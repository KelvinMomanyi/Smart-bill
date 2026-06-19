import {
  json,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
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
import { getShopSettings } from "../services/invoiceWorkflow.server";
import { createAccountingState } from "../utils/accountingOAuth.server";
import { getQuickBooksAuthUrl } from "../utils/quickbook";
import { requireAdmin } from "../utils/rbac.server";
import { getXeroAuthUrl } from "../utils/xero";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await requireAdmin(request);
  const [settings, accountingConnections] = await Promise.all([
    getShopSettings(session.shop),
    prisma.accountingConnection.findMany({
      where: { shop: session.shop },
      select: { platform: true, tenantId: true, realmId: true, updatedAt: true },
    }),
  ]);

  return json({
    settings,
    accountingConnections,
    plans: [
      { label: "Growth - $99/mo", value: SMARTBILL_PLANS.GROWTH },
      { label: "Scale - $249/mo", value: SMARTBILL_PLANS.SCALE },
    ],
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");
  const shop = session.shop;

  try {
    if (intent === "save-settings") {
      await prisma.shopSettings.upsert({
        where: { shop },
        update: {
          billingPlan: String(formData.get("billingPlan") || "GROWTH"),
          accountingPlatform: String(formData.get("accountingPlatform") || "") || null,
          autoSyncCogs: formData.get("autoSyncCogs") === "on",
          requireReview: formData.get("requireReview") === "on",
          defaultCurrency: String(formData.get("defaultCurrency") || "USD").toUpperCase(),
        },
        create: {
          shop,
          billingPlan: String(formData.get("billingPlan") || "GROWTH"),
          accountingPlatform: String(formData.get("accountingPlatform") || "") || null,
          autoSyncCogs: formData.get("autoSyncCogs") === "on",
          requireReview: formData.get("requireReview") === "on",
          defaultCurrency: String(formData.get("defaultCurrency") || "USD").toUpperCase(),
        },
      });
      return json({ success: true, message: "Settings saved" });
    }

    if (intent === "start-billing") {
      const plan = String(formData.get("plan") || SMARTBILL_PLANS.GROWTH);
      const url = new URL(request.url);
      return billing.request({
        plan,
        isTest: process.env.NODE_ENV !== "production",
        returnUrl: `${url.origin}/app/settings`,
      });
    }

    if (intent === "connect-accounting") {
      const platform = String(formData.get("platform") || "");
      const url = new URL(request.url);

      if (platform === "XERO") {
        const redirectUri = `${url.origin}/accounting/xero/callback`;
        return redirect(
          await getXeroAuthUrl(
            redirectUri,
            createAccountingState(shop, "XERO"),
          ),
        );
      }

      if (platform === "QUICKBOOKS") {
        const redirectUri = `${url.origin}/accounting/quickbooks/callback`;
        return redirect(
          await getQuickBooksAuthUrl(
            redirectUri,
            createAccountingState(shop, "QUICKBOOKS"),
          ),
        );
      }

      return json(
        { success: false, error: "Unsupported accounting platform" },
        { status: 400 },
      );
    }

    return json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
};

export default function Settings() {
  const { settings, plans, accountingConnections } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [billingPlan, setBillingPlan] = useState(settings.billingPlan);
  const [accountingPlatform, setAccountingPlatform] = useState(settings.accountingPlatform || "");
  const [defaultCurrency, setDefaultCurrency] = useState(settings.defaultCurrency);
  const [autoSyncCogs, setAutoSyncCogs] = useState(settings.autoSyncCogs);
  const [requireReview, setRequireReview] = useState(settings.requireReview);
  const isSubmitting = navigation.state === "submitting";
  const connectedPlatforms = new Set(
    accountingConnections.map((connection) => connection.platform),
  );

  return (
    <Page title="Settings" subtitle="Configure billing, review controls, COGS sync defaults, and accounting export behavior.">
      <BlockStack gap="500">
        {actionData?.success && (
          <Banner tone="success" title={actionData.message}>
            <p>Your SmartBill settings are current.</p>
          </Banner>
        )}
        {actionData && !actionData.success && (
          <Banner tone="critical" title="Settings action failed">
            <p>{actionData.error}</p>
          </Banner>
        )}

        <Layout>
          <Layout.Section>
            <Card>
              <Form method="post">
                <input type="hidden" name="intent" value="save-settings" />
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    Operating defaults
                  </Text>
                  <Select
                    label="Internal plan marker"
                    name="billingPlan"
                    options={[
                      { label: "Growth", value: "GROWTH" },
                      { label: "Scale", value: "SCALE" },
                    ]}
                    value={billingPlan}
                    onChange={setBillingPlan}
                  />
                  <TextField
                    label="Default currency"
                    name="defaultCurrency"
                    value={defaultCurrency}
                    onChange={setDefaultCurrency}
                    autoComplete="off"
                    maxLength={3}
                  />
                  <Select
                    label="Accounting platform"
                    name="accountingPlatform"
                    value={accountingPlatform}
                    onChange={setAccountingPlatform}
                    options={[
                      { label: "CSV export package", value: "" },
                      { label: "Xero payloads", value: "XERO" },
                      { label: "QuickBooks payloads", value: "QUICKBOOKS" },
                    ]}
                  />
                  <Checkbox
                    label="Require human review before accounting export"
                    name="requireReview"
                    checked={requireReview}
                    onChange={setRequireReview}
                  />
                  <Checkbox
                    label="Enable COGS sync by default during invoice capture"
                    name="autoSyncCogs"
                    checked={autoSyncCogs}
                    onChange={setAutoSyncCogs}
                  />
                  <Button submit variant="primary" loading={isSubmitting}>
                    Save settings
                  </Button>
                </BlockStack>
              </Form>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Billing
                </Text>
                <InlineStack gap="200">
                  <Badge tone="info">{settings.billingPlan}</Badge>
                  <Badge tone={settings.accountingConnected ? "success" : "warning"}>
                    {settings.accountingConnected ? "Accounting connected" : "Export package mode"}
                  </Badge>
                </InlineStack>
                {plans.map((plan) => (
                  <Form method="post" key={plan.value}>
                    <input type="hidden" name="intent" value="start-billing" />
                    <input type="hidden" name="plan" value={plan.value} />
                    <Button submit loading={isSubmitting}>
                      Start {plan.label}
                    </Button>
                  </Form>
                ))}
              </BlockStack>
            </Card>

            <div style={{ height: 16 }} />

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Accounting connections
                </Text>
                <InlineStack gap="200">
                  <Badge tone={connectedPlatforms.has("XERO") ? "success" : "info"}>
                    {connectedPlatforms.has("XERO") ? "Xero connected" : "Xero"}
                  </Badge>
                  <Badge
                    tone={
                      connectedPlatforms.has("QUICKBOOKS") ? "success" : "info"
                    }
                  >
                    {connectedPlatforms.has("QUICKBOOKS")
                      ? "QuickBooks connected"
                      : "QuickBooks"}
                  </Badge>
                </InlineStack>
                <Form method="post">
                  <input type="hidden" name="intent" value="connect-accounting" />
                  <input type="hidden" name="platform" value="XERO" />
                  <Button submit loading={isSubmitting}>
                    Connect Xero
                  </Button>
                </Form>
                <Form method="post">
                  <input type="hidden" name="intent" value="connect-accounting" />
                  <input type="hidden" name="platform" value="QUICKBOOKS" />
                  <Button submit loading={isSubmitting}>
                    Connect QuickBooks
                  </Button>
                </Form>
              </BlockStack>
            </Card>

            <div style={{ height: 16 }} />

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Security posture
                </Text>
                <Text as="p" tone="subdued">
                  Invoice documents are stored as private storage references. Keep Firebase and accounting credentials in environment variables only.
                </Text>
                <Badge tone="success">Public invoice files disabled</Badge>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}
