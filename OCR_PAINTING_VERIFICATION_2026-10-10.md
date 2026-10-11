# Painting invoice OCR verification

The actual uploaded WEBP completed through the Shopify merchant UI, but its untouched field accuracy **failed: 5 / 24 checked fields**. Recognition confidence was 91%. OCR accuracy cannot be guaranteed 100% across arbitrary scans; the specific item/price defects found here have regression coverage and require fresh live verification after deployment.

## Document and initial evidence

Filename `22196_42757_painting_invoice_download.webp`; 133782 bytes; 1200 × 1200; one page. Uploaded through native Playwright MCP with empty supplier override, PO selection and pasted text. Upload 202 at 2026-10-09 17:32:25 UTC, loading/disabled submit verified; completion 200 at 17:32:39 UTC and saved-for-review success. Invoice `e5c36337-fd08-44d1-80d1-b0753e82411f`, job `925c8df3-c649-4ff4-8e2e-2e068efaf5da`.

The original app preview was visually read before edits. It prints invoice 2001321, date 12/26/2024 (2024-12-26), no due date and no supplier name. Its Company and Sender Name fields are blank. Currency is L.E., interpreted as Egyptian pounds: [Egypt's State Information Service uses LE for the Egyptian pound](https://sis.gov.eg/en/media-center/news/dollar-falls-to-le-4836-as-pound-strengthens-reserves-up-54-to-49b/).

| Printed row | Quantity | Printed unit price | Printed amount |
|---|---:|---:|---:|
| Product 1 | 5 | 100.00 | 500.00 |
| product 2 | 3 | 20.00 | 60.00 |
| product 3 | 1 | 25.00 | 25.00 |

Printed subtotal 585.00, discount 10% / 58.50, tax 52.65 and total 579.15 balance: 585 − 58.50 + 52.65 = 579.15. The application uses **net** line prices for financial approval, so the document discount still needs review. Proportional net prices would be 90 / 18 / 22.50 and net subtotal 526.50; the printed pre-discount prices must not be mistaken for verified net prices.

Initial extraction used PAINTING as a supplier, defaulted USD, omitted all three item rows, and read total 679.15. Invoice number, date, absent due date, subtotal and tax were correct. The app kept a usable review page with missing-line/arithmetic warnings and no raw web error.

Private evidence: `.cache/ocr-accuracy/evidence/2026-10-09T17-33-36-065Z-e0f72947-9f18-4e38-905c-d51172fd8282.json`, `live/painting-initial-ui.json`, independent expected case `painting-case.json`, and `runs/2026-10-10T17-22-41-733Z-63c56000-b051-4c76-8124-6ec291af17a9.json`. The latter reports current parser 22/24, original saved/UI 5/24 and initial live FAIL. Missing supplier and wrong recognised total remain differences; the expected values are not weakened to make the test pass. The printed discount is documented separately and is not silently counted as extracted by this 24-field metric.

## Root causes and fixes

- L.E. suffixes after both money cells prevented full-row matching, so all rows were dropped. EGP/L.E. detection and numeric-cell suffix handling now preserve all names, quantities, prices and amounts.
- Supplier fallback treated a split PAINTING / INVOICE heading as a trading name despite blank supplier labels. Blank templates now keep the unknown-supplier state; review-save retains a useful supplier warning, and the existing approval guard requires a real supplier.
- Raw OCR read a genuine digit incorrectly, 579.15 → 679.15. Browser recognition now tries another actual read when a supported monetary summary is inconsistent, and uses arithmetic as one selection signal. It never synthesizes a replacement total. Unsupported summaries are left undecided, and unresolved mismatches remain in merchant review.
- The template includes a document discount. A review warning directs merchants to check the total and net prices/subtotal after discount before approval.

Files changed: `app/utils/parser.server.ts`; `app/utils/browserOcr.ts`; `app/services/invoiceReview.server.ts`; `app/__tests__/parser.test.ts`; `app/__tests__/browserOcr.test.ts`; `scripts/ocr-accuracy/README.md`; `OCR_ACCURACY_LIVE_LOG.md`; this report. Runtime changes, tests and the guide/ledger update were pushed in commit `323fe2e`; this final report remains in the workspace.

## Test results

| Test | Result | Notes |
|---|---|---|
| Correct-store embedded app and invoice deep link | PASS | Native Playwright, both capture day and reconnect next day |
| WEBP upload, loading, OCR save and usable review | PASS | Actual UI; 202 / 200; saved success; no unexpected app failures |
| Original field accuracy | FAIL | 5/24; all three item rows missing; wrong supplier/currency/total |
| Parser item recovery | PASS | All 16 item/row-count fields correct on actual stored OCR; prices 100 / 20 / 25 |
| True-original parser comparison after fixes | FAIL | 22/24; supplier is genuinely absent, raw recognised total remains wrong |
| Full regression suite | PASS | 202 tests; includes real alternate-read selection via the OCR pipeline with injected reads |
| TypeScript, targeted ESLint, production build | PASS | Final source checked |
| Production rollout | PASS | Commit 323fe2e08ade5a77efdd6e9b29933eafb9d29cd8 Active / Deployed (completed), observed through Playwright in GitHub at 2026-10-10 17:37:53 UTC |
| Reviewed item names, quantities, printed prices and amounts | PASS | All three rows match the original in the actual reopened UI and scoped database snapshot; these are reviewed values |
| Merchant corrections/save/reopen/persistence | PASS, reviewed | Save POST 200 with Invoice updated. at 17:39 UTC; refresh GET 200; database revision 1 retained rows, EGP and corrected total 579.15 |
| Whole reviewed invoice comparison | FAIL / needs review | Saved values 23/24; unknown-supplier placeholder remains different from the genuinely absent supplier. Discount/net prices and EGP/KES rate also need merchant review |
| Fresh unedited file capture after latest fixes | UNVERIFIED | No claim that a mock OCR test proves real recognition accuracy |
| Xero Demo / QuickBooks Sandbox export | UNVERIFIED | No configured test MCP/environment verified; no export attempted |

Native Playwright MCP provided actual UI, document preview and network/error observations. No Chrome DevTools, database/Supabase, Xero or QuickBooks MCP was available for this test. Scoped read-only Prisma/PostgreSQL provided persistence snapshots; no direct database remediation was used. Shopify documentation was not rechecked for these parser-only changes. App-specific error checks do not claim the entire Shopify Admin shell has no console messages.

Production deployment: https://smart-bill-self-ecnuusd3h-bostone339-6995.vercel.app. The reopened invoice showed the new missing-supplier warning alongside the arithmetic and exchange-rate warnings. UI/network evidence is `.cache/ocr-accuracy/live/painting-reviewed-ui-2026-10-10.json`; the independent line comparison is `live/painting-reviewed-line-check-2026-10-10.json`. The review audit records 31 app responses, all 200 except a normal cached icon 304, with zero failed app requests, app exceptions or app console errors.

Read-only saved evidence: `.cache/ocr-accuracy/evidence/2026-10-10T17-40-41-472Z-41f1cbb5-8053-45d8-9a7d-c5a760e53da2.json`. The true-original comparison at `runs/2026-10-10T17-44-01-344Z-e91ddbaf-a0f8-41a2-b90a-231a738e4b39.json` correctly remains FAIL: current parser 22/24 (raw total still misread), reviewed saved state 23/24 (supplier absent). Every item field and the item count match in both comparisons. The original revision-0 failure is retained; neither parser replay nor manual correction is counted as a fresh automatic OCR pass.

No invoice was approved, exported or used to update Shopify costs. A 17:43 UTC scoped read-only database check confirms NEEDS_ATTENTION, null approvedAt, NOT_EXPORTED, NOT_REQUESTED, zero exports and zero cost changes: `.cache/ocr-accuracy/painting-financial-state-2026-10-10T17-43-34-346Z.json`. The missing supplier, discount/net values and currency rate must remain review tasks. Additional independent invoice layouts and live PDF/JPG/multipage/rotated/poor-scan and timeout/failure coverage remain necessary. Wider reinstall billing and accounting sandbox checks remain pending.

At 17:45:59 UTC the browser was returned to the correct-store capture page and live diagnostics were rearmed. The file input was enabled, no file or pasted text was selected, and the manual picker had no interception listeners. The next independent upload has no result until it is actually supplied, recognised and compared against the original.

**NOT READY FOR SHOPIFY RETEST**
