import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useLoaderData } from "@remix-run/react";
import { Badge, BlockStack, Card, DataTable, Layout, Page, Text, } from "@shopify/polaris";
import { formatMoney } from "file:///C:/Users/user/Desktop/SMARTBILL/smart-bill/output/screenshots/source/format-3157096fa0.mjs";
function HealthBadge({ value, total }) {
    const ratio = total === 0 ? 0 : value / total;
    const tone = ratio === 0 ? "success" : ratio < 0.15 ? "warning" : "critical";
    return _jsx(Badge, { tone: tone, children: value.toString() });
}
export default function AnalyticsDashboard() {
    const { vendorAnalytics, metrics } = useLoaderData();
    const rows = vendorAnalytics.map((vendor) => [
        vendor.name,
        vendor.invoiceCount.toString(),
        vendor.purchaseOrderCount.toString(),
        formatMoney(vendor.totalSpend, vendor.currency),
        formatMoney(vendor.averageInvoice, vendor.currency),
        _jsx(HealthBadge, { value: vendor.mismatchCount, total: vendor.purchaseOrderCount }, vendor.id),
    ]);
    return (_jsx(Page, { title: "Vendor analytics", subtitle: "Track supplier spend, invoice quality, PO mismatches, and automation throughput.", children: _jsxs(BlockStack, { gap: "500", children: [_jsxs("div", { style: {
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
                        gap: "16px",
                    }, children: [_jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { as: "p", tone: "subdued", children: "Spend captured" }), _jsx(Text, { as: "p", variant: "headingLg", children: metrics.totalSpend
                                            .map((t) => formatMoney(t.total, t.currency))
                                            .join(" / ") || "No invoices" })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { as: "p", tone: "subdued", children: "Invoices captured" }), _jsx(Text, { as: "p", variant: "headingLg", children: metrics.invoiceCount })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { as: "p", tone: "subdued", children: "Needs attention" }), _jsx(Text, { as: "p", variant: "headingLg", children: metrics.needsAttention })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { as: "p", tone: "subdued", children: "Mismatched POs" }), _jsx(Text, { as: "p", variant: "headingLg", children: metrics.mismatchedPOs })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { as: "p", tone: "subdued", children: "COGS synced" }), _jsx(Text, { as: "p", variant: "headingLg", children: metrics.syncedCogs })] }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "200", children: [_jsx(Text, { as: "p", tone: "subdued", children: "Accounting exports" }), _jsx(Text, { as: "p", variant: "headingLg", children: metrics.exported })] }) })] }), _jsx(Layout, { children: _jsx(Layout.Section, { children: _jsx(Card, { children: _jsxs(BlockStack, { gap: "400", children: [_jsx(Text, { as: "h2", variant: "headingMd", children: "Supplier scorecard" }), rows.length > 0 ? (_jsx(DataTable, { columnContentTypes: [
                                            "text",
                                            "numeric",
                                            "numeric",
                                            "numeric",
                                            "numeric",
                                            "text",
                                        ], headings: [
                                            "Vendor",
                                            "Invoices",
                                            "POs",
                                            "Spend",
                                            "Avg invoice",
                                            "Mismatches",
                                        ], rows: rows })) : (_jsx(Text, { as: "p", tone: "subdued", children: "Capture invoices and create purchase orders to generate vendor analytics." }))] }) }) }) })] }) }));
}
