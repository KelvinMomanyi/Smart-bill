import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, Link, useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Button,
  DataTable,
  InlineStack,
} from "@shopify/polaris";
import prisma from "../db.server";
import { requireAdmin } from "../utils/rbac.server";
import { getShopSettings } from "../services/invoiceWorkflow.server";
import { currencyTotals, validDate } from "../utils/invoiceRules";
import { formatMoney } from "../utils/format";
import { reportingForPeriod } from "../services/reportingAggregation.server";
import { previewFxRevaluation } from "../services/fxRevaluation.server";
export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await requireAdmin(request);
  const url = new URL(request.url);
  const raw = url.searchParams.get("from");
  const from =
    raw && validDate(raw) ? new Date(raw) : new Date(Date.now() - 365 * 86400000);
  from.setUTCHours(0, 0, 0, 0);
  const rawUntil = url.searchParams.get("until");
  const until = rawUntil && validDate(rawUntil)
    ? new Date(rawUntil)
    : new Date(Date.now() + 86400000);
  until.setUTCHours(0, 0, 0, 0);
  if (until <= from)
    throw new Response("The report end date must follow its start date.", { status: 400 });
  const duration = until.getTime() - from.getTime();
  const previousFrom = new Date(from.getTime() - duration);
  const [invoices, approvals, exports, costChanges, settings, attention, report, previous, creditStatus, fxRevaluation] =
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
      reportingForPeriod(session.shop, from, until),
      reportingForPeriod(session.shop, previousFrom, from),
      prisma.creditNote.groupBy({
        by: ["status"],
        where: { shop: session.shop },
        _count: { _all: true },
        _sum: { amount: true },
      }),
      previewFxRevaluation(session.shop, from, until),
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
    report,
    previousVendorSpend: previous.vendorSpend,
    creditStatus,
    fxRevaluation,
    estimatedHours: (approvedCount * settings.minutesSavedPerInvoice) / 60,
  });
}
export default function VendorReport() {
  const r = useLoaderData<typeof loader>();
  return (
    <Page
      title="Vendor spend and margin report"
      subtitle={`${r.from} to ${r.until} (UTC, end date excluded)`}
    >
      <BlockStack gap="400">
        <Card>
          <Form method="get">
            <InlineStack gap="300" blockAlign="end">
              <label>
                From <input name="from" type="date" defaultValue={r.from} />
              </label>
              <label>
                Until <input name="until" type="date" defaultValue={r.until} />
              </label>
              <Button submit>Apply period</Button>
              <Button url={`/api/reports/csv?from=${r.from}&until=${r.until}`}>
                Export CSV
              </Button>
            </InlineStack>
          </Form>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Material FX revaluation</Text>
            <Text as="p" tone="subdued">
              Foreign invoices appear when the latest stored rate differs by at
              least 5% from the approved invoice rate.
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "numeric", "numeric", "numeric"]}
              headings={["Invoice", "Supplier", "Original rate", "Latest rate", "Gain / loss"]}
              rows={r.fxRevaluation.map((row) => [
                <Link key={row.invoiceId} to={`/app/invoices/${row.invoiceId}`}>
                  {row.invoiceNumber || row.invoiceId.slice(0, 8)}
                </Link>,
                row.supplier,
                row.originalRate,
                row.currentRate,
                `${row.effect}: ${formatMoney(Math.abs(row.difference), row.toCurrency)}`,
              ])}
            />
          </BlockStack>
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
            <Text as="h2" variant="headingMd">Top suppliers</Text>
            <DataTable
              columnContentTypes={["text", "numeric", "numeric", "numeric"]}
              headings={["Supplier", "Invoices", "Net spend", "Previous period"]}
              rows={r.report.vendorSpend.slice(0, 10).map((supplier) => {
                const previous = r.previousVendorSpend.find(
                  (entry) =>
                    entry.supplierId === supplier.supplierId &&
                    entry.currency === supplier.currency,
                )?.total ?? 0;
                return [
                  supplier.supplier,
                  supplier.invoices,
                  formatMoney(supplier.total, supplier.currency),
                  formatMoney(previous, supplier.currency),
                ];
              })}
            />
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Monthly vendor trend</Text>
            <DataTable
              columnContentTypes={["text", "text", "numeric"]}
              headings={["Month", "Supplier", "Spend"]}
              rows={r.report.monthlySpend.slice(-36).map((row) => [
                row.month,
                row.supplier,
                formatMoney(row.total, row.currency),
              ])}
            />
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Price changes and estimated margin impact
            </Text>
            <Text as="p" tone="subdued">
              Margin impact estimates the latest purchased quantity at the
              change in unit cost. Negative values indicate margin pressure.
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "numeric"]}
              headings={["Supplier", "SKU", "Previous", "Current", "Change", "Margin impact"]}
              rows={r.report.priceChanges.slice(0, 50).map((row) => [
                row.supplier,
                row.sku,
                formatMoney(row.previousCost, row.currency),
                formatMoney(row.currentCost, row.currency),
                row.percent == null ? "New" : `${row.percent.toFixed(1)}%`,
                formatMoney(row.marginImpact, row.currency),
              ])}
            />
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Supplier performance</Text>
            <DataTable
              columnContentTypes={["text", "numeric", "numeric", "numeric"]}
              headings={["Supplier", "Average invoice", "PO accuracy", "Mismatches"]}
              rows={r.report.supplierPerformance.map((row) => [
                row.supplier,
                formatMoney(row.averageInvoice, row.currency),
                `${row.accuracyPercent.toFixed(1)}%`,
                row.mismatches,
              ])}
            />
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">COGS by invoice category</Text>
            <DataTable
              columnContentTypes={["text", "numeric"]}
              headings={["Category", "Line spend"]}
              rows={r.report.categorySpend.map((row) => [
                row.category,
                formatMoney(row.total, row.currency),
              ])}
            />
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">Credit-note aging</Text>
            {r.creditStatus.length ? (
              r.creditStatus.map((entry) => (
                <Text as="p" key={entry.status}>
                  {entry.status}: {entry._count._all} notes, total{" "}
                  {entry._sum.amount?.toFixed(2) || "0.00"} in their document currencies
                </Text>
              ))
            ) : (
              <Text as="p" tone="subdued">No credit notes recorded.</Text>
            )}
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
