import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import prisma from "../db.server";
import { PLANS, type PlanKey } from "../utils/plans";
import {
  shopDomain,
  shopifyAdminAppsUrl,
  shopifyAppListingUrl,
} from "../utils/shopifyNavigation";

const originalCount = prisma.session.count;
(prisma.session as any).count = async () => 0;
const {
  subscriptionFor,
  requireSubscription,
  isDevelopmentStore,
  billingReturnUrl,
} = await import("../services/billing.server");
const { authenticate } = await import("../shopify.server");
const { action: settingsAction } = await import("../routes/app.settings");
const { loader: loginLoader, action: loginAction } = await import(
  "../routes/auth.login/route"
);
const { loader: homeLoader } = await import("../routes/_index/route");
prisma.session.count = originalCount;

function subscription(
  plan: PlanKey = "STARTER",
  status = "ACTIVE",
  test = false,
) {
  return {
    id: `gid://shopify/AppSubscription/${plan}`,
    name: PLANS[plan].name,
    status,
    test,
    lineItems: [
      {
        plan: {
          pricingDetails: {
            price: { amount: String(PLANS[plan].price), currencyCode: "USD" },
            interval: "EVERY_30_DAYS",
          },
        },
      },
    ],
  };
}

function billingResponse(subscriptions: any[] = [], development = false) {
  return {
    data: {
      shop: { plan: { partnerDevelopment: development } },
      currentAppInstallation: { activeSubscriptions: subscriptions },
    },
  };
}

function legacyFlag(t: TestContext) {
  const previous = process.env.SHOPIFY_BILLING_TEST;
  process.env.SHOPIFY_BILLING_TEST = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.SHOPIFY_BILLING_TEST;
    else process.env.SHOPIFY_BILLING_TEST = previous;
  });
}

test("a stale testing environment flag cannot grant access without Shopify approval", async (t) => {
  legacyFlag(t);
  let queries = 0;
  const admin = {
    graphql: async () => {
      queries++;
      return Response.json(billingResponse());
    },
  };
  t.mock.method(authenticate, "admin", async () => ({ admin }));
  assert.equal(await subscriptionFor(admin as any), null);
  await assert.rejects(
    requireSubscription(new Request("https://app.example/app")),
    /Choose a Starter or Growth/,
  );
  assert.equal(queries, 2);
});

test("upgrades, downgrades and removal of approval follow Shopify's current subscription", async (t) => {
  let active = [subscription()];
  const admin = { graphql: async () => Response.json(billingResponse(active)) };
  t.mock.method(authenticate, "admin", async () => ({ admin }));
  const request = new Request("https://app.example/app");
  assert.equal((await subscriptionFor(admin as any))?.plan, "STARTER");
  await assert.rejects(requireSubscription(request, "bulk"), /require Growth/);
  active = [subscription("GROWTH")];
  assert.equal((await requireSubscription(request, "bulk")).plan, "GROWTH");
  active = [subscription("STARTER")];
  assert.equal((await requireSubscription(request)).plan, "STARTER");
  await assert.rejects(requireSubscription(request, "bulk"), /require Growth/);
  active = [];
  await assert.rejects(
    requireSubscription(request),
    /Choose a Starter or Growth/,
  );
});

test("declined, canceled, pending, expired and unknown subscriptions grant no plan", async () => {
  for (const status of [
    "DECLINED",
    "CANCELLED",
    "PENDING",
    "EXPIRED",
    "FROZEN",
  ]) {
    const admin = {
      graphql: async () =>
        Response.json(billingResponse([subscription("GROWTH", status)])),
    };
    assert.equal(await subscriptionFor(admin as any), null, status);
  }
  const unknown = { ...subscription(), name: "Unrecognized plan" };
  assert.equal(
    await subscriptionFor({
      graphql: async () => Response.json(billingResponse([unknown])),
    } as any),
    null,
  );
});

test("Shopify test subscriptions grant access only to verified development stores", async (t) => {
  legacyFlag(t);
  for (const development of [false, true]) {
    const admin = {
      graphql: async () =>
        Response.json(
          billingResponse(
            [subscription("STARTER", "ACTIVE", true)],
            development,
          ),
        ),
    };
    assert.equal(
      (await subscriptionFor(admin as any))?.plan ?? null,
      development ? "STARTER" : null,
    );
    assert.equal(await isDevelopmentStore(admin as any), development);
  }
  const unknownStore = billingResponse([
    subscription("GROWTH", "ACTIVE", true),
  ]);
  delete (unknownStore.data as any).shop;
  assert.equal(
    await subscriptionFor({
      graphql: async () => Response.json(unknownStore),
    } as any),
    null,
  );
});

test("billing verification errors fail closed and earlier prices remain eligible for replacement", async () => {
  for (const body of [{ errors: [{ message: "Denied" }] }, { data: {} }]) {
    const admin = { graphql: async () => Response.json(body) };
    await assert.rejects(subscriptionFor(admin as any), /Unable to verify/);
    await assert.rejects(isDevelopmentStore(admin as any), /Unable to verify/);
  }
  const earlier = subscription("GROWTH");
  earlier.lineItems[0].plan.pricingDetails.price.amount = "49.99";
  const current = await subscriptionFor({
    graphql: async () => Response.json(billingResponse([earlier])),
  } as any);
  assert.equal(current?.plan, "GROWTH");
  assert.equal(current?.matchesPrice, false);
});

function mockSettings(
  t: TestContext,
  development: boolean,
  requests: any[],
  requestError?: Error,
) {
  const originalFindUnique = prisma.session.findUnique;
  (prisma.session as any).findUnique = async () => ({ role: "ADMIN" });
  t.after(() => {
    prisma.session.findUnique = originalFindUnique;
  });
  t.mock.method(authenticate, "admin", async () => ({
    session: {
      shop: "billing-test.myshopify.com",
      id: "owner",
      isOnline: true,
    },
    admin: {
      graphql: async () => Response.json(billingResponse([], development)),
    },
    billing: {
      request: async (options: any) => {
        requests.push(options);
        if (requestError) throw requestError;
        throw new Response(null, {
          status: 302,
          headers: { Location: "https://admin.shopify.com/charges/approve" },
        });
      },
    },
  }));
}

function planRequest(plan: string) {
  return new Request("https://app.example/app/settings", {
    method: "POST",
    body: new URLSearchParams({ intent: "start-billing", plan }),
  });
}

test("both plan switches request real merchant charges and preserve Shopify approval redirects", async (t) => {
  legacyFlag(t);
  const requests: any[] = [];
  mockSettings(t, false, requests);
  for (const plan of Object.values(PLANS)) {
    await assert.rejects(
      settingsAction({ request: planRequest(plan.name) } as any),
      (error: any) =>
        error instanceof Response &&
        error.status === 302 &&
        error.headers.get("Location")?.startsWith("https://admin.shopify.com/"),
    );
  }
  assert.deepEqual(
    requests,
    Object.values(PLANS).map((plan) => ({
      plan: plan.name,
      isTest: false,
      returnUrl: billingReturnUrl("billing-test.myshopify.com"),
    })),
  );
});

test("development stores still require Shopify's test-charge approval", async (t) => {
  const requests: any[] = [];
  mockSettings(t, true, requests);
  await assert.rejects(
    settingsAction({ request: planRequest(PLANS.STARTER.name) } as any),
    (error: any) => error instanceof Response && error.status === 302,
  );
  assert.equal(requests[0].isTest, true);
});

test("invalid plans and unverified stores cannot create a charge", async (t) => {
  const requests: any[] = [];
  mockSettings(t, false, requests);
  assert.equal(
    (await settingsAction({ request: planRequest("invalid") } as any)).status,
    400,
  );
  t.mock.method(authenticate, "admin", async () => ({
    session: {
      shop: "billing-test.myshopify.com",
      id: "owner",
      isOnline: true,
    },
    admin: {
      graphql: async () =>
        Response.json({ errors: [{ message: "Unavailable" }] }),
    },
    billing: {
      request: async () => {
        requests.push("unexpected");
      },
    },
  }));
  assert.equal(
    (await settingsAction({ request: planRequest(PLANS.STARTER.name) } as any))
      .status,
    400,
  );
  assert.deepEqual(requests, []);
});

test("public login has no manual domain flow while Shopify launch parameters are retained", async () => {
  const response = await loginLoader({
    request: new Request("https://app.example/auth/login"),
  } as any);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/");
  const post = await loginAction({
    request: new Request("https://app.example/auth/login", {
      method: "POST",
      body: new URLSearchParams({ shop: "typed-shop.myshopify.com" }),
    }),
  } as any);
  assert.equal(post.status, 303);
  assert.equal(post.headers.get("Location"), "/");
  const query = "shop=billing-test.myshopify.com&host=shopify-host&embedded=1";
  await assert.rejects(
    homeLoader({
      request: new Request(`https://app.example/?${query}`),
    } as any),
    (error: any) =>
      error instanceof Response &&
      error.headers.get("Location") === `/app?${query}`,
  );
});

test("Shopify-provided login still redirects to Shopify managed installation", async () => {
  await assert.rejects(
    loginLoader({
      request: new Request(
        "https://app.example/auth/login?shop=billing-test.myshopify.com",
      ),
    } as any),
    (error: any) =>
      error instanceof Response &&
      error.status === 302 &&
      error.headers
        .get("Location")
        ?.startsWith(
          "https://admin.shopify.com/store/billing-test/oauth/install?",
        ),
  );
});

test("billing returns to the authenticated store even when request and configured stores differ", async (t) => {
  const requests: any[] = [];
  mockSettings(t, false, requests);
  await assert.rejects(
    settingsAction({
      request: new Request(
        "https://app.example/app/settings?shop=other-review.myshopify.com&host=untrusted",
        {
          method: "POST",
          body: new URLSearchParams({
            intent: "start-billing",
            plan: PLANS.STARTER.name,
            shop: "another-store.myshopify.com",
            returnUrl: "https://evil.example",
          }),
        },
      ),
    } as any),
    (error: any) => error instanceof Response && error.status === 302,
  );
  assert.equal(
    requests[0].returnUrl,
    `https://admin.shopify.com/store/billing-test/apps/${process.env.SHOPIFY_API_KEY}/app/settings?billing=returned`,
  );
});

test("store navigation rejects external destinations and never guesses a default store", () => {
  assert.equal(
    shopDomain(" Review-Store.myshopify.com "),
    "review-store.myshopify.com",
  );
  assert.equal(
    shopifyAdminAppsUrl("review-store.myshopify.com"),
    "https://admin.shopify.com/store/review-store/apps",
  );
  for (const shop of [
    null,
    "",
    "evil.example",
    "review.myshopify.com.evil.example",
    "review.myshopify.com/admin",
    "https://review.myshopify.com",
    "-review.myshopify.com",
  ]) {
    assert.equal(shopifyAdminAppsUrl(shop), null);
    assert.throws(() => billingReturnUrl(shop as string), /Unable to reopen/);
  }
});

test("reinstall without an active Shopify subscription requests fresh approval", async (t) => {
  const requests: any[] = [];
  mockSettings(t, true, requests);
  await assert.rejects(
    requireSubscription(new Request("https://app.example/app")),
    /Choose a Starter or Growth/,
  );
  await assert.rejects(
    settingsAction({ request: planRequest(PLANS.GROWTH.name) } as any),
    (error: any) => error instanceof Response && error.status === 302,
  );
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].returnUrl,
    billingReturnUrl("billing-test.myshopify.com"),
  );
});

test("billing API failures retain a retryable merchant message without provider details", async (t) => {
  const requests: any[] = [];
  mockSettings(
    t,
    true,
    requests,
    new Error("HTTP 500 internal billing response"),
  );
  const response = await settingsAction({
    request: planRequest(PLANS.STARTER.name),
  } as any);
  assert.equal(response.status, 400);
  const result = await response.json();
  assert.ok("error" in result);
  assert.equal(
    result.error,
    "We couldn't open Shopify's subscription approval. Please try again.",
  );
});

test("public installation uses the configured Shopify listing without guessing a store", async (t) => {
  const previous = process.env.SHOPIFY_APP_LISTING_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.SHOPIFY_APP_LISTING_URL;
    else process.env.SHOPIFY_APP_LISTING_URL = previous;
  });
  process.env.SHOPIFY_APP_LISTING_URL =
    "https://apps.shopify.com/example-listing-for-tests";
  const data = await homeLoader({
    request: new Request(
      "https://app.example/?listingUrl=https://evil.example",
    ),
  } as any);
  assert.equal(data.listingUrl, process.env.SHOPIFY_APP_LISTING_URL);
  delete process.env.SHOPIFY_APP_LISTING_URL;
  assert.equal(
    (await homeLoader({ request: new Request("https://app.example/") } as any))
      .listingUrl,
    null,
  );
});

test("listing links accept Shopify listings/previews and reject generic Admin or external destinations", () => {
  for (const value of [
    "https://apps.shopify.com/example-listing-for-tests",
    "https://apps.shopify.com/example-preview-for-tests/preview/en",
  ])
    assert.equal(shopifyAppListingUrl(value), value);
  for (const value of [
    null,
    "",
    "bad url",
    "http://apps.shopify.com/example",
    "https://apps.shopify.com/",
    "https://admin.shopify.com/apps",
    "https://admin.shopify.com/store/review/apps",
    "https://apps.shopify.com.evil.example/example",
    "https://user:secret@apps.shopify.com/example",
    "https://apps.shopify.com:8443/example",
  ])
    assert.equal(shopifyAppListingUrl(value), null);
});
