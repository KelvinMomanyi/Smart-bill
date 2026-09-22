import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireAdmin } from "../utils/rbac.server";
import {
  reportingCsv,
  reportingForPeriod,
} from "../services/reportingAggregation.server";
import { validDate } from "../utils/invoiceRules";

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await requireAdmin(request);
  const url = new URL(request.url);
  const fromText = url.searchParams.get("from") || "";
  const untilText = url.searchParams.get("until") || "";
  if (!validDate(fromText) || !validDate(untilText))
    throw new Response("Choose a valid report period.", { status: 400 });
  const from = new Date(`${fromText}T00:00:00.000Z`);
  const until = new Date(`${untilText}T00:00:00.000Z`);
  if (until <= from) throw new Response("End date must follow start date.", { status: 400 });
  const data = await reportingForPeriod(session.shop, from, until);
  return new Response(reportingCsv(data), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="smartbill-report-${fromText}-${untilText}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
