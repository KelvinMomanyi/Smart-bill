import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { eraseShopData } from "../services/privacy.server";
export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop } = await authenticate.webhook(request);
  if (topic === "SHOP_REDACT") await eraseShopData(shop);
  else if (topic !== "CUSTOMERS_DATA_REQUEST" && topic !== "CUSTOMERS_REDACT")
    return new Response("Unsupported webhook", { status: 400 });
  // SmartBill stores supplier invoices, not Shopify customers or their orders.
  return new Response(null, { status: 200 });
}
