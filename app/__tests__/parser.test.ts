import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvoiceText } from "../utils/parser.server";

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
