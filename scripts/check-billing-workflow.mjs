/* global globalThis */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { PrismaClient } from "@prisma/client";
import { createRequestHandler } from "@remix-run/node";
import { chromium } from "playwright";

// Production UI and Shopify SDK; isolated sessions/database and simulated
// Shopify approval/API responses. This never creates a real Shopify charge.
const key = "00000000000000000000000000000000";
const secret = "isolated-billing-review-secret";
Object.assign(process.env, {
  NODE_ENV: "production",
  DATABASE_URL:
    "postgresql://test:test@127.0.0.1:1/billing_review?connect_timeout=1",
  SHOPIFY_API_KEY: key,
  SHOPIFY_API_SECRET: secret,
  SHOPIFY_APP_URL: "https://app.example",
  SCOPES: "read_products,write_products,write_inventory,read_inventory",
});
const shops = [
  "billing-review-a.myshopify.com",
  "billing-review-b.myshopify.com",
];
const subscriptions = new Map();
const rejectedBillingShops = new Set();
const charges = [];
const returnedUrls = [];
const checks = [];
const exceptions = [];
const controlledNetwork = [];
const unexpectedNetwork = [];
const tokens = new Map(
  shops.map((shop) => {
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
    return [
      shop,
      `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`,
    ];
  }),
);
const prisma = new PrismaClient();
prisma.session.count = async () => 0;
prisma.session.findUnique = async ({ where }) => ({
  id: where.id,
  shop: shops.find((shop) => where.id.includes(shop)) || shops[0],
  state: "",
  isOnline: true,
  scope: process.env.SCOPES,
  expires: new Date(Date.now() + 3600000),
  accessToken: "fake-billing-access-token",
  userId: 123n,
  firstName: "Review",
  lastName: "Owner",
  email: "review@example.com",
  accountOwner: true,
  locale: "en",
  collaborator: false,
  emailVerified: true,
  role: "ADMIN",
});
prisma.session.findMany = async () => [];
prisma.monthlyUsage.findUnique = async () => null;
prisma.shopSettings.upsert = async ({ where }) => ({
  shop: where.shop,
  defaultCurrency: "USD",
  dateOrder: "DMY",
  minutesSavedPerInvoice: 0,
  fxRateRounding: 6,
  fxRateSourcePreference: "MANUAL",
  fxRevaluationFrequency: "MANUAL",
});
for (const model of [
  "accountingConnection",
  "vendor",
  "uoMMapping",
  "notificationPreference",
  "notificationLog",
  "approvalRule",
])
  prisma[model].findMany = async () => [];
prisma.approvalRule.upsert = async ({ create }) => create;
globalThis.prismaGlobal = prisma;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(
    typeof input === "string" ? input : input.url || String(input),
  );
  if (!url.hostname.endsWith(".myshopify.com"))
    return originalFetch(input, options);
  assert.ok(shops.includes(url.hostname), "No API call to a different store");
  const body = JSON.parse(options?.body || "{}");
  let data;
  if (body.query.includes("mutation AppSubscriptionCreate")) {
    if (rejectedBillingShops.has(url.hostname))
      return Response.json({
        data: {
          appSubscriptionCreate: {
            appSubscription: null,
            confirmationUrl: null,
            userErrors: [
              { field: null, message: "Internal provider validation detail" },
            ],
          },
        },
      });
    const index = charges.length;
    charges.push({ shop: url.hostname, ...body.variables });
    data = {
      appSubscriptionCreate: {
        appSubscription: {
          id: `gid://shopify/AppSubscription/${index}`,
          name: body.variables.name,
          status: "PENDING",
        },
        confirmationUrl: `https://admin.shopify.com/store/${url.hostname.replace(".myshopify.com", "")}/charges/review-${index}`,
        userErrors: [],
      },
    };
  } else
    data = {
      shop: { plan: { partnerDevelopment: true } },
      currentAppInstallation: {
        activeSubscriptions: subscriptions.get(url.hostname) || [],
      },
    };
  return Response.json(
    { data },
    { headers: { "X-Shopify-API-Version": "2026-10" } },
  );
};
const build = await import("../build/server/index.js");
const handle = createRequestHandler(build, "production");
const clientRoot = resolve("build/client");
const types = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const bridge = (
  shop,
) => `window.shopify={idToken:async()=>${JSON.stringify(tokens.get(shop))},environment:{embedded:true},config:{apiKey:${JSON.stringify(key)}}};
const originalFetch=window.fetch;window.fetch=async(...args)=>{const response=await originalFetch(...args);const target=response.headers.get('X-Shopify-API-Request-Failure-Reauthorize-Url');if(target){window.location.assign(target);return new Promise(()=>{});}return response;};`;
const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, `http://${incoming.headers.host}`);
    if (url.pathname === "/__review/bridge.js") {
      outgoing.writeHead(200, { "Content-Type": "application/javascript" });
      outgoing.end(bridge(url.searchParams.get("shop")));
      return;
    }
    if (
      url.pathname.startsWith("/assets/") ||
      url.pathname.startsWith("/brand/") ||
      ["/favicon.ico", "/apple-touch-icon.png"].includes(url.pathname)
    ) {
      const path = resolve(clientRoot, `.${decodeURIComponent(url.pathname)}`);
      assert.ok(path.startsWith(`${clientRoot}${sep}`));
      outgoing.writeHead(200, {
        "Content-Type": types[extname(path)] || "application/octet-stream",
      });
      outgoing.end(await readFile(path));
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
    if (response.headers.get("content-type")?.includes("text/html"))
      outgoing.end(
        (await response.text()).replaceAll(
          "https://cdn.shopify.com/shopifycloud/app-bridge.js",
          `/__review/bridge.js?shop=${url.searchParams.get("shop") || shops[0]}`,
        ),
      );
    else outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    outgoing.writeHead(500);
    outgoing.end("Billing test harness failure");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
function appUrl(shop, path = "/app/settings", extra = {}) {
  const query = new URLSearchParams({
    shop,
    host: Buffer.from(
      `admin.shopify.com/store/${shop.replace(".myshopify.com", "")}`,
    ).toString("base64"),
    embedded: "1",
    id_token: tokens.get(shop),
    ...extra,
  });
  return `${origin}${path}?${query}`;
}
if (process.env.BILLING_REVIEW_SERVE === "1") {
  subscriptions.set(shops[0], [
    {
      id: "demo",
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
  ]);
  console.log(
    JSON.stringify({
      isolatedReviewUrl: appUrl(shops[0], "/app/settings", {
        billing: "returned",
      }),
      liveShopifyUsed: false,
    }),
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
try {
  await mkdir(".cache", { recursive: true });
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === "win32" ? { channel: "msedge" } : {}),
  });
  for (const shop of shops) {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      extraHTTPHeaders: { Authorization: `Bearer ${tokens.get(shop)}` },
    });
    await context.route("https://cdn.shopify.com/**", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: bridge(shop),
      }),
    );
    await context.route("https://admin.shopify.com/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/favicon.ico") {
        await route.fulfill({ status: 204, body: "" });
        return;
      }
      assert.ok(
        url.pathname.startsWith(
          `/store/${shop.replace(".myshopify.com", "")}/`,
        ),
        `Return and approval stay in the authenticated store: ${url.pathname}`,
      );
      if (url.pathname.includes("/charges/review-")) {
        const index = Number(url.pathname.match(/\/charges\/review-(\d+)$/)[1]);
        const charge = charges[index];
        const decision = url.searchParams.get("decision");
        if (!decision) {
          await route.fulfill({
            contentType: "text/html",
            body: `<h1>Simulated Shopify approval</h1><p>${shop}: ${charge.name}</p><a href="?decision=approve">Approve</a> <a href="?decision=decline">Decline</a>`,
          });
          return;
        }
        if (decision === "approve")
          subscriptions.set(shop, [
            {
              id: `gid://shopify/AppSubscription/${index}`,
              name: charge.name,
              status: "ACTIVE",
              test: charge.test,
              lineItems: charge.lineItems.map((item) => ({
                plan: { pricingDetails: item.plan.appRecurringPricingDetails },
              })),
            },
          ]);
        await route.fulfill({
          contentType: "text/html",
          body: `<script>location.assign(${JSON.stringify(charge.returnUrl)})</script>`,
        });
        return;
      }
      assert.equal(
        url.pathname,
        `/store/${shop.replace(".myshopify.com", "")}/apps/${key}/app/settings`,
      );
      returnedUrls.push(url.toString());
      await route.fulfill({
        contentType: "text/html",
        body: `<script>location.assign(${JSON.stringify(appUrl(shop, "/app/settings", Object.fromEntries(url.searchParams)))})</script>`,
      });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => exceptions.push(error.message));
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const record = {
        path: new URL(response.url()).pathname,
        status: response.status(),
        method: response.request().method(),
      };
      if (
        (response.status() === 401 &&
          response.headers()[
            "x-shopify-api-request-failure-reauthorize-url"
          ]) ||
        (response.status() === 400 &&
          rejectedBillingShops.has(shop) &&
          record.path === "/app/settings" &&
          record.method === "POST") ||
        (response.status() === 404 &&
          record.path.includes("missing-billing-page"))
      )
        controlledNetwork.push(record);
      else unexpectedNetwork.push(record);
    });
    page.on("requestfailed", (request) => {
      const error = request.failure()?.errorText || "Unknown network failure";
      if (!error.includes("ERR_ABORTED"))
        unexpectedNetwork.push({
          path: new URL(request.url()).pathname,
          error,
        });
    });
    await page.goto(appUrl(shop));
    await page.getByRole("heading", { name: "Settings and plans" }).waitFor();
    await page.waitForFunction(() => window.__remixRouter);
    async function requestPlan(name = "SmartBill Starter") {
      await page
        .locator("form")
        .filter({ has: page.locator(`input[name="plan"][value="${name}"]`) })
        .getByRole("button")
        .click();
      await page
        .getByRole("heading", { name: "Simulated Shopify approval" })
        .waitFor();
      const charge = charges.at(-1);
      assert.equal(charge.shop, shop);
      assert.equal(charge.test, true);
      assert.equal(charge.trialDays, 14);
      assert.equal(charge.replacementBehavior, "APPLY_IMMEDIATELY");
      assert.equal(
        charge.returnUrl,
        `https://admin.shopify.com/store/${shop.replace(".myshopify.com", "")}/apps/${key}/app/settings?billing=returned`,
      );
      assert.equal(
        charge.lineItems[0].plan.appRecurringPricingDetails.price.currencyCode,
        "USD",
      );
    }
    rejectedBillingShops.add(shop);
    await page
      .locator("form")
      .filter({
        has: page.locator('input[name="plan"][value="SmartBill Starter"]'),
      })
      .getByRole("button")
      .click();
    await page
      .getByText(
        "We couldn't open Shopify's subscription approval. Please try again.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page
        .getByText("Internal provider validation detail", { exact: false })
        .count(),
      0,
    );
    rejectedBillingShops.delete(shop);
    checks.push(
      `${shop}: billing API rejection keeps the plan form usable with safe retry guidance`,
    );
    await requestPlan();
    await page.getByRole("link", { name: "Decline", exact: true }).click();
    await page
      .getByText(`No subscription is active for ${shop}.`, { exact: false })
      .waitFor();
    assert.equal(subscriptions.get(shop), undefined);
    checks.push(
      `${shop}: decline returns to the same store with retry and no entitlement`,
    );
    await requestPlan();
    await page.getByRole("link", { name: "Approve", exact: true }).click();
    await page
      .getByText(`Starter is your active plan for ${shop}.`, { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Current plan", exact: true })
        .isDisabled(),
      true,
    );
    checks.push(
      `${shop}: retry, approval, active plan and correct embedded return`,
    );
    await page.reload();
    await page
      .getByText(`Starter is your active plan for ${shop}.`, { exact: true })
      .waitFor();
    checks.push(`${shop}: refresh rechecks Shopify's active subscription`);
    await requestPlan("SmartBill Growth");
    await page.getByRole("link", { name: "Decline", exact: true }).click();
    await page
      .getByText(`Starter is your active plan for ${shop}.`, { exact: true })
      .waitFor();
    checks.push(`${shop}: declining replacement preserves the approved plan`);
    await requestPlan("SmartBill Growth");
    await page.getByRole("link", { name: "Approve", exact: true }).click();
    await page
      .getByText(`Growth is your active plan for ${shop}.`, { exact: true })
      .waitFor();
    checks.push(`${shop}: approved upgrade uses correct store and plan`);
    await requestPlan();
    await page.getByRole("link", { name: "Approve", exact: true }).click();
    await page
      .getByText(`Starter is your active plan for ${shop}.`, { exact: true })
      .waitFor();
    checks.push(`${shop}: approved downgrade uses correct store and plan`);
    subscriptions.delete(shop); // Simulate Shopify cancelling the subscription on uninstall.
    await page.goto(
      appUrl(shop, "/app/settings", {
        billing: "returned",
        charge_id: "forged",
        status: "ACTIVE",
      }),
    );
    await page
      .getByText(`No subscription is active for ${shop}.`, { exact: false })
      .waitFor();
    checks.push(
      `${shop}: callback flags and charge IDs cannot grant subscription access`,
    );
    await requestPlan();
    await page.getByRole("link", { name: "Approve", exact: true }).click();
    await page
      .getByText(`Starter is your active plan for ${shop}.`, { exact: true })
      .waitFor();
    checks.push(
      `${shop}: reinstall with no active subscription requests approval again`,
    );
    await page.goto(appUrl(shop, "/app/missing-billing-page"));
    const recovery = page.getByRole("link", {
      name: `Open Shopify admin for ${shop}`,
      exact: true,
    });
    assert.equal(
      await recovery.getAttribute("href"),
      `https://admin.shopify.com/store/${shop.replace(".myshopify.com", "")}/apps`,
    );
    checks.push(`${shop}: recovery navigation is store-specific`);
    await page.screenshot({
      path: `.cache/billing-recovery-${shops.indexOf(shop)}.png`,
      fullPage: true,
    });
    await context.close();
  }
  const publicContext = await browser.newContext();
  const publicPage = await publicContext.newPage();
  await publicPage.goto(origin);
  assert.equal(
    await publicPage
      .getByRole("link", { name: "Open Shopify admin", exact: true })
      .count(),
    0,
  );
  await publicPage
    .getByRole("link", { name: "Choose your store in Shopify", exact: true })
    .waitFor();
  checks.push(
    "Public landing page explicitly asks merchants to choose their store",
  );
  await publicContext.close();
  assert.deepEqual(exceptions, [], "No uncaught browser exceptions");
  assert.deepEqual(unexpectedNetwork, [], "No unexpected error responses");
  const evidence = {
    passed: checks.length,
    checks,
    charges,
    returnedUrls,
    exceptions,
    controlledNetwork,
    unexpectedNetwork,
    liveShopifyUsed: false,
    liveDatabaseUsed: false,
  };
  await mkdir(".cache", { recursive: true });
  await writeFile(
    ".cache/billing-review-browser-evidence.json",
    JSON.stringify(evidence, null, 2),
  );
  console.log(
    JSON.stringify({ ...evidence, charges: charges.length }, null, 2),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  globalThis.fetch = originalFetch;
  await prisma.$disconnect();
}
