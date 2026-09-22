BEGIN;

ALTER TABLE "Vendor" ADD COLUMN "defaultLandedCostMethod" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "shopCurrency" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "costInShopCurrency" DOUBLE PRECISION;
ALTER TABLE "InvoiceItem" ADD COLUMN "convertedQuantity" DOUBLE PRECISION;
ALTER TABLE "InvoiceItem" ADD COLUMN "costPerStockUnit" DOUBLE PRECISION;
ALTER TABLE "InvoiceItem" ADD COLUMN "landedCostPerUnit" DOUBLE PRECISION;
ALTER TABLE "ShopSettings" ADD COLUMN "fxRateSourcePreference" TEXT NOT NULL DEFAULT 'OPENEXCHANGERATES';
ALTER TABLE "ShopSettings" ADD COLUMN "fxRevaluationFrequency" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "ShopSettings" ADD COLUMN "fxGainAccount" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN "fxLossAccount" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN "fxRateRounding" INTEGER NOT NULL DEFAULT 6;
ALTER TABLE "SupplierMapping" ADD COLUMN "packUnitOfMeasure" TEXT;
ALTER TABLE "SupplierMapping" ADD COLUMN "stockUnitOfMeasure" TEXT;
ALTER TABLE "CreditNote" ADD COLUMN "accountingStatus" TEXT NOT NULL DEFAULT 'NOT_POSTED';
ALTER TABLE "CreditNote" ADD COLUMN "accountingRequestKey" TEXT;

CREATE TABLE "CreditNoteLine" (
  "id" TEXT NOT NULL,
  "creditNoteId" TEXT NOT NULL,
  "invoiceLineId" TEXT,
  "description" TEXT NOT NULL,
  "quantity" DOUBLE PRECISION NOT NULL,
  "unitPrice" DOUBLE PRECISION NOT NULL,
  "lineAmount" DOUBLE PRECISION NOT NULL,
  "originalLineId" TEXT,
  CONSTRAINT "CreditNoteLine_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CreditNoteLine_creditNoteId_idx" ON "CreditNoteLine"("creditNoteId");
CREATE INDEX "CreditNoteLine_invoiceLineId_idx" ON "CreditNoteLine"("invoiceLineId");
ALTER TABLE "CreditNoteLine" ADD CONSTRAINT "CreditNoteLine_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditNoteLine" ADD CONSTRAINT "CreditNoteLine_invoiceLineId_fkey" FOREIGN KEY ("invoiceLineId") REFERENCES "InvoiceItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CreditNoteAllocation" (
  "id" TEXT NOT NULL,
  "creditNoteId" TEXT NOT NULL,
  "targetInvoiceId" TEXT NOT NULL,
  "allocatedAmount" DOUBLE PRECISION NOT NULL,
  "allocationDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "allocationReason" TEXT,
  CONSTRAINT "CreditNoteAllocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreditNoteAllocation_creditNoteId_targetInvoiceId_key" ON "CreditNoteAllocation"("creditNoteId", "targetInvoiceId");
CREATE INDEX "CreditNoteAllocation_targetInvoiceId_idx" ON "CreditNoteAllocation"("targetInvoiceId");
ALTER TABLE "CreditNoteAllocation" ADD CONSTRAINT "CreditNoteAllocation_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "CreditNote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditNoteAllocation" ADD CONSTRAINT "CreditNoteAllocation_targetInvoiceId_fkey" FOREIGN KEY ("targetInvoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "FreightLine" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "invoiceItemId" TEXT,
  "supplierId" TEXT,
  "description" TEXT NOT NULL,
  "amount" DOUBLE PRECISION NOT NULL,
  "currency" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "FreightLine_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FreightLine_invoiceItemId_key" ON "FreightLine"("invoiceItemId");
CREATE INDEX "FreightLine_invoiceId_idx" ON "FreightLine"("invoiceId");
CREATE INDEX "FreightLine_supplierId_idx" ON "FreightLine"("supplierId");
ALTER TABLE "FreightLine" ADD CONSTRAINT "FreightLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FreightLine" ADD CONSTRAINT "FreightLine_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "FreightAllocation" (
  "id" TEXT NOT NULL,
  "freightLineId" TEXT NOT NULL,
  "invoiceLineId" TEXT NOT NULL,
  "allocationMethod" TEXT NOT NULL,
  "allocatedAmount" DOUBLE PRECISION NOT NULL,
  "allocationReason" TEXT,
  "calculatedBy" TEXT NOT NULL,
  "allocationDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "adjustedManually" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "FreightAllocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "FreightAllocation_freightLineId_invoiceLineId_key" ON "FreightAllocation"("freightLineId", "invoiceLineId");
CREATE INDEX "FreightAllocation_invoiceLineId_idx" ON "FreightAllocation"("invoiceLineId");
ALTER TABLE "FreightAllocation" ADD CONSTRAINT "FreightAllocation_freightLineId_fkey" FOREIGN KEY ("freightLineId") REFERENCES "FreightLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FreightAllocation" ADD CONSTRAINT "FreightAllocation_invoiceLineId_fkey" FOREIGN KEY ("invoiceLineId") REFERENCES "InvoiceItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ExchangeRate" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "fromCurrency" TEXT NOT NULL,
  "toCurrency" TEXT NOT NULL,
  "rateDate" TIMESTAMP(3) NOT NULL,
  "rate" DOUBLE PRECISION NOT NULL,
  "source" TEXT NOT NULL,
  "confidence" INTEGER NOT NULL,
  "appliedToInvoice" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExchangeRate_shop_fromCurrency_toCurrency_rateDate_source_key" ON "ExchangeRate"("shop", "fromCurrency", "toCurrency", "rateDate", "source");
CREATE INDEX "ExchangeRate_shop_fromCurrency_toCurrency_rateDate_idx" ON "ExchangeRate"("shop", "fromCurrency", "toCurrency", "rateDate");

CREATE TABLE "FXAdjustment" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "fromCurrency" TEXT NOT NULL,
  "toCurrency" TEXT NOT NULL,
  "invoiceAmount" DOUBLE PRECISION NOT NULL,
  "convertedAmount" DOUBLE PRECISION NOT NULL,
  "rateUsed" DOUBLE PRECISION NOT NULL,
  "rateDate" TIMESTAMP(3) NOT NULL,
  "rateDifference" DOUBLE PRECISION,
  "reason" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FXAdjustment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FXAdjustment_invoiceId_createdAt_idx" ON "FXAdjustment"("invoiceId", "createdAt");
ALTER TABLE "FXAdjustment" ADD CONSTRAINT "FXAdjustment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UoMMapping" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "supplierId" TEXT NOT NULL,
  "itemKey" TEXT NOT NULL,
  "supplierUoM" TEXT NOT NULL,
  "stockUoM" TEXT NOT NULL,
  "conversionFactor" DOUBLE PRECISION NOT NULL,
  "confidence" TEXT NOT NULL,
  "lastUsed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "frequency" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UoMMapping_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UoMMapping_shop_supplierId_itemKey_supplierUoM_stockUoM_key" ON "UoMMapping"("shop", "supplierId", "itemKey", "supplierUoM", "stockUoM");
CREATE INDEX "UoMMapping_shop_supplierId_idx" ON "UoMMapping"("shop", "supplierId");
ALTER TABLE "UoMMapping" ADD CONSTRAINT "UoMMapping_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Vendor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ApprovalRule" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "invoiceAmountMin" DOUBLE PRECISION,
  "invoiceAmountMax" DOUBLE PRECISION,
  "supplierId" TEXT,
  "requiredApprovers" INTEGER NOT NULL DEFAULT 1,
  "approverRoles" JSONB NOT NULL,
  "escalateIfUnresolvedDays" INTEGER NOT NULL DEFAULT 3,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApprovalRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ApprovalRule_shop_active_idx" ON "ApprovalRule"("shop", "active");
CREATE UNIQUE INDEX "ApprovalRule_shop_name_key" ON "ApprovalRule"("shop", "name");
ALTER TABLE "ApprovalRule" ADD CONSTRAINT "ApprovalRule_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "Approval" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "approvalRuleId" TEXT NOT NULL,
  "approverId" TEXT,
  "assignedTo" TEXT,
  "approvedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "comments" TEXT,
  "escalated" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Approval_invoiceId_status_idx" ON "Approval"("invoiceId", "status");
CREATE INDEX "Approval_assignedTo_status_idx" ON "Approval"("assignedTo", "status");
CREATE INDEX "Approval_invoiceId_approvalRuleId_approverId_idx" ON "Approval"("invoiceId", "approvalRuleId", "approverId");
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_approvalRuleId_fkey" FOREIGN KEY ("approvalRuleId") REFERENCES "ApprovalRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "NotificationPreference" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "webhookUrl" TEXT,
  "emailAddress" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "notificationTypes" JSONB NOT NULL,
  "frequency" TEXT NOT NULL DEFAULT 'IMMEDIATE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationPreference_shop_channel_key" ON "NotificationPreference"("shop", "channel");

CREATE TABLE "NotificationLog" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "sentAt" TIMESTAMP(3),
  "deliveryStatus" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NotificationLog_shop_createdAt_idx" ON "NotificationLog"("shop", "createdAt");

CREATE TABLE "ReportingSnapshot" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "periodStart" TIMESTAMP(3) NOT NULL,
  "periodEnd" TIMESTAMP(3) NOT NULL,
  "periodType" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReportingSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReportingSnapshot_shop_periodStart_periodEnd_periodType_key" ON "ReportingSnapshot"("shop", "periodStart", "periodEnd", "periodType");
CREATE INDEX "ReportingSnapshot_shop_periodType_periodStart_idx" ON "ReportingSnapshot"("shop", "periodType", "periodStart");

COMMIT;
