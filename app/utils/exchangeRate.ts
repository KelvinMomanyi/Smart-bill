export const FX_SOURCES = [
  "MANUAL",
  "SHOP_CURRENCY",
  "XERO_API",
  "OPENEXCHANGERATES",
  "ECB",
] as const;
export type FxSource = (typeof FX_SOURCES)[number];

export type FxResolution = {
  required: boolean;
  rate: number;
  problem: string;
};

// SmartBill writes Shopify inventory costs in the shop currency. A foreign
// invoice therefore needs an explicit, reviewed rate before any cost changes.
export function resolveFxRate(
  invoiceCurrency: string,
  shopCurrency: string,
  rate?: number | null,
): FxResolution {
  if (invoiceCurrency === shopCurrency)
    return { required: false, rate: 1, problem: "" };
  if (rate == null || !Number.isFinite(rate))
    return {
      required: true,
      rate: 0,
      problem: `This invoice is ${invoiceCurrency} and Shopify costs are ${shopCurrency}. Choose the exchange rate before previewing or syncing costs.`,
    };
  if (rate <= 0 || rate > 100000)
    return {
      required: true,
      rate: 0,
      problem: "Enter a realistic exchange rate, for example 1.35.",
    };
  return { required: true, rate, problem: "" };
}

export function fxSummary(
  invoiceCurrency: string,
  shopCurrency: string,
  rate: number,
  rateDate?: string | null,
) {
  const stamp = rateDate ? ` dated ${rateDate}` : "";
  return `1 ${invoiceCurrency} = ${rate} ${shopCurrency}${stamp}. Shopify costs are written in ${shopCurrency}.`;
}

export function resolveFxRateDate(value: unknown) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
}
