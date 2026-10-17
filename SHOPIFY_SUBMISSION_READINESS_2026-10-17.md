# SmartBill submission readiness — 17 October 2026

The reported paid-plan recognition defect is fixed and has passed live Shopify approval, refresh, downgrade, upgrade and reinstall checks. This is not yet a comprehensive compliance sign-off: Xero demo-company acceptance and residual dependency maintenance remain open. No resubmission or “all requirements met” attestation has been made.

## Live acceptance completed

Used the official Playwright MCP through the Chrome extension against the existing signed-in Google Chrome session. Shopify Dev MCP independently validated billing and lifecycle GraphQL operations for API 2026-10; live subscription/provider reads used the app's authenticated SDKs.

| Area | Evidence |
| --- | --- |
| Hosted billing approval | Approved Starter, returned to its correct 50-invoice limit, refreshed successfully, and confirmed the subscription through Shopify. Restored original Growth and verified its 250-invoice limit and USD 29.99 price. All approvals explicitly displayed Shopify's test-charge notice. |
| Declined plan change | Canceled a hosted Starter approval; the existing Growth plan remained active. |
| Fresh installation | Created the free `smartbill-review-20261017.myshopify.com` development store. Shopify-native install approval reached the working embedded app and Settings. |
| Uninstall and reinstall | Uninstalled only that empty test installation with Shopify's documented self-uninstall API. The real uninstall webhook removed sessions (2 to 0). Native reinstallation created fresh sessions, retained no paid access, and required new approval. New Starter subscription: `74100605005`. |
| Chrome with cookies/storage blocked | A fresh isolated Chrome context loaded authenticated Settings and survived refresh with third-party-cookie restrictions, all app cookie headers removed, Set-Cookie responses discarded, and app localStorage denied. 43 app requests and a bearer-authenticated request were observed. Shopify sign-in was reused only in memory; app cookies and storage were not supplied. Initial headless attempts were correctly rejected by Shopify's bot guard; the successful test used visible Chrome. |
| Live OCR and review | Uploaded a synthetic PNG through the deployed capture flow. Browser OCR reported 95% confidence; supplier, invoice number, invoice/due dates, USD currency, subtotal 10, tax 0 and total 10 matched the source. The private original rendered in review. Saved corrections and completed required approval. |
| QuickBooks sandbox | Existing reviewer account connected `Sandbox Company US 4304`; live catalog contained 55 purchase accounts. Approved invoice `SB-QA-20261017-01` exported to unpaid bill `147`. Independent provider read verified one bill, USD 10 total and balance, and agreement with the approved supplier/dates/currency/amounts. Original PNG attachment `1000000021` was independently verified as linked to that bill. No production QuickBooks company was used. |
| Xero existing connection | Read-only production connection/catalog check passed for the existing store. No bill was created in that company. Fresh Xero reviewer login/demo-company export remains open. |
| Public surfaces | Production landing page, privacy policy and terms return HTTPS 200. Legal pages identify Bowstone Studios and a working-format contact address. The saved YouTube screencast returns public oEmbed metadata. This confirms accessibility, not that the entire recording is up to date. |

The existing `creatorsstore254` invoices and accounting connection were preserved. Its original Growth plan was restored. The new review store holds clearly synthetic test records and a Shopify test subscription.

## Listing corrections saved in Shopify

Inspected the actual Partner Dashboard and listing editor rather than relying on source descriptions. The primary category is Store management → Finances → Accounting. Shopify's preliminary checks displayed supported API versions, valid configuration, emergency contact, a checked English listing, no protected-customer-data requirement, and passed common-error checks.

Saved these draft corrections and reloaded to verify persistence:

- Consistent app name **SmartBill** and plan name **Growth**, replacing “Smart Bill” and “Pro.”
- Removed unsupported annual offers (USD 100 and USD 290). Public plans now display USD 9.99/month and USD 29.99/month with 14-day trials, matching the Billing API configuration.
- Removed the inactive “Invoice email inbox” feature. The app now displays its inbox controls only when configured; the supported Growth description promises bulk upload instead.
- Added a usable sample invoice and explicit billing approval/refresh/cancellation instructions. Instructions retain the production host's 4 MB upload-batch limit.
- Replaced generic screenshot descriptions with meaningful alt text. Inspected the icon, promotional image and three desktop screenshots: consistent branding, sample data, no pricing in the logo, and features represented in the app.

The app UI now discloses the actual per-file and per-batch limits for its deployment (4 MB on Vercel), while retaining the 10-page document limit. The reviewer accounts are present; credentials were used only in browser sign-in and were not committed or printed.

## Functionality fix found during live review

A valid freight line was incorrectly entering PO product matching, producing an “unmatched item” discrepancy and potentially inflating billed stock when a charge reused a product SKU. Reconciliation now excludes explicitly classified freight, duty, handling, insurance and other charges from stock matching. Product quantities and unexpected product lines still receive the existing safeguards.

Two focused regressions reproduced the defect before the fix and pass afterward. The full suite now passes **217 tests**. Live PO, physical receipt and cost-update/restore acceptance is being recorded separately before closing this item.

## Local release validation

- 217 unit/service/route/accounting tests passed, including the new freight regressions.
- Typecheck, lint and production build passed. Lint emits the existing upstream Remix config deprecation warning.
- Chrome browser matrices passed: 22 billing checks, 27 PO checks, and eight OCR cases plus safe failure/retry scenarios. Missing source fields correctly require review. All Windows browser scripts now select Chrome explicitly.
- Built-release public launch, authentication redirects, legal pages and mandatory-webhook signature checks passed.
- Shopify Dev MCP validated lifecycle query and self-uninstall mutation against Admin API 2026-10. Draft-product/cost setup operations were also validated before live testing.

## Dependency review

The refreshed production audit fell from **23 findings (16 high, 7 moderate)** to **16 findings (12 high, 4 moderate; no critical)** after scoped updates to esbuild 0.25.12, Prisma configuration's deepmerge-ts 8.0.2, and TOML 4.3.0. Generation, tests and builds passed with those APIs. No forced downgrade of Shopify SDKs or suppression of audit findings was used.

Remaining findings include inherited package entries and six underlying advisory families:

| Advisory family | Current source assessment |
| --- | --- |
| turbo-stream single-fetch DoS | Single Fetch is explicitly disabled in Vite configuration and the built manifest. No defer/Await flow is used by the app. The vulnerable package version remains installed. |
| React Router navigation/open redirects | App links use fixed paths, generated record IDs or validated Shopify listing URLs. No merchant-controlled destination is passed directly to Link/useNavigate. This is an exposure assessment, not an upstream patch. |
| React Router SSR error constructor injection | Installed Remix sanitizes production Error instances to plain Error before serialization; current custom error names are fixed constants. No request-controlled error constructor assignment was found. |
| braces recursion | Reached through filesystem watcher/build dependencies; merchants supply no glob expressions to these tools. |
| ESTree prototype pollution | Legacy MDX frontmatter build dependency; the app does not accept merchant MDX/TOML source or contain MDX routes. |

A supported framework/tooling upgrade remains maintenance work. The app has not received a clean dependency audit or comprehensive independent security certification. Reassess these conclusions if Single Fetch, error construction, navigation inputs, build inputs or deployment entry points change.

## Remaining before a full readiness claim

1. Finish Xero reviewer sign-in and connect a verified demo organisation; export a synthetic approved bill and its attachment, then independently verify them. Its vendor-hosted login did not complete in the automated Chrome session. The existing production Xero connection must not be used for test writes.
2. Complete live acceptance of the new freight reconciliation fix after deployment, including physical receipts and Shopify cost update/restore on the unpublished review product.
3. Address the remaining framework/tooling advisories through a supported upgrade, or record an explicit deployment-specific risk decision. Current reachability observations do not make the installed vulnerable versions patched.

The [requirements matrix](SHOPIFY_REQUIREMENTS_MATRIX_2026-10-16.md) now accounts for 100 local AI-checklist entries: **30 likely passing, 1 needing review, 69 category-specific entries skipped**. Skipped entries are not passes, and this subset is not Shopify's entire review process.

## Evidence and release

`5c67432` was pushed and its corrected Growth feature description was observed in production. Subsequent upload-limit and freight fixes are validated locally and require their recorded production acceptance below. Older deployment/access blockers in the 16 October report are superseded.

Raw evidence is under ignored `.cache/live-billing-2026-10-17/`, including `chrome-session-live/result-*.json`, `cookie-free-chrome/result.json`, `quickbooks-live-bill-verification.log`, `review-store-uninstall.log`, lifecycle subscription records, listing images and official Shopify MCP results. Test output is in `.cache/close-check-*.log`. These browser artifacts may contain private navigation/session data and are intentionally not tracked.
