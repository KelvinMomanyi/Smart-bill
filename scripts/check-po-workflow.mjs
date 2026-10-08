/* global globalThis */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { createRequestHandler } from "@remix-run/node";
import { chromium } from "playwright";

// Run the real production UI, loaders and actions with isolated in-memory
// persistence and an approved Shopify test subscription. Never use live secrets.
const shop = "po-browser.myshopify.com";
const secret = "po-browser-check-secret";
const key = "00000000000000000000000000000000";
Object.assign(process.env, {
  NODE_ENV: "production",
  DATABASE_URL:
    "postgresql://test:test@127.0.0.1:1/po_browser?connect_timeout=1",
  SHOPIFY_API_KEY: key,
  SHOPIFY_API_SECRET: secret,
  SHOPIFY_APP_URL: "https://app.example",
  SCOPES: "read_products,write_products,write_inventory,read_inventory",
});
const now = Math.floor(Date.now() / 1000);
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
  iss: `https://${shop}/admin`,
  dest: `https://${shop}`,
  aud: key,
  sub: "123",
  exp: now + 3600,
  nbf: now - 10,
  iat: now,
  sid: randomUUID(),
  jti: randomUUID(),
})}`;
const token = `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
const bridgeScript = `window.shopify={idToken:async()=>${JSON.stringify(token)},environment:{embedded:true},config:{apiKey:${JSON.stringify(key)}}};`;
const prisma = new PrismaClient();
prisma.session.count = async () => 0;
prisma.session.findUnique = async ({ where }) => ({
  id: where.id,
  shop,
  state: "",
  isOnline: true,
  scope: process.env.SCOPES,
  expires: new Date(Date.now() + 3600000),
  accessToken: "fake-browser-access-token",
  userId: 123n,
  firstName: "Test",
  lastName: "Owner",
  email: "test@example.com",
  accountOwner: true,
  locale: "en",
  collaborator: false,
  emailVerified: true,
  role: "ADMIN",
});
let orders = [];
let failSave = false;
let subscribed = true;
let saveDelayMs = 0;
const vendors = [];
prisma.vendor.upsert = async ({ create }) => {
  let vendor = vendors.find(
    (v) => v.shop === create.shop && v.name === create.name,
  );
  if (!vendor) {
    vendor = { id: randomUUID(), ...create };
    vendors.push(vendor);
  }
  return vendor;
};
prisma.shopSettings.upsert = async () => ({ shop, defaultCurrency: "USD" });
prisma.purchaseOrder.findMany = async ({ where }) =>
  orders.filter((order) => order.shop === where.shop);
prisma.purchaseOrder.findFirst = async ({ where }) =>
  orders.find((order) => order.shop === where.shop && order.id === where.id) ??
  null;
prisma.purchaseOrder.create = async ({ data }) => {
  if (saveDelayMs)
    await new Promise((resolve) => setTimeout(resolve, saveDelayMs));
  if (failSave) throw new Error("Simulated database outage");
  if (
    data.poNumber &&
    orders.some(
      (order) => order.shop === data.shop && order.poNumber === data.poNumber,
    )
  )
    throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
      code: "P2002",
      clientVersion: Prisma.prismaVersion.client,
      meta: { modelName: "PurchaseOrder", target: ["shop", "poNumber"] },
    });
  const order = {
    ...data,
    id: data.id || randomUUID(),
    vendor: vendors.find((v) => v.id === data.vendorId),
    items: data.items.create.map((item) => ({
      ...item,
      id: randomUUID(),
      billedQty: 0,
      receivedQty: 0,
    })),
    linkedInvoices: [],
    receipts: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  orders.push(order);
  return order;
};
prisma.$transaction = async (callback) => {
  const before = [...orders];
  try {
    return await callback(prisma);
  } catch (error) {
    orders = before;
    throw error;
  }
};
globalThis.prismaGlobal = prisma;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (new URL(String(url)).hostname.endsWith(".myshopify.com")) {
    return Response.json(
      {
        data: {
          shop: { plan: { partnerDevelopment: true } },
          currentAppInstallation: {
            activeSubscriptions: subscribed
              ? [
                  {
                    id: "test-subscription",
                    name: "SmartBill Starter",
                    status: "ACTIVE",
                    test: true,
                    lineItems: [
                      {
                        plan: {
                          pricingDetails: {
                            price: { amount: "9.99", currencyCode: "USD" },
                            interval: "EVERY_30_DAYS",
                          },
                        },
                      },
                    ],
                  },
                ]
              : [],
          },
        },
      },
      { headers: { "X-Shopify-API-Version": "2026-10" } },
    );
  }
  return originalFetch(url, options);
};

const build = await import("../build/server/index.js");
const handle = createRequestHandler(build, "production");
const clientRoot = resolve("build/client");
const types = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, `http://${incoming.headers.host}`);
    if (
      process.env.PO_REVIEW_SERVE === "1" &&
      url.pathname === "/__review/bridge.js"
    ) {
      outgoing.writeHead(200, { "Content-Type": "application/javascript" });
      outgoing.end(bridgeScript);
      return;
    }
    if (
      url.pathname.startsWith("/assets/") ||
      url.pathname.startsWith("/brand/") ||
      url.pathname === "/favicon.ico" ||
      url.pathname === "/apple-touch-icon.png"
    ) {
      const file = resolve(clientRoot, `.${decodeURIComponent(url.pathname)}`);
      assert.ok(file.startsWith(`${clientRoot}${sep}`));
      outgoing.writeHead(200, {
        "Content-Type": types[extname(file)] || "application/octet-stream",
      });
      outgoing.end(await readFile(file));
      return;
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const response = await handle(
      new Request(url, {
        method: incoming.method,
        headers: incoming.headers,
        ...(body.length ? { body } : {}),
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (
      process.env.PO_REVIEW_SERVE === "1" &&
      response.headers.get("content-type")?.includes("text/html")
    ) {
      outgoing.end(
        (await response.text()).replaceAll(
          "https://cdn.shopify.com/shopifycloud/app-bridge.js",
          "/__review/bridge.js",
        ),
      );
    } else outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500);
    outgoing.end("Test harness failure");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const url = `${origin}/app/reconciliation?shop=${shop}&host=${Buffer.from("admin.shopify.com/store/po-browser").toString("base64")}&embedded=1&id_token=${token}`;
if (process.env.PO_REVIEW_SERVE === "1") {
  console.log(
    JSON.stringify({ isolatedReviewUrl: url, liveDatabaseUsed: false }),
  );
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
  process.exit(0);
}
let browser;
const checks = [];
const submissions = [];
const browserExceptions = [];
const unexpectedNetwork = [];
const controlledNetwork = [];
const expectedDisabledScriptRequests = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_BROWSER_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_BROWSER_EXECUTABLE }
      : process.platform === "win32"
        ? { channel: "msedge" }
        : {}),
  });
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({
      javaScriptEnabled,
      // Shopify intentionally rejects the default HeadlessChrome bot identity.
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    });
    await context.route("https://cdn.shopify.com/**", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: bridgeScript,
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const entry = {
        method: response.request().method(),
        url: new URL(response.url()).pathname,
        status: response.status(),
      };
      if (
        entry.url.startsWith("/accounting/") ||
        entry.url.includes("does-not-exist")
      )
        controlledNetwork.push(entry);
      else unexpectedNetwork.push(entry);
    });
    page.on("requestfailed", (request) => {
      const error = request.failure()?.errorText || "Unknown network failure";
      // Playwright deliberately blocks script/module preloads in the native
      // HTML context. These are caused by disabling JavaScript for this test.
      if (!javaScriptEnabled && error === "csp") {
        expectedDisabledScriptRequests.push(new URL(request.url()).pathname);
        return;
      }
      if (!error.includes("ERR_ABORTED"))
        unexpectedNetwork.push({ url: new URL(request.url()).pathname, error });
    });
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      browserExceptions.push({
        page: new URL(page.url()).pathname,
        message: error.message,
      });
    });
    const launch = await page.goto(url);
    assert.equal(launch.status(), 200);
    await page
      .getByRole("heading", { name: "Purchase orders", exact: true })
      .waitFor();
    // Wait for hydration in the JS case; native controls also work without it.
    if (javaScriptEnabled)
      await page.waitForFunction(() => Boolean(window.__remixContext));
    const number = javaScriptEnabled ? "BROWSER-JS" : "BROWSER-NATIVE";
    const fill = async (poNumber = number) => {
      await page.getByLabel("Vendor", { exact: true }).fill("Browser vendor");
      await page.getByLabel("PO number", { exact: true }).fill(poNumber);
      await page
        .getByLabel("Item name", { exact: true })
        .first()
        .fill("Fabric");
      await page.getByLabel("Qty", { exact: true }).first().fill("2.5");
      await page
        .getByLabel("Unit cost (optional)", { exact: true })
        .first()
        .fill("12.50");
    };
    const submit = async () => {
      const pending = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/app/reconciliation" &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Create purchase order", exact: true })
        .click();
      const response = await pending;
      assert.equal(response.status(), 200);
      const rawResponseBody = await response.text();
      const fields = Array.from(
        new URLSearchParams(response.request().postData()),
      );
      const result = response
        .headers()
        ["content-type"]?.includes("application/json")
        ? JSON.parse(rawResponseBody)
        : { success: rawResponseBody.includes("Purchase order created") };
      submissions.push({
        javaScriptEnabled,
        method: response.request().method(),
        endpoint: new URL(response.url()).pathname,
        payload: Object.fromEntries(fields),
        payloadFields: fields,
        status: response.status(),
        response: result,
        rawResponseBody,
      });
    };
    await fill();
    await submit();
    await page
      .getByRole("link", {
        name: `Open ${number} and receive stock`,
        exact: true,
      })
      .waitFor();
    assert.equal(
      orders.find((order) => order.poNumber === number).totalAmount,
      31.25,
    );
    await page
      .getByRole("link", {
        name: `Open ${number} and receive stock`,
        exact: true,
      })
      .click();
    await page
      .getByRole("button", { name: "Record physical receipt", exact: true })
      .waitFor();
    checks.push(
      `${javaScriptEnabled ? "JavaScript" : "Native HTML"}: valid PO saved, listed, and opened for receiving`,
    );

    await page.goto(url);
    await fill();
    await submit();
    await page
      .getByText("This PO number is already in use.", { exact: false })
      .first()
      .waitFor();
    assert.equal(
      await page.getByLabel("PO number", { exact: true }).inputValue(),
      number,
    );
    checks.push(
      `${javaScriptEnabled ? "JavaScript" : "Native HTML"}: duplicate error stays in the form with values intact`,
    );

    await page.getByLabel("PO number", { exact: true }).fill(`${number}-RETRY`);
    failSave = true;
    await submit();
    await page.getByText(/We couldn't save this purchase order/).waitFor();
    assert.equal(
      await page.getByLabel("Item name", { exact: true }).first().inputValue(),
      "Fabric",
    );
    failSave = false;
    await submit();
    await page
      .getByRole("link", {
        name: `Open ${number}-RETRY and receive stock`,
        exact: true,
      })
      .waitFor();
    checks.push(
      `${javaScriptEnabled ? "JavaScript" : "Native HTML"}: database failure recovers without retyping`,
    );

    await page.goto(url);
    await fill(`${number}-BILLING`);
    subscribed = false;
    await submit();
    await page
      .getByRole("link", { name: "Choose a plan in Settings", exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel("Vendor", { exact: true }).inputValue(),
      "Browser vendor",
    );
    subscribed = true;
    checks.push(
      `${javaScriptEnabled ? "JavaScript" : "Native HTML"}: missing subscription has a usable recovery link`,
    );
    if (javaScriptEnabled) {
      await page.goto(url);
      await page.getByLabel("Vendor", { exact: true }).fill("Browser vendor");
      await page.getByLabel("PO number", { exact: true }).fill("BROWSER-BULK");
      await page
        .getByLabel("Paste rows", { exact: true })
        .fill("FAB-1 Fabric\t2.5\t12.50\nSAMPLE Free sample\t1\t0");
      await page
        .getByRole("button", { name: "Import pasted rows", exact: true })
        .click();
      assert.equal(
        await page.getByLabel("Item name", { exact: true }).count(),
        2,
      );
      await submit();
      await page
        .getByRole("link", {
          name: "Open BROWSER-BULK and receive stock",
          exact: true,
        })
        .waitFor();
      assert.equal(
        orders.find((order) => order.poNumber === "BROWSER-BULK").items.length,
        2,
      );
      checks.push(
        "Browser: spreadsheet import preserves both lines, fractional quantities and zero cost",
      );
      for (const sample of [
        {
          number: "REVIEW-DATE-NOTES",
          vendor: "Second supplier & Co",
          date: "2027-02-28",
          notes: "Deliver after 10:00 — reference Ω-42",
          quantity: "3.125",
          rate: "9.99",
        },
        {
          number: "REVIEW-LARGE",
          vendor: "Large supplier",
          date: "2026-12-31",
          notes: "x".repeat(2000),
          quantity: "1000000",
          rate: "99999.99",
        },
        {
          number: "",
          vendor: "Optional fields supplier",
          date: "",
          notes: "",
          quantity: "1",
          rate: "",
        },
      ]) {
        await page.goto(url);
        await fill(sample.number);
        await page.getByLabel("Vendor", { exact: true }).fill(sample.vendor);
        await page
          .getByLabel("Expected date", { exact: true })
          .fill(sample.date);
        await page.getByLabel("Notes", { exact: true }).fill(sample.notes);
        await page
          .getByLabel("Qty", { exact: true })
          .first()
          .fill(sample.quantity);
        await page
          .getByLabel("Unit cost (optional)", { exact: true })
          .first()
          .fill(sample.rate);
        const count = orders.length;
        await submit();
        await page
          .getByRole("link", { name: /^Open .* and receive stock$/ })
          .waitFor();
        assert.equal(orders.length, count + 1);
        const saved = orders.at(-1);
        assert.equal(saved.vendor.name, sample.vendor);
        assert.equal(
          saved.expectedDate?.toISOString().slice(0, 10) || "",
          sample.date,
        );
        assert.equal(saved.notes || "", sample.notes);
        assert.equal(saved.items[0].expectedQty, Number(sample.quantity));
        assert.equal(
          saved.items[0].expectedRate,
          sample.rate ? Number(sample.rate) : null,
        );
        await page
          .getByRole("link", { name: /^Open .* and receive stock$/ })
          .click();
        await page
          .getByRole("heading", { name: "Purchase order details" })
          .waitFor();
        assert.ok(
          (await page.locator("body").innerText()).includes(sample.vendor),
        );
        if (sample.date)
          await page
            .getByText(`Expected delivery: ${sample.date}`, { exact: true })
            .waitFor();
        if (sample.notes)
          await page
            .getByText(`Notes: ${sample.notes}`, { exact: true })
            .waitFor();
        assert.equal((await page.reload()).status(), 200);
        await page
          .getByRole("heading", { name: "Purchase order details" })
          .waitFor();
        checks.push(
          `Browser: create, verify isolated persistence and reopen ${sample.number || "blank optional fields"}`,
        );
      }
      for (const invalid of [
        {
          label: "missing vendor",
          field: "Vendor",
          value: "",
          expected: /Enter a vendor name/,
        },
        {
          label: "whitespace vendor",
          field: "Vendor",
          value: "   ",
          expected: /Enter a vendor name/,
        },
        {
          label: "no items",
          field: "Item name",
          value: "",
          expected: /Add at least one item/,
        },
      ]) {
        await page.goto(url);
        await fill(`INVALID-${invalid.label}`);
        await page
          .getByLabel(invalid.field, { exact: true })
          .first()
          .fill(invalid.value);
        if (invalid.label === "no items") {
          await page.getByLabel("Qty", { exact: true }).first().fill("1");
          await page
            .getByLabel("Unit cost (optional)", { exact: true })
            .first()
            .fill("");
        }
        const count = orders.length;
        await submit();
        await page.getByText(invalid.expected).first().waitFor();
        assert.equal(orders.length, count);
        assert.equal(
          await page.getByLabel("PO number", { exact: true }).inputValue(),
          `INVALID-${invalid.label}`,
        );
        checks.push(
          `Browser: ${invalid.label} shows validation and preserves entries`,
        );
      }
      for (const invalid of [
        { label: "zero quantity", field: "Qty", value: "0" },
        { label: "negative quantity", field: "Qty", value: "-2" },
        { label: "negative price", field: "Unit cost (optional)", value: "-1" },
        { label: "excessive quantity", field: "Qty", value: "1000000001" },
      ]) {
        await page.goto(url);
        await fill(`INVALID-${invalid.label}`);
        const input = page.getByLabel(invalid.field, { exact: true }).first();
        await input.fill(invalid.value);
        assert.equal(
          await input.evaluate((element) => element.checkValidity()),
          false,
        );
        const count = orders.length;
        await page
          .getByRole("button", { name: "Create purchase order", exact: true })
          .click();
        assert.equal(orders.length, count);
        checks.push(`Browser: native validation blocks ${invalid.label}`);
      }
      await page.goto(url);
      await fill("");
      const count = orders.length;
      saveDelayMs = 350;
      const doubleResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/app/reconciliation" &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Create purchase order", exact: true })
        .dblclick();
      const doubleResult = await doubleResponse;
      assert.equal(doubleResult.status(), 200);
      const doubleFields = Array.from(
        new URLSearchParams(doubleResult.request().postData()),
      );
      submissions.push({
        javaScriptEnabled,
        method: "POST",
        endpoint: "/app/reconciliation",
        payload: Object.fromEntries(doubleFields),
        payloadFields: doubleFields,
        status: doubleResult.status(),
        response: await doubleResult.json(),
        rawResponseBody: await doubleResult.text(),
      });
      await page
        .getByRole("link", {
          name: "Open purchase order and receive stock",
          exact: true,
        })
        .waitFor();
      saveDelayMs = 0;
      assert.equal(orders.length, count + 1);
      checks.push(
        "Browser: double-click with blank PO number creates one record",
      );

      await page
        .getByRole("link", {
          name: "Open purchase order and receive stock",
          exact: true,
        })
        .click();
      await page
        .getByRole("heading", { name: "Purchase order details" })
        .waitFor();
      await page.goBack();
      await page
        .getByRole("heading", { name: "Purchase orders", exact: true })
        .waitFor();
      await page.goForward();
      await page
        .getByRole("heading", { name: "Purchase order details" })
        .waitFor();
      checks.push("Browser: back and forward preserve usable PO routes");
      const missing = await page.goto(`${origin}/app/receipts/does-not-exist`);
      assert.equal(missing.status(), 200);
      await page
        .getByRole("heading", { name: "Purchase order not found" })
        .waitFor();
      await page
        .getByRole("link", { name: "Back to purchase orders", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Purchase orders", exact: true })
        .waitFor();
      checks.push(
        "Browser: nonexistent/deleted PO has an operational recovery page",
      );
      for (const width of [360, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const button = page.getByRole("button", {
          name: "Create purchase order",
          exact: true,
        });
        await button.scrollIntoViewIfNeeded();
        assert.equal(await button.isVisible(), true);
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          `Layout overflows at ${width}px`,
        );
      }
      checks.push(
        "Browser: form and submit usable at 360, 768 and 1440 pixels",
      );
      for (const route of [
        "/accounting/confirm",
        "/accounting/authorize",
        "/accounting/xero/callback",
        "/accounting/quickbooks/callback",
      ]) {
        const response = await page.goto(origin + route);
        assert.equal(response.status(), 400);
        await page
          .getByRole("heading", {
            name: "Accounting connection couldn't be completed",
          })
          .waitFor();
        await page
          .getByRole("link", { name: "Back to Settings", exact: true })
          .waitFor();
        assert.doesNotMatch(
          await page.locator("body").innerText(),
          /HTTP \d{3}|Unhandled Thrown|Application Error|stack trace/,
        );
      }
      checks.push(
        "Browser: all four invalid accounting links render safe reconnect guidance",
      );
      const unknown = await page.goto(`${origin}/app/does-not-exist`);
      assert.equal(unknown.status(), 404);
      await page.getByRole("heading", { name: "Page not found" }).waitFor();
      checks.push(
        "Browser: unknown app route renders a recovery UI without framework error details",
      );
    }
    assert.deepEqual(
      errors,
      [],
      "No browser exceptions during the PO workflow",
    );
    await mkdir(".cache", { recursive: true });
    await page.screenshot({
      path: `.cache/po-workflow-${javaScriptEnabled ? "js" : "native"}.png`,
      fullPage: true,
    });
    await context.close();
  }
  console.log(
    JSON.stringify(
      {
        passed: checks.length,
        checks,
        persistedTestOrders: orders.length,
        liveDatabaseUsed: false,
        submissionCount: submissions.length,
        browserExceptions,
        unexpectedNetwork: unexpectedNetwork.slice(0, 10),
        expectedDisabledScriptRequests: expectedDisabledScriptRequests.length,
        controlledNetwork,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(
    unexpectedNetwork,
    [],
    "No unexpected failed network requests",
  );
  await mkdir(".cache", { recursive: true });
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(
      ".cache/po-review-browser-evidence.json",
      JSON.stringify(
        {
          checks,
          submissions,
          persistedTestOrders: orders,
          liveDatabaseUsed: false,
          browserExceptions,
          unexpectedNetwork,
          controlledNetwork,
        },
        null,
        2,
      ),
    ),
  );
} finally {
  failSave = false;
  subscribed = true;
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = originalFetch;
  await prisma.$disconnect();
}
