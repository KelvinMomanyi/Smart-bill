import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { login } from "../../shopify.server";

// Store identity comes from Shopify's installation/launch request. Visitors
// without that context return to the Shopify admin launch link on the home page.
export async function loader({ request }: LoaderFunctionArgs) {
  if (new URL(request.url).searchParams.get("shop")) await login(request);
  return redirect("/");
}

export async function action(_args: ActionFunctionArgs) {
  return redirect("/", { status: 303 });
}
