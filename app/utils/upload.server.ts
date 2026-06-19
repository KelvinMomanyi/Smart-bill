import { randomUUID } from 'crypto';
import { getFirebaseStorage } from './firebase.server';

function safeFilename(filename: string) {
  return filename.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 120) || "invoice";
}

export async function uploadInvoiceImage(
  fileBuffer: Buffer,
  filename: string,
  contentType = "application/octet-stream",
): Promise<string> {
  const storage = getFirebaseStorage();
  const objectName = `invoices/${randomUUID()}-${safeFilename(filename)}`;

  if (!storage) {
    return `storage-not-configured://${objectName}`;
  }

  const bucket = storage.bucket();
  const file = bucket.file(objectName);

  const stream = file.createWriteStream({
    metadata: { contentType },
    resumable: false,
  });
  stream.end(fileBuffer);

  return new Promise((resolve, reject) => {
    stream.on('finish', async () => {
      resolve(`gs://${bucket.name}/${objectName}`);
    });
    stream.on('error', reject);
  });
}
