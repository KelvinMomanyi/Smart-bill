import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeInvoiceOcrText,
  parseInvoiceText,
} from "../utils/parser.server";

test("parseInvoiceText extracts invoice fields and line items", () => {
  const parsed = parseInvoiceText(`
    Supplier: Acme Packaging
    Invoice No: INV-1007
    Invoice Date: 2026-06-10
    Due Date: 2026-07-10

    Description Qty Rate Amount
    PACK-100 Mailer Boxes 12 4.50 54.00
    TAPE-20 Packing Tape 3 6.00 18.00

    Subtotal 72.00
    Tax 7.20
    Total USD 79.20
  `);

  assert.equal(parsed.vendor.name, "Acme Packaging");
  assert.equal(parsed.invoiceNumber, "INV-1007");
  assert.equal(parsed.date, "2026-06-10");
  assert.equal(parsed.dueDate, "2026-07-10");
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.total, 79.2);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].sku, "PACK-100");
  assert.equal(parsed.items[0].quantity, 12);
  assert.equal(parsed.items[0].price, 4.5);
});

test("parseInvoiceText flags incomplete invoices with empty items and zero total", () => {
  const parsed = parseInvoiceText("Invoice\nThank you for your business");

  assert.equal(parsed.invoiceNumber, undefined);
  assert.equal(parsed.total, 0);
  assert.deepEqual(parsed.items, []);
});

test("parseInvoiceText repairs common OCR errors in dollar amounts and labels", () => {
  const source = `
    Supplier: Clearview Studio
    lnvoice No: INV-5589
    Date: 15/09/2026

    Description Qty Rate Amount
    Design services 1 S55 . 89 $SS . 89

    SubtotaI §55,89
    Tax $4.47
    TotaI U5D $60.36
  `;
  const normalized = normalizeInvoiceOcrText(source);
  assert.match(normalized, /Design services 1 \$55\.89 \$55\.89/);
  const parsed = parseInvoiceText(source);

  assert.equal(parsed.invoiceNumber, "INV-5589");
  assert.equal(parsed.date, "2026-09-15");
  assert.equal(parsed.currency, "USD");
  assert.equal(parsed.subtotal, 55.89);
  assert.equal(parsed.tax, 4.47);
  assert.equal(parsed.total, 60.36);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].rate, 55.89);
  assert.equal(parsed.items[0].amount, 55.89);
});

test("parseInvoiceText supports localized decimals, thousands separators, and currencies", () => {
  const parsed = parseInvoiceText(`
    Supplier: Atelier Europe
    Invoice Number: EU-1234
    Invoice Date: 2026-09-15
    Description Qty Rate Amount
    Translation 1 EUR 1.234,56 €1.234,56
    Subtotal €1.234,56
    Total EUR 1.234,56
  `);

  assert.equal(parsed.currency, "EUR");
  assert.equal(parsed.subtotal, 1234.56);
  assert.equal(parsed.total, 1234.56);
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].rate, 1234.56);
  assert.equal(parsed.items[0].amount, 1234.56);
});

test("OCR normalization is conservative outside monetary fields", () => {
  const normalized = normalizeInvoiceOcrText(
    "Invoice No: SOIL-51\nCustomer: Olson Services\nTotal S55.89",
  );
  assert.match(normalized, /SOIL-51/);
  assert.match(normalized, /Olson Services/);
  assert.match(normalized, /Total \$55\.89/);
});
