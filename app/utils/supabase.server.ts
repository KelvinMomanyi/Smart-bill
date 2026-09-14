import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { MAX_FILE_BYTES } from "./plans";

export const SUPABASE_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/bmp",
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
  const status = errorStatus(cause);
  const code =
    cause && typeof cause === "object" && "code" in cause
      ? String(cause.code || "")
      : "";
  const hint =
    status === 401
      ? " Supabase rejected the server key (HTTP 401). Use an sb_secret_ key from the same project, not a publishable or anon key."
      : status === 403
        ? " Supabase denied Storage administration (HTTP 403). Use the project's server secret key."
        : status === 400
          ? " Supabase rejected the request (HTTP 400). Check the project API URL and bucket name."
          : status
            ? ` Supabase returned HTTP ${status}${code ? ` (${code})` : ""}.`
            : " Supabase could not complete the request; verify that the project is active and its API URL is reachable.";
  return new Error(`${message}${hint}`, { cause });
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== "object") return;
  const directStatus = "status" in error ? error.status : undefined;
  const originalStatus =
    "originalError" in error &&
    error.originalError &&
    typeof error.originalError === "object" &&
    "status" in error.originalError
      ? error.originalError.status
      : undefined;
  const status = Number(directStatus ?? originalStatus);
  return Number.isFinite(status) ? status : undefined;
}

function unquote(value: string) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function normalizeSupabaseProjectUrl(value: string) {
  const rawUrl = unquote(value);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("SUPABASE_URL must be a valid project API URL.");
  }
  const localHttp =
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp)
    throw new Error("SUPABASE_URL must use HTTPS.");
  if (
    parsed.hostname === "supabase.com" ||
    parsed.hostname === "www.supabase.com" ||
    parsed.hostname.includes(".storage.supabase.")
  ) {
    throw new Error(
      "SUPABASE_URL must be the project API URL, such as https://PROJECT_REF.supabase.co, not a dashboard, Storage, or S3 URL.",
    );
  }
  if (/^\/storage\/v1\/?$/i.test(parsed.pathname)) {
    parsed.pathname = "/";
  } else if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      "SUPABASE_URL must not contain a path. Use the project API URL ending in .supabase.co.",
    );
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.origin;
}

function legacyKeyRole(key: string) {
  if (!key.startsWith("eyJ")) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(key.split(".")[1] || "", "base64url").toString("utf8"),
    );
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

export function normalizeSupabaseServerKey(value: string) {
  const key = unquote(value);
  const legacyRole = legacyKeyRole(key);
  if (key.startsWith("sb_publishable_") || legacyRole === "anon") {
    throw new Error(
      "SUPABASE_SECRET_KEY contains a publishable/anon key. Copy the server secret key beginning with sb_secret_ from Supabase Project Settings > API Keys.",
    );
  }
  if (key.startsWith("sb_secret_") || legacyRole === "service_role") return key;
  throw new Error(
    "SUPABASE_SECRET_KEY is not a recognized server key. Use an sb_secret_ key, or the legacy service_role JWT from the same project.",
  );
}

export function getSupabaseStorage(): SupabaseStorage | null {
  const configuredUrl = process.env.SUPABASE_URL?.trim();
  const configuredServiceKey = (
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
  )?.trim();
  const bucket =
    process.env.SUPABASE_STORAGE_BUCKET?.trim() || "smartbill-documents";

  if (!configuredUrl && !configuredServiceKey) return null;
  if (!configuredUrl || !configuredServiceKey) {
    throw new Error(
      "Supabase document storage configuration is incomplete. Set SUPABASE_URL and SUPABASE_SECRET_KEY.",
    );
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(bucket)) {
    throw new Error(
      "SUPABASE_STORAGE_BUCKET must be a single name using letters, numbers, dots, hyphens, or underscores.",
    );
  }
  const url = normalizeSupabaseProjectUrl(configuredUrl);
  const serviceKey = normalizeSupabaseServerKey(configuredServiceKey);

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
