import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DataTable,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { useState } from "react";
import prisma from "../db.server";
import { authenticate, SMARTBILL_PLANS } from "../shopify.server";
import {
  createInvoiceFromInput,
  getDashboard,
  getShopSettings,
} from "../services/invoiceWorkflow.server";
import { formatMoney } from "../utils/format";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const shop = session.shop;
  const [settings, dashboard, purchaseOrders] = await Promise.all([
    getShopSettings(shop),
    getDashboard(shop),
    prisma.purchaseOrder.findMany({
      where: { shop, status: { in: ["OPEN", "PARTIAL", "MISMATCH"] } },
      include: { vendor: true, items: true },
      orderBy: { updatedAt: "desc" },
      take: 25,
    }),
  ]);

  const billingStatus = await billing
    .check({
      plans: Object.values(SMARTBILL_PLANS),
      isTest: process.env.NODE_ENV !== "production",
    })
    .then((result) => ({ active: result.hasActivePayment }))
    .catch(() => ({ active: false }));

  return json({ settings, dashboard, purchaseOrders, billingStatus });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "upload-invoice") {
    return json({ success: false, error: "Unknown action" }, { status: 400 });
  }

  try {
    const file = formData.get("invoiceFile");
    const result = await createInvoiceFromInput({
      request,
      shop: session.shop,
      file: file instanceof File ? file : null,
      rawText: String(formData.get("rawText") || ""),
      vendorName: String(formData.get("vendorName") || ""),
      purchaseOrderId: String(formData.get("purchaseOrderId") || "") || null,
      syncCogs: formData.get("syncCogs") === "on",
    });

    return json({
      success: true,
      invoiceId: result.invoice.id,
      invoiceNumber: result.invoice.invoiceNumber,
      warnings: result.warnings,
    });
  } catch (error) {
    return json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 400 },
    );
  }
};

function statusTone(status: string) {
  if (
    status === "NEEDS_ATTENTION" ||
    status === "MISMATCH" ||
    status === "FAILED"
  )
    return "critical";
  if (status === "APPROVED" || status === "SYNCED" || status === "FULFILLED")
    return "success";
  if (status === "PARTIAL" || status === "PENDING") return "warning";
  return "info";
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text as="p" tone="subdued">
          {label}
        </Text>
        <Text as="p" variant="headingLg">
          {value}
        </Text>
        <Text as="p" tone="subdued">
          {detail}
        </Text>
      </BlockStack>
    </Card>
  );
}

export default function Dashboard() {
  const { settings, dashboard, purchaseOrders, billingStatus } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [vendorName, setVendorName] = useState("");
  const [rawText, setRawText] = useState("");
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [syncCogs, setSyncCogs] = useState(settings.autoSyncCogs);
  const isUploading = navigation.state === "submitting";

  const poOptions = [
    { label: "No purchase order", value: "" },
    ...purchaseOrders.map((po) => ({
      label: `${po.poNumber || `PO-${po.id.slice(0, 8)}`} - ${po.vendor.name} (${po.status})`,
      value: po.id,
    })),
  ];

  const invoiceRows = dashboard.recentInvoices.map((invoice) => [
    invoice.invoiceNumber || invoice.id.slice(0, 8),
    invoice.vendor?.name || "Unknown vendor",
    formatMoney(invoice.total, invoice.currency),
    invoice.purchaseOrder?.poNumber || "Unlinked",
    invoice.reviewStatus,
    new Date(invoice.createdAt).toLocaleDateString(),
  ]);

  const poRows = dashboard.activePurchaseOrders.map((po) => [
    po.poNumber || po.id.slice(0, 8),
    po.vendor.name,
    po.status,
    po.items.length.toString(),
    formatMoney(po.totalAmount || 0),
  ]);

  return (
    <Page
      title="SmartBill command center"
      subtitle="Capture supplier invoices, match purchase orders, update Shopify COGS, and prepare accounting exports."
      primaryAction={{ content: "Review invoices", url: "/app/invoices" }}
      secondaryActions={[{ content: "Create PO", url: "/app/reconciliation" }]}
    >
      <BlockStack gap="500">
        {!billingStatus.active && (
          <Banner
            tone="warning"
            title="No active SmartBill subscription detected"
          >
            <p>
              Start a billing plan in Settings before launching this app
              publicly.
            </p>
          </Banner>
        )}

        {actionData?.success && (
          <Banner
            tone={actionData.warnings.length > 0 ? "warning" : "success"}
            title="Invoice captured"
          >
            <p>
              Invoice {actionData.invoiceNumber || actionData.invoiceId} was
              saved.
              {actionData.warnings.length > 0
                ? ` Review warnings: ${actionData.warnings.join("; ")}`
                : ""}
            </p>
          </Banner>
        )}
        {actionData && !actionData.success && (
          <Banner tone="critical" title="Invoice capture failed">
            <p>{actionData.error}</p>
          </Banner>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
            gap: "16px",
          }}
        >
          <MetricCard
            label="Invoices this month"
            value={dashboard.metrics.invoicesThisMonth.toString()}
            detail={formatMoney(dashboard.metrics.spendThisMonth)}
          />
          <MetricCard
            label="Needs attention"
            value={dashboard.metrics.invoicesNeedingAttention.toString()}
            detail="Extraction or PO mismatch"
          />
          <MetricCard
            label="Open POs"
            value={dashboard.metrics.openPurchaseOrders.toString()}
            detail="Open, partial, or mismatch"
          />
          <MetricCard
            label="COGS synced"
            value={dashboard.metrics.cogsSyncedThisMonth.toString()}
            detail="This month"
          />
        </div>

        <Layout>
          <Layout.Section>
            <Card>
              <Form method="post" encType="multipart/form-data">
                <input type="hidden" name="intent" value="upload-invoice" />
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Capture supplier invoice
                  </Text>
                  <Text as="p" tone="subdued">
                    Upload a clear invoice image or PDF. SmartBill will extract
                    items, link a PO, and optionally sync unit costs.
                  </Text>
                  <input
                    name="invoiceFile"
                    type="file"
                    accept="image/*,.pdf,application/pdf"
                  />
                  <TextField
                    label="Vendor override"
                    name="vendorName"
                    value={vendorName}
                    onChange={setVendorName}
                    autoComplete="off"
                    helpText="Optional. Leave blank to use the supplier detected from the invoice."
                  />
                  <Select
                    label="Purchase order"
                    name="purchaseOrderId"
                    options={poOptions}
                    value={purchaseOrderId}
                    onChange={setPurchaseOrderId}
                  />
                  <TextField
                    label="OCR text"
                    name="rawText"
                    value={rawText}
                    onChange={setRawText}
                    autoComplete="off"
                    multiline={6}
                    helpText="Optional override or fallback text for images, PDFs, and email invoices."
                  />
                  <Checkbox
                    label="Sync extracted line item unit costs to Shopify COGS"
                    name="syncCogs"
                    checked={syncCogs}
                    onChange={setSyncCogs}
                  />
                  <InlineStack gap="300">
                    <Button submit variant="primary" loading={isUploading}>
                      Capture invoice
                    </Button>
                    <Button url="/app/reconciliation">
                      Manage purchase orders
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Form>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Operational posture
                </Text>
                <InlineStack gap="200">
                  <Badge
                    tone={statusTone(
                      settings.requireReview ? "PENDING" : "SYNCED",
                    )}
                  >
                    {settings.requireReview
                      ? "Review required"
                      : "Auto approval"}
                  </Badge>
                  <Badge
                    tone={settings.accountingConnected ? "success" : "warning"}
                  >
                    {settings.accountingConnected
                      ? "Accounting connected"
                      : "Accounting export pending"}
                  </Badge>
                </InlineStack>
                <Box paddingBlockStart="200">
                  <Text as="p" tone="subdued">
                    Private document storage, PO matching, vendor analytics,
                    COGS sync, and billing are now first-class workflows.
                  </Text>
                </Box>
                <Button url="/app/settings">Configure settings</Button>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Recent invoices
                </Text>
                {invoiceRows.length > 0 ? (
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
                      "Vendor",
                      "Total",
                      "PO",
                      "Review",
                      "Captured",
                    ]}
                    rows={invoiceRows}
                  />
                ) : (
                  <Text as="p" tone="subdued">
                    No invoices captured yet.
                  </Text>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Active POs
                </Text>
                {poRows.length > 0 ? (
                  <DataTable
                    columnContentTypes={[
                      "text",
                      "text",
                      "text",
                      "numeric",
                      "numeric",
                    ]}
                    headings={["PO", "Vendor", "Status", "Items", "Expected"]}
                    rows={poRows}
                  />
                ) : (
                  <Text as="p" tone="subdued">
                    Create purchase orders to unlock 2-way invoice matching.
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
