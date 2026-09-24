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

test("parseInvoiceText captures rows with units and tax-code columns", () => {
  const parsed = parseInvoiceText(`
    Supplier: Warehouse Goods
    Invoice No: WG-200
    Date: 2026-09-15
    Item Description | Qty | Unit Price | VAT | Amount
    WGT-3000 Widget 3000 | 2 | EA | $27.945 | 16% | $55.89
    SHIP-1 Delivery Fee | 1 | each | $10.00 | EXEMPT | $10.00
    CASE-5 Storage Case | EA | 2 | $5.00 | $10.00 | VAT | 16%
    Subtotal $75.89
    Tax $10.54
    Total USD $86.43
  `);

  assert.equal(parsed.items.length, 3);
  assert.deepEqual(
    parsed.items.map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      rate: item.rate,
      amount: item.amount,
    })),
    [
      {
        sku: "WGT-3000",
        name: "Widget 3000",
        quantity: 2,
        rate: 27.945,
        amount: 55.89,
      },
      {
        sku: "SHIP-1",
        name: "Delivery Fee",
        quantity: 1,
        rate: 10,
        amount: 10,
      },
      {
        sku: "CASE-5",
        name: "Storage Case",
        quantity: 2,
        rate: 5,
        amount: 10,
      },
    ],
  );
});

test("parseInvoiceText joins descriptions and values wrapped across OCR lines", () => {
  const parsed = parseInvoiceText(`
    Supplier: Support Company
    Invoice No: SC-22
    Date: 2026-09-15
    Description
    Qty
    Unit Price
    Amount
    Annual support and
    implementation package
    2
    $27.945
    $55.89
    Subtotal $55.89
    Total USD $55.89
  `);

  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].name, "Annual support and implementation package");
  assert.equal(parsed.items[0].quantity, 2);
  assert.equal(parsed.items[0].rate, 27.945);
  assert.equal(parsed.items[0].amount, 55.89);
});

test("parseInvoiceText handles amount-only and quantity-plus-amount tables", () => {
  const amountOnly = parseInvoiceText(`
    Invoice No: A-1
    Date: 2026-09-15
    Description Amount
    On-site consultation $55.89
    Total USD $55.89
  `);
  assert.equal(amountOnly.items.length, 1);
  assert.equal(amountOnly.items[0].quantity, 1);
  assert.equal(amountOnly.items[0].rate, 55.89);

  const quantityAndAmount = parseInvoiceText(`
    Invoice No: A-2
    Date: 2026-09-15
    Description Qty Amount
    Printer paper 2 $55.90
    Total USD $55.90
  `);
  assert.equal(quantityAndAmount.items.length, 1);
  assert.equal(quantityAndAmount.items[0].quantity, 2);
  assert.equal(quantityAndAmount.items[0].rate, 27.95);
  assert.equal(quantityAndAmount.items[0].amount, 55.9);
});

test("parseInvoiceText reconstructs column-oriented OCR tables", () => {
  const parsed = parseInvoiceText(`
    Supplier: Column Supply
    Invoice No: COL-90
    Date: 2026-09-15
    Description
    Printer paper
    Packing tape
    Quantity
    2
    3
    Unit Price
    $10.00
    $5.00
    Amount
    $20.00
    $15.00
    Subtotal $35.00
    Total USD $35.00
  `);

  assert.deepEqual(
    parsed.items.map((item) => [
      item.name,
      item.quantity,
      item.rate,
      item.amount,
    ]),
    [
      ["Printer paper", 2, 10, 20],
      ["Packing tape", 3, 5, 15],
    ],
  );
});

test("parseInvoiceText derives omitted line values from the available columns", () => {
  const rateOnly = parseInvoiceText(`
    Invoice No: RATE-1
    Date: 2026-09-15
    Product QTY Unit Rate
    Total Care subscription 2 boxes $27.95
    Total USD $55.90
  `);
  assert.equal(rateOnly.items.length, 1);
  assert.equal(rateOnly.items[0].name, "Total Care subscription");
  assert.equal(rateOnly.items[0].rate, 27.95);
  assert.equal(rateOnly.items[0].amount, 55.9);

  const columnAmountOnly = parseInvoiceText(`
    Invoice No: COL-2
    Date: 2026-09-15
    Description
    Printer paper
    Packing tape
    Quantity
    2
    3
    Amount
    $20.00
    $15.00
    Subtotal $35.00
    Total USD $35.00
  `);
  assert.deepEqual(
    columnAmountOnly.items.map((item) => [item.quantity, item.rate, item.amount]),
    [
      [2, 10, 20],
      [3, 5, 15],
    ],
  );
});

test("line-item rates distinguish extended decimals from thousands groups", () => {
  const parsed = parseInvoiceText(`
    Invoice No: RATE-2
    Date: 2026-09-15
    Description Qty Rate Amount
    Precision component 2 $27.945 $55.89
    Bulk component 2 $1,234 $2,468
    Subtotal $2,523.89
    Total USD $2,523.89
  `);
  assert.equal(parsed.items[0].rate, 27.945);
  assert.equal(parsed.items[0].amount, 55.89);
  assert.equal(parsed.items[1].rate, 1234);
  assert.equal(parsed.items[1].amount, 2468);
});

test("parseInvoiceText reconstructs columns when quantity is omitted", () => {
  const parsed = parseInvoiceText(`
    Invoice No: COL-3
    Date: 2026-09-15
    Description
    Consulting service
    Support plan
    Unit Price
    $55.89
    $20.00
    Amount
    $55.89
    $20.00
    Subtotal $75.89
    Total USD $75.89
  `);
  assert.deepEqual(
    parsed.items.map((item) => [
      item.name,
      item.quantity,
      item.rate,
      item.amount,
    ]),
    [
      ["Consulting service", 1, 55.89, 55.89],
      ["Support plan", 1, 20, 20],
    ],
  );
});

test("parseInvoiceText restores missing decimal points when totals prove the scale", () => {
  const parsed = parseInvoiceText(`
    Supplier: Decimal Supply
    Invoice No: DEC-906
    Date: 2026-09-15
    Description Qty Rate Amount
    Service charge 1 906 906
    Subtotal $9.06
    Total USD $9.06
  `);

  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].rate, 9.06);
  assert.equal(parsed.items[0].amount, 9.06);
  assert.equal(parsed.subtotal, 9.06);
  assert.equal(parsed.total, 9.06);
  assert.ok(parsed.warnings?.some((warning) => /decimal separator/i.test(warning)));
});

test("parseInvoiceText restores missing decimals in quantity and rate arithmetic", () => {
  const parsed = parseInvoiceText(`
    Invoice No: DEC-2
    Date: 2026-09-15
    Description Qty Rate Amount
    Small component 2 453 906
    Subtotal $9.06
    Total USD $9.06
  `);

  assert.equal(parsed.items[0].rate, 4.53);
  assert.equal(parsed.items[0].amount, 9.06);
});

test("parseInvoiceText repairs summary decimals using printed line amounts", () => {
  const parsed = parseInvoiceText(`
    Invoice No: DEC-3
    Date: 2026-09-15
    Description Qty Rate Amount
    Service charge 1 $9.06 $9.06
    Subtotal 906
    Total USD 906
  `);

  assert.equal(parsed.subtotal, 9.06);
  assert.equal(parsed.total, 9.06);
  assert.equal(parsed.items[0].amount, 9.06);
});

test("parseInvoiceText keeps internally consistent integer amounts unchanged", () => {
  const parsed = parseInvoiceText(`
    Invoice No: INT-906
    Date: 2026-09-15
    Description Qty Rate Amount
    Equipment 1 906 906
    Subtotal 906
    Total USD 906
  `);

  assert.equal(parsed.subtotal, 906);
  assert.equal(parsed.total, 906);
  assert.equal(parsed.items[0].rate, 906);
  assert.equal(parsed.items[0].amount, 906);
  assert.equal(parsed.warnings?.some((warning) => /decimal separator/i.test(warning)), false);
});

test("OCR normalization restores a decimal point read as whitespace", () => {
  const normalized = normalizeInvoiceOcrText(
    "Invoice No: SPACE-1\nDate: 2026-09-15\nTotal USD $9 06",
  );
  assert.match(normalized, /\$9\.06/);
  assert.equal(parseInvoiceText(normalized).total, 9.06);
});

test("service rows with per-hour rates stay separate and bank details are excluded", () => {
  const parsed = parseInvoiceText(`
123 Anywhere St., Any City, ST 12345
Tel: +123-456-7890

INVOICE

Invoice No: ABC-OCT22-001 Date: 12 October, 2022
Bill to: Liceria & Co.

123 Anywhere St,
Any City, ST 12345

Tel: +123-456-7890
Email: customer email id

item Description Qty Unit Price Amount
1. Logo Design 2 hrs 2000/hr 4000
2. Advertising Design S5hrs 500/hr 2500
3. Poster Design 4 hrs 1000/hr v4000
4. Brochure Design 5 hrs 2000/hr 10000
Subtotal v20500
Payment Terms: [Payment Tax 10%
terms, such as "Payment due Total 22500
within 30 days"]
Bank Name: Olivia Wilson Signature

Bank Account: 0123 4567 8901

If you have any question please contact : hello@company.com
  `);

  assert.equal(parsed.invoiceNumber, "ABC-OCT22-001");
  assert.equal(parsed.date, "2022-10-12");
  assert.deepEqual(
    parsed.items.map((item) => [
      item.name,
      item.quantity,
      item.rate,
      item.amount,
    ]),
    [
      ["Logo Design", 2, 2000, 4000],
      ["Advertising Design", 5, 500, 2500],
      ["Poster Design", 4, 1000, 4000],
      ["Brochure Design", 5, 2000, 10000],
    ],
  );
  assert.ok(!parsed.items.some((item) => /bank/i.test(item.name)));
  assert.equal(parsed.subtotal, 20500);
  assert.equal(parsed.tax, 2000);
  assert.equal(parsed.total, 22500);
  assert.ok(parsed.warnings?.some((warning) => /10%.*2,050.*2,000/i.test(warning)));
});

test("multi-page item tables continue after page subtotals", () => {
  const parsed = parseInvoiceText(`
Invoice No: MULTI-4
Date: 24 September 2026
Description Qty Unit Price Amount
Brake cables 1 100.00 100.00
Pedal arms 1 30.00 30.00
Workshop labor 3 5.00 15.00
Subtotal 145.00
--- Page 2 ---
Description Qty Unit Price Amount
Cable clips 2 2.50 5.00
Subtotal 150.00
Tax 9.38
Total USD 159.38
  `);

  assert.deepEqual(
    parsed.items.map((item) => [item.name, item.quantity, item.rate, item.amount]),
    [
      ["Brake cables", 1, 100, 100],
      ["Pedal arms", 1, 30, 30],
      ["Workshop labor", 3, 5, 15],
      ["Cable clips", 2, 2.5, 5],
    ],
  );
  assert.equal(parsed.subtotal, 150);
  assert.equal(parsed.tax, 9.38);
  assert.equal(parsed.total, 159.38);
});

test("an unreadable row cannot merge into the next complete item or numeric footer", () => {
  const parsed = parseInvoiceText(`
Invoice No: SAFE-ROWS-1
Date: 23 September 2026
Description Qty Unit Price Amount
Unreadable damaged OCR row without values
Widget replacement 2 units 10.00 20.00
Subtotal 20.00
Total USD 20.00
Payment reference: 111 222 333
Routing number: 444 555 666
  `);

  assert.deepEqual(
    parsed.items.map((item) => [item.name, item.quantity, item.rate, item.amount]),
    [["Widget replacement", 2, 10, 20]],
  );
  assert.ok(parsed.warnings?.some((warning) => /could not be parsed confidently/i.test(warning)));
});
