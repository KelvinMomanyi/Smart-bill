import prisma from 'app/db.server';
import { json } from '@remix-run/node';
import { authenticate } from '../shopify.server';

export const loader = async ({ request }: any) => {
  try {
    const { session } = await authenticate.admin(request);
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
  } catch (error: any) {
    console.error("Error fetching POs:", error);
    return json({ success: false, error: error.message }, { status: 500 });
  }
};
