import { forwardRef } from "react";
import {
  Link as RemixLink,
  useRouteLoaderData,
  type LinkProps,
} from "@remix-run/react";
import { shopifyAppPath } from "../utils/shopifyNavigation";

// Keep normal Remix navigation while also making the server-rendered href
// usable before hydration and when a merchant opens it in another tab.
export const EmbeddedLink = forwardRef<HTMLAnchorElement, LinkProps>(
  function EmbeddedLink({ to, ...props }, ref) {
    const appPath = useEmbeddedAppPath();
    const destination = typeof to === "string" ? appPath(to) : to;
    return <RemixLink {...props} to={destination} ref={ref} />;
  },
);

export function useEmbeddedAppPath() {
  const app = useRouteLoaderData<{ shop: string }>("routes/app");
  return (path: string) => shopifyAppPath(path, app?.shop);
}

export function EmbeddedNavigationFields() {
  const appPath = useEmbeddedAppPath();
  const params = new URLSearchParams(appPath("/app").split("?")[1]);
  const shop = params.get("shop");
  const host = params.get("host");
  if (!shop || !host) return null;
  // A native GET form replaces the URL query; keep the SDK navigation hints.
  return (
    <>
      <input type="hidden" name="shop" value={shop} />
      <input type="hidden" name="host" value={host} />
    </>
  );
}
