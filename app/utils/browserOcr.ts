import { MAX_FILE_BYTES } from "./plans";

// Match the working processor in old/app/components/InvoiceUpload.tsx.
export const BROWSER_OCR_MAX_PAGES = 5;
export const BROWSER_PDF_SCALE = 2;
export const BROWSER_OCR_MIN_WIDTH = 1800;
export const BROWSER_OCR_MAX_EDGE = 3600;
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
  prepareImage?(image: Blob, monochrome: boolean): Promise<Blob>;
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
    prepareImage: (image, monochrome) =>
      prepareBrowserInvoiceImage(image, monochrome),
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

async function prepareBrowserInvoiceImage(image: Blob, monochrome: boolean) {
  const source = await createImageBitmap(image);
  const dimensions = browserOcrImageDimensions(source.width, source.height);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  try {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot prepare invoice images.");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
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
  const currency = /[$€£¥₹₦₵₱]|R\$|KSh|\b(?:USD|EUR|GBP|CAD|AUD|NZD|KES|ZAR|NGN|GHS|JPY|CNY|INR|AED|UGX|TZS|RWF|BRL|PHP)\b/i.test(
    text,
  );
  return (
    Math.max(0, confidence) * 3 +
    labels * 100 +
    Math.min(decimalAmounts, 12) * 90 +
    (currency ? 100 : 0) +
    Math.min(text.trim().length, 2000) * 0.1
  );
}

export function needsOcrAccuracyPass(text: string, confidence = 0) {
  return (
    confidence < 70 ||
    !/\b(?:invoice|inv)\b/i.test(text) ||
    !/\b(?:total|amount due|balance due)\b/i.test(text) ||
    !/(?:[$€£¥₹₦₵₱]|R\$|KSh|\b(?:USD|EUR|GBP|CAD|AUD|NZD|KES|ZAR|NGN|GHS|JPY|CNY|INR|AED|UGX|TZS|RWF|BRL|PHP)\b)/i.test(
      text,
    ) ||
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
    throw new Error("Browser OCR supports complete invoices of up to 5 pages.");
  return { rawText, pageCount: Number(pageCount) };
}

export async function processInvoiceInBrowser(
  file: File,
  onProgress: (update: BrowserOcrProgress) => void,
  runtime?: BrowserOcrRuntime,
): Promise<BrowserOcrResult> {
  const isPdf = validateBrowserOcrFile(file);
  onProgress({ status: "Loading OCR engine...", progress: 0 });
  const engine = runtime || (await loadRuntime(isPdf));
  const loading = isPdf ? engine.openPdf(await file.arrayBuffer()) : undefined;
  let preview: Blob = file;
  let rawText = "";
  let worker: BrowserOcrWorker | undefined;
  let activePage = 1;
  let activePageCount = 1;
  let activeStatus = "Loading OCR engine...";
  let activePassStart = 0;
  let activePassSpan = 0.7;
  const confidences: number[] = [];
  try {
    const pdf = await loading?.promise;
    const pageCount = pdf?.numPages || 1;
    activePageCount = pageCount;
    // The original limited processing to five pages. Reject larger documents
    // explicitly so totals on later pages cannot silently disappear.
    if (pageCount > BROWSER_OCR_MAX_PAGES)
      throw new Error(
        "This PDF exceeds the 5-page browser OCR limit. Split it into complete invoices before processing.",
      );
    worker = await engine.createWorker("eng", {
      logger(message) {
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
    });
    await worker.setParameters({
      preserve_interword_spaces: "1",
      tessedit_pageseg_mode: "3",
      user_defined_dpi: "300",
    });
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
        const pdfPage = await pdf.getPage(page);
        const viewport = pdfPage.getViewport({ scale: BROWSER_PDF_SCALE });
        const canvas = engine.createCanvas();
        try {
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const context = canvas.getContext("2d");
          if (!context)
            throw new Error("This browser cannot render PDF pages.");
          await pdfPage.render({ canvasContext: context, viewport }).promise;
          image = await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (blob) =>
                blob
                  ? resolve(blob)
                  : reject(new Error("PDF page conversion failed.")),
              "image/png",
              0.95,
            ),
          );
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
        ? await engine.prepareImage(image, true)
        : image;
      const primary = await worker.recognize(primaryImage, { rotateAuto: true });
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
          await worker.setParameters({ tessedit_pageseg_mode: "6" });
          const alternateImage = engine.prepareImage
            ? await engine.prepareImage(image, false)
            : image;
          const alternate = await worker.recognize(alternateImage, {
            rotateAuto: true,
          });
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
        } catch {
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
            await worker.setParameters({ tessedit_pageseg_mode: "11" });
            const sparseImage = engine.prepareImage
              ? await engine.prepareImage(image, true)
              : image;
            const sparse = await worker.recognize(sparseImage, {
              rotateAuto: true,
            });
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
          } catch {
            // Keep the strongest earlier result when sparse recognition fails.
          }
        }

        try {
          await worker
            .setParameters({ tessedit_pageseg_mode: "3" });
        } catch {
          // The worker is terminated below even if its optional reset fails.
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
    await Promise.allSettled([worker?.terminate(), loading?.destroy()]);
  }
}
