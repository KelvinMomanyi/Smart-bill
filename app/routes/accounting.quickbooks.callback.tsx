import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { readAccountingState, tokenExpiry } from "../utils/accountingOAuth.server";
import { getQuickBooksToken } from "../utils/quickbook";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const realmId = url.searchParams.get("realmId");
  const state = readAccountingState(url.searchParams.get("state"));

  if (!code) {
    throw new Response("Missing QuickBooks authorization code", { status: 400 });
  }
  if (!realmId) throw new Response("Missing QuickBooks realmId", { status: 400 });
  if (state.platform !== "QUICKBOOKS") {
    throw new Response("Invalid QuickBooks OAuth state", { status: 400 });
  }

  const redirectUri = `${url.origin}/accounting/quickbooks/callback`;
  const token = await getQuickBooksToken(code, redirectUri);

  await prisma.accountingConnection.upsert({
    where: { shop_platform: { shop: state.shop, platform: "QUICKBOOKS" } },
    update: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || null,
      tenantId: null,
      realmId,
      scopes: token.scope || null,
      expiresAt: tokenExpiry(token.expires_in),
    },
    create: {
      shop: state.shop,
      platform: "QUICKBOOKS",
      accessToken: token.access_token,
      refreshToken: token.refresh_token || null,
      realmId,
      scopes: token.scope || null,
      expiresAt: tokenExpiry(token.expires_in),
    },
  });

  await prisma.shopSettings.upsert({
    where: { shop: state.shop },
    update: { accountingPlatform: "QUICKBOOKS", accountingConnected: true },
    create: {
      shop: state.shop,
      accountingPlatform: "QUICKBOOKS",
      accountingConnected: true,
    },
  });

  return redirect("/app/settings?accounting=quickbooks-connected");
};
