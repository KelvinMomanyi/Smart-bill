# Xero and QuickBooks integration

Implementation and verification notes, 10 September 2026.

## What is implemented

SmartBill connects a Shopify shop to one Xero organisation and one QuickBooks Online company. It exports approved supplier invoices as Xero draft purchase bills (`ACCPAY`) or QuickBooks unpaid bills. It also exports reviewed CSV independently of either provider.

The connection flow leaves the Shopify iframe, uses a signed, unique, expiring OAuth state and a browser cookie, exchanges the authorization code once, and asks the merchant to confirm the company. Xero lists the authorised organisations; it does not silently choose the first. Client secrets and tokens never appear in loader data or the browser.

Access and refresh tokens are encrypted using authenticated AES-256-GCM encryption. PostgreSQL locks serialize refreshes, reconnects and disconnects across server instances. Disconnect revokes access at the provider before deleting local credentials. Changing company clears store accounting defaults; saved invoice choices and export history remain associated with their original company and environment.

Settings loads active purchase accounts and purchase tax codes from the connected company. Invoice **Accounting details** allows different accounts and taxes on each line. The app checks net line totals and computed tax against the approved invoice before creating a bill.

| Capability                                           | Xero                                                     | QuickBooks Online                                                            |
| ---------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Connect, reconnect and revoke access                 | Yes                                                      | Yes                                                                          |
| Explicit company confirmation                        | Organisation selection                                   | Company confirmation                                                         |
| Production and test destinations                     | Authorised organisation, including a demo organisation   | Separate sandbox and production API destinations                             |
| Active purchase account choices                      | Yes                                                      | Yes                                                                          |
| Zero-tax and mixed-rate purchase bills               | Yes                                                      | Yes                                                                          |
| US purchase sales tax                                | Organisation tax setup                                   | Separate non-recoverable expense account chosen by the merchant              |
| Foreign-currency bills                               | Enabled organisation currency and reviewed exchange rate | Multicurrency enabled, compatible vendor currency and reviewed exchange rate |
| Duplicate protection and interrupted export recovery | Yes                                                      | Yes                                                                          |
| Original document attachment after export            | Yes                                                      | Yes                                                                          |

Xero uses its current granular `accounting.invoices` scope, plus contacts, read-only settings, attachments and offline access. These match the [Xero scope definitions](https://developer.xero.com/documentation/guides/oauth2/scopes/).

## Required deployment configuration

Use a stable HTTPS URL, not a temporary Cloudflare development tunnel. For the currently configured domain, register these exact redirect URIs in the provider developer applications:

```text
https://smart-bill-self.vercel.app/accounting/xero/callback
https://smart-bill-self.vercel.app/accounting/quickbooks/callback
```

Both the initial request and token exchange derive the URI from `SHOPIFY_APP_URL`, preventing reverse-proxy host differences from changing it.

Required environment variables:

```text
SHOPIFY_APP_URL=https://smart-bill-self.vercel.app
XERO_CLIENT_ID=...
XERO_CLIENT_SECRET=...
QB_CLIENT_ID=...
QB_CLIENT_SECRET=...
QB_ENVIRONMENT=production
```

For a QuickBooks sandbox deployment, set `QB_ENVIRONMENT=sandbox`. Prefer a separate `QB_SANDBOX_CLIENT_ID` / `QB_SANDBOX_CLIENT_SECRET` pair. If that pair is absent, sandbox uses `QB_CLIENT_ID` / `QB_CLIENT_SECRET`; those values must then be sandbox credentials. Each saved connection retains its environment. Switching the environment variable does not silently move existing connections.

Optionally configure `ACCOUNTING_TOKEN_KEY` as a base64-encoded 32-byte secret before connecting companies. If absent, SmartBill derives a separate encryption key from `SHOPIFY_API_SECRET` using HKDF. Keep the chosen key stable and backed up through your secret manager. Changing the key or changing the fallback Shopify secret without a token migration requires reconnecting accounting companies. Existing plaintext accounting tokens are encrypted on their next successful read/refresh.

Apply the additive migration before running the new server:

```sh
npm run prisma -- migrate deploy
npm run prisma -- migrate status
```

The migration is `20260910100000_complete_accounting_integrations`. It adds accounting choices, connection metadata, company-bound export history, attachment status, and temporary OAuth authorization records. It does not delete invoices or reset approvals. Vercel's existing `build:deploy` command applies migrations before completing deployment.

The database inspection helper does not print tokens:

```sh
node --env-file=.env scripts/check-accounting.mjs --before
node --env-file=.env scripts/check-accounting.mjs --verify
```

## Merchant workflow

1. Open **Settings**, choose **Connect Xero** or **Connect QuickBooks**, grant access, and confirm the correct accounting company.
2. Select the purchase account and default purchase tax from that company's choices. For a US QuickBooks company, select an expense account if invoices contain non-recoverable purchase sales tax.
3. Capture and review a supplier invoice. Enter net line amounts and separate tax. Save and approve it.
4. Open **Xero accounting details** or **QuickBooks accounting details** if individual lines need different tax/account choices or if the invoice uses foreign currency. Save the choices; the app checks the tax total.
5. Use **Export to Xero** or **Export to QuickBooks**. Xero creates a draft bill for final accounting review; QuickBooks creates an unpaid bill.
6. Check the export history. After successful export, **Attach original document to bill** uploads the private original document without creating another bill.

The foreign exchange input is explicit: **1 invoice-currency unit equals X home-currency units**. SmartBill sends that rate to QuickBooks and its reciprocal to Xero. Xero's API defines `CurrencyRate` as foreign currency per base currency, so these directions must differ. See [Xero multicurrency guidance](https://developer.xero.com/documentation/best-practices/data-integrity/multicurrency/).

International QuickBooks purchase taxes use the selected code's `PurchaseTaxRateList`, not its sales-tax rate list. Tax details carry rate references, taxable bases and amounts. Supported compound rates follow their configured order; an unrecognized or inconsistent tax arrangement is blocked before export. US QuickBooks purchase sales tax is represented as a separate expense line because its sales-tax feature does not supply international purchase-tax recovery. See [Intuit's explanation and expense-account approach](https://quickbooks.intuit.com/learn-support/global/other-questions/hi-there-abr-ora-in-quickbooks-online-qbo-you-can-se/01/384400).

## Export recovery

Every live export has one durable record per invoice/provider and a provider request key. The app searches for a bill with the same supplier and invoice number before creating a new bill.

- **EXPORTED:** The provider returned a matching bill and the local invoice/audit update completed. Repeating Export returns the existing result.
- **REJECTED:** The request was explicitly rejected, or preparation failed before bill submission. Correct the issue and retry from Export. A rejected invoice may be edited and reapproved; accounting choices can also be corrected.
- **SENDING:** An attempt is running. Wait two minutes before recovery.
- **VERIFY:** The outcome is uncertain, a duplicate already exists, or the returned bill differs from the approved invoice. Use **Find / verify existing bill**. Leave its ID blank to search, or enter the actual bill ID.

Verification checks the company/environment, supplier, invoice number, dates, currency and amounts. Unknown network outcomes never trigger blind resubmission. A provider returning a mismatched bill ID is recorded so the user can correct that bill rather than creating a second one.

An absent search result does not prove a timed-out create request failed. Such attempts remain blocked pending investigation. The same rule applies to uncertain attachment uploads. There is no unsafe "reset and create another bill" button.

## Validation and remaining acceptance work

The automated suite covers payloads, mixed taxes, US tax expense lines, foreign currencies, invalid mappings, state tampering and expiry, browser binding, encryption, token endpoints, actual OAuth callback/confirmation flows, concurrent token refresh, account pagination, duplicate clicks, concurrent exports, confirmed rejections, timeouts, mismatched totals, existing bills, attachments, and provider-side disconnect.

Workflow tests execute the real application services against mocked provider responses and a serialized in-memory database adapter. They use dummy credentials and an unreachable local test database URL, never the configured production database. They do not substitute for testing provider permissions, the actual embedded Shopify browser flow, or regional accounting behaviour against a real test company.

At inspection, the configured database contained **0 accounting connections and 0 accounting exports**. Local environment variables existed for both providers, but credentials alone do not grant access to a company. No live accounting bill was created during this implementation.

The accounting migration was applied successfully to the configured database on 10 September 2026. All five schema checks passed, and the existing **5 invoices and 15 invoice lines** were preserved. The automated suite now has **62 passing tests**. Source changes still need deployment before merchants can use the new connection and export screens.

Before calling the integration live-verified:

1. Deploy these changes with the migration and correct environment values.
2. Connect a Xero demo/test organisation and a QuickBooks sandbox company through Settings.
3. Export one approved zero-tax bill and one taxed/mixed-rate bill. Confirm supplier, account, tax treatment, dates, original currency and amounts in the provider UI.
4. Test a reviewed foreign-currency bill where multicurrency is enabled.
5. Attach a document, repeat export, disconnect, reconnect, and confirm no duplicates.
6. Repeat relevant cases in the intended country/edition and verify production developer-app access before enabling real merchants.

The supported scope is supplier bill export. This is not a full two-way accounting sync: payments, credit notes, inventory quantity synchronization, arbitrary journal entries, provider-side edits flowing back into SmartBill, and every specialised tax regime are separate capabilities. Unsupported tax arrangements fail explicitly rather than being silently posted with guessed tax.
