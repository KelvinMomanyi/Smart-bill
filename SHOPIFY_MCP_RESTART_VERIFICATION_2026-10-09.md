# Shopify MCP restart and live verification — 9 October 2026

**Later OCR follow-up:** [Supplied-invoice OCR remediation](SHOPIFY_OCR_LIVE_REMEDIATION_2026-10-09.md) supersedes the pending-upload statements below. Manual WEBP selection and OCR completion passed; parser, repeated-save exchange-rate and refresh timestamp defects were fixed, deployed and verified. A final valid PO was created, reopened, refreshed and checked in the database on the deployed build. The sections below retain their earlier testing scope.

The live connection was restarted and the deployed SmartBill application was tested through Shopify Admin in `creatorsstore254.myshopify.com`. The valid PO workflow works in this run. Full Shopify retest readiness remains unconfirmed because live OCR, billing after reinstall, and accounting exports have outstanding verification prerequisites.

Deployment tested: `https://smart-bill-self-five.vercel.app`, app handle `smartbill-1`. The implementation deployed on 8 October remains unchanged. See [the previous full review](SHOPIFY_LIVE_MCP_VERIFICATION_2026-10-08.md) for diagnosis, implementation changes and the broader test matrix.

## Root cause and fix status

The reviewer's historical valid-PO HTTP 400 did not recur. The current merchant form submitted successfully to `POST /app/reconciliation` with HTTP 200. This run confirms the deployed behavior; it does not establish the exact contents of the reviewer's original rejected request, which remain unavailable.

No additional application defect requiring a code fix was discovered in the workflows completed in this run. The previous PO, store-context navigation, billing-return and responsive hydration remediations remain deployed.

## Valid PO reproduction

Merchant path: Shopify Admin → SmartBill → Purchase orders → enter values → Create purchase order.

| Field | Entered value |
|---|---|
| Vendor | MCP Live Supplies |
| PO number | MCP-RESTART-20261009-01 |
| Expected date | 2026-10-16 |
| Item SKU | MCP-PAPER-01 |
| Item name | Printer paper |
| Quantity | 2.5 |
| Unit price | 12.50 |
| Notes | MCP connection restart verification - 9 October 2026 |
| Expected total | USD 31.25 |

The browser showed “Purchase order created” and a link to open the saved order. The endpoint returned:

```json
{"success":true,"message":"Purchase order created","purchaseOrderId":"c4eda12f-96b4-45dd-b913-f9b37914ab71","purchaseOrderNumber":"MCP-RESTART-20261009-01"}
```

Playwright MCP's network list records the submission as request 796, HTTP 200. Its request-body accessor returned no body in extension mode; the exact serialized request bytes were therefore not recovered. Entered values, the action response, reopened UI and database values were verified independently. Chrome DevTools did not inspect this authenticated POST.

The first automation assertion looked for a bare PO number, while the actual link includes “Receive stock”. That assertion timed out after successful creation. The test inspected the success state and existing record before proceeding; it did not repeat the submission. Reopening and refreshing the saved order then passed.

Read-only PostgreSQL verification confirmed the correct shop, supplier ownership, item foreign key, date, notes, currency, quantity, unit price and total. There is exactly one record for this PO number. No physical receipt, Shopify stock adjustment or accounting export was performed.

## Tests performed

| Test | Result | Evidence / limits |
|---|---|---|
| Launch SmartBill in the installed store from Shopify Admin | PASS | Correct CreatorsStore254 Admin URL and app document HTTP 200; repeated after reconnect. |
| Open merchant PO form | PASS | Usable form, app route responses HTTP 200. |
| Create valid single-item PO with decimal quantity and price | PASS | Submission HTTP 200, success banner, new PO link. |
| Save → reopen → verify entered values | PASS | Supplier, date, notes, item, quantity, price and total visible in PO detail. |
| Refresh saved PO embedded route | PASS | Same store and PO, document HTTP 200, zero uncaught exceptions during this check. |
| Database persistence / ownership / duplicate count | PASS | Read-only Prisma/PostgreSQL verification; one PO and its expected item. |
| Missing supplier validation | PASS | HTTP 200 application failure response, “Enter a vendor name” beside the field, `aria-invalid=true`, usable enabled form. |
| Rejected submission does not persist a PO | PASS | Database count for MCP-RESTART-INVALID-20261009 is zero. |
| Direct nonexistent PO route | PASS | HTTP 200 app UI: “Purchase order not found”. |
| Recovery from nonexistent PO | PASS | “Back to purchase orders” opens usable PO form in the same store. |
| Native navigation to the primary app link | PASS | Link retains shop and host; normal redirects end at correct-store embedded app, HTTP 200. No public landing page rendered as the result. |
| Current billing page and store | PASS | Settings document HTTP 200; Starter is current plan in CreatorsStore254. |
| Hosted billing approval return | PREVIOUS LIVE PASS | Completed in the 8 October review; no new charge requested in this run. |
| Renewed charge approval after actual uninstall/reinstall | NOT VERIFIED | Requires a disposable development store or explicit authorization for the existing store's destructive uninstall. |
| Extension-mode invoice file attachment | BLOCKED | Standard Playwright upload returns `DOM.setFileInputFiles: Not allowed`, including after restart. |
| Separate browser file-attachment capability | PASS — CAPABILITY ONLY | Playwright MCP attached PDF-01.pdf to a diagnostic file input. This did not upload an invoice to SmartBill or run OCR. |
| Live PDF/JPG/PNG/multipage and OCR failure matrix | PENDING | Separate browser awaits normal Shopify merchant sign-in. No OCR success claimed. |
| Xero export | NOT VERIFIED | Existing company has not been established as a Xero Demo Company; no working test MCP connection verified. |
| QuickBooks export | NOT CONFIGURED FOR TESTING | Merchant settings show Not connected (sandbox); no working sandbox MCP connection verified. |
| App exceptions and unexpected HTTP failures | PASS — TESTED SCOPE | No uncaught app exceptions or unexpected app 4xx/5xx in the completed checks. This is not an all-workflows audit. |

## MCP evidence

| MCP | Use in this run |
|---|---|
| Playwright MCP | Official server reconnected through configured extension mode; actual authenticated merchant interaction, PO submission response, navigation, refresh and recovery checks. A second official connection to an isolated browser verified ordinary file attachment. |
| Chrome DevTools MCP | Auto-connect to existing Chrome failed because no supported DevToolsActivePort was available. A separate diagnostic Chrome was opened, then the official MCP reconnected to that owned browser using its local debugging endpoint. Page inspection confirms it is at Shopify sign-in. It has not inspected an authenticated SmartBill workflow in this run. |
| Shopify Dev MCP | Official server restarted; searched current App Store review, merchant error presentation and Billing API approval/return documentation. |
| Database / Supabase MCP | Unavailable in this session. Persistence was checked with read-only Prisma queries against the application's PostgreSQL database. No database MCP use claimed. |
| Xero MCP | No working test connection verified; no accounting changes made. |
| QuickBooks MCP | No working sandbox connection verified; no accounting changes made. |

Current requirements were also checked directly in [Shopify's App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements): usable UI across launch methods (2.1.3) and acceptance, decline and renewed charge approval after reinstall (1.2.2). Shopify Dev MCP's [manual pricing documentation](https://shopify.dev/docs/apps/launch/billing/manual-pricing) describes the hosted confirmation and configured return URL.

## Network and connection issues

No unexpected application 4xx/5xx was found in the completed merchant checks. Missing-supplier validation was represented as a safe application response with HTTP 200. Missing-record navigation rendered app recovery UI with HTTP 200. Normal navigation redirects completed successfully; cached icon responses of HTTP 304 were expected.

Shopify Admin still logs a failed developer-preview WebSocket for a stale `trycloudflare.com` endpoint, plus Admin warnings about ShopifyQL Direct API Access and deprecated initialization parameters. These originate in Shopify Admin; the monitored app checks produced no uncaught app exceptions. The complete Admin console is not being labelled error-free.

Browser file attachment is still denied through the extension connection. Repeated pending file choosers were cancelled using the normal MCP cancellation action. No denied upload method was bypassed. The separate browser accepts files normally, but has no authenticated merchant session yet.

The initial separate Chrome DevTools connection later attempted to relaunch an already running profile. Reconnecting the official MCP to that owned diagnostic browser's local endpoint restored page inspection. This was a test-tool connection issue, not an app HTTP failure.

## Files changed

- `SHOPIFY_MCP_RESTART_VERIFICATION_2026-10-09.md`: this follow-up report.
- `SHOPIFY_LIVE_MCP_VERIFICATION_2026-10-08.md`: pointer to this follow-up.
- Ignored `.cache/mcp-live-client.mjs`: restart/reconnect options for official local MCP servers and separate diagnostic browser.
- Ignored `.cache/verify-restarted-po-20261009.mjs`: read-only assertions for the new PO and rejected submission.
- Ignored `.cache/check-ocr-handoff-20261009.mjs` and generated JSON/session logs: scoped read-only OCR handoff checks and diagnostic evidence.

Application source was not modified or redeployed during this follow-up.

## Remaining verification and conclusion

Follow-up at 10:07–10:16 UTC: the merchant reported that Choose File appeared disabled. The actual invoice input was enabled. The MCP file-chooser listener was intercepting clicks instead of presenting the normal native picker; 46 pending chooser events were recorded at one measurement. Pending prompts were cancelled with the standard MCP tool. The listener was then temporarily removed through Playwright's public event API while retaining network and console monitoring, and Choose File was activated for manual selection. Automated file attachment remains restricted; no file was injected and no denied DOM upload command was bypassed. Manual selection and actual OCR processing remain unverified until a filename appears. A read-only database check at 10:07 UTC found no OCR job or invoice created today in CreatorsStore254.

Sign in normally to CreatorsStore254 in the separate “Log in — Shopify” Chrome window to enable the live OCR tests. The supplied document's local path is still pending; prepared synthetic invoice fixtures can cover the format and failure matrix once authenticated. The old extension connection should not be used for file attachment.

Actual reinstall/renewed billing approval, the remaining broad live test matrix, and verified Xero Demo / QuickBooks Sandbox export tests are still outstanding. The completed PO and store-context checks support the reported fixes, but do not establish complete compliance across untested workflows.

**NOT READY FOR SHOPIFY RETEST**
