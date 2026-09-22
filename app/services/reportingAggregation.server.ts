import prisma from "../db.server";
import { roundMoney } from "../utils/invoiceRules";

export type ReportingInvoice = {
  id: string;
  date: Date;
  total: number;
  currency: string;
  discrepancySummary: string | null;
  vendor: { id: string; name: string } | null;
  creditNotes: { amount: number; status: string }[];
  items: {
    sku: string | null;
    name: string;
    category: string;
    quantity: number;
    price: number;
    amount: number | null;
  }[];
};

function lineAmount(line: ReportingInvoice["items"][number]) {
  return line.amount ?? line.quantity * line.price;
}

function monthKey(date: Date) {
  return date.toISOString().slice(0, 7);
}

export function aggregateReporting(invoices: ReportingInvoice[]) {
  const vendorSpend = new Map<
    string,
    { supplierId: string; supplier: string; currency: string; total: number; invoices: number }
  >();
  const monthlySpend = new Map<
    string,
    { month: string; supplier: string; currency: string; total: number }
  >();
  const categorySpend = new Map<string, { category: string; currency: string; total: number }>();
  const supplierPerformance = new Map<
    string,
    { supplier: string; currency: string; total: number; invoices: number; mismatches: number }
  >();
  const prices = new Map<
    string,
    { supplier: string; sku: string; name: string; date: Date; cost: number; quantity: number; currency: string }[]
  >();

  for (const invoice of invoices) {
    const supplierId = invoice.vendor?.id || "unknown";
    const supplier = invoice.vendor?.name || "Unknown supplier";
    const credited = invoice.creditNotes
      .filter((credit) => ["APPROVED", "APPLIED", "POSTED"].includes(credit.status))
      .reduce((sum, credit) => sum + credit.amount, 0);
    const netTotal = Math.max(0, invoice.total - credited);
    const vendorKey = `${supplierId}|${invoice.currency}`;
    const vendor = vendorSpend.get(vendorKey) || {
      supplierId,
      supplier,
      currency: invoice.currency,
      total: 0,
      invoices: 0,
    };
    vendor.total = roundMoney(vendor.total + netTotal);
    vendor.invoices++;
    vendorSpend.set(vendorKey, vendor);

    const monthlyKey = `${monthKey(invoice.date)}|${supplierId}|${invoice.currency}`;
    const monthly = monthlySpend.get(monthlyKey) || {
      month: monthKey(invoice.date),
      supplier,
      currency: invoice.currency,
      total: 0,
    };
    monthly.total = roundMoney(monthly.total + netTotal);
    monthlySpend.set(monthlyKey, monthly);

    const performance = supplierPerformance.get(vendorKey) || {
      supplier,
      currency: invoice.currency,
      total: 0,
      invoices: 0,
      mismatches: 0,
    };
    performance.total = roundMoney(performance.total + netTotal);
    performance.invoices++;
    if (invoice.discrepancySummary?.trim()) performance.mismatches++;
    supplierPerformance.set(vendorKey, performance);

    for (const line of invoice.items.filter((item) => item.category === "PRODUCT")) {
      const categoryKey = `${line.category}|${invoice.currency}`;
      const category = categorySpend.get(categoryKey) || {
        category: line.category,
        currency: invoice.currency,
        total: 0,
      };
      category.total = roundMoney(category.total + lineAmount(line));
      categorySpend.set(categoryKey, category);
      const sku = line.sku || line.name;
      const priceKey = `${supplierId}|${sku}|${invoice.currency}`;
      const history = prices.get(priceKey) || [];
      history.push({
        supplier,
        sku,
        name: line.name,
        date: invoice.date,
        cost: line.quantity ? lineAmount(line) / line.quantity : line.price,
        quantity: line.quantity,
        currency: invoice.currency,
      });
      prices.set(priceKey, history);
    }
  }

  const priceChanges = [...prices.values()]
    .filter((history) => history.length > 1)
    .map((history) => {
      history.sort((left, right) => left.date.getTime() - right.date.getTime());
      const previous = history.at(-2)!;
      const current = history.at(-1)!;
      const delta = current.cost - previous.cost;
      return {
        supplier: current.supplier,
        sku: current.sku,
        name: current.name,
        currency: current.currency,
        previousCost: roundMoney(previous.cost),
        currentCost: roundMoney(current.cost),
        delta: roundMoney(delta),
        percent: previous.cost ? (delta / previous.cost) * 100 : null,
        marginImpact: roundMoney(-delta * current.quantity),
        latestDate: current.date.toISOString().slice(0, 10),
      };
    })
    .sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));

  return {
    vendorSpend: [...vendorSpend.values()].sort((a, b) => b.total - a.total),
    monthlySpend: [...monthlySpend.values()].sort((a, b) => a.month.localeCompare(b.month)),
    priceChanges,
    categorySpend: [...categorySpend.values()].sort((a, b) => b.total - a.total),
    supplierPerformance: [...supplierPerformance.values()]
      .map((supplier) => ({
        ...supplier,
        averageInvoice: supplier.invoices
          ? roundMoney(supplier.total / supplier.invoices)
          : 0,
        accuracyPercent: supplier.invoices
          ? ((supplier.invoices - supplier.mismatches) / supplier.invoices) * 100
          : 100,
      }))
      .sort((a, b) => b.total - a.total),
  };
}

export async function reportingForPeriod(shop: string, from: Date, until: Date) {
  const invoices = await prisma.invoice.findMany({
    where: { shop, date: { gte: from, lt: until } },
    include: {
      vendor: { select: { id: true, name: true } },
      creditNotes: { select: { amount: true, status: true } },
      items: {
        select: {
          sku: true,
          name: true,
          category: true,
          quantity: true,
          price: true,
          amount: true,
        },
      },
    },
    orderBy: { date: "asc" },
  });
  return aggregateReporting(invoices);
}

export async function refreshReportingSnapshot(
  shop: string,
  from: Date,
  until: Date,
  periodType = "CUSTOM",
) {
  const data = await reportingForPeriod(shop, from, until);
  return prisma.reportingSnapshot.upsert({
    where: {
      shop_periodStart_periodEnd_periodType: {
        shop,
        periodStart: from,
        periodEnd: until,
        periodType,
      },
    },
    create: { shop, periodStart: from, periodEnd: until, periodType, data },
    update: { data },
  });
}

function csvCell(value: unknown) {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text)
    ? `"'${text.replaceAll('"', '""')}"`
    : `"${text.replaceAll('"', '""')}"`;
}

export function reportingCsv(data: ReturnType<typeof aggregateReporting>) {
  const rows: unknown[][] = [
    ["Report", "Supplier", "SKU", "Currency", "Amount", "Previous", "Current", "Change percent", "Margin impact"],
    ...data.vendorSpend.map((row) => [
      "Vendor spend",
      row.supplier,
      "",
      row.currency,
      row.total,
      "",
      "",
      "",
      "",
    ]),
    ...data.priceChanges.map((row) => [
      "Price change",
      row.supplier,
      row.sku,
      row.currency,
      "",
      row.previousCost,
      row.currentCost,
      row.percent?.toFixed(2) ?? "",
      row.marginImpact,
    ]),
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
