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

Use Node.js 22 or 24, PostgreSQL, a Shopify development store and the environment variables in `.env.example`. Supply actual values through your environment or a private `.env` file. Firebase Admin credentials and a private storage bucket are required for file uploads; pasted text works without file storage.

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

Checks do not apply migrations:

```sh
npm test
npm run typecheck
npm run lint
npm run build:check
```

The automated tests cover parsing, fractional quantities, date order, total validation, approval/currency rules, PO ambiguity, pricing boundaries, tax allocation, CSV escaping and upload validation. They do not contact Shopify, Xero or QuickBooks, or prove production database concurrency.

## Deployment

Set one stable HTTPS `SHOPIFY_APP_URL` and use that URL in `shopify.app.toml`, the Shopify app configuration and OAuth callbacks. The current TOML uses `https://smart-bill-self.vercel.app`. A temporary `trycloudflare.com` development URL only works while its tunnel is active; restarting development can change that URL. Updating source files does not deploy the app or update its remote Shopify configuration.

Build with `npm run build`. Builds generate Prisma Client but do not apply database migrations. Before starting the new release, back up the database and run `npm run setup` against the intended database, then start the web service with `npm start`. The invoice-controls migration preserves old invoice-derived receipt totals as billed quantities and requires new physical delivery records; earlier approvals need review again.

Run a separate persistent Node service with `npm run worker`, sharing the database, Shopify credentials and Firebase configuration with the web service. Keep `eng.traineddata` in its working directory. The included Dockerfile provides a Node 22 Linux runtime and excludes local secrets; use the same image for web and worker services, changing the worker start command. The Docker image itself still needs to be built and tested on your deployment platform.

Alternatively, a scheduler can call `/api/jobs/run` with `Authorization: Bearer <CRON_SECRET>` to process one queued document per call. Configure the schedule and execution time explicitly. The repository does not activate a scheduler. Stale worker leases recover after 15 minutes; failed documents are retried up to three times before requiring a manual retry.

App limits are 10 MB and 10 pages per document, and 25 MB per batch. Vercel-hosted browser uploads are capped at 4 MB per batch because Vercel Functions have a 4.5 MB request/response payload limit. Larger documents and full-size inbound email payloads need the Node service behind an ingress that supports these sizes. See [Vercel function limits](https://vercel.com/docs/functions/limitations). Test original-document viewing and OCR on the actual host.

The installed Shopify SDK supports `2025-10`, now selected for Admin API calls and webhooks. Upgrade the SDK and retest before that API version retires on October 16, 2026; see [Shopify's version schedule](https://shopify.dev/docs/api/usage/versioning). Current scopes are limited to product reads and inventory cost access.

## Accounting and email activation

Register these callback URLs with your accounting OAuth applications:

- `https://YOUR_APP/accounting/xero/callback`
- `https://YOUR_APP/accounting/quickbooks/callback`

Set the Xero/QuickBooks client credentials in the environment, then connect the organisation from Settings. Enter its actual purchase/expense account and tax mapping there. Xero exports validate the returned total. QuickBooks live export currently supports untaxed bills; use reviewed CSV for taxed bills. Currency conversion, mixed line tax treatments and credit notes are not automated. Provider verification can resolve a bill that already exists; an attempt that provably created no bill still requires operator investigation before resetting its export record.

For Growth email capture, configure a Postmark-compatible inbound webhook to `/api/inbound-email` using HTTP Basic username `smartbill` and password `INBOUND_EMAIL_SECRET`. Set `INBOUND_EMAIL_DOMAIN` to the receiving domain and route mail for generated aliases to that webhook. Enable the store's inbox from Settings. Only authenticated webhook requests for a single known store are accepted; document hashes deduplicate provider retries. Inbound email is not active until the mail provider and receiving domain are configured.

## Before publication

- Apply the migration and test install/login with both the owner and a separate staff account. Approve a test subscription in a development store using `SHOPIFY_BILLING_TEST=true`; keep test billing off for production merchants.
- Upload real supplier samples, correct extraction, record partial deliveries, approve, preview costs, sync and restore on test products. Test usage exhaustion and duplicate capture.
- Exercise accounting export and interrupted-response verification against test organisations, including tax and currency mismatch cases.
- Deploy the compliance webhook subscriptions in `shopify.app.toml` and verify signed requests. Uninstall stops jobs and removes sessions/connections. Shop redaction deletes the shop's invoice files and app records; customer-specific topics are acknowledged because SmartBill stores supplier invoices, not customer/order records.
- Configure private storage rules, backups, operator contact information and a privacy policy appropriate to the actual hosting setup. Rotate any credentials previously shared or committed; replacing `.env.example` with placeholders does not revoke old credentials.

App Store publication, paid subscription approval, provider setup and production migrations have not been performed by these source changes.
