import { PrismaClient } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
const db = new PrismaClient();
const mode = process.argv[2] || "--status";
try {
  const counts = await db.$queryRaw`SELECT
    (SELECT COUNT(*)::int FROM "Invoice") AS invoices,
    (SELECT COUNT(*)::int FROM "InvoiceItem") AS items,
    (SELECT COUNT(*)::int FROM "AccountingConnection") AS connections,
    (SELECT COUNT(*)::int FROM "AccountingExport") AS exports`;
  const connections = await db.$queryRaw`SELECT platform, "expiresAt",
    ("tenantId" IS NOT NULL) AS "hasXeroCompany",
    ("realmId" IS NOT NULL) AS "hasQuickBooksCompany" FROM "AccountingConnection"`;
  const migrations =
    await db.$queryRaw`SELECT migration_name, finished_at IS NOT NULL AS applied
    FROM "_prisma_migrations" WHERE migration_name = '20260910100000_complete_accounting_integrations'`;
  console.log(JSON.stringify({ counts, connections, migration: migrations }));
  if (mode === "--before") {
    await mkdir(".local-backups", { recursive: true });
    const file = `.local-backups/accounting-before-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    // The migration only adds columns and a new table. Preserve pre-change row
    // counts and schema metadata without copying accounting credentials.
    const columns = await db.$queryRaw`SELECT table_name, column_name, data_type
      FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name IN ('Invoice', 'AccountingConnection', 'AccountingExport', 'ShopSettings')
      ORDER BY table_name, ordinal_position`;
    await writeFile(file, JSON.stringify({ counts, columns }, null, 2), {
      flag: "wx",
    });
    console.log("Pre-migration snapshot: " + file);
  }
  if (mode === "--verify") {
    await db.invoice.findFirst({ select: { accountingMapping: true } });
    await db.shopSettings.findFirst({
      select: { quickBooksTaxAccountId: true },
    });
    await db.accountingConnection.findFirst({
      select: {
        environment: true,
        companyName: true,
        country: true,
        homeCurrency: true,
        xeroConnectionId: true,
      },
    });
    await db.accountingExport.findFirst({
      select: {
        companyKey: true,
        attachmentStatus: true,
        attachmentId: true,
        attachmentError: true,
      },
    });
    await db.accountingAuthorization.count();
    console.log("All five accounting schema checks passed.");
  }
} catch (error) {
  console.error(
    "Accounting database check failed: " + (error.code || error.name),
  );
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
