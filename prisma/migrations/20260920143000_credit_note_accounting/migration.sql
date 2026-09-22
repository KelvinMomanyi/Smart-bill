BEGIN;
ALTER TABLE "CreditNote" ADD COLUMN "accountingPlatform" TEXT;
ALTER TABLE "CreditNote" ADD COLUMN "accountingReference" TEXT;
ALTER TABLE "CreditNote" ADD COLUMN "accountingError" TEXT;
ALTER TABLE "CreditNote" ADD COLUMN "accountedAt" TIMESTAMP(3);
COMMIT;