import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { MAX_FILE_BYTES } from "./plans";

export const SUPABASE_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

type SupabaseStorage = {
  client: SupabaseClient;
  bucket: string;
};

let cachedStorage:
  | (SupabaseStorage & { url: string; serviceKey: string })
  | undefined;
let readyBucket:
  | { client: SupabaseClient; bucket: string; promise: Promise<void> }
  | undefined;

function storageError(message: string, cause: unknown) {
  return new Error(message, { cause });
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== "object" || !("status" in error)) return;
  const status = Number(error.status);
  return Number.isFinite(status) ? status : undefined;
}

export function getSupabaseStorage(): SupabaseStorage | null {
  const url = process.env.SUPABASE_URL?.trim();
  const serviceKey = (
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )?.trim();
  const bucket =
    process.env.SUPABASE_STORAGE_BUCKET?.trim() || "smartbill-documents";

  if (!url && !serviceKey) return null;
  if (!url || !serviceKey) {
    throw new Error(
      "Supabase document storage configuration is incomplete. Set SUPABASE_URL and SUPABASE_SECRET_KEY.",
    );
  }
  if (bucket.includes("/") || bucket.includes("\\") || !bucket.trim()) {
    throw new Error("SUPABASE_STORAGE_BUCKET must be a single bucket name.");
  }
  try {
    new URL(url);
  } catch {
    throw new Error("SUPABASE_URL must be a valid project URL.");
  }

  if (
    cachedStorage?.url === url &&
    cachedStorage.serviceKey === serviceKey &&
    cachedStorage.bucket === bucket
  ) {
    return cachedStorage;
  }

  cachedStorage = {
    url,
    serviceKey,
    bucket,
    client: createClient(url, serviceKey, {
      auth: {
        autoRefreshToken: false,
        detectSessionInUrl: false,
        persistSession: false,
      },
    }),
  };
  readyBucket = undefined;
  return cachedStorage;
}

async function configurePrivateBucket({ client, bucket }: SupabaseStorage) {
  const current = await client.storage.getBucket(bucket);
  if (current.error && errorStatus(current.error) !== 404) {
    throw storageError(
      "Unable to inspect the Supabase document bucket. Check the project URL and server secret key.",
      current.error,
    );
  }

  let bucketData = current.data;
  if (!bucketData) {
    const created = await client.storage.createBucket(bucket, {
      public: false,
      fileSizeLimit: MAX_FILE_BYTES,
      allowedMimeTypes: [...SUPABASE_DOCUMENT_MIME_TYPES],
    });
    if (created.error) {
      // Another server instance may have created the bucket concurrently.
      const afterRace = await client.storage.getBucket(bucket);
      if (afterRace.error || !afterRace.data) {
        throw storageError(
          "Unable to create the private Supabase document bucket.",
          created.error,
        );
      }
      bucketData = afterRace.data;
    } else {
      return;
    }
  }

  const allowed = bucketData.allowed_mime_types || [];
  const needsUpdate =
    bucketData.public ||
    bucketData.file_size_limit !== MAX_FILE_BYTES ||
    SUPABASE_DOCUMENT_MIME_TYPES.some((type) => !allowed.includes(type)) ||
    allowed.some(
      (type) =>
        !SUPABASE_DOCUMENT_MIME_TYPES.includes(
          type as (typeof SUPABASE_DOCUMENT_MIME_TYPES)[number],
        ),
    );
  if (!needsUpdate) return;

  const updated = await client.storage.updateBucket(bucket, {
    public: false,
    fileSizeLimit: MAX_FILE_BYTES,
    allowedMimeTypes: [...SUPABASE_DOCUMENT_MIME_TYPES],
  });
  if (updated.error) {
    throw storageError(
      "Unable to secure the Supabase document bucket as private.",
      updated.error,
    );
  }
}

export function ensureSupabaseDocumentBucket(storage: SupabaseStorage) {
  if (
    readyBucket?.client === storage.client &&
    readyBucket.bucket === storage.bucket
  ) {
    return readyBucket.promise;
  }

  const promise = configurePrivateBucket(storage).catch((error) => {
    if (readyBucket?.promise === promise) readyBucket = undefined;
    throw error;
  });
  readyBucket = { ...storage, promise };
  return promise;
}
