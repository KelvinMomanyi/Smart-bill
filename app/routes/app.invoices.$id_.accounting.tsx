import {
  json,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import { Page, Card, BlockStack, Text, Banner, Button } from "@shopify/polaris";
import prisma from "../db.server";
import { requireAdmin } from "../utils/rbac.server";
import { getAccountingCatalog } from "../services/accountingCatalog.server";
import { livePlatform } from "../services/accountingConnection.server";
import { saveInvoiceAccountingMapping } from "../services/accountingExport.server";
import { isUsCompany, type BillMapping } from "../utils/accountingValidation";
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await requireAdmin(request);
  const invoice = await prisma.invoice.findFirst({
    where: { id: params.id, shop: session.shop },
    include: { items: true, exports: true },
  });
  if (!invoice) throw new Response("Invoice not found.", { status: 404 });
  const platform = livePlatform(
    new URL(request.url).searchParams.get("platform") || "XERO",
  );
  const settings = await prisma.shopSettings.findUnique({
    where: { shop: session.shop },
  });
  try {
    return json({
      invoice,
      platform,
      settings,
      catalog: await getAccountingCatalog(session.shop, platform),
      error: null,
    });
  } catch (error) {
    return json({
      invoice,
      platform,
      settings,
      catalog: null,
      error: error instanceof Error ? error.message : "Connection unavailable.",
    });
  }
}
export async function action({ request, params }: ActionFunctionArgs) {
  try {
    const form = await request.formData();
    await saveInvoiceAccountingMapping(
      request,
      params.id || "",
      livePlatform(String(form.get("platform"))),
      form,
    );
    return json({
      success: true as const,
      message: "Accounting choices saved and tax totals checked.",
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    return json(
      {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Could not save accounting choices.",
      },
      { status: 400 },
    );
  }
}
export default function InvoiceAccountingDetails() {
  const { invoice, platform, settings, catalog, error } =
    useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const mapping = (invoice.accountingMapping as any)?.[platform] as
    | BillMapping
    | undefined;
  const matching =
    mapping?.companyKey === catalog?.companyKey ? mapping : undefined;
  const entry = invoice.exports.find((e) => e.platform === platform);
  const locked = Boolean(entry && entry.status !== "REJECTED");
  const us =
    catalog && platform === "QUICKBOOKS" && isUsCompany(catalog.country);
  return (
    <Page
      title={`${platform} accounting details`}
      backAction={{ content: "Invoice", url: `/app/invoices/${invoice.id}` }}
    >
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical">
            {error} Open Settings to connect or repair the connection.
          </Banner>
        )}
        {result && (
          <Banner tone={result.success ? "success" : "critical"}>
            {result.success ? result.message : result.error}
          </Banner>
        )}
        {catalog && (
          <Card>
            <Form method="post">
              <input type="hidden" name="platform" value={platform} />
              <input type="hidden" name="revision" value={invoice.revision} />
              <BlockStack gap="400">
                <Text as="p">
                  Company: {catalog.companyName}. Invoice{" "}
                  {invoice.invoiceNumber}: {invoice.currency}{" "}
                  {invoice.total.toFixed(2)}, including{" "}
                  {Number(invoice.tax || 0).toFixed(2)} tax.
                </Text>
                {locked && (
                  <Banner tone="info">
                    These choices are locked because an export has started or
                    completed.
                  </Banner>
                )}
                <Text as="p">
                  Choose the purchase account and tax for each net line amount.
                  Tax codes must reproduce the approved invoice&apos;s tax
                  total.
                </Text>
                {us && (
                  <Text as="p">
                    US purchase sales tax uses the separate expense account
                    selected in Settings.
                  </Text>
                )}
                {invoice.items.map((item) => {
                  const line = matching?.lines.find(
                    (l) => l.itemId === item.id,
                  );
                  return (
                    <fieldset key={item.id} disabled={locked || busy}>
                      <legend>
                        {item.name} —{" "}
                        {Number(
                          item.amount ?? item.price * item.quantity,
                        ).toFixed(2)}{" "}
                        {invoice.currency}
                      </legend>
                      <label>
                        Purchase account{" "}
                        <select
                          name={`account-${item.id}`}
                          required
                          defaultValue={
                            line?.accountId ||
                            (platform === "XERO"
                              ? settings?.xeroAccountCode
                              : settings?.quickBooksAccountId) ||
                            ""
                          }
                        >
                          <option value="">Choose account</option>
                          {catalog.accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name} ({a.id})
                            </option>
                          ))}
                        </select>
                      </label>{" "}
                      {!us && (
                        <label>
                          Purchase tax{" "}
                          <select
                            name={`tax-${item.id}`}
                            required
                            defaultValue={
                              line?.taxCodeId ||
                              (platform === "XERO"
                                ? settings?.xeroTaxType
                                : settings?.quickBooksTaxCodeId) ||
                              ""
                            }
                          >
                            <option value="">Choose tax</option>
                            {catalog.taxes.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.name} ({t.id})
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                    </fieldset>
                  );
                })}
                {invoice.currency !== catalog.homeCurrency && (
                  <label>
                    Exchange rate: 1 {invoice.currency} equals{" "}
                    <input
                      name="exchangeRate"
                      type="number"
                      min="0.000001"
                      step="any"
                      required
                      defaultValue={matching?.exchangeRate || ""}
                      disabled={locked || busy}
                    />{" "}
                    {catalog.homeCurrency}
                  </label>
                )}
                <Text as="p">
                  Xero bills are created as drafts for review in Xero.
                  QuickBooks creates an unpaid supplier bill.
                </Text>
                <Button submit loading={busy} disabled={locked}>
                  Save accounting choices
                </Button>
                <Button url={`/app/invoices/${invoice.id}`}>
                  Return to invoice to export
                </Button>
              </BlockStack>
            </Form>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
