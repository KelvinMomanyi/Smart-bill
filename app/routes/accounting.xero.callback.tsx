import type { LoaderFunctionArgs } from "@remix-run/node";
import { completeAuthorizationCallback } from "../services/accountingAuthorization.server";
export async function loader({ request }: LoaderFunctionArgs) {
  try {
    return await completeAuthorizationCallback(request, "XERO");
  } catch (error) {
    if (error instanceof Response) throw error;
    throw new Response(
      "The accounting connection could not be completed. Return to Settings and reconnect.",
      { status: 400 },
    );
  }
}
export { AccountingConnectionErrorBoundary as ErrorBoundary } from "../components/AppErrorState";
