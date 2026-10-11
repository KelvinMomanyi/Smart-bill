import { MAX_FILE_BYTES } from "./plans";

export const BROWSER_OCR_MAX_PAGES = 10;
export const BROWSER_PDF_SCALE = 2;
export const BROWSER_OCR_MIN_WIDTH = 1800;
export const BROWSER_OCR_MAX_EDGE = 3600;
export const BROWSER_OCR_OPERATION_TIMEOUT_MS = 120_000;
const OCR_CLEANUP_TIMEOUT_MS = 5_000;

class BrowserOcrTimeoutError extends Error {
  constructor() {
    super("Invoice recognition took too long. Retry processing or enter the invoice text manually.");
    this.name = "BrowserOcrTimeoutError";
  }
}

async function ocrOperation<T>(operation: Promise<T>, timeout = BROWSER_OCR_OPERATION_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BrowserOcrTimeoutError()), timeout);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
export const BROWSER_OCR_SCRIPTS = {
  tesseract:
    "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js",
  pdf: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfWorker:
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
} as const;

export type BrowserOcrProgress = { status: string; progress: number };
export type BrowserOcrResult = {
  rawText: string;
  pageCount: number;
  preview: Blob;
  confidence: number;
};
type ProgressMessage = { status: string; progress: number };
type OcrRecognition = { data: { text: string; confidence?: number } };
type BrowserOcrWorker = {
  setParameters(parameters: Record<string, string>): Promise<unknown>;
  recognize(
    image: Blob,
    options?: { rotateAuto?: boolean },
  ): Promise<OcrRecognition>;
  terminate(): Promise<unknown>;
};
type PdfPage = {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }): { promise: Promise<void> };
};
type PdfDocument = {
  numPages: number;
  getPage(page: number): Promise<PdfPage>;
};
export type BrowserOcrRuntime = {
  createWorker(
    language: string,
    options: { logger(message: ProgressMessage): void },
  ): Promise<BrowserOcrWorker>;
  openPdf(data: ArrayBuffer): {
    promise: Promise<PdfDocument>;
    destroy(): Promise<void>;
  };
  createCanvas(): HTMLCanvasElement;
  prepareImage?(image: Blob, monochrome: boolean, rotation?: number): Promise<Blob>;
  imageRotations?(image: Blob): Promise<number[]>;
};
type OcrWindow = Window & {
  Tesseract?: {
    createWorker(
      language: string,
      oem: number,
      options: { logger(message: ProgressMessage): void },
    ): Promise<BrowserOcrWorker>;
  };
  pdfjsLib?: {
    GlobalWorkerOptions: { workerSrc: string };
    getDocument(options: {
      data: ArrayBuffer;
      isEvalSupported: boolean;
    }): ReturnType<BrowserOcrRuntime["openPdf"]>;
  };
};

const scriptLoads = new Map<string, Promise<void>>();
function loadScript(src: string) {
  const existing = scriptLoads.get(src);
  if (existing) return existing;
  const loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const timer = setTimeout(() => fail(), 30000);
    const fail = () => {
      clearTimeout(timer);
      script.remove();
      scriptLoads.delete(src);
      reject(
        new Error(
          "Unable to load the OCR engine. Check your connection and retry.",
        ),
      );
    };
    script.src = src;
    script.async = true;
    script.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  scriptLoads.set(src, loading);
  return loading;
}

async function loadRuntime(pdf: boolean): Promise<BrowserOcrRuntime> {
  const scope = window as OcrWindow;
  if (!scope.Tesseract) await loadScript(BROWSER_OCR_SCRIPTS.tesseract);
  if (pdf && !scope.pdfjsLib) await loadScript(BROWSER_OCR_SCRIPTS.pdf);
  if (!scope.Tesseract || (pdf && !scope.pdfjsLib))
    throw new Error("The OCR engine did not load. Reload SmartBill and retry.");
  if (scope.pdfjsLib)
    scope.pdfjsLib.GlobalWorkerOptions.workerSrc =
      BROWSER_OCR_SCRIPTS.pdfWorker;
  return {
    createWorker: (language, options) =>
      scope.Tesseract!.createWorker(language, 1, options),
    openPdf: (data) =>
      scope.pdfjsLib!.getDocument({ data, isEvalSupported: false }),
    createCanvas: () => document.createElement("canvas"),
    prepareImage: (image, monochrome, rotation) =>
      prepareBrowserInvoiceImage(image, monochrome, rotation),
    imageRotations: async image => {
      const source = await createImageBitmap(image);
      try { return source.width > source.height ? [90, 270] : [180]; }
      finally { source.close(); }
    },
  };
}

export function browserOcrImageDimensions(width: number, height: number) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new Error("OCR image dimensions must be positive numbers.");
  const upscale = width < BROWSER_OCR_MIN_WIDTH ? BROWSER_OCR_MIN_WIDTH / width : 1;
  const edgeLimit = Math.min(BROWSER_OCR_MAX_EDGE / width, BROWSER_OCR_MAX_EDGE / height);
  const scale = Math.max(0.01, Math.min(upscale, edgeLimit));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function clampChannel(value: number) {
  return Math.max(0, Math.min(255, value));
}

function enhanceInvoiceCanvas(canvas: HTMLCanvasElement, monochrome: boolean) {
  if (!monochrome) return;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot prepare invoice images.");
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = image.data;
  const samples: number[] = [];
  const stride = Math.max(1, Math.floor((canvas.width * canvas.height) / 12000));
  for (let index = 0; index < pixels.length; index += stride * 4) {
    samples.push(
      0.299 * pixels[index] +
        0.587 * pixels[index + 1] +
        0.114 * pixels[index + 2],
    );
  }
  samples.sort((left, right) => left - right);
  const low = samples[Math.floor(samples.length * 0.02)] ?? 0;
  const high = samples[Math.floor(samples.length * 0.98)] ?? 255;
  const spread = Math.max(70, high - low);
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3] / 255;
    const red = pixels[index] * alpha + 255 * (1 - alpha);
    const green = pixels[index + 1] * alpha + 255 * (1 - alpha);
    const blue = pixels[index + 2] * alpha + 255 * (1 - alpha);
    const luma = 0.299 * red + 0.587 * green + 0.114 * blue;
    const normalized = ((luma - low) / spread) * 255;
    // Keep small, light punctuation pixels. Aggressive white/black clipping can
    // erase a decimal point while leaving the surrounding digits readable.
    const contrasted = clampChannel(128 + (normalized - 128) * 1.08);
    const cleaned = contrasted > 253 ? 255 : contrasted < 8 ? 0 : contrasted;
    pixels[index] = cleaned;
    pixels[index + 1] = cleaned;
    pixels[index + 2] = cleaned;
    pixels[index + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

async function prepareBrowserInvoiceImage(image: Blob, monochrome: boolean, rotation = 0) {
  const source = await createImageBitmap(image);
  const dimensions = browserOcrImageDimensions(source.width, source.height);
  const canvas = document.createElement("canvas");
  const sideways = rotation === 90 || rotation === 270;
  canvas.width = sideways ? dimensions.height : dimensions.width;
  canvas.height = sideways ? dimensions.width : dimensions.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot prepare invoice images.");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(rotation * Math.PI / 180);
    context.drawImage(source, -dimensions.width / 2, -dimensions.height / 2, dimensions.width, dimensions.height);
    enhanceInvoiceCanvas(canvas, monochrome);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error("Invoice image preparation failed.")),
        "image/png",
        1,
      ),
    );
  } finally {
    source.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function invoiceOcrSummaryBalance(text: string): boolean | null {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const decimalAmounts = (line: string) => [...line.matchAll(/[+-]?(?:\d{1,3}(?:[ ,.'’]\d{3})+|\d+)[.,]\d{2}\b/g)]
    .filter(match => !/^\s*%/.test(line.slice((match.index || 0) + match[0].length)))
    .map(match => {
      const amount = match[0].trim();
      const separator = Math.max(amount.lastIndexOf("."), amount.lastIndexOf(","));
      return Number(amount.slice(0, separator).replace(/[ ,.'’]/g, "") + "." + amount.slice(separator + 1));
    });
  const subtotalIndex = lines.reduce((last, line, i) => /^sub[\s-]*total\b/i.test(line) ? i : last, -1);
  const totalIndex = lines.reduce((last, line, i) =>
    /^(?:grand\s+total|invoice\s+total|total(?:\s+due)?|amount\s+due|balance\s+due)\b/i.test(line) &&
    !/\b(?:tax|vat|gst)\b/i.test(line) ? i : last, -1,
  );
  if (subtotalIndex < 0 || totalIndex <= subtotalIndex) return null;
  const summary = lines.slice(subtotalIndex + 1, totalIndex);
  // Do not treat a legitimate charge, deposit or credit as a digit error.
  if (summary.some(line => /\b(?:shipping|freight|handling|insurance|surcharge|rounding|deposit|paid|credit|withheld)\b/i.test(line))) return null;
  const subtotal = decimalAmounts(lines[subtotalIndex]).at(-1);
  const total = decimalAmounts(lines[totalIndex]).at(-1);
  const taxes = summary.filter(line => /^(?:sales\s+tax|tax|vat|gst|total\s+(?:tax|vat|gst))\b/i.test(line));
  const aggregate = taxes.filter(line => /^(?:total\s+(?:tax|vat|gst)|(?:tax|vat|gst)\s+total)\b/i.test(line)).at(-1);
  const taxLines = aggregate ? [aggregate] : taxes;
  const discounts = summary.filter(line => /^(?:discount|less\s+discount)\b/i.test(line));
  if (!taxLines.length || [...taxLines, ...discounts].some(line =>
    !decimalAmounts(line).length || (/\b(?:from|on|of)\b/i.test(line) && decimalAmounts(line).length < 2),
  )) return null;
  const tax = taxLines.reduce((sum, line) => sum + decimalAmounts(line).at(-1)!, 0);
  const discount = discounts.reduce((sum, line) => sum + decimalAmounts(line).at(-1)!, 0);
  if (subtotal == null || total == null || ![subtotal, tax, discount, total].every(Number.isFinite) ||
      subtotal < 0 || tax < 0 || discount < 0 || discount > subtotal || total < 0) return null;
  // Select among actual recognition reads; this never edits recognised digits.
  return Math.abs(subtotal - discount + tax - total) < 0.015;
}

function hasOcrCurrency(text: string) {
  return /[$€£¥₹₦₵₱]|R\$|KSh|\b(?:USD|EUR|GBP|CAD|AUD|NZD|KES|ZAR|NGN|GHS|JPY|CNY|INR|AED|UGX|TZS|RWF|BRL|PHP|EGP)\b|\d[.,]\d{2,4}\s+L\.?E\.?(?=\s|$)/i.test(text);
}

export function invoiceOcrTextScore(text: string, confidence = 0) {
  const decimalAmounts =
    text.match(
      /(?:[$€£¥₹₦₵₱]|R\$|KSh|USD|EUR|GBP|CAD|AUD|NZD|KES|ZAR|NGN|GHS|JPY|CNY|INR|AED|UGX|TZS|RWF|BRL|PHP)?\s*\d[\d ,.'’]*[.,]\d{2}\b/gi,
    )?.length || 0;
  const labels = [
    /\b(?:invoice|inv)\b/i,
    /\bdate\b/i,
    /\b(?:subtotal|sub-total)\b/i,
    /\b(?:tax|vat|gst)\b/i,
    /\b(?:total|amount due|balance due)\b/i,
  ].filter((pattern) => pattern.test(text)).length;
  const currency = hasOcrCurrency(text);
  const balance = invoiceOcrSummaryBalance(text);
  return (
    Math.max(0, confidence) * 3 +
    labels * 100 +
    Math.min(decimalAmounts, 12) * 90 +
    (currency ? 100 : 0) +
    (balance === true ? 200 : balance === false ? -200 : 0) +
    Math.min(text.trim().length, 2000) * 0.1
  );
}

export function needsOcrAccuracyPass(text: string, confidence = 0) {
  return (
    confidence < 70 ||
    !/\b(?:invoice|inv)\b/i.test(text) ||
    !/\b(?:total|amount due|balance due)\b/i.test(text) ||
    !hasOcrCurrency(text) ||
    invoiceOcrSummaryBalance(text) === false ||
    !/\d[\d ,.'’]*[.,]\d{2}\b/.test(text)
  );
}

export function validateBrowserOcrFile(
  file: Pick<File, "name" | "type" | "size">,
) {
  if (!file.size || file.size > MAX_FILE_BYTES)
    throw new Error("Choose a document between 1 byte and 10 MB.");
  const pdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (
    !pdf &&
    ![
      "image/jpeg",
      "image/jpg",
      "image/png",
      "image/gif",
      "image/bmp",
      "image/webp",
    ].includes(file.type)
  )
    throw new Error("Choose a PDF, JPEG, PNG, GIF, BMP or WebP invoice.");
  return pdf;
}

export function validateBrowserOcrText(rawText: unknown, pageCount: unknown) {
  if (typeof rawText !== "string" || !rawText.trim() || rawText.length > 200000)
    throw new Error("Invoice text must contain 1–200,000 characters.");
  if (
    !Number.isInteger(pageCount) ||
    Number(pageCount) < 1 ||
    Number(pageCount) > BROWSER_OCR_MAX_PAGES
  )
    throw new Error(
      `Browser OCR supports complete invoices of up to ${BROWSER_OCR_MAX_PAGES} pages.`,
    );
  return { rawText, pageCount: Number(pageCount) };
}

export async function processInvoiceInBrowser(
  file: File,
  onProgress: (update: BrowserOcrProgress) => void,
  runtime?: BrowserOcrRuntime,
): Promise<BrowserOcrResult> {
  const isPdf = validateBrowserOcrFile(file);
  onProgress({ status: "Loading OCR engine...", progress: 0 });
  const engine = runtime || (await ocrOperation(loadRuntime(isPdf)));
  const loading = isPdf ? engine.openPdf(await file.arrayBuffer()) : undefined;
  let preview: Blob = file;
  let rawText = "";
  let worker: BrowserOcrWorker | undefined;
  let stopped = false;
  let activePage = 1;
  let activePageCount = 1;
  let activeStatus = "Loading OCR engine...";
  let activePassStart = 0;
  let activePassSpan = 0.7;
  const confidences: number[] = [];
  try {
    const pdf = loading ? await ocrOperation(loading.promise) : undefined;
    const pageCount = pdf?.numPages || 1;
    activePageCount = pageCount;
    // Reject larger documents explicitly so later-page totals cannot silently
    // disappear from an otherwise successful capture.
    if (pageCount > BROWSER_OCR_MAX_PAGES)
      throw new Error(
        `This PDF exceeds the ${BROWSER_OCR_MAX_PAGES}-page browser OCR limit. Split it into complete invoices before processing.`,
      );
    worker = await ocrOperation<BrowserOcrWorker>(engine.createWorker("eng", {
      logger(message) {
        if (stopped) return;
        if (message.status === "recognizing text")
          onProgress({
            status: activeStatus,
            progress: Math.round(
              ((activePage -
                1 +
                activePassStart +
                Number(message.progress || 0) * activePassSpan) /
                activePageCount) *
                100,
            ),
          });
        else if (message.status === "loading language traineddata")
          onProgress({
            status:
              "Loading English recognition data (" +
              Math.round(Number(message.progress || 0) * 100) +
              "%)...",
            progress: Math.round(((activePage - 1) / activePageCount) * 100),
          });
        else if (
          message.status === "initializing api" ||
          message.status === "loading tesseract core"
        )
          onProgress({
            status: "Initializing OCR engine...",
            progress: Math.round(((activePage - 1) / activePageCount) * 100),
          });
      },
    }).then(created => {
      // An engine can finish initializing after its deadline. Release that
      // late worker without letting an abandoned capture resume.
      if (stopped) {
        void ocrOperation(created.terminate(), OCR_CLEANUP_TIMEOUT_MS).catch(() => undefined);
        throw new BrowserOcrTimeoutError();
      }
      return created;
    }));
    await ocrOperation(worker.setParameters({
      preserve_interword_spaces: "1",
      tessedit_pageseg_mode: "3",
      user_defined_dpi: "300",
    }));
    for (let page = 1; page <= pageCount; page++) {
      activePage = page;
      activePassStart = 0;
      activePassSpan = 0.7;
      let image: Blob = file;
      if (pdf) {
        onProgress({
          status: "Converting PDF page " + page + " of " + pageCount + "...",
          progress: Math.round(((page - 1) / pageCount) * 100),
        });
        const pdfPage = await ocrOperation(pdf.getPage(page));
        const viewport = pdfPage.getViewport({ scale: BROWSER_PDF_SCALE });
        const canvas = engine.createCanvas();
        try {
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext("2d");
          if (!context)
            throw new Error("This browser cannot render PDF pages.");
          await ocrOperation(pdfPage.render({ canvasContext: context, viewport }).promise);
          image = await ocrOperation(new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (blob) =>
                blob
                  ? resolve(blob)
                  : reject(new Error("PDF page conversion failed.")),
              "image/png",
              0.95,
            ),
          ));
          if (page === 1) preview = image;
        } finally {
          canvas.width = 0;
          canvas.height = 0;
        }
      }
      const status = pdf
        ? "Processing page " + page + " of " + pageCount + "..."
        : "Processing image...";
      activeStatus = status;
      onProgress({
        status,
        progress: Math.round(((page - 1) / pageCount) * 100),
      });
      // Upscaling and contrast cleanup improve small decimal points and currency
      // glyphs. Auto-rotation handles phone photos taken in the wrong orientation.
      const primaryImage = engine.prepareImage
        ? await ocrOperation(engine.prepareImage(image, true))
        : image;
      const primary = await ocrOperation(worker.recognize(primaryImage, { rotateAuto: true }));
      let selected = primary;

      // Dense tables and sparse layouts segment punctuation differently. Retry
      // only weak results and score every complete read so a version that keeps
      // decimal amounts wins over one that merges the same digits.
      if (
        needsOcrAccuracyPass(
          primary.data.text,
          Number(primary.data.confidence || 0),
        )
      ) {
        activePassStart = 0.7;
        activePassSpan = 0.15;
        activeStatus = pdf
          ? "Improving details on page " + page + " of " + pageCount + "..."
          : "Improving currency and number accuracy...";
        onProgress({
          status: activeStatus,
          progress: Math.round(
            ((page - 1 + activePassStart) / pageCount) * 100,
          ),
        });
        try {
          await ocrOperation(worker.setParameters({ tessedit_pageseg_mode: "6" }));
          const alternateImage = engine.prepareImage
            ? await ocrOperation(engine.prepareImage(image, false))
            : image;
          const alternate = await ocrOperation(worker.recognize(alternateImage, {
            rotateAuto: true,
          }));
          if (
            invoiceOcrTextScore(
              alternate.data.text,
              Number(alternate.data.confidence || 0),
            ) >
            invoiceOcrTextScore(
              primary.data.text,
              Number(primary.data.confidence || 0),
            )
          )
            selected = alternate;
        } catch (error) {
          if (error instanceof BrowserOcrTimeoutError) throw error;
          // The primary reading remains usable if the optional accuracy pass
          // cannot run on a particular browser or image.
        }

        if (
          needsOcrAccuracyPass(
            selected.data.text,
            Number(selected.data.confidence || 0),
          )
        ) {
          activePassStart = 0.85;
          activePassSpan = 0.15;
          activeStatus = pdf
            ? "Recovering small numbers on page " + page + " of " + pageCount + "..."
            : "Recovering decimal points and small symbols...";
          onProgress({
            status: activeStatus,
            progress: Math.round(
              ((page - 1 + activePassStart) / pageCount) * 100,
            ),
          });
          try {
            await ocrOperation(worker.setParameters({ tessedit_pageseg_mode: "11" }));
            const sparseImage = engine.prepareImage
              ? await ocrOperation(engine.prepareImage(image, true))
              : image;
            const sparse = await ocrOperation(worker.recognize(sparseImage, {
              rotateAuto: true,
            }));
            if (
              invoiceOcrTextScore(
                sparse.data.text,
                Number(sparse.data.confidence || 0),
              ) >
              invoiceOcrTextScore(
                selected.data.text,
                Number(selected.data.confidence || 0),
              )
            )
              selected = sparse;
          } catch (error) {
            if (error instanceof BrowserOcrTimeoutError) throw error;
            // Keep the strongest earlier result when sparse recognition fails.
          }
        }

        try {
          await ocrOperation(worker.setParameters({ tessedit_pageseg_mode: "3" }), OCR_CLEANUP_TIMEOUT_MS);
        } catch {
          // The worker is terminated below even if its optional reset fails.
        }
      }
      if (engine.prepareImage && engine.imageRotations) {
        const rotations = await ocrOperation(engine.imageRotations(image));
        const weak = needsOcrAccuracyPass(selected.data.text, Number(selected.data.confidence || 0));
        // Auto deskew alone does not reliably read upside-down invoices. Check
        // portrait 180-degree candidates only for weak reads; landscape pages
        // also get upright 90/270 candidates. Choose actual text, never edits.
        if (weak || rotations.includes(90)) {
          activePassStart = 0.85; activePassSpan = 0.15;
          activeStatus = "Checking invoice orientation...";
          for (const rotation of rotations) {
            try {
              await ocrOperation(worker.setParameters({ tessedit_pageseg_mode: "3" }));
              const upright = await ocrOperation(engine.prepareImage(image, true, rotation));
              const reading = await ocrOperation(worker.recognize(upright, { rotateAuto: false }));
              // At equal quality, prefer pixels explicitly rendered upright
              // over the automatic orientation read; do not rewrite its text.
              if (invoiceOcrTextScore(reading.data.text, Number(reading.data.confidence || 0)) >=
                  invoiceOcrTextScore(selected.data.text, Number(selected.data.confidence || 0))) selected = reading;
            } catch (error) {
              if (error instanceof BrowserOcrTimeoutError) throw error;
              // An optional orientation read can fail without losing a usable
              // earlier read. The review workflow still validates its values.
            }
          }
        }
      }
      const text = selected.data.text;
      confidences.push(Number(selected.data.confidence || 0));
      rawText += pdf ? "\n--- Page " + page + " ---\n" + text + "\n" : text;
      onProgress({
        status,
        progress: Math.round((page / pageCount) * 100),
      });
    }
    rawText = rawText.trim();
    if (!rawText.replace(/--- Page \d+ ---/g, "").trim())
      throw new Error(
        "No readable text was found. Try another image or paste the invoice text.",
      );
    validateBrowserOcrText(rawText, pageCount);
    onProgress({ status: "OCR complete", progress: 100 });
    return {
      rawText,
      pageCount,
      preview,
      confidence:
        confidences.reduce((sum, confidence) => sum + confidence, 0) /
        confidences.length,
    };
  } finally {
    stopped = true;
    await Promise.allSettled([
      worker ? ocrOperation(worker.terminate(), OCR_CLEANUP_TIMEOUT_MS) : undefined,
      loading ? ocrOperation(loading.destroy(), OCR_CLEANUP_TIMEOUT_MS) : undefined,
    ]);
  }
}
