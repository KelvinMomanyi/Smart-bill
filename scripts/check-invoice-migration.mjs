import { PrismaClient } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";

const prisma = new PrismaClient();
const target = new URL(process.env.DATABASE_URL);
const mode = process.argv[2];
try {
  if (mode === "--backup") {
    const snapshot = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return {
          purchaseOrders:
            await tx.$queryRaw`SELECT "id", "shop", "status" FROM "PurchaseOrder" ORDER BY "id"`,
          purchaseOrderItems:
            await tx.$queryRaw`SELECT "id", "purchaseOrderId", "expectedQty", "receivedQty" FROM "PurchaseOrderItem" ORDER BY "id"`,
          approvals:
            await tx.$queryRaw`SELECT "id", "shop", "reviewStatus" FROM "Invoice" WHERE "reviewStatus" = 'APPROVED' ORDER BY "id"`,
          settings:
            await tx.$queryRaw`SELECT "id", "shop", "requireReview", "autoSyncCogs", "defaultCurrency" FROM "ShopSettings" ORDER BY "id"`,
          counts:
            await tx.$queryRaw`SELECT (SELECT COUNT(*)::int FROM "Invoice") AS invoices, (SELECT COUNT(*)::int FROM "InvoiceItem") AS items`,
        };
      },
      { isolationLevel: "RepeatableRead", timeout: 30000 },
    );
    const folder = new URL("../.local-backups/", import.meta.url);
    await mkdir(folder, { recursive: true });
    const filename = `invoice-controls-before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    await writeFile(
      new URL(filename, folder),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          host: target.hostname,
          database: target.pathname,
          snapshot,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    console.log(
      JSON.stringify({
        backup: `.local-backups/${filename}`,
        counts: snapshot.counts,
        purchaseOrders: snapshot.purchaseOrders.length,
        purchaseOrderItems: snapshot.purchaseOrderItems.length,
        approvals: snapshot.approvals.length,
        settings: snapshot.settings.length,
      }),
    );
  } else if (mode === "--verify") {
    const checks = await Promise.all([
      prisma.invoice.findMany({
        take: 1,
        include: { items: true, exports: true, costChanges: true },
      }),
      prisma.invoiceJob.count(),
      prisma.monthlyUsage.count(),
      prisma.supplierMapping.count(),
      prisma.goodsReceipt.count(),
      prisma.auditEvent.count(),
      prisma.shopSettings.findMany({ take: 1 }),
      prisma.purchaseOrder.findMany({
        take: 1,
        include: { items: true, receipts: true },
      }),
    ]);
    console.log(
      JSON.stringify({
        schemaChecksPassed: checks.length,
        invoiceQueryPassed: true,
        invoiceCount: await prisma.invoice.count(),
        invoiceItemCount: await prisma.invoiceItem.count(),
      }),
    );
  } else
    throw new Error(
      "Use --backup before migration or --verify after migration.",
    );
} finally {
  await prisma.$disconnect();
}
