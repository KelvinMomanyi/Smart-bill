# SmartBill Functional Test Report

## OCR accuracy enhancement verified on 15 September 2026

Dashboard OCR now uses Tesseract.js 6.0.1 with one worker per document,
automatic rotation, bounded upscaling, grayscale contrast cleanup and preserved
word spacing. A weak first reading receives one color sparse-layout pass, and
SmartBill keeps the complete reading with the stronger invoice-detail score.
The capture preview now shows Tesseract's recognition confidence and reminds the
user to verify currency, tax and totals against the original.

The invoice parser now recognizes common currency symbols and codes, decimal
points, decimal commas and thousands separators. Monetary-context repairs cover
common OCR mistakes such as `S55.89`, `$SS.89`, `§55,89`, `U5D`, `TotaI` and
`SubtotaI`; names and invoice identifiers are left untouched.

- Real Chromium OCR preserved `$55.89`, invoice identifiers and the `$60.36`
  total in a generated 500x650 PNG, WebP and two-page PDF. With the recognition
  files cached, the runs completed in 2.51, 1.73 and 3.72 seconds respectively;
  Tesseract reported 94% confidence for each result.
- All 87 automated tests passed, including OCR result selection, worker reuse,
  cleanup, localized amounts, currency detection and conservative OCR repair.
- TypeScript, ESLint and the production Remix/Vite build all passed after the
  implementation.

## OCR restoration verified on 14 September 2026

This update supersedes the earlier OCR/queue descriptions below. Dashboard
capture and retry now use the browser processor from
../old/app/components/InvoiceUpload.tsx: Tesseract.js 4.1.1 in English on
original images, and PDF.js 3.11.174 at 2x scale with sequential page OCR.
The original five-page limit is enforced without silently omitting later pages.
Progress, first-page preview and raw extracted text are available in capture.

- Real Chromium OCR: a generated 500x650 PNG returned invoice SMOKE-1001 and
  total USD 58.00 in 39.01 seconds including the first English-model download.
  WebP returned the same fields in 2.56 seconds. A two-page PDF returned
  PDF-SMOKE-1002 and total USD 69.60 in 9.12 seconds.
- The real browser capture hook passed a two-document batch, stored-document
  retry, preview, simulated save failure and recovery. Storage/save HTTP
  responses were mocked for these browser tests; no live store data was changed.
- 82 automated tests passed, including private original upload, one usage
  reservation per document, subscription enforcement, shop isolation,
  concurrency, interrupted-save recovery and browser PDF/resource handling.
- TypeScript, lint and production compilation passed.
- All 58,223 files in old matched the SHA-256 snapshot taken before implementation:
  no files changed, disappeared or were added.

Browser uploads wait in AWAITING_OCR and are not claimed by server workers.
Completion stores the server-parsed invoice, original storage reference and
review state. Existing failed/queued documents can use browser retry.
Google credentials and the server OCR deadline apply only to unattended
email/API workers. Deploy these source changes before testing this flow in the
live Shopify app.

The remaining sections record the earlier 13 September audit and its live
integration limitations; they are not new live acceptance results.

**Test date:** 13 September 2026  
**Source workspace:** `C:\Users\user\Desktop\SMARTBILL\smart-bill`  
**Public deployment:** <https://smart-bill-self.vercel.app>

## Executive result

SmartBill's source builds successfully and its automated, database, OCR,
Shopify-read and accounting-adapter checks pass. The audit found and corrected
six functional defects:

1. The Shopify currency GraphQL request put `#graphql` and the query on one
   line. GraphQL treated the request as a comment, so cost preview and cost sync
   could not obtain the store currency.
2. Vercel uploads depended entirely on an unconfigured external worker or cron.
   The signed-in dashboard can now securely process its own queued documents,
   one at a time, while it remains open.
3. The purchase-order API converted Shopify login redirects into HTTP 500
   responses. Authentication responses now pass through correctly.
4. Purchase-order quantity/rate parsing accepted values such as `2 boxes` as
   the number `2`, and invalid quantities could silently become `1`.
5. Physical over-deliveries were marked fulfilled instead of mismatched.
6. Scanner users saw admin-only links that led to HTTP 403 pages.

Two external prerequisites still prevent a complete live acceptance test:

- Document storage has been migrated from the nonexistent Firebase bucket to
  private Supabase Storage. A Supabase project URL and server secret key still
  need to be configured locally and in Vercel before the real upload/read/delete
  round trip can be accepted.
- Neither installed store has an active SmartBill subscription. Paid actions,
  including upload, approval, cost sync, Xero/QuickBooks connection and bill
  export, are therefore correctly blocked. A merchant must approve Starter or
  Growth before those live flows can run.

No browser is connected to this test session, so signed-in visual interaction
was not possible. No real Shopify product cost or accounting bill was created,
changed or deleted during this audit.

## Verification matrix

| Area                             | Result                                     | Evidence and limits                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                       | Pass                                       | `npm run typecheck` completed with no errors.                                                                                                                                                                                                                                                                                                                                                                                 |
| Lint                             | Pass                                       | `npm run lint` completed with no errors. The only message is the upstream Remix ESLint deprecation notice.                                                                                                                                                                                                                                                                                                                    |
| Automated behavior               | Pass                                       | 71 of 71 tests passed. These cover parsing, invoice validation, date/currency rules, upload spoofing/limits, private storage-reference isolation, Supabase and OCR configuration validation, bounded OCR image sizing, the text-PDF OCR bypass, PO parsing and matching, receipt status, plans, CSV injection protection, OAuth state and browser binding, encrypted tokens, Xero/QuickBooks adapters, catalogs, tax/FX mapping, idempotency, concurrency, rejection/timeout recovery, disconnect and document attachments. |
| Production compilation           | Pass                                       | `npm run build:check` generated Prisma Client and built both browser and SSR bundles. Empty client chunks for server-only routes are expected.                                                                                                                                                                                                                                                                                |
| Database migrations              | Pass                                       | Prisma reports all seven migrations applied. Eight invoice schema checks, five accounting schema checks and a real invoice query passed. Existing data remained at 5 invoices and 15 invoice lines.                                                                                                                                                                                                                           |
| Stored data integrity            | Pass                                       | Both dashboards load from the configured database. Approved invoices have approval timestamps and valid totals. No duplicate non-null document hashes were found. There are no queued jobs and no accounting connections.                                                                                                                                                                                                     |
| Stable public URL                | Pass                                       | The Vercel homepage returns HTTP 200. Six deployed frontend assets were scanned and contain no `trycloudflare.com` reference.                                                                                                                                                                                                                                                                                                 |
| Public authentication boundaries | Mostly pass                                | Settings and invoice pages redirect to `/auth/login`; cron and inbound email reject missing credentials with HTTP 401; OAuth launch/callback routes reject missing signed state with HTTP 400. The deployed purchase-order endpoint still returns HTTP 500 because the corrected source has not been deployed. The final local production build returns the correct HTTP 302 login redirect.                                  |
| Shopify offline authentication   | Pass                                       | Two stored offline sessions authenticated successfully against Shopify. Both returned store currency `KES`.                                                                                                                                                                                                                                                                                                                   |
| Shopify product access           | Pass                                       | Both stores successfully returned product variants through the app's Admin GraphQL query, confirming read-product access for the stored sessions.                                                                                                                                                                                                                                                                             |
| Billing lookup and plan rules    | Pass / blocked live                        | Shopify billing lookup works and plan boundary tests pass. Both stores currently return no active SmartBill subscription, so live paid actions are unavailable by design. Subscription approval was not initiated.                                                                                                                                                                                                            |
| Text capture and invoice parsing | Pass                                       | Unit tests cover complete and incomplete invoices, ambiguous dates, fractional duplicate lines, missing identifiers, currencies and amount balancing.                                                                                                                                                                                                                                                                         |
| Image OCR                        | Pass locally / production credentials recommended | The real Tesseract runtime read a generated 500x650 PNG invoice and the parser recovered invoice `SMOKE-1001` with total USD 58.00 in 4.27 seconds during the 2026-09-14 verification run. Vercel uses Google Cloud Vision when `GOOGLE_APPLICATION_CREDENTIALS_JSON` is configured; `OCR_PROVIDER=auto` limits each Google request to four seconds before falling back to bounded Tesseract processing. Small and oversized inputs are normalized to bounded working dimensions before local OCR. |
| PDF extraction/OCR               | Pass locally / optimized production path   | The real PDF path processed a generated one-page PDF and recovered invoice `PDF-SMOKE-1002` with total USD 69.60. Text-based pages now bypass image OCR; scanned pages use the selected Google Vision or Tesseract provider.                                                                                                                                                                                                  |
| Private Supabase storage         | Implemented / credentials required         | Firebase was replaced with a server-only Supabase adapter covering private bucket setup, MIME and size restrictions, upload, metadata lookup, authenticated read and deletion. The live round trip still requires `SUPABASE_URL` and a server secret key.                                                                                                                                                                     |
| Background document queue        | Pass in source / blocked end to end        | Queue claims, leases, retries and duplicate handling are implemented. The new browser trigger is authenticated, subscription checked and shop scoped. Full upload-to-invoice testing is blocked by the missing bucket and subscription. A persistent worker remains the best production option.                                                                                                                               |
| Invoice review and approval      | Pass in automated rules / blocked live     | Save/revision/approval rules compile and validation tests pass. Signed-in visual editing and approval could not be exercised without a browser and active subscription.                                                                                                                                                                                                                                                       |
| Purchase orders and receipts     | Pass                                       | Fractional quantities and zero-rate items are preserved. Malformed, negative and extreme values are rejected. Partial, fulfilled, open and over-delivered receipt states are tested; over-delivery now produces `MISMATCH`.                                                                                                                                                                                                   |
| CSV export                       | Pass in automated rules / blocked live     | CSV quoting and spreadsheet-formula neutralization pass. Route compiles and requires an approved invoice plus admin access. Authenticated download was not possible in this session.                                                                                                                                                                                                                                          |
| Shopify cost sync                | Partially verified                         | Store currency and product reads now work against Shopify. Approval, currency matching, preview, interrupted-write recovery and restoration safeguards compile. No actual cost was written because there is no active subscription and changing a merchant product was outside this non-destructive audit.                                                                                                                    |
| Xero connection/export           | Adapter pass / live blocked                | Local Xero client credentials were accepted by Xero's token endpoint; the deliberately invalid authorization code was rejected as expected. Mocked OAuth, company confirmation, catalogs, bill export, tax/FX, concurrency, recovery, disconnect and attachment workflows pass. No Xero organisation is connected, and the live Connect button could not be clicked without a browser and subscription.                       |
| QuickBooks connection/export     | Adapter pass / live blocked                | Local QuickBooks client credentials were accepted by Intuit's token endpoint; the deliberately invalid authorization code was rejected as expected. Mocked sandbox/production separation, OAuth, company confirmation, catalogs, bill export, tax/FX, concurrency, recovery, disconnect and attachment workflows pass. No QuickBooks company is connected.                                                                    |
| Inbound email                    | Security pass / not configured             | The public endpoint rejects unauthenticated requests. `INBOUND_EMAIL_SECRET` and `INBOUND_EMAIL_DOMAIN` are absent locally, so real email ingestion is not active.                                                                                                                                                                                                                                                            |
| Cron processing                  | Security pass / not configured             | The public endpoint rejects unauthenticated requests. `CRON_SECRET` is absent locally and `vercel.json` has no cron schedule. The dashboard trigger now provides processing while SmartBill stays open.                                                                                                                                                                                                                       |
| Shopify compliance webhooks      | Compiles / provider delivery not exercised | Signed webhook handling, uninstall cleanup and shop redaction paths compile. A genuine signed delivery was not triggered from Shopify during this run. Destructive shop-redaction was intentionally not run against stored data.                                                                                                                                                                                              |

## Live accounting readiness

The source includes complete supplier-bill integration logic for Xero and
QuickBooks, but the app is not yet live-ready for an end-to-end accounting test.
The current database has zero accounting connections, and the two installed
stores have zero active SmartBill subscriptions. Clicking either Connect button
today will stop at the subscription requirement before provider OAuth.

After a merchant approves a plan, acceptance testing should use a Xero demo
organisation and a QuickBooks sandbox company. For each provider:

1. Click Connect from Settings and verify top-level redirect to the provider.
2. Authorize the intended test company and confirm that exact company in
   SmartBill.
3. Load the provider-backed account and purchase-tax catalogs.
4. Approve a balanced test invoice, save its line mappings and export it.
5. Confirm one draft Xero bill or one unpaid QuickBooks bill exists with the
   expected supplier, dates, currency, lines, tax and exchange rate.
6. Repeat Export and verify that no duplicate bill is created.
7. Attach the original document once and verify the attachment.
8. Exercise a rejected request and an uncertain-response verification case.
9. Disconnect and confirm provider revocation plus local credential removal.

## Required activation work

1. Set `SUPABASE_URL`, the server-only `SUPABASE_SECRET_KEY` (or legacy
   `SUPABASE_SERVICE_ROLE_KEY`) and `SUPABASE_STORAGE_BUCKET` in Vercel. The app
   creates or secures the bucket as private with a 10 MB file limit. Rerun
   `scripts/smoke-runtime.ts` without `--skip-storage` before accepting document
   uploads.
2. Deploy the corrected source. The current public deployment still contains
   the old purchase-order authentication behavior.
3. Approve a Starter or Growth subscription in a Shopify development store.
   Use `SHOPIFY_BILLING_TEST=true` only for development-store acceptance tests.
4. Connect a browser to the test session and open SmartBill inside Shopify so
   all signed-in buttons, loading states, banners and redirects can be tested.
5. For unattended OCR, run `npm run worker` on persistent compute. A Vercel Pro
   cron can run once per minute; Vercel Hobby schedules are limited to once per
   day and are unsuitable for an interactive upload queue. Configure a random
   `CRON_SECRET` of at least 16 characters if using Vercel Cron. See
   <https://vercel.com/docs/cron-jobs/usage-and-pricing> and
   <https://vercel.com/docs/cron-jobs/manage-cron-jobs>.
6. Configure the inbound email domain and secret only if Growth email capture
   will be offered.

## Reusable commands

```sh
npm test
npm run typecheck
npm run lint
npm run build:check
node --env-file=.env scripts/check-invoice-migration.mjs --verify
node --env-file=.env scripts/check-accounting.mjs --verify
node --env-file=.env node_modules/vite-node/vite-node.mjs --config vite.tasks.config.ts scripts/smoke-runtime.ts
node --env-file=.env node_modules/vite-node/vite-node.mjs --config vite.tasks.config.ts scripts/smoke-shopify.ts
node --env-file=.env node_modules/vite-node/vite-node.mjs --config vite.tasks.config.ts scripts/audit-data.ts
```

The runtime storage smoke test writes one temporary generated PNG to the private
bucket, verifies its bytes and content type, and deletes it in a `finally` block.
The Shopify and database smoke tests are read-only and do not print shop names,
tokens, credentials or invoice contents.
