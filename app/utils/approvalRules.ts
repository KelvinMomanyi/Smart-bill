export const STAFF_ROLES = ["SCANNER", "APPROVER", "FINANCE", "ADMIN"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export type ApprovalRuleLike = {
  id: string;
  name: string;
  invoiceAmountMin: number | null;
  invoiceAmountMax: number | null;
  supplierId: string | null;
  requiredApprovers: number;
  approverRoles: unknown;
  escalateIfUnresolvedDays: number;
  active: boolean;
};

export const DEFAULT_APPROVAL_RULES = [
  {
    name: "Default: under 500",
    invoiceAmountMin: null,
    invoiceAmountMax: 499.999999,
    requiredApprovers: 1,
    approverRoles: ["SCANNER"],
    escalateIfUnresolvedDays: 3,
  },
  {
    name: "Default: 500 to 5000",
    invoiceAmountMin: 500,
    invoiceAmountMax: 5000,
    requiredApprovers: 1,
    approverRoles: ["APPROVER", "FINANCE"],
    escalateIfUnresolvedDays: 3,
  },
  {
    name: "Default: over 5000",
    invoiceAmountMin: 5000.000001,
    invoiceAmountMax: null,
    requiredApprovers: 2,
    approverRoles: ["APPROVER", "FINANCE"],
    escalateIfUnresolvedDays: 3,
  },
  {
    name: "Default: PO mismatch",
    invoiceAmountMin: null,
    invoiceAmountMax: null,
    requiredApprovers: 1,
    approverRoles: ["ADMIN"],
    escalateIfUnresolvedDays: 3,
  },
] as const;

export function normalizeStaffRole(value: unknown): StaffRole {
  const role = String(value || "SCANNER").toUpperCase();
  return STAFF_ROLES.includes(role as StaffRole)
    ? (role as StaffRole)
    : "SCANNER";
}

export function ruleRoles(rule: { approverRoles?: unknown }) {
  if (!Array.isArray(rule.approverRoles)) return [] as StaffRole[];
  return rule.approverRoles
    .map(normalizeStaffRole)
    .filter((role, index, roles) => roles.indexOf(role) === index);
}

export function roleCanApprove(role: StaffRole, required: StaffRole[]) {
  return role === "ADMIN" || required.includes(role);
}

function amountMatches(rule: ApprovalRuleLike, total: number) {
  return (
    (rule.invoiceAmountMin == null || total >= rule.invoiceAmountMin) &&
    (rule.invoiceAmountMax == null || total <= rule.invoiceAmountMax)
  );
}

export function matchingApprovalRules(
  rules: ApprovalRuleLike[],
  invoice: {
    total: number;
    supplierId: string | null;
    hasPoMismatch: boolean;
  },
) {
  const active = rules.filter((rule) => rule.active);
  const custom = active.filter((rule) => !rule.name.startsWith("Default:"));
  const customMatches = custom.filter(
    (rule) =>
      amountMatches(rule, invoice.total) &&
      (!rule.supplierId || rule.supplierId === invoice.supplierId),
  );
  const amountRules = customMatches.length
    ? customMatches
    : active.filter(
        (rule) =>
          rule.name !== "Default: PO mismatch" &&
          amountMatches(rule, invoice.total) &&
          (!rule.supplierId || rule.supplierId === invoice.supplierId),
      );
  const mismatch = invoice.hasPoMismatch
    ? active.filter((rule) => rule.name === "Default: PO mismatch")
    : [];
  return [...amountRules, ...mismatch].filter(
    (rule, index, matches) =>
      matches.findIndex((candidate) => candidate.id === rule.id) === index,
  );
}

export function approvalRequirementsComplete(
  requirements: { id: string; requiredApprovers: number }[],
  approvals: { approvalRuleId: string; approverId: string | null; status: string }[],
) {
  return requirements.every((rule) => {
    const distinct = new Set(
      approvals
        .filter(
          (approval) =>
            approval.approvalRuleId === rule.id &&
            approval.status === "APPROVED" &&
            approval.approverId,
        )
        .map((approval) => approval.approverId),
    );
    return distinct.size >= Math.max(1, rule.requiredApprovers);
  });
}
