import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  BillingReplacementBehavior,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { PLANS, SMARTBILL_PLANS, TRIAL_DAYS } from "./utils/plans";
export { SMARTBILL_PLANS } from "./utils/plans";

function normalizeAppUrl(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return "";

  const withProtocol = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function resolveAppUrl() {
  const appUrl = normalizeAppUrl(
    process.env.SHOPIFY_APP_URL ||
      process.env.APP_URL ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      process.env.VERCEL_BRANCH_URL ||
      process.env.NEXT_PUBLIC_VERCEL_URL ||
      process.env.VERCEL_URL ||
      process.env.HOST,
  );

  if (!appUrl) {
    throw new Error(
      [
        "Missing Shopify app URL.",
        "Set SHOPIFY_APP_URL in your deployment environment to your public HTTPS app URL.",
        "For Vercel, use the production domain shown in Project Settings -> Domains, for example https://smart-bill.vercel.app.",
      ].join(" "),
    );
  }

  return appUrl;
}

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: resolveAppUrl(),
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma, {
    connectionRetries: 6,
    connectionRetryIntervalMs: 2500,
  }),
  distribution: AppDistribution.AppStore,
  useOnlineTokens: true,
  billing: {
    [SMARTBILL_PLANS.STARTER]: {
      trialDays: TRIAL_DAYS,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: PLANS.STARTER.price,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
    [SMARTBILL_PLANS.GROWTH]: {
      trialDays: TRIAL_DAYS,
      replacementBehavior: BillingReplacementBehavior.ApplyImmediately,
      lineItems: [
        {
          amount: PLANS.GROWTH.price,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
