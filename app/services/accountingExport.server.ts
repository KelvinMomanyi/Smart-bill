import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import type { Prisma } from "@prisma/client";
import {
  assertApproved,
  invoiceIssues,
  normalizedKey,
} from "../utils/invoiceRules";
import { lockInvoice } from "./invoiceLock.server";
import {
  createQuickBooksBill,
  readQuickBooksBill,
  findQuickBooksBills,
  getOrCreateQuickBooksVendorRef,
} from "../utils/quickbook";
import {
  createXeroBill,
  findXeroBills,
  getOrCreateXeroContact,
  xeroRequest,
} from "../utils/xero";
import {
  formatForPlatform,
  type AccountingPlatform,
} from "../utils/accountingFormat";
import {
  validateBillMapping,
  type BillMapping,
} from "../utils/accountingValidation";
import { AccountingApiError } from "../utils/accountingHttp.server";
import {
  accountingCompanyKey,
  getAccountingConnection,
  type LivePlatform,
} from "./accountingConnection.server";
import { fetchAccountingCatalog } from "./accountingCatalog.server";
import {
  billMatchesInvoice,
  assertExportCompany,
  exportDisposition,
} from "../utils/accountingExportPolicy";
export { formatForPlatform } from "../utils/accountingFormat";
export type { AccountingPlatform } from "../utils/accountingFormat";
async function authorizeAccounting(request: Request) {
  const [{ requireAdmin }, { requireSubscription }] = await Promise.all([
    import("../utils/rbac.server"),
    import("./billing.server"),
  ]);
  const context = await requireAdmin(request);
  await requireSubscription(request);
  return context;
}

async function getInvoice(shop: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, shop },
    include: { vendor: true, items: true, purchaseOrder: true, exports: true },
  });
  if (!invoice) throw new Error("Invoice not found.");
  return invoice;
}
export async function getInvoiceAccountingPayload(
  shop: string,
  invoiceId: string,
  platform: AccountingPlatform,
) {
  return formatForPlatform(await getInvoice(shop, invoiceId), platform);
}
async function finishExport(
  entryId: string,
  shop: string,
  invoiceId: string,
  actor: string,
  platform: LivePlatform,
  remoteId: string,
  companyKey: string,
  verified = false,
) {
  await prisma.$transaction(async (tx) => {
    await lockInvoice(tx, shop, invoiceId);
    const entry = await tx.accountingExport.findUniqueOrThrow({
      where: { id: entryId },
    });
    assertExportCompany(entry.companyKey, companyKey);
    if (entry.status === "EXPORTED") return;
    const other = await tx.accountingExport.findFirst({
      where: {
        shop,
        platform,
        remoteId,
        companyKey,
        invoiceId: { not: invoiceId },
      },
    });
    if (other)
      throw new Error(
        "That bill is already linked to another SmartBill invoice.",
      );
    await tx.accountingExport.update({
      where: { id: entryId },
      data: { remoteId, status: "EXPORTED", error: null, companyKey },
    });
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { accountingStatus: "EXPORTED", status: "SYNCED" },
    });
    await tx.auditEvent.create({
      data: {
        shop,
        invoiceId,
        actor,
        action: verified ? "ACCOUNTING_VERIFIED" : "ACCOUNTING_EXPORTED",
        detail: { platform, remoteId, companyKey },
      },
    });
  });
}
async function remoteCandidates(
  connection: Awaited<ReturnType<typeof getAccountingConnection>>,
  invoice: any,
  payload: any,
) {
  const bills =
    connection.platform === "XERO"
      ? await findXeroBills(connection, invoice.invoiceNumber)
      : await findQuickBooksBills(connection, invoice.invoiceNumber);
  // A same-number bill from another supplier is a different document.
  return bills.filter((bill: any) =>
    connection.platform === "XERO"
      ? bill.Type === "ACCPAY" &&
        !["VOIDED", "DELETED"].includes(bill.Status) &&
        (bill.Contact?.ContactID === payload.Contact?.ContactID ||
          normalizedKey(bill.Contact?.Name || "") ===
            normalizedKey(invoice.vendor?.name || ""))
      : String(bill.VendorRef?.value) === String(payload.VendorRef?.value),
  );
}
export async function exportInvoiceToAccounting(
  request: Request,
  invoiceId: string,
  platform: AccountingPlatform,
) {
  const { session, actor } = await authorizeAccounting(request);
  return exportApprovedInvoice({
    shop: session.shop,
    actor,
    invoiceId,
    platform,
  });
}
// Internal entry point: callers must authorize the shop and subscription first.
export async function exportApprovedInvoice({
  shop,
  actor,
  invoiceId,
  platform,
}: {
  shop: string;
  actor: string;
  invoiceId: string;
  platform: AccountingPlatform;
}) {
  const invoice = await getInvoice(shop, invoiceId);
  assertApproved(invoice);
  const issues = invoiceIssues(invoice);
  if (issues.length) throw new Error(issues.join(" "));
  if (platform === "CSV")
    return {
      success: true,
      platform,
      mode: "CSV_PACKAGE",
      payload: formatForPlatform(invoice, platform),
      remoteResponse: null,
    };
  const previous = invoice.exports.find((e) => e.platform === platform);
  const disposition = exportDisposition(previous);
  if (disposition === "DONE")
    return {
      success: true,
      platform,
      mode: "LIVE_SYNC",
      payload: previous!.payload,
      remoteResponse: { id: previous!.remoteId, alreadyExported: true },
    };
  if (invoice.accountingStatus === "EXPORTED" && !invoice.exports.length)
    throw new Error(
      "An older version exported this invoice. Check the original bill; creating another copy is blocked.",
    );
  const connection = await getAccountingConnection(shop, platform);
  const companyKey = accountingCompanyKey(connection);
  if (previous) assertExportCompany(previous.companyKey, companyKey);
  const [settings, catalog] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { shop } }),
    fetchAccountingCatalog(connection),
  ]);
  const mapping = (invoice.accountingMapping as any)?.[platform] as
    | BillMapping
    | undefined;
  const validated = validateBillMapping(invoice, settings, catalog, mapping);
  const payload =
    platform === "XERO"
      ? formatForPlatform(invoice, platform, {
          validated,
          xeroContactRef: await getOrCreateXeroContact(
            connection,
            invoice.vendor!.name,
          ),
        })
      : formatForPlatform(invoice, platform, {
          validated,
          quickBooksMultiCurrency: catalog.multiCurrency,
          quickBooksVendorRef: await getOrCreateQuickBooksVendorRef(
            connection,
            invoice.vendor!.name,
            invoice.currency,
            catalog.multiCurrency,
          ),
        });
  const entry = await prisma.$transaction(async (tx) => {
    const latest = await lockInvoice(tx, shop, invoiceId);
    assertApproved(latest);
    if (latest.revision !== invoice.revision)
      throw new Error("Invoice changed during export preparation. Reload it.");
    const current = await tx.accountingConnection.findUnique({
      where: { shop_platform: { shop, platform } },
    });
    if (!current || accountingCompanyKey(current) !== companyKey)
      throw new Error("Accounting company changed. Reload the invoice.");
    const previous = latest.exports.find((e) => e.platform === platform);
    if (exportDisposition(previous) === "DONE") return previous!;
    if (previous) assertExportCompany(previous.companyKey, companyKey);
    const data = {
      status: "SENDING",
      attemptedAt: new Date(),
      error: null,
      companyKey,
      requestKey: randomUUID(),
      payload: payload as Prisma.InputJsonValue,
    };
    return previous
      ? tx.accountingExport.update({ where: { id: previous.id }, data })
      : tx.accountingExport.create({
          data: { shop, invoiceId, platform, ...data },
        });
  });
  if (entry.status === "EXPORTED")
    return {
      success: true,
      platform,
      mode: "LIVE_SYNC",
      payload: entry.payload,
      remoteResponse: { id: entry.remoteId, alreadyExported: true },
    };
  let submitted = false;
  try {
    const duplicates = await remoteCandidates(connection, invoice, payload);
    if (duplicates.length) {
      const id =
        duplicates.length === 1
          ? String(
              platform === "XERO" ? duplicates[0].InvoiceID : duplicates[0].Id,
            )
          : null;
      await prisma.accountingExport.update({
        where: { id: entry.id },
        data: {
          status: "VERIFY",
          remoteId: id,
          error:
            "An existing bill has this supplier and invoice number. Verify it to link the existing bill; no new bill was created.",
        },
      });
      throw new Error(
        "A bill with this supplier and invoice number already exists. Use Verify existing bill in the export history.",
      );
    }
    submitted = true;
    const response =
      platform === "XERO"
        ? await createXeroBill(connection, payload, entry.requestKey)
        : await createQuickBooksBill(connection, payload, entry.requestKey);
    const bill = platform === "XERO" ? response.Invoices?.[0] : response.Bill;
    const remoteId = platform === "XERO" ? bill?.InvoiceID : bill?.Id;
    if (
      !remoteId &&
      (bill?.HasErrors ||
        bill?.HasValidationErrors ||
        bill?.ValidationErrors?.length)
    ) {
      const message = (bill.ValidationErrors || [])
        .map((e: any) => e.Message)
        .join(" ")
        .slice(0, 600);
      throw new AccountingApiError(
        platform,
        400,
        message || "The accounting provider rejected this bill.",
        true,
      );
    }
    if (!remoteId)
      throw new Error(
        "The provider did not confirm a bill ID. Search for the bill in export history before trying again.",
      );
    // Save the remote ID even if later validation or local persistence fails.
    await prisma.accountingExport.update({
      where: { id: entry.id },
      data: { remoteId: String(remoteId) },
    });
    if (
      !billMatchesInvoice(
        platform,
        bill,
        invoice,
        payload,
        catalog.homeCurrency,
      )
    )
      throw new Error(
        "The returned bill's supplier, dates, currency or amounts do not match. Verify the existing bill; creating another copy is blocked.",
      );
    await finishExport(
      entry.id,
      shop,
      invoiceId,
      actor,
      platform,
      String(remoteId),
      companyKey,
    );
    return {
      success: true,
      platform,
      mode: "LIVE_SYNC",
      payload,
      remoteResponse: { id: String(remoteId) },
    };
  } catch (error) {
    const rejected =
      !submitted || (error instanceof AccountingApiError && error.rejected);
    await prisma.accountingExport.updateMany({
      where: { id: entry.id, status: "SENDING", remoteId: null },
      data: {
        status: rejected ? "REJECTED" : "VERIFY",
        error:
          error instanceof Error
            ? error.message
            : "The bill export needs verification.",
      },
    });
    await prisma.accountingExport.updateMany({
      where: { id: entry.id, status: "SENDING", remoteId: { not: null } },
      data: {
        status: "VERIFY",
        error:
          error instanceof Error ? error.message : "Verify the recorded bill.",
      },
    });
    throw error;
  }
}
export async function verifyAccountingExport(
  request: Request,
  invoiceId: string,
  platform: LivePlatform,
  remoteId: string,
) {
  const { session, actor } = await authorizeAccounting(request);
  const invoice = await getInvoice(session.shop, invoiceId);
  assertApproved(invoice);
  const entry = invoice.exports.find((e) => e.platform === platform);
  if (!entry || !["VERIFY", "SENDING"].includes(entry.status))
    throw new Error("There is no incomplete export to verify.");
  if (
    entry.status === "SENDING" &&
    entry.attemptedAt &&
    Date.now() - entry.attemptedAt.getTime() < 120000
  )
    throw new Error(
      "Allow two minutes for the running export to finish before verification.",
    );
  const connection = await getAccountingConnection(session.shop, platform);
  const companyKey = accountingCompanyKey(connection);
  assertExportCompany(entry.companyKey, companyKey);
  const expected = entry.payload as any;
  if (!remoteId) {
    if (entry.remoteId) remoteId = entry.remoteId;
    else {
      const candidates = await remoteCandidates(connection, invoice, expected);
      if (candidates.length !== 1)
        throw new Error(
          candidates.length
            ? "Several bills match. Enter the correct bill ID to verify."
            : "No bill was found yet. Check the accounting company and try again later. No second bill was created.",
        );
      remoteId = String(
        platform === "XERO" ? candidates[0].InvoiceID : candidates[0].Id,
      );
    }
  }
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(remoteId))
    throw new Error("Enter a valid accounting bill ID.");
  if (entry.remoteId && entry.remoteId !== remoteId)
    throw new Error(
      "Verify the bill ID already recorded in the export history.",
    );
  const bill =
    platform === "XERO"
      ? (
          await xeroRequest(
            connection,
            `/Invoices/${encodeURIComponent(remoteId)}`,
          )
        ).Invoices?.[0]
      : (await readQuickBooksBill(connection, remoteId)).Bill;
  const catalog = await fetchAccountingCatalog(connection);
  if (
    !billMatchesInvoice(platform, bill, invoice, expected, catalog.homeCurrency)
  )
    throw new Error(
      "This bill does not match the supplier, number, dates, currency and amounts of the approved invoice. Correct the existing bill in the accounting system, then verify it.",
    );
  await finishExport(
    entry.id,
    session.shop,
    invoiceId,
    actor,
    platform,
    remoteId,
    companyKey,
    true,
  );
}
export async function saveInvoiceAccountingMapping(
  request: Request,
  invoiceId: string,
  platform: LivePlatform,
  form: FormData,
) {
  const { session, actor } = await authorizeAccounting(request);
  const invoice = await getInvoice(session.shop, invoiceId);
  const [settings, catalog] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { shop: session.shop } }),
    fetchAccountingCatalog(
      await getAccountingConnection(session.shop, platform),
    ),
  ]);
  const mapping: BillMapping = {
    companyKey: catalog.companyKey,
    lines: invoice.items.map((item) => ({
      itemId: item.id,
      accountId: String(form.get(`account-${item.id}`) || ""),
      taxCodeId: String(form.get(`tax-${item.id}`) || ""),
    })),
    ...(String(form.get("exchangeRate") || "").trim()
      ? { exchangeRate: Number(form.get("exchangeRate")) }
      : {}),
  };
  validateBillMapping(invoice, settings, catalog, mapping);
  await prisma.$transaction(async (tx) => {
    const latest = await lockInvoice(tx, session.shop, invoiceId);
    if (latest.revision !== Number(form.get("revision")))
      throw new Error("The invoice changed. Reload Accounting details.");
    const previous = latest.exports.find((e) => e.platform === platform);
    if (previous && previous.status !== "REJECTED")
      throw new Error(
        "This invoice already has an export in progress or completed. Its accounting choices are locked.",
      );
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        accountingMapping: {
          ...((latest.accountingMapping as any) || {}),
          [platform]: mapping,
        },
        revision: { increment: 1 },
      },
    });
    await tx.auditEvent.create({
      data: {
        shop: session.shop,
        invoiceId,
        actor,
        action: "ACCOUNTING_MAPPING_UPDATED",
        detail: { platform, companyKey: catalog.companyKey },
      },
    });
  });
}
