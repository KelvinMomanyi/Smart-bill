export const PLANS = {
  STARTER: {
    name: "SmartBill Starter", label: "Starter", price: 19, invoiceLimit: 50,
    description: "50 invoices per calendar month. Review, purchase orders, cost sync, CSV, Xero and QuickBooks.",
  },
  GROWTH: {
    name: "SmartBill Growth", label: "Growth", price: 49, invoiceLimit: 250,
    description: "250 invoices per calendar month. Everything in Starter, plus bulk upload and an invoice email inbox.",
  },
} as const;
export type PlanKey = keyof typeof PLANS;
export const SMARTBILL_PLANS = { STARTER: PLANS.STARTER.name, GROWTH: PLANS.GROWTH.name } as const;
export const TRIAL_DAYS = 14;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 10;
export function planFromName(name?: string): PlanKey | null {
  return (Object.keys(PLANS) as PlanKey[]).find(key => PLANS[key].name === name) || null;
}
export function usageMonth(now = new Date()) { return now.toISOString().slice(0, 7); }
export function usageAvailable(plan: PlanKey, used: number, requested = 1) {
  return Number.isInteger(requested) && requested > 0 && used + requested <= PLANS[plan].invoiceLimit;
}
