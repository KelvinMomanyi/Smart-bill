import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allocateCharges,
  allocationSummary,
  detectChargeCategory,
  isChargeLine,
  landedCostIssues,
  landedUnitCost,
  type LandedCostLine,
} from "../utils/landedCost";
import { parseInvoiceText } from "../utils/parser.server";
import { invoiceIssues } from "../utils/invoiceRules";

const lines: LandedCostLine[] = [
  { id: "a", name: "Widget", quantity: 10, price: 10 },
  { id: "b", name: "Gadget", quantity: 5, price: 20 },
  { id: "c", name: "Gizmo", quantity: 1, price: 50 },
];

test("charge lines are detected without swallowing products", () => {
  assert.equal(detectChargeCategory("Freight"), "FREIGHT");
  assert.equal(detectChargeCategory("FREIGHT CHARGES"), "FREIGHT");
  assert.equal(detectChargeCategory("Shipping & handling"), "FREIGHT");
  assert.equal(detectChargeCategory("Delivery fee"), "FREIGHT");
  assert.equal(detectChargeCategory("Customs duty"), "DUTY");
  assert.equal(detectChargeCategory("Import duty 5%"), "DUTY");
  assert.equal(detectChargeCategory("Handling charges - pallet"), "HANDLING");
  assert.equal(detectChargeCategory("Transit insurance"), "INSURANCE");
  assert.equal(detectChargeCategory("Shipping Tape 48mm roll"), undefined);
  assert.equal(detectChargeCategory("Freightliner bracket"), undefined);
  assert.equal(detectChargeCategory("Fabric", "SKU-1"), undefined);
  assert.equal(
    detectChargeCategory("Freight surcharge for oversized pallet of widgets"),
    undefined,
  );
  assert.equal(isChargeLine({ category: "FREIGHT" }), true);
  assert.equal(isChargeLine({ category: "PRODUCT" }), false);
  assert.equal(isChargeLine({ category: null }), false);
});

test("value allocation is proportional and always reconciles to the charge total", () => {
  const result = allocateCharges(lines, 90, "VALUE");
  assert.equal(result.method, "VALUE");
  assert.equal(result.allocatedTotal, 90);
  assert.deepEqual(
    result.allocations.map((item) => item.amount),
    [36, 36, 18],
  );
  assert.equal(result.warnings.length, 0);
});

test("quantity, weight and penny-rounding allocations stay exact", () => {
  const byQuantity = allocateCharges(lines, 16, "QUANTITY");
  assert.deepEqual(
    byQuantity.allocations.map((item) => item.amount),
    [10, 5, 1],
  );
  const byWeight = allocateCharges(
    lines.map((line, index) => ({ ...line, weight: [1, 3, 1][index] })),
    50,
    "WEIGHT",
  );
  assert.deepEqual(
    byWeight.allocations.map((item) => item.amount),
    [10, 30, 10],
  );
  const awkward = allocateCharges(
    [
      { id: "a", quantity: 1, price: 1 },
      { id: "b", quantity: 1, price: 1 },
      { id: "c", quantity: 1, price: 1 },
    ],
    10,
    "VALUE",
  );
  assert.equal(
    awkward.allocations.reduce((sum, item) => sum + item.amount, 0),
    10,
  );
});

test("missing weight falls back to value allocation with a warning", () => {
  const result = allocateCharges(
    lines.map((line, index) => ({ ...line, weight: index === 0 ? 2 : null })),
    90,
    "WEIGHT",
  );
  assert.equal(result.requestedMethod, "WEIGHT");
  assert.equal(result.method, "VALUE");
  assert.deepEqual(
    result.allocations.map((item) => item.amount),
    [36, 36, 18],
  );
  assert.match(result.warnings.join(" "), /weight is missing/i);
});

test("manual allocation is honoured and mismatched totals are rejected", () => {
  const result = allocateCharges(lines, 30, "MANUAL", { a: 10, b: 20, c: 0 });
  assert.equal(result.method, "MANUAL");
  assert.deepEqual(
    result.allocations.map((item) => item.amount),
    [10, 20, 0],
  );
  assert.throws(
    () => allocateCharges(lines, 30, "MANUAL", { a: 10, b: 20, c: 5 }),
    /Manual freight amounts total/,
  );
  assert.throws(
    () => allocateCharges(lines, 30, "MANUAL", { a: -10, b: 40, c: 0 }),
    /zero or greater/,
  );
});

test("mixed allocation preserves manual lines and spreads the remainder", () => {
  const result = allocateCharges(lines, 30, "MANUAL", {
    a: 10,
    b: null,
    c: 5,
  });
  assert.deepEqual(
    result.allocations.map((item) => item.amount),
    [10, 15, 5],
  );
  assert.equal(result.allocatedTotal, 30);
  assert.match(result.warnings.join(" "), /remaining freight/i);
});

test("no charges, or no method chosen, never blocks or invents an allocation", () => {
  const none = allocateCharges(lines, 0, "NONE");
  assert.equal(none.allocatedTotal, 0);
  assert.equal(none.warnings.length, 0);
  assert.equal(
    allocationSummary(none),
    "No freight or charges detected on this invoice.",
  );
  const unallocated = allocateCharges(lines, 25, "NONE");
  assert.equal(unallocated.allocatedTotal, 0);
  assert.match(unallocated.warnings.join(" "), /not allocated/i);
  const noLines = allocateCharges([], 25, "VALUE");
  assert.equal(noLines.allocatedTotal, 0);
});

test("landed unit cost spreads the allocated charge over the billed quantity", () => {
  const [widget] = lines;
  assert.equal(landedUnitCost(widget, 0), 10);
  assert.equal(landedUnitCost(widget, 25), 12.5);
  assert.equal(landedUnitCost({ ...widget, quantity: 3, price: 10 }, 1), 10.3333);
  const summary = allocationSummary(allocateCharges(lines, 90, "VALUE"));
  assert.match(summary, /Allocated 90.00 in freight and charges across 3 lines/i);
});

test("approval requires an allocation method when charges exist", () => {
  const items = [
    ...lines,
    { id: "f", quantity: 1, price: 40, category: "FREIGHT" },
  ];
  assert.deepEqual(landedCostIssues(items, "VALUE"), []);
  assert.match(landedCostIssues(items, "NONE").join(" "), /allocate the freight/i);
  assert.deepEqual(landedCostIssues(lines, "NONE"), []);
  assert.match(
    landedCostIssues(
      [{ id: "f", quantity: 1, price: 0, category: "DUTY" }],
      "VALUE",
    ).join(" "),
    /positive amount/i,
  );
});

test("a parsed freight line becomes a charge that never blocks the subtotal check", () => {
  const parsed = parseInvoiceText(`Supplier: Acme Supplies
Invoice No: INV-500
Invoice Date: 2026-09-01
Description Qty Rate Amount
Widget A 10 10.00 100.00
Freight 1 25.00 25.00
Subtotal 100.00
Tax 10.00
Total USD 135.00`);
  const freight = parsed.items.find((item) => item.category === "FREIGHT");
  assert.ok(freight, "the freight line should be tagged as a charge");
  assert.equal(freight?.amount, 25);
  assert.ok(
    (parsed.warnings || []).some((warning) => /freight/i.test(warning)),
    "the capture should tell the merchant to allocate the charge",
  );
  assert.deepEqual(
    invoiceIssues({ ...parsed, items: parsed.items }),
    [],
    "product lines balance the subtotal and the charge completes the total",
  );
  assert.equal(landedCostIssues(parsed.items, "NONE").length, 1);
  const allocation = allocateCharges(
    parsed.items.filter((item) => !isChargeLine(item)),
    25,
    "VALUE",
  );
  assert.equal(allocation.allocatedTotal, 25);
  assert.equal(
    landedUnitCost(parsed.items.find((item) => !isChargeLine(item))!, 25),
    12.5,
  );
});
