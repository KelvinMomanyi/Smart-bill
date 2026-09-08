import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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

  return "SCANNER";
}
