export type InvoiceValues = {
  supplier: string | null;
  invoiceNumber: string | null;
  date: string | null;
  dueDate: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  items: Array<{
    sku: string | null;
    name: string;
    quantity: number;
    price: number;
    amount: number | null;
  }>;
};

export type AccuracyCase = {
  id: string;
  source: string;
  dateOrder: "DMY" | "MDY";
  rawText: string;
  expected: InvoiceValues;
  requiredWarnings?: string[];
};

type FieldCheck = {
  field: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
};

// Explicit null means the original has no value. An omitted expectation must
// fail rather than silently removing that field from the accuracy denominator.
export function validateExpected(value: unknown): asserts value is InvoiceValues {
  if (!value || typeof value !== "object") throw new Error("Expected invoice is required.");
  const record = value as Record<string, unknown>;
  for (const field of ["supplier", "invoiceNumber", "date", "dueDate", "currency"]) {
    if (!(field in record) || (record[field] !== null && (typeof record[field] !== "string" || !String(record[field]).trim()))) {
      throw new Error(`Expected ${field} must be a nonempty string or explicit null.`);
    }
  }
  for (const field of ["subtotal", "tax", "total"]) {
    if (!(field in record) || (record[field] !== null && !Number.isFinite(record[field]))) {
      throw new Error(`Expected ${field} must be finite or explicit null.`);
    }
  }
  if (!Array.isArray(record.items)) throw new Error("Expected items must be an array.");
  for (const item of record.items) {
    if (!item || typeof item.name !== "string" || !item.name.trim() ||
        !("sku" in item) || (item.sku !== null && typeof item.sku !== "string") ||
        !Number.isFinite(item.quantity) || !Number.isFinite(item.price) ||
        !("amount" in item) || (item.amount !== null && !Number.isFinite(item.amount))) {
      throw new Error("Every expected line needs name, sku, quantity, price and amount.");
    }
  }
}

const text = (value: unknown) => typeof value === "string"
  ? value.normalize("NFKC").replace(/\s+/g, " ").trim()
  : value;

export function compareInvoice(
  expected: InvoiceValues,
  actual: InvoiceValues,
  unorderedItems = false,
) {
  validateExpected(expected);
  const checks: FieldCheck[] = [];
  const check = (field: string, wanted: unknown, found: unknown, tolerance = 0) => {
    const pass = typeof wanted === "number"
      ? typeof found === "number" && Number.isFinite(found) && Math.abs(wanted - found) <= tolerance
      : wanted === null ? found === null : text(wanted) === text(found);
    checks.push({ field, expected: wanted, actual: found ?? null, pass });
  };
  for (const field of ["supplier", "invoiceNumber", "date", "dueDate", "currency"] as const) {
    check(field, expected[field], actual[field]);
  }
  for (const field of ["subtotal", "tax", "total"] as const) {
    check(field, expected[field], actual[field], 0.004999);
  }
  check("items.length", expected.items.length, actual.items.length);
  // The database has no line position column. Compare full rows as a multiset
  // there, preserving duplicate rows; UI and parser comparisons preserve order.
  const sorted = (items: InvoiceValues["items"]) => [...items].sort((a, b) =>
    JSON.stringify([a.sku, text(a.name), a.quantity, a.price, a.amount])
      .localeCompare(JSON.stringify([b.sku, text(b.name), b.quantity, b.price, b.amount])),
  );
  const wantedItems = unorderedItems ? sorted(expected.items) : expected.items;
  const actualItems = unorderedItems ? sorted(actual.items) : actual.items;
  wantedItems.forEach((item, index) => {
    const found = actualItems[index];
    for (const field of ["sku", "name", "quantity", "price", "amount"] as const) {
      check(`items[${index}].${field}`, item[field], found?.[field],
        field === "quantity" ? 0.000001 : field === "price" ? 0.000001 : field === "amount" ? 0.004999 : 0);
    }
  });
  const failures = checks.filter((entry) => !entry.pass);
  return {
    result: failures.length ? "FAIL" as const : "PASS" as const,
    checkedFields: checks.length,
    matchedFields: checks.length - failures.length,
    fieldAccuracyPercent: Number(((checks.length - failures.length) * 100 / checks.length).toFixed(2)),
    failures,
  };
}

export function parsedValues(parsed: {
  vendor: { name: string }; invoiceNumber?: string; date: string; dueDate?: string;
  currency: string; subtotal?: number; tax?: number; total: number;
  items: Array<{ sku?: string; name: string; quantity: number; price: number; amount: number }>;
}): InvoiceValues {
  return {
    supplier: parsed.vendor.name || null,
    invoiceNumber: parsed.invoiceNumber ?? null,
    date: parsed.date,
    dueDate: parsed.dueDate ?? null,
    currency: parsed.currency,
    subtotal: parsed.subtotal ?? null,
    tax: parsed.tax ?? null,
    total: parsed.total,
    items: parsed.items.map((item) => ({
      sku: item.sku ?? null, name: item.name, quantity: item.quantity,
      price: item.price, amount: item.amount,
    })),
  };
}

export function liveAccuracyStatus(revision: number, originalUiPass: boolean | null, networkPass: boolean, databasePass: boolean) {
  // Current reviewed values can never retroactively prove initial OCR accuracy.
  if (originalUiPass === null || revision !== 0) return "UNVERIFIED";
  return originalUiPass && networkPass && databasePass ? "PASS" : "FAIL";
}
