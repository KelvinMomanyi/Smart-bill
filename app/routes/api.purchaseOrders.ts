import prisma from "../db.server";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  try {
    const shop = session.shop;

    const pos = await prisma.purchaseOrder.findMany({
      where: { 
        shop,
        status: { in: ["OPEN", "PARTIAL", "MISMATCH"] } 
      },
      include: { 
        vendor: true,
        items: true
      },
      orderBy: { createdAt: 'desc' }
    });

    return json({ success: true, pos });
  } catch (error) {
    console.error(
      "Error fetching purchase orders:",
      error instanceof Error ? error.message : "Unknown database error",
    );
    return json(
      { success: false, error: "Purchase orders could not be loaded." },
      { status: 500 },
    );
  }
};
