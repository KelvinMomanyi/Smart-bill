export function normalizedKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
export function supplierItemKey(item: { sku?: string | null; name: string }) {
  return item.sku ? `sku:${normalizedKey(item.sku)}` : `name:${normalizedKey(item.name)}`;
}
export function roundMoney(value: number) { return Math.round((value + Number.EPSILON) * 100) / 100; }
export function validCurrency(value: string) {
  return /^[A-Z]{3}$/.test(value) && Intl.supportedValuesOf("currency").includes(value);
}
export function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
type InvoiceAmounts = {
  invoiceNumber?: string | null; currency: string; total: number;
  subtotal?: number | null; tax?: number | null;
  items: { name: string; quantity: number; price: number; amount?: number | null }[];
};
export function invoiceIssues(invoice: InvoiceAmounts) {
  const issues: string[] = [];
  if (!invoice.invoiceNumber?.trim()) issues.push("Enter an invoice number.");
  if (!validCurrency(invoice.currency)) issues.push("Select a valid invoice currency.");
  if (!Number.isFinite(invoice.total) || invoice.total <= 0) issues.push("Enter a positive invoice total.");
  if (!invoice.items.length) issues.push("Add at least one invoice line.");
  for (const [index, item] of invoice.items.entries()) {
    if (!item.name.trim() || !Number.isFinite(item.quantity) || item.quantity <= 0 ||
        !Number.isFinite(item.price) || item.price < 0) issues.push(`Check description, quantity and unit price on line ${index + 1}.`);
    if (item.amount != null && (!Number.isFinite(item.amount) ||
        Math.abs(roundMoney(item.quantity * item.price) - item.amount) > 0.011)) {
      issues.push(`Line ${index + 1} amount must equal quantity × unit price. Enter a net unit price after discounts.`);
    }
  }
  const sum = roundMoney(invoice.items.reduce((total, item) => total + roundMoney(item.quantity * item.price), 0));
  if (invoice.subtotal != null && (!Number.isFinite(invoice.subtotal) || Math.abs(sum - invoice.subtotal) > 0.011)) {
    issues.push("Line amounts do not match the subtotal. Add freight or other charges as separate lines.");
  }
  if (!Number.isFinite(invoice.tax ?? 0) || (invoice.tax ?? 0) < 0 ||
      Math.abs(roundMoney(sum + (invoice.tax ?? 0)) - invoice.total) > 0.011) {
    issues.push("Net line amounts plus tax must match the invoice total.");
  }
  return issues;
}
export function assertApproved(invoice: { reviewStatus: string; approvedAt?: Date | null }) {
  if (invoice.reviewStatus !== "APPROVED" || !invoice.approvedAt) {
    throw new Error("Review and approve this invoice before exporting or changing Shopify costs.");
  }
}
export function assertCurrencyMatch(invoiceCurrency: string, shopCurrency: string) {
  if (invoiceCurrency !== shopCurrency) throw new Error(`Cost sync requires ${shopCurrency}. This invoice is in ${invoiceCurrency}; currency conversion is not enabled.`);
}
export function currencyTotals(invoices: { currency: string; total: number }[]) {
  return Object.entries(invoices.reduce<Record<string, number>>((totals, invoice) => {
    totals[invoice.currency] = (totals[invoice.currency] || 0) + invoice.total;
    return totals;
  }, {})).map(([currency, total]) => ({ currency, total: roundMoney(total) }));
}
