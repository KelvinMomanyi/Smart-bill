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
import {
  accountingBaseUrl,
  createAuthorization,
} from "../services/accountingAuthorization.server";
import {
  disconnectAccounting,
  livePlatform,
} from "../services/accountingConnection.server";
import { getAccountingCatalog } from "../services/accountingCatalog.server";
import { quickBooksEnvironment } from "../utils/quickbook";
import { isUsCompany } from "../utils/accountingValidation";
import {
  deleteUomMapping,
  saveUomMapping,
} from "../services/uomMapping.server";
import {
  notifyOn,
} from "../services/notifications.server";
import {
  NOTIFICATION_TYPES,
  validateNotificationTarget,
} from "../utils/notifications";
import { ensureDefaultApprovalRules } from "../services/approvalRules.server";
import {
  normalizeStaffRole,
  STAFF_ROLES,
} from "../utils/approvalRules";
export async function loader({ request }: LoaderFunctionArgs) {
  const { session, admin } = await requireAdmin(request);
  await ensureDefaultApprovalRules(session.shop);
  const [
    settings,
    subscription,
    used,
    connections,
    staff,
    vendors,
    uomMappings,
    notificationPreferences,
    notificationLogs,
    approvalRules,
  ] = await Promise.all([
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
    prisma.vendor.findMany({
      where: { shop: session.shop },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 500,
    }),
    prisma.uoMMapping.findMany({
      where: { shop: session.shop },
      include: { supplier: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 500,
    }),
    prisma.notificationPreference.findMany({
      where: { shop: session.shop },
      orderBy: { channel: "asc" },
    }),
    prisma.notificationLog.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    prisma.approvalRule.findMany({
      where: { shop: session.shop },
      orderBy: [{ active: "desc" }, { createdAt: "asc" }],
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
    accountingCallbacks: {
      XERO: `${accountingBaseUrl()}/accounting/xero/callback`,
      QUICKBOOKS: `${accountingBaseUrl()}/accounting/quickbooks/callback`,
    },
    staff,
    vendors,
    uomMappings,
    notificationPreferences,
    notificationLogs,
    approvalRules,
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
        fxRateSourcePreference: [
          "OPENEXCHANGERATES",
          "XERO_API",
          "ECB",
          "MANUAL",
        ].includes(String(form.get("fxRateSourcePreference")))
          ? String(form.get("fxRateSourcePreference"))
          : "OPENEXCHANGERATES",
        fxRevaluationFrequency: [
          "MONTHLY",
          "QUARTERLY",
          "ANNUALLY",
          "MANUAL",
        ].includes(String(form.get("fxRevaluationFrequency")))
          ? String(form.get("fxRevaluationFrequency"))
          : "MANUAL",
        fxGainAccount: String(form.get("fxGainAccount") || "").trim() || null,
        fxLossAccount: String(form.get("fxLossAccount") || "").trim() || null,
        fxRateRounding: [2, 4, 6].includes(Number(form.get("fxRateRounding")))
          ? Number(form.get("fxRateRounding"))
          : 6,
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
    } else if (intent === "save-uom-mapping") {
      await saveUomMapping(request, {
        supplierId: String(form.get("supplierId") || ""),
        itemKey: String(form.get("itemKey") || ""),
        supplierUoM: String(form.get("supplierUoM") || ""),
        stockUoM: String(form.get("stockUoM") || "unit"),
        conversionFactor: Number(form.get("conversionFactor")),
      });
    } else if (intent === "delete-uom-mapping") {
      await deleteUomMapping(request, String(form.get("mappingId") || ""));
    } else if (intent === "save-notification") {
      await requireSubscription(request);
      const channel = String(form.get("channel") || "").toUpperCase();
      const target = String(form.get("target") || "").trim();
      validateNotificationTarget(channel, target);
      const notificationTypes = form
        .getAll("notificationType")
        .map(String)
        .filter((type) =>
          NOTIFICATION_TYPES.includes(type as (typeof NOTIFICATION_TYPES)[number]),
        );
      if (!notificationTypes.length)
        throw new Error("Choose at least one notification type.");
      await prisma.notificationPreference.upsert({
        where: { shop_channel: { shop: session.shop, channel } },
        create: {
          shop: session.shop,
          channel,
          emailAddress: channel === "EMAIL" ? target : null,
          webhookUrl: channel === "SLACK" ? target : null,
          enabled: form.get("enabled") === "yes",
          frequency: form.get("frequency") === "DAILY" ? "DAILY" : "IMMEDIATE",
          notificationTypes,
        },
        update: {
          emailAddress: channel === "EMAIL" ? target : null,
          webhookUrl: channel === "SLACK" ? target : null,
          enabled: form.get("enabled") === "yes",
          frequency: form.get("frequency") === "DAILY" ? "DAILY" : "IMMEDIATE",
          notificationTypes,
        },
      });
    } else if (intent === "test-notification") {
      await requireSubscription(request);
      const channel = String(form.get("channel") || "").toUpperCase();
      const results = await notifyOn(
        "APPROVAL_REQUIRED",
        session.shop,
        { message: "This is a SmartBill test notification", actionPath: "/app/settings" },
        { channel, includeDaily: true },
      );
      if (!results.some((result) => result.sent))
        throw new Error(results[0]?.error || "No enabled preference is configured for this channel.");
    } else if (intent === "save-approval-rule") {
      await requireSubscription(request);
      const name = String(form.get("name") || "").trim();
      if (name.length < 3 || name.startsWith("Default:"))
        throw new Error("Enter a rule name of at least three characters.");
      const minText = String(form.get("invoiceAmountMin") || "").trim();
      const maxText = String(form.get("invoiceAmountMax") || "").trim();
      const invoiceAmountMin = minText ? Number(minText) : null;
      const invoiceAmountMax = maxText ? Number(maxText) : null;
      if (
        (invoiceAmountMin != null && (!Number.isFinite(invoiceAmountMin) || invoiceAmountMin < 0)) ||
        (invoiceAmountMax != null && (!Number.isFinite(invoiceAmountMax) || invoiceAmountMax < 0)) ||
        (invoiceAmountMin != null && invoiceAmountMax != null && invoiceAmountMin > invoiceAmountMax)
      )
        throw new Error("Enter a valid approval amount range.");
      const requiredApprovers = Number(form.get("requiredApprovers"));
      const escalateIfUnresolvedDays = Number(form.get("escalateIfUnresolvedDays"));
      if (!Number.isInteger(requiredApprovers) || requiredApprovers < 1 || requiredApprovers > 5)
        throw new Error("Required approvers must be between 1 and 5.");
      if (!Number.isInteger(escalateIfUnresolvedDays) || escalateIfUnresolvedDays < 1 || escalateIfUnresolvedDays > 30)
        throw new Error("Escalation must be between 1 and 30 days.");
      const approverRoles = form
        .getAll("approverRole")
        .map(normalizeStaffRole)
        .filter((role, index, roles) => roles.indexOf(role) === index);
      if (!approverRoles.length) throw new Error("Choose at least one approver role.");
      const supplierId = String(form.get("supplierId") || "") || null;
      if (
        supplierId &&
        !(await prisma.vendor.findFirst({
          where: { id: supplierId, shop: session.shop },
          select: { id: true },
        }))
      )
        throw new Error("Choose a supplier from this store.");
      await prisma.approvalRule.upsert({
        where: { shop_name: { shop: session.shop, name } },
        create: {
          shop: session.shop,
          name,
          invoiceAmountMin,
          invoiceAmountMax,
          supplierId,
          requiredApprovers,
          approverRoles,
          escalateIfUnresolvedDays,
        },
        update: {
          invoiceAmountMin,
          invoiceAmountMax,
          supplierId,
          requiredApprovers,
          approverRoles,
          escalateIfUnresolvedDays,
          active: true,
        },
      });
    } else if (intent === "delete-approval-rule") {
      const rule = await prisma.approvalRule.findFirst({
        where: { id: String(form.get("ruleId") || ""), shop: session.shop },
      });
      if (!rule || rule.name.startsWith("Default:"))
        throw new Error("Default safeguards cannot be deleted.");
      await prisma.approvalRule.update({
        where: { id: rule.id },
        data: { active: false },
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
        data: { role: normalizeStaffRole(form.get("role")) },
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
    accountingCallbacks,
    quickBooksEnvironment,
    owner,
    staff,
    vendors,
    uomMappings,
    notificationPreferences,
    notificationLogs,
    approvalRules,
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
                Preferred FX rate source{" "}
                <select
                  name="fxRateSourcePreference"
                  defaultValue={settings.fxRateSourcePreference}
                >
                  <option value="OPENEXCHANGERATES">
                    Open Exchange Rates, then manual
                  </option>
                  <option value="XERO_API">Xero, then manual</option>
                  <option value="ECB">ECB, then manual</option>
                  <option value="MANUAL">Manual only</option>
                </select>
              </label>
              <label>
                FX revaluation frequency{" "}
                <select
                  name="fxRevaluationFrequency"
                  defaultValue={settings.fxRevaluationFrequency}
                >
                  <option value="MONTHLY">Monthly</option>
                  <option value="QUARTERLY">Quarterly</option>
                  <option value="ANNUALLY">Annually</option>
                  <option value="MANUAL">Manual only</option>
                </select>
              </label>
              <label>
                FX gain account{" "}
                <input
                  name="fxGainAccount"
                  defaultValue={settings.fxGainAccount || ""}
                />
              </label>
              <label>
                FX loss account{" "}
                <input
                  name="fxLossAccount"
                  defaultValue={settings.fxLossAccount || ""}
                />
              </label>
              <label>
                FX rate decimal places{" "}
                <select
                  name="fxRateRounding"
                  defaultValue={settings.fxRateRounding}
                >
                  <option value="2">2</option>
                  <option value="4">4</option>
                  <option value="6">6</option>
                </select>
              </label>
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
              Unit-of-measure mappings
            </Text>
            <Text as="p" tone="subdued">
              Store multiple supplier/SKU conversions, such as one case of a
              specific SKU equalling 24 stock units.
            </Text>
            <Form method="post">
              <input type="hidden" name="intent" value="save-uom-mapping" />
              <InlineStack gap="300" wrap>
                <label>
                  Supplier{" "}
                  <select name="supplierId" required>
                    <option value="">Choose supplier</option>
                    {vendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  SKU or item key <input name="itemKey" required />
                </label>
                <label>
                  Supplier unit{" "}
                  <input name="supplierUoM" placeholder="case" required />
                </label>
                <label>
                  Stock unit{" "}
                  <input name="stockUoM" defaultValue="unit" required />
                </label>
                <label>
                  Stock units per supplier unit{" "}
                  <input
                    name="conversionFactor"
                    type="number"
                    min="0.0001"
                    step="any"
                    required
                  />
                </label>
              </InlineStack>
              <Button submit loading={busy}>
                Save UoM mapping
              </Button>
            </Form>
            {uomMappings.map((mapping) => (
              <InlineStack key={mapping.id} gap="300" blockAlign="center">
                <Text as="p">
                  {mapping.supplier.name} · {mapping.itemKey}: 1{" "}
                  {mapping.supplierUoM} = {mapping.conversionFactor}{" "}
                  {mapping.stockUoM} ({mapping.confidence.toLowerCase()})
                </Text>
                <Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="delete-uom-mapping"
                  />
                  <input type="hidden" name="mappingId" value={mapping.id} />
                  <Button submit tone="critical" loading={busy}>
                    Delete
                  </Button>
                </Form>
              </InlineStack>
            ))}
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Notifications
            </Text>
            <Text as="p" tone="subdued">
              Delivery failures are retried three times and retained in the
              notification log. Slack uses an incoming webhook.
            </Text>
            {(["EMAIL", "SLACK"] as const).map((channel) => {
              const preference = notificationPreferences.find(
                (entry) => entry.channel === channel,
              );
              const selected = Array.isArray(preference?.notificationTypes)
                ? preference.notificationTypes.map(String)
                : [...NOTIFICATION_TYPES];
              return (
                <Form method="post" key={channel}>
                  <input type="hidden" name="channel" value={channel} />
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">
                      {channel === "EMAIL" ? "Email" : "Slack"}
                    </Text>
                    <label>
                      {channel === "EMAIL" ? "Email address" : "Incoming webhook URL"}{" "}
                      <input
                        name="target"
                        type={channel === "EMAIL" ? "email" : "url"}
                        defaultValue={
                          channel === "EMAIL"
                            ? preference?.emailAddress || ""
                            : preference?.webhookUrl || ""
                        }
                        required
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        name="enabled"
                        value="yes"
                        defaultChecked={preference?.enabled ?? true}
                      />{" "}
                      Enabled
                    </label>
                    <label>
                      Frequency{" "}
                      <select
                        name="frequency"
                        defaultValue={preference?.frequency || "IMMEDIATE"}
                      >
                        <option value="IMMEDIATE">Immediate</option>
                        <option value="DAILY">Daily digest</option>
                      </select>
                    </label>
                    <InlineStack gap="200" wrap>
                      {NOTIFICATION_TYPES.map((type) => (
                        <label key={type}>
                          <input
                            type="checkbox"
                            name="notificationType"
                            value={type}
                            defaultChecked={selected.includes(type)}
                          />{" "}
                          {type.toLowerCase().replaceAll("_", " ")}
                        </label>
                      ))}
                    </InlineStack>
                    <InlineStack gap="200">
                      <button
                        type="submit"
                        name="intent"
                        value="save-notification"
                        disabled={busy}
                      >
                        Save {channel.toLowerCase()}
                      </button>
                      {preference && (
                        <button
                          type="submit"
                          name="intent"
                          value="test-notification"
                          disabled={busy}
                        >
                          Send test
                        </button>
                      )}
                    </InlineStack>
                  </BlockStack>
                </Form>
              );
            })}
            {notificationLogs.length > 0 && (
              <BlockStack gap="100">
                <Text as="h3" variant="headingSm">
                  Recent delivery log
                </Text>
                {notificationLogs.map((log) => (
                  <Text as="p" key={log.id} tone="subdued">
                    {log.type} to {log.target}: {log.status}
                    {log.error ? ` — ${log.error}` : ""}
                  </Text>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Approval rules
            </Text>
            <Text as="p" tone="subdued">
              Custom matching rules replace the default amount rule. PO
              mismatches always retain the separate administrator safeguard.
            </Text>
            <Form method="post">
              <input type="hidden" name="intent" value="save-approval-rule" />
              <InlineStack gap="300" wrap>
                <label>
                  Rule name <input name="name" required minLength={3} />
                </label>
                <label>
                  Minimum amount{" "}
                  <input name="invoiceAmountMin" type="number" min="0" step="0.01" />
                </label>
                <label>
                  Maximum amount{" "}
                  <input name="invoiceAmountMax" type="number" min="0" step="0.01" />
                </label>
                <label>
                  Supplier{" "}
                  <select name="supplierId">
                    <option value="">All suppliers</option>
                    {vendors.map((vendor) => (
                      <option key={vendor.id} value={vendor.id}>
                        {vendor.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Required approvers{" "}
                  <input
                    name="requiredApprovers"
                    type="number"
                    min="1"
                    max="5"
                    defaultValue="1"
                    required
                  />
                </label>
                <label>
                  Escalate after days{" "}
                  <input
                    name="escalateIfUnresolvedDays"
                    type="number"
                    min="1"
                    max="30"
                    defaultValue="3"
                    required
                  />
                </label>
              </InlineStack>
              <InlineStack gap="200" wrap>
                {STAFF_ROLES.map((staffRole) => (
                  <label key={staffRole}>
                    <input
                      type="checkbox"
                      name="approverRole"
                      value={staffRole}
                      defaultChecked={staffRole === "APPROVER"}
                    />{" "}
                    {staffRole}
                  </label>
                ))}
              </InlineStack>
              <Button submit loading={busy}>
                Save approval rule
              </Button>
            </Form>
            {approvalRules.map((rule) => (
              <InlineStack key={rule.id} gap="300" blockAlign="center">
                <Text as="p">
                  {rule.name}: {rule.invoiceAmountMin ?? "0"}–
                  {rule.invoiceAmountMax ?? "no limit"}; {rule.requiredApprovers}{" "}
                  approver{rule.requiredApprovers === 1 ? "" : "s"} ({
                    Array.isArray(rule.approverRoles)
                      ? rule.approverRoles.join(", ")
                      : "unassigned"
                  })
                </Text>
                {!rule.name.startsWith("Default:") && (
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="delete-approval-rule"
                    />
                    <input type="hidden" name="ruleId" value={rule.id} />
                    <Button submit tone="critical" loading={busy}>
                      Deactivate
                    </Button>
                  </Form>
                )}
              </InlineStack>
            ))}
          </BlockStack>
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
                    <Text as="p" tone="subdued">
                      Registered callback: {accountingCallbacks[platform]}
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
                        <option value="SCANNER">Scanner (low-value approval)</option>
                        <option value="APPROVER">Approver</option>
                        <option value="FINANCE">Finance</option>
                        <option value="ADMIN">Administrator</option>
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
