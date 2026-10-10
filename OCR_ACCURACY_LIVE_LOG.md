# OCR accuracy: live uploads over time

This is an append-only review ledger. Parser regressions and live document recognition are reported separately. Passing synthetic transcripts is not evidence of live PDF/image accuracy. Test commands and the per-upload procedure are in [the OCR accuracy guide](scripts/ocr-accuracy/README.md).

| Observed UTC | Document / format | Initial extraction | Review, persistence and UI | Evidence / notes |
|---|---|---|---|---|
| 2026-10-09 10:18 | Freelance-Invoice-Template-Sample-500x650.webp / WEBP | FAIL | Usable error and retry; failed completion created no partial invoice | Invoice number read as Main instead of 10001; duplicate rejection HTTP 400. Recorded in SHOPIFY_OCR_LIVE_REMEDIATION_2026-10-09.md. |
| 2026-10-09 10:51 | Same stored original / WEBP, post-fix retry | PASS, tested sample | PASS after additional review-save and refresh fixes | Visually verified invoice 10001, Company Name, 2018-01-01, USD, four lines, 3010 subtotal / 301 tax / 3311 total. Confidence 87% is not the pass criterion. Invoice 0d3a2006-f73e-449b-a4ad-0908694321dc. |
| 2026-10-09 16:14 | invoice-template-us-us-flag-750px.png / PNG | FAIL: 19 / 24 fields | Upload 202, completion 200, review usable and arithmetic differences flagged; revision-0 database snapshot retained | US-001, East Repair Inc., dates/totals correct, but quantities became 1/1/1 instead of 1/2/3 and names included the leading digits. Confidence 75% was not counted as accuracy. Invoice 3dc2a0e1-bf78-44c7-b53a-f7d0f8f20517. |
| 2026-10-09 16:44–16:46 | Same PNG invoice, merchant corrections | Original FAIL retained | PASS: corrected values 24 / 24; save 200, refresh 200, database revision 1 | Descriptions corrected; quantities 1/2/3, rates 100/15/5, amounts 100/30/15, subtotal 145, tax 9.06, total 154.06. This is reviewed accuracy, not a new original OCR pass. |

The sample's tax amount was inferred from the printed 10% rate and totals and flagged for review. The sample has an expiry label; no payment due date was assumed. Current invoice revision 2 includes merchant edits and cannot serve as a fresh, unedited OCR measurement. Historical initial UI checks remain in the remediation report.

Two real documents have now been tested: the freelance WEBP and East Repair PNG. Their original extraction results are retained above. The PNG's printed P.O.# 2312/2019 was not captured as a reference: OCR read its label as POA, and PO linking currently requires merchant selection. This unsupported/missing reference is outside the 24 compared invoice/line fields and is not being counted as correct extraction.

## Test framework verification — 9 October 2026

- Seven parser corpus cases pass: 133 / 133 expected fields. The first run failed two cases, exposing currency corruption (`KES` became unrecognised) and a lost product-description word (`Mailer Boxes` became `Mailer`). Narrow parser fixes preserve complete currency codes and limit unit-before-quantity reordering to delimited cells. These are parser findings, not additional live file uploads.
- Full automated suite: 190 tests pass, zero failures. TypeScript, targeted ESLint and production build pass.
- Fresh read-only snapshot of invoice 10001: job COMPLETED, revision 2. Current parser replay and persisted values both match all 29 fields. Comparison report: `.cache/ocr-accuracy/runs/2026-10-09T15-59-37-633Z-955734b9-acd4-401f-a996-7bcb71471d0d.json`. It explicitly does not count reviewed values as a fresh initial-UI pass.
- Native Playwright MCP reconnect confirmed the correct installed app and enabled manual picker. Each live upload requires an armed browser session; future documents have no result until they are actually supplied and reviewed.

## Quantity-first PNG follow-up

The original image was independently read from the app's 750 × 1061 preview. It prints QTY before DESCRIPTION, UNIT PRICE and AMOUNT, but browser OCR read QTY as `ary`. The parser recognised the other headers as a table without a quantity column, assumed quantity 1, and treated each leading quantity as part of the description. The fix reads a quantity-first header when available; if that heading is unreadable, it accepts a leading quantity only when quantity × printed unit price equals the printed amount and keeps a manual-review warning. Numeric product names are protected by an arithmetic regression.

The corpus now has eight cases and 157 checked fields. All pass locally, including the exact PNG layout. Full suite: 193 tests pass. The initial live snapshot still fails, as it should: a local parser fix cannot change or retroactively validate the already stored initial values. Its report with both initial UI and database evidence is `.cache/ocr-accuracy/runs/2026-10-09T16-39-27-757Z-eef4c326-4b50-43b3-83a9-6534dd0d4651.json`: current parser 24/24, original saved/UI 19/24, initial live FAIL.

Production deployment `baeed663ad67902b13d45869b73eb0862830ff69` is Active / Deployed (completed), confirmed in GitHub through Playwright MCP: `https://smart-bill-self-g29z0mstz-bostone339-6995.vercel.app`. The earlier currency/description fix `6088345031db5e814174950010b35c3bbba96b92` deployed successfully at `https://smart-bill-self-30bl858my-bostone339-6995.vercel.app`.

The supplied PNG was corrected through visible review controls and saved at 16:44 UTC. It reopened/refreshed at 16:45 UTC with all corrected values retained. Read-only PostgreSQL snapshot and comparison at 16:46 UTC match 24/24 fields; the report labels revision 1 as reviewed and initial live accuracy UNVERIFIED for that reviewed snapshot. Its original failed revision-0 measurement remains above.

At 16:50 UTC a separate **manual-text** invoice, `MCP-ACCURACY-20261009-01`, verified the deployed parser through the actual merchant UI: quantity-first row `2.5 Mailer Boxes 12.50 31.25`, currency KES, subtotal/total 31.25, tax zero, date 2026-10-09 and due date 2026-10-16. Capture returned 200 and saved success; reopening showed the complete description, correct quantity, price, currency and warning for the unreadable quantity heading. Invoice ID `deacbced-26eb-483e-b079-ee738b3d070d`. UI and read-only database checks pass; all 14 expected fields match. This is deployed parser/UI proof, not another file OCR run.

The corrected PNG and manual-text invoice remain unapproved, NOT_EXPORTED and NOT_REQUESTED for Shopify cost sync. Database checks confirm no exports or cost changes. The audit exported to `.cache/ocr-accuracy/live/2026-10-09T16-54-15-925Z-ui-audit.json` contains 44 app responses, no unexpected HTTP errors, no app exceptions, no app console errors and no failed app requests. The complete Shopify Admin shell console is not being labelled error-free.

The browser was returned to the correct-store capture page with an enabled input, zero picker interception listeners and no pending file/text. A new file upload after this fix still needs to verify initial extraction; the existing PNG was not deleted/reuploaded or silently reparsed.

## Australian invoice upload — 9 October 2026, 17:04 UTC

The third independent document, `download-free-invoice-template-in-pdf.png`, was uploaded manually as an 855257-byte PNG (3572 × 5055 pixels). Native Playwright MCP observed upload 202, completion 200, the saved-for-review success state and an enabled review workflow. The app preview was visually read independently before corrections. Recognition confidence was 91%, but the original extraction **FAILS: 15 / 19 checked fields** in both the UI and the revision-0 PostgreSQL snapshot.

| Field | Printed original | Initial OCR / saved value |
|---|---|---|
| Supplier | Your Business Name | Q Era |
| Invoice number | 2022435 | Missing |
| Currency | AUD | USD |
| Combined GST | 410.00 (10.00 + 400.00) | 400.00 |

Both dates (2022-07-19 and 2022-08-03), both complete item descriptions, quantities 1/1, prices and amounts 100/2000, subtotal 2100 and total 2510 were correct. The invoice stayed usable and flagged the missing number and tax/total difference; no raw HTTP error appeared. The complete original text was stored, including the correct supplier name in the footer, the bare `Invoice 2022435` heading and both GST amounts.

Root causes: the supplier heuristic preferred a short logo artifact; invoice-number labels required No/#; a dollar subtotal won before the explicitly labelled AUD total; tax parsing selected the last rate component instead of the sum. Narrow fixes complete a multiword supplier prefix only against a repeated footer name beside a street address, support bare numbered invoice headings, prioritise explicit currency labels, and sum verified rate components in the final summary. Explicit tax totals take precedence over their breakdown, and inconsistent components are not summed.

The original failed evidence is preserved: `.cache/ocr-accuracy/evidence/2026-10-09T17-12-04-030Z-b4744831-1018-4399-98c7-4d78c5beb07a.json`, `.cache/ocr-accuracy/live/2022435-initial-ui.json` and `.cache/ocr-accuracy/runs/2026-10-09T17-13-48-461Z-2fd3b5df-6e19-41fa-bda2-f000e086db71.json`. Invoice ID `af7167d7-f4f3-45d3-bf30-6b93fcb4d0a6`; job `abf01ff3-624a-46b4-9112-c3633828567c`.

After the fix, replaying the actual stored OCR matches 19/19 expected fields, while the same initial UI/database evidence still correctly fails 15/19: `.cache/ocr-accuracy/runs/2026-10-09T17-15-49-794Z-d0018ca3-bbbe-4c42-9618-754252d0b359.json`. This is parser proof, not a replacement for the original live result. A sanitized version of the actual OCR is the ninth regression case. All nine cases pass (176 expected fields); the full automated suite passes 198 tests, and TypeScript, targeted ESLint and production build pass.

The four corrections were entered through the visible review controls and saved at 17:17 UTC (POST 200, `Invoice updated.`). Browser refresh at 17:18 UTC retained every corrected field, revision 1. The reviewed UI observation is `.cache/ocr-accuracy/live/2022435-reviewed-ui.json`; the read-only database snapshot is `.cache/ocr-accuracy/evidence/2026-10-09T17-19-31-020Z-906c415f-f8cf-4b85-9466-5f3fc4a56143.json`. Its comparison at 17:20 UTC passes 19/19 parser and saved fields: `.cache/ocr-accuracy/runs/2026-10-09T17-20-41-105Z-d558fae9-c980-406b-be2c-ec338e1d52af.json`, with revision 1 explicitly labelled REVIEWED and initial live accuracy UNVERIFIED. No approval or accounting/cost-sync action was invoked. A reviewed AUD/KES exchange rate is still required before approval/cost sync.

Production commit `939206280ce823e5147a395b51a2df5a59da5991` is Active / Deployed (completed), observed through native Playwright in GitHub at 17:25 UTC: `https://smart-bill-self-qvbxl2ydy-bostone339-6995.vercel.app`.

At 17:26 UTC a separate manual-text invoice, `MCP-AUD-20261009-01`, exercised all four fixes through the actual deployed app: the bare invoice heading, incomplete supplier header completed by its footer name/address, an explicitly labelled AUD total after dollar amounts, and 10/400 GST components. Capture returned 200 and a saved-for-review success state. Reopening showed all 19 expected fields correctly, with revision 0. Read-only PostgreSQL evidence and parser comparison also match 19/19. Invoice ID `801ce1a4-95ce-4c20-a1d8-12e819f97d46`; private evidence `live/aud-runtime-ui.json`, `evidence/2026-10-09T17-27-37-458Z-3ac8bbab-adb1-4440-82c3-c2d74690b392.json` and `runs/2026-10-09T17-29-18-778Z-fa6644fe-bbed-4524-b02b-4ce16a02c200.json`. This is a deployed parser/UI test, not another file OCR test; initial file accuracy remains UNVERIFIED for this synthetic record.

The deployed-runtime audit `.cache/ocr-accuracy/live/2026-10-09T17-30-26-294Z-aud-runtime-audit.json` has 13 app responses, all 200, with zero failed app requests, app console errors or exceptions. The Shopify Admin shell console is not being called error-free. A 17:30 UTC scoped database check confirms both the corrected uploaded invoice and this manual fixture remain unapproved, NOT_EXPORTED and NOT_REQUESTED, with no exports or cost changes: `.cache/ocr-accuracy/2022435-financial-state-2026-10-09T17-30-31-968Z.json`.

At 17:29 UTC the browser was returned to the correct-store capture page: no selected file or pending text, enabled file input and capture button, and no picker interception listeners. Diagnostics will be rearmed for the next independent upload. A new, untouched file capture is still required to validate these fixes end to end through recognition.

## Painting WEBP — captured 9 October, follow-up 10 October 2026

The merchant selected another document while the Australian result was being finalized: `22196_42757_painting_invoice_download.webp`, 133782 bytes, image/webp, 1200 × 1200 pixels, one page. Native Playwright submitted that actual file through Capture invoices with blank supplier override, PO and pasted-text fields. Upload returned 202 at 17:32:25 UTC, with submit disabled during recognition; completion returned 200 at 17:32:39 UTC and a saved-for-review success state. No failed app requests or app exceptions were observed. Job `925c8df3-c649-4ff4-8e2e-2e068efaf5da`; invoice `e5c36337-fd08-44d1-80d1-b0753e82411f`.

The untouched result **FAILS: 5 / 24 expected fields**, despite 91% recognition confidence. The original preview prints invoice 2001321, date 12/26/2024, no due date, subtotal 585, discount 58.50, tax 52.65 and total 579.15. It contains three rows: Product 1 (5 × 100 = 500), product 2 (3 × 20 = 60), product 3 (1 × 25 = 25). Company and sender-name fields are blank; a real supplier name cannot be extracted from this template. The monetary suffix is L.E. (Egyptian pounds; the abbreviation is supported by [Egypt's State Information Service](https://sis.gov.eg/en/media-center/news/dollar-falls-to-le-4836-as-pound-strengthens-reserves-up-54-to-49b/)).

Initial extraction incorrectly used PAINTING as the supplier, defaulted currency to USD, omitted all three rows and read total 679.15. The invoice remained usable and flagged missing rows and arithmetic problems. Its initial UI and revision-0 database snapshot are preserved at `.cache/ocr-accuracy/live/painting-initial-ui.json` and `.cache/ocr-accuracy/evidence/2026-10-09T17-33-36-065Z-e0f72947-9f18-4e38-905c-d51172fd8282.json`. The true-original comparison remains a FAIL in `.cache/ocr-accuracy/runs/2026-10-10T17-22-41-733Z-63c56000-b051-4c76-8124-6ec291af17a9.json`: current parser 22/24, initial UI and database 5/24. The remaining parser differences are the unknown-supplier placeholder and the actual OCR digit error; they are not hidden by changing expected values.

Follow-up fixes support EGP and monetary L.E. suffixes without rewriting product prose, keep an incomplete template's split document title out of its supplier, and flag document discounts for net-price review. A missing supplier stays flagged after review-save and remains blocked by the existing approval guard. Browser OCR now requests another genuine recognition read when a supported subtotal/discount/tax/total summary does not balance, and favours a balanced actual reading. It never rewrites digits to manufacture a balanced total; ambiguous or unsupported summaries, such as extra charges, are left undecided. Two parser regressions and two actual OCR-pipeline regressions cover these conditions.

The full suite passes 202 tests. TypeScript, targeted ESLint and the production build pass. The nine standard parser accuracy cases still pass; the painting document is deliberately kept as a failed true-original measurement rather than an invented successful corpus case. Recognition cannot be guaranteed 100% accurate across arbitrary scans. Every item and price still requires comparison with the original before approval/export.

Deployment and live review follow-up will be recorded after verification.

## Remaining verification (after the fourth document)

Continue uploading independent invoice layouts over time. Live PDF/JPG/multipage/rotation/poor scans and OCR timeout/service-failure coverage remain pending. The printed P.O. reference requires merchant selection. Broader Shopify reinstall billing and Xero Demo/QuickBooks Sandbox verification remain as described in the earlier review; this test suite does not establish complete App Store readiness.

**NOT READY FOR SHOPIFY RETEST**
