import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { AppErrorState } from "../components/AppErrorState";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return json({}, { status: 404 });
}
export default function MissingAppPage() {
  return (
    <AppErrorState
      title="Page not found"
      message="Return to SmartBill to continue."
    />
  );
}
