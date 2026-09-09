import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { parseInvoiceText } from "../utils/parser.server";
import {
  invoiceIssues,
  normalizedKey,
  supplierItemKey,
  currencyTotals,
} from "../utils/invoiceRules";
import {
  requireSubscription,
  reserveInvoiceUsage,
  releaseInvoiceUsage,
} from "./billing.server";
import { reconcileInvoiceWithPO } from "./poReconciliation.server";
export { formatMoney } from "../utils/format";

export function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function invoiceIdentity(vendor: string, number?: string | null) {
  return number?.trim()
    ? hashText(JSON.stringify([normalizedKey(vendor), normalizedKey(number)]))
    : null;
}
export async function getShopSettings(shop: string) {
  return prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
}
export async function getDashboard(shop: string) {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const [
    invoices,
    openPurchaseOrders,
    invoicesNeedingAttention,
    recentInvoices,
    activePurchaseOrders,
    vendors,
  ] = await Promise.all([
    prisma.invoice.findMany({ where: { shop, createdAt: { gte: since } } }),
    prisma.purchaseOrder.count({
      where: { shop, status: { in: ["OPEN", "PARTIAL", "MISMATCH"] } },
    }),
    prisma.invoice.count({ where: { shop, reviewStatus: "NEEDS_ATTENTION" } }),
    prisma.invoice.findMany({
      where: { shop },
      include: { vendor: true, items: true, purchaseOrder: true },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    prisma.purchaseOrder.findMany({
      where: { shop, status: { in: ["OPEN", "PARTIAL", "MISMATCH"] } },
      include: { vendor: true, items: true, linkedInvoices: true },
      take: 6,
    }),
    prisma.vendor.findMany({
      where: { shop },
      include: { invoices: { where: { createdAt: { gte: since } } } },
    }),
  ]);
  const spend = currencyTotals(invoices);
  return {
    metrics: {
      invoicesThisMonth: invoices.length,
      spendThisMonth: spend.length === 1 ? spend[0].total : 0,
      spendByCurrency: spend,
      openPurchaseOrders,
      invoicesNeedingAttention,
      cogsSyncedThisMonth: invoices.filter((i) => i.cogsSyncStatus === "SYNCED")
        .length,
      accountingExportsThisMonth: invoices.filter(
        (i) => i.accountingStatus === "EXPORTED",
      ).length,
    },
    recentInvoices,
    activePurchaseOrders,
    vendorSpend: vendors
      .flatMap((v) =>
        currencyTotals(v.invoices).map((t) => ({
          id: `${v.id}-${t.currency}`,
          name: v.name,
          totalSpend: t.total,
          currency: t.currency,
          invoiceCount: v.invoices.filter((i) => i.currency === t.currency)
            .length,
        })),
      )
      .slice(0, 10),
  };
}
type Capture = {
  shop: string;
  rawText: string;
  storageKey?: string;
  filename?: string;
  vendorName?: string | null;
  purchaseOrderId?: string | null;
  documentHash?: string;
  actor?: string;
  jobLease?: { id: string; token: string };
};
export async function persistCapturedInvoice(input: Capture) {
  const { shop } = input;
  if (!input.rawText.trim() || input.rawText.length > 200000)
    throw new Error("Invoice text must contain 1–200,000 characters.");
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  const parsed = parseInvoiceText(
    input.rawText,
    settings?.dateOrder === "MDY" ? "MDY" : "DMY",
  );
  const vendorName =
    input.vendorName?.trim() || parsed.vendor.name || "Unknown Vendor";
  if (
    input.purchaseOrderId &&
    !(await prisma.purchaseOrder.findFirst({
      where: { id: input.purchaseOrderId, shop },
    }))
  )
    throw new Error("Purchase order not found in this store.");
  const documentHash =
    input.documentHash || hashText(normalizedKey(input.rawText));
  const identityKey = invoiceIdentity(vendorName, parsed.invoiceNumber);
  const duplicate = await prisma.invoice.findFirst({
    where: {
      shop,
      OR: [
        { documentHash },
        ...(identityKey
          ? [
              { identityKey },
              {
                invoiceNumber: {
                  equals: parsed.invoiceNumber!,
                  mode: "insensitive" as const,
                },
                vendor: {
                  name: { equals: vendorName, mode: "insensitive" as const },
                },
              },
            ]
          : []),
      ],
    },
  });
  if (duplicate)
    throw new Error(
      `Duplicate invoice: ${duplicate.invoiceNumber || duplicate.id} is already captured.`,
    );
  const mappings = await prisma.supplierMapping.findMany({
    where: { shop, vendorKey: normalizedKey(vendorName) },
  });
  const items = parsed.items.map((item) => {
    const mapping = mappings.find((m) => m.itemKey === supplierItemKey(item));
    return {
      sku: item.sku || null,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      amount: item.amount,
      shopifyVariantId: mapping?.variantId,
      matchedProductTitle: mapping?.title,
      matchConfirmed: false,
    };
  });
  const issues = [
    ...invoiceIssues({ ...parsed, items }),
    ...(parsed.warnings || []),
  ];
  if (vendorName === "Unknown Vendor")
    issues.push("Confirm the supplier name.");
  try {
    const invoice = await prisma.$transaction(async (tx) => {
      if (input.jobLease) {
        const active = await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "InvoiceJob"
          WHERE "id" = ${input.jobLease.id} AND "shop" = ${shop}
          AND "leaseToken" = ${input.jobLease.token} AND "status" = 'PROCESSING' FOR UPDATE`;
        if (!active.length)
          throw new Error("Processing was cancelled or the lease was lost.");
      }
      const vendor = await tx.vendor.upsert({
        where: { shop_name: { shop, name: vendorName } },
        update: {},
        create: { shop, name: vendorName, defaultCurrency: parsed.currency },
      });
      const created = await tx.invoice.create({
        data: {
          shop,
          vendorId: vendor.id,
          purchaseOrderId: input.purchaseOrderId || null,
          imageUrl: input.storageKey || "manual-entry://invoice",
          storageKey: input.storageKey,
          sourceFilename: input.filename,
          rawText: input.rawText,
          documentHash,
          identityKey,
          invoiceNumber: parsed.invoiceNumber,
          date: new Date(parsed.date),
          dueDate: parsed.dueDate ? new Date(parsed.dueDate) : null,
          currency: parsed.currency,
          subtotal: parsed.subtotal,
          tax: parsed.tax,
          total: parsed.total,
          reviewStatus: issues.length ? "NEEDS_ATTENTION" : "PENDING_REVIEW",
          discrepancySummary: issues.join("\n") || null,
          items: { create: items },
        },
        include: { items: true, vendor: true, purchaseOrder: true },
      });
      await tx.auditEvent.create({
        data: {
          shop,
          invoiceId: created.id,
          actor: input.actor || "capture",
          action: "CAPTURED",
        },
      });
      return created;
    });
    let reconciliationResult = null;
    if (input.purchaseOrderId) {
      try {
        reconciliationResult = await reconcileInvoiceWithPO(
          invoice.id,
          input.purchaseOrderId,
        );
      } catch {
        issues.push(
          "Invoice saved. Open its review page to retry purchase order reconciliation.",
        );
      }
    }
    return {
      invoice,
      parsed,
      reconciliationResult,
      syncResult: null,
      warnings: [...issues, ...(reconciliationResult?.discrepancies || [])],
    };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new Error(
        "This document or supplier invoice number is already captured.",
      );
    throw error;
  }
}
export async function createInvoiceFromInput(input: {
  request: Request;
  shop: string;
  file?: File | null;
  imageUrl?: string | null;
  rawText?: string | null;
  vendorName?: string | null;
  purchaseOrderId?: string | null;
  syncCogs?: boolean;
}) {
  const { session, plan } = await requireSubscription(input.request);
  if (session.shop !== input.shop) throw new Error("Store mismatch.");
  if (input.file?.size)
    throw new Error("Use the document upload queue for files.");
  const month = await reserveInvoiceUsage(session.shop, plan);
  try {
    return await persistCapturedInvoice({
      shop: session.shop,
      rawText: input.rawText || "",
      vendorName: input.vendorName,
      purchaseOrderId: input.purchaseOrderId,
      actor: session.id,
    });
  } catch (error) {
    await releaseInvoiceUsage(session.shop, month);
    throw error;
  }
}
export async function fetchShopCurrency(
  admin: Pick<AdminApiContext, "graphql">,
) {
  const response = await admin.graphql(
    `#graphql query SmartBillShopCurrency { shop { currencyCode } }`,
  );
  const json = await response.json();
  if (("errors" in json && json.errors) || !json.data?.shop?.currencyCode)
    throw new Error("Could not verify the Shopify store currency.");
  return String(json.data.shop.currencyCode);
}
