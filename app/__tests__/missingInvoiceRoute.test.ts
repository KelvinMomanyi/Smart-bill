import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import prisma from "../db.server";

const originalCount = prisma.session.count;
(prisma.session as any).count = async () => 0;
const { authenticate } = await import("../shopify.server");
const { loader: invoice } = await import("../routes/app.invoices.$id");
const { loader: accounting } = await import("../routes/app.invoices.$id_.accounting");
const { loader: credit } = await import("../routes/app.credit-notes.$id");
prisma.session.count = originalCount;
const shop = "missing-document-review.myshopify.com";
function replace(t: TestContext, object: any, name: string, method: any) {
  const previous = object[name]; object[name] = method;
  t.after(() => { object[name] = previous; });
}
const routes = [
  { name: "invoice", loader: invoice, model: prisma.invoice, missing: "missingInvoice" },
  { name: "accounting details", loader: accounting, model: prisma.invoice, missing: "missingInvoice" },
  { name: "credit note", loader: credit, model: prisma.creditNote, missing: "missingCreditNote" },
];
for (const route of routes) {
  test(`missing or foreign ${route.name} returns an operational page without exposing another shop`, async t => {
    t.mock.method(authenticate, "admin", async () => ({ session: { shop, id: "owner", isOnline: true }, admin: {} }) as any);
    replace(t, prisma.session, "findUnique", async () => ({ role: "ADMIN" }));
    replace(t, route.model, "findFirst", async (args: any) => {
      assert.equal(args.where.shop, shop);
      assert.equal(args.where.id, "foreign-or-deleted-record");
      return null;
    });
    const response = await route.loader({ request: new Request(`https://app.example/app/${route.name}`), params: { id: "foreign-or-deleted-record" }, context: {} });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { [route.missing]: true });
  });
}
test("missing-document recovery never bypasses Shopify authentication", async t => {
  const expired = new Response(null, { status: 401 });
  t.mock.method(authenticate, "admin", async () => { throw expired; });
  for (const route of routes) {
    await assert.rejects(route.loader({ request: new Request("https://app.example/app/invoices/deleted"), params: { id: "deleted" }, context: {} }), error => error === expired);
  }
});
