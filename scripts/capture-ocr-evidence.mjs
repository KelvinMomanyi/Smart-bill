import { PrismaClient } from "@prisma/client";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const shop = option("--shop");
const invoiceId = option("--invoice");
if (!shop || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !invoiceId || invoiceId.startsWith("--")) {
  console.error("Usage: node --env-file=.env scripts/capture-ocr-evidence.mjs --shop STORE.myshopify.com --invoice ID");
  process.exit(1);
}
const prisma = new PrismaClient({ log: [] });
try {
  // Read-only, explicitly tenant scoped. Deliberately exclude document URLs,
  // storage keys, session records, OAuth fields and accounting connections.
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, shop },
    select: {
      id: true, revision: true, rawText: true, createdAt: true, updatedAt: true,
      sourceFilename: true, documentHash: true, identityKey: true, invoiceNumber: true, date: true, dueDate: true,
      currency: true, subtotal: true, tax: true, total: true,
      vendor: { select: { name: true, shop: true } },
      items: { select: { sku: true, name: true, quantity: true, price: true, amount: true } },
    },
  });
  if (!invoice?.rawText || invoice.vendor?.shop !== shop) throw new Error("No matching invoice with stored OCR text and correct supplier ownership.");
  const [settings, job, documentCount, identityCount] = await Promise.all([
    prisma.shopSettings.findUnique({ where: { shop }, select: { dateOrder: true } }),
    prisma.invoiceJob.findFirst({ where: { shop, invoiceId }, select: { id: true, status: true, pageCount: true, contentType: true } }),
    invoice.documentHash ? prisma.invoice.count({ where: { shop, documentHash: invoice.documentHash } }) : Promise.resolve(null),
    invoice.identityKey ? prisma.invoice.count({ where: { shop, identityKey: invoice.identityKey } }) : Promise.resolve(null),
  ]);
  const capturedAt = new Date().toISOString();
  const snapshot = {
    kind: "live-invoice-snapshot", capturedAt, shop, invoiceId,
    revision: invoice.revision, createdAt: invoice.createdAt, updatedAt: invoice.updatedAt,
    sourceFilename: invoice.sourceFilename, job, documentCount, identityCount,
    dateOrder: settings?.dateOrder === "MDY" ? "MDY" : "DMY",
    rawText: invoice.rawText,
    persisted: {
      supplier: invoice.vendor.name, invoiceNumber: invoice.invoiceNumber,
      date: invoice.date.toISOString().slice(0, 10), dueDate: invoice.dueDate?.toISOString().slice(0, 10) ?? null,
      currency: invoice.currency, subtotal: invoice.subtotal, tax: invoice.tax, total: invoice.total,
      items: invoice.items,
    },
  };
  const output = resolve(".cache/ocr-accuracy/evidence", `${capturedAt.replace(/[:.]/g, "-")}-${randomUUID()}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(snapshot, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, invoiceId, revision: invoice.revision, jobStatus: job?.status ?? null, initialCapture: invoice.revision === 0 }, null, 2));
} catch {
  // Do not expose connection strings or raw database exceptions.
  console.error("Could not capture scoped OCR evidence. Check database access and the shop/invoice identifiers.");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
