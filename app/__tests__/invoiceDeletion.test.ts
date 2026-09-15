import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import prisma from "../db.server";
import { invoiceDeletionBlockedReason } from "../utils/invoiceDeletion";

const originalCount = prisma.session.count;
(prisma.session as any).count = async () => 0;
const { deleteCapturedInvoiceForShop } = await import(
  "../services/invoiceDeletion.server"
);
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

function mockDeletion(t: TestContext) {
  const invoice: any = {
    id: "invoice-delete-1",
    shop: "delete-shop.myshopify.com",
    invoiceNumber: "DELETE-100",
    status: "PENDING_SYNC",
    reviewStatus: "APPROVED",
    cogsSyncStatus: "NOT_REQUESTED",
    accountingStatus: "NOT_EXPORTED",
    revision: 4,
    documentHash: "delete-hash",
    storageKey:
      "supabase://documents/invoices/delete-shop.myshopify.com/delete.pdf",
    purchaseOrderId: "po-1",
    vendorId: "vendor-1",
    vendor: { id: "vendor-1", name: "Delete Supplier" },
    items: [{ id: "line-1", name: "Item", quantity: 3, price: 10 }],
    exports: [{ platform: "XERO", status: "REJECTED" }],
    costChanges: [{ status: "PLANNED" }],
  };
  const calls = {
    audit: 0,
    jobs: 0,
    invoice: 0,
    mappings: 0,
    vendor: 0,
    billedQty: -1,
    poStatus: "",
  };
  let deleted = false;

  replaceMethod(t, prisma, "$transaction", async (callback: any) =>
    callback(prisma),
  );
  replaceMethod(t, prisma, "$queryRaw", async () => [{ id: "locked" }]);
  replaceMethod(t, prisma.invoice, "findFirst", async ({ where }: any) =>
    !deleted && where.id === invoice.id && where.shop === invoice.shop
      ? structuredClone(invoice)
      : null,
  );
  replaceMethod(t, prisma.invoice, "update", async ({ where, data }: any) => {
    if (where.id === invoice.id) {
      if (data.revision?.increment) invoice.revision += data.revision.increment;
      Object.assign(invoice, {
        ...data,
        revision: invoice.revision,
      });
    }
    return invoice;
  });
  replaceMethod(t, prisma.invoice, "updateMany", async ({ data }: any) => {
    Object.assign(invoice, data);
    return { count: 1 };
  });
  replaceMethod(t, prisma.auditEvent, "deleteMany", async () => {
    calls.audit++;
    return { count: 2 };
  });
  replaceMethod(t, prisma.invoiceJob, "deleteMany", async ({ where }: any) => {
    assert.equal(where.shop, invoice.shop);
    assert.ok(where.OR.some((entry: any) => entry.invoiceId === invoice.id));
    assert.ok(
      where.OR.some((entry: any) => entry.documentHash === invoice.documentHash),
    );
    calls.jobs++;
    return { count: 1 };
  });
  replaceMethod(t, prisma.invoice, "delete", async () => {
    calls.invoice++;
    deleted = true;
    return invoice;
  });
  replaceMethod(t, prisma.invoice, "count", async () => 0);
  replaceMethod(t, prisma.purchaseOrder, "count", async () => 0);
  replaceMethod(t, prisma.supplierMapping, "deleteMany", async () => {
    calls.mappings++;
    return { count: 1 };
  });
  replaceMethod(t, prisma.vendor, "deleteMany", async () => {
    calls.vendor++;
    return { count: 1 };
  });
  replaceMethod(t, prisma.purchaseOrder, "findFirst", async () => ({
    id: "po-1",
    shop: invoice.shop,
    currency: "USD",
    items: [
      {
        id: "po-line-1",
        name: "Item",
        expectedQty: 3,
        receivedQty: 0,
        expectedRate: 10,
      },
    ],
    linkedInvoices: [],
  }));
  replaceMethod(t, prisma.purchaseOrderItem, "update", async ({ data }: any) => {
    calls.billedQty = data.billedQty;
    return {};
  });
  replaceMethod(t, prisma.purchaseOrder, "update", async ({ data }: any) => {
    calls.poStatus = data.status;
    return {};
  });
  return { invoice, calls, deleted: () => deleted };
}

test("captured invoice deletion removes dependent local data and refreshes its PO", async (t) => {
  const { invoice, calls, deleted } = mockDeletion(t);
  const documents: string[] = [];
  const result = await deleteCapturedInvoiceForShop(
    { shop: invoice.shop, invoiceId: invoice.id },
    async (key) => {
      documents.push(key);
    },
  );
  assert.equal(result.invoiceNumber, "DELETE-100");
  assert.deepEqual(documents, [invoice.storageKey]);
  assert.equal(deleted(), true);
  assert.deepEqual(calls, {
    audit: 1,
    jobs: 1,
    invoice: 1,
    mappings: 1,
    vendor: 1,
    billedQty: 0,
    poStatus: "OPEN",
  });
});

test("document cleanup failure restores an invoice before local data is removed", async (t) => {
  const { invoice, calls, deleted } = mockDeletion(t);
  await assert.rejects(
    deleteCapturedInvoiceForShop(
      { shop: invoice.shop, invoiceId: invoice.id },
      async () => {
        throw new Error("Supabase unavailable");
      },
    ),
    /Supabase unavailable/,
  );
  assert.equal(deleted(), false);
  assert.equal(invoice.status, "PENDING_SYNC");
  assert.equal(invoice.reviewStatus, "APPROVED");
  assert.equal(invoice.revision, 4);
  assert.equal(calls.audit, 0);
  assert.equal(calls.jobs, 0);
});

test("captured invoices cannot be deleted across shops", async (t) => {
  const { invoice, deleted } = mockDeletion(t);
  let documentDeleted = false;
  await assert.rejects(
    deleteCapturedInvoiceForShop(
      { shop: "another-shop.myshopify.com", invoiceId: invoice.id },
      async () => {
        documentDeleted = true;
      },
    ),
    /Invoice not found/,
  );
  assert.equal(documentDeleted, false);
  assert.equal(deleted(), false);
});

test("invoice deletion blocks external financial activity", () => {
  const base = {
    accountingStatus: "NOT_EXPORTED",
    cogsSyncStatus: "NOT_REQUESTED",
    exports: [] as Array<{ platform: string; status: string }>,
    costChanges: [] as Array<{ status: string }>,
  };
  assert.equal(invoiceDeletionBlockedReason(base), null);
  assert.match(
    invoiceDeletionBlockedReason({
      ...base,
      exports: [{ platform: "QUICKBOOKS", status: "VERIFY" }],
    }) || "",
    /accounting bill|uncertain result/,
  );
  assert.match(
    invoiceDeletionBlockedReason({
      ...base,
      costChanges: [{ status: "APPLIED" }],
    }) || "",
    /Shopify product costs/,
  );
  assert.equal(
    invoiceDeletionBlockedReason({
      ...base,
      exports: [{ platform: "XERO", status: "REJECTED" }],
      costChanges: [{ status: "PLANNED" }],
    }),
    null,
  );
});
