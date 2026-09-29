import { Link } from "@remix-run/react";
import type { ReactNode } from "react";

import type { PublicLegalDetails } from "../utils/legal.server";
import styles from "../styles/legal.module.css";
import { IntuitTrademarkNotice } from "./IntuitTrademarkNotice";

type PublicLegalPageProps = {
  children: ReactNode;
  details: PublicLegalDetails;
  eyebrow: string;
  summary: string;
  title: string;
};

export function PublicLegalPage({
  children,
  details,
  eyebrow,
  summary,
  title,
}: PublicLegalPageProps) {
  return (
    <div className={styles.page}>
      <header className={styles.siteHeader}>
        <Link className={styles.brand} to="/" aria-label="SmartBill home">
          <span className={styles.brandMark} aria-hidden="true">
            S
          </span>
          <span>SmartBill</span>
        </Link>
        <nav className={styles.navigation} aria-label="Legal pages">
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
        </nav>
      </header>

      <main className={styles.document}>
        <header className={styles.documentHeader}>
          <p className={styles.eyebrow}>{eyebrow}</p>
          <h1>{title}</h1>
          <p className={styles.summary}>{summary}</p>
          <p className={styles.effectiveDate}>
            Effective date: <time>{details.effectiveDate}</time>
          </p>
        </header>

        <article className={styles.content}>{children}</article>

        <aside className={styles.contactCard} aria-labelledby="legal-contact">
          <div>
            <p className={styles.eyebrow}>Questions or requests</p>
            <h2 id="legal-contact">Contact SmartBill</h2>
          </div>
          <div className={styles.contactDetails}>
            <strong>{details.operatorName}</strong>
            {details.postalAddress && <span>{details.postalAddress}</span>}
            {details.supportEmail ? (
              <a href={`mailto:${details.supportEmail}`}>
                {details.supportEmail}
              </a>
            ) : (
              <span>
                Use the support contact shown in the SmartBill app listing or
                your existing merchant support channel.
              </span>
            )}
          </div>
        </aside>
      </main>

      <footer className={styles.footer}>
        <span>
          &copy; {new Date().getUTCFullYear()} {details.operatorName}
        </span>
        <span>Supplier invoice control for Shopify merchants</span>
        <IntuitTrademarkNotice className={styles.trademarkNotice} />
      </footer>
    </div>
  );
}
