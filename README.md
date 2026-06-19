# SmartBill

SmartBill is a Shopify embedded app for supplier invoice capture, purchase order reconciliation, COGS updates, and accounting export workflows.

The app is built for inventory-heavy Shopify merchants that receive vendor invoices and need a controlled way to:

- Upload invoice images or PDFs and extract invoice data with OCR.
- Match invoice line items against purchase orders.
- Review discrepancies before approval.
- Sync matched item costs to Shopify inventory items.
- Export invoice data to CSV, Xero, or QuickBooks.
- Track vendor spend, invoice quality, and automation throughput.

## Product Positioning

Primary Shopify App Store category:

- Store management -> Finances -> Accounting

Best niche:

- Supplier invoice OCR, PO matching, and COGS sync for Shopify inventory teams.

Secondary fit:

- Orders and shipping -> Inventory -> Inventory optimization

Avoid positioning this as a customer invoice printer or generic sales-accounting connector. The strongest value is supplier-side cost control.

## Core Workflows

- Command Center: capture invoices, link POs, optionally sync COGS, and review operating metrics.
- Invoice Review: approve invoices, export CSV packages, and sync connected invoices to Xero or QuickBooks.
- Purchase Orders: create structured supplier POs, paste/import bulk item rows, and track received quantities.
- Vendor Analytics: monitor supplier spend, mismatches, COGS syncs, and exports.
- Settings: manage Shopify billing, accounting connections, review policy, currency, and COGS defaults.

## Pricing

Shopify recurring billing is configured in `app/shopify.server.ts`:

- SmartBill Growth: USD 99 every 30 days, 14-day trial.
- SmartBill Scale: USD 249 every 30 days, 14-day trial.

Recommended launch packaging:

- Growth: invoice capture, review queue, CSV export, basic PO matching.
- Scale: COGS sync, vendor analytics, Xero/QuickBooks live export, larger invoice volume.

## Tech Stack

- Shopify App Remix
- Remix and React
- Shopify Polaris
- Prisma with SQLite for local development
- Tesseract.js and PDF.js for OCR/PDF extraction
- Firebase Storage for private invoice file storage when configured
- Shopify Admin GraphQL for inventory item cost updates

## Requirements

- Node.js 18.20 or newer
- Shopify Partner account
- Shopify development store
- SQLite for local development

Optional production integrations:

- Firebase Admin credentials for private invoice storage
- Xero OAuth app credentials
- QuickBooks OAuth app credentials

## Environment

Create `.env` with the Shopify CLI values plus any optional integrations:

```env
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_APP_URL=
SCOPES=write_products,read_products,write_inventory,read_inventory,read_orders,write_orders

FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
FIREBASE_STORAGE_BUCKET=

XERO_CLIENT_ID=
XERO_CLIENT_SECRET=
QB_CLIENT_ID=
QB_CLIENT_SECRET=
```

Accounting callback URLs to register with providers:

- `https://your-app-url/accounting/xero/callback`
- `https://your-app-url/accounting/quickbooks/callback`

## Development

Install dependencies:

```shell
npm install
```

Prepare Prisma:

```shell
npm run setup
```

Start Shopify local development:

```shell
npm run dev
```

Run checks:

```shell
npm test
npm run lint
npm run build
```

## Data Model

The main product tables are:

- `Vendor`
- `PurchaseOrder`
- `PurchaseOrderItem`
- `Invoice`
- `InvoiceItem`
- `ShopSettings`
- `AccountingConnection`

Shopify session data is stored in `Session`.

## Launch Notes

Before App Store submission:

- Replace tunnel URLs in `shopify.app.toml` with the production app URL.
- Use a production database instead of local SQLite.
- Configure private file storage.
- Verify Xero and QuickBooks OAuth credentials and callback URLs.
- Test OCR against real supplier invoice samples.
- Add App Store listing copy focused on supplier invoice automation, PO reconciliation, and inventory cost control.
