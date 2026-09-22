import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { requireAdmin, requireFinanceAccess } from "../utils/rbac.server";
import { requireSubscription } from "./billing.server";
import { lockInvoice } from "./invoiceLock.server";
import { normalizedKey, roundMoney } from "../utils/invoiceRules";
import {
  allocateCredit,
  creditNoteIssues,
  creditNoteSignals,
  detectCreditReason,
  isCreditReason,
  type CreditSignals,
} from "../utils/creditNotes";
import { isChargeLine, lineValue } from "../utils/landedCost";

export type CreditLine = {
  id: string;
  name: string;
  quantity: number;
  price: number;
  amount?: number | null;
  category?: string | null;
};

export type CreditRow = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  allocation?: unknown;
};

// Credits only ever reduce product cost, never a freight or duty line: those
// are already spread across the product lines as landed cost.
export function creditableLines(items: CreditLine[]) {
  return items
    .filter((item) => !isChargeLine(item))
    .map((item) => ({
      id: item.id,
      name: item.name,
      value: lineValue(item),
    }));
}

function live(status: string) {
  return status === "APPROVED" || status === "APPLIED";
}

// Splits every live credit across the invoice's product lines so the sync can
// reduce each line's cost instead of guessing at a single net figure.
export function creditByLine(
  credits: CreditRow[],
  items: CreditLine[],
  includeMatched = false,
) {
  const lines = creditableLines(items);
  const valueOf: Record<string, number> = Object.fromEntries(
    lines.map((line) => [line.id, line.value]),
  );
  const byLine: Record<string, number> = {};
  const warnings: string[] = [];
  let total = 0;

  for (const credit of credits) {
    if (!live(credit.status) && !(includeMatched && credit.status === "MATCHED"))
      continue;
    total = roundMoney(total + Number(credit.amount || 0));
    const allocation = credit.allocation as
      | { method?: string; lines?: { lineId: string; amount: number }[] }
      | null
      | undefined;
    let entries: { lineId: string; amount: number }[];
    if (allocation?.method === "MANUAL" && Array.isArray(allocation.lines)) {
      entries = lines.map((line) => ({
        lineId: line.id,
        amount: Number(
          allocation.lines!.find((entry) => entry.lineId === line.id)?.amount ??
            0,
        ),
      }));
      const manualTotal = roundMoney(
        entries.reduce((sum, entry) => sum + entry.amount, 0),
      );
      if (Math.abs(manualTotal - Number(credit.amount)) > 0.011) {
        warnings.push(
          "A manually allocated credit note no longer matches the invoice lines. Re-allocate it before syncing costs.",
        );
        continue;
      }
    } else {
      if (!lines.length) continue;
      entries = allocateCredit(lines, Number(credit.amount)).allocations;
    }
    for (const entry of entries) {
      if (!Number.isFinite(entry.amount) || entry.amount <= 0) continue;
      byLine[entry.lineId] = roundMoney((byLine[entry.lineId] || 0) + entry.amount);
    }
  }

  for (const [lineId, amount] of Object.entries(byLine)) {
    const cap = valueOf[lineId] ?? 0;
    if (amount > cap + 0.011)
      warnings.push(
        `Credits applied to ${lineId} exceed that line's value. The line cost is floored at zero, so the extra credit is not reflected in Shopify.`,
      );
  }

  return {
    byLine,
    total,
    warnings,
    lines,
  };
}

export async function listCreditNotes(
  shop: string,
  filter: { status?: string; invoiceId?: string } = {},
) {
  return prisma.creditNote.findMany({
    where: {
      shop,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.invoiceId ? { invoiceId: filter.invoiceId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
}

export async function liveCreditsForInvoice(shop: string, invoiceId: string) {
  return prisma.creditNote.findMany({
    where: { shop, invoiceId, status: { in: ["APPROVED", "APPLIED"] } },
    orderBy: { createdAt: "asc" },
  });
}

export async function findInvoiceForCredit(
  shop: string,
  originalInvoiceNumber?: string | null,
  vendorId?: string | null,
) {
  const number = String(originalInvoiceNumber || "").trim();
  if (!number) return null;
  const invoices = await prisma.invoice.findMany({
    where: {
      shop,
      invoiceNumber: { equals: number, mode: "insensitive" },
      ...(vendorId ? { vendorId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 2,
  });
  return invoices.length === 1 ? invoices[0] : null;
}

export async function invalidateInvoiceForCredit(
  tx: Prisma.TransactionClient,
  shop: string,
  invoiceId: string,
) {
  const invoice = await lockInvoice(tx, shop, invoiceId);
  if (
    ["SYNCING", "SYNCED", "PARTIAL"].includes(invoice.cogsSyncStatus) ||
    invoice.costChanges.some((change) => change.status !== "PLANNED")
  )
    throw new Error(
      "This invoice already changed Shopify costs. Restore those costs before changing its credit notes.",
    );
  await tx.costChange.deleteMany({
    where: { invoiceId, status: "PLANNED" },
  });
  await tx.approval.deleteMany({ where: { invoiceId } });
  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      reviewStatus: "PENDING_REVIEW",
      approvedAt: null,
      approvedBy: null,
      cogsSyncStatus: "NOT_REQUESTED",
      revision: { increment: 1 },
    },
  });
  return invoice;
}

export type CreditCapture = {
  shop: string;
  actor: string;
  rawText: string;
  storageKey?: string | null;
  filename?: string | null;
  documentHash?: string | null;
  amount: number;
  currency: string;
  creditNoteNumber?: string | null;
  originalInvoiceNumber?: string | null;
  reason?: string | null;
  dateIssued?: string | null;
  dateReceived?: string | null;
  vendorName?: string | null;
  note?: string | null;
  items?: {
    description: string;
    quantity: number;
    unitPrice: number;
    lineAmount: number;
    originalLineId?: string | null;
  }[];
};

// Records a credit note. Matching to the original invoice is attempted with the
// number printed on the document; anything ambiguous stays PENDING for a human.
export async function captureCreditNote(input: CreditCapture) {
  const reason = isCreditReason(input.reason)
    ? input.reason
    : detectCreditReason({ rawText: input.rawText });
  const issues = creditNoteIssues({
    creditNoteNumber: input.creditNoteNumber,
    originalInvoiceNumber: input.originalInvoiceNumber,
    amount: input.amount,
    currency: input.currency,
    reason,
    dateIssued: input.dateIssued,
  });
  const hardIssues = issues.filter(
    (issue) => !/relates to so the credit can be matched/.test(issue),
  );
  if (hardIssues.length) throw new Error(hardIssues.join(" "));

  const vendorName = input.vendorName?.trim() || null;
  const vendor = vendorName
    ? await prisma.vendor.findFirst({
        where: { shop: input.shop, name: { equals: vendorName, mode: "insensitive" } },
      })
    : null;
  const matched = await findInvoiceForCredit(
    input.shop,
    input.originalInvoiceNumber,
    vendor?.id,
  );

  return prisma.$transaction(async (tx) => {
    if (matched)
      await invalidateInvoiceForCredit(tx, input.shop, matched.id);
    return tx.creditNote.create({
      data: {
        shop: input.shop,
        vendorId: vendor?.id || null,
        invoiceId: matched?.id || null,
        creditNoteNumber: input.creditNoteNumber?.trim() || null,
        originalInvoiceNumber: input.originalInvoiceNumber?.trim() || null,
        amount: roundMoney(input.amount),
        currency: input.currency,
        reason,
        status: matched ? "MATCHED" : "PENDING",
        dateIssued: input.dateIssued ? new Date(input.dateIssued) : null,
        dateReceived: input.dateReceived ? new Date(input.dateReceived) : null,
        documentHash: input.documentHash || null,
        storageKey: input.storageKey || null,
        sourceFilename: input.filename || null,
        rawText: input.rawText?.slice(0, 200000) || null,
        allocation: { method: "PRO_RATA" },
        actor: input.actor,
        lines: input.items?.length
          ? {
              create: input.items.map((item) => ({
                description: item.description,
                quantity: Math.abs(item.quantity),
                unitPrice: Math.abs(item.unitPrice),
                lineAmount: Math.abs(item.lineAmount),
                originalLineId: item.originalLineId || null,
              })),
            }
          : undefined,
        allocations: matched
          ? {
              create: {
                targetInvoiceId: matched.id,
                allocatedAmount: roundMoney(input.amount),
                allocationReason: "Matched by original invoice number",
              },
            }
          : undefined,
      },
    });
  });
}

export function creditSignalsFor(parsed: {
  rawText?: string | null;
  invoiceNumber?: string | null;
  total?: number | null;
  items?: { name: string; quantity?: number | null; price?: number | null; amount?: number | null }[];
}): ReturnType<typeof creditNoteSignals> {
  const input: CreditSignals = {
    rawText: parsed.rawText,
    invoiceNumber: parsed.invoiceNumber,
    total: parsed.total,
    items: parsed.items,
  };
  return creditNoteSignals(input);
}

export async function matchCreditNote(
  request: Request,
  creditNoteId: string,
  invoiceId: string,
  manual?: Record<string, number | null | undefined> | null,
) {
  const { session, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const credit = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, shop: session.shop },
  });
  if (!credit) throw new Error("Credit note not found.");
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, shop: session.shop },
    include: { items: true },
  });
  if (!invoice) throw new Error("Invoice not found.");
  if (invoice.currency !== credit.currency)
    throw new Error(
      `This credit note is in ${credit.currency} but the invoice is in ${invoice.currency}. Match documents in the same currency.`,
    );
  const lines = creditableLines(invoice.items);
  if (!lines.length)
    throw new Error("Add a product line to the invoice before matching a credit.");
  const allocation =
    manual && Object.keys(manual).length
      ? {
          method: "MANUAL",
          lines: allocateCredit(lines, credit.amount, manual).allocations,
        }
      : { method: "PRO_RATA" };
  await prisma.$transaction(async (tx) => {
    await invalidateInvoiceForCredit(tx, session.shop, invoiceId);
    await tx.creditNote.update({
      where: { id: creditNoteId },
      data: {
        invoiceId,
        status: credit.status === "APPLIED" ? "APPLIED" : "MATCHED",
        allocation,
      },
    });
    await tx.creditNoteAllocation.deleteMany({ where: { creditNoteId } });
    await tx.creditNoteAllocation.create({
      data: {
        creditNoteId,
        targetInvoiceId: invoiceId,
        allocatedAmount: credit.amount,
        allocationReason: "Merchant-confirmed invoice match",
      },
    });
    await tx.auditEvent.create({
      data: {
        shop: session.shop,
        invoiceId,
        actor,
        action: "CREDIT_NOTE_MATCHED",
        detail: {
          creditNoteId,
          creditNoteNumber: credit.creditNoteNumber,
          amount: credit.amount,
          method: allocation.method,
        },
      },
    });
  });
}

export async function setCreditNoteAllocation(
  request: Request,
  creditNoteId: string,
  method: "PRO_RATA" | "MANUAL",
  manual: Record<string, number | null | undefined> = {},
) {
  const { session, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const credit = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, shop: session.shop },
    include: { invoice: { include: { items: true } } },
  });
  if (!credit) throw new Error("Credit note not found.");
  if (!credit.invoice)
    throw new Error("Match this credit note to an invoice before allocating it.");
  if (["APPLIED", "VOID"].includes(credit.status))
    throw new Error("This credit note can no longer be re-allocated.");
  const lines = creditableLines(credit.invoice.items);
  const allocation =
    method === "MANUAL"
      ? {
          method,
          lines: allocateCredit(lines, credit.amount, manual).allocations,
        }
      : { method: "PRO_RATA" };
  const preview = creditByLine(
    [{ ...credit, status: "APPROVED", allocation }],
    credit.invoice.items,
  );
  if (preview.warnings.length) throw new Error(preview.warnings.join(" "));
  await prisma.$transaction(async (tx) => {
    await invalidateInvoiceForCredit(tx, session.shop, credit.invoiceId!);
    await tx.creditNote.update({
      where: { id: creditNoteId },
      data: {
        allocation,
        status: "MATCHED",
        approvedAt: null,
        appliedAt: null,
      },
    });
    await tx.creditNoteAllocation.updateMany({
      where: { creditNoteId, targetInvoiceId: credit.invoiceId! },
      data: {
        allocatedAmount: credit.amount,
        allocationDate: new Date(),
        allocationReason:
          method === "MANUAL"
            ? "Merchant-reviewed line allocation"
            : "Allocated by invoice line value",
      },
    });
    await tx.auditEvent.create({
      data: {
        shop: session.shop,
        invoiceId: credit.invoiceId,
        actor,
        action: "CREDIT_NOTE_ALLOCATED",
        detail: { creditNoteId, method },
      },
    });
  });
}

export async function approveCreditNote(
  request: Request,
  creditNoteId: string,
  note = "",
) {
  const { session, actor } = await requireFinanceAccess(request);
  await requireSubscription(request);
  const credit = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, shop: session.shop },
    include: { invoice: { include: { items: true } } },
  });
  if (!credit) throw new Error("Credit note not found.");
  if (!credit.invoiceId)
    throw new Error(
      "Match this credit note to the invoice it relates to before approving it.",
    );
  if (credit.status === "VOID")
    throw new Error("A voided credit note cannot be approved.");
  const preview = creditByLine(
    [{ ...credit, status: "APPROVED" }],
    credit.invoice!.items,
  );
  if (preview.warnings.length) throw new Error(preview.warnings.join(" "));
  await prisma.$transaction(async (tx) => {
    await lockInvoice(tx, session.shop, credit.invoiceId!);
    await tx.creditNote.update({
      where: { id: creditNoteId },
      data: { status: "APPROVED", approvedAt: new Date(), note: note || null },
    });
    await tx.auditEvent.create({
      data: {
        shop: session.shop,
        invoiceId: credit.invoiceId,
        actor,
        action: "CREDIT_NOTE_APPROVED",
        detail: {
          creditNoteId,
          creditNoteNumber: credit.creditNoteNumber,
          amount: credit.amount,
        },
      },
    });
  });
}

export async function voidCreditNote(
  request: Request,
  creditNoteId: string,
  note = "",
) {
  const { session, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const credit = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, shop: session.shop },
  });
  if (!credit) throw new Error("Credit note not found.");
  if (credit.status === "APPLIED")
    throw new Error(
      "This credit has already reduced Shopify costs. Restore the cost history first, then void it.",
    );
  await prisma.$transaction(async (tx) => {
    if (credit.invoiceId)
      await invalidateInvoiceForCredit(tx, session.shop, credit.invoiceId);
    await tx.creditNote.update({
      where: { id: creditNoteId },
      data: { status: "VOID", invoiceId: null, note: note || null },
    });
    await tx.creditNoteAllocation.deleteMany({ where: { creditNoteId } });
    await tx.auditEvent.create({
      data: {
        shop: session.shop,
        invoiceId: credit.invoiceId,
        actor,
        action: "CREDIT_NOTE_VOIDED",
        detail: { creditNoteId, reason: note },
      },
    });
  });
}

export async function unmatchCreditNote(request: Request, creditNoteId: string) {
  const { session, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const credit = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, shop: session.shop },
  });
  if (!credit) throw new Error("Credit note not found.");
  if (credit.status === "APPLIED")
    throw new Error(
      "This credit has already reduced Shopify costs and cannot be unmatched.",
    );
  await prisma.$transaction(async (tx) => {
    if (credit.invoiceId)
      await invalidateInvoiceForCredit(tx, session.shop, credit.invoiceId);
    await tx.creditNote.update({
      where: { id: creditNoteId },
      data: { status: "PENDING", invoiceId: null, approvedAt: null },
    });
    await tx.creditNoteAllocation.deleteMany({ where: { creditNoteId } });
    await tx.auditEvent.create({
      data: {
        shop: session.shop,
        invoiceId: credit.invoiceId,
        actor,
        action: "CREDIT_NOTE_UNMATCHED",
        detail: { creditNoteId },
      },
    });
  });
}

// Called inside the cost-sync transaction once every planned change applied.
export async function markCreditsApplied(
  tx: Pick<Prisma.TransactionClient, "creditNote">,
  shop: string,
  invoiceId: string,
) {
  return tx.creditNote.updateMany({
    where: { shop, invoiceId, status: "APPROVED" },
    data: { status: "APPLIED", appliedAt: new Date() },
  });
}

export function creditVendorKey(name: string) {
  return normalizedKey(name);
}
