const QUICKBOOKS_API_BASE_URL = "https://quickbooks.api.intuit.com/v3/company";
const QUICKBOOKS_MINOR_VERSION = "75";

type QuickBooksConnection = {
  accessToken: string;
  realmId?: string | null;
};

export type QuickBooksRef = {
  value: string;
  name?: string;
};

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireRealmId(connection: QuickBooksConnection) {
  if (!connection.realmId) throw new Error("QuickBooks realmId is missing");
  return connection.realmId;
}

async function readErrorBody(response: Response) {
  const text = await response.text();
  return text.slice(0, 500);
}

function quickBooksUrl(connection: QuickBooksConnection, path: string) {
  const url = new URL(
    `${QUICKBOOKS_API_BASE_URL}/${requireRealmId(connection)}${path}`,
  );
  url.searchParams.set("minorversion", QUICKBOOKS_MINOR_VERSION);
  return url;
}

async function quickBooksRequest<T>(
  connection: QuickBooksConnection,
  path: string,
  init: RequestInit = {},
) {
  const response = await fetch(quickBooksUrl(connection, path), {
    ...init,
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (!response.ok) {
    throw new Error(
      `QuickBooks request failed: ${response.status} ${await readErrorBody(response)}`,
    );
  }

  return response.json() as Promise<T>;
}

function escapeQuickBooksQueryValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function quickBooksQuery<T>(
  connection: QuickBooksConnection,
  query: string,
  responseKey: string,
) {
  const path = `/query?query=${encodeURIComponent(query)}`;
  const response = await quickBooksRequest<Record<string, any>>(connection, path, {
    method: "GET",
  });

  return (response.QueryResponse?.[responseKey] || []) as T[];
}

async function findQuickBooksVendor(
  connection: QuickBooksConnection,
  displayName: string,
) {
  const vendors = await quickBooksQuery<any>(
    connection,
    `select * from Vendor where DisplayName = '${escapeQuickBooksQueryValue(displayName)}'`,
    "Vendor",
  );

  return vendors[0];
}

async function createQuickBooksVendor(
  connection: QuickBooksConnection,
  displayName: string,
) {
  const response = await quickBooksRequest<{ Vendor: any }>(connection, "/vendor", {
    method: "POST",
    body: JSON.stringify({
      DisplayName: displayName,
      CompanyName: displayName,
    }),
  });

  return response.Vendor;
}

export async function getOrCreateQuickBooksVendorRef(
  connection: QuickBooksConnection,
  displayName: string,
): Promise<QuickBooksRef> {
  const name = displayName.trim() || "Unknown Vendor";
  const vendor =
    (await findQuickBooksVendor(connection, name)) ||
    (await createQuickBooksVendor(connection, name));

  if (!vendor?.Id) {
    throw new Error(`QuickBooks did not return an id for vendor ${name}`);
  }

  return { value: String(vendor.Id), name: vendor.DisplayName || name };
}

async function findQuickBooksAccountByName(
  connection: QuickBooksConnection,
  name: string,
) {
  const accounts = await quickBooksQuery<any>(
    connection,
    `select * from Account where Name = '${escapeQuickBooksQueryValue(name)}' and Active = true`,
    "Account",
  );

  return accounts[0];
}

async function listQuickBooksAccounts(connection: QuickBooksConnection) {
  return quickBooksQuery<any>(
    connection,
    "select * from Account where Active = true",
    "Account",
  );
}

function quickBooksRefFromAccount(account: any): QuickBooksRef | null {
  if (!account?.Id) return null;
  return { value: String(account.Id), name: account.Name };
}

function chooseDefaultExpenseAccount(accounts: any[]) {
  const preferredNames = [
    "Cost of Goods Sold",
    "Purchases",
    "Supplies & Materials",
    "Office Supplies",
  ];
  const preferredTypes = ["Cost of Goods Sold", "Expense", "Other Expense"];

  return (
    preferredNames
      .map((name) => accounts.find((account) => account.Name === name))
      .find(Boolean) ||
    accounts.find((account) => preferredTypes.includes(account.AccountType))
  );
}

export async function resolveQuickBooksExpenseAccountRef(
  connection: QuickBooksConnection,
): Promise<QuickBooksRef> {
  const configuredId = process.env.QB_EXPENSE_ACCOUNT_ID?.trim();
  const configuredName = process.env.QB_EXPENSE_ACCOUNT_NAME?.trim();

  if (configuredId) {
    return { value: configuredId, name: configuredName || undefined };
  }

  if (configuredName) {
    const account = await findQuickBooksAccountByName(connection, configuredName);
    const ref = quickBooksRefFromAccount(account);
    if (ref) return ref;

    throw new Error(
      `QuickBooks account "${configuredName}" was not found. Set QB_EXPENSE_ACCOUNT_ID to the account id or use an active account name.`,
    );
  }

  const account = chooseDefaultExpenseAccount(await listQuickBooksAccounts(connection));
  const ref = quickBooksRefFromAccount(account);
  if (ref) return ref;

  throw new Error(
    "No usable QuickBooks expense account was found. Set QB_EXPENSE_ACCOUNT_ID or QB_EXPENSE_ACCOUNT_NAME.",
  );
}

export async function createQuickBooksBill(
  connection: QuickBooksConnection,
  payload: Record<string, unknown>,
) {
  return quickBooksRequest(connection, "/bill", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getQuickBooksAuthUrl(
  redirectUri: string,
  state = "quickbooks-oauth",
) {
  const url = new URL("https://appcenter.intuit.com/connect/oauth2");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", requiredEnv("QB_CLIENT_ID"));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "com.intuit.quickbooks.accounting");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function getQuickBooksToken(code: string, redirectUri: string) {
  const credentials = Buffer.from(
    `${requiredEnv("QB_CLIENT_ID")}:${requiredEnv("QB_CLIENT_SECRET")}`,
  ).toString("base64");

  const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`QuickBooks token exchange failed: ${response.status}`);
  }

  return response.json();
}

export async function refreshQuickBooksToken(refreshToken: string) {
  const credentials = Buffer.from(
    `${requiredEnv("QB_CLIENT_ID")}:${requiredEnv("QB_CLIENT_SECRET")}`,
  ).toString("base64");

  const response = await fetch("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`QuickBooks token refresh failed: ${response.status}`);
  }

  return response.json();
}
