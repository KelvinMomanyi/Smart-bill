import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { parseInvoiceText } from "../utils/parser.server";
import {
  invoiceIssues,
  normalizedKey,
  roundMoney,
  supplierItemKey,
  currencyTotals,
} from "../utils/invoiceRules";
import { detectCreditReason } from "../utils/creditNotes";
import {
  findInvoiceForCredit,
  invalidateInvoiceForCredit,
} from "./creditNotes.server";
import {
  requireSubscription,
  reserveInvoiceUsage,
  releaseInvoiceUsage,
} from "./billing.server";
import { reconcileInvoiceWithPO } from "./poReconciliation.server";
import { SHOP_CURRENCY_QUERY } from "../utils/shopifyQueries";
import { syncFreightLines } from "./freightAllocation.server";
import { notifySafely } from "./notifications.server";
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
  // A supplier credit is a different document: it never becomes an invoice,
  // and it only ever reduces the cost of the invoice it credits.
  if (parsed.isCreditDocument)
    return persistCapturedCreditNote({
      ...input,
      shop,
      vendorName,
      documentHash,
      parsed,
    });
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
  const knownVendor = await prisma.vendor.findFirst({
    where: { shop, name: { equals: vendorName, mode: "insensitive" } },
  });
  const [mappings, uomMappings] = await Promise.all([
    prisma.supplierMapping.findMany({
      where: { shop, vendorKey: normalizedKey(vendorName) },
    }),
    knownVendor
      ? prisma.uoMMapping.findMany({
          where: { shop, supplierId: knownVendor.id },
        })
      : Promise.resolve([]),
  ]);
  const items = parsed.items.map((item) => {
    const category = item.category || "PRODUCT";
    const charge = category !== "PRODUCT";
    const mapping = charge
      ? undefined
      : mappings.find((m) => m.itemKey === supplierItemKey(item));
    const uomMapping = charge
      ? undefined
      : uomMappings.find(
          (candidate) =>
            candidate.itemKey === supplierItemKey(item) &&
            candidate.supplierUoM === item.supplierUoM,
        );
    return {
      sku: item.sku || null,
      name: item.name,
      category,
      // Snapshotted from the document so the pack size survives later edits.
      supplierUoM: charge ? null : item.supplierUoM || null,
      packSize: charge
        ? null
        : item.packSize ||
          uomMapping?.conversionFactor ||
          (item.supplierUoM && item.supplierUoM === mapping?.supplierUoM
            ? mapping.packSize
            : null),
      price: item.price,
      quantity: item.quantity,
      amount: item.amount,
      shopifyVariantId: mapping?.variantId,
      matchedProductTitle: mapping?.title,
      matchConfirmed: false,
      // Freight, duty and handling lines are charges, never stock.
      syncCost: !charge,
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
      await syncFreightLines(tx, created);
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
    await notifySafely("INVOICE_UPLOADED", shop, {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      supplier: invoice.vendor?.name,
      amount: invoice.total,
      currency: invoice.currency,
      message: "Review needed",
    });
    const confidenceValues = parsed.items
      .map((item) => item.confidence)
      .filter((value): value is number => Number.isFinite(value));
    const averageConfidence = confidenceValues.length
      ? confidenceValues.reduce((sum, value) => sum + value, 0) /
        confidenceValues.length
      : null;
    if (averageConfidence != null && averageConfidence < 0.7)
      await notifySafely("OCR_LOW_CONFIDENCE", shop, {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        supplier: invoice.vendor?.name,
        message: `OCR confidence was ${Math.round(averageConfidence * 100)}%; manual review is recommended`,
      });
    if (reconciliationResult?.discrepancies.length)
      await notifySafely("PO_MISMATCH", shop, {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        supplier: invoice.vendor?.name,
        amount: invoice.total,
        currency: invoice.currency,
        message: reconciliationResult.discrepancies.join(" "),
      });
    if (vendorName === "Unknown Vendor")
      await notifySafely("MISSING_SUPPLIER", shop, {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        message: "Assign a supplier before approval and cost sync",
      });
    return {
      invoice,
      creditNote: null,
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
// Credit documents are stored beside invoices and matched to the invoice they
// credit. They never carry line-level Shopify mapping of their own.
async function persistCapturedCreditNote(input: Capture & {
  shop: string;
  vendorName: string;
  documentHash: string;
  parsed: ReturnType<typeof parseInvoiceText>;
}) {
  const { shop, parsed } = input;
  const duplicate = await prisma.creditNote.findFirst({
    where: { shop, documentHash: input.documentHash },
  });
  if (duplicate)
    throw new Error(
      `Duplicate credit note: ${duplicate.creditNoteNumber || duplicate.id.slice(0, 8)} was already captured.`,
    );
  const amount = roundMoney(Math.abs(Number(parsed.total) || 0));
  if (!(amount > 0))
    throw new Error(
      "The credit note amount could not be read. Enter it in the credit note form.",
    );
  const created = await prisma.$transaction(async (tx) => {
    if (input.jobLease) {
      const active = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "InvoiceJob"
        WHERE "id" = ${input.jobLease.id} AND "shop" = ${shop}
        AND "leaseToken" = ${input.jobLease.token} AND "status" = 'PROCESSING' FOR UPDATE`;
      if (!active.length)
        throw new Error("Processing was cancelled or the lease was lost.");
    }
    const vendor = await tx.vendor.upsert({
      where: { shop_name: { shop, name: input.vendorName } },
      update: {},
      create: { shop, name: input.vendorName, defaultCurrency: parsed.currency },
    });
    const matched = await findInvoiceForCredit(
      shop,
      parsed.originalInvoiceNumber,
      vendor.id,
    );
    if (matched) await invalidateInvoiceForCredit(tx, shop, matched.id);
    const credit = await tx.creditNote.create({
      data: {
        shop,
        vendorId: vendor.id,
        invoiceId: matched?.id || null,
        creditNoteNumber:
          parsed.creditNoteNumber?.trim() || parsed.invoiceNumber?.trim() || null,
        originalInvoiceNumber: parsed.originalInvoiceNumber?.trim() || null,
        amount,
        currency: parsed.currency,
        reason: detectCreditReason({
          rawText: input.rawText,
          items: parsed.items,
        }),
        status: matched ? "MATCHED" : "PENDING",
        dateIssued: new Date(parsed.date),
        documentHash: input.documentHash,
        storageKey: input.storageKey || null,
        sourceFilename: input.filename || null,
        rawText: input.rawText,
        allocation: { method: "PRO_RATA" },
        actor: input.actor || "capture",
        lines: parsed.items.length
          ? {
              create: parsed.items.map((item) => ({
                description: item.name,
                quantity: Math.abs(item.quantity),
                unitPrice: Math.abs(item.price),
                lineAmount: Math.abs(item.amount),
                originalLineId: item.sku || null,
              })),
            }
          : undefined,
        allocations: matched
          ? {
              create: {
                targetInvoiceId: matched.id,
                allocatedAmount: amount,
                allocationReason: "Matched by parsed original invoice number",
              },
            }
          : undefined,
      },
    });
    await tx.auditEvent.create({
      data: {
        shop,
        invoiceId: matched?.id || null,
        actor: input.actor || "capture",
        action: "CREDIT_NOTE_CAPTURED",
        detail: {
          creditNoteId: credit.id,
          creditNoteNumber: credit.creditNoteNumber,
          amount,
          currency: credit.currency,
          matchedInvoiceId: matched?.id || null,
        },
      },
    });
    return credit;
  });
  return {
    invoice: null,
    creditNote: created,
    parsed,
    reconciliationResult: null,
    syncResult: null,
    warnings: [
      ...(parsed.warnings || []),
      created.invoiceId
        ? `Matched to invoice ${created.originalInvoiceNumber}. Review and approve the credit before syncing costs.`
        : "No invoice with that number was found. Match this credit note to the invoice it credits.",
    ],
  };
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
  const response = await admin.graphql(SHOP_CURRENCY_QUERY);
  const json = await response.json();
  if (("errors" in json && json.errors) || !json.data?.shop?.currencyCode)
    throw new Error("Could not verify the Shopify store currency.");
  return String(json.data.shop.currencyCode);
}
