import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
function encryptionKey() {
  const configured = process.env.ACCOUNTING_TOKEN_KEY?.trim();
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32)
      throw new Error(
        "ACCOUNTING_TOKEN_KEY must be a base64-encoded 32-byte key.",
      );
    return key;
  }
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret)
    throw new Error("Accounting token encryption is not configured.");
  return Buffer.from(
    hkdfSync("sha256", secret, "smartbill-accounting-v1", "token-storage", 32),
  );
}
export function sealAccountingSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return [
    "enc",
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}
export function openAccountingSecret(value: string) {
  // Existing installations migrate plaintext tokens on their next refresh/read.
  if (!value.startsWith("enc:")) return value;
  const [prefix, version, iv, tag, ciphertext] = value.split(":");
  if (prefix !== "enc" || version !== "v1" || !iv || !tag || !ciphertext)
    throw new Error(
      "Accounting credentials could not be read. Reconnect the company.",
    );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
