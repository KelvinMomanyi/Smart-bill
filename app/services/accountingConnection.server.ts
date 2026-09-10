import { Prisma, type AccountingConnection } from "@prisma/client";
import prisma from "../db.server";
import {
  openAccountingSecret,
  sealAccountingSecret,
} from "../utils/accountingTokens.server";
import {
  disconnectXero,
  getXeroConnections,
  refreshXeroToken,
} from "../utils/xero";
import {
  refreshQuickBooksToken,
  revokeQuickBooksToken,
} from "../utils/quickbook";
import { tokenExpiry } from "../utils/accountingOAuth.server";
import { AccountingApiError } from "../utils/accountingHttp.server";

export type LivePlatform = "XERO" | "QUICKBOOKS";
export function livePlatform(value: string): LivePlatform {
  if (value !== "XERO" && value !== "QUICKBOOKS")
    throw new Error("Choose Xero or QuickBooks.");
  return value;
}
export function accountingCompanyKey(connection: {
  platform: string;
  environment?: string;
  tenantId?: string | null;
  realmId?: string | null;
}) {
  const id =
    connection.platform === "XERO" ? connection.tenantId : connection.realmId;
  if (!id) throw new Error("The accounting company has not been selected.");
  return `${connection.platform}:${connection.environment || "production"}:${id}`;
}
async function usableConnection(
  tx: Prisma.TransactionClient,
  stored: AccountingConnection,
) {
  let accessToken = openAccountingSecret(stored.accessToken);
  let refreshToken = stored.refreshToken
    ? openAccountingSecret(stored.refreshToken)
    : null;
  let expiresAt = stored.expiresAt;
  let scopes = stored.scopes;
  if (!expiresAt || expiresAt.getTime() <= Date.now() + 60000) {
    if (!refreshToken)
      throw new Error(
        "The accounting connection expired. Reconnect in Settings.",
      );
    const token =
      stored.platform === "XERO"
        ? await refreshXeroToken(refreshToken)
        : await refreshQuickBooksToken(refreshToken, stored.environment);
    if (!token.access_token)
      throw new Error(
        "The accounting provider did not return an access token.",
      );
    accessToken = token.access_token;
    refreshToken = token.refresh_token || refreshToken;
    expiresAt = tokenExpiry(token.expires_in);
    scopes = token.scope || scopes;
  }
  await tx.accountingConnection.update({
    where: { id: stored.id },
    data: {
      accessToken: sealAccountingSecret(accessToken),
      refreshToken: refreshToken ? sealAccountingSecret(refreshToken) : null,
      expiresAt,
      scopes,
    },
  });
  return { ...stored, accessToken, refreshToken, expiresAt, scopes };
}
export async function getAccountingConnection(
  shop: string,
  platform: LivePlatform,
) {
  // Locks coordinate refresh, reconnect and disconnect across server instances.
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${shop}), hashtext(${platform}))`,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "AccountingConnection" WHERE shop = ${shop} AND platform = ${platform} FOR UPDATE`,
      );
      const stored = await tx.accountingConnection.findUnique({
        where: { shop_platform: { shop, platform } },
      });
      if (!stored)
        throw new Error(`Connect ${platform} in Settings before exporting.`);
      return usableConnection(tx, stored);
    },
    { maxWait: 20000, timeout: 25000 },
  );
}
export async function disconnectAccounting(
  shop: string,
  platform: LivePlatform,
  actor: string,
) {
  const failure = await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${shop}), hashtext(${platform}))`,
      );
      const stored = await tx.accountingConnection.findUnique({
        where: { shop_platform: { shop, platform } },
      });
      if (!stored) return null;
      const running = await tx.accountingExport.count({
        where: {
          shop,
          platform,
          OR: [
            {
              status: "SENDING",
              attemptedAt: { gt: new Date(Date.now() - 120000) },
            },
            {
              attachmentStatus: "SENDING",
              updatedAt: { gt: new Date(Date.now() - 120000) },
            },
          ],
        },
      });
      if (running)
        throw new Error(
          "An accounting export or attachment is running. Wait for it to finish before disconnecting.",
        );
      try {
        if (platform === "QUICKBOOKS") {
          await revokeQuickBooksToken(
            openAccountingSecret(stored.refreshToken || stored.accessToken),
            stored.environment,
          );
        } else {
          const connection = await usableConnection(tx, stored);
          let remoteId = connection.xeroConnectionId;
          if (!remoteId)
            remoteId = (await getXeroConnections(connection.accessToken)).find(
              (c) => c.tenantId === connection.tenantId,
            )?.id;
          if (remoteId) await disconnectXero(connection.accessToken, remoteId);
        }
      } catch (error) {
        // Only a missing connection or an explicitly invalid grant proves access
        // is already gone. A bad client secret must not silently "disconnect".
        if (
          !(
            error instanceof AccountingApiError &&
            (error.status === 404 ||
              ["invalid_grant", "invalid_token"].includes(error.code || ""))
          )
        ) {
          // Commit any rotated refresh token even when remote revocation fails.
          return { error };
        }
      }
      await tx.accountingConnection.deleteMany({ where: { id: stored.id } });
      await tx.accountingAuthorization.deleteMany({
        where: { shop, platform },
      });
      const remaining = await tx.accountingConnection.findFirst({
        where: { shop },
      });
      await tx.shopSettings.updateMany({
        where: { shop },
        data: {
          accountingConnected: Boolean(remaining),
          accountingPlatform: remaining?.platform || null,
          ...(platform === "XERO"
            ? { xeroAccountCode: null, xeroTaxType: null }
            : {
                quickBooksAccountId: null,
                quickBooksTaxCodeId: null,
                quickBooksTaxAccountId: null,
              }),
        },
      });
      await tx.auditEvent.create({
        data: {
          shop,
          actor,
          action: "ACCOUNTING_DISCONNECTED",
          detail: { platform, companyKey: accountingCompanyKey(stored) },
        },
      });
      return null;
    },
    { maxWait: 20000, timeout: 55000 },
  );
  if (failure) throw failure.error;
}
