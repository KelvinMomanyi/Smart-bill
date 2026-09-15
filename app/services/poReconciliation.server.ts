import prisma from "../db.server";
import type { Prisma } from "@prisma/client";
import { invoiceIssues } from "../utils/invoiceRules";
import { matchPoLine, receiptStatus } from "../utils/poMatching";
export { matchPoLine } from "../utils/poMatching";
export async function reconcileInvoiceWithPO(
  invoiceId: string,
  purchaseOrderId: string,
) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice || invoice.purchaseOrderId !== purchaseOrderId)
    throw new Error(
      "Save this purchase order on the invoice before reconciling.",
    );
  return refreshPurchaseOrder(invoice.shop, purchaseOrderId);
}
export async function refreshPurchaseOrder(
  shop: string,
  purchaseOrderId: string,
) {
  return prisma.$transaction((tx) =>
    refreshPurchaseOrderInTransaction(tx, shop, purchaseOrderId),
  );
}

export async function refreshPurchaseOrderInTransaction(
  tx: Prisma.TransactionClient,
  shop: string,
  purchaseOrderId: string,
) {
  await tx.$queryRaw`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${purchaseOrderId} AND "shop" = ${shop} FOR UPDATE`;
  const po = await tx.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, shop },
    include: { items: true, linkedInvoices: { include: { items: true } } },
  });
  if (!po) throw new Error("Purchase order not found.");
  const billed = new Map<string, number>();
  const discrepancies: string[] = [];
  for (const bill of po.linkedInvoices) {
    if (bill.currency !== po.currency)
      discrepancies.push(
        `Invoice ${bill.invoiceNumber || bill.id} currency differs from PO currency ${po.currency}.`,
      );
    for (const item of bill.items) {
      const matched = matchPoLine(item, po.items);
      if (!matched) {
        discrepancies.push(`Unmatched or ambiguous item: ${item.name}.`);
        continue;
      }
      billed.set(matched.id, (billed.get(matched.id) || 0) + item.quantity);
      const row = po.items.find((i) => i.id === matched.id)!;
      if (
        row.expectedRate != null &&
        Math.abs(row.expectedRate - item.price) > 0.011
      )
        discrepancies.push(
          `Price mismatch for ${row.name}: ordered ${row.expectedRate}, billed ${item.price}.`,
        );
    }
  }
  for (const row of po.items) {
    const quantity = billed.get(row.id) || 0;
    if (row.receivedQty > row.expectedQty + 0.00001)
      discrepancies.push(
        `${row.name}: physically received ${row.receivedQty}, above the ordered quantity ${row.expectedQty}.`,
      );
    if (quantity > row.expectedQty + 0.00001)
      discrepancies.push(
        `Billed quantity exceeds ordered quantity for ${row.name}.`,
      );
    if (quantity > row.receivedQty + 0.00001)
      discrepancies.push(
        `${row.name}: billed ${quantity}, physically received ${row.receivedQty}.`,
      );
    await tx.purchaseOrderItem.update({
      where: { id: row.id },
      data: { billedQty: quantity },
    });
  }
  const status = discrepancies.length ? "MISMATCH" : receiptStatus(po.items);
  await tx.purchaseOrder.update({ where: { id: po.id }, data: { status } });
  for (const bill of po.linkedInvoices) {
    const issues = [...invoiceIssues(bill), ...discrepancies];
    await tx.invoice.update({
      where: { id: bill.id },
      data: {
        discrepancySummary: issues.join("\n") || null,
        ...(bill.reviewStatus !== "APPROVED"
          ? {
              reviewStatus: issues.length
                ? "NEEDS_ATTENTION"
                : "PENDING_REVIEW",
            }
          : {}),
      },
    });
  }
  return { success: true, status, discrepancies };
}
