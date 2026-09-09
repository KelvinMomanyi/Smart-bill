import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { requireAdmin } from "../utils/rbac.server";
import { csvRows } from "../utils/csv";
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await requireAdmin(request);
  const id = new URL(request.url).searchParams.get("invoiceId");
  const invoices = await prisma.invoice.findMany({
    where: {
      shop: session.shop,
      reviewStatus: "APPROVED",
      approvedAt: { not: null },
      ...(id ? { id } : {}),
    },
    include: { items: true, vendor: true, purchaseOrder: true },
    orderBy: { date: "asc" },
  });
  if (id && !invoices.length)
    throw new Response("Approved invoice not found", { status: 404 });
  const headers = [
    "InvoiceID",
    "InvoiceNumber",
    "Vendor",
    "PO",
    "Date",
    "DueDate",
    "Currency",
    "InvoiceSubtotal",
    "InvoiceTax",
    "InvoiceTotal",
    "SKU",
    "Description",
    "Quantity",
    "NetUnitPrice",
    "NetLineAmount",
  ];
  const rows = invoices.flatMap((invoice) =>
    invoice.items.map((item, index) => [
      invoice.id,
      invoice.invoiceNumber,
      invoice.vendor?.name,
      invoice.purchaseOrder?.poNumber,
      invoice.date.toISOString().slice(0, 10),
      invoice.dueDate?.toISOString().slice(0, 10),
      invoice.currency,
      index === 0 ? invoice.subtotal : "",
      index === 0 ? invoice.tax : "",
      index === 0 ? invoice.total : "",
      item.sku,
      item.name,
      item.quantity,
      item.price,
      item.amount,
    ]),
  );
  return new Response(csvRows(headers, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="approved-invoices.csv"',
      "Cache-Control": "private, no-store",
    },
  });
}
