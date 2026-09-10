import {
  json,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Banner,
  Button,
  InlineStack,
  Badge,
} from "@shopify/polaris";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getUserRole } from "../utils/rbac.server";
import { invoiceIssues } from "../utils/invoiceRules";
import {
  saveInvoiceReview,
  approveInvoice,
} from "../services/invoiceReview.server";
import {
  prepareCostSync,
  syncApprovedCosts,
  restoreCost,
  verifyCost,
} from "../services/cogs.server";
import {
  exportInvoiceToAccounting,
  verifyAccountingExport,
} from "../services/accountingExport.server";
import { formatMoney } from "../utils/format";
import type { loader as productLoader } from "./api.products";
import { attachInvoiceDocument } from "../services/accountingAttachment.server";
import { livePlatform } from "../services/accountingConnection.server";
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.id, shop: session.shop },
    include: {
      vendor: true,
      items: true,
      exports: true,
      costChanges: true,
      purchaseOrder: true,
    },
  });
  if (!invoice) throw new Response("Invoice not found", { status: 404 });
  const [role, purchaseOrders, events] = await Promise.all([
    getUserRole(request),
    prisma.purchaseOrder.findMany({
      where: { shop: session.shop },
      select: { id: true, poNumber: true },
      take: 200,
    }),
    prisma.auditEvent.findMany({
      where: { shop: session.shop, invoiceId: invoice.id },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
  ]);
  return json({
    invoice,
    role,
    purchaseOrders,
    events,
    issues: invoiceIssues(invoice),
  });
}
export async function action({ request, params }: ActionFunctionArgs) {
  const form = await request.formData();
  const id = params.id || "";
  const intent = String(form.get("intent"));
  try {
    if (intent === "save") await saveInvoiceReview(request, id, form);
    else if (intent === "approve") {
      if (form.get("checkedOriginal") !== "yes")
        throw new Error(
          "Confirm the supplier, invoice number, dates, currency and totals against the original before approval.",
        );
      await approveInvoice(
        request,
        id,
        Number(form.get("revision")),
        String(form.get("exceptionReason") || ""),
      );
    } else if (intent === "preview-costs") await prepareCostSync(request, id);
    else if (intent === "sync-costs") await syncApprovedCosts(request, id);
    else if (intent === "restore-cost")
      await restoreCost(request, String(form.get("changeId")));
    else if (intent === "verify-cost")
      await verifyCost(request, String(form.get("changeId")));
    else if (intent === "verify-export") {
      const platform = String(form.get("platform"));
      if (platform !== "XERO" && platform !== "QUICKBOOKS")
        throw new Error("Invalid accounting platform.");
      await verifyAccountingExport(
        request,
        id,
        platform,
        String(form.get("remoteId") || "").trim(),
      );
    } else if (intent === "export-xero" || intent === "export-quickbooks")
      await exportInvoiceToAccounting(
        request,
        id,
        intent === "export-xero" ? "XERO" : "QUICKBOOKS",
      );
    else if (intent === "attach-document")
      await attachInvoiceDocument(
        request,
        id,
        livePlatform(String(form.get("platform"))),
      );
    else throw new Error("Unknown invoice action.");
    return json({ success: true as const, message: "Invoice updated." });
  } catch (error) {
    if (error instanceof Response) throw error;
    return json(
      {
        success: false as const,
        error: error instanceof Error ? error.message : "The action failed.",
      },
      { status: 400 },
    );
  }
}
type EditorItem = {
  name: string;
  sku: string;
  quantity: string;
  price: string;
  amount: string;
  shopifyVariantId: string;
  matchConfirmed: boolean;
  syncCost: boolean;
  matchedProductTitle: string;
};
function MatchPicker({
  item,
  update,
  disabled,
}: {
  item: EditorItem;
  update: (change: Partial<EditorItem>) => void;
  disabled: boolean;
}) {
  const products = useFetcher<typeof productLoader>();
  const [query, setQuery] = useState(item.sku || item.name);
  const variants = products.data?.variants || [];
  return (
    <BlockStack gap="200">
      <label>
        Search Shopify products{" "}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={disabled}
        />
      </label>
      <Button
        disabled={disabled || !query}
        loading={products.state !== "idle"}
        onClick={() =>
          products.load(`/api/products?q=${encodeURIComponent(query)}`)
        }
      >
        Find product
      </Button>
      <label>
        Matched variant{" "}
        <select
          disabled={disabled}
          value={item.shopifyVariantId}
          onChange={(e) => {
            const selected = variants.find((v) => v.id === e.target.value);
            update({
              shopifyVariantId: e.target.value,
              matchConfirmed: false,
              matchedProductTitle: selected
                ? `${selected.product.title} / ${selected.title}`
                : "",
            });
          }}
        >
          <option value="">Select a variant</option>
          {item.shopifyVariantId &&
            !variants.some((v) => v.id === item.shopifyVariantId) && (
              <option value={item.shopifyVariantId}>
                {item.matchedProductTitle || "Saved match"}
              </option>
            )}
          {variants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.sku} — {v.product.title} / {v.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={item.matchConfirmed}
          disabled={disabled || !item.shopifyVariantId}
          onChange={(e) => update({ matchConfirmed: e.target.checked })}
        />{" "}
        I have verified this variant
      </label>
    </BlockStack>
  );
}
function OriginalDocument({
  id,
  available,
}: {
  id: string;
  available: boolean;
}) {
  const [document, setDocument] = useState<{ url: string; type: string }>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    let objectUrl = "";
    void fetch(`/api/invoice-document?id=${encodeURIComponent(id)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Original document could not be loaded.");
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        setDocument({ url: objectUrl, type: blob.type });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, available]);
  if (!available)
    return (
      <Text as="p">
        This invoice was entered from text; there is no attached original.
      </Text>
    );
  if (error)
    return (
      <Text as="p" tone="critical">
        {error}
      </Text>
    );
  if (!document) return <Text as="p">Loading original document…</Text>;
  return document.type === "application/pdf" ? (
    <iframe
      title="Original supplier invoice"
      src={document.url}
      style={{ width: "100%", height: 650, border: 0 }}
    />
  ) : (
    <img
      src={document.url}
      alt="Original supplier invoice"
      style={{ width: "100%", objectFit: "contain" }}
    />
  );
}
export default function InvoiceDetail() {
  const data = useLoaderData<typeof loader>();
  return (
    <InvoiceEditor
      key={`${data.invoice.id}-${data.invoice.revision}`}
      data={data}
    />
  );
}
function InvoiceEditor({
  data,
}: {
  data: ReturnType<typeof useLoaderData<typeof loader>>;
}) {
  const { invoice, role, purchaseOrders, events, issues } = data;
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const [dirty, setDirty] = useState(false);
  const [items, setItems] = useState<EditorItem[]>(
    invoice.items.map((i) => ({
      name: i.name,
      sku: i.sku || "",
      quantity: String(i.quantity),
      price: String(i.price),
      amount: String(i.amount ?? i.quantity * i.price),
      shopifyVariantId: i.shopifyVariantId || "",
      matchConfirmed: i.matchConfirmed,
      syncCost: i.syncCost,
      matchedProductTitle: i.matchedProductTitle || "",
    })),
  );
  const locked =
    invoice.accountingStatus === "EXPORTED" ||
    invoice.cogsSyncStatus === "SYNCED" ||
    invoice.exports.some(
      (e) => e.platform !== "CSV" && e.status !== "REJECTED",
    ) ||
    invoice.costChanges.some((c) => c.status !== "PLANNED");
  const update = (index: number, change: Partial<EditorItem>) => {
    setDirty(true);
    setItems((old) =>
      old.map((item, i) => (i === index ? { ...item, ...change } : item)),
    );
  };
  return (
    <Page
      title={`Invoice ${invoice.invoiceNumber || invoice.id.slice(0, 8)}`}
      backAction={{ url: "/app/invoices" }}
    >
      <BlockStack gap="400">
        {result && (
          <Banner tone={result.success ? "success" : "critical"}>
            {result.success ? result.message : result.error}
          </Banner>
        )}
        <InlineStack gap="300">
          <Badge>{invoice.reviewStatus}</Badge>
          <Badge>{invoice.cogsSyncStatus}</Badge>
          <Badge>{invoice.accountingStatus}</Badge>
        </InlineStack>
        {(issues.length > 0 || invoice.discrepancySummary) && (
          <Banner tone="warning" title="Review these differences">
            <ul>
              {[
                ...new Set([
                  ...issues,
                  ...(invoice.discrepancySummary?.split("\n") || []),
                ]),
              ].map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </Banner>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "repeat(auto-fit, minmax(min(100%, 360px), 1fr))",
            gap: 20,
          }}
        >
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Original document
              </Text>
              <OriginalDocument
                id={invoice.id}
                available={Boolean(invoice.storageKey)}
              />
              <details>
                <summary>Extracted text</summary>
                <pre style={{ whiteSpace: "pre-wrap" }}>{invoice.rawText}</pre>
              </details>
            </BlockStack>
          </Card>
          <Card>
            <Form method="post" onChange={() => setDirty(true)}>
              <input type="hidden" name="intent" value="save" />
              <input type="hidden" name="revision" value={invoice.revision} />
              <input type="hidden" name="items" value={JSON.stringify(items)} />
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Correct invoice details
                </Text>
                {locked && (
                  <Text as="p">
                    Financial activity locks this invoice. Use a separate
                    correcting document to preserve its history.
                  </Text>
                )}
                <label>
                  Supplier{" "}
                  <input
                    name="vendorName"
                    defaultValue={invoice.vendor?.name || ""}
                    required
                    disabled={locked}
                  />
                </label>
                <label>
                  Invoice number{" "}
                  <input
                    name="invoiceNumber"
                    defaultValue={invoice.invoiceNumber || ""}
                    required
                    disabled={locked}
                  />
                </label>
                <label>
                  Invoice date{" "}
                  <input
                    name="date"
                    type="date"
                    defaultValue={invoice.date.slice(0, 10)}
                    required
                    disabled={locked}
                  />
                </label>
                <label>
                  Due date{" "}
                  <input
                    name="dueDate"
                    type="date"
                    defaultValue={invoice.dueDate?.slice(0, 10)}
                    disabled={locked}
                  />
                </label>
                <label>
                  Currency{" "}
                  <input
                    name="currency"
                    defaultValue={invoice.currency}
                    maxLength={3}
                    required
                    disabled={locked}
                  />
                </label>
                <label>
                  Purchase order{" "}
                  <select
                    name="purchaseOrderId"
                    defaultValue={invoice.purchaseOrderId || ""}
                    disabled={locked}
                  >
                    <option value="">No PO</option>
                    {purchaseOrders.map((po) => (
                      <option key={po.id} value={po.id}>
                        {po.poNumber || po.id.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
                {items.map((item, index) => (
                  <fieldset
                    key={index}
                    disabled={locked}
                    style={{
                      padding: 12,
                      border: "1px solid #ddd",
                      borderRadius: 8,
                    }}
                  >
                    <legend>Line {index + 1}</legend>
                    <BlockStack gap="200">
                      <label>
                        Description{" "}
                        <input
                          value={item.name}
                          onChange={(e) =>
                            update(index, { name: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        Supplier SKU{" "}
                        <input
                          value={item.sku}
                          onChange={(e) =>
                            update(index, {
                              sku: e.target.value,
                              matchConfirmed: false,
                            })
                          }
                        />
                      </label>
                      <label>
                        Quantity{" "}
                        <input
                          type="number"
                          step="any"
                          min="0.001"
                          value={item.quantity}
                          onChange={(e) =>
                            update(index, { quantity: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        Net unit price{" "}
                        <input
                          type="number"
                          step="any"
                          min={0}
                          value={item.price}
                          onChange={(e) =>
                            update(index, { price: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        Net line amount{" "}
                        <input
                          type="number"
                          step="0.01"
                          value={item.amount}
                          onChange={(e) =>
                            update(index, { amount: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          checked={item.syncCost}
                          onChange={(e) =>
                            update(index, { syncCost: e.target.checked })
                          }
                        />{" "}
                        Include this line in product cost sync
                      </label>
                      {item.syncCost && (
                        <MatchPicker
                          item={item}
                          disabled={locked}
                          update={(change) => update(index, change)}
                        />
                      )}
                      <Button
                        disabled={locked || items.length <= 1}
                        onClick={() => {
                          setDirty(true);
                          setItems((old) => old.filter((_, i) => i !== index));
                        }}
                      >
                        Remove line
                      </Button>
                    </BlockStack>
                  </fieldset>
                ))}
                <Button
                  disabled={locked}
                  onClick={() => {
                    setDirty(true);
                    setItems((old) => [
                      ...old,
                      {
                        name: "",
                        sku: "",
                        quantity: "1",
                        price: "0",
                        amount: "0",
                        shopifyVariantId: "",
                        matchConfirmed: false,
                        syncCost: false,
                        matchedProductTitle: "",
                      },
                    ]);
                  }}
                >
                  Add line / freight charge
                </Button>
                <label>
                  Subtotal, excluding tax{" "}
                  <input
                    name="subtotal"
                    type="number"
                    step="0.01"
                    defaultValue={
                      invoice.subtotal ??
                      invoice.items.reduce(
                        (s, i) => s + i.quantity * i.price,
                        0,
                      )
                    }
                    disabled={locked}
                  />
                </label>
                <label>
                  Tax total{" "}
                  <input
                    name="tax"
                    type="number"
                    min={0}
                    step="0.01"
                    defaultValue={invoice.tax || 0}
                    disabled={locked}
                  />
                </label>
                <label>
                  Invoice total{" "}
                  <input
                    name="total"
                    type="number"
                    step="0.01"
                    defaultValue={invoice.total}
                    disabled={locked}
                  />
                </label>
                <Button
                  submit
                  variant="primary"
                  disabled={locked}
                  loading={busy}
                >
                  Save corrections
                </Button>
                <Text as="p" tone="subdued">
                  Saving corrections resets approval. Use net prices after
                  discounts and enter freight as a separate line.
                </Text>
              </BlockStack>
            </Form>
          </Card>
        </div>
        {role === "ADMIN" && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Approval and export
              </Text>
              <Form method="post">
                <input type="hidden" name="intent" value="approve" />
                <input type="hidden" name="revision" value={invoice.revision} />
                <label>
                  Reason for accepting any PO differences{" "}
                  <input
                    name="exceptionReason"
                    placeholder="Required when accepting unresolved differences"
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    name="checkedOriginal"
                    value="yes"
                    required
                  />{" "}
                  I checked the supplier, invoice number, dates, currency and
                  totals against the original.
                </label>
                <Button
                  submit
                  loading={busy}
                  disabled={dirty || invoice.reviewStatus === "APPROVED"}
                >
                  Approve saved invoice
                </Button>
              </Form>
              <Text as="p" tone="subdued">
                Save changes before approving. Approval applies to the saved
                invoice shown above.
              </Text>
              <InlineStack gap="300">
                <Button
                  url={`/app/invoices/${invoice.id}/accounting?platform=XERO`}
                  disabled={dirty}
                >
                  Xero accounting details
                </Button>
                <Button
                  url={`/app/invoices/${invoice.id}/accounting?platform=QUICKBOOKS`}
                  disabled={dirty}
                >
                  QuickBooks accounting details
                </Button>
                {[
                  ["preview-costs", "Preview Shopify costs"],
                  ["sync-costs", "Apply previewed costs"],
                  ["export-xero", "Export to Xero"],
                  ["export-quickbooks", "Export to QuickBooks"],
                ].map(([intent, label]) => (
                  <Form method="post" key={intent}>
                    <input type="hidden" name="intent" value={intent} />
                    <Button
                      submit
                      loading={busy}
                      disabled={dirty || invoice.reviewStatus !== "APPROVED"}
                    >
                      {label}
                    </Button>
                  </Form>
                ))}
                <Button
                  url={`/api/exportCSV?invoiceId=${invoice.id}`}
                  disabled={dirty || invoice.reviewStatus !== "APPROVED"}
                >
                  Download approved CSV
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}
        {invoice.costChanges.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Cost preview and history
              </Text>
              {invoice.costChanges.map((c) => (
                <div key={c.id}>
                  <Text as="p">
                    {invoice.items.find((i) => i.id === c.invoiceItemId)
                      ?.name || c.variantId}
                    :{" "}
                    {c.previousCost == null
                      ? "No previous cost"
                      : formatMoney(c.previousCost, c.currency)}{" "}
                    → {formatMoney(c.newCost, c.currency)} — {c.status}
                  </Text>
                  {c.error && (
                    <Text as="p" tone="critical">
                      {c.error}
                    </Text>
                  )}
                  {role === "ADMIN" &&
                    [
                      "VERIFY",
                      "VERIFY_RESTORE",
                      "APPLYING",
                      "RESTORING",
                      "PLANNED",
                    ].includes(c.status) && (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="verify-cost"
                        />
                        <input type="hidden" name="changeId" value={c.id} />
                        <Button submit loading={busy}>
                          Check current cost / recover interrupted sync
                        </Button>
                      </Form>
                    )}
                  {role === "ADMIN" && c.status === "APPLIED" && (
                    <Form method="post">
                      <input type="hidden" name="intent" value="restore-cost" />
                      <input type="hidden" name="changeId" value={c.id} />
                      <Button submit loading={busy}>
                        Restore previous cost
                      </Button>
                    </Form>
                  )}
                </div>
              ))}
            </BlockStack>
          </Card>
        )}
        {invoice.exports.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Accounting export history
              </Text>
              {invoice.exports.map((e) => (
                <div key={e.id}>
                  <Text as="p">
                    {e.platform}: {e.status}
                    {e.remoteId ? ` — bill ${e.remoteId}` : ""}
                  </Text>
                  {e.error && (
                    <Text as="p" tone="critical">
                      {e.error}
                    </Text>
                  )}
                  {e.companyKey && (
                    <Text as="p" tone="subdued">
                      Company: {e.companyKey}
                    </Text>
                  )}
                  {e.status === "REJECTED" && (
                    <Text as="p">
                      No bill was created. Correct the reported issue, then use
                      Export above to retry.
                    </Text>
                  )}
                  {role === "ADMIN" &&
                    e.status === "EXPORTED" &&
                    invoice.storageKey && (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="attach-document"
                        />
                        <input
                          type="hidden"
                          name="platform"
                          value={e.platform}
                        />
                        <Text as="p">
                          Original document: {e.attachmentStatus}
                        </Text>
                        {e.attachmentError && (
                          <Text as="p" tone="critical">
                            {e.attachmentError}
                          </Text>
                        )}
                        <Button
                          submit
                          loading={busy}
                          disabled={e.attachmentStatus === "ATTACHED"}
                        >
                          {["VERIFY", "SENDING"].includes(e.attachmentStatus)
                            ? "Check attachment"
                            : "Attach original document to bill"}
                        </Button>
                      </Form>
                    )}
                  {role === "ADMIN" &&
                    ["VERIFY", "SENDING"].includes(e.status) && (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="verify-export"
                        />
                        <input
                          type="hidden"
                          name="platform"
                          value={e.platform}
                        />
                        <label>
                          Existing bill ID{" "}
                          <input
                            name="remoteId"
                            defaultValue={e.remoteId || ""}
                          />
                        </label>
                        <Text as="p" tone="subdued">
                          Leave the bill ID blank to search the connected
                          company, or enter the existing bill ID. Verification
                          checks its supplier, dates, currency and amounts.
                        </Text>
                        <Button submit loading={busy}>
                          Find / verify existing bill
                        </Button>
                      </Form>
                    )}
                </div>
              ))}
            </BlockStack>
          </Card>
        )}
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Activity history
            </Text>
            {events.map((e) => (
              <Text as="p" key={e.id}>
                {new Date(e.createdAt).toLocaleString()} — {e.action} —{" "}
                {e.actor}
              </Text>
            ))}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
