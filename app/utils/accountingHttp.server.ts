export class AccountingApiError extends Error {
  constructor(
    public provider: string,
    public status: number,
    message: string,
    public rejected: boolean,
    public code?: string,
  ) {
    super(message);
    this.name = "AccountingApiError";
  }
}
// Only an explicit rejection proves that creating a bill can be retried.
// Timeouts, malformed success responses and server failures remain ambiguous.
export async function accountingRequest<T = any>(
  provider: string,
  url: string | URL,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal || AbortSignal.timeout(15000),
    });
  } catch {
    throw new AccountingApiError(
      provider,
      0,
      `${provider} did not respond. Check the export history before trying again.`,
      false,
    );
  }
  const raw = await response.text();
  let body: any;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw new AccountingApiError(
      provider,
      response.status,
      `${provider} returned an unreadable response.`,
      false,
    );
  }
  if (!response.ok || body.Fault) {
    const advice =
      body.error === "invalid_grant"
        ? "Authorization has expired or was revoked. Reconnect the accounting company in Settings."
        : body.error === "invalid_client"
          ? "The app operator must check the accounting client credentials and environment."
          : response.status === 401
            ? "Reconnect the accounting company in Settings."
            : response.status === 403
              ? "Check the connection permissions and company subscription."
              : response.status === 429
                ? `Request limit reached. Try again after ${response.headers.get("retry-after") || "60"} seconds.`
                : response.status >= 500
                  ? "The accounting service is temporarily unavailable. Check the export history before trying again."
                  : "Check the selected supplier, accounts, tax codes and bill fields, then try again.";
    throw new AccountingApiError(
      provider,
      response.status,
      `${provider}: ${advice}`,
      [400, 401, 403, 404, 422, 429].includes(response.status),
      typeof body.error === "string"
        ? body.error
        : body.Fault?.Error?.[0]?.code,
    );
  }
  return body as T;
}
