# Shopify review 2.1.3: purchase order creation

The PO submission fix is implemented and verified locally. Production verification is still required before resubmission.

## Finding and correction

The old form submitted line items only through a hidden React JSON snapshot. Its visible item controls had no form names. Replaying a submission with valid item fields and an empty snapshot reproduced HTTP 400 (`Add at least one PO item`). The reviewer's exact fields and production logs were unavailable, so this does not establish their precise failure path.

Line items now submit directly through named controls, including before JavaScript loads. The server validates them, saves the vendor, settings and PO together in one database transaction, and returns a link to the saved PO's receiving screen. Earlier JSON submissions remain supported. Spreadsheet, CSV and pipe imports use the same validation in the browser and server.

Validation, duplicate numbers, missing billing approval and save failures produce operational messages within the form, preserve entered values and return HTTP 200. Authentication responses remain protected. Database failures include a support reference without exposing database details.

## Verification

- All 162 automated tests passed, including 14 PO regression tests.
- TypeScript and the production build passed.
- Twenty-five browser checks passed against the production bundle with isolated persistence and mocked Shopify responses, including creation/reopen, validation, duplicate and save recovery, native HTML submission, navigation, missing resources, accounting connection recovery and viewport checks.
- Actual configured-database checks replayed all nine successful browser payloads, verifying PO/item values, totals, ownership, submission replay and rollback. Every test transaction was rolled back; zero test records remained.

The [runtime review](SHOPIFY_PO_RUNTIME_REVIEW_2026-10-07.md) records MCP availability, captured network evidence, related error fixes and the remaining installed-store/OCR/accounting checks. The original Shopify request remains unconfirmed; local test results do not establish production readiness.

Repeat the browser check after building with `npm run check:po`. It uses local Edge on Windows; set `PLAYWRIGHT_BROWSER_EXECUTABLE` for another Chromium browser, or install Playwright Chromium on other platforms. It never uses the configured live database or Shopify credentials.

## Production acceptance

Deploy this revision to the Vercel project serving `https://smart-bill-self-five.vercel.app`. The current Vercel CLI account could not access that deployment's logs. No production deployment was performed during this fix.

From the installed app in Shopify admin, create a PO with a unique number, vendor, item, fractional quantity and unit cost. Confirm the success message, saved list entry and working receiving link; reload to confirm persistence. Repeat with a second line and with optional fields blank. Check that duplicate numbers show inline guidance. Confirm the deployed request returns HTTP 200 before requesting another review.
