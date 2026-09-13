import assert from "node:assert/strict";
import prisma from "../app/db.server";
import { getDashboard } from "../app/services/invoiceWorkflow.server";
import { invoiceIssues } from "../app/utils/invoiceRules";

async function main() {
  const stores = await prisma.session.findMany({
    distinct: ["shop"],
    select: { shop: true },
  });
  const [invoices, jobCounts, connectionCount, storageReferenceCounts] =
    await Promise.all([
      prisma.invoice.findMany({
        include: {
          items: true,
          vendor: true,
          exports: true,
          costChanges: true,
        },
      }),
      prisma.invoiceJob.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.accountingConnection.count(),
      Promise.all([
        prisma.invoice.count({
          where: { storageKey: { startsWith: "gs://" } },
        }),
        prisma.invoiceJob.count({
          where: { storageKey: { startsWith: "gs://" } },
        }),
        prisma.invoice.count({
          where: { storageKey: { startsWith: "supabase://" } },
        }),
        prisma.invoiceJob.count({
          where: { storageKey: { startsWith: "supabase://" } },
        }),
      ]),
    ]);

  for (const store of stores) {
    const dashboard = await getDashboard(store.shop);
    assert.ok(Array.isArray(dashboard.recentInvoices));
    assert.ok(Array.isArray(dashboard.activePurchaseOrders));
    assert.ok(Array.isArray(dashboard.metrics.spendByCurrency));
  }

  const approvedWithoutTimestamp = invoices.filter(
    (invoice) => invoice.reviewStatus === "APPROVED" && !invoice.approvedAt,
  ).length;
  const invalidApproved = invoices.filter(
    (invoice) =>
      invoice.reviewStatus === "APPROVED" && invoiceIssues(invoice).length > 0,
  ).length;
  const duplicateDocuments = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM (
      SELECT "shop", "documentHash" FROM "Invoice"
      WHERE "documentHash" IS NOT NULL
      GROUP BY "shop", "documentHash" HAVING COUNT(*) > 1
    ) duplicates
  `;

  assert.equal(approvedWithoutTimestamp, 0);
  assert.equal(invalidApproved, 0);
  assert.equal(Number(duplicateDocuments[0]?.count || 0), 0);
  assert.equal(storageReferenceCounts[0] + storageReferenceCounts[1], 0);
  console.log(
    JSON.stringify({
      stores: stores.length,
      dashboards: "passed",
      invoices: invoices.length,
      approvedIntegrity: "passed",
      duplicateDocumentCheck: "passed",
      legacyFirebaseStorageReferences:
        storageReferenceCounts[0] + storageReferenceCounts[1],
      supabaseStorageReferences:
        storageReferenceCounts[2] + storageReferenceCounts[3],
      jobs: jobCounts.map((row) => ({
        status: row.status,
        count: row._count._all,
      })),
      accountingConnections: connectionCount,
    }),
  );
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Data audit failed.",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
