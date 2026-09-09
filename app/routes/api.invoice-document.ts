import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { readInvoiceDocument } from "../utils/upload.server";
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = new URL(request.url).searchParams.get("id") || "";
  const invoice = await prisma.invoice.findFirst({
    where: { id, shop: session.shop },
  });
  if (!invoice?.storageKey)
    throw new Response("Document not found", { status: 404 });
  const file = await readInvoiceDocument(invoice.storageKey);
  return new Response(new Uint8Array(file.buffer), {
    headers: {
      "Content-Type": file.contentType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="${(invoice.sourceFilename || "invoice").replace(/[^a-zA-Z0-9._-]/g, "-")}"`,
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
