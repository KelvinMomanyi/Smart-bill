import { normalizedKey } from "./invoiceRules";
export type MatchLine = {
  sku?: string | null;
  name: string;
  quantity: number;
  price: number;
};
export function matchPoLine(
  item: MatchLine,
  lines: { id: string; sku?: string | null; name: string }[],
) {
  const matches = lines.filter((line) =>
    item.sku && line.sku
      ? normalizedKey(item.sku) === normalizedKey(line.sku)
      : normalizedKey(item.name) === normalizedKey(line.name),
  );
  return matches.length === 1 ? matches[0] : null;
}

export function receiptStatus(
  items: { expectedQty: number; receivedQty: number }[],
) {
  if (
    items.some(
      (item) => item.receivedQty > item.expectedQty + 0.00001,
    )
  )
    return "MISMATCH";
  if (
    items.length > 0 &&
    items.every((item) => item.receivedQty >= item.expectedQty)
  )
    return "FULFILLED";
  return items.some((item) => item.receivedQty > 0) ? "PARTIAL" : "OPEN";
}
