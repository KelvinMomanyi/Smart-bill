import prisma from "../db.server";
import { Prisma } from "@prisma/client";
import { requireApprovalAccess } from "../utils/rbac.server";
import { requireSubscription } from "./billing.server";
import { fetchShopCurrency, invoiceIdentity } from "./invoiceWorkflow.server";
import {
  invoiceIssues,
  normalizedKey,
  supplierItemKey,
  validDate,
  validCurrency,
} from "../utils/invoiceRules";
import {
  reconcileInvoiceWithPO,
  refreshPurchaseOrder,
} from "./poReconciliation.server";
import { lockInvoice } from "./invoiceLock.server";
import {
  allocateCharges,
  isChargeCategory,
  isChargeLine,
  isLandedCostMethod,
  landedCostIssues,
  lineValue,
} from "../utils/landedCost";
import { needsPackSize, resolvePackSize } from "../utils/unitCost";
import { resolveFxRate, resolveFxRateDate } from "../utils/exchangeRate";
import { creditByLine } from "./creditNotes.server";
import type { authenticate } from "../shopify.server";
import { syncFreightLines } from "./freightAllocation.server";
import {
  EXCHANGE_RATE_SOURCES,
  recordInvoiceFxSelection,
  type ExchangeRateSource,
} from "./exchangeRate.server";
import { rememberInvoiceUomMappings } from "./uomMapping.server";
import {
  ensureDefaultApprovalRules,
  recordApproval,
} from "./approvalRules.server";

type Admin = Awaited<ReturnType<typeof authenticate.admin>>["admin"];
export async function findVariants(admin: Admin, query: string) {
  const response = await admin.graphql(
    `#graphql
    query SmartBillVariantSearch($query: String!) {
      productVariants(first: 20, query: $query) { nodes {
        id title sku product { title } inventoryItem { id unitCost { amount currencyCode } measurement { weight { value unit } } }
      } }
    }`,
    { variables: { query: query.trim().slice(0, 150) } },
  );
  const body = await response.json();
  if ("errors" in body && body.errors)
    throw new Error("Product search failed.");
  return body.data.productVariants.nodes as Variant[];
}
export type Variant = {
  id: string;
  title: string;
  sku: string;
  product: { title: string };
  inventoryItem: {
    id: string;
    unitCost: { amount: string; currencyCode: string } | null;
    measurement?: { weight?: { value: number; unit: string } | null } | null;
  };
};
export async function variantsByIds(admin: Admin, ids: string[]) {
  if (!ids.length) return [] as Variant[];
  const response = await admin.graphql(
    `#graphql
    query SmartBillConfirmedVariants($ids: [ID!]!) {
      nodes(ids: $ids) { ... on ProductVariant {
        id title sku product { title } inventoryItem { id unitCost { amount currencyCode } measurement { weight { value unit } } }
      } }
    }`,
    { variables: { ids: [...new Set(ids)] } },
  );
  const body = await response.json();
  if ("errors" in body && body.errors)
    throw new Error("Could not verify product matches.");
  const variants = (body.data.nodes || []).filter(
    (v: Variant | null) => v?.id,
  ) as Variant[];
  if (variants.length !== new Set(ids).size)
    throw new Error(
      "A selected variant is unavailable in this store. Select its replacement.",
    );
  return variants;
}
export async function saveInvoiceReview(
  request: Request,
  id: string,
  form: FormData,
) {
  const { session, admin } = await requireSubscription(request);
  const invoiceNumber = String(form.get("invoiceNumber") || "").trim();
  const vendorName = String(form.get("vendorName") || "").trim();
  const date = String(form.get("date") || "");
  const dueDate = String(form.get("dueDate") || "");
  const currency = String(form.get("currency") || "").toUpperCase();
  const purchaseOrderId = String(form.get("purchaseOrderId") || "") || null;
  if (
    !vendorName ||
    !validDate(date) ||
    (dueDate && !validDate(dueDate)) ||
    !validCurrency(currency)
  )
    throw new Error("Enter a supplier, valid dates and an ISO currency code.");
  const rawItems = JSON.parse(String(form.get("items") || "[]"));
  if (!Array.isArray(rawItems) || !rawItems.length || rawItems.length > 200)
    throw new Error("An invoice must have 1–200 lines.");
  const items = rawItems.map((item: Record<string, unknown>) => {
    const category =
      isChargeCategory(item.category) && item.category !== "PRODUCT"
        ? item.category
        : "PRODUCT";
    const charge = category !== "PRODUCT";
    const manualCharge = Number(item.manualCharge);
    const supplierUoM = charge
      ? null
      : String(item.supplierUoM || "").trim().toLowerCase().slice(0, 20) || null;
    const packSize = Number(item.packSize);
    return {
      name: String(item.name || "").trim(),
      sku: String(item.sku || "").trim() || null,
      category,
      manualCharge:
        !charge && Number.isFinite(manualCharge) && manualCharge > 0
          ? manualCharge
          : null,
      supplierUoM,
      packSize:
        !charge && Number.isFinite(packSize) && packSize > 0
          ? packSize
          : null,
      quantity: Number(item.quantity),
      price: Number(item.price),
      amount: Number(item.amount),
      // A charge line is never matched to a variant or synced as a product cost.
      shopifyVariantId: charge
        ? null
        : String(item.shopifyVariantId || "") || null,
      matchConfirmed: charge ? false : item.matchConfirmed === true,
      syncCost: charge ? false : item.syncCost !== false,
    };
  });
  const subtotal = Number(form.get("subtotal"));
  const tax = Number(form.get("tax"));
  const total = Number(form.get("total"));
  const issues = invoiceIssues({
    invoiceNumber,
    currency,
    subtotal,
    tax,
    total,
    items,
  });
  if (
    items.some(
      (i) =>
        !i.name ||
        !Number.isFinite(i.quantity) ||
        i.quantity <= 0 ||
        !Number.isFinite(i.price) ||
        i.price < 0 ||
        !Number.isFinite(i.amount),
    ) ||
    ![subtotal, tax, total].every(Number.isFinite)
  )
    throw new Error(
      "Use valid, positive quantities and finite monetary amounts.",
    );
  const methodValue = String(form.get("landedCostMethod") || "NONE");
  const landedCostMethod = isLandedCostMethod(methodValue)
    ? methodValue
    : "NONE";
  const chargeTotal = items
    .filter((item) => isChargeLine(item))
    .reduce((sum, item) => sum + lineValue(item), 0);
  const productItems = items.filter((item) => !isChargeLine(item));
  if (chargeTotal > 0) {
    if (!productItems.length)
      throw new Error(
        "Add at least one product line for the freight and charges to be allocated to.",
      );
    // Validates manual amounts against the charge total and the chosen method.
    allocateCharges(
      productItems.map((item, index) => ({ ...item, id: String(index) })),
      chargeTotal,
      landedCostMethod,
      Object.fromEntries(
        productItems.map((item, index) => [String(index), item.manualCharge]),
      ),
    );
  }
  issues.push(...landedCostIssues(items, landedCostMethod));
  // Shopify costs are written in the shop currency, so a foreign invoice needs
  // an explicit rate before it can be approved.
  const shopCurrency = await fetchShopCurrency(admin);
  const fxRateValue = String(form.get("fxRate") || "").trim();
  const fx = resolveFxRate(
    currency,
    shopCurrency,
    fxRateValue ? Number(fxRateValue) : null,
  );
  const requestedFxSource = String(form.get("fxSource") || "MANUAL");
  const fxSource: ExchangeRateSource = EXCHANGE_RATE_SOURCES.includes(
    requestedFxSource as ExchangeRateSource,
  )
    ? (requestedFxSource as ExchangeRateSource)
    : "MANUAL";
  const fxRateDate = fx.required
    ? resolveFxRateDate(form.get("fxRateDate")) || new Date(`${date}T00:00:00.000Z`)
    : null;
  if (fx.problem) issues.push(fx.problem);
  for (const item of items) {
    if (needsPackSize(item.supplierUoM) && !item.packSize)
      issues.push(
        `Line "${item.name || "unnamed"}" is billed in ${item.supplierUoM}s. Enter how many stock units one ${item.supplierUoM} contains, or set it to 1 if the unit is already a stock unit.`,
      );
  }
  const variants = await variantsByIds(
    admin,
    items.filter((i) => i.shopifyVariantId).map((i) => i.shopifyVariantId!),
  );
  if (
    purchaseOrderId &&
    !(await prisma.purchaseOrder.findFirst({
      where: { id: purchaseOrderId, shop: session.shop },
    }))
  )
    throw new Error("Purchase order not found.");
  const previousPurchaseOrderId = await prisma.$transaction(async (tx) => {
    const before = await lockInvoice(tx, session.shop, id);
    if (
      before.accountingStatus === "EXPORTED" ||
      before.cogsSyncStatus === "SYNCED"
    )
      throw new Error(
        "This invoice has completed financial activity. Preserve it and create a correcting document.",
      );
    if (before.revision !== Number(form.get("revision")))
      throw new Error(
        "This invoice changed in another tab. Reload before saving.",
      );
    if (
      before.exports.some(
        (e) => e.platform !== "CSV" && e.status !== "REJECTED",
      ) ||
      before.costChanges.some((c) => c.status !== "PLANNED")
    )
      throw new Error(
        "This invoice has financial activity. Preserve it and create a separate correcting document.",
      );
    const vendor = await tx.vendor.upsert({
      where: { shop_name: { shop: session.shop, name: vendorName } },
      update: {},
      create: { shop: session.shop, name: vendorName },
    });
    await tx.costChange.deleteMany({
      where: { invoiceId: id, status: "PLANNED" },
    });
    await tx.approval.deleteMany({ where: { invoiceId: id } });
    await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
    const saved = await tx.invoice.update({
      where: { id },
      data: {
        vendorId: vendor.id,
        invoiceNumber,
        identityKey: invoiceIdentity(vendorName, invoiceNumber),
        date: new Date(date),
        dueDate: dueDate ? new Date(dueDate) : null,
        currency,
        subtotal,
        tax,
        total,
        purchaseOrderId,
        approvedAt: null,
        approvedBy: null,
        reviewStatus: issues.length ? "NEEDS_ATTENTION" : "PENDING_REVIEW",
        discrepancySummary: issues.join("\n") || null,
        revision: { increment: 1 },
        landedCostMethod,
        landedCostUpdatedAt: new Date(),
        fxRate: fx.required ? fx.rate : null,
        fxRateSource: fx.required ? fxSource : null,
        fxRateDate,
        shopCurrency,
        costInShopCurrency: fx.required ? total * fx.rate : total,
        accountingMapping: Prisma.DbNull,
        cogsSyncStatus: "NOT_REQUESTED",
        items: {
          create: items.map((item) => {
            const variant = variants.find(
              (v) => v.id === item.shopifyVariantId,
            );
            return {
              ...item,
              matchConfirmed: Boolean(variant && item.matchConfirmed),
              matchedProductTitle: variant
                ? `${variant.product.title} / ${variant.title}`
                : null,
            };
          }),
        },
      },
      include: { items: true },
    });
    await syncFreightLines(tx, saved);
    if (fx.required && fxRateDate)
      await recordInvoiceFxSelection(tx, {
        invoiceId: id,
        shop: session.shop,
        fromCurrency: currency,
        toCurrency: shopCurrency,
        invoiceAmount: total,
        rate: fx.rate,
        rateDate: fxRateDate,
        source: fxSource,
        confidence: fxSource === "MANUAL" ? 40 : 80,
      });
    await tx.auditEvent.create({
      data: {
        shop: session.shop,
        invoiceId: id,
        actor: session.id,
        action: "EDITED",
        detail: {
          previousRevision: before.revision,
          totalBefore: before.total,
          totalAfter: total,
        },
      },
    });
    return before.purchaseOrderId;
  });
  if (purchaseOrderId) await reconcileInvoiceWithPO(id, purchaseOrderId);
  if (previousPurchaseOrderId && previousPurchaseOrderId !== purchaseOrderId)
    await refreshPurchaseOrder(session.shop, previousPurchaseOrderId);
}
export async function approveInvoice(
  request: Request,
  id: string,
  revision: number,
  exceptionReason = "",
) {
  const { session, admin, actor, role } = await requireApprovalAccess(request);
  await requireSubscription(request);
  await ensureDefaultApprovalRules(session.shop);
  const current = await prisma.invoice.findFirst({
    where: { id, shop: session.shop },
    include: { items: true },
  });
  if (!current) throw new Error("Invoice not found.");
  const discrepancies = current.purchaseOrderId
    ? (await reconcileInvoiceWithPO(id, current.purchaseOrderId)).discrepancies
    : [];
  const shopCurrency = await fetchShopCurrency(admin);
  const fx = resolveFxRate(current.currency, shopCurrency, current.fxRate);
  if (fx.problem) throw new Error(fx.problem);
  for (const item of current.items) {
    if (isChargeLine(item)) continue;
    if (needsPackSize(item.supplierUoM) && !item.packSize)
      throw new Error(
        `Line "${item.name}" is billed in ${item.supplierUoM}s. Enter how many stock units one ${item.supplierUoM} contains before approval.`,
      );
    resolvePackSize(item, null);
  }
  // A credit that is still only matched would silently change the cost later,
  // so it must be approved or voided before the invoice can be approved.
  const credits = await prisma.creditNote.findMany({
    where: { shop: session.shop, invoiceId: id },
  });
  const waiting = credits.filter((credit) => credit.status === "MATCHED");
  if (waiting.length)
    throw new Error(
      `${waiting.length} credit note${waiting.length === 1 ? "" : "s"} linked to this invoice still need approval or voiding.`,
    );
  const creditInfo = creditByLine(
    credits.filter((credit) => ["APPROVED", "APPLIED"].includes(credit.status)),
    current.items,
  );
  if (current.total - creditInfo.total < -0.011)
    throw new Error(
      "The linked credit notes are larger than the invoice total. Check the credit amounts before approval.",
    );
  if (discrepancies.length && exceptionReason.trim().length < 10)
    throw new Error(
      "Resolve the PO differences or enter a clear reason for accepting them (at least 10 characters).",
    );
  return prisma.$transaction(async (tx) => {
    const invoice = await lockInvoice(tx, session.shop, id);
    if (invoice.revision !== revision)
      throw new Error("Invoice changed. Reload and review again.");
    const landedCostMethod = isLandedCostMethod(invoice.landedCostMethod)
      ? invoice.landedCostMethod
      : "NONE";
    const productItems = invoice.items.filter((item) => !isChargeLine(item));
    const chargeTotal = invoice.items
      .filter((item) => isChargeLine(item))
      .reduce((sum, item) => sum + lineValue(item), 0);
    if (chargeTotal > 0)
      allocateCharges(
        productItems,
        chargeTotal,
        landedCostMethod,
        Object.fromEntries(
          productItems.map((item) => [item.id, item.manualCharge]),
        ),
      );
    const issues = [
      ...invoiceIssues(invoice),
      ...landedCostIssues(invoice.items, landedCostMethod),
    ];
    if (issues.length) throw new Error(issues.join(" "));
    if (!invoice.vendor || invoice.vendor.name === "Unknown Vendor")
      throw new Error("Confirm the supplier before approval.");
    const approval = await recordApproval(tx, {
      invoice,
      actor,
      sessionId: session.id,
      role,
      comments: exceptionReason,
    });
    await tx.invoice.update({
      where: { id },
      data: {
        reviewStatus: approval.complete ? "APPROVED" : "PENDING_REVIEW",
        approvedAt: approval.complete ? new Date() : null,
        approvedBy: approval.complete ? actor : null,
      },
    });
    if (approval.complete) {
      await tx.vendor.update({
        where: { id: invoice.vendor.id },
        data: { defaultLandedCostMethod: landedCostMethod },
      });
      for (const item of invoice.items.filter(
        (i) => i.matchConfirmed && i.shopifyVariantId,
      )) {
        const key = {
          shop: session.shop,
          vendorKey: normalizedKey(invoice.vendor.name),
          itemKey: supplierItemKey(item),
        };
        const uom = {
          packSize: item.packSize ?? null,
          supplierUoM: item.supplierUoM ?? null,
        };
        await tx.supplierMapping.upsert({
          where: { shop_vendorKey_itemKey: key },
          create: {
            ...key,
            ...uom,
            variantId: item.shopifyVariantId!,
            title: item.matchedProductTitle || item.name,
          },
          update: {
            ...uom,
            variantId: item.shopifyVariantId!,
            title: item.matchedProductTitle || item.name,
          },
        });
      }
      await rememberInvoiceUomMappings(tx, {
        shop: session.shop,
        supplierId: invoice.vendor.id,
        items: invoice.items,
      });
    }
    await tx.auditEvent.create({
      data: {
        shop: session.shop,
        invoiceId: id,
        actor,
        action: approval.complete ? "APPROVED" : "APPROVAL_RECORDED",
        detail: {
          revision,
          role,
          approvalsRequired: approval.requirements.map((rule) => ({
            rule: rule.name,
            requiredApprovers: rule.requiredApprovers,
          })),
          discrepancies,
          exceptionReason: exceptionReason.trim(),
          landedCostMethod,
          fxRate: fx.required ? fx.rate : null,
          creditsApplied: creditInfo.total,
        },
      },
    });
    return approval;
  });
}
