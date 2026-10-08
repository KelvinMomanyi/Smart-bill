import assert from "node:assert/strict";
import { test } from "node:test";
import { merchantErrorMessage } from "../utils/merchantErrors";
import {
  accountingRequest,
  AccountingApiError,
} from "../utils/accountingHttp.server";

test("merchant errors keep useful validation and suppress transport, database and credential details", () => {
  const fallback = "Please try again.";
  assert.equal(
    merchantErrorMessage(new Error("Supplier is required."), fallback),
    "Supplier is required.",
  );
  for (const message of [
    "HTTP 400",
    "Failed to fetch",
    "fetch failed",
    "postgresql://private:secret@host",
    "Invalid `prisma.invoice.create()` invocation",
    "SUPABASE_SECRET_KEY is missing",
    "accessToken=private",
    "x".repeat(601),
  ])
    assert.equal(merchantErrorMessage(new Error(message), fallback), fallback);
  assert.equal(
    merchantErrorMessage(new TypeError("Unexpected response"), fallback),
    fallback,
  );
});

test("provider errors retain retry classification without exposing remote error bodies or HTTP codes", async (t) => {
  let status = 400;
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        Fault: {
          Error: [
            {
              Detail:
                "private token and internal endpoint https://private.example",
            },
          ],
        },
      },
      { status },
    ),
  );
  for (const code of [400, 401, 403, 422, 429, 500, 503]) {
    status = code;
    await assert.rejects(
      accountingRequest("QuickBooks", "https://test.invalid"),
      (error: unknown) => {
        assert.ok(error instanceof AccountingApiError);
        assert.equal(error.status, code);
        assert.equal(error.rejected, code < 500);
        assert.doesNotMatch(error.message, /HTTP|private|endpoint/);
        return true;
      },
    );
  }
});
