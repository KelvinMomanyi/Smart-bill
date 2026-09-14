import { MAX_FILE_BYTES } from "./plans";

// Match the working processor in old/app/components/InvoiceUpload.tsx.
export const BROWSER_OCR_MAX_PAGES = 5;
export const BROWSER_PDF_SCALE = 2;
export const BROWSER_OCR_SCRIPTS = {
  tesseract:
    "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js",
  pdf: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfWorker:
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
} as const;

export type BrowserOcrProgress = { status: string; progress: number };
export type BrowserOcrResult = {
  rawText: string;
  pageCount: number;
  preview: Blob;
};
type ProgressMessage = { status: string; progress: number };
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
  recognize(
    image: Blob,
    language: string,
    options: { logger(message: ProgressMessage): void },
  ): Promise<{ data: { text: string } }>;
  openPdf(data: ArrayBuffer): {
    promise: Promise<PdfDocument>;
    destroy(): Promise<void>;
  };
  createCanvas(): HTMLCanvasElement;
};
type OcrWindow = Window & {
  Tesseract?: Pick<BrowserOcrRuntime, "recognize">;
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
    recognize: (image, language, options) =>
      scope.Tesseract!.recognize(image, language, options),
    openPdf: (data) =>
      scope.pdfjsLib!.getDocument({ data, isEvalSupported: false }),
    createCanvas: () => document.createElement("canvas"),
  };
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
  try {
    const pdf = await loading?.promise;
    const pageCount = pdf?.numPages || 1;
    // The original limited processing to five pages. Reject larger documents
    // explicitly so totals on later pages cannot silently disappear.
    if (pageCount > BROWSER_OCR_MAX_PAGES)
      throw new Error(
        "This PDF exceeds the 5-page browser OCR limit. Split it into complete invoices before processing.",
      );
    for (let page = 1; page <= pageCount; page++) {
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
      onProgress({
        status,
        progress: Math.round(((page - 1) / pageCount) * 100),
      });
      // Preserve the original image, English model and default segmentation.
      // Recognition runs on the device, outside a Vercel request deadline.
      const {
        data: { text },
      } = await engine.recognize(image, "eng", {
        logger(message) {
          if (message.status === "recognizing text")
            onProgress({
              status,
              progress: Math.round(
                ((page - 1 + message.progress) / pageCount) * 100,
              ),
            });
          else if (message.status === "loading language traineddata")
            onProgress({
              status: "Loading English recognition data (" + Math.round(message.progress * 100) + "%)...",
              progress: Math.round((page - 1) / pageCount * 100),
            });
          else if (message.status === "initializing api" || message.status === "loading tesseract core")
            onProgress({
              status: "Initializing OCR engine...",
              progress: Math.round((page - 1) / pageCount * 100),
            });
        },
      });
      rawText += pdf ? "\n--- Page " + page + " ---\n" + text + "\n" : text;
    }
    rawText = rawText.trim();
    if (!rawText.replace(/--- Page \d+ ---/g, "").trim())
      throw new Error(
        "No readable text was found. Try another image or paste the invoice text.",
      );
    validateBrowserOcrText(rawText, pageCount);
    onProgress({ status: "OCR complete", progress: 100 });
    return { rawText, pageCount, preview };
  } finally {
    await loading?.destroy();
  }
}
