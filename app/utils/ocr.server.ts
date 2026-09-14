import {
  createCanvas,
  DOMMatrix,
  ImageData,
  loadImage,
  Path2D,
  type Canvas,
} from "@napi-rs/canvas";
import { existsSync } from "node:fs";
import vision from "@google-cloud/vision";
import Tesseract from "tesseract.js";
import { MAX_PDF_PAGES } from "./plans";

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
  onProgress?: (page: number, total: number) => Promise<void>;
};

const PDF_RENDER_DPI = 300;
const MIN_OCR_WIDTH = 1800;
const MAX_OCR_EDGE = 3600;
const DEFAULT_MAX_PDF_PAGES = MAX_PDF_PAGES;
const MIN_MEANINGFUL_TEXT_LENGTH = 24;
const GOOGLE_PDF_PAGE_BATCH = 5;
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

type OcrProvider = "google" | "tesseract";
type GoogleCredentials = {
  client_email: string;
  private_key: string;
  project_id?: string;
};

let googleClient:
  | InstanceType<typeof vision.v1.ImageAnnotatorClient>
  | undefined;

function unquote(value: string) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function serviceAccountJson() {
  const plain =
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON?.trim() ||
    process.env.GOOGLE_CLOUD_CREDENTIALS_JSON?.trim() ||
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (plain) return unquote(plain);

  const encoded = process.env.GOOGLE_APPLICATION_CREDENTIALS_BASE64?.trim();
  if (!encoded) return;
  try {
    return Buffer.from(unquote(encoded), "base64").toString("utf8");
  } catch {
    throw new Error(
      "Google Cloud Vision credentials are not valid base64-encoded JSON.",
    );
  }
}

function parseGoogleCredentials(raw: string): GoogleCredentials {
  let parsed: Partial<GoogleCredentials>;
  try {
    parsed = JSON.parse(raw) as Partial<GoogleCredentials>;
  } catch {
    throw new Error(
      "Google Cloud Vision credentials are not valid service-account JSON.",
    );
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      "Google Cloud Vision credentials must include client_email and private_key.",
    );
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key.replace(/\\n/g, "\n"),
    project_id: parsed.project_id,
  };
}

function googleConfigurationPresent() {
  if (serviceAccountJson()) return true;
  const keyFilename = unquote(
    process.env.GOOGLE_APPLICATION_CREDENTIALS || "",
  );
  return Boolean(keyFilename && existsSync(keyFilename));
}

export function configuredOcrProvider(
  requested = process.env.OCR_PROVIDER,
  googleConfigured = googleConfigurationPresent(),
): OcrProvider {
  const provider = requested?.trim().toLowerCase() || "auto";
  if (provider === "google") {
    if (!googleConfigured) {
      throw new Error(
        "Google Cloud Vision OCR is selected but credentials are missing. Set GOOGLE_APPLICATION_CREDENTIALS_JSON in the server environment.",
      );
    }
    return "google";
  }
  if (provider === "tesseract") return "tesseract";
  if (provider !== "auto") {
    throw new Error("OCR_PROVIDER must be auto, google, or tesseract.");
  }
  return googleConfigured ? "google" : "tesseract";
}

function getOcrTimeoutMs() {
  const configured = Number.parseInt(process.env.OCR_TIMEOUT_MS || "", 10);
  if (Number.isFinite(configured) && configured >= 5000) {
    return Math.min(configured, 240000);
  }
  return process.env.VERCEL ? 50000 : 180000;
}

function remainingTime(deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error(
      "OCR timed out. Try a clearer image or a shorter PDF, then retry processing.",
    );
  }
  return remaining;
}

async function withOcrTimeout<T>(promise: Promise<T>, deadline: number) {
  const remaining = remainingTime(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "OCR timed out. Try a clearer image or a shorter PDF, then retry processing.",
              ),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getGoogleClient() {
  if (googleClient) return googleClient;

  const inline = serviceAccountJson();
  if (inline) {
    const credentials = parseGoogleCredentials(inline);
    googleClient = new vision.v1.ImageAnnotatorClient({
      credentials,
      projectId: credentials.project_id,
    });
    return googleClient;
  }

  const keyFilename = unquote(process.env.GOOGLE_APPLICATION_CREDENTIALS || "");
  if (!keyFilename || !existsSync(keyFilename)) {
    throw new Error(
      "Google Cloud Vision credential file is unavailable on this host. Set GOOGLE_APPLICATION_CREDENTIALS_JSON in Vercel instead of a local file path.",
    );
  }
  googleClient = new vision.v1.ImageAnnotatorClient({ keyFilename });
  return googleClient;
}

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
  if (value && Number.isFinite(value) && value > 0)
    return Math.min(MAX_PDF_PAGES, Math.floor(value));

  const configured = Number.parseInt(process.env.OCR_MAX_PDF_PAGES || "", 10);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(MAX_PDF_PAGES, configured)
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

async function createOcrWorker(deadline: number) {
  const worker = await withOcrTimeout(
    Tesseract.createWorker("eng", Tesseract.OEM.LSTM_ONLY, {
      cacheMethod: "none",
      gzip: false,
      langPath: process.cwd(),
    }),
    deadline,
  );

  try {
    await withOcrTimeout(
      worker.setParameters({
        preserve_interword_spaces: "1",
        tessedit_pageseg_mode: Tesseract.PSM.AUTO,
        user_defined_dpi: String(PDF_RENDER_DPI),
      }),
      deadline,
    );
    return worker;
  } catch (error) {
    await worker.terminate().catch(() => undefined);
    throw error;
  }
}

async function recognizeImageWithWorker(
  worker: Tesseract.Worker,
  image: Buffer | string,
  deadline: number,
) {
  const {
    data: { confidence, text },
  } = await withOcrTimeout(worker.recognize(image), deadline);

  return {
    confidence: confidence || 0,
    text: normalizeWhitespace(text),
  };
}

function annotationResult(response: {
  error?: { message?: string | null } | null;
  fullTextAnnotation?: {
    text?: string | null;
    pages?: Array<{
      blocks?: Array<{ confidence?: number | null }> | null;
    }> | null;
  } | null;
  textAnnotations?: Array<{ description?: string | null }> | null;
}) {
  if (response.error?.message) {
    throw new Error(
      `Google Cloud Vision rejected the document: ${response.error.message}`,
    );
  }
  const annotation = response.fullTextAnnotation;
  const blocks = annotation?.pages?.flatMap((page) => page.blocks || []) || [];
  const confidence = blocks.length
    ? (blocks.reduce((sum, block) => sum + Number(block.confidence || 0), 0) /
        blocks.length) *
      100
    : 0;
  return {
    confidence,
    text: normalizeWhitespace(
      annotation?.text || response.textAnnotations?.[0]?.description || "",
    ),
  };
}

async function recognizeImageWithGoogle(image: Buffer, deadline: number) {
  try {
    const [result] = await getGoogleClient().batchAnnotateImages(
      {
        requests: [
          {
            image: { content: image },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          },
        ],
      },
      { timeout: remainingTime(deadline) },
    );
    const response = result.responses?.[0];
    if (!response) throw new Error("Google Cloud Vision returned no result.");
    return annotationResult(response);
  } catch (error) {
    if (error instanceof Error && /OCR timed out/.test(error.message))
      throw error;
    throw new Error(
      "Google Cloud Vision OCR failed. Check that the API is enabled and the Vercel service-account JSON is valid.",
      { cause: error },
    );
  }
}

async function recognizePdfPagesWithGoogle(
  buffer: Buffer | Uint8Array,
  pageNumbers: number[],
  deadline: number,
) {
  const pageResults = new Map<number, { confidence: number; text: string }>();

  try {
    for (
      let offset = 0;
      offset < pageNumbers.length;
      offset += GOOGLE_PDF_PAGE_BATCH
    ) {
      const pages = pageNumbers.slice(offset, offset + GOOGLE_PDF_PAGE_BATCH);
      const [result] = await getGoogleClient().batchAnnotateFiles(
        {
          requests: [
            {
              inputConfig: {
                content: Buffer.from(buffer),
                mimeType: "application/pdf",
              },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
              pages,
            },
          ],
        },
        { timeout: remainingTime(deadline) },
      );
      const fileResponse = result.responses?.[0];
      if (fileResponse?.error?.message) {
        throw new Error(fileResponse.error.message);
      }
      const responses = fileResponse?.responses || [];
      for (const [index, pageNumber] of pages.entries()) {
        const response = responses[index];
        if (!response) {
          throw new Error(
            `Google Cloud Vision returned no result for page ${pageNumber}.`,
          );
        }
        pageResults.set(pageNumber, annotationResult(response));
      }
    }
    return pageResults;
  } catch (error) {
    if (error instanceof Error && /OCR timed out/.test(error.message))
      throw error;
    throw new Error(
      "Google Cloud Vision OCR failed. Check that the API is enabled and the Vercel service-account JSON is valid.",
      { cause: error },
    );
  }
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

export function hasUsableEmbeddedInvoiceText(text: string) {
  const normalized = normalizeWhitespace(text);
  if (normalized.length < 80 || !/\d/.test(normalized)) return false;
  const fields = INVOICE_FIELD_PATTERNS.reduce(
    (count, pattern) => count + (pattern.test(normalized) ? 1 : 0),
    0,
  );
  return fields >= 2 || (fields >= 1 && normalized.length >= 250);
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
  const deadline = Date.now() + getOcrTimeoutMs();
  const pdfjs = await loadPdfJs();
  const loadingTask = pdfjs.getDocument({
    canvasFactory: new NodeCanvasFactory(),
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  });
  const pdf = (await loadingTask.promise) as unknown as PdfDocumentProxy;
  if (pdf.numPages > getMaxPdfPages(options.maxPdfPages)) {
    await pdf.destroy();
    throw new Error(
      `PDF exceeds the ${getMaxPdfPages(options.maxPdfPages)}-page limit. Split it into complete invoice documents before uploading.`,
    );
  }
  const pageLimit = Math.min(pdf.numPages, getMaxPdfPages(options.maxPdfPages));
  const totalPages = pdf.numPages;
  const pages: OcrPageResult[] = [];
  let completedPages = 0;
  const reportProgress = async () => {
    completedPages += 1;
    await options.onProgress?.(completedPages, totalPages);
  };
  const needsOcr: Array<{
    pageNumber: number;
    page: PdfPageProxy;
    embeddedText: string;
  }> = [];

  try {
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const embeddedText = await extractEmbeddedTextFromPdfPage(page);
      if (hasUsableEmbeddedInvoiceText(embeddedText)) {
        pages.push({
          confidence: 100,
          pageNumber,
          source: "embedded",
          text: embeddedText,
        });
        await reportProgress();
      } else {
        needsOcr.push({ pageNumber, page, embeddedText });
      }
    }

    if (needsOcr.length) {
      const provider = configuredOcrProvider();
      if (provider === "google") {
        const cloudPages = await recognizePdfPagesWithGoogle(
          buffer,
          needsOcr.map(({ pageNumber }) => pageNumber),
          deadline,
        );
        for (const pending of needsOcr) {
          const ocrResult = cloudPages.get(pending.pageNumber) || {
            confidence: 0,
            text: "",
          };
          const selected = choosePageText(
            pending.embeddedText,
            ocrResult.text,
            ocrResult.confidence,
          );
          pages.push({
            confidence:
              selected.source === "embedded" ? 100 : ocrResult.confidence,
            pageNumber: pending.pageNumber,
            source: selected.source,
            text: selected.text,
          });
          await reportProgress();
        }
      } else {
        const worker = await createOcrWorker(deadline);
        try {
          for (const pending of needsOcr) {
            const renderedImage = await renderPdfPageForOcr(pending.page);
            const ocrResult = await recognizeImageWithWorker(
              worker,
              renderedImage,
              deadline,
            );
            const selected = choosePageText(
              pending.embeddedText,
              ocrResult.text,
              ocrResult.confidence,
            );
            pages.push({
              confidence:
                selected.source === "embedded" ? 100 : ocrResult.confidence,
              pageNumber: pending.pageNumber,
              source: selected.source,
              text: selected.text,
            });
            await reportProgress();
          }
        } finally {
          await worker.terminate().catch(() => undefined);
        }
      }
    }
  } finally {
    await pdf.destroy().catch(() => undefined);
  }

  pages.sort((left, right) => left.pageNumber - right.pageNumber);
  const text = normalizeWhitespace(pages.map((page) => page.text).join("\n\n"));
  const confidence =
    pages.length > 0
      ? pages.reduce((sum, page) => sum + page.confidence, 0) / pages.length
      : 0;

  return {
    confidence,
    pageCount: totalPages,
    pages,
    source: "pdf",
    text,
  };
}

async function extractTextFromRasterImage(
  file: Buffer | Uint8Array | string,
): Promise<OcrDocumentResult> {
  const deadline = Date.now() + getOcrTimeoutMs();
  const provider = configuredOcrProvider();
  let result: { confidence: number; text: string };

  if (provider === "google") {
    if (typeof file === "string") {
      throw new Error("Google Cloud Vision requires the uploaded image bytes.");
    }
    result = await recognizeImageWithGoogle(Buffer.from(file), deadline);
  } else {
    const worker = await createOcrWorker(deadline);
    try {
      const image = await imageBufferForOcr(file);
      result = await recognizeImageWithWorker(worker, image, deadline);
    } finally {
      await worker.terminate().catch(() => undefined);
    }
  }

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
