import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import {
  Link,
  Outlet,
  isRouteErrorResponse,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import formStyles from "../styles/forms.css?url";

import { IntuitTrademarkNotice } from "../components/IntuitTrademarkNotice";
import { SmartBillBrand } from "../components/SmartBillBrand";
import { AppErrorState } from "../components/AppErrorState";
import { authenticate } from "../shopify.server";
import { getUserRole } from "../utils/rbac.server";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
  { rel: "stylesheet", href: formStyles },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const role = await getUserRole(request);

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    shop: session.shop,
    role,
  };
};

export default function App() {
  const { apiKey, role } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Command Center
        </Link>
        <Link to="/app/invoices">Review Invoices</Link>
        {(role === "ADMIN" || role === "FINANCE") && (
          <Link to="/app/credit-notes">Credit notes</Link>
        )}
        {role === "ADMIN" && (
          <>
            <Link to="/app/reconciliation">Purchase Orders</Link>
            <Link to="/app/analytics">Vendor Analytics</Link>
            <Link to="/app/reports">Vendor reports</Link>
            <Link to="/app/settings">Settings</Link>
          </>
        )}
      </NavMenu>
      <header className="smartbill-app-brand">
        <Link to="/app" aria-label="SmartBill home">
          <SmartBillBrand size={32} />
        </Link>
      </header>
      <main className="smartbill-workspace">
        <Outlet />
      </main>
      <IntuitTrademarkNotice className="smartbill-trademark-notice" />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  const error = useRouteError();
  // The SDK throws a successful HTML response to escape the iframe for auth
  // and billing redirects. Preserve that protocol and Shopify's headers.
  if (isRouteErrorResponse(error) && error.status === 200)
    return boundary.error(error);
  if (isRouteErrorResponse(error) && error.status === 401)
    return (
      <AppErrorState
        title="Your session needs refreshing"
        message="Reopen SmartBill from Apps in Shopify admin, then try again."
      />
    );
  if (isRouteErrorResponse(error) && error.status === 403)
    return (
      <AppErrorState
        title="Access required"
        message="Ask your store owner to grant access to this part of SmartBill."
      />
    );
  if (isRouteErrorResponse(error) && error.status === 404)
    return (
      <AppErrorState
        title="Page not found"
        message="Return to SmartBill to continue."
      />
    );
  return <AppErrorState />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
