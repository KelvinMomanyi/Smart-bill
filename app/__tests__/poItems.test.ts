import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePoItems, parseStructuredPoItems } from "../utils/poItems.server";

test("parsePoItems reads pasted SKU rows", () => {
  const items = parsePoItems(`
    SKU-001 Premium Widget Set | 50 | 20.00
    PACK-100 Bulk Packaging Supplies, 100, 5.00
  `);

  assert.equal(items.length, 2);
  assert.equal(items[0].sku, "SKU-001");
  assert.equal(items[0].name, "Premium Widget Set");
  assert.equal(items[0].expectedQty, 50);
  assert.equal(items[0].expectedRate, 20);
  assert.equal(items[1].sku, "PACK-100");
});

test("parseStructuredPoItems filters blank rows and preserves Shopify IDs", () => {
  const items = parseStructuredPoItems(
    JSON.stringify([
      {
        sku: "BAG-10",
        name: "Canvas Bag",
        expectedQty: "8",
        expectedRate: "12.50",
        shopifyVariantId: "gid://shopify/ProductVariant/1",
      },
      { sku: "", name: "", expectedQty: "", expectedRate: "" },
    ]),
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].sku, "BAG-10");
  assert.equal(items[0].expectedQty, 8);
  assert.equal(items[0].expectedRate, 12.5);
  assert.equal(items[0].shopifyVariantId, "gid://shopify/ProductVariant/1");
});
