BEGIN;
ALTER TABLE "Invoice" ADD COLUMN "accountingMapping" JSONB;
ALTER TABLE "ShopSettings" ADD COLUMN "quickBooksTaxAccountId" TEXT;
ALTER TABLE "AccountingExport"
  ADD COLUMN "companyKey" TEXT,
  ADD COLUMN "attachmentStatus" TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
  ADD COLUMN "attachmentId" TEXT,
  ADD COLUMN "attachmentError" TEXT;
CREATE UNIQUE INDEX "AccountingExport_shop_platform_companyKey_remoteId_key" ON "AccountingExport"("shop", "platform", "companyKey", "remoteId");
ALTER TABLE "AccountingConnection"
  ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'production',
  ADD COLUMN "companyName" TEXT,
  ADD COLUMN "country" TEXT,
  ADD COLUMN "homeCurrency" TEXT,
  ADD COLUMN "xeroConnectionId" TEXT;
CREATE TABLE "AccountingAuthorization" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "environment" TEXT NOT NULL DEFAULT 'production',
  "actor" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CREATED',
  "cookieHash" TEXT,
  "credentials" TEXT,
  "companies" JSONB,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountingAuthorization_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AccountingAuthorization_shop_expiresAt_idx" ON "AccountingAuthorization"("shop", "expiresAt");
COMMIT;
