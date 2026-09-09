import { timingSafeEqual } from "node:crypto";
import type { ActionFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { requireShopSubscription } from "../services/billing.server";
import { enqueueDocument } from "../services/invoiceJobs.server";
import { MAX_FILE_BYTES } from "../utils/plans";
// Postmark inbound webhook: configure HTTP Basic credentials smartbill:<secret>.
export async function action({ request }: ActionFunctionArgs) {
  const secret = process.env.INBOUND_EMAIL_SECRET;
  const auth = request.headers.get("authorization") || "";
  const supplied = auth.startsWith("Basic ")
    ? Buffer.from(auth.slice(6), "base64")
    : Buffer.alloc(0);
  const expected = Buffer.from(`smartbill:${secret || ""}`);
  if (
    !secret ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return new Response("Unauthorized", { status: 401 });
  const body = await request.text();
  if (body.length > 25 * 1024 * 1024)
    return new Response("Message too large", { status: 413 });
  try {
    const email = JSON.parse(body) as {
      ToFull?: { Email: string }[];
      Attachments?: { Name: string; Content: string; ContentType: string }[];
    };
    const domain = process.env.INBOUND_EMAIL_DOMAIN?.toLowerCase();
    const addresses =
      email.ToFull?.map((r) => r.Email?.toLowerCase()).filter(Boolean) || [];
    const aliases = addresses
      .filter((a) => a.split("@")[1] === domain)
      .map((a) => a.split("@")[0]);
    const settings = await prisma.shopSettings.findMany({
      where: { inboundAlias: { in: aliases } },
    });
    if (settings.length !== 1)
      return new Response("Unknown or ambiguous inbox", { status: 422 });
    const shop = settings[0].shop;
    const plan = await requireShopSubscription(shop, "bulk");
    const attachments = email.Attachments || [];
    if (!attachments.length || attachments.length > 10)
      return new Response("Include 1–10 invoice attachments", { status: 422 });
    const outcomes = [];
    for (const attachment of attachments) {
      if (
        typeof attachment.Content !== "string" ||
        attachment.Content.length > Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4
      )
        throw new Error("Attachment exceeds 10 MB.");
      const job = await enqueueDocument({
        shop,
        plan,
        buffer: Buffer.from(attachment.Content, "base64"),
        filename: attachment.Name,
        contentType: attachment.ContentType,
      });
      outcomes.push({ id: job.id, status: job.status });
    }
    return Response.json({ accepted: outcomes });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Email capture failed.",
      },
      { status: 422 },
    );
  }
}
