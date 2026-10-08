import type { LinksFunction } from "@remix-run/node";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "@remix-run/react";
import { AppErrorState } from "./components/AppErrorState";

export const links: LinksFunction = () => [
  {
    rel: "icon",
    href: "/favicon.ico?v=invoice-inventory",
    sizes: "16x16 32x32 48x48",
  },
  {
    rel: "icon",
    href: "/brand/smartbill-icon-32.png",
    type: "image/png",
    sizes: "32x32",
  },
  {
    rel: "icon",
    href: "/brand/smartbill-icon-16.png",
    type: "image/png",
    sizes: "16x16",
  },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png", sizes: "180x180" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="theme-color" content="#17653e" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return (
    <AppErrorState
      {...(missing
        ? {
            title: "Page not found",
            message:
              "This page may have moved. Return to SmartBill to continue.",
          }
        : {})}
    />
  );
}
