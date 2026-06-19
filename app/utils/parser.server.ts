type ParsedAddress = {
  name: string;
  address?: string;
};

export type ParsedInvoiceItem = {
  sku?: string;
  name: string;
  description: string;
  quantity: number;
  rate: number;
  price: number;
  amount: number;
  confidence?: number;
};

export type ParsedInvoice = {
  invoiceNumber?: string;
  date: string;
  dueDate?: string;
  billTo: ParsedAddress;
  vendor: ParsedAddress;
  currency: string;
  subtotal?: number;
  tax?: number;
  total: number;
  items: ParsedInvoiceItem[];
};

const currencyPattern = "(?:[$\\u20ac\\u00a3]|KES|USD|EUR|GBP|CAD|AUD)?";
const moneyPattern = `${currencyPattern}\\s*([+-]?\\d[\\d,]*(?:\\.\\d{1,2})?)`;

function parseMoney(value?: string | null) {
  if (!value) return undefined;
  const parsed = Number.parseFloat(
    value.replace(/[$\u20ac\u00a3,\s]|KES|USD|EUR|GBP|CAD|AUD/gi, ""),
  );
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeDate(raw?: string | null) {
  if (!raw) return undefined;

  const trimmed = raw.trim().replace(/,/g, " ");
  const isoMatch = trimmed.match(/\d{4}-\d{1,2}-\d{1,2}/);
  if (isoMatch) return new Date(isoMatch[0]).toISOString().slice(0, 10);

  const slashMatch = trimmed.match(/\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/);
  if (slashMatch) {
    const [first, second, yearPart] = slashMatch[0].split(/[/-]/);
    const year = yearPart.length === 2 ? `20${yearPart}` : yearPart;
    const month = first.padStart(2, "0");
    const day = second.padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const monthNameMatch = trimmed.match(
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}\s+\d{2,4}\b/i,
  );
  const date = new Date(monthNameMatch?.[0] || trimmed);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString().slice(0, 10);
  }

  return undefined;
}

function findValue(lines: string[], patterns: RegExp[]) {
  for (const pattern of patterns) {
    for (const line of lines) {
      const match = line.match(pattern);
      if (match?.[1]) return match[1].trim();
    }
  }

  return undefined;
}

function extractCurrency(text: string) {
  if (/\bKES\b|KSh|Ksh/i.test(text)) return "KES";
  if (/\bEUR\b|\u20ac/i.test(text)) return "EUR";
  if (/\bGBP\b|\u00a3/i.test(text)) return "GBP";
  if (/\bCAD\b/i.test(text)) return "CAD";
  if (/\bAUD\b/i.test(text)) return "AUD";
  return "USD";
}

function isLikelyHeader(line: string) {
  const lower = line.toLowerCase();
  return (
    lower.includes("invoice") ||
    lower.includes("receipt") ||
    lower.includes("statement") ||
    lower.includes("date") ||
    lower.includes("total") ||
    lower.includes("subtotal") ||
    lower.includes("tax") ||
    lower.includes("amount due") ||
    lower.includes("bill to") ||
    lower.includes("ship to") ||
    /^page\s+\d+/.test(lower)
  );
}

function extractVendor(lines: string[]) {
  const labeledVendor = findValue(lines, [
    /(?:vendor|supplier|from|bill\s+from)\s*:?\s*(.+)$/i,
  ]);

  if (labeledVendor) return { name: labeledVendor };

  const firstUsefulLine = lines.find(
    (line) => line.length > 2 && !isLikelyHeader(line),
  );
  return { name: firstUsefulLine || "Unknown Vendor" };
}

function extractBlockAfterLabel(
  lines: string[],
  labelPattern: RegExp,
  maxLines = 4,
) {
  const block: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(labelPattern);
    if (!match) continue;

    if (match[1]?.trim()) block.push(match[1].trim());

    for (
      let cursor = index + 1;
      cursor < lines.length && block.length < maxLines;
      cursor += 1
    ) {
      const nextLine = lines[cursor];
      if (
        /(?:ship\s+to|description|item|qty|quantity|amount|subtotal|total|tax|vat|gst)\b/i.test(
          nextLine,
        )
      )
        break;
      block.push(nextLine);
    }
    break;
  }

  return block;
}

function extractBillTo(lines: string[]) {
  const block = extractBlockAfterLabel(
    lines,
    /(?:bill\s+to|customer)\s*:?\s*(.*)$/i,
  );
  return {
    name: block[0] || "",
    address: block.slice(1).join(", ") || undefined,
  };
}

function normalizeItemName(name: string) {
  return name
    .replace(/\s{2,}/g, " ")
    .replace(/^\W+|\W+$/g, "")
    .trim();
}

function parseItemLine(line: string): ParsedInvoiceItem | null {
  const cleanedLine = line
    .replace(/[|]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (
    /^(?:description|item|sku|qty|quantity|rate|price|amount|total)\b/i.test(
      cleanedLine,
    )
  )
    return null;

  const itemMatch = cleanedLine.match(
    new RegExp(
      `^(.+?)\\s+(\\d+(?:\\.\\d+)?)\\s+${currencyPattern}\\s*([+-]?\\d[\\d,]*(?:\\.\\d{1,2})?)\\s+${moneyPattern}$`,
      "i",
    ),
  );

  if (!itemMatch) return null;

  const rawDescription = normalizeItemName(itemMatch[1]);
  const skuMatch = rawDescription.match(/^([A-Z0-9._-]{3,})\s+(.+)$/);
  const quantity = Number.parseFloat(itemMatch[2]);
  const rate = parseMoney(itemMatch[3]) || 0;
  const amount = parseMoney(itemMatch[4]) || quantity * rate;
  const description = skuMatch ? skuMatch[2] : rawDescription;

  if (!description || !Number.isFinite(quantity)) return null;

  return {
    sku: skuMatch?.[1],
    name: description,
    description,
    quantity: Math.max(1, Math.round(quantity)),
    rate,
    price: rate,
    amount,
    confidence: rate > 0 && amount > 0 ? 0.88 : 0.58,
  };
}

function extractItems(lines: string[]) {
  const items: ParsedInvoiceItem[] = [];
  let inItemsSection = false;

  for (const line of lines) {
    const lower = line.toLowerCase();

    if (
      lower.includes("description") ||
      (lower.includes("qty") && lower.includes("amount")) ||
      (lower.includes("quantity") && lower.includes("amount")) ||
      (lower.includes("item") && lower.includes("total"))
    ) {
      inItemsSection = true;
      continue;
    }

    if (
      inItemsSection &&
      /subtotal|sub-total|tax|vat|gst|balance|amount\s+due|grand\s+total|\btotal\b/i.test(
        line,
      )
    ) {
      inItemsSection = false;
    }

    const parsed = parseItemLine(line);
    if (!parsed) continue;

    if (inItemsSection || parsed.amount >= parsed.price) {
      items.push(parsed);
    }
  }

  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.sku || item.name}-${item.quantity}-${item.price}-${item.amount}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findInvoiceNumber(lines: string[]) {
  const candidate = findValue(lines, [
    /\b(?:invoice|inv)\s*(?:number|no\.?|#)\s*:?\s*([A-Z0-9][A-Z0-9._/-]*)/i,
    /\b(?:document|reference)\s*(?:number|no\.?|#)\s*:?\s*([A-Z0-9][A-Z0-9._/-]*)/i,
  ]);

  if (!candidate || /^(date|due|total|tax|amount)$/i.test(candidate))
    return undefined;
  return candidate;
}

function findInvoiceDate(lines: string[]) {
  for (const line of lines) {
    if (/(?:due|payment)\s+date/i.test(line)) continue;

    const labeled = line.match(/(?:invoice\s+date|\bdate)\s*:?\s*(.+)$/i);
    const normalized = normalizeDate(labeled?.[1]);
    if (normalized) return normalized;
  }

  return normalizeDate(
    findValue(lines, [
      /\b(\d{4}-\d{1,2}-\d{1,2})\b/,
      /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/,
    ]),
  );
}

function findMoneyOnLine(line?: string) {
  if (!line) return undefined;

  const matches = [...line.matchAll(new RegExp(moneyPattern, "gi"))];
  const lastMatch = matches.at(-1);
  return parseMoney(lastMatch?.[1]);
}

function findMoneyByLabel(
  lines: string[],
  labelPattern: RegExp,
  options: { reverse?: boolean; exclude?: RegExp } = {},
) {
  const source = options.reverse ? [...lines].reverse() : lines;
  const line = source.find(
    (candidate) =>
      labelPattern.test(candidate) && !options.exclude?.test(candidate),
  );
  return findMoneyOnLine(line);
}

export function parseInvoiceText(text: string): ParsedInvoice {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const dueDate = normalizeDate(
    findValue(lines, [/(?:due\s+date|payment\s+due)\s*:?\s*(.+)$/i]),
  );
  const date = findInvoiceDate(lines);
  const subtotal = findMoneyByLabel(lines, /(?:subtotal|sub-total)\b/i);
  const tax = findMoneyByLabel(lines, /\b(?:tax|vat|gst)\b/i);
  const total =
    findMoneyByLabel(
      lines,
      /(?:amount\s+due|grand\s+total|balance\s+due|invoice\s+total|\btotal\b)/i,
      {
        exclude: /(?:subtotal|sub-total|tax|vat|gst)/i,
        reverse: true,
      },
    ) ||
    subtotal ||
    0;
  const vendor = extractVendor(lines);

  return {
    invoiceNumber: findInvoiceNumber(lines),
    date: date || new Date().toISOString().slice(0, 10),
    dueDate,
    billTo: extractBillTo(lines),
    vendor,
    currency: extractCurrency(text),
    subtotal,
    tax,
    total,
    items: extractItems(lines),
  };
}
