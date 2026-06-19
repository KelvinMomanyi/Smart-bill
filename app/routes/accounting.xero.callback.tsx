import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { readAccountingState, tokenExpiry } from "../utils/accountingOAuth.server";
import { getXeroConnections, getXeroToken } from "../utils/xero";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = readAccountingState(url.searchParams.get("state"));

  if (!code) throw new Response("Missing Xero authorization code", { status: 400 });
  if (state.platform !== "XERO") {
    throw new Response("Invalid Xero OAuth state", { status: 400 });
  }

  const redirectUri = `${url.origin}/accounting/xero/callback`;
  const token = await getXeroToken(code, redirectUri);
  const connections = await getXeroConnections(token.access_token);
  const tenantId = connections?.[0]?.tenantId;

  if (!tenantId) {
    throw new Response("No Xero tenant was returned", { status: 400 });
  }

  await prisma.accountingConnection.upsert({
    where: { shop_platform: { shop: state.shop, platform: "XERO" } },
    update: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || null,
      tenantId,
      realmId: null,
      scopes: token.scope || null,
      expiresAt: tokenExpiry(token.expires_in),
    },
    create: {
      shop: state.shop,
      platform: "XERO",
      accessToken: token.access_token,
      refreshToken: token.refresh_token || null,
      tenantId,
      scopes: token.scope || null,
      expiresAt: tokenExpiry(token.expires_in),
    },
  });

  await prisma.shopSettings.upsert({
    where: { shop: state.shop },
    update: { accountingPlatform: "XERO", accountingConnected: true },
    create: {
      shop: state.shop,
      accountingPlatform: "XERO",
      accountingConnected: true,
    },
  });

  return redirect("/app/settings?accounting=xero-connected");
};
