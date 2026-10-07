# SmartBill submission review — October 7, 2026

**The three previously detected source failures are corrected. Deployment and live acceptance checks are still required before submission.** This is a local AI self-review, not confirmation of Shopify approval.

The [live Shopify checklist](https://shopify.dev/docs/apps/launch/app-store-review/app-store-ai-self-review-requirements) was fetched again at `2026-10-07T03:41:42.911Z`. This follow-up reevaluates the corrected requirements and retains the previous assessments for unchanged functionality: **28 likely passing, 0 likely failing in the corrected source, 3 needing review, 10 groups skipped (68 entries)**. All 99 checklist entries are accounted for; skipped entries are not passes.

## Corrected

- **1.2.2 — Billing:** Removed the Growth entitlement bypass and deployment test flag. Access requires an actual active Shopify subscription. Merchant stores request real charges; test subscriptions are accepted only when Shopify identifies the store as a development store. A stale `SHOPIFY_BILLING_TEST=true` cannot enable access or test merchant charges.
- **1.2.3 — Plan changes:** Starter/Growth access follows Shopify's current subscription. Both switch directions request Shopify approval; buttons distinguish starting a trial from switching an existing subscription.
- **2.3.1 — Installation:** Removed both manual shop-domain forms. The public page links to Shopify admin; Shopify-provided launch/login parameters continue through managed installation. Install unpublished apps through the Dev Dashboard and published apps through their App Store listing.
- **Cost-sync permissions:** Added `write_products` for product-variant audit metafields alongside existing product/inventory scopes. [Shopify requires the permissions of the metafield's owner resource.](https://shopify.dev/docs/api/admin-graphql/latest/mutations/metafieldsSet)
- **API support:** Updated Shopify SDK dependencies and aligned Admin API, code generation and webhooks to stable `2026-10`. Added the compatible nullable session refresh-token fields and migration; adjusted product-query handling for nullable API fields. [Version schedule](https://shopify.dev/docs/api/usage/versioning).
- Accounting callback URLs remain absent from the Settings frontend.

## Needs review

- **1.1.1 — Session-token authentication:** Verify the deployed app in Chrome incognito with third-party cookies blocked, including downloads and accounting connections.
- **1.1.4 — Factual claims:** Compare the final listing/screenshots against deployed features, configured integrations and prices: Starter **$9.99**, Growth **$29.99** USD every 30 days, 14-day trial.
- **2.3.3 — Post-install destination:** Confirm a fresh install and reinstall return to the embedded app on `https://smart-bill-self-five.vercel.app`, including owner and staff access. Hosted Shopify configuration has not yet been validated; CLI authentication is pending.

## Verification and release

- `npm test`: **146 passed, 0 failed**. Includes ten new billing/login tests; provider and database requests are mocked.
- `npm run graphql-codegen -- --config .graphqlrc.ts`: operations validated against `2026-10`.
- `npm run typecheck`: passed with generated API types.
- `npm run build:check`: production client/server build passed; no database migration or deployment was performed locally.
- `npm run check:submission`: production-bundle landing page, Shopify login/launch redirects and legal pages passed without a database or merchant charges.

Deploy this revision to the new Vercel project. Its existing `build:deploy` command applies the new Session migration before serving the build. Use Node 22 or newer. Remove any old billing-test environment variable and set:

```dotenv
SHOPIFY_APP_URL=https://smart-bill-self-five.vercel.app
SCOPES=read_products,write_products,write_inventory,read_inventory
```

After Shopify CLI login, run `shopify app config validate --json` and release the updated permissions/webhooks using `shopify app deploy`. Approve updated permissions for existing installations. Then verify actual billing approval/decline, both switches, uninstall/reinstall, cost sync, signed compliance webhooks and configured accounting/OCR flows on the deployed host. Complete Shopify's submission checks and final listing review.

## Skipped groups

No matching extensions/features were detected for 5.1 Online store, 5.2 Payment, 5.4 Purchase option, 5.6 Checkout customization, 5.7 Sales channel, or 5.8 Post purchase. Opt-in groups 5.3 Payment facilitator, 5.5 Product sourcing, 5.9 Mobile app builders, and 5.10 Donation were not requested.

See [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements), [best practices](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices), [billing guidance](https://shopify.dev/docs/apps/launch/billing), and [submission steps](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review).
