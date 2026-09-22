import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { requireAdmin } from "../utils/rbac.server";
import { requireSubscription } from "./billing.server";
import { roundMoney } from "../utils/invoiceRules";
import {
  createQuickBooksVendorCredit,
  findQuickBooksVendorCredits,
  getOrCreateQuickBooksVendorRef,
  type QuickBooksRef,
} from "../utils/quickbook";
import {
  allocateXeroCreditNote,
  createXeroCreditNote,
  findXeroCreditNotes,
  getOrCreateXeroContact,
} from "../utils/xero";
import {
  getAccountingConnection,
  type LivePlatform,
} from "./accountingConnection.server";
import { fetchAccountingCatalog } from "./accountingCatalog.server";
import { formatForPlatform } from "../utils/accountingFormat";

// The credit memo mirrors the invoice lines it credits so the bookkeeper can
// see exactly which costs came back, rather than one unexplained lump sum.
function creditMemoLines(
  credit: { amount: number; allocation: unknown },
  invoice: { items: { id: string; name: string; sku: string | null; category: string }[] },
) {
  const allocation = credit.allocation as
    | { lines?: { lineId: string; amount: number }[] }
    | null
    | undefined;
  const productLines = invoice.items.filter(
    (item) => item.category === "PRODUCT",
  );
  if (!allocation?.lines?.length || !productLines.length)
    return [
      {
        description: "Supplier credit note",
        amount: roundMoney(credit.amount),
      },
    ];
  const lines = productLines
    .map((item) => ({
      description: item.sku ? `${item.sku} - ${item.name}` : item.name,
      amount:
        allocation.lines!.find((entry) => entry.lineId === item.id)?.amount ?? 0,
    }))
    .filter((line) => line.amount > 0);
  const allocated = roundMoney(lines.reduce((sum, line) => sum + line.amount, 0));
  if (lines.length && Math.abs(allocated - credit.amount) > 0.011)
    lines.push({
      description: "Unallocated credit balance",
      amount: roundMoney(credit.amount - allocated),
    });
  return lines.length
    ? lines
    : [
        {
          description: "Supplier credit note",
          amount: roundMoney(credit.amount),
        },
      ];
}

export async function exportCreditNoteToAccounting(
  request: Request,
  creditNoteId: string,
  platform: LivePlatform,
) {
  const { session, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const credit = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, shop: session.shop },
    include: {
      vendor: true,
      invoice: { include: { items: true, exports: true } },
    },
  });
  if (!credit) throw new Error("Credit note not found.");
  if (credit.accountingReference)
    return {
      success: true,
      platform,
      remoteId: credit.accountingReference,
      alreadyPosted: true,
      document: credit.invoice
        ? formatForPlatform(credit.invoice, "CSV")
        : null,
    };
  if (["PENDING", "MATCHED"].includes(credit.status))
    throw new Error(
      "Match and approve this credit note before posting it to accounting.",
    );
  if (credit.status === "VOID")
    throw new Error("A voided credit note cannot be posted.");
  const invoice = credit.invoice;
  if (!invoice)
    throw new Error(
      "Match this credit note to the invoice it credits before posting it.",
    );
  if (invoice.accountingStatus !== "EXPORTED")
    throw new Error(
      "Export the original invoice first so the credit can be posted against its bill.",
    );
  if (!credit.vendor)
    throw new Error("This credit note has no supplier.");
  if (!credit.creditNoteNumber)
    throw new Error("Enter the credit note number before posting it.");

  const connection = await getAccountingConnection(session.shop, platform);
  const catalog = await fetchAccountingCatalog(connection);
  const lines = creditMemoLines(credit, invoice);
  const requestKey = credit.accountingRequestKey || randomUUID();
  const reference = invoice.invoiceNumber || undefined;
  const originalExport = invoice.exports.find(
    (entry) => entry.platform === platform && entry.status === "EXPORTED",
  );
  if (!originalExport?.remoteId)
    throw new Error(
      `The original ${platform} bill reference is missing. Verify the invoice export before posting its credit.`,
    );
  const originalPayload = originalExport.payload as any;

  const claim = await prisma.creditNote.updateMany({
    where: {
      id: creditNoteId,
      shop: session.shop,
      accountingReference: null,
      accountingStatus: { in: ["NOT_POSTED", "FAILED", "VERIFY"] },
    },
    data: {
      accountingStatus: "SENDING",
      accountingRequestKey: requestKey,
      accountingError: null,
    },
  });
  if (!claim.count) {
    const latest = await prisma.creditNote.findUnique({
      where: { id: creditNoteId },
    });
    if (latest?.accountingReference)
      return {
        success: true,
        platform,
        remoteId: latest.accountingReference,
        alreadyPosted: true,
        document: formatForPlatform(invoice, "CSV"),
      };
    throw new Error(
      "This credit-note export is already running or needs verification. Reload before retrying.",
    );
  }

  let remoteId = "";
  try {
    if (platform === "XERO") {
      const contact = await getOrCreateXeroContact(
        connection,
        credit.vendor.name,
      );
      const existing = (await findXeroCreditNotes(
        connection,
        credit.creditNoteNumber,
      )).filter(
        (candidate: any) =>
          candidate.Type === "ACCPAYCREDIT" &&
          (candidate.Contact?.ContactID === contact.ContactID ||
            candidate.Contact?.Name === contact.Name),
      );
      if (existing.length > 1)
        throw new Error(
          "Multiple Xero supplier credits use this number. Verify them in Xero before retrying.",
        );
      if (existing[0]?.CreditNoteID) {
        remoteId = String(existing[0].CreditNoteID);
      } else {
      const response = await createXeroCreditNote(
        connection,
        {
          Type: "ACCPAYCREDIT",
          Contact: contact,
          Date: (credit.dateIssued || credit.createdAt).toISOString().slice(0, 10),
          CreditNoteNumber: credit.creditNoteNumber,
          Reference: reference,
          CurrencyCode: credit.currency,
          Status: "AUTHORISED",
          LineAmountTypes: "Exclusive",
          ...(catalog.homeCurrency !== credit.currency && invoice.fxRate
            ? { CurrencyRate: Number((1 / invoice.fxRate).toFixed(6)) }
            : {}),
          LineItems: lines.map((line) => ({
            Description: line.description,
            Quantity: 1,
            UnitAmount: line.amount,
            LineAmount: line.amount,
            AccountCode:
              originalPayload?.LineItems?.[0]?.AccountCode ||
              catalog.accounts[0]?.id ||
              "300",
          })),
        },
        requestKey,
      );
      const created = response.CreditNotes?.[0];
      if (
        !created?.CreditNoteID ||
        created.HasErrors ||
        created.ValidationErrors?.length
      )
        throw new Error(
          (created?.ValidationErrors || [])
            .map((error: { Message: string }) => error.Message)
            .join(" ") || "Xero rejected this credit note.",
        );
      remoteId = String(created.CreditNoteID);
      }
      const matchedCredit = existing[0];
      const alreadyAllocated = (matchedCredit?.Allocations || []).some(
        (allocation: any) =>
          String(allocation.Invoice?.InvoiceID) === String(originalExport.remoteId),
      );
      if (!alreadyAllocated)
        await allocateXeroCreditNote(
          connection,
          remoteId,
          originalExport.remoteId,
          credit.amount,
          (credit.dateIssued || credit.createdAt).toISOString().slice(0, 10),
          `${requestKey}-allocation`,
        );
    } else {
      const vendorRef: QuickBooksRef = await getOrCreateQuickBooksVendorRef(
        connection,
        credit.vendor.name,
        credit.currency,
        catalog.multiCurrency,
      );
      const originalAccountRef =
        originalPayload?.Line?.[0]?.AccountBasedExpenseLineDetail?.AccountRef;
      const accountRef = originalAccountRef || (catalog.accounts[0]
        ? { value: catalog.accounts[0].id, name: catalog.accounts[0].name }
        : undefined);
      const existing = (await findQuickBooksVendorCredits(
        connection,
        credit.creditNoteNumber,
      )).filter(
        (candidate: any) =>
          String(candidate.VendorRef?.value) === String(vendorRef.value),
      );
      if (existing.length > 1)
        throw new Error(
          "Multiple QuickBooks vendor credits use this number. Verify them in QuickBooks before retrying.",
        );
      if (existing[0]?.Id) {
        remoteId = String(existing[0].Id);
      } else {
      const response = await createQuickBooksVendorCredit(
        connection,
        {
          VendorRef: vendorRef,
          TxnDate: (credit.dateIssued || credit.createdAt)
            .toISOString()
            .slice(0, 10),
          DocNumber: credit.creditNoteNumber.slice(0, 21),
          PrivateNote: reference ? `Credits invoice ${reference}` : undefined,
          ...(catalog.multiCurrency
            ? { CurrencyRef: { value: credit.currency } }
            : {}),
          ...(catalog.homeCurrency !== credit.currency && invoice.fxRate
            ? { ExchangeRate: invoice.fxRate }
            : {}),
          Line: lines.map((line) => ({
            Amount: line.amount,
            DetailType: "AccountBasedExpenseLineDetail",
            Description: line.description,
            AccountBasedExpenseLineDetail: {
              AccountRef: accountRef || { name: "Cost of Goods Sold" },
              BillableStatus: "NotBillable",
            },
          })),
        },
        requestKey,
      );
      const memo = response.VendorCredit;
      if (!memo?.Id)
        throw new Error("QuickBooks rejected this credit memo.");
      remoteId = String(memo.Id);
      }
    }
  } catch (error) {
    await prisma.creditNote.update({
      where: { id: creditNoteId },
      data: {
        accountingStatus: "VERIFY",
        accountingError:
          error instanceof Error ? error.message.slice(0, 500) : "Export failed",
      },
    });
    throw error;
  }

  await prisma.$transaction([
    prisma.creditNote.update({
      where: { id: creditNoteId },
      data: {
        accountingPlatform: platform,
        accountingReference: remoteId,
        accountingStatus: "POSTED",
        accountingError: null,
        accountedAt: new Date(),
      },
    }),
    prisma.auditEvent.create({
      data: {
        shop: session.shop,
        invoiceId: invoice.id,
        actor,
        action: "CREDIT_NOTE_EXPORTED",
        detail: {
          creditNoteId,
          platform,
          remoteId,
          amount: credit.amount,
          currency: credit.currency,
        },
      },
    }),
  ]);
  return {
    success: true,
    platform,
    remoteId,
    document: formatForPlatform(invoice, "CSV"),
  };
}
