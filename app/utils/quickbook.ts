import { accountingRequest } from "./accountingHttp.server";
export type QuickBooksConnection = {
  accessToken: string;
  realmId?: string | null;
  environment?: string | null;
};
export type QuickBooksRef = { value: string; name?: string };
export function quickBooksEnvironment() {
  const value = process.env.QB_ENVIRONMENT?.trim() || "production";
  if (!["sandbox", "production"].includes(value))
    throw new Error("QB_ENVIRONMENT must be sandbox or production.");
  return value;
}
function credentials(environment = quickBooksEnvironment()) {
  const prefix =
    environment === "sandbox" && process.env.QB_SANDBOX_CLIENT_ID
      ? "QB_SANDBOX"
      : "QB";
  const id = process.env[`${prefix}_CLIENT_ID`]?.trim();
  const secret = process.env[`${prefix}_CLIENT_SECRET`]?.trim();
  if (!id || !secret)
    throw new Error(
      `Configure ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET before connecting QuickBooks.`,
    );
  return { id, basic: Buffer.from(`${id}:${secret}`).toString("base64") };
}
export function quickBooksUrl(connection: QuickBooksConnection, path: string) {
  if (!connection.realmId || !/^\d+$/.test(connection.realmId))
    throw new Error("QuickBooks company ID is missing or invalid.");
  const env = connection.environment || "production";
  if (!["sandbox", "production"].includes(env))
    throw new Error("Unknown QuickBooks environment.");
  const origin =
    env === "sandbox"
      ? "https://sandbox-quickbooks.api.intuit.com"
      : "https://quickbooks.api.intuit.com";
  const url = new URL(`${origin}/v3/company/${connection.realmId}${path}`);
  url.searchParams.set("minorversion", "75");
  return url;
}
export function quickBooksRequest<T = any>(
  connection: QuickBooksConnection,
  path: string,
  init: RequestInit = {},
) {
  return accountingRequest<T>("QuickBooks", quickBooksUrl(connection, path), {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      Accept: "application/json",
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
}
export function escapeQuickBooksQueryValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
export async function quickBooksQuery<T = any>(
  connection: QuickBooksConnection,
  query: string,
  key: string,
): Promise<T[]> {
  const response = await quickBooksRequest(
    connection,
    `/query?query=${encodeURIComponent(query)}`,
  );
  return response.QueryResponse?.[key] || [];
}
export async function listQuickBooksEntity(
  connection: QuickBooksConnection,
  entity: "Account" | "TaxCode" | "TaxRate",
) {
  const all: any[] = [];
  for (let start = 1; start <= 20001; start += 1000) {
    const page = await quickBooksQuery(
      connection,
      `select * from ${entity} startposition ${start} maxresults 1000`,
      entity,
    );
    all.push(...page);
    if (page.length < 1000) return all.filter((item) => item.Active !== false);
  }
  throw new Error(
    `Too many ${entity} records. Contact support to configure this company.`,
  );
}
export async function getOrCreateQuickBooksVendorRef(
  connection: QuickBooksConnection,
  displayName: string,
  currency?: string,
  multiCurrency = false,
): Promise<QuickBooksRef> {
  const name = displayName.trim();
  if (!name || name.length > 500)
    throw new Error("Enter a supplier name between 1 and 500 characters.");
  const query = `select * from Vendor where DisplayName = '${escapeQuickBooksQueryValue(name)}'`;
  let vendors = await quickBooksQuery<any>(connection, query, "Vendor");
  if (vendors.length > 1)
    throw new Error("Multiple QuickBooks suppliers match this name.");
  let vendor = vendors[0];
  if (!vendor) {
    try {
      vendor = (
        await quickBooksRequest(connection, "/vendor", {
          method: "POST",
          body: JSON.stringify({
            DisplayName: name,
            CompanyName: name,
            ...(multiCurrency && currency
              ? { CurrencyRef: { value: currency } }
              : {}),
          }),
        })
      ).Vendor;
    } catch (error) {
      // A concurrent invoice may have created the same vendor.
      vendors = await quickBooksQuery<any>(connection, query, "Vendor");
      if (!vendors.length) throw error;
      vendor = vendors[0];
    }
  }
  if (!vendor?.Id || vendor.Active === false)
    throw new Error("QuickBooks supplier is missing or inactive.");
  if (
    currency &&
    vendor.CurrencyRef?.value &&
    vendor.CurrencyRef.value !== currency
  )
    throw new Error(
      `This QuickBooks supplier uses ${vendor.CurrencyRef.value}. Use a supplier with the invoice currency ${currency}.`,
    );
  return { value: String(vendor.Id), name: vendor.DisplayName };
}
export function createQuickBooksBill(
  connection: QuickBooksConnection,
  payload: Record<string, unknown>,
  requestKey?: string,
) {
  return quickBooksRequest(
    connection,
    `/bill${requestKey ? `?requestid=${encodeURIComponent(requestKey)}` : ""}`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}
export function readQuickBooksBill(
  connection: QuickBooksConnection,
  id: string,
) {
  return quickBooksRequest<{ Bill: any }>(
    connection,
    `/bill/${encodeURIComponent(id)}`,
  );
}
export function findQuickBooksBills(
  connection: QuickBooksConnection,
  number: string,
) {
  return quickBooksQuery<any>(
    connection,
    `select * from Bill where DocNumber = '${escapeQuickBooksQueryValue(number)}' maxresults 1000`,
    "Bill",
  );
}
export async function getQuickBooksAuthUrl(
  redirectUri: string,
  state: string,
  environment = quickBooksEnvironment(),
) {
  const url = new URL("https://appcenter.intuit.com/connect/oauth2");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: credentials(environment).id,
    redirect_uri: redirectUri,
    scope: "com.intuit.quickbooks.accounting",
    state,
  }).toString();
  return url.toString();
}
async function tokenRequest(
  parameters: Record<string, string>,
  environment?: string,
) {
  return accountingRequest(
    "QuickBooks",
    "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials(environment).basic}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(parameters),
    },
  );
}
export function getQuickBooksToken(
  code: string,
  redirectUri: string,
  environment?: string,
) {
  return tokenRequest(
    { grant_type: "authorization_code", code, redirect_uri: redirectUri },
    environment,
  );
}
export function refreshQuickBooksToken(
  refreshToken: string,
  environment?: string,
) {
  return tokenRequest(
    { grant_type: "refresh_token", refresh_token: refreshToken },
    environment,
  );
}
export function revokeQuickBooksToken(token: string, environment?: string) {
  return accountingRequest(
    "QuickBooks",
    "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials(environment).basic}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token }),
    },
  );
}
