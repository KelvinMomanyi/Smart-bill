# Repeatable invoice OCR accuracy testing

Upload different invoices whenever convenient in the installed Shopify app. Tell Codex **"uploaded, check OCR"** after capture. No fixed upload schedule or automatic monitoring is configured. Each live test needs an active MCP browser connection; reconnect and arm a new session after a browser restart.

For the cleanest measurement, leave extracted fields unchanged until the initial comparison is recorded. Corrections remain available afterward. A merchant correction must not be counted as correct original extraction. Different suppliers and layouts matter more than repeatedly uploading the same template. Exact repeat documents should exercise duplicate handling rather than create duplicate accounting records.

## Per-upload live procedure

1. Launch SmartBill from the correct Shopify Admin store. Arm diagnostics through Playwright MCP `browser_run_code_unsafe` with `filename: "smart-bill/scripts/ocr-accuracy/arm-live-session.txt"` when the MCP workspace root is SMARTBILL. Adjust the relative path if its root is smart-bill instead. This restores the native manual picker and monitors app responses, failures and exceptions. It does not upload files. Do not re-arm until existing evidence is exported, because re-arming starts a new observation window.
2. Merchant selects a PDF/image using Choose File and captures it. Record filename, format, page count, upload/completion responses, processing/loading state, and review link. Poll the existing audit through MCP; do not repeat submission when processing is still active.
3. Read the original invoice independently, including every page. Record ground truth for supplier, exact invoice/reference identifier, date, due date, currency, subtotal, tax, total, and every line's description, SKU, quantity, unit price and amount. Unknown or unreadable values stay **UNVERIFIED**; never use the extracted result itself as ground truth. Confirm ambiguous date formats and currencies with the merchant. Ignore OCR confidence when deciding whether a field matches.
4. Open the merchant review UI **before editing**, compare each field and all line counts with the document, capture the initial UI values and any review warnings. Missing fields must be flagged rather than credited when an assumed default happens to equal a value. Export the audit to an ignored local evidence file; exclude listeners/functions and any private URLs/tokens.
5. Capture the database snapshot below with the exact shop and new invoice ID. It reads only that tenant's invoice; it does not approve, export, receive inventory, alter product costs or modify data. Revision 0 is the clean initial snapshot. Store the original UI evidence separately alongside this snapshot.
6. Run the comparison against a new ground-truth case. Record **initial UI**, **stored values**, **current parser replay**, and **usability** separately. A parser replay is not a new live OCR recognition run. PASS requires all expected fields and line counts to match; a high field percentage cannot override one incorrect invoice number, currency, amount or missing row.
7. After recording initial accuracy, correct any errors through the UI, save, reopen and refresh, then verify database persistence again. Log corrections separately. Add a sanitized version of the actual failing transcript and independently established expected values to `cases.json`, fix the narrow cause, and rerun the corpus and full suite. Keep real commercial invoices and OCR text in ignored `.cache/ocr-accuracy`; commit only public/synthetic or explicitly approved sanitized fixtures.

## Commands

```powershell
npm run test:ocr-accuracy
npm test
node --env-file=.env scripts/capture-ocr-evidence.mjs --shop creatorsstore254.myshopify.com --invoice INVOICE_ID
npm run test:ocr-accuracy -- --case CASE_ID --evidence .cache/ocr-accuracy/evidence/SNAPSHOT.json
npm run test:ocr-accuracy -- --case CASE_ID --evidence .cache/ocr-accuracy/evidence/INITIAL.json --ui-evidence .cache/ocr-accuracy/live/INITIAL-UI.json
```

The default eight-case corpus covers the supplied freelance sample, taxed SKU rows, European currency formatting, wrapped descriptions, multipage continuation, fractional Kenyan quantities, configured US dates, and the actual quantity-first East Repair PNG. These are **parser regression cases**, not eight live document uploads. Unit checks also ensure that the comparison detects dropped/extra/duplicated rows, one-cent differences, wrong identifiers, swapped numeric columns and rounded unit prices.

The capture command prints only its output path and safe record metadata. It deliberately excludes private document URLs, storage keys, database errors and authentication fields. Stored raw OCR text may contain commercial details; keep the ignored evidence local. Each capture and comparison writes a timestamped, unique file without overwriting earlier runs. The report identifies the checkout commit, hashes the actual parser source, and labels reviewed snapshots. `initialLiveUiAccuracy: UNVERIFIED` is deliberate when initial MCP UI evidence is absent or the snapshot is already reviewed: database reads and parser execution cannot prove the original browser workflow. `--ui-evidence` accepts a recorded `live-ui-observation` for the same shop, invoice and revision, checks its field values and successful upload/completion responses, and reports PASS/FAIL for a revision-0 capture. This evidence must come from actual MCP observations, never manufactured success flags. The PNG's initial UI evidence is a working FAIL example in the ignored evidence directory.

Ground-truth case format is demonstrated in `cases.json`. Every expected header and line field is required; use explicit null when the original genuinely has no value. Currency and identifiers compare exactly after whitespace/Unicode normalization; case differences are not silently ignored. Quantities and unit prices allow only floating-point tolerance of 0.000001. Amounts must differ by less than half a cent. All duplicate lines are counted. Parser/UI comparisons preserve row order; database comparisons allow row order differences because InvoiceItem has no position column.

## Live acceptance ledger

Use `OCR_ACCURACY_LIVE_LOG.md` for human-reviewed results over time. Keep one row per genuine upload/test and cite private evidence filenames, without committing customer documents or signed URLs. Log FAIL immediately, including the specific mismatch, then append the post-fix retry result; do not overwrite the initial failure.

Required variety before a broad reliability claim: independent suppliers/layouts, text PDF, scanned PDF, JPG/PNG, multipage documents, rotation, low resolution/blur, decimal quantities and rates, multiple currencies, taxed/untaxed invoices, missing fields, manually corrected fields, OCR timeout/failure, retry, duplicate upload, save/reopen/refresh. A readable fixture that passes does not prove unreadable documents will extract perfectly. Unreadable results must keep a usable manual-review path.

No files need to be selected simultaneously: upload one invoice now, another later, and keep appending evidence. A failure in any critical field remains a failure regardless of recognition confidence or earlier passing invoices.
