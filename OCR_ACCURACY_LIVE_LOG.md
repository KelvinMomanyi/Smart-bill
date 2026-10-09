# OCR accuracy: live uploads over time

This is an append-only review ledger. Parser regressions and live document recognition are reported separately. Passing synthetic transcripts is not evidence of live PDF/image accuracy. Test commands and the per-upload procedure are in [the OCR accuracy guide](scripts/ocr-accuracy/README.md).

| Observed UTC | Document / format | Initial extraction | Review, persistence and UI | Evidence / notes |
|---|---|---|---|---|
| 2026-10-09 10:18 | Freelance-Invoice-Template-Sample-500x650.webp / WEBP | FAIL | Usable error and retry; failed completion created no partial invoice | Invoice number read as Main instead of 10001; duplicate rejection HTTP 400. Recorded in SHOPIFY_OCR_LIVE_REMEDIATION_2026-10-09.md. |
| 2026-10-09 10:51 | Same stored original / WEBP, post-fix retry | PASS, tested sample | PASS after additional review-save and refresh fixes | Visually verified invoice 10001, Company Name, 2018-01-01, USD, four lines, 3010 subtotal / 301 tax / 3311 total. Confidence 87% is not the pass criterion. Invoice 0d3a2006-f73e-449b-a4ad-0908694321dc. |
| 2026-10-09 16:14 | invoice-template-us-us-flag-750px.png / PNG | FAIL: 19 / 24 fields | Upload 202, completion 200, review usable and arithmetic differences flagged; revision-0 database snapshot retained | US-001, East Repair Inc., dates/totals correct, but quantities became 1/1/1 instead of 1/2/3 and names included the leading digits. Confidence 75% was not counted as accuracy. Invoice 3dc2a0e1-bf78-44c7-b53a-f7d0f8f20517. |

The sample's tax amount was inferred from the printed 10% rate and totals and flagged for review. The sample has an expiry label; no payment due date was assumed. Current invoice revision 2 includes merchant edits and cannot serve as a fresh, unedited OCR measurement. Historical initial UI checks remain in the remediation report.

Two real documents have now been tested: the freelance WEBP and East Repair PNG. Their original extraction results are retained above. The PNG's printed P.O.# 2312/2019 was not captured as a reference: OCR read its label as POA, and PO linking currently requires merchant selection. This unsupported/missing reference is outside the 24 compared invoice/line fields and is not being counted as correct extraction.

## Test framework verification — 9 October 2026

- Seven parser corpus cases pass: 133 / 133 expected fields. The first run failed two cases, exposing currency corruption (`KES` became unrecognised) and a lost product-description word (`Mailer Boxes` became `Mailer`). Narrow parser fixes preserve complete currency codes and limit unit-before-quantity reordering to delimited cells. These are parser findings, not additional live file uploads.
- Full automated suite: 190 tests pass, zero failures. TypeScript, targeted ESLint and production build pass.
- Fresh read-only snapshot of invoice 10001: job COMPLETED, revision 2. Current parser replay and persisted values both match all 29 fields. Comparison report: `.cache/ocr-accuracy/runs/2026-10-09T15-59-37-633Z-955734b9-acd4-401f-a996-7bcb71471d0d.json`. It explicitly does not count reviewed values as a fresh initial-UI pass.
- Native Playwright MCP reconnect confirmed the correct installed app and enabled manual picker. Each live upload requires an armed browser session; future documents have no result until they are actually supplied and reviewed.

## Quantity-first PNG follow-up

The original image was independently read from the app's 750 × 1061 preview. It prints QTY before DESCRIPTION, UNIT PRICE and AMOUNT, but browser OCR read QTY as `ary`. The parser recognised the other headers as a table without a quantity column, assumed quantity 1, and treated each leading quantity as part of the description. The fix reads a quantity-first header when available; if that heading is unreadable, it accepts a leading quantity only when quantity × printed unit price equals the printed amount and keeps a manual-review warning. Numeric product names are protected by an arithmetic regression.

The corpus now has eight cases and 157 checked fields. All pass locally, including the exact PNG layout. Full suite: 193 tests pass. The initial live snapshot still fails, as it should: a local parser fix cannot change or retroactively validate the already stored initial values. Its report with both initial UI and database evidence is `.cache/ocr-accuracy/runs/2026-10-09T16-39-27-757Z-eef4c326-4b50-43b3-83a9-6534dd0d4651.json`: current parser 24/24, original saved/UI 19/24, initial live FAIL. Deployment and corrected-UI verification will be appended after completion.
