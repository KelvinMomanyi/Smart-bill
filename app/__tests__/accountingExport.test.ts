import assert from "node:assert/strict";
import { test } from "node:test";
import { formatForPlatform } from "../services/accountingExport.server";

const invoice = {
  id: "inv_1",
  invoiceNumber: "INV-1007",
  date: new Date("2026-06-10T12:00:00.000Z"),
  dueDate: new Date("2026-07-10T12:00:00.000Z"),
  currency: "USD",
  subtotal: 72,
  tax: 7.2,
  total: 79.2,
  vendor: { name: "Acme Packaging" },
  purchaseOrder: { poNumber: "PO-44" },
  items: [
    {
      sku: "PACK-100",
      name: "Mailer Boxes",
      quantity: 12,
      price: 4.5,
      amount: 54,
    },
  ],
};

test("formatForPlatform creates Xero accounts payable invoice payloads", () => {
  const payload = formatForPlatform(invoice, "XERO");

  assert.equal(payload.Type, "ACCPAY");
  assert.equal(payload.Contact.Name, "Acme Packaging");
  assert.equal(payload.Reference, "PO-44");
  assert.equal(payload.DateString, "2026-06-10");
  assert.equal(payload.LineItems[0].UnitAmount, 4.5);
});

test("formatForPlatform creates QuickBooks bill payloads", () => {
  const payload = formatForPlatform(invoice, "QUICKBOOKS");

  assert.equal(payload.VendorRef.name, "Acme Packaging");
  assert.equal(payload.DocNumber, "INV-1007");
  assert.equal(payload.TxnDate, "2026-06-10");
  assert.equal(payload.Line[0].Amount, 54);
});

test("formatForPlatform creates CSV package records", () => {
  const payload = formatForPlatform(invoice, "CSV");

  assert.equal(payload.invoiceNumber, "INV-1007");
  assert.equal(payload.date, "2026-06-10");
  assert.equal(payload.lineItems[0].sku, "PACK-100");
});
