# SmartBill submission readiness — 16 October 2026

**Local validation passes. Production deployment and final live acceptance remain blocked, so do not resubmit yet.** No new deployment or Partner Dashboard submission was performed. This report supersedes the earlier build-blocked status in this file.

## Fixes completed

- Paid-plan recognition now accepts Shopify's ACTIVE Starter/Growth subscriptions independently of the test-charge flag and the store's partner-development flag. Charge creation still requests real billing on merchant stores. Unapproved, inactive and unknown plans remain ineligible; callback parameters cannot grant access.
- The browser billing matrix now covers an approved test charge on a non-development review store. This reproduces the concrete recognition defect consistent with the screencast; the recording does not expose the original Shopify response, so its exact historical cause is unconfirmed.
- Restored the three required source/test files that were staged for deletion, recovered three null-byte-damaged files from clean Git blobs, and reinstalled the locked dependencies. Damaged-file backups remain in the ignored recovery directory. The restored files match HEAD; unrelated edits were preserved.
- Updated compatible dependencies and added scoped security overrides for minimatch 9.0.9, tar 7.5.22 in the build cache, lodash 4.18.1 and ws 7.5.13 in the Remix development tool.
- Updated the server PDF.js canvas-factory API. A real scanned-PDF test then exposed a separate contrast bug: when sparse text occupies less than the low-percentile sample, both sample endpoints can be white, turning the entire page black. Normalization now preserves the background. The same scanned PDF changed from empty OCR output to correctly recognized invoice number and total.
- Added repeatable `test:billing` and `test:pdf` commands, review-store browser coverage, and real-SDK mandatory-webhook signature checks.

## Final validation

The following results use the final source and dependency tree. Browser checks use its fresh production bundle. Simulated Shopify responses, isolated persistence and actual provider calls are distinguished below.

| Check | Result | Scope |
| --- | --- | --- |
| Unit/service/route/accounting tests | PASS — 215 tests, zero failures | Provider and database responses mocked |
| Server scanned-PDF regression | PASS | Actual PDF.js, native canvas and local Tesseract; synthetic invoice; no paid OCR call |
| GraphQL generation/validation | PASS | Configured Shopify Admin API 2026-10 |
| Typechecking and lint | PASS | Final source; lint emits an upstream config-deprecation warning |
| Production build | PASS | Final release bundle; an earlier Windows Prisma DLL lock was resolved by running the build after tests finished |
| Billing browser matrix | PASS — 22 checks | Actual UI/SDK; simulated Shopify charge approval, decline, plan changes and reinstall; two isolated stores |
| PO browser matrix | PASS — 27 checks | Actual UI/routes; isolated persistence and provider responses; zero unexpected network failures or browser exceptions |
| Browser OCR matrix | PASS — 8 document cases and failure/retry scenarios | Actual browser Tesseract/PDF.js on synthetic PNG/JPG/PDF/multipage/rotated/poor scans; missing source fields require review |
| Public launch/login/legal and mandatory webhooks | PASS | Final production bundle; forged compliance signatures rejected, signed customer privacy requests acknowledged; no live database |
| Public production app/privacy/terms | PASS | HTTPS 200; Playwright MCP snapshots; public-page console check reports zero errors/warnings |
| Shopify CLI app configuration | PASS | Authenticated official CLI reports `valid: true`, no issues; linked app and public URL match source |
| Live development-store subscription lookup | PASS | Read-only existing app session; Shopify identifies the store as development and reports ACTIVE Starter, USD 9.99, matching current price |

The live lookup reads the existing subscription. It does not establish that a fresh hosted approval round trip or this new source has been deployed. No charge was created or approved, no app was uninstalled, and no merchant accounting entry or product cost was changed in these checks.

## Security assessment

`npm audit --omit=dev` improved from **59 findings (7 critical)** to **23 findings (0 critical, 16 high, 7 moderate)**. The remaining findings are not a clean security sign-off.

Remaining roots include React Router/Remix, Prisma's configuration dependency, and build/MDX tooling. Many audit entries inherit the same underlying advisory. The app disables Single Fetch, which is a condition for [the turbo-stream DoS advisory](https://github.com/advisories/GHSA-rxv8-25v2-qmq8). In the source reviewed, app links use fixed internal paths or generated record IDs; no attacker-controlled navigation destination or user overwrite of error constructors was found. These source observations reduce specific exposure but do not remove [the navigation advisory](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6) or [the conditional SSR error-constructor advisory](https://github.com/advisories/GHSA-337j-9hxr-rhxg) from the dependency tree.

Braces/chokidar, MDX/TOML/ESTree and esbuild findings concern build/development tooling in this app; they should not process untrusted merchant files or be exposed through a production development server. Prisma's deep-merge finding concerns trusted developer configuration. A supported framework/tooling upgrade and final reachability review remain maintenance work before claiming comprehensive security clearance. No forced SDK downgrade, broad major-version substitution or dependency-vulnerability suppression was applied.

## Current requirements assessment

Used the official Shopify Dev MCP review instructions and fetched the current checklist with `shopify doc fetch`. All **100 entries** are accounted for in [the requirement matrix](SHOPIFY_REQUIREMENTS_MATRIX_2026-10-16.md): **25 likely passing, 0 likely failing, 6 needing review; 69 entries skipped across 10 category groups**. Skipped entries are not passes. This is a local subset of [Shopify's full requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements), which also require operational features and accurate listing/reviewer information.

The six outstanding local-checklist assessments concern incognito authentication, factual listing claims, actual charge approval/decline/reinstall, actual upgrade/downgrade history, fresh-install destination and reinstall authentication. No matching theme, payment, purchase-option, checkout, sales-channel or post-purchase extension was detected. Supplier purchase-order reconciliation does not itself establish a product-sourcing or payment app.

## Access and live acceptance still needed

1. **Access to the existing Vercel project.** CLI login succeeded, but the account exposes only `kelvinmomanyis-projects`. It cannot inspect SmartBill's original project or `smart-bill-self-five.vercel.app`. The existing local project linkage points to another team. Grant access to that project or authenticate its owner account before deployment.
2. **Authenticated Shopify browser session.** The separate Edge test window is at Shopify login with a CAPTCHA-loading failure. Complete this vendor-hosted sign-in manually. Chrome DevTools MCP could not attach to the default Chrome profile because no debugging endpoint was available; Playwright MCP successfully inspected the separate browser and public production pages.
3. **Actual final-release acceptance.** Deploy the verified source, identify the deployed revision, then record hosted approval and decline, both plan changes, reload and renewed approval after reinstall on a suitable disposable test installation. Verify paid feature access against Shopify's actual active state. The existing development store contains merchant records/connections, so a destructive uninstall was not performed.
4. **Listing and integration verification.** Review the actual Dashboard listing, category, screenshots, support/privacy links, pricing and working reviewer access. Confirm listed OCR, invoice/PO/cost workflows and configured Xero/QuickBooks test-company exports on the deployed release. The accounting tests here use mocked providers, not live sandbox exports.
5. **Close the remaining dependency-risk assessment** before asserting comprehensive security readiness.

## Tools and evidence

Installed and exercised the official Shopify Dev and Playwright MCP servers in the ignored local tools directory. Used Shopify CLI for the fresh review checklist, app info, released-version listing and config validation; used Vercel CLI for login and project-access checks. Shopify/Vercel app integrations were offered but no connection was confirmed; successful CLI authentication is recorded separately.

Raw evidence is in `.cache/submission-2026-10-16/`: `release-*.log`, `npm-audit-release.json`, `requirements.md`, `requirements-assessments.json`, MCP outputs, public-page snapshots, live read-only billing output and access-check results. No credential files are tracked. Source fingerprint: `365895eb2d322dff9a85453b12a76efa30e7f46918c66544de24cb16559792e0`; per-file hashes and baseline commit are in `release-fingerprint.json`. The fingerprint identifies a working-tree candidate, not a deployed release.

Reproduce locally with `npm ci`, `npm test`, `npm run test:pdf`, `npm run graphql-codegen -- --config .graphqlrc.ts`, `npm run typecheck`, `npm run lint`, `npm run build:check`, `npm run check:billing`, `npm run check:po`, `npm run check:submission` and `npm run test:ocr-browser`. On Windows, let tests finish before the Prisma-generating build to avoid a loaded DLL lock. Reassess dependency advisories with `npm audit --omit=dev`.
