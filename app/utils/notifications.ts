export const NOTIFICATION_TYPES = [
  "INVOICE_UPLOADED",
  "PO_MISMATCH",
  "OCR_LOW_CONFIDENCE",
  "MISSING_SUPPLIER",
  "COST_SYNC_SUCCESS",
  "COST_SYNC_FAILURE",
  "APPROVAL_REQUIRED",
  "EXPORT_SUCCESS",
  "EXPORT_FAILURE",
  "APPROVAL_ESCALATED",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export type NotificationContext = {
  invoiceId?: string;
  invoiceNumber?: string | null;
  supplier?: string | null;
  amount?: number | null;
  currency?: string | null;
  message?: string;
  actionPath?: string;
};

const LABELS: Record<NotificationType, string> = {
  INVOICE_UPLOADED: "Invoice uploaded",
  PO_MISMATCH: "Purchase order mismatch",
  OCR_LOW_CONFIDENCE: "OCR review needed",
  MISSING_SUPPLIER: "Supplier mapping needed",
  COST_SYNC_SUCCESS: "Shopify cost sync completed",
  COST_SYNC_FAILURE: "Shopify cost sync failed",
  APPROVAL_REQUIRED: "Invoice approval required",
  EXPORT_SUCCESS: "Accounting export completed",
  EXPORT_FAILURE: "Accounting export failed",
  APPROVAL_ESCALATED: "Invoice approval escalated",
};

export function notificationMessage(
  type: NotificationType,
  context: NotificationContext,
) {
  const invoice = context.invoiceNumber
    ? `Invoice ${context.invoiceNumber}`
    : "An invoice";
  const supplier = context.supplier ? ` from ${context.supplier}` : "";
  const amount =
    context.amount != null && context.currency
      ? `${context.currency} ${context.amount.toFixed(2)}`
      : "";
  const detail = context.message?.trim();
  return {
    subject: `SmartBill: ${LABELS[type]}`,
    text: `${invoice}${supplier}${amount ? ` (${amount})` : ""}: ${detail || LABELS[type]}.`,
  };
}

export function notificationTypeEnabled(value: unknown, type: NotificationType) {
  return Array.isArray(value) && value.map(String).includes(type);
}

export function validateNotificationTarget(channel: string, target: string) {
  if (channel === "EMAIL") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target))
      throw new Error("Enter a valid notification email address.");
    return;
  }
  if (channel === "SLACK") {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new Error("Enter a valid Slack webhook URL.");
    }
    if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com")
      throw new Error("Use an HTTPS webhook from hooks.slack.com.");
    return;
  }
  throw new Error("Choose email or Slack.");
}
