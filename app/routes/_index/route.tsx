import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";

import { login } from "../../shopify.server";
import { PLANS, TRIAL_DAYS } from "../../utils/plans";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>SmartBill supplier invoice control</h1>
        <p className={styles.text}>
          Capture vendor invoices, reconcile purchase orders, update Shopify
          COGS, and prepare accounting exports.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
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
      </div>
    </div>
  );
}
