import { json, type ActionFunctionArgs } from "@remix-run/node";
import { requireSubscription } from "../services/billing.server";
import { enqueueDocument } from "../services/invoiceJobs.server";
export async function action({ request }: ActionFunctionArgs) {
  try {
    const { session, plan } = await requireSubscription(request);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size)
      throw new Error("Select a document.");
    const job = await enqueueDocument({
      shop: session.shop,
      plan,
      buffer: Buffer.from(await file.arrayBuffer()),
      filename: file.name,
      contentType: file.type,
    });
    return json(
      { success: true, jobId: job.id, status: job.status },
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
