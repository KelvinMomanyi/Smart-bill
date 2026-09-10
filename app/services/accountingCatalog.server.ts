import { listQuickBooksEntity, quickBooksRequest } from "../utils/quickbook";
import { xeroRequest } from "../utils/xero";
import {
  accountingCompanyKey,
  getAccountingConnection,
  type LivePlatform,
} from "./accountingConnection.server";
import type { AccountingCatalog } from "../utils/accountingValidation";

export async function fetchAccountingCatalog(
  connection: Awaited<ReturnType<typeof getAccountingConnection>>,
): Promise<AccountingCatalog> {
  if (connection.platform === "XERO") {
    const [accounts, taxes, organisations, currencies] = await Promise.all([
      xeroRequest(connection, "/Accounts"),
      xeroRequest(connection, "/TaxRates"),
      xeroRequest(connection, "/Organisation"),
      xeroRequest(connection, "/Currencies"),
    ]);
    const org = organisations.Organisations?.[0];
    if (!org?.BaseCurrency)
      throw new Error("Xero did not return the organisation currency.");
    return {
      platform: "XERO",
      companyKey: accountingCompanyKey(connection),
      companyName: org.Name,
      country: org.CountryCode || "",
      homeCurrency: org.BaseCurrency,
      multiCurrency: true,
      currencies: (currencies.Currencies || []).map((c: any) => c.Code),
      accounts: (accounts.Accounts || [])
        .filter(
          (a: any) =>
            a.Status === "ACTIVE" &&
            a.Code &&
            a.Type !== "BANK" &&
            ["ASSET", "EXPENSE"].includes(a.Class),
        )
        .map((a: any) => ({
          id: a.Code,
          name: a.Name,
          type: a.Class,
          currency: a.CurrencyCode || null,
        })),
      taxes: (taxes.TaxRates || [])
        .filter(
          (t: any) =>
            t.Status === "ACTIVE" &&
            (t.CanApplyToExpenses || t.CanApplyToAssets),
        )
        .map((t: any) => ({
          id: t.TaxType,
          name: t.Name,
          rate: Number(t.EffectiveRate),
          expense: t.CanApplyToExpenses,
          asset: t.CanApplyToAssets,
          components: [],
          supported:
            Number.isFinite(Number(t.EffectiveRate)) &&
            Number(t.EffectiveRate) >= 0,
        })),
    };
  }
  const [info, preferences, accounts, taxCodes, taxRates] = await Promise.all([
    quickBooksRequest(connection, `/companyinfo/${connection.realmId}`),
    quickBooksRequest(connection, "/preferences"),
    listQuickBooksEntity(connection, "Account"),
    listQuickBooksEntity(connection, "TaxCode"),
    listQuickBooksEntity(connection, "TaxRate"),
  ]);
  const prefs = preferences.Preferences;
  const country = info.CompanyInfo?.Country || "";
  const homeCurrency = prefs?.CurrencyPrefs?.HomeCurrency?.value;
  if (!homeCurrency || !country)
    throw new Error(
      "QuickBooks did not return its country and home currency. Check company settings.",
    );
  return {
    platform: "QUICKBOOKS",
    companyKey: accountingCompanyKey(connection),
    companyName: info.CompanyInfo.CompanyName,
    country,
    homeCurrency,
    multiCurrency: prefs.CurrencyPrefs?.MultiCurrencyEnabled === true,
    currencies: [],
    accounts: accounts
      .filter((a) =>
        [
          "Expense",
          "Other Expense",
          "Cost of Goods Sold",
          "Other Current Asset",
          "Fixed Asset",
          "Other Asset",
        ].includes(a.AccountType),
      )
      .map((a) => ({
        id: String(a.Id),
        name: a.FullyQualifiedName || a.Name,
        type:
          a.Classification?.toUpperCase() ||
          (a.AccountType.includes("Asset") ? "ASSET" : "EXPENSE"),
        currency: a.CurrencyRef?.value || null,
      })),
    taxes: taxCodes
      .map((code) => {
        const details = code.PurchaseTaxRateList?.TaxRateDetail || [];
        const components = details
          .map((detail: any) => {
            const rate = taxRates.find(
              (r) => String(r.Id) === String(detail.TaxRateRef?.value),
            );
            return {
              id: String(detail.TaxRateRef?.value || ""),
              rate: Number(rate?.RateValue),
              kind: detail.TaxTypeApplicable || "TaxOnAmount",
              order: Number(detail.TaxOrder || 0),
              taxOnOrder: Number(detail.TaxOnTaxOrder || 0),
            };
          })
          .sort((a: any, b: any) => a.order - b.order);
        const supported =
          (code.Taxable === false || components.length > 0) &&
          components.every(
            (c: any) =>
              c.id &&
              Number.isFinite(c.rate) &&
              c.rate >= 0 &&
              ["TaxOnAmount", "TaxOnAmountPlusTax", "TaxOnTax"].includes(
                c.kind,
              ),
          );
        return {
          id: String(code.Id),
          name: code.Name,
          rate: 0,
          expense: true,
          asset: true,
          components,
          supported,
        };
      })
      .filter((tax) => tax.supported),
  };
}
export async function getAccountingCatalog(
  shop: string,
  platform: LivePlatform,
) {
  return fetchAccountingCatalog(await getAccountingConnection(shop, platform));
}
