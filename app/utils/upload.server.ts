import { randomUUID } from "node:crypto";
import { MAX_FILE_BYTES } from "./plans";
import {
  ensureSupabaseDocumentBucket,
  getSupabaseStorage,
} from "./supabase.server";

export function validateDocument(
  buffer: Buffer,
  filename: string,
  contentType: string,
) {
  if (!buffer.length || buffer.length > MAX_FILE_BYTES)
    throw new Error("Each document must be between 1 byte and 10 MB.");
  const detectedType =
    buffer.subarray(0, 5).toString() === "%PDF-"
      ? "application/pdf"
      : buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
        ? "image/jpeg"
        : buffer
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          ? "image/png"
          : buffer.subarray(0, 4).toString() === "GIF8"
            ? "image/gif"
            : buffer.subarray(0, 4).toString() === "RIFF" &&
                buffer.subarray(8, 12).toString() === "WEBP"
              ? "image/webp"
              : null;
  if (
    detectedType === "application/pdf" &&
    (contentType === detectedType || filename.toLowerCase().endsWith(".pdf"))
  ) {
    return detectedType;
  }
  if (detectedType && contentType === detectedType) return detectedType;
  throw new Error("Upload a valid PDF, JPEG, PNG, GIF or WebP document.");
}
export async function uploadInvoiceImage(
  buffer: Buffer,
  filename: string,
  contentType: string,
  shop: string,
) {
  const validatedContentType = validateDocument(buffer, filename, contentType);
  const storage = getSupabaseStorage();
  if (!storage)
    throw new Error(
      "Document storage is not configured. Please contact support before uploading.",
    );
  await ensureSupabaseDocumentBucket(storage);
  const name =
    filename.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "invoice";
  const shopFolder = shop.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 150);
  if (!shopFolder)
    throw new Error("A valid shop is required for document storage.");
  const objectName = `invoices/${shopFolder}/${randomUUID()}-${name}`;
  const { error } = await storage.client.storage
    .from(storage.bucket)
    .upload(objectName, buffer, {
      cacheControl: "0",
      contentType: validatedContentType,
      upsert: false,
    });
  if (error)
    throw new Error("Unable to upload the private invoice document.", {
      cause: error,
    });
  return `supabase://${storage.bucket}/${objectName}`;
}

export function parseSupabaseDocumentKey(key: string, bucket: string) {
  const bucketPrefix = `supabase://${bucket}/`;
  const requiredPrefix = `${bucketPrefix}invoices/`;
  if (!key.startsWith(requiredPrefix)) {
    throw new Error("Invalid private document reference.");
  }
  const objectName = key.slice(bucketPrefix.length);
  const parts = objectName.split("/");
  if (
    parts.length < 3 ||
    parts.some(
      (part) => !part || part === "." || part === ".." || part.includes("\\"),
    )
  ) {
    throw new Error("Invalid private document reference.");
  }
  return objectName;
}

async function storageFile(key: string) {
  const storage = getSupabaseStorage();
  if (!storage) throw new Error("Document storage is not configured.");
  await ensureSupabaseDocumentBucket(storage);
  return {
    files: storage.client.storage.from(storage.bucket),
    objectName: parseSupabaseDocumentKey(key, storage.bucket),
  };
}
// Call only after resolving a shop-owned invoice or job from the database.
export async function readInvoiceDocument(key: string) {
  const { files, objectName } = await storageFile(key);
  const info = await files.info(objectName);
  if (info.error)
    throw new Error("Unable to read the private invoice document metadata.", {
      cause: info.error,
    });
  if (Number(info.data.size || info.data.metadata?.size) > MAX_FILE_BYTES) {
    throw new Error("Document exceeds the 10 MB limit.");
  }
  const downloaded = await files.download(objectName);
  if (downloaded.error)
    throw new Error("Unable to read the private invoice document.", {
      cause: downloaded.error,
    });
  const buffer = Buffer.from(await downloaded.data.arrayBuffer());
  if (buffer.length > MAX_FILE_BYTES)
    throw new Error("Document exceeds the 10 MB limit.");
  return {
    buffer,
    contentType: String(
      info.data.contentType ||
        info.data.metadata?.mimetype ||
        downloaded.data.type ||
        "application/octet-stream",
    ),
  };
}
export async function deleteInvoiceDocument(key: string) {
  const { files, objectName } = await storageFile(key);
  const { error } = await files.remove([objectName]);
  if (error)
    throw new Error("Unable to delete the private invoice document.", {
      cause: error,
    });
}
