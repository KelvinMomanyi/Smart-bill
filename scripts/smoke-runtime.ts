import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import {
  deleteInvoiceDocument,
  readInvoiceDocument,
  uploadInvoiceImage,
  validateDocument,
} from "../app/utils/upload.server";
import { extractTextFromDocument } from "../app/utils/ocr.server";
import { parseInvoiceText } from "../app/utils/parser.server";

function makeInvoiceImage() {
  const canvas = createCanvas(1400, 900);
  const context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "black";
  context.font = "bold 48px Arial";
  context.fillText("INVOICE", 80, 90);
  context.font = "32px Arial";
  const lines = [
    "Supplier: SmartBill Runtime Supplies",
    "Invoice No: SMOKE-1001",
    "Invoice Date: 2026-09-13",
    "Description Qty Rate Amount",
    "PAPER-10 Printer Paper 2 25.00 50.00",
    "Subtotal 50.00",
    "Tax 8.00",
    "Total USD 58.00",
  ];
  lines.forEach((line, index) => context.fillText(line, 80, 170 + index * 75));
  return canvas.toBuffer("image/png");
}

function makeInvoicePdf() {
  const lines = [
    "INVOICE",
    "Supplier: SmartBill PDF Supplies",
    "Invoice No: PDF-SMOKE-1002",
    "Invoice Date: 2026-09-13",
    "Description Qty Rate Amount",
    "INK-20 Printer Ink 2 30.00 60.00",
    "Subtotal 60.00",
    "Tax 9.60",
    "Total USD 69.60",
  ];
  const escaped = (value: string) =>
    value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const content = [
    "BT",
    "/F1 18 Tf",
    "72 740 Td",
    ...lines.flatMap((line, index) => [
      ...(index ? ["0 -32 Td"] : []),
      `(${escaped(line)}) Tj`,
    ]),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

async function main() {
  const image = makeInvoiceImage();
  assert.equal(
    validateDocument(image, "smartbill-runtime-smoke.png", "image/png"),
    "image/png",
  );

  const ocr = await extractTextFromDocument(image, {
    filename: "smartbill-runtime-smoke.png",
    mimeType: "image/png",
  });
  const parsed = parseInvoiceText(ocr.text);
  assert.equal(ocr.pageCount, 1);
  assert.match(ocr.text, /SMOKE-1001/i);
  assert.equal(parsed.invoiceNumber, "SMOKE-1001");
  assert.equal(parsed.total, 58);

  const pdfOcr = await extractTextFromDocument(makeInvoicePdf(), {
    filename: "smartbill-runtime-smoke.pdf",
    mimeType: "application/pdf",
  });
  const parsedPdf = parseInvoiceText(pdfOcr.text);
  assert.equal(pdfOcr.pageCount, 1);
  assert.match(pdfOcr.text, /PDF-SMOKE-1002/i);
  assert.equal(parsedPdf.invoiceNumber, "PDF-SMOKE-1002");
  assert.equal(parsedPdf.total, 69.6);

  if (process.argv.includes("--skip-storage")) {
    console.log(
      JSON.stringify({
        imageOcr: "passed",
        pdfOcr: "passed",
        parsedInvoices: "passed",
        privateStorageRoundTrip: "skipped",
      }),
    );
    return;
  }

  let storageKey: string | undefined;
  try {
    storageKey = await uploadInvoiceImage(
      image,
      "smartbill-runtime-smoke.png",
      "image/png",
      "runtime-smoke.myshopify.com",
    );
    const stored = await readInvoiceDocument(storageKey);
    assert.equal(stored.contentType, "image/png");
    assert.deepEqual(stored.buffer, image);
  } finally {
    if (storageKey) await deleteInvoiceDocument(storageKey);
  }

  console.log(
    JSON.stringify({
      imageOcr: "passed",
      pdfOcr: "passed",
      parsedInvoices: "passed",
      privateStorageRoundTrip: "passed",
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Runtime smoke test failed.");
  process.exitCode = 1;
});
