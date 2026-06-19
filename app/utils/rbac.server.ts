import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function requireAdmin(request: Request) {
  const { session } = await authenticate.admin(request);
  
  const dbSession = await prisma.session.findUnique({
    where: { id: session.id }
  });

  const hasAdminAccess = dbSession?.role === "ADMIN" || dbSession?.accountOwner === true;

  if (!hasAdminAccess) {
    throw new Response("Unauthorized: Admin access required", { status: 403 });
  }

  return { session, dbSession };
}

export async function getUserRole(request: Request) {
  const { session } = await authenticate.admin(request);
  
  const dbSession = await prisma.session.findUnique({
    where: { id: session.id }
  });

  if (dbSession?.role === "ADMIN" || dbSession?.accountOwner === true) {
    return "ADMIN";
  }

  return "SCANNER";
}
