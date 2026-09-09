import assert from "node:assert/strict";
import { test } from "node:test";
import {
  invoiceIssues,
  assertApproved,
  assertCurrencyMatch,
  currencyTotals,
  validDate,
} from "../utils/invoiceRules";
import { normalizeDate, parseInvoiceText } from "../utils/parser.server";
import { parseStructuredPoItems } from "../utils/poItems.server";
import { matchPoLine } from "../utils/poMatching";
import { allocateTax, formatForPlatform } from "../utils/accountingFormat";
import {
  PLANS,
  planFromName,
  usageAvailable,
  usageMonth,
} from "../utils/plans";
import { csvCell } from "../utils/csv";
import { validateDocument } from "../utils/upload.server";

const invoice = {
  invoiceNumber: "INV-22",
  currency: "KES",
  subtotal: 250,
  tax: 40,
  total: 290,
  items: [{ name: "Fabric", quantity: 2.5, price: 100, amount: 250 }],
};
test("balanced invoices accept fractional quantities and reject mismatched amounts", () => {
  assert.deepEqual(invoiceIssues(invoice), []);
  assert.ok(invoiceIssues({ ...invoice, total: 289 }).length);
  assert.ok(invoiceIssues({ ...invoice, subtotal: 200 }).length);
  assert.ok(
    invoiceIssues({ ...invoice, items: [{ ...invoice.items[0], amount: 260 }] })
      .length,
  );
});
test("invalid amounts, currencies and missing invoice identifiers cannot pass review", () => {
  for (const patch of [
    { total: NaN },
    { tax: -1 },
    { currency: "XYZ" },
    { invoiceNumber: "" },
    { items: [] },
  ]) {
    assert.ok(invoiceIssues({ ...invoice, ...patch }).length);
  }
});
test("approval timestamp and status are both necessary for financial operations", () => {
  assert.throws(() => assertApproved({ reviewStatus: "APPROVED" }));
  assert.throws(() =>
    assertApproved({ reviewStatus: "PENDING_REVIEW", approvedAt: new Date() }),
  );
  assert.doesNotThrow(() =>
    assertApproved({ reviewStatus: "APPROVED", approvedAt: new Date() }),
  );
  assert.throws(() => assertCurrencyMatch("USD", "KES"));
  assert.doesNotThrow(() => assertCurrencyMatch("KES", "KES"));
});
test("dates honor a store's numeric date order and reject impossible dates", () => {
  assert.equal(normalizeDate("04/05/2026", "DMY"), "2026-05-04");
  assert.equal(normalizeDate("04/05/2026", "MDY"), "2026-04-05");
  assert.equal(validDate("2026-02-30"), false);
  assert.equal(validDate("2024-02-29"), true);
  assert.equal(normalizeDate("2026-02-30"), undefined);
});
test("capture preserves two identical fractional invoice lines", () => {
  const parsed = parseInvoiceText(`Supplier: Fabric Store
Invoice No: F-11
Invoice Date: 2026-09-08
Description Qty Rate Amount
FAB-1 Fabric 2.5 100.00 250.00
FAB-1 Fabric 2.5 100.00 250.00
Subtotal 500.00
Tax 80.00
Total KES 580.00`);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].quantity, 2.5);
});
test("purchase order entry preserves fractional quantities", () => {
  const items = parseStructuredPoItems(
    JSON.stringify([
      { name: "Fabric", expectedQty: "2.5", expectedRate: "100" },
    ]),
  );
  assert.equal(items[0].expectedQty, 2.5);
});
test("PO matching rejects ambiguous descriptions and mismatched supplier SKUs", () => {
  const item = { name: "Fabric", sku: "FAB-1", quantity: 2.5, price: 100 };
  assert.equal(
    matchPoLine(item, [{ id: "a", name: "Fabric", sku: "FAB-2" }]),
    null,
  );
  assert.equal(
    matchPoLine({ ...item, sku: null }, [
      { id: "a", name: "Fabric" },
      { id: "b", name: "Fabric" },
    ]),
    null,
  );
  assert.equal(
    matchPoLine(item, [{ id: "a", name: "Cloth", sku: "fab-1 " }])?.id,
    "a",
  );
});
test("reports keep currencies separate instead of adding unlike amounts", () => {
  assert.deepEqual(
    currencyTotals([
      { currency: "KES", total: 100 },
      { currency: "USD", total: 10 },
      { currency: "KES", total: 50 },
    ]),
    [
      { currency: "KES", total: 150 },
      { currency: "USD", total: 10 },
    ],
  );
});
test("Xero proportional tax allocation preserves the exact total", () => {
  for (const tax of [0.01, 0.02, 1, 7.21]) {
    const parts = allocateTax(tax, [1, 1, 1]);
    assert.equal(
      Math.round(parts.reduce((sum, part) => sum + part, 0) * 100),
      Math.round(tax * 100),
    );
    assert.ok(parts.every((p) => p >= 0));
  }
  const payload = formatForPlatform(
    { ...invoice, date: new Date(), vendor: { name: "Fabric Store" } },
    "XERO",
    { xeroAccountCode: "300", xeroTaxType: "INPUT" },
  );
  assert.equal(payload.LineItems[0].TaxAmount, 40);
});
test("plan boundaries enforce the advertised allowance and use UTC calendar months", () => {
  assert.equal(PLANS.STARTER.price, 19);
  assert.equal(PLANS.GROWTH.price, 49);
  assert.equal(planFromName("SmartBill Scale"), null);
  assert.equal(usageAvailable("STARTER", 49), true);
  assert.equal(usageAvailable("STARTER", 50), false);
  assert.equal(usageAvailable("GROWTH", 249, 2), false);
  assert.equal(usageAvailable("GROWTH", 1, -1), false);
  assert.equal(usageMonth(new Date("2026-10-01T01:00:00+03:00")), "2026-09");
});
test("CSV escapes quotes, newlines and supplier-provided spreadsheet formulas", () => {
  assert.equal(csvCell('Vendor "A"\nLtd'), '"Vendor ""A""\nLtd"');
  assert.equal(csvCell("=1+1"), '"\'=1+1"');
  assert.equal(csvCell(" +SUM(A1:A2)"), '"\' +SUM(A1:A2)"');
  assert.equal(csvCell(-2), '"-2"');
});
test("file capture rejects spoofed documents and files above the size limit", () => {
  assert.equal(
    validateDocument(Buffer.from("%PDF-1.7"), "invoice.pdf", "application/pdf"),
    "application/pdf",
  );
  assert.throws(() =>
    validateDocument(
      Buffer.from("<script>alert(1)</script>"),
      "invoice.pdf",
      "application/pdf",
    ),
  );
  assert.throws(() =>
    validateDocument(
      Buffer.alloc(10 * 1024 * 1024 + 1),
      "invoice.pdf",
      "application/pdf",
    ),
  );
});
