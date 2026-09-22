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
  useNavigation,
} from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  Banner,
  Text,
  Button,
  InlineStack,
} from "@shopify/polaris";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { getUserRole } from "../utils/rbac.server";
import {
  approveCreditNote,
  creditByLine,
  matchCreditNote,
  setCreditNoteAllocation,
  unmatchCreditNote,
  voidCreditNote,
} from "../services/creditNotes.server";
import { exportCreditNoteToAccounting } from "../services/creditNoteAccounting.server";
import { formatMoney } from "../utils/format";
import {
  CREDIT_NOTE_STATUS_LABELS,
  CREDIT_REASON_LABELS,
  isCreditNoteStatus,
  isCreditReason,
} from "../utils/creditNotes";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const credit = await prisma.creditNote.findFirst({
    where: { id: params.id, shop: session.shop },
    include: {
      vendor: true,
      lines: true,
      allocations: true,
      invoice: { include: { items: true } },
    },
  });
  if (!credit) throw new Response("Credit note not found", { status: 404 });
  const [role, candidates, connections] = await Promise.all([
    getUserRole(request),
    prisma.invoice.findMany({
      where: {
        shop: session.shop,
        ...(credit.invoiceId ? { id: { not: credit.invoiceId } } : {}),
        OR: credit.originalInvoiceNumber
          ? [
              { invoiceNumber: credit.originalInvoiceNumber },
              { currency: credit.currency },
            ]
          : [{ currency: credit.currency }],
      },
      include: { vendor: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    prisma.accountingConnection.findMany({
      where: { shop: session.shop },
      select: { platform: true, companyName: true },
    }),
  ]);
  const applied = credit.invoice
    ? creditByLine(
        [credit],
        credit.invoice.items.map((item) => ({ ...item })),
        true,
      )
    : null;
  return json({ credit, role, candidates, connections, applied });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const id = params.id || "";
  const form = await request.formData();
  const intent = String(form.get("intent"));
  try {
    if (intent === "match")
      await matchCreditNote(request, id, String(form.get("invoiceId") || ""));
    else if (intent === "allocate") {
      const method = form.get("method") === "MANUAL" ? "MANUAL" : "PRO_RATA";
      const manual = Object.fromEntries(
        [...form.entries()]
          .filter(([name]) => name.startsWith("line-"))
          .map(([name, value]) => [name.slice(5), Number(value)]),
      );
      await setCreditNoteAllocation(request, id, method, manual);
    }
    else if (intent === "approve")
      await approveCreditNote(request, id, String(form.get("note") || ""));
    else if (intent === "void")
      await voidCreditNote(request, id, String(form.get("note") || ""));
    else if (intent === "unmatch") await unmatchCreditNote(request, id);
    else if (intent === "post-accounting") {
      const platform = String(form.get("platform"));
      if (platform !== "XERO" && platform !== "QUICKBOOKS")
        throw new Error("Invalid accounting platform.");
      await exportCreditNoteToAccounting(request, id, platform);
    } else throw new Error("Unknown credit note action.");
    return json({ success: true as const, message: "Credit note updated." });
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

export default function CreditNoteDetail() {
  const { credit, role, candidates, connections, applied } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  return (
    <Page
      title={`Credit note ${credit.creditNoteNumber || credit.id.slice(0, 8)}`}
      backAction={{ url: "/app/credit-notes" }}
      subtitle={
        credit.vendor?.name
          ? `${credit.vendor.name} - ${formatMoney(credit.amount, credit.currency)}`
          : formatMoney(credit.amount, credit.currency)
      }
    >
      <BlockStack gap="400">
        {result && (
          <Banner tone={result.success ? "success" : "critical"}>
            {result.success ? result.message : result.error}
          </Banner>
        )}
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Credit details
            </Text>
            <Text as="p">
              Amount {formatMoney(credit.amount, credit.currency)} -{" "}
              {isCreditReason(credit.reason)
                ? CREDIT_REASON_LABELS[credit.reason]
                : credit.reason}
            </Text>
            <Text as="p">
              Original invoice {credit.originalInvoiceNumber || "not stated"}
            </Text>
            <Text as="p">
              Status{" "}
              {isCreditNoteStatus(credit.status)
                ? CREDIT_NOTE_STATUS_LABELS[credit.status]
                : credit.status}
            </Text>
            {credit.invoice ? (
              <Text as="p">
                Matched to{" "}
                <Link to={`/app/invoices/${credit.invoice.id}`}>
                  {credit.invoice.invoiceNumber || credit.invoice.id.slice(0, 8)}
                </Link>
              </Text>
            ) : (
              <Text as="p" tone="subdued">
                This credit is not matched to an invoice yet. Until it is, it
                does not change any Shopify cost.
              </Text>
            )}
            {credit.note && <Text as="p">Note: {credit.note}</Text>}
            {credit.lines.length > 0 && (
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">
                  Parsed credit lines
                </Text>
                {credit.lines.map((line) => (
                  <Text as="p" key={line.id}>
                    {line.description}: {line.quantity} ×{" "}
                    {formatMoney(line.unitPrice, credit.currency)} ={" "}
                    {formatMoney(line.lineAmount, credit.currency)}
                  </Text>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
        {applied && applied.total > 0 && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Credit spread across the invoice
              </Text>
              <Text as="p" tone="subdued">
                {applied.warnings.length
                  ? applied.warnings.join(" ")
                  : `Reduces the matched invoice lines by ${formatMoney(applied.total, credit.currency)} in total.`}
              </Text>
              {applied.lines.map((line) => (
                <Text as="p" key={line.id}>
                  {line.name}:{" "}
                  {formatMoney(applied.byLine[line.id] || 0, credit.currency)} of{" "}
                  {formatMoney(line.value, credit.currency)}
                </Text>
              ))}
            </BlockStack>
          </Card>
        )}
        {role === "FINANCE" &&
          credit.invoiceId &&
          credit.status !== "APPLIED" &&
          credit.status !== "VOID" && (
            <Card>
              <Form method="post">
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">
                    Finance approval
                  </Text>
                  <input type="hidden" name="intent" value="approve" />
                  <label>
                    Approval note (optional){" "}
                    <input name="note" maxLength={200} />
                  </label>
                  <Button submit variant="primary" loading={busy}>
                    Approve credit
                  </Button>
                </BlockStack>
              </Form>
            </Card>
          )}
        {role === "ADMIN" && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Actions
              </Text>
              {!credit.invoiceId && (
                <Form method="post">
                  <BlockStack gap="200">
                    <input type="hidden" name="intent" value="match" />
                    <Text as="p" tone="subdued">
                      Match this credit to the invoice it credits. Only invoices
                      in {credit.currency} can be matched.
                    </Text>
                    <label>
                      Invoice{" "}
                      <select name="invoiceId" required>
                        <option value="">Select an invoice</option>
                        {candidates.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.invoiceNumber || candidate.id.slice(0, 8)}{" "}
                            - {candidate.vendor?.name || "Unknown"} -{" "}
                            {formatMoney(candidate.total, candidate.currency)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <InlineStack gap="200">
                      <Button submit loading={busy}>
                        Match to invoice
                      </Button>
                      <Button url="/app/invoices">Find the invoice</Button>
                    </InlineStack>
                  </BlockStack>
                </Form>
              )}
              {credit.invoiceId && credit.status !== "APPLIED" && (
                <Form method="post">
                  <BlockStack gap="200">
                    <input type="hidden" name="intent" value="allocate" />
                    <Text as="h3" variant="headingSm">
                      Allocate this credit
                    </Text>
                    <label>
                      Allocation method{" "}
                      <select
                        name="method"
                        defaultValue={
                          (credit.allocation as { method?: string } | null)
                            ?.method === "MANUAL"
                            ? "MANUAL"
                            : "PRO_RATA"
                        }
                      >
                        <option value="PRO_RATA">By invoice line value</option>
                        <option value="MANUAL">Manual amount per line</option>
                      </select>
                    </label>
                    {credit.invoice?.items
                      .filter((item) => item.category === "PRODUCT")
                      .map((item) => {
                        const saved = (
                          credit.allocation as {
                            lines?: { lineId: string; amount: number }[];
                          } | null
                        )?.lines?.find((line) => line.lineId === item.id)?.amount;
                        return (
                          <label key={item.id}>
                            {item.name}{" "}
                            <input
                              name={`line-${item.id}`}
                              type="number"
                              min={0}
                              step="0.01"
                              defaultValue={saved ?? applied?.byLine[item.id] ?? 0}
                            />
                          </label>
                        );
                      })}
                    <Text as="p" tone="subdued">
                      Manual amounts must add up exactly to the credit-note
                      total. Automatic allocation spreads the credit by line
                      value.
                    </Text>
                    <Button submit loading={busy}>
                      Save allocation
                    </Button>
                  </BlockStack>
                </Form>
              )}
              {credit.invoiceId && credit.status !== "APPLIED" && (
                <Form method="post">
                  <BlockStack gap="200">
                    <input type="hidden" name="intent" value="approve" />
                    <label>
                      Approval note (optional){" "}
                      <input name="note" maxLength={200} />
                    </label>
                    <InlineStack gap="200">
                      <Button submit variant="primary" loading={busy}>
                        Approve credit
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Form>
              )}
              {credit.status !== "APPLIED" && credit.status !== "VOID" && (
                <Form method="post">
                  <BlockStack gap="200">
                    <input type="hidden" name="intent" value="void" />
                    <label>
                      Reason for voiding{" "}
                      <input name="note" maxLength={200} />
                    </label>
                    <Button submit tone="critical" loading={busy}>
                      Void credit note
                    </Button>
                  </BlockStack>
                </Form>
              )}
              {credit.invoiceId && credit.status !== "APPLIED" && (
                <Form method="post">
                  <input type="hidden" name="intent" value="unmatch" />
                  <Button submit loading={busy}>
                    Unmatch from this invoice
                  </Button>
                </Form>
              )}
              {credit.status === "APPLIED" && (
                <Text as="p" tone="subdued">
                  This credit has already reduced Shopify costs. Restore the
                  invoice cost history before reversing it.
                </Text>
              )}
              {credit.invoice?.accountingStatus === "EXPORTED" &&
                ["APPROVED", "APPLIED"].includes(credit.status) && (
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">
                      Accounting
                    </Text>
                    {credit.accountingReference ? (
                      <Text as="p">
                        Posted to {credit.accountingPlatform} as{" "}
                        {credit.accountingReference}.
                      </Text>
                    ) : connections.length ? (
                      connections.map((connection) => (
                        <Form method="post" key={connection.platform}>
                          <input
                            type="hidden"
                            name="intent"
                            value="post-accounting"
                          />
                          <input
                            type="hidden"
                            name="platform"
                            value={connection.platform}
                          />
                          <Button submit loading={busy}>
                            Post to {connection.platform}
                            {connection.companyName
                              ? ` - ${connection.companyName}`
                              : ""}
                          </Button>
                        </Form>
                      ))
                    ) : (
                      <Text as="p" tone="subdued">
                        Connect Xero or QuickBooks in Settings before posting
                        this credit.
                      </Text>
                    )}
                    {credit.accountingError && (
                      <Text as="p" tone="critical">
                        {credit.accountingError}
                      </Text>
                    )}
                  </BlockStack>
                )}
            </BlockStack>
          </Card>
        )}
        {credit.rawText && (
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                Recognized text
              </Text>
              <Text as="p" tone="subdued">
                {credit.rawText.slice(0, 4000)}
              </Text>
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
