import prisma from "../db.server";
import { requireAdmin } from "../utils/rbac.server";
import { normalizedKey, supplierItemKey } from "../utils/invoiceRules";
import { requireSubscription } from "./billing.server";

export function inferPackSize(
  billedQuantity: number,
  receivedStockQuantity: number,
) {
  if (
    !Number.isFinite(billedQuantity) ||
    billedQuantity <= 0 ||
    !Number.isFinite(receivedStockQuantity) ||
    receivedStockQuantity <= 0
  )
    return null;
  const factor = receivedStockQuantity / billedQuantity;
  return Number.isFinite(factor) && factor > 0
    ? Math.round((factor + Number.EPSILON) * 10000) / 10000
    : null;
}

export async function inferInvoiceLinePackSize(
  shop: string,
  invoiceId: string,
  invoiceItemId: string,
) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, shop },
    include: {
      items: true,
      purchaseOrder: { include: { items: true } },
    },
  });
  const item = invoice?.items.find((candidate) => candidate.id === invoiceItemId);
  if (!invoice?.purchaseOrder || !item) return null;
  const poItem = invoice.purchaseOrder.items.find(
    (candidate) =>
      (item.sku && candidate.sku === item.sku) ||
      (!item.sku && normalizedKey(candidate.name) === normalizedKey(item.name)),
  );
  if (!poItem) return null;
  return inferPackSize(item.quantity, poItem.receivedQty);
}

export async function saveUomMapping(
  request: Request,
  input: {
    supplierId: string;
    itemKey: string;
    supplierUoM: string;
    stockUoM: string;
    conversionFactor: number;
    confidence?: "MANUAL" | "INFERRED";
  },
) {
  const { session } = await requireAdmin(request);
  await requireSubscription(request);
  const supplier = await prisma.vendor.findFirst({
    where: { id: input.supplierId, shop: session.shop },
  });
  if (!supplier) throw new Error("Supplier not found.");
  if (!input.itemKey.trim()) throw new Error("Enter a SKU or item key.");
  if (!input.supplierUoM.trim() || !input.stockUoM.trim())
    throw new Error("Enter both the supplier and stock units.");
  if (!Number.isFinite(input.conversionFactor) || input.conversionFactor <= 0)
    throw new Error("Enter a positive UoM conversion factor.");
  const normalizedItemKey = normalizedKey(input.itemKey);
  const itemKey = /^(?:sku|name):/.test(normalizedItemKey)
    ? normalizedItemKey
    : `sku:${normalizedItemKey}`;
  return prisma.uoMMapping.upsert({
    where: {
      shop_supplierId_itemKey_supplierUoM_stockUoM: {
        shop: session.shop,
        supplierId: supplier.id,
        itemKey,
        supplierUoM: normalizedKey(input.supplierUoM),
        stockUoM: normalizedKey(input.stockUoM),
      },
    },
    update: {
      conversionFactor: input.conversionFactor,
      confidence: input.confidence || "MANUAL",
      lastUsed: new Date(),
      frequency: { increment: 1 },
    },
    create: {
      shop: session.shop,
      supplierId: supplier.id,
      itemKey,
      supplierUoM: normalizedKey(input.supplierUoM),
      stockUoM: normalizedKey(input.stockUoM),
      conversionFactor: input.conversionFactor,
      confidence: input.confidence || "MANUAL",
    },
  });
}

export async function deleteUomMapping(request: Request, id: string) {
  const { session } = await requireAdmin(request);
  await requireSubscription(request);
  const deleted = await prisma.uoMMapping.deleteMany({
    where: { id, shop: session.shop },
  });
  if (!deleted.count) throw new Error("UoM mapping not found.");
}

export async function rememberInvoiceUomMappings(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  input: {
    shop: string;
    supplierId: string;
    items: {
      sku: string | null;
      name: string;
      supplierUoM: string | null;
      packSize: number | null;
    }[];
  },
) {
  for (const item of input.items) {
    if (!item.supplierUoM || !item.packSize) continue;
    await tx.uoMMapping.upsert({
      where: {
        shop_supplierId_itemKey_supplierUoM_stockUoM: {
          shop: input.shop,
          supplierId: input.supplierId,
          itemKey: supplierItemKey(item),
          supplierUoM: item.supplierUoM,
          stockUoM: "unit",
        },
      },
      update: {
        conversionFactor: item.packSize,
        confidence: "MANUAL",
        lastUsed: new Date(),
        frequency: { increment: 1 },
      },
      create: {
        shop: input.shop,
        supplierId: input.supplierId,
        itemKey: supplierItemKey(item),
        supplierUoM: item.supplierUoM,
        stockUoM: "unit",
        conversionFactor: item.packSize,
        confidence: "MANUAL",
      },
    });
  }
}
