import { randomUUID } from "node:crypto";
import { getFirebaseStorage } from "./firebase.server";
import { MAX_FILE_BYTES } from "./plans";

export function validateDocument(buffer: Buffer, filename: string, contentType: string) {
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) throw new Error("Each document must be between 1 byte and 10 MB.");
  const pdf = buffer.subarray(0, 5).toString() === "%PDF-";
  const image = buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
    buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
    buffer.subarray(0, 4).toString() === "GIF8" ||
    (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8,12).toString() === "WEBP");
  if (pdf && (contentType === "application/pdf" || filename.toLowerCase().endsWith(".pdf"))) return "application/pdf";
  if (image && ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(contentType)) return contentType;
  throw new Error("Upload a valid PDF, JPEG, PNG, GIF or WebP document.");
}
export async function uploadInvoiceImage(buffer: Buffer, filename: string, contentType: string, shop: string) {
  validateDocument(buffer, filename, contentType);
  const storage = getFirebaseStorage();
  if (!storage) throw new Error("Document storage is not configured. Please contact support before uploading.");
  const name = filename.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "invoice";
  const objectName = `invoices/${shop}/${randomUUID()}-${name}`;
  const bucket = storage.bucket();
  await bucket.file(objectName).save(buffer, { resumable: false, contentType, metadata: { cacheControl: "private, no-store" } });
  return `gs://${bucket.name}/${objectName}`;
}
function storageFile(key: string) {
  const storage = getFirebaseStorage();
  if (!storage) throw new Error("Document storage is not configured.");
  const bucket = storage.bucket();
  const prefix = `gs://${bucket.name}/invoices/`;
  if (!key.startsWith(prefix)) throw new Error("Invalid private document reference.");
  return bucket.file(key.slice(`gs://${bucket.name}/`.length));
}
// Call only after resolving a shop-owned invoice or job from the database.
export async function readInvoiceDocument(key: string) {
  const file = storageFile(key);
  const [metadata] = await file.getMetadata();
  if (Number(metadata.size) > MAX_FILE_BYTES) throw new Error("Document exceeds the 10 MB limit.");
  const [buffer] = await file.download();
  return { buffer, contentType: String(metadata.contentType || "application/octet-stream") };
}
export async function deleteInvoiceDocument(key: string) {
  await storageFile(key).delete({ ignoreNotFound: true });
}
