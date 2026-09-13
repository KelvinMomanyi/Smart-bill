export type ParsedPoItem = {
  sku?: string;
  name: string;
  expectedQty: number;
  expectedRate?: number;
  shopifyProductId?: string;
  shopifyVariantId?: string;
};

function parseNumber(value?: string | number | null) {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (!value) return undefined;

  const parsed = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedQty(value?: string | number | null) {
  const supplied = value != null && String(value).trim() !== "";
  const quantity = parseNumber(value);
  if (quantity == null) {
    if (!supplied) return 1;
    throw new Error("Purchase order quantities must be valid numbers.");
  }
  if (quantity <= 0 || quantity > 1_000_000_000)
    throw new Error(
      "Purchase order quantities must be positive and no more than 1,000,000,000.",
    );
  return quantity;
}

function normalizedRate(value?: string | number | null) {
  if (value == null || String(value).trim() === "") return undefined;
  const rate = parseNumber(value);
  if (rate == null || rate < 0 || rate > 1_000_000_000)
    throw new Error(
      "Purchase order rates must be valid, non-negative numbers no more than 1,000,000,000.",
    );
  return rate;
}

function cleanedText(value?: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseStructuredPoItems(value?: string | null): ParsedPoItem[] {
  if (!value?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
      .map((item): ParsedPoItem | null => {
        const name = cleanedText(item?.name);
        if (!name) return null;

        return {
          sku: cleanedText(item?.sku) || undefined,
          name,
          expectedQty: normalizedQty(item?.expectedQty ?? item?.quantity),
          expectedRate: normalizedRate(item?.expectedRate ?? item?.rate),
          shopifyProductId: cleanedText(item?.shopifyProductId) || undefined,
          shopifyVariantId: cleanedText(item?.shopifyVariantId) || undefined,
        };
      })
      .filter((item): item is ParsedPoItem => Boolean(item));
}

export function parsePoItems(text: string): ParsedPoItem[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): ParsedPoItem | null => {
      const parts = line.includes("|") ? line.split("|") : line.split(",");
      if (parts.length >= 3) {
        const [nameOrSku, qty, rate] = parts.map((part) => part.trim());
        const skuMatch = nameOrSku.match(/^([A-Z0-9._-]{3,})\s+(.+)$/);
        return {
          sku: skuMatch?.[1],
          name: skuMatch?.[2] || nameOrSku,
          expectedQty: normalizedQty(qty),
          expectedRate: normalizedRate(rate),
        };
      }

      const match = line.match(
        /^(.+?)\s+(\d+(?:\.\d+)?)\s+[$\u20ac\u00a3]?\s*([\d,]+(?:\.\d{1,2})?)$/,
      );
      if (!match) return null;

      const rawName = match[1].trim();
      const skuMatch = rawName.match(/^([A-Z0-9._-]{3,})\s+(.+)$/);
      return {
        sku: skuMatch?.[1],
        name: skuMatch?.[2] || rawName,
        expectedQty: normalizedQty(match[2]),
        expectedRate: normalizedRate(match[3]),
      };
    })
    .filter((item): item is ParsedPoItem => Boolean(item?.name));
}
