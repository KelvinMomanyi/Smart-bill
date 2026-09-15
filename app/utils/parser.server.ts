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

function parseMoney(value?: string | null, extendedDecimals = false) {
  if (!value) return undefined;
  let numeric = value
    .replace(new RegExp(currencyCodes, "gi"), "")
    .replace(/R\$|KSh|[\u20ac\u00a3\u00a5\u20b9\u20a6\u20b5\u20b1$]/gi, "")
    .replace(/[\s'’]/g, "");
  const lastDot = numeric.lastIndexOf(".");
  const lastComma = numeric.lastIndexOf(",");
  const separator = Math.max(lastDot, lastComma);
  const fractionLength = separator >= 0 ? numeric.length - separator - 1 : 0;
  if (
    separator >= 0 &&
    fractionLength > 0 &&
    fractionLength <= (extendedDecimals ? 4 : 2)
  ) {
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

type ItemColumnHints = {
  seen: boolean;
  quantity: boolean;
  rate: boolean;
  amount: boolean;
};

const emptyItemHints = (): ItemColumnHints => ({
  seen: false,
  quantity: false,
  rate: false,
  amount: false,
});
const quantityPattern = "\\d+(?:[.,]\\d+)?";
const itemUnitToken =
  "(?:x|ea(?:ch)?|pcs?|pieces?|units?|unit|nos?|sets?|cases?|dozen|kg|g|lb|lbs|hours?|hrs?|days?|boxes?|packs?|litres?|liters?|ltr|metres?|meters?)";
const itemUnitPattern =
  `(?:${itemUnitToken}\\.?\\s+)?`;

function itemHeaderHints(line: string): ItemColumnHints | null {
  const lower = line
    .toLowerCase()
    .replace(/[|:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const description = /\b(?:description|item|product|service|details?)\b/.test(
    lower,
  );
  const quantity = /\b(?:qty|q\s*ty|quantity)\b/.test(lower);
  const rate =
    /\b(?:rate|price|cost|unit\s*(?:price|cost|rate|amount)|price\s*each|unitprice)\b/.test(
      lower,
    );
  const amount =
    /\b(?:amount|line\s*total|extended\s*(?:price|amount)|total\s*price)\b/.test(
      lower,
    ) ||
    (/\btotal\b/.test(lower) &&
      (quantity || rate || /^(?:description|item|product|service)\s+total$/.test(lower)));
  const labelOnly =
    /^(?:item\s*)?(?:description|details?)$|^(?:item|product|service)$|^(?:qty|q\s*ty|quantity)$|^(?:rate|price|cost|unit\s*(?:price|cost|rate|amount)|price\s*each|unitprice)$|^(?:amount|line\s*total|extended\s*(?:price|amount)|total\s*price)$/i.test(
      lower,
    );
  const trailingValue = new RegExp(`${moneyPattern}\\s*$`, "i").test(line);
  if (
    !labelOnly &&
    (trailingValue || !(description && (quantity || rate || amount)))
  )
    return null;
  return { seen: true, quantity, rate, amount };
}

function isItemSummaryLine(line: string) {
  if (
    /^\s*(?:subtotal|sub-total|tax|sales\s+tax|vat|gst|grand\s+total|invoice\s+total|amount\s+due|balance\s+due|net\s+amount)\b/i.test(
      line,
    )
  )
    return true;
  return new RegExp(
    `^\\s*total(?:\\s+(?:before\\s+tax|after\\s+tax))?\\s*:?(?:\\s*$|\\s+(?:${currencyCodes}|R\\$|KSh|[$\\u20ac\\u00a3\\u00a5\\u20b9\\u20a6\\u20b5\\u20b1]|[+-]?\\d))`,
    "i",
  ).test(line);
}

function buildParsedItem(
  rawDescription: string,
  rawQuantity: string,
  rawRate: string | undefined,
  rawAmount?: string,
): ParsedInvoiceItem | null {
  const itemName = normalizeItemName(rawDescription);
  const skuMatch = itemName.match(/^([A-Z0-9._/-]{3,})\s+(.+)$/);
  const quantity = Number.parseFloat(rawQuantity.replace(",", "."));
  const parsedAmount = parseMoney(rawAmount);
  const standardRate = parseMoney(rawRate);
  const extendedRate = parseMoney(rawRate, true);
  let parsedRate = standardRate;
  if (
    standardRate != null &&
    extendedRate != null &&
    standardRate !== extendedRate
  ) {
    if (parsedAmount != null && quantity > 0) {
      const standardDifference = Math.abs(
        standardRate * quantity - parsedAmount,
      );
      const extendedDifference = Math.abs(
        extendedRate * quantity - parsedAmount,
      );
      if (extendedDifference < standardDifference) parsedRate = extendedRate;
    } else {
      const numericRate = rawRate?.replace(/[^\d.,+-]/g, "") || "";
      const separator = Math.max(
        numericRate.lastIndexOf("."),
        numericRate.lastIndexOf(","),
      );
      const integerPart = numericRate
        .slice(0, separator)
        .replace(/[.,+-]/g, "");
      const fractionLength =
        separator >= 0 ? numericRate.length - separator - 1 : 0;
      if (fractionLength === 4 || /^0+$/.test(integerPart))
        parsedRate = extendedRate;
    }
  }
  const amount =
    parsedAmount ??
    (parsedRate != null && quantity > 0 ? parsedRate * quantity : undefined);
  const rate =
    parsedRate ??
    (amount != null && quantity > 0 ? amount / quantity : undefined);
  const description = skuMatch ? skuMatch[2] : itemName;

  if (
    !description ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    quantity > 1_000_000_000 ||
    amount == null ||
    !Number.isFinite(amount) ||
    rate == null ||
    !Number.isFinite(rate)
  )
    return null;

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

function parseItemLine(
  line: string,
  hints: ItemColumnHints = emptyItemHints(),
  relaxed = false,
): ParsedInvoiceItem | null {
  const cleanedLine = line
    .replace(/[|]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (
    !cleanedLine ||
    itemHeaderHints(cleanedLine) ||
    isItemSummaryLine(cleanedLine)
  )
    return null;
  const normalizedRow = cleanedLine.replace(
    new RegExp(
      `\\b(${itemUnitToken})\\.?\\s+(${quantityPattern})(?=\\s+${currencyPattern}\\s*[+-]?\\d)`,
      "i",
    ),
    (_match, unit: string, quantity: string) => `${quantity} ${unit}`,
  );

  const completeRow = normalizedRow.match(
    new RegExp(
      `^(.+)\\s+(${quantityPattern})\\s+${itemUnitPattern}${moneyPattern}\\s+${moneyPattern}$`,
      "i",
    ),
  );
  if (completeRow)
    return buildParsedItem(
      completeRow[1],
      completeRow[2],
      completeRow[3],
      completeRow[4],
    );

  // Tax, discount or accounting-code columns can sit between rate and amount.
  const rowWithExtraColumns = normalizedRow.match(
    new RegExp(
      `^(.+)\\s+(${quantityPattern})\\s+${itemUnitPattern}${moneyPattern}\\s+(?:\\S+\\s+){1,3}${moneyPattern}$`,
      "i",
    ),
  );
  if (rowWithExtraColumns)
    return buildParsedItem(
      rowWithExtraColumns[1],
      rowWithExtraColumns[2],
      rowWithExtraColumns[3],
      rowWithExtraColumns[4],
    );

  // Some suppliers put tax or discount codes after the extended amount.
  const trailingCode =
    "(?:\\d+(?:[.,]\\d+)?\\s*%|VAT|GST|TAX|EXEMPT|ZERO(?:\\s+RATED)?|T\\d+)";
  const rowWithTrailingColumns = normalizedRow.match(
    new RegExp(
      `^(.+)\\s+(${quantityPattern})\\s+${itemUnitPattern}${moneyPattern}\\s+${moneyPattern}\\s+${trailingCode}(?:\\s+${trailingCode}){0,2}$`,
      "i",
    ),
  );
  if (rowWithTrailingColumns)
    return buildParsedItem(
      rowWithTrailingColumns[1],
      rowWithTrailingColumns[2],
      rowWithTrailingColumns[3],
      rowWithTrailingColumns[4],
    );

  if (!relaxed) return null;

  const quantityAndAmount = normalizedRow.match(
    new RegExp(
      `^(.+)\\s+(${quantityPattern})\\s+${itemUnitPattern}${moneyPattern}$`,
      "i",
    ),
  );
  if (quantityAndAmount && hints.quantity && hints.amount && !hints.rate)
    return buildParsedItem(
      quantityAndAmount[1],
      quantityAndAmount[2],
      undefined,
      quantityAndAmount[3],
    );
  if (quantityAndAmount && hints.quantity && hints.rate && !hints.amount)
    return buildParsedItem(
      quantityAndAmount[1],
      quantityAndAmount[2],
      quantityAndAmount[3],
    );

  const rateAndAmount = normalizedRow.match(
    new RegExp(`^(.+)\\s+${moneyPattern}\\s+${moneyPattern}$`, "i"),
  );
  if (rateAndAmount && !hints.quantity)
    return buildParsedItem(
      rateAndAmount[1],
      "1",
      rateAndAmount[2],
      rateAndAmount[3],
    );

  const amountOnly = normalizedRow.match(
    new RegExp(`^(.+)\\s+${moneyPattern}$`, "i"),
  );
  if (amountOnly && (!hints.rate || !hints.quantity))
    return buildParsedItem(
      amountOnly[1],
      "1",
      amountOnly[2],
      amountOnly[2],
    );

  return null;
}

function columnLabel(line: string) {
  const normalized = line
    .toLowerCase()
    .replace(/[|:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /^(?:item\s*)?(?:description|details?)$|^(?:item|product|service)$/.test(
      normalized,
    )
  )
    return "description" as const;
  if (/^(?:qty|q\s*ty|quantity)$/.test(normalized))
    return "quantity" as const;
  if (
    /^(?:rate|price|cost|unit\s*(?:price|cost|rate|amount)|price\s*each|unitprice)$/.test(
      normalized,
    )
  )
    return "rate" as const;
  if (
    /^(?:amount|total|line\s*total|extended\s*(?:price|amount)|total\s*price)$/.test(
      normalized,
    )
  )
    return "amount" as const;
  return undefined;
}

function standaloneQuantity(line: string) {
  const match = line.trim().match(
    new RegExp(
      `^(${quantityPattern})(?:\\s+(?:ea(?:ch)?|pcs?|pieces?|units?|unit|nos?|sets?|cases?|dozen|kg|g|lb|lbs|hours?|hrs?|days?|boxes?|packs?|litres?|liters?|ltr|metres?|meters?)\\.?)?$`,
      "i",
    ),
  );
  return match?.[1];
}

function standaloneMoney(line: string) {
  const match = line.trim().match(new RegExp(`^${moneyPattern}$`, "i"));
  return match?.[1];
}

function extractColumnMajorItems(lines: string[]) {
  for (
    let descriptionIndex = 0;
    descriptionIndex < lines.length;
    descriptionIndex += 1
  ) {
    if (columnLabel(lines[descriptionIndex]) !== "description") continue;
    const amountIndex = lines.findIndex(
      (line, index) =>
        index > descriptionIndex && columnLabel(line) === "amount",
    );
    if (amountIndex < 0) continue;
    const foundRateIndex = lines.findIndex(
      (line, index) =>
        index > descriptionIndex && columnLabel(line) === "rate",
    );
    const rateIndex =
      foundRateIndex >= 0 && foundRateIndex < amountIndex
        ? foundRateIndex
        : -1;
    const foundQuantityIndex = lines.findIndex(
      (line, index) =>
        index > descriptionIndex && columnLabel(line) === "quantity",
    );
    const firstValueColumn = rateIndex >= 0 ? rateIndex : amountIndex;
    const quantityIndex =
      foundQuantityIndex >= 0 && foundQuantityIndex < firstValueColumn
        ? foundQuantityIndex
        : -1;
    const descriptionEnd =
      quantityIndex >= 0 ? quantityIndex : firstValueColumn;
    const endIndex = lines.findIndex(
      (line, index) => index > amountIndex && isItemSummaryLine(line),
    );
    const descriptions = lines
      .slice(descriptionIndex + 1, descriptionEnd)
      .filter((line) => !columnLabel(line) && /[\p{L}]/u.test(line));
    const quantities =
      quantityIndex >= 0
        ? lines
            .slice(quantityIndex + 1, firstValueColumn)
            .map(standaloneQuantity)
            .filter((value): value is string => Boolean(value))
        : descriptions.map(() => "1");
    const rates =
      rateIndex >= 0
        ? lines
            .slice(rateIndex + 1, amountIndex)
            .map(standaloneMoney)
            .filter((value): value is string => Boolean(value))
        : [];
    const amounts = lines
      .slice(amountIndex + 1, endIndex >= 0 ? endIndex : lines.length)
      .map(standaloneMoney)
      .filter((value): value is string => Boolean(value));
    if (
      !descriptions.length ||
      descriptions.length !== quantities.length ||
      descriptions.length !== amounts.length ||
      (rateIndex >= 0 && descriptions.length !== rates.length)
    )
      continue;
    const items = descriptions.map((description, index) =>
      buildParsedItem(
        description,
        quantities[index],
        rateIndex >= 0 ? rates[index] : undefined,
        amounts[index],
      ),
    );
    if (items.every((item): item is ParsedInvoiceItem => Boolean(item)))
      return items;
  }
  return [];
}

function canBufferItemLine(line: string, pending: string[]) {
  if (line.length > 250 || /^---\s*Page\s+\d+\s*---$/i.test(line)) return false;
  if (
    /^(?:invoice|date|due|vendor|supplier|customer|bill\s+to|ship\s+to|po|purchase\s+order)\b.*:/i.test(
      line,
    )
  )
    return false;
  return /[\p{L}]/u.test(line) || pending.length > 0;
}

function extractItems(lines: string[]) {
  const columnMajor = extractColumnMajorItems(lines);
  if (columnMajor.length) return columnMajor;

  const items: ParsedInvoiceItem[] = [];
  let inItemsSection = false;
  let hints = emptyItemHints();
  let pending: string[] = [];

  for (const line of lines) {
    const header = itemHeaderHints(line);
    if (header) {
      inItemsSection = true;
      pending = [];
      hints = {
        seen: true,
        quantity: hints.quantity || header.quantity,
        rate: hints.rate || header.rate,
        amount: hints.amount || header.amount,
      };
      continue;
    }

    if (inItemsSection && isItemSummaryLine(line)) {
      if (pending.length) {
        const incomplete = parseItemLine(
          pending.join(" "),
          { ...hints, rate: false, amount: true },
          true,
        );
        if (incomplete) items.push(incomplete);
      }
      inItemsSection = false;
      pending = [];
      continue;
    }

    const combined = pending.length ? pending.join(" ") + " " + line : line;
    const parsed = parseItemLine(combined, hints, inItemsSection);
    if (parsed) {
      items.push(parsed);
      pending = [];
      continue;
    }

    if (inItemsSection && canBufferItemLine(line, pending)) {
      pending.push(line);
      if (pending.length > 6) pending = pending.slice(-6);
      continue;
    }

    const strict = parseItemLine(line);
    if (strict && strict.amount >= strict.price) items.push(strict);
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
