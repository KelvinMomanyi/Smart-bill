export function formatMoney(amount?: number | null, currency = "USD") {
  const safeAmount = amount || 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(safeAmount);
}
// Explicit UTC formatting keeps the server and browser's first render identical.
export function formatTimestamp(value: Date | string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

