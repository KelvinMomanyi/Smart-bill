import {
  json,
  redirect,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { requireSubscription } from "../services/billing.server";
import {
  completeBrowserInvoiceJob,
  processNextInvoiceJob,
} from "../services/invoiceJobs.server";
export const maxDuration = 60;
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const jobs = await prisma.invoiceJob.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      filename: true,
      status: true,
      pageCount: true,
      error: true,
      invoiceId: true,
      creditNoteId: true,
      attempts: true,
    },
  });
  return json({ jobs });
}
export async function action({ request }: ActionFunctionArgs) {
  try {
    const { session } = await requireSubscription(request);
    const form = await request.formData();
    const intent = String(form.get("intent") || "retry-job");
    if (intent === "complete-browser-ocr") {
      const completed = await completeBrowserInvoiceJob({
        shop: session.shop,
        actor: session.id,
        jobId: String(form.get("jobId") || ""),
        rawText: form.get("rawText"),
        pageCount: Number(form.get("pageCount")),
      });
      return json({ success: true, ...completed });
    }
    if (intent === "fail-browser-ocr") {
      await prisma.invoiceJob.updateMany({
        where: {
          id: String(form.get("jobId") || ""),
          shop: session.shop,
          status: "AWAITING_OCR",
        },
        data: {
          status: "FAILED",
          error: String(
            form.get("error") || "Browser OCR was interrupted.",
          ).slice(0, 500),
        },
      });
      return json({ success: true });
    }
    if (intent === "process-next") {
      return json({
        success: true as const,
        processed: await processNextInvoiceJob(session.shop),
      });
    }
    if (intent !== "retry-job") throw new Error("Unknown job action.");
    const jobId = String(form.get("jobId") || "");
    if (!jobId) throw new Error("Choose a failed document to retry.");
    const retried = await prisma.invoiceJob.updateMany({
      where: {
        id: jobId,
        shop: session.shop,
        status: "FAILED",
      },
      data: {
        status: "QUEUED",
        attempts: 0,
        availableAt: new Date(),
        error: null,
      },
    });
    if (!retried.count)
      throw new Error("That failed document was not found. Reload the page.");
    return redirect("/app");
  } catch (error) {
    if (error instanceof Response) throw error;
    return json(
      { error: error instanceof Error ? error.message : "Retry failed." },
      { status: 400 },
    );
  }
}
