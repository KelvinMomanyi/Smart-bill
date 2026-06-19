import { createHmac, timingSafeEqual } from "node:crypto";

export type AccountingPlatform = "XERO" | "QUICKBOOKS";

type AccountingOAuthState = {
  shop: string;
  platform: AccountingPlatform;
  issuedAt: number;
};

function stateSecret() {
  return process.env.SHOPIFY_API_SECRET || "smartbill-local-oauth-state";
}

function signatureFor(payload: AccountingOAuthState) {
  return createHmac("sha256", stateSecret())
    .update(JSON.stringify(payload))
    .digest("base64url");
}

function signaturesMatch(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function createAccountingState(
  shop: string,
  platform: AccountingPlatform,
) {
  const payload = { shop, platform, issuedAt: Date.now() };
  return Buffer.from(
    JSON.stringify({ payload, signature: signatureFor(payload) }),
    "utf8",
  ).toString("base64url");
}

export function readAccountingState(value?: string | null) {
  if (!value) throw new Error("Missing accounting OAuth state");

  const parsed = JSON.parse(
    Buffer.from(value, "base64url").toString("utf8"),
  ) as { payload?: AccountingOAuthState; signature?: string };

  if (!parsed.payload || !parsed.signature) {
    throw new Error("Invalid accounting OAuth state");
  }

  if (!signaturesMatch(parsed.signature, signatureFor(parsed.payload))) {
    throw new Error("Invalid accounting OAuth state signature");
  }

  const payload = parsed.payload;

  if (!payload.shop || !payload.platform) {
    throw new Error("Invalid accounting OAuth state");
  }

  const stateAgeMs = Date.now() - payload.issuedAt;
  if (!Number.isFinite(stateAgeMs) || stateAgeMs > 30 * 60 * 1000) {
    throw new Error("Expired accounting OAuth state");
  }

  return payload;
}

export function tokenExpiry(expiresIn?: number) {
  if (!expiresIn || !Number.isFinite(expiresIn)) return null;
  return new Date(Date.now() + Math.max(0, expiresIn - 60) * 1000);
}
