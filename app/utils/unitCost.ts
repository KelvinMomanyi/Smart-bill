import { lineValue, roundUnit, type LandedCostLine } from "./landedCost";

export type UnitCostInput = {
  line: LandedCostLine;
  // All amounts are in the invoice currency until fxRate is applied.
  allocatedCharge?: number;
  creditAmount?: number;
  fxRate?: number;
  stockUnitsPerBilledUnit?: number;
};

export type UnitCostBreakdown = {
  netLineValue: number;
  allocatedCharge: number;
  convertedValue: number;
  stockUnitsPerBilledUnit: number;
  stockQuantity: number;
  costPerStockUnit: number;
  billToStockFactor: number;
};

export function roundCost(value: number) {
  return roundUnit(value);
}

export function resolveUnitCost({
  line,
  allocatedCharge = 0,
  creditAmount = 0,
  fxRate = 1,
  stockUnitsPerBilledUnit = 1,
}: UnitCostInput): UnitCostBreakdown {
  if (!Number.isFinite(fxRate) || fxRate <= 0)
    throw new Error("Enter a positive exchange rate before syncing costs.");
  if (!Number.isFinite(stockUnitsPerBilledUnit) || stockUnitsPerBilledUnit <= 0)
    throw new Error(
      "Enter how many stock units each billed unit contains before syncing costs.",
    );
  const quantity = Number(line.quantity) || 0;
  const charge = Number.isFinite(allocatedCharge) ? allocatedCharge : 0;
  const credit = Number.isFinite(creditAmount) ? creditAmount : 0;
  const netLineValue = roundUnit(Math.max(0, lineValue(line) - credit));
  const convertedValue = roundUnit((netLineValue + charge) * fxRate);
  const stockQuantity = roundUnit(quantity * stockUnitsPerBilledUnit);
  return {
    netLineValue,
    allocatedCharge: roundUnit(charge),
    convertedValue,
    stockUnitsPerBilledUnit,
    stockQuantity,
    costPerStockUnit:
      stockQuantity > 0 ? roundUnit(convertedValue / stockQuantity) : 0,
    billToStockFactor: roundUnit(stockUnitsPerBilledUnit),
  };
}

// Units a supplier bills in. Only the trailing unit word is trusted, so
// "Box of 12 widgets" reads as a box but "Boxing gloves" stays a count.
const supplierUnitPattern =
  /\b(eaches?|each|ea|units?|pieces?|pcs?|packs?|boxes?|cases?|cartons?|pallets?|containers?|dozens?|gross|reams?|rolls?|kg|kilograms?|g|grams?|lbs?|pounds?|gallons?|litres?|liters?|ltr|metres?|meters?|m)\b\.?(?:\s*(?:of|x|\/|-)\s*\d+)?\s*$/i;

export function normalizeSupplierUnit(value: string) {
  const unit = value.toLowerCase().replace(/[^a-z]/g, "");
  const aliases: Record<string, string> = {
    eaches: "each",
    ea: "each",
    units: "unit",
    pieces: "piece",
    pcs: "piece",
    packs: "pack",
    boxes: "box",
    cases: "case",
    cartons: "carton",
    pallets: "pallet",
    containers: "container",
    dozens: "dozen",
    reams: "ream",
    rolls: "roll",
    kilograms: "kg",
    grams: "g",
    pounds: "lb",
    lbs: "lb",
    gallons: "gallon",
    litres: "litre",
    liters: "litre",
    ltr: "litre",
    metres: "metre",
    meters: "metre",
  };
  return aliases[unit] || unit;
}

export function detectSupplierUnit(name: string): string | null {
  const match = supplierUnitPattern.exec((name || "").trim());
  if (!match) return null;
  return normalizeSupplierUnit(match[1]);
}

export function detectPackSize(name: string, supplierUoM?: string | null) {
  const unit = supplierUoM || detectSupplierUnit(name);
  if (unit === "dozen") return 12;
  if (unit === "gross") return 144;
  const match = (name || "").match(
    /\b(?:pack|box|case|carton|pallet|container)\b\.?\s*(?:of|x|\/|-)\s*(\d+(?:[.,]\d+)?)(?:\s+(?:units?|pieces?|pcs?|each|ea))?\b/i,
  );
  if (!match) return null;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Pack size resolution: an explicit line value wins, then the saved supplier
// mapping, then a pack-sized unit blocks the sync instead of guessing.
export function resolvePackSize(
  item: { supplierUoM?: string | null; packSize?: number | null },
  mappingPackSize?: number | null,
) {
  const explicit = Number(item.packSize);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const mapped = Number(mappingPackSize);
  if (Number.isFinite(mapped) && mapped > 0) return mapped;
  if (needsPackSize(item.supplierUoM))
    throw new Error(
      `This line is billed in ${item.supplierUoM}s. Enter how many stock units one ${item.supplierUoM} contains before syncing costs.`,
    );
  return 1;
}

// Billed units that are not single stock units need a pack size.
export function needsPackSize(supplierUnit: string | null | undefined) {
  if (!supplierUnit) return false;
  return !["each", "ea", "unit", "piece", "pcs", "kg", "g", "lb", "litre", "l", "metre", "m", "hour", "day"].includes(
    supplierUnit.toLowerCase(),
  );
}
