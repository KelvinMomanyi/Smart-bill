import {
  detectChargeCategory,
  lineValue,
  type ChargeCategory,
} from "./landedCost";
import {
  detectPackSize,
  detectSupplierUnit,
  normalizeSupplierUnit,
} from "./unitCost";
import { creditNoteSignals } from "./creditNotes";

type ParsedAddress = {
  name: string;
  address?: string;
  email?: string;
  phone?: string;
  taxId?: string;
};

export type ParsedInvoiceItem = {
  sku?: string;
  name: string;
  description: string;
  // Goods are PRODUCT; freight, duty, handling and insurance lines are charges
  // that must be allocated into the landed cost instead of matched to variants.
  category?: ChargeCategory;
  // The unit the supplier billed in, when the line states one, e.g. "boxes".
  supplierUoM?: string;
  packSize?: number;
  quantity: number;
  rate: number;
  price: number;
  amount: number;
  confidence?: number;
};

type ParsedInvoiceItemWithSource = ParsedInvoiceItem & {
  // Kept only while parsing so a missing OCR decimal can be repaired without
  // mistaking a correctly printed value such as "10.00" for the integer 10.
  _rawRate?: string;
  _rawAmount?: string;
};

export type ParsedInvoice = {
  invoiceNumber?: string;
  // Set when the document presents itself as a supplier credit document.
  isCreditDocument?: boolean;
  creditNoteNumber?: string;
  originalInvoiceNumber?: string;
  poNumber?: string;
  date: string;
  dueDate?: string;
  paymentTerms?: string;
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
    // A faint currency glyph is sometimes reduced to a leading "v". It is
    // not reliable enough to identify a currency, but it must not prevent the
    // adjacent amount from being parsed.
    .replace(/\bv(?=\d[\d.,]*\s*$)/gm, "")
    // Tesseract can prepend an S-shaped artifact to a compact service
    // quantity ("S5hrs"). Keep this repair limited to time units so product
    // identifiers such as S500 remain untouched.
    .replace(/\b[Ss](\d+(?:[.,]\d+)?)\s*(hours?|hrs?)\b/g, "$1 $2")
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

  // A faint decimal point can be recognized as whitespace. Restore it only
  // where a currency marker or a monetary summary label makes the two-digit
  // suffix unambiguous ("$9 06" and "Total 9 06").
  normalized = normalized.replace(
    new RegExp(`(${currencyMarker}\\s*[+-]?\\d{1,9})\\s+(\\d{2})(?=\\s|$)`, "gi"),
    "$1.$2",
  );
  normalized = normalized.replace(
    /^(\s*(?:subtotal|sub-total|tax|vat|gst|grand\s+total|invoice\s+total|total|amount\s+due|balance\s+due)\b.*?\d{1,9})\s+(\d{2})\s*$/gim,
    "$1.$2",
  );

  // OCR may leave spaces around a decimal point or comma ("55 . 89").
  for (let pass = 0; pass < 2; pass += 1)
    normalized = normalized.replace(/(\d)\s*([.,])\s*(\d)/g, "$1$2$3");
  return normalized;
}

function parseMoney(value?: string | null, extendedDecimals = false) {
  if (!value) return undefined;
  let numeric = value
    .replace(new RegExp(`\\b(?:${currencyCodes})\\b`, "gi"), "")
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

const monthIndex: Record<string, string> = {
  jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
  apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07", july: "07",
  aug: "08", august: "08", sep: "09", sept: "09", september: "09",
  oct: "10", october: "10", nov: "11", november: "11", dec: "12", december: "12",
};

function fullYear(value: string) {
  return value.length === 2 ? `20${value}` : value;
}

export function normalizeDate(raw?: string | null, dateOrder: "DMY" | "MDY" = "DMY") {
  if (!raw) return undefined;

  const trimmed = raw.trim().replace(/,/g, " ");
  const isoMatch = trimmed.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (isoMatch) return checkedDate(isoMatch[1], isoMatch[2], isoMatch[3]);

  const slashMatch = trimmed.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/);
  if (slashMatch) {
    const [, first, second, yearPart] = slashMatch;
    const year = fullYear(yearPart);
    const dayFirst = Number(first) > 12 || (Number(second) <= 12 && dateOrder === "DMY");
    return checkedDate(year, dayFirst ? second : first, dayFirst ? first : second);
  }

  // Month names are resolved explicitly. Handing them to the Date constructor
  // parses them in the server's local zone, so toISOString then reports the
  // previous day for every store east of UTC.
  const dayMonthYear = trimmed.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?[\s.-]+([A-Za-z]{3,9})\.?[\s.-]+(\d{2,4})\b/i,
  );
  const dayMonth = monthIndex[dayMonthYear?.[2].toLowerCase() || ""];
  if (dayMonthYear && dayMonth)
    return checkedDate(fullYear(dayMonthYear[3]), dayMonth, dayMonthYear[1]);

  const monthDayYear = trimmed.match(
    /\b([A-Za-z]{3,9})\.?[\s.-]+(\d{1,2})(?:st|nd|rd|th)?[\s.-]+(\d{2,4})\b/i,
  );
  const monthDay = monthIndex[monthDayYear?.[1].toLowerCase() || ""];
  if (monthDayYear && monthDay)
    return checkedDate(fullYear(monthDayYear[3]), monthDay, monthDayYear[2]);

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

const currencySymbolClass = "[$\\u20ac\\u00a3\\u00a5\\u20b9\\u20a6\\u20b5\\u20b1]";
const symbolCurrencies: Array<[RegExp, string]> = [
  [/R\$/, "BRL"],
  [/KSh/i, "KES"],
  [/\u20ac/, "EUR"],
  [/\u00a3/, "GBP"],
  [/\u00a5/, "JPY"],
  [/\u20b9/, "INR"],
  [/\u20a6/, "NGN"],
  [/\u20b5/, "GHS"],
  [/\u20b1/, "PHP"],
];

// A three-letter code only names the invoice currency when it sits beside an
// amount. Scanning prose books "PHP development" in pesos and "CAD drawings"
// in Canadian dollars.
const codeBesideMoney = new RegExp(
  `\\b(${currencyCodes})\\b\\s*(?:${currencySymbolClass}\\s*)?[+-]?\\d` +
    `|[+-]?\\d[\\d.,'\u2019\\s]*\\b(${currencyCodes})\\b`,
  "i",
);

function currencyOnLine(line: string | undefined, allowDollar: boolean) {
  if (!line) return undefined;
  const code = line.match(codeBesideMoney);
  if (code) return (code[1] || code[2]).toUpperCase();
  const symbol = symbolCurrencies.find(([pattern]) => pattern.test(line));
  if (symbol) return symbol[1];
  // "$" is shared by several currencies, so it only decides when no code does.
  return allowDollar && /\$\s*[+-]?\d/.test(line) ? "USD" : undefined;
}

function extractCurrency(lines: string[], summaryLines: Array<string | undefined> = []) {
  for (const line of summaryLines) {
    const currency = currencyOnLine(line, true);
    if (currency) return { currency, assumed: false };
  }
  for (const allowDollar of [false, true]) {
    for (const line of lines) {
      const currency = currencyOnLine(line, allowDollar);
      if (currency) return { currency, assumed: false };
    }
  }
  return { currency: "USD", assumed: true };
}

function isLikelyHeader(line: string) {
  return (
    /\b(?:invoices?|receipts?|statements?|dates?|totals?|subtotals?|tax|vat|gst|amount\s+due|bill\s+to|ship\s+to|remit\s+to)\b/i.test(
      line,
    ) || /^page\s+\d+/i.test(line)
  );
}

const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const labelledPhone =
  /\b(?:tel|telephone|phone|mobile|cell|fax|contact)\b\.?\s*[:.]?\s*(\+?\d[\d\s()./-]{6,}\d)/i;
const barePhone = /^\+?\d[\d\s()./-]{7,}\d$/;
const taxIdPattern =
  /\b(?:tax|vat|gst|pin)\s*(?:id|i\.?d\.?|no\.?|num(?:ber)?|reg(?:istration)?(?:\s*(?:no\.?|number))?)\s*[:.]?\s*([A-Z0-9][A-Z0-9/-]{3,})/i;
const otherLabelledField = /^[A-Za-z][\w\s]{0,24}:/;
const contactLabel =
  /^(?:tel|telephone|phone|mobile|cell|fax|e-?mail|web(?:site)?|www\.|https?:|vat|tax|gst|pin|reg(?:istration)?|company\s+(?:no|number|reg)|p\.?\s?o\.?\s*box|attn)\b/i;

function vendorScore(line: string, index: number) {
  if (isLikelyHeader(line) || contactLabel.test(line)) return -1;
  if (emailPattern.test(line) || barePhone.test(line)) return -1;
  // Street numbers and account references are never the trading name.
  if (/^\d/.test(line)) return -1;
  const letters = line.match(/[\p{L}]/gu)?.length || 0;
  if (letters < 3 || letters / line.length < 0.5) return -1;
  let score = 12 - index;
  if (
    /\b(?:ltd|limited|llc|inc|incorporated|corp|corporation|co|company|plc|pty|gmbh|bv|nv|srl|sarl|ag|oy|ab|as|pvt|holdings?|group|services?|solutions?|enterprises?|trading|traders?|supplies|supply|industries|works|studios?|labs?|partners?|associates?|consult(?:ing|ants?))\b\.?$/i.test(
      line,
    )
  )
    score += 25;
  if (/^[^\p{Ll}]+$/u.test(line)) score += 6;
  return score;
}

function vendorRegionEnd(lines: string[]) {
  const stop = lines.findIndex(
    (line, index) =>
      index > 0 &&
      (/\b(?:bill\s+to|ship\s+to|sold\s+to|invoice\s+to|deliver\s+to|customer)\b/i.test(
        line,
      ) ||
        Boolean(itemHeaderHints(line)) ||
        isItemSummaryLine(line)),
  );
  return Math.min(stop < 0 ? lines.length : stop, 20);
}

function extractVendor(lines: string[], regionEnd: number): ParsedAddress {
  // Weak labels such as "from" must carry a separator, or prose like
  // "balance carried from previous invoice" is read as the supplier.
  const labelPattern =
    /^\s*(?:vendor|supplier|seller|from|bill(?:ed)?\s+from|sold\s+by|remit\s+to|company)\s*[:\u2013-]\s*(.+)$/i;
  let nameIndex = -1;
  let name = "";

  for (const [index, line] of lines.entries()) {
    const labelled = line.match(labelPattern)?.[1]?.trim();
    if (labelled) {
      nameIndex = index;
      name = labelled;
      break;
    }
  }

  if (!name) {
    let best = 0;
    for (const [index, line] of lines.slice(0, Math.max(regionEnd, 1)).entries()) {
      const score = vendorScore(line, index);
      if (score > best) {
        best = score;
        nameIndex = index;
        name = line;
      }
    }
  }

  const region = lines.slice(0, Math.max(regionEnd, nameIndex + 1));
  const email = region.find((line) => emailPattern.test(line))?.match(emailPattern)?.[0];
  const phone =
    region.find((line) => labelledPhone.test(line))?.match(labelledPhone)?.[1] ||
    region.find((line) => barePhone.test(line));
  const taxId = region.find((line) => taxIdPattern.test(line))?.match(taxIdPattern)?.[1];

  const address: string[] = [];
  for (let cursor = nameIndex + 1; cursor < region.length && address.length < 4; cursor += 1) {
    const line = region[cursor];
    if (
      emailPattern.test(line) ||
      labelledPhone.test(line) ||
      barePhone.test(line) ||
      taxIdPattern.test(line) ||
      otherLabelledField.test(line) ||
      isLikelyHeader(line) ||
      new RegExp(`^${moneyPattern}$`, "i").test(line) ||
      !/[\p{L}\d]/u.test(line) ||
      line.length > 120
    )
      break;
    address.push(line);
  }

  return {
    name: name || "Unknown Vendor",
    address: address.join(", ") || undefined,
    email,
    phone: phone?.trim(),
    taxId,
  };
}

function extractPaymentTerms(lines: string[]) {
  const labelled = findValue(lines, [
    /\b(?:payment\s+terms?|terms\s+of\s+payment|payment\s+conditions?)\s*[:.\u2013-]\s*(.+)$/i,
    /^\s*terms\s*[:.\u2013-]\s*(.+)$/i,
  ]);
  if (labelled) return labelled.slice(0, 120);
  return lines
    .find((line) =>
      /^\s*(?:net\s*\d{1,3}(?:\s*days?)?|due\s+(?:on|upon)\s+receipt|payable\s+on\s+receipt|cash\s+on\s+delivery|c\.?o\.?d\.?|prepaid|\d{1,2}\s*\/\s*\d{1,2}\s+net\s*\d{1,3})\s*$/i.test(
        line,
      ),
    )
    ?.trim()
    .slice(0, 120);
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
        ) ||
        otherLabelledField.test(nextLine) ||
        new RegExp(`^${moneyPattern}$`, "i").test(nextLine)
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
    .replace(/^\d{1,4}[.)]\s+(?=[\p{L}])/u, "")
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
  "(?:x|ea(?:ch)?|pcs?|pieces?|units?|unit|nos?|sets?|cases?|cartons?|pallets?|containers?|dozens?|gross|reams?|rolls?|kg|g|lb|lbs|hours?|hrs?|days?|boxes?|packs?|gallons?|litres?|liters?|ltr|metres?|meters?)";
const itemUnitPattern =
  `(?:${itemUnitToken}\\.?\\s+)?`;
const rateUnitSuffix = `(?:\\s*(?:/|per\\s+)${itemUnitToken}\\.?)?`;

function isNonItemAdministrativeLine(line: string) {
  return (
    /^(?:bank(?:\s+(?:name|account))?|account(?:\s+(?:name|number|no\.?))?|iban|swift|bic|routing(?:\s+number)?|sort\s+code|payment\s+(?:terms?|instructions?|details?))\b\s*:/i.test(
      line,
    ) ||
    /^(?:signature|authori[sz]ed\s+signatory|if\s+you\s+have\s+any\s+questions?|contact\s+us)\b/i.test(
      line,
    )
  );
}

const columnWords = {
  description:
    "(?:item\\s*)?(?:description|details?|particulars?|goods|narration|articles)|item|product|service",
  quantity: "qty|q\\s*ty|quantity|qty\\s*shipped|pcs",
  rate:
    "rate|price|cost|unit\\s*(?:price|cost|rate|amount|value)|u\\.?\\s*price|price\\s*(?:each|per\\s*unit)|unitprice|list\\s*price|mrp",
  amount:
    "amount|line\\s*(?:total|amount)|ext(?:ended)?\\.?\\s*(?:price|amount)|total\\s*price|net\\s*amount|gross\\s*amount|taxable\\s*value|total\\s*value|value",
};

function itemHeaderHints(line: string): ItemColumnHints | null {
  const lower = line
    .toLowerCase()
    .replace(/[|:_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const description = new RegExp(`\\b(?:${columnWords.description})\\b`).test(lower);
  const quantity = new RegExp(`\\b(?:${columnWords.quantity})\\b`).test(lower);
  const rate = new RegExp(`\\b(?:${columnWords.rate})\\b`).test(lower);
  const amount =
    new RegExp(`\\b(?:${columnWords.amount})\\b`).test(lower) ||
    (/\btotal\b/.test(lower) &&
      (quantity || rate || /^(?:description|item|product|service)\s+total$/.test(lower)));
  const labelOnly = new RegExp(
    `^(?:${columnWords.description}|${columnWords.quantity}|${columnWords.rate}|${columnWords.amount})$`,
    "i",
  ).test(lower);
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

function roundConfidence(value: number) {
  return Math.max(0.05, Math.min(1, Math.round(value * 100) / 100));
}

function buildParsedItem(
  rawDescription: string,
  rawQuantity: string,
  rawRate: string | undefined,
  rawAmount?: string,
  relaxed = false,
): ParsedInvoiceItemWithSource | null {
  const itemName = normalizeItemName(rawDescription);
  const skuMatch = itemName.match(/^([A-Z0-9][A-Z0-9._/-]{2,})\s+(.+)$/);
  // A leading run of digits is a pack size or a line number ("500 Sheets Copier
  // Paper"), not a stock code. Require a letter or an internal separator.
  const sku =
    skuMatch &&
    (/[A-Z]/.test(skuMatch[1]) ||
      (/[._/-]/.test(skuMatch[1]) && !/^\d+$/.test(skuMatch[1])))
      ? skuMatch[1]
      : undefined;
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
  const description = sku ? skuMatch![2] : itemName;

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

  // Every column that had to be inferred rather than read lowers the score the
  // review screen shows against the line.
  const readColumns = Number(parsedRate != null) + Number(parsedAmount != null);
  const confidence = roundConfidence(
    (readColumns === 2 ? 1 : readColumns === 1 ? 0.8 : 0.6) - (relaxed ? 0.1 : 0),
  );

  return {
    sku,
    name: description,
    description,
    quantity,
    rate,
    price: rate,
    amount,
    confidence,
    _rawRate: rawRate,
    _rawAmount: rawAmount,
  };
}

function parseItemLine(
  line: string,
  hints: ItemColumnHints = emptyItemHints(),
  relaxed = false,
): ParsedInvoiceItemWithSource | null {
  const cleanedLine = line
    .replace(/[|]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (
    !cleanedLine ||
    itemHeaderHints(cleanedLine) ||
    isItemSummaryLine(cleanedLine) ||
    isNonItemAdministrativeLine(cleanedLine)
  )
    return null;
  const normalizedRow = cleanedLine.replace(
    new RegExp(
      `(?<!/)\\b(${itemUnitToken})\\.?\\s+(${quantityPattern})(?=\\s+${currencyPattern}\\s*[+-]?\\d)`,
      "i",
    ),
    (_match, unit: string, quantity: string) => `${quantity} ${unit}`,
  );
  const billedUnit = normalizedRow.match(
    new RegExp(
      `\\b${quantityPattern}\\s+(${itemUnitToken})\\.?\\s+(?=${currencyPattern}\\s*[+-]?\\d)`,
      "i",
    ),
  )?.[1];
  const withUnit = (item: ParsedInvoiceItemWithSource | null) => {
    if (!item) return null;
    const supplierUoM = billedUnit
      ? normalizeSupplierUnit(billedUnit)
      : detectSupplierUnit(item.name) || undefined;
    return {
      ...item,
      supplierUoM,
      packSize: detectPackSize(item.name, supplierUoM) || undefined,
    };
  };

  const completeRow = normalizedRow.match(
    new RegExp(
      `^(.+)\\s+(${quantityPattern})\\s+${itemUnitPattern}${moneyPattern}${rateUnitSuffix}\\s+${moneyPattern}$`,
      "i",
    ),
  );
  if (completeRow)
    return withUnit(buildParsedItem(
      completeRow[1],
      completeRow[2],
      completeRow[3],
      completeRow[4],
    ));

  // Tax, discount or accounting-code columns can sit between rate and amount.
  const rowWithExtraColumns = normalizedRow.match(
    new RegExp(
      `^(.+)\\s+(${quantityPattern})\\s+${itemUnitPattern}${moneyPattern}${rateUnitSuffix}\\s+(?:\\S+\\s+){1,3}${moneyPattern}$`,
      "i",
    ),
  );
  if (rowWithExtraColumns)
    return withUnit(buildParsedItem(
      rowWithExtraColumns[1],
      rowWithExtraColumns[2],
      rowWithExtraColumns[3],
      rowWithExtraColumns[4],
    ));

  // Some suppliers put tax or discount codes after the extended amount.
  const trailingCode =
    "(?:\\d+(?:[.,]\\d+)?\\s*%|VAT|GST|TAX|EXEMPT|ZERO(?:\\s+RATED)?|T\\d+)";
  const rowWithTrailingColumns = normalizedRow.match(
    new RegExp(
      `^(.+)\\s+(${quantityPattern})\\s+${itemUnitPattern}${moneyPattern}${rateUnitSuffix}\\s+${moneyPattern}\\s+${trailingCode}(?:\\s+${trailingCode}){0,2}$`,
      "i",
    ),
  );
  if (rowWithTrailingColumns)
    return withUnit(buildParsedItem(
      rowWithTrailingColumns[1],
      rowWithTrailingColumns[2],
      rowWithTrailingColumns[3],
      rowWithTrailingColumns[4],
    ));

  if (!relaxed) return null;

  const quantityAndAmount = normalizedRow.match(
    new RegExp(
      `^(.+)\\s+(${quantityPattern})\\s+${itemUnitPattern}${moneyPattern}$`,
      "i",
    ),
  );
  if (quantityAndAmount && hints.quantity && hints.amount && !hints.rate)
    return withUnit(buildParsedItem(
      quantityAndAmount[1],
      quantityAndAmount[2],
      undefined,
      quantityAndAmount[3],
    ));
  if (quantityAndAmount && hints.quantity && hints.rate && !hints.amount)
    return withUnit(buildParsedItem(
      quantityAndAmount[1],
      quantityAndAmount[2],
      quantityAndAmount[3],
    ));

  const rateAndAmount = normalizedRow.match(
    new RegExp(`^(.+)\\s+${moneyPattern}\\s+${moneyPattern}$`, "i"),
  );
  if (rateAndAmount && !hints.quantity)
    return withUnit(buildParsedItem(
      rateAndAmount[1],
      "1",
      rateAndAmount[2],
      rateAndAmount[3],
    ));

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
  if (new RegExp(`^(?:${columnWords.description})$`, "i").test(normalized))
    return "description" as const;
  if (new RegExp(`^(?:${columnWords.quantity})$`, "i").test(normalized))
    return "quantity" as const;
  if (new RegExp(`^(?:${columnWords.rate})$`, "i").test(normalized))
    return "rate" as const;
  if (new RegExp(`^(?:${columnWords.amount}|total)$`, "i").test(normalized))
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
    if (items.every((item): item is ParsedInvoiceItemWithSource => Boolean(item)))
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
  if (columnMajor.length) return { items: columnMajor, unparsedRows: 0 };

  const items: ParsedInvoiceItemWithSource[] = [];
  let unparsedRows = 0;
  let inItemsSection = false;
  let itemsSectionEnded = false;
  let hints = emptyItemHints();
  let pending: string[] = [];

  for (const line of lines) {
    if (itemsSectionEnded) continue;
    const header = itemHeaderHints(line);
    if (header) {
      inItemsSection = true;
      itemsSectionEnded = false;
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
        else unparsedRows += 1;
      }
      inItemsSection = false;
      itemsSectionEnded = true;
      pending = [];
      continue;
    }

    // A malformed row may be waiting in the buffer. If the current physical
    // OCR line is already a complete item, keep it independent rather than
    // letting the buffered text become part of its description.
    if (pending.length) {
      const direct = parseItemLine(line, hints, inItemsSection);
      if (direct) {
        const buffered = parseItemLine(pending.join(" "), hints, true);
        if (buffered) items.push(buffered);
        else unparsedRows += 1;
        items.push(direct);
        pending = [];
        continue;
      }
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
      if (pending.length > 6) {
        pending = pending.slice(-6);
        unparsedRows += 1;
      }
      continue;
    }

    const strict = itemsSectionEnded ? null : parseItemLine(line);
    if (strict && strict.amount >= strict.price) items.push(strict);
  }

  if (pending.length) unparsedRows += 1;
  return { items, unparsedRows };
}

// Credit note fields use the same "label then value" shape as invoices, but
// the labels differ enough that they need their own pass.
function findCreditField(lines: string[], patterns: RegExp[]) {
  const candidate = findValue(lines, patterns);
  if (!candidate || /^(date|due|total|tax|amount|number|no)$/i.test(candidate))
    return undefined;
  return candidate;
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

type ParsedMoneySource = {
  raw: string;
  value: number;
  line: string;
};

function findMoneyOnLine(
  line?: string,
  options: { excludePercentages?: boolean } = {},
): ParsedMoneySource | undefined {
  if (!line) return undefined;

  const matches = [...line.matchAll(new RegExp(moneyPattern, "gi"))];
  const selected = [...matches].reverse().find((match) => {
    if (!options.excludePercentages) return true;
    const end = (match.index || 0) + match[0].length;
    return !/^\s*%/.test(line.slice(end));
  });
  const raw = selected?.[1];
  const value = parseMoney(raw);
  return raw && value != null ? { raw, value, line } : undefined;
}

function findMoneyByLabel(
  lines: string[],
  labelPattern: RegExp,
  options: {
    reverse?: boolean;
    exclude?: RegExp;
    excludePercentages?: boolean;
  } = {},
) {
  const source = options.reverse ? [...lines].reverse() : lines;
  for (const candidate of source) {
    if (!labelPattern.test(candidate) || options.exclude?.test(candidate))
      continue;
    const value = findMoneyOnLine(candidate, options);
    if (value) return value;
  }
  return undefined;
}

function findPercentageByLabel(lines: string[], labelPattern: RegExp) {
  for (const line of lines) {
    if (!labelPattern.test(line)) continue;
    const raw = line.match(/([+-]?\d+(?:[.,]\d+)?)\s*%/)?.[1];
    const value = parseMoney(raw);
    if (value != null) return value;
  }
  return undefined;
}

function roundParsedMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function moneyDifference(left: number, right: number) {
  return Math.abs(roundParsedMoney(left) - roundParsedMoney(right));
}

function canRestoreDecimal(raw: string | undefined, value: number) {
  if (!raw || !Number.isInteger(value) || Math.abs(value) < 10) return false;
  const compact = raw.replace(/[^\d.,+\s'\u2019-]/g, "");
  return (
    !/[.,\s'\u2019]/.test(compact) &&
    /^[+-]?\d{2,}$/.test(compact)
  );
}

function restoredDecimal(value: number) {
  return Math.round((value / 100 + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function closestPlausibleItemTotal(
  items: ParsedInvoiceItemWithSource[],
  target: number,
) {
  let totals = [0];
  for (const item of items) {
    const amounts = [item.amount];
    const amountCanShift = canRestoreDecimal(item._rawAmount, item.amount);
    const derivedFromRate =
      !item._rawAmount && canRestoreDecimal(item._rawRate, item.rate);
    if (amountCanShift || derivedFromRate)
      amounts.push(restoredDecimal(item.amount));
    totals = [...new Set(totals.flatMap((total) => amounts.map((amount) =>
      roundParsedMoney(total + amount),
    )))]
      .sort(
        (left, right) =>
          moneyDifference(left, target) - moneyDifference(right, target),
      )
      .slice(0, 128);
  }
  return totals.length
    ? Math.min(...totals.map((total) => moneyDifference(total, target)))
    : Number.POSITIVE_INFINITY;
}

type SummaryCandidate = {
  subtotal?: number;
  tax?: number;
  total?: number;
  changes: number;
  error: number;
  constraints: number;
};

function summaryMoneyOptions(source?: ParsedMoneySource) {
  if (!source)
    return [{ value: undefined, shifted: false }] as const;
  const options = [{ value: source.value, shifted: false }];
  if (canRestoreDecimal(source.raw, source.value))
    options.push({ value: restoredDecimal(source.value), shifted: true });
  return options;
}

function repairSummaryDecimals(
  subtotalSource: ParsedMoneySource | undefined,
  taxSource: ParsedMoneySource | undefined,
  totalSource: ParsedMoneySource | undefined,
  items: ParsedInvoiceItemWithSource[],
) {
  const candidates: SummaryCandidate[] = [];
  for (const subtotal of summaryMoneyOptions(subtotalSource))
    for (const tax of summaryMoneyOptions(taxSource))
      for (const total of summaryMoneyOptions(totalSource)) {
        let error = 0;
        let constraints = 0;
        if (subtotal.value != null && total.value != null) {
          error += moneyDifference(
            subtotal.value + (tax.value ?? 0),
            total.value,
          );
          constraints += 1;
        }
        if (items.length && subtotal.value != null) {
          error += closestPlausibleItemTotal(items, subtotal.value);
          constraints += 1;
        } else if (items.length && total.value != null) {
          error += closestPlausibleItemTotal(
            items,
            total.value - (tax.value ?? 0),
          );
          constraints += 1;
        }
        candidates.push({
          subtotal: subtotal.value,
          tax: tax.value,
          total: total.value,
          changes:
            Number(subtotal.shifted) +
            Number(tax.shifted) +
            Number(total.shifted),
          error,
          constraints,
        });
      }

  const baseline = candidates[0];
  const best = [...candidates].sort(
    (left, right) => left.error - right.error || left.changes - right.changes,
  )[0];
  const tolerance = Math.max(0.011, best.constraints * 0.011);
  const corrected =
    best.changes > 0 &&
    best.constraints > 0 &&
    best.error <= tolerance &&
    baseline.error > tolerance;
  return corrected ? { ...best, corrected } : { ...baseline, corrected: false };
}

function itemDecimalVariants(item: ParsedInvoiceItemWithSource) {
  const rateCanShift = canRestoreDecimal(item._rawRate, item.rate);
  const amountCanShift = canRestoreDecimal(item._rawAmount, item.amount);
  const flags: Array<[boolean, boolean]> = [[false, false]];

  if (rateCanShift)
    flags.push(item._rawAmount ? [true, false] : [true, true]);
  if (amountCanShift)
    flags.push(item._rawRate ? [false, true] : [true, true]);
  if (rateCanShift && amountCanShift) flags.push([true, true]);

  const seen = new Set<string>();
  return flags.flatMap(([shiftRate, shiftAmount]) => {
    const rate = shiftRate ? restoredDecimal(item.rate) : item.rate;
    const amount = shiftAmount ? restoredDecimal(item.amount) : item.amount;
    const key = `${rate}|${amount}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      item: { ...item, rate, price: rate, amount },
      changes: Number(shiftRate) + Number(shiftAmount),
      lineError: moneyDifference(item.quantity * rate, amount),
    }];
  });
}

function repairItemDecimals(
  items: ParsedInvoiceItemWithSource[],
  target: number | undefined,
  trustedTarget: boolean,
) {
  if (!items.length) return { items, corrected: false };

  if (!trustedTarget || target == null || target < 0) {
    let corrected = false;
    const locallyRepaired = items.map((item) => {
      const variants = itemDecimalVariants(item).sort(
        (left, right) =>
          left.lineError - right.lineError || left.changes - right.changes,
      );
      const baseline = variants.find((variant) => variant.changes === 0)!;
      const best = variants[0];
      if (
        best.changes > 0 &&
        best.lineError <= 0.011 &&
        baseline.lineError > 0.011
      ) {
        corrected = true;
        return best.item;
      }
      return item;
    });
    return { items: locallyRepaired, corrected };
  }

  type BeamState = {
    items: ParsedInvoiceItemWithSource[];
    total: number;
    lineError: number;
    changes: number;
  };
  let states: BeamState[] = [{ items: [], total: 0, lineError: 0, changes: 0 }];
  for (const item of items) {
    const next = states.flatMap((state) =>
      itemDecimalVariants(item).map((variant) => ({
        items: [...state.items, variant.item],
        total: roundParsedMoney(state.total + variant.item.amount),
        lineError: state.lineError + variant.lineError,
        changes: state.changes + variant.changes,
      })),
    );
    const seen = new Set<string>();
    states = next
      .sort(
        (left, right) =>
          left.lineError * 4 + moneyDifference(left.total, target) * 8 -
            (right.lineError * 4 + moneyDifference(right.total, target) * 8) ||
          left.changes - right.changes,
      )
      .filter((state) => {
        const key = `${state.total}|${roundParsedMoney(state.lineError)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 256);
  }

  const baseline = states.find((state) => state.changes === 0);
  const best = [...states].sort(
    (left, right) =>
      left.lineError * 4 + moneyDifference(left.total, target) * 8 -
        (right.lineError * 4 + moneyDifference(right.total, target) * 8) ||
      left.changes - right.changes,
  )[0];
  const baselineMismatch =
    !baseline ||
    baseline.lineError > 0.011 ||
    moneyDifference(baseline.total, target) > 0.011;
  const corrected =
    best.changes > 0 &&
    baselineMismatch &&
    best.items.every(
      (item) => moneyDifference(item.quantity * item.rate, item.amount) <= 0.011,
    ) &&
    moneyDifference(best.total, target) <= 0.011;
  return corrected ? { items: best.items, corrected } : { items, corrected: false };
}

function withoutItemSource(item: ParsedInvoiceItemWithSource): ParsedInvoiceItem {
  const { _rawRate: _ignoredRate, _rawAmount: _ignoredAmount, ...parsed } = item;
  return parsed;
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
  const subtotalSource = findMoneyByLabel(lines, /(?:subtotal|sub-total)\b/i);
  const taxLabel = /\b(?:tax|vat|gst)\b/i;
  const taxSource = findMoneyByLabel(lines, taxLabel, {
    excludePercentages: true,
  });
  const taxRate = findPercentageByLabel(lines, taxLabel);
  const totalSource = findMoneyByLabel(
    lines,
    /(?:amount\s+due|grand\s+total|balance\s+due|invoice\s+total|\btotal\b)/i,
    {
      exclude: /(?:subtotal|sub-total|tax|vat|gst)/i,
      reverse: true,
    },
  );
  const extractedItems = extractItems(lines);
  const sourceItems = extractedItems.items;
  const summary = repairSummaryDecimals(
    subtotalSource,
    taxSource,
    totalSource,
    sourceItems,
  );
  const subtotal = summary.subtotal;
  const total = summary.total ?? subtotal ?? 0;
  const inferredTax =
    summary.tax == null &&
    subtotal != null &&
    summary.total != null &&
    summary.total >= subtotal &&
    (taxRate != null || moneyDifference(summary.total, subtotal) > 0.011)
      ? roundParsedMoney(summary.total - subtotal)
      : undefined;
  const tax = summary.tax ?? inferredTax;
  const itemTarget = subtotal ?? (summary.total != null ? total - (tax ?? 0) : undefined);
  const targetSource = subtotalSource ?? totalSource;
  const trustedItemTarget =
    summary.corrected || Boolean(targetSource && /[.,]/.test(targetSource.raw));
  const repairedItems = repairItemDecimals(
    sourceItems,
    itemTarget,
    trustedItemTarget,
  );
  const decimalCorrected = summary.corrected || repairedItems.corrected;
  const vendor = extractVendor(lines, vendorRegionEnd(lines));
  const currencyResult = extractCurrency(lines, [
    subtotalSource?.line,
    taxSource?.line,
    totalSource?.line,
  ]);
  const warnings = date
    ? []
    : ["Invoice date was missing or invalid; confirm the date before approval."];
  if (currencyResult.assumed)
    warnings.push(
      "Invoice currency was not found. SmartBill assumed USD; confirm the currency before approval.",
    );
  if (extractedItems.unparsedRows > 0)
    warnings.push(
      `${extractedItems.unparsedRows} row${extractedItems.unparsedRows === 1 ? "" : "s"} inside the item table could not be parsed confidently. Compare every populated line with the original before approval.`,
    );
  if (inferredTax != null)
    warnings.push(
      `${taxRate != null ? "The invoice showed a tax rate but no tax amount." : "The invoice did not show a separate tax amount."} SmartBill inferred ${inferredTax.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} from total minus subtotal; confirm it before approval.`,
    );
  if (taxRate != null && subtotal != null && inferredTax != null) {
    const percentageTax = roundParsedMoney((subtotal * taxRate) / 100);
    if (moneyDifference(percentageTax, inferredTax) > 0.011)
      warnings.push(
        `The printed ${taxRate}% tax equals ${percentageTax.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}, but total minus subtotal is ${inferredTax.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. Confirm the invoice total and tax before approval.`,
      );
  }
  const detectedCharges = repairedItems.items
    .filter((item) => detectChargeCategory(item.name, item.sku))
    .reduce((total, item) => total + lineValue(item), 0);
  if (detectedCharges > 0)
    warnings.push(
      `Detected ${detectedCharges.toFixed(2)} in freight, duty or handling charges. Choose how to allocate them into the landed cost before syncing product costs.`,
    );
  if (decimalCorrected)
    warnings.push(
      "OCR omitted a decimal separator in one or more amounts. SmartBill restored it using the invoice arithmetic; confirm the corrected values before approval.",
    );

  const creditNoteNumber = findCreditField(lines, [
    /\bcredit\s*note\s*(?:number|no\.?|#)\s*:?\s*([A-Z0-9][A-Z0-9._/-]*)/i,
    /\bcredit\s*memo\s*(?:number|no\.?|#)\s*:?\s*([A-Z0-9][A-Z0-9._/-]*)/i,
    /\b(?:document|reference)\s*(?:number|no\.?|#)\s*:?\s*((?:CN|CR|CM|CRN)[\s._-]*\d[A-Z0-9._/-]*)/i,
    /\b((?:CN|CR|CM|CRN)[\s._-]*\d[A-Z0-9._/-]*)\b/,
  ]);
  const originalInvoiceNumber = findCreditField(lines, [
    /\b(?:original\s+|against\s+)?invoice\s*(?:number|no\.?|#)\s*:?\s*([A-Z0-9][A-Z0-9._/-]*)/i,
    /\breference\s*:?\s*(?:invoice\s*)?([A-Z0-9][A-Z0-9._/-]*)/i,
  ]);
  const documentNumber = creditNoteNumber || findInvoiceNumber(lines);
  const isCreditDocument = creditNoteSignals({
    rawText: normalizedText,
    invoiceNumber: documentNumber,
    total: summary.total,
    items: repairedItems.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      price: item.price,
      amount: item.amount,
    })),
  }).detected;
  if (isCreditDocument)
    warnings.push(
      creditNoteNumber
        ? `This looks like credit note ${creditNoteNumber}. Review it against the invoice it credits before it reduces any cost.`
        : "This looks like a supplier credit note. Match it to the invoice it credits before it reduces any cost.",
    );

  return {
    invoiceNumber: documentNumber,
    isCreditDocument,
    creditNoteNumber,
    originalInvoiceNumber,
    date: date || new Date().toISOString().slice(0, 10),
    dueDate,
    paymentTerms: extractPaymentTerms(lines),
    billTo: extractBillTo(lines),
    vendor,
    currency: currencyResult.currency,
    subtotal,
    tax,
    total,
    items: repairedItems.items.map((item) => {
      const category = detectChargeCategory(item.name, item.sku);
      return {
        ...withoutItemSource(item),
        category,
        // Charge lines are allocated into the landed cost, so their unit is
        // never converted into stock units.
        supplierUoM: category
          ? undefined
          : item.supplierUoM || detectSupplierUnit(item.name) || undefined,
        packSize: category ? undefined : item.packSize,
      };
    }),
    warnings,
  };
}
