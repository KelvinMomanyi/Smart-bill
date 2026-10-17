import "./accountingTestEnvironment";
import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshPurchaseOrderInTransaction } from "../services/poReconciliation.server";

async function reconcile(extraProduct = false) {
  const items = [
    { name: "Mug", sku: "MUG", category: "PRODUCT", quantity: 10, price: 5, amount: 50 },
    // Even a charge with the product SKU must not inflate received/billed units.
    ...["FREIGHT", "DUTY", "HANDLING", "INSURANCE", "OTHER"].map(category => ({
      name: category, sku: "MUG", category, quantity: 1, price: 1, amount: 1,
    })),
    ...(extraProduct ? [{ name: "Unexpected product", sku: "OTHER-SKU", category: "PRODUCT", quantity: 1, price: 1, amount: 1 }] : []),
  ];
  const bill = { id: "invoice", invoiceNumber: "TEST-1", currency: "USD", subtotal: extraProduct ? 51 : 50, tax: 0, total: extraProduct ? 56 : 55, reviewStatus: "PENDING_REVIEW", items };
  const updates = { billedQty: 0, discrepancySummary: "", reviewStatus: "" };
  const tx = {
    $queryRaw: async () => [],
    purchaseOrder: {
      findFirst: async ({ where }: any) => {
        assert.deepEqual(where, { id: "po", shop: "po-test.myshopify.com" });
        return { id: "po", currency: "USD", items: [{ id: "po-line", name: "Mug", sku: "MUG", expectedQty: 10, receivedQty: 10, expectedRate: 5 }], linkedInvoices: [bill] };
      },
      update: async () => ({}),
    },
    purchaseOrderItem: { update: async ({ data }: any) => Object.assign(updates, data) },
    invoice: { update: async ({ data }: any) => Object.assign(updates, data) },
  };
  const result = await refreshPurchaseOrderInTransaction(tx as any, "po-test.myshopify.com", "po");
  return { result, updates };
}

test("PO reconciliation excludes landed-cost charges from product quantities and price matching", async () => {
  const { result, updates } = await reconcile();
  assert.deepEqual(result.discrepancies, []);
  assert.equal(result.status, "FULFILLED");
  assert.equal(updates.billedQty, 10);
  assert.equal(updates.discrepancySummary, null);
  assert.equal(updates.reviewStatus, "PENDING_REVIEW");
});

test("PO reconciliation still flags unexpected product lines alongside valid freight charges", async () => {
  const { result, updates } = await reconcile(true);
  assert.equal(result.status, "MISMATCH");
  assert.deepEqual(result.discrepancies, ["Unmatched or ambiguous item: Unexpected product."]);
  assert.equal(updates.billedQty, 10);
  assert.equal(updates.reviewStatus, "NEEDS_ATTENTION");
});
