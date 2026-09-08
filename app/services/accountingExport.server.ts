import prisma from "../db.server";
import {
  createQuickBooksBill,
  getOrCreateQuickBooksVendorRef,
  refreshQuickBooksToken,
  resolveQuickBooksExpenseAccountRef,
  type QuickBooksRef,
} from "../utils/quickbook";
import { refreshXeroToken } from "../utils/xero";

export type AccountingPlatform = "XERO" | "QUICKBOOKS" | "CSV";

type ExportMode = "CSV_PACKAGE" | "LIVE_SYNC";

type AccountingFormatOptions = {
  quickBooksExpenseAccountRef?: QuickBooksRef;
  quickBooksVendorRef?: QuickBooksRef;
  xeroAccountCode?: string;
  xeroTaxType?: string;
};

function isoDate(value?: Date | string | null) {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().slice(0, 10);
}

function money(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function envValue(name: string) {
  return process.env[name]?.trim() || undefined;
}

function configuredXeroAccountCode() {
  return envValue("XERO_PURCHASE_ACCOUNT_CODE") || "300";
}

function configuredXeroTaxType() {
  return envValue("XERO_TAX_TYPE") || "NONE";
}

function configuredQuickBooksAccountRef(): QuickBooksRef | undefined {
  const value = envValue("QB_EXPENSE_ACCOUNT_ID");
  if (!value) return undefined;
  return { value, name: envValue("QB_EXPENSE_ACCOUNT_NAME") };
}

async function readErrorBody(response: Response) {
  const text = await response.text();
  return text.slice(0, 500);
}

async function refreshConnectionIfNeeded(connection: any) {
  const isExpired =
    connection.expiresAt && new Date(connection.expiresAt).getTime() <= Date.now();

  if (!isExpired || !connection.refreshToken) return connection;

  const token =
    connection.platform === "XERO"
      ? await refreshXeroToken(connection.refreshToken)
      : await refreshQuickBooksToken(connection.refreshToken);

  return prisma.accountingConnection.update({
    where: {
      shop_platform: {
        shop: connection.shop,
        platform: connection.platform,
      },
    },
    data: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || connection.refreshToken,
      scopes: token.scope || connection.scopes,
      expiresAt: token.expires_in
        ? new Date(Date.now() + Math.max(0, token.expires_in - 60) * 1000)
        : connection.expiresAt,
    },
  });
}

async function getInvoice(shop: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, shop },
    include: { vendor: true, items: true, purchaseOrder: true },
  });

  if (!invoice) throw new Error("Invoice not found");
  return invoice;
}

export async function getInvoiceAccountingPayload(
  shop: string,
  invoiceId: string,
  platform: AccountingPlatform,
) {
  const invoice = await getInvoice(shop, invoiceId);

  return formatForPlatform(invoice, platform);
}

async function postToXero(connection: any, payload: any) {
  if (!connection.tenantId) throw new Error("Xero tenant is missing");

  const response = await fetch("https://api.xero.com/api.xro/2.0/Invoices", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      "xero-tenant-id": connection.tenantId,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ Invoices: [payload] }),
  });

  if (!response.ok) {
    throw new Error(`Xero export failed: ${response.status} ${await readErrorBody(response)}`);
  }

  return response.json();
}

async function postToQuickBooks(connection: any, payload: any) {
  return createQuickBooksBill(connection, payload);
}

export async function exportInvoiceToAccounting(
  shop: string,
  invoiceId: string,
  platform: AccountingPlatform,
) {
  const invoice = await getInvoice(shop, invoiceId);
  let payload = formatForPlatform(invoice, platform);
  let mode: ExportMode = "CSV_PACKAGE";
  let remoteResponse: unknown = null;

  if (platform !== "CSV") {
    const storedConnection = await prisma.accountingConnection.findUnique({
      where: { shop_platform: { shop, platform } },
    });

    if (!storedConnection) {
      throw new Error(`Connect ${platform} in Settings before live export.`);
    }

    const connection = await refreshConnectionIfNeeded(storedConnection);
    if (platform === "QUICKBOOKS") {
      payload = formatForPlatform(invoice, platform, {
        quickBooksVendorRef: await getOrCreateQuickBooksVendorRef(
          connection,
          invoice.vendor?.name || "Unknown Vendor",
        ),
        quickBooksExpenseAccountRef:
          configuredQuickBooksAccountRef() ||
          (await resolveQuickBooksExpenseAccountRef(connection)),
      });
    }

    remoteResponse =
      platform === "XERO"
        ? await postToXero(connection, payload)
        : await postToQuickBooks(connection, payload);
    mode = "LIVE_SYNC";
  }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      accountingStatus: "EXPORTED",
      status: platform === "CSV" ? "PENDING_SYNC" : "SYNCED",
    },
  });

  return { success: true, platform, mode, payload, remoteResponse };
}

function baseLineItems(invoice: any) {
  return invoice.items.map((item: any) => ({
    description: item.name,
    sku: item.sku,
    quantity: item.quantity,
    unitAmount: item.price,
    amount: money(item.amount || item.price * item.quantity),
  }));
}

function lineDescription(item: any) {
  return item.sku ? `${item.sku} - ${item.description}` : item.description;
}

export function formatForPlatform(
  invoice: any,
  platform: AccountingPlatform,
  options: AccountingFormatOptions = {},
) {
  const lineItems = baseLineItems(invoice);

  if (platform === "XERO") {
    const taxType = options.xeroTaxType || configuredXeroTaxType();
    return {
      Type: "ACCPAY",
      Contact: { Name: invoice.vendor?.name || "Unknown Vendor" },
      InvoiceNumber: invoice.invoiceNumber,
      Reference: invoice.purchaseOrder?.poNumber,
      DateString: isoDate(invoice.date),
      DueDateString: isoDate(invoice.dueDate || invoice.date),
      CurrencyCode: invoice.currency || "USD",
      LineAmountTypes: "Exclusive",
      LineItems: lineItems.map((item: any) => ({
        Description: lineDescription(item),
        Quantity: item.quantity,
        UnitAmount: item.unitAmount,
        AccountCode: options.xeroAccountCode || configuredXeroAccountCode(),
        ...(taxType ? { TaxType: taxType } : {}),
      })),
    };
  }

  if (platform === "QUICKBOOKS") {
    const vendorName = invoice.vendor?.name || "Unknown Vendor";
    const vendorRef = options.quickBooksVendorRef || { name: vendorName };
    const accountRef =
      options.quickBooksExpenseAccountRef ||
      configuredQuickBooksAccountRef() || {
        name: envValue("QB_EXPENSE_ACCOUNT_NAME") || "Cost of Goods Sold",
      };
    const taxCodeId = envValue("QB_TAX_CODE_ID");

    return {
      VendorRef: vendorRef,
      DocNumber: invoice.invoiceNumber,
      PrivateNote: invoice.purchaseOrder?.poNumber ? `PO ${invoice.purchaseOrder.poNumber}` : undefined,
      TxnDate: isoDate(invoice.date),
      DueDate: isoDate(invoice.dueDate || invoice.date),
      CurrencyRef: { value: invoice.currency || "USD" },
      Line: lineItems.map((item: any) => ({
        Amount: item.amount,
        DetailType: "AccountBasedExpenseLineDetail",
        Description: lineDescription(item),
        AccountBasedExpenseLineDetail: {
          AccountRef: accountRef,
          BillableStatus: "NotBillable",
          ...(taxCodeId ? { TaxCodeRef: { value: taxCodeId } } : {}),
        },
      })),
    };
  }

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    vendor: invoice.vendor?.name || "Unknown Vendor",
    poNumber: invoice.purchaseOrder?.poNumber || "",
    date: isoDate(invoice.date),
    dueDate: isoDate(invoice.dueDate),
    currency: invoice.currency || "USD",
    subtotal: invoice.subtotal,
    tax: invoice.tax,
    total: invoice.total,
    lineItems,
  };
}
