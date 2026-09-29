import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { PublicLegalPage } from "../components/PublicLegalPage";
import { getPublicLegalDetails } from "../utils/legal.server";

export const meta: MetaFunction = () => [
  { title: "Privacy Policy | SmartBill" },
  {
    name: "description",
    content:
      "How SmartBill collects, uses, shares, protects, and deletes merchant information.",
  },
];

export async function loader(_args: LoaderFunctionArgs) {
  return json(
    { details: getPublicLegalDetails() },
    { headers: { "Cache-Control": "public, max-age=300, s-maxage=3600" } },
  );
}

export default function PrivacyPage() {
  const { details } = useLoaderData<typeof loader>();

  return (
    <PublicLegalPage
      details={details}
      eyebrow="Privacy"
      title="Privacy Policy"
      summary="This policy describes the information SmartBill processes, why it is needed, and the choices available to merchants and their users."
    >
      <section>
        <h2>Scope and roles</h2>
        <p>
          This Privacy Policy applies to the SmartBill website, Shopify app,
          supplier-invoice workflows, and supported integrations operated by
          {` ${details.operatorName}`} (“SmartBill,” “we,” “us,” or “our”).
        </p>
        <p>
          For supplier invoices and operational data submitted by a Merchant,
          the Merchant generally determines the purpose of processing and
          SmartBill acts as its service provider or processor. SmartBill may act
          as controller for account administration, subscription, security,
          support, and legal-compliance information. Merchants are responsible
          for their own privacy notices and lawful use of supplier and staff
          data.
        </p>
      </section>

      <section>
        <h2>Information we collect</h2>
        <h3>Shopify and user information</h3>
        <p>
          We receive the store domain, installation and session information,
          granted permissions, subscription status, and available staff details
          such as name, email address, role, and account-owner status. SmartBill
          accesses product and inventory information required for product
          matching and approved inventory-cost updates. The app is not designed
          to collect Shopify customer or order records.
        </p>
        <h3>Invoice and business records</h3>
        <p>
          We process uploaded or emailed invoice images and PDFs; extracted
          text; supplier names and contact details; invoice identifiers and
          dates; products, SKUs, descriptions, quantities, prices, discounts,
          taxes, currencies, totals, payment terms, purchase orders, delivery
          receipts, credit notes, cost allocations, approvals, reports, and
          audit events.
        </p>
        <h3>Accounting integrations</h3>
        <p>
          If you connect QuickBooks or Xero, we process authorisation tokens,
          company identifiers and names, home currency and country, account and
          tax-code choices, supplier records needed for exports, export status,
          and identifiers of bills, credits, and attachments created through
          SmartBill. Accounting credentials are encrypted at rest.
        </p>
        <h3>Settings, communications, and technical data</h3>
        <p>
          We process app settings, notification email addresses or Slack webhook
          URLs you configure, inbound invoice email metadata and attachments,
          usage counts, support communications, request and error information,
          device or browser information supplied through standard web requests,
          and security logs needed to operate and protect the service.
        </p>
      </section>

      <section>
        <h2>How we use information</h2>
        <ul>
          <li>
            authenticate users and provide the features requested by the
            Merchant;
          </li>
          <li>
            store, read, extract, validate, match, display, and report
            supplier-invoice information;
          </li>
          <li>
            perform merchant-approved Shopify cost updates and accounting
            exports;
          </li>
          <li>
            deliver configured email or Slack notifications and process
            configured inbound invoice email;
          </li>
          <li>
            administer plans, trials, invoice allowances, and subscriptions;
          </li>
          <li>
            maintain audit trails, prevent duplicate processing, troubleshoot
            failures, secure the service, and prevent misuse;
          </li>
          <li>
            respond to support, privacy, legal, and regulatory requests; and
          </li>
          <li>
            improve reliability and functionality using aggregated or
            de-identified operational information where appropriate.
          </li>
        </ul>
        <p>
          We do not sell Merchant data or use QuickBooks, Xero, Shopify, or
          supplier-document data for third-party advertising.
        </p>
      </section>

      <section>
        <h2>When information is shared</h2>
        <p>
          We disclose information only as needed to operate the service, follow
          Merchant instructions, complete a transaction, protect rights and
          security, comply with law, or support a corporate transaction subject
          to appropriate safeguards. Depending on the features configured or
          selected, recipients may include:
        </p>
        <ul>
          <li>
            <strong>Shopify</strong>, for installation, authentication, app
            billing, product and inventory workflows, and compliance requests;
          </li>
          <li>
            <strong>Intuit QuickBooks and Xero</strong>, when the Merchant
            connects an accounting company and requests reads, bill or credit
            creation, attachment upload, or disconnection;
          </li>
          <li>
            <strong>
              hosting, database, and private document-storage providers
            </strong>
            , including Vercel and Supabase in the current deployment;
          </li>
          <li>
            <strong>OCR providers</strong>, such as Google Cloud Vision when
            server OCR is configured; browser OCR may instead run locally in the
            user’s browser;
          </li>
          <li>
            <strong>communication providers</strong>, such as SendGrid, a
            configured inbound-email provider, or Slack when those features are
            enabled;
          </li>
          <li>
            <strong>exchange-rate providers</strong> when automated historical
            rates are requested; and
          </li>
          <li>
            professional advisers, authorities, or transaction counterparties
            where reasonably necessary and legally permitted.
          </li>
        </ul>
        <p>
          Service providers may process information only for contracted services
          and under their own security and confidentiality obligations. Your use
          of a connected platform is also governed by that platform’s terms and
          privacy notice.
        </p>
      </section>

      <section>
        <h2>Cookies and authentication</h2>
        <p>
          SmartBill uses cookies and similar request data that are necessary for
          Shopify authentication, session continuity, OAuth security, and core
          app functionality. We do not operate third-party behavioural
          advertising cookies through these legal pages. Your browser may allow
          you to block cookies, but required authentication features may then
          stop working.
        </p>
      </section>

      <section>
        <h2>Retention and deletion</h2>
        <p>
          We retain Merchant information while the installation or account is
          active and as needed to provide the service, preserve financial audit
          history, resolve disputes, enforce agreements, maintain security, and
          meet legal obligations. Retention may differ by record type and the
          Merchant’s instructions.
        </p>
        <p>
          When Shopify sends its verified shop-redaction request after an
          uninstall, SmartBill cancels queued jobs and deletes that shop’s
          stored invoice documents, sessions, connections, settings, invoice and
          operational records from the active application database and document
          store. Residual copies may remain temporarily in protected backups
          until their normal rotation. Records already exported to Shopify,
          QuickBooks, Xero, email, or Slack remain under the Merchant’s control
          in those services and are not deleted automatically by SmartBill.
        </p>
        <p>
          Disconnecting QuickBooks or Xero attempts to revoke remote access and
          removes the active connection credentials from SmartBill. Historical
          SmartBill export and audit records may remain until the shop is
          redacted or deletion is otherwise required.
        </p>
      </section>

      <section>
        <h2>Security</h2>
        <p>
          We use safeguards appropriate to the nature of the information,
          including HTTPS transport, Shopify authentication, role-based access,
          private document storage, encrypted accounting credentials, scoped
          provider permissions, signed webhook verification, and audit records.
          No internet service is completely secure, so we cannot guarantee
          absolute security. Merchants must also protect their accounts and
          promptly report suspected unauthorised access.
        </p>
      </section>

      <section>
        <h2>International processing</h2>
        <p>
          SmartBill and its providers may process information in countries other
          than the country where the Merchant or user is located. Those
          countries may have different privacy laws. Where required, we use
          contractual or other lawful safeguards for international transfers.
        </p>
      </section>

      <section>
        <h2>Your choices and rights</h2>
        <p>
          Merchant administrators can review and correct invoice records and
          settings in SmartBill, manage staff access, disconnect accounting
          services, disable notifications, and uninstall the app. Depending on
          applicable law, an individual may request access, correction,
          deletion, restriction, portability, or objection and may complain to a
          competent data-protection authority.
        </p>
        <p>
          If your information was submitted by a Merchant, contact that Merchant
          first because it controls the business record. We will assist the
          Merchant with valid requests as required. We may verify identity and
          authority before completing a request.
        </p>
      </section>

      <section>
        <h2>Children</h2>
        <p>
          SmartBill is a business service and is not directed to children. We do
          not knowingly collect personal information from children through the
          service. Contact us if you believe a child’s information has been
          submitted improperly.
        </p>
      </section>

      <section>
        <h2>Policy changes</h2>
        <p>
          We may update this Privacy Policy when the service, providers, or
          legal requirements change. The effective date above identifies the
          current version. We will provide additional notice of material changes
          where required by law or an applicable platform.
        </p>
      </section>
    </PublicLegalPage>
  );
}
