// feature-reference.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { AppProvider, Page, Card, BlockStack, Text, Banner, Badge } from "@shopify/polaris";

// app/utils/landedCost.ts
var LANDED_COST_METHODS = [
  "NONE",
  "VALUE",
  "QUANTITY",
  "WEIGHT",
  "MANUAL"
];
var LANDED_COST_METHOD_LABELS = {
  NONE: "Do not allocate",
  VALUE: "By line value",
  QUANTITY: "By quantity",
  WEIGHT: "By product weight",
  MANUAL: "Manual amounts"
};
function lineValue(line) {
  const value = line.amount != null ? line.amount : line.quantity * line.price;
  return Number.isFinite(value) ? value : 0;
}
function roundUnit(value) {
  return Math.round((value + Number.EPSILON) * 1e4) / 1e4;
}
function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
function baseFor(line, method) {
  if (method === "WEIGHT")
    return Number(line.weight) || 0;
  if (method === "QUANTITY")
    return Number(line.quantity) || 0;
  return lineValue(line);
}
function allocateCharges(lines, totalCharge, method, manual = {}) {
  const charge = roundMoney(Number(totalCharge) || 0);
  const idOf = (line, index) => line.id === void 0 ? String(index) : line.id;
  const zeroed = {
    requestedMethod: method,
    method,
    totalCharge: charge,
    allocatedTotal: 0,
    allocations: lines.map((line, index) => ({
      lineId: idOf(line, index),
      amount: 0,
      unitAmount: 0
    })),
    warnings: []
  };
  if (charge <= 0 || !lines.length)
    return zeroed;
  if (method === "NONE")
    return {
      ...zeroed,
      warnings: [
        "Freight and charges are not allocated. Choose an allocation method before syncing costs."
      ]
    };
  const warnings = [];
  let chosen = method;
  if (method === "WEIGHT" && !lines.every((line) => Number(line.weight) > 0)) {
    warnings.push(
      "Product weight is missing for one or more lines. SmartBill allocated the charges by line value instead."
    );
    chosen = "VALUE";
  }
  const baseOf = (line) => baseFor(line, chosen);
  const bases = lines.map(baseOf);
  let totalBase = bases.reduce((sum, base) => sum + base, 0);
  let evenSplit = false;
  if (totalBase <= 0) {
    evenSplit = true;
    warnings.push(
      "The lines used for allocation have no value or quantity. SmartBill split the charges evenly across them."
    );
    totalBase = lines.length;
  }
  const weights = bases.map((base) => evenSplit ? 1 : base);
  if (chosen === "MANUAL") {
    const entries = lines.map((line, index) => {
      const value = manual[idOf(line, index)];
      return {
        line,
        index,
        specified: value !== void 0 && value !== null,
        amount: value === void 0 || value === null ? 0 : Number(value)
      };
    });
    for (const entry of entries.filter((candidate) => candidate.specified)) {
      if (!Number.isFinite(entry.amount) || entry.amount < 0)
        throw new Error(
          "Enter a valid amount, zero or greater, for every manual freight allocation."
        );
    }
    const manualTotal = roundMoney(
      entries.filter((entry) => entry.specified).reduce((sum, entry) => sum + entry.amount, 0)
    );
    const automatic = entries.filter((entry) => !entry.specified);
    if (!automatic.length && Math.abs(manualTotal - charge) > 0.011)
      throw new Error(
        `Manual freight amounts total ${manualTotal.toFixed(2)} but the charge lines total ${charge.toFixed(2)}. Adjust the amounts so they match.`
      );
    if (manualTotal - charge > 0.011)
      throw new Error(
        `Manual freight amounts total ${manualTotal.toFixed(2)}, which is more than the ${charge.toFixed(2)} charge total.`
      );
    if (automatic.length) {
      const remaining = roundMoney(charge - manualTotal);
      const automaticBases = automatic.map(
        (entry) => Math.max(0, lineValue(entry.line))
      );
      const automaticBaseTotal = automaticBases.reduce(
        (sum, value) => sum + value,
        0
      );
      const raw2 = automatic.map(
        (_, index) => automaticBaseTotal > 0 ? automaticBases[index] * remaining / automaticBaseTotal : remaining / automatic.length
      );
      const rounded = raw2.map(roundMoney);
      const drift2 = roundMoney(
        remaining - rounded.reduce((sum, value) => sum + value, 0)
      );
      if (drift2) {
        const largest = raw2.reduce(
          (best, value, index) => value > raw2[best] ? index : best,
          0
        );
        rounded[largest] = roundMoney(rounded[largest] + drift2);
      }
      automatic.forEach((entry, index) => {
        entry.amount = rounded[index];
      });
      warnings.push(
        "Lines without a manual amount received the remaining freight in proportion to line value."
      );
    }
    const allocations2 = entries.map((entry) => {
      const quantity = Number(entry.line.quantity) || 0;
      return {
        lineId: idOf(entry.line, entry.index),
        amount: roundMoney(entry.amount),
        unitAmount: quantity > 0 ? roundUnit(entry.amount / quantity) : 0
      };
    });
    return finish(allocations2, warnings, method, chosen, charge);
  }
  const raw = lines.map((line, index) => weights[index] * charge / totalBase);
  const allocations = raw.map((value, index) => ({
    lineId: idOf(lines[index], index),
    amount: roundMoney(value),
    unitAmount: 0
  }));
  const drift = roundMoney(charge - allocations.reduce((sum, item) => sum + item.amount, 0));
  if (drift !== 0) {
    const largest = raw.reduce(
      (best, value, index) => value > raw[best] ? index : best,
      0
    );
    allocations[largest].amount = roundMoney(allocations[largest].amount + drift);
  }
  for (const [index, allocation] of allocations.entries()) {
    const quantity = Number(lines[index].quantity) || 0;
    allocation.unitAmount = quantity > 0 ? roundUnit(allocation.amount / quantity) : 0;
  }
  return finish(allocations, warnings, method, chosen, charge);
}
function finish(allocations, warnings, requestedMethod, method, totalCharge) {
  return {
    requestedMethod,
    method,
    totalCharge,
    allocatedTotal: roundMoney(
      allocations.reduce((sum, item) => sum + item.amount, 0)
    ),
    allocations,
    warnings
  };
}
function landedUnitCost(line, allocated) {
  const quantity = Number(line.quantity) || 0;
  if (quantity <= 0)
    return 0;
  return roundUnit((lineValue(line) + allocated) / quantity);
}
function allocationSummary(result) {
  if (result.totalCharge <= 0)
    return "No freight or charges detected on this invoice.";
  if (result.method === "NONE")
    return `${result.totalCharge.toFixed(2)} in freight and charges is not allocated.`;
  const label = LANDED_COST_METHOD_LABELS[result.method].toLowerCase();
  const lines = result.allocations.filter((item) => item.amount !== 0).length;
  return `Allocated ${result.totalCharge.toFixed(2)} in freight and charges across ${lines} line${lines === 1 ? "" : "s"} ${label}.`;
}

// feature-reference.tsx
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
function render() {
  const invoice = { currency: "USD", invoiceNumber: "SB-1042" };
  const productLines = [
    { id: "tote", name: "Linen tote", quantity: 40, price: 6, amount: 240, category: "PRODUCT" },
    { id: "cup", name: "Ceramic cup", quantity: 60, price: 4, amount: 240, category: "PRODUCT" }
  ];
  const chargeLines = [{ category: "FREIGHT", amount: 72 }, { category: "DUTY", amount: 24 }];
  const chargeTotal = 96;
  const landedCostMethod = "VALUE";
  const result = allocateCharges(productLines, chargeTotal, landedCostMethod);
  const landedCost = {
    summary: allocationSummary(result),
    warnings: result.warnings,
    lines: productLines.map((line) => {
      const allocated = result.allocations.find((a) => a.lineId === line.id).amount;
      return { ...line, allocated, landedUnitCost: landedUnitCost(line, allocated) };
    })
  };
  const landedCostError = "", landedCostMethodWarning = "", locked = false;
  const setDirty = () => {
  }, setLandedCostMethod = () => {
  };
  return renderToStaticMarkup(
    /* @__PURE__ */ jsx(AppProvider, { i18n: {}, children: /* @__PURE__ */ jsx(Page, { title: "Invoice " + invoice.invoiceNumber, children: /* @__PURE__ */ jsxs(BlockStack, { gap: "400", children: [
      /* @__PURE__ */ jsx(Badge, { children: "APPROVED" }),
      /* @__PURE__ */ jsx(Card, { children: /* @__PURE__ */ jsx(
        "div",
        {
          style: {
            border: "1px solid #e3e3e3",
            borderRadius: 8,
            padding: 12
          },
          children: /* @__PURE__ */ jsxs(BlockStack, { gap: "200", children: [
            /* @__PURE__ */ jsx(Text, { as: "h3", variant: "headingSm", children: "Freight, duty and landed cost" }),
            /* @__PURE__ */ jsxs(Text, { as: "p", tone: "subdued", children: [
              chargeLines.length,
              " charge line",
              chargeLines.length === 1 ? "" : "s",
              " totalling",
              " ",
              chargeTotal.toFixed(2),
              " ",
              invoice.currency,
              ". Choose how they are spread over the ",
              productLines.length,
              " product line",
              productLines.length === 1 ? "" : "s",
              " before previewing costs."
            ] }),
            /* @__PURE__ */ jsxs("label", { children: [
              "Allocation method",
              " ",
              /* @__PURE__ */ jsx(
                "select",
                {
                  name: "landedCostMethod",
                  value: landedCostMethod,
                  disabled: locked,
                  onChange: (e) => {
                    setDirty(true);
                    setLandedCostMethod(e.target.value);
                  },
                  children: LANDED_COST_METHODS.map((method) => /* @__PURE__ */ jsx("option", { value: method, children: LANDED_COST_METHOD_LABELS[method] }, method))
                }
              )
            ] }),
            landedCostError && /* @__PURE__ */ jsx(Banner, { tone: "critical", children: landedCostError }),
            landedCostMethodWarning && /* @__PURE__ */ jsx(Banner, { tone: "warning", children: landedCostMethodWarning }),
            landedCost && /* @__PURE__ */ jsxs(Fragment, { children: [
              /* @__PURE__ */ jsx(Text, { as: "p", children: landedCost.summary }),
              landedCost.warnings.map((warning) => /* @__PURE__ */ jsx(Text, { as: "p", tone: "subdued", children: warning }, warning)),
              /* @__PURE__ */ jsxs(
                "table",
                {
                  style: {
                    width: "100%",
                    borderCollapse: "collapse"
                  },
                  children: [
                    /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
                      /* @__PURE__ */ jsx("th", { align: "left", children: "Product line" }),
                      /* @__PURE__ */ jsx("th", { align: "right", children: "Qty" }),
                      /* @__PURE__ */ jsx("th", { align: "right", children: "Allocated charge" }),
                      /* @__PURE__ */ jsx("th", { align: "right", children: "Landed cost per unit" })
                    ] }) }),
                    /* @__PURE__ */ jsx("tbody", { children: landedCost.lines.map((line) => /* @__PURE__ */ jsxs("tr", { children: [
                      /* @__PURE__ */ jsx("td", { children: line.name }),
                      /* @__PURE__ */ jsx("td", { align: "right", children: line.quantity }),
                      /* @__PURE__ */ jsx("td", { align: "right", children: line.allocated.toFixed(2) }),
                      /* @__PURE__ */ jsx("td", { align: "right", children: line.landedUnitCost.toFixed(4) })
                    ] }, line.id)) })
                  ]
                }
              ),
              /* @__PURE__ */ jsx(Text, { as: "p", tone: "subdued", children: "The landed cost per unit is what SmartBill writes to Shopify as the variant cost. This preview reflects the saved invoice, so save corrections first." })
            ] })
          ] })
        }
      ) })
    ] }) }) })
  );
}
export {
  render
};
