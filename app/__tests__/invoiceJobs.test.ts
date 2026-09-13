import assert from "node:assert/strict";
import { test } from "node:test";
import {
  queuedInvoiceJobWhere,
  staleInvoiceJobWhere,
} from "../utils/invoiceJobs";

test("browser-triggered queue filters are restricted to the signed-in shop", () => {
  const now = new Date("2026-09-13T12:00:00Z");
  const cutoff = new Date("2026-09-13T11:45:00Z");
  assert.deepEqual(queuedInvoiceJobWhere("shop-a.myshopify.com", now), {
    shop: "shop-a.myshopify.com",
    status: "QUEUED",
    availableAt: { lte: now },
  });
  assert.deepEqual(staleInvoiceJobWhere("shop-a.myshopify.com", cutoff), {
    shop: "shop-a.myshopify.com",
    status: "PROCESSING",
    lockedAt: { lt: cutoff },
  });
});
