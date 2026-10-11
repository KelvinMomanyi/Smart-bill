import { createCanvas } from "@napi-rs/canvas";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export const fixtureDirectory = resolve(".cache/ocr-browser-fixtures");
await mkdir(fixtureDirectory, { recursive: true });
const heading = (id) => ["INVOICE", "Supplier: MCP Matrix Supplies", `Invoice No: MCP-MATRIX-${id}`,
  "Invoice Date: 2026-10-11", "Due Date: 2026-10-25"];
const table = "Description Qty Rate Amount";
const rows = ["MCP-PAPER-01 Printer paper 2.5 12.50 31.25", "MCP-INK-02 Printer ink 1.25 17.00 21.25"];
const summary = ["Subtotal 52.50", "Tax 5.25", "Total USD 57.75"];
const expected = (id, missing = false) => ({ supplier: missing ? null : "MCP Matrix Supplies", invoiceNumber: `MCP-MATRIX-${id}`,
  date: missing ? null : "2026-10-11", dueDate: "2026-10-25", currency: "USD", subtotal: 52.5, tax: 5.25, total: 57.75,
  items: [{ sku: "MCP-PAPER-01", name: "Printer paper", quantity: 2.5, price: 12.5, amount: 31.25 },
    { sku: "MCP-INK-02", name: "Printer ink", quantity: 1.25, price: 17, amount: 21.25 }] });
export const fixtures = [];
for (const id of ["PNG", "JPG", "ROTATED180", "ROTATED90", "POOR", "MISSING"]) {
  const rotated90 = id === "ROTATED90";
  const canvas = createCanvas(rotated90 ? 1500 : 1100, rotated90 ? 1100 : 1500);
  const context = canvas.getContext("2d");
  context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
  if (rotated90) { context.translate(1500, 0); context.rotate(Math.PI / 2); }
  if (id === "ROTATED180") { context.translate(1100, 1500); context.rotate(Math.PI); }
  context.fillStyle = id === "POOR" ? "#bdbdbd" : "black";
  context.font = "32px Arial";
  const text = [...heading(id), table, ...rows, ...summary].filter(line => id !== "MISSING" || !/^(Supplier:|Invoice Date:)/.test(line));
  text.forEach((line, index) => context.fillText(line, 45, 90 + index * 90));
  const type = id === "JPG" ? "image/jpeg" : "image/png";
  const filename = `${id}.${id === "JPG" ? "jpg" : "png"}`;
  await writeFile(resolve(fixtureDirectory, filename), canvas.toBuffer(type));
  fixtures.push({ id, filename, type, pages: 1, expected: expected(id, id === "MISSING"), absentFields: id === "MISSING" ? ["supplier", "date"] : [] });
}
function pdf(pages) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (const [index, lines] of pages.entries()) {
    const text = ["BT", "/F1 17 Tf", "40 740 Td", ...lines.flatMap((line, i) => [ ...(i ? ["0 -42 Td"] : []), `(${line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")}) Tj` ]), "ET"].join("\n");
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`);
  }
  let out = "%PDF-1.4\n"; const offsets = [];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(out, "ascii");
}
for (const id of ["PDF", "MULTIPAGE"]) {
  const pages = id === "PDF" ? [[...heading(id), table, ...rows, ...summary]]
    : [[...heading(id), table, rows[0]], ["Invoice continuation", table, rows[1], ...summary]];
  const filename = `${id}.pdf`;
  await writeFile(resolve(fixtureDirectory, filename), pdf(pages));
  fixtures.push({ id, filename, type: "application/pdf", pages: pages.length, expected: expected(id), absentFields: [] });
}
await writeFile(resolve(fixtureDirectory, "manifest.json"), JSON.stringify({ kind: "independently-specified-synthetic-invoice-fixtures", fixtures }, null, 2));
