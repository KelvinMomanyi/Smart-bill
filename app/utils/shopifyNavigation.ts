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
