# Live OCR verification — invoice 2022435

The manually uploaded `download-free-invoice-template-in-pdf.png` completed successfully, but its untouched extraction **failed: 15 of 19 expected fields matched**. Corrections now match all 19 fields in the merchant UI and database. Original accuracy and corrected accuracy are recorded separately.

## Original document and result

Native Playwright MCP inspected the running embedded app in `creatorsstore254.myshopify.com`. The uploaded PNG was 855257 bytes, 3572 × 5055 pixels, one page. The original was independently viewed from the app's document preview before editing.

| Field | Original | Initial extraction | Reviewed value |
|---|---|---|---|
| Supplier | Your Business Name | Q Era | Your Business Name |
| Invoice number | 2022435 | Missing | 2022435 |
| Invoice date | 19/7/2022 | 2022-07-19 | 2022-07-19 |
| Due date | 3/8/2022 | 2022-08-03 | 2022-08-03 |
| Currency | AUD | USD | AUD |
| Subtotal | 2100.00 | 2100.00 | 2100.00 |
| GST | 410.00 | 400.00 | 410.00 |
| Total | 2510.00 | 2510.00 | 2510.00 |

Both item rows were correct: `Services & products`, quantity 1, price/amount 100; `More services & products`, quantity 1, price/amount 2000. Neither item prints a SKU. GST comprises 10% of 100 (10) plus 20% of 2000 (400). The 91% recognition confidence was not used as an accuracy pass.

## Root causes and implementation

- Supplier selection favoured an early, short logo artifact over incomplete `Your Business` text. A matching multiword header prefix can now be completed from a repeated footer name beside a street address, beyond customer and summary sections.
- Invoice-number extraction required No/#. A conservative fallback now accepts complete headings such as `Invoice 2022435`; dates and prose are excluded.
- Currency detection selected an ambiguous dollar subtotal before the explicit `Total (AUD)` label. Explicit currency labels now precede dollar fallback.
- Tax extraction selected the last GST component. Verified rate components in the final summary are summed; an explicit tax total takes precedence, and inconsistent components are not summed.

Files changed for this upload: `app/utils/parser.server.ts` (four parser fixes); `app/__tests__/parser.test.ts` (positive cases and false-positive/double-counting guards); `scripts/ocr-accuracy/cases.json` (sanitized actual transcript and independent expected values); `OCR_ACCURACY_LIVE_LOG.md` (preserved initial failure and follow-up evidence); `scripts/ocr-accuracy/README.md` (current corpus scope); this report. Evidence remains in ignored `.cache/ocr-accuracy`.

## Verification

| Test | Result | Evidence |
|---|---|---|
| Correct-store embedded app | PASS | Actual Shopify Admin UI, native Playwright MCP |
| PNG upload and OCR completion | PASS | Upload POST 202 at 17:04:43 UTC; completion POST 200 at 17:04:50 UTC; saved-for-review success |
| Initial automatic field accuracy | FAIL | UI and revision-0 database both 15/19; four mismatches retained |
| Current parser replay of actual OCR | PASS | 19/19; original UI/database result still FAIL |
| Manual review/save | PASS | Four visible field corrections; POST 200, `Invoice updated.` at 17:17 UTC |
| Refresh and saved values | PASS | UI revision 1, all values retained at 17:18 UTC; PostgreSQL 19/19 at 17:20 UTC |
| Accounting and cost changes during testing | PASS | No approval, exports or cost changes; NOT_EXPORTED / NOT_REQUESTED; reviewed AUD/KES rate still required |
| Parser corpus | PASS | Nine cases, 176 expected fields |
| Full automated suite | PASS | 198 tests, zero failures |
| TypeScript / targeted ESLint / production build | PASS | Completed locally |
| App requests / exceptions during upload and review | PASS | No unexpected 4xx/5xx, failed app requests, app console errors or uncaught exceptions in the recorded audit |
| Production rollout | PASS | Commit `939206280ce823e5147a395b51a2df5a59da5991` Active / Deployed (completed), observed in GitHub through Playwright at 17:25 UTC |
| Deployed parser through merchant UI | PASS | Separate manual-text invoice `MCP-AUD-20261009-01`: capture 200, success, reopened correct values; UI and PostgreSQL 19/19 |
| Fresh unedited file upload after this fix | UNVERIFIED | Existing invoice was corrected, not deleted/reuploaded or silently reparsed |

Playwright MCP supplied actual UI, document, network and browser-error observations. No Chrome DevTools, database/Supabase, Xero or QuickBooks MCP was available for this upload test; database evidence used scoped read-only Prisma/PostgreSQL. Shopify documentation was not rechecked because this change only concerns parsing. No accounting export was attempted.

Private evidence: revision-0 snapshot `evidence/2026-10-09T17-12-04-030Z-b4744831-1018-4399-98c7-4d78c5beb07a.json`; initial UI `live/2022435-initial-ui.json`; original FAIL `runs/2026-10-09T17-13-48-461Z-2fd3b5df-6e19-41fa-bda2-f000e086db71.json`; reviewed snapshot `evidence/2026-10-09T17-19-31-020Z-906c415f-f8cf-4b85-9466-5f3fc4a56143.json`; reviewed UI `live/2022435-reviewed-ui.json`; reviewed comparison `runs/2026-10-09T17-20-41-105Z-d558fae9-c980-406b-be2c-ec338e1d52af.json`; financial-state check `2022435-financial-state-2026-10-09T17-22-23-862Z.json`.

Production deployment: `https://smart-bill-self-qvbxl2ydy-bostone339-6995.vercel.app`. The deployed-runtime record is `801ce1a4-95ce-4c20-a1d8-12e819f97d46`, revision 0. Its manual-text source, expected values and UI observation are `.cache/ocr-accuracy/aud-runtime-case.json` and `live/aud-runtime-ui.json`; snapshot `evidence/2026-10-09T17-27-37-458Z-3ac8bbab-adb1-4440-82c3-c2d74690b392.json`; comparison `runs/2026-10-09T17-29-18-778Z-fa6644fe-bbed-4524-b02b-4ce16a02c200.json` (19/19 parser and saved values, initial live file accuracy UNVERIFIED). This test exercises the deployed parser and save/reopen UI, with no file recognition involved. Its audit `live/2026-10-09T17-30-26-294Z-aud-runtime-audit.json` records 13 successful app responses and zero app request failures, exceptions or console errors. Shopify shell console messages are outside that app-specific assertion.

The 17:30 UTC read-only check `2022435-financial-state-2026-10-09T17-30-31-968Z.json` confirms both records remain unapproved, NOT_EXPORTED and NOT_REQUESTED with no exports or cost changes. The browser returned to the correct-store capture page with an enabled manual picker and empty file/text inputs, ready for the next independent upload. Final report and guide updates remain in the workspace; the runtime fixes, regressions, corpus case and pre-deployment ledger were deployed in the commit above.

More independent live layouts, PDF/JPG/multipage/rotated/poor scans and timeout/failure coverage remain necessary before a broad OCR reliability claim. Shopify reinstall billing and Xero Demo/QuickBooks Sandbox checks also remain pending from the wider review.

**NOT READY FOR SHOPIFY RETEST**
