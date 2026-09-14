import { createHash, randomUUID } from "node:crypto";
import prisma from "../db.server";
import {
  validateDocument,
  uploadInvoiceImage,
  readInvoiceDocument,
  deleteInvoiceDocument,
} from "../utils/upload.server";
import {
  requireShopSubscription,
  reserveInvoiceUsage,
  releaseInvoiceUsage,
} from "./billing.server";
import { persistCapturedInvoice } from "./invoiceWorkflow.server";
import type { PlanKey } from "../utils/plans";
import { validateBrowserOcrText } from "../utils/browserOcr";
import {
  INVOICE_JOB_STALE_MS,
  queuedInvoiceJobWhere,
  staleInvoiceJobWhere,
} from "../utils/invoiceJobs";

export async function enqueueDocument(input: {
  shop: string;
  plan: PlanKey;
  buffer: Buffer;
  filename: string;
  contentType: string;
  vendorName?: string;
  purchaseOrderId?: string;
  browserOcr?: boolean;
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
        status: input.browserOcr ? "AWAITING_OCR" : "QUEUED",
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
export async function completeBrowserInvoiceJob(input: {
  shop: string;
  jobId: string;
  rawText: unknown;
  pageCount: unknown;
  actor: string;
}) {
  const { rawText, pageCount } = validateBrowserOcrText(
    input.rawText,
    input.pageCount,
  );
  const job = await prisma.invoiceJob.findFirst({
    where: { id: input.jobId, shop: input.shop },
  });
  if (!job) throw new Error("Document not found in this store.");
  if (job.status === "COMPLETED" && job.invoiceId) return job.invoiceId;
  if (job.contentType !== "application/pdf" && pageCount !== 1)
    throw new Error("An image must have exactly one OCR page.");
  const leaseToken = randomUUID();
  const claim = await prisma.invoiceJob.updateMany({
    where: {
      id: job.id,
      shop: input.shop,
      OR: [
        { status: { in: ["AWAITING_OCR", "QUEUED", "FAILED"] } },
        {
          status: "PROCESSING",
          lockedAt: { lt: new Date(Date.now() - INVOICE_JOB_STALE_MS) },
        },
      ],
    },
    data: {
      status: "PROCESSING",
      leaseToken,
      lockedAt: new Date(),
      error: null,
      attempts: { increment: 1 },
    },
  });
  if (!claim.count)
    throw new Error(
      "This document is already being saved or processed. Reload to check its status.",
    );
  try {
    const existing = await prisma.invoice.findFirst({
      where: { shop: input.shop, documentHash: job.documentHash },
    });
    const invoiceId =
      existing?.id ||
      (
        await persistCapturedInvoice({
          shop: input.shop,
          rawText,
          storageKey: job.storageKey,
          filename: job.filename,
          documentHash: job.documentHash,
          vendorName: job.vendorName,
          purchaseOrderId: job.purchaseOrderId,
          actor: input.actor,
          jobLease: { id: job.id, token: leaseToken },
        })
      ).invoice.id;
    const completed = await prisma.invoiceJob.updateMany({
      where: { id: job.id, shop: input.shop, leaseToken },
      data: {
        status: "COMPLETED",
        invoiceId,
        pageCount,
        error: null,
        leaseToken: null,
        lockedAt: null,
      },
    });
    if (!completed.count)
      throw new Error(
        "Saving was interrupted. Reload to check the invoice before retrying.",
      );
    return invoiceId;
  } catch (error) {
    await prisma.invoiceJob.updateMany({
      where: { id: job.id, shop: input.shop, leaseToken },
      data: {
        status: "FAILED",
        leaseToken: null,
        lockedAt: null,
        error: (error instanceof Error
          ? error.message
          : "Unable to save OCR results."
        ).slice(0, 500),
      },
    });
    throw error;
  }
}

export async function processNextInvoiceJob(shop?: string) {
  const cutoff = new Date(Date.now() - INVOICE_JOB_STALE_MS);
  await prisma.invoiceJob.updateMany({
    where: staleInvoiceJobWhere(shop, cutoff),
    data: { status: "QUEUED", leaseToken: null, lockedAt: null },
  });
  const job = await prisma.invoiceJob.findFirst({
    where: queuedInvoiceJobWhere(shop, new Date()),
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
      const { extractTextFromDocument } = await import("../utils/ocr.server");
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
      /limit|Duplicate|already captured|must contain|subscription|valid PDF|OCR timed out|OCR is selected|credential file is unavailable|credentials are not valid|Google Cloud Vision OCR failed/.test(
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
