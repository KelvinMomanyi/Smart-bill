import "./accountingTestEnvironment";
import assert from "node:assert/strict";
import { test } from "node:test";
import prisma from "../db.server";
import { PLANS } from "../utils/plans";

const originalCount = prisma.session.count;
(prisma.session as any).count = async () => 0;
const { subscriptionFor, requireSubscription } = await import("../services/billing.server");
const { authenticate } = await import("../shopify.server");
prisma.session.count = originalCount;

test("approved review-store charges unlock the paid plan and its features", async (t) => {
  for (const plan of ["STARTER", "GROWTH"] as const) {
    const active = {
      id: `gid://shopify/AppSubscription/${plan}`,
      name: PLANS[plan].name, status: "ACTIVE", test: true,
      lineItems: [{ plan: { pricingDetails: {
        price: { amount: String(PLANS[plan].price), currencyCode: "USD" },
        interval: "EVERY_30_DAYS",
      } } }],
    };
    const admin = { graphql: async () => Response.json({ data: {
      shop: { plan: { partnerDevelopment: false } },
      currentAppInstallation: { activeSubscriptions: [active] },
    } }) };
    t.mock.method(authenticate, "admin", async () => ({ admin }));
    assert.equal((await subscriptionFor(admin as any))?.plan, plan);
    assert.equal((await requireSubscription(new Request("https://app.example/app"), plan === "GROWTH" ? "bulk" : "core")).plan, plan);
    for (const status of ["PENDING", "DECLINED", "CANCELLED", "EXPIRED", "FROZEN"]) {
      active.status = status;
      assert.equal(await subscriptionFor(admin as any), null);
    }
    active.status = "ACTIVE";
    active.name = "Unknown plan" as any;
    assert.equal(await subscriptionFor(admin as any), null);
  }
});
