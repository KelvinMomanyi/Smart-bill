import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectPackSize,
  detectSupplierUnit,
  needsPackSize,
  resolvePackSize,
  resolveUnitCost,
} from "../utils/unitCost";
import { fxSummary, resolveFxRate } from "../utils/exchangeRate";

const widget = { id: "a", name: "Widget", quantity: 500, price: 10 };

test("unit cost composes credits, charges, exchange rates and pack sizes", () => {
  const plain = resolveUnitCost({ line: widget });
  assert.equal(plain.costPerStockUnit, 10);
  assert.equal(plain.stockQuantity, 500);

  const withCharge = resolveUnitCost({
    line: widget,
    allocatedCharge: 250,
  });
  assert.equal(withCharge.costPerStockUnit, 10.5);

  const withCredit = resolveUnitCost({
    line: widget,
    creditAmount: 500,
    allocatedCharge: 250,
  });
  assert.equal(withCredit.netLineValue, 4500);
  assert.equal(withCredit.costPerStockUnit, 9.5);

  const withPack = resolveUnitCost({
    line: widget,
    allocatedCharge: 250,
    stockUnitsPerBilledUnit: 12,
  });
  assert.equal(withPack.stockQuantity, 6000);
  assert.equal(withPack.costPerStockUnit, 0.875);

  const withFx = resolveUnitCost({
    line: widget,
    allocatedCharge: 250,
    stockUnitsPerBilledUnit: 12,
    fxRate: 1.35,
  });
  assert.equal(withFx.convertedValue, 7087.5);
  assert.equal(withFx.costPerStockUnit, 1.1813);
});

test("credits cannot push a line value below zero and invalid inputs are rejected", () => {
  assert.equal(
    resolveUnitCost({ line: widget, creditAmount: 99999 }).netLineValue,
    0,
  );
  assert.throws(
    () => resolveUnitCost({ line: widget, stockUnitsPerBilledUnit: 0 }),
    /stock units each billed unit/,
  );
  assert.throws(
    () => resolveUnitCost({ line: widget, fxRate: -1 }),
    /positive exchange rate/,
  );
  assert.equal(resolveUnitCost({ line: { ...widget, quantity: 0 } }).costPerStockUnit, 0);
});

test("supplier units are detected for pack-sized lines only", () => {
  assert.equal(detectSupplierUnit("Widget 500 boxes"), "box");
  assert.equal(detectSupplierUnit("Gadget case of 24"), "case");
  assert.equal(detectSupplierUnit("Copier Paper reams"), "ream");
  assert.equal(detectSupplierUnit("Widget cartons"), "carton");
  assert.equal(detectPackSize("Widget case of 24", "case"), 24);
  assert.equal(detectPackSize("Fasteners gross", "gross"), 144);
  assert.equal(detectSupplierUnit("Widget"), null);
  assert.equal(detectSupplierUnit("Boxing gloves"), null);
  assert.equal(needsPackSize("box"), true);
  assert.equal(needsPackSize("case"), true);
  assert.equal(needsPackSize("each"), false);
  assert.equal(needsPackSize("kg"), false);
  assert.equal(needsPackSize(null), false);
});

test("foreign invoices require a reviewed exchange rate", () => {
  assert.equal(resolveFxRate("USD", "USD", null).problem, "");
  const missing = resolveFxRate("USD", "CAD", null);
  assert.equal(missing.required, true);
  assert.match(missing.problem, /exchange rate/i);
  assert.equal(resolveFxRate("USD", "CAD", 1.35).rate, 1.35);
  assert.match(resolveFxRate("USD", "CAD", 0).problem, /realistic/i);
  assert.equal(
    fxSummary("USD", "CAD", 1.35, "2026-09-01"),
    "1 USD = 1.35 CAD dated 2026-09-01. Shopify costs are written in CAD.",
  );
});
test("pack sizes are reused and unknown pack units block the sync", () => {
  assert.equal(resolvePackSize({}), 1);
  assert.equal(resolvePackSize({ packSize: 12 }), 12);
  assert.equal(resolvePackSize({ supplierUoM: "box" }, 24), 24);
  assert.equal(resolvePackSize({ supplierUoM: "kg" }), 1);
  assert.throws(
    () => resolvePackSize({ supplierUoM: "box" }),
    /billed in boxs?/,
  );
  assert.throws(
    () => resolvePackSize({ supplierUoM: "pallet" }),
    /stock units one pallet contains/,
  );
});
