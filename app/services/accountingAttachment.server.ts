import prisma from "../db.server";
import { assertApproved } from "../utils/invoiceRules";
import { readInvoiceDocument } from "../utils/upload.server";
import {
  getAccountingConnection,
  accountingCompanyKey,
  type LivePlatform,
} from "./accountingConnection.server";
import { assertExportCompany } from "../utils/accountingExportPolicy";
import { quickBooksQuery, quickBooksRequest } from "../utils/quickbook";
import { xeroRequest } from "../utils/xero";
import { AccountingApiError } from "../utils/accountingHttp.server";
const extensions: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};
export async function attachInvoiceDocument(
  request: Request,
  invoiceId: string,
  platform: LivePlatform,
) {
  const [{ requireAdmin }, { requireSubscription }] = await Promise.all([
    import("../utils/rbac.server"),
    import("./billing.server"),
  ]);
  const { session, actor } = await requireAdmin(request);
  await requireSubscription(request);
  return attachApprovedInvoiceDocument({
    shop: session.shop,
    actor,
    invoiceId,
    platform,
  });
}
export async function attachApprovedInvoiceDocument(
  {
    shop,
    actor,
    invoiceId,
    platform,
  }: {
    shop: string;
    actor: string;
    invoiceId: string;
    platform: LivePlatform;
  },
  readDocument = readInvoiceDocument,
) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, shop },
    include: { exports: true },
  });
  if (!invoice?.storageKey)
    throw new Error(
      "This invoice has no private original document available to attach.",
    );
  assertApproved(invoice);
  const entry = invoice.exports.find((e) => e.platform === platform);
  if (!entry?.remoteId || entry.status !== "EXPORTED")
    throw new Error(
      "Export or verify the bill before attaching its original document.",
    );
  if (entry.attachmentStatus === "ATTACHED") return;
  if (
    entry.attachmentStatus === "SENDING" &&
    Date.now() - entry.updatedAt.getTime() < 120000
  )
    throw new Error(
      "Document attachment is still running. Check again in two minutes.",
    );
  const connection = await getAccountingConnection(shop, platform);
  assertExportCompany(entry.companyKey, accountingCompanyKey(connection));
  const file = await readDocument(invoice.storageKey);
  const extension = extensions[file.contentType];
  if (!extension)
    throw new Error(
      "The original document format is not supported by accounting attachments.",
    );
  const filename = `smartbill-${invoice.id}.${extension}`;
  const found =
    platform === "XERO"
      ? (
          await xeroRequest(
            connection,
            `/Invoices/${entry.remoteId}/Attachments`,
          )
        ).Attachments?.find((a: any) => a.FileName === filename)
      : (
          await quickBooksQuery(
            connection,
            `select * from Attachable where AttachableRef.EntityRef.Type = 'Bill' and AttachableRef.EntityRef.value = '${entry.remoteId}' maxresults 1000`,
            "Attachable",
          )
        ).find((a: any) => a.FileName === filename);
  if (found) {
    const size = Number(found.ContentLength ?? found.Size);
    if (size !== file.buffer.length)
      throw new Error(
        "An attachment with this name has a different size. Review it in the accounting company.",
      );
    await prisma.accountingExport.update({
      where: { id: entry.id },
      data: {
        attachmentStatus: "ATTACHED",
        attachmentId: String(found.AttachmentID || found.Id),
        attachmentError: null,
      },
    });
    return;
  }
  if (["VERIFY", "SENDING"].includes(entry.attachmentStatus))
    throw new Error(
      "The earlier attachment outcome is still unknown. Check the existing bill's attachments before uploading another copy.",
    );
  const claim = await prisma.accountingExport.updateMany({
    where: {
      id: entry.id,
      attachmentStatus: { in: ["NOT_REQUESTED", "FAILED"] },
    },
    data: { attachmentStatus: "SENDING", attachmentError: null },
  });
  if (claim.count !== 1)
    throw new Error("An attachment is already running. Reload its status.");
  try {
    let attachment: any;
    if (platform === "XERO") {
      attachment = (
        await xeroRequest(
          connection,
          `/Invoices/${entry.remoteId}/Attachments/${encodeURIComponent(filename)}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": file.contentType,
              "Idempotency-Key": `${entry.requestKey}-file`,
            },
            body: new Uint8Array(file.buffer),
          },
        )
      ).Attachments?.[0];
    } else {
      const form = new FormData();
      form.append(
        "file_metadata_01",
        new Blob(
          [
            JSON.stringify({
              AttachableRef: [
                { EntityRef: { type: "Bill", value: entry.remoteId } },
              ],
              FileName: filename,
              ContentType: file.contentType,
            }),
          ],
          { type: "application/json" },
        ),
        "metadata.json",
      );
      form.append(
        "file_content_01",
        new Blob([new Uint8Array(file.buffer)], { type: file.contentType }),
        filename,
      );
      const response = await quickBooksRequest(
        connection,
        `/upload?requestid=${entry.requestKey}-file`,
        { method: "POST", body: form },
      );
      const result = response.AttachableResponse?.[0];
      if (result?.Fault)
        throw new AccountingApiError(
          "QuickBooks",
          400,
          "QuickBooks rejected the attachment. Check its accepted file types and size.",
          true,
        );
      attachment = result?.Attachable;
    }
    const id = attachment?.AttachmentID || attachment?.Id;
    if (!id)
      throw new Error(
        "The accounting provider did not confirm the attachment. Check the existing bill.",
      );
    await prisma.$transaction([
      prisma.accountingExport.update({
        where: { id: entry.id },
        data: {
          attachmentStatus: "ATTACHED",
          attachmentId: String(id),
          attachmentError: null,
        },
      }),
      prisma.auditEvent.create({
        data: {
          shop,
          invoiceId,
          actor,
          action: "ACCOUNTING_DOCUMENT_ATTACHED",
          detail: { platform, remoteId: entry.remoteId },
        },
      }),
    ]);
  } catch (error) {
    await prisma.accountingExport.update({
      where: { id: entry.id },
      data: {
        attachmentStatus:
          error instanceof AccountingApiError && error.rejected
            ? "FAILED"
            : "VERIFY",
        attachmentError:
          error instanceof Error
            ? error.message
            : "Check the attachment in the accounting company.",
      },
    });
    throw error;
  }
}
