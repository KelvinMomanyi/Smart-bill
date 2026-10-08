import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { parsePoItems, parseStructuredPoItems } from "../utils/poItems";

const originalCount = prisma.session.count;
(prisma.session as any).count = async () => 0;
const { authenticate } = await import("../shopify.server");
const { action, loader } = await import("../routes/app.reconciliation");
prisma.session.count = originalCount;

const shop = "po-workflow.myshopify.com";
function replace(t: TestContext, object: any, name: string, method: any) {
  const previous = object[name];
  object[name] = method;
  t.after(() => {
    object[name] = previous;
  });
}

function mockWorkflow(t: TestContext) {
  let subscribed = true;
  let failure: Error | undefined;
  let loadsFail = false;
  let transactions = 0;
  let authentications = 0;
  const orders: any[] = [];
  replace(t, prisma.session, "findUnique", async () => ({ role: "ADMIN" }));
  t.mock.method(authenticate, "admin", async () => {
    authentications++;
    return {
      session: { shop, id: "owner", isOnline: true },
      admin: {
        graphql: async () =>
          Response.json({
            data: {
              shop: { plan: { partnerDevelopment: true } },
              currentAppInstallation: {
                activeSubscriptions: subscribed
                  ? [
                      {
                        id: "subscription",
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
          }),
      },
    };
  });
  replace(t, prisma, "$transaction", async (callback: any) => {
    transactions++;
    return callback(prisma);
  });
  replace(t, prisma.vendor, "upsert", async ({ where, create }: any) => {
    assert.equal(where.shop_name.shop, shop);
    assert.equal(create.shop, shop);
    return { id: "vendor", name: create.name };
  });
  replace(t, prisma.shopSettings, "upsert", async ({ where }: any) => {
    assert.equal(where.shop, shop);
    return { defaultCurrency: "KES" };
  });
  replace(t, prisma.purchaseOrder, "create", async ({ data }: any) => {
    if (failure) throw failure;
    assert.equal(data.shop, shop);
    if (
      data.poNumber &&
      orders.some((order) => order.poNumber === data.poNumber)
    )
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "6.19.3",
        meta: { modelName: "PurchaseOrder", target: ["shop", "poNumber"] },
      });
    const order = {
      ...data,
      id: data.id || `po-${orders.length + 1}`,
      vendor: { name: "Test vendor" },
      items: data.items.create.map((item: any) => ({
        ...item,
        receivedQty: 0,
      })),
      linkedInvoices: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    orders.push(order);
    return order;
  });
  replace(t, prisma.purchaseOrder, "findMany", async ({ where }: any) => {
    assert.equal(where.shop, shop);
    if (loadsFail) throw new Error("Database unavailable");
    return orders;
  });
  replace(
    t,
    prisma.purchaseOrder,
    "findFirst",
    async ({ where }: any) =>
      orders.find(
        (order) => order.shop === where.shop && order.id === where.id,
      ) || null,
  );
  return {
    orders,
    setSubscribed: (value: boolean) => {
      subscribed = value;
    },
    setFailure: (value: Error | undefined) => {
      failure = value;
    },
    setLoadFailure: (value: boolean) => {
      loadsFail = value;
    },
    transactions: () => transactions,
    authentications: () => authentications,
  };
}

function form(overrides: Record<string, string> = {}) {
  const body = new URLSearchParams({
    intent: "create-po",
    vendorName: " Test vendor ",
    poNumber: "PO-100",
    expectedDate: "2026-10-08",
    notes: "Deliver to receiving",
    itemSku: "FAB-1",
    itemName: "Fabric",
    itemQuantity: "2.5",
    itemRate: "12.50",
    ...overrides,
  });
  return body;
}

const request = (body: URLSearchParams) =>
  new Request("https://app.example/app/reconciliation", {
    method: "POST",
    body,
  });

test("valid PO from named browser controls is saved and available in the workspace", async (t) => {
  const state = mockWorkflow(t);
  const response = await action({
    request: request(form({ structuredItems: "[]" })),
  } as any);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, true);
  assert.equal(result.purchaseOrderId, "po-1");
  assert.equal(state.authentications(), 1);
  assert.equal(state.transactions(), 1);
  assert.equal(state.orders[0].vendorId, "vendor");
  assert.equal(state.orders[0].currency, "KES");
  assert.equal(state.orders[0].totalAmount, 31.25);
  assert.equal(state.orders[0].items[0].expectedQty, 2.5);
  assert.equal(
    state.orders[0].expectedDate.toISOString(),
    "2026-10-08T00:00:00.000Z",
  );
  const refreshed = await loader({
    request: new Request("https://app.example/app/reconciliation"),
  } as any);
  assert.equal(
    (await refreshed.json()).purchaseOrders[0].id,
    result.purchaseOrderId,
  );
});

test("multiple native line items are saved without a hidden JSON snapshot", async (t) => {
  const state = mockWorkflow(t);
  const body = form();
  for (const [name, value] of Object.entries({
    itemSku: "SAMPLE",
    itemName: "Free sample",
    itemQuantity: "1",
    itemRate: "0",
  }))
    body.append(name, value);
  const response = await action({ request: request(body) } as any);
  assert.equal((await response.json()).success, true);
  assert.equal(state.orders[0].items.length, 2);
  assert.equal(state.orders[0].items[1].expectedRate, 0);
});

test("optional PO number, date, SKU and cost can all be blank", async (t) => {
  const state = mockWorkflow(t);
  const response = await action({
    request: request(
      form({ poNumber: "", expectedDate: "", itemSku: "", itemRate: "" }),
    ),
  } as any);
  assert.equal((await response.json()).success, true);
  assert.equal(state.orders[0].poNumber, null);
  assert.equal(state.orders[0].expectedDate, null);
  assert.equal(state.orders[0].items[0].expectedRate, null);
});

test("valid legacy structured submissions remain supported", async (t) => {
  const state = mockWorkflow(t);
  const body = form();
  for (const name of ["itemName", "itemSku", "itemQuantity", "itemRate"])
    body.delete(name);
  body.set(
    "structuredItems",
    JSON.stringify([
      { name: "Legacy item", expectedQty: "3", expectedRate: "4" },
    ]),
  );
  assert.equal(
    (await (await action({ request: request(body) } as any)).json()).success,
    true,
  );
  assert.equal(state.orders[0].items[0].name, "Legacy item");
});

test("spreadsheet, CSV and pipe rows create POs without clicking Import first", async (t) => {
  const state = mockWorkflow(t);
  for (const [index, text] of [
    "FAB-1 Fabric\t2.5\t12.50",
    '"Fabric, blue",2.5,"1,200.50"',
    "FAB-1 Fabric | 2.5 | 12.50",
  ].entries()) {
    const response = await action({
      request: request(
        form({
          poNumber: `BULK-${index}`,
          itemName: "",
          itemSku: "",
          itemQuantity: "1",
          itemRate: "",
          itemRows: text,
        }),
      ),
    } as any);
    assert.equal((await response.json()).success, true);
  }
  assert.equal(state.orders[1].items[0].expectedRate, 1200.5);
  assert.equal(state.orders[1].items[0].name, "Fabric, blue");
});

test("validation keeps the form usable, preserves values and performs no database writes", async (t) => {
  const state = mockWorkflow(t);
  const invalidEntries: Record<string, string>[] = [
    { vendorName: "" },
    { itemQuantity: "0" },
    { itemRate: "-1" },
    { expectedDate: "2026-02-30" },
    { itemName: "" },
    { notes: "x".repeat(2001) },
  ];
  for (const overrides of invalidEntries) {
    const body = form(overrides);
    const response = await action({ request: request(body) } as any);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.success, false);
    assert.ok(Object.keys(result.fieldErrors).length > 0);
    assert.equal(result.values.poNumber, "PO-100");
    assert.equal(result.values.items[0].quantity, body.get("itemQuantity"));
  }
  assert.equal(state.transactions(), 0);
  assert.equal(state.orders.length, 0);
});

test("incomplete additional rows and malformed pasted rows are never silently discarded", async (t) => {
  const state = mockWorkflow(t);
  const body = form();
  body.append("itemName", "");
  body.append("itemSku", "SKU-ONLY");
  body.append("itemQuantity", "2");
  body.append("itemRate", "3");
  const response = await action({ request: request(body) } as any);
  const result = await response.json();
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error, /Line 2: enter an item name/);
  assert.throws(
    () => parsePoItems("Valid item | 1 | 2\ninvalid row"),
    /Pasted line 2/,
  );
  assert.throws(() => parseStructuredPoItems("{bad json"), /could not be read/);
  assert.equal(state.orders.length, 0);
});

test("duplicate PO numbers show a recoverable field error and preserve the existing PO", async (t) => {
  const state = mockWorkflow(t);
  await action({ request: request(form()) } as any);
  const response = await action({ request: request(form()) } as any);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, false);
  assert.match(result.fieldErrors.poNumber || "", /already in use/);
  assert.equal(state.orders.length, 1);
});

test("missing billing approval gives a Settings recovery path without granting access", async (t) => {
  const state = mockWorkflow(t);
  state.setSubscribed(false);
  const response = await action({ request: request(form()) } as any);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, false);
  assert.equal(result.settingsRequired, true);
  assert.equal(result.values.items[0].name, "Fabric");
  assert.equal(state.transactions(), 0);
});

test("database errors keep entered values and disclose only a support reference", async (t) => {
  const state = mockWorkflow(t);
  state.setFailure(new Error("postgresql://private-host:secret SQL internals"));
  t.mock.method(console, "error", () => {});
  const response = await action({ request: request(form()) } as any);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.success, false);
  assert.match(result.error, /reference [0-9a-f-]+/);
  assert.doesNotMatch(result.error, /private-host|secret|SQL/);
  assert.equal(result.values.vendorName, " Test vendor ");
  assert.equal(state.orders.length, 0);
});

test("PO loading errors return an operational retry state instead of an error page", async (t) => {
  const state = mockWorkflow(t);
  state.setLoadFailure(true);
  t.mock.method(console, "error", () => {});
  const response = await loader({
    request: new Request("https://app.example/app/reconciliation"),
  } as any);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.purchaseOrders, []);
  assert.match(result.loadError || "", /retry/);
});

test("Shopify authentication responses are preserved instead of becoming successful form responses", async (t) => {
  const unauthorized = new Response("Unauthorized", { status: 401 });
  t.mock.method(authenticate, "admin", async () => {
    throw unauthorized;
  });
  await assert.rejects(
    action({ request: request(form()) } as any),
    (error) => error === unauthorized,
  );
});

test("replaying a form without a PO number reuses the saved submission instead of duplicating it", async (t) => {
  const state = mockWorkflow(t);
  const body = form({
    poNumber: "",
    submissionId: "01bfb105-3a14-4110-a101-b0e0f4984af2",
  });
  const first = await (await action({ request: request(body) } as any)).json();
  const second = await (await action({ request: request(body) } as any)).json();
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(second.purchaseOrderId, first.purchaseOrderId);
  assert.equal(state.orders.length, 1);
});

test("invalid submission keys and oversized line text are explained without writes", async (t) => {
  const state = mockWorkflow(t);
  const invalid: Record<string, string>[] = [
    { submissionId: "bad-key" },
    { itemName: "x".repeat(501) },
    { itemSku: "x".repeat(201) },
  ];
  for (const overrides of invalid) {
    const result = await (
      await action({ request: request(form(overrides)) } as any)
    ).json();
    assert.equal(result.success, false);
    assert.ok(result.error.length < 200);
  }
  assert.equal(state.orders.length, 0);
});
