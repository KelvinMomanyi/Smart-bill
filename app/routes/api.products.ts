import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { requireSubscription } from "../services/billing.server";
import { findVariants } from "../services/invoiceReview.server";
export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await requireSubscription(request);
  const query = new URL(request.url).searchParams.get("q")?.trim();
  return json({ variants: query ? await findVariants(admin, query) : [] });
}
