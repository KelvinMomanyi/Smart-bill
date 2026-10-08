import {
  Link,
  isRouteErrorResponse,
  useRouteError,
  useLocation,
  useRouteLoaderData,
} from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { shopDomain, shopifyAdminAppsUrl } from "../utils/shopifyNavigation";

// No loader data or provider is needed: this also works when app startup fails.
export function AppErrorState({
  title = "SmartBill couldn't load this page",
  message = "Please try again. If the problem continues, reopen SmartBill from Apps in Shopify admin.",
  backTo = "/app",
  backLabel = "Back to SmartBill",
}: {
  title?: string;
  message?: string;
  backTo?: string;
  backLabel?: string;
}) {
  const app = useRouteLoaderData<{ shop?: string }>("routes/app");
  const location = useLocation();
  const shop =
    shopDomain(app?.shop) ||
    shopDomain(new URLSearchParams(location.search).get("shop"));
  const adminUrl = shopifyAdminAppsUrl(shop);
  const backUrl = shop
    ? `${backTo}${backTo.includes("?") ? "&" : "?"}shop=${encodeURIComponent(shop)}`
    : backTo;
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "48px auto",
        padding: 24,
        fontFamily: "system-ui",
        overflowWrap: "anywhere",
      }}
    >
      <h1>{title}</h1>
      <p role="alert">{message}</p>
      <p>
        <Link to={backUrl}>{backLabel}</Link>
      </p>
      {adminUrl ? (
        <p>
          <a href={adminUrl} target="_top">
            Open Shopify admin for {shop}
          </a>
        </p>
      ) : (
        <p>
          Open the store you were using in Shopify admin, then choose SmartBill
          from Apps.
        </p>
      )}
      <button type="button" onClick={() => window.location.reload()}>
        Try again
      </button>
    </main>
  );
}

export function AccountingConnectionErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 200)
    return boundary.error(error);
  return (
    <AppErrorState
      title="Accounting connection couldn't be completed"
      message="This connection link may have expired. Return to SmartBill Settings and reconnect your accounting company."
      backTo="/app/settings"
      backLabel="Back to Settings"
    />
  );
}
