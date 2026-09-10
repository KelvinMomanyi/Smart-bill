import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { exportApprovedInvoice } from "../services/accountingExport.server";
import {
  createAuthorization,
  launchAuthorization,
  completeAuthorizationCallback,
  confirmAuthorization,
} from "../services/accountingAuthorization.server";
import { openAccountingSecret } from "../utils/accountingTokens.server";
import {
  getAccountingConnection,
  disconnectAccounting,
} from "../services/accountingConnection.server";
import { attachApprovedInvoiceDocument } from "../services/accountingAttachment.server";

const shop = "test-shop.myshopify.com";
function replaceMethod(
  t: any,
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
function mockTransaction(t: any) {
  // Simulate the serialized row locks used by Prisma transactions.
  let pending = Promise.resolve();
  replaceMethod(t, prisma, "$transaction", (callback: any) => {
    const result = pending.then(() =>
      typeof callback === "function" ? callback(prisma) : Promise.all(callback),
    );
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  });
  replaceMethod(t, prisma, "$queryRaw", async () => []);
}
function mockWorkflow(
  t: any,
  platform: "XERO" | "QUICKBOOKS",
  mode: "ok" | "reject" | "timeout" | "mismatch" | "duplicate" = "ok",
) {
  const invoice: any = {
    id: "invoice-1",
    shop,
    invoiceNumber: "INV-1",
    vendor: { name: "Example Supplier" },
    date: new Date("2026-09-10"),
    dueDate: new Date("2026-10-10"),
    currency: "GBP",
    subtotal: 100,
    tax: 20,
    total: 120,
    reviewStatus: "APPROVED",
    approvedAt: new Date(),
    revision: 0,
    accountingStatus: "NOT_EXPORTED",
    status: "PENDING_SYNC",
    items: [
      {
        id: "line-1",
        name: "Purchase",
        quantity: 1,
        price: 100,
        amount: 100,
        syncCost: false,
      },
    ],
    exports: [],
    costChanges: [],
  };
  const entries: any[] = [];
  const connection: any = {
    id: "conn",
    shop,
    platform,
    environment: platform === "QUICKBOOKS" ? "sandbox" : "production",
    realmId: platform === "QUICKBOOKS" ? "123" : null,
    tenantId: platform === "XERO" ? "tenant" : null,
    accessToken: "test-access",
    refreshToken: "test-refresh",
    expiresAt: new Date(Date.now() + 3600000),
    country: "GB",
    homeCurrency: "GBP",
  };
  let billPosts = 0;
  let remote: any = null;
  const audits: any[] = [];
  const matches = (entry: any, where: any) =>
    Object.entries(where).every(([key, value]: any) =>
      value && typeof value === "object"
        ? "not" in value
          ? entry[key] !== value.not
          : true
        : entry[key] === value,
    );
  mockTransaction(t);
  replaceMethod(t, prisma.invoice, "findFirst", async () =>
    structuredClone({ ...invoice, exports: entries }),
  );
  replaceMethod(t, prisma.invoice, "update", async ({ data }: any) =>
    Object.assign(invoice, data),
  );
  replaceMethod(t, prisma.accountingConnection, "findUnique", async () =>
    structuredClone(connection),
  );
  replaceMethod(
    t,
    prisma.accountingConnection,
    "update",
    async ({ data }: any) => Object.assign(connection, data),
  );
  replaceMethod(t, prisma.shopSettings, "findUnique", async () => ({
    xeroAccountCode: "10",
    xeroTaxType: "INPUT20",
    quickBooksAccountId: "10",
    quickBooksTaxCodeId: "20",
  }));
  replaceMethod(t, prisma.accountingExport, "create", async ({ data }: any) => {
    const entry = {
      id: randomUUID(),
      remoteId: null,
      attachmentStatus: "NOT_REQUESTED",
      updatedAt: new Date(),
      ...data,
    };
    entries.push(entry);
    return structuredClone(entry);
  });
  replaceMethod(
    t,
    prisma.accountingExport,
    "findFirst",
    async ({ where }: any) =>
      entries.find((entry) => matches(entry, where)) || null,
  );
  replaceMethod(
    t,
    prisma.accountingExport,
    "findUniqueOrThrow",
    async ({ where }: any) =>
      structuredClone(entries.find((entry) => entry.id === where.id)),
  );
  replaceMethod(
    t,
    prisma.accountingExport,
    "update",
    async ({ where, data }: any) => {
      const entry = entries.find((entry) => entry.id === where.id);
      Object.assign(entry, data);
      return structuredClone(entry);
    },
  );
  replaceMethod(
    t,
    prisma.accountingExport,
    "updateMany",
    async ({ where, data }: any) => {
      const found = entries.filter((entry) => matches(entry, where));
      found.forEach((entry) => Object.assign(entry, data));
      return { count: found.length };
    },
  );
  replaceMethod(t, prisma.auditEvent, "create", async ({ data }: any) => {
    audits.push(data);
    return data;
  });
  t.mock.method(globalThis, "fetch", async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const query = url.searchParams.get("query") || "";
    const respond = (data: any, status = 200) =>
      new Response(JSON.stringify(data), { status });
    if (
      (path.endsWith("/bill") || path.endsWith("/Invoices")) &&
      init.method === "POST"
    ) {
      billPosts++;
      if (mode === "timeout")
        throw new Error("network timeout after transmission");
      if (mode === "reject")
        return respond(
          { Fault: { Error: [{ Detail: "Account is inactive" }] } },
          400,
        );
      const body = JSON.parse(init.body);
      remote =
        platform === "QUICKBOOKS"
          ? {
              ...body,
              Id: "remote-1",
              TotalAmt: mode === "mismatch" ? 121 : 120,
            }
          : {
              ...body.Invoices[0],
              InvoiceID: "remote-1",
              Total: mode === "mismatch" ? 121 : 120,
              SubTotal: 100,
              TotalTax: 20,
            };
      return respond(
        platform === "QUICKBOOKS" ? { Bill: remote } : { Invoices: [remote] },
      );
    }
    if (path.endsWith("/Accounts"))
      return respond({
        Accounts: [
          {
            Code: "10",
            Name: "Purchases",
            Status: "ACTIVE",
            Class: "EXPENSE",
            Type: "DIRECTCOSTS",
          },
        ],
      });
    if (path.endsWith("/TaxRates"))
      return respond({
        TaxRates: [
          {
            TaxType: "INPUT20",
            Name: "Purchase VAT",
            EffectiveRate: 20,
            Status: "ACTIVE",
            CanApplyToExpenses: true,
          },
        ],
      });
    if (path.endsWith("/Organisation"))
      return respond({
        Organisations: [
          { Name: "Test", BaseCurrency: "GBP", CountryCode: "GB" },
        ],
      });
    if (path.endsWith("/Currencies"))
      return respond({ Currencies: [{ Code: "GBP" }] });
    if (path.endsWith("/Contacts"))
      return respond({
        Contacts: [{ ContactID: "supplier", Name: "Example Supplier" }],
      });
    if (path.endsWith("/Invoices"))
      return respond({
        Invoices:
          mode === "duplicate"
            ? [
                {
                  Type: "ACCPAY",
                  Contact: { ContactID: "supplier", Name: "Example Supplier" },
                  InvoiceID: "existing",
                },
              ]
            : remote
              ? [remote]
              : [],
      });
    if (path.includes("/companyinfo/"))
      return respond({ CompanyInfo: { CompanyName: "Test", Country: "GB" } });
    if (path.endsWith("/preferences"))
      return respond({
        Preferences: {
          CurrencyPrefs: {
            HomeCurrency: { value: "GBP" },
            MultiCurrencyEnabled: false,
          },
        },
      });
    if (query.includes("from Account"))
      return respond({
        QueryResponse: {
          Account: [
            {
              Id: "10",
              Name: "Purchases",
              AccountType: "Expense",
              Classification: "Expense",
              Active: true,
            },
          ],
        },
      });
    if (query.includes("from TaxCode"))
      return respond({
        QueryResponse: {
          TaxCode: [
            {
              Id: "20",
              Name: "VAT",
              Taxable: true,
              PurchaseTaxRateList: {
                TaxRateDetail: [
                  {
                    TaxRateRef: { value: "rate-20" },
                    TaxTypeApplicable: "TaxOnAmount",
                  },
                ],
              },
            },
          ],
        },
      });
    if (query.includes("from TaxRate"))
      return respond({
        QueryResponse: {
          TaxRate: [{ Id: "rate-20", RateValue: 20, Active: true }],
        },
      });
    if (query.includes("from Vendor"))
      return respond({
        QueryResponse: {
          Vendor: [
            {
              Id: "supplier",
              DisplayName: "Example Supplier",
              CurrencyRef: { value: "GBP" },
            },
          ],
        },
      });
    if (query.includes("from Bill"))
      return respond({
        QueryResponse: {
          Bill:
            mode === "duplicate"
              ? [{ Id: "existing", VendorRef: { value: "supplier" } }]
              : remote
                ? [remote]
                : [],
        },
      });
    throw new Error("Unexpected mocked provider request: " + path);
  });
  return { invoice, entries, audits, connection, billPosts: () => billPosts };
}
for (const platform of ["XERO", "QUICKBOOKS"] as const) {
  test(`${platform} approved invoice exports through the actual service and repeated clicks create one bill`, async (t) => {
    const mock = mockWorkflow(t, platform);
    const params = { shop, actor: "owner", invoiceId: "invoice-1", platform };
    const first = await exportApprovedInvoice(params);
    assert.equal(first.success, true);
    assert.equal(mock.entries[0].status, "EXPORTED");
    assert.equal(mock.invoice.accountingStatus, "EXPORTED");
    assert.ok(mock.audits.some((a) => a.action === "ACCOUNTING_EXPORTED"));
    await exportApprovedInvoice(params);
    assert.equal(mock.billPosts(), 1);
  });
  test(`${platform} concurrent exports serialize and cannot create duplicate bills`, async (t) => {
    const mock = mockWorkflow(t, platform);
    const params = { shop, actor: "owner", invoiceId: "invoice-1", platform };
    const outcomes = await Promise.allSettled([
      exportApprovedInvoice(params),
      exportApprovedInvoice(params),
    ]);
    assert.ok(outcomes.some((o) => o.status === "fulfilled"));
    assert.equal(mock.billPosts(), 1);
    assert.equal(mock.entries.length, 1);
  });
  for (const [mode, expected] of [
    ["reject", "REJECTED"],
    ["timeout", "VERIFY"],
    ["mismatch", "VERIFY"],
    ["duplicate", "VERIFY"],
  ] as const) {
    test(`${platform} ${mode} export preserves a recoverable ledger state`, async (t) => {
      const mock = mockWorkflow(t, platform, mode);
      const params = { shop, actor: "owner", invoiceId: "invoice-1", platform };
      await assert.rejects(exportApprovedInvoice(params));
      assert.equal(mock.entries[0].status, expected);
      assert.equal(mock.invoice.accountingStatus, "NOT_EXPORTED");
      if (mode === "duplicate") assert.equal(mock.billPosts(), 0);
      if (mode === "mismatch")
        assert.equal(mock.entries[0].remoteId, "remote-1");
      if (expected === "VERIFY") {
        const before = mock.billPosts();
        await assert.rejects(exportApprovedInvoice(params));
        assert.equal(mock.billPosts(), before);
      } else {
        const firstKey = mock.entries[0].requestKey;
        await assert.rejects(exportApprovedInvoice(params));
        assert.equal(mock.billPosts(), 2);
        assert.notEqual(mock.entries[0].requestKey, firstKey);
      }
    });
  }
}
test("unapproved invoices cannot reach accounting providers", async (t) => {
  const mock = mockWorkflow(t, "XERO");
  mock.invoice.reviewStatus = "PENDING_REVIEW";
  mock.invoice.approvedAt = null;
  await assert.rejects(
    exportApprovedInvoice({
      shop,
      actor: "owner",
      invoiceId: "invoice-1",
      platform: "XERO",
    }),
    /approv/i,
  );
  assert.equal(mock.billPosts(), 0);
  assert.equal(mock.entries.length, 0);
});

for (const platform of ["XERO", "QUICKBOOKS"] as const) {
  test(`${platform} disconnect revokes provider access before deleting local credentials`, async (t) => {
    const mock = mockWorkflow(t, platform);
    mock.connection.xeroConnectionId = "selected-connection";
    const operations: string[] = [];
    replaceMethod(t, prisma.accountingExport, "count", async () => 0);
    replaceMethod(t, prisma.accountingConnection, "deleteMany", async () => {
      operations.push("delete-local");
      return { count: 1 };
    });
    replaceMethod(
      t,
      prisma.accountingAuthorization,
      "deleteMany",
      async () => ({ count: 0 }),
    );
    replaceMethod(
      t,
      prisma.accountingConnection,
      "findFirst",
      async () => null,
    );
    replaceMethod(
      t,
      prisma.shopSettings,
      "updateMany",
      async ({ data }: any) => {
        assert.equal(data.accountingConnected, false);
        return { count: 1 };
      },
    );
    t.mock.method(globalThis, "fetch", async (input: any, init: any) => {
      operations.push("revoke-remote");
      const url = new URL(String(input));
      assert.equal(
        url.pathname,
        platform === "XERO"
          ? "/connections/selected-connection"
          : "/v2/oauth2/tokens/revoke",
      );
      assert.equal(init.method, platform === "XERO" ? "DELETE" : "POST");
      return new Response(null, { status: 204 });
    });
    await disconnectAccounting(shop, platform, "owner");
    assert.deepEqual(operations, ["revoke-remote", "delete-local"]);
  });
}
test("a provider credential configuration error does not erase a connection during disconnect", async (t) => {
  mockWorkflow(t, "QUICKBOOKS");
  replaceMethod(t, prisma.accountingExport, "count", async () => 0);
  let deleted = false;
  replaceMethod(t, prisma.accountingConnection, "deleteMany", async () => {
    deleted = true;
    return { count: 1 };
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(JSON.stringify({ error: "invalid_client" }), {
        status: 400,
      }),
  );
  await assert.rejects(
    disconnectAccounting(shop, "QUICKBOOKS", "owner"),
    /client credentials/,
  );
  assert.equal(deleted, false);
});
function mockAuthorization(t: any) {
  const rows: any[] = [];
  const connected: any[] = [];
  let tokenCalls = 0;
  const matches = (row: any, where: any) =>
    Object.entries(where).every(([k, v]: any) =>
      v && typeof v === "object" && "gt" in v
        ? row[k] > v.gt
        : v && typeof v === "object"
          ? true
          : row[k] === v,
    );
  mockTransaction(t);
  replaceMethod(t, prisma.accountingAuthorization, "deleteMany", async () => ({
    count: 0,
  }));
  replaceMethod(
    t,
    prisma.accountingAuthorization,
    "create",
    async ({ data }: any) => {
      const row = { ...data, status: "CREATED", cookieHash: null };
      rows.push(row);
      return row;
    },
  );
  replaceMethod(
    t,
    prisma.accountingAuthorization,
    "findUnique",
    async ({ where }: any) =>
      structuredClone(rows.find((r) => r.id === where.id)),
  );
  replaceMethod(
    t,
    prisma.accountingAuthorization,
    "findUniqueOrThrow",
    async ({ where }: any) =>
      structuredClone(rows.find((r) => r.id === where.id)),
  );
  replaceMethod(
    t,
    prisma.accountingAuthorization,
    "update",
    async ({ where, data }: any) =>
      Object.assign(
        rows.find((r) => r.id === where.id),
        data,
      ),
  );
  replaceMethod(
    t,
    prisma.accountingAuthorization,
    "updateMany",
    async ({ where, data }: any) => {
      const selected = rows.filter((r) => matches(r, where));
      selected.forEach((r) => Object.assign(r, data));
      return { count: selected.length };
    },
  );
  replaceMethod(t, prisma.accountingConnection, "findUnique", async () => null);
  replaceMethod(t, prisma.accountingExport, "count", async () => 0);
  replaceMethod(
    t,
    prisma.accountingConnection,
    "upsert",
    async ({ create }: any) => {
      connected.push(create);
      return create;
    },
  );
  replaceMethod(
    t,
    prisma.shopSettings,
    "upsert",
    async ({ create }: any) => create,
  );
  replaceMethod(t, prisma.auditEvent, "create", async ({ data }: any) => data);
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const url = new URL(String(input));
    let data: any;
    if (url.pathname.includes("/token")) {
      tokenCalls++;
      data = {
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_in: 1800,
      };
    } else if (url.pathname === "/connections")
      data = [
        {
          id: "connection-a",
          tenantId: "company-a",
          tenantName: "Company A",
          tenantType: "ORGANISATION",
        },
        {
          id: "connection-b",
          tenantId: "company-b",
          tenantName: "Company B",
          tenantType: "ORGANISATION",
        },
      ];
    else if (url.pathname.endsWith("/Organisation"))
      data = {
        Organisations: [
          { Name: "Company B", BaseCurrency: "GBP", CountryCode: "GB" },
        ],
      };
    else if (url.pathname.includes("/companyinfo/"))
      data = { CompanyInfo: { CompanyName: "Test QB", Country: "GB" } };
    else if (url.pathname.endsWith("/preferences"))
      data = {
        Preferences: { CurrencyPrefs: { HomeCurrency: { value: "GBP" } } },
      };
    else throw new Error("Unexpected OAuth request");
    return new Response(JSON.stringify(data), { status: 200 });
  });
  return { rows, connected, tokenCalls: () => tokenCalls };
}
test("concurrent requests refresh the token once and retain the rotated refresh token", async (t) => {
  const mock = mockWorkflow(t, "QUICKBOOKS");
  mock.connection.expiresAt = new Date(Date.now() - 1000);
  let refreshes = 0;
  t.mock.method(globalThis, "fetch", async () => {
    refreshes++;
    return new Response(
      JSON.stringify({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      }),
      { status: 200 },
    );
  });
  const connections = await Promise.all([
    getAccountingConnection(shop, "QUICKBOOKS"),
    getAccountingConnection(shop, "QUICKBOOKS"),
  ]);
  assert.equal(refreshes, 1);
  assert.equal(connections[0].accessToken, "rotated-access");
  assert.equal(connections[1].accessToken, "rotated-access");
  assert.equal(
    openAccountingSecret(mock.connection.refreshToken),
    "rotated-refresh",
  );
});
for (const platform of ["XERO", "QUICKBOOKS"] as const) {
  test(`${platform} original document attachment uploads once and preserves the exported bill`, async (t) => {
    const mock = mockWorkflow(t, platform);
    const params = { shop, actor: "owner", invoiceId: "invoice-1", platform };
    await exportApprovedInvoice(params);
    mock.invoice.storageKey = "gs://test/invoices/test.pdf";
    let uploads = 0;
    t.mock.method(globalThis, "fetch", async (input: any, init: any = {}) => {
      const url = new URL(String(input));
      let result: any;
      if (url.pathname.endsWith("/Attachments")) result = { Attachments: [] };
      else if (url.pathname.endsWith("/query"))
        result = { QueryResponse: { Attachable: [] } };
      else if (url.pathname.includes("/Attachments/")) {
        uploads++;
        assert.equal(init.method, "PUT");
        assert.equal(
          new Headers(init.headers).get("Content-Type"),
          "application/pdf",
        );
        assert.equal(Buffer.from(init.body).toString(), "%PDF-test");
        result = { Attachments: [{ AttachmentID: "attachment" }] };
      } else if (url.pathname.endsWith("/upload")) {
        uploads++;
        assert.ok(init.body instanceof FormData);
        const metadata = JSON.parse(
          await init.body.get("file_metadata_01").text(),
        );
        assert.deepEqual(metadata.AttachableRef, [
          { EntityRef: { type: "Bill", value: "remote-1" } },
        ]);
        assert.equal(
          await init.body.get("file_content_01").text(),
          "%PDF-test",
        );
        assert.equal(new Headers(init.headers).has("Content-Type"), false);
        result = { AttachableResponse: [{ Attachable: { Id: "attachment" } }] };
      } else throw new Error("Unexpected attachment request");
      return new Response(JSON.stringify(result), { status: 200 });
    });
    const reader = async () => ({
      buffer: Buffer.from("%PDF-test"),
      contentType: "application/pdf",
    });
    await attachApprovedInvoiceDocument(params, reader);
    await attachApprovedInvoiceDocument(params, reader);
    assert.equal(uploads, 1);
    assert.equal(mock.entries[0].attachmentStatus, "ATTACHED");
    assert.equal(mock.entries[0].status, "EXPORTED");
  });
}
for (const platform of ["XERO", "QUICKBOOKS"] as const) {
  test(`${platform} OAuth launch, callback, explicit company confirmation and replay protection work together`, async (t) => {
    const mock = mockAuthorization(t);
    const launch = await createAuthorization(shop, platform, "owner");
    const state = new URL(launch).searchParams.get("state")!;
    const response = await launchAuthorization(new Request(launch));
    const cookie = response.headers.get("Set-Cookie")!.split(";")[0];
    await assert.rejects(launchAuthorization(new Request(launch)), /used/);
    const callbackUrl = `https://app.example/accounting/${platform.toLowerCase()}/callback?code=test&realmId=123&state=${encodeURIComponent(state)}`;
    await assert.rejects(
      completeAuthorizationCallback(new Request(callbackUrl), platform),
      /browser/,
    );
    assert.equal(mock.tokenCalls(), 0);
    await completeAuthorizationCallback(
      new Request(callbackUrl, { headers: { Cookie: cookie } }),
      platform,
    );
    assert.equal(
      mock.connected.length,
      0,
      "Callback must not pick a company automatically",
    );
    assert.equal(mock.rows[0].status, "SELECTING");
    assert.ok(mock.rows[0].credentials.startsWith("enc:v1:"));
    await assert.rejects(
      completeAuthorizationCallback(
        new Request(callbackUrl, { headers: { Cookie: cookie } }),
        platform,
      ),
      /completed/,
    );
    assert.equal(mock.tokenCalls(), 1);
    const confirmation = new Request("https://app.example/accounting/confirm", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://app.example" },
    });
    await assert.rejects(
      confirmAuthorization(confirmation, mock.rows[0].id, "not-authorized"),
      /Choose one/,
    );
    await confirmAuthorization(
      confirmation,
      mock.rows[0].id,
      platform === "XERO" ? "company-b" : "123",
    );
    assert.equal(mock.connected.length, 1);
    assert.equal(
      platform === "XERO"
        ? mock.connected[0].tenantId
        : mock.connected[0].realmId,
      platform === "XERO" ? "company-b" : "123",
    );
    assert.equal(
      openAccountingSecret(mock.connected[0].refreshToken),
      "test-refresh",
    );
    assert.equal(mock.rows[0].credentials, null);
    await assert.rejects(
      confirmAuthorization(
        confirmation,
        mock.rows[0].id,
        platform === "XERO" ? "company-b" : "123",
      ),
      /completed/,
    );
  });
}
