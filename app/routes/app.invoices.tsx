import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  DataTable,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { exportInvoiceToAccounting } from "../services/accountingExport.server";
import { approveInvoice } from "../services/invoiceWorkflow.server";
import { formatMoney } from "../utils/format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const invoices = await prisma.invoice.findMany({
    where: { shop },
    include: { vendor: true, items: true, purchaseOrder: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const accountingConnections = await prisma.accountingConnection.findMany({
    where: { shop },
    select: { platform: true },
  });

  return json({
    invoices,
    connectedPlatforms: accountingConnections.map(
      (connection) => connection.platform,
    ),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const invoiceId = String(formData.get("invoiceId") || "");

  if (!invoiceId) {
    return json({ success: false, error: "Missing invoice id" }, { status: 400 });
  }

  try {
    if (intent === "approve") {
      await approveInvoice(session.shop, invoiceId);
      return json({ success: true, message: "Invoice approved" });
    }

    if (intent === "export-xero" || intent === "export-quickbooks" || intent === "export-csv") {
      const platform =
        intent === "export-xero" ? "XERO" : intent === "export-quickbooks" ? "QUICKBOOKS" : "CSV";
      const result = await exportInvoiceToAccounting(session.shop, invoiceId, platform);
      return json({
        success: true,
        message:
          result.mode === "LIVE_SYNC"
            ? `Invoice synced to ${platform}`
            : `Invoice marked ready for ${platform} export`,
      });
    }

    return json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
};

function badgeTone(status: string) {
  if (["NEEDS_ATTENTION", "FAILED"].includes(status)) return "critical";
  if (["APPROVED", "SYNCED", "EXPORTED"].includes(status)) return "success";
  if (["PENDING", "PENDING_REVIEW", "PENDING_SYNC"].includes(status)) return "warning";
  return "info";
}

function InvoiceActions({
  invoiceId,
  connectedPlatforms,
}: {
  invoiceId: string;
  connectedPlatforms: string[];
}) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";

  return (
    <InlineStack gap="200">
      <Form method="post">
        <input type="hidden" name="intent" value="approve" />
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <Button submit size="slim" loading={busy}>
          Approve
        </Button>
      </Form>
      <Form method="post">
        <input type="hidden" name="intent" value="export-csv" />
        <input type="hidden" name="invoiceId" value={invoiceId} />
        <Button submit size="slim" loading={busy}>
          CSV
        </Button>
      </Form>
      {connectedPlatforms.includes("XERO") && (
        <Form method="post">
          <input type="hidden" name="intent" value="export-xero" />
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <Button submit size="slim" loading={busy}>
            Xero
          </Button>
        </Form>
      )}
      {connectedPlatforms.includes("QUICKBOOKS") && (
        <Form method="post">
          <input type="hidden" name="intent" value="export-quickbooks" />
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <Button submit size="slim" loading={busy}>
            QuickBooks
          </Button>
        </Form>
      )}
    </InlineStack>
  );
}

export default function InvoiceReviewQueue() {
  const { invoices, connectedPlatforms } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  const attention = invoices.filter((invoice) => invoice.reviewStatus === "NEEDS_ATTENTION");
  const approved = invoices.filter((invoice) => invoice.reviewStatus === "APPROVED");
  const totalSpend = invoices.reduce((sum, invoice) => sum + invoice.total, 0);

  const rows = invoices.map((invoice) => [
    invoice.invoiceNumber || invoice.id.slice(0, 8),
    invoice.vendor?.name || "Unknown",
    formatMoney(invoice.total, invoice.currency),
    invoice.purchaseOrder?.poNumber || "Unlinked",
    <Badge key={`${invoice.id}-review`} tone={badgeTone(invoice.reviewStatus)}>
      {invoice.reviewStatus}
    </Badge>,
    <Badge key={`${invoice.id}-cogs`} tone={badgeTone(invoice.cogsSyncStatus)}>
      {invoice.cogsSyncStatus}
    </Badge>,
    <Badge key={`${invoice.id}-accounting`} tone={badgeTone(invoice.accountingStatus)}>
      {invoice.accountingStatus}
    </Badge>,
    <InvoiceActions
      key={`${invoice.id}-actions`}
      invoiceId={invoice.id}
      connectedPlatforms={connectedPlatforms}
    />,
  ]);

  return (
    <Page
      title="Invoice review queue"
      subtitle="Approve captured invoices, inspect mismatches, and export clean records."
      secondaryActions={[{ content: "Download CSV", url: "/api/exportCSV" }]}
    >
      <BlockStack gap="500">
        {actionData?.success && (
          <Banner tone="success" title={actionData.message}>
            <p>The invoice queue has been updated.</p>
          </Banner>
        )}
        {actionData && !actionData.success && (
          <Banner tone="critical" title="Action failed">
            <p>{actionData.error}</p>
          </Banner>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "16px" }}>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Total invoices
              </Text>
              <Text as="p" variant="headingLg">
                {invoices.length}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Needs attention
              </Text>
              <Text as="p" variant="headingLg">
                {attention.length}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Approved
              </Text>
              <Text as="p" variant="headingLg">
                {approved.length}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Spend captured
              </Text>
              <Text as="p" variant="headingLg">
                {formatMoney(totalSpend)}
              </Text>
            </BlockStack>
          </Card>
        </div>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Captured invoices
                </Text>
                {rows.length > 0 ? (
                  <DataTable
                    columnContentTypes={["text", "text", "numeric", "text", "text", "text", "text", "text"]}
                    headings={["Invoice", "Vendor", "Total", "PO", "Review", "COGS", "Accounting", "Actions"]}
                    rows={rows}
                  />
                ) : (
                  <Text as="p" tone="subdued">
                    Capture an invoice from the command center to start the review workflow.
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
