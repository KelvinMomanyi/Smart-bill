export function formatMoney(amount?: number | null, currency = "USD") {
  const safeAmount = amount || 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(safeAmount);
}
