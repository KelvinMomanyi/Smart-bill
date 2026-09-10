import type { QuickBooksRef } from "./quickbook";
import type { validateBillMapping } from "./accountingValidation";

export type AccountingPlatform = "XERO" | "QUICKBOOKS" | "CSV";

type AccountingFormatOptions = {
  quickBooksExpenseAccountRef?: QuickBooksRef;
  quickBooksVendorRef?: QuickBooksRef;
  xeroAccountCode?: string;
  xeroTaxType?: string;
  quickBooksTaxCodeId?: string;
  xeroContactRef?: { ContactID: string; Name: string };
  validated?: ReturnType<typeof validateBillMapping>;
  quickBooksMultiCurrency?: boolean;
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
  platform: "XERO",
  options?: AccountingFormatOptions,
): Extract<ReturnType<typeof formatPayload>, { Type: string }>;
export function formatForPlatform(
  invoice: any,
  platform: "QUICKBOOKS",
  options?: AccountingFormatOptions,
): Extract<ReturnType<typeof formatPayload>, { Line: any[] }>;
export function formatForPlatform(
  invoice: any,
  platform: "CSV",
  options?: AccountingFormatOptions,
): Extract<ReturnType<typeof formatPayload>, { invoiceId: any }>;
export function formatForPlatform(
  invoice: any,
  platform: AccountingPlatform,
  options?: AccountingFormatOptions,
): ReturnType<typeof formatPayload>;
export function formatForPlatform(
  invoice: any,
  platform: AccountingPlatform,
  options: AccountingFormatOptions = {},
) {
  return formatPayload(invoice, platform, options);
}
function formatPayload(
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
      Contact: options.xeroContactRef || {
        Name: invoice.vendor?.name || "Unknown Vendor",
      },
      InvoiceNumber: invoice.invoiceNumber,
      Reference: invoice.purchaseOrder?.poNumber,
      Date: isoDate(invoice.date),
      DueDate: isoDate(invoice.dueDate || invoice.date),
      Status: "DRAFT",
      CurrencyCode: invoice.currency || "USD",
      LineAmountTypes: "Exclusive",
      ...(options.validated?.exchangeRate
        ? {
            CurrencyRate: Number(
              (1 / options.validated.exchangeRate).toFixed(6),
            ),
          }
        : {}),
      LineItems: lineItems.map((item: any, index: number) => ({
        Description: lineDescription(item),
        Quantity: item.quantity,
        UnitAmount: item.unitAmount,
        LineAmount: item.amount,
        AccountCode:
          options.validated?.lines[index].accountId ||
          options.xeroAccountCode ||
          configuredXeroAccountCode(),
        TaxType: options.validated?.lines[index].taxCodeId || taxType,
        TaxAmount: options.validated
          ? options.validated.lines[index].taxAmount
          : taxAmounts[index],
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
    const validated = options.validated;
    const taxDetails = new Map<
      string,
      { id: string; rate: number; taxable: number; amount: number }
    >();
    for (const line of validated?.lines || []) {
      for (const component of line.components) {
        const key = `${component.id}:${component.rate}`;
        const previous = taxDetails.get(key);
        taxDetails.set(key, {
          ...component,
          taxable: money((previous?.taxable || 0) + component.taxable),
          amount: money((previous?.amount || 0) + component.amount),
        });
      }
    }

    return {
      VendorRef: vendorRef,
      DocNumber: invoice.invoiceNumber,
      PrivateNote: invoice.purchaseOrder?.poNumber
        ? `PO ${invoice.purchaseOrder.poNumber}`
        : undefined,
      TxnDate: isoDate(invoice.date),
      DueDate: isoDate(invoice.dueDate || invoice.date),
      ...(options.quickBooksMultiCurrency !== false
        ? { CurrencyRef: { value: invoice.currency || "USD" } }
        : {}),
      ...(validated?.exchangeRate
        ? { ExchangeRate: validated.exchangeRate }
        : {}),
      ...(validated && !validated.us
        ? {
            GlobalTaxCalculation: "TaxExcluded",
            TxnTaxDetail: {
              TotalTax: money(invoice.tax || 0),
              TaxLine: [...taxDetails.values()].map((t) => ({
                Amount: t.amount,
                DetailType: "TaxLineDetail",
                TaxLineDetail: {
                  TaxRateRef: { value: t.id },
                  PercentBased: true,
                  TaxPercent: t.rate,
                  NetAmountTaxable: t.taxable,
                },
              })),
            },
          }
        : {}),
      Line: [
        ...lineItems.map((item: any, index: number) => ({
          Amount: item.amount,
          DetailType: "AccountBasedExpenseLineDetail",
          Description: lineDescription(item),
          AccountBasedExpenseLineDetail: {
            AccountRef: validated
              ? { value: validated.lines[index].accountId }
              : accountRef,
            BillableStatus: "NotBillable",
            ...(validated
              ? validated.lines[index].taxCodeId
                ? { TaxCodeRef: { value: validated.lines[index].taxCodeId } }
                : {}
              : taxCodeId
                ? { TaxCodeRef: { value: taxCodeId } }
                : {}),
          },
        })),
        ...(validated?.taxAccountId
          ? [
              {
                Amount: money(invoice.tax || 0),
                Description: "Non-recoverable purchase sales tax",
                DetailType: "AccountBasedExpenseLineDetail",
                AccountBasedExpenseLineDetail: {
                  AccountRef: { value: validated.taxAccountId },
                  BillableStatus: "NotBillable",
                },
              },
            ]
          : []),
      ],
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
