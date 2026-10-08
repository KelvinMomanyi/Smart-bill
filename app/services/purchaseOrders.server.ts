import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { roundMoney, validDate } from "../utils/invoiceRules";
import {
  parsePoItems,
  parseStructuredPoItems,
  type ParsedPoItem,
} from "../utils/poItems";
import { readPoFormValues, type PoField } from "../utils/purchaseOrderForm";

export class PurchaseOrderInputError extends Error {
  constructor(
    message: string,
    public field: PoField,
  ) {
    super(message);
  }
}

export function purchaseOrderInput(form: FormData) {
  const values = readPoFormValues(form);
  const vendorName = values.vendorName.trim();
  const poNumber = values.poNumber.trim();
  const expectedDate = values.expectedDate.trim();
  const notes = values.notes.trim();
  const submissionId = String(form.get("submissionId") || "");
  if (
    submissionId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      submissionId,
    )
  )
    throw new PurchaseOrderInputError(
      "Reload the purchase order form and try again.",
      "submissionId",
    );
  if (!vendorName)
    throw new PurchaseOrderInputError("Enter a vendor name.", "vendorName");
  if (vendorName.length > 200)
    throw new PurchaseOrderInputError(
      "Vendor name must be 200 characters or fewer.",
      "vendorName",
    );
  if (poNumber.length > 100)
    throw new PurchaseOrderInputError(
      "Purchase order number must be 100 characters or fewer.",
      "poNumber",
    );
  if (notes.length > 2_000)
    throw new PurchaseOrderInputError(
      "Purchase order notes must be 2,000 characters or fewer.",
      "notes",
    );
  if (expectedDate && !validDate(expectedDate))
    throw new PurchaseOrderInputError(
      "Enter a valid expected delivery date.",
      "expectedDate",
    );
  let items: ParsedPoItem[];
  try {
    items = parseStructuredPoItems(
      form.has("itemName")
        ? JSON.stringify(values.items)
        : String(form.get("structuredItems") || ""),
    );
    if (!items.length) items = parsePoItems(values.itemRows);
    if (!items.length)
      throw new Error(
        "Add at least one item with an item name and a positive quantity.",
      );
  } catch (error) {
    throw new PurchaseOrderInputError(
      error instanceof Error
        ? error.message
        : "Check the purchase order items.",
      "items",
    );
  }
  return { vendorName, poNumber, expectedDate, notes, items, submissionId };
}

export async function createPurchaseOrder(
  shop: string,
  input: ReturnType<typeof purchaseOrderInput>,
  database: Pick<typeof prisma, "$transaction"> = prisma,
) {
  const { vendorName, poNumber, expectedDate, notes, items, submissionId } =
    input;
  try {
    return await database.$transaction(async (tx) => {
      if (submissionId) {
        const existing = await tx.purchaseOrder.findFirst({
          where: { id: submissionId, shop },
        });
        if (existing) return existing;
      }
      const vendor = await tx.vendor.upsert({
        where: { shop_name: { shop, name: vendorName } },
        update: {},
        create: { shop, name: vendorName },
      });
      const settings = await tx.shopSettings.upsert({
        where: { shop },
        update: {},
        create: { shop },
      });
      return tx.purchaseOrder.create({
        data: {
          ...(submissionId ? { id: submissionId } : {}),
          shop,
          currency: settings.defaultCurrency,
          vendorId: vendor.id,
          poNumber: poNumber || null,
          expectedDate: expectedDate
            ? new Date(`${expectedDate}T00:00:00.000Z`)
            : null,
          notes: notes || null,
          status: "OPEN",
          totalAmount: roundMoney(
            items.reduce(
              (sum, item) => sum + (item.expectedRate ?? 0) * item.expectedQty,
              0,
            ),
          ),
          items: {
            create: items.map((item) => ({
              sku: item.sku || null,
              shopifyProductId: item.shopifyProductId || null,
              shopifyVariantId: item.shopifyVariantId || null,
              name: item.name,
              expectedQty: item.expectedQty,
              expectedRate: item.expectedRate ?? null,
            })),
          },
        },
      });
    });
  } catch (error) {
    // Concurrent retries race on the primary key. Read only this shop's record
    // after the failed transaction has rolled back.
    if (
      submissionId &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await database.$transaction((tx) =>
        tx.purchaseOrder.findFirst({ where: { id: submissionId, shop } }),
      );
      if (existing) return existing;
    }
    if (
      poNumber &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      (error.meta?.modelName === "PurchaseOrder" ||
        String(error.meta?.target).includes("poNumber"))
    )
      throw new PurchaseOrderInputError(
        "This PO number is already in use. Choose another number or open the existing purchase order below.",
        "poNumber",
      );
    throw error;
  }
}
