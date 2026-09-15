import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import prisma from "../db.server";
import { queuedInvoiceJobWhere } from "../utils/invoiceJobs";

// Shopify probes the session table on initialization; keep even that probe local.
const originalCount = prisma.session.count;
(prisma.session as any).count = async () => 0;
const { completeBrowserInvoiceJob } = await import(
  "../services/invoiceJobs.server"
);
const { authenticate } = await import("../shopify.server");
const { action: jobsAction } = await import("../routes/api.jobs");
const { loader: documentLoader } = await import("../routes/api.jobs.document");
const { action: uploadAction } = await import("../routes/api.upload-invoice");
prisma.session.count = originalCount;

function replaceMethod(
  t: TestContext,
  object: any,
  name: string,
  implementation: (...args: any[]) => any,
) {
  const original = object[name];
  object[name] = implementation;
  t.after(() => {
    object[name] = original;
  });
}

const shop = "browser-test.myshopify.com";
const input = {
  shop,
  jobId: "job-1",
  actor: "owner",
  pageCount: 1,
  rawText:
    "Supplier: Test Supplier\nInvoice No: BROWSER-100\nInvoice Date: 2026-09-14\nDescription Qty Rate Amount\nPaper 2 25.00 50.00\nSubtotal 50.00\nTax 8.00\nTotal USD 58.00",
};
function mockJob(t: TestContext, status = "AWAITING_OCR") {
  const job: any = {
    id: "job-1",
    shop,
    status,
    invoiceId: null,
    storageKey:
      "supabase://private/invoices/browser-test.myshopify.com/invoice.png",
    documentHash: "original-file-hash",
    filename: "invoice.png",
    contentType: "image/png",
    vendorName: "Test Supplier",
    purchaseOrderId: null,
    lockedAt: new Date(),
    leaseToken: null,
  };
  const invoices: any[] = [];
  replaceMethod(t, prisma.invoiceJob, "findFirst", async ({ where }: any) =>
    where.id === job.id && where.shop === shop ? structuredClone(job) : null,
  );
  replaceMethod(
    t,
    prisma.invoiceJob,
    "updateMany",
    async ({ where, data }: any) => {
      assert.equal(where.shop, shop);
      if (where.leaseToken && where.leaseToken !== job.leaseToken)
        return { count: 0 };
      if (
        where.OR &&
        !where.OR.some((condition: any) =>
          typeof condition.status === "string"
            ? condition.status === job.status &&
              job.lockedAt < condition.lockedAt.lt
            : condition.status.in.includes(job.status),
        )
      )
        return { count: 0 };
      Object.assign(job, data);
      return { count: 1 };
    },
  );
  replaceMethod(
    t,
    prisma.invoice,
    "findFirst",
    async () => invoices[0] || null,
  );
  replaceMethod(t, prisma.shopSettings, "findUnique", async () => null);
  replaceMethod(t, prisma.supplierMapping, "findMany", async () => []);
  replaceMethod(t, prisma, "$transaction", async (callback: any) =>
    callback(prisma),
  );
  replaceMethod(t, prisma, "$queryRaw", async () =>
    job.leaseToken ? [{ id: job.id }] : [],
  );
  replaceMethod(t, prisma.vendor, "upsert", async () => ({ id: "vendor-1" }));
  replaceMethod(t, prisma.invoice, "create", async ({ data }: any) => {
    const invoice = { ...data, id: "invoice-" + (invoices.length + 1) };
    invoices.push(invoice);
    return invoice;
  });
  replaceMethod(t, prisma.auditEvent, "create", async () => ({}));
  replaceMethod(t, prisma.monthlyUsage, "upsert", async () => {
    throw new Error("Completion must not charge usage again");
  });
  return { job, invoices };
}

test("browser completion saves the original, parsed fields and review state once", async (t) => {
  const { job, invoices } = mockJob(t);
  const id = await completeBrowserInvoiceJob(input);
  assert.equal(await completeBrowserInvoiceJob(input), id);
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].total, 58);
  assert.equal(invoices[0].invoiceNumber, "BROWSER-100");
  assert.equal(invoices[0].storageKey, job.storageKey);
  assert.equal(invoices[0].documentHash, job.documentHash);
  assert.equal(invoices[0].rawText, input.rawText);
  assert.notEqual(invoices[0].reviewStatus, "APPROVED");
  assert.equal(job.status, "COMPLETED");
  assert.equal(job.pageCount, 1);
  assert.equal(job.leaseToken, null);
  assert.equal(queuedInvoiceJobWhere(shop, new Date()).status, "QUEUED");
});

test("browser completion persists line items from non-basic invoice tables", async (t) => {
  const { invoices } = mockJob(t);
  await completeBrowserInvoiceJob({
    ...input,
    rawText: `Supplier: Test Supplier
Invoice No: BROWSER-ITEMS-200
Invoice Date: 2026-09-15
Item Description | Qty | Unit Price | VAT | Amount
WGT-3000 Widget 3000 | 2 | EA | $27.945 | 16% | $55.89
Subtotal $55.89
Tax $0.00
Total USD $55.89`,
  });
  assert.deepEqual(invoices[0].items.create, [
    {
      sku: "WGT-3000",
      name: "Widget 3000",
      price: 27.945,
      quantity: 2,
      amount: 55.89,
      shopifyVariantId: undefined,
      matchedProductTitle: undefined,
      matchConfirmed: false,
    },
  ]);
});

test("browser OCR retries failed jobs and reconciles interrupted saves without duplicates", async (t) => {
  const { job, invoices } = mockJob(t, "FAILED");
  await completeBrowserInvoiceJob(input);
  job.status = "FAILED";
  job.invoiceId = null;
  assert.equal(await completeBrowserInvoiceJob(input), invoices[0].id);
  assert.equal(invoices.length, 1);
});

test("browser completion cannot cross shops, steal an active lease or race a second save", async (t) => {
  const { job, invoices } = mockJob(t);
  await assert.rejects(
    completeBrowserInvoiceJob({ ...input, shop: "another-shop" }),
    /not found/,
  );
  job.status = "PROCESSING";
  await assert.rejects(completeBrowserInvoiceJob(input), /already being saved/);
  job.status = "AWAITING_OCR";
  const results = await Promise.allSettled([
    completeBrowserInvoiceJob(input),
    completeBrowserInvoiceJob(input),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(invoices.length, 1);
});

test("browser save failures remain retryable and do not leave processing leases", async (t) => {
  const { job } = mockJob(t);
  replaceMethod(t, prisma.invoice, "create", async () => {
    throw new Error("Database unavailable");
  });
  await assert.rejects(
    completeBrowserInvoiceJob(input),
    /Database unavailable/,
  );
  assert.equal(job.status, "FAILED");
  assert.equal(job.leaseToken, null);
  assert.equal(job.error, "Database unavailable");
});

test("browser completion route enforces subscription and job document lookup is shop-scoped", async (t) => {
  const { job } = mockJob(t);
  let active = false;
  t.mock.method(authenticate, "admin", async () => ({
    session: { shop, id: "session-1" },
    admin: {
      graphql: async () =>
        new Response(
          JSON.stringify({
            data: {
              currentAppInstallation: {
                activeSubscriptions: active
                  ? [
                      {
                        id: "sub-1",
                        name: "SmartBill Starter",
                        status: "ACTIVE",
                        test: false,
                        lineItems: [
                          {
                            plan: {
                              pricingDetails: {
                                price: { amount: "19", currencyCode: "USD" },
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
          }),
        ),
    },
  }));
  const form = new FormData();
  form.set("intent", "complete-browser-ocr");
  form.set("jobId", job.id);
  form.set("rawText", input.rawText);
  form.set("pageCount", "1");
  const request = () =>
    new Request("https://app.example/api/jobs", { method: "POST", body: form });
  assert.equal((await jobsAction({ request: request() } as any)).status, 400);
  active = true;
  const response = await jobsAction({ request: request() } as any);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok("invoiceId" in data);
  assert.equal(data.invoiceId, "invoice-1");
  await assert.rejects(
    documentLoader({
      request: new Request(
        "https://app.example/api/jobs/document?jobId=another-shop-job",
      ),
    } as any),
    (error: any) => error instanceof Response && error.status === 404,
  );
});

test("browser upload stores one private original and reserves usage once without queuing server OCR", async (t) => {
  const originalEnvironment = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
    SHOPIFY_BILLING_TEST: process.env.SHOPIFY_BILLING_TEST,
  };
  Object.assign(process.env, {
    SUPABASE_URL: "https://ocr-test.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_fake-ocr-test",
    SUPABASE_STORAGE_BUCKET: "ocr-test",
    SHOPIFY_BILLING_TEST: "true",
  });
  t.after(() => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(authenticate, "admin", async () => ({ session: { shop, id: "owner" }, admin: {} }));
  let stored = 0;
  t.mock.method(globalThis, "fetch", async (url: any) => {
    const path = new URL(String(url)).pathname;
    assert.equal(new URL(String(url)).host, "ocr-test.supabase.co");
    if (path === "/storage/v1/bucket/ocr-test") return Response.json({
      id: "ocr-test", name: "ocr-test", public: false, file_size_limit: 10 * 1024 * 1024,
      allowed_mime_types: ["application/pdf", "image/jpeg", "image/png", "image/gif", "image/bmp", "image/webp"],
    });
    assert.ok(path.startsWith("/storage/v1/object/ocr-test/invoices/" + shop + "/"));
    stored++;
    return Response.json({ Key: "stored", Id: "object-1" });
  });
  let job: any = null;
  let reserved = 0;
  replaceMethod(t, prisma.invoiceJob, "findUnique", async () => job);
  replaceMethod(t, prisma.invoiceJob, "create", async ({ data }: any) => (job = { ...data, id: "browser-job", invoiceId: null }));
  replaceMethod(t, prisma.monthlyUsage, "upsert", async () => ({}));
  replaceMethod(t, prisma.monthlyUsage, "updateMany", async () => { reserved++; return { count: 1 }; });
  const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], "invoice.png", { type: "image/png" });
  const form = new FormData();
  form.set("file", file);
  form.set("processor", "browser");
  const request = () => new Request("https://app.example/api/upload-invoice", { method: "POST", body: form });
  assert.equal((await uploadAction({ request: request() } as any)).status, 202);
  assert.equal((await uploadAction({ request: request() } as any)).status, 202);
  assert.equal(job.status, "AWAITING_OCR");
  assert.equal(job.shop, shop);
  assert.ok(job.storageKey.startsWith("supabase://ocr-test/invoices/" + shop + "/"));
  assert.equal(stored, 1);
  assert.equal(reserved, 1);
});
