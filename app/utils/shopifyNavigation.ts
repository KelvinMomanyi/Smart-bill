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
