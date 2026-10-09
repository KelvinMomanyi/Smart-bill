import assert from "node:assert/strict";
import { test } from "node:test";
import cases from "../../scripts/ocr-accuracy/cases.json";
import { compareInvoice, liveAccuracyStatus, parsedValues, validateExpected, type InvoiceValues } from "../../scripts/ocr-accuracy/evaluate";
import { parseInvoiceText } from "../utils/parser.server";

for (const fixture of cases) {
  test(`OCR accuracy corpus: ${fixture.id}`, () => {
    validateExpected(fixture.expected);
    const parsed = parseInvoiceText(fixture.rawText, fixture.dateOrder as "DMY" | "MDY");
    const result = compareInvoice(fixture.expected, parsedValues(parsed));
    assert.deepEqual(result.failures, []);
    for (const pattern of "requiredWarnings" in fixture ? fixture.requiredWarnings || [] : []) {
      assert.ok(parsed.warnings?.some((warning) => new RegExp(pattern, "i").test(warning)));
    }
  });
}

const expected: InvoiceValues = structuredClone(cases[0].expected);

test("accuracy check catches missing and extra lines even when invoice totals match", () => {
  for (const mutation of ["missing", "extra"]) {
    const actual = structuredClone(expected);
    if (mutation === "missing") actual.items.pop();
    else actual.items.push({ ...actual.items[0] });
    assert.equal(compareInvoice(expected, actual).result, "FAIL");
  }
});

test("accuracy check catches digit errors, swapped quantity/price and fractional precision loss", () => {
  const wrongId = structuredClone(expected);
  wrongId.invoiceNumber = "1000I";
  assert.equal(compareInvoice(expected, wrongId).result, "FAIL");
  const swapped = structuredClone(expected);
  [swapped.items[0].quantity, swapped.items[0].price] = [swapped.items[0].price, swapped.items[0].quantity];
  assert.equal(compareInvoice(expected, swapped).result, "FAIL");
  const rounded = structuredClone(cases[3].expected);
  rounded.items[0].price = 27.95;
  assert.equal(compareInvoice(cases[3].expected, rounded).result, "FAIL");
});

test("accuracy tolerates floating arithmetic but fails a one-cent monetary discrepancy", () => {
  const actual = structuredClone(expected);
  assert.ok(actual.total !== null);
  actual.total += Number.EPSILON * actual.total;
  assert.equal(compareInvoice(expected, actual).result, "PASS");
  actual.total += 0.01;
  assert.equal(compareInvoice(expected, actual).result, "FAIL");
});

test("absence, zero, nonfinite numbers and missing expectations are distinct", () => {
  const actual = structuredClone(expected);
  actual.dueDate = "2026-10-09";
  actual.tax = 0;
  actual.total = NaN;
  assert.equal(compareInvoice(expected, actual).failures.length, 3);
  const incomplete: any = structuredClone(expected);
  delete incomplete.tax;
  assert.throws(() => compareInvoice(incomplete, expected), /Expected tax/);
  delete incomplete.items[0].amount;
  incomplete.tax = expected.tax;
  assert.throws(() => compareInvoice(incomplete, expected), /Every expected line/);
});

test("database comparison preserves duplicate rows and can ignore unspecified database row order", () => {
  const actual = structuredClone(expected);
  actual.items.reverse();
  assert.equal(compareInvoice(expected, actual).result, "FAIL");
  assert.equal(compareInvoice(expected, actual, true).result, "PASS");
  actual.items[0] = { ...actual.items[1] };
  assert.equal(compareInvoice(expected, actual, true).result, "FAIL");
});

test("reviewed invoices and unobserved UI cannot be credited as accurate original OCR", () => {
  assert.equal(liveAccuracyStatus(2, true, true, true), "UNVERIFIED");
  assert.equal(liveAccuracyStatus(0, null, true, true), "UNVERIFIED");
  assert.equal(liveAccuracyStatus(0, false, true, true), "FAIL");
  assert.equal(liveAccuracyStatus(0, true, false, true), "FAIL");
  assert.equal(liveAccuracyStatus(0, true, true, false), "FAIL");
  assert.equal(liveAccuracyStatus(0, true, true, true), "PASS");
});

test("missing dates and currency remain flagged even if parser supplies defaults", () => {
  const parsed = parseInvoiceText("Supplier: Acme\nInvoice No: MISSING-1\nWidget 1 10.00 10.00\nTotal 10.00");
  assert.ok(parsed.warnings?.some((warning) => /date was missing or invalid/i.test(warning)));
  assert.ok(parsed.warnings?.some((warning) => /currency was not found/i.test(warning)));
});
