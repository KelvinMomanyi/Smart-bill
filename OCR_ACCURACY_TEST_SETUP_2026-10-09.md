# Repeatable OCR tests and new PNG remediation — 9 October 2026

The merchant can upload invoices at different times and ask for an MCP check. The test setup preserves initial extraction, reviewed values, parser replay and UI usability as separate results. It compares every supported header and line field against values read independently from the source invoice; OCR confidence cannot override an incorrect field. No automatic background monitoring or scheduled task is configured.

## Root causes and fixes

The new field-comparison corpus found two existing parser errors: monetary lookalike repair could consume the S in KES/GHS and corrupt the currency code; unit-before-quantity reordering could strip Boxes from Mailer Boxes. Monetary repair now requires a value boundary, and unit reordering requires an explicit column delimiter. These fixes deployed successfully in commit `6088345031db5e814174950010b35c3bbba96b92`.

During testing, the merchant selected `invoice-template-us-us-flag-750px.png` (46,412 bytes, image/png). Playwright observed the native form with supplier override, PO selection and pasted text blank and valid. Capture disabled the submit button while processing, upload returned 202, and completion returned 200 with a usable saved/review state. OCR confidence was 75%, one page. The original image was independently viewed through the app preview at 750 × 1061.

This PNG exposed another parser error. Its table has quantity before description; OCR read QTY as ary. The parser recognised a table without a quantity column, assumed quantity 1, and retained each leading quantity in the product name. It saved 1/1/1 instead of 1/2/3, despite correctly capturing dates, supplier and totals. The app flagged the arithmetic differences and preserved a usable correction path. Initial accuracy: **FAIL, 19/24 fields**; there was no raw HTTP error.

The fix records quantity-column order when the heading is readable. With an unreadable quantity heading, a leading number is accepted only where quantity × printed unit price equals the printed amount, and the app keeps a manual-review warning. A regression protects numeric product names such as 500 Sheets Copier Paper. No approval, tenant, duplicate or arithmetic validation was weakened. Commit `baeed663ad67902b13d45869b73eb0862830ff69` is deployed and Active, confirmed through the actual GitHub UI: `https://smart-bill-self-g29z0mstz-bostone339-6995.vercel.app`.

## Test setup and changed files

| File | Purpose |
|---|---|
| app/utils/parser.server.ts | Preserve currency codes and complete descriptions; handle leading quantities conservatively. |
| app/__tests__/parser.test.ts | Regressions for currencies, unit words, readable quantity-first headings and numeric product names. |
| app/__tests__/ocrAccuracy.test.ts | Eight ground-truth cases and checks for lost/extra/duplicate lines, digit errors, swapped numeric columns, unit precision, floating arithmetic, missing expectations, review warnings and initial/reviewed evidence. |
| app/__tests__/run.ts | Register the accuracy checks in the normal suite. |
| package.json | Add npm run test:ocr-accuracy. |
| scripts/ocr-accuracy/evaluate.ts | Strict full-field comparison and live evidence acceptance rules. |
| scripts/ocr-accuracy/cases.json | Public/sanitized and synthetic regression transcripts with independent expected values; no live-format claims for synthetic cases. |
| scripts/check-ocr-accuracy.ts | Run the corpus or a scoped live snapshot; write unique timestamped reports with commit and parser-source hash; return nonzero on mismatch. |
| scripts/capture-ocr-evidence.mjs | Read-only tenant-scoped invoice snapshots without storage URLs, authentication values or raw database exceptions. |
| scripts/ocr-accuracy/arm-live-session.txt | Playwright MCP diagnostics and restoration of the native manual chooser through the public listener API. |
| scripts/ocr-accuracy/README.md | Instructions for repeated uploads, initial document/UI comparison, persistence, corrections and evidence handling. |
| OCR_ACCURACY_LIVE_LOG.md | Append-only original failures, corrected results, deployed verification and remaining scope. |
| OCR_ACCURACY_TEST_SETUP_2026-10-09.md | This setup and runtime verification report. |

Actual commercial documents, raw OCR snapshots, UI evidence and comparison runs stay in ignored `.cache/ocr-accuracy`. Future documents need independently established expected values before they can receive an accuracy result. Missing or unreadable information is not marked correct by guessing.

## MCP evidence

Playwright MCP was used through the authenticated merchant browser to observe the actual PNG selection, capture, loading/disabled state, upload/completion responses, original image, initial review controls, corrections/save, reopen/refresh and deployment status. The deployed parser was also exercised through a separate native manual-text capture; this is explicitly not another image OCR test.

No authenticated Chrome DevTools inspection is claimed for this follow-up. Database/Supabase MCP was unavailable; persistence and absence of financial side effects were verified with scoped read-only Prisma/PostgreSQL queries. No Xero Demo or QuickBooks Sandbox export was performed. Earlier Shopify Dev MCP documentation checks remain recorded in the prior review; it was not called again for this test-only setup.

## Results

| Test | Result | Evidence / limit |
|---|---|---|
| Eight parser accuracy cases | PASS | 157/157 expected fields, including the exact sanitized PNG transcript. |
| Full automated suite | PASS | 193 tests, zero failures. These include mocks and are not live accounting proof. |
| TypeScript, targeted lint, production build | PASS | Checks completed before deployment; known nonblocking build/deprecation warnings remain. |
| Live PNG upload and completion | PASS | Upload 202, job completion 200, success and review UI; submit disabled during recognition. |
| PNG original extraction | FAIL | Initial quantities/descriptions wrong: 19/24 fields, preserved revision-0 snapshot. |
| PNG merchant correction/save | PASS | Visible fields changed to exact printed names and quantities; action 200, Invoice updated. |
| PNG reopen/refresh | PASS | All corrected lines and total retained; document response 200; revision 1. |
| PNG corrected database fields | PASS | 24/24 fields match source; reviewed state, not a retroactive initial OCR pass. |
| Deployed parser through native UI | PASS | Separate manual-text MCP-ACCURACY-20261009-01: Mailer Boxes, 2.5 × 12.50, KES 31.25; 14/14 saved fields. |
| Financial side effects | PASS | Both invoices unapproved; no accounting exports, Shopify cost changes or cost sync. |
| Monitored app network/console | PASS, tested scope | Exported audit: 44 responses, no unexpected HTTP errors, app console errors, exceptions or failed requests. Admin shell diagnostics remain separate. |
| Fresh file recognition after leading-quantity fix | PENDING | The PNG was corrected without deleting or reuploading it. Next independent upload will test initial extraction on the deployed fix. |
| Live PDF/JPG/multipage/rotated/poor scans | PENDING | Two live documents tested so far: WEBP and PNG. |
| Live OCR timeout/service failure | PENDING | No claim based solely on automated tests. |
| Printed P.O.# reference | NOT CAPTURED | PNG prints 2312/2019; OCR label POA was unreadable. App PO linking requires explicit merchant selection. Outside the 24 field comparison; not counted correct. |

The PNG remains invoice `3dc2a0e1-bf78-44c7-b53a-f7d0f8f20517`, revision 1, USD 154.06, with FX still blank. The synthetic manual-text invoice is `deacbced-26eb-483e-b079-ee738b3d070d`, revision 0, KES 31.25. Original failed UI/saved evidence remains intact. The browser was left on correct-store capture home with an enabled native picker and blank file/text fields.

Detailed private evidence filenames and chronological results are in [the live ledger](OCR_ACCURACY_LIVE_LOG.md). Commands and subsequent-upload instructions are in [the guide](scripts/ocr-accuracy/README.md).

## Remaining scope

A repeated-upload test process is now implemented and working. General accuracy still needs representative fresh documents over time, including the remaining formats and difficult scans. No perfect-recognition guarantee is made from two templates. Initial failures stay recorded even after correction or remediation.

The original broader Shopify review also still requires actual reinstall billing and configured accounting sandbox verification. No new unexpected 4xx/5xx was found in this follow-up. The new PNG failure was an extraction error within a usable UI, and the underlying quantity layout has been fixed and deployed.

**NOT READY FOR SHOPIFY RETEST**
