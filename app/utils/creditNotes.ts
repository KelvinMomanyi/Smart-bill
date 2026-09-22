import { roundMoney, validCurrency, validDate } from "./invoiceRules";

export const CREDIT_REASONS = [
  "RETURN",
  "OVERCHARGE",
  "DISCOUNT",
  "ALLOWANCE",
  "DAMAGE",
  "OTHER",
] as const;
export type CreditReason = (typeof CREDIT_REASONS)[number];

export const CREDIT_REASON_LABELS: Record<CreditReason, string> = {
  RETURN: "Returned goods",
  OVERCHARGE: "Overcharge",
  DISCOUNT: "Discount",
  ALLOWANCE: "Allowance",
  DAMAGE: "Damage or shortage",
  OTHER: "Other",
};

export const CREDIT_NOTE_STATUSES = [
  "PENDING",
  "MATCHED",
  "APPROVED",
  "APPLIED",
  "VOID",
] as const;
export type CreditNoteStatus = (typeof CREDIT_NOTE_STATUSES)[number];

export const CREDIT_NOTE_STATUS_LABELS: Record<CreditNoteStatus, string> = {
  PENDING: "Awaiting matching",
  MATCHED: "Matched, awaiting approval",
  APPROVED: "Approved, awaiting cost sync",
  APPLIED: "Applied to invoice costs",
  VOID: "Voided",
};

export function isCreditReason(value: unknown): value is CreditReason {
  return (
    typeof value === "string" &&
    (CREDIT_REASONS as readonly string[]).includes(value)
  );
}

export function isCreditNoteStatus(value: unknown): value is CreditNoteStatus {
  return (
    typeof value === "string" &&
    (CREDIT_NOTE_STATUSES as readonly string[]).includes(value)
  );
}

// A credit note is a separate document from an invoice, so detection has to be
// strong enough never to swallow a real invoice that happens to mention
// returns in its terms and conditions.
export type CreditSignals = {
  rawText?: string | null;
  invoiceNumber?: string | null;
  total?: number | null;
  items?: {
    name: string;
    quantity?: number | null;
    price?: number | null;
    amount?: number | null;
  }[];
};

export type CreditSignalResult = {
  detected: boolean;
  score: number;
  reasons: string[];
};

const creditHeading =
  /\b(?:credit\s*(?:note|memo|memorandum|invoice)|credit\s*for\s+return|return\s*authoris?ation|allowance\s*note|adjustment\s*note|refund\s*note|goods?\s*returned\s*note)\b/i;
const creditNumberPrefix = /\b(?:CN|CR|CM|CRN|RMA)[\s._-]*\d/i;
const creditNumberWord = /\b(?:credit|return|refund|rma)\b/i;
const returnLanguage =
  /\b(?:goods?\s+returned|returned\s+goods|short\s*ship(?:ped|ment)?|over\s*-?\s*charg(?:e|ed)|damaged|defective|rebate|allowance)\b/i;

export function creditNoteSignals(input: CreditSignals): CreditSignalResult {
  const text = String(input.rawText || "");
  const number = String(input.invoiceNumber || "").trim();
  const items = input.items || [];
  const reasons: string[] = [];
  let score = 0;

  if (text && creditHeading.test(text)) {
    score += 3;
    reasons.push("The document names itself a credit note or credit memo.");
  }
  if (number && creditNumberPrefix.test(number)) {
    score += 3;
    reasons.push(`The document number "${number}" looks like a credit note.`);
  } else if (number && creditNumberWord.test(number)) {
    score += 3;
    reasons.push(`The document number "${number}" refers to a credit.`);
  }
  if (Number.isFinite(input.total) && Number(input.total) < 0) {
    score += 3;
    reasons.push("The document total is negative.");
  }
  const negativeLines = items.filter(
    (item) =>
      (Number.isFinite(item.amount) && Number(item.amount) < 0) ||
      (Number.isFinite(item.price) && Number(item.price) < 0),
  ).length;
  if (negativeLines) {
    score += 2;
    reasons.push(
      `${negativeLines} line${negativeLines === 1 ? "" : "s"} carry a negative amount.`,
    );
  }
  if (text && returnLanguage.test(text)) {
    score += 1;
    reasons.push("The text mentions returned, damaged or overcharged goods.");
  }

  // A heading alone is not enough: an invoice that happens to print the words
  // "credit note" must not be captured as one. The document needs a second
  // signal, or a negative total that only a credit can produce.
  const negative = Number(input.total) < 0 || negativeLines > 0;
  return { detected: score >= 4 || (score >= 3 && negative), score, reasons };
}

export function detectCreditReason(input: CreditSignals): CreditReason {
  const text = `${input.rawText || ""} ${input.items?.map((i) => i.name).join(" ") || ""}`;
  if (/\b(?:damag|broken|defect|faulty|short\s*ship)/i.test(text))
    return "DAMAGE";
  if (/\b(?:return|rma|goods?\s+sent\s+back)/i.test(text)) return "RETURN";
  if (/\b(?:over\s*-?\s*charg|duplicate|billed\s+twice|incorrect\s+price|price\s+adjust)/i.test(text))
    return "OVERCHARGE";
  if (/\b(?:discount|rebate|settlement\s+discount)/i.test(text)) return "DISCOUNT";
  if (/\b(?:allowance|adjustment|write\s*-?\s*off)/i.test(text)) return "ALLOWANCE";
  return "OTHER";
}

export type CreditNoteDraft = {
  creditNoteNumber?: string | null;
  originalInvoiceNumber?: string | null;
  amount: number;
  currency: string;
  reason: string;
  dateIssued?: string | null;
};

export function creditNoteIssues(credit: CreditNoteDraft) {
  const issues: string[] = [];
  if (!credit.creditNoteNumber?.trim())
    issues.push("Enter the credit note number shown on the document.");
  if (!Number.isFinite(credit.amount) || credit.amount <= 0)
    issues.push("Enter the credit note amount as a positive number.");
  if (!validCurrency(credit.currency))
    issues.push("Select a valid credit note currency.");
  if (!isCreditReason(credit.reason))
    issues.push("Choose why the supplier issued the credit note.");
  if (credit.dateIssued && !validDate(credit.dateIssued))
    issues.push("Enter a valid credit note date.");
  if (!credit.originalInvoiceNumber?.trim())
    issues.push(
      "Enter the invoice number this credit note relates to so the credit can be matched.",
    );
  return issues;
}

export type CreditAllocationLine = {
  id: string;
  value: number;
};

export type CreditAllocation = {
  lineId: string;
  amount: number;
};

export type CreditAllocationResult = {
  allocations: CreditAllocation[];
  allocatedTotal: number;
  warnings: string[];
};

// A credit is spread over the invoice lines it relates to in proportion to
// line value, with the rounding drift pushed onto the largest line so the
// allocation always reconciles with the credit total.
export function allocateCredit(
  lines: CreditAllocationLine[],
  total: number,
  manual?: Record<string, number | null | undefined>,
): CreditAllocationResult {
  const warnings: string[] = [];
  if (!Number.isFinite(total) || total <= 0)
    throw new Error("Enter the credit note amount as a positive number.");
  if (!lines.length) return { allocations: [], allocatedTotal: 0, warnings };

  if (manual) {
    const entries = lines.map((line) => ({
      lineId: line.id,
      amount: Number(manual[line.id] ?? 0),
    }));
    if (entries.some((entry) => !Number.isFinite(entry.amount) || entry.amount < 0))
      throw new Error(
        "Enter a credit amount of zero or greater for every invoice line.",
      );
    const manualTotal = roundMoney(
      entries.reduce((sum, entry) => sum + entry.amount, 0),
    );
    if (Math.abs(manualTotal - total) > 0.011)
      throw new Error(
        `Manual credit amounts total ${manualTotal.toFixed(2)} but the credit note is ${total.toFixed(2)}. Adjust the amounts so they match.`,
      );
    return {
      allocations: entries.map((entry) => ({
        lineId: entry.lineId,
        amount: roundMoney(entry.amount),
      })),
      allocatedTotal: manualTotal,
      warnings,
    };
  }

  let totalValue = lines.reduce(
    (sum, line) => sum + (Number.isFinite(line.value) ? line.value : 0),
    0,
  );
  let evenSplit = false;
  if (totalValue <= 0) {
    evenSplit = true;
    totalValue = lines.length;
  }
  const weights = lines.map((line) =>
    evenSplit ? 1 : Number.isFinite(line.value) ? Math.max(0, line.value) : 0,
  );
  const raw = weights.map((weight) => (weight * total) / totalValue);
  const allocations = raw.map((value, index) => ({
    lineId: lines[index].id,
    amount: roundMoney(value),
  }));
  const drift = roundMoney(
    total - allocations.reduce((sum, item) => sum + item.amount, 0),
  );
  if (drift !== 0) {
    const largest = raw.reduce(
      (best, value, index) => (value > raw[best] ? index : best),
      0,
    );
    allocations[largest].amount = roundMoney(allocations[largest].amount + drift);
  }
  return {
    allocations,
    allocatedTotal: roundMoney(
      allocations.reduce((sum, item) => sum + item.amount, 0),
    ),
    warnings,
  };
}

export function creditAllocationFor(
  allocation: unknown,
  lineId: string,
): number {
  const value = allocation as { lines?: CreditAllocation[] } | null | undefined;
  const match = value?.lines?.find((line) => line?.lineId === lineId);
  return Number.isFinite(match?.amount) ? Number(match!.amount) : 0;
}

export function creditTotals(
  credits: { amount: number; currency: string; status: string }[],
) {
  const live = credits.filter((credit) =>
    ["MATCHED", "APPROVED", "APPLIED"].includes(credit.status),
  );
  const currency = live[0]?.currency || "USD";
  return {
    currency,
    total: roundMoney(live.reduce((sum, credit) => sum + credit.amount, 0)),
    applied: roundMoney(
      live
        .filter((credit) => credit.status === "APPLIED")
        .reduce((sum, credit) => sum + credit.amount, 0),
    ),
    count: live.length,
  };
}