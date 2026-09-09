-- AlterTable
ALTER TABLE "public"."PurchaseOrder" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD';

-- AlterTable
ALTER TABLE "public"."PurchaseOrderItem" ADD COLUMN     "billedQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
ALTER COLUMN "expectedQty" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "receivedQty" SET DEFAULT 0,
ALTER COLUMN "receivedQty" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "public"."Invoice" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "documentHash" TEXT,
ADD COLUMN     "identityKey" TEXT,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."InvoiceItem" ADD COLUMN     "matchConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "syncCost" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "quantity" SET DEFAULT 1,
ALTER COLUMN "quantity" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "public"."ShopSettings" ADD COLUMN     "dateOrder" TEXT NOT NULL DEFAULT 'DMY',
ADD COLUMN     "inboundAlias" TEXT,
ADD COLUMN     "minutesSavedPerInvoice" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "quickBooksAccountId" TEXT,
ADD COLUMN     "quickBooksTaxCodeId" TEXT,
ADD COLUMN     "xeroAccountCode" TEXT,
ADD COLUMN     "xeroTaxType" TEXT,
ALTER COLUMN "billingPlan" SET DEFAULT 'STARTER';

-- Older versions counted invoices as receipts. Preserve that number as billed,
-- and require an actual delivery record before declaring goods received.
UPDATE "public"."PurchaseOrderItem" SET "billedQty" = "receivedQty", "receivedQty" = 0;
UPDATE "public"."PurchaseOrder" SET "status" = 'OPEN';
UPDATE "public"."PurchaseOrder" AS po SET "currency" = settings."defaultCurrency"
FROM "public"."ShopSettings" AS settings WHERE po."shop" = settings."shop";
UPDATE "public"."Invoice" SET "reviewStatus" = 'PENDING_REVIEW'
WHERE "reviewStatus" = 'APPROVED' AND "approvedAt" IS NULL;
UPDATE "public"."ShopSettings" SET "requireReview" = true, "autoSyncCogs" = false;

-- CreateTable
CREATE TABLE "public"."AccountingExport" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestKey" TEXT NOT NULL,
    "remoteId" TEXT,
    "payload" JSONB,
    "error" TEXT,
    "attemptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountingExport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CostChange" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "invoiceItemId" TEXT NOT NULL,
    "inventoryItemId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "previousCost" DOUBLE PRECISION,
    "newCost" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "actor" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuditEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "invoiceId" TEXT,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SupplierMapping" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "vendorKey" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GoodsReceipt" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "reference" TEXT,
    "requestKey" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoodsReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GoodsReceiptItem" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "purchaseOrderItemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "GoodsReceiptItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InvoiceJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "documentHash" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "vendorName" TEXT,
    "purchaseOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "invoiceId" TEXT,
    "error" TEXT,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "usageMonth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MonthlyUsage" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "invoices" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "MonthlyUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccountingExport_requestKey_key" ON "public"."AccountingExport"("requestKey");

-- CreateIndex
CREATE INDEX "AccountingExport_shop_status_idx" ON "public"."AccountingExport"("shop", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AccountingExport_invoiceId_platform_key" ON "public"."AccountingExport"("invoiceId", "platform");

-- CreateIndex
CREATE INDEX "CostChange_shop_createdAt_idx" ON "public"."CostChange"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CostChange_invoiceId_invoiceItemId_key" ON "public"."CostChange"("invoiceId", "invoiceItemId");

-- CreateIndex
CREATE INDEX "AuditEvent_shop_createdAt_idx" ON "public"."AuditEvent"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_invoiceId_idx" ON "public"."AuditEvent"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierMapping_shop_vendorKey_itemKey_key" ON "public"."SupplierMapping"("shop", "vendorKey", "itemKey");

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_requestKey_key" ON "public"."GoodsReceipt"("requestKey");

-- CreateIndex
CREATE INDEX "GoodsReceipt_shop_receivedAt_idx" ON "public"."GoodsReceipt"("shop", "receivedAt");

-- CreateIndex
CREATE INDEX "InvoiceJob_status_availableAt_idx" ON "public"."InvoiceJob"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceJob_shop_documentHash_key" ON "public"."InvoiceJob"("shop", "documentHash");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyUsage_shop_month_key" ON "public"."MonthlyUsage"("shop", "month");

-- CreateIndex
CREATE INDEX "Invoice_shop_createdAt_idx" ON "public"."Invoice"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_shop_documentHash_key" ON "public"."Invoice"("shop", "documentHash");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_shop_identityKey_key" ON "public"."Invoice"("shop", "identityKey");

-- CreateIndex
CREATE UNIQUE INDEX "ShopSettings_inboundAlias_key" ON "public"."ShopSettings"("inboundAlias");

-- AddForeignKey
ALTER TABLE "public"."AccountingExport" ADD CONSTRAINT "AccountingExport_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "public"."Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CostChange" ADD CONSTRAINT "CostChange_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "public"."Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "public"."PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsReceiptItem" ADD CONSTRAINT "GoodsReceiptItem_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "public"."GoodsReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoodsReceiptItem" ADD CONSTRAINT "GoodsReceiptItem_purchaseOrderItemId_fkey" FOREIGN KEY ("purchaseOrderItemId") REFERENCES "public"."PurchaseOrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
