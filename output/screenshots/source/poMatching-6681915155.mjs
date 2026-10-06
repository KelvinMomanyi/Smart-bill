import { normalizedKey } from "file:///C:/Users/user/Desktop/SMARTBILL/smart-bill/output/screenshots/source/invoiceRules-2420c41cd1.mjs";
export function matchPoLine(item, lines) {
    const matches = lines.filter((line) => item.sku && line.sku
        ? normalizedKey(item.sku) === normalizedKey(line.sku)
        : normalizedKey(item.name) === normalizedKey(line.name));
    return matches.length === 1 ? matches[0] : null;
}
export function receiptStatus(items) {
    if (items.some((item) => item.receivedQty > item.expectedQty + 0.00001))
        return "MISMATCH";
    if (items.length > 0 &&
        items.every((item) => item.receivedQty >= item.expectedQty))
        return "FULFILLED";
    return items.some((item) => item.receivedQty > 0) ? "PARTIAL" : "OPEN";
}
