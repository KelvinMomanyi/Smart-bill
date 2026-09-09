import { createHash, randomUUID } from "node:crypto";
import prisma from "../db.server";
import {
  validateDocument,
  uploadInvoiceImage,
  readInvoiceDocument,
  deleteInvoiceDocument,
} from "../utils/upload.server";
import { extractTextFromDocument } from "../utils/ocr.server";
import {
  requireShopSubscription,
  reserveInvoiceUsage,
  releaseInvoiceUsage,
} from "./billing.server";
import { persistCapturedInvoice } from "./invoiceWorkflow.server";
import type { PlanKey } from "../utils/plans";

export async function enqueueDocument(input: {
  shop: string;
  plan: PlanKey;
  buffer: Buffer;
  filename: string;
  contentType: string;
  vendorName?: string;
  purchaseOrderId?: string;
}) {
  const contentType = validateDocument(
    input.buffer,
    input.filename,
    input.contentType,
  );
  if (
    input.purchaseOrderId &&
    !(await prisma.purchaseOrder.findFirst({
      where: { id: input.purchaseOrderId, shop: input.shop },
    }))
  )
    throw new Error("Purchase order not found.");
  const documentHash = createHash("sha256").update(input.buffer).digest("hex");
  const existing = await prisma.invoiceJob.findUnique({
    where: { shop_documentHash: { shop: input.shop, documentHash } },
  });
  if (existing) return existing;
  const usageMonth = await reserveInvoiceUsage(input.shop, input.plan);
  let storageKey: string | undefined;
  try {
    storageKey = await uploadInvoiceImage(
      input.buffer,
      input.filename,
      contentType,
      input.shop,
    );
    return await prisma.invoiceJob.create({
      data: {
        shop: input.shop,
        documentHash,
        storageKey,
        contentType,
        filename: input.filename,
        vendorName: input.vendorName || null,
        purchaseOrderId: input.purchaseOrderId || null,
        usageMonth,
      },
    });
  } catch (error) {
    await releaseInvoiceUsage(input.shop, usageMonth);
    if (storageKey)
      await deleteInvoiceDocument(storageKey).catch(() => undefined);
    const concurrent = await prisma.invoiceJob.findUnique({
      where: { shop_documentHash: { shop: input.shop, documentHash } },
    });
    if (concurrent) return concurrent;
    throw error;
  }
}
export async function processNextInvoiceJob() {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  await prisma.invoiceJob.updateMany({
    where: { status: "PROCESSING", lockedAt: { lt: cutoff } },
    data: { status: "QUEUED", leaseToken: null, lockedAt: null },
  });
  const job = await prisma.invoiceJob.findFirst({
    where: { status: "QUEUED", availableAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
  });
  if (!job) return false;
  const leaseToken = randomUUID();
  const claim = await prisma.invoiceJob.updateMany({
    where: { id: job.id, status: "QUEUED" },
    data: {
      status: "PROCESSING",
      lockedAt: new Date(),
      leaseToken,
      attempts: { increment: 1 },
      error: null,
    },
  });
  if (!claim.count) return true;
  const heartbeat = setInterval(() => {
    void prisma.invoiceJob
      .updateMany({
        where: { id: job.id, leaseToken },
        data: { lockedAt: new Date() },
      })
      .catch(() => undefined);
  }, 30000);
  try {
    await requireShopSubscription(job.shop);
    const existing = await prisma.invoice.findFirst({
      where: { shop: job.shop, documentHash: job.documentHash },
    });
    let invoiceId = existing?.id;
    if (!invoiceId) {
      const document = await readInvoiceDocument(job.storageKey);
      const result = await extractTextFromDocument(document.buffer, {
        filename: job.filename,
        mimeType: job.contentType,
        onProgress: async (page) => {
          const updated = await prisma.invoiceJob.updateMany({
            where: { id: job.id, leaseToken },
            data: { pageCount: page, lockedAt: new Date() },
          });
          if (!updated.count)
            throw new Error(
              "Processing lease was lost; another worker will resume.",
            );
        },
      });
      const captured = await persistCapturedInvoice({
        shop: job.shop,
        rawText: result.text,
        documentHash: job.documentHash,
        storageKey: job.storageKey,
        filename: job.filename,
        vendorName: job.vendorName,
        purchaseOrderId: job.purchaseOrderId,
        actor: "document-worker",
        jobLease: { id: job.id, token: leaseToken },
      });
      invoiceId = captured.invoice.id;
    }
    await prisma.invoiceJob.updateMany({
      where: { id: job.id, leaseToken },
      data: {
        status: "COMPLETED",
        invoiceId,
        lockedAt: null,
        leaseToken: null,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Document processing failed.";
    const terminal =
      job.attempts + 1 >= 3 ||
      /limit|Duplicate|already captured|must contain|subscription|valid PDF/.test(
        message,
      );
    await prisma.invoiceJob.updateMany({
      where: { id: job.id, leaseToken },
      data: {
        status: terminal ? "FAILED" : "QUEUED",
        error: message.slice(0, 500),
        lockedAt: null,
        leaseToken: null,
        availableAt: new Date(Date.now() + 60000 * (job.attempts + 1)),
      },
    });
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
