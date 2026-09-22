import prisma from "../db.server";
import { roundMoney } from "../utils/invoiceRules";

export function calculateFxRevaluation(
  invoiceAmount: number,
  originalRate: number,
  currentRate: number,
  thresholdPercent = 5,
) {
  if (
    ![invoiceAmount, originalRate, currentRate].every(Number.isFinite) ||
    invoiceAmount < 0 ||
    originalRate <= 0 ||
    currentRate <= 0
  )
    throw new Error("Revaluation requires a positive amount and exchange rates.");
  const originalValue = roundMoney(invoiceAmount * originalRate);
  const currentValue = roundMoney(invoiceAmount * currentRate);
  const difference = roundMoney(currentValue - originalValue);
  const swingPercent = Math.abs((currentRate - originalRate) / originalRate) * 100;
  return {
    invoiceAmount,
    originalRate,
    currentRate,
    originalValue,
    currentValue,
    difference,
    swingPercent,
    material: swingPercent >= thresholdPercent,
    effect: difference > 0 ? "LOSS" : difference < 0 ? "GAIN" : "NONE",
  } as const;
}

export async function previewFxRevaluation(
  shop: string,
  from: Date,
  until: Date,
  rateDate = new Date(),
) {
  const invoices = await prisma.invoice.findMany({
    where: {
      shop,
      date: { gte: from, lt: until },
      fxRate: { not: null },
      shopCurrency: { not: null },
    },
    include: { vendor: { select: { name: true } } },
  });
  const previews = [];
  for (const invoice of invoices) {
    if (!invoice.fxRate || !invoice.shopCurrency || invoice.currency === invoice.shopCurrency)
      continue;
    const latest = await prisma.exchangeRate.findFirst({
      where: {
        shop,
        fromCurrency: invoice.currency,
        toCurrency: invoice.shopCurrency,
        rateDate: { lte: rateDate },
      },
      orderBy: [{ rateDate: "desc" }, { confidence: "desc" }],
    });
    if (!latest) continue;
    const calculation = calculateFxRevaluation(
      invoice.total,
      invoice.fxRate,
      latest.rate,
    );
    if (!calculation.material) continue;
    previews.push({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      supplier: invoice.vendor?.name || "Unknown supplier",
      fromCurrency: invoice.currency,
      toCurrency: invoice.shopCurrency,
      rateDate: latest.rateDate,
      source: latest.source,
      ...calculation,
    });
  }
  return previews.sort((left, right) => Math.abs(right.difference) - Math.abs(left.difference));
}

export async function recordFxRevaluation(
  shop: string,
  invoiceId: string,
  actor: string,
  currentRate: number,
  rateDate: Date,
  source: string,
) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, shop },
  });
  if (!invoice?.fxRate || !invoice.shopCurrency)
    throw new Error("This invoice does not have an approved foreign-currency rate.");
  const calculation = calculateFxRevaluation(invoice.total, invoice.fxRate, currentRate);
  return prisma.$transaction(async (tx) => {
    const adjustment = await tx.fXAdjustment.create({
      data: {
        invoiceId,
        fromCurrency: invoice.currency,
        toCurrency: invoice.shopCurrency!,
        invoiceAmount: invoice.total,
        convertedAmount: calculation.currentValue,
        rateUsed: currentRate,
        rateDate,
        rateDifference: currentRate - invoice.fxRate!,
        reason: "REVALUATION",
        source,
      },
    });
    await tx.auditEvent.create({
      data: {
        shop,
        invoiceId,
        actor,
        action: "FX_REVALUED",
        detail: calculation,
      },
    });
    return { adjustment, calculation };
  });
}
