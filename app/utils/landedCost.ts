export const CHARGE_CATEGORIES = [
  "PRODUCT",
  "FREIGHT",
  "DUTY",
  "HANDLING",
  "INSURANCE",
  "OTHER",
] as const;
export type ChargeCategory = (typeof CHARGE_CATEGORIES)[number];

export const CHARGE_CATEGORY_LABELS: Record<ChargeCategory, string> = {
  PRODUCT: "Product",
  FREIGHT: "Freight",
  DUTY: "Duty / customs",
  HANDLING: "Handling",
  INSURANCE: "Insurance",
  OTHER: "Other charge",
};

export const LANDED_COST_METHODS = [
  "NONE",
  "VALUE",
  "QUANTITY",
  "WEIGHT",
  "MANUAL",
] as const;
export type LandedCostMethod = (typeof LANDED_COST_METHODS)[number];

export const LANDED_COST_METHOD_LABELS: Record<LandedCostMethod, string> = {
  NONE: "Do not allocate",
  VALUE: "By line value",
  QUANTITY: "By quantity",
  WEIGHT: "By product weight",
  MANUAL: "Manual amounts",
};

export type LandedCostLine = {
  // Optional so callers that only need issue detection can pass plain rows.
  id?: string;
  name?: string;
  quantity: number;
  price: number;
  amount?: number | null;
  category?: string | null;
  weight?: number | null;
};

export type ChargeAllocation = {
  lineId: string;
  amount: number;
  unitAmount: number;
};

export type AllocationResult = {
  requestedMethod: LandedCostMethod;
  method: LandedCostMethod;
  totalCharge: number;
  allocatedTotal: number;
  allocations: ChargeAllocation[];
  warnings: string[];
};

export function isChargeCategory(value: unknown): value is ChargeCategory {
  return CHARGE_CATEGORIES.includes(value as ChargeCategory);
}

export function isLandedCostMethod(value: unknown): value is LandedCostMethod {
  return LANDED_COST_METHODS.includes(value as LandedCostMethod);
}

export function isChargeLine(line: { category?: string | null }) {
  return Boolean(line.category && line.category !== "PRODUCT" && isChargeCategory(line.category));
}

export function lineValue(line: { quantity: number; price: number; amount?: number | null }) {
  const value = line.amount != null ? line.amount : line.quantity * line.price;
  return Number.isFinite(value) ? value : 0;
}

export function roundUnit(value: number) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

const chargePatterns: Array<[RegExp, ChargeCategory]> = [
  [/\b(?:freight|shipping|delivery|carriage|transport|haulage)\b/i, "FREIGHT"],
  [/\b(?:duty|duties|customs|import\s+(?:duty|charges?)|clearance|tariff)\b/i, "DUTY"],
  [/\b(?:handling|packing|loading|unloading|pallet)\b/i, "HANDLING"],
  [/\b(?:insurance|transit\s+insurance)\b/i, "INSURANCE"],
];

// Words that may follow a charge keyword without turning the line into a product.
const chargeQualifiers = new Set([
  "charge", "charges", "fee", "fees", "cost", "costs", "expense", "expenses",
  "total", "surcharge", "surcharges", "levy", "levies", "duty", "duties",
  "tax", "vat", "service", "services", "and", "&", "+", "/", "-", "on", "for",
  "the", "import", "imports", "clearance", "handling", "insurance", "shipping",
  "freight", "delivery", "transport", "customs", "tariff", "pallet", "packing",
  "loading", "unloading", "inbound", "outbound", "air", "sea", "road",
]);

function isChargeTail(tail: string) {
  const words = tail.trim().split(/\s+/).filter(Boolean);
  return words.every((word) => {
    if (/^[$\u20ac\u00a3]?\d[\d.,]*%?$/.test(word)) return true;
    return chargeQualifiers.has(word.toLowerCase().replace(/[^a-z&+/-]/g, ""));
  });
}

// Freight, duty, handling and insurance lines are charges, not stock.
// A line carrying a SKU is always treated as goods, and the text after the
// keyword must look like a charge qualifier so "Shipping tape 48mm" stays a
// product.
export function detectChargeCategory(
  name: string,
  sku?: string | null,
): ChargeCategory | undefined {
  if (sku?.trim()) return undefined;
  const text = (name || "").trim().replace(/\s+/g, " ");
  if (!text || text.length > 60) return undefined;
  for (const [pattern, category] of chargePatterns) {
    const match = pattern.exec(text);
    if (
      match &&
      isChargeTail(text.slice(0, match.index)) &&
      isChargeTail(text.slice(match.index + match[0].length))
    )
      return category;
  }
  return undefined;
}

function baseFor(line: LandedCostLine, method: LandedCostMethod) {
  if (method === "WEIGHT") return Number(line.weight) || 0;
  if (method === "QUANTITY") return Number(line.quantity) || 0;
  return lineValue(line);
}

export function allocateCharges(
  lines: LandedCostLine[],
  totalCharge: number,
  method: LandedCostMethod,
  manual: Record<string, number | null | undefined> = {},
): AllocationResult {
  const charge = roundMoney(Number(totalCharge) || 0);
  const idOf = (line: LandedCostLine, index: number) =>
    line.id === undefined ? String(index) : line.id;
  const zeroed: AllocationResult = {
    requestedMethod: method,
    method,
    totalCharge: charge,
    allocatedTotal: 0,
    allocations: lines.map((line, index) => ({
      lineId: idOf(line, index),
      amount: 0,
      unitAmount: 0,
    })),
    warnings: [],
  };
  if (charge <= 0 || !lines.length) return zeroed;
  if (method === "NONE")
    return {
      ...zeroed,
      warnings: [
        "Freight and charges are not allocated. Choose an allocation method before syncing costs.",
      ],
    };

  const warnings: string[] = [];
  let chosen = method;
  if (
    method === "WEIGHT" &&
    !lines.every((line) => Number(line.weight) > 0)
  ) {
    warnings.push(
      "Product weight is missing for one or more lines. SmartBill allocated the charges by line value instead.",
    );
    chosen = "VALUE";
  }

  const baseOf = (line: LandedCostLine) => baseFor(line, chosen);
  const bases = lines.map(baseOf);
  let totalBase = bases.reduce((sum, base) => sum + base, 0);
  let evenSplit = false;
  if (totalBase <= 0) {
    evenSplit = true;
    warnings.push(
      "The lines used for allocation have no value or quantity. SmartBill split the charges evenly across them.",
    );
    totalBase = lines.length;
  }
  const weights = bases.map((base) => (evenSplit ? 1 : base));

  if (chosen === "MANUAL") {
    const entries = lines.map((line, index) => {
      const value = manual[idOf(line, index)];
      return {
        line,
        index,
        specified: value !== undefined && value !== null,
        amount: value === undefined || value === null ? 0 : Number(value),
      };
    });
    for (const entry of entries.filter((candidate) => candidate.specified)) {
      if (!Number.isFinite(entry.amount) || entry.amount < 0)
        throw new Error(
          "Enter a valid amount, zero or greater, for every manual freight allocation.",
        );
    }
    const manualTotal = roundMoney(
      entries
        .filter((entry) => entry.specified)
        .reduce((sum, entry) => sum + entry.amount, 0),
    );
    const automatic = entries.filter((entry) => !entry.specified);
    if (!automatic.length && Math.abs(manualTotal - charge) > 0.011)
      throw new Error(
        `Manual freight amounts total ${manualTotal.toFixed(2)} but the charge lines total ${charge.toFixed(2)}. Adjust the amounts so they match.`,
      );
    if (manualTotal - charge > 0.011)
      throw new Error(
        `Manual freight amounts total ${manualTotal.toFixed(2)}, which is more than the ${charge.toFixed(2)} charge total.`,
      );
    if (automatic.length) {
      const remaining = roundMoney(charge - manualTotal);
      const automaticBases = automatic.map((entry) =>
        Math.max(0, lineValue(entry.line)),
      );
      const automaticBaseTotal = automaticBases.reduce(
        (sum, value) => sum + value,
        0,
      );
      const raw = automatic.map((_, index) =>
        automaticBaseTotal > 0
          ? (automaticBases[index] * remaining) / automaticBaseTotal
          : remaining / automatic.length,
      );
      const rounded = raw.map(roundMoney);
      const drift = roundMoney(
        remaining - rounded.reduce((sum, value) => sum + value, 0),
      );
      if (drift) {
        const largest = raw.reduce(
          (best, value, index) => (value > raw[best] ? index : best),
          0,
        );
        rounded[largest] = roundMoney(rounded[largest] + drift);
      }
      automatic.forEach((entry, index) => {
        entry.amount = rounded[index];
      });
      warnings.push(
        "Lines without a manual amount received the remaining freight in proportion to line value.",
      );
    }
    const allocations = entries.map((entry) => {
      const quantity = Number(entry.line.quantity) || 0;
      return {
        lineId: idOf(entry.line, entry.index),
        amount: roundMoney(entry.amount),
        unitAmount: quantity > 0 ? roundUnit(entry.amount / quantity) : 0,
      };
    });
    return finish(allocations, warnings, method, chosen, charge);
  }

  const raw = lines.map((line, index) => (weights[index] * charge) / totalBase);
  const allocations = raw.map((value, index) => ({
    lineId: idOf(lines[index], index),
    amount: roundMoney(value),
    unitAmount: 0,
  }));
  // Penny drift is pushed onto the largest line so the allocation always
  // reconciles with the charge total.
  const drift = roundMoney(charge - allocations.reduce((sum, item) => sum + item.amount, 0));
  if (drift !== 0) {
    const largest = raw.reduce(
      (best, value, index) => (value > raw[best] ? index : best),
      0,
    );
    allocations[largest].amount = roundMoney(allocations[largest].amount + drift);
  }
  for (const [index, allocation] of allocations.entries()) {
    const quantity = Number(lines[index].quantity) || 0;
    allocation.unitAmount = quantity > 0 ? roundUnit(allocation.amount / quantity) : 0;
  }
  return finish(allocations, warnings, method, chosen, charge);
}

function finish(
  allocations: ChargeAllocation[],
  warnings: string[],
  requestedMethod: LandedCostMethod,
  method: LandedCostMethod,
  totalCharge: number,
): AllocationResult {
  return {
    requestedMethod,
    method,
    totalCharge,
    allocatedTotal: roundMoney(
      allocations.reduce((sum, item) => sum + item.amount, 0),
    ),
    allocations,
    warnings,
  };
}

export function landedUnitCost(line: LandedCostLine, allocated: number) {
  const quantity = Number(line.quantity) || 0;
  if (quantity <= 0) return 0;
  return roundUnit((lineValue(line) + allocated) / quantity);
}

export function allocationSummary(result: AllocationResult) {
  if (result.totalCharge <= 0)
    return "No freight or charges detected on this invoice.";
  if (result.method === "NONE")
    return `${result.totalCharge.toFixed(2)} in freight and charges is not allocated.`;
  const label = LANDED_COST_METHOD_LABELS[result.method].toLowerCase();
  const lines = result.allocations.filter((item) => item.amount !== 0).length;
  return `Allocated ${result.totalCharge.toFixed(2)} in freight and charges across ${lines} line${lines === 1 ? "" : "s"} ${label}.`;
}

export function landedCostIssues(
  items: LandedCostLine[],
  method: LandedCostMethod,
) {
  const issues: string[] = [];
  const charges = items.filter(isChargeLine);
  if (!charges.length) return issues;
  if (method === "NONE")
    issues.push(
      "Choose how to allocate the freight and charge lines before approval.",
    );
  if (roundMoney(charges.reduce((sum, line) => sum + lineValue(line), 0)) <= 0)
    issues.push("Enter a positive amount on every freight or charge line.");
  return issues;
}
