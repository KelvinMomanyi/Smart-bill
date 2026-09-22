import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { normalizeStaffRole } from "./approvalRules";

export async function requireAdmin(request: Request) {
  const context = await authenticate.admin(request);
  const { session } = context;
  
  const dbSession = await prisma.session.findUnique({
    where: { id: session.id }
  });

  const hasAdminAccess = session.isOnline && (dbSession?.role === "ADMIN" || session.onlineAccessInfo?.associated_user.account_owner === true);

  if (!hasAdminAccess) {
    throw new Response("Unauthorized: Admin access required", { status: 403 });
  }

  return { ...context, dbSession, actor: String(session.onlineAccessInfo?.associated_user.id || session.id) };
}

export async function getUserRole(request: Request) {
  const { session } = await authenticate.admin(request);
  
  const dbSession = await prisma.session.findUnique({
    where: { id: session.id }
  });

  if (session.isOnline && (dbSession?.role === "ADMIN" || session.onlineAccessInfo?.associated_user.account_owner === true)) {
    return "ADMIN";
  }

  return normalizeStaffRole(dbSession?.role);
}

export async function requireApprovalAccess(request: Request) {
  const context = await authenticate.admin(request);
  const { session } = context;
  const dbSession = await prisma.session.findUnique({ where: { id: session.id } });
  const actor = String(
    session.onlineAccessInfo?.associated_user.id || session.id,
  );
  const role = session.onlineAccessInfo?.associated_user.account_owner
    ? "ADMIN"
    : normalizeStaffRole(dbSession?.role);
  if (!session.isOnline)
    throw new Response("Unauthorized: staff session required", { status: 403 });
  return { ...context, dbSession, actor, role };
}

export async function requireFinanceAccess(request: Request) {
  const context = await requireApprovalAccess(request);
  if (context.role !== "ADMIN" && context.role !== "FINANCE")
    throw new Response("Unauthorized: finance approval required", { status: 403 });
  return context;
}
