import prisma from "../db.server";
import {
  notificationMessage,
  notificationTypeEnabled,
  type NotificationContext,
  type NotificationType,
} from "../utils/notifications";
export {
  NOTIFICATION_TYPES,
  notificationMessage,
  notificationTypeEnabled,
  validateNotificationTarget,
} from "../utils/notifications";
export type { NotificationContext, NotificationType } from "../utils/notifications";

function appUrl(path: string | undefined) {
  const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
  return base && path ? `${base}${path.startsWith("/") ? path : `/${path}`}` : "";
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

async function sendEmail(target: string, subject: string, text: string, url: string) {
  const apiKey = process.env.SENDGRID_API_KEY;
  const from = process.env.NOTIFICATION_FROM_EMAIL;
  if (!apiKey || !from)
    throw new Error("Email notifications are not configured by the app operator.");
  const html = `<p>${escapeHtml(text)}</p>${
    url ? `<p><a href="${escapeHtml(url)}">Review in SmartBill</a></p>` : ""
  }`;
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: target }] }],
      from: { email: from },
      subject,
      content: [
        { type: "text/plain", value: `${text}${url ? `\n\n${url}` : ""}` },
        { type: "text/html", value: html },
      ],
    }),
  });
  if (!response.ok)
    throw new Error(`SendGrid rejected the notification (${response.status}).`);
}

async function sendSlack(target: string, text: string, url: string) {
  const response = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text } },
        ...(url
          ? [
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    text: { type: "plain_text", text: "Review in SmartBill" },
                    url,
                  },
                ],
              },
            ]
          : []),
      ],
    }),
  });
  if (!response.ok)
    throw new Error(`Slack rejected the notification (${response.status}).`);
}

async function deliver(
  channel: string,
  target: string,
  subject: string,
  body: string,
  url: string,
) {
  if (channel === "EMAIL") return sendEmail(target, subject, body, url);
  if (channel === "SLACK") return sendSlack(target, body, url);
  throw new Error(`Unsupported notification channel ${channel}.`);
}

export async function notifyOn(
  type: NotificationType,
  shop: string,
  context: NotificationContext,
  options: {
    channel?: string;
    includeDaily?: boolean;
    frequency?: "IMMEDIATE" | "DAILY";
  } = {},
) {
  const preferences = await prisma.notificationPreference.findMany({
    where: {
      shop,
      enabled: true,
      ...(options.channel ? { channel: options.channel } : {}),
      ...(options.frequency
        ? { frequency: options.frequency }
        : options.includeDaily
          ? {}
          : { frequency: "IMMEDIATE" }),
    },
  });
  const message = notificationMessage(type, context);
  const url = appUrl(
    context.actionPath ||
      (context.invoiceId ? `/app/invoices/${context.invoiceId}` : "/app"),
  );
  const results = [];
  for (const preference of preferences) {
    if (!notificationTypeEnabled(preference.notificationTypes, type)) continue;
    const target =
      preference.channel === "EMAIL"
        ? preference.emailAddress
        : preference.webhookUrl;
    if (!target) continue;
    const log = await prisma.notificationLog.create({
      data: { shop, type, target, status: "SENDING" },
    });
    let lastError = "";
    let sent = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await deliver(preference.channel, target, message.subject, message.text, url);
        await prisma.notificationLog.update({
          where: { id: log.id },
          data: {
            status: "SENT",
            deliveryStatus: "DELIVERED",
            sentAt: new Date(),
            attempts: attempt,
            error: null,
          },
        });
        sent = true;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Delivery failed.";
        if (attempt < 3)
          await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }
    if (!sent)
      await prisma.notificationLog.update({
        where: { id: log.id },
        data: {
          status: "FAILED",
          deliveryStatus: "FAILED",
          attempts: 3,
          error: lastError,
        },
      });
    results.push({ channel: preference.channel, target, sent, error: lastError });
  }
  return results;
}

export async function notifySafely(
  type: NotificationType,
  shop: string,
  context: NotificationContext,
) {
  try {
    return await notifyOn(type, shop, context);
  } catch (error) {
    console.error("Notification delivery failed", { type, shop, error });
    return [];
  }
}

export async function sendDailyDigest(shop: string) {
  const [pending, mismatches, syncFailures, exportFailures] = await Promise.all([
    prisma.invoice.count({
      where: { shop, reviewStatus: { not: "APPROVED" } },
    }),
    prisma.invoice.count({
      where: {
        shop,
        reviewStatus: { not: "APPROVED" },
        discrepancySummary: { not: null },
      },
    }),
    prisma.invoice.count({
      where: { shop, cogsSyncStatus: { in: ["FAILED", "PARTIAL"] } },
    }),
    prisma.accountingExport.count({
      where: { shop, status: { in: ["REJECTED", "VERIFY"] } },
    }),
  ]);
  return notifyOn(
    "APPROVAL_REQUIRED",
    shop,
    {
      message: `${pending} invoices pending approval; ${mismatches} have review or PO issues; ${syncFailures} cost syncs and ${exportFailures} exports need attention`,
      actionPath: "/app/invoices",
    },
    { frequency: "DAILY" },
  );
}
