import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { requireSubscription } from "../services/billing.server";
import prisma from "../db.server";
import { invoiceDocumentDownloadUrl } from "../utils/upload.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await requireSubscription(request);
  const id = new URL(request.url).searchParams.get("jobId") || "";
  const job = await prisma.invoiceJob.findFirst({
    where: { id, shop: session.shop },
  });
  if (!job) throw new Response("Document not found", { status: 404 });
  return json(
    {
      url: await invoiceDocumentDownloadUrl(job.storageKey),
      filename: job.filename,
      contentType: job.contentType,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
