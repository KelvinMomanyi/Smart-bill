import prisma from "../db.server";
import { requireAdmin } from "../utils/rbac.server";
import { requireSubscription } from "./billing.server";
import {
  assertApproved,
  assertCurrencyMatch,
  normalizedKey,
  supplierItemKey,
} from "../utils/invoiceRules";
import { fetchShopCurrency } from "./invoiceWorkflow.server";
import { variantsByIds, type Variant } from "./invoiceReview.server";
import {
  allocateCharges,
  allocationSummary,
  isChargeLine,
  isLandedCostMethod,
  lineValue,
  type LandedCostLine,
} from "../utils/landedCost";
import { resolveUnitCost, resolvePackSize } from "../utils/unitCost";
import { resolveFxRate, fxSummary } from "../utils/exchangeRate";
import { creditByLine, liveCreditsForInvoice, markCreditsApplied } from "./creditNotes.server";
import { lockInvoice } from "./invoiceLock.server";
import type { authenticate } from "../shopify.server";
import {
  recordFreightAllocations,
  syncFreightLines,
} from "./freightAllocation.server";
import { notifySafely } from "./notifications.server";

type Admin = Awaited<ReturnType<typeof authenticate.admin>>["admin"];
async function writeCost(admin: Admin, inventoryItemId: string, cost: number) {
  const response = await admin.graphql(
    `#graphql
    mutation SmartBillCost($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id } userErrors { message } }
    }`,
    { variables: { id: inventoryItemId, input: { cost } } },
  );
  const body = await response.json();
  if (
    ("errors" in body && body.errors) ||
    !body.data?.inventoryItemUpdate?.inventoryItem ||
    body.data.inventoryItemUpdate.userErrors.length
  )
    throw new Error(
      "Shopify did not confirm the cost update. Refresh the preview and verify the current cost before retrying.",
    );
}

async function writeCostMetadata(
  admin: Admin,
  change: {
    variantId: string;
    newCost: number;
    allocation: unknown;
    fxRate: number | null;
    fxSource: string | null;
    packSize: number | null;
    creditApplied: number | null;
    createdAt: Date;
  },
) {
  const allocation = change.allocation as
    | { method?: string; allocatedToLine?: number }
    | null;
  const values = [
    ["landed_cost_per_unit", "number_decimal", change.newCost],
    ["landed_cost_method", "single_line_text_field", allocation?.method || "NONE"],
    ["freight_allocated_total", "number_decimal", allocation?.allocatedToLine || 0],
    ["allocation_date", "date_time", change.createdAt.toISOString()],
    ["fx_rate", "number_decimal", change.fxRate || 1],
    ["fx_source", "single_line_text_field", change.fxSource || "SHOP_CURRENCY"],
    ["pack_size", "number_decimal", change.packSize || 1],
    ["credit_allocated_total", "number_decimal", change.creditApplied || 0],
  ] as const;
  const response = await admin.graphql(
    `#graphql
    mutation SmartBillCostMetadata($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id key }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        metafields: values.map(([key, type, value]) => ({
          ownerId: change.variantId,
          namespace: "smartbill",
          key,
          type,
          value: String(value),
        })),
      },
    },
  );
  const body = await response.json();
  if (
    ("errors" in body && body.errors) ||
    body.data?.metafieldsSet?.userErrors?.length
  )
    throw new Error(
      "Shopify updated the cost but did not confirm its SmartBill audit metafields. Use recovery to retry the metadata write.",
    );
}
type LandedCostInvoiceItem = {
  id: string;
  name: string;
  category: string;
  quantity: number;
  price: number;
  amount: number | null;
  manualCharge: number | null;
  shopifyVariantId: string | null;
  supplierUoM: string | null;
  packSize: number | null;
};

const WEIGHT_TO_GRAMS: Record<string, number> = {
  GRAMS: 1,
  KILOGRAMS: 1000,
  OUNCES: 28.349523125,
  POUNDS: 453.59237,
};

function weightOf(
  variants: Variant[],
  variantId: string | null,
  quantity: number,
) {
  if (!variantId) return null;
  const weight = variants.find((v) => v.id === variantId)?.inventoryItem
    .measurement?.weight;
  const value = Number(weight?.value);
  const factor = weight?.unit ? WEIGHT_TO_GRAMS[weight.unit] : undefined;
  return Number.isFinite(value) && value > 0 && factor && quantity > 0
    ? value * factor * quantity
    : null;
}

// Freight, duty, handling and insurance lines are spread across the product
// lines so the Shopify cost reflects the landed cost, not just the invoice rate.
function landedCostFor(
  invoice: { landedCostMethod: string },
  productLines: LandedCostInvoiceItem[],
  chargeLines: LandedCostInvoiceItem[],
  variants: Variant[],
) {
  const method = isLandedCostMethod(invoice.landedCostMethod)
    ? invoice.landedCostMethod
    : "NONE";
  const chargeTotal = chargeLines.reduce((sum, item) => sum + lineValue(item), 0);
  if (!chargeLines.length || chargeTotal <= 0)
    return {
      method,
      chargeTotal: 0,
      result: null,
      byLine: new Map<string, number>(),
    };
  if (method === "NONE")
    throw new Error(
      "Choose how to allocate the freight and charge lines in the landed cost section before previewing or syncing costs.",
    );
  const lines: LandedCostLine[] = productLines.map((item) => ({
    id: item.id,
    name: item.name,
    quantity: item.quantity,
    price: item.price,
    amount: item.amount,
    category: item.category,
    weight:
      method === "WEIGHT"
        ? weightOf(variants, item.shopifyVariantId, item.quantity)
        : null,
  }));
  const result = allocateCharges(
    lines,
    chargeTotal,
    method,
    Object.fromEntries(productLines.map((item) => [item.id, item.manualCharge])),
  );
  return {
    method: result.method,
    chargeTotal,
    result,
    byLine: new Map(
      result.allocations.map((entry) => [entry.lineId, entry.amount]),
    ),
  };
}

export async function prepareCostSync(request: Request, invoiceId: string) {
  const { session, admin, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, shop: session.shop },
    include: { items: true, vendor: true },
  });
  if (!invoice) throw new Error("Invoice not found.");
  assertApproved(invoice);
  if (
    invoice.cogsSyncStatus === "SYNCED" &&
    !(await prisma.costChange.count({
      where: { invoiceId, shop: session.shop },
    }))
  )
    throw new Error(
      "This invoice was synced by an older version. Verify its costs directly in Shopify; repeating that sync is blocked.",
    );
  // Shopify inventory costs are always written in the shop currency, so a
  // foreign invoice needs a reviewed rate before anything is calculated.
  const currency = await fetchShopCurrency(admin);
  const fx = resolveFxRate(invoice.currency, currency, invoice.fxRate);
  if (fx.problem) throw new Error(fx.problem);
  const items = invoice.items.filter((i) => i.syncCost && !isChargeLine(i));
  if (!items.length)
    throw new Error("Select at least one product line for cost sync.");
  const productLines = invoice.items.filter((item) => !isChargeLine(item));
  const chargeLines = invoice.items.filter((item) => isChargeLine(item));
  if (items.some((i) => !i.matchConfirmed || !i.shopifyVariantId))
    throw new Error(
      "Confirm a Shopify variant for every line selected for cost sync.",
    );
  if (new Set(items.map((i) => i.shopifyVariantId)).size !== items.length)
    throw new Error(
      "Multiple lines target the same variant. Select one net unit cost per variant.",
    );
  // Pack sizes are remembered per supplier item, so a line billed in cases
  // converts to the stock unit before the cost is written.
  const itemKeys = [...new Set(items.map((item) => supplierItemKey(item)))];
  const [mappings, uomMappings] = invoice.vendor
    ? await Promise.all([
        prisma.supplierMapping.findMany({
          where: {
            shop: session.shop,
            vendorKey: normalizedKey(invoice.vendor.name),
            itemKey: { in: itemKeys },
          },
        }),
        prisma.uoMMapping.findMany({
          where: {
            shop: session.shop,
            supplierId: invoice.vendor.id,
            itemKey: { in: itemKeys },
          },
        }),
      ])
    : [[], []];
  const packSizeFor = (item: (typeof items)[number]) => {
    const mapping = mappings.find((m) => m.itemKey === supplierItemKey(item));
    const uomMapping = uomMappings.find(
      (candidate) =>
        candidate.itemKey === supplierItemKey(item) &&
        candidate.supplierUoM === item.supplierUoM,
    );
    try {
      return resolvePackSize(
        item,
        uomMapping?.conversionFactor ??
          (item.supplierUoM && item.supplierUoM === mapping?.supplierUoM
            ? mapping.packSize
            : null),
      );
    } catch (error) {
      throw new Error(
        `${item.name}: ${error instanceof Error ? error.message : "Set the pack size before syncing."}`,
      );
    }
  };
  const credits = await liveCreditsForInvoice(session.shop, invoiceId);
  const creditInfo = creditByLine(credits, invoice.items);
  const variants = await variantsByIds(
    admin,
    items.map((i) => i.shopifyVariantId!),
  );
  const landed = landedCostFor(invoice, productLines, chargeLines, variants);
  const selected = new Set(items.map((item) => item.id));
  const skippedAllocation = productLines.some(
    (line) => !selected.has(line.id) && (landed.byLine.get(line.id) ?? 0) > 0,
  );
  const allocationNote = landed.result
    ? {
        method: landed.method,
        totalCharge: landed.chargeTotal,
        summary: allocationSummary(landed.result),
        warnings: [
          ...landed.result.warnings,
          ...(skippedAllocation
            ? [
                "Freight allocated to product lines that are not selected for cost sync is not written to Shopify.",
              ]
            : []),
          ...creditInfo.warnings,
        ],
        allocationDate: new Date().toISOString(),
      }
    : creditInfo.warnings.length
      ? { method: "NONE", totalCharge: 0, warnings: creditInfo.warnings }
      : null;
  const fxNote = fx.required
    ? fxSummary(invoice.currency, currency, fx.rate, invoice.fxRateDate ? invoice.fxRateDate.toISOString().slice(0, 10) : null)
    : null;
  const plannedChanges = items.map((item) => {
    const variant = variants.find((v) => v.id === item.shopifyVariantId)!;
    if (variant.inventoryItem.unitCost)
      assertCurrencyMatch(
        variant.inventoryItem.unitCost.currencyCode,
        currency,
      );
    const allocated = landed.byLine.get(item.id) ?? 0;
    const packSize = packSizeFor(item);
    const creditApplied = creditInfo.byLine[item.id] ?? 0;
    const breakdown = resolveUnitCost({
      line: {
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        amount: item.amount,
        category: item.category,
      },
      allocatedCharge: allocated,
      creditAmount: creditApplied,
      fxRate: fx.rate,
      stockUnitsPerBilledUnit: packSize,
    });
    return {
      shop: session.shop,
      invoiceId,
      invoiceItemId: item.id,
      inventoryItemId: variant.inventoryItem.id,
      variantId: variant.id,
      previousCost: variant.inventoryItem.unitCost
        ? Number(variant.inventoryItem.unitCost.amount)
        : null,
      newCost: breakdown.costPerStockUnit,
      landedCostPerUnit: breakdown.costPerStockUnit,
      allocation: allocationNote
        ? { ...allocationNote, allocatedToLine: allocated }
        : undefined,
      shopCurrency: currency,
      fxRate: fx.rate,
      fxSource: fx.required ? invoice.fxRateSource || "MANUAL" : "SHOP_CURRENCY",
      packSize,
      creditApplied,
      breakdown: { ...breakdown, fxNote, supplierUoM: item.supplierUoM },
      currency,
      actor,
      status: "PLANNED",
    };
  });
  await prisma.$transaction(async (tx) => {
    const latest = await lockInvoice(tx, session.shop, invoiceId);
    assertApproved(latest);
    if (latest.revision !== invoice.revision)
      throw new Error("Invoice changed; review it again.");
    if (latest.costChanges.some((c) => c.status !== "PLANNED"))
      throw new Error(
        "Cost changes already exist. Check their status in the history.",
      );
    await tx.costChange.deleteMany({ where: { invoiceId, status: "PLANNED" } });
    await tx.costChange.createMany({
      data: plannedChanges,
    });
    for (const change of plannedChanges)
      await tx.invoiceItem.update({
        where: { id: change.invoiceItemId },
        data: {
          convertedQuantity: Number(
            (change.breakdown as { stockQuantity: number }).stockQuantity,
          ),
          costPerStockUnit: change.newCost,
          landedCostPerUnit: change.landedCostPerUnit,
        },
      });
    const freightLines = await syncFreightLines(tx, invoice);
    if (landed.result)
      await recordFreightAllocations(tx, {
        freightLines,
        result: landed.result,
        requestedMethod: landed.method,
        actor,
      });
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        shopCurrency: currency,
        costInShopCurrency: invoice.total * fx.rate,
      },
    });
  });
}
export async function syncApprovedCosts(request: Request, invoiceId: string) {
  const { session, admin, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const currency = await fetchShopCurrency(admin);
  const changes = await prisma.$transaction(async (tx) => {
    const invoice = await lockInvoice(tx, session.shop, invoiceId);
    assertApproved(invoice);
    if (invoice.cogsSyncStatus === "SYNCING")
      throw new Error(
        "A cost sync is already running. Check the history before retrying.",
      );
    const planned = invoice.costChanges.filter((c) => c.status === "PLANNED");
    if (!planned.length) throw new Error("Preview the proposed costs first.");
    // The preview locked in a shop currency and rate; a change since then
    // would silently write a cost in the wrong currency.
    if (planned.some((c) => c.shopCurrency && c.shopCurrency !== currency))
      throw new Error(
        "The Shopify store currency changed after the preview. Preview the proposed costs again.",
      );
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { cogsSyncStatus: "SYNCING" },
    });
    return planned;
  });
  let failures = 0;
  for (const change of changes) {
    try {
      const [variant] = await variantsByIds(admin, [change.variantId]);
      const current = variant.inventoryItem.unitCost
        ? Number(variant.inventoryItem.unitCost.amount)
        : null;
      if (current !== change.previousCost)
        throw new Error(
          "The Shopify cost changed after preview. No overwrite was attempted.",
        );
      await prisma.costChange.update({
        where: { id: change.id },
        data: { status: "APPLYING" },
      });
      await writeCost(admin, change.inventoryItemId, change.newCost);
      await writeCostMetadata(admin, change);
      await prisma.costChange.update({
        where: { id: change.id },
        data: { status: "APPLIED", error: null },
      });
      await prisma.auditEvent.create({
        data: {
          shop: session.shop,
          invoiceId,
          actor,
          action: "COST_UPDATED",
          detail: {
            variantId: change.variantId,
            previousCost: change.previousCost,
            newCost: change.newCost,
            landedCostPerUnit: change.landedCostPerUnit,
            allocation: change.allocation,
            currency,
            fxRate: change.fxRate,
            fxSource: change.fxSource,
            packSize: change.packSize,
            creditApplied: change.creditApplied,
          },
        },
      });
    } catch (error) {
      failures += 1;
      await prisma.costChange.update({
        where: { id: change.id },
        data: {
          status: "VERIFY",
          error:
            error instanceof Error
              ? error.message
              : "Verify the current Shopify cost.",
        },
      });
    }
  }
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { cogsSyncStatus: failures ? "PARTIAL" : "SYNCED" },
  });
  // Credits become APPLIED only once every planned line reached Shopify, so a
  // partial sync never silently banks a credit it did not use.
  if (!failures)
    await prisma.$transaction(async (tx) => {
      await lockInvoice(tx, session.shop, invoiceId);
      await markCreditsApplied(tx, session.shop, invoiceId);
    });
  const notificationInvoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, shop: session.shop },
    include: { vendor: true },
  });
  if (notificationInvoice)
    await notifySafely(
      failures ? "COST_SYNC_FAILURE" : "COST_SYNC_SUCCESS",
      session.shop,
      {
        invoiceId,
        invoiceNumber: notificationInvoice.invoiceNumber,
        supplier: notificationInvoice.vendor?.name,
        amount: notificationInvoice.total,
        currency: notificationInvoice.currency,
        message: failures
          ? `${failures} product cost update${failures === 1 ? "" : "s"} need verification`
          : `${changes.length} Shopify product cost${changes.length === 1 ? "" : "s"} updated`,
      },
    );
  if (failures)
    throw new Error(
      "Some costs need verification. Check each result in the cost history.",
    );
}
export async function restoreCost(request: Request, changeId: string) {
  const { session, admin, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const change = await prisma.costChange.findFirst({
    where: { id: changeId, shop: session.shop },
  });
  if (!change || change.status !== "APPLIED")
    throw new Error("Only confirmed applied costs can be restored.");
  if (change.previousCost == null)
    throw new Error(
      "This variant had no previous cost. Clear its cost manually in Shopify if needed.",
    );
  const [variant] = await variantsByIds(admin, [change.variantId]);
  assertCurrencyMatch(change.currency, await fetchShopCurrency(admin));
  if (Number(variant.inventoryItem.unitCost?.amount) !== change.newCost)
    throw new Error(
      "The cost has changed since this update. Restore was blocked to preserve the newer value.",
    );
  const claim = await prisma.costChange.updateMany({
    where: { id: changeId, status: "APPLIED" },
    data: { status: "RESTORING" },
  });
  if (!claim.count) throw new Error("Another request is restoring this cost.");
  try {
    await writeCost(admin, change.inventoryItemId, change.previousCost);
    await prisma.$transaction([
      prisma.costChange.update({
        where: { id: changeId },
        data: { status: "RESTORED" },
      }),
      prisma.invoice.update({
        where: { id: change.invoiceId },
        data: { cogsSyncStatus: "RESTORED" },
      }),
      prisma.auditEvent.create({
        data: {
          shop: session.shop,
          invoiceId: change.invoiceId,
          actor,
          action: "COST_RESTORED",
          detail: { changeId },
        },
      }),
    ]);
  } catch (error) {
    await prisma.costChange.update({
      where: { id: changeId },
      data: {
        status: "VERIFY_RESTORE",
        error:
          "Restore response was not confirmed. Verify the cost in Shopify.",
      },
    });
    throw error;
  }
}

export async function verifyCost(request: Request, changeId: string) {
  const { session, admin, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const change = await prisma.costChange.findFirst({
    where: { id: changeId, shop: session.shop },
  });
  if (
    !change ||
    !["VERIFY", "VERIFY_RESTORE", "APPLYING", "RESTORING", "PLANNED"].includes(
      change.status,
    )
  )
    throw new Error("This cost does not need recovery.");
  if (
    ["APPLYING", "RESTORING", "PLANNED"].includes(change.status) &&
    Date.now() - change.updatedAt.getTime() < 15 * 60 * 1000
  )
    throw new Error(
      "Allow 15 minutes for an interrupted sync to finish before recovering it.",
    );
  assertCurrencyMatch(change.currency, await fetchShopCurrency(admin));
  const [variant] = await variantsByIds(admin, [change.variantId]);
  const current = variant.inventoryItem.unitCost
    ? Number(variant.inventoryItem.unitCost.amount)
    : null;
  const restoring = ["VERIFY_RESTORE", "RESTORING"].includes(change.status);
  const status =
    current === change.newCost
      ? "APPLIED"
      : current === change.previousCost
        ? restoring
          ? "RESTORED"
          : "PLANNED"
        : null;
  if (!status)
    throw new Error(
      "Shopify now has a different cost. Review that value directly in Shopify; automatic recovery cannot overwrite it.",
    );
  if (status === "APPLIED") await writeCostMetadata(admin, change);
  await prisma.$transaction(async (tx) => {
    await lockInvoice(tx, session.shop, change.invoiceId);
    const updated = await tx.costChange.updateMany({
      where: {
        id: changeId,
        status: change.status,
        updatedAt: change.updatedAt,
      },
      data: { status, error: null },
    });
    if (!updated.count)
      throw new Error("Cost history changed. Reload it before recovery.");
    const changes = await tx.costChange.findMany({
      where: { invoiceId: change.invoiceId },
    });
    await tx.invoice.update({
      where: { id: change.invoiceId },
      data: {
        cogsSyncStatus: changes.every((c) => c.status === "APPLIED")
          ? "SYNCED"
          : changes.every((c) => c.status === "RESTORED")
            ? "RESTORED"
            : "PARTIAL",
      },
    });
    await tx.auditEvent.create({
      data: {
        shop: session.shop,
        invoiceId: change.invoiceId,
        actor,
        action: "COST_VERIFIED",
        detail: { changeId, current, status },
      },
    });
  });
}
