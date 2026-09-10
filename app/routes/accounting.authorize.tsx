import type { LoaderFunctionArgs } from "@remix-run/node";
import { launchAuthorization } from "../services/accountingAuthorization.server";
export async function loader({ request }: LoaderFunctionArgs) {
  try {
    return await launchAuthorization(request);
  } catch (error) {
    throw new Response(
      error instanceof Error ? error.message : "Connection failed.",
      { status: 400 },
    );
  }
}
