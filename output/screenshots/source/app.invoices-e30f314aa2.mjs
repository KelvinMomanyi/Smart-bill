import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Form, Link, useLoaderData, useOutlet } from "@remix-run/react";
import { Page, Card, BlockStack, Banner, Text, DataTable, Button, InlineStack, } from "@shopify/polaris";
import { formatMoney } from "file:///C:/Users/user/Desktop/SMARTBILL/smart-bill/output/screenshots/source/format-3157096fa0.mjs";
import { CsvDownloadButton } from "file:///C:/Users/user/Desktop/SMARTBILL/smart-bill/output/screenshots/source/CsvDownloadButton-3d2ec60607.mjs";
export default function InvoiceQueue() {
    const data = useLoaderData();
    const outlet = useOutlet();
    if (outlet)
        return outlet;
    const query = (page) => `/app/invoices?${new URLSearchParams({ page: String(page), q: data.search, status: data.status })}`;
    return (_jsx(Page, { title: "Invoice review", subtitle: "Open an invoice to inspect the original, correct its lines and approve it.", children: _jsxs(BlockStack, { gap: "400", children: [data.deleted && (_jsx(Banner, { tone: "success", children: "The invoice and all of its local data were deleted." })), _jsx(Card, { children: _jsx(Form, { method: "get", children: _jsxs(InlineStack, { gap: "300", children: [_jsxs("label", { children: ["Search invoices or suppliers", " ", _jsx("input", { name: "q", defaultValue: data.search })] }), _jsxs("label", { children: ["Status", " ", _jsxs("select", { name: "status", defaultValue: data.status, children: [_jsx("option", { value: "", children: "All" }), _jsx("option", { value: "PENDING_REVIEW", children: "Pending review" }), _jsx("option", { value: "NEEDS_ATTENTION", children: "Needs attention" }), _jsx("option", { value: "APPROVED", children: "Approved" })] })] }), _jsx(Button, { submit: true, children: "Search" })] }) }) }), _jsx(Card, { children: _jsxs(BlockStack, { gap: "300", children: [_jsxs(Text, { as: "p", children: [data.count, " invoices"] }), _jsx(DataTable, { columnContentTypes: [
                                    "text",
                                    "text",
                                    "numeric",
                                    "text",
                                    "text",
                                    "text",
                                ], headings: [
                                    "Invoice",
                                    "Supplier",
                                    "Total",
                                    "PO",
                                    "Review",
                                    "Accounting",
                                ], rows: data.invoices.map((i) => [
                                    _jsx(Link, { to: `/app/invoices/${i.id}`, children: i.invoiceNumber || i.id.slice(0, 8) }, i.id),
                                    i.vendor?.name || "Unknown",
                                    formatMoney(i.total, i.currency),
                                    i.purchaseOrder?.poNumber || "—",
                                    i.reviewStatus,
                                    i.accountingStatus,
                                ]) }), _jsxs(InlineStack, { gap: "300", children: [data.page > 1 && (_jsx(Button, { url: query(data.page - 1), children: "Previous" })), data.page * 25 < data.count && (_jsx(Button, { url: query(data.page + 1), children: "Next" }))] }), data.role === "ADMIN" && (_jsx(CsvDownloadButton, { children: "Download approved invoices CSV" }))] }) })] }) }));
}
