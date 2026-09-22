import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalRequirementsComplete,
  matchingApprovalRules,
  roleCanApprove,
} from "../utils/approvalRules";
import {
  notificationMessage,
  notificationTypeEnabled,
  validateNotificationTarget,
} from "../services/notifications.server";
import {
  aggregateReporting,
  reportingCsv,
  type ReportingInvoice,
} from "../services/reportingAggregation.server";
import { calculateFxRevaluation } from "../services/fxRevaluation.server";
import { parseInvoiceText } from "../utils/parser.server";
import { allocateCredit } from "../utils/creditNotes";

const rules = [
  {
    id: "low",
    name: "Default: under 500",
    invoiceAmountMin: null,
    invoiceAmountMax: 499.999999,
    supplierId: null,
    requiredApprovers: 1,
    approverRoles: ["SCANNER"],
    escalateIfUnresolvedDays: 3,
    active: true,
  },
  {
    id: "high",
    name: "Default: over 5000",
    invoiceAmountMin: 5000.000001,
    invoiceAmountMax: null,
    supplierId: null,
    requiredApprovers: 2,
    approverRoles: ["APPROVER"],
    escalateIfUnresolvedDays: 3,
    active: true,
  },
  {
    id: "mismatch",
    name: "Default: PO mismatch",
    invoiceAmountMin: null,
    invoiceAmountMax: null,
    supplierId: null,
    requiredApprovers: 1,
    approverRoles: ["ADMIN"],
    escalateIfUnresolvedDays: 3,
    active: true,
  },
];

test("approval thresholds require distinct approvers and PO mismatch approval", () => {
  const matched = matchingApprovalRules(rules, {
    total: 8000,
    supplierId: "supplier-1",
    hasPoMismatch: true,
  });
  assert.deepEqual(matched.map((rule) => rule.id), ["high", "mismatch"]);
  assert.equal(
    approvalRequirementsComplete(matched, [
      { approvalRuleId: "high", approverId: "one", status: "APPROVED" },
      { approvalRuleId: "high", approverId: "two", status: "APPROVED" },
      { approvalRuleId: "mismatch", approverId: "admin", status: "APPROVED" },
    ]),
    true,
  );
  assert.equal(
    approvalRequirementsComplete(matched, [
      { approvalRuleId: "high", approverId: "one", status: "APPROVED" },
      { approvalRuleId: "high", approverId: "one", status: "APPROVED" },
      { approvalRuleId: "mismatch", approverId: "admin", status: "APPROVED" },
    ]),
    false,
  );
  assert.equal(roleCanApprove("ADMIN", ["FINANCE"]), true);
  assert.equal(roleCanApprove("SCANNER", ["APPROVER"]), false);
});

test("notification filtering and content include the actionable invoice details", () => {
  assert.equal(
    notificationTypeEnabled(["INVOICE_UPLOADED"], "INVOICE_UPLOADED"),
    true,
  );
  assert.equal(notificationTypeEnabled([], "INVOICE_UPLOADED"), false);
  const message = notificationMessage("PO_MISMATCH", {
    invoiceNumber: "INV-42",
    supplier: "Acme",
    amount: 500,
    currency: "USD",
    message: "Quantity differs from PO",
  });
  assert.match(message.text, /INV-42.*Acme.*USD 500\.00.*Quantity differs/);
  assert.doesNotThrow(() =>
    validateNotificationTarget("SLACK", "https://hooks.slack.com/services/a/b/c"),
  );
  assert.throws(
    () => validateNotificationTarget("SLACK", "https://example.com/hook"),
    /hooks\.slack\.com/,
  );
});

test("reporting aggregates vendor spend, price variance and margin impact", () => {
  const invoice = (
    id: string,
    date: string,
    total: number,
    price: number,
  ): ReportingInvoice => ({
    id,
    date: new Date(`${date}T00:00:00.000Z`),
    total,
    currency: "USD",
    discrepancySummary: null,
    vendor: { id: "supplier-a", name: "Supplier A" },
    creditNotes: [],
    items: [
      {
        sku: "SKU-123",
        name: "Widget",
        category: "PRODUCT",
        quantity: 100,
        price,
        amount: 100 * price,
      },
    ],
  });
  const report = aggregateReporting([
    invoice("one", "2026-01-01", 1000, 10),
    invoice("two", "2026-02-01", 1100, 11),
  ]);
  assert.equal(report.vendorSpend[0].total, 2100);
  assert.equal(report.vendorSpend[0].invoices, 2);
  assert.equal(report.priceChanges[0].percent, 10);
  assert.equal(report.priceChanges[0].marginImpact, -100);
  assert.match(reportingCsv(report), /Supplier A/);
});

test("FX revaluation flags material rate swings and calculates gain or loss", () => {
  const revaluation = calculateFxRevaluation(1000, 1.1, 1.2);
  assert.equal(revaluation.originalValue, 1100);
  assert.equal(revaluation.currentValue, 1200);
  assert.equal(revaluation.difference, 100);
  assert.equal(revaluation.effect, "LOSS");
  assert.equal(revaluation.material, true);
  assert.equal(calculateFxRevaluation(1000, 1.1, 1.12).material, false);
});

test("credit-note parsing separates the document and partial allocations reconcile", () => {
  const parsed = parseInvoiceText(`
    Supplier: Acme Packaging
    CREDIT NOTE
    Credit Note No: CN-100
    Original Invoice No: INV-42
    Date: 2026-09-01
    Description Qty Rate Amount
    Returned cartons 2 -10.00 -20.00
    Total USD -20.00
  `);
  assert.equal(parsed.isCreditDocument, true);
  assert.equal(parsed.creditNoteNumber, "CN-100");
  assert.equal(parsed.originalInvoiceNumber, "INV-42");
  const allocation = allocateCredit(
    [
      { id: "one", value: 60 },
      { id: "two", value: 40 },
    ],
    25,
  );
  assert.equal(allocation.allocatedTotal, 25);
  assert.deepEqual(allocation.allocations.map((entry) => entry.amount), [15, 10]);
});
