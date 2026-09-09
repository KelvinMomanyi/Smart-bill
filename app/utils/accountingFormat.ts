import type { QuickBooksRef } from "./quickbook";

export type AccountingPlatform = "XERO" | "QUICKBOOKS" | "CSV";

type AccountingFormatOptions = {
  quickBooksExpenseAccountRef?: QuickBooksRef;
  quickBooksVendorRef?: QuickBooksRef;
  xeroAccountCode?: string;
  xeroTaxType?: string;
  quickBooksTaxCodeId?: string;
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

function baseLineItems(invoice: any) {
  return invoice.items.map((item: any) => ({
    description: item.name,
    sku: item.sku,
    quantity: item.quantity,
    unitAmount: item.price,
    amount: money(item.amount ?? item.price * item.quantity),
  }));
}

function lineDescription(item: any) {
  return item.sku ? `${item.sku} - ${item.description}` : item.description;
}

// Cumulative rounding keeps the tax sum exact, including a penny across many lines.
export function allocateTax(tax: number, amounts: number[]) {
  const total = amounts.reduce((sum, amount) => sum + amount, 0);
  let cumulative = 0;
  let allocated = 0;
  return amounts.map((amount) => {
    cumulative += amount;
    const target = total > 0 ? money((tax * cumulative) / total) : 0;
    const part = money(target - allocated);
    allocated = target;
    return part;
  });
}

export function formatForPlatform(
  invoice: any,
  platform: AccountingPlatform,
  options: AccountingFormatOptions = {},
) {
  const lineItems = baseLineItems(invoice);

  if (platform === "XERO") {
    const taxType = options.xeroTaxType || configuredXeroTaxType();
    const taxAmounts = allocateTax(
      invoice.tax || 0,
      lineItems.map((item: any) => item.amount),
    );
    return {
      Type: "ACCPAY",
      Contact: { Name: invoice.vendor?.name || "Unknown Vendor" },
      InvoiceNumber: invoice.invoiceNumber,
      Reference: invoice.purchaseOrder?.poNumber,
      DateString: isoDate(invoice.date),
      DueDateString: isoDate(invoice.dueDate || invoice.date),
      CurrencyCode: invoice.currency || "USD",
      LineAmountTypes: "Exclusive",
      LineItems: lineItems.map((item: any, index: number) => ({
        Description: lineDescription(item),
        Quantity: item.quantity,
        UnitAmount: item.unitAmount,
        AccountCode: options.xeroAccountCode || configuredXeroAccountCode(),
        ...(taxType ? { TaxType: taxType } : {}),
        ...((invoice.tax || 0) > 0 ? { TaxAmount: taxAmounts[index] } : {}),
      })),
    };
  }

  if (platform === "QUICKBOOKS") {
    const vendorName = invoice.vendor?.name || "Unknown Vendor";
    const vendorRef = options.quickBooksVendorRef || { name: vendorName };
    const accountRef = options.quickBooksExpenseAccountRef ||
      configuredQuickBooksAccountRef() || {
        name: envValue("QB_EXPENSE_ACCOUNT_NAME") || "Cost of Goods Sold",
      };
    const taxCodeId = options.quickBooksTaxCodeId || envValue("QB_TAX_CODE_ID");

    return {
      VendorRef: vendorRef,
      DocNumber: invoice.invoiceNumber,
      PrivateNote: invoice.purchaseOrder?.poNumber
        ? `PO ${invoice.purchaseOrder.poNumber}`
        : undefined,
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
