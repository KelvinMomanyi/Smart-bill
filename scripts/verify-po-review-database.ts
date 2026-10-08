import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import prisma from "../app/db.server";
import {
  createPurchaseOrder,
  purchaseOrderInput,
} from "../app/services/purchaseOrders.server";

// Every test write stays inside an explicitly rolled-back transaction. This
// verifies the configured PostgreSQL schema without leaving merchant records.
async function main() {
  const audit = {
    purchaseOrders: await prisma.purchaseOrder.count(),
    invoices: await prisma.invoice.count(),
    connections: await prisma.accountingConnection.groupBy({
      by: ["platform", "environment"],
      _count: { _all: true },
    }),
    tenantMismatches: Number(
      (
        await prisma.$queryRaw<
          { count: bigint }[]
        >`SELECT COUNT(*)::bigint AS count FROM "PurchaseOrder" p JOIN "Vendor" v ON v.id = p."vendorId" WHERE p.shop <> v.shop`
      )[0].count,
    ),
    duplicatePoNumbers: Number(
      (
        await prisma.$queryRaw<
          { count: bigint }[]
        >`SELECT COUNT(*)::bigint AS count FROM (SELECT shop, "poNumber" FROM "PurchaseOrder" WHERE "poNumber" IS NOT NULL GROUP BY shop, "poNumber" HAVING COUNT(*) > 1) duplicates`
      )[0].count,
    ),
    xeroCredentialsConfigured: Boolean(
      process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET,
    ),
    quickBooksEnvironment: process.env.QB_ENVIRONMENT || "production",
    quickBooksSandboxCredentialsConfigured: Boolean(
      process.env.QB_SANDBOX_CLIENT_ID && process.env.QB_SANDBOX_CLIENT_SECRET,
    ),
  };
  assert.equal(audit.tenantMismatches, 0);
  assert.equal(audit.duplicatePoNumbers, 0);
  let payloads: Array<Array<[string, string]>>;
  try {
    const evidence = JSON.parse(
      await readFile(".cache/po-review-browser-evidence.json", "utf8"),
    );
    payloads = evidence.submissions
      .filter((s: any) => s.response?.success === true)
      .map((s: any) => s.payloadFields || Object.entries(s.payload));
  } catch {
    payloads = [
      Object.entries({
        intent: "create-po",
        vendorName: "Review supplier",
        poNumber: "REVIEW-ROLLBACK",
        expectedDate: "2026-10-08",
        notes: "Rolled back",
        itemName: "Fabric",
        itemSku: "FAB-1",
        itemQuantity: "2.5",
        itemRate: "12.50",
      }),
    ];
  }
  const rollback = new Error("INTENTIONAL_REVIEW_ROLLBACK");
  const checks = [];
  for (const [index, payload] of payloads.entries()) {
    const testShop = `po-review-${randomUUID()}.myshopify.com`;
    let verified = false;
    try {
      await prisma.$transaction(
        async (tx) => {
          const adapter = { $transaction: (fn: any) => fn(tx) } as Pick<
            typeof prisma,
            "$transaction"
          >;
          const form = new FormData();
          for (const [key, value] of payload) form.append(key, value);
          form.set("submissionId", randomUUID());
          const input = purchaseOrderInput(form);
          const saved = await createPurchaseOrder(testShop, input, adapter);
          const stored = await tx.purchaseOrder.findFirst({
            where: { id: saved.id, shop: testShop },
            include: { vendor: true, items: true },
          });
          assert.ok(stored);
          assert.equal(stored.vendor.shop, testShop);
          assert.equal(stored.vendor.name, input.vendorName);
          assert.equal(stored.currency, "USD");
          assert.equal(stored.totalAmount, Math.round(input.items.reduce((sum, item) => sum + item.expectedQty * (item.expectedRate ?? 0), 0) * 100) / 100);
          assert.equal(stored.items.length, input.items.length);
          assert.equal(stored.poNumber, input.poNumber || null);
          assert.equal(
            stored.expectedDate?.toISOString().slice(0, 10) || "",
            input.expectedDate,
          );
          assert.equal(stored.notes || "", input.notes);
          for (const item of input.items) {
            const persisted: (typeof stored.items)[number] | undefined =
              stored.items.find(
                (i) =>
                  i.name === item.name && i.expectedQty === item.expectedQty,
              );
            assert.ok(persisted);
            assert.equal(persisted.sku, item.sku || null);
            assert.equal(persisted.expectedRate, item.expectedRate ?? null);
          }
          const replay = await createPurchaseOrder(testShop, input, adapter);
          assert.equal(replay.id, saved.id);
          assert.equal(
            await tx.purchaseOrder.count({ where: { shop: testShop } }),
            1,
          );
          assert.equal(
            await tx.purchaseOrder.findFirst({
              where: { id: saved.id, shop: "another-store.myshopify.com" },
            }),
            null,
          );
          verified = true;
          throw rollback;
        },
        { timeout: 30000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
    assert.ok(verified);
    assert.equal(
      await prisma.purchaseOrder.count({ where: { shop: testShop } }),
      0,
    );
    assert.equal(await prisma.vendor.count({ where: { shop: testShop } }), 0);
    assert.equal(
      await prisma.shopSettings.count({ where: { shop: testShop } }),
      0,
    );
    checks.push({
      browserPayload: index + 1,
      persistence: "PASS",
      replay: "PASS",
      tenantIsolation: "PASS",
      rollback: "PASS",
    });
  }
  await mkdir(".cache", { recursive: true });
  await writeFile(
    ".cache/po-review-database-evidence.json",
    JSON.stringify(
      { audit, checks, committedTestRecords: 0, accountingApisCalled: false },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      {
        audit,
        checkedPayloads: checks.length,
        checks,
        committedTestRecords: 0,
        accountingApisCalled: false,
      },
      null,
      2,
    ),
  );
}
main()
  .catch((error) => {
    console.error(
      error instanceof Error
        ? error.name + ": PO database verification failed"
        : "PO database verification failed",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
