import { createServer } from "vite";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fixtures, fixtureDirectory } from "./ocr-accuracy/make-browser-fixtures.mjs";

const server = await createServer({ configFile: resolve("scripts/ocr-accuracy/vite.browser.config.mjs") });
let browser;
const report = { observedAt: new Date().toISOString(), scope: "Isolated local browser; real Tesseract/PDF.js on synthetic files; production capture hook with simulated API failures. Not live Shopify UI or provider verification.", recognition: [], ui: [], exceptions: [] };
try {
  await server.listen();
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "chrome" } : {}) });
  const page = await browser.newPage();
  page.on("pageerror", error => report.exceptions.push(error.message));
  await page.goto(base + "/scripts/ocr-accuracy/browser-matrix.html");
  await page.waitForFunction(() => window.harnessReady);
  for (const fixture of fixtures) {
    if (process.argv.includes("--ui-only")) break;
    const selectedIndex = process.argv.indexOf("--case");
    if (selectedIndex >= 0 && fixture.id !== process.argv[selectedIndex + 1]) continue;
    try {
      const result = await page.evaluate(fixture => window.runFixture(fixture), fixture);
      // Missing source fields must remain unknown; keep their full comparison
      // rather than calling a placeholder a correct OCR capture.
      result.result = result.comparison.result;
      if (fixture.absentFields.length) {
        result.result = result.pageCount === fixture.pages && result.parsed.date !== fixture.expected.dueDate &&
          result.warnings.some(warning => /invoice date was missing/i.test(warning)) &&
          [null, "Unknown Vendor"].includes(result.parsed.supplier) && result.comparison.failures.every(failure => fixture.absentFields.includes(failure.field)) ? "PASS_REVIEW_REQUIRED" : "FAIL";
      } else if (result.pageCount !== fixture.pages) result.result = "FAIL";
      report.recognition.push(result);
      console.log(`${fixture.id}: ${result.result}; ${result.comparison.matchedFields}/${result.comparison.checkedFields}; pages ${result.pageCount}`);
    } catch (error) { report.recognition.push({ id: fixture.id, result: "FAIL", error: error.message }); console.log(`${fixture.id}: FAIL; ${error.message}`); }
  }
  async function uiCase(name, setup, evaluate, clockAdvance = 0) {
    const check = await browser.newPage();
    const requests = [];
    check.on("pageerror", error => report.exceptions.push(`${name}: ${error.message}`));
    await check.route("**/api/upload-invoice", async route => { requests.push("upload"); await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ success: true, jobId: "fixture-job", status: "AWAITING_OCR" }) }); });
    await check.route("**/api/jobs", async route => { requests.push(route.request().postData()?.includes("fail-browser-ocr") ? "failed-job" : "complete-job"); await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, invoiceId: "fixture-invoice" }) }); });
    await check.goto(base + "/scripts/ocr-accuracy/browser-matrix.html");
    await check.waitForFunction(() => window.harnessReady);
    await setup(check);
    await check.locator('[name="file"]').setInputFiles(resolve(fixtureDirectory, "PNG.png"));
    await check.getByRole("button", { name: "Capture invoices", exact: true }).click();
    if (clockAdvance) {
      await check.waitForFunction(() => window.fixtureWorkerStage);
      await check.clock.runFor(clockAdvance);
      await check.waitForFunction(() => !JSON.parse(document.querySelector("#state").textContent).busy, null, { polling: 100, timeout: 5000 }).catch(() => undefined);
    }
    else await check.waitForFunction(() => !JSON.parse(document.querySelector("#state").textContent).busy, null, { timeout: 20000 });
    const state = JSON.parse(await check.locator("#state").innerText());
    const enabled = await check.getByRole("button", { name: "Capture invoices", exact: true }).isEnabled();
    const result = evaluate(state, requests, enabled);
    report.ui.push({ name, result: result ? "PASS" : "FAIL", state, requests, enabled });
    console.log(`${name}: ${result ? "PASS" : "FAIL"}`);
    if (result && /OCR (?:service failure|initialization timeout|recognition timeout)/.test(name)) {
      await reader(check);
      await check.route("**/api/jobs/document?**", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: base + "/ocr-fixtures/PNG.png", filename: "PNG.png", contentType: "image/png" }) }));
      await check.getByRole("button", { name: "Retry processing", exact: true }).click();
      await check.waitForFunction(() => !JSON.parse(document.querySelector("#state").textContent).busy && JSON.parse(document.querySelector("#state").textContent).saved.length === 1, null, { polling: 100, timeout: 20000 });
      const recovered = JSON.parse(await check.locator("#state").innerText());
      const pass = !recovered.busy && !recovered.error && recovered.saved.length === 1 && requests.filter(r => r === "upload").length === 1;
      report.ui.push({ name: name + ": retry original without another upload", result: pass ? "PASS" : "FAIL", state: recovered, requests: [...requests] });
      console.log(`${name}: retry ${pass ? "PASS" : "FAIL"}`);
    }
    await check.close();
  }
  const goodText = "INVOICE FIXTURE-01\nSupplier: MCP Matrix Supplies\nInvoice Date: 2026-10-11\nDescription Qty Rate Amount\nPrinter paper 2.5 12.50 31.25\nSubtotal 31.25\nTax 3.13\nTotal USD 34.38";
  const reader = async (check, mode = "good") => check.evaluate(({ goodText, mode }) => {
    window.Tesseract = { createWorker: async () => {
      if (mode === "stalled-init") { window.fixtureWorkerStage = "initializing"; return new Promise(() => {}); }
      return { setParameters: async () => {}, recognize: async () => {
        if (mode === "stalled-read") { window.fixtureWorkerStage = "recognizing"; return new Promise(() => {}); }
        if (mode === "failure") throw new Error("HTTP 503 XERO_CLIENT_SECRET confidential");
        return { data: { text: goodText, confidence: 96 } };
      }, terminate: async () => {} };
    } };
  }, { goodText, mode });
  await uiCase("OCR service failure is a safe UI error", check => reader(check, "failure"), (state, requests, enabled) => !state.busy && enabled && state.error && !/HTTP|SECRET|confidential/.test(state.error) && requests.includes("failed-job") && !requests.includes("complete-job"));
  await uiCase("Unexpected API failure retains a usable UI", async check => { await reader(check); await check.route("**/api/upload-invoice", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "HTTP 500 postgres://private credential" }) })); }, (state, requests, enabled) => !state.busy && enabled && state.error && !/HTTP|postgres|credential/.test(state.error) && !requests.includes("complete-job"));
  await uiCase("Expired session produces reload guidance", async check => { await reader(check); await check.route("**/api/upload-invoice", route => route.fulfill({ status: 401, contentType: "text/html", body: "<h1>Session expired</h1>" })); }, (state, requests, enabled) => !state.busy && enabled && /session|Reload/i.test(state.error) && !requests.includes("complete-job"));
  await uiCase("OCR initialization timeout releases capture", async check => { await check.clock.install(); await reader(check, "stalled-init"); }, (state, requests, enabled) => !state.busy && enabled && /timed out|too long/i.test(state.error) && requests.includes("failed-job"), 130000);
  await uiCase("OCR recognition timeout releases capture", async check => { await check.clock.install(); await reader(check, "stalled-read"); }, (state, requests, enabled) => !state.busy && enabled && /timed out|too long/i.test(state.error) && requests.includes("failed-job"), 130000);
} catch (error) { report.fatal = error.message; }
finally {
  await browser?.close(); await server.close();
  report.result = !report.fatal && !report.exceptions.length && report.recognition.every(check => check.result !== "FAIL") && report.ui.every(check => check.result === "PASS") ? "PASS" : "FAIL";
  const directory = resolve(".cache/ocr-accuracy/browser-runs"); await mkdir(directory, { recursive: true });
  const output = resolve(directory, report.observedAt.replace(/[:.]/g, "-") + ".json");
  await writeFile(output, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ result: report.result, fatal: report.fatal, output }));
  if (report.result !== "PASS") process.exitCode = 1;
}
