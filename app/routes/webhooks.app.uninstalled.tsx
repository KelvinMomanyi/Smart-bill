import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  await db.$transaction([
    db.invoiceJob.updateMany({
      where: { shop, status: { in: ["QUEUED", "PROCESSING"] } },
      data: { status: "CANCELLED", leaseToken: null },
    }),
    db.accountingConnection.deleteMany({ where: { shop } }),
    db.accountingAuthorization.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);

  return new Response();
};
