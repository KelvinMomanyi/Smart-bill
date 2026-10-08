import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Link, useLoaderData } from "@remix-run/react";

import { IntuitTrademarkNotice } from "../../components/IntuitTrademarkNotice";
import { SmartBillBrand } from "../../components/SmartBillBrand";
import { PLANS, TRIAL_DAYS } from "../../utils/plans";
import { shopifyAppListingUrl } from "../../utils/shopifyNavigation";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return {
    listingUrl: shopifyAppListingUrl(process.env.SHOPIFY_APP_LISTING_URL),
  };
};

export default function App() {
  const { listingUrl } = useLoaderData<typeof loader>();
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <div>
          <SmartBillBrand size={80} showName={false} />
        </div>
        <h1 className={styles.heading}>SmartBill supplier invoice control</h1>
        <p className={styles.text}>
          Capture vendor invoices, reconcile purchase orders, update Shopify
          COGS, and prepare accounting exports.
        </p>
        <div className={styles.launch}>
          {listingUrl ? (
            <>
              <a className={styles.button} href={listingUrl} target="_top">
                Install SmartBill on Shopify
              </a>
              <p>
                Shopify will guide you through choosing a store and installing
                SmartBill.
              </p>
            </>
          ) : (
            <p>
              For a test installation, use the SmartBill installation link
              provided by Shopify.
            </p>
          )}
          <p>
            Already installed? Open SmartBill from Apps in the Shopify store
            where you installed it.
          </p>
        </div>
        <ul className={styles.list}>
          <li>
            <strong>Invoice OCR</strong>. Turn supplier invoice images into
            structured vendor, total, tax, and line-item records.
          </li>
          <li>
            <strong>PO matching</strong>. Catch quantity, price, and
            unexpected-item differences before they hit your books.
          </li>
          <li>
            <strong>Shopify cost sync</strong>. Push approved supplier costs
            into product inventory records for cleaner margin reporting.
          </li>
        </ul>
        <h2>Simple plans for growing stores</h2>
        <ul className={styles.list}>
          {Object.values(PLANS).map((plan) => (
            <li key={plan.name}>
              <strong>
                {plan.label}: {"$"}
                {plan.price} USD every 30 days
              </strong>
              <p>{plan.description}</p>
            </li>
          ))}
        </ul>
        <p>
          {TRIAL_DAYS}-day trial. No automatic overage charges. Invoice
          allowances reset each calendar month, UTC.
        </p>
        <footer className={styles.footer}>
          <div className={styles.footerLinks}>
            <Link to="/terms">End-User Licence Agreement</Link>
            <Link to="/privacy">Privacy Policy</Link>
          </div>
          <IntuitTrademarkNotice className={styles.trademarkNotice} />
        </footer>
      </div>
    </div>
  );
}
