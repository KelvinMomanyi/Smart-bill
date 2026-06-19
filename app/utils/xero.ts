export async function getXeroAuthUrl(redirectUri: string, state = "xero-oauth") {
  const url = new URL("https://login.xero.com/identity/connect/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.XERO_CLIENT_ID || "");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid profile email accounting.transactions accounting.contacts offline_access");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function getXeroToken(code: string, redirectUri: string) {
  const credentials = Buffer.from(
    `${process.env.XERO_CLIENT_ID || ""}:${process.env.XERO_CLIENT_SECRET || ""}`,
  ).toString("base64");

  const response = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    throw new Error(`Xero token exchange failed: ${response.status}`);
  }

  return response.json();
}

export async function refreshXeroToken(refreshToken: string) {
  const credentials = Buffer.from(
    `${process.env.XERO_CLIENT_ID || ""}:${process.env.XERO_CLIENT_SECRET || ""}`,
  ).toString("base64");

  const response = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Xero token refresh failed: ${response.status}`);
  }

  return response.json();
}

export async function getXeroConnections(accessToken: string) {
  const response = await fetch("https://api.xero.com/connections", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Xero connection lookup failed: ${response.status}`);
  }

  return response.json();
}
