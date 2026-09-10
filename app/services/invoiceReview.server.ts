import prisma from "../db.server";
import { Prisma } from "@prisma/client";
import { requireAdmin } from "../utils/rbac.server";
import { requireSubscription } from "./billing.server";
import { invoiceIdentity } from "./invoiceWorkflow.server";
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
import type { authenticate } from "../shopify.server";

type Admin = Awaited<ReturnType<typeof authenticate.admin>>["admin"];
export async function findVariants(admin: Admin, query: string) {
  const response = await admin.graphql(
    `#graphql
    query SmartBillVariantSearch($query: String!) {
      productVariants(first: 20, query: $query) { nodes {
        id title sku product { title } inventoryItem { id unitCost { amount currencyCode } }
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
  };
};
export async function variantsByIds(admin: Admin, ids: string[]) {
  if (!ids.length) return [] as Variant[];
  const response = await admin.graphql(
    `#graphql
    query SmartBillConfirmedVariants($ids: [ID!]!) {
      nodes(ids: $ids) { ... on ProductVariant {
        id title sku product { title } inventoryItem { id unitCost { amount currencyCode } }
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
  const items = rawItems.map((item: Record<string, unknown>) => ({
    name: String(item.name || "").trim(),
    sku: String(item.sku || "").trim() || null,
    quantity: Number(item.quantity),
    price: Number(item.price),
    amount: Number(item.amount),
    shopifyVariantId: String(item.shopifyVariantId || "") || null,
    matchConfirmed: item.matchConfirmed === true,
    syncCost: item.syncCost !== false,
  }));
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
    await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
    await tx.invoice.update({
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
  const { session, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const current = await prisma.invoice.findFirst({
    where: { id, shop: session.shop },
  });
  if (!current) throw new Error("Invoice not found.");
  const discrepancies = current.purchaseOrderId
    ? (await reconcileInvoiceWithPO(id, current.purchaseOrderId)).discrepancies
    : [];
  if (discrepancies.length && exceptionReason.trim().length < 10)
    throw new Error(
      "Resolve the PO differences or enter a clear reason for accepting them (at least 10 characters).",
    );
  await prisma.$transaction(async (tx) => {
    const invoice = await lockInvoice(tx, session.shop, id);
    if (invoice.revision !== revision)
      throw new Error("Invoice changed. Reload and review again.");
    const issues = invoiceIssues(invoice);
    if (issues.length) throw new Error(issues.join(" "));
    if (!invoice.vendor || invoice.vendor.name === "Unknown Vendor")
      throw new Error("Confirm the supplier before approval.");
    await tx.invoice.update({
      where: { id },
      data: {
        reviewStatus: "APPROVED",
        approvedAt: new Date(),
        approvedBy: actor,
      },
    });
    for (const item of invoice.items.filter(
      (i) => i.matchConfirmed && i.shopifyVariantId,
    )) {
      const key = {
        shop: session.shop,
        vendorKey: normalizedKey(invoice.vendor.name),
        itemKey: supplierItemKey(item),
      };
      await tx.supplierMapping.upsert({
        where: { shop_vendorKey_itemKey: key },
        create: {
          ...key,
          variantId: item.shopifyVariantId!,
          title: item.matchedProductTitle || item.name,
        },
        update: {
          variantId: item.shopifyVariantId!,
          title: item.matchedProductTitle || item.name,
        },
      });
    }
    await tx.auditEvent.create({
      data: {
        shop: session.shop,
        invoiceId: id,
        actor,
        action: "APPROVED",
        detail: {
          revision,
          discrepancies,
          exceptionReason: exceptionReason.trim(),
        },
      },
    });
  });
}
