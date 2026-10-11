import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browserOcrImageDimensions,
  BROWSER_OCR_OPERATION_TIMEOUT_MS,
  invoiceOcrTextScore,
  invoiceOcrSummaryBalance,
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

test("a stalled OCR initialization times out and releases a worker that arrives late", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mock = fakeRuntime();
  let resolveWorker: (worker: Awaited<ReturnType<BrowserOcrRuntime["createWorker"]>>) => void = () => {};
  let terminated = false;
  mock.runtime.createWorker = () => new Promise(resolve => { resolveWorker = resolve; });
  const operation = processInvoiceInBrowser(new File(["image"], "invoice.png", { type: "image/png" }), () => {}, mock.runtime);
  const rejected = assert.rejects(operation, /took too long.*Retry processing/i);
  t.mock.timers.tick(BROWSER_OCR_OPERATION_TIMEOUT_MS);
  await rejected;
  resolveWorker({ setParameters: async () => {}, recognize: async () => ({ data: { text: "late" } }), terminate: async () => { terminated = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(terminated, true);
});

test("stalled recognition times out, stops optional reads and terminates its worker", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mock = fakeRuntime(1, () => new Promise(() => {}));
  const operation = processInvoiceInBrowser(new File(["image"], "invoice.png", { type: "image/png" }), () => {}, mock.runtime);
  const rejected = assert.rejects(operation, /took too long/i);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(BROWSER_OCR_OPERATION_TIMEOUT_MS);
  await rejected;
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.terminated(), true);
});

test("worker cleanup cannot keep a timed-out capture pending indefinitely", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mock = fakeRuntime();
  mock.runtime.createWorker = async () => ({ setParameters: async () => {}, recognize: () => new Promise(() => {}), terminate: () => new Promise(() => {}) });
  const operation = processInvoiceInBrowser(new File(["image"], "invoice.png", { type: "image/png" }), () => {}, mock.runtime);
  const rejected = assert.rejects(operation, /took too long/i);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(BROWSER_OCR_OPERATION_TIMEOUT_MS);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(5000);
  await rejected;
});

test("an upside-down image uses an upright recognition read rather than guessed fields", async () => {
  const upright = "Invoice ROTATION-1\nDate 2026-10-11\nSubtotal 10.00\nTax 0.00\nTotal USD 10.00";
  const mock = fakeRuntime(1, async call => ({ data: { text: call === 4 ? upright : "JOIOANI unreadable upside down", confidence: call === 4 ? 96 : 40 } }));
  const rotations: number[] = [];
  mock.runtime.prepareImage = async (image, _monochrome, rotation = 0) => { rotations.push(rotation); return image; };
  mock.runtime.imageRotations = async () => [180];
  const result = await processInvoiceInBrowser(new File(["image"], "invoice.png", { type: "image/png" }), () => {}, mock.runtime);
  assert.equal(result.rawText, upright);
  assert.ok(rotations.includes(180));
  assert.equal(mock.calls.at(-1)?.options?.rotateAuto, false);
});

test("equal-quality landscape readings prefer the explicitly upright recognition", async () => {
  const wrong = "Invoice ROTATEDS0\nDate 2026-10-11\nSubtotal 10.00\nTax 0.00\nTotal USD 10.00";
  const upright = wrong.replace("ROTATEDS0", "ROTATED90");
  assert.equal(invoiceOcrTextScore(wrong, 94), invoiceOcrTextScore(upright, 94));
  const mock = fakeRuntime(1, async call => ({ data: { text: call === 1 ? wrong : call === 2 ? "upside down" : upright, confidence: call === 2 ? 30 : 94 } }));
  mock.runtime.prepareImage = async image => image;
  mock.runtime.imageRotations = async () => [90, 270];
  const result = await processInvoiceInBrowser(new File(["image"], "invoice.png", { type: "image/png" }), () => {}, mock.runtime);
  assert.equal(result.rawText, upright);
  assert.equal(mock.calls.length, 3);
});

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

test("high-confidence OCR with a wrong total gets a real alternate read, not invented digits", async () => {
  const wrong = "Invoice 2001321\nDate 12/26/2024\nProduct 1 5 100.00 L.E. 500.00 L.E.\nproduct 2 3 20.00 L.E. 60.00 L.E.\nproduct 3 1 25.00 L.E. 25.00 L.E.\nSubtotal 585.00 L.E.\nDiscount (10%) 58.50 L.E.\nTax 1 52.65 L.E.\nTotal 679.15 L.E.";
  const correct = wrong.replace("679.15", "579.15");
  assert.equal(invoiceOcrSummaryBalance(wrong), false);
  assert.equal(invoiceOcrSummaryBalance(correct), true);
  assert.equal(needsOcrAccuracyPass(wrong, 91), true);
  assert.equal(needsOcrAccuracyPass(correct, 85), false);
  assert.ok(invoiceOcrTextScore(correct, 85) > invoiceOcrTextScore(wrong, 91));
  const mock = fakeRuntime(1, async call => ({data: {text: call === 1 ? wrong : correct, confidence: call === 1 ? 91 : 85}}));
  const result = await processInvoiceInBrowser(new File(["image"], "invoice.webp", {type: "image/webp"}), () => {}, mock.runtime);
  assert.equal(mock.calls.length, 2);
  assert.equal(result.rawText, correct);
});

test("OCR summary scoring handles explicit tax totals and defers unsupported summaries", () => {
  const summary = "Subtotal 2,100.00\nGST 10% from 100.00 10.00\nGST 20% from 2,000.00 400.00\nTax total 410.00\nTotal (AUD): 2,510.00";
  assert.equal(invoiceOcrSummaryBalance(summary), true);
  assert.equal(invoiceOcrSummaryBalance(summary.replace("Tax total 410.00\n", "")), true);
  assert.equal(invoiceOcrSummaryBalance("Subtotal 100.00\nTax 10%\nTotal 110.00"), null);
  assert.equal(invoiceOcrSummaryBalance("Subtotal 100.00\nFreight 10.00\nTax 11.00\nTotal 121.00"), null);
  assert.equal(invoiceOcrSummaryBalance("Subtotal 1.234,56\nTax 0,00\nTotal EUR 1.234,56"), true);
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
