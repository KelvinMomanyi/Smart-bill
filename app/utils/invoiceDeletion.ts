export type InvoiceDeletionState = {
  accountingStatus: string;
  cogsSyncStatus: string;
  exports: Array<{ platform: string; status: string }>;
  costChanges: Array<{ status: string }>;
};

export function invoiceDeletionBlockedReason(invoice: InvoiceDeletionState) {
  if (
    invoice.accountingStatus === "EXPORTED" ||
    invoice.exports.some(
      (entry) => entry.platform !== "CSV" && entry.status !== "REJECTED",
    )
  )
    return "This invoice has an accounting bill or an export with an uncertain result. Resolve it in Xero or QuickBooks before removing SmartBill's record.";
  if (
    invoice.cogsSyncStatus !== "NOT_REQUESTED" ||
    invoice.costChanges.some((change) => change.status !== "PLANNED")
  )
    return "This invoice has changed, or may have changed, Shopify product costs. Restore and verify those costs before deleting the invoice.";
  return null;
}
