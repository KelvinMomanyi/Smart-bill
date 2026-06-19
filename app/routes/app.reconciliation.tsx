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
  TextField,
} from "@shopify/polaris";
import { useState } from "react";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { formatMoney } from "../utils/format";
import { parsePoItems, parseStructuredPoItems } from "../utils/poItems.server";
import { requireAdmin } from "../utils/rbac.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await requireAdmin(request);
  const shop = session.shop;

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

  return json({ purchaseOrders });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const shop = session.shop;

  try {
    if (intent === "create-po") {
      const vendorName = String(formData.get("vendorName") || "").trim();
      const poNumber = String(formData.get("poNumber") || "").trim();
      const expectedDate = String(formData.get("expectedDate") || "").trim();
      const notes = String(formData.get("notes") || "").trim();
      const itemRows = String(formData.get("itemRows") || "");
      const structuredItems = String(formData.get("structuredItems") || "");
      const items = parseStructuredPoItems(structuredItems);
      const fallbackItems = items.length > 0 ? items : parsePoItems(itemRows);

      if (!vendorName) throw new Error("Vendor name is required");
      if (fallbackItems.length === 0) throw new Error("Add at least one PO item");

      const vendor = await prisma.vendor.upsert({
        where: { shop_name: { shop, name: vendorName } },
        update: {},
        create: { shop, name: vendorName },
      });

      const totalAmount = fallbackItems.reduce(
        (sum, item) => sum + (item.expectedRate || 0) * item.expectedQty,
        0,
      );

      await prisma.purchaseOrder.create({
        data: {
          shop,
          vendorId: vendor.id,
          poNumber: poNumber || null,
          expectedDate: expectedDate ? new Date(expectedDate) : null,
          notes: notes || null,
          totalAmount,
          status: "OPEN",
          items: {
            create: fallbackItems.map((item) => ({
              sku: item.sku || null,
              shopifyProductId: item.shopifyProductId || null,
              shopifyVariantId: item.shopifyVariantId || null,
              name: item.name,
              expectedQty: item.expectedQty,
              expectedRate: item.expectedRate || null,
            })),
          },
        },
      });

      return json({ success: true, message: "Purchase order created" });
    }

    if (intent === "close-po") {
      const poId = String(formData.get("poId") || "");
      await prisma.purchaseOrder.updateMany({
        where: { id: poId, shop },
        data: { status: "FULFILLED" },
      });
      return json({ success: true, message: "Purchase order closed" });
    }

    return json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
};

function statusTone(status: string) {
  if (status === "MISMATCH") return "critical";
  if (status === "FULFILLED") return "success";
  if (status === "PARTIAL") return "warning";
  return "info";
}

type PoFormRow = {
  sku: string;
  name: string;
  quantity: string;
  rate: string;
};

function emptyPoRow(): PoFormRow {
  return { sku: "", name: "", quantity: "1", rate: "" };
}

function parseClientBulkRows(text: string): PoFormRow[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.includes("|") ? line.split("|") : line.split(",");
      if (parts.length >= 3) {
        const [nameOrSku, quantity, rate] = parts.map((part) => part.trim());
        const skuMatch = nameOrSku.match(/^([A-Z0-9._-]{3,})\s+(.+)$/);
        return {
          sku: skuMatch?.[1] || "",
          name: skuMatch?.[2] || nameOrSku,
          quantity: quantity || "1",
          rate: rate || "",
        };
      }

      return null;
    })
    .filter((item): item is PoFormRow => Boolean(item?.name));
}

export default function PurchaseOrders() {
  const { purchaseOrders } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [vendorName, setVendorName] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [itemRows, setItemRows] = useState("");
  const [items, setItems] = useState<PoFormRow[]>([emptyPoRow()]);
  const isSubmitting = navigation.state === "submitting";
  const structuredItems = JSON.stringify(
    items
      .filter((item) => item.name.trim())
      .map((item) => ({
        sku: item.sku.trim(),
        name: item.name.trim(),
        expectedQty: item.quantity,
        expectedRate: item.rate,
      })),
  );

  const updateItem = (
    index: number,
    field: keyof PoFormRow,
    value: string,
  ) => {
    setItems((currentItems) =>
      currentItems.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    );
  };

  const addItem = () => setItems((currentItems) => [...currentItems, emptyPoRow()]);
  const removeItem = (index: number) =>
    setItems((currentItems) =>
      currentItems.length === 1
        ? [emptyPoRow()]
        : currentItems.filter((_, itemIndex) => itemIndex !== index),
    );
  const importBulkRows = () => {
    const parsed = parseClientBulkRows(itemRows);
    if (parsed.length > 0) setItems(parsed);
  };

  const rows = purchaseOrders.map((po) => {
    const received = po.items.reduce((sum, item) => sum + item.receivedQty, 0);
    const expected = po.items.reduce((sum, item) => sum + item.expectedQty, 0);
    const invoiceCount = po.linkedInvoices.length;

    return [
      po.poNumber || po.id.slice(0, 8),
      po.vendor.name,
      <Badge key={`${po.id}-status`} tone={statusTone(po.status)}>
        {po.status}
      </Badge>,
      `${received}/${expected}`,
      invoiceCount.toString(),
      formatMoney(po.totalAmount || 0),
      po.updatedAt ? new Date(po.updatedAt).toLocaleDateString() : "",
    ];
  });

  const mismatchCount = purchaseOrders.filter((po) => po.status === "MISMATCH").length;
  const openCount = purchaseOrders.filter((po) => ["OPEN", "PARTIAL"].includes(po.status)).length;

  return (
    <Page title="Purchase orders" subtitle="Create expected supplier orders and let SmartBill match incoming invoices against them.">
      <BlockStack gap="500">
        {actionData?.success && (
          <Banner tone="success" title={actionData.message}>
            <p>The purchase order workspace is up to date.</p>
          </Banner>
        )}
        {actionData && !actionData.success && (
          <Banner tone="critical" title="Purchase order action failed">
            <p>{actionData.error}</p>
          </Banner>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "16px" }}>
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
              <Form method="post">
                <input type="hidden" name="intent" value="create-po" />
                <input
                  type="hidden"
                  name="structuredItems"
                  value={structuredItems}
                />
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
                  />
                  <InlineStack gap="300" blockAlign="start">
                    <div style={{ flex: 1 }}>
                      <TextField
                        label="PO number"
                        name="poNumber"
                        value={poNumber}
                        onChange={setPoNumber}
                        autoComplete="off"
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
                      />
                    </div>
                  </InlineStack>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">
                      Line items
                    </Text>
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
                          label={index === 0 ? "SKU" : ""}
                          value={item.sku}
                          onChange={(value) => updateItem(index, "sku", value)}
                          autoComplete="off"
                        />
                        <TextField
                          label={index === 0 ? "Item name" : ""}
                          value={item.name}
                          onChange={(value) => updateItem(index, "name", value)}
                          autoComplete="off"
                        />
                        <TextField
                          label={index === 0 ? "Qty" : ""}
                          value={item.quantity}
                          onChange={(value) =>
                            updateItem(index, "quantity", value)
                          }
                          type="number"
                          min={1}
                          autoComplete="off"
                        />
                        <TextField
                          label={index === 0 ? "Unit cost" : ""}
                          value={item.rate}
                          onChange={(value) => updateItem(index, "rate", value)}
                          type="number"
                          min={0}
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
                      <Button onClick={addItem}>Add item</Button>
                    </InlineStack>
                  </BlockStack>
                  <TextField
                    label="Paste rows"
                    name="itemRows"
                    value={itemRows}
                    onChange={setItemRows}
                    autoComplete="off"
                    multiline={4}
                    helpText="Optional bulk import: SKU Name | quantity | expected unit cost. Commas also work."
                  />
                  <InlineStack gap="300">
                    <Button onClick={importBulkRows} disabled={!itemRows.trim()}>
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
                  SmartBill matches invoice line items to PO rows by normalized item names and token overlap, then recalculates received quantities from linked invoices.
                </Text>
                <Text as="p" tone="subdued">
                  Price, quantity, and unexpected item differences are written back to the invoice review queue.
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
                columnContentTypes={["text", "text", "text", "text", "numeric", "numeric", "text"]}
                headings={["PO", "Vendor", "Status", "Received", "Invoices", "Expected total", "Updated"]}
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
