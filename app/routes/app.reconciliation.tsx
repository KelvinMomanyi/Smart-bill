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
  Button,
  Card,
  DataTable,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { useEffect, useRef, useState } from "react";
import {
  EmbeddedLink as Link,
  useEmbeddedAppPath,
} from "../components/EmbeddedLink";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { subscriptionFor } from "../services/billing.server";
import {
  createPurchaseOrder,
  purchaseOrderInput,
  PurchaseOrderInputError,
} from "../services/purchaseOrders.server";
import { formatMoney } from "../utils/format";
import { parsePoItems } from "../utils/poItems";
import {
  emptyPoRow,
  readPoFormValues,
  type PoFormRow,
  type PoFieldErrors,
} from "../utils/purchaseOrderForm";
import { requireAdmin } from "../utils/rbac.server";

type PoLoaderData = {
  purchaseOrders: Prisma.PurchaseOrderGetPayload<{
    include: {
      vendor: true;
      items: true;
      linkedInvoices: { include: { items: true } };
    };
  }>[];
  loadError: string | null;
  submissionId: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await requireAdmin(request);
  const shop = session.shop;

  try {
    const purchaseOrders = await prisma.purchaseOrder.findMany({
      where: { shop },
      include: {
        vendor: true,
        items: true,
        linkedInvoices: { include: { items: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });

    return json<PoLoaderData>({
      purchaseOrders,
      loadError: null,
      submissionId: randomUUID(),
    });
  } catch (error) {
    logPoError(shop, error);
    return json<PoLoaderData>({
      purchaseOrders: [],
      submissionId: randomUUID(),
      loadError:
        "Purchase orders could not be loaded. Please retry. Your saved orders have not been changed.",
    });
  }
};

function logPoError(shop: string, error: unknown) {
  const reference = randomUUID();
  console.error("Purchase order operation failed", {
    shop,
    reference,
    code:
      error && typeof error === "object" && "code" in error
        ? error.code
        : "UNKNOWN",
    type: error instanceof Error ? error.name : "UnknownError",
  });
  return reference;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await requireAdmin(request);
  const shop = session.shop;
  let formData = new FormData();
  const failure = (
    error: string,
    fieldErrors: PoFieldErrors = {},
    settingsRequired = false,
  ) =>
    json({
      success: false as const,
      error,
      fieldErrors,
      settingsRequired,
      values: readPoFormValues(formData),
    });
  try {
    formData = await request.formData();
    const intent = String(formData.get("intent") || "");
    if (intent === "close-po")
      return failure(
        "Record the physical delivery using Receive stock. An invoice cannot confirm a delivery.",
      );
    if (intent !== "create-po")
      return failure("Choose Create purchase order to submit this form.");
    const input = purchaseOrderInput(formData);
    const subscription = await subscriptionFor(admin);
    if (!subscription)
      return failure(
        "Choose a Starter or Growth subscription in Settings, then return to create your purchase order. Your entries are kept here.",
        {},
        true,
      );
    const purchaseOrder = await createPurchaseOrder(shop, input);
    return json({
      success: true as const,
      message: "Purchase order created",
      purchaseOrderId: purchaseOrder.id,
      purchaseOrderNumber: purchaseOrder.poNumber,
    });
  } catch (error) {
    // Preserve Shopify's authentication and session-token responses.
    if (error instanceof Response) throw error;
    if (error instanceof PurchaseOrderInputError)
      return failure(error.message, { [error.field]: error.message });
    const reference = logPoError(shop, error);
    return failure(
      `We couldn't save this purchase order. Your entries are kept here. Please try again; if the problem continues, contact support with reference ${reference}.`,
    );
  }
};

function statusTone(status: string) {
  if (status === "MISMATCH") return "critical";
  if (status === "FULFILLED") return "success";
  if (status === "PARTIAL") return "warning";
  return "info";
}

export default function PurchaseOrders() {
  const appPath = useEmbeddedAppPath();
  const { purchaseOrders, loadError, submissionId } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submittedValues =
    actionData && !actionData.success ? actionData.values : undefined;
  const fieldErrors =
    actionData && !actionData.success ? actionData.fieldErrors : {};
  const [vendorName, setVendorName] = useState(
    submittedValues?.vendorName || "",
  );
  const [poNumber, setPoNumber] = useState(submittedValues?.poNumber || "");
  const [expectedDate, setExpectedDate] = useState(
    submittedValues?.expectedDate || "",
  );
  const [notes, setNotes] = useState(submittedValues?.notes || "");
  const [itemRows, setItemRows] = useState(submittedValues?.itemRows || "");
  const [items, setItems] = useState<PoFormRow[]>(
    submittedValues?.items || [emptyPoRow()],
  );
  const [bulkError, setBulkError] = useState<string>();
  const isSubmitting = navigation.state !== "idle";
  const submitting = useRef(false);
  useEffect(() => {
    if (navigation.state === "idle") submitting.current = false;
  }, [navigation.state, actionData]);

  useEffect(() => {
    if (!actionData?.success) return;
    setVendorName("");
    setPoNumber("");
    setExpectedDate("");
    setNotes("");
    setItemRows("");
    setItems([emptyPoRow()]);
    setBulkError(undefined);
  }, [actionData]);

  const updateItem = (index: number, field: keyof PoFormRow, value: string) => {
    setItems((currentItems) =>
      currentItems.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    );
  };

  const addItem = () =>
    setItems((currentItems) => [...currentItems, emptyPoRow()]);
  const removeItem = (index: number) =>
    setItems((currentItems) =>
      currentItems.length === 1
        ? [emptyPoRow()]
        : currentItems.filter((_, itemIndex) => itemIndex !== index),
    );
  const importBulkRows = () => {
    try {
      const parsed = parsePoItems(itemRows);
      if (!parsed.length) throw new Error("Paste at least one item row.");
      setItems(
        parsed.map((item) => ({
          sku: item.sku || "",
          name: item.name,
          quantity: String(item.expectedQty),
          rate: item.expectedRate == null ? "" : String(item.expectedRate),
        })),
      );
      setBulkError(undefined);
      setItemRows("");
    } catch (error) {
      setBulkError(
        error instanceof Error ? error.message : "Check the pasted rows.",
      );
    }
  };

  const rows = purchaseOrders.map((po) => {
    const received = po.items.reduce((sum, item) => sum + item.receivedQty, 0);
    const expected = po.items.reduce((sum, item) => sum + item.expectedQty, 0);
    const invoiceCount = po.linkedInvoices.length;

    return [
      <Link key={po.id} to={`/app/receipts/${po.id}`}>
        {po.poNumber || po.id.slice(0, 8)} — Receive stock
      </Link>,
      po.vendor.name,
      <Badge key={`${po.id}-status`} tone={statusTone(po.status)}>
        {po.status}
      </Badge>,
      `${received}/${expected}`,
      invoiceCount.toString(),
      formatMoney(po.totalAmount || 0, po.currency),
      po.updatedAt
        ? new Date(po.updatedAt).toLocaleDateString("en-US", { timeZone: "UTC" })
        : "",
    ];
  });

  const mismatchCount = purchaseOrders.filter(
    (po) => po.status === "MISMATCH",
  ).length;
  const openCount = purchaseOrders.filter((po) =>
    ["OPEN", "PARTIAL"].includes(po.status),
  ).length;

  return (
    <Page
      title="Purchase orders"
      subtitle="Create expected supplier orders and let SmartBill match incoming invoices against them."
    >
      <BlockStack gap="500">
        {actionData?.success && (
          <Banner tone="success" title={actionData.message}>
            <p>
              <Link to={`/app/receipts/${actionData.purchaseOrderId}`}>
                Open {actionData.purchaseOrderNumber || "purchase order"} and
                receive stock
              </Link>
              .
            </p>
          </Banner>
        )}
        {actionData && !actionData.success && (
          <Banner tone="critical" title="Purchase order action failed">
            <p>{actionData.error}</p>
            {actionData.settingsRequired && (
              <Link to="/app/settings">Choose a plan in Settings</Link>
            )}
          </Banner>
        )}
        {loadError && (
          <Banner
            tone="critical"
            title="Purchase orders unavailable"
            action={{
              content: "Retry loading",
              url: appPath("/app/reconciliation"),
            }}
          >
            {loadError}
          </Banner>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
            gap: "16px",
          }}
        >
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Total POs
              </Text>
              <Text as="p" variant="headingLg">
                {purchaseOrders.length}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Open or partial
              </Text>
              <Text as="p" variant="headingLg">
                {openCount}
              </Text>
            </BlockStack>
          </Card>
          <Card>
            <BlockStack gap="200">
              <Text as="p" tone="subdued">
                Mismatches
              </Text>
              <Text as="p" variant="headingLg">
                {mismatchCount}
              </Text>
            </BlockStack>
          </Card>
        </div>

        <Layout>
          <Layout.Section>
            <Card>
              <Form
                method="post"
                onSubmit={(event) => {
                  if (submitting.current) {
                    event.preventDefault();
                    return;
                  }
                  submitting.current = true;
                }}
              >
                <input type="hidden" name="intent" value="create-po" />
                <input type="hidden" name="submissionId" value={submissionId} />
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Create purchase order
                  </Text>
                  <TextField
                    label="Vendor"
                    name="vendorName"
                    value={vendorName}
                    onChange={setVendorName}
                    autoComplete="off"
                    maxLength={200}
                    requiredIndicator
                    error={fieldErrors.vendorName}
                  />
                  <InlineStack gap="300" blockAlign="start">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="PO number"
                        name="poNumber"
                        value={poNumber}
                        onChange={setPoNumber}
                        autoComplete="off"
                        maxLength={100}
                        error={fieldErrors.poNumber}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="Expected date"
                        name="expectedDate"
                        type="date"
                        value={expectedDate}
                        onChange={setExpectedDate}
                        autoComplete="off"
                        error={fieldErrors.expectedDate}
                      />
                    </div>
                  </InlineStack>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Line items
                    </Text>
                    {fieldErrors.items && (
                      <Text as="p" tone="critical">
                        {fieldErrors.items}
                      </Text>
                    )}
                    {items.map((item, index) => (
                      <div
                        key={index}
                        style={{
                          display: "grid",
                          gap: 12,
                          gridTemplateColumns:
                            "repeat(auto-fit, minmax(120px, 1fr))",
                          alignItems: "end",
                        }}
                      >
                        <TextField
                          label="SKU (optional)"
                          labelHidden={index > 0}
                          name="itemSku"
                          maxLength={200}
                          value={item.sku}
                          onChange={(value) => updateItem(index, "sku", value)}
                          autoComplete="off"
                        />
                        <TextField
                          label="Item name"
                          labelHidden={index > 0}
                          requiredIndicator
                          name="itemName"
                          maxLength={500}
                          value={item.name}
                          onChange={(value) => updateItem(index, "name", value)}
                          autoComplete="off"
                        />
                        <TextField
                          label="Qty"
                          labelHidden={index > 0}
                          requiredIndicator
                          name="itemQuantity"
                          value={item.quantity}
                          onChange={(value) =>
                            updateItem(index, "quantity", value)
                          }
                          type="number"
                          min={0.001}
                          max={1000000000}
                          step={0.001}
                          autoComplete="off"
                        />
                        <TextField
                          label="Unit cost (optional)"
                          labelHidden={index > 0}
                          name="itemRate"
                          value={item.rate}
                          onChange={(value) => updateItem(index, "rate", value)}
                          type="number"
                          min={0}
                          max={1000000000}
                          step={0.01}
                          autoComplete="off"
                        />
                        <Button
                          onClick={() => removeItem(index)}
                          disabled={items.length === 1 && !item.name.trim()}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                    <InlineStack gap="300">
                      <Button onClick={addItem} disabled={items.length >= 200}>
                        Add item
                      </Button>
                    </InlineStack>
                  </BlockStack>
                  <TextField
                    label="Paste rows"
                    name="itemRows"
                    value={itemRows}
                    onChange={setItemRows}
                    autoComplete="off"
                    multiline={4}
                    helpText="Optional: SKU Name | quantity | unit cost. Comma-separated or spreadsheet columns also work. Unit cost can be left blank."
                    error={bulkError}
                  />
                  <InlineStack gap="300">
                    <Button
                      onClick={importBulkRows}
                      disabled={!itemRows.trim()}
                    >
                      Import pasted rows
                    </Button>
                  </InlineStack>
                  <TextField
                    label="Notes"
                    name="notes"
                    value={notes}
                    onChange={setNotes}
                    autoComplete="off"
                    multiline={2}
                    maxLength={2000}
                    error={fieldErrors.notes}
                  />
                  <Button submit variant="primary" loading={isSubmitting}>
                    Create purchase order
                  </Button>
                </BlockStack>
              </Form>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Matching rules
                </Text>
                <Text as="p" tone="subdued">
                  SmartBill matches exact supplier SKUs or unique item names.
                  Invoices update billed quantities; only a recorded delivery
                  updates physically received quantities.
                </Text>
                <Text as="p" tone="subdued">
                  Price, quantity, and unexpected item differences are written
                  back to the invoice review queue.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              PO reconciliation state
            </Text>
            {rows.length > 0 ? (
              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "text",
                  "numeric",
                  "numeric",
                  "text",
                ]}
                headings={[
                  "PO",
                  "Vendor",
                  "Status",
                  "Received",
                  "Invoices",
                  "Expected total",
                  "Updated",
                ]}
                rows={rows}
              />
            ) : (
              <Text as="p" tone="subdued">
                No purchase orders yet.
              </Text>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
