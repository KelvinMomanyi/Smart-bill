# SmartBill live Shopify verification — 8 October 2026

**9 October OCR follow-up:** [Supplied-invoice remediation](SHOPIFY_OCR_LIVE_REMEDIATION_2026-10-09.md) verifies manual WEBP upload, actual OCR completion, invoice review and four-item PO persistence. Parser, blank-exchange-rate and invoice-refresh timestamp fixes are deployed and verified. A fresh valid PO, reopen, refresh and database check also passed on the final build. Earlier pending-OCR statements below describe the 8 October scope.

Live PO creation and the Shopify test-charge approval return work in `creatorsstore254.myshopify.com`. With the user's deployment approval, the additional navigation/refresh fixes were **deployed to production** in commit `15f561f36463f1b4b170964dd711af80cceba7c1`. A fresh merchant launch, new PO creation/reopen, database verification, native home navigation and refresh passed on the deployed build. OCR file uploads, live reinstall, and accounting exports remain unverified. This report supersedes earlier reports' statements that merchant UI testing had not been possible.

## Deployment and final live verification

The tested changes were committed and pushed to `main`, triggering the repository's existing Vercel production integration. GitHub reports the new commit as **Active / Deployed (completed)** in Production. Deployment ID: `6MpW74zsP7Z6yWD5StmtrYYB8wnD`; deployment URL: `https://smart-bill-self-rjyerfkps-bostone339-6995.vercel.app`. The merchant application remains at **`https://smart-bill-self-five.vercel.app`**. The new asset hashes and rendered context-preserving links were verified at that live URL.

The locally signed-in Vercel account and saved project link were stale and could not access this project. Deployment used the existing GitHub integration for `bostone339-6995/smart-bill-self`; no new project was created and no domain or environment configuration was changed. No new migrations were added. Direct CLI build logs were unavailable; GitHub's deployment status and actual merchant behavior confirmed completion.

Final merchant checks were made with Playwright MCP in the installed app in CreatorsStore254. These checks used the deployed application without response interception or mocked services:

| Post-deployment check | Result | Evidence |
|---|---|---|
| Fresh installed-app launch | PASS | App document 200; correct Admin store; rendered home href contains that shop and canonical host. |
| Original valid PO workflow repeated | PASS | `MCP-DEPLOY-20261008-01`, vendor `MCP Live Supplies`, expected date `2026-10-15`, SKU `MCP-PAPER-01`, Printer paper, quantity `2.5`, unit cost `12.50`, notes `Post-deployment Shopify review — delivery door 2`. POST `/app/reconciliation` returned 200 and `Purchase order created`. |
| Saved PO reopen | PASS | UI shows supplier, date, notes, line values and USD 31.25 total; ID `dbb30f3d-8c83-4f90-b544-b0d4a40df551`. |
| Actual database persistence | PASS | Read-only PostgreSQL query verified every saved field, supplier/store ownership and item foreign key. Exactly one matching PO exists; invalid test number `MCP-DEPLOY-INVALID-01` has zero records. |
| Refresh saved PO | PASS | At the previously failing 630-pixel iframe width: document 200, values preserved, zero uncaught page exceptions and no failed app resources. |
| Native browser document navigation to rendered home href | PASS | Returned through normal authentication redirects to `admin.shopify.com/store/creatorsstore254/apps/smartbill-1/app`; merchant home visible, no public landing document, no 4xx/5xx or uncaught exceptions. |
| Missing PO and recovery link | PASS | Document 200, `Purchase order not found`; `Back to purchase orders` opened the usable creation form with the correct store context. |
| Missing supplier and duplicate PO | PASS | Both returned controlled 200 validation responses, highlighted the appropriate field and retained typed values. Loading ended and submit became enabled again. No raw HTTP message appeared. |
| Saved manual invoice review | PASS | Reopened via the app's home/list link; corrected description, due date, USD subtotal/tax/total and linked PO selection retained. This is not a successful OCR-upload test. |
| Shopify billing state | PASS | Settings reloaded with 200, Starter usage and `Current plan`, in the same store; no additional charge was requested. Hosted approval/cancel/retry was already verified live before this deployment; it was not repeated after deployment. |
| Chrome DevTools public-page diagnostics | PASS | Fresh reload of the live origin: 15 requests, all 200, no console warnings/errors in this separate unsigned-in profile. |

Browser automation reset during follow-up and was reconnected to the same signed-in store. A first direct database read timed out; the subsequent verification and final uniqueness/invalid-record checks passed. Shopify Admin still logs an optional ShopifyQL capability warning and another app's stale development-preview WebSocket error. A diagnostic DOM activation of its sidebar in the hidden browser also generated `Transition was aborted because of invalid state. Document hidden`; the destination loaded with 200. Keyboard/forced sidebar clicks were unreliable in that hidden session. These limitations are recorded separately from the passing PO, home-document, refresh and recovery checks; this is not a claim that every Shopify Admin console entry is clean.

Deployment evidence is retained in ignored `.cache/deployment-verification-20261008.json`, `.cache/deployment-browser-evidence.json`, `.cache/deployment-refresh-and-sidebar.json` and `.cache/deployed-po-database-evidence.json`. The earlier test matrices below retain their historical scope unless explicitly updated.

## Root cause

### Reported PO HTTP 400

The current deployed app did not reproduce the reported 400: seven valid POs were entered, submitted, and reopened through the installed app in Shopify Admin, and all seven persisted correctly in PostgreSQL.

The earlier implementation's visible item controls lacked form names and relied on a hidden `structuredItems` JSON snapshot. Before hydration that snapshot was `[]`; valid visible entries could therefore reach the server as an empty item list and fail validation. The earlier action also classified unrelated failures as 400. The committed PO remediation uses named native controls, shared parsing, transactional saving and submission replay protection. This is a demonstrated defect in the previous implementation, but the reviewer's historical request and server logs are unavailable, so it cannot be conclusively identified as the cause of that exact rejection.

### Additional live navigation defect

Opening the app's home link before hydration completed generated a native `GET /app` with no Shopify navigation context. The observed chain was `/app` (302), `/auth/login` (302), then the public `/` landing page (200), while the parent remained in CreatorsStore254 Admin.

The installed Shopify SDK requires both `shop` and `host` on document requests without a session-token header. Its `validateShopAndHostParams` helper sends missing hints to the login path without preserving them. Supplying `shop` alone was also tested and still reached the public landing page. Supplying the correct shop and canonical encoded Admin host successfully reopened the installed app in the same store through the real Shopify UI.

Internal links previously rendered bare app paths. The new shared navigation component preserves both hints using the authenticated app loader's shop, including PO links, invoice links, navigation, back buttons, retry actions and native GET search forms. Shopify authentication remains mandatory; these hints grant no data access. No configured development store or previous store is used as a fallback.

### Additional live refresh defect

Refreshing an existing PO produced React hydration errors #418 and #423. Polaris 12.27's `MediaQueryProvider` initializes its state from `matchMedia` in the browser but from `false` on the server. Below 768 pixels its Page header can render a different DOM during hydration, forcing React to discard the server render.

The new installation/build patch makes the initial state `false` in both ESM and CommonJS builds. The provider's existing mount effect and resize listener then apply the actual viewport. An isolated test with the actual Polaris components reproduced the original error at 360 and 630 pixels; the fix produces zero recoverable hydration errors at 360, 630, 768 and 1440 pixels, with responsive headers and working form submission. Errors are not suppressed. The patch checks the installed package version and fails clearly if an upgrade requires review.

## Live PO request evidence

The app was launched from its installed Shopify Admin entry, including the initial permission update. The tested deployment was `https://smart-bill-self-five.vercel.app`, app handle `smartbill-1`. A separate legacy browser tab used another hostname; it was not treated as this deployment.

The first PO contained exactly:

| Field | Value |
|---|---|
| Vendor | `MCP Live Supplies` |
| PO number | `MCP-LIVE-20261008-01` |
| Expected date | `2026-10-15` |
| SKU | `MCP-PAPER-01` |
| Item name | `Printer paper` |
| Quantity | `2.5` |
| Unit cost | `12.50` |
| Notes | `Live Shopify review verification — delivery door 2` |
| Pasted rows | Empty |
| Intent | `create-po` |
| Submission ID | `86d41c65-82d2-432d-bb30-1e3f5dfc0b78` |

Before submission the populated merchant form was visible, with one item and its submit button. Its native FormData was captured before pressing submit. The generated request was **POST `/app/reconciliation`**, Content-Type **`application/x-www-form-urlencoded;charset=UTF-8`**, returning **HTTP 200** with:

```json
{
  "success": true,
  "message": "Purchase order created",
  "purchaseOrderId": "86d41c65-82d2-432d-bb30-1e3f5dfc0b78",
  "purchaseOrderNumber": "MCP-LIVE-20261008-01"
}
```

The UI displayed `Purchase order created` and an Open/receive link. Reopening showed the supplier, expected date, notes, item, quantity, unit cost and USD 31.25 total. A read-only database query confirmed the same values and shop ownership.

The merchant Playwright extension returned an empty raw request body from its network inspection API. Consequently, the evidence includes native FormData, response JSON/status, reopened UI and persisted values; **it does not include a captured raw production POST body**. Named `itemSku`, `itemName`, `itemQuantity` and `itemRate` controls match the server's shared form reader. Numeric strings are parsed and validated on the server. Date, notes and PO number are optional; accounting export is not part of PO saving.

### All seven live successful cases

All totals below are USD. Every case was created and reopened through merchant UI and then verified read-only in PostgreSQL, including vendor ownership, item relationships, quantities, prices, dates, notes and one record per PO number.

| PO / database ID | Vendor / date | Items: SKU, description, quantity × unit cost | Notes / result |
|---|---|---|---|
| `MCP-LIVE-20261008-01` / `86d41c65-82d2-432d-bb30-1e3f5dfc0b78` | MCP Live Supplies / 2026-10-15 | MCP-PAPER-01, Printer paper, 2.5 × 12.50 | `Live Shopify review verification — delivery door 2`; total 31.25 |
| `MCP-LIVE-20261008-02` / `41fe3090-5a6e-4f6a-ac80-2bcd7cb93be0` | MCP Live Supplies / 2026-11-01 | MCP-A, Paper cartons, 3 × 10.01; MCP-B, Complimentary sample, 2.5 × 0 | `Multiple items; zero-price sample`; total 30.03 |
| `MCP-LIVE-20261008-03` / `9e80b370-4ac8-447b-bba1-09a2052ea0b8` | Entered `  MCP Live Second Supplier & Co  ` / 2027-02-28 | MCP-CAFÉ, Fractional pack, 3.125 × 9.99 | Entered `  Reference: Nairobi café — 部品  `; whitespace trimmed; total 31.22 |
| `MCP-LIVE-20261008-04` / `738754bc-b72e-4088-bcf1-60e8feff9d10` | MCP Live Supplies / 2026-12-31 | MCP-MAX, Large wholesale lot, 1000000 × 99999.99 | Exactly 2000 `M` characters; total 99999990000 |
| `MCP-LIVE-20261008-05` / `7b444c63-0aae-4dd5-a76c-2044290c8aaa` | MCP Live Supplies / 2026-10-20 | MCP-DOUBLE, Shipping boxes, 2 × 20 | `Rapid double-click submission`; one record; total 40 |
| Blank PO number / `6e8f5da1-3174-44b6-97f6-4b43d51d81be` | MCP Live Supplies / date blank | SKU blank, Unpriced planned item, 1.25 × cost blank | `Optional PO number, date, SKU and unit cost`; null optional values; total 0 |
| `MCP-LIVE-20261008-06` / `6599a10e-ce35-46f6-8f1d-ef5358438d44` | MCP Live Second Supplier & Co / 2026-10-30 | MCP-C, Imported widgets, 4 × 2.50; MCP-D, Imported sample, 1 × 0 | `Imported spreadsheet rows`; total 10 |

The final case imported these exact tab-separated rows using the UI's Import action:

```text
MCP-C Imported widgets	4	2.50
MCP-D Imported sample	1	0
```

PO entry has no separate tax control. A taxed PO case cannot be claimed. Tax was verified in the manual invoice workflow below.

## Billing evidence

In CreatorsStore254, Starter approval was requested through Settings. The Shopify-hosted approval visibly stated **“You will not be billed for this test charge.”** The first approval was canceled using Shopify's back action, returning to the app installation details. Reopening SmartBill showed no active plan and allowed another approval request.

The second request, charge ID `75831869716`, was approved on Shopify's hosted UI. Shopify returned to:

```text
https://admin.shopify.com/store/creatorsstore254/apps/smartbill-1/app/settings?billing=returned&charge_id=75831869716
```

The app displayed `Starter is your active plan for creatorsstore254.myshopify.com.` The active plan button was disabled. There was no public landing-page or different-store return in this approval test. This verifies cancel/reopen/re-request/approve behavior; it is not evidence of an actual uninstall/reinstall test or an explicitly observed DECLINED subscription status.

Uninstall/reinstall was not performed. The uninstall webhook deletes existing accounting connections/authorizations and sessions and cancels queued/processing OCR jobs. This store has an existing Xero connection whose Demo Company status is unverified. Clarification was requested before taking that destructive step; a disposable development store is preferable. Local simulated browser tests cover reinstall with no active subscription, but do not replace live verification.

## Invoice fallback and persistence

Chrome's extension denied both Playwright file-selection methods with `DOM.setFileInputFiles: Not allowed`. The attempted PDF selection attached no file and made no upload request. No PDF/JPG/PNG recognition success is claimed.

The merchant's manual-text fallback was tested instead. An invoice containing supplier MCP Live Supplies, reference `MCP-LIVE-INV-MANUAL-01`, date 2026-10-08, due date 2026-10-22, 2.5 Printer paper at 12.50, subtotal 31.25, tax 3.13 and total USD 34.38 was captured and linked to the first PO. Capture returned 200 and `Invoice ... saved for review.`

Through the invoice review UI, the description was corrected to `Printer paper (reviewed)` and the due date to 2026-10-25. Save returned 200 and `Invoice updated.` The saved form retained the correction. PostgreSQL confirmed invoice `bc544bdb-85ea-49bd-b147-26f5db43d7aa`, supplier/store ownership, PO relationship, dates, corrected description, quantity, price, subtotal, tax and total. No accounting-export or stock-cost-change record was created.

The invoice correctly showed operational review guidance for the USD/KES conversion and the absence of a physical delivery. It was not approved or exported. This verifies manual capture/review/edit/save and PO linking, **not OCR recognition**.

## MCP evidence and limitations

| MCP / access | Used | Important evidence / limitation |
|---|---|---|
| Playwright MCP | YES | Actual signed-in Shopify Admin, installed app launch, test-charge cancel/retry/approve, seven initial PO creations/reopens plus one after deployment, validation, manual invoice review, direct/missing routes, back/forward and network/console observations. Final deployment checks include native home document navigation, PO refresh, recovery and current plan. Browser keyboard interaction was used when hidden-window actionability prevented mouse clicks; sidebar DOM activation was diagnostic. File attachment was denied by Chrome. Connection resets interrupted some attempts; the post-deployment launch and core checks were completed after reconnecting. |
| Chrome DevTools MCP | YES | Live public landing-page network and console diagnostics: initial 13 requests all 200/304, final post-deployment reload 15 requests all 200, no console warnings/errors. Also exercised through a local stdio MCP client earlier in the session. Its separate headless profile was not signed into Shopify; it did not independently inspect the authenticated merchant PO POST. Merchant POST diagnostics came from Playwright. |
| Shopify Dev MCP | YES | Connected via local stdio MCP, version 1.16.0. Consulted review/authentication/billing docs and validated `partnerDevelopment` and `currentAppInstallation.activeSubscriptions` GraphQL queries against Admin API 2026-10; both valid. The canonical CLI-fetched code-review requirements include 1.2.2. Search results did not provide a complete current 2.1.3 evaluation; actual runtime findings determine this report's negative readiness conclusion. Installed SDK source confirmed the shop/host requirement. |
| Database / Supabase MCP | NO | No callable database MCP connection was available. The app database is PostgreSQL; actual persistence was verified through read-only Prisma queries, not Supabase MCP. Supabase document storage was not verified through live upload. |
| Xero MCP | NO | No working MCP test credentials. The existing app connection is not verified as Demo Company. No export, token expiry, contact, duplicate or outage test was performed against Xero. |
| QuickBooks MCP | NO | Configured MCP credentials were placeholders and its configured local server file was absent. The app showed QuickBooks sandbox disconnected. No sandbox export was performed. |

Local evidence is retained in `.cache/live-merchant-mcp-evidence.json`, `.cache/live-merchant-retry-evidence.json`, `.cache/live-merchant-database-evidence.json`, and the MCP session logs. Billing and PO screenshots are in `.cache/live-billing-*-test-charge.png`, `.cache/live-po-before-submit.png`, and `.cache/live-po-reopened.png`. These files are ignored diagnostic artifacts. Temporary browser asset interception was used for hydration diagnostics and then removed; it was not a deployment or a live acceptance test of the final source changes.

## Tests performed

PASS below means the stated scope passed. BLOCKED/NOT RUN identifies missing evidence rather than an assumed application failure.

| Test | Result | Notes |
|---|---|---|
| Open installed app from Shopify Admin Apps | PASS live | Correct CreatorsStore254 app; permission update completed. |
| Shopify hosted test-charge approval and same-store return | PASS live | Starter active in the same store after approval. |
| Cancel approval, reopen and request approval again | PASS live | Second request could be approved; formal DECLINED status not queried. |
| Live uninstall/reinstall and fresh approval | BLOCKED | Existing unverified Xero connection would be deleted; clarification pending. |
| Valid single-item PO | PASS live | 200, success UI, reopen and database verification. |
| Multiple items | PASS live | Two items persisted with exact values. |
| Fractional quantities/prices | PASS live | 2.5 and 3.125 quantities; decimal prices and rounded total verified. |
| Zero price / absent optional values | PASS live | Zero and null costs; blank PO number/date/SKU supported. |
| Different supplier/date/notes/reference/Unicode | PASS live | Trimmed whitespace and Unicode preserved appropriately. |
| Large valid numbers and 2000-character notes | PASS live | Bounded large-value case saved/reopened. |
| Spreadsheet import | PASS live | Two rows imported and persisted. |
| Double-click submit | PASS live | One PO record. |
| Missing / whitespace supplier | PASS live | `Enter a vendor name.` in usable form; values retained. |
| No line items | PASS live | Appropriate item guidance, no record created. |
| Zero/negative quantity and negative price | PASS live | Native number validation blocked submission. |
| Duplicate PO number | PASS live | Field guidance; existing record preserved. |
| Malformed amounts, invalid dates, over-limit strings | PASS local / NOT RUN live | Server and browser regressions cover these; not all were exercised in the merchant session. |
| Distinct taxed PO | NOT APPLICABLE | PO form has no tax field; taxed invoice verified separately. |
| Direct PO list/create route | PASS live | Creation shares `/app/reconciliation`; 200 and usable form. |
| Direct existing PO route / reopen | PASS live | Saved values visible. |
| Missing/nonexistent PO route | PASS live | 200, `Purchase order not found`, recovery action. |
| Refresh embedded existing PO | PASS after deployment | Original audit found hydration exceptions. Deployed fix retested at 630 pixels: 200, values preserved, zero uncaught exceptions. |
| Native home navigation | PASS after deployment | Original pre-hydration audit reached the public landing page. Native document navigation to the deployed rendered home href now returns to the correct store's embedded app. |
| Fully hydrated in-app home navigation | PASS live | Invoice-to-home transition worked. |
| Browser back / forward | PASS live | Home and saved invoice remained usable after hydration. |
| Admin navigation away/back and final fresh launch | NOT COMPLETED | Final attempt was interrupted when the MCP connection reset to its Welcome tab. Initial installed-app launch passed. |
| Actual expired merchant session | NOT RUN live | No global merchant cookies were cleared; SDK recovery tested locally. |
| Manual invoice capture → review/edit/save → PO link | PASS live | 200 responses and actual PostgreSQL values verified. |
| PDF, JPG, PNG and multipage PDF OCR | BLOCKED | Browser file-selection permission denied. |
| Poor/rotated/missing-field OCR and timeout/service failure | BLOCKED live | Synthetic fixtures prepared; local OCR tests pass, live recognition not verified. |
| Xero Demo export and failure scenarios | NOT VERIFIED | Test company/working MCP connection unavailable. |
| QuickBooks Sandbox export and failure scenarios | NOT CONFIGURED/CONNECTED for testing | No working sandbox MCP credentials/connection. |
| Database persistence / tenant ownership / duplicate prevention | PASS live | All seven POs and the corrected manual invoice verified read-only. |
| App exceptions on final PO/refresh/home checks | PASS after deployment | No uncaught exceptions in these app checks. Entire Admin console remains outside this pass: stale dev-preview WebSocket and hidden-document transition diagnostics are recorded above. |
| Unexpected 4xx/5xx during valid PO submissions | PASS observed scope | All seven PO submissions returned 200. This is not a complete all-workflows audit. |
| Common viewport sizes | PASS local | PO form at 360/768/1440; focused responsive hydration test at 360/630/768/1440. |
| Unit/service regression suite | PASS local | 169 tests; accounting providers are simulated in these tests. |
| Production-build PO browser regression | PASS local | 27 checks, isolated persistence, zero uncaught exceptions/unexpected network failures. |
| Production-build billing browser regression | PASS local | 22 checks across two simulated shops, zero uncaught exceptions/unexpected network failures. |
| TypeScript / production build / targeted lint / submission checks | PASS local | Final source builds; SDK native URL recovery and SSR navigation hints checked. Existing dependency deprecation/build notices remain. |

## Network issues found

| Observation | Classification / resolution |
|---|---|
| Historical valid-PO HTTP 400 | Not reproduced on current deployment. Seven live valid submissions returned 200. Historical raw request unavailable. |
| `/app` 302 → `/auth/login` 302 → public `/` 200 | Unexpected merchant navigation failure reproduced and fixed. Deployed links retain both Shopify hints; final native document navigation reached the correct embedded store, with no public landing document. |
| React #418 / #423 on PO refresh | Application JavaScript/SSR failure fixed by deterministic provider initialization. Deployed PO refresh passed at 630 pixels with zero uncaught exceptions. |
| POST `/app/settings` 401 during billing handoff | Expected Shopify SDK/App Bridge redirect protocol; actual hosted approval and same-store return succeeded. Not treated as failed authentication. |
| Shopify Admin developer-preview WebSocket failure | Originated in Shopify Admin for a different app's stale preview. Not a SmartBill PO request; not changed. |
| Shopify accounts challenge 403 in anonymous headless Chrome | Unauthenticated diagnostic profile could not complete login. Challenge was not bypassed. Merchant tests used the existing signed-in Playwright session. |
| Local controlled accounting callback 400s and unknown route 404s | Invalid simulated operations displayed recovery UI. No unexpected failures in the final isolated browser suites. |
| PostgreSQL read connection timeout during verification | First retry failed; subsequent read-only verification succeeded for every recorded PO and invoice. No database data was changed by verification. |

## Files changed in this review

The implementation and test changes below were deployed in commit `15f561f`; the two reports are local review artifacts. Earlier committed PO/billing remediations were already present at the review's start.

| File | Purpose |
|---|---|
| `app/components/EmbeddedLink.tsx` | Shared internal links, native GET navigation fields and route helper hook using authenticated app shop. |
| `app/utils/shopifyNavigation.ts` | Preserve validated shop and canonical encoded host on app paths. |
| `app/components/AppErrorState.tsx` | Preserve both SDK hints in recovery links. |
| `app/components/InvoiceOcr.tsx` | Use context-preserving invoice review links. |
| `app/routes/app.tsx` | App menu and brand/home links preserve store context. |
| `app/routes/app._index.tsx` | Invoice/job links, primary action and navigation buttons preserve context. |
| `app/routes/app.reconciliation.tsx` | PO open, billing recovery and retry navigation preserve context. |
| `app/routes/app.receipts.$id.tsx` | PO detail back action preserves context. |
| `app/routes/app.invoices.tsx` | Review links, pagination and native GET search preserve context. |
| `app/routes/app.invoices.$id.tsx` | Invoice/credit/accounting navigation and back action preserve context. |
| `app/routes/app.invoices.$id_.accounting.tsx` | Accounting details return navigation preserves context. |
| `app/routes/app.credit-notes.tsx` | Credit/invoice links, back action and native GET filters preserve context. |
| `app/routes/app.credit-notes.$id.tsx` | Credit detail and invoice navigation preserve context. |
| `app/routes/app.reports.tsx` | Invoice links and native GET report filters preserve context. |
| `app/__tests__/billing.test.ts` | Check correct-store navigation, stale hint replacement, query/hash retention and external-path exclusions. |
| `scripts/patch-polaris-ssr.mjs` | Idempotent version-checked fix for Polaris's SSR media-query initialization in both module builds. |
| `scripts/check-polaris-hydration.mjs` | Actual Polaris SSR/Chrome regression fixture, original-defect replay, responsive and form checks. |
| `package.json` | Apply the SSR patch during install and both build commands. |
| `scripts/check-po-workflow.mjs` | Check server-rendered home links with JavaScript enabled and disabled. |
| `scripts/check-submission.mjs` | Verify actual SDK native document recovery with shop and canonical host. |
| `SHOPIFY_LIVE_MCP_VERIFICATION_2026-10-08.md` | Current evidence, findings, limits and readiness report. |
| `SHOPIFY_LAUNCH_STATUS_2026-10-08.md` | Point earlier status to this live review and correct its outdated deployment conclusion. |

Ignored `.cache` additions contain read-only verification clients, synthetic invoice fixtures and diagnostic evidence; no secrets or OAuth callbacks were added to tracked files. Deployment was authorized and completed. No migration was added, and no charge configuration, authentication bypass or live accounting export was performed.

## Remaining issues and Shopify requirement conclusion

1. The navigation/hydration deployment and core merchant retest are complete. Complete the remaining broad live matrix, including Admin away/back, expired sessions and additional viewport cases; earlier local passes do not establish those live results.
2. Restore a stable signed-in Playwright session with working file-picker access and complete the full OCR format/failure matrix. The manual fallback pass does not satisfy this requirement.
3. Use a disposable development store, or clarify permission regarding the existing accounting connection, for actual uninstall/reinstall and renewed charge approval.
4. Connect verified Xero Demo Company and QuickBooks Sandbox environments/MCPs before live export and failure-path tests. Never use the unverified existing Xero company for this review.
5. Configure the official Shopify listing/preview installation URL if the public landing page must offer an Install button. It currently gives installation instructions; it no longer guesses a store through generic Admin navigation.
6. Complete the remaining expired-session and broader authenticated network/console audit. Chrome DevTools' public profile is not proof of the merchant POST payload.

Requirement 2.1.3's reported valid PO workflow passes on the deployed build, and the additional native-navigation and refresh defects pass their final live checks. Unverified OCR and the remaining broader live matrix prevent a full readiness claim. Requirement 1.2.2's hosted test approval return passes in the real store and the active plan remains correct after deployment; live reinstall approval remains unverified. Local automated passes are not a substitute for these remaining merchant tests.

Follow-up: [9 October MCP restart and live verification](SHOPIFY_MCP_RESTART_VERIFICATION_2026-10-09.md) confirms another valid PO submission, database persistence, refresh, missing-record recovery and correct-store primary navigation. A separate MCP browser permits file attachment and awaits Shopify sign-in for live OCR.

**NOT READY FOR SHOPIFY RETEST**
