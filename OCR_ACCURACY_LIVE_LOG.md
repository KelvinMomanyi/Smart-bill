# OCR accuracy: live uploads over time

This is an append-only review ledger. Parser regressions and live document recognition are reported separately. Passing synthetic transcripts is not evidence of live PDF/image accuracy. Test commands and the per-upload procedure are in [the OCR accuracy guide](scripts/ocr-accuracy/README.md).

| Observed UTC | Document / format | Initial extraction | Review, persistence and UI | Evidence / notes |
|---|---|---|---|---|
| 2026-10-09 10:18 | Freelance-Invoice-Template-Sample-500x650.webp / WEBP | FAIL | Usable error and retry; failed completion created no partial invoice | Invoice number read as Main instead of 10001; duplicate rejection HTTP 400. Recorded in SHOPIFY_OCR_LIVE_REMEDIATION_2026-10-09.md. |
| 2026-10-09 10:51 | Same stored original / WEBP, post-fix retry | PASS, tested sample | PASS after additional review-save and refresh fixes | Visually verified invoice 10001, Company Name, 2018-01-01, USD, four lines, 3010 subtotal / 301 tax / 3311 total. Confidence 87% is not the pass criterion. Invoice 0d3a2006-f73e-449b-a4ad-0908694321dc. |

The sample's tax amount was inferred from the printed 10% rate and totals and flagged for review. The sample has an expiry label; no payment due date was assumed. Current invoice revision 2 includes merchant edits and cannot serve as a fresh, unedited OCR measurement. Historical initial UI checks remain in the remediation report.

New documents: awaiting merchant uploads. No additional file formats or independent suppliers are claimed verified yet.

## Test framework verification — 9 October 2026

- Seven parser corpus cases pass: 133 / 133 expected fields. The first run failed two cases, exposing currency corruption (`KES` became unrecognised) and a lost product-description word (`Mailer Boxes` became `Mailer`). Narrow parser fixes preserve complete currency codes and limit unit-before-quantity reordering to delimited cells. These are parser findings, not additional live file uploads.
- Full automated suite: 190 tests pass, zero failures. TypeScript, targeted ESLint and production build pass.
- Fresh read-only snapshot of invoice 10001: job COMPLETED, revision 2. Current parser replay and persisted values both match all 29 fields. Comparison report: `.cache/ocr-accuracy/runs/2026-10-09T15-59-37-633Z-955734b9-acd4-401f-a996-7bcb71471d0d.json`. It explicitly does not count reviewed values as a fresh initial-UI pass.
- Native Playwright MCP reconnect confirmed the correct installed app and enabled manual picker. Each live upload requires an armed browser session; future documents have no result until they are actually supplied and reviewed.
