// Navigation hints never authorize a shop. Billing must pass session.shop,
// after authenticate.admin has verified the merchant's session.
export function shopDomain(value?: string | null) {
  const shop = value?.trim().toLowerCase() || "";
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(shop)
    ? shop
    : null;
}

export function shopifyAdminAppsUrl(value?: string | null) {
  const shop = shopDomain(value);
  return shop
    ? `https://admin.shopify.com/store/${shop.replace(".myshopify.com", "")}/apps`
    : null;
}

export function shopifyEmbeddedAppUrl(shop: string, apiKey: string) {
  const appsUrl = shopifyAdminAppsUrl(shop);
  if (!appsUrl || !/^[a-zA-Z0-9_-]+$/.test(apiKey))
    throw new Error(
      "Unable to reopen SmartBill. Open it from your store's Apps page.",
    );
  // The installed Shopify SDK also uses the API key for embedded app URLs.
  return `${appsUrl}/${apiKey}`;
}

// Native links (before hydration, or opened in a new tab) have no App Bridge
// Authorization header. The SDK requires both navigation hints to recover the
// embedded session. These values never authorize access; authenticate.admin
// still verifies Shopify's token and determines the shop for every operation.
export function shopifyAppPath(path: string, value?: string | null) {
  const shop = shopDomain(value);
  if (!shop || !/^\/app(?:\/|\?|#|$)/.test(path)) return path;
  const url = new URL(path, "https://smartbill.invalid");
  if (url.pathname !== "/app" && !url.pathname.startsWith("/app/")) return path;
  url.searchParams.set("shop", shop);
  url.searchParams.set(
    "host",
    btoa(`admin.shopify.com/store/${shop.replace(".myshopify.com", "")}`),
  );
  return `${url.pathname}${url.search}${url.hash}`;
}

export function shopifyAppListingUrl(value?: string | null) {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.hostname !== "apps.shopify.com" ||
      url.port ||
      url.username ||
      url.password ||
      !/^\/[a-zA-Z0-9-]+(?:\/preview\/[a-zA-Z-]+)?\/?$/.test(url.pathname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
