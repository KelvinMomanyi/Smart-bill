import { Prisma } from "@prisma/client";
export async function lockInvoice(
  tx: Prisma.TransactionClient,
  shop: string,
  id: string,
) {
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "Invoice" WHERE id = ${id} AND shop = ${shop} FOR UPDATE`,
  );
  const invoice = await tx.invoice.findFirst({
    where: { id, shop },
    include: { items: true, vendor: true, exports: true, costChanges: true },
  });
  if (!invoice) throw new Error("Invoice not found.");
  return invoice;
}
