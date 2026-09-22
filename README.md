# SmartBill

SmartBill helps Shopify inventory teams capture supplier invoices, review costs, reconcile purchase orders and prepare accounting bills. This is an unpublished app; external billing, OCR hosting and accounting connections still require deployment configuration and development-store testing.

## Launch pricing

| Plan    | USD every 30 days | Invoices per calendar month |
| ------- | ----------------: | --------------------------: |
| Starter |               $19 |                          50 |
| Growth  |               $49 |                         250 |

Both plans include a 14-day trial, invoice editing and approval, purchase orders, physical receipt tracking, product cost sync, CSV export, vendor analytics, weekly reports and accounting connections. Growth adds batches of up to 10 documents and an optional invoice email inbox.

Allowances reset on the first day of each month in UTC. Each accepted document counts once, including documents that need correction or fail OCR. Retrying the same upload does not use another allowance. Manual captures count when saved. There are no automatic overage fees. Shopify manages subscription approval and replacement; existing subscribers must approve a replacement to receive the new price.

Pricing is centralized in `app/utils/plans.ts`. Paid actions check the active Shopify subscription on the server. Store owners manage staff access in Settings. Staff can capture and correct invoices; approvers can approve invoices, change product costs and export bills.

## Workflow

1. Upload a PDF/image or paste invoice text. Dashboard uploads use enhanced browser Tesseract recognition with live progress. Originals are stored privately before recognition and saved results go to invoice review. Identical uploads and repeated supplier invoice numbers cannot create a second invoice.
2. Open an invoice to compare the original private document with editable fields and lines. Correct dates, currency, quantities, net prices, tax and totals. Select and explicitly confirm Shopify variants. Approved supplier matches are suggested on later captures.
3. Record deliveries from a purchase order's receipt page. Ordered, billed and physically received quantities are separate. Receipts do not adjust Shopify inventory quantities.
4. Approve the saved invoice after checking its original. Totals must balance. Accepting unresolved PO differences requires an explanation recorded in the activity history.
5. Preview old and proposed Shopify costs before applying them. Invoice and store currencies must match. Cost history supports restoration and recovery of interrupted requests by checking the current Shopify value.
6. Export approved CSV or create a bill in a connected accounting system. Live exports retain a unique attempt record and provider request key. An uncertain response blocks duplicate creation; the review page can verify an existing bill ID.

Financial activity locks invoice editing. Use a separate correcting document if needed. Earlier invoices marked exported or synced without detailed history cannot be blindly exported/synced again.

Reports keep each currency separate. Weekly time-saving estimates use the measured minutes entered in Settings; zero is the default. These are operational estimates, not guaranteed savings or profit.

## Freight, duty and landed cost

Capture tags freight, shipping, delivery, customs duty, handling and insurance lines as charges instead of products. A charge line is never matched to a Shopify variant and is never synced as a product cost; it is spread across the invoice product lines so the cost written to Shopify is the landed cost rather than the bare invoice rate.

- Choose the method in the invoice **Freight, duty and landed cost** section: by line value (default), by quantity, by product weight, or manual amounts per line. `Do not allocate` leaves the charges unallocated and blocks approval, cost preview and cost sync.
- Weight allocation uses the Shopify inventory-item weight of each mapped variant. If a line has no weight, SmartBill allocates by line value and states that in the warnings instead of failing.
- The preview shows the allocated charge and the landed cost per unit for every product line. Landed cost per unit is `(net line amount + allocated charge) / quantity`, which is exactly what is written to the Shopify variant cost.
- Rounding always reconciles to the charge total; the largest line absorbs the remainder, so allocated amounts never drift.
- Manual amounts must total the charge lines, or the invoice cannot be saved or approved.
- Saving corrections resets approval, so the landed cost is always previewed against approved figures.
- Charge lines remain their own lines on the accounting bill (CSV, Xero, QuickBooks). SmartBill does not post the allocation to accounting; it changes the Shopify cost only.
- Freight allocated to product lines that are not selected for cost sync is reported as a warning in the cost review because that share is not written to Shopify.
- Invoices captured before this change keep their existing lines as products until a merchant retags them, so no historical invoice is altered automatically.

## Local setup and checks

Use Node.js 22 or 24, PostgreSQL, a Shopify development store and the environment variables in `.env.example`. Supply actual values through your environment or a private `.env` file. Supabase project credentials are required for file uploads; pasted text works without file storage. Set `SUPABASE_URL` to the project API URL (`https://PROJECT_REF.supabase.co`), set `SUPABASE_SECRET_KEY` to the server-only `sb_secret_` key from the same project (or use the legacy `SUPABASE_SERVICE_ROLE_KEY`), and set `SUPABASE_STORAGE_BUCKET`. Do not use a dashboard, Storage or S3 URL, and do not use the publishable/anon key. The first storage operation creates the bucket when needed and enforces private access, the 10 MB limit and SmartBill's accepted document MIME types. Never expose the secret key to browser code.

Dashboard capture and Retry/Continue processing use Tesseract.js 6.0.1 in the browser, reuse one English worker for every page, enable auto-rotation, preserve word spacing and render PDFs with PDF.js at 2x scale. Images are resized to a bounded resolution and a grayscale contrast pass improves small decimal points and currency glyphs. Weak first readings receive one alternate sparse-layout pass; SmartBill scores both complete readings and keeps the stronger one. Each PDF page is recognized in order, with page markers, progress, an image preview, raw text and recognition confidence. PDFs over the ten-page limit are rejected explicitly rather than silently truncated.

The parser accepts common currency symbols and codes, decimal points or decimal commas, and common thousands separators. It makes conservative repairs for OCR errors in monetary context, such as `S55.89`, `$SS.89`, `§55,89`, `U5D`, `TotaI` and `SubtotaI`, without applying digit substitutions to supplier names or invoice identifiers. Line items can be reconstructed from ordinary rows, rows with units or tax/code columns, wrapped descriptions and values, amount-only tables, quantity-plus-amount tables, and OCR output arranged as whole columns. Missing line amounts or rates are derived only when the detected table headers establish which value is present. Supported currency detection includes USD, EUR, GBP, CAD, AUD, NZD, KES, ZAR, NGN, GHS, JPY, CNY, INR, AED, UGX, TZS, RWF, BRL and PHP. Users must still confirm the original document, currency, tax and every amount before approval.

The first use downloads the OCR engine and English data; subsequent recognition uses the browser cache. Keep the page open until saving completes. Google credentials and `OCR_TIMEOUT_MS` do not affect this browser processor.

An upload is stored in private Supabase Storage as an `AWAITING_OCR` job before recognition. The browser submits text and page count to an authenticated, subscription-checked completion endpoint; the server parses and validates it, then saves the original reference and invoice for review. Jobs remain available for browser retries after interruption. Duplicate uploads and retries reuse the original job and usage reservation. The server queue does not claim `AWAITING_OCR` jobs.

Unattended email/API jobs still use the server processor. For that worker only, `OCR_PROVIDER=auto` tries Google Cloud Vision when server credentials are present, then falls back to Tesseract. Configure `GOOGLE_APPLICATION_CREDENTIALS_JSON` for Vercel or `GOOGLE_APPLICATION_CREDENTIALS` on a persistent host. `OCR_PROVIDER=google` requires Google; `OCR_PROVIDER=tesseract` selects the local server engine.

```sh
npm ci
npm run setup
npm run dev
```

`setup` applies database migrations to `DATABASE_URL`. Use a development database locally.

Run the queue worker in a separate terminal with the same environment:

```sh
npm run worker
```

When a merchant keeps the SmartBill dashboard open, the browser also asks the
server to process one queued document at a time. This makes single-document
processing usable on hosts without a persistent worker. A worker or frequent
scheduler is still recommended so processing continues after the merchant
closes SmartBill. The browser-triggered endpoint is authenticated, subscription
checked and restricted to the signed-in shop.

Checks do not apply migrations:

```sh
npm test
npm run typecheck
npm run lint
npm run build:check
```

The automated tests cover parsing, invoice controls, pricing, CSV/upload validation and accounting workflows, including OAuth callbacks, company confirmation, taxed bills, token refresh, duplicate/concurrent exports, recovery and attachments. Accounting workflow tests use mocked APIs and a serialized database adapter with dummy credentials. They do not contact Shopify, Xero or QuickBooks, or prove production database concurrency.

To smoke-test the real OCR engine and the configured private Supabase bucket,
run the following from a trusted development machine. The script creates one
generated invoice image, verifies extraction and parsing, uploads it, reads it
back and deletes it in a `finally` block.

```sh
node --env-file=.env node_modules/vite-node/vite-node.mjs --config vite.tasks.config.ts scripts/smoke-runtime.ts
```

Add `--skip-storage` to verify image/PDF OCR and parsing when a Supabase
bucket is not available.

Use the stored offline sessions to run read-only Shopify authentication,
currency and subscription checks with:

```sh
node --env-file=.env node_modules/vite-node/vite-node.mjs --config vite.tasks.config.ts scripts/smoke-shopify.ts
```

Run read-only dashboard and invoice-integrity checks against the configured
database with:

```sh
node --env-file=.env node_modules/vite-node/vite-node.mjs --config vite.tasks.config.ts scripts/audit-data.ts
```

## Deployment

Set one stable HTTPS `SHOPIFY_APP_URL` and use that URL in `shopify.app.toml`, the Shopify app configuration and OAuth callbacks. The current TOML uses `https://smart-bill-self.vercel.app`. A temporary `trycloudflare.com` development URL only works while its tunnel is active; restarting development can change that URL. Updating source files does not deploy the app or update its remote Shopify configuration.

Vercel uses `npm run build:deploy` from `vercel.json`: it builds the app, applies pending migrations with `prisma migrate deploy`, and verifies migration status before allowing the deployment to finish. Build-time and runtime `DATABASE_URL` must point to the same database. Give Preview deployments their own database through Preview-scoped environment variables.

Local `npm run build` and `npm run build:check` only generate Prisma Client and build the app. For other hosts, use `npm run build:deploy` as the release command, or run `npm run setup` against the intended database before starting `npm start`. Back up existing data before schema upgrades. The invoice-controls migration preserves old invoice-derived receipt totals as billed quantities and requires new physical delivery records; earlier approvals need review again.

If a deployed app reports `P2022: Invoice.documentHash does not exist`, its Prisma Client is newer than its database schema. Apply the committed migrations to that deployment's database with `npm run prisma -- migrate deploy`, then verify with `npm run prisma -- migrate status`. Generating Prisma Client alone does not update database tables. See [Prisma's production migration guidance](https://www.prisma.io/docs/orm/v6/prisma-client/deployment/deploy-database-changes-with-prisma-migrate).

For unattended email/API OCR, run a separate persistent Node service with `npm run worker`, sharing the database, Shopify, Supabase and OCR configuration with the web service. Keep `eng.traineddata` in its working directory when Tesseract is enabled. The included Dockerfile provides a Node 22 Linux runtime and excludes local secrets; use the same image for web and worker services, changing the worker start command. The Docker image itself still needs to be built and tested on your deployment platform.

Alternatively, a scheduler can call `/api/jobs/run` with `Authorization: Bearer <CRON_SECRET>` to process one queued document per call. Configure the schedule and execution time explicitly. The repository does not activate a scheduler. Stale worker leases recover after two minutes. OCR configuration errors and timeouts fail visibly and can be retried after correction; other transient failures are retried up to three times.

Call `/api/maintenance/run` once daily with the same bearer secret to escalate overdue approvals, send configured daily notification digests and refresh the current monthly reporting snapshot. Immediate Slack notifications use a workspace incoming webhook. Email notifications use SendGrid and require `SENDGRID_API_KEY` plus `NOTIFICATION_FROM_EMAIL`. Historical FX lookup through Open Exchange Rates requires `OPENEXCHANGERATES_APP_ID`; reviewed manual rates remain available without it.

Browser and server OCR support up to ten pages per document. File and batch limits are 10 MB per document and 25 MB per batch. Vercel-hosted browser uploads are capped at 4 MB per batch because Vercel Functions have a 4.5 MB request/response payload limit. Larger documents and full-size inbound email payloads need the Node service behind an ingress that supports these sizes. Test original-document viewing and OCR on the actual host.

The installed Shopify SDK supports `2025-10`, now selected for Admin API calls and webhooks. Upgrade the SDK and retest before that API version retires on October 16, 2026; see [Shopify's version schedule](https://shopify.dev/docs/api/usage/versioning). Current scopes are limited to product reads and inventory cost access.

## Accounting and email activation

Register these callback URLs with your accounting OAuth applications:

- `https://YOUR_APP/accounting/xero/callback`
- `https://YOUR_APP/accounting/quickbooks/callback`

Set the Xero/QuickBooks credentials in the environment, connect from Settings and explicitly confirm the company. Select accounts and purchase taxes from provider-backed choices. Invoice Accounting details supports mixed line taxes and reviewed foreign exchange rates. QuickBooks supports international purchase-tax bills and an explicitly selected expense account for US non-recoverable purchase sales tax. Xero creates draft purchase bills; QuickBooks creates unpaid bills. Both support original-document attachments, provider-side disconnect, confirmed-rejection retries and verification of uncertain outcomes. See [Accounting integrations](ACCOUNTING_INTEGRATIONS.md) for configuration, supported scope and live acceptance steps.

For Growth email capture, configure a Postmark-compatible inbound webhook to `/api/inbound-email` using HTTP Basic username `smartbill` and password `INBOUND_EMAIL_SECRET`. Set `INBOUND_EMAIL_DOMAIN` to the receiving domain and route mail for generated aliases to that webhook. Enable the store's inbox from Settings. Only authenticated webhook requests for a single known store are accepted; document hashes deduplicate provider retries. Inbound email is not active until the mail provider and receiving domain are configured.

## Supported operating boundary

SmartBill is designed for product-based Shopify merchants processing roughly 250 or fewer supplier documents per month. It supports freight/duty allocation, supplier credit notes, reviewed foreign-currency conversion, pack-size conversion, multi-step approvals, Xero/QuickBooks supplier bills and credits, notifications, and vendor/price reporting. Every financial write remains approval-gated and auditable.

The store still has one Shopify base currency. FX revaluation is calculated and recorded for review but is not automatically posted as a gain/loss journal. Browser and server OCR stop at ten pages, Vercel request-size limits still apply, and freight weight allocation falls back to value when Shopify product weights are incomplete. NetSuite, Sage, Wave, native Shopify PO/Transfer import, mobile photo capture and historical CSV migration are not included in this release; do not advertise those workflows as available.

## Before publication

- Apply the migration and test install/login with both the owner and a separate staff account. `SHOPIFY_BILLING_TEST=true` temporarily treats authenticated installed stores as Growth subscribers so all paid features can be acceptance-tested without a charge. Set it to `false` and redeploy before publishing so Shopify subscription checks are enforced.
- Upload real supplier samples, correct extraction, record partial deliveries, approve, preview costs, sync and restore on test products. Test usage exhaustion and duplicate capture.
- Exercise accounting export and interrupted-response verification against test organisations, including tax and currency mismatch cases.
- Deploy the compliance webhook subscriptions in `shopify.app.toml` and verify signed requests. Uninstall stops jobs and removes sessions/connections. Shop redaction deletes the shop's invoice files and app records; customer-specific topics are acknowledged because SmartBill stores supplier invoices, not customer/order records.
- Configure private storage rules, backups, operator contact information and a privacy policy appropriate to the actual hosting setup. Rotate any credentials previously shared or committed; replacing `.env.example` with placeholders does not revoke old credentials.

App Store publication, paid subscription approval, provider setup and production migrations have not been performed by these source changes.
