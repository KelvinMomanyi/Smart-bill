import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { createRequestHandler } from "@remix-run/node";

// Exercise the production bundle without deployed credentials or a database.
process.env.NODE_ENV = "production";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/submission_check?connect_timeout=1";
process.env.SHOPIFY_API_KEY = "00000000000000000000000000000000";
process.env.SHOPIFY_API_SECRET = "submission-check-secret";
process.env.SHOPIFY_APP_URL = "https://app.example";
const prisma = new PrismaClient();
prisma.session.count = async () => 0;
globalThis.prismaGlobal = prisma;

try {
  const build = await import("../build/server/index.js");
  const handle = createRequestHandler(build, "production");
  const request = (path, options) => handle(new Request(`https://app.example${path}`, options));

  const home = await request("/");
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /href="https:\/\/admin\.shopify\.com\/apps"/);
  assert.doesNotMatch(html, /name="shop"|Shop domain|my-shop-domain/);

  const login = await request("/auth/login");
  assert.equal(login.status, 302);
  assert.equal(login.headers.get("Location"), "/");

  const manualLogin = await request("/auth/login", {
    method: "POST",
    body: new URLSearchParams({ shop: "manually-entered.myshopify.com" }),
  });
  assert.equal(manualLogin.status, 303);
  assert.equal(manualLogin.headers.get("Location"), "/");

  const managedLogin = await request("/auth/login?shop=submission-check.myshopify.com");
  assert.equal(managedLogin.status, 302);
  assert.match(managedLogin.headers.get("Location"), /^https:\/\/admin\.shopify\.com\/store\/submission-check\/oauth\/install\?/);

  for (const path of ["/privacy", "/terms"]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    await response.text();
  }
  console.log("Production bundle: landing page, Shopify launch/login redirects and legal pages passed (no database or merchant charges).");
} finally {
  await prisma.$disconnect();
}
