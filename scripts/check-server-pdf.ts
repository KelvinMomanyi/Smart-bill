import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import { mkdir, writeFile } from "node:fs/promises";
import { extractTextFromDocument } from "../app/utils/ocr.server";

// Exercise actual PDF.js rendering and local OCR with a synthetic invoice.
// No database, merchant data, or paid OCR provider is used.
process.env.OCR_PROVIDER = "tesseract";
process.env.OCR_TIMEOUT_MS = "120000";
const directory = ".cache/server-pdf-check";
await mkdir(directory, { recursive: true });
const canvas = createCanvas(1100, 1500);
const context = canvas.getContext("2d");
context.fillStyle = "white";
context.fillRect(0, 0, canvas.width, canvas.height);
context.fillStyle = "black";
context.font = "32px Arial";
[
  "INVOICE", "Supplier: SmartBill PDF QA", "Invoice No: PDF-QA-001",
  "Invoice Date: 2026-10-16", "Due Date: 2026-10-30",
  "Description Qty Rate Amount", "Paper 2.5 12.50 31.25", "Ink 1.25 17.00 21.25",
  "Subtotal 52.50", "Tax 5.25", "Total USD 57.75",
].forEach((line, index) => context.fillText(line, 45, 90 + index * 90));
const jpeg = canvas.toBuffer("image/jpeg");
const drawing = Buffer.from("q 528 0 0 720 42 36 cm /Im0 Do Q");
const objects = [
  Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
  Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
  Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>"),
  Buffer.concat([Buffer.from(`<< /Length ${drawing.length} >>\nstream\n`), drawing, Buffer.from("\nendstream")]),
  Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream")]),
];
const pieces = [Buffer.from("%PDF-1.4\n")];
const offsets: number[] = [];
for (const [index, object] of objects.entries()) {
  offsets.push(pieces.reduce((total, part) => total + part.length, 0));
  pieces.push(Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n"));
}
const start = pieces.reduce((total, part) => total + part.length, 0);
pieces.push(Buffer.from(`xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${start}\n%%EOF\n`));
const pdf = Buffer.concat(pieces);
await writeFile(`${directory}/sparse-invoice.pdf`, pdf);
const result = await extractTextFromDocument(pdf, { filename: "synthetic-scan.pdf", mimeType: "application/pdf" });
assert.equal(result.pageCount, 1);
assert.equal(result.pages[0].source, "ocr");
assert.match(result.text, /PDF-QA-001/);
assert.match(result.text, /57[.,]75/);
console.log("Scanned PDF: actual server rendering and local OCR preserve the invoice number and total.");
