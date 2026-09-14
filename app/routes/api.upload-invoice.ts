import { json, type ActionFunctionArgs } from "@remix-run/node";
import {
  assertSubscription,
  requireSubscription,
} from "../services/billing.server";
import { enqueueDocument } from "../services/invoiceJobs.server";
export async function action({ request }: ActionFunctionArgs) {
  try {
    const { session, plan } = await requireSubscription(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size)
      throw new Error("Select a document.");
    if (process.env.VERCEL && file.size > 4 * 1024 * 1024)
      throw new Error("This host accepts documents up to 4 MB per upload.");
    const batchSize = Number(form.get("batchSize") || 1);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10)
      throw new Error("Upload at most 10 documents at once.");
    if (batchSize > 1) assertSubscription(plan, "bulk");
    const job = await enqueueDocument({
      shop: session.shop,
      plan,
      buffer: Buffer.from(await file.arrayBuffer()),
      filename: file.name,
      contentType: file.type,
      vendorName: String(form.get("vendorName") || ""),
      purchaseOrderId: String(form.get("purchaseOrderId") || "") || undefined,
      browserOcr: form.get("processor") === "browser",
    });
    return json(
      {
        success: true,
        jobId: job.id,
        status: job.status,
        invoiceId: job.invoiceId,
      },
      { status: 202 },
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Upload failed.",
      },
      { status: 400 },
    );
  }
}
