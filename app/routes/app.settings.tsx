import { randomUUID } from "node:crypto";
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
import {
  Page,
  Card,
  BlockStack,
  Banner,
  Text,
  Button,
  InlineStack,
  Badge,
} from "@shopify/polaris";
import prisma from "../db.server";
import { requireAdmin } from "../utils/rbac.server";
import { getShopSettings } from "../services/invoiceWorkflow.server";
import {
  getUsage,
  requireSubscription,
  subscriptionFor,
} from "../services/billing.server";
import { PLANS, planFromName, TRIAL_DAYS } from "../utils/plans";
import { validCurrency } from "../utils/invoiceRules";
import { createAuthorization } from "../services/accountingAuthorization.server";
import {
  disconnectAccounting,
  livePlatform,
} from "../services/accountingConnection.server";
import { getAccountingCatalog } from "../services/accountingCatalog.server";
import { quickBooksEnvironment } from "../utils/quickbook";
import { isUsCompany } from "../utils/accountingValidation";
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await requireAdmin(request);
  const [settings, subscription, used, connections, staff] = await Promise.all([
    getShopSettings(session.shop),
    subscriptionFor(admin),
    getUsage(session.shop),
    prisma.accountingConnection.findMany({
      where: { shop: session.shop },
      select: {
        platform: true,
        companyName: true,
        tenantId: true,
        realmId: true,
        environment: true,
      },
    }),
    prisma.session.findMany({
      where: { shop: session.shop, isOnline: true },
      select: {
        id: true,
        email: true,
        firstName: true,
        role: true,
        accountOwner: true,
      },
    }),
  ]);
  const catalogs = await Promise.all(
    connections.map(async (connection) => {
      try {
        return {
          platform: connection.platform,
          catalog: await getAccountingCatalog(
            session.shop,
            livePlatform(connection.platform),
          ),
          error: null,
        };
      } catch (error) {
        return {
          platform: connection.platform,
          catalog: null,
          error:
            error instanceof Error ? error.message : "Connection check failed.",
        };
      }
    }),
  );
  return json({
    settings,
    subscription,
    used,
    connections,
    catalogs,
    quickBooksEnvironment: quickBooksEnvironment(),
    accountingConfigured: {
      XERO: Boolean(
        process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET,
      ),
      QUICKBOOKS: Boolean(
        (process.env.QB_CLIENT_ID && process.env.QB_CLIENT_SECRET) ||
          (process.env.QB_ENVIRONMENT === "sandbox" &&
            process.env.QB_SANDBOX_CLIENT_ID &&
            process.env.QB_SANDBOX_CLIENT_SECRET),
      ),
    },
    staff,
    owner: session.onlineAccessInfo?.associated_user.account_owner === true,
    inboxDomain: process.env.INBOUND_EMAIL_DOMAIN || "",
    inboxReady: Boolean(
      process.env.INBOUND_EMAIL_DOMAIN && process.env.INBOUND_EMAIL_SECRET,
    ),
  });
}
export async function action({ request }: ActionFunctionArgs) {
  const {
    session,
    billing,
    actor,
    redirect: shopifyRedirect,
  } = await requireAdmin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "");
  try {
    if (intent === "start-billing") {
      const key = planFromName(String(form.get("plan")));
      if (!key) throw new Error("Choose a valid plan.");
      return await billing.request({
        plan: PLANS[key].name,
        isTest:
          process.env.NODE_ENV !== "production" ||
          process.env.SHOPIFY_BILLING_TEST === "true",
        returnUrl: `${process.env.SHOPIFY_APP_URL?.replace(/\/$/, "") || new URL(request.url).origin}/app/settings`,
      });
    }
    if (intent === "save-settings") {
      await requireSubscription(request);
      const currency = String(form.get("defaultCurrency")).toUpperCase();
      if (!validCurrency(currency))
        throw new Error("Enter a valid ISO currency code.");
      const minutes = Number(form.get("minutesSavedPerInvoice"));
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 120)
        throw new Error("Time saved must be between 0 and 120 minutes.");
      const data = {
        defaultCurrency: currency,
        dateOrder: form.get("dateOrder") === "MDY" ? "MDY" : "DMY",
        requireReview: true,
        autoSyncCogs: false,
        xeroAccountCode:
          String(form.get("xeroAccountCode") || "").trim() || null,
        xeroTaxType: String(form.get("xeroTaxType") || "").trim() || null,
        quickBooksAccountId:
          String(form.get("quickBooksAccountId") || "").trim() || null,
        quickBooksTaxCodeId:
          String(form.get("quickBooksTaxCodeId") || "").trim() || null,
        quickBooksTaxAccountId:
          String(form.get("quickBooksTaxAccountId") || "").trim() || null,
        minutesSavedPerInvoice: minutes,
      };
      const linked = await prisma.accountingConnection.findMany({
        where: { shop: session.shop },
        select: { platform: true },
      });
      for (const link of linked) {
        const platform = livePlatform(link.platform);
        const catalog = await getAccountingCatalog(session.shop, platform);
        const account =
          platform === "XERO" ? data.xeroAccountCode : data.quickBooksAccountId;
        const tax =
          platform === "XERO" ? data.xeroTaxType : data.quickBooksTaxCodeId;
        if (account && !catalog.accounts.some((a) => a.id === account))
          throw new Error(
            "Choose an active purchase account from the connected company.",
          );
        if (tax && !catalog.taxes.some((t) => t.id === tax))
          throw new Error(
            "Choose a purchase tax code from the connected company.",
          );
        if (
          platform === "QUICKBOOKS" &&
          data.quickBooksTaxAccountId &&
          !catalog.accounts.some(
            (a) => a.id === data.quickBooksTaxAccountId && a.type === "EXPENSE",
          )
        )
          throw new Error(
            "Choose an expense account for non-recoverable US purchase sales tax.",
          );
      }
      await prisma.shopSettings.update({ where: { shop: session.shop }, data });
      await prisma.auditEvent.create({
        data: { shop: session.shop, actor, action: "SETTINGS_UPDATED" },
      });
    } else if (intent === "enable-inbox") {
      await requireSubscription(request, "bulk");
      if (
        !process.env.INBOUND_EMAIL_DOMAIN ||
        !process.env.INBOUND_EMAIL_SECRET
      )
        throw new Error(
          "Email capture has not been configured by the app operator.",
        );
      await prisma.shopSettings.update({
        where: { shop: session.shop },
        data: { inboundAlias: randomUUID().replace(/-/g, "") },
      });
    } else if (intent === "staff-role") {
      if (!session.onlineAccessInfo?.associated_user.account_owner)
        throw new Error("Only the store owner can change staff permissions.");
      await requireSubscription(request);
      await prisma.session.updateMany({
        where: {
          id: String(form.get("staffId")),
          shop: session.shop,
          isOnline: true,
          accountOwner: false,
        },
        data: { role: form.get("role") === "ADMIN" ? "ADMIN" : "SCANNER" },
      });
      await prisma.auditEvent.create({
        data: {
          shop: session.shop,
          actor,
          action: "STAFF_ROLE_UPDATED",
          detail: {
            staffId: String(form.get("staffId")),
            role: String(form.get("role")),
          },
        },
      });
    } else if (intent === "connect-accounting") {
      await requireSubscription(request);
      return shopifyRedirect(
        await createAuthorization(
          session.shop,
          livePlatform(String(form.get("platform"))),
          actor,
        ),
        { target: "_top" },
      );
    } else if (intent === "disconnect-accounting") {
      await disconnectAccounting(
        session.shop,
        livePlatform(String(form.get("platform"))),
        actor,
      );
    } else throw new Error("Unknown action.");
    return json({ success: true as const, message: "Settings saved." });
  } catch (error) {
    if (error instanceof Response) throw error;
    return json(
      {
        success: false as const,
        error:
          error instanceof Error
            ? error.message
            : "Settings could not be saved.",
      },
      { status: 400 },
    );
  }
}
export default function Settings() {
  const {
    settings,
    subscription,
    used,
    connections,
    catalogs,
    accountingConfigured,
    quickBooksEnvironment,
    owner,
    staff,
    inboxReady,
    inboxDomain,
  } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const xero = catalogs.find((c) => c.platform === "XERO")?.catalog;
  const quickbooks = catalogs.find((c) => c.platform === "QUICKBOOKS")?.catalog;
  return (
    <Page
      title="Settings and plans"
      subtitle="Affordable invoice control with approval before every financial change."
    >
      <BlockStack gap="500">
        {result && (
          <Banner tone={result.success ? "success" : "critical"}>
            {result.success ? result.message : result.error}
          </Banner>
        )}
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Choose your plan
            </Text>
            {subscription && !subscription.matchesPrice && (
              <Banner tone="info">
                Your existing subscription uses earlier pricing. Choose a plan
                below and approve the lower price in Shopify to replace it.
              </Banner>
            )}
            <Text as="p">
              {subscription
                ? `${PLANS[subscription.plan].label}: ${used} / ${PLANS[subscription.plan].invoiceLimit} invoices used this calendar month.`
                : "Start a 14-day trial to capture and process invoices."}
            </Text>
            <InlineStack gap="400">
              {Object.entries(PLANS).map(([key, plan]) => (
                <Form method="post" key={key} style={{ flex: "1 1 260px" }}>
                  <input type="hidden" name="intent" value="start-billing" />
                  <input type="hidden" name="plan" value={plan.name} />
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingMd">
                      {plan.label} — $ {plan.price} USD / 30 days
                    </Text>
                    <Text as="p">{plan.description}</Text>
                    <Button
                      submit
                      loading={busy}
                      disabled={
                        subscription?.plan === key && subscription.matchesPrice
                      }
                    >
                      {subscription?.plan === key && subscription.matchesPrice
                        ? "Current plan"
                        : `Start ${TRIAL_DAYS}-day trial / switch`}
                    </Button>
                  </BlockStack>
                </Form>
              ))}
            </InlineStack>
            <Text as="p" tone="subdued">
              No automatic overage fees. Allowances reset on the first of each
              month, UTC. Maximum 10 MB and 10 pages per document. Each accepted
              upload counts once; retries of that upload are included.
            </Text>
          </BlockStack>
        </Card>
        <Card>
          <Form method="post">
            <input type="hidden" name="intent" value="save-settings" />
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Review and accounting defaults
              </Text>
              <Badge tone="success">Approval always required</Badge>
              <label>
                Default reporting / PO currency{" "}
                <input
                  name="defaultCurrency"
                  defaultValue={settings.defaultCurrency}
                  maxLength={3}
                  required
                />
              </label>
              <label>
                Numeric invoice date order{" "}
                <select name="dateOrder" defaultValue={settings.dateOrder}>
                  <option value="DMY">Day / month / year</option>
                  <option value="MDY">Month / day / year</option>
                </select>
              </label>
              <AccountChoice
                name="xeroAccountCode"
                label="Xero purchase account"
                value={settings.xeroAccountCode}
                options={xero?.accounts}
              />
              <AccountChoice
                name="xeroTaxType"
                label="Xero default purchase tax"
                value={settings.xeroTaxType}
                options={xero?.taxes}
              />
              <AccountChoice
                name="quickBooksAccountId"
                label="QuickBooks purchase account"
                value={settings.quickBooksAccountId}
                options={quickbooks?.accounts}
              />
              {(!quickbooks || !isUsCompany(quickbooks.country)) && (
                <AccountChoice
                  name="quickBooksTaxCodeId"
                  label="QuickBooks default purchase tax"
                  value={settings.quickBooksTaxCodeId}
                  options={quickbooks?.taxes}
                />
              )}
              {quickbooks && isUsCompany(quickbooks.country) && (
                <>
                  <AccountChoice
                    name="quickBooksTaxAccountId"
                    label="US purchase sales-tax expense account"
                    value={settings.quickBooksTaxAccountId}
                    options={quickbooks.accounts.filter(
                      (a) => a.type === "EXPENSE",
                    )}
                  />
                  <Text as="p" tone="subdued">
                    US QuickBooks records purchase sales tax as a separate,
                    non-recoverable expense using this account.
                  </Text>
                </>
              )}
              <Text as="p" tone="subdued">
                Choices come from your connected company. Use Accounting details
                on an invoice to choose different accounts or taxes per line and
                enter an exchange rate. Enter net line amounts and separate tax.
              </Text>
              <label>
                Measured minutes saved per approved invoice{" "}
                <input
                  name="minutesSavedPerInvoice"
                  type="number"
                  min={0}
                  max={120}
                  step="0.1"
                  defaultValue={settings.minutesSavedPerInvoice}
                />
              </label>
              <Text as="p" tone="subdued">
                Leave at zero until you have measured this. Weekly reports label
                the resulting time savings as an estimate.
              </Text>
              <Button submit loading={busy}>
                Save defaults
              </Button>
            </BlockStack>
          </Form>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Accounting connections
            </Text>
            <InlineStack gap="300">
              {(["XERO", "QUICKBOOKS"] as const).map((platform) => {
                const connection = connections.find(
                  (c) => c.platform === platform,
                );
                const connected = Boolean(connection);
                const health = catalogs.find((c) => c.platform === platform);
                return (
                  <BlockStack gap="200" key={platform}>
                    <Text as="p">
                      {platform}:{" "}
                      {connection
                        ? connection.companyName ||
                          connection.tenantId ||
                          connection.realmId
                        : "Not connected"}
                      {platform === "QUICKBOOKS"
                        ? ` (${connection?.environment || quickBooksEnvironment})`
                        : ""}
                    </Text>
                    {health?.error && (
                      <Banner tone="warning">
                        {health.error} Reconnect if permissions have changed.
                      </Banner>
                    )}
                    {!accountingConfigured[platform] && (
                      <Text as="p" tone="subdued">
                        The app operator must configure this provider&apos;s
                        credentials before connection.
                      </Text>
                    )}
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="connect-accounting"
                      />
                      <input type="hidden" name="platform" value={platform} />
                      <Button
                        submit
                        loading={busy}
                        disabled={!accountingConfigured[platform]}
                      >
                        {connected ? "Reconnect / change company" : "Connect"}{" "}
                        {platform}
                      </Button>
                    </Form>
                    {connected && (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="disconnect-accounting"
                        />
                        <input type="hidden" name="platform" value={platform} />
                        <Button submit loading={busy}>
                          Disconnect {platform}
                        </Button>
                      </Form>
                    )}
                  </BlockStack>
                );
              })}
            </InlineStack>
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Invoice email inbox
            </Text>
            <Text as="p">
              {settings.inboundAlias && inboxReady
                ? `Forward supplier invoices to ${settings.inboundAlias}@${inboxDomain}.`
                : "Growth includes an inbox for forwarded supplier PDF and image attachments."}
            </Text>
            {inboxReady ? (
              <Form method="post">
                <input type="hidden" name="intent" value="enable-inbox" />
                <Button submit loading={busy}>
                  {settings.inboundAlias
                    ? "Replace inbox address"
                    : "Enable inbox"}
                </Button>
              </Form>
            ) : (
              <Text as="p" tone="subdued">
                Email capture is awaiting activation by the app operator. File
                upload remains available.
              </Text>
            )}
          </BlockStack>
        </Card>
        {owner && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Staff access
              </Text>
              <Text as="p">
                Staff can capture and edit invoices. Approvers can approve,
                export, manage costs and settings. Staff appear after opening
                the app.
              </Text>
              {staff
                .filter((s) => !s.accountOwner)
                .map((s) => (
                  <Form method="post" key={s.id}>
                    <input type="hidden" name="intent" value="staff-role" />
                    <input type="hidden" name="staffId" value={s.id} />
                    <label>
                      {s.email || s.firstName || "Staff member"}{" "}
                      <select name="role" defaultValue={s.role || "SCANNER"}>
                        <option value="SCANNER">Capture and edit</option>
                        <option value="ADMIN">Approver</option>
                      </select>
                    </label>{" "}
                    <Button submit>Save access</Button>
                  </Form>
                ))}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  );
}
function AccountChoice({
  name,
  label,
  value,
  options,
}: {
  name: string;
  label: string;
  value: string | null;
  options?: { id: string; name: string }[];
}) {
  return (
    <label>
      {label}{" "}
      <select name={name} defaultValue={value || ""}>
        <option value="">Choose after connecting</option>
        {value && !options?.some((o) => o.id === value) && (
          <option value={value}>{value} — verify selection</option>
        )}
        {options?.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name} ({option.id})
          </option>
        ))}
      </select>
    </label>
  );
}
