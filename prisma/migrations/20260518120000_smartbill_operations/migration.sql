-- Productize SmartBill around invoice review, private document storage,
-- PO reconciliation, COGS sync status, and accounting export status.

ALTER TABLE "Vendor" ADD COLUMN "email" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "phone" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "paymentTerms" TEXT;
ALTER TABLE "Vendor" ADD COLUMN "defaultCurrency" TEXT DEFAULT 'USD';

ALTER TABLE "PurchaseOrder" ADD COLUMN "poNumber" TEXT;
ALTER TABLE "PurchaseOrder" ADD COLUMN "notes" TEXT;

ALTER TABLE "Invoice" ADD COLUMN "storageKey" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "sourceFilename" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "rawText" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE "Invoice" ADD COLUMN "reviewStatus" TEXT NOT NULL DEFAULT 'PENDING_REVIEW';
ALTER TABLE "Invoice" ADD COLUMN "cogsSyncStatus" TEXT NOT NULL DEFAULT 'NOT_REQUESTED';
ALTER TABLE "Invoice" ADD COLUMN "accountingStatus" TEXT NOT NULL DEFAULT 'NOT_EXPORTED';
ALTER TABLE "Invoice" ADD COLUMN "discrepancySummary" TEXT;

ALTER TABLE "InvoiceItem" ADD COLUMN "sku" TEXT;
ALTER TABLE "InvoiceItem" ADD COLUMN "confidence" REAL;
ALTER TABLE "InvoiceItem" ADD COLUMN "matchedProductTitle" TEXT;

CREATE TABLE "ShopSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "billingPlan" TEXT NOT NULL DEFAULT 'GROWTH',
    "accountingPlatform" TEXT,
    "accountingConnected" BOOLEAN NOT NULL DEFAULT false,
    "autoSyncCogs" BOOLEAN NOT NULL DEFAULT false,
    "requireReview" BOOLEAN NOT NULL DEFAULT true,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "ShopSettings_shop_key" ON "ShopSettings"("shop");
CREATE UNIQUE INDEX "PurchaseOrder_shop_poNumber_key" ON "PurchaseOrder"("shop", "poNumber");
