import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server";
import { parseInvoiceText, type ParsedInvoice } from "../utils/parser.server";
import { extractTextFromFile } from "../utils/ocr.server";
import { uploadInvoiceImage } from "../utils/upload.server";
import { formatMoney } from "../utils/format";
import { reconcileInvoiceWithPO } from "./poReconciliation.server";
import { syncCogsToShopify } from "./cogs.server";

type CreateInvoiceInput = {
  request: Request;
  shop: string;
  file?: File | null;
  imageUrl?: string | null;
  rawText?: string | null;
  vendorName?: string | null;
  purchaseOrderId?: string | null;
  syncCogs?: boolean;
};

type DashboardMetrics = {
  invoicesThisMonth: number;
  spendThisMonth: number;
  openPurchaseOrders: number;
  invoicesNeedingAttention: number;
  cogsSyncedThisMonth: number;
  accountingExportsThisMonth: number;
};

function startOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function toDate(value?: string | null) {
  if (!value) return new Date();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function summarizeExtraction(parsed: ParsedInvoice) {
  const issues: string[] = [];
  if (!parsed.invoiceNumber) issues.push("Missing invoice number");
  if (!parsed.vendor.name || parsed.vendor.name === "Unknown Vendor")
    issues.push("Unknown vendor");
  if (parsed.items.length === 0) issues.push("No line items detected");
  if (!parsed.total || parsed.total <= 0) issues.push("Missing invoice total");
  return issues;
}

function reviewStatusFor(
  parsed: ParsedInvoice,
  reconciliationDiscrepancies: string[],
) {
  const extractionIssues = summarizeExtraction(parsed);
  if (extractionIssues.length > 0 || reconciliationDiscrepancies.length > 0) {
    return "NEEDS_ATTENTION";
  }

  return "PENDING_REVIEW";
}

export { formatMoney };

export async function getShopSettings(shop: string) {
  return prisma.shopSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
}

export async function getDashboard(shop: string) {
  const since = startOfMonth();

  const [
    invoicesThisMonth,
    invoices,
    openPurchaseOrders,
    invoicesNeedingAttention,
    cogsSyncedThisMonth,
    accountingExportsThisMonth,
    recentInvoices,
    activePurchaseOrders,
    topVendors,
  ] = await Promise.all([
    prisma.invoice.count({ where: { shop, createdAt: { gte: since } } }),
    prisma.invoice.findMany({ where: { shop, createdAt: { gte: since } } }),
    prisma.purchaseOrder.count({
      where: { shop, status: { in: ["OPEN", "PARTIAL", "MISMATCH"] } },
    }),
    prisma.invoice.count({ where: { shop, reviewStatus: "NEEDS_ATTENTION" } }),
    prisma.invoice.count({
      where: { shop, cogsSyncStatus: "SYNCED", createdAt: { gte: since } },
    }),
    prisma.invoice.count({
      where: { shop, accountingStatus: "EXPORTED", createdAt: { gte: since } },
    }),
    prisma.invoice.findMany({
      where: { shop },
      include: { vendor: true, items: true, purchaseOrder: true },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    prisma.purchaseOrder.findMany({
      where: { shop, status: { in: ["OPEN", "PARTIAL", "MISMATCH"] } },
      include: { vendor: true, items: true, linkedInvoices: true },
      orderBy: { updatedAt: "desc" },
      take: 6,
    }),
    prisma.vendor.findMany({
      where: { shop },
      include: { invoices: true },
      take: 100,
    }),
  ]);

  const metrics: DashboardMetrics = {
    invoicesThisMonth,
    spendThisMonth: invoices.reduce((sum, invoice) => sum + invoice.total, 0),
    openPurchaseOrders,
    invoicesNeedingAttention,
    cogsSyncedThisMonth,
    accountingExportsThisMonth,
  };

  const vendorSpend = topVendors
    .map((vendor) => ({
      id: vendor.id,
      name: vendor.name,
      totalSpend: vendor.invoices.reduce(
        (sum, invoice) => sum + invoice.total,
        0,
      ),
      invoiceCount: vendor.invoices.length,
    }))
    .sort((left, right) => right.totalSpend - left.totalSpend)
    .slice(0, 5);

  return { metrics, recentInvoices, activePurchaseOrders, vendorSpend };
}

export async function createInvoiceFromInput(input: CreateInvoiceInput) {
  const { request, shop, file, vendorName, purchaseOrderId } = input;
  let rawText = input.rawText?.trim() || "";
  let imageUrl = input.imageUrl?.trim() || "manual-entry://invoice";
  let sourceFilename: string | null = null;
  let uploadWarning: string | null = null;

  if (file && file.size > 0) {
    sourceFilename = file.name;
    if (
      !file.type.startsWith("image/") &&
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      throw new Error("Upload an invoice image or PDF for OCR.");
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    rawText ||= await extractTextFromFile(buffer, {
      filename: file.name,
      mimeType: file.type,
    });

    try {
      imageUrl = await uploadInvoiceImage(buffer, file.name, file.type);
    } catch (error) {
      uploadWarning = error instanceof Error ? error.message : String(error);
      imageUrl = `upload-failed://${file.name}`;
    }
  }

  if (!rawText) {
    throw new Error(
      "No invoice text was found. Upload a clear invoice image or paste OCR text.",
    );
  }

  const parsed = parseInvoiceText(rawText);
  const selectedVendorName =
    vendorName?.trim() || parsed.vendor.name || "Unknown Vendor";

  const vendor = await prisma.vendor.upsert({
    where: {
      shop_name: {
        shop,
        name: selectedVendorName,
      },
    },
    update: {
      defaultCurrency: parsed.currency,
    },
    create: {
      shop,
      name: selectedVendorName,
      address: parsed.vendor.address || null,
      defaultCurrency: parsed.currency,
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      shop,
      vendorId: vendor.id,
      purchaseOrderId: purchaseOrderId || null,
      imageUrl,
      storageKey: imageUrl.startsWith("gs://") ? imageUrl : null,
      sourceFilename,
      rawText,
      date: toDate(parsed.date),
      dueDate: parsed.dueDate ? toDate(parsed.dueDate) : null,
      subtotal: parsed.subtotal || null,
      tax: parsed.tax || null,
      total: parsed.total || 0,
      invoiceNumber: parsed.invoiceNumber,
      currency: parsed.currency,
      status: "PENDING_SYNC",
      reviewStatus:
        summarizeExtraction(parsed).length > 0
          ? "NEEDS_ATTENTION"
          : "PENDING_REVIEW",
      cogsSyncStatus: input.syncCogs ? "PENDING" : "NOT_REQUESTED",
      items: {
        create: parsed.items.map((item) => ({
          sku: item.sku || null,
          name: item.description || item.name || "Unknown Item",
          price: item.rate || item.price || 0,
          quantity: item.quantity || 1,
          amount: item.amount || 0,
          confidence: item.confidence || null,
        })),
      },
    },
    include: { items: true, vendor: true },
  });

  let reconciliationResult: Awaited<
    ReturnType<typeof reconcileInvoiceWithPO>
  > | null = null;
  if (purchaseOrderId) {
    reconciliationResult = await reconcileInvoiceWithPO(
      invoice.id,
      purchaseOrderId,
    );
  }

  let syncResult: Awaited<ReturnType<typeof syncCogsToShopify>> | null = null;
  if (input.syncCogs && invoice.items.length > 0) {
    syncResult = await syncCogsToShopify(
      request,
      invoice.items.map((item) => ({
        invoiceItemId: item.id,
        sku: item.sku,
        shopifyProductId: item.shopifyProductId,
        shopifyVariantId: item.shopifyVariantId,
        name: item.name,
        price: item.price,
      })),
    );
  }

  const extractionIssues = summarizeExtraction(parsed);
  const reconciliationDiscrepancies = reconciliationResult?.discrepancies || [];
  if (syncResult?.syncedItems.length) {
    await Promise.all(
      syncResult.syncedItems
        .filter((item) => item.invoiceItemId)
        .map((item) =>
          prisma.invoiceItem.update({
            where: { id: item.invoiceItemId },
            data: {
              shopifyProductId: item.productId || null,
              shopifyVariantId: item.variantId || null,
              matchedProductTitle:
                item.matchedProductTitle || item.matchedVariantTitle || null,
            },
          }),
        ),
    );
  }

  const cogsSyncStatus = input.syncCogs
    ? syncResult?.success
      ? "SYNCED"
      : syncResult?.partialSuccess
        ? "PARTIAL"
        : "FAILED"
    : "NOT_REQUESTED";

  const finalInvoice = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      reviewStatus: reviewStatusFor(parsed, reconciliationDiscrepancies),
      cogsSyncStatus,
      status: cogsSyncStatus === "SYNCED" ? "SYNCED" : "PENDING_SYNC",
      discrepancySummary:
        [
          ...extractionIssues,
          ...reconciliationDiscrepancies,
          ...(uploadWarning ? [`Upload warning: ${uploadWarning}`] : []),
        ].join("\n") || null,
    },
    include: { items: true, vendor: true, purchaseOrder: true },
  });

  return {
    invoice: finalInvoice,
    parsed,
    reconciliationResult,
    syncResult,
    warnings: [
      ...extractionIssues,
      ...reconciliationDiscrepancies,
      ...(uploadWarning ? [uploadWarning] : []),
    ],
  };
}

export async function approveInvoice(shop: string, invoiceId: string) {
  return prisma.invoice.update({
    where: { id: invoiceId, shop },
    data: { reviewStatus: "APPROVED" },
  });
}

export async function markAccountingExported(shop: string, invoiceId: string) {
  return prisma.invoice.update({
    where: { id: invoiceId, shop },
    data: { accountingStatus: "EXPORTED" },
  });
}

export async function fetchShopCurrency(admin: AdminApiContext) {
  try {
    const response = await admin.graphql(`#graphql
      query SmartBillShopCurrency {
        shop {
          currencyCode
        }
      }
    `);
    const json = await response.json();
    return json.data?.shop?.currencyCode || "USD";
  } catch {
    return "USD";
  }
}
