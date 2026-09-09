import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, Link, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Button,
  DataTable,
} from "@shopify/polaris";
import prisma from "../db.server";
import { requireAdmin } from "../utils/rbac.server";
import { getShopSettings } from "../services/invoiceWorkflow.server";
import { currencyTotals, validDate } from "../utils/invoiceRules";
import { formatMoney } from "../utils/format";
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await requireAdmin(request);
  const raw = new URL(request.url).searchParams.get("from");
  const from =
    raw && validDate(raw) ? new Date(raw) : new Date(Date.now() - 7 * 86400000);
  from.setUTCHours(0, 0, 0, 0);
  const until = new Date(from.getTime() + 7 * 86400000);
  const [invoices, approvals, exports, costChanges, settings, attention] =
    await Promise.all([
      prisma.invoice.findMany({
        where: { shop: session.shop, createdAt: { gte: from, lt: until } },
        include: { vendor: true },
      }),
      prisma.auditEvent.findMany({
        where: {
          shop: session.shop,
          action: "APPROVED",
          createdAt: { gte: from, lt: until },
        },
        select: { invoiceId: true },
      }),
      prisma.accountingExport.count({
        where: {
          shop: session.shop,
          status: "EXPORTED",
          updatedAt: { gte: from, lt: until },
        },
      }),
      prisma.costChange.count({
        where: {
          shop: session.shop,
          status: "APPLIED",
          updatedAt: { gte: from, lt: until },
        },
      }),
      getShopSettings(session.shop),
      prisma.invoice.findMany({
        where: { shop: session.shop, reviewStatus: "NEEDS_ATTENTION" },
        include: { vendor: true },
        take: 50,
      }),
    ]);
  const approvedCount = new Set(approvals.map((a) => a.invoiceId)).size;
  return json({
    from: from.toISOString().slice(0, 10),
    until: until.toISOString().slice(0, 10),
    invoiceCount: invoices.length,
    spend: currencyTotals(invoices),
    approvedCount,
    exports,
    costChanges,
    attention,
    estimatedHours: (approvedCount * settings.minutesSavedPerInvoice) / 60,
  });
}
export default function WeeklyReport() {
  const r = useLoaderData<typeof loader>();
  return (
    <Page
      title="Weekly operations report"
      subtitle={`${r.from} to ${r.until} (UTC, end date excluded)`}
    >
      <BlockStack gap="400">
        <Card>
          <Form method="get">
            <label>
              Week starting{" "}
              <input name="from" type="date" defaultValue={r.from} />
            </label>{" "}
            <Button submit>View week</Button>
          </Form>
        </Card>
        <Card>
          <BlockStack gap="200">
            <Text as="p">
              Captured: {r.invoiceCount} invoices · Approved: {r.approvedCount}{" "}
              · Bills exported: {r.exports} · Product costs updated:{" "}
              {r.costChanges}
            </Text>
            <Text as="p">
              Supplier spend:{" "}
              {r.spend
                .map((t) => formatMoney(t.total, t.currency))
                .join(" · ") || "No invoices"}
            </Text>
            <Text as="p">
              {r.estimatedHours > 0
                ? `Estimated staff time saved: ${r.estimatedHours.toFixed(1)} hours, using your configured minutes per invoice.`
                : "Measure your time saved per invoice and enter it in Settings to estimate the weekly benefit."}
            </Text>
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Outstanding invoice issues
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "text"]}
              headings={["Invoice", "Supplier", "Issue"]}
              rows={r.attention.map((i) => [
                <Link key={i.id} to={`/app/invoices/${i.id}`}>
                  {i.invoiceNumber || i.id.slice(0, 8)}
                </Link>,
                i.vendor?.name || "Unknown",
                i.discrepancySummary || "Review extraction",
              ])}
            />
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
