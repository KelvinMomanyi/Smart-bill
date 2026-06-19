import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Card,
  DataTable,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import prisma from "../db.server";
import { formatMoney } from "../utils/format";
import { requireAdmin } from "../utils/rbac.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await requireAdmin(request);
  const shop = session.shop;

  const [vendors, invoices, purchaseOrders] = await Promise.all([
    prisma.vendor.findMany({
      where: { shop },
      include: {
        invoices: true,
        purchaseOrders: true,
      },
    }),
    prisma.invoice.findMany({
      where: { shop },
      include: { vendor: true, items: true, purchaseOrder: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.purchaseOrder.findMany({
      where: { shop },
      include: { vendor: true, items: true, linkedInvoices: true },
    }),
  ]);

  const vendorAnalytics = vendors
    .map((vendor) => {
      const totalSpend = vendor.invoices.reduce((sum, inv) => sum + (inv.total || 0), 0);
      const invoiceCount = vendor.invoices.length;
      const averageInvoice = invoiceCount > 0 ? totalSpend / invoiceCount : 0;
      const mismatchCount = vendor.purchaseOrders.filter((po) => po.status === "MISMATCH").length;
      return {
        id: vendor.id,
        name: vendor.name,
        totalSpend,
        invoiceCount,
        averageInvoice,
        purchaseOrderCount: vendor.purchaseOrders.length,
        mismatchCount,
      };
    })
    .sort((a, b) => b.totalSpend - a.totalSpend);

  const totalSpend = invoices.reduce((sum, invoice) => sum + invoice.total, 0);
  const needsAttention = invoices.filter((invoice) => invoice.reviewStatus === "NEEDS_ATTENTION").length;
  const syncedCogs = invoices.filter((invoice) => invoice.cogsSyncStatus === "SYNCED").length;
  const exported = invoices.filter((invoice) => invoice.accountingStatus === "EXPORTED").length;
  const mismatchedPOs = purchaseOrders.filter((po) => po.status === "MISMATCH").length;

  return json({
    vendorAnalytics,
    metrics: {
      totalSpend,
      invoiceCount: invoices.length,
      needsAttention,
      syncedCogs,
      exported,
      mismatchedPOs,
      purchaseOrderCount: purchaseOrders.length,
    },
  });
};

function HealthBadge({ value, total }: { value: number; total: number }) {
  const ratio = total === 0 ? 0 : value / total;
  const tone = ratio === 0 ? "success" : ratio < 0.15 ? "warning" : "critical";
  return <Badge tone={tone}>{value.toString()}</Badge>;
}

export default function AnalyticsDashboard() {
  const { vendorAnalytics, metrics } = useLoaderData<typeof loader>();

  const rows = vendorAnalytics.map((vendor) => [
    vendor.name,
    vendor.invoiceCount.toString(),
    vendor.purchaseOrderCount.toString(),
    formatMoney(vendor.totalSpend),
    formatMoney(vendor.averageInvoice),
    <HealthBadge key={vendor.id} value={vendor.mismatchCount} total={vendor.purchaseOrderCount} />,
  ]);

  return (
    <Page title="Vendor analytics" subtitle="Track supplier spend, invoice quality, PO mismatches, and automation throughput.">
      <BlockStack gap="500">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "16px" }}>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Spend captured
              </Text>
              <Text as="p" variant="headingLg">
                {formatMoney(metrics.totalSpend)}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Invoices captured
              </Text>
              <Text as="p" variant="headingLg">
                {metrics.invoiceCount}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Needs attention
              </Text>
              <Text as="p" variant="headingLg">
                {metrics.needsAttention}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Mismatched POs
              </Text>
              <Text as="p" variant="headingLg">
                {metrics.mismatchedPOs}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                COGS synced
              </Text>
              <Text as="p" variant="headingLg">
                {metrics.syncedCogs}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Accounting exports
              </Text>
              <Text as="p" variant="headingLg">
                {metrics.exported}
              </Text>
            </BlockStack>
          </Card>
        </div>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Supplier scorecard
                </Text>
                {rows.length > 0 ? (
                  <DataTable
                    columnContentTypes={["text", "numeric", "numeric", "numeric", "numeric", "text"]}
                    headings={["Vendor", "Invoices", "POs", "Spend", "Avg invoice", "Mismatches"]}
                    rows={rows}
                  />
                ) : (
                  <Text as="p" tone="subdued">
                    Capture invoices and create purchase orders to generate vendor analytics.
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
