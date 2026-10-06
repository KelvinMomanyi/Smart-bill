# SmartBill listing screenshots

Three desktop PNGs are 1600 by 900 pixels. One optional mobile PNG is 900 by 1600 pixels.

Existing SmartBill route components are rendered using installed Polaris components and the app's styles. Server handlers are omitted from the local rendering copy and replaced with fictional sample data. No app source, live database, merchant records, integrations, or listing are changed. The desktop capture uses normal browser zoom for readability.

The mobile image shows a delivery form with sample quantities entered without submitting it. No POS screenshot is included because SmartBill does not implement a POS integration.

| File | Alt text |
| --- | --- |
| smartbill-desktop-01-invoice-review.png | Supplier invoices with review and accounting statuses |
| smartbill-desktop-02-purchase-order-receipts.png | Compare ordered, received, and billed product quantities |
| smartbill-desktop-03-vendor-analytics.png | Supplier spending, invoice counts, and purchase order issues |
| smartbill-mobile-01-record-delivery.png | Record a delivery on mobile with previous receipts visible |

All alt text is at most 64 characters. Images contain only app content, without browser controls or desktop backgrounds. Sample supplier and staff labels are fictional and contain no personal information. Invoice amounts are sample business records, not app subscription pricing or outcome claims.

Recreate with: `node output/screenshots/create-smartbill-screenshots.mjs --capture`. Rendering alone does not launch a browser.

Guidelines: https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices#3-screenshots
