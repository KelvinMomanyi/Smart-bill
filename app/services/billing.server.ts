import prisma from "../db.server";
import { authenticate, unauthenticated } from "../shopify.server";
import { PLANS, planFromName, usageMonth, type PlanKey } from "../utils/plans";

type Admin = Awaited<ReturnType<typeof authenticate.admin>>["admin"];
export async function subscriptionFor(admin: Admin) {
  const response = await admin.graphql(`#graphql
    query SmartBillSubscription {
      currentAppInstallation { activeSubscriptions { id name status test
        lineItems { plan { pricingDetails { ... on AppRecurringPricing { price { amount currencyCode } interval } } } }
      } }
    }`);
  const body = await response.json();
  if (("errors" in body && body.errors) || !body.data?.currentAppInstallation)
    throw new Error("Unable to verify your subscription. Please retry.");
  const subscriptions = body.data.currentAppInstallation
    .activeSubscriptions as {
    id: string;
    name: string;
    status: string;
    test: boolean;
    lineItems: {
      plan: {
        pricingDetails: {
          price?: { amount: string; currencyCode: string };
          interval?: string;
        };
      };
    }[];
  }[];
  const active = subscriptions.find(
    (s) =>
      s.status === "ACTIVE" &&
      planFromName(s.name) &&
      (!s.test ||
        process.env.NODE_ENV !== "production" ||
        process.env.SHOPIFY_BILLING_TEST === "true"),
  );
  if (!active) return null;
  const plan = planFromName(active.name)!;
  const pricing = active.lineItems[0]?.plan.pricingDetails;
  const currentPrice = Number(pricing?.price?.amount);
  return {
    id: active.id,
    plan,
    currentPrice,
    currentCurrency: pricing?.price?.currencyCode || "USD",
    matchesPrice:
      active.lineItems.length === 1 &&
      currentPrice === PLANS[plan].price &&
      pricing?.price?.currencyCode === "USD" &&
      pricing?.interval === "EVERY_30_DAYS",
  };
}
export async function requireSubscription(
  request: Request,
  feature: "core" | "bulk" = "core",
) {
  const context = await authenticate.admin(request);
  const subscription = await subscriptionFor(context.admin);
  assertSubscription(subscription?.plan || null, feature);
  return { ...context, plan: subscription!.plan };
}
export function assertSubscription(
  plan: PlanKey | null,
  feature: "core" | "bulk" = "core",
) {
  if (!plan)
    throw new Error(
      "Choose a Starter or Growth subscription in Settings to continue.",
    );
  if (feature === "bulk" && plan !== "GROWTH")
    throw new Error(
      "Bulk upload and email capture require Growth ($49 every 30 days).",
    );
}
export async function requireShopSubscription(
  shop: string,
  feature: "core" | "bulk" = "core",
) {
  const { admin } = await unauthenticated.admin(shop);
  const subscription = await subscriptionFor(admin);
  assertSubscription(subscription?.plan || null, feature);
  return subscription!.plan;
}
export async function getUsage(shop: string) {
  return (
    (
      await prisma.monthlyUsage.findUnique({
        where: { shop_month: { shop, month: usageMonth() } },
      })
    )?.invoices || 0
  );
}
export async function reserveInvoiceUsage(shop: string, plan: PlanKey) {
  const month = usageMonth();
  await prisma.monthlyUsage.upsert({
    where: { shop_month: { shop, month } },
    create: { shop, month },
    update: {},
  });
  const result = await prisma.monthlyUsage.updateMany({
    where: { shop, month, invoices: { lt: PLANS[plan].invoiceLimit } },
    data: { invoices: { increment: 1 } },
  });
  if (!result.count)
    throw new Error(
      `Your ${PLANS[plan].invoiceLimit}-invoice allowance is used. Upgrade or wait for the next calendar month (UTC). No overage fees are charged.`,
    );
  return month;
}
export async function releaseInvoiceUsage(shop: string, month: string) {
  await prisma.monthlyUsage.updateMany({
    where: { shop, month, invoices: { gt: 0 } },
    data: { invoices: { decrement: 1 } },
  });
}
