import {
  json,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
} from "@remix-run/react";
import { useEffect, useState } from "react";
import {
  Page,
  Card,
  BlockStack,
  Banner,
  Button,
  Text,
  InlineStack,
  DataTable,
} from "@shopify/polaris";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  getDashboard,
  createInvoiceFromInput,
} from "../services/invoiceWorkflow.server";
import {
  getUsage,
  subscriptionFor,
  requireSubscription,
} from "../services/billing.server";
import { enqueueDocument } from "../services/invoiceJobs.server";
import { PLANS } from "../utils/plans";
import { formatMoney } from "../utils/format";
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const [dashboard, subscription, used, purchaseOrders, jobs, pendingJobs] =
    await Promise.all([
      getDashboard(session.shop),
      subscriptionFor(admin),
      getUsage(session.shop),
      prisma.purchaseOrder.findMany({
        where: { shop: session.shop, status: { not: "FULFILLED" } },
        include: { vendor: true },
        take: 100,
      }),
      prisma.invoiceJob.findMany({
        where: { shop: session.shop },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          filename: true,
          status: true,
          pageCount: true,
          error: true,
          invoiceId: true,
        },
      }),
      prisma.invoiceJob.count({
        where: { shop: session.shop, status: { in: ["QUEUED", "PROCESSING"] } },
      }),
    ]);
  return json({
    dashboard,
    subscription,
    used,
    purchaseOrders,
    jobs,
    pendingJobs,
    uploadLimitMb: process.env.VERCEL ? 4 : 25,
  });
}
export async function action({ request }: ActionFunctionArgs) {
  try {
    const limitMb = process.env.VERCEL ? 4 : 25;
    if (
      Number(request.headers.get("content-length") || 0) >
      limitMb * 1024 * 1024 + 65536
    )
      throw new Error(`Upload at most ${limitMb} MB in a batch on this host.`);
    const { session, plan } = await requireSubscription(request);
    const form = await request.formData();
    const files = form
      .getAll("invoiceFile")
      .filter((f): f is File => f instanceof File && f.size > 0);
    if (files.reduce((sum, file) => sum + file.size, 0) > limitMb * 1024 * 1024)
      throw new Error(`Upload at most ${limitMb} MB in a batch on this host.`);
    const vendorName = String(form.get("vendorName") || "");
    const purchaseOrderId =
      String(form.get("purchaseOrderId") || "") || undefined;
    if (files.length > 10)
      throw new Error("Upload at most 10 documents at once.");
    if (files.length > 1) await requireSubscription(request, "bulk");
    if (files.length) {
      const messages: string[] = [];
      let accepted = 0;
      for (const file of files) {
        try {
          await enqueueDocument({
            shop: session.shop,
            plan,
            buffer: Buffer.from(await file.arrayBuffer()),
            filename: file.name,
            contentType: file.type,
            vendorName,
            purchaseOrderId,
          });
          messages.push(`${file.name}: queued`);
          accepted++;
        } catch (error) {
          messages.push(
            `${file.name}: ${error instanceof Error ? error.message : "Upload failed"}`,
          );
        }
      }
      if (!accepted) throw new Error(messages.join(" • "));
      return json({ success: true as const, message: messages.join(" • ") });
    }
    const result = await createInvoiceFromInput({
      request,
      shop: session.shop,
      rawText: String(form.get("rawText") || ""),
      vendorName,
      purchaseOrderId,
    });
    return json({
      success: true as const,
      message: `Invoice ${result.invoice.invoiceNumber || result.invoice.id} saved for review.`,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    return json(
      {
        success: false as const,
        error: error instanceof Error ? error.message : "Capture failed.",
      },
      { status: 400 },
    );
  }
}
export default function Dashboard() {
  const {
    dashboard,
    subscription,
    used,
    purchaseOrders,
    jobs,
    pendingJobs,
    uploadLimitMb,
  } = useLoaderData<typeof loader>();
  const [uploadError, setUploadError] = useState("");
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!pendingJobs) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [pendingJobs, revalidator]);
  return (
    <Page
      title="SmartBill"
      subtitle="Capture invoices, review costs, and approve accurate supplier bills."
      primaryAction={{ content: "Review invoices", url: "/app/invoices" }}
    >
      <BlockStack gap="500">
        {!subscription && (
          <Banner tone="info" title="Start your 14-day trial">
            <p>
              Plans start at $19 USD every 30 days. Choose a plan in Settings to
              start capturing invoices.
            </p>
            <Button url="/app/settings">Choose a plan</Button>
          </Banner>
        )}
        {result && (
          <Banner tone={result.success ? "info" : "critical"}>
            {result.success ? result.message : result.error}
          </Banner>
        )}
        {uploadError && <Banner tone="critical">{uploadError}</Banner>}
        <Card>
          <InlineStack gap="500">
            <Text as="p">
              Invoices this month: {dashboard.metrics.invoicesThisMonth}
            </Text>
            <Text as="p">
              Need attention: {dashboard.metrics.invoicesNeedingAttention}
            </Text>
            <Text as="p">Open POs: {dashboard.metrics.openPurchaseOrders}</Text>
            <Text as="p">
              Costs synced: {dashboard.metrics.cogsSyncedThisMonth}
            </Text>
          </InlineStack>
          <Text as="p">
            Spend:{" "}
            {dashboard.metrics.spendByCurrency
              .map((t) => formatMoney(t.total, t.currency))
              .join(" · ") || "No invoices yet"}
          </Text>
          {subscription && (
            <Text as="p">
              {used} / {PLANS[subscription.plan].invoiceLimit} uploads used this
              calendar month
            </Text>
          )}
        </Card>
        <Card>
          <Form
            method="post"
            encType="multipart/form-data"
            onSubmit={(event) => {
              const form = new FormData(event.currentTarget);
              const files = form
                .getAll("invoiceFile")
                .filter((file): file is File => file instanceof File);
              setUploadError("");
              if (
                files.some((file) => file.size > 10 * 1024 * 1024) ||
                files.reduce((sum, file) => sum + file.size, 0) >
                  uploadLimitMb * 1024 * 1024
              ) {
                event.preventDefault();
                setUploadError(
                  `Use files up to 10 MB each and at most ${uploadLimitMb} MB in total per batch on this host.`,
                );
              }
            }}
          >
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Capture supplier invoices
              </Text>
              <label>
                Invoice documents{" "}
                <input
                  name="invoiceFile"
                  type="file"
                  accept=".pdf,image/jpeg,image/png,image/gif,image/webp"
                  multiple={subscription?.plan === "GROWTH"}
                />
              </label>
              <Text as="p" tone="subdued">
                PDFs and images, up to 10 MB and 10 pages each. Growth supports
                batches of up to 10 documents. Processing continues in the
                background.
              </Text>
              <Text as="p" tone="subdued">
                This host accepts up to {uploadLimitMb} MB total per upload
                batch.
              </Text>
              <label>
                Supplier name (optional) <input name="vendorName" />
              </label>
              <label>
                Purchase order{" "}
                <select name="purchaseOrderId">
                  <option value="">No purchase order</option>
                  {purchaseOrders.map((po) => (
                    <option key={po.id} value={po.id}>
                      {po.poNumber || po.id.slice(0, 8)} — {po.vendor.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Or paste invoice text{" "}
                <textarea name="rawText" rows={6} style={{ width: "100%" }} />
              </label>
              <Text as="p" tone="subdued">
                Every invoice is saved for review. No product costs or
                accounting bills change during capture.
              </Text>
              <Button
                submit
                variant="primary"
                loading={busy}
                disabled={!subscription}
              >
                Capture invoices
              </Button>
            </BlockStack>
          </Form>
        </Card>
        {jobs.length > 0 && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Document processing
              </Text>
              {jobs.map((job) => (
                <div key={job.id}>
                  <Text as="p">
                    {job.filename} — {job.status}
                    {job.pageCount > 0
                      ? ` (${job.pageCount} pages processed)`
                      : ""}
                  </Text>
                  {job.error && (
                    <Text as="p" tone="critical">
                      {job.error}
                    </Text>
                  )}
                  {job.invoiceId && (
                    <Link to={`/app/invoices/${job.invoiceId}`}>
                      Review invoice
                    </Link>
                  )}
                  {job.status === "FAILED" && (
                    <Form method="post" action="/api/jobs">
                      <input type="hidden" name="jobId" value={job.id} />
                      <Button submit>Retry processing</Button>
                    </Form>
                  )}
                </div>
              ))}
            </BlockStack>
          </Card>
        )}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Recent invoices
            </Text>
            <DataTable
              columnContentTypes={["text", "text", "numeric", "text"]}
              headings={["Invoice", "Supplier", "Total", "Review"]}
              rows={dashboard.recentInvoices.map((i) => [
                <Link key={i.id} to={`/app/invoices/${i.id}`}>
                  {i.invoiceNumber || i.id.slice(0, 8)}
                </Link>,
                i.vendor?.name || "Unknown",
                formatMoney(i.total, i.currency),
                i.reviewStatus,
              ])}
            />
            <InlineStack gap="300">
              <Button url="/app/reconciliation">Purchase orders</Button>
              <Button url="/app/reports">Weekly report</Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
