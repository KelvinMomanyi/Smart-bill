import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { timingSafeEqual } from "node:crypto";
import { processNextInvoiceJob } from "../services/invoiceJobs.server";
export async function loader({
  request,
}: LoaderFunctionArgs | ActionFunctionArgs) {
  const expected = process.env.CRON_SECRET;
  const value =
    request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  const supplied = Buffer.from(value);
  const configured = Buffer.from(expected || "");
  if (
    !expected ||
    supplied.length !== configured.length ||
    !timingSafeEqual(supplied, configured)
  )
    return new Response("Unauthorized", { status: 401 });
  return Response.json({ processed: await processNextInvoiceJob() });
}
export const action = loader;
