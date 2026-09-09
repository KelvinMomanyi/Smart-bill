import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, Link, useLoaderData, useOutlet } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  DataTable,
  Button,
  InlineStack,
} from "@shopify/polaris";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { formatMoney } from "../utils/format";
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = Math.max(
    1,
    Number.parseInt(url.searchParams.get("page") || "1", 10) || 1,
  );
  const search = (url.searchParams.get("q") || "").slice(0, 100);
  const status = url.searchParams.get("status") || "";
  const where = {
    shop: session.shop,
    ...(search
      ? {
          OR: [
            {
              invoiceNumber: { contains: search, mode: "insensitive" as const },
            },
            {
              vendor: {
                name: { contains: search, mode: "insensitive" as const },
              },
            },
          ],
        }
      : {}),
    ...(["APPROVED", "PENDING_REVIEW", "NEEDS_ATTENTION"].includes(status)
      ? { reviewStatus: status }
      : {}),
  };
  const [invoices, count] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: { vendor: true, purchaseOrder: true },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * 25,
      take: 25,
    }),
    prisma.invoice.count({ where }),
  ]);
  return json({ invoices, count, page, search, status });
}
export default function InvoiceQueue() {
  const data = useLoaderData<typeof loader>();
  const outlet = useOutlet();
  if (outlet) return outlet;
  const query = (page: number) =>
    `/app/invoices?${new URLSearchParams({ page: String(page), q: data.search, status: data.status })}`;
  return (
    <Page
      title="Invoice review"
      subtitle="Open an invoice to inspect the original, correct its lines and approve it."
    >
      <BlockStack gap="400">
        <Card>
          <Form method="get">
            <InlineStack gap="300">
              <label>
                Search invoices or suppliers{" "}
                <input name="q" defaultValue={data.search} />
              </label>
              <label>
                Status{" "}
                <select name="status" defaultValue={data.status}>
                  <option value="">All</option>
                  <option value="PENDING_REVIEW">Pending review</option>
                  <option value="NEEDS_ATTENTION">Needs attention</option>
                  <option value="APPROVED">Approved</option>
                </select>
              </label>
              <Button submit>Search</Button>
            </InlineStack>
          </Form>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="p">{data.count} invoices</Text>
            <DataTable
              columnContentTypes={[
                "text",
                "text",
                "numeric",
                "text",
                "text",
                "text",
              ]}
              headings={[
                "Invoice",
                "Supplier",
                "Total",
                "PO",
                "Review",
                "Accounting",
              ]}
              rows={data.invoices.map((i) => [
                <Link key={i.id} to={`/app/invoices/${i.id}`}>
                  {i.invoiceNumber || i.id.slice(0, 8)}
                </Link>,
                i.vendor?.name || "Unknown",
                formatMoney(i.total, i.currency),
                i.purchaseOrder?.poNumber || "—",
                i.reviewStatus,
                i.accountingStatus,
              ])}
            />
            <InlineStack gap="300">
              {data.page > 1 && (
                <Button url={query(data.page - 1)}>Previous</Button>
              )}
              {data.page * 25 < data.count && (
                <Button url={query(data.page + 1)}>Next</Button>
              )}
            </InlineStack>
            <Button url="/api/exportCSV">Download approved invoices CSV</Button>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
