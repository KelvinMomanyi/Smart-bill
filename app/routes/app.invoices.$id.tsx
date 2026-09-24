import {
  json,
  redirect,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import {
  Form,
  Link,
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
import {
  getUserRole,
  requireApprovalAccess,
} from "../utils/rbac.server";
import { invoiceIssues } from "../utils/invoiceRules";
import { fxSummary, resolveFxRate } from "../utils/exchangeRate";
import { creditTotals } from "../utils/creditNotes";
import {
  approveCreditNote,
  unmatchCreditNote,
  voidCreditNote,
} from "../services/creditNotes.server";
import { fetchShopCurrency } from "../services/invoiceWorkflow.server";
import { getExchangeRateOptions } from "../services/exchangeRate.server";
import { needsPackSize } from "../utils/unitCost";
import {
  allocateCharges,
  allocationSummary,
  CHARGE_CATEGORIES,
  CHARGE_CATEGORY_LABELS,
  isChargeLine,
  isLandedCostMethod,
  LANDED_COST_METHOD_LABELS,
  LANDED_COST_METHODS,
  landedCostIssues,
  landedUnitCost,
  lineValue,
} from "../utils/landedCost";
import {
  saveInvoiceReview,
  approveInvoice,
  variantsByIds,
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
import { deleteCapturedInvoice } from "../services/invoiceDeletion.server";
import { invoiceDeletionBlockedReason } from "../utils/invoiceDeletion";
import { CsvDownloadButton } from "../components/CsvDownloadButton";
import {
  approvalState,
  delegateApproval,
  ensureDefaultApprovalRules,
} from "../services/approvalRules.server";
import {
  normalizeStaffRole,
  roleCanApprove,
  ruleRoles,
} from "../utils/approvalRules";
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  await ensureDefaultApprovalRules(session.shop);
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.id, shop: session.shop },
    include: {
      vendor: true,
      items: true,
      exports: true,
      costChanges: true,
      purchaseOrder: true,
      creditNotes: true,
      approvals: { include: { approvalRule: true } },
    },
  });
  if (!invoice) throw new Response("Invoice not found", { status: 404 });
  const shopCurrency = await fetchShopCurrency(admin);
  const [role, purchaseOrders, events, fxOptions, approval, approvalStaff] = await Promise.all([
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
    invoice.currency === shopCurrency
      ? Promise.resolve([])
      : getExchangeRateOptions({
          shop: session.shop,
          fromCurrency: invoice.currency,
          toCurrency: shopCurrency,
          rateDate: invoice.date,
          allowRemote: true,
        }),
    approvalState(prisma, invoice),
    prisma.session.findMany({
      where: { shop: session.shop, isOnline: true },
      select: { id: true, firstName: true, email: true, role: true, accountOwner: true },
      orderBy: { firstName: "asc" },
    }),
  ]);
  const landedCostMethod = isLandedCostMethod(invoice.landedCostMethod)
    ? invoice.landedCostMethod
    : "NONE";
  const productLines = invoice.items.filter((item) => !isChargeLine(item));
  const chargeTotal = invoice.items
    .filter((item) => isChargeLine(item))
    .reduce((sum, item) => sum + lineValue(item), 0);
  let weights: Record<string, number | null> = {};
  if (landedCostMethod === "WEIGHT") {
    const ids = productLines
      .map((item) => item.shopifyVariantId)
      .filter((id): id is string => Boolean(id));
    if (ids.length) {
      try {
        const variants = await variantsByIds(admin, ids);
        weights = Object.fromEntries(
          variants.map((variant) => {
            const weight = variant.inventoryItem.measurement?.weight;
            const multiplier = {
              GRAMS: 1,
              KILOGRAMS: 1000,
              OUNCES: 28.349523125,
              POUNDS: 453.59237,
            }[String(weight?.unit || "").toUpperCase()];
            const quantity =
              productLines.find(
                (line) => line.shopifyVariantId === variant.id,
              )?.quantity || 0;
            return [
              variant.id,
              weight && multiplier
                ? weight.value * multiplier * quantity
                : null,
            ];
          }),
        );
      } catch {
        weights = {};
      }
    }
  }
  let landedCost = null;
  let landedCostError = "";
  try {
    if (chargeTotal > 0 && productLines.length) {
      const result = allocateCharges(
        productLines.map((item) => ({
          id: item.id,
          name: item.name,
          quantity: item.quantity,
          price: item.price,
          amount: item.amount,
          category: item.category,
          weight: item.shopifyVariantId
            ? weights[item.shopifyVariantId] ?? null
            : null,
        })),
        chargeTotal,
        landedCostMethod,
        Object.fromEntries(
          productLines.map((item) => [item.id, item.manualCharge]),
        ),
      );
      const allocatedFor = (id: string) =>
        result.allocations.find((entry) => entry.lineId === id)?.amount ?? 0;
      landedCost = {
        method: result.method,
        chargeTotal: result.totalCharge,
        summary: allocationSummary(result),
        warnings: result.warnings,
        lines: productLines.map((item) => ({
          id: item.id,
          name: item.name,
          quantity: item.quantity,
          allocated: allocatedFor(item.id),
          landedUnitCost: landedUnitCost(item, allocatedFor(item.id)),
        })),
      };
    }
  } catch (error) {
    landedCostError =
      error instanceof Error
        ? error.message
        : "The freight allocation could not be calculated.";
  }
  const fx = resolveFxRate(invoice.currency, shopCurrency, invoice.fxRate);
  const credits = creditTotals(invoice.creditNotes);
  return json({
    invoice,
    role,
    purchaseOrders,
    events,
    landedCost,
    landedCostError,
    landedCostMethodWarning:
      invoice.vendor?.defaultLandedCostMethod &&
      invoice.vendor.defaultLandedCostMethod !== landedCostMethod
        ? `This supplier last used ${invoice.vendor.defaultLandedCostMethod}. Review the change to ${landedCostMethod} before approval.`
        : "",
    shopCurrency,
    fxRate: invoice.fxRate,
    fxProblem: fx.problem,
    fxRequired: fx.required,
    fxOptions,
    credits,
    approval,
    approvalStaff,
    issues: [
      ...invoiceIssues(invoice),
      ...landedCostIssues(invoice.items, landedCostMethod),
      ...(fx.problem ? [fx.problem] : []),
      ...invoice.creditNotes
        .filter((credit) => credit.status === "MATCHED")
        .map(
          (credit) =>
            `Credit note ${credit.creditNoteNumber || credit.id.slice(0, 8)} still needs approval or voiding.`,
        ),
    ],
  });
}
export async function action({ request, params }: ActionFunctionArgs) {
  const form = await request.formData();
  const id = params.id || "";
  const intent = String(form.get("intent"));
  try {
    let message = "Invoice updated.";
    if (intent === "delete") {
      await deleteCapturedInvoice(request, id);
      return redirect("/app/invoices?deleted=1");
    } else if (intent === "save") await saveInvoiceReview(request, id, form);
    else if (intent === "approve") {
      if (form.get("checkedOriginal") !== "yes")
        throw new Error(
          "Confirm the supplier, invoice number, dates, currency and totals against the original before approval.",
        );
      const approval = await approveInvoice(
        request,
        id,
        Number(form.get("revision")),
        String(form.get("exceptionReason") || ""),
      );
      message = approval.complete
        ? "All required approvals are complete."
        : "Your approval was recorded. Additional approval is still required.";
    } else if (intent === "delegate-approval") {
      const { session, actor, role } = await requireApprovalAccess(request);
      await delegateApproval(
        session.shop,
        id,
        String(form.get("ruleId") || ""),
        actor,
        String(form.get("targetSessionId") || ""),
        role,
      );
      message = "Approval delegated.";
    } else if (intent === "preview-costs") await prepareCostSync(request, id);
    else if (intent === "sync-costs") await syncApprovedCosts(request, id);
    else if (intent === "approve-credit")
      await approveCreditNote(
        request,
        String(form.get("creditNoteId")),
        String(form.get("note") || ""),
      );
    else if (intent === "void-credit")
      await voidCreditNote(
        request,
        String(form.get("creditNoteId")),
        String(form.get("note") || ""),
      );
    else if (intent === "unmatch-credit")
      await unmatchCreditNote(request, String(form.get("creditNoteId")));
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
    return json({ success: true as const, message });
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
  category: string;
  supplierUoM: string;
  packSize: string;
  manualCharge: string;
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
  const {
    invoice,
    role,
    purchaseOrders,
    events,
    issues,
    landedCost,
    landedCostError,
    landedCostMethodWarning,
    shopCurrency,
    fxRate,
    fxProblem,
    fxOptions,
    credits,
    approval,
    approvalStaff,
  } = data;
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const [dirty, setDirty] = useState(false);
  const [landedCostMethod, setLandedCostMethod] = useState(
    invoice.landedCostMethod || "NONE",
  );
  const [selectedFxRate, setSelectedFxRate] = useState(
    fxRate == null ? "" : String(fxRate),
  );
  const [selectedFxSource, setSelectedFxSource] = useState(
    invoice.fxRateSource || "MANUAL",
  );
  const [selectedFxDate, setSelectedFxDate] = useState(
    invoice.fxRateDate?.slice(0, 10) || invoice.date.slice(0, 10),
  );
  const [items, setItems] = useState<EditorItem[]>(
    invoice.items.map((i) => ({
      name: i.name,
      sku: i.sku || "",
      category: i.category || "PRODUCT",
      supplierUoM: i.supplierUoM || "",
      packSize: i.packSize == null ? "" : String(i.packSize),
      manualCharge: i.manualCharge == null ? "" : String(i.manualCharge),
      quantity: String(i.quantity),
      price: String(i.price),
      amount: String(i.amount ?? i.quantity * i.price),
      shopifyVariantId: i.shopifyVariantId || "",
      matchConfirmed: i.matchConfirmed,
      syncCost: i.syncCost,
      matchedProductTitle: i.matchedProductTitle || "",
    })),
  );
  const financialActivity =
    invoice.accountingStatus === "EXPORTED" ||
    invoice.cogsSyncStatus === "SYNCED" ||
    invoice.exports.some(
      (e) => e.platform !== "CSV" && e.status !== "REJECTED",
    ) ||
    invoice.costChanges.some((c) => c.status !== "PLANNED");
  const deletionPending = invoice.status === "DELETING";
  const deletionBlocked = invoiceDeletionBlockedReason(invoice);
  const locked = financialActivity || deletionPending;
  const update = (index: number, change: Partial<EditorItem>) => {
    setDirty(true);
    setItems((old) =>
      old.map((item, i) => (i === index ? { ...item, ...change } : item)),
    );
  };
  const chargeLines = items.filter((item) => item.category !== "PRODUCT");
  const productLines = items.filter((item) => item.category === "PRODUCT");
  const chargeTotal = chargeLines.reduce(
    (sum, item) =>
      sum + (Number(item.amount) || Number(item.quantity) * Number(item.price) || 0),
    0,
  );
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
                <Text as="h3" variant="headingSm">
                  Captured line items ({items.length})
                </Text>
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
                            update(index, {
                              name: e.target.value,
                              ...(item.category === "PRODUCT"
                                ? { matchConfirmed: false }
                                : {}),
                            })
                          }
                        />
                      </label>
                      <label>
                        Line type{" "}
                        <select
                          value={item.category}
                          disabled={locked}
                          onChange={(e) => {
                            const category = e.target.value;
                            update(
                              index,
                              category === "PRODUCT"
                                ? { category }
                                : {
                                    category,
                                    syncCost: false,
                                    matchConfirmed: false,
                                    shopifyVariantId: "",
                                    matchedProductTitle: "",
                                  },
                            );
                          }}
                        >
                          {CHARGE_CATEGORIES.map((category) => (
                            <option key={category} value={category}>
                              {CHARGE_CATEGORY_LABELS[category]}
                            </option>
                          ))}
                        </select>
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
                      {item.category === "PRODUCT" ? (
                        <>
                          <label>
                            Billed unit (optional){" "}
                            <input
                              value={item.supplierUoM}
                              placeholder="e.g. box, case, each"
                              maxLength={20}
                              disabled={locked}
                              onChange={(e) =>
                                update(index, {
                                  supplierUoM: e.target.value
                                    .toLowerCase()
                                    .trimStart(),
                                })
                              }
                            />
                          </label>
                          {needsPackSize(item.supplierUoM) && (
                            <label>
                              Stock units per {item.supplierUoM || "billed unit"}{" "}
                              <input
                                type="number"
                                step="any"
                                min="0.001"
                                value={item.packSize}
                                placeholder="e.g. 12"
                                disabled={locked}
                                onChange={(e) =>
                                  update(index, { packSize: e.target.value })
                                }
                              />
                            </label>
                          )}
                          {landedCostMethod === "MANUAL" && (
                            <label>
                              Manual share of freight and charges{" "}
                              <input
                                type="number"
                                step="0.01"
                                min={0}
                                value={item.manualCharge}
                                onChange={(e) =>
                                  update(index, {
                                    manualCharge: e.target.value,
                                  })
                                }
                                disabled={locked}
                              />
                            </label>
                          )}
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
                        </>
                      ) : (
                        <Text as="p" tone="subdued">
                          Charges are spread across the product lines as landed
                          cost. They are never synced to Shopify as a product
                          cost.
                        </Text>
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
                        category: "PRODUCT",
                        supplierUoM: "",
                        packSize: "",
                        manualCharge: "",
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
                  Add missing invoice line / freight charge
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
                {invoice.currency !== shopCurrency && (
                  <div
                    style={{
                      border: "1px solid #e3e3e3",
                      borderRadius: 8,
                      padding: 12,
                    }}
                  >
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        Currency conversion
                      </Text>
                      <Text as="p" tone="subdued">
                        This invoice is in {invoice.currency}, but Shopify
                        inventory costs are always written in {shopCurrency}.
                        Enter the rate you reviewed before this invoice can be
                        approved or synced.
                      </Text>
                      {fxOptions.length > 0 && (
                        <label>
                          Saved or provider rate{" "}
                          <select
                            value={`${selectedFxSource}|${selectedFxDate}|${selectedFxRate}`}
                            onChange={(event) => {
                              if (!event.target.value) return;
                              const [source, rateDate, rate] =
                                event.target.value.split("|");
                              setDirty(true);
                              setSelectedFxSource(source);
                              setSelectedFxDate(rateDate);
                              setSelectedFxRate(rate);
                            }}
                          >
                            <option value="">Choose a stored rate</option>
                            {fxOptions.map((option) => (
                              <option
                                key={`${option.source}-${option.rateDate}-${option.rate}`}
                                value={`${option.source}|${option.rateDate}|${option.rate}`}
                              >
                                {option.source} - {option.rate} on{" "}
                                {option.rateDate}
                                {option.nearestPrior ? " (nearest prior)" : ""}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <input
                        type="hidden"
                        name="fxSource"
                        value={selectedFxSource}
                      />
                      <label>
                        1 {invoice.currency} ={" "}
                        <input
                          name="fxRate"
                          type="number"
                          step="any"
                          min="0.000001"
                          value={selectedFxRate}
                          onChange={(event) => {
                            setDirty(true);
                            setSelectedFxSource("MANUAL");
                            setSelectedFxRate(event.target.value);
                          }}
                          disabled={locked}
                        />{" "}
                        {shopCurrency}
                      </label>
                      <label>
                        Rate date{" "}
                        <input
                          name="fxRateDate"
                          type="date"
                          value={selectedFxDate}
                          onChange={(event) => {
                            setDirty(true);
                            setSelectedFxDate(event.target.value);
                          }}
                          disabled={locked}
                        />
                      </label>
                      {fxProblem ? (
                        <Banner tone="warning">{fxProblem}</Banner>
                      ) : fxRate != null ? (
                        <Text as="p">
                          {fxSummary(
                            invoice.currency,
                            shopCurrency,
                            fxRate,
                            invoice.fxRateDate?.slice(0, 10) || null,
                          )}
                        </Text>
                      ) : null}
                    </BlockStack>
                  </div>
                )}
                {chargeLines.length > 0 && (
                  <div
                    style={{
                      border: "1px solid #e3e3e3",
                      borderRadius: 8,
                      padding: 12,
                    }}
                  >
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        Freight, duty and landed cost
                      </Text>
                      <Text as="p" tone="subdued">
                        {chargeLines.length} charge line
                        {chargeLines.length === 1 ? "" : "s"} totalling{" "}
                        {chargeTotal.toFixed(2)} {invoice.currency}. Choose how
                        they are spread over the {productLines.length} product
                        line{productLines.length === 1 ? "" : "s"} before
                        previewing costs.
                      </Text>
                      <label>
                        Allocation method{" "}
                        <select
                          name="landedCostMethod"
                          value={landedCostMethod}
                          disabled={locked}
                          onChange={(e) => {
                            setDirty(true);
                            setLandedCostMethod(e.target.value);
                          }}
                        >
                          {LANDED_COST_METHODS.map((method) => (
                            <option key={method} value={method}>
                              {LANDED_COST_METHOD_LABELS[method]}
                            </option>
                          ))}
                        </select>
                      </label>
                      {landedCostError && (
                        <Banner tone="critical">{landedCostError}</Banner>
                      )}
                      {landedCostMethodWarning && (
                        <Banner tone="warning">
                          {landedCostMethodWarning}
                        </Banner>
                      )}
                      {landedCost && (
                        <>
                          <Text as="p">{landedCost.summary}</Text>
                          {landedCost.warnings.map((warning) => (
                            <Text as="p" key={warning} tone="subdued">
                              {warning}
                            </Text>
                          ))}
                          <table
                            style={{
                              width: "100%",
                              borderCollapse: "collapse",
                            }}
                          >
                            <thead>
                              <tr>
                                <th align="left">Product line</th>
                                <th align="right">Qty</th>
                                <th align="right">Allocated charge</th>
                                <th align="right">Landed cost per unit</th>
                              </tr>
                            </thead>
                            <tbody>
                              {landedCost.lines.map((line) => (
                                <tr key={line.id}>
                                  <td>{line.name}</td>
                                  <td align="right">{line.quantity}</td>
                                  <td align="right">
                                    {line.allocated.toFixed(2)}
                                  </td>
                                  <td align="right">
                                    {line.landedUnitCost.toFixed(4)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <Text as="p" tone="subdued">
                            The landed cost per unit is what SmartBill writes to
                            Shopify as the variant cost. This preview reflects
                            the saved invoice, so save corrections first.
                          </Text>
                        </>
                      )}
                    </BlockStack>
                  </div>
                )}
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
                  discounts. Tag freight, duty or handling lines as charges so
                  they become landed cost instead of product costs.
                </Text>
              </BlockStack>
            </Form>
          </Card>
        </div>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Supplier credit notes
            </Text>
            {invoice.creditNotes.length === 0 ? (
              <Text as="p" tone="subdued">
                No credit notes are linked to this invoice. Record one so
                returns, overcharges or allowances reduce the cost SmartBill
                writes to Shopify.
              </Text>
            ) : (
              <>
                <Text as="p">
                  Credits reduce the cost of the product lines below. Net
                  invoice value:{" "}
                  {formatMoney(invoice.total - credits.total, invoice.currency)}
                </Text>
                {invoice.creditNotes.map((credit) => (
                  <BlockStack gap="100" key={credit.id}>
                    <InlineStack gap="200">
                      <Link to={`/app/credit-notes/${credit.id}`}>
                        {credit.creditNoteNumber || credit.id.slice(0, 8)}
                      </Link>
                      <Text as="span">
                        {formatMoney(credit.amount, credit.currency)}
                      </Text>
                      <Badge
                        tone={
                          credit.status === "APPLIED"
                            ? "success"
                            : credit.status === "VOID"
                              ? "critical"
                              : "attention"
                        }
                      >
                        {credit.status}
                      </Badge>
                    </InlineStack>
                    {(role === "ADMIN" || role === "FINANCE") && (
                      <InlineStack gap="200">
                        {credit.status === "MATCHED" && (
                          <Form method="post">
                            <input
                              type="hidden"
                              name="intent"
                              value="approve-credit"
                            />
                            <input
                              type="hidden"
                              name="creditNoteId"
                              value={credit.id}
                            />
                            <Button submit loading={busy}>
                              Approve credit
                            </Button>
                          </Form>
                        )}
                        {credit.status !== "APPLIED" &&
                          credit.status !== "VOID" && (
                            <Form method="post">
                              <input
                                type="hidden"
                                name="intent"
                                value="void-credit"
                              />
                              <input
                                type="hidden"
                                name="creditNoteId"
                                value={credit.id}
                              />
                              <Button submit tone="critical" loading={busy}>
                                Void
                              </Button>
                            </Form>
                          )}
                      </InlineStack>
                    )}
                  </BlockStack>
                ))}
              </>
            )}
            <InlineStack gap="200">
              <Button url="/app/credit-notes">Record or match a credit note</Button>
            </InlineStack>
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Approval workflow
            </Text>
            {approval.requirements.map((rule) => {
              const approvedBy = new Set(
                approval.approvals
                  .filter(
                    (entry) =>
                      entry.approvalRuleId === rule.id &&
                      entry.status === "APPROVED" &&
                      entry.approverId,
                  )
                  .map((entry) => entry.approverId),
              ).size;
              const eligible = roleCanApprove(role, ruleRoles(rule));
              const delegates = approvalStaff.filter((staff) =>
                roleCanApprove(
                  staff.accountOwner
                    ? "ADMIN"
                    : normalizeStaffRole(staff.role),
                  ruleRoles(rule),
                ),
              );
              return (
                <BlockStack gap="100" key={rule.id}>
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="p">
                      {rule.name}: {approvedBy} / {rule.requiredApprovers}
                    </Text>
                    <Badge
                      tone={
                        approvedBy >= rule.requiredApprovers
                          ? "success"
                          : "attention"
                      }
                    >
                      {approvedBy >= rule.requiredApprovers
                        ? "Complete"
                        : "Pending"}
                    </Badge>
                  </InlineStack>
                  {eligible &&
                    approvedBy < rule.requiredApprovers &&
                    delegates.length > 0 && (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="delegate-approval"
                        />
                        <input type="hidden" name="ruleId" value={rule.id} />
                        <label>
                          Delegate to{" "}
                          <select name="targetSessionId" required>
                            <option value="">Choose teammate</option>
                            {delegates.map((staff) => (
                              <option key={staff.id} value={staff.id}>
                                {staff.email || staff.firstName || staff.id}
                              </option>
                            ))}
                          </select>
                        </label>{" "}
                        <Button submit loading={busy}>
                          Assign
                        </Button>
                      </Form>
                    )}
                </BlockStack>
              );
            })}
            {approval.requirements.some((rule) =>
              roleCanApprove(role, ruleRoles(rule)),
            ) && (
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
            )}
            <Text as="p" tone="subdued">
              Save changes before approving. Every required rule must have
              enough distinct approvers before cost sync or export is enabled.
            </Text>
            {role === "ADMIN" && (
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
                <CsvDownloadButton
                  invoiceId={invoice.id}
                  disabled={dirty || invoice.reviewStatus !== "APPROVED"}
                >
                  Download approved CSV
                </CsvDownloadButton>
              </InlineStack>
            )}
          </BlockStack>
        </Card>
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
        {role === "ADMIN" && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Delete invoice
              </Text>
              <Text as="p" tone="subdued">
                This removes the uploaded document, extracted fields, line
                items, approval history, processing entry, and its values from
                dashboards, reports, and purchase-order reconciliation.
              </Text>
              {deletionBlocked && (
                <Text as="p" tone="critical">
                  {deletionBlocked}
                </Text>
              )}
              {deletionPending && (
                <Text as="p" tone="critical">
                  An earlier deletion was interrupted. Retry to finish removing
                  its local data.
                </Text>
              )}
              <Form
                method="post"
                onSubmit={(event) => {
                  if (
                    !window.confirm(
                      `Permanently delete invoice ${invoice.invoiceNumber || invoice.id.slice(0, 8)} and all of its local data?`,
                    )
                  )
                    event.preventDefault();
                }}
              >
                <input type="hidden" name="intent" value="delete" />
                <Button
                  submit
                  tone="critical"
                  loading={busy}
                  disabled={Boolean(deletionBlocked)}
                >
                  {deletionPending
                    ? "Retry invoice deletion"
                    : "Delete invoice"}
                </Button>
              </Form>
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
