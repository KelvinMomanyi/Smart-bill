import prisma from "../db.server";
import type { Prisma } from "@prisma/client";
import { requireAdmin } from "../utils/rbac.server";
import { requireSubscription } from "./billing.server";
import {
  assertApproved,
  invoiceIssues,
  normalizedKey,
} from "../utils/invoiceRules";
import { lockInvoice } from "./invoiceLock.server";
import {
  createQuickBooksBill,
  readQuickBooksBill,
  getOrCreateQuickBooksVendorRef,
  refreshQuickBooksToken,
} from "../utils/quickbook";
import { refreshXeroToken } from "../utils/xero";

import {
  formatForPlatform,
  type AccountingPlatform,
} from "../utils/accountingFormat";
export { formatForPlatform } from "../utils/accountingFormat";
export type { AccountingPlatform } from "../utils/accountingFormat";
type ExportMode = "CSV_PACKAGE" | "LIVE_SYNC";

async function readErrorBody(response: Response) {
  const text = await response.text();
  return text.slice(0, 500);
}

async function refreshConnectionIfNeeded(connection: any) {
  const isExpired =
    connection.expiresAt &&
    new Date(connection.expiresAt).getTime() <= Date.now();

  if (!isExpired || !connection.refreshToken) return connection;

  const token =
    connection.platform === "XERO"
      ? await refreshXeroToken(connection.refreshToken)
      : await refreshQuickBooksToken(connection.refreshToken);

  return prisma.accountingConnection.update({
    where: {
      shop_platform: {
        shop: connection.shop,
        platform: connection.platform,
      },
    },
    data: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || connection.refreshToken,
      scopes: token.scope || connection.scopes,
      expiresAt: token.expires_in
        ? new Date(Date.now() + Math.max(0, token.expires_in - 60) * 1000)
        : connection.expiresAt,
    },
  });
}

async function getInvoice(shop: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, shop },
    include: { vendor: true, items: true, purchaseOrder: true },
  });

  if (!invoice) throw new Error("Invoice not found");
  return invoice;
}

export async function getInvoiceAccountingPayload(
  shop: string,
  invoiceId: string,
  platform: AccountingPlatform,
) {
  const invoice = await getInvoice(shop, invoiceId);

  return formatForPlatform(invoice, platform);
}

async function postToXero(connection: any, payload: any, requestKey: string) {
  if (!connection.tenantId) throw new Error("Xero tenant is missing");

  const response = await fetch("https://api.xero.com/api.xro/2.0/Invoices", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      "xero-tenant-id": connection.tenantId,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": requestKey,
    },
    body: JSON.stringify({ Invoices: [payload] }),
  });

  if (!response.ok) {
    throw new Error(
      `Xero export failed: ${response.status} ${await readErrorBody(response)}`,
    );
  }

  return response.json();
}

async function postToQuickBooks(
  connection: any,
  payload: any,
  requestKey: string,
) {
  return createQuickBooksBill(connection, payload, requestKey);
}

// Recovery only reads an existing bill. It never creates another remote document.
export async function verifyAccountingExport(
  request: Request,
  invoiceId: string,
  platform: "XERO" | "QUICKBOOKS",
  remoteId: string,
) {
  const { session, actor } = await requireAdmin(request);
  await requireSubscription(request);
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(remoteId))
    throw new Error("Enter the existing bill ID from your accounting system.");
  const invoice = await getInvoice(session.shop, invoiceId);
  assertApproved(invoice);
  const entry = await prisma.accountingExport.findFirst({
    where: { shop: session.shop, invoiceId, platform },
  });
  if (!entry || !["VERIFY", "SENDING"].includes(entry.status))
    throw new Error("There is no incomplete export to verify.");
  if (entry.remoteId && entry.remoteId !== remoteId)
    throw new Error(
      "Verify the bill ID already recorded in this invoice's history.",
    );
  if (
    entry.status === "SENDING" &&
    entry.attemptedAt &&
    Date.now() - entry.attemptedAt.getTime() < 120000
  )
    throw new Error(
      "The export may still be running. Allow two minutes before checking its result.",
    );
  const stored = await prisma.accountingConnection.findUnique({
    where: { shop_platform: { shop: session.shop, platform } },
  });
  if (!stored)
    throw new Error(
      "Reconnect the same accounting organisation before verifying its bill.",
    );
  const connection = await refreshConnectionIfNeeded(stored);
  let bill: any;
  if (platform === "XERO") {
    if (!connection.tenantId) throw new Error("Xero tenant is missing.");
    const response = await fetch(
      `https://api.xero.com/api.xro/2.0/Invoices/${encodeURIComponent(remoteId)}`,
      {
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          "xero-tenant-id": connection.tenantId,
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) throw new Error("Xero could not retrieve that bill.");
    bill = (await response.json()).Invoices?.[0];
  } else bill = (await readQuickBooksBill(connection, remoteId)).Bill;
  const expected = entry.payload as any;
  const matches =
    platform === "XERO"
      ? bill?.Type === "ACCPAY" &&
        bill.InvoiceNumber === invoice.invoiceNumber &&
        bill.CurrencyCode === invoice.currency &&
        normalizedKey(bill.Contact?.Name || "") ===
          normalizedKey(invoice.vendor?.name || "") &&
        Math.abs(Number(bill.Total) - invoice.total) <= 0.011 &&
        !["VOIDED", "DELETED"].includes(bill.Status)
      : bill?.DocNumber === invoice.invoiceNumber &&
        bill.CurrencyRef?.value === invoice.currency &&
        String(bill.VendorRef?.value) === String(expected?.VendorRef?.value) &&
        Math.abs(Number(bill.TotalAmt) - invoice.total) <= 0.011;
  if (!matches)
    throw new Error(
      "That bill's supplier, number, currency or total does not match. Correct the existing bill in the accounting system, then verify it again.",
    );
  await prisma.$transaction(async (tx) => {
    await lockInvoice(tx, session.shop, invoiceId);
    const other = await tx.accountingExport.findFirst({
      where: {
        shop: session.shop,
        platform,
        remoteId,
        invoiceId: { not: invoiceId },
      },
    });
    if (other) throw new Error("That bill is linked to a different invoice.");
    await tx.accountingExport.update({
      where: { id: entry.id },
      data: { remoteId, status: "EXPORTED", error: null },
    });
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { accountingStatus: "EXPORTED", status: "SYNCED" },
    });
    await tx.auditEvent.create({
      data: {
        shop: session.shop,
        invoiceId,
        actor,
        action: "ACCOUNTING_VERIFIED",
        detail: { platform, remoteId },
      },
    });
  });
}

export async function exportInvoiceToAccounting(
  request: Request,
  invoiceId: string,
  platform: AccountingPlatform,
) {
  const { session, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const shop = session.shop;
  const invoice = await getInvoice(shop, invoiceId);
  assertApproved(invoice);
  const issues = invoiceIssues(invoice);
  if (issues.length) throw new Error(issues.join(" "));
  const settings = await prisma.shopSettings.findUnique({ where: { shop } });
  let payload = formatForPlatform(invoice, platform);
  let mode: ExportMode = "CSV_PACKAGE";
  let remoteResponse: unknown = null;

  if (platform !== "CSV") {
    if (
      invoice.accountingStatus === "EXPORTED" &&
      !(await prisma.accountingExport.count({ where: { shop, invoiceId } }))
    )
      throw new Error(
        "This invoice was exported by an older version. Verify the existing bill in your accounting system; duplicate export is blocked.",
      );
    const storedConnection = await prisma.accountingConnection.findUnique({
      where: { shop_platform: { shop, platform } },
    });

    if (!storedConnection) {
      throw new Error(`Connect ${platform} in Settings before live export.`);
    }

    const connection = await refreshConnectionIfNeeded(storedConnection);
    if (platform === "XERO") {
      if (!settings?.xeroAccountCode || !settings.xeroTaxType)
        throw new Error(
          "Set this store's Xero purchase account and tax type in Settings.",
        );
      if (
        (invoice.tax || 0) > 0 &&
        settings.xeroTaxType.toUpperCase() === "NONE"
      )
        throw new Error(
          "Select a purchase tax type for this taxed invoice in Settings.",
        );
      payload = formatForPlatform(invoice, platform, {
        xeroAccountCode: settings.xeroAccountCode,
        xeroTaxType: settings.xeroTaxType,
      });
    }
    if (platform === "QUICKBOOKS") {
      if (!settings?.quickBooksAccountId)
        throw new Error(
          "Set this store's QuickBooks expense account ID in Settings.",
        );
      if ((invoice.tax || 0) > 0)
        throw new Error(
          "Taxed QuickBooks bills require company-specific purchase-tax setup. Download the reviewed CSV and enter this bill in QuickBooks; SmartBill will not guess its tax treatment.",
        );
      payload = formatForPlatform(invoice, platform, {
        quickBooksVendorRef: await getOrCreateQuickBooksVendorRef(
          connection,
          invoice.vendor?.name || "Unknown Vendor",
        ),
        quickBooksExpenseAccountRef: { value: settings.quickBooksAccountId },
        quickBooksTaxCodeId: settings.quickBooksTaxCodeId || undefined,
      });
    }

    const entry = await prisma.$transaction(async (tx) => {
      const latest = await lockInvoice(tx, shop, invoiceId);
      assertApproved(latest);
      if (latest.revision !== invoice.revision)
        throw new Error(
          "Invoice changed during export preparation. Reload it.",
        );
      const previous = latest.exports.find((e) => e.platform === platform);
      if (previous?.remoteId) return previous;
      if (previous)
        throw new Error(
          "An export was already attempted. Verify its status in the accounting system before another attempt; duplicate bill creation is blocked.",
        );
      return tx.accountingExport.create({
        data: {
          shop,
          invoiceId,
          platform,
          status: "SENDING",
          attemptedAt: new Date(),
          payload: payload as unknown as Prisma.InputJsonValue,
        },
      });
    });
    if (entry.remoteId) {
      if (entry.status !== "EXPORTED")
        throw new Error(
          "The existing remote bill needs verification. Review its total in your accounting system.",
        );
      return {
        success: true,
        platform,
        mode: "LIVE_SYNC" as const,
        payload: entry.payload,
        remoteResponse: { id: entry.remoteId, alreadyExported: true },
      };
    }
    try {
      remoteResponse =
        platform === "XERO"
          ? await postToXero(connection, payload, entry.requestKey)
          : await postToQuickBooks(connection, payload, entry.requestKey);
      const response = remoteResponse as any;
      const bill = platform === "XERO" ? response.Invoices?.[0] : response.Bill;
      const remoteId = platform === "XERO" ? bill?.InvoiceID : bill?.Id;
      if (!remoteId || bill?.HasErrors || bill?.ValidationErrors?.length)
        throw new Error(
          "The accounting provider did not confirm a valid bill.",
        );
      const remoteTotal = Number(
        platform === "XERO" ? bill.Total : bill.TotalAmt,
      );
      const matches =
        Number.isFinite(remoteTotal) &&
        Math.abs(remoteTotal - invoice.total) <= 0.011;
      await prisma.accountingExport.update({
        where: { id: entry.id },
        data: {
          remoteId: String(remoteId),
          status: matches ? "EXPORTED" : "VERIFY",
          error: matches
            ? null
            : "The provider returned a different total. Review the remote bill; creating another copy is blocked.",
        },
      });
      if (!matches)
        throw new Error(
          "The accounting provider returned a different total. Verify the existing remote bill.",
        );
      await prisma.auditEvent.create({
        data: {
          shop,
          invoiceId,
          actor,
          action: "ACCOUNTING_EXPORTED",
          detail: { platform, remoteId: String(remoteId) },
        },
      });
    } catch (error) {
      await prisma.accountingExport.updateMany({
        where: { id: entry.id, status: "SENDING" },
        data: {
          status: "VERIFY",
          error:
            "Export outcome needs verification in the accounting system. Do not create a second bill.",
        },
      });
      throw error;
    }
    mode = "LIVE_SYNC";
  }

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      accountingStatus:
        platform === "CSV" ? invoice.accountingStatus : "EXPORTED",
      status: platform === "CSV" ? "PENDING_SYNC" : "SYNCED",
    },
  });

  return { success: true, platform, mode, payload, remoteResponse };
}
