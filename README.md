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

1. Upload a PDF/image or paste invoice text. Documents enter a persisted background queue; identical uploads and repeated supplier invoice numbers are blocked.
2. Open an invoice to compare the original private document with editable fields and lines. Correct dates, currency, quantities, net prices, tax and totals. Select and explicitly confirm Shopify variants. Approved supplier matches are suggested on later captures.
3. Record deliveries from a purchase order's receipt page. Ordered, billed and physically received quantities are separate. Receipts do not adjust Shopify inventory quantities.
4. Approve the saved invoice after checking its original. Totals must balance. Accepting unresolved PO differences requires an explanation recorded in the activity history.
5. Preview old and proposed Shopify costs before applying them. Invoice and store currencies must match. Cost history supports restoration and recovery of interrupted requests by checking the current Shopify value.
6. Export approved CSV or create a bill in a connected accounting system. Live exports retain a unique attempt record and provider request key. An uncertain response blocks duplicate creation; the review page can verify an existing bill ID.

Financial activity locks invoice editing. Use a separate correcting document if needed. Earlier invoices marked exported or synced without detailed history cannot be blindly exported/synced again.

Reports keep each currency separate. Weekly time-saving estimates use the measured minutes entered in Settings; zero is the default. These are operational estimates, not guaranteed savings or profit.

## Local setup and checks

Use Node.js 22 or 24, PostgreSQL, a Shopify development store and the environment variables in `.env.example`. Supply actual values through your environment or a private `.env` file. Supabase project credentials are required for file uploads; pasted text works without file storage. Set `SUPABASE_URL` to the project API URL (`https://PROJECT_REF.supabase.co`), set `SUPABASE_SECRET_KEY` to the server-only `sb_secret_` key from the same project (or use the legacy `SUPABASE_SERVICE_ROLE_KEY`), and set `SUPABASE_STORAGE_BUCKET`. Do not use a dashboard, Storage or S3 URL, and do not use the publishable/anon key. The first storage operation creates the bucket when needed and enforces private access, the 10 MB limit and SmartBill's accepted document MIME types. Never expose the secret key to browser code.

OCR uses Google Cloud Vision first on Vercel when credentials are available. Set `GOOGLE_APPLICATION_CREDENTIALS_JSON` to the full service-account JSON and enable the Cloud Vision API in that Google Cloud project. On a persistent local host, `GOOGLE_APPLICATION_CREDENTIALS` can point to the credential JSON file. `OCR_PROVIDER=auto` falls back to the bundled Tesseract engine when Google is unavailable or rejects a request. `OCR_PROVIDER=google` makes Google mandatory, while `OCR_PROVIDER=tesseract` explicitly selects the local engine. Text-based PDF pages bypass image OCR.

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

Run a separate persistent Node service with `npm run worker`, sharing the database, Shopify, Supabase and OCR configuration with the web service. Keep `eng.traineddata` in its working directory when Tesseract is enabled. The included Dockerfile provides a Node 22 Linux runtime and excludes local secrets; use the same image for web and worker services, changing the worker start command. The Docker image itself still needs to be built and tested on your deployment platform.

Alternatively, a scheduler can call `/api/jobs/run` with `Authorization: Bearer <CRON_SECRET>` to process one queued document per call. Configure the schedule and execution time explicitly. The repository does not activate a scheduler. Stale worker leases recover after two minutes. OCR configuration errors and timeouts fail visibly and can be retried after correction; other transient failures are retried up to three times.

App limits are 10 MB and 10 pages per document, and 25 MB per batch. Vercel-hosted browser uploads are capped at 4 MB per batch because Vercel Functions have a 4.5 MB request/response payload limit. Larger documents and full-size inbound email payloads need the Node service behind an ingress that supports these sizes. See [Vercel function limits](https://vercel.com/docs/functions/limitations). Test original-document viewing and OCR on the actual host.

The installed Shopify SDK supports `2025-10`, now selected for Admin API calls and webhooks. Upgrade the SDK and retest before that API version retires on October 16, 2026; see [Shopify's version schedule](https://shopify.dev/docs/api/usage/versioning). Current scopes are limited to product reads and inventory cost access.

## Accounting and email activation

Register these callback URLs with your accounting OAuth applications:

- `https://YOUR_APP/accounting/xero/callback`
- `https://YOUR_APP/accounting/quickbooks/callback`

Set the Xero/QuickBooks credentials in the environment, connect from Settings and explicitly confirm the company. Select accounts and purchase taxes from provider-backed choices. Invoice Accounting details supports mixed line taxes and reviewed foreign exchange rates. QuickBooks supports international purchase-tax bills and an explicitly selected expense account for US non-recoverable purchase sales tax. Xero creates draft purchase bills; QuickBooks creates unpaid bills. Both support original-document attachments, provider-side disconnect, confirmed-rejection retries and verification of uncertain outcomes. See [Accounting integrations](ACCOUNTING_INTEGRATIONS.md) for configuration, supported scope and live acceptance steps.

For Growth email capture, configure a Postmark-compatible inbound webhook to `/api/inbound-email` using HTTP Basic username `smartbill` and password `INBOUND_EMAIL_SECRET`. Set `INBOUND_EMAIL_DOMAIN` to the receiving domain and route mail for generated aliases to that webhook. Enable the store's inbox from Settings. Only authenticated webhook requests for a single known store are accepted; document hashes deduplicate provider retries. Inbound email is not active until the mail provider and receiving domain are configured.

## Before publication

- Apply the migration and test install/login with both the owner and a separate staff account. `SHOPIFY_BILLING_TEST=true` temporarily treats authenticated installed stores as Growth subscribers so all paid features can be acceptance-tested without a charge. Set it to `false` and redeploy before publishing so Shopify subscription checks are enforced.
- Upload real supplier samples, correct extraction, record partial deliveries, approve, preview costs, sync and restore on test products. Test usage exhaustion and duplicate capture.
- Exercise accounting export and interrupted-response verification against test organisations, including tax and currency mismatch cases.
- Deploy the compliance webhook subscriptions in `shopify.app.toml` and verify signed requests. Uninstall stops jobs and removes sessions/connections. Shop redaction deletes the shop's invoice files and app records; customer-specific topics are acknowledged because SmartBill stores supplier invoices, not customer/order records.
- Configure private storage rules, backups, operator contact information and a privacy policy appropriate to the actual hosting setup. Rotate any credentials previously shared or committed; replacing `.env.example` with placeholders does not revoke old credentials.

App Store publication, paid subscription approval, provider setup and production migrations have not been performed by these source changes.
