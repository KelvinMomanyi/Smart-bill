import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTimestamp } from "../utils/format";

test("history timestamps are identical across server and merchant timezones", () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ["UTC", "Africa/Nairobi", "America/Los_Angeles"]) {
      process.env.TZ = zone;
      assert.equal(formatTimestamp("2026-10-09T10:51:50.743Z"), "2026-10-09 10:51:50 UTC");
      assert.equal(formatTimestamp("2026-10-09T00:05:00.000Z"), "2026-10-09 00:05:00 UTC");
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
  assert.equal(formatTimestamp("invalid"), "Date unavailable");
});
