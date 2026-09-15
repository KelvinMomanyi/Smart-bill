import prisma from "../db.server";
import { requireAdmin } from "../utils/rbac.server";
import { normalizedKey } from "../utils/invoiceRules";
import { invoiceDeletionBlockedReason } from "../utils/invoiceDeletion";
import { deleteInvoiceDocument } from "../utils/upload.server";
import { lockInvoice } from "./invoiceLock.server";
import { refreshPurchaseOrderInTransaction } from "./poReconciliation.server";

export async function deleteCapturedInvoiceForShop(
  input: { shop: string; invoiceId: string },
  deleteDocument: (key: string) => Promise<void> = deleteInvoiceDocument,
) {
  if (!input.invoiceId) throw new Error("Choose an invoice to delete.");

  const claim = await prisma.$transaction(async (tx) => {
    const invoice = await lockInvoice(tx, input.shop, input.invoiceId, {
      allowDeleting: true,
    });
    const blocked = invoiceDeletionBlockedReason(invoice);
    if (blocked) throw new Error(blocked);
    if (invoice.status === "DELETING")
      return {
        newlyClaimed: false,
        revision: invoice.revision,
        originalStatus: invoice.status,
        originalReviewStatus: invoice.reviewStatus,
        invoice,
      };
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: "DELETING",
        reviewStatus: "DELETE_PENDING",
        revision: { increment: 1 },
      },
    });
    return {
      newlyClaimed: true,
      revision: invoice.revision + 1,
      originalStatus: invoice.status,
      originalReviewStatus: invoice.reviewStatus,
      invoice,
    };
  });

  if (claim.invoice.storageKey?.startsWith("supabase://")) {
    try {
      await deleteDocument(claim.invoice.storageKey);
    } catch (error) {
      if (claim.newlyClaimed)
        await prisma.invoice.updateMany({
          where: {
            id: claim.invoice.id,
            shop: input.shop,
            status: "DELETING",
            revision: claim.revision,
          },
          data: {
            status: claim.originalStatus,
            reviewStatus: claim.originalReviewStatus,
            revision: claim.invoice.revision,
          },
        });
      throw error;
    }
  }

  await prisma.$transaction(async (tx) => {
    if (claim.invoice.purchaseOrderId)
      await tx.$queryRaw`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${claim.invoice.purchaseOrderId} AND "shop" = ${input.shop} FOR UPDATE`;
    const invoice = await lockInvoice(tx, input.shop, input.invoiceId, {
      allowDeleting: true,
    });
    if (invoice.status !== "DELETING" || invoice.revision !== claim.revision)
      throw new Error("Invoice deletion changed. Reload before trying again.");

    await tx.auditEvent.deleteMany({
      where: { shop: input.shop, invoiceId: invoice.id },
    });
    await tx.invoiceJob.deleteMany({
      where: {
        shop: input.shop,
        OR: [
          { invoiceId: invoice.id },
          ...(invoice.documentHash
            ? [{ documentHash: invoice.documentHash }]
            : []),
        ],
      },
    });
    await tx.invoice.delete({ where: { id: invoice.id } });

    if (invoice.vendorId) {
      const remainingInvoices = await tx.invoice.count({
        where: { shop: input.shop, vendorId: invoice.vendorId },
      });
      const remainingPurchaseOrders = await tx.purchaseOrder.count({
        where: { shop: input.shop, vendorId: invoice.vendorId },
      });
      if (!remainingInvoices && !remainingPurchaseOrders) {
        if (invoice.vendor?.name)
          await tx.supplierMapping.deleteMany({
            where: {
              shop: input.shop,
              vendorKey: normalizedKey(invoice.vendor.name),
            },
          });
        await tx.vendor.deleteMany({
          where: { id: invoice.vendorId, shop: input.shop },
        });
      }
    }

    if (invoice.purchaseOrderId)
      await refreshPurchaseOrderInTransaction(
        tx,
        input.shop,
        invoice.purchaseOrderId,
      );
  });

  return {
    id: claim.invoice.id,
    invoiceNumber: claim.invoice.invoiceNumber,
  };
}

export async function deleteCapturedInvoice(request: Request, invoiceId: string) {
  const { session } = await requireAdmin(request);
  return deleteCapturedInvoiceForShop({ shop: session.shop, invoiceId });
}
