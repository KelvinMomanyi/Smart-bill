# Shopify billing return remediation: requirement 1.2.2

Reviewed 8 October 2026. Local implementation and verification completed. **No deployment or real charge approval was performed. Live Shopify retesting remains required.** Earlier uncommitted PO/error-handling changes were preserved.

## Root cause and deployed reproduction

The app already uses the Shopify Billing API through `billing.request`. Its custom return URL overrode the SDK's embedded return behavior with `SHOPIFY_APP_URL + /app/settings`. That URL supplied neither `shop` nor embedded store context. After hosted approval, the app could not resolve the merchant session and sent the browser through `/auth/login` to `/`.

Chrome DevTools MCP reproduced this navigation against the deployed application:

| Request | Result |
| --- | --- |
| `GET https://smart-bill-self-five.vercel.app/app/settings` | 302 to `/auth/login` |
| `GET /auth/login` | 302 to `/` |
| `GET /` | 200, public landing page |

The deployed landing page's `Open Shopify admin` link was `https://admin.shopify.com/apps`. It contained no store identity, so it could reopen whichever store Shopify selected from the browser account. It was not hardcoded to the configured development store; its lack of a store was the problem.

This reproduces the contextless return destination and matches the rejection. The reviewer's actual hosted charge approval, screenshots and exact request were not available in this session, so an actual approved production charge round trip is not claimed.

## Implementation

Billing now returns to:

```text
https://admin.shopify.com/store/{authenticated-shop}/apps/{app-api-key}/app/settings?billing=returned
```

The shop comes exclusively from the authenticated `session.shop`. Submitted `shop`, `host`, `returnUrl`, a developer store setting and the public application origin cannot select the billing return store. Shop domains and the app identifier are validated before constructing the URL. The installed Shopify SDK also uses the API key to identify an app in embedded Admin URLs.

The existing `billing.request` implementation still creates the Shopify-hosted approval flow with the configured plan, trial, replacement behavior and store-verified test flag. Its thrown redirect and reauthentication Responses remain preserved. Real merchant stores request real charges; only Shopify-verified development stores request test charges. No bypass was introduced.

Settings queries `currentAppInstallation.activeSubscriptions` every time it loads. `billing=returned`, `charge_id` and claimed status values cannot activate a plan. The returned UI identifies the store and its current approved plan. Without an active plan, it explains that the merchant can choose a plan and request approval again. Declining a replacement retains the existing approved plan. Missing approval after reinstall leaves plan selection available and paid actions gated by Shopify's current state. Existing uninstall cleanup removes sessions; no locally cached plan is accepted as billing authority.

Plan buttons are disabled during submission and for the current plan at its current price. Shopify billing failures keep the form usable with: `We couldn't open Shopify's subscription approval. Please try again.` Provider response details are not displayed.

Recovery pages prefer the authenticated app loader's shop, otherwise a validated shop navigation hint. Their Admin link explicitly targets that store's Apps page and their app recovery link retains the shop. With no store context, they instruct the merchant to reopen the store they were using rather than offering a generic `Open Shopify admin` link. The public landing page labels its generic Shopify destination `Choose your store in Shopify`; it does not claim to know the merchant's current store. No manual shop-domain installation form was introduced.

## Verification

The browser harness runs the **production app bundle, actual route loaders/actions and actual Shopify billing SDK** in Edge through the local Playwright library. Sessions, database, App Bridge behavior, Shopify GraphQL responses, hosted approval pages and Admin embedding are simulated. It never creates a real charge or modifies merchant records. This distinction applies to every local billing browser PASS below.

| Test | Result | Evidence |
| --- | --- | --- |
| Deployed contextless return reaches landing | REPRODUCED | Chrome DevTools document requests: 302 → 302 → 200 |
| Approve a subscription and return to Settings | PASS locally | Both isolated stores return to their own Admin/app URL and show active plan |
| Decline and request approval again | PASS locally | Both stores retain usable plan forms and no entitlement |
| Decline a replacement plan | PASS locally | Existing Starter approval remains active |
| Upgrade and downgrade | PASS locally | Growth and Starter transitions, both stores |
| Reinstall with no active subscription | PASS locally | Fresh approval requested; simulated Shopify cancellation/reset |
| Return-page refresh | PASS locally | Requeries current Shopify subscription |
| Billing API rejection and retry | PASS locally | Safe message, no provider details, retry succeeds |
| Forged `charge_id` / status / return flag | PASS locally | No subscription access granted |
| Request specifies a different store/return URL | PASS | Action regression uses authenticated shop instead |
| Recovery Admin link | PASS locally | Exact store-specific URLs for both stores |
| Public launch wording | PASS locally | Generic destination explicitly asks the visitor to choose a store |
| Current-plan control | PASS locally | Current plan disabled; loading-state disabling is implemented but was not separately timed |
| Billing browser suite | PASS | 21 checks, 12 simulated charge creations/return navigations |
| Charge terms | PASS, captured mutations | Starter 9.99 / Growth 29.99 USD, EVERY_30_DAYS; 14-day trial, APPLY_IMMEDIATELY, test true in the verified-development-store fixture |
| Merchant versus development charges | PASS, mocked action regressions | `isTest: false` on merchant stores; true only after Shopify development-plan verification |
| PO browser regressions | PASS locally | 25 checks, including JavaScript and native HTML creation/reopen |
| PostgreSQL PO regression | PASS, rolled back | Nine latest browser payloads verified through Prisma; persistence, tenant isolation, replay and rollback; zero committed test records |
| Automated regressions | PASS | 166 tests |
| TypeScript, lint, production build | PASS | Existing Remix deprecation and build chunk/import notices only |
| Public landing, managed login, legal-page bundle checks | PASS | `npm run check:submission` |
| Actual Shopify-hosted approval / decline / uninstall-reinstall | BLOCKED | No authenticated Shopify merchant browser session |

The final billing browser run reported zero uncaught browser exceptions and zero unexpected failed requests. Expected statuses were two controlled 400 responses for injected billing rejection, twelve SDK 401 responses carrying `X-Shopify-API-Request-Failure-Reauthorize-Url` to open Shopify approval, and two controlled 404 recovery pages. The SDK 401 is part of its App Bridge navigation protocol, not a failed subscription authentication check.

The test harness's approval page initially had a charge-ID parsing error and its navigation interception initially allowed a redirect to Shopify login. Both test-fixture problems were corrected before the passing run. No real charge was approved during those attempts.

Chrome DevTools separately inspected the local return UI: HTTP 200, `Settings and plans`, `Starter is your active plan for billing-review-a.myshopify.com.`, a disabled current-plan control, and the store-specific recovery URL. No console errors appeared on the final local Settings page. The fixture generated an App Bridge preload warning because its SDK script is replaced locally; this was not attributed to production.

## MCP evidence and limitations

- **Chrome DevTools MCP:** used for the deployed failing navigation, generic Admin-link inspection, local Settings return state, document status, console diagnostics and recovery-link inspection.
- **Playwright MCP:** retried; Chrome extension remains unavailable. No successful Playwright MCP test is claimed. The installed Playwright library supplied the 21 billing and 25 PO browser checks.
- **Shopify Dev MCP:** unavailable. Current official Shopify documentation and the installed Shopify SDK implementation were checked instead.
- **Database, Xero and QuickBooks MCPs:** not used for this billing change. The browser checks use isolated persistence, and no accounting export is part of this workflow.

The supplemental PO database regression used Prisma/PostgreSQL directly, not a database MCP. The normal local app was rebuilt and restarted at `http://localhost:3000`; Chrome DevTools confirmed its public landing page returned 200 with the updated store-selection wording. An initial session-storage connection attempt reported a database connectivity error; the subsequent direct database regression completed successfully. No production app deployment or accounting write occurred.

## Files changed in this billing remediation

| File | Purpose |
| --- | --- |
| `app/utils/shopifyNavigation.ts` | Validate shop domains; construct store-specific Admin/app destinations |
| `app/services/billing.server.ts` | Build the authenticated store's embedded billing return URL |
| `app/routes/app.settings.tsx` | Correct billing return, safe request failure, current-subscription return banner, disabled submission state |
| `app/routes/app.tsx` | Expose the authenticated shop for recovery navigation |
| `app/components/AppErrorState.tsx` | Store-specific Admin recovery and retained shop on app recovery links |
| `app/routes/_index/route.tsx` | Distinguish public store selection from a known-store return |
| `app/__tests__/billing.test.ts` | Correct expected return and cover store isolation, invalid destinations, reinstall approval and API failure |
| `scripts/check-billing-workflow.mjs` | Actual production UI/SDK browser regressions with simulated provider responses |
| `package.json` | Add `npm run check:billing` |
| `README.md` | Document return behavior and verification command |
| `SHOPIFY_BILLING_REVIEW_2026-10-08.md` | This evidence and handoff report |

No schema migration, pricing change, new access scope or development-store configuration change is needed.

## Evidence and reproduction commands

- [Billing browser evidence](.cache/billing-review-browser-evidence.json): checks, all captured billing mutation variables, actual requested return URLs and network classification. Contains no real credentials.
- [Store A recovery screenshot](.cache/billing-recovery-0.png) and [Store B recovery screenshot](.cache/billing-recovery-1.png).
- [PO browser evidence](.cache/po-review-browser-evidence.json).
- [PostgreSQL rollback evidence](.cache/po-review-database-evidence.json).

Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build:check`, `npm run check:billing`, `npm run check:po` and `npm run check:submission`. On Windows, stop local app/test servers before rebuilding because Prisma's loaded DLL cannot be replaced.

Official references: [Shopify requirement 1.2.2](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements#implement-shopify-app-pricing-or-the-shopify-billing-api-correctly), [Shopify Remix billing and embedded navigation](https://shopify.dev/docs/api/shopify-app-remix/latest/authenticate/admin), and [subscription billing/uninstall behavior](https://shopify.dev/docs/apps/launch/billing/manual-pricing/subscription-billing). Shopify requires charge approval, decline and renewed approval after reinstall; this implementation retains Shopify as billing authority and uses the SDK's documented embedded return-URL pattern.

## Remaining live acceptance

Deploy the reviewed revision, then use a signed-in development/review store to approve and decline actual Shopify-hosted test charges, request approval again, switch both plan directions and uninstall/reinstall. Confirm that Shopify returns to that same store's embedded Settings page, verify the actual subscription through Shopify, and repeat with a second store/account context. Test session expiry and third-party-cookie restrictions through real App Bridge. The earlier PO review's live verification requirements also remain outstanding.

**NOT READY FOR SHOPIFY RETEST** until deployment and the actual hosted billing round trip are verified.
