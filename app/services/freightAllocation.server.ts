import type { Prisma } from "@prisma/client";
import {
  isChargeLine,
  lineValue,
  type AllocationResult,
  type LandedCostMethod,
} from "../utils/landedCost";

type InvoiceForFreight = {
  id: string;
  vendorId: string | null;
  currency: string;
  items: {
    id: string;
    name: string;
    category: string;
    quantity: number;
    price: number;
    amount: number | null;
  }[];
};

export async function syncFreightLines(
  tx: Prisma.TransactionClient,
  invoice: InvoiceForFreight,
) {
  await tx.freightLine.deleteMany({ where: { invoiceId: invoice.id } });
  const charges = invoice.items.filter(isChargeLine);
  if (charges.length)
    await tx.freightLine.createMany({
      data: charges.map((line) => ({
        invoiceId: invoice.id,
        invoiceItemId: line.id,
        supplierId: invoice.vendorId,
        description: line.name,
        amount: lineValue(line),
        currency: invoice.currency,
        category: line.category,
      })),
    });
  return tx.freightLine.findMany({
    where: { invoiceId: invoice.id },
    orderBy: { createdAt: "asc" },
  });
}

function splitFreightLine(
  amount: number,
  result: AllocationResult,
) {
  if (result.allocatedTotal <= 0)
    return result.allocations.map((allocation) => ({
      lineId: allocation.lineId,
      amount: 0,
    }));
  const raw = result.allocations.map((allocation) =>
    Math.max(0, (allocation.amount * amount) / result.allocatedTotal),
  );
  const split = raw.map((value, index) => ({
    lineId: result.allocations[index].lineId,
    amount: Math.round((value + Number.EPSILON) * 100) / 100,
  }));
  const allocated = split.reduce((sum, entry) => sum + entry.amount, 0);
  const drift = Math.round((amount - allocated + Number.EPSILON) * 100) / 100;
  if (drift && split.length) {
    const largest = raw.reduce(
      (best, value, index) => (value > raw[best] ? index : best),
      0,
    );
    split[largest].amount =
      Math.round((split[largest].amount + drift + Number.EPSILON) * 100) / 100;
  }
  return split;
}

export async function recordFreightAllocations(
  tx: Prisma.TransactionClient,
  input: {
    freightLines: { id: string; amount: number }[];
    result: AllocationResult;
    requestedMethod: LandedCostMethod;
    actor: string;
  },
) {
  const warning = input.result.warnings.join(" ") || null;
  for (const freight of input.freightLines) {
    const split = splitFreightLine(freight.amount, input.result);
    if (!split.length) continue;
    await tx.freightAllocation.createMany({
      data: split.map((allocation) => ({
        freightLineId: freight.id,
        invoiceLineId: allocation.lineId,
        allocationMethod: input.result.method,
        allocatedAmount: allocation.amount,
        allocationReason:
          warning ||
          (input.result.method === "MANUAL"
            ? "Merchant-reviewed manual allocation"
            : `Allocated by ${input.result.method.toLowerCase()}`),
        calculatedBy: input.actor,
        adjustedManually: input.requestedMethod === "MANUAL",
      })),
    });
  }
}
