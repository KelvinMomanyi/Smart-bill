import prisma from "../db.server";
import { deleteInvoiceDocument } from "../utils/upload.server";
export async function eraseShopData(shop: string) {
  await prisma.invoiceJob.updateMany({
    where: { shop },
    data: { status: "CANCELLED", leaseToken: null, lockedAt: null },
  });
  const [invoices, jobs] = await Promise.all([
    prisma.invoice.findMany({ where: { shop }, select: { storageKey: true } }),
    prisma.invoiceJob.findMany({
      where: { shop },
      select: { storageKey: true },
    }),
  ]);
  const keys = [
    ...new Set(
      [...invoices, ...jobs]
        .map((i) => i.storageKey)
        .filter((s): s is string => Boolean(s?.startsWith("gs://"))),
    ),
  ];
  for (const key of keys) await deleteInvoiceDocument(key);
  await prisma.$transaction([
    prisma.invoiceJob.deleteMany({ where: { shop } }),
    prisma.accountingExport.deleteMany({ where: { shop } }),
    prisma.costChange.deleteMany({ where: { shop } }),
    prisma.auditEvent.deleteMany({ where: { shop } }),
    prisma.supplierMapping.deleteMany({ where: { shop } }),
    prisma.invoice.deleteMany({ where: { shop } }),
    prisma.goodsReceipt.deleteMany({ where: { shop } }),
    prisma.purchaseOrder.deleteMany({ where: { shop } }),
    prisma.vendor.deleteMany({ where: { shop } }),
    prisma.accountingConnection.deleteMany({ where: { shop } }),
    prisma.monthlyUsage.deleteMany({ where: { shop } }),
    prisma.shopSettings.deleteMany({ where: { shop } }),
    prisma.session.deleteMany({ where: { shop } }),
  ]);
}
