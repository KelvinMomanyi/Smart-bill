import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountingRequest,
  AccountingApiError,
} from "../utils/accountingHttp.server";
import {
  sealAccountingSecret,
  openAccountingSecret,
} from "../utils/accountingTokens.server";
import {
  createAccountingState,
  readAccountingState,
} from "../utils/accountingOAuth.server";
import { cookieMatches } from "../services/accountingAuthorization.server";
import { createHash } from "node:crypto";
import {
  getQuickBooksAuthUrl,
  getQuickBooksToken,
  refreshQuickBooksToken,
  revokeQuickBooksToken,
  quickBooksUrl,
  createQuickBooksBill,
  getOrCreateQuickBooksVendorRef,
  listQuickBooksEntity,
} from "../utils/quickbook";
import {
  getXeroAuthUrl,
  createXeroBill,
  getXeroToken,
  getXeroConnections,
  disconnectXero,
  getOrCreateXeroContact,
} from "../utils/xero";
import { formatForPlatform } from "../utils/accountingFormat";
import {
  validateBillMapping,
  purchaseTaxComponents,
  type AccountingCatalog,
  type BillMapping,
} from "../utils/accountingValidation";
import {
  assertExportCompany,
  exportDisposition,
  billMatchesInvoice,
} from "../utils/accountingExportPolicy";
import { fetchAccountingCatalog } from "../services/accountingCatalog.server";

const invoice = {
  id: "invoice-test",
  invoiceNumber: "INV-105",
  vendor: { name: "Example Supplier" },
  date: new Date("2026-09-10T00:00:00Z"),
  dueDate: new Date("2026-10-10T00:00:00Z"),
  currency: "GBP",
  subtotal: 150,
  tax: 20,
  total: 170,
  items: [
    {
      id: "line-1",
      name: "Taxable purchase",
      quantity: 2,
      price: 50,
      amount: 100,
    },
    {
      id: "line-2",
      name: "Exempt purchase",
      quantity: 1,
      price: 50,
      amount: 50,
    },
  ],
};
const catalog: AccountingCatalog = {
  platform: "QUICKBOOKS",
  companyKey: "QUICKBOOKS:sandbox:123",
  companyName: "Test Company",
  country: "GB",
  homeCurrency: "GBP",
  currencies: [],
  multiCurrency: false,
  accounts: [{ id: "10", name: "Purchases", type: "EXPENSE", currency: null }],
  taxes: [
    {
      id: "20",
      name: "VAT on purchases 20%",
      rate: 20,
      expense: true,
      asset: false,
      supported: true,
      components: [
        { id: "7", rate: 20, kind: "TaxOnAmount", order: 0, taxOnOrder: 0 },
      ],
    },
    {
      id: "0",
      name: "Zero",
      rate: 0,
      expense: true,
      asset: true,
      supported: true,
      components: [],
    },
  ],
};
const mapping: BillMapping = {
  companyKey: catalog.companyKey,
  lines: [
    { itemId: "line-1", accountId: "10", taxCodeId: "20" },
    { itemId: "line-2", accountId: "10", taxCodeId: "0" },
  ],
};
const settings = { quickBooksAccountId: "10", quickBooksTaxCodeId: "20" };
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), { status });
}
function fakeFetch(
  t: any,
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
) {
  return t.mock.method(
    globalThis,
    "fetch",
    async (url: any, init: RequestInit = {}) =>
      handler(new URL(String(url)), init),
  );
}
test("mixed-rate QuickBooks bills include purchase tax rate references and exact totals", () => {
  const validated = validateBillMapping(invoice, settings, catalog, mapping);
  const payload = formatForPlatform(invoice, "QUICKBOOKS", {
    validated,
    quickBooksVendorRef: { value: "4" },
    quickBooksMultiCurrency: false,
  });
  assert.equal(payload.GlobalTaxCalculation, "TaxExcluded");
  assert.deepEqual(payload.TxnTaxDetail?.TaxLine, [
    {
      Amount: 20,
      DetailType: "TaxLineDetail",
      TaxLineDetail: {
        TaxRateRef: { value: "7" },
        PercentBased: true,
        TaxPercent: 20,
        NetAmountTaxable: 100,
      },
    },
  ]);
  assert.equal(payload.TxnTaxDetail?.TotalTax, 20);
  assert.equal(
    payload.Line[1].AccountBasedExpenseLineDetail.TaxCodeRef.value,
    "0",
  );
  assert.equal("CurrencyRef" in payload, false);
});
test("mixed Xero taxes use provider tax types and draft bills", () => {
  const xero = {
    ...catalog,
    platform: "XERO" as const,
    companyKey: "XERO:production:abc",
    currencies: ["GBP"],
  };
  const validated = validateBillMapping(invoice, {}, xero, {
    ...mapping,
    companyKey: xero.companyKey,
  });
  const payload = formatForPlatform(invoice, "XERO", {
    validated,
    xeroContactRef: { ContactID: "contact", Name: "Example Supplier" },
  });
  assert.equal(payload.Status, "DRAFT");
  assert.deepEqual(
    payload.LineItems.map((l: any) => l.TaxAmount),
    [20, 0],
  );
  assert.equal(payload.LineItems[1].TaxType, "0");
  assert.equal(payload.Date, "2026-09-10");
  assert.equal(payload.LineItems[0].LineAmount, 100);
});
test("US purchase sales tax requires an explicit expense account and is included in the bill total", () => {
  const us = { ...catalog, country: "US", homeCurrency: "USD", taxes: [] };
  const bill = { ...invoice, currency: "USD" };
  assert.throws(
    () => validateBillMapping(bill, settings, us, mapping),
    /expense account/,
  );
  const validated = validateBillMapping(
    bill,
    { ...settings, quickBooksTaxAccountId: "10" },
    us,
    mapping,
  );
  const payload = formatForPlatform(bill, "QUICKBOOKS", { validated });
  assert.equal(payload.TxnTaxDetail, undefined);
  assert.equal(payload.Line.length, 3);
  assert.equal(
    payload.Line.reduce((sum: number, line: any) => sum + line.Amount, 0),
    170,
  );
  assert.equal(
    payload.Line[2].AccountBasedExpenseLineDetail.AccountRef.value,
    "10",
  );
});
test("untaxed international bills still send an explicit zero tax code", () => {
  const bill = { ...invoice, tax: 0, total: 150 };
  const choices = {
    ...mapping,
    lines: mapping.lines.map((l) => ({ ...l, taxCodeId: "0" })),
  };
  const validated = validateBillMapping(bill, settings, catalog, choices);
  const payload = formatForPlatform(bill, "QUICKBOOKS", { validated });
  assert.equal(payload.TxnTaxDetail?.TotalTax, 0);
  assert.deepEqual(
    payload.Line.map((l) => l.AccountBasedExpenseLineDetail.TaxCodeRef.value),
    ["0", "0"],
  );
});
test("invalid tax totals, sales-only tax and stale line/account mappings fail before export", () => {
  assert.throws(
    () => validateBillMapping(invoice, settings, catalog),
    /Selected purchase taxes total 30/,
  );
  assert.throws(
    () =>
      validateBillMapping(invoice, settings, catalog, {
        ...mapping,
        companyKey: "other",
      }),
    /different company/,
  );
  assert.throws(
    () =>
      validateBillMapping(invoice, settings, catalog, {
        ...mapping,
        lines: [mapping.lines[0]],
      }),
    /Invoice lines changed/,
  );
  assert.throws(
    () =>
      validateBillMapping(
        invoice,
        settings,
        { ...catalog, accounts: [] },
        mapping,
      ),
    /active purchase account/,
  );
  assert.throws(
    () =>
      validateBillMapping(
        invoice,
        settings,
        { ...catalog, taxes: [] },
        mapping,
      ),
    /valid purchase tax code/,
  );
  const salesOnly = {
    ...catalog,
    taxes: catalog.taxes.map((t) => ({ ...t, expense: false })),
  };
  assert.throws(
    () => validateBillMapping(invoice, settings, salesOnly, mapping),
    /cannot be used/,
  );
});
test("compound purchase taxes use the declared calculation order", () => {
  const components = purchaseTaxComponents(100, [
    { id: "a", rate: 5, kind: "TaxOnAmount", order: 1, taxOnOrder: 0 },
    { id: "b", rate: 10, kind: "TaxOnAmountPlusTax", order: 2, taxOnOrder: 1 },
  ]);
  assert.deepEqual(
    components.map((c) => [c.taxable, c.amount]),
    [
      [100, 5],
      [105, 10.5],
    ],
  );
  assert.throws(
    () =>
      purchaseTaxComponents(100, [
        { id: "a", rate: 5, kind: "TaxOnTax", order: 1, taxOnOrder: 0 },
      ]),
    /calculation order/,
  );
});
test("foreign-currency export requires reviewed rate and enabled currency support", () => {
  const foreign = { ...invoice, currency: "EUR" };
  assert.throws(
    () => validateBillMapping(foreign, settings, catalog, mapping),
    /Enable multicurrency/,
  );
  assert.throws(
    () =>
      validateBillMapping(
        foreign,
        settings,
        { ...catalog, multiCurrency: true },
        mapping,
      ),
    /reviewed exchange rate/,
  );
  const validated = validateBillMapping(
    foreign,
    settings,
    { ...catalog, multiCurrency: true },
    { ...mapping, exchangeRate: 0.85 },
  );
  assert.equal(
    formatForPlatform(foreign, "QUICKBOOKS", { validated }).ExchangeRate,
    0.85,
  );
  const xero = {
    ...catalog,
    platform: "XERO" as const,
    companyKey: "XERO:production:abc",
    multiCurrency: true,
    currencies: ["EUR"],
  };
  const xr = validateBillMapping(foreign, {}, xero, {
    ...mapping,
    companyKey: xero.companyKey,
    exchangeRate: 0.85,
  });
  assert.equal(
    formatForPlatform(foreign, "XERO", { validated: xr }).CurrencyRate,
    1.176471,
  );
});
test("ledger permits retry only after a confirmed rejection", () => {
  assert.equal(exportDisposition(null), "CREATE");
  assert.equal(
    exportDisposition({ status: "REJECTED", remoteId: null }),
    "RETRY",
  );
  assert.equal(
    exportDisposition({ status: "EXPORTED", remoteId: "1" }),
    "DONE",
  );
  for (const status of ["SENDING", "VERIFY", "PENDING", "EXPORTED"])
    assert.throws(
      () => exportDisposition({ status, remoteId: null }),
      /already running/,
    );
  assert.throws(
    () => exportDisposition({ status: "REJECTED", remoteId: "1" }),
    /already running/,
  );
  assert.throws(
    () =>
      assertExportCompany(
        "QUICKBOOKS:sandbox:123",
        "QUICKBOOKS:production:123",
      ),
    /original accounting company/,
  );
});
test("bill verification rejects mismatched currency, tax, date, supplier, and voided bills", () => {
  const expected = {
    VendorRef: { value: "4" },
    TxnTaxDetail: { TotalTax: 20 },
  };
  const bill = {
    Id: "b",
    DocNumber: invoice.invoiceNumber,
    VendorRef: { value: "4" },
    TotalAmt: 170,
    TxnTaxDetail: { TotalTax: 20 },
    TxnDate: "2026-09-10",
    DueDate: "2026-10-10",
  };
  assert.equal(
    billMatchesInvoice("QUICKBOOKS", bill, invoice, expected, "GBP"),
    true,
  );
  for (const change of [
    { CurrencyRef: { value: "USD" } },
    { TotalAmt: 169 },
    { TxnTaxDetail: { TotalTax: 0 } },
    { TxnDate: "2026-09-09" },
    { VendorRef: { value: "9" } },
  ])
    assert.equal(
      billMatchesInvoice(
        "QUICKBOOKS",
        { ...bill, ...change },
        invoice,
        expected,
        "GBP",
      ),
      false,
    );
  const xb = {
    Type: "ACCPAY",
    InvoiceNumber: invoice.invoiceNumber,
    Contact: { ContactID: "c" },
    CurrencyCode: "GBP",
    Total: 170,
    SubTotal: 150,
    TotalTax: 20,
    Date: "/Date(1788998400000+0000)/",
    DueDateString: "2026-10-10",
    Status: "DRAFT",
  };
  assert.equal(
    billMatchesInvoice(
      "XERO",
      xb,
      invoice,
      { Contact: { ContactID: "c" } },
      "GBP",
    ),
    true,
  );
  assert.equal(
    billMatchesInvoice(
      "XERO",
      { ...xb, Status: "VOIDED" },
      invoice,
      { Contact: { ContactID: "c" } },
      "GBP",
    ),
    false,
  );
});
test("verification checks posted accounts and exchange rates even when the bill total matches", () => {
  const validated = validateBillMapping(invoice, settings, catalog, mapping);
  const expected = formatForPlatform(invoice, "QUICKBOOKS", {
    validated,
    quickBooksVendorRef: { value: "4" },
    quickBooksMultiCurrency: false,
  });
  const remote = { ...structuredClone(expected), Id: "remote", TotalAmt: 170 };
  assert.equal(
    billMatchesInvoice("QUICKBOOKS", remote, invoice, expected, "GBP"),
    true,
  );
  remote.Line[0].AccountBasedExpenseLineDetail.AccountRef.value =
    "wrong-account";
  assert.equal(
    billMatchesInvoice("QUICKBOOKS", remote, invoice, expected, "GBP"),
    false,
  );
  assert.equal(
    billMatchesInvoice(
      "QUICKBOOKS",
      { ...expected, TotalAmt: 170, ExchangeRate: 1.1 },
      invoice,
      { ...expected, ExchangeRate: 1.2 },
      "GBP",
    ),
    false,
  );
});
test("OAuth state is unique, signed, platform-bound, and expires", (t) => {
  const first = createAccountingState("test-shop.myshopify.com", "XERO");
  const second = createAccountingState("test-shop.myshopify.com", "XERO");
  assert.notEqual(first, second);
  assert.equal(readAccountingState(first).platform, "XERO");
  const parsed = JSON.parse(Buffer.from(first, "base64url").toString());
  parsed.payload.shop = "other-shop.myshopify.com";
  assert.throws(
    () =>
      readAccountingState(
        Buffer.from(JSON.stringify(parsed)).toString("base64url"),
      ),
    /signature/,
  );
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 31 * 60000);
  assert.throws(() => readAccountingState(first), /Expired/);
});
test("OAuth browser binding rejects missing and incorrect browser cookies", () => {
  const expected = createHash("sha256").update("browser-secret").digest("hex");
  assert.equal(cookieMatches("browser-secret", expected), true);
  assert.equal(cookieMatches("different-browser", expected), false);
  assert.equal(cookieMatches(null, expected), false);
});
test("stored accounting secrets are authenticated ciphertext with legacy read compatibility", () => {
  const sealed = sealAccountingSecret("test-refresh-token");
  assert.equal(sealed.includes("test-refresh-token"), false);
  assert.equal(openAccountingSecret(sealed), "test-refresh-token");
  assert.notEqual(sealed, sealAccountingSecret("test-refresh-token"));
  const parts = sealed.split(":");
  parts[3] = Buffer.alloc(16).toString("base64url");
  assert.throws(() => openAccountingSecret(parts.join(":")));
  assert.equal(openAccountingSecret("legacy-test-token"), "legacy-test-token");
});
test("QuickBooks sandbox and production requests cannot be mixed", () => {
  assert.equal(
    quickBooksUrl(
      { accessToken: "t", realmId: "123", environment: "sandbox" },
      "/bill",
    ).hostname,
    "sandbox-quickbooks.api.intuit.com",
  );
  assert.equal(
    quickBooksUrl(
      { accessToken: "t", realmId: "123", environment: "production" },
      "/bill",
    ).hostname,
    "quickbooks.api.intuit.com",
  );
  assert.throws(
    () => quickBooksUrl({ accessToken: "t", realmId: "../other" }, "/bill"),
    /company ID/,
  );
});
test("authorization URLs use current scopes and preserve the registered callback", async () => {
  const xero = new URL(
    await getXeroAuthUrl(
      "https://app.example/accounting/xero/callback",
      "state",
    ),
  );
  assert.ok(xero.searchParams.get("scope")?.includes("accounting.invoices"));
  assert.ok(
    xero.searchParams.get("scope")?.includes("accounting.settings.read"),
  );
  assert.ok(xero.searchParams.get("scope")?.includes("offline_access"));
  assert.ok(
    !xero.searchParams.get("scope")?.includes("accounting.transactions"),
  );
  const qb = new URL(
    await getQuickBooksAuthUrl(
      "https://app.example/accounting/quickbooks/callback",
      "state",
      "production",
    ),
  );
  assert.equal(
    qb.searchParams.get("redirect_uri"),
    "https://app.example/accounting/quickbooks/callback",
  );
  assert.equal(
    qb.searchParams.get("scope"),
    "com.intuit.quickbooks.accounting",
  );
});
test("provider token exchange, refresh, connection listing and revocation use the documented endpoints", async (t) => {
  const requests: { url: URL; init: RequestInit }[] = [];
  fakeFetch(t, (url, init) => {
    requests.push({ url, init });
    return json(
      url.pathname === "/connections"
        ? [{ id: "connection", tenantId: "tenant" }]
        : {
            access_token: "test-access",
            refresh_token: "test-refresh",
            expires_in: 1800,
          },
    );
  });
  await getQuickBooksToken(
    "code",
    "https://app.example/accounting/quickbooks/callback",
    "production",
  );
  await refreshQuickBooksToken("refresh", "production");
  await revokeQuickBooksToken("refresh", "production");
  await getXeroToken("code", "https://app.example/accounting/xero/callback");
  assert.equal((await getXeroConnections("access")).length, 1);
  await disconnectXero("access", "connection");
  assert.equal(
    new URLSearchParams(String(requests[0].init.body)).get("grant_type"),
    "authorization_code",
  );
  assert.equal(
    new URLSearchParams(String(requests[1].init.body)).get("grant_type"),
    "refresh_token",
  );
  assert.equal(requests[2].url.pathname, "/v2/oauth2/tokens/revoke");
  assert.deepEqual(JSON.parse(String(requests[2].init.body)), {
    token: "refresh",
  });
  assert.equal(requests[5].init.method, "DELETE");
  assert.equal(requests[5].url.pathname, "/connections/connection");
});
test("actual provider adapters serialize one bill and a stable idempotency key", async (t) => {
  const requests: { url: URL; init: RequestInit }[] = [];
  fakeFetch(t, (url, init) => {
    requests.push({ url, init });
    return json({ Bill: { Id: "bill" }, Invoices: [{ InvoiceID: "invoice" }] });
  });
  const payload = { DocNumber: "INV-1", Line: [] };
  await createQuickBooksBill(
    { accessToken: "test-token", realmId: "123", environment: "sandbox" },
    payload,
    "stable-key",
  );
  await createXeroBill(
    { accessToken: "test-token", tenantId: "tenant" },
    { Type: "ACCPAY" },
    "stable-key",
  );
  assert.equal(requests[0].url.searchParams.get("requestid"), "stable-key");
  assert.deepEqual(JSON.parse(String(requests[0].init.body)), payload);
  assert.equal(
    new Headers(requests[1].init.headers).get("Idempotency-Key"),
    "stable-key",
  );
  assert.equal(
    new Headers(requests[1].init.headers).get("xero-tenant-id"),
    "tenant",
  );
  assert.equal(JSON.parse(String(requests[1].init.body)).Invoices.length, 1);
});
test("HTTP errors distinguish provider rejection from unknown outcomes", async (t) => {
  let status = 400;
  fakeFetch(t, () =>
    json(
      { Fault: { Error: [{ Detail: "Invalid purchase account" }] } },
      status,
    ),
  );
  await assert.rejects(
    accountingRequest("QuickBooks", "https://example.invalid"),
    (e: any) => e instanceof AccountingApiError && e.rejected,
  );
  status = 500;
  await assert.rejects(
    accountingRequest("QuickBooks", "https://example.invalid"),
    (e: any) => !e.rejected,
  );
});
test("network timeouts and malformed success responses never permit blind bill retry", async (t) => {
  let timeout = true;
  fakeFetch(t, () => {
    if (timeout) throw new Error("timeout");
    return new Response("not json", { status: 200 });
  });
  await assert.rejects(
    accountingRequest("Xero", "https://example.invalid"),
    (e: any) => !e.rejected,
  );
  timeout = false;
  await assert.rejects(
    accountingRequest("Xero", "https://example.invalid"),
    (e: any) => !e.rejected,
  );
});
test("supplier resolution reuses existing contacts and checks QuickBooks vendor currency", async (t) => {
  let posts = 0;
  fakeFetch(t, (url, init) => {
    if (init.method === "POST") posts++;
    return json(
      url.pathname.endsWith("/Contacts")
        ? { Contacts: [{ ContactID: "c", Name: "Example Supplier" }] }
        : {
            QueryResponse: {
              Vendor: [
                {
                  Id: "v",
                  DisplayName: "Example Supplier",
                  CurrencyRef: { value: "GBP" },
                },
              ],
            },
          },
    );
  });
  assert.equal(
    (
      await getOrCreateXeroContact(
        { accessToken: "t", tenantId: "tenant" },
        "Example Supplier",
      )
    ).ContactID,
    "c",
  );
  assert.equal(
    (
      await getOrCreateQuickBooksVendorRef(
        { accessToken: "t", realmId: "123" },
        "Example Supplier",
        "GBP",
        true,
      )
    ).value,
    "v",
  );
  await assert.rejects(
    getOrCreateQuickBooksVendorRef(
      { accessToken: "t", realmId: "123" },
      "Example Supplier",
      "USD",
      true,
    ),
    /invoice currency/,
  );
  assert.equal(posts, 0);
});
test("QuickBooks catalog pagination includes accounts after the first thousand", async (t) => {
  fakeFetch(t, (url) =>
    json({
      QueryResponse: {
        Account: url.searchParams.get("query")?.includes("startposition 1 ")
          ? Array.from({ length: 1000 }, (_, i) => ({
              Id: String(i),
              Active: true,
            }))
          : [
              { Id: "last", Active: true },
              { Id: "inactive", Active: false },
            ],
      },
    }),
  );
  const accounts = await listQuickBooksEntity(
    { accessToken: "t", realmId: "123" },
    "Account",
  );
  assert.equal(accounts.length, 1001);
  assert.equal(accounts.at(-1).Id, "last");
});
test("Xero catalogs filter inactive accounts and sales-only tax codes", async (t) => {
  fakeFetch(t, (url) =>
    json(
      url.pathname.endsWith("/Accounts")
        ? {
            Accounts: [
              {
                Code: "1",
                Name: "Purchases",
                Status: "ACTIVE",
                Class: "EXPENSE",
                Type: "DIRECTCOSTS",
              },
              { Code: "2", Status: "ARCHIVED", Class: "EXPENSE" },
              { Code: "3", Status: "ACTIVE", Class: "REVENUE" },
            ],
          }
        : url.pathname.endsWith("/TaxRates")
          ? {
              TaxRates: [
                {
                  TaxType: "INPUT",
                  Name: "VAT",
                  Status: "ACTIVE",
                  CanApplyToExpenses: true,
                  EffectiveRate: 20,
                },
                {
                  TaxType: "OUTPUT",
                  Status: "ACTIVE",
                  CanApplyToRevenue: true,
                },
              ],
            }
          : url.pathname.endsWith("/Organisation")
            ? {
                Organisations: [
                  { Name: "Test", BaseCurrency: "GBP", CountryCode: "GB" },
                ],
              }
            : { Currencies: [{ Code: "GBP" }] },
    ),
  );
  const result = await fetchAccountingCatalog({
    platform: "XERO",
    environment: "production",
    tenantId: "tenant",
    accessToken: "t",
  } as any);
  assert.deepEqual(
    result.accounts.map((a) => a.id),
    ["1"],
  );
  assert.deepEqual(
    result.taxes.map((a) => a.id),
    ["INPUT"],
  );
});
