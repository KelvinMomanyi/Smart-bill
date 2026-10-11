# SmartBill supplied-invoice OCR remediation - 9 October 2026

This report records actual merchant interaction in CreatorsStore254 after the user manually selected an invoice. It supplements [the earlier live review](SHOPIFY_LIVE_MCP_VERIFICATION_2026-10-08.md) and [the MCP restart checks](SHOPIFY_MCP_RESTART_VERIFICATION_2026-10-09.md). The supplied WEBP now completes OCR and saves invoice `10001`; the four extracted lines, totals and PO link were verified in the UI and database. The parser, review-save and timestamp fixes are deployed; final invoice deep-link/refresh testing passes without app exceptions.

## Root causes

**Choose File:** The application input was enabled. Playwright MCP's file-chooser subscription intercepted the merchant's clicks; repeated attempts accumulated pending chooser events. The normal MCP cancellation action cleared those prompts. Removing that page's chooser subscription through Playwright's public event API restored the native picker for manual use. The merchant selected `Freelance-Invoice-Template-Sample-500x650.webp` (11,684 bytes, `image/webp`). No denied automated attachment command was bypassed, and no file was injected into the input.

**New OCR HTTP 400:** The uploaded sample has an `INVOICE NO` label beside a separate address column, with the real number `10001` below the label. Browser OCR retained this layout:

```text
INVOICE NO                                          Main, AZ 33394
10001                                               (999) 999-9999
```

The previous parser collapsed column spacing and accepted the prefix `Main` before the comma as an invoice identifier. Five historical June captures already existed under supplier `Company Name` with invoice number `Main`. Server-side duplicate validation consequently rejected the otherwise valid sample: `POST /api/jobs` returned 400 with `{"error":"Duplicate invoice: Main is already captured."}`. The original upload had returned 202, and no partial invoice was persisted by the failed completion. The job remained retryable.

The parser now preserves column spacing when locating an invoice number, requires a complete identifier boundary, and supports the next line below the label without consuming another labelled field. Duplicate validation and tenant ownership checks remain enforced. On the deployed parser fix, the merchant's **Retry processing** action reused the private stored original and completed browser OCR: `POST /api/jobs` returned 200, the UI showed **Invoices saved for review**, and the job became `COMPLETED` with one processed page. Recognition confidence was 87%.

**Repeated review saves:** Saving this USD invoice without an exchange rate initially persisted the resolver's internal failure value `0` as a reviewed rate. Reloading then populated the optional rate input with `0`, violating its positive minimum and preventing a later save. This was reproduced while linking the invoice to a PO: the native validation message was `Value must be greater than or equal to 0.000001`, no save request was sent, and a database assertion confirmed the PO link was still null.

The FX resolver now distinguishes its internal calculation value from `reviewedRate`. Missing and invalid rates remain null in the editable and persisted field. The save service leaves rate metadata and converted cost unset and records an FX selection only when a valid rate exists. The loader also presents historical invalid rates as an empty editable field. Existing approval and cost-sync checks continue to require a valid conversion rate.

The reviewer's historical PO rejection is a separate issue: earlier remediation replaced unnamed visible item controls and an initially empty hidden JSON snapshot with named controls and shared parsing. Its exact original rejected request is unavailable. Valid native PO submissions succeeded in the earlier merchant checks and again during this OCR follow-up; this newly reproduced OCR 400 must not be presented as proof of the historical PO request's exact cause.

## Deployments and files changed

Production app: `https://smart-bill-self-five.vercel.app`, Shopify handle `smartbill-1`, store `creatorsstore254.myshopify.com`. Changes were deployed under the user's existing deployment authorization through the repository's Vercel integration. No migrations or environment changes were required.

- `75b301ce3b856702d6353a5a98abfe074d455544`: parser fix. GitHub's Production deployment became **Active / Deployed (completed)**; deployment URL `https://smart-bill-self-gn1wtf2t8-bostone339-6995.vercel.app`. Actual merchant OCR completion verified the deployed behavior.
- `a84f093d42628692449482097ff3ceeba7b824ef`: review FX fix. Production became **Active / Deployed (completed)** at `https://smart-bill-self-bfpk3frw6-bostone339-6995.vercel.app`. Two successive blank-rate saves passed through the actual UI with HTTP 200.
- `12573d5b7f8e4f5a68c47eb4191beb07e98a7683`: deterministic history timestamps. The first production attempt failed. The provider build log could not be accessed because the signed-in Vercel account cannot view the owning team's project; the exact provider failure is unknown.
- `7148a6f0752534d942ede3bba0e952777ae7564b`: whitespace cleanup and one deployment retry. GitHub confirms **Active / Deployed (completed)** at `https://smart-bill-self-nxn08yn61-bostone339-6995.vercel.app`. At 11:54 UTC, actual navigation to the supplied invoice's primary embedded Admin URL returned 200 with identical server/browser history timestamps, retained rate 129 and PO link, zero app console errors, zero uncaught exceptions, no unexpected 4xx/5xx and no failed app requests. No provider access change was required for this successful retry.

| File | Change |
|---|---|
| `app/utils/parser.server.ts` | Preserve OCR column spacing for invoice identifiers; read identifiers below their label and reject adjacent address fragments. |
| `app/__tests__/parser.test.ts` | Regressions for this sample, following-line alphanumeric identifiers, and missing-number/next-field handling. |
| `app/utils/exchangeRate.ts` | Expose a nullable reviewed rate independently of the internal invalid calculation value. |
| `app/services/invoiceReview.server.ts` | Persist missing rates and converted costs as null; avoid recording invalid FX selections. |
| `app/routes/app.invoices.$id.tsx` | Keep invalid historical rates from populating an unusable review input; format history timestamps consistently. |
| `app/__tests__/unitCost.test.ts` | Confirm missing/invalid rates stay unset and valid rates remain required for financial operations. |
| `app/utils/format.ts` | Format history timestamps consistently in explicit UTC across server and browser. |
| `app/routes/app.receipts.$id.tsx` | Apply the same stable timestamp format to receipt history. |
| `app/routes/app.reconciliation.tsx` | Use an explicit locale and UTC for PO update dates. |
| `app/__tests__/format.test.ts` | Regression for timestamp rendering in UTC, Nairobi and Los Angeles, including midnight and invalid values. |
| `app/__tests__/run.ts` | Register the timestamp regression. |
| `SHOPIFY_OCR_LIVE_REMEDIATION_2026-10-09.md` | Record this reproduction, remediation, deployments, live evidence and remaining scope. |
| `SHOPIFY_MCP_RESTART_VERIFICATION_2026-10-09.md` | Mark its earlier pending-OCR statements as superseded by this follow-up. |
| `SHOPIFY_LIVE_MCP_VERIFICATION_2026-10-08.md` | Link the later OCR evidence while retaining the original testing scope. |
| `SHOPIFY_LAUNCH_STATUS_2026-10-08.md` | Point to the current deployed fix and live verification status. |

Ignored `.cache/check-supplied-ocr-20261009.mjs` and `.cache/verify-ocr-po-20261009.mjs` contain scoped read-only database checks. Evidence includes `.cache/supplied-ocr-database-evidence-20261009.json`, `.cache/ocr-po-database-evidence-20261009.json`, `.cache/final-po-and-fx-database-evidence-20261009.json` and official MCP session diagnostics. These are not deployed application code. Authentication values and private document URLs were excluded from the reported diagnostics.

## Merchant-entered and persisted values

The initial capture selected the WEBP with supplier override, PO selection and pasted text all empty. The UI retained the original image for review, verified as loaded at 500 by 650 pixels. The invoice review showed:

| Field | Saved value |
|---|---|
| Invoice | `10001` |
| Supplier | `Company Name` |
| Invoice date | `2018-01-01` |
| Due date | Empty; the sample's expiry label was not assumed to be a payment due date. |
| Currency | USD |
| Subtotal / tax / total | 3,010.00 / 301.00 / 3,311.00 |

| Line | Quantity | Unit price | Net amount |
|---|---:|---:|---:|
| Product 1 | 2 | 45.00 | 90.00 |
| Product 2 | 3 | 100.00 | 300.00 |
| Service 1 | 1 | 20.00 | 20.00 |
| Service 2 | 5 | 520.00 | 2,600.00 |

Invoice ID: `0d3a2006-f73e-449b-a4ad-0908694321dc`; job ID: `f841a9c0-f6ad-4f4b-8bc9-15b64dd5517c`. Read-only PostgreSQL verification confirmed shop/supplier ownership, all four line foreign keys, matching document hash and exactly one record for the uploaded document. Retry did not consume another upload allowance; the home page remained at 2 / 50 uploads.

The review form accepted edits to the quantity and price controls (`5.0`, `520.00`, preserving the original values) and saved corrections, receiving `Invoice updated.` and HTTP 200. A new PO was entered through the actual merchant form with the same supplier and four lines: `MCP-OCR-20261009-01`, expected date `2026-10-16`, notes `Live OCR verification from invoice 10001 - 9 October 2026`. All optional SKUs and pasted rows were blank. Native form validity passed; submit disabled while saving. `POST /app/reconciliation` returned 200 with `Purchase order created` and ID `38b4b227-e51f-4524-9779-0200002c3bfb`. The PO reopened and survived an embedded-route browser refresh, showing USD 3,010.00 net and all entered values. The PO form has no tax field; invoice tax remains recorded separately.

The merchant session subsequently saved rate 129 and the link to that PO on invoice 10001. Those values were preserved during further testing. The invoice remains in review because billed quantities have no physical receipt yet. A separate manual-text fixture, `MCP-FX-20261009-01` (ID `9605875b-c912-4d82-8e0f-98593f12bd0f`, supplier `MCP Review Test`, date `2026-10-09`, USD 10.00, one Widget line), exercised two consecutive saves with the rate blank. Both returned 200 and `Invoice updated.`; the rate input remained empty and valid, and the database retained null rate, rate source/date and converted cost. This fixture used one additional capture allowance; final usage is 3 / 50. It is not additional file-OCR evidence.

After the final production deployment, the original valid-PO pattern was repeated from a fresh Shopify Admin app launch: home → Purchase orders → merchant form. `MCP-FINAL-20261009-01`, supplier `MCP Live Supplies`, expected date `2026-10-16`, SKU `MCP-PAPER-01`, Printer paper, quantity 2.5, unit price 12.50, notes `Final live verification - 9 October 2026`. `POST /app/reconciliation` returned 200 with `{"success":true,"message":"Purchase order created","purchaseOrderId":"119a5176-1239-49c3-80e5-7bb873bc3874","purchaseOrderNumber":"MCP-FINAL-20261009-01"}`. Database assertions at 12:22 UTC confirmed USD 31.25, every entered value, supplier/store ownership, line foreign key and exactly one matching PO.

## Tests performed

| Test | Result | Notes |
|---|---|---|
| Launch from installed Shopify Admin app | PASS | Correct CreatorsStore254 context and usable merchant UI. |
| Manual native invoice selection | PASS | Actual WEBP selected by the merchant; application file input enabled. Automated extension uploads remain restricted. |
| Initial upload / stored-original retrieval | PASS | Upload 202; retry document lookup 200. |
| Valid supplied-image OCR and retry | PASS AFTER FIX | Initial completion 400; deployed parser completion 200 and saved success banner. |
| Extracted fields and original preview | PASS | Invoice 10001, four lines, totals, date; original image loaded. |
| Merchant edit and first review save | PASS | Visible controls edited; action 200 and Invoice updated. |
| Multi-item PO creation | PASS | Four actual UI rows; action 200 and success state. |
| Original valid PO workflow on final deployed build | PASS | Fresh installed-app launch; native single-item decimal submission 200, success banner and one persisted PO with all expected values. |
| PO reopen and embedded refresh | PASS | Supplier, date, notes, lines and total retained in correct store. |
| Final deployed-build PO reopen / refresh / home return | PASS | Final PO reopened and refreshed with USD 31.25 and retained values; all monitored app responses 200 except expected cached icon 304, no app exceptions or failed app requests. |
| Manual picker readiness on the final capture tab | PASS | Correct-store home visible; file input enabled, zero native-picker interception listeners, invoice 10001 available to reopen. |
| Invoice-to-PO link | PASS | Invoice 10001 reopened linked to the new PO, with the rate 129 entered during the merchant session preserved. |
| Repeated save without FX | PASS AFTER FIX | Separate test invoice MCP-FX-20261009-01 saved twice, both action responses 200; revisions 1 and 2, empty valid rate input, success message. |
| Final linked invoice / PO database assertions | PASS | 11:23 UTC: unique invoice/document/PO, correct tenants/foreign keys, billed quantities 2/3/1/5, received quantities zero. Separate fixture's rate/metadata/converted cost all null after two saves. |
| Unexpected app 4xx/5xx after parser deployment | PASS - TESTED SCOPE | No unexpected app error statuses during OCR retry, first review save, PO creation/reopen and refresh. |
| Invoice deep link / refresh and history hydration | PASS AFTER FIX | First reproduced React 425/418/423. After the successful deployment retry, the supplied invoice loaded with matching UTC timestamps and no app exceptions or console errors. |
| Local tests / TypeScript / lint / production build | PASS | 174 tests, no failures; TypeScript and targeted ESLint pass. Final production build passes. An initial duplicate import lint failure was corrected. |
| PDF/JPG/PNG/multipage/rotated/poor-quality live uploads | NOT VERIFIED | This live sample is WEBP. Automated fixture coverage is not live UI proof for the remaining formats. |
| Live OCR timeout/service-failure matrix | NOT VERIFIED | The duplicate rejection and successful UI retry were exercised; broader failure cases still need live verification. |
| Hosted billing approval / decline / correct-store return | PREVIOUS LIVE PASS | Documented in the 8 October review; no new charge requested here. |
| Renewed billing approval after actual uninstall/reinstall | NOT VERIFIED | Requires a disposable test store or explicit authorization for destructive uninstall. |
| Xero export | NOT VERIFIED | Existing connection has not been established as a Xero Demo Company; no test MCP verification. |
| QuickBooks export | NOT CONFIGURED FOR TESTING | Merchant settings previously showed Not connected (sandbox); no sandbox MCP verification. |

## MCP evidence

| MCP | Actual use and limits |
|---|---|
| Playwright MCP | Official server connected to the signed-in browser. Native chooser diagnostics, file selection observation, merchant capture/retry/review/PO workflows, network statuses and responses, navigation and refresh. GitHub UI also confirmed the deployment. |
| Chrome DevTools MCP | Connected earlier to a separate diagnostic browser; that profile remains at Shopify login. It did not inspect this authenticated OCR or PO request. No such use is claimed. |
| Shopify Dev MCP | Official server restarted earlier in this session and searched current App Store UI and Billing API return requirements. Current references are recorded in the MCP restart report. |
| Database / Supabase MCP | Unavailable. Actual persistence was verified through read-only Prisma/PostgreSQL queries. Supabase is private document storage, not the invoice database. |
| Xero MCP | No working Demo Company test connection verified; no accounting objects created. |
| QuickBooks MCP | No working Sandbox test connection verified; no accounting objects created. |

The Playwright extension exposes the action responses and Content-Type, but its post-data accessor returned no serialized body. Entered native form values and subsequent database values were recorded independently. No exact request-byte capture or authenticated Chrome DevTools inspection is claimed.

## Network issues and remaining work

- Unexpected `POST /api/jobs` **400**, duplicate `Main`: **fixed and retested**, response 200 with invoice 10001 saved. The failed attempt persisted no partial invoice.
- Persisted-zero review rate: **fixed, deployed and retested**. Two valid saves returned 200; all missing rate values remain null in PostgreSQL.
- Invoice history refresh: **fixed, deployed and retested**. The server previously displayed `10/9/2026, 11:10:59 AM` while the Nairobi browser displayed `10/9/2026, 2:10:59 PM` for the same audit event. React emitted text mismatch and hydration recovery errors. Both now render `2026-10-09 11:10:59 UTC` without app exceptions; errors are not suppressed. See React's [text mismatch explanation](https://react.dev/errors/425).
- Shopify Admin's stale developer-preview WebSocket, optional capability/deprecation messages, and an Admin-proxied Gravatar image blocked by `ERR_BLOCKED_BY_ORB` remain browser-shell diagnostics. They did not prevent the tested app workflows; the complete Admin console is not being labelled error-free.
- A local production build initially hit a Windows Prisma DLL rename lock while tests were active. Waiting for the owned test process to finish resolved the build failure. This was not a deployed HTTP error.
- The first history-fix deployment was marked failed. One retry succeeded and actual production timestamps/refresh verified the new code. The provider's initial failure reason remains unavailable; the signed-in Vercel account cannot view the owning team's project.
- During final PO automation, two navigation actions were initially issued before the first had settled, leaving the usable home screen and timing out the test assertion. A later MCP context reset closed the managed page. No PO was submitted in those attempts. After reconnecting, the normal merchant home link and completed form submission passed once, with one database record. These tooling/navigation timing failures are not being counted as successful submissions.

Five historical June records of this sample remain under the incorrect number `Main` with older incorrect amounts and missing fourth lines. They were inspected read-only and not bulk edited or deleted. They need merchant review before any financial operation. The new corrected invoice remains unapproved, with no accounting export, product-cost sync or physical receipt. USD/KES conversion and product matching are legitimate review requirements.

The supplied-file OCR success closes this specific upload verification gap. The final deployed valid-PO creation, persistence, reopen and refresh checks also pass. Live PDF/JPG/PNG/multipage and OCR timeout/failure scenarios, actual reinstall billing, the remaining session/navigation matrix, and Xero Demo/QuickBooks Sandbox exports remain unverified. Current Shopify [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements) require usable UI across launch methods and correct billing approval behavior; that unresolved verification scope prevents an overall readiness claim.

**NOT READY FOR SHOPIFY RETEST**
