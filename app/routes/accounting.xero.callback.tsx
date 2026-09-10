import type { LoaderFunctionArgs } from "@remix-run/node";
import { completeAuthorizationCallback } from "../services/accountingAuthorization.server";
export async function loader({ request }: LoaderFunctionArgs) {
  try {
    return await completeAuthorizationCallback(request, "XERO");
  } catch (error) {
    throw new Response(
      error instanceof Error
        ? error.message
        : "Accounting connection failed. Start again in Settings.",
      { status: 400 },
    );
  }
}
