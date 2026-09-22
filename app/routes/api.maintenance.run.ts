import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { escalateOverdueApprovals } from "../services/approvalRules.server";
import { sendDailyDigest } from "../services/notifications.server";
import { refreshReportingSnapshot } from "../services/reportingAggregation.server";

function authorized(request: Request) {
  const expected = process.env.CRON_SECRET || "";
  const supplied =
    request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return Boolean(
    expected &&
      expectedBytes.length === suppliedBytes.length &&
      timingSafeEqual(expectedBytes, suppliedBytes),
  );
}

export async function loader({ request }: LoaderFunctionArgs | ActionFunctionArgs) {
  if (!authorized(request)) return new Response("Unauthorized", { status: 401 });
  const shops = await prisma.shopSettings.findMany({ select: { shop: true } });
  const now = new Date();
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  const results = [];
  for (const { shop } of shops) {
    const escalated = await escalateOverdueApprovals(shop);
    const notifications = await sendDailyDigest(shop);
    await refreshReportingSnapshot(shop, periodStart, periodEnd, "MONTHLY");
    results.push({
      shop,
      escalated: escalated.length,
      notifications: notifications.filter((result) => result.sent).length,
    });
  }
  return Response.json({ processed: results.length, results });
}

export const action = loader;
