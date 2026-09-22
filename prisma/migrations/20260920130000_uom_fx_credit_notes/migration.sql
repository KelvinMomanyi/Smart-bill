BEGIN;
ALTER TABLE "Invoice" ADD COLUMN "fxRate" DOUBLE PRECISION;
ALTER TABLE "Invoice" ADD COLUMN "fxRateSource" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "fxRateDate" TIMESTAMP(3);
ALTER TABLE "InvoiceItem" ADD COLUMN "supplierUoM" TEXT;
ALTER TABLE "InvoiceItem" ADD COLUMN "packSize" DOUBLE PRECISION;
ALTER TABLE "SupplierMapping" ADD COLUMN "packSize" DOUBLE PRECISION;
ALTER TABLE "SupplierMapping" ADD COLUMN "supplierUoM" TEXT;
CREATE TABLE "CreditNote" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "vendorId" TEXT,
  "invoiceId" TEXT,
  "creditNoteNumber" TEXT,
  "originalInvoiceNumber" TEXT,
  "amount" DOUBLE PRECISION NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "reason" TEXT NOT NULL DEFAULT 'OTHER',
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "dateIssued" TIMESTAMP(3),
  "dateReceived" TIMESTAMP(3),
  "documentHash" TEXT,
  "storageKey" TEXT,
  "sourceFilename" TEXT,
  "rawText" TEXT,
  "allocation" JSONB,
  "actor" TEXT NOT NULL,
  "approvedAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreditNote_shop_documentHash_key" ON "CreditNote"("shop", "documentHash");
CREATE INDEX "CreditNote_shop_status_idx" ON "CreditNote"("shop", "status");
CREATE INDEX "CreditNote_invoiceId_idx" ON "CreditNote"("invoiceId");
COMMIT;