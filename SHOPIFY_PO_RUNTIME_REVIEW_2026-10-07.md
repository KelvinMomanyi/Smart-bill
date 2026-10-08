# SmartBill: Shopify requirement 2.1.3 runtime review

Reviewed 7 October 2026. Local remediation and verification are complete within the access available in this session. **The exact installed-app rejection has not been reproduced or cleared. No production deployment was performed.**

## Root cause

**The precise cause of Shopify's original valid-submission HTTP 400 remains unconfirmed.** The reviewer’s submitted payload, production logs and authenticated merchant browser session were unavailable. The workspace already contained an uncommitted PO fix when this review began; it would be inaccurate to claim that this session reproduced the original failure against production.

The earlier implementation, inspected through Git, submitted items exclusively in a hidden `structuredItems` JSON value. Visible item controls had no form names. Before hydration, the hidden value remained `[]` even when a merchant filled the visible controls. With no pasted rows, the server received no items, threw `Add at least one PO item`, and returned HTTP 400. The existing [PO fix report](PO_REVIEW_FIX.md) records a replay of that condition. This is a concrete serialization defect and a plausible rejection path, **not proof of the reviewer's exact request**. The previous form could also silently discard some pasted rows, and broad action catches returned 400 for validation, billing and database failures.

The existing fix submits named controls directly and shares item parsing between browser and server. This session verified that implementation in real local browsers, added idempotent submission, and repaired related merchant error paths. A direct production PO URL redirected through `/auth/login` to the landing page because this browser had no merchant session. Launching the configured development store, `creatorsstore254.myshopify.com`, reached Shopify account selection, which returned **HTTP 503**. Neither observation establishes a PO backend failure.

## Fix and full request trace

The merchant submits a Remix form to `POST /app/reconciliation`, using `application/x-www-form-urlencoded`. Authentication and the administrator role check run first. The server parses the named controls, validates the input, checks the actual Shopify subscription, and saves the vendor, settings and PO with nested items in a single PostgreSQL transaction. It returns a success message and a link to the saved PO. Validation and save failures retain entered values. No Xero, QuickBooks or OCR operation is part of PO creation.

| Submitted field | Server handling |
| --- | --- |
| `intent` | Must equal `create-po`. |
| `submissionId` | Optional for legacy clients; UUID v4 for the UI. Used as the existing PO primary key to make retries idempotent. Reads and replay recovery are shop-scoped. No schema migration is needed. |
| `vendorName` | Trimmed, required, maximum 200 characters. Vendor lookup/upsert is scoped to the authenticated shop. The UI does not submit a vendor ID. |
| `poNumber` | Trimmed, optional, maximum 100 characters. Existing per-shop uniqueness remains enforced; duplicates produce a field error. |
| `expectedDate` | Optional valid calendar date in `YYYY-MM-DD`, stored at UTC midnight. Impossible dates are rejected. |
| `notes` | Trimmed, optional, maximum 2,000 characters. |
| Repeated `itemSku`, `itemName`, `itemQuantity`, `itemRate` | Read directly from named controls in order. Name required for a populated row; names limited to 500 characters and SKUs to 200. Quantity positive and no more than 1 billion. Unit cost optional, zero allowed, negatives and values above 1 billion rejected. At most 200 rows. |
| `itemRows` | Optional spreadsheet, CSV or pipe rows; the same parser supports browser import and server submission. |
| Legacy `structuredItems` | Supported when named item controls are absent. Malformed JSON produces operational validation. |
| Shop, session, currency and total | Shop/session come from authentication; currency from shop settings; total is calculated and rounded on the server. These are not trusted frontend inputs. |

Manual POs currently have no tax-entry fields or tax breakdown. Taxed invoice review and accounting bills are separate features. No new taxed-PO feature was added.

Additional remediation:

- Added a synchronous submit guard and persistent submission identity, including for blank PO numbers and uncertain-response retries.
- Added saved vendor, date, notes, currency, quantities, prices and total to the PO receiving screen so merchants can reopen and verify their order.
- Nonexistent, deleted or other-shop PO IDs return a `Purchase order not found` UI with a purchase-order navigation link.
- Added safe app/root error boundaries and explicit unknown-page routes. Browser testing found React hydration errors on unmatched URLs with lazy route discovery; explicit fallback routes and a shared document layout resolved them.
- Invalid accounting authorization, callback and confirmation links have reconnect guidance. Shopify's thrown authentication responses and required boundary headers remain preserved.
- Accounting messages no longer copy remote fault bodies or append HTTP status codes. The internal status and rejected/uncertain classification remain intact, preserving duplicate-export safeguards.
- Shared merchant error filtering covers invoice capture/review, receipts, credit notes, settings, persisted processing/export failures and downloads. OCR network failures have retry/manual-entry guidance; malformed responses and request timeouts are handled.
- CSV downloads no longer display raw response bodies or fetch errors.

## MCP evidence and access limitations

| MCP/tool | Actual use and limitation |
| --- | --- |
| Playwright MCP | Attempted browser discovery and code execution, then retried discovery. All failed because its Chrome extension was missing. **No successful Playwright MCP UI verification is claimed.** |
| Local Playwright library | Used the production bundle in installed Edge with isolated persistence, stubbed Shopify responses and a synthetic session. 25 UI checks passed, with JavaScript enabled and disabled. This is real browser interaction, but it is not an installed Shopify Admin session. |
| Chrome DevTools MCP | Used for Shopify Admin launch, deployed/local landing pages, PO form entry/submission, request and response inspection, success/reopen states, console diagnostics, and before/after error-page checks. PO interaction used an isolated local fixture; accounting-confirmation checks also used the normally started local app. |
| Shopify Dev MCP | Not exposed in this session. Current official Shopify documentation was checked through web browsing instead; this is not MCP verification. |
| Database/Supabase MCP | Not connected. Supabase was found as an available connection, but no connection was confirmed. Database checks used Prisma/PostgreSQL directly, not a database MCP. |
| Xero MCP | Unavailable. No Xero API calls or accounting writes were made. Demo Company identity was not verified. |
| QuickBooks MCP | Unavailable. No QuickBooks API calls or accounting writes were made. Sandbox access was not verified. |

Chrome DevTools observed a valid submission with these **actual serialized values**: vendor `MCP Review Supplies`; PO number `MCP-REVIEW-20261007`; date blank (optional); SKU `PAPER-01`; item `Printer paper`; quantity `12.5`; unit cost `12.50`; pasted rows blank; notes `Review delivery — door 2`. Response: HTTP 200, `{"success":true,"message":"Purchase order created","purchaseOrderId":"6427909d-d2fa-44af-ad03-883bd19125be","purchaseOrderNumber":"MCP-REVIEW-20261007"}`. The success link opened the order with a USD 156.25 total and the saved notes/items. The browser tool had been asked to fill quantity 2.5 and a date, but actually serialized 12.5 and a blank date; this report records the observed request, not the intended tool input. Local Playwright separately verified exact fractional quantities and dates.

## Tests performed

**PASS below applies only to the environment stated. BLOCKED means no valid end-to-end result was obtained; it is not a pass.**

| Test | Result | Evidence / limit |
| --- | --- | --- |
| Open installed app from Shopify Admin | BLOCKED | No merchant session; Shopify account selection returned 503. |
| Deployed landing page | PASS | Chrome DevTools loaded the merchant landing UI. |
| Create valid single-item PO | PASS locally | JavaScript and native HTML; success message, list and reopen. Installed workflow remains blocked. |
| Multiple-item PO | PASS locally | Spreadsheet import; both lines preserved, including a zero-price item. |
| Decimal quantity/price | PASS locally | 2.5 × 12.50 = 31.25; 3.125 × 9.99 = 31.22. |
| Non-taxed PO | PASS locally | Manual PO model has no tax input. |
| Taxed manual PO | NOT SUPPORTED | No tax fields in this workflow. Taxed accounting bills passed mocked service regressions. |
| Different supplier/date/notes | PASS locally | `Second supplier & Co`, 2027-02-28, Unicode/reference notes; reopened values checked. |
| Large reasonable values | PASS locally | Quantity 1,000,000; cost 99,999.99; 2,000-character notes; date 2026-12-31. |
| Optional number/date/SKU/cost | PASS locally | Blank optional fields accepted; missing cost persisted as null. |
| Duplicate numbers | PASS locally | Field guidance; existing order preserved. |
| Double-click / repeat blank-number form | PASS locally | One saved record; service replay returns the original ID. |
| Save failure and retry | PASS locally | Injected database failure, entries preserved, retry succeeds. |
| Missing subscription | PASS locally | Settings recovery link, no database write or access bypass. |
| Refresh / direct PO list and existing PO | PASS locally | Direct URLs and document reloads remain usable. |
| Back / forward | PASS locally | List and receiving UI remain usable. |
| Missing/deleted/invalid PO ID | PASS locally | HTTP 200 operational not-found UI and working navigation. |
| Unknown app/public page | PASS locally | Explicit recovery UI; no framework text or hydration exception. Unknown routes retain controlled 404 status. |
| Accounting links with invalid/missing session data | PASS locally | All four routes show reconnect guidance; controlled 400 statuses. |
| Responsive layout | PASS locally | 360, 768 and 1440 px; visible submit and no document overflow. |
| Full invoice upload → OCR → review/edit → PO association/save | BLOCKED | Authenticated merchant UI unavailable. |
| Real local image/PDF OCR engine | PASS | Generated PNG and PDF; extraction/parsing succeeded. Private storage round trip was explicitly skipped. |
| Xero export | BLOCKED | Mocked service regressions pass; no verified Demo Company or Xero MCP. |
| QuickBooks export | BLOCKED | Mocked service regressions pass; no verified Sandbox credentials/session or QuickBooks MCP. |
| PostgreSQL persistence | PASS, rolled back | All nine successful browser payloads replayed against the configured schema, including multi-item/native submissions. Fields, totals, currency, ownership, replay and cleanup checked. No committed browser-created merchant record was verified. |
| Browser console | PASS locally | Zero uncaught exceptions in the final 25-check run. Controlled document error statuses produce normal browser resource diagnostics. |
| Unexpected failed network requests | PASS locally | None in the final browser run. Deliberate JavaScript-disabled script blocks are classified separately. |
| Regression suite | PASS | 162/162. Includes OCR parsing/control and mocked Xero/QuickBooks workflow cases. |
| TypeScript / lint / production build | PASS | Lint has only the existing Remix configuration deprecation notice; build has existing chunk/import notices. |

### Validation coverage

| Condition | Result / level |
| --- | --- |
| Missing or whitespace-only supplier | PASS: browser guidance, values preserved, no write. |
| Missing PO number/date | PASS: both are optional, including native HTML. |
| Invalid/impossible date | PASS: server regression rejects 2026-02-30. Browser date control limits entry. |
| No line items | PASS: browser guidance, no write. |
| Zero/negative quantity | PASS: browser native validation; server regression checks. |
| Zero price | PASS: saved as zero, not null. |
| Negative price | PASS: browser native validation and server regression. |
| Malformed/extreme amounts | PASS: parser/server regression; excessive browser quantity blocked. |
| Extremely long text | PASS: browser limits; server tests for oversized notes, item names and SKUs. |
| Duplicate submission/double click | PASS locally: UI guard and shop-scoped submission replay. |
| Incomplete additional row | PASS: server regression reports line-specific guidance. |
| Unicode and punctuation | PASS locally: ampersand, Unicode reference and em dash accepted and reopened. No ASCII-only restriction was introduced. |
| Expired/restarted Shopify merchant session | BLOCKED in real browser: SDK responses preserved by tests; actual reauthentication still needs verification. |

### Launch/navigation coverage still required

The installed Admin Apps launch, primary embedded URL, Admin navigation away/back, owner/staff sessions, expiry/restart, third-party-cookie restrictions and final production PO submit remain unverified. Local list/create share `/app/reconciliation`; details/receiving use `/app/receipts/:id`. Local direct links, refresh, back/forward and missing-record recovery passed. They do not establish embedded production behavior.

### OCR and accounting coverage still required

The requested merchant UI matrix for PDF, JPG, PNG, multipage PDF, poor/rotated scan, missing/incorrect OCR field, manual correction, OCR timeout/failure, retry and manual entry was not completed. Unit tests cover worker rotation, multipage processing, poor-result fallback, cleanup, interrupted saves, duplicates and ownership; the real-engine smoke check covers PNG/PDF. These are supplemental evidence, not UI passes.

Live Xero and QuickBooks success and failure matrices remain unverified, including provider records, contact/vendor, references, dates, due dates, lines, tax, totals, currency, disconnection, expiry, duplicate export and outages. PO creation calls neither provider. Existing export approval, idempotency and uncertain-outcome safeguards passed mocked regressions.

The configured database contained 11 invoices and zero POs before the rolled-back checks. It contained five Xero connections labeled `production` and three QuickBooks connections labeled `sandbox`. Xero client credentials are set. Local `QB_ENVIRONMENT` is `production`, and no dedicated sandbox credential pair is set. These metadata do not prove any connection is usable or identify a Xero Demo Company. They were not changed, and no accounting export was attempted.

## Network issues found

| Issue | Resolution / status |
| --- | --- |
| Shopify account selection GET → 503 | External access blocker; unresolved. No authenticated installed-app PO request was captured. |
| Normal local `/accounting/confirm` without authorization → 400 framework page | Fixed locally: reconnect UI with navigation. The controlled 400 status remains. |
| Other three invalid accounting links → 400 | Verified safe reconnect UI; controlled status remains. |
| Missing PO route threw 404 | Fixed: shop-scoped operational not-found page returns 200. |
| Unknown URL → framework fallback / React #418 and #423 during hydration | Fixed locally with shared document layout and explicit fallback routes. Controlled 404 now renders usable UI with no uncaught exception. |
| `/favicon.ico` → 404 in the initial isolated test server | Test-fixture defect fixed by serving the actual static icon. Not attributed to production. |
| Local startup TLS failure / connection refused | Sandbox environment issue. Normal app started successfully outside the sandbox; no database security setting was weakened. |
| Script/module requests blocked as `csp` with JavaScript disabled | Expected test control: 123 requests in the deliberate native-HTML context. Kept separate from unexpected failures; app CSP was not weakened. |

No unexpected 4xx/5xx was observed in the final local PO browser matrix. This statement does not cover untested authenticated production workflows.

## Files changed

The following files were added or modified during this session. Several PO files already had uncommitted changes; those changes were preserved and extended.

| File | Purpose |
| --- | --- |
| `.eslintignore` | Exclude locally generated Shopify declaration files from source lint. |
| `app/__tests__/run.ts` | Register merchant-error regressions. |
| `app/__tests__/purchaseOrderWorkflow.test.ts` | Add submission replay/length tests and preserve shop-scoped mock records. |
| `app/__tests__/merchantErrors.test.ts` | Verify sensitive error filtering and provider retry classification. |
| `app/components/AppErrorState.tsx` | Shared recovery UI and Shopify-aware accounting boundary. |
| `app/components/InvoiceOcr.tsx` | Handle network timeouts, malformed responses and safe OCR errors. |
| `app/components/CsvDownloadButton.tsx` | Translate fetch failures; never toast raw server bodies. |
| `app/root.tsx` | Shared document Layout and safe root boundary. |
| `app/routes/$.tsx` | Public unknown-page recovery route. |
| `app/routes/app.$.tsx` | Authenticated unknown-page recovery route. |
| `app/routes/app.tsx` | Friendly app errors while retaining Shopify's redirect protocol and headers. |
| `app/routes/app.reconciliation.tsx` | Submission identity, synchronous submit guard and aligned item limits. |
| `app/routes/app.receipts.$id.tsx` | Operational missing-PO UI, saved details and safe errors. |
| `app/routes/app._index.tsx` | Safe capture and persisted OCR/job messages. |
| `app/routes/app.invoices.$id.tsx` | Safe action/document/history messages. |
| `app/routes/app.invoices.$id_.accounting.tsx` | Safe accounting catalog/mapping errors. |
| `app/routes/app.credit-notes.tsx` | Safe capture/action messages. |
| `app/routes/app.credit-notes.$id.tsx` | Safe detail/action messages. |
| `app/routes/app.settings.tsx` | Safe settings, connection and notification history messages. |
| `app/routes/accounting.authorize.tsx` | Preserve authentication responses/headers; safe connection boundary. |
| `app/routes/accounting.confirm.tsx` | Safe confirmation errors and recovery boundary. |
| `app/routes/accounting.xero.callback.tsx` | Safe callback response and recovery boundary. |
| `app/routes/accounting.quickbooks.callback.tsx` | Safe callback response and recovery boundary. |
| `app/routes/api.jobs.ts` | Safe processing/retry response messages. |
| `app/routes/api.upload-invoice.ts` | Safe upload response messages. |
| `app/routes/api.saveInvoice.ts` | Safe save response messages. |
| `app/services/purchaseOrders.server.ts` | Transactional submission replay using existing PO primary key. |
| `app/services/invoiceJobs.server.ts` | Persist safe processing/save failures. |
| `app/services/accountingExport.server.ts` | Persist safe export/history/notification failures. |
| `app/services/accountingAttachment.server.ts` | Persist safe attachment failures. |
| `app/utils/merchantErrors.ts` | Shared filtering for legacy business errors versus technical details. |
| `app/utils/accountingHttp.server.ts` | Translate provider errors without remote fault text or HTTP codes. |
| `app/utils/poItems.ts` | Enforce consistent item text limits for controls and pasted rows. |
| `app/utils/purchaseOrderForm.ts` | Include submission-key validation in typed form errors. |
| `scripts/check-po-workflow.mjs` | Expand to 25 browser checks; capture requests/responses/state; support isolated DevTools inspection. |
| `scripts/verify-po-review-database.ts` | Replay successful browser payloads against PostgreSQL with explicit rollback. |
| `PO_REVIEW_FIX.md` | Update local verification counts and link this review. |
| `SHOPIFY_PO_RUNTIME_REVIEW_2026-10-07.md` | This report. |

`README.md`, `package.json`, `package-lock.json` and `app/utils/poItems.server.ts` were already modified at arrival and were not functionally changed by this session. Existing changes outside the review were not reset. Generated build output and local evidence are separate from source edits.

## Evidence artifacts and reproducibility

- [Browser requests, full response bodies, isolated records and final checks](.cache/po-review-browser-evidence.json): 18 submissions, nine saved test POs, 25 checks, no uncaught exceptions or unexpected network failures.
- [PostgreSQL audit and rollback evidence](.cache/po-review-database-evidence.json): nine browser payloads verified; zero committed test records.
- [JavaScript recovery screenshot](.cache/po-workflow-js.png) and [native HTML screenshot](.cache/po-workflow-native.png).

Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build:check`, then `npm run check:po`. To repeat the database check after the browser check:

```powershell
node --env-file=.env node_modules/vite-node/vite-node.mjs --config vite.tasks.config.ts scripts/verify-po-review-database.ts
```

The local production server was restarted and left running at `http://localhost:3000`. Its public fallback was checked through Chrome DevTools after rebuilding. Nothing was deployed to `https://smart-bill-self-five.vercel.app`.

## Shopify requirement conclusion and remaining work

Shopify's current [requirement 2.1.3](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements#have-a-user-interface-ui-that-merchants-can-interact-with) requires an operational merchant UI through all launch methods. The [Shopify Remix documentation](https://shopify.dev/docs/api/shopify-app-remix/latest) requires preserving SDK authentication/boundary behavior. The document recovery layout follows [Remix's root Layout guidance](https://v2.remix.run/docs/file-conventions/root/). This review used those official sources, not Shopify Dev MCP.

Local evidence supports the implementation fixes. It does not establish production compliance. Before resubmission, restore an authenticated test-store browser and Playwright MCP, confirm the deployed revision, repeat the exact Shopify Admin → PO → valid submit → reopen workflow, verify its committed shop-scoped record and browser/network output, and complete the OCR and sandbox accounting matrices. The required MCP connections and provider test-company identities also need verification.

**NOT READY FOR SHOPIFY RETEST**
