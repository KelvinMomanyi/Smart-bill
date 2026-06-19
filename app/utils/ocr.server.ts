import {
  createCanvas,
  DOMMatrix,
  ImageData,
  loadImage,
  Path2D,
  type Canvas,
} from "@napi-rs/canvas";
import Tesseract from "tesseract.js";

type PdfPageProxy = {
  getViewport: (params: { scale: number }) => { width: number; height: number };
  getTextContent: () => Promise<{
    items: Array<{ str?: string; transform?: number[]; width?: number }>;
  }>;
  render: (params: {
    canvasContext: ReturnType<Canvas["getContext"]>;
    viewport: { width: number; height: number };
    background?: string;
  }) => { promise: Promise<void> };
};

type PdfDocumentProxy = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageProxy>;
  destroy: () => Promise<void>;
};

type OcrSource = "image" | "pdf";

export type OcrPageResult = {
  pageNumber: number;
  text: string;
  confidence: number;
  source: "ocr" | "embedded" | "merged";
};

export type OcrDocumentResult = {
  source: OcrSource;
  pageCount: number;
  confidence: number;
  text: string;
  pages: OcrPageResult[];
};

type ExtractTextOptions = {
  filename?: string;
  mimeType?: string;
  maxPdfPages?: number;
};

const PDF_RENDER_DPI = 300;
const MIN_OCR_WIDTH = 1800;
const MAX_OCR_EDGE = 3600;
const DEFAULT_MAX_PDF_PAGES = Number.MAX_SAFE_INTEGER;
const MIN_MEANINGFUL_TEXT_LENGTH = 24;
const INVOICE_FIELD_PATTERNS = [
  /\binvoice\b/i,
  /\b(inv|invoice)\s*(no|number|#)\b/i,
  /\bdate\b/i,
  /\bdue\b/i,
  /\bbill\s+to\b/i,
  /\bship\s+to\b/i,
  /\bdescription\b/i,
  /\b(qty|quantity)\b/i,
  /\b(subtotal|sub-total)\b/i,
  /\b(tax|vat|gst)\b/i,
  /\b(total|amount\s+due|balance\s+due)\b/i,
];

class NodeCanvasFactory {
  create(width: number, height: number) {
    const canvas = createCanvas(width, height);
    return {
      canvas,
      context: canvas.getContext("2d"),
    };
  }

  reset(
    canvasAndContext: {
      canvas: Canvas;
      context: ReturnType<Canvas["getContext"]>;
    },
    width: number,
    height: number,
  ) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: {
    canvas: Canvas | null;
    context: ReturnType<Canvas["getContext"]> | null;
  }) {
    if (canvasAndContext.canvas) {
      canvasAndContext.canvas.width = 0;
      canvasAndContext.canvas.height = 0;
    }
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

function clamp(value: number, min = 0, max = 255) {
  return Math.max(min, Math.min(max, value));
}

function getMaxPdfPages(value?: number) {
  if (value && Number.isFinite(value) && value > 0) return Math.floor(value);

  const configured = Number.parseInt(process.env.OCR_MAX_PDF_PAGES || "", 10);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_PDF_PAGES;
}

function isPdf(
  buffer: Buffer | Uint8Array,
  mimeType?: string,
  filename?: string,
) {
  if (mimeType === "application/pdf") return true;
  if (filename?.toLowerCase().endsWith(".pdf")) return true;

  const signature = Buffer.from(buffer).subarray(0, 4).toString("ascii");
  return signature === "%PDF";
}

function normalizeWhitespace(text: string) {
  return text
    .replaceAll("\f", "\n")
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function calculateImageScale(width: number, height: number) {
  const upScale = width < MIN_OCR_WIDTH ? MIN_OCR_WIDTH / width : 1;
  const maxScale = Math.min(MAX_OCR_EDGE / width, MAX_OCR_EDGE / height);
  return Math.max(0.25, Math.min(upScale, maxScale));
}

function calculatePdfScale(width: number, height: number) {
  const targetScale = PDF_RENDER_DPI / 72;
  const maxScale = Math.min(MAX_OCR_EDGE / width, MAX_OCR_EDGE / height);
  return Math.max(1, Math.min(targetScale, maxScale));
}

function normalizeCanvasForOcr(canvas: Canvas) {
  const context = canvas.getContext("2d");
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  const samples: number[] = [];
  const stride = Math.max(
    4,
    Math.floor((canvas.width * canvas.height) / 12000),
  );

  for (let index = 0; index < pixels.length; index += stride * 4) {
    const luma =
      0.299 * pixels[index] +
      0.587 * pixels[index + 1] +
      0.114 * pixels[index + 2];
    samples.push(luma);
  }

  samples.sort((left, right) => left - right);
  const low = samples[Math.floor(samples.length * 0.02)] ?? 0;
  const high = samples[Math.floor(samples.length * 0.98)] ?? 255;
  const spread = Math.max(60, high - low);

  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] / 255;
    const red = pixels[index] * alpha + 255 * (1 - alpha);
    const green = pixels[index + 1] * alpha + 255 * (1 - alpha);
    const blue = pixels[index + 2] * alpha + 255 * (1 - alpha);
    const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
    const normalized = clamp(((luma - low) / spread) * 255);
    const contrasted = clamp(128 + (normalized - 128) * 1.18);
    const cleaned = contrasted > 246 ? 255 : contrasted < 18 ? 0 : contrasted;

    pixels[index] = cleaned;
    pixels[index + 1] = cleaned;
    pixels[index + 2] = cleaned;
    pixels[index + 3] = 255;
  }

  context.putImageData(imageData, 0, 0);
}

async function imageBufferForOcr(file: Buffer | Uint8Array | string) {
  if (typeof file === "string") return file;

  const image = await loadImage(Buffer.from(file));
  const scale = calculateImageScale(image.width, image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");

  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  normalizeCanvasForOcr(canvas);

  return canvas.toBuffer("image/png");
}

async function createOcrWorker() {
  const worker = await Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
    cacheMethod: "none",
    gzip: false,
    langPath: process.cwd(),
  });

  await worker.setParameters({
    preserve_interword_spaces: "1",
    tessedit_pageseg_mode: Tesseract.PSM.AUTO,
    user_defined_dpi: String(PDF_RENDER_DPI),
  });

  return worker;
}

async function recognizeImageWithWorker(
  worker: Tesseract.Worker,
  image: Buffer | string,
) {
  const {
    data: { confidence, text },
  } = await worker.recognize(image);

  return {
    confidence: confidence || 0,
    text: normalizeWhitespace(text),
  };
}

function textQualityScore(text: string, confidence = 0) {
  const normalized = normalizeWhitespace(text);
  if (!normalized) return 0;

  const fieldScore = INVOICE_FIELD_PATTERNS.reduce(
    (score, pattern) => score + (pattern.test(normalized) ? 120 : 0),
    0,
  );
  const moneyScore =
    (normalized.match(
      /(?:[$\u20ac\u00a3]|KES|USD|EUR|GBP)?\s*\d[\d,]*\.\d{2}\b/gi,
    )?.length || 0) * 35;
  const dateScore =
    (normalized.match(/\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/g)?.length || 0) * 25;
  const lengthScore = Math.min(normalized.length, 2500) * 0.4;

  return lengthScore + fieldScore + moneyScore + dateScore + confidence * 4;
}

function normalizedLineKey(line: string) {
  return line.toLowerCase().replace(/[^a-z0-9.]+/g, "");
}

function mergeUniqueLines(primary: string, secondary: string) {
  const primaryLines = normalizeWhitespace(primary).split("\n").filter(Boolean);
  const secondaryLines = normalizeWhitespace(secondary)
    .split("\n")
    .filter(Boolean);
  const seen = new Set(
    primaryLines.map(normalizedLineKey).filter((key) => key.length > 4),
  );

  for (const line of secondaryLines) {
    const key = normalizedLineKey(line);
    if (key.length <= 4 || seen.has(key)) continue;

    const isContained = [...seen].some(
      (existingKey) => existingKey.includes(key) || key.includes(existingKey),
    );
    if (isContained) continue;

    primaryLines.push(line);
    seen.add(key);
  }

  return primaryLines.join("\n").trim();
}

function choosePageText(
  embeddedText: string,
  ocrText: string,
  confidence: number,
) {
  const embeddedScore = textQualityScore(embeddedText, 100);
  const ocrScore = textQualityScore(ocrText, confidence);

  if (
    embeddedText.length >= MIN_MEANINGFUL_TEXT_LENGTH &&
    embeddedScore >= ocrScore * 0.9
  ) {
    const mergedText =
      ocrText.length >= MIN_MEANINGFUL_TEXT_LENGTH
        ? mergeUniqueLines(embeddedText, ocrText)
        : embeddedText;
    return {
      source: mergedText === embeddedText ? "embedded" : "merged",
      text: mergedText,
    } as const;
  }

  if (embeddedText.length >= MIN_MEANINGFUL_TEXT_LENGTH) {
    return {
      source: "merged",
      text: mergeUniqueLines(ocrText, embeddedText),
    } as const;
  }

  return {
    source: "ocr",
    text: ocrText,
  } as const;
}

function textItemsToLines(
  items: Array<{ str?: string; transform?: number[]; width?: number }>,
) {
  const rows: Array<{
    y: number;
    items: Array<{ text: string; x: number; width: number }>;
  }> = [];

  for (const item of items) {
    const text = item.str?.trim();
    const transform = item.transform;
    if (!text || !transform || transform.length < 6) continue;

    const x = transform[4];
    const y = transform[5];
    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= 3);
    if (!row) {
      row = { y, items: [] };
      rows.push(row);
    }
    row.items.push({ text, x, width: item.width || 0 });
  }

  return rows
    .sort((left, right) => right.y - left.y)
    .map((row) => {
      const ordered = row.items.sort((left, right) => left.x - right.x);
      let cursor = 0;

      return ordered
        .map((item, index) => {
          const gap = index === 0 ? 0 : item.x - cursor;
          cursor = item.x + item.width;

          if (index === 0) return item.text;
          if (gap > 36) return `    ${item.text}`;
          if (gap > 12) return `  ${item.text}`;
          return ` ${item.text}`;
        })
        .join("");
    })
    .join("\n");
}

async function extractEmbeddedTextFromPdfPage(page: PdfPageProxy) {
  try {
    const textContent = await page.getTextContent();
    return normalizeWhitespace(textItemsToLines(textContent.items));
  } catch {
    return "";
  }
}

async function renderPdfPageForOcr(page: PdfPageProxy) {
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = calculatePdfScale(baseViewport.width, baseViewport.height);
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");

  context.fillStyle = "white";
  context.fillRect(0, 0, width, height);

  await page.render({
    background: "white",
    canvasContext: context,
    viewport,
  }).promise;

  normalizeCanvasForOcr(canvas);
  return canvas.toBuffer("image/png");
}

async function loadPdfJs() {
  globalThis.DOMMatrix ||= DOMMatrix as unknown as typeof globalThis.DOMMatrix;
  globalThis.ImageData ||= ImageData as unknown as typeof globalThis.ImageData;
  globalThis.Path2D ||= Path2D as unknown as typeof globalThis.Path2D;

  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

async function extractTextFromPdf(
  buffer: Buffer | Uint8Array,
  options: ExtractTextOptions,
): Promise<OcrDocumentResult> {
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    canvasFactory: new NodeCanvasFactory(),
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  });
  const pdf = (await loadingTask.promise) as unknown as PdfDocumentProxy;
  const pageLimit = Math.min(pdf.numPages, getMaxPdfPages(options.maxPdfPages));
  const pages: OcrPageResult[] = [];
  const worker = await createOcrWorker();

  try {
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const [embeddedText, renderedImage] = await Promise.all([
        extractEmbeddedTextFromPdfPage(page),
        renderPdfPageForOcr(page),
      ]);
      const ocrResult = await recognizeImageWithWorker(worker, renderedImage);
      const selected = choosePageText(
        embeddedText,
        ocrResult.text,
        ocrResult.confidence,
      );

      pages.push({
        confidence: selected.source === "embedded" ? 100 : ocrResult.confidence,
        pageNumber,
        source: selected.source,
        text: selected.text,
      });
    }
  } finally {
    await Promise.allSettled([worker.terminate(), pdf.destroy()]);
  }

  const text = normalizeWhitespace(pages.map((page) => page.text).join("\n\n"));
  const confidence =
    pages.length > 0
      ? pages.reduce((sum, page) => sum + page.confidence, 0) / pages.length
      : 0;

  return {
    confidence,
    pageCount: pdf.numPages,
    pages,
    source: "pdf",
    text,
  };
}

async function extractTextFromRasterImage(
  file: Buffer | Uint8Array | string,
): Promise<OcrDocumentResult> {
  const worker = await createOcrWorker();

  try {
    const image = await imageBufferForOcr(file);
    const result = await recognizeImageWithWorker(worker, image);

    return {
      confidence: result.confidence,
      pageCount: 1,
      pages: [
        {
          confidence: result.confidence,
          pageNumber: 1,
          source: "ocr",
          text: result.text,
        },
      ],
      source: "image",
      text: result.text,
    };
  } finally {
    await worker.terminate();
  }
}

export async function extractTextFromDocument(
  file: Buffer | Uint8Array | string,
  options: ExtractTextOptions = {},
): Promise<OcrDocumentResult> {
  if (
    typeof file !== "string" &&
    isPdf(file, options.mimeType, options.filename)
  ) {
    return extractTextFromPdf(file, options);
  }

  return extractTextFromRasterImage(file);
}

export async function extractTextFromFile(
  file: Buffer | Uint8Array | string,
  options: ExtractTextOptions = {},
) {
  const result = await extractTextFromDocument(file, options);
  return result.text;
}

export async function extractTextFromImage(file: Buffer | Uint8Array | string) {
  return extractTextFromFile(file);
}
