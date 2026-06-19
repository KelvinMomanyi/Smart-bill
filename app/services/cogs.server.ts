// app/services/cogs.server.ts
import { authenticate } from "../shopify.server";

export interface SyncItem {
  invoiceItemId?: string;
  sku?: string | null;
  shopifyProductId?: string | null;
  shopifyVariantId?: string | null;
  name: string;
  price: number;
}

type ResolvedInventoryItem = {
  productId?: string;
  variantId: string;
  inventoryItemId: string;
  matchedProductTitle?: string;
  matchedVariantTitle?: string;
  sku?: string | null;
  matchStrategy: "variant_id" | "sku" | "product_id" | "title";
};

async function graphqlJson(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  query: string,
  variables: Record<string, unknown>,
) {
  const response = await admin.graphql(query, { variables });
  return response.json();
}

async function resolveByVariantId(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  variantId: string,
): Promise<ResolvedInventoryItem | null> {
  const json = await graphqlJson(
    admin,
    `#graphql
      query SmartBillVariantById($id: ID!) {
        productVariant(id: $id) {
          id
          title
          sku
          product {
            id
            title
          }
          inventoryItem {
            id
          }
        }
      }`,
    { id: variantId },
  );
  const variant = json.data?.productVariant;
  const inventoryItemId = variant?.inventoryItem?.id;
  if (!variant?.id || !inventoryItemId) return null;

  return {
    productId: variant.product?.id,
    variantId: variant.id,
    inventoryItemId,
    matchedProductTitle: variant.product?.title,
    matchedVariantTitle: variant.title,
    sku: variant.sku,
    matchStrategy: "variant_id",
  };
}

async function resolveBySku(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  sku: string,
): Promise<ResolvedInventoryItem | null> {
  const json = await graphqlJson(
    admin,
    `#graphql
      query SmartBillVariantBySku($query: String!) {
        productVariants(first: 1, query: $query) {
          edges {
            node {
              id
              title
              sku
              product {
                id
                title
              }
              inventoryItem {
                id
              }
            }
          }
        }
      }`,
    { query: `sku:${sku}` },
  );
  const variant = json.data?.productVariants?.edges?.[0]?.node;
  const inventoryItemId = variant?.inventoryItem?.id;
  if (!variant?.id || !inventoryItemId) return null;

  return {
    productId: variant.product?.id,
    variantId: variant.id,
    inventoryItemId,
    matchedProductTitle: variant.product?.title,
    matchedVariantTitle: variant.title,
    sku: variant.sku,
    matchStrategy: "sku",
  };
}

async function resolveByProductId(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  productId: string,
): Promise<ResolvedInventoryItem | null> {
  const json = await graphqlJson(
    admin,
    `#graphql
      query SmartBillProductById($id: ID!) {
        product(id: $id) {
          id
          title
          variants(first: 1) {
            edges {
              node {
                id
                title
                sku
                inventoryItem {
                  id
                }
              }
            }
          }
        }
      }`,
    { id: productId },
  );
  const product = json.data?.product;
  const variant = product?.variants?.edges?.[0]?.node;
  const inventoryItemId = variant?.inventoryItem?.id;
  if (!variant?.id || !inventoryItemId) return null;

  return {
    productId: product.id,
    variantId: variant.id,
    inventoryItemId,
    matchedProductTitle: product.title,
    matchedVariantTitle: variant.title,
    sku: variant.sku,
    matchStrategy: "product_id",
  };
}

async function resolveByTitle(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  name: string,
): Promise<ResolvedInventoryItem | null> {
  const json = await graphqlJson(
    admin,
    `#graphql
      query SmartBillProductByTitle($query: String!) {
        products(first: 1, query: $query) {
          edges {
            node {
              id
              title
              variants(first: 1) {
                edges {
                  node {
                    id
                    title
                    sku
                    inventoryItem {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }`,
    { query: `title:${name}*` },
  );
  const product = json.data?.products?.edges?.[0]?.node;
  const variant = product?.variants?.edges?.[0]?.node;
  const inventoryItemId = variant?.inventoryItem?.id;
  if (!variant?.id || !inventoryItemId) return null;

  return {
    productId: product.id,
    variantId: variant.id,
    inventoryItemId,
    matchedProductTitle: product.title,
    matchedVariantTitle: variant.title,
    sku: variant.sku,
    matchStrategy: "title",
  };
}

async function resolveInventoryItem(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  item: SyncItem,
) {
  const explicitVariantId = item.shopifyVariantId?.startsWith("gid://")
    ? item.shopifyVariantId
    : null;
  const sku = item.sku || (!explicitVariantId ? item.shopifyVariantId : null);

  if (explicitVariantId) {
    const resolved = await resolveByVariantId(admin, explicitVariantId);
    if (resolved) return resolved;
  }

  if (sku) {
    const resolved = await resolveBySku(admin, sku);
    if (resolved) return resolved;
  }

  if (item.shopifyProductId) {
    const resolved = await resolveByProductId(admin, item.shopifyProductId);
    if (resolved) return resolved;
  }

  return resolveByTitle(admin, item.name);
}

async function updateInventoryItemCost(
  admin: Awaited<ReturnType<typeof authenticate.admin>>["admin"],
  inventoryItemId: string,
  cost: number,
) {
  const json = await graphqlJson(
    admin,
    `#graphql
      mutation SmartBillInventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
        inventoryItemUpdate(id: $id, input: $input) {
          inventoryItem {
            id
            unitCost {
              amount
            }
          }
          userErrors {
            field
            message
          }
        }
      }`,
    {
      id: inventoryItemId,
      input: { cost },
    },
  );

  return json.data?.inventoryItemUpdate?.userErrors || [];
}

export async function syncCogsToShopify(request: Request, items: SyncItem[]) {
  const { admin } = await authenticate.admin(request);
  const syncedItems = [];
  const errors = [];

  for (const item of items) {
    try {
      const resolved = await resolveInventoryItem(admin, item);
      if (!resolved) {
        errors.push(
          `Could not find Shopify inventory item for ${item.sku || item.name}`,
        );
        continue;
      }

      const userErrors = await updateInventoryItemCost(
        admin,
        resolved.inventoryItemId,
        item.price,
      );

      if (userErrors.length > 0) {
        errors.push(`Error updating ${item.name}: ${userErrors[0].message}`);
      } else {
        syncedItems.push({
          invoiceItemId: item.invoiceItemId,
          name: item.name,
          sku: resolved.sku,
          productId: resolved.productId,
          variantId: resolved.variantId,
          inventoryItemId: resolved.inventoryItemId,
          matchedProductTitle: resolved.matchedProductTitle,
          matchedVariantTitle: resolved.matchedVariantTitle,
          matchStrategy: resolved.matchStrategy,
          newCost: item.price,
        });
      }
    } catch (err) {
      console.error(`Error syncing COGS for ${item.name}:`, err);
      errors.push(
        `Failed to sync ${item.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const failedCount = Math.max(0, items.length - syncedItems.length);

  return {
    success: items.length > 0 && syncedItems.length === items.length,
    partialSuccess: syncedItems.length > 0 && failedCount > 0,
    syncedCount: syncedItems.length,
    failedCount,
    syncedItems,
    errors,
  };
}
