import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

import { PublicLegalPage } from "../components/PublicLegalPage";
import { getPublicLegalDetails } from "../utils/legal.server";

export const meta: MetaFunction = () => [
  { title: "End-User Licence Agreement | SmartBill" },
  {
    name: "description",
    content:
      "The terms governing access to and use of the SmartBill supplier invoice application.",
  },
];

export async function loader(_args: LoaderFunctionArgs) {
  return json(
    { details: getPublicLegalDetails() },
    { headers: { "Cache-Control": "public, max-age=300, s-maxage=3600" } },
  );
}

export default function TermsPage() {
  const { details } = useLoaderData<typeof loader>();

  return (
    <PublicLegalPage
      details={details}
      eyebrow="Legal"
      title="End-User Licence Agreement"
      summary="These terms explain the licence and conditions that apply when a merchant installs or uses SmartBill."
    >
      <section>
        <h2>Agreement and eligibility</h2>
        <p>
          This End-User Licence Agreement (the <strong>Agreement</strong>) is
          between {details.operatorName} (<strong>SmartBill</strong>, “we,”
          “us,” or “our”) and the business or organisation that installs,
          subscribes to, accesses, or uses the SmartBill application (the
          <strong> Merchant</strong>, “you,” or “your”).
        </p>
        <p>
          By installing or using SmartBill, you accept this Agreement for the
          Merchant and confirm that you have authority to bind it. You must be
          legally capable of entering a contract and operate a valid Shopify
          store. If you do not agree, do not install or use SmartBill.
        </p>
      </section>

      <section>
        <h2>The service</h2>
        <p>
          SmartBill helps merchants capture supplier invoices, extract and
          review invoice data, reconcile purchase orders and receipts, manage
          landed costs and credit notes, update supported Shopify inventory
          costs, prepare reports, and export approved transactions to supported
          accounting services.
        </p>
        <p>
          SmartBill is a workflow and record-processing tool. It is not an
          accounting firm, tax adviser, auditor, bank, or legal adviser. OCR,
          matching, tax, currency, cost-allocation, and reporting results may
          contain errors. You are responsible for reviewing source documents,
          approvals, tax treatment, exchange rates, account mappings, and every
          financial entry before relying on or exporting it.
        </p>
      </section>

      <section>
        <h2>Licence and restrictions</h2>
        <p>
          Subject to this Agreement and payment of applicable fees, SmartBill
          grants the Merchant a limited, non-exclusive, non-transferable,
          revocable licence to access and use the service for its internal
          business operations during the subscription term.
        </p>
        <p>You must not, and must not allow anyone to:</p>
        <ul>
          <li>
            use SmartBill unlawfully, fraudulently, or to process content you
            have no right to use;
          </li>
          <li>
            circumvent access controls, usage limits, billing, or security
            measures;
          </li>
          <li>
            probe, disrupt, overload, or introduce malicious code into the
            service;
          </li>
          <li>
            copy, resell, sublicense, reverse engineer, or create a competing
            service from SmartBill except where applicable law expressly permits
            it; or
          </li>
          <li>
            use automated access other than documented integrations or workflows
            we expressly support.
          </li>
        </ul>
      </section>

      <section>
        <h2>Your accounts, users, and data</h2>
        <p>
          You are responsible for your Shopify account, authorised staff,
          connected accounting companies, credentials, devices, and all activity
          performed through them. Keep access secure and remove staff access
          promptly when it is no longer required.
        </p>
        <p>
          You retain ownership of supplier documents and other business data you
          submit. You grant SmartBill permission to host, copy, transform,
          analyse, transmit, and display that data only as needed to provide,
          secure, support, and improve the service and comply with law. You
          confirm that you have the rights and lawful basis required to provide
          that data to SmartBill and selected integrations.
        </p>
      </section>

      <section>
        <h2>Subscriptions, trials, and payment</h2>
        <p>
          Available plans, features, limits, trial periods, prices, currencies,
          and billing intervals are shown before subscription approval in
          Shopify and may also appear on the SmartBill website. Charges are
          processed through Shopify and are subject to Shopify’s billing terms.
          Taxes may be added where required.
        </p>
        <p>
          A subscription continues for successive billing periods until
          cancelled through the available Shopify controls or the app is
          uninstalled. Except where mandatory law or the applicable Shopify
          billing process requires otherwise, paid fees are not refundable for a
          partially used billing period. We may change future pricing or plan
          features with notice and any consent required by Shopify or law.
        </p>
      </section>

      <section>
        <h2>Third-party services</h2>
        <p>
          SmartBill interoperates with services such as Shopify, QuickBooks,
          Xero, document storage and OCR providers, notification providers, and
          exchange-rate services. Those services are operated under their own
          terms and privacy notices. You choose which optional integrations to
          enable and authorise SmartBill to exchange the information needed for
          that integration.
        </p>
        <p>
          We do not control third-party availability, data, API changes, or
          decisions. Disconnecting an integration stops future authorised API
          access after revocation is completed, but does not automatically
          remove bills, attachments, or other records already created in that
          third-party service.
        </p>
      </section>

      <section>
        <h2>Availability and changes</h2>
        <p>
          We aim to operate SmartBill reliably but do not guarantee
          uninterrupted, error-free, or permanently available service.
          Maintenance, security events, provider outages, network conditions, or
          legal requirements may affect access. Features may change as the
          service, APIs, and legal requirements evolve. We will provide
          reasonable notice of material changes when practicable.
        </p>
      </section>

      <section>
        <h2>Intellectual property and feedback</h2>
        <p>
          SmartBill and its software, design, documentation, branding, and
          related intellectual property belong to the SmartBill operator or its
          licensors. No ownership transfers under this Agreement. If you submit
          feedback, you permit us to use it without restriction or compensation,
          provided we do not identify you publicly without permission.
        </p>
      </section>

      <section>
        <h2>Suspension and termination</h2>
        <p>
          You may stop using SmartBill, cancel the subscription, and uninstall
          the app at any time. We may suspend or terminate access if you
          materially breach this Agreement, fail to pay applicable fees, create
          a security or legal risk, or misuse the service. Where reasonable, we
          will give notice and an opportunity to cure the issue.
        </p>
        <p>
          On termination, the licence ends. Provisions that by their nature
          should survive—including ownership, payment obligations, disclaimers,
          liability limits, and dispute terms—remain effective. Data handling
          after uninstall or termination is described in the Privacy Policy.
        </p>
      </section>

      <section>
        <h2>Disclaimers</h2>
        <p>
          To the maximum extent permitted by law, SmartBill is provided “as is”
          and “as available.” We disclaim implied warranties of merchantability,
          fitness for a particular purpose, non-infringement, accuracy, and
          uninterrupted availability. Nothing in this Agreement excludes a
          warranty or consumer right that cannot lawfully be excluded.
        </p>
      </section>

      <section>
        <h2>Limitation of liability</h2>
        <p>
          To the maximum extent permitted by law, neither party is liable for
          indirect, incidental, special, exemplary, or consequential loss, or
          loss of profits, revenue, goodwill, or data. SmartBill’s total
          aggregate liability arising from the service or this Agreement will
          not exceed the fees the Merchant paid for SmartBill during the twelve
          months immediately preceding the event giving rise to the claim.
        </p>
        <p>
          These limitations do not apply to fraud, wilful misconduct, death or
          personal injury caused by negligence, infringement or misuse of the
          other party’s intellectual property, payment obligations, or any
          liability that applicable law does not permit the parties to limit.
        </p>
      </section>

      <section>
        <h2>Governing terms and changes</h2>
        <p>
          {details.governingLaw
            ? `This Agreement is governed by ${details.governingLaw}, without regard to conflict-of-law principles. Courts with jurisdiction under those laws will hear disputes unless mandatory law requires otherwise.`
            : "The governing law and forum are those applicable to the SmartBill operator identified in the current app listing, unless mandatory law requires otherwise."}
        </p>
        <p>
          We may update this Agreement to reflect service, legal, or operational
          changes. We will revise the effective date and provide additional
          notice where required. Continued use after an updated Agreement takes
          effect constitutes acceptance to the extent permitted by law. If a
          material update is unacceptable, you must stop using the service.
        </p>
      </section>
    </PublicLegalPage>
  );
}
