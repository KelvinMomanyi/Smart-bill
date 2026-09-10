import { normalizedKey } from "./invoiceRules";
export function exportDisposition(
  entry?: { status: string; remoteId: string | null } | null,
) {
  if (!entry) return "CREATE" as const;
  if (entry.status === "EXPORTED" && entry.remoteId) return "DONE" as const;
  if (entry.status === "REJECTED" && !entry.remoteId) return "RETRY" as const;
  throw new Error(
    "An export is already running or needs verification. Use the export history to find the existing bill.",
  );
}
export function assertExportCompany(
  previous: string | null | undefined,
  current: string,
) {
  if (previous && previous !== current)
    throw new Error(
      "Reconnect the original accounting company and environment before retrying or verifying this export.",
    );
}
function dateOnly(value: any) {
  if (!value) return "";
  const epoch = typeof value === "string" && /^\/Date\((-?\d+)/.exec(value);
  const parsed = epoch ? new Date(Number(epoch[1])) : new Date(value);
  return Number.isNaN(parsed.getTime())
    ? ""
    : parsed.toISOString().slice(0, 10);
}
function sameAmount(a: unknown, b: unknown) {
  return (
    a != null &&
    b != null &&
    Number.isFinite(Number(a)) &&
    Number.isFinite(Number(b)) &&
    Math.abs(Number(a) - Number(b)) <= 0.011
  );
}
export function billMatchesInvoice(
  platform: "XERO" | "QUICKBOOKS",
  bill: any,
  invoice: any,
  expected: any,
  homeCurrency: string,
) {
  if (!bill || !expected) return false;
  if (!samePostingLines(platform, bill, expected)) return false;
  const expectedRate =
    platform === "XERO" ? expected.CurrencyRate : expected.ExchangeRate;
  const actualRate =
    platform === "XERO" ? bill.CurrencyRate : bill.ExchangeRate;
  if (
    expectedRate != null &&
    (!Number.isFinite(Number(actualRate)) ||
      Math.abs(Number(actualRate) - Number(expectedRate)) > 0.000001)
  )
    return false;
  if (platform === "XERO") {
    return (
      bill.Type === "ACCPAY" &&
      !bill.HasErrors &&
      !bill.HasValidationErrors &&
      !bill.ValidationErrors?.length &&
      !["VOIDED", "DELETED"].includes(bill.Status) &&
      bill.InvoiceNumber === invoice.invoiceNumber &&
      (expected.Contact?.ContactID
        ? bill.Contact?.ContactID === expected.Contact.ContactID
        : normalizedKey(bill.Contact?.Name || "") ===
          normalizedKey(invoice.vendor?.name || "")) &&
      bill.CurrencyCode === invoice.currency &&
      sameAmount(bill.Total, invoice.total) &&
      sameAmount(bill.TotalTax, invoice.tax || 0) &&
      sameAmount(bill.SubTotal, invoice.subtotal) &&
      dateOnly(bill.DateString || bill.Date) === dateOnly(invoice.date) &&
      dateOnly(bill.DueDateString || bill.DueDate) ===
        dateOnly(invoice.dueDate || invoice.date)
    );
  }
  return (
    bill.DocNumber === invoice.invoiceNumber &&
    String(bill.VendorRef?.value) === String(expected.VendorRef?.value) &&
    (bill.CurrencyRef?.value || homeCurrency) === invoice.currency &&
    sameAmount(bill.TotalAmt, invoice.total) &&
    (!expected.TxnTaxDetail ||
      sameAmount(
        bill.TxnTaxDetail?.TotalTax ?? 0,
        expected.TxnTaxDetail.TotalTax,
      )) &&
    dateOnly(bill.TxnDate) === dateOnly(invoice.date) &&
    dateOnly(bill.DueDate) === dateOnly(invoice.dueDate || invoice.date)
  );
}
function samePostingLines(
  platform: "XERO" | "QUICKBOOKS",
  bill: any,
  expected: any,
) {
  const wanted = platform === "XERO" ? expected.LineItems : expected.Line;
  const received = platform === "XERO" ? bill.LineItems : bill.Line;
  if (!Array.isArray(wanted)) return true; // Legacy payloads can lack line detail.
  if (!Array.isArray(received)) return false;
  function postings(lines: any[]) {
    const groups = new Map<string, { net: number; tax: number }>();
    for (const line of lines) {
      if (
        platform === "QUICKBOOKS" &&
        line.DetailType !== "AccountBasedExpenseLineDetail"
      )
        continue;
      const account =
        platform === "XERO"
          ? line.AccountCode
          : line.AccountBasedExpenseLineDetail?.AccountRef?.value;
      const tax =
        platform === "XERO"
          ? line.TaxType
          : line.AccountBasedExpenseLineDetail?.TaxCodeRef?.value || "";
      const amount = Number(
        platform === "XERO" ? line.LineAmount : line.Amount,
      );
      const taxAmount = Number(platform === "XERO" ? line.TaxAmount || 0 : 0);
      if (!account || !Number.isFinite(amount) || !Number.isFinite(taxAmount))
        return null;
      const key = JSON.stringify([String(account), tax]);
      const previous = groups.get(key) || { net: 0, tax: 0 };
      groups.set(key, {
        net: previous.net + amount,
        tax: previous.tax + taxAmount,
      });
    }
    return groups;
  }
  const a = postings(wanted);
  const b = postings(received);
  return Boolean(
    a &&
      b &&
      a.size === b.size &&
      [...a].every(
        ([key, value]) =>
          sameAmount(value.net, b.get(key)?.net) &&
          sameAmount(value.tax, b.get(key)?.tax),
      ),
  );
}
