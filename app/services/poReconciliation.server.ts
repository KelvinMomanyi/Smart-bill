import prisma from "../db.server";
import { normalizedKey } from "../utils/invoiceRules";
export type MatchLine = { sku?: string | null; name: string; quantity: number; price: number };
export function matchPoLine(item: MatchLine, lines: { id: string; sku?: string | null; name: string }[]) {
  const matches = lines.filter(line => item.sku && line.sku
    ? normalizedKey(item.sku) === normalizedKey(line.sku)
    : normalizedKey(item.name) === normalizedKey(line.name));
  return matches.length === 1 ? matches[0] : null;
}
export async function reconcileInvoiceWithPO(invoiceId: string, purchaseOrderId: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { items: true } });
  if (!invoice) throw new Error("Invoice not found.");
  const po = await prisma.purchaseOrder.findFirst({ where: { id: purchaseOrderId, shop: invoice.shop },
    include: { items: true, linkedInvoices: { include: { items: true } } } });
  if (!po) throw new Error("Purchase order not found.");
  const linked = po.linkedInvoices.some(i => i.id === invoice.id) ? po.linkedInvoices : [...po.linkedInvoices, invoice];
  const billed = new Map<string, number>();
  const discrepancies: string[] = [];
  for (const bill of linked) {
    if (bill.currency !== po.currency) discrepancies.push(`Invoice ${bill.invoiceNumber || bill.id} currency differs from PO currency ${po.currency}.`);
    for (const item of bill.items) {
      const matched = matchPoLine(item, po.items);
      if (!matched) { discrepancies.push(`Unmatched or ambiguous item: ${item.name}.`); continue; }
      billed.set(matched.id, (billed.get(matched.id) || 0) + item.quantity);
      const row = po.items.find(i => i.id === matched.id)!;
      if (row.expectedRate != null && Math.abs(row.expectedRate - item.price) > 0.011) discrepancies.push(`Price mismatch for ${row.name}: ordered ${row.expectedRate}, billed ${item.price}.`);
    }
  }
  for (const row of po.items) {
    const quantity = billed.get(row.id) || 0;
    if (quantity > row.expectedQty + 0.00001) discrepancies.push(`Billed quantity exceeds ordered quantity for ${row.name}.`);
    if (quantity > row.receivedQty + 0.00001) discrepancies.push(`${row.name}: billed ${quantity}, physically received ${row.receivedQty}.`);
  }
  const complete = po.items.length > 0 && po.items.every(i => i.receivedQty >= i.expectedQty);
  const status = discrepancies.length ? "MISMATCH" : complete ? "FULFILLED" : po.items.some(i => i.receivedQty > 0) ? "PARTIAL" : "OPEN";
  await prisma.$transaction([
    ...po.items.map(row => prisma.purchaseOrderItem.update({ where: { id: row.id }, data: { billedQty: billed.get(row.id) || 0 } })),
    prisma.purchaseOrder.update({ where: { id: po.id }, data: { status } }),
    prisma.invoice.update({ where: { id: invoice.id }, data: { purchaseOrderId: po.id, discrepancySummary: discrepancies.join("\n") || null } }),
  ]);
  return { success: true, status, discrepancies };
}
