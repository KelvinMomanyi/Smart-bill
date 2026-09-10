import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createCookie, redirect } from "@remix-run/node";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import {
  createAccountingState,
  readAccountingState,
  tokenExpiry,
} from "../utils/accountingOAuth.server";
import {
  openAccountingSecret,
  sealAccountingSecret,
} from "../utils/accountingTokens.server";
import {
  getXeroAuthUrl,
  getXeroConnections,
  getXeroToken,
  xeroRequest,
} from "../utils/xero";
import {
  getQuickBooksAuthUrl,
  getQuickBooksToken,
  quickBooksEnvironment,
  quickBooksRequest,
} from "../utils/quickbook";
import {
  accountingCompanyKey,
  type LivePlatform,
} from "./accountingConnection.server";

export function accountingBaseUrl() {
  const value = process.env.SHOPIFY_APP_URL?.trim();
  if (!value) throw new Error("Set SHOPIFY_APP_URL to the deployed app URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost")
    throw new Error("Accounting connections require an HTTPS app URL.");
  return url.origin;
}
export function accountingReturnUrl(shop: string) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop))
    throw new Error("Invalid shop.");
  return `https://${shop}/admin/apps/${encodeURIComponent(process.env.SHOPIFY_API_KEY || "")}/app/settings`;
}
function browserCookie(id: string) {
  return createCookie(`sb-accounting-${id}`, {
    httpOnly: true,
    secure: accountingBaseUrl().startsWith("https:"),
    sameSite: "lax",
    path: "/accounting",
    maxAge: 1800,
  });
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function cookieMatches(value: unknown, expected: string | null) {
  if (typeof value !== "string" || !expected) return false;
  const a = Buffer.from(hash(value));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function createAuthorization(
  shop: string,
  platform: LivePlatform,
  actor: string,
) {
  const id = randomUUID();
  const environment =
    platform === "QUICKBOOKS" ? quickBooksEnvironment() : "production";
  // Validate provider configuration before leaving the embedded app.
  const state = createAccountingState(shop, platform, id);
  const callback = `${accountingBaseUrl()}/accounting/${platform.toLowerCase()}/callback`;
  if (platform === "XERO") await getXeroAuthUrl(callback, state);
  else await getQuickBooksAuthUrl(callback, state, environment);
  await prisma.accountingAuthorization.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  await prisma.accountingAuthorization.create({
    data: {
      id,
      shop,
      platform,
      environment,
      actor,
      expiresAt: new Date(Date.now() + 1800000),
    },
  });
  return `${accountingBaseUrl()}/accounting/authorize?state=${encodeURIComponent(state)}`;
}
export async function launchAuthorization(request: Request) {
  const stateValue = new URL(request.url).searchParams.get("state");
  const state = readAccountingState(stateValue);
  const secret = randomBytes(32).toString("base64url");
  const claimed = await prisma.accountingAuthorization.updateMany({
    where: {
      id: state.nonce,
      shop: state.shop,
      platform: state.platform,
      status: "CREATED",
      expiresAt: { gt: new Date() },
    },
    data: { status: "STARTED", cookieHash: hash(secret) },
  });
  if (claimed.count !== 1)
    throw new Error(
      "This connection link expired or was used. Start again from Settings.",
    );
  const row = await prisma.accountingAuthorization.findUniqueOrThrow({
    where: { id: state.nonce },
  });
  const callback = `${accountingBaseUrl()}/accounting/${state.platform.toLowerCase()}/callback`;
  const target =
    state.platform === "XERO"
      ? await getXeroAuthUrl(callback, stateValue!)
      : await getQuickBooksAuthUrl(callback, stateValue!, row.environment);
  return redirect(target, {
    headers: {
      "Set-Cookie": await browserCookie(row.id).serialize(secret),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export async function authorizedBrowser(
  request: Request,
  id: string,
  status: string,
) {
  if (!/^[a-zA-Z0-9-]{20,80}$/.test(id))
    throw new Error("Invalid accounting connection.");
  const row = await prisma.accountingAuthorization.findUnique({
    where: { id },
  });
  if (!row || row.status !== status || row.expiresAt.getTime() <= Date.now())
    throw new Error(
      "This connection expired or was already completed. Start again in Settings.",
    );
  if (
    !cookieMatches(
      await browserCookie(id).parse(request.headers.get("Cookie")),
      row.cookieHash,
    )
  )
    throw new Error(
      "Complete the connection in the browser where you started it. Allow cookies for this app.",
    );
  return row;
}
export async function completeAuthorizationCallback(
  request: Request,
  platform: LivePlatform,
) {
  const url = new URL(request.url);
  const state = readAccountingState(url.searchParams.get("state"));
  if (state.platform !== platform)
    throw new Error("Invalid accounting provider.");
  const row = await authorizedBrowser(request, state.nonce, "STARTED");
  if (row.shop !== state.shop || row.platform !== platform)
    throw new Error("Invalid accounting connection.");
  const claimed = await prisma.accountingAuthorization.updateMany({
    where: { id: row.id, status: "STARTED" },
    data: { status: "EXCHANGING" },
  });
  if (claimed.count !== 1)
    throw new Error("This authorization code was already used.");
  if (url.searchParams.has("error")) {
    await prisma.accountingAuthorization.delete({ where: { id: row.id } });
    return redirect(accountingReturnUrl(row.shop), {
      headers: {
        "Set-Cookie": await browserCookie(row.id).serialize("", { maxAge: 0 }),
      },
    });
  }
  const code = url.searchParams.get("code");
  if (!code)
    throw new Error("The accounting provider returned no authorization code.");
  const callback = `${accountingBaseUrl()}/accounting/${platform.toLowerCase()}/callback`;
  const token =
    platform === "XERO"
      ? await getXeroToken(code, callback)
      : await getQuickBooksToken(code, callback, row.environment);
  if (!token.access_token || !token.refresh_token)
    throw new Error(
      "The provider did not grant offline access. Reconnect and approve the requested permissions.",
    );
  let companies: { id: string; name: string; connectionId?: string }[];
  if (platform === "XERO") {
    companies = (await getXeroConnections(token.access_token))
      .filter((c) => c.tenantType === "ORGANISATION")
      .map((c) => ({ id: c.tenantId, name: c.tenantName, connectionId: c.id }));
  } else {
    const realmId = url.searchParams.get("realmId");
    if (!realmId || !/^\d+$/.test(realmId))
      throw new Error("QuickBooks returned no valid company ID.");
    const data = await quickBooksRequest(
      {
        accessToken: token.access_token,
        realmId,
        environment: row.environment,
      },
      `/companyinfo/${realmId}`,
    );
    companies = [
      { id: realmId, name: data.CompanyInfo?.CompanyName || realmId },
    ];
  }
  if (!companies.length)
    throw new Error("No eligible accounting organisations were authorized.");
  await prisma.accountingAuthorization.update({
    where: { id: row.id },
    data: {
      status: "SELECTING",
      credentials: sealAccountingSecret(
        JSON.stringify({ ...token, obtainedAt: Date.now() }),
      ),
      companies,
    },
  });
  return redirect(`/accounting/confirm?authorization=${row.id}`, {
    headers: { "Cache-Control": "no-store" },
  });
}
export async function confirmAuthorization(
  request: Request,
  id: string,
  companyId: string,
) {
  if (request.headers.get("Origin") !== accountingBaseUrl())
    throw new Error("Invalid confirmation origin.");
  const row = await authorizedBrowser(request, id, "SELECTING");
  const companies = row.companies as {
    id: string;
    name: string;
    connectionId?: string;
  }[];
  const company = companies.find((c) => c.id === companyId);
  if (!company || !row.credentials)
    throw new Error("Choose one of the authorized companies.");
  const token = JSON.parse(openAccountingSecret(row.credentials));
  const connection = {
    platform: row.platform,
    environment: row.environment,
    accessToken: token.access_token,
    tenantId: row.platform === "XERO" ? company.id : null,
    realmId: row.platform === "QUICKBOOKS" ? company.id : null,
  };
  let country: string | null = null;
  let homeCurrency: string | null = null;
  if (row.platform === "XERO") {
    const org = (await xeroRequest(connection, "/Organisation"))
      .Organisations?.[0];
    if (!org)
      throw new Error(
        "Xero organisation settings are unavailable. Reconnect with the requested settings permission.",
      );
    country = org.CountryCode;
    homeCurrency = org.BaseCurrency;
  } else {
    const info = (
      await quickBooksRequest(connection, `/companyinfo/${company.id}`)
    ).CompanyInfo;
    const prefs = (await quickBooksRequest(connection, "/preferences"))
      .Preferences;
    country = info?.Country || null;
    homeCurrency = prefs?.CurrencyPrefs?.HomeCurrency?.value || null;
  }
  await prisma.$transaction(
    async (tx) => {
      // Serialize reconnects with token refresh and competing confirmations.
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${row.shop}), hashtext(${row.platform}))`,
      );
      const running = await tx.accountingExport.count({
        where: {
          shop: row.shop,
          platform: row.platform,
          status: "SENDING",
          attemptedAt: { gt: new Date(Date.now() - 120000) },
        },
      });
      if (running)
        throw new Error(
          "An accounting export is running. Wait for it to finish, then confirm the connection.",
        );
      const claimed = await tx.accountingAuthorization.updateMany({
        where: { id, status: "SELECTING", expiresAt: { gt: new Date() } },
        data: { status: "COMPLETE", credentials: null, cookieHash: null },
      });
      if (claimed.count !== 1)
        throw new Error("This connection was already confirmed or expired.");
      const existing = await tx.accountingConnection.findUnique({
        where: { shop_platform: { shop: row.shop, platform: row.platform } },
      });
      const changedCompany =
        !existing ||
        accountingCompanyKey(existing) !== accountingCompanyKey(connection);
      const data = {
        ...connection,
        companyName: company.name,
        country,
        homeCurrency,
        xeroConnectionId: company.connectionId || null,
        accessToken: sealAccountingSecret(token.access_token),
        refreshToken: sealAccountingSecret(token.refresh_token),
        scopes: token.scope || null,
        expiresAt: tokenExpiry(
          Math.max(
            0,
            token.expires_in - (Date.now() - token.obtainedAt) / 1000,
          ),
        ),
        connectedAt: new Date(),
      };
      await tx.accountingConnection.upsert({
        where: { shop_platform: { shop: row.shop, platform: row.platform } },
        create: { shop: row.shop, ...data },
        update: data,
      });
      const settingsData = {
        accountingPlatform: row.platform,
        accountingConnected: true,
        ...(changedCompany
          ? row.platform === "XERO"
            ? { xeroAccountCode: null, xeroTaxType: null }
            : {
                quickBooksAccountId: null,
                quickBooksTaxCodeId: null,
                quickBooksTaxAccountId: null,
              }
          : {}),
      };
      await tx.shopSettings.upsert({
        where: { shop: row.shop },
        create: { shop: row.shop, ...settingsData },
        update: settingsData,
      });
      await tx.auditEvent.create({
        data: {
          shop: row.shop,
          actor: row.actor,
          action: "ACCOUNTING_CONNECTED",
          detail: {
            platform: row.platform,
            companyKey: accountingCompanyKey(connection),
            company: company.name,
          },
        },
      });
    },
    { timeout: 15000 },
  );
  return redirect(accountingReturnUrl(row.shop), {
    headers: {
      "Set-Cookie": await browserCookie(row.id).serialize("", { maxAge: 0 }),
      "Cache-Control": "no-store",
    },
  });
}
