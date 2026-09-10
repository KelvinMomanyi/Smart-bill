import { accountingRequest } from "./accountingHttp.server";

export type XeroConnection = { accessToken: string; tenantId?: string | null };
export const XERO_SCOPES =
  "openid profile email offline_access accounting.invoices accounting.contacts accounting.settings.read accounting.attachments";
function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
export async function getXeroAuthUrl(redirectUri: string, state: string) {
  const url = new URL("https://login.xero.com/identity/connect/authorize");
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: requiredEnv("XERO_CLIENT_ID"),
    redirect_uri: redirectUri,
    scope: XERO_SCOPES,
    state,
  }).toString();
  return url.toString();
}
async function tokenRequest(parameters: Record<string, string>) {
  return accountingRequest("Xero", "https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${requiredEnv("XERO_CLIENT_ID")}:${requiredEnv("XERO_CLIENT_SECRET")}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(parameters),
  });
}
export function getXeroToken(code: string, redirectUri: string) {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
}
export function refreshXeroToken(refreshToken: string) {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}
export function getXeroConnections(accessToken: string) {
  return accountingRequest<any[]>("Xero", "https://api.xero.com/connections", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
}
export function disconnectXero(accessToken: string, connectionId: string) {
  return accountingRequest(
    "Xero",
    `https://api.xero.com/connections/${encodeURIComponent(connectionId)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
}
export function xeroRequest<T = any>(
  connection: XeroConnection,
  path: string,
  init: RequestInit = {},
) {
  if (!connection.tenantId)
    throw new Error("Choose a Xero organisation in Settings.");
  return accountingRequest<T>(
    "Xero",
    `https://api.xero.com/api.xro/2.0${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${connection.accessToken}`,
        "xero-tenant-id": connection.tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
  );
}
export function createXeroBill(
  connection: XeroConnection,
  payload: any,
  requestKey: string,
) {
  return xeroRequest(connection, "/Invoices?summarizeErrors=false&unitdp=4", {
    method: "POST",
    headers: { "Idempotency-Key": requestKey },
    body: JSON.stringify({ Invoices: [payload] }),
  });
}
export async function findXeroBills(
  connection: XeroConnection,
  number: string,
) {
  const where = `Type=="ACCPAY"&&InvoiceNumber==${JSON.stringify(number)}`;
  return (
    (
      await xeroRequest(
        connection,
        `/Invoices?where=${encodeURIComponent(where)}&page=1&pageSize=100`,
      )
    ).Invoices || []
  );
}
export async function getOrCreateXeroContact(
  connection: XeroConnection,
  name: string,
) {
  const where = `Name==${JSON.stringify(name)}`;
  const contacts =
    (
      await xeroRequest(
        connection,
        `/Contacts?where=${encodeURIComponent(where)}`,
      )
    ).Contacts || [];
  if (contacts.length > 1)
    throw new Error(
      "Multiple Xero contacts have this supplier name. Make the name unique in Xero.",
    );
  let contact = contacts[0];
  if (!contact) {
    const response = await xeroRequest(connection, "/Contacts", {
      method: "POST",
      body: JSON.stringify({ Contacts: [{ Name: name }] }),
    });
    contact = response.Contacts?.[0];
  }
  if (
    !contact?.ContactID ||
    contact.HasValidationErrors ||
    contact.ValidationErrors?.length
  )
    throw new Error("Xero could not create or resolve the supplier contact.");
  if (contact.ContactStatus === "ARCHIVED")
    throw new Error("Restore this supplier contact in Xero before exporting.");
  return { ContactID: contact.ContactID, Name: contact.Name };
}
