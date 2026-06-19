import prisma from 'app/db.server';
import { authenticate } from '../shopify.server';

function csvCell(value: string | number | null | undefined) {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows: Record<string, string | number | null | undefined>[]) {
  if (rows.length === 0) {
    return "InvoiceID,InvoiceNumber,Vendor,PO,Date,Currency,Total,ReviewStatus,COGSStatus,AccountingStatus,SKU,ItemName,Quantity,ItemPrice,ItemAmount\n";
  }

  const headers = Object.keys(rows[0]);
  const body = rows.map((row) => headers.map((header) => csvCell(row[header])).join(","));

  return [headers.join(","), ...body].join("\n");
}

export const loader = async ({ request }: any) => {
  const { session } = await authenticate.admin(request);
  const invoices = await prisma.invoice.findMany({
    where: { shop: session.shop },
    include: { items: true, vendor: true, purchaseOrder: true },
  });
  const csvData = invoices.flatMap(inv =>
    inv.items.map(item => ({
      InvoiceID: inv.id,
      InvoiceNumber: inv.invoiceNumber,
      Vendor: inv.vendor?.name,
      PO: inv.purchaseOrder?.poNumber,
      Date: inv.date.toISOString(),
      Currency: inv.currency,
      Total: inv.total,
      ReviewStatus: inv.reviewStatus,
      COGSStatus: inv.cogsSyncStatus,
      AccountingStatus: inv.accountingStatus,
      SKU: item.sku,
      ItemName: item.name,
      Quantity: item.quantity,
      ItemPrice: item.price,
      ItemAmount: item.amount
    }))
  );

  const csv = toCsv(csvData);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="invoices.csv"'
    }
  });
};
