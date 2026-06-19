export async function getQuickBooksAuthUrl(
  redirectUri: string,
  state = "quickbooks-oauth",
) {
  const url = new URL("https://appcenter.intuit.com/connect/oauth2");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.QB_CLIENT_ID || "");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "com.intuit.quickbooks.accounting");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function getQuickBooksToken(code: string, redirectUri: string) {
  const credentials = Buffer.from(
    `${process.env.QB_CLIENT_ID || ""}:${process.env.QB_CLIENT_SECRET || ""}`,
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
    `${process.env.QB_CLIENT_ID || ""}:${process.env.QB_CLIENT_SECRET || ""}`,
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
