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
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.replace(/[$,\s]/g, ""));
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

function cleanedText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseStructuredPoItems(value?: string | null): ParsedPoItem[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      "The line items could not be read. Re-enter them and try again.",
    );
  }
  if (!Array.isArray(parsed))
    throw new Error("Add purchase order line items as rows.");
  if (parsed.length > 200)
    throw new Error("A purchase order can contain at most 200 items.");
  return parsed.flatMap((item, index): ParsedPoItem[] => {
    const name = cleanedText(item?.name);
    const sku = cleanedText(item?.sku);
    const quantity = item?.expectedQty ?? item?.quantity;
    const rate = item?.expectedRate ?? item?.rate;
    if (
      !name &&
      !sku &&
      !String(rate ?? "").trim() &&
      (!String(quantity ?? "").trim() || String(quantity) === "1")
    )
      return [];
    if (!name) throw new Error(`Line ${index + 1}: enter an item name.`);
    if (name.length > 500 || sku.length > 200)
      throw new Error(
        `Line ${index + 1}: item names must be 500 characters or fewer and SKUs 200 characters or fewer.`,
      );
    try {
      return [
        {
          sku: sku || undefined,
          name,
          expectedQty: normalizedQty(quantity),
          expectedRate: normalizedRate(rate),
          shopifyProductId: cleanedText(item?.shopifyProductId) || undefined,
          shopifyVariantId: cleanedText(item?.shopifyVariantId) || undefined,
        },
      ];
    } catch (error) {
      throw new Error(
        `Line ${index + 1}: ${error instanceof Error ? error.message : "check quantity and unit cost."}`,
      );
    }
  });
}

function csvCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else cell += character;
  }
  if (quoted) throw new Error("Close the quotation marks in the pasted row.");
  cells.push(cell.trim());
  return cells;
}

export function parsePoItems(text: string): ParsedPoItem[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 200)
    throw new Error("A purchase order can contain at most 200 items.");
  return lines.map((line, index) => {
    try {
      let parts: string[];
      if (line.includes("|"))
        parts = line.split("|").map((part) => part.trim());
      else if (line.includes("\t"))
        parts = line.split("\t").map((part) => part.trim());
      else if (line.includes(",")) parts = csvCells(line);
      else {
        const match = line.match(
          /^(.+?)\s+(\d+(?:\.\d+)?)\s+[$\u20ac\u00a3]?\s*([\d,]+(?:\.\d{1,2})?)$/,
        );
        parts = match ? [match[1].trim(), match[2], match[3]] : [];
      }
      if (parts.length < 2 || parts.length > 3 || !parts[0])
        throw new Error(
          "Use Item name | quantity | unit cost, or three spreadsheet columns. Quote values containing commas in CSV rows.",
        );
      const [nameOrSku, quantity, rate] = parts;
      const skuMatch = nameOrSku.match(/^([A-Z0-9._-]{3,})\s+(.+)$/);
      if (
        (skuMatch?.[2] || nameOrSku).length > 500 ||
        (skuMatch?.[1]?.length || 0) > 200
      )
        throw new Error(
          "Item names must be 500 characters or fewer and SKUs 200 characters or fewer.",
        );
      return {
        sku: skuMatch?.[1],
        name: skuMatch?.[2] || nameOrSku,
        expectedQty: normalizedQty(quantity),
        expectedRate: normalizedRate(rate),
      };
    } catch (error) {
      throw new Error(
        `Pasted line ${index + 1}: ${error instanceof Error ? error.message : "check this row."}`,
      );
    }
  });
}
