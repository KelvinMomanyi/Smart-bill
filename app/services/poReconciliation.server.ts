import prisma from "../db.server";
import type { Invoice, InvoiceItem } from "@prisma/client";

type InvoiceWithItems = Invoice & { items: InvoiceItem[] };

function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenScore(left: string, right: string) {
  const leftTokens = new Set(normalized(left).split(/\s+/).filter(Boolean));
  const rightTokens = new Set(normalized(right).split(/\s+/).filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function namesMatch(left: string, right: string) {
  const a = normalized(left);
  const b = normalized(right);
  return a.includes(b) || b.includes(a) || tokenScore(a, b) >= 0.5;
}

function itemsMatch(
  invoiceItem: InvoiceItem,
  poItem: { name: string; sku?: string | null },
) {
  if (invoiceItem.sku && poItem.sku) {
    return normalized(invoiceItem.sku) === normalized(poItem.sku);
  }

  return namesMatch(invoiceItem.name, poItem.name);
}

function moneyChanged(expected?: number | null, actual?: number | null) {
  if (expected == null || actual == null) return false;
  return Math.abs(expected - actual) > 0.01;
}

export async function reconcileInvoiceWithPO(invoiceId: string, purchaseOrderId: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { items: true },
  });

  if (!invoice) throw new Error("Invoice not found");

  const po = await prisma.purchaseOrder.findUnique({
    where: { id: purchaseOrderId },
    include: {
      items: true,
      linkedInvoices: { include: { items: true } },
    },
  });

  if (!po) throw new Error("Purchase order not found");
  if (invoice.shop !== po.shop) throw new Error("Invoice and purchase order belong to different shops");

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { purchaseOrderId },
  });

  const allLinkedInvoices: InvoiceWithItems[] = po.linkedInvoices.some((linked) => linked.id === invoice.id)
    ? po.linkedInvoices
    : [...po.linkedInvoices, invoice];

  const discrepancies: string[] = [];
  let totalExpectedItems = 0;
  let totalReceivedItems = 0;

  for (const poItem of po.items) {
    totalExpectedItems += poItem.expectedQty;

    const matchingInvoiceItems = allLinkedInvoices.flatMap((linkedInvoice) =>
      linkedInvoice.items.filter((invoiceItem) => itemsMatch(invoiceItem, poItem)),
    );

    const receivedQty = matchingInvoiceItems.reduce((sum, item) => sum + item.quantity, 0);
    totalReceivedItems += receivedQty;

    await prisma.purchaseOrderItem.update({
      where: { id: poItem.id },
      data: { receivedQty },
    });

    if (receivedQty > poItem.expectedQty) {
      discrepancies.push(
        `Quantity overage for ${poItem.name}: expected ${poItem.expectedQty}, received ${receivedQty}`,
      );
    }

    for (const item of matchingInvoiceItems) {
      if (moneyChanged(poItem.expectedRate, item.price)) {
        discrepancies.push(
          `Price mismatch for ${poItem.name}: expected ${poItem.expectedRate?.toFixed(2)}, got ${item.price.toFixed(2)}`,
        );
      }
    }
  }

  for (const linkedInvoice of allLinkedInvoices) {
    for (const invoiceItem of linkedInvoice.items) {
      const matched = po.items.some((poItem) => itemsMatch(invoiceItem, poItem));
      if (!matched) {
        discrepancies.push(`Unexpected item on invoice ${linkedInvoice.invoiceNumber || linkedInvoice.id}: ${invoiceItem.name}`);
      }
    }
  }

  let newStatus = "OPEN";
  if (discrepancies.length > 0) {
    newStatus = "MISMATCH";
  } else if (totalReceivedItems > 0 && totalReceivedItems < totalExpectedItems) {
    newStatus = "PARTIAL";
  } else if (totalExpectedItems > 0 && totalReceivedItems >= totalExpectedItems) {
    newStatus = "FULFILLED";
  }

  await prisma.purchaseOrder.update({
    where: { id: purchaseOrderId },
    data: { status: newStatus },
  });

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      reviewStatus: discrepancies.length > 0 ? "NEEDS_ATTENTION" : "PENDING_REVIEW",
      discrepancySummary: discrepancies.join("\n") || null,
    },
  });

  return {
    success: true,
    status: newStatus,
    discrepancies,
  };
}
