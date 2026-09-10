# SmartBill: Product, Business Value and Earning Potential

**Prepared:** 9 September 2026  
**Purpose:** Explain the app, assess its commercial opportunity, and identify the work needed to build a sustainable business.  
**Currency:** Financial examples use USD unless another currency is explicitly stated.

This report draws on the current SmartBill source code, the implementation and database checks completed in this project, and current official product listings and platform documentation. Feature descriptions refer to implemented code; externally connected features still depend on configuration and live testing. Revenue and cost scenarios are assumptions for planning, not observed sales or forecasts.

## 1. Overall assessment

SmartBill is a Shopify app for managing **supplier invoices and purchase costs**. It turns incoming invoice documents into records that a merchant can review, compare with purchase orders and deliveries, use to update Shopify product costs, and send to accounting.

Its most useful promise is:

> Help Shopify merchants check supplier bills and keep product costs accurate, with review before financial updates.

A retailer may order stock at one price, receive only part of the shipment, and then receive an invoice for a different quantity or price. SmartBill brings those records together so the team can investigate the difference before approving the invoice.

The app has a credible niche among smaller inventory businesses that have outgrown spreadsheets but do not need a complete enterprise purchasing system. Its commercial success will depend on accurate extraction, low effort per invoice, dependable integrations, and repeat use.

The current $19 and $49 plans are accessible entry prices, but SmartBill is **not the lowest-priced supplier-invoice app** in the market. Its price must be justified by the combined review, reconciliation, cost-history and accounting workflow. The competitive comparison in Section 7 explains this finding.

At an assumed average subscription value of $28 per store per 30-day cycle:

- 50 paying stores produce $1,400 in gross recurring revenue per cycle.
- 100 paying stores produce $2,800.
- 500 paying stores produce $14,000.

Those are revenue calculations, not take-home income. Provider fees, computing, support, customer acquisition and development can materially reduce the amount available to the owner.

## 2. What problem does the app solve?

Supplier invoices often arrive as PDFs, scanned pages, photographs, or email attachments. Someone must read them, identify the supplier and products, enter the amounts, compare them with expected purchases, and update other systems.

The work becomes difficult when:

- Supplier descriptions differ from Shopify product names.
- A supplier uses its own SKU or packaging unit.
- An invoice arrives before all goods have been delivered.
- Unit prices differ from the purchase order.
- A document is uploaded twice or forwarded by multiple people.
- Tax, discounts and freight make totals harder to reconcile.
- Product costs in Shopify are out of date.
- The same bill must be entered again in accounting software.
- Different staff members capture, receive and approve documents.

SmartBill provides a structured path through these tasks. Its value comes from reducing repeated entry and giving staff a clear record of what was captured, corrected, approved and applied.

Three terms describe the central workflow:

| Record                | What it represents                         | Example               |
| --------------------- | ------------------------------------------ | --------------------- |
| Purchase order, or PO | What the merchant agreed to buy            | 100 units at $10 each |
| Goods receipt         | What staff confirm physically arrived      | 80 units delivered    |
| Supplier invoice      | What the supplier asks the merchant to pay | 100 units at $11 each |

The invoice is evidence of a supplier's bill. It does not, by itself, prove that all the goods arrived or that the agreed price was followed.

## 3. Who would use SmartBill?

### Best initial customers

The strongest initial audience is a Shopify merchant that:

- Holds or purchases physical inventory.
- Receives repeat invoices from several suppliers.
- Processes roughly 20–250 supplier invoices per month.
- Uses spreadsheets, manual Shopify cost entry, or repeated accounting entry.
- Has an owner or operations manager willing to review exceptions.
- Can identify a measurable amount of time spent on the current process.

Possible early customer groups include apparel resellers, beauty and cosmetics retailers, homeware stores, pet-supply retailers, and specialist shops carrying many supplier SKUs. These are proposed customer segments, not validated customer groups for SmartBill.

Importers could also benefit, but the current lack of automated foreign-exchange conversion and landed-cost allocation makes them a more demanding segment. Start with merchants whose invoice and store currencies match and whose unit conventions are straightforward.

### People within a store

| User                               | Main use                                                 | Practical benefit                           |
| ---------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| Store owner                        | Approve invoices and inspect purchasing activity         | More visibility into bills and cost changes |
| Purchasing manager                 | Create POs and investigate price or quantity differences | A consistent review process                 |
| Receiving staff or operations team | Record deliveries                                        | Separate received stock from billed stock   |
| Invoice-entry staff                | Upload, correct and match invoice lines                  | Less repeated typing                        |
| Bookkeeper                         | Review approved records and export bills                 | Better organized accounting inputs          |

Bookkeepers and Shopify agencies could become referral partners. The current app does not provide a central accountant console for operating many client stores; that would be a future feature.

### Weaker fits today

Stores selling only digital goods, businesses receiving very few supplier invoices, and merchants needing only customer invoice printing are unlikely to obtain enough value. Large warehouse operations requiring inventory transfers, manufacturing, replenishment forecasting or complex valuation need capabilities beyond the current product.

## 4. How the app works in practice

Consider a merchant with a PO for 100 bottles at $10 each.

1. **Create the purchase order.** Staff record the supplier, quantities, expected rates and currency in SmartBill.
2. **Record the delivery.** Only 80 bottles arrive, so staff enter a receipt for 80.
3. **Capture the invoice.** The supplier sends a PDF billing 100 bottles at $11 each. Staff upload it or paste its text.
4. **Extract the fields.** The background processor reads the document and creates editable invoice details and lines.
5. **Check differences.** SmartBill identifies the price difference and the fact that 100 units have been billed while only 80 have been received.
6. **Correct and review.** Staff compare the source document with the extracted data, confirm the product variant and investigate the discrepancy.
7. **Approve deliberately.** An approver either resolves the difference or records a reason for accepting the PO exception.
8. **Apply selected updates.** The approver can preview and apply a product cost change or export the approved invoice to accounting.
9. **Retain the history.** The app records activity, cost changes and export outcomes for later review.

In this example, the billed amount is $1,100 compared with the original PO value of $1,000. The $100 difference deserves investigation; it is not automatically a confirmed loss or a guaranteed saving. The incomplete delivery is a separate issue, and the two should not be added together as if both were proven overcharges.

The app does not pay the supplier. The merchant still makes the payment decision in the appropriate payment or accounting system.

## 5. Major implemented features

### 5.1 Invoice capture and extraction

SmartBill accepts supported PDFs and images, and it also allows pasted text. It extracts supplier information, invoice identifiers, dates, currency, tax, totals and line items.

The implemented extraction path uses Tesseract OCR, PDF text/rendering tools and rules-based parsing. The current worker uses English language data. There is no verified basis for advertising universal language support, a guaranteed accuracy percentage, or fully autonomous accounting.

Fractional quantities are preserved, and identical repeated lines are retained. Numeric dates can follow day/month/year or month/day/year settings.

**Business value:** A starting point for review without entering every field from scratch.

### 5.2 Original document beside editable invoice data

The review page displays the stored source document alongside editable metadata and line items. Staff can correct descriptions, SKUs, quantities, net unit prices, amounts, currency and tax, and add a separate freight or charge line.

Saving corrections resets approval. Financial activity locks subsequent editing so that an already applied invoice retains its history.

**Business value:** Extraction errors can be corrected in the same workflow, while the original remains available for comparison.

### 5.3 Mandatory approval and numerical checks

Before cost changes or live accounting exports, the invoice must be approved. Checks cover missing identifiers, invalid amounts, line arithmetic, subtotal consistency and the relationship between net lines, tax and the invoice total.

The approval screen asks the approver to confirm the source details. Unresolved PO differences require an explanation.

**Business value:** Mistakes are more likely to be discovered before they become product-cost or accounting updates. These controls support human review; they do not establish that an invoice is authentic or commercially correct.

### 5.4 Purchase orders and delivery reconciliation

Staff can enter structured PO lines or paste/import line data. The app tracks ordered, billed and physically received quantities separately, including fractional quantities and partial deliveries.

Matching uses supplier SKUs or unambiguous descriptions. Uncertain matches are flagged rather than accepted as reliable matches.

POs and receipts are stored in SmartBill's own database. Automatic import or synchronization of Shopify's native purchase-order records is not implemented.

**Business value:** The team can investigate unexpected products, price differences and quantities billed ahead of receipt.

### 5.5 Product matching and remembered supplier mappings

Staff search Shopify products, choose a variant and explicitly confirm it. Approved supplier-to-product mappings are saved and proposed for later invoices.

A proposed mapping still needs confirmation. A supplier pack of 12 and a Shopify product sold individually require manual quantity and unit-cost normalization today.

**Business value:** Repeat suppliers can become faster to review without relying on a supplier description being identical to the Shopify title.

### 5.6 Product cost preview, update and recovery

Approved lines selected for cost synchronization show the previous and proposed Shopify cost. The app checks that the invoice currency matches the store currency and that the current Shopify cost still agrees with the preview before attempting an update.

Cost history records the result. Restoration and interrupted-request recovery check the current Shopify value before proceeding.

This updates Shopify's product inventory-item cost. It does not calculate FIFO, weighted-average inventory valuation, full landed cost or a complete accounting cost of goods sold figure.

**Business value:** More current product-cost inputs, with a reviewable record of changes.

### 5.7 CSV, Xero and QuickBooks exports

Approved invoices can be exported to CSV. The CSV includes invoice and line data, escapes spreadsheet formula-like supplier text, and avoids repeating invoice totals on every line.

Xero and QuickBooks connection and bill-export code is present. Live exports require working OAuth applications, connected organizations and per-store account mapping.

An export ledger and stable provider request keys reduce duplicate-creation risk. If a response is uncertain, the app blocks another creation attempt and can verify a bill that already exists.

**Current boundaries:** QuickBooks live export supports untaxed bills; taxed bills use the reviewed CSV workflow. Complex mixed line taxes and credit notes are not automated. Some unsuccessful export attempts still require operator investigation.

### 5.8 Background processing and Growth capture tools

File uploads create persisted jobs. The dashboard shows queue status, progress and errors. Failed jobs retry automatically up to the configured limit, and staff can retry them afterward.

Growth includes batches of up to 10 documents and code for an inbound invoice email webhook. Email capture requires a configured receiving domain, mail provider and webhook credentials.

**Business value:** Staff can submit documents without waiting for each OCR operation to finish in the browser. This depends on the worker or scheduler actually running.

### 5.9 Duplicate protection and activity history

Document fingerprints and supplier invoice identities help detect repeated captures. Financial activity and approval events are recorded, and live export attempts are tracked separately.

These checks reduce duplicate processing. They are not fraud detection, and they should not be marketed as protection against every possible duplicate document.

### 5.10 Dashboard, supplier analytics and weekly reports

The app shows capture volume, invoices needing attention, open purchase orders, cost-sync activity, supplier spend and accounting exports. Spend is grouped by currency rather than adding unlike currencies together.

The weekly report includes an optional time-saving estimate based on a value entered by the merchant. Its default is zero until the merchant supplies a measured estimate.

The report is an in-app report; an automatically emailed weekly digest is not currently implemented.

### 5.11 Staff access and private document handling

Store owners can manage staff access. Capture staff and approvers have different permissions, and protected actions verify access on the server.

Source documents use private storage references and authenticated retrieval. Compliance webhook handlers and shop-data cleanup code are implemented.

These are useful controls, but they do not establish a security certification. Production storage permissions, credentials, backup retention, deletion behavior and provider authorization flows still need operational review and live testing.

## 6. Why the app is useful and important

### Less repetitive work

Typing an invoice into a spreadsheet, entering the same values in accounting and separately changing Shopify costs creates repeated effort. SmartBill can reduce that repetition if its extraction and review process is faster than the merchant's existing method.

### Better purchasing discipline

Comparing invoice, order and receipt information gives staff a reason to investigate a difference before accepting it. It also creates a clearer handover between purchasing, receiving and bookkeeping.

### More useful product-cost information

Accurate supplier unit costs can support pricing and margin decisions. A simple supplier-cost update does not capture all expenses, so the merchant still needs an appropriate policy for freight, duties, discounts, taxes and inventory valuation.

### A clearer history

Knowing who approved a bill, which cost was changed, and whether an accounting provider confirmed an export makes later investigation easier. This can be valuable when a bookkeeper or new employee takes over a task.

### An illustrative return on the subscription

Assume a merchant saves **five minutes per invoice** and values staff time at **$15 per hour**. These are hypothetical inputs, not measured SmartBill results.

| Example          | Invoices processed | Time released | Value of that time | Subscription | Time value less subscription |
| ---------------- | -----------------: | ------------: | -----------------: | -----------: | ---------------------------: |
| Starter merchant |                 50 |    4.17 hours |             $62.50 |          $19 |                       $43.50 |
| Growth merchant  |                200 |   16.67 hours |            $250.00 |          $49 |                      $201.00 |

At those assumptions, time value covers the subscription after approximately **16 invoices for Starter** or **40 invoices for Growth**. Actual results depend on document quality, review time and the previous process.

Released staff time is not necessarily a reduction in wages. It may instead let the same team spend more time on other work.

## 7. Market context and competing products

Prices below were checked on 9 September 2026. These products have different scopes and volume definitions, so this is a positioning comparison rather than a feature-for-feature ranking.

| Product              | Published entry pricing                                        | Relevant focus                                                                          | Implication for SmartBill                                                    |
| -------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| SmartBill            | $19 per 30 days for 50 invoices; $49 for 250                   | Invoice review, PO/receipt checks, selected product-cost updates and accounting exports | Must show the benefit of the combined process                                |
| Salor Invoice        | Free allowance; $9/month for 200 invoices; $29/month for 1,000 | Supplier invoice extraction, reviewed cost/quantity updates and saved matches           | Direct price pressure on basic capture and cost updates                      |
| Auto Purchase Orders | From $39.99/month, including 100 POs on its entry plan         | PO automation, suppliers and inventory receiving                                        | An adjacent, broader purchasing alternative                                  |
| Inventaly            | From $89/month                                                 | Procurement, invoice extraction, receiving and landed-cost tracking                     | A higher-priced alternative with capabilities SmartBill does not yet provide |

Sources for the competing products: [Salor Invoice listing](https://apps.shopify.com/salor-invoice), [Auto Purchase Orders listing](https://apps.shopify.com/auto-purchase-orders), and [Inventaly listing](https://apps.shopify.com/inventaly). Listings describe the vendors' offerings; their accuracy and performance were not independently tested.

SmartBill's prices are lower than some broader procurement tools, but its invoice allowance is materially less generous than the cheaper direct capture competitor shown above. Being inexpensive in absolute dollars is not the same as offering the lowest cost per invoice.

There is also a native-platform alternative. Shopify now supports purchasing and receiving workflows, and its Stocky transition guidance describes using reports and CSV calculations to reconcile received quantities against vendor invoices. The same guidance states that Stocky stopped being available for inventory operations on 31 August 2026. [Shopify's Stocky transition guide](https://help.shopify.com/en/manual/products/inventory/transitioning-from-stocky).

**Commercial inference:** Merchants reassessing their purchasing process may be open to an invoice-control tool. This does not prove that they will buy SmartBill. Since its POs currently live separately from Shopify's native POs, duplicate setup could be an adoption barrier.

The strongest positioning to test is:

> Review supplier invoices, check purchase and delivery differences, and approve accurate cost and accounting updates inside your Shopify workflow.

A defensible advantage would come from reliable handling of real supplier formats, easy onboarding, useful saved mappings and merchant trust. These have to be demonstrated through customer use; the code alone does not establish a competitive advantage.

## 8. Pricing and packaging assessment

| Plan    |      Recurring charge |                       Allowance | Capture differences                          |
| ------- | --------------------: | ------------------------------: | -------------------------------------------- |
| Starter | $19 USD every 30 days |  50 invoices per calendar month | Individual document capture and pasted text  |
| Growth  | $49 USD every 30 days | 250 invoices per calendar month | Adds bulk upload and an optional email inbox |

Both plans have a 14-day trial and include the core approval, PO, cost and accounting workflows, subject to integration setup and current feature limitations.

There are no automatic overage fees. An accepted upload uses an allowance even if extraction later fails or needs correction. Retrying the same upload does not use another allowance. Manual captures count when saved.

Invoice allowances reset by calendar month in UTC, whereas subscription charges recur every 30 days. Explain this clearly during onboarding to avoid confusion.

### Recommended pricing approach

Keep the current plans as a launch hypothesis while measuring willingness to pay and support cost. Do not assume the pricing has been validated by the earlier reduction from $99/$249.

If prospects want only OCR and basic cost updates, cheaper competitors may be a better fit for them. If prospects need invoice approval, PO exceptions and accounting handover, demonstrate that workflow before discussing a price change.

After pilot evidence is available, consider one change at a time: a higher Starter allowance, clearer Growth benefits, a modest annual option, or an explicitly priced advanced feature. No additional prices or packaging changes have been implemented as part of this report.

## 9. Subscription earning potential

No verified paying-customer count, subscription income, conversion history or acquisition cost was supplied for this report. The small set of invoice records checked during the recent database repair is operational test evidence, not evidence of paid demand.

### Revenue at different customer counts

Assume:

- 70% of paying stores choose Starter at $19.
- 30% choose Growth at $49.
- All listed stores are paying and remain subscribed for the period.
- There are no discounts, refunds, failed collections or free trials in the figures.

Average recurring revenue per store is:

**(70% × $19) + (30% × $49) = $28 per 30-day billing cycle.**

| Paying stores | Starter / Growth | Gross revenue per 30-day cycle | Gross revenue over 12 such cycles |
| ------------- | ---------------: | -----------------------------: | --------------------------------: |
| 10            |            7 / 3 |                           $280 |                            $3,360 |
| 50            |          35 / 15 |                         $1,400 |                           $16,800 |
| 100           |          70 / 30 |                         $2,800 |                           $33,600 |
| 250           |         175 / 75 |                         $7,000 |                           $84,000 |
| 500           |        350 / 150 |                        $14,000 |                          $168,000 |
| 1,000         |        700 / 300 |                        $28,000 |                          $336,000 |

Twelve 30-day cycles cover 360 days. The last column is a constant-customer run-rate illustration, not a calendar-year cash forecast.

At the same assumed plan mix, gross recurring revenue targets of $1,000, $5,000 and $10,000 per cycle require approximately **36, 179 and 358 paying stores**, respectively.

### The customer mix matters

At 100 paying stores, an all-Starter business generates $1,900 per cycle, while an all-Growth business generates $4,900. Higher-priced customers may also use more processing and support, so higher revenue does not automatically mean a higher margin.

The practical first commercial milestone is 10–20 merchants who use the product repeatedly and choose to pay after the trial. Retaining that group is more informative than collecting many free installations.

## 10. Costs, profit and the economics of each customer

### 10.1 Shopify billing costs

Shopify's current published standard terms provide 0% revenue share on the first $1 million of qualifying gross app revenue earned from 1 January 2025, then 15% above that threshold. This is cumulative across associated developer accounts, not a fresh annual allowance. Different rules apply to very large developers.

App billing also carries a 2.9% processing fee, with applicable taxes and possible regional fees. App Store registration is a separate one-time $19 fee per Partner account. Confirm the account's actual eligibility and deductions before treating any scenario as a payout estimate. [Shopify developer revenue-share terms](https://shopify.dev/docs/apps/launch/distribution/revenue-share).

For an eligible early-stage account below the threshold, $2,800 of gross revenue would have a simplified processing deduction of **$81.20**, leaving **$2,718.80 before all other costs**. The following operating examples assume that 0% revenue-share eligibility.

### 10.2 Costs that need a budget

| Cost                        | Why it exists                                          | How to measure it                                                  |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| Web hosting and database    | Serve the app and keep invoices, sessions and activity | Actual hosting invoices and database utilization                   |
| OCR computing               | Render PDFs and recognize images                       | Effective cost per successfully processed page                     |
| File storage and transfer   | Keep originals and display them during review          | Stored GB, retention period and download volume                    |
| Email infrastructure        | Receive and route invoice attachments                  | Provider plan and message/attachment usage                         |
| Accounting developer access | Maintain production API integrations                   | Connected organizations, API usage and tier requirements           |
| Customer support            | Resolve document and accounting setup issues           | Minutes per store, separated into onboarding and recurring support |
| Marketing and referrals     | Acquire merchants                                      | Total acquisition spending divided by new paying stores            |
| Maintenance                 | Fix defects and follow platform changes                | Engineering time, dependency updates and incident work             |
| Administration and tax      | Operate the business                                   | Actual professional fees and applicable obligations                |

Tesseract running in the app avoids a mandatory charge from a hosted OCR vendor for each page in the current path. It does not make OCR free: processors, memory, storage, failed attempts and support still have costs.

### 10.3 Accounting integrations can add fixed costs

Xero's current developer pricing lists a free Starter tier with up to 5 connections, Core at **AUD 35/month for up to 50**, and Plus at **AUD 245/month for up to 1,000**. Plus requires app certification, and data-use charges can also apply. These are developer costs, separate from a merchant's accounting subscription. [Xero developer pricing](https://developer.xero.com/pricing).

Intuit's published guide lists a no-fee Builder tier with a capped CorePlus API allowance, and Silver at **USD 300/month** with different benefits and allowances. Do not assume every QuickBooks integration must start at $300, or that every developer automatically qualifies for free production operation. Confirm the app's region, assessment, required access and usage against the actual developer account. [Intuit App Partner Program Guide, fee table](https://static.developer.intuit.com/resources/Intuit_App_Partner_Program_Guide.pdf#page=10).

These fee structures make it important to measure how many customers use each integration. Moving from 50 to 51 Xero connections, for example, can create a different cost and certification requirement even if subscription revenue grows by only one customer.

### 10.4 Illustrative operating surplus

The table below is a planning model, not a quote for hosting or a prediction of profit.

Assumptions:

- $28 blended subscription revenue per store per 30-day cycle.
- A 2.9% Shopify processing deduction and no revenue-share deduction at this stage.
- $8 variable service cost per store: an assumed $3 for incremental processing/storage/email plus $5 of recurring support labor.
- The $5 support allowance represents 20 minutes valued at $15/hour.
- Fixed infrastructure pays for the base service capacity; the variable allowance covers incremental usage beyond that base.
- Marketing and accounting-provider reserves are explicit budget assumptions.
- Provider reserves are in USD. They are not currency conversions of the AUD prices above.
- Additional founder engineering/administration pay, income tax, exceptional incidents, refunds and unmodeled fees are excluded.

| Paying stores | Gross revenue | Processing fee | Variable service cost | Fixed infrastructure | Marketing | Provider reserve | Modeled surplus before excluded costs |
| ------------- | ------------: | -------------: | --------------------: | -------------------: | --------: | ---------------: | ------------------------------------: |
| 50            |        $1,400 |         $40.60 |                  $400 |                 $100 |      $100 |              $50 |                               $709.40 |
| 100           |        $2,800 |         $81.20 |                  $800 |                 $200 |      $300 |             $100 |                             $1,318.80 |
| 250           |        $7,000 |        $203.00 |                $2,000 |                 $400 |      $700 |             $250 |                             $3,447.00 |
| 500           |       $14,000 |        $406.00 |                $4,000 |                 $700 |    $1,500 |             $400 |                             $6,994.00 |

If the founder performs support personally, the model still values that time as a cost. The surplus is therefore not a promise of salary or distributable cash. Actual provider fees or support requirements could exceed the reserves.

### 10.5 Break-even and acquisition cost

Before fixed costs and customer acquisition, the assumed contribution per store is:

**$28 × (1 − 2.9%) − $8 = $19.188 per cycle.**

On that basis:

- $300 of fixed costs requires approximately 16 active paying stores.
- $500 requires approximately 27.
- $2,000, including a larger maintenance or owner-pay budget, requires approximately 105.

These examples treat the stated fixed-cost amount as the total relevant fixed budget; do not add it twice to the earlier scenario table.

If acquiring a paying store costs $50, the simple payback time is around 2.6 cycles. At $100 it is around 5.2 cycles; at $200 it is around 10.4 cycles. This assumes the store stays subscribed and continues producing the same contribution.

If the full 15% Shopify revenue-share rate later applies to additional revenue, contribution on that revenue falls to approximately **$14.99 per store** under the same service-cost assumption. Customer retention then becomes even more important.

### 10.6 Stress-test the document allowance

Growth permits up to 250 invoices in a calendar month and up to 10 pages per document. A customer could therefore submit 2,500 pages within that allowance.

Assume, purely for a stress test, that effective OCR computing costs $0.01 per page and other variable service costs are $6 for that customer:

**$49 − $1.421 processing fee − $25 computing − $6 other service = $16.579 contribution before fixed costs.**

At an effective computing cost of $0.02 per page, the same customer produces approximately **negative $8.42** before fixed costs.

Those per-page figures are hypothetical operating costs, not published Tesseract charges. The example shows why affordable pricing needs observed page counts, processing time and retry rates. Avoid offering unlimited processing before those measurements are available.

## 11. How revenue could develop over time

A subscriber target has little meaning without an acquisition and retention assumption. The following scenarios start at zero and add new paying stores each cycle. They are not labeled as likely outcomes.

The model is:

**Active stores this cycle = previous active stores × (1 − cancellation rate) + new paying stores.**

New paying stores already exclude trials that fail to convert. Revenue shown is the run rate at each checkpoint, not cumulative cash received.

| Hypothetical acquisition pattern | New paying stores per cycle | Cancellation rate per cycle | Revenue run rate after 3 cycles | After 6 cycles | After 12 cycles |
| -------------------------------- | --------------------------: | --------------------------: | ------------------------------: | -------------: | --------------: |
| Slow acquisition                 |                           5 |                          5% |                            $399 |           $742 |          $1,287 |
| Steady acquisition               |                          15 |                          4% |                          $1,210 |         $2,281 |          $4,067 |
| Strong acquisition               |                          30 |                          3% |                          $2,445 |         $4,677 |          $8,572 |

The corresponding expected active-store counts after 12 cycles are approximately 46, 145 and 306. The model calculates with unrounded customer counts before rounding the displayed revenue.

The acquisition assumptions need to be earned through marketing and a product that retains merchants. If no customers convert, revenue stays at zero while operating expenses continue.

For example, 15 new paying stores per cycle would require 60 trial starts at an assumed 25% trial-to-paid conversion rate. That percentage is an illustration, not an industry benchmark or a measured SmartBill result.

At 100 existing customers, a 5% cancellation rate means replacing about five customers per cycle merely to avoid shrinking. Support, reliability and repeat use are therefore part of the revenue strategy.

## 12. A practical route to customers

### Start with one repeatable use case

A suitable initial message is: “Review supplier invoices and update approved product costs without retyping everything.”

Demonstrate it using one merchant segment and a small group of common supplier formats. A clear example of a price or delivery discrepancy is more persuasive than a long feature list.

### Recruit a small pilot group

Work with 5–10 appropriate merchants. For each one:

1. Observe how they currently handle a supplier invoice.
2. Record time spent on entry, correction, matching and export.
3. Process a sample of real documents with permission.
4. Identify the formats that require repeated correction.
5. Check whether staff use the app again on the next delivery.
6. Ask whether the demonstrated benefit is worth the current price.

Offer help with setup, but measure that help. A $19 subscription that requires hours of recurring manual support may not be commercially viable.

### Use relevant acquisition channels

| Channel                     | Initial approach                                                                 | Evidence to collect                               |
| --------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| Shopify App Store           | Clear supplier-invoice positioning, real screenshots and a concise demonstration | Listing-to-install and install-to-paid conversion |
| Bookkeepers and accountants | Demonstrate reviewed supplier bills and an organized handover                    | Active referred customers and support effort      |
| Shopify agencies            | Offer a repeatable setup guide for inventory clients                             | Referrals that remain paying                      |
| Educational content         | Explain supplier price changes, invoice review and PO discrepancies              | Qualified visits and actual trial activation      |
| Merchant communities        | Discuss the workflow and gather feedback where promotion is allowed              | Relevant conversations and voluntary trials       |
| Paid advertising            | Small controlled tests after onboarding works                                    | Cost per paying retained store, not merely clicks |

A launch campaign should not promise guaranteed savings, universal OCR accuracy, full tax automation or a complete replacement for inventory/accounting software.

Existing marketplace listings show competition; they do not reveal competitor revenue or establish the size of SmartBill's obtainable market. A reliable market-size estimate needs evidence about how many suitable merchants have this problem and will pay for this specific solution.

### A 90-day plan, starting when launch prerequisites are met

| Period     | Main work                                                                              | Desired evidence                                       |
| ---------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Days 1–30  | Resolve launch blockers, validate supplier samples and onboard the first pilot group   | Successful complete workflows and measured review time |
| Days 31–60 | Improve recurring errors, refine onboarding and seek the first 10–20 paying merchants  | Trial conversion, repeat processing and first renewals |
| Days 61–90 | Build the most productive referral/content channel and test a small acquisition budget | A repeatable cost per retained paying merchant         |

These are planning milestones, not promised customer counts. Delay broad paid acquisition if the core workflow is still unreliable.

## 13. What should improve next?

The priority should be to make the existing promise dependable before expanding into unrelated features.

| Priority            | Improvement                                                                                  | Why it matters                                                          |
| ------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Before broad launch | Verify worker operation, file storage, billing and accounting connections on the actual host | Implemented code must become a reliable operating service               |
| Before broad launch | Update and test against a supported Shopify API version                                      | Avoid platform compatibility becoming a launch interruption             |
| High                | Measure correction rates on real supplier documents                                          | Accuracy determines the user's actual time saving                       |
| High                | Improve onboarding, first-document guidance and recovery messages                            | More trial users can reach a successful first invoice                   |
| High                | Add explicit pack/case-to-unit conversion                                                    | A correctly read pack price can still be the wrong product unit cost    |
| High                | Measure per-page cost, retries, support minutes and active API connections                   | Protect the economics of the $19/$49 plans                              |
| High                | Expand QuickBooks purchase-tax handling with supported country-specific behavior             | Current limitations reduce the value of live exports for taxed invoices |
| Medium              | Investigate import/sync with Shopify native purchasing records                               | Reduce duplicate PO setup where supported APIs permit it                |
| Medium              | Supplier price-change trends and alerts                                                      | Give merchants useful reasons to return beyond initial capture          |
| Medium              | A scheduled weekly digest and reminder workflow                                              | Bring unresolved invoices back to the responsible person                |
| Later               | Landed-cost allocation and documented currency conversion                                    | Better serve importers and complex cost policies                        |
| Later               | Accountant or agency tools for multiple stores                                               | Support a potentially valuable distribution channel                     |

Supplier price-change alerts, scheduled digests, case conversion, native PO synchronization, landed-cost calculation and multi-store accounting tools are future opportunities. They should not appear as completed product features in a listing.

Any provider-supported API work should be assessed against the current provider documentation and actual account permissions when implemented.

## 14. Current readiness and known limits

The app has substantial implemented functionality and a deployed environment, but readiness for public commercial launch has not been established by the available evidence.

| Area                  | Evidence available                                                                                 | Remaining uncertainty or work                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Database schema       | The missing invoice-controls migration was applied on 9 September 2026; eight schema checks passed | Continue checking each intended deployment database                                          |
| Existing records      | Five invoices and 15 line items remained after the repair                                          | These are not customer or revenue metrics                                                    |
| Automated checks      | Earlier implementation validation passed 19 tests, TypeScript, lint and production build           | Does not establish live workflow accuracy, load capacity or every financial edge case        |
| Deployment process    | Local Vercel configuration now builds, migrates and checks migration status                        | Adoption by the next deployed release has not been independently verified in this report     |
| OCR queue             | Persistent jobs, retries and a worker command are implemented                                      | Worker/scheduler operation on the intended host needs confirmation                           |
| File/email capture    | Private-storage and inbound-webhook code is present                                                | Storage credentials, receiving domain and mail-provider setup need confirmation              |
| Shopify cost sync     | Approval, preview, history and recovery are implemented                                            | Verify on development-store products and realistic supplier samples                          |
| Accounting            | Connection, export and existing-bill verification paths exist                                      | Production credentials, account mappings, provider access and live testing need confirmation |
| Publication and sales | The user described the app as not yet published                                                    | Public listing, paying merchants and recurring income are not verified                       |

### Specific boundaries to explain to users

- A receipt records physical delivery in SmartBill; it does not automatically adjust Shopify stock quantities.
- Updating a product's cost is not a complete inventory-valuation or historical profit-calculation engine.
- A supplier invoice cannot be assumed to use the same units as a Shopify variant.
- Cross-currency product-cost updates are blocked; automated conversion is unavailable.
- Complex tax treatments and credit notes require work outside the automated paths.
- Email capture is dependent on external configuration.
- Captured documents can need manual correction; OCR confidence is not proof of accounting correctness.
- Reports describe stored operational activity. They do not prove recovered money or net business profit.

The app permits documents up to 10 MB and 10 pages, but the Vercel browser flow limits each batch to 4 MB to accommodate the host's request limit. Full-size uploads and email payloads need suitable ingress and worker hosting. [Vercel function limits](https://vercel.com/docs/functions/limitations).

The source currently selects Shopify API version `2025-10`. Shopify's published schedule lists its retirement as 16 October 2026, so updating the SDK/API and testing the app is an immediate maintenance priority. [Shopify API version schedule](https://shopify.dev/docs/api/usage/versioning).

## 15. The app's value as a business asset

SmartBill has two different kinds of value.

**Value to a merchant** can be measured through time released, fewer repeated entries, useful exceptions discovered and more dependable cost/accounting inputs. The strongest evidence will be observations of real work before and after adoption.

**Value to the owner or a potential buyer** depends on retained paying customers, profit after realistic costs, reliability, ownership of the software, maintainability, distribution channels and the amount of work required from the founder.

The available evidence is not sufficient to assign a reliable sale valuation. A functioning codebase and a repaired database are useful assets, but they are not proof of a profitable customer base.

Evidence that would support a stronger valuation includes:

- Several months of verified recurring subscription receipts.
- Retention and cancellation records by customer cohort.
- Documented hosting, support and integration costs.
- Successful, repeatable onboarding without excessive founder involvement.
- Clear ownership and documentation of the source and operating accounts.
- Tested recovery, backups and financial-update behavior.
- A customer-acquisition channel with measurable economics.

A practical objective is to establish a small group of satisfied, renewing customers and a positive contribution per store. That would improve both the merchant proposition and the owner's ability to judge the business.

## 16. Recommended commercial direction

Proceed as a focused supplier-invoice control product for Shopify inventory merchants. Keep the public promise narrow enough to demonstrate with real documents: capture, review, check purchase/delivery differences, and apply approved updates.

Treat the $19/$49 pricing as a hypothesis to test against measurable customer value. A merchant who needs only basic OCR has lower-priced alternatives. A merchant who needs reliable approval and accounting handover may be willing to pay for the complete workflow.

The immediate priorities are operational readiness, sample-based extraction improvement, clearer onboarding and a small paying pilot. Then use observed retention and service costs to decide whether to increase invoice allowances, change packaging or invest in broader features.

The revenue scenarios show that a useful small software business is possible at tens to hundreds of paying stores. The missing evidence is whether SmartBill can acquire those stores, keep them using the app, and serve them profitably.

## 17. Evidence and source notes

**Product evidence reviewed:** current project source and implementation history. No new app features, subscription prices, external account settings or database records were changed to prepare this report.

Useful source files:

| Topic                           | Project reference                                                     |
| ------------------------------- | --------------------------------------------------------------------- |
| Plans and limits                | [app/utils/plans.ts](app/utils/plans.ts)                              |
| Capture and invoice persistence | [invoiceWorkflow.server.ts](app/services/invoiceWorkflow.server.ts)   |
| Background processing           | [invoiceJobs.server.ts](app/services/invoiceJobs.server.ts)           |
| Invoice editor                  | [app.invoices.$id.tsx](app/routes/app.invoices.$id.tsx)               |
| Approval and supplier mappings  | [invoiceReview.server.ts](app/services/invoiceReview.server.ts)       |
| PO/receipt comparison           | [poReconciliation.server.ts](app/services/poReconciliation.server.ts) |
| Product cost controls           | [cogs.server.ts](app/services/cogs.server.ts)                         |
| Accounting exports              | [accountingExport.server.ts](app/services/accountingExport.server.ts) |
| Weekly report                   | [app.reports.tsx](app/routes/app.reports.tsx)                         |
| OCR implementation              | [ocr.server.ts](app/utils/ocr.server.ts)                              |
| Data model                      | [prisma/schema.prisma](prisma/schema.prisma)                          |
| Deployment and setup            | [README.md](README.md)                                                |

External facts are linked beside the relevant comparisons, costs and platform statements. Prices and provider policies were checked on 9 September 2026 and can change. Revenue scenarios, cost allowances, target segments and recommended milestones are this report's analysis and assumptions.
