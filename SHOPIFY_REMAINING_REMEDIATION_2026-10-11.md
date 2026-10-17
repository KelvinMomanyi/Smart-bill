# Remaining Shopify remediation — 11 October 2026

## Status

The final deployed source is `ace2fa0833530976a0bd9a072f316497d6e35fd5`, **Active / Deployed (completed)**, verified through Playwright MCP in GitHub at 2026-10-11 11:08:11 UTC: `https://smart-bill-self-pjx0zao3k-bostone339-6995.vercel.app`. It includes the OCR, invoice parsing and missing-record fixes in `0fc38fb299cc4a9f8440f27d0f20d9edb29cc535`, the native-navigation fix in `bcbf04d23674fdb1ad557db480d76701c966ccb5`, and preservation of early PO entries. Actual merchant PO creation, reopening, refresh and scoped persistence pass on this final release. Fresh live file OCR, reinstall approval and accounting test-company exports remain unverified.

Testing is scoped to SmartBill in `creatorsstore254.myshopify.com`, installed app handle `smartbill-1`, production origin `https://smart-bill-self-five.vercel.app`. Historical results are preserved in the earlier review reports and `OCR_ACCURACY_LIVE_LOG.md`. No invoice was approved, exported or used to change Shopify product costs during this continuation.

## Root cause and fixes

### Original PO HTTP 400

The reviewer's original request and server logs remain unavailable. It would be inaccurate to claim the exact historical rejection was reproduced. The earlier implementation had unnamed visible item controls and relied on a hidden JSON snapshot that could remain empty before hydration. That concrete serialization defect was fixed previously with named controls, shared parsing, transactional persistence and submission replay protection. Earlier action error classification was also corrected. Current valid merchant submissions succeed through the actual Shopify UI.

### Native embedded navigation

An early click on the new invoice recovery link returned `GET /app/invoices` HTTP 302 and attempted to load Shopify Admin inside the app iframe, which Shopify refused with `X-Frame-Options: deny`. The link retained the correct shop and host but omitted `embedded=1`. The installed Shopify SDK's `ensureAppIsEmbeddedIfRequired` treats a document request without that flag as outside the embedded app. This failure was reproduced through the actual recovery link while delaying the app's client script; it was not diagnosed only from an API request. Hydrated navigation with an Authorization header succeeded, explaining the intermittent behavior.

The shared navigation helper now supplies the authenticated store, canonical host and `embedded=1`. Native GET forms carry the same three hints. These parameters do not authorize access: Shopify session-token verification and tenant queries remain mandatory. No tokens are copied into navigation links.

### PO entries made before hydration

During live form setup, the first supplier entry disappeared while the page finished loading. The server correctly returned field-level missing-vendor validation with HTTP 200 and retained the items; entering the supplier again succeeded. A separate no-write UI probe then confirmed the underlying problem: with the client script delayed, `MCP Early Input Test` appeared in the native supplier input, but became empty after hydration and editing the PO number. React initialized its controlled state from empty defaults rather than the merchant's existing native field values.

The PO form now uses its actual form ref and the existing `readPoFormValues` helper once on mount to adopt early entries. This preserves supplier, PO number, date, notes and rows before the next controlled update. It does not weaken validation or disable native server-rendered controls. `scripts/check-po-native-hydration.txt` is a repeatable Playwright MCP regression probe on the actual Shopify form; it does not submit or change database records.

The same production probe passed on `ace2fa0` at 11:08:40 UTC: supplier, number, date, notes, SKU, name and unit cost survived hydration and a subsequent quantity edit. Before and after evidence is preserved separately in `.cache/remaining-acceptance/early-input-before.json` and `early-input-after.json`. A subsequent real submission of those early-entered fields also succeeded; see final PO evidence below.

### Missing invoice, accounting detail and credit note

The live missing-invoice route displayed a recovery screen but returned document HTTP 404. The three related loaders now return explicit missing-record data with HTTP 200 and render an app recovery screen with a back action. Invoice approval-rule initialization happens only after the invoice exists. Authentication, administrative role checks and shop-scoped record queries are preserved. Missing PO links already used an operational UI state.

### Stalled browser OCR

The actual capture hook in an isolated browser remained busy with its submit control disabled when worker initialization or recognition never resolved. PDF operations and cleanup could also hang. Each asynchronous OCR operation now has a 120-second deadline; cleanup has a five-second bound. Timeout errors stop optional passes, ignore late progress, release late-created workers and reach the existing safe UI error/retry workflow. The original stored document can be retried without uploading it again. Service and API failures remain distinct from successful capture.

### Rotated invoice readings

Real Tesseract testing initially failed on an upside-down synthetic invoice and misread a sideways invoice number, despite automatic deskew. OCR now tries actual upright pixel rotations for weak portrait reads and landscape pages. A correct upright reading was initially discarded when its score tied the automatic reading; equal-score upright candidates now take precedence. Recognized digits are never rewritten to manufacture matching amounts.

### Missing invoice date and unit price

The date fallback could use a due/payment/delivery date as the invoice date. Those labels are excluded from fallback; an explicitly labeled invoice date remains preferred. A genuinely missing invoice date still produces a warning and the existing capture-date fallback requiring merchant review.

The newly uploaded quantity-first sales invoice had a blank last unit-price cell. Its quantity was retained in the description. The parser now separates that quantity and derives the unit price only from printed quantity and extended amount, with an explicit review warning. The review form labels its financial field “Product subtotal, excluding tax and charges” to distinguish it from a printed subtotal that includes freight.

## Files changed in this continuation

| File | Purpose |
|---|---|
| `app/utils/browserOcr.ts` | Bound OCR operations and cleanup; release abandoned workers; recognize upright rotations. |
| `app/utils/parser.server.ts` | Exclude unrelated date labels; parse quantity-first rows with missing price and flag inference. |
| `app/routes/app.invoices.$id.tsx` | Operational missing-invoice state; avoid missing-record writes; clarify product subtotal. |
| `app/routes/app.invoices.$id_.accounting.tsx` | Operational missing-invoice accounting state. |
| `app/routes/app.credit-notes.$id.tsx` | Operational missing-credit-note state. |
| `app/routes/app.reconciliation.tsx` | Preserve native PO entries made before React hydration. |
| `app/utils/shopifyNavigation.ts` | Preserve the required embedded flag with the authenticated shop and host. |
| `app/components/EmbeddedLink.tsx` | Carry the embedded flag in native GET forms. |
| `app/__tests__/browserOcr.test.ts` | Worker/recognition/cleanup deadlines, late worker cleanup and real candidate selection. |
| `app/__tests__/parser.test.ts` | Missing invoice date, explicit invoice/due date and missing-price row regressions. |
| `app/__tests__/missingInvoiceRoute.test.ts` | Actual route loaders: safe missing/foreign IDs, tenant scope and retained authentication. |
| `app/__tests__/billing.test.ts` | Navigation regression for stale store/host/embedded hints. |
| `app/__tests__/run.ts` | Register missing-record loader regressions. |
| `package.json` | Add `test:ocr-browser`. |
| `scripts/check-ocr-browser.mjs` | Real OCR matrix plus capture-hook recovery tests with explicitly simulated failures. |
| `scripts/check-po-native-hydration.txt` | Repeatable actual-Shopify early-input regression; no database writes. |
| `scripts/ocr-accuracy/browser-matrix.html` | Browser harness importing the production OCR/capture implementation. |
| `scripts/ocr-accuracy/make-browser-fixtures.mjs` | Generate independent PNG/JPG/PDF/multipage/rotated/poor/missing-field fixtures. |
| `scripts/ocr-accuracy/vite.browser.config.mjs` | Local-only harness; whitelist generated fixtures and deny private environment/evidence files. |
| `scripts/ocr-accuracy/README.md` | Repeatable test instructions and evidence limits. |
| `OCR_ACCURACY_LIVE_LOG.md` | Append the fifth uploaded invoice and distinct isolated-browser evidence. |
| `SHOPIFY_REMAINING_REMEDIATION_2026-10-11.md` | Current report and remaining acceptance prerequisites. |

No database schema, credentials or environment configuration was changed.

## Live uploaded sales invoice

The merchant uploaded `Sales_Invoice_Example.png` (567 × 915, one page). Job `4155dc5a-0444-4d59-b718-211461c046fa` completed and invoice `086d2fc6-da5a-49ec-b9fe-d584dbcac8c2` existed at revision 0. A browser connection restart interrupted observation of the original submission, so its upload/completion network requests are not retrospectively claimed as captured.

The source prints supplier TOM GREEN HANDYMAN, invoice 0003521, date 6/5/2016 (store DMY: 2016-05-06), subtotal 2928 including freight 150, tax 439.20 and total 3367.20. All six quantities and extended amounts and all five explicitly printed unit prices were captured correctly. The last unit price is blank on the original: 228 is inferred from quantity 1 and amount 228. A bare dollar sign does not establish an ISO currency; the default USD still requires merchant confirmation.

| Printed row | Quantity | Printed unit price | Amount |
|---|---:|---:|---:|
| Labour | 23.75 | 40 | 950 |
| Nails and screws | 50 | 0.80 | 40 |
| Paint and Plywood | 1 | 1000 | 1000 |
| Imported wall tiles | 40 | 14 | 560 |
| Freight | 1 | 150 | 150 |
| Sub-contractor : Tile-It | 1 | Missing; inferred 228 | 228 |

The untouched result had the incorrect last description `1 Sub-contractor : Tile-It`; it is not a perfect automatic OCR pass. Through the actual review UI, the description was corrected and product subtotal normalized to 2778 (= printed 2928 minus separate freight 150). Save returned HTTP 200, “Invoice updated.” Reload and scoped database verification retained all six rows, tax and total at revision 1. This is reviewed persistence, not a fresh untouched OCR run on the new deployment. Currency, FX and freight allocation still require merchant review before approval.

Private evidence includes `.cache/ocr-accuracy/live/sales-0003521-initial-ui.json`, `sales-0003521-review-save.json`, and revision-specific snapshots under `.cache/ocr-accuracy/evidence/`. These contain no authentication credentials or private document download URLs.

## Live PO evidence

After deployment, the merchant-facing PO form accepted vendor MCP Live Supplies, PO MCP-REMAINING-20261011-01, expected date 2026-10-18, SKU MCP-PAPER-01, name Printer paper, quantity 2.5, unit cost 12.5 and notes “Post-remediation live verification.”

Playwright's network inspection recorded `POST /app/reconciliation` HTTP 200 with:

```json
{"success":true,"message":"Purchase order created","purchaseOrderId":"e208eacd-550a-4170-b460-a2397bed3c6f","purchaseOrderNumber":"MCP-REMAINING-20261011-01"}
```

The UI showed success. Its “Open … and receive stock” link and browser refresh both reopened the correct PO, including supplier, date, notes, quantity 2.5, unit price USD 12.50 and total USD 31.25. Read-only database verification confirmed the current shop, vendor ownership and exactly one record; no receipt was created. The MCP's separate request-body accessor returned an empty body, so an unavailable wire payload is not invented. The entered values, success response, reopened UI and persisted fields are recorded independently.

Scoped database evidence: `.cache/remaining-acceptance/records-2026-10-11T09-45-26-033Z.json`. Exports and cost changes remained zero. The reviewed sales invoice was NEEDS_ATTENTION, unapproved, NOT_EXPORTED and NOT_REQUESTED.

On the navigation deployment, SmartBill was also launched using the actual visible Apps sidebar link in the correct store. The MCP backend's normal click/actionability waits stalled; Playwright clicked that same DOM anchor, then interacted with the rendered app. This limitation is not being reported as a Shopify app error. A two-item PO `MCP-REMAINING-20261011-02` was created for MCP Live Second Supplier & Co: paper 2.5 × 12.50 plus ink 1.25 × 17.00 = USD 52.50, expected date 2026-11-01, notes retained. It returned HTTP 200 and success; reopened and refreshed values matched. Record `b121a666-1864-48f2-ad7f-d7748e3c3b34` persisted once with correct shop/vendor ownership. Database evidence: `records-2026-10-11T10-19-21-816Z.json`.

Missing-vendor and duplicate-number submissions returned useful inline messages while keeping the form usable. A 500 ms request delay was deliberately added to observe submit behavior: loading and disabled state were both observed. The actual duplicate message explains that the PO number is already in use. No second PO was created. Fast navigation after success canceled two in-flight list revalidations (`net::ERR_ABORTED`); these were navigation cancellations, not server failures. A separate direct reopen/refresh audit contains only 200 responses and a cached icon 304, with zero failed requests, exceptions or app console errors.

### Final deployed PO verification

At 11:12:49 UTC on `ace2fa0`, the actual merchant form submitted the values entered before hydration: vendor **MCP Early Input Test**, number **MCP-REMAINING-20261011-03**, expected date **2026-10-18**, notes **Entered before hydration.**, SKU **MCP-PAPER-01**, item **Printer paper**, quantity **2.5**, unit cost **12.5**. The PO number was changed after the no-write probe; the other early-entered values remained intact. The captured form data contains those exact named values.

`POST /app/reconciliation` returned **HTTP 200**, `success: true`, message **Purchase order created**, ID `17f836c8-9e31-463c-82c4-3e87634cc590`. The visible success state linked to the new PO. After waiting for list revalidation, opening that link and refreshing the detail screen both retained the correct supplier, date, notes, item, quantity, unit price and **USD 31.25** total. The scoped network audit contains only successful 200 responses and a cached icon 304, with **zero failed app requests, uncaught exceptions or app console errors**. UI evidence: `.cache/remaining-acceptance/final-early-po-created.json`.

Read-only database verification at 11:17:57 UTC confirmed exactly one record, correct shop and vendor ownership, quantity 2.5, rate 12.5, total 31.25, OPEN status, and zero received/billed quantity. Evidence: `.cache/remaining-acceptance/records-2026-10-11T11-17-57-268Z.json`. The reviewed invoice retained its six rows; accounting exports and product cost changes remained zero.

The final Apps-sidebar launch at 15:18:25 UTC opened the correct CreatorsStore254 embedded app and enabled capture form. Its normal origin `/` redirect returned 302 followed by `/app` 200; it was not an error page or loop. All app resources loaded successfully, with no failed requests or uncaught exceptions. This last launch did not submit another PO. Evidence: `latest-admin-launch-final.json`. The browser connection had five stale file-chooser modals: they were canceled using the native cancellation operation, with no attachment supplied. Public Playwright listener removal then restored manual selection at 15:19:59 UTC, `manualPickerReady: true`, no selected files. Evidence: `final-capture-armed.json`. The browser remains on the correct-store capture page awaiting a fresh merchant-selected document.

## Live manual fallback on deployed parser

`MCP-RECOVERY-20261011-01` was entered through the actual “Or paste invoice text” field, with a due date but no invoice date and a quantity-first row lacking its unit price. Capture returned HTTP 200 and “saved for review”; its review link opened invoice `e7824000-d630-4e47-9d2a-a4e3d169e3e3` with both rows, total USD 328, invoice-date fallback 2026-10-11 and due date 2026-10-25. The UI explicitly warned about the missing invoice date and inferred unit price, and used the clearer product-subtotal label. This verifies the deployed manual fallback and parser, not file OCR.

Read-only snapshot: `.cache/ocr-accuracy/evidence/2026-10-11T10-29-04-466Z-2f221b2d-7604-4d1e-832b-226cba53e1f2.json`. A final scoped count at 10:31 UTC found 15 invoices, 13 POs, five completed file jobs, zero exports and zero product cost changes. Browser back/forward continued to render the app in the correct store. The effective narrow frame had 350 px content/scroll width with a capture button fitting within it; broader review-layout viewport coverage is not claimed from the resize calls because the connected frame remained 360 px even as host width changed.

## Tests performed

| Test | Result | Scope / notes |
|---|---|---|
| Correct-store live Shopify app launch | PASS | Fresh launch recovered the temporarily offline Admin tab. |
| Valid decimal PO creation | PASS | Real Shopify UI, HTTP 200, success, saved record. |
| Multi-item / second supplier / later date / notes | PASS | Latest navigation deployment; USD 52.50, both rows retained in UI and database. |
| Missing supplier / duplicate PO number | PASS | Inline explanations, retained fields, usable retry; no duplicate record. |
| Loading / disabled submit | PASS | Observed through actual UI with explicitly delayed request. |
| Reopen / refresh created PO | PASS | Correct supplier, dates, notes, item and total retained; app requests 200. |
| PO database persistence / ownership | PASS | Read-only tenant-scoped queries; exactly one PO. |
| Uploaded sales invoice review / save / reopen | PASS | Six rows persisted after explicitly documented review corrections. |
| Perfect untouched sales invoice extraction | FAIL | Last name included quantity; missing printed price and ambiguous currency require review. |
| Missing invoice document | PASS | New document response 200 with “Invoice not found.” |
| Early native recovery-link navigation | PASS after fix | Before: document 302 to Admin in iframe. After: normal session-token bounce and operational invoice list in same store. |
| Missing accounting detail / credit note / PO recovery | PASS | All four missing-record document responses 200; all back actions work; no app exceptions/errors. |
| Early PO input retention | PASS after fix | Actual delayed-hydration probe preserves all fields; subsequent valid PO returns 200 and persists once on final release. Original failing probe retained. |
| Manual capture with missing date / inferred price | PASS | Real Shopify UI and persisted record, explicit review warnings; not a file OCR test. |
| Browser back / forward | PASS | App states rendered in the correct store. |
| QuickBooks disconnected UI | PASS | Connect-in-Settings message; usable page rather than raw API error. |
| PNG / JPG / PDF / multipage PDF | PASS isolated browser | Real Tesseract/PDF.js; 19/19 fields per complete fixture. Not live Shopify uploads. |
| 180° / 90° rotation / poor scan | PASS isolated browser | Real recognition and actual candidate selection; 19/19 fields each. |
| Missing supplier / invoice date | PASS_REVIEW_REQUIRED isolated browser | 17/19 comparison retained; absent fields are not counted as correctly extracted. |
| OCR initialization / recognition timeout | PASS isolated browser | Actual capture hook, simulated worker stalls and advanced browser clock. |
| OCR service / API / expired-session failures | PASS isolated browser | Safe messages, released submit state, no raw confidential errors. |
| Retry original after OCR failure / timeout | PASS isolated browser | Three retries succeed without another upload. |
| Unit / route / billing / integration regressions | PASS | 214 tests, zero failures; includes mocked accounting provider tests. |
| TypeScript / targeted ESLint / build | PASS | Final PO input-preservation release: 214 tests pass, TypeScript, targeted ESLint and production build succeed. |
| Malformed amounts / impossible dates / over-limit strings | PASS local; NOT RUN live | Earlier production-bundle/server regressions cover them. All variants were not exercised in the authenticated merchant browser. |
| Taxed manual PO | NOT SUPPORTED | This PO form has no tax field. Taxed invoices and accounting exports use separate workflows. |
| Actual expired merchant session | NOT VERIFIED live | SDK recovery and expired-session UI are covered locally; no merchant-wide cookie deletion was performed. |
| Full responsive review-layout matrix | NOT VERIFIED live | Earlier isolated layouts pass; this live connection's effective frame stayed 360 px despite host resize. |
| Fresh file OCR on latest production revision | NOT VERIFIED | Automated attachment denied; merchant must select a fresh file normally. |
| Live uninstall / reinstall / renewed charge approval | NOT VERIFIED | Pending disposable store or explicit choice allowing deletion of existing Xero connection. |
| Xero Demo export | NOT CONFIGURED | Existing connection is production “yuygn”; Demo Company status unverified. No export made. |
| QuickBooks Sandbox export | NOT CONFIGURED | Sandbox connection absent. No export made. |

Complete real-recognition report: `.cache/ocr-accuracy/browser-runs/2026-10-11T03-38-29-145Z.json`: seven complete fixtures, 133/133 fields, one explicitly incomplete fixture, eight UI recovery checks, overall PASS. Earlier failed reports remain intact. Final recovery-only rerun with the private-file deny configuration also passed at `2026-10-11T08-02-05-236Z.json`. These scopes are not substituted for live uploaded documents or provider exports.

## MCP evidence and availability

| Tool | Actual use / limitation |
|---|---|
| Playwright MCP | Actual Shopify app launch, forms, PO create/reopen/refresh, missing-record recovery links, invoice review/save and GitHub deployment verification. |
| Chrome DevTools MCP | Public production landing request/console inspection; normal Admin navigation reached Shopify login in its separate browser. No authenticated PO diagnostics are claimed from this MCP. Playwright inspected the live PO network. |
| Shopify Dev MCP | Unavailable in the current connected tool inventory. Current official Shopify requirements and GraphQL documentation were browsed directly. Earlier reports identify their own prior MCP use. |
| Database / Supabase MCP | Unavailable. Persistence and financial safety checked using shop-scoped, read-only Prisma/PostgreSQL queries. |
| Xero MCP | Unavailable; live Demo Company export not verified. |
| QuickBooks MCP | Unavailable; live Sandbox export not verified. |

No file attachment restriction was bypassed through another connection, DOM file injection or CDP. The isolated local fixture browser has no merchant authentication and is explicitly separate from the connected live browser.

## Network issues

| Finding | Disposition |
|---|---|
| Historical valid-PO HTTP 400 | Does not recur in current real UI submission. Exact historical request remains unavailable. |
| Live nonexistent invoice document HTTP 404 | Fixed to HTTP 200 with app recovery state; related accounting/credit loaders corrected. |
| Early native recovery link HTTP 302 to Admin inside iframe | Fixed and verified on `bcbf04d`; normal 302 session-token recovery ends in usable app UI. |
| Supplier erased during hydration | Fixed on `ace2fa0`; before/after live probes plus valid early-entered PO submission, reopen, refresh and database verification pass. |
| Final app launch origin `/` HTTP 302 | Normal redirect to `/app` 200, correct store and operational capture page; no loop. |
| QuickBooks connection launch HTTP 401 | Shopify SDK's top-level external redirect response, not failed authentication: provider sign-in opened. No Sandbox company was connected or exported. |
| Two aborted list revalidations on fast success navigation | Expected navigation cancellations; detail screen worked and separate refresh audit was clean. |
| Stalled OCR capture | Fixed deadline and bounded cleanup; isolated actual-hook failure/retry checks pass. |
| Simulated API 500 / session 401 / service 503 | Explicit failure fixtures, not unexpected production responses; usable UI checks pass. |
| Shopify Admin cloudflare extension websocket error | Outside app origin; reported separately, not falsely attributed to SmartBill or suppressed. |

No unexpected 4xx/5xx, failed app requests, uncaught app exceptions or app console errors occurred during the successful PO reopen/refresh audit. This does not claim Shopify Admin's whole shell console was error-free.

## Remaining acceptance prerequisites

1. Select a new invoice through the enabled live file picker and complete capture/reopen after the latest deployment. PDF/JPG/multipage/rotation/poor-scan fixtures have isolated real-engine evidence, while authenticated live file-format coverage remains incomplete.
2. Complete actual uninstall/reinstall and fresh Shopify-hosted test-charge approval on a disposable development store. Uninstalling CreatorsStore254 invokes `app/routes/webhooks.app.uninstalled.tsx`, which deletes its existing accounting connection and sessions. A store choice was requested; silence is not approval for deleting that connection.
3. Connect a verified Xero Demo Company and QuickBooks Sandbox, then create and inspect test accounting records and their failure/retry paths. Provider unit tests and disconnected UI do not establish live export correctness.
4. Complete the remaining authenticated validation variants, actual session-expiry recovery and broad review-layout/network matrix. Earlier local passes and the explicit current live scope are recorded above and in `SHOPIFY_LIVE_MCP_VERIFICATION_2026-10-08.md`; they are not presented as complete live coverage.

100% OCR accuracy across arbitrary invoices cannot be guaranteed. Missing fields, inferred prices, ambiguous currencies and low-quality readings must remain reviewable and must not silently reach financial approval/export.

## Shopify requirement conclusion

The current [Shopify App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements) still require operational merchant UI under 2.1.3 and charge acceptance, decline and renewed approval after reinstall under 1.2.2. [Shopify's current subscription mutation](https://shopify.dev/docs/api/admin-graphql/latest/mutations/appSubscriptionCreate) provides hosted approval and a configured return URL. Previously verified charge returns stayed in the correct store; an actual reinstall remains unverified. Passing local tests alone does not establish compliance.

**NOT READY FOR SHOPIFY RETEST**
