import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { roundMoney } from "../utils/invoiceRules";

export const EXCHANGE_RATE_SOURCES = [
  "SHOP_CURRENCY",
  "XERO_API",
  "OPENEXCHANGERATES",
  "ECB",
  "MANUAL",
] as const;
export type ExchangeRateSource = (typeof EXCHANGE_RATE_SOURCES)[number];

export type ExchangeRateOption = {
  rate: number;
  rateDate: string;
  source: ExchangeRateSource;
  confidence: number;
  nearestPrior: boolean;
};

function utcDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) throw new Error("Enter a valid FX rate date.");
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export async function storeExchangeRate(input: {
  shop: string;
  fromCurrency: string;
  toCurrency: string;
  rateDate: Date | string;
  rate: number;
  source: ExchangeRateSource;
  confidence: number;
}) {
  if (!Number.isFinite(input.rate) || input.rate <= 0)
    throw new Error("Exchange rates must be positive numbers.");
  const rateDate = utcDate(input.rateDate);
  return prisma.exchangeRate.upsert({
    where: {
      shop_fromCurrency_toCurrency_rateDate_source: {
        shop: input.shop,
        fromCurrency: input.fromCurrency,
        toCurrency: input.toCurrency,
        rateDate,
        source: input.source,
      },
    },
    update: { rate: input.rate, confidence: input.confidence },
    create: { ...input, rateDate },
  });
}

export async function findNearestExchangeRate(input: {
  shop: string;
  fromCurrency: string;
  toCurrency: string;
  rateDate: Date | string;
}) {
  const rateDate = utcDate(input.rateDate);
  return prisma.exchangeRate.findFirst({
    where: {
      shop: input.shop,
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      rateDate: { lte: rateDate },
    },
    orderBy: [{ rateDate: "desc" }, { confidence: "desc" }],
  });
}

async function fetchOpenExchangeRate(
  fromCurrency: string,
  toCurrency: string,
  rateDate: Date,
) {
  const appId = process.env.OPENEXCHANGERATES_APP_ID?.trim();
  if (!appId) return null;
  const date = rateDate.toISOString().slice(0, 10);
  const response = await fetch(
    `https://openexchangerates.org/api/historical/${date}.json?app_id=${encodeURIComponent(appId)}`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) },
  );
  if (!response.ok) return null;
  const payload = (await response.json()) as {
    rates?: Record<string, number>;
  };
  const from = fromCurrency === "USD" ? 1 : Number(payload.rates?.[fromCurrency]);
  const to = toCurrency === "USD" ? 1 : Number(payload.rates?.[toCurrency]);
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0)
    return null;
  return to / from;
}

export async function getExchangeRateOptions(input: {
  shop: string;
  fromCurrency: string;
  toCurrency: string;
  rateDate: Date | string;
  allowRemote?: boolean;
}): Promise<ExchangeRateOption[]> {
  const rateDate = utcDate(input.rateDate);
  if (input.fromCurrency === input.toCurrency)
    return [
      {
        rate: 1,
        rateDate: rateDate.toISOString().slice(0, 10),
        source: "SHOP_CURRENCY",
        confidence: 100,
        nearestPrior: false,
      },
    ];
  const stored = await prisma.exchangeRate.findMany({
    where: {
      shop: input.shop,
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      rateDate: { lte: rateDate },
    },
    orderBy: [{ rateDate: "desc" }, { confidence: "desc" }],
    take: 10,
  });
  if (input.allowRemote && process.env.OPENEXCHANGERATES_APP_ID) {
    const exact = stored.some(
      (rate) =>
        rate.source === "OPENEXCHANGERATES" &&
        rate.rateDate.getTime() === rateDate.getTime(),
    );
    if (!exact) {
      const rate = await fetchOpenExchangeRate(
        input.fromCurrency,
        input.toCurrency,
        rateDate,
      );
      if (rate)
        stored.unshift(
          await storeExchangeRate({
            shop: input.shop,
            fromCurrency: input.fromCurrency,
            toCurrency: input.toCurrency,
            rateDate,
            rate,
            source: "OPENEXCHANGERATES",
            confidence: 80,
          }),
        );
    }
  }
  const seen = new Set<string>();
  return stored
    .filter((rate) => {
      const key = `${rate.source}:${rate.rateDate.toISOString()}:${rate.rate}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((rate) => ({
      rate: rate.rate,
      rateDate: rate.rateDate.toISOString().slice(0, 10),
      source: rate.source as ExchangeRateSource,
      confidence: rate.confidence,
      nearestPrior: rate.rateDate.getTime() !== rateDate.getTime(),
    }));
}

export async function recordInvoiceFxSelection(
  tx: Prisma.TransactionClient,
  input: {
    invoiceId: string;
    shop: string;
    fromCurrency: string;
    toCurrency: string;
    invoiceAmount: number;
    rate: number;
    rateDate: Date;
    source: ExchangeRateSource;
    confidence: number;
    reason?: string;
  },
) {
  if (input.fromCurrency === input.toCurrency) return;
  await tx.exchangeRate.upsert({
    where: {
      shop_fromCurrency_toCurrency_rateDate_source: {
        shop: input.shop,
        fromCurrency: input.fromCurrency,
        toCurrency: input.toCurrency,
        rateDate: input.rateDate,
        source: input.source,
      },
    },
    update: {
      rate: input.rate,
      confidence: input.confidence,
      appliedToInvoice: { increment: 1 },
    },
    create: {
      shop: input.shop,
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      rateDate: input.rateDate,
      rate: input.rate,
      source: input.source,
      confidence: input.confidence,
      appliedToInvoice: 1,
    },
  });
  await tx.fXAdjustment.create({
    data: {
      invoiceId: input.invoiceId,
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      invoiceAmount: input.invoiceAmount,
      convertedAmount: roundMoney(input.invoiceAmount * input.rate),
      rateUsed: input.rate,
      rateDate: input.rateDate,
      reason: input.reason || "INVOICE_DATED_RATE",
      source: input.source,
    },
  });
}
