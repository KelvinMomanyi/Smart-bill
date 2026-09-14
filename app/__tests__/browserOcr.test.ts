import assert from "node:assert/strict";
import { test } from "node:test";
import {
  processInvoiceInBrowser,
  validateBrowserOcrText,
  type BrowserOcrRuntime,
  type BrowserOcrProgress,
} from "../utils/browserOcr";
import { validateDocument } from "../utils/upload.server";

function fakeRuntime(count = 1) {
  const calls: Array<{ image: Blob; language: string }> = [];
  const scales: number[] = [];
  const canvasSizes: number[][] = [];
  let destroyed = false;
  const runtime: BrowserOcrRuntime = {
    recognize: async (image, language, { logger }) => {
      calls.push({ image, language });
      logger({ status: "recognizing text", progress: 0.5 });
      logger({ status: "recognizing text", progress: 1 });
      return {
        data: { text: "INVOICE INV-100\nTotal USD " + calls.length + "0.00\n" },
      };
    },
    openPdf: () => ({
      promise: Promise.resolve({
        numPages: count,
        getPage: async () => ({
          getViewport: ({ scale }) => {
            scales.push(scale);
            return { width: 612 * scale, height: 792 * scale };
          },
          render: () => ({ promise: Promise.resolve() }),
        }),
      }),
      destroy: async () => {
        destroyed = true;
      },
    }),
    createCanvas: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({}),
        toBlob: (callback: BlobCallback, type: string, quality: number) => {
          canvasSizes.push([canvas.width, canvas.height]);
          assert.equal(type, "image/png");
          assert.equal(quality, 0.95);
          callback(new Blob(["rendered page"], { type }));
        },
      };
      return canvas as unknown as HTMLCanvasElement;
    },
  };
  return { runtime, calls, scales, canvasSizes, destroyed: () => destroyed };
}

test("legacy browser OCR passes original images directly to English Tesseract", async () => {
  const mock = fakeRuntime();
  const file = new File(["image"], "invoice.webp", { type: "image/webp" });
  const progress: BrowserOcrProgress[] = [];
  const result = await processInvoiceInBrowser(
    file,
    (value) => progress.push(value),
    mock.runtime,
  );
  assert.equal(mock.calls[0].image, file);
  assert.equal(mock.calls[0].language, "eng");
  assert.equal(result.preview, file);
  assert.equal(result.pageCount, 1);
  assert.match(result.rawText, /Total USD 10.00/);
  assert.equal(mock.scales.length, 0);
  assert.equal(progress.at(-1)?.progress, 100);
});

test("legacy browser PDFs render at 2x and OCR every page with ordered text and progress", async () => {
  const mock = fakeRuntime(2);
  const progress: BrowserOcrProgress[] = [];
  const result = await processInvoiceInBrowser(
    new File(["%PDF-"], "invoice.pdf", { type: "application/pdf" }),
    (value) => progress.push(value),
    mock.runtime,
  );
  assert.deepEqual(mock.scales, [2, 2]);
  assert.deepEqual(mock.canvasSizes, [
    [1224, 1584],
    [1224, 1584],
  ]);
  assert.equal(mock.calls.length, 2);
  assert.equal(result.pageCount, 2);
  assert.equal(result.preview, mock.calls[0].image);
  assert.match(
    result.rawText,
    /--- Page 1 ---[\s\S]*10.00[\s\S]*--- Page 2 ---[\s\S]*20.00/,
  );
  assert.ok(progress.some((value) => value.progress === 25));
  assert.ok(progress.some((value) => value.progress === 75));
  assert.equal(mock.destroyed(), true);
});

test("browser PDFs over five pages fail without silently dropping pages", async () => {
  const mock = fakeRuntime(6);
  await assert.rejects(
    processInvoiceInBrowser(
      new File(["%PDF-"], "invoice.pdf", { type: "application/pdf" }),
      () => {},
      mock.runtime,
    ),
    /5-page/,
  );
  assert.equal(mock.calls.length, 0);
  assert.equal(mock.destroyed(), true);
});

test("browser OCR errors release PDF resources and blank scans are not saved", async () => {
  for (const fail of [true, false]) {
    const mock = fakeRuntime();
    mock.runtime.recognize = async () => {
      if (fail) throw new Error("Recognition failed");
      return { data: { text: " \n " } };
    };
    await assert.rejects(
      processInvoiceInBrowser(
        new File(["%PDF-"], "invoice.pdf", { type: "application/pdf" }),
        () => {},
        mock.runtime,
      ),
      fail ? /Recognition failed/ : /No readable text/,
    );
    assert.equal(mock.destroyed(), true);
  }
});

test("browser OCR rejects malformed results and accepts legacy BMP uploads", () => {
  for (const pageCount of [0, 6, 1.5, NaN, "1"])
    assert.throws(() => validateBrowserOcrText("Invoice text", pageCount));
  for (const rawText of ["", " ".repeat(10), "x".repeat(200001), {}])
    assert.throws(() => validateBrowserOcrText(rawText, 1));
  assert.equal(
    validateDocument(Buffer.from("BMtest-image"), "invoice.bmp", "image/bmp"),
    "image/bmp",
  );
});
