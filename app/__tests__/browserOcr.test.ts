import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browserOcrImageDimensions,
  invoiceOcrTextScore,
  needsOcrAccuracyPass,
  processInvoiceInBrowser,
  validateBrowserOcrText,
  type BrowserOcrRuntime,
  type BrowserOcrProgress,
} from "../utils/browserOcr";
import { validateDocument } from "../utils/upload.server";

type Recognition = { data: { text: string; confidence?: number } };

function fakeRuntime(
  count = 1,
  recognize: (call: number) => Promise<Recognition> = async (call) => ({
    data: {
      text:
        "INVOICE INV-100\nDate 2026-09-15\nTotal USD $" +
        call +
        "0.00\n",
      confidence: 92,
    },
  }),
) {
  const calls: Array<{
    image: Blob;
    language: string;
    options?: { rotateAuto?: boolean };
  }> = [];
  const parameters: Array<Record<string, string>> = [];
  const scales: number[] = [];
  const canvasSizes: number[][] = [];
  let destroyed = false;
  let terminated = false;
  let workerCount = 0;
  const runtime: BrowserOcrRuntime = {
    createWorker: async (language, { logger }) => {
      workerCount += 1;
      logger({ status: "loading tesseract core", progress: 1 });
      return {
        setParameters: async (value) => {
          parameters.push(value);
        },
        recognize: async (image, options) => {
          calls.push({ image, language, options });
          logger({ status: "recognizing text", progress: 0.5 });
          logger({ status: "recognizing text", progress: 1 });
          return recognize(calls.length);
        },
        terminate: async () => {
          terminated = true;
        },
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
  return {
    runtime,
    calls,
    parameters,
    scales,
    canvasSizes,
    destroyed: () => destroyed,
    terminated: () => terminated,
    workerCount: () => workerCount,
  };
}

test("browser OCR configures one English worker with auto-rotation", async () => {
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
  assert.deepEqual(mock.calls[0].options, { rotateAuto: true });
  assert.equal(mock.workerCount(), 1);
  assert.equal(mock.terminated(), true);
  assert.deepEqual(mock.parameters[0], {
    preserve_interword_spaces: "1",
    tessedit_pageseg_mode: "3",
    user_defined_dpi: "300",
  });
  assert.equal(result.preview, file);
  assert.equal(result.pageCount, 1);
  assert.equal(result.confidence, 92);
  assert.match(result.rawText, /Total USD \$10.00/);
  assert.equal(mock.scales.length, 0);
  assert.equal(progress.at(-1)?.progress, 100);
});

test("browser PDFs render at 2x and reuse one worker for every page", async () => {
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
  assert.equal(mock.workerCount(), 1);
  assert.equal(mock.terminated(), true);
  assert.equal(result.pageCount, 2);
  assert.equal(result.preview, mock.calls[0].image);
  assert.match(
    result.rawText,
    /--- Page 1 ---[\s\S]*10.00[\s\S]*--- Page 2 ---[\s\S]*20.00/,
  );
  assert.ok(progress.some((value) => value.progress === 50));
  assert.ok(
    progress.every(
      (value, index) => !index || value.progress >= progress[index - 1].progress,
    ),
  );
  assert.equal(mock.destroyed(), true);
});

test("browser PDFs over ten pages fail without silently dropping pages", async () => {
  const mock = fakeRuntime(11);
  await assert.rejects(
    processInvoiceInBrowser(
      new File(["%PDF-"], "invoice.pdf", { type: "application/pdf" }),
      () => {},
      mock.runtime,
    ),
    /10-page/,
  );
  assert.equal(mock.calls.length, 0);
  assert.equal(mock.destroyed(), true);
});

test("browser OCR errors release PDF resources and blank scans are not saved", async () => {
  for (const fail of [true, false]) {
    const mock = fakeRuntime(1, async () => {
      if (fail) throw new Error("Recognition failed");
      return { data: { text: " \n ", confidence: 90 } };
    });
    await assert.rejects(
      processInvoiceInBrowser(
        new File(["%PDF-"], "invoice.pdf", { type: "application/pdf" }),
        () => {},
        mock.runtime,
      ),
      fail ? /Recognition failed/ : /No readable text/,
    );
    assert.equal(mock.destroyed(), true);
    assert.equal(mock.terminated(), true);
  }
});

test("weak OCR gets an alternate-layout accuracy pass and keeps the stronger result", async () => {
  const mock = fakeRuntime(1, async (call) =>
    call === 1
      ? { data: { text: "lnvoice\nTotaI S55 89", confidence: 54 } }
      : {
          data: {
            text: "Invoice INV-55\nDate 2026-09-15\nTotal USD $55.89",
            confidence: 88,
          },
        },
  );
  const prepared: boolean[] = [];
  mock.runtime.prepareImage = async (image, monochrome) => {
    prepared.push(monochrome);
    return image;
  };
  const result = await processInvoiceInBrowser(
    new File(["image"], "invoice.png", { type: "image/png" }),
    () => {},
    mock.runtime,
  );
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(prepared, [true, false]);
  assert.ok(mock.parameters.some((value) => value.tessedit_pageseg_mode === "6"));
  assert.match(result.rawText, /\$55\.89/);
  assert.equal(result.confidence, 88);
});

test("OCR uses a sparse pass when dense layouts still lose the decimal", async () => {
  const mock = fakeRuntime(1, async (call) => {
    if (call === 3)
      return {
        data: {
          text: "Invoice INV-906\nDate 2026-09-15\nTotal USD $9.06",
          confidence: 78,
        },
      };
    return {
      data: {
        text: "Invoice INV-906\nDate 2026-09-15\nTotal USD $906",
        confidence: 84,
      },
    };
  });
  const prepared: boolean[] = [];
  mock.runtime.prepareImage = async (image, monochrome) => {
    prepared.push(monochrome);
    return image;
  };

  const result = await processInvoiceInBrowser(
    new File(["image"], "invoice.png", { type: "image/png" }),
    () => {},
    mock.runtime,
  );

  assert.equal(mock.calls.length, 3);
  assert.deepEqual(prepared, [true, false, true]);
  assert.ok(mock.parameters.some((value) => value.tessedit_pageseg_mode === "6"));
  assert.ok(mock.parameters.some((value) => value.tessedit_pageseg_mode === "11"));
  assert.match(result.rawText, /\$9\.06/);
});

test("OCR sizing and quality scoring favor readable invoice amounts", () => {
  assert.deepEqual(browserOcrImageDimensions(700, 1000), {
    width: 1800,
    height: 2571,
  });
  assert.deepEqual(browserOcrImageDimensions(4000, 2000), {
    width: 3600,
    height: 1800,
  });
  assert.equal(needsOcrAccuracyPass("Invoice\nTotal USD $55.89", 85), false);
  assert.equal(needsOcrAccuracyPass("Invoice\nTotal 55 89", 85), true);
  assert.ok(
    invoiceOcrTextScore("Invoice\nDate\nTotal USD $55.89", 85) >
      invoiceOcrTextScore("lnvoice\nTotaI S55 89", 54),
  );
});

test("browser OCR rejects malformed results and accepts legacy BMP uploads", () => {
  for (const pageCount of [0, 11, 1.5, NaN, "1"])
    assert.throws(() => validateBrowserOcrText("Invoice text", pageCount));
  for (const rawText of ["", " ".repeat(10), "x".repeat(200001), {}])
    assert.throws(() => validateBrowserOcrText(rawText, 1));
  assert.equal(
    validateDocument(Buffer.from("BMtest-image"), "invoice.bmp", "image/bmp"),
    "image/bmp",
  );
});
