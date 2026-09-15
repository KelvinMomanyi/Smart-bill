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
  warnings?: string[];
};

const currencyCodes =
  "USD|EUR|GBP|CAD|AUD|NZD|KES|ZAR|NGN|GHS|JPY|CNY|INR|AED|UGX|TZS|RWF|BRL|PHP";
const currencyPattern =
  `(?:(?:${currencyCodes})|R\\$|KSh|[$\\u20ac\\u00a3\\u00a5\\u20b9\\u20a6\\u20b5\\u20b1])?`;
const numberPattern =
  "[+-]?(?:\\d{1,3}(?:[\\s,'’.]\\d{3})+(?:[.,]\\d{1,4})?|\\d+(?:[.,]\\d{1,4})?)";
const moneyPattern = `${currencyPattern}\\s*(${numberPattern})`;

function normalizeOcrDigits(value: string) {
  return value.replace(/[Oo]/g, "0").replace(/[Il|]/g, "1").replace(/[Ss]/g, "5");
}

export function normalizeInvoiceOcrText(text: string) {
  let normalized = text
    .normalize("NFKC")
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\blnvoice\b/gi, "Invoice")
    .replace(/\blnv(?=\s*(?:no\.?|number|#))/gi, "Inv")
    .replace(/\bSubtota[Il|]\b/gi, "Subtotal")
    .replace(/\bTota[Il|]\b/gi, "Total")
    .replace(/\bU(?:5|S)(?:D|O)\b/gi, "USD")
    .replace(/\bKE5\b/gi, "KES")
    .replace(/\bEUR\b/gi, "EUR")
    .replace(/\u00a7(?=\s*[\dOIlS])/g, "$")
    // Tesseract commonly reads a dollar glyph as S immediately before money.
    .replace(
      /(?<![$\u20ac\u00a3\u00a5\u20b9\u20a6\u20b5\u20b1])\bS(?=\s*[\dOIlS]+\s*[.,]\s*[\dOIlS]{1,4}\b)/g,
      "$",
    );

  const currencyMarker =
    `(?:${currencyCodes}|R\\$|KSh|[$\\u20ac\\u00a3\\u00a5\\u20b9\\u20a6\\u20b5\\u20b1])`;
  normalized = normalized.replace(
    new RegExp(
      `(${currencyMarker}\\s*)([\\dOIlS][\\dOIlS\\s,'’.]*(?:[.,]\\s*[\\dOIlS]{1,4}))`,
      "gi",
    ),
    (_match, marker: string, amount: string) =>
      marker + normalizeOcrDigits(amount),
  );

  // Preserve normal prose and identifiers; only repair digit lookalikes on
  // lines whose labels make the value unambiguously monetary.
  normalized = normalized.replace(
    /^(\s*(?:subtotal|sub-total|tax|vat|gst|grand\s+total|invoice\s+total|total|amount\s+due|balance\s+due)\b.*?)([\dOIlS][\dOIlS\s,'’.]*(?:[.,]\s*[\dOIlS]{1,4}))\s*$/gim,
    (_match, label: string, amount: string) =>
      label + normalizeOcrDigits(amount),
  );

  // OCR may leave spaces around a decimal point or comma ("55 . 89").
  for (let pass = 0; pass < 2; pass += 1)
    normalized = normalized.replace(/(\d)\s*([.,])\s*(\d)/g, "$1$2$3");
  return normalized;
}

function parseMoney(value?: string | null) {
  if (!value) return undefined;
  let numeric = value
    .replace(new RegExp(currencyCodes, "gi"), "")
    .replace(/R\$|KSh|[\u20ac\u00a3\u00a5\u20b9\u20a6\u20b5\u20b1$]/gi, "")
    .replace(/[\s'’]/g, "");
  const lastDot = numeric.lastIndexOf(".");
  const lastComma = numeric.lastIndexOf(",");
  const separator = Math.max(lastDot, lastComma);
  const fractionLength = separator >= 0 ? numeric.length - separator - 1 : 0;
  if (separator >= 0 && fractionLength > 0 && fractionLength <= 2) {
    const integer = numeric.slice(0, separator).replace(/[.,]/g, "");
    numeric = integer + "." + numeric.slice(separator + 1);
  } else {
    numeric = numeric.replace(/[.,]/g, "");
  }
  const parsed = Number.parseFloat(numeric);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeDate(raw?: string | null, dateOrder: "DMY" | "MDY" = "DMY") {
  if (!raw) return undefined;

  const trimmed = raw.trim().replace(/,/g, " ");
  const isoMatch = trimmed.match(/\d{4}-\d{1,2}-\d{1,2}/);
  if (isoMatch) {
    const [year, month, day] = isoMatch[0].split("-");
    return checkedDate(year, month, day);
  }

  const slashMatch = trimmed.match(/\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/);
  if (slashMatch) {
    const [first, second, yearPart] = slashMatch[0].split(/[/-]/);
    const year = yearPart.length === 2 ? `20${yearPart}` : yearPart;
    const dayFirst = Number(first) > 12 || (Number(second) <= 12 && dateOrder === "DMY");
    return checkedDate(year, dayFirst ? second : first, dayFirst ? first : second);
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

function checkedDate(year: string, month: string, day: string) {
  const value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
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
  if (/\bNZD\b/i.test(text)) return "NZD";
  if (/\bZAR\b/i.test(text)) return "ZAR";
  if (/\bNGN\b|\u20a6/i.test(text)) return "NGN";
  if (/\bGHS\b|\u20b5/i.test(text)) return "GHS";
  if (/\bCNY\b/i.test(text)) return "CNY";
  if (/\bJPY\b|\u00a5/i.test(text)) return "JPY";
  if (/\bINR\b|\u20b9/i.test(text)) return "INR";
  if (/\bAED\b/i.test(text)) return "AED";
  if (/\bUGX\b/i.test(text)) return "UGX";
  if (/\bTZS\b/i.test(text)) return "TZS";
  if (/\bRWF\b/i.test(text)) return "RWF";
  if (/\bBRL\b|R\$/i.test(text)) return "BRL";
  if (/\bPHP\b|\u20b1/i.test(text)) return "PHP";
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
      `^(.+?)\\s+(\\d+(?:[.,]\\d+)?)\\s+${moneyPattern}\\s+${moneyPattern}$`,
      "i",
    ),
  );

  if (!itemMatch) return null;

  const rawDescription = normalizeItemName(itemMatch[1]);
  const skuMatch = rawDescription.match(/^([A-Z0-9._-]{3,})\s+(.+)$/);
  const quantity = Number.parseFloat(itemMatch[2].replace(",", "."));
  const rate = parseMoney(itemMatch[3]) ?? 0;
  const amount = parseMoney(itemMatch[4]) ?? quantity * rate;
  const description = skuMatch ? skuMatch[2] : rawDescription;

  if (!description || !Number.isFinite(quantity)) return null;

  return {
    sku: skuMatch?.[1],
    name: description,
    description,
    quantity,
    rate,
    price: rate,
    amount,
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

  return items;
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

function findInvoiceDate(lines: string[], dateOrder: "DMY" | "MDY") {
  for (const line of lines) {
    if (/(?:due|payment)\s+date/i.test(line)) continue;

    const labeled = line.match(/(?:invoice\s+date|\bdate)\s*:?\s*(.+)$/i);
    const normalized = normalizeDate(labeled?.[1], dateOrder);
    if (normalized) return normalized;
  }

  return normalizeDate(
    findValue(lines, [
      /\b(\d{4}-\d{1,2}-\d{1,2})\b/,
      /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/,
    ]), dateOrder,
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

export function parseInvoiceText(text: string, dateOrder: "DMY" | "MDY" = "DMY"): ParsedInvoice {
  const normalizedText = normalizeInvoiceOcrText(text);
  const lines = normalizedText
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const dueDate = normalizeDate(
    findValue(lines, [/(?:due\s+date|payment\s+due)\s*:?\s*(.+)$/i]), dateOrder,
  );
  const date = findInvoiceDate(lines, dateOrder);
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
    ) ??
    subtotal ??
    0;
  const vendor = extractVendor(lines);

  return {
    invoiceNumber: findInvoiceNumber(lines),
    date: date || new Date().toISOString().slice(0, 10),
    dueDate,
    billTo: extractBillTo(lines),
    vendor,
    currency: extractCurrency(normalizedText),
    subtotal,
    tax,
    total,
    items: extractItems(lines),
    warnings: date ? [] : ["Invoice date was missing or invalid; confirm the date before approval."],
  };
}
