import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "../db.server";
import {
  approvalRequirementsComplete,
  DEFAULT_APPROVAL_RULES,
  matchingApprovalRules,
  normalizeStaffRole,
  roleCanApprove,
  ruleRoles,
  type StaffRole,
} from "../utils/approvalRules";
import { notifySafely } from "./notifications.server";

type DbClient = Prisma.TransactionClient | PrismaClient;

export async function ensureDefaultApprovalRules(shop: string) {
  await Promise.all(
    DEFAULT_APPROVAL_RULES.map((rule) =>
      prisma.approvalRule.upsert({
        where: { shop_name: { shop, name: rule.name } },
        create: { shop, ...rule },
        update: {},
      }),
    ),
  );
}

export async function approvalState(
  db: DbClient,
  invoice: {
    id: string;
    shop: string;
    total: number;
    vendorId: string | null;
    purchaseOrderId: string | null;
    discrepancySummary: string | null;
  },
) {
  const [rules, approvals] = await Promise.all([
    db.approvalRule.findMany({
      where: { shop: invoice.shop, active: true },
      orderBy: { createdAt: "asc" },
    }),
    db.approval.findMany({
      where: { invoiceId: invoice.id },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const requirements = matchingApprovalRules(rules, {
    total: invoice.total,
    supplierId: invoice.vendorId,
    hasPoMismatch: Boolean(
      invoice.purchaseOrderId && invoice.discrepancySummary?.trim(),
    ),
  });
  return {
    requirements,
    approvals,
    complete: approvalRequirementsComplete(requirements, approvals),
  };
}

export async function recordApproval(
  tx: Prisma.TransactionClient,
  input: {
    invoice: {
      id: string;
      shop: string;
      total: number;
      vendorId: string | null;
      purchaseOrderId: string | null;
      discrepancySummary: string | null;
    };
    actor: string;
    sessionId: string;
    role: StaffRole;
    comments?: string;
  },
) {
  const rules = await tx.approvalRule.findMany({
    where: { shop: input.invoice.shop, active: true },
    orderBy: { createdAt: "asc" },
  });
  const requirements = matchingApprovalRules(rules, {
    total: input.invoice.total,
    supplierId: input.invoice.vendorId,
    hasPoMismatch: Boolean(
      input.invoice.purchaseOrderId && input.invoice.discrepancySummary?.trim(),
    ),
  });
  if (!requirements.length)
    throw new Error("No approval rule applies to this invoice.");
  const eligible = requirements.filter((rule) =>
    roleCanApprove(input.role, ruleRoles(rule)),
  );
  if (!eligible.length)
    throw new Error(
      `Your ${input.role.toLowerCase()} role cannot satisfy the pending approval rule.`,
    );
  for (const rule of eligible) {
    const existing = await tx.approval.findFirst({
      where: {
        invoiceId: input.invoice.id,
        approvalRuleId: rule.id,
        OR: [
          { approverId: input.actor },
          { assignedTo: input.sessionId, status: "PENDING" },
        ],
      },
    });
    if (existing?.status === "APPROVED") continue;
    if (existing)
      await tx.approval.update({
        where: { id: existing.id },
        data: {
          status: "APPROVED",
          approverId: input.actor,
          approvedAt: new Date(),
          comments: input.comments?.trim() || null,
          assignedTo: null,
        },
      });
    else
      await tx.approval.create({
        data: {
          invoiceId: input.invoice.id,
          approvalRuleId: rule.id,
          approverId: input.actor,
          status: "APPROVED",
          approvedAt: new Date(),
          comments: input.comments?.trim() || null,
        },
      });
  }
  const approvals = await tx.approval.findMany({
    where: { invoiceId: input.invoice.id },
  });
  return {
    requirements,
    approvals,
    complete: approvalRequirementsComplete(requirements, approvals),
  };
}

export async function delegateApproval(
  shop: string,
  invoiceId: string,
  ruleId: string,
  actor: string,
  targetSessionId: string,
  actorRole: StaffRole,
) {
  const [invoice, rule, target] = await Promise.all([
    prisma.invoice.findFirst({ where: { id: invoiceId, shop } }),
    prisma.approvalRule.findFirst({ where: { id: ruleId, shop, active: true } }),
    prisma.session.findFirst({
      where: { id: targetSessionId, shop, isOnline: true },
      select: { id: true, role: true, accountOwner: true },
    }),
  ]);
  if (!invoice || !rule || !target) throw new Error("Approval assignment was not found.");
  const targetRole = target.accountOwner ? "ADMIN" : normalizeStaffRole(target.role);
  if (!roleCanApprove(targetRole, ruleRoles(rule)))
    throw new Error("Choose a teammate whose role can satisfy this rule.");
  if (!roleCanApprove(actorRole, ruleRoles(rule)) && actorRole !== "ADMIN")
    throw new Error("You cannot delegate this approval rule.");
  await prisma.$transaction([
    prisma.approval.create({
      data: {
        invoiceId,
        approvalRuleId: ruleId,
        assignedTo: target.id,
        status: "PENDING",
        comments: `Delegated by ${actor}`,
      },
    }),
    prisma.auditEvent.create({
      data: {
        shop,
        invoiceId,
        actor,
        action: "APPROVAL_DELEGATED",
        detail: { ruleId, assignedTo: target.id },
      },
    }),
  ]);
}

export async function escalateOverdueApprovals(shop: string) {
  await ensureDefaultApprovalRules(shop);
  const pending = await prisma.approval.findMany({
    where: { invoice: { shop }, status: "PENDING", escalated: false },
    include: { approvalRule: true, invoice: true },
  });
  const now = Date.now();
  const overdue = pending.filter((approval) => {
    const days = Math.max(1, approval.approvalRule.escalateIfUnresolvedDays);
    return now - approval.createdAt.getTime() >= days * 86_400_000;
  });
  if (overdue.length)
    await prisma.$transaction(
      overdue.flatMap((approval) => [
      prisma.approval.update({
        where: { id: approval.id },
        data: { escalated: true },
      }),
      prisma.auditEvent.create({
        data: {
          shop,
          invoiceId: approval.invoiceId,
          actor: "SYSTEM",
          action: "APPROVAL_ESCALATED",
          detail: { approvalId: approval.id, rule: approval.approvalRule.name },
        },
      }),
      ]),
    );
  const cutoff = new Date(Date.now() - 86_400_000);
  const untouched = await prisma.invoice.findMany({
    where: {
      shop,
      reviewStatus: { not: "APPROVED" },
      createdAt: { lte: cutoff },
      approvals: { none: {} },
    },
  });
  const rules = await prisma.approvalRule.findMany({
    where: { shop, active: true },
  });
  const created = [];
  for (const invoice of untouched) {
    const requirements = matchingApprovalRules(rules, {
      total: invoice.total,
      supplierId: invoice.vendorId,
      hasPoMismatch: Boolean(
        invoice.purchaseOrderId && invoice.discrepancySummary?.trim(),
      ),
    });
    const overdueRule = requirements.find(
      (rule) =>
        Date.now() - invoice.createdAt.getTime() >=
        Math.max(1, rule.escalateIfUnresolvedDays) * 86_400_000,
    );
    if (!overdueRule) continue;
    const approval = await prisma.approval.create({
      data: {
        invoiceId: invoice.id,
        approvalRuleId: overdueRule.id,
        status: "PENDING",
        escalated: true,
        comments: "Automatically escalated because approval is overdue.",
      },
    });
    await prisma.auditEvent.create({
      data: {
        shop,
        invoiceId: invoice.id,
        actor: "SYSTEM",
        action: "APPROVAL_ESCALATED",
        detail: { approvalId: approval.id, rule: overdueRule.name },
      },
    });
    created.push({ ...approval, invoice, approvalRule: overdueRule });
  }
  const escalated = [...overdue, ...created];
  for (const approval of escalated)
    await notifySafely("APPROVAL_ESCALATED", shop, {
      invoiceId: approval.invoiceId,
      invoiceNumber: approval.invoice.invoiceNumber,
      amount: approval.invoice.total,
      currency: approval.invoice.currency,
      message: `${approval.approvalRule.name} is overdue`,
    });
  return escalated;
}
