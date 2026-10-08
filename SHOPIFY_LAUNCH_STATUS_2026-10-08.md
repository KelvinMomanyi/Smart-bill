# SmartBill launch and Shopify rejection status

Follow-up checked 8 October 2026. This report supplements the [PO runtime review](SHOPIFY_PO_RUNTIME_REVIEW_2026-10-07.md) and [billing review](SHOPIFY_BILLING_REVIEW_2026-10-08.md). Those reports describe earlier work; their local passing results do not establish live Shopify approval.

## Current conclusion

Neither rejection is confirmed resolved in the installed live app. Both have implementation fixes and local regression evidence. The public site's generic Admin link is still deployed; the additional public-link correction in this follow-up has not been deployed by this session. Some earlier changes are live, as shown by the updated button wording. The deployed Git revision could not be verified.

## Why the app link opens the wrong place

The public application origin does not identify a store. On the live page, the button says `Choose your store in Shopify`, but its destination is still `https://admin.shopify.com/apps`. That destination neither installs SmartBill nor specifies the store where SmartBill is installed. Relabeling the button did not fix its destination.

The newly supplied `screenshot1.webp` shows Shopify-hosted test subscription approval in a review store. `screenshot2.webp` shows the public landing page with the earlier `Open Shopify admin` button. These screenshots corroborate the reported sequence; they do not expose the original approval request or demonstrate that the new billing return has been deployed successfully.

Installation must start through Shopify. For development installations, use Dev Dashboard > the app > Installs > Install app and select the intended store. Existing merchants open SmartBill from Apps in their own store. A published or preview App Store listing can provide the public installation entry point. The app must not guess a store from a developer setting or send every merchant to one hardcoded store.

Official references: [Shopify Dev Dashboard installation](https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard) and [Shopify App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements).

## Implementation status

**PO / requirement 2.1.3:** The earlier form's unnamed visible item controls and initially empty hidden JSON could submit no items before hydration. Named form controls and shared parsing fix that concrete defect. Idempotent saving, retained values, field validation and usable error/not-found states are implemented. The reviewer's exact production HTTP 400 has not been captured, so its precise cause remains unconfirmed. PO creation does not call Xero or QuickBooks.

**Billing / requirement 1.2.2:** The earlier billing return used a contextless public `/app/settings` URL. Without shop/session context, authentication redirected it to the landing page. The implementation now returns through the authenticated store's embedded Admin URL, constructed from `session.shop` and the app API key. Settings rechecks Shopify's active subscription rather than trusting callback flags. Decline, retry and reinstall cases pass local browser tests with simulated Shopify responses.

**Additional public-link correction:** The public page now offers `Install SmartBill on Shopify` only when `SHOPIFY_APP_LISTING_URL` contains an allowed HTTPS Shopify App Store listing/preview URL. Request parameters cannot choose that destination. Otherwise it explains Shopify installation and opening an already installed app from the merchant's own store. The misleading generic Admin link has been removed locally. No manual shop-domain form or hardcoded store was introduced.

SmartBill's actual Shopify-generated listing/preview link is absent from the repository/environment. It must be supplied and configured before a working public installation button can be deployed. The test URL in the automated checks is explicitly a fixture; it is not SmartBill's listing.

## Live browser evidence

Read-only browser observation at `2026-10-08T08:11:11.362Z`, using the installed Playwright library and Edge:

| Request / observation | Result |
| --- | --- |
| Public application `/` | 200, SmartBill landing UI |
| Landing Shopify button | Generic `https://admin.shopify.com/apps` destination |
| Contextless `/app/settings` | 302 to `/auth/login`, then 302 to `/`, then landing 200 |
| Signed-in merchant session | Unavailable |

The contextless redirect alone does not prove that the corrected billing return is absent: the correction deliberately returns through a store-specific Admin URL instead. No actual hosted approval round trip was executed. Evidence: [.cache/live-launch-evidence.json](.cache/live-launch-evidence.json) and [.cache/live-launch.png](.cache/live-launch.png).

## Verification results

PASS is limited to the stated environment. BLOCKED is not a pass.

| Test | Result | Notes |
| --- | --- | --- |
| Open installed app from Shopify Admin | BLOCKED | No authenticated merchant browser |
| Actual live valid PO submission and reopen | BLOCKED | Reviewer's request still unavailable |
| Single/multiple-item PO, fractional values, validation, reload and reopen | PASS locally, earlier review | 25 browser checks using isolated persistence; not repeated for this public-link-only follow-up |
| Missing PO route | PASS locally, earlier review | Operational not-found UI, safe navigation |
| PO database persistence | PASS, earlier rolled-back verification | Nine browser payloads replayed through Prisma/PostgreSQL; no committed merchant test records |
| Billing approval/decline/retry/reinstall and store-specific return | PASS locally | Current production bundle and actual billing SDK; simulated provider responses, two stores |
| Billing browser suite | PASS | 22 checks; 12 simulated charge requests, zero real charges |
| Public page without a configured listing | PASS locally | No generic Admin link; installation guidance remains usable |
| Public installation button with configured listing | PASS locally | Real browser click; Shopify listing destination deliberately simulated |
| Invalid/external listing configuration | PASS | Rejected; request parameters cannot override configured destination |
| Actual Shopify-hosted approval/decline/reinstall | BLOCKED | No signed-in Shopify session |
| Full merchant invoice upload > OCR > review > PO/save | BLOCKED | Earlier PNG/PDF engine smoke checks and mocked regressions do not establish merchant UI success |
| Xero Demo Company export | BLOCKED | No verified Demo Company or Xero MCP; no export attempted |
| QuickBooks Sandbox export | BLOCKED | No verified sandbox session or QuickBooks MCP; no export attempted |
| Automated regressions | PASS | 168 tests |
| TypeScript / lint / production build | PASS | Existing Remix deprecation and Vite chunk/import notices only |
| Production-bundle public/login/legal checks | PASS | `npm run check:submission` |
| Browser exceptions / unexpected requests | PASS locally | Current billing suite: zero uncaught exceptions, zero unexpected error responses |

Commands completed: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build:check`, `npm run check:billing`, `npm run check:submission`.

The normally started rebuilt app is running at `http://localhost:3000`. A local HTTP smoke check returned 200, confirmed the generic Admin link is absent and confirmed the installation guidance is present. This supplemental HTTP check is not merchant UI acceptance. The first sandboxed startup could not establish database TLS; restarting outside the sandbox succeeded without weakening database connection settings.

## Network findings

No new unexpected 4xx/5xx was observed in this follow-up's live public-document check or local billing matrix. The live navigation has the documented contextless 302 chain. The local billing suite deliberately includes two handled 400 rejections, twelve SDK 401 responses carrying the App Bridge approval navigation protocol, and two controlled 404 recovery pages. These remain usable UI states, with no exposed provider errors. This is not a complete authenticated production network audit.

## MCP evidence

- **Playwright MCP:** attempted this follow-up; browser tools fail because the required Chrome extension is missing. No successful Playwright MCP verification is claimed. Local Playwright supplied the read-only live check and 22 browser regressions.
- **Chrome DevTools MCP:** unavailable in this follow-up. Used in earlier PO/billing reviews as documented there; not substituted with a claim of current MCP use.
- **Shopify Dev MCP:** unavailable. Current official Shopify documentation and the installed billing SDK were checked instead.
- **Database/Supabase MCP:** unavailable/not connected. Earlier persistence verification used Prisma/PostgreSQL directly.
- **Xero / QuickBooks MCP:** unavailable. No live accounting operations were performed.

## Files changed in this follow-up

| File | Purpose |
| --- | --- |
| `app/routes/_index/route.tsx` | Replace generic Admin button with configured Shopify listing installation; explain existing-store launch |
| `app/utils/shopifyNavigation.ts` | Validate the configured Shopify listing URL |
| `.env.example` | Document `SHOPIFY_APP_LISTING_URL` without inventing an actual listing |
| `README.md` | Explain correct public, development and installed-store entry points |
| `app/__tests__/billing.test.ts` | Check configured destination, URL validation and rejection of request overrides |
| `scripts/check-billing-workflow.mjs` | Browser-check configured install-link navigation and absence of generic Admin link |
| `scripts/check-submission.mjs` | Check production rendering with missing, valid and invalid listing configuration |
| `SHOPIFY_LAUNCH_STATUS_2026-10-08.md` | Current evidence, limitations and release status |

The screenshot additions/deletion present in the working tree were supplied separately and were not edited by this follow-up. Generated `.cache` evidence is ignored by Git.

## Remaining acceptance

1. Supply the exact failing app link, intended store and Shopify-generated listing/installation link. Configure the valid listing URL for a public installation button.
2. Deploy the reviewed application revision to the configured app origin and verify its deployed revision/environment. No deployment was performed by this session.
3. In a signed-in Shopify test/review store, launch from Admin, submit valid PO data, inspect the actual request/response, verify the committed database record and reopen it.
4. Approve and decline actual Shopify-hosted test charges, retry and uninstall/reinstall; verify return to the same store. Repeat in a second store context and check session restart/expiry.
5. Complete the outstanding installed-app navigation, OCR and configured accounting acceptance matrices in the earlier reports.

**NOT READY FOR SHOPIFY RETEST**
