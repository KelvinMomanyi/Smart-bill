import assert from "node:assert/strict";
import { test } from "node:test";
import { formatForPlatform } from "../utils/accountingFormat";

const invoice = {
  id: "inv_1",
  invoiceNumber: "INV-1007",
  date: new Date("2026-06-10T12:00:00.000Z"),
  dueDate: new Date("2026-07-10T12:00:00.000Z"),
  currency: "USD",
  subtotal: 54,
  tax: 5.4,
  total: 59.4,
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
  const payload = formatForPlatform(invoice, "XERO", {
    xeroAccountCode: "500",
    xeroTaxType: "INPUT",
  });

  assert.equal(payload.Type, "ACCPAY");
  assert.equal(payload.Contact.Name, "Acme Packaging");
  assert.equal(payload.Reference, "PO-44");
  assert.equal(payload.Date, "2026-06-10");
  assert.equal(payload.LineItems[0].UnitAmount, 4.5);
  assert.equal(payload.LineItems[0].AccountCode, "500");
  assert.equal(payload.LineItems[0].TaxType, "INPUT");
});

test("formatForPlatform creates QuickBooks bill payloads", () => {
  const payload = formatForPlatform(invoice, "QUICKBOOKS", {
    quickBooksVendorRef: { value: "42", name: "Acme Packaging" },
    quickBooksExpenseAccountRef: { value: "87", name: "Cost of Goods Sold" },
  }) as any;

  assert.equal(payload.VendorRef.value, "42");
  assert.equal(payload.VendorRef.name, "Acme Packaging");
  assert.equal(payload.DocNumber, "INV-1007");
  assert.equal(payload.TxnDate, "2026-06-10");
  assert.equal(payload.Line[0].Amount, 54);
  assert.equal(payload.Line[0].DetailType, "AccountBasedExpenseLineDetail");
  assert.equal(
    payload.Line[0].AccountBasedExpenseLineDetail.AccountRef.value,
    "87",
  );
});

test("formatForPlatform creates CSV package records", () => {
  const payload = formatForPlatform(invoice, "CSV");

  assert.equal(payload.invoiceNumber, "INV-1007");
  assert.equal(payload.date, "2026-06-10");
  assert.equal(payload.lineItems[0].sku, "PACK-100");
});
