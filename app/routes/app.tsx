import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

import { authenticate } from "../shopify.server";
import { getUserRole } from "../utils/rbac.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const role = await getUserRole(request);

  return { 
    apiKey: process.env.SHOPIFY_API_KEY || "",
    role
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
        {role === "ADMIN" && (
          <>
            <Link to="/app/reconciliation">Purchase Orders</Link>
            <Link to="/app/analytics">Vendor Analytics</Link>
            <Link to="/app/settings">Settings</Link>
          </>
        )}
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
