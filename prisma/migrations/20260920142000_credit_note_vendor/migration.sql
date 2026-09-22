BEGIN;
CREATE INDEX "CreditNote_vendorId_idx" ON "CreditNote"("vendorId");
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;
COMMIT;