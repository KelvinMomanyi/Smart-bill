export type AccountingCatalog = {
  platform: "XERO" | "QUICKBOOKS";
  companyKey: string;
  companyName: string;
  country: string;
  homeCurrency: string;
  multiCurrency: boolean;
  currencies: string[];
  accounts: {
    id: string;
    name: string;
    type: string;
    currency: string | null;
  }[];
  taxes: {
    id: string;
    name: string;
    rate: number;
    expense: boolean;
    asset: boolean;
    supported: boolean;
    components: {
      id: string;
      rate: number;
      kind: string;
      order: number;
      taxOnOrder: number;
    }[];
  }[];
};
export type BillMapping = {
  companyKey: string;
  lines: { itemId: string; accountId: string; taxCodeId: string }[];
  exchangeRate?: number;
  attachDocument?: boolean;
};
export function money(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
export function isUsCompany(country: string) {
  return ["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"].includes(
    country.toUpperCase(),
  );
}
export function purchaseTaxComponents(
  amount: number,
  components: AccountingCatalog["taxes"][number]["components"],
) {
  const results: {
    id: string;
    rate: number;
    taxable: number;
    amount: number;
    order: number;
  }[] = [];
  for (const component of components) {
    const previous = results.filter((r) =>
      component.taxOnOrder
        ? r.order === component.taxOnOrder
        : r.order < component.order,
    );
    const previousTax = money(previous.reduce((sum, p) => sum + p.amount, 0));
    if (component.kind !== "TaxOnAmount" && !previous.length)
      throw new Error(
        "The selected compound tax rate has an unsupported calculation order. Check its setup in QuickBooks.",
      );
    const taxable =
      component.kind === "TaxOnTax"
        ? previousTax
        : component.kind === "TaxOnAmountPlusTax"
          ? money(amount + previousTax)
          : amount;
    results.push({
      id: component.id,
      rate: component.rate,
      taxable,
      amount: money((taxable * component.rate) / 100),
      order: component.order,
    });
  }
  return results;
}
export function validateBillMapping(
  invoice: any,
  settings: any,
  catalog: AccountingCatalog,
  mapping?: BillMapping,
) {
  if (mapping && mapping.companyKey !== catalog.companyKey)
    throw new Error(
      "This invoice's accounting choices belong to a different company. Review and save them again.",
    );
  if (
    !invoice.invoiceNumber ||
    invoice.invoiceNumber.length >
      (catalog.platform === "QUICKBOOKS" ? 21 : 255)
  )
    throw new Error(
      catalog.platform === "QUICKBOOKS"
        ? "QuickBooks bill numbers must contain 1–21 characters."
        : "Enter an invoice number of at most 255 characters.",
    );
  if (!catalog.homeCurrency)
    throw new Error("The accounting company's currency could not be verified.");
  const foreign = invoice.currency !== catalog.homeCurrency;
  if (foreign && !catalog.multiCurrency)
    throw new Error(
      "Enable multicurrency in the accounting company before exporting this invoice.",
    );
  if (
    foreign &&
    catalog.platform === "XERO" &&
    !catalog.currencies.includes(invoice.currency)
  )
    throw new Error(
      `Add ${invoice.currency} to the Xero organisation's currencies before exporting.`,
    );
  if (
    foreign &&
    (!mapping?.exchangeRate ||
      !Number.isFinite(mapping.exchangeRate) ||
      mapping.exchangeRate <= 0)
  )
    throw new Error(
      `Enter the reviewed exchange rate in Accounting details. One ${invoice.currency} equals this many ${catalog.homeCurrency}.`,
    );
  const us = catalog.platform === "QUICKBOOKS" && isUsCompany(catalog.country);
  if (
    mapping &&
    (mapping.lines.length !== invoice.items.length ||
      new Set(mapping.lines.map((l) => l.itemId)).size !==
        invoice.items.length ||
      mapping.lines.some(
        (l) => !invoice.items.some((i: any) => i.id === l.itemId),
      ))
  )
    throw new Error(
      "Invoice lines changed. Review the accounting choices again.",
    );
  const lines = invoice.items.map((item: any) => {
    const override = mapping?.lines.find((l) => l.itemId === item.id);
    const accountId =
      override?.accountId ||
      (catalog.platform === "XERO"
        ? settings?.xeroAccountCode
        : settings?.quickBooksAccountId);
    const taxCodeId =
      override?.taxCodeId ||
      (catalog.platform === "XERO"
        ? settings?.xeroTaxType
        : settings?.quickBooksTaxCodeId);
    const account = catalog.accounts.find((a) => a.id === accountId);
    if (!account)
      throw new Error(
        `Choose an active purchase account for "${item.name}" in Accounting details or Settings.`,
      );
    if (
      account.currency &&
      account.currency !== invoice.currency &&
      account.currency !== catalog.homeCurrency
    )
      throw new Error(
        `Account "${account.name}" has an incompatible currency.`,
      );
    const tax = catalog.taxes.find((t) => t.id === taxCodeId);
    if (!us && (!tax || !tax.supported))
      throw new Error(
        `Choose a valid purchase tax code for "${item.name}", including zero-rated lines.`,
      );
    if (
      !us &&
      tax &&
      ((account.type === "ASSET" && !tax.asset) ||
        (account.type === "EXPENSE" && !tax.expense))
    )
      throw new Error(
        `Tax "${tax.name}" cannot be used with account "${account.name}".`,
      );
    const amount = money(item.amount ?? item.price * item.quantity);
    const components =
      !us && catalog.platform === "QUICKBOOKS"
        ? purchaseTaxComponents(amount, tax!.components)
        : [];
    const taxAmount = us
      ? 0
      : catalog.platform === "XERO"
        ? money((amount * tax!.rate) / 100)
        : money(components.reduce((sum, c) => sum + c.amount, 0));
    return {
      itemId: item.id,
      accountId: account.id,
      taxCodeId: us ? undefined : tax!.id,
      amount,
      taxAmount,
      components,
    };
  });
  const expectedTax = money(
    lines.reduce((sum: number, l: any) => sum + l.taxAmount, 0),
  );
  const documentTax = money(Number(invoice.tax || 0));
  if (!us && Math.abs(expectedTax - documentTax) > 0.011)
    throw new Error(
      `Selected purchase taxes total ${expectedTax.toFixed(2)}, but the invoice tax is ${documentTax.toFixed(2)}. Check the net line amounts and tax codes in Accounting details.`,
    );
  let taxAccountId: string | undefined;
  if (us && documentTax > 0) {
    const account = catalog.accounts.find(
      (a) => a.id === settings?.quickBooksTaxAccountId && a.type === "EXPENSE",
    );
    if (!account)
      throw new Error(
        "Select a US purchase sales-tax expense account in Settings. This records non-recoverable tax as a separate expense line.",
      );
    taxAccountId = account.id;
  }
  return {
    lines,
    taxAccountId,
    us,
    foreign,
    exchangeRate: foreign ? mapping!.exchangeRate : undefined,
    expectedTax,
  };
}
