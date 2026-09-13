import assert from "node:assert/strict";
import prisma from "../app/db.server";
import { unauthenticated } from "../app/shopify.server";
import { subscriptionFor } from "../app/services/billing.server";
import { fetchShopCurrency } from "../app/services/invoiceWorkflow.server";
import { findVariants } from "../app/services/invoiceReview.server";

async function main() {
  const sessions = await prisma.session.findMany({
    where: { isOnline: false },
    distinct: ["shop"],
    select: { shop: true },
  });
  assert.ok(sessions.length > 0, "No offline Shopify sessions are available.");

  const results = [];
  for (const [index, session] of sessions.entries()) {
    try {
      const { admin } = await unauthenticated.admin(session.shop);
      const [currency, subscription, variants] = await Promise.all([
        fetchShopCurrency(admin),
        subscriptionFor(admin),
        findVariants(admin, ""),
      ]);
      results.push({
        store: index + 1,
        authenticated: true,
        currency,
        subscription: subscription?.plan || null,
        subscriptionPriceMatches: subscription?.matchesPrice ?? null,
        productReadScope: "passed",
        visibleVariantCount: variants.length,
      });
    } catch (error) {
      results.push({
        store: index + 1,
        authenticated: false,
        error: error instanceof Error ? error.message : "Shopify check failed.",
      });
    }
  }
  console.log(JSON.stringify({ stores: results }));
  assert.ok(
    results.some((result) => result.authenticated),
    "None of the stored offline Shopify sessions could authenticate.",
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Shopify smoke test failed.");
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
