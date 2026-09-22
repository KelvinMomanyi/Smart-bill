import {
  json,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useOutlet,
  useNavigation,
} from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Banner,
  Text,
  DataTable,
  Button,
  InlineStack,
  Badge,
} from "@shopify/polaris";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getUserRole, requireAdmin } from "../utils/rbac.server";
import { requireSubscription } from "../services/billing.server";
import { captureCreditNote } from "../services/creditNotes.server";
import { formatMoney } from "../utils/format";
import {
  CREDIT_NOTE_STATUS_LABELS,
  CREDIT_REASONS,
  CREDIT_REASON_LABELS,
  isCreditNoteStatus,
  isCreditReason,
} from "../utils/creditNotes";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "";
  const role = await getUserRole(request);
  const credits = await prisma.creditNote.findMany({
    where: {
      shop: session.shop,
      ...(isCreditNoteStatus(status) ? { status } : {}),
    },
    include: { vendor: true, invoice: { select: { id: true, invoiceNumber: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return json({ credits, status, role });
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { session, actor } = await requireAdmin(request);
    await requireSubscription(request);
    const form = await request.formData();
    if (String(form.get("intent")) !== "record-credit")
      throw new Error("Unknown credit note action.");
    const credit = await captureCreditNote({
      shop: session.shop,
      actor,
      rawText: "",
      amount: Number(form.get("amount")),
      currency: String(form.get("currency") || "").toUpperCase(),
      creditNoteNumber: String(form.get("creditNoteNumber") || ""),
      originalInvoiceNumber: String(form.get("originalInvoiceNumber") || ""),
      reason: String(form.get("reason") || "OTHER"),
      dateIssued: String(form.get("dateIssued") || "") || null,
      vendorName: String(form.get("vendorName") || ""),
    });
    return json({
      success: true as const,
      message: credit.invoiceId
        ? `Credit note ${credit.creditNoteNumber} matched to invoice ${credit.originalInvoiceNumber}.`
        : `Credit note ${credit.creditNoteNumber} saved. Match it to the invoice it credits.`,
    });
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

export default function CreditNotes() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const outlet = useOutlet();
  if (outlet) return outlet;
  return (
    <Page
      title="Supplier credit notes"
      subtitle="Record, match and approve credits so invoice costs are net of returns and overcharges."
      backAction={{ url: "/app/invoices" }}
    >
      <BlockStack gap="400">
        {result && (
          <Banner tone={result.success ? "success" : "critical"}>
            {result.success ? result.message : result.error}
          </Banner>
        )}
        {data.role === "ADMIN" && (
          <Card>
            <Form method="post">
              <input type="hidden" name="intent" value="record-credit" />
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Record a credit note
                </Text>
                <Text as="p" tone="subdued">
                  Uploading a document that reads as a credit note adds it here
                  automatically. Use this form for a credit received by email or
                  post.
                </Text>
                <InlineStack gap="300" wrap>
                  <label>
                    Supplier{" "}
                    <input name="vendorName" required maxLength={200} />
                  </label>
                  <label>
                    Credit note number{" "}
                    <input name="creditNoteNumber" required maxLength={80} />
                  </label>
                  <label>
                    Original invoice number{" "}
                    <input
                      name="originalInvoiceNumber"
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Amount{" "}
                    <input
                      name="amount"
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                    />
                  </label>
                  <label>
                    Currency{" "}
                    <input
                      name="currency"
                      maxLength={3}
                      defaultValue={data.credits[0]?.currency || "USD"}
                      required
                    />
                  </label>
                  <label>
                    Reason{" "}
                    <select name="reason" defaultValue="OTHER">
                      {CREDIT_REASONS.map((reason) => (
                        <option key={reason} value={reason}>
                          {CREDIT_REASON_LABELS[reason]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Date issued <input name="dateIssued" type="date" />
                  </label>
                </InlineStack>
                <Button submit variant="primary" loading={busy}>
                  Save credit note
                </Button>
              </BlockStack>
            </Form>
          </Card>
        )}
        <Card>
          <BlockStack gap="300">
            <Form method="get">
              <InlineStack gap="300">
                <label>
                  Status{" "}
                  <select name="status" defaultValue={data.status}>
                    <option value="">All</option>
                    {Object.entries(CREDIT_NOTE_STATUS_LABELS).map(
                      ([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <Button submit>Filter</Button>
              </InlineStack>
            </Form>
            <Text as="p">{data.credits.length} credit notes</Text>
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
                "Credit note",
                "Supplier",
                "Amount",
                "Invoice",
                "Reason",
                "Status",
              ]}
              rows={data.credits.map((credit) => [
                <Link key={credit.id} to={`/app/credit-notes/${credit.id}`}>
                  {credit.creditNoteNumber || credit.id.slice(0, 8)}
                </Link>,
                credit.vendor?.name || "Unknown",
                formatMoney(credit.amount, credit.currency),
                credit.invoice ? (
                  <Link key={credit.id} to={`/app/invoices/${credit.invoice.id}`}>
                    {credit.invoice.invoiceNumber || "Open invoice"}
                  </Link>
                ) : (
                  credit.originalInvoiceNumber || "Not matched"
                ),
                isCreditReason(credit.reason)
                  ? CREDIT_REASON_LABELS[credit.reason]
                  : credit.reason,
                isCreditNoteStatus(credit.status) ? (
                  <Badge
                    key={credit.id}
                    tone={
                      credit.status === "APPLIED"
                        ? "success"
                        : credit.status === "VOID"
                          ? "critical"
                          : "attention"
                    }
                  >
                    {CREDIT_NOTE_STATUS_LABELS[credit.status]}
                  </Badge>
                ) : (
                  credit.status
                ),
              ])}
            />
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
