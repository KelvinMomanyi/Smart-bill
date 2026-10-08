import { merchantErrorMessage } from "../utils/merchantErrors";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  json,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "@remix-run/react";
import { Page, Card, BlockStack, Text, Banner, Button } from "@shopify/polaris";
import prisma from "../db.server";
import { requireAdmin } from "../utils/rbac.server";
import { requireSubscription } from "../services/billing.server";
import { refreshPurchaseOrder } from "../services/poReconciliation.server";
import { receiptStatus } from "../utils/poMatching";
import { AppErrorState } from "../components/AppErrorState";
import { formatMoney } from "../utils/format";
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await requireAdmin(request);
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: params.id, shop: session.shop },
    include: {
      vendor: true,
      items: true,
      receipts: { include: { items: true }, orderBy: { receivedAt: "desc" } },
    },
  });
  return json({ po, requestKey: randomUUID() });
}
export async function action({ request, params }: ActionFunctionArgs) {
  const { session, actor } = await requireAdmin(request);
  const form = await request.formData();
  const id = params.id || "";
  try {
    await requireSubscription(request);
    const requestKey = String(form.get("requestKey"));
    if (!/^[a-f0-9-]{36}$/.test(requestKey))
      throw new Error("Reload the receipt form.");
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM "PurchaseOrder" WHERE id = ${id} AND shop = ${session.shop} FOR UPDATE`,
      );
      const po = await tx.purchaseOrder.findFirst({
        where: { id, shop: session.shop },
        include: { items: true },
      });
      if (!po) throw new Error("Purchase order not found.");
      if (
        await tx.goodsReceipt.findFirst({
          where: { requestKey, shop: session.shop, purchaseOrderId: id },
        })
      )
        return;
      const rows = po.items.map((i) => ({
        purchaseOrderItemId: i.id,
        quantity: Number(form.get(`qty:${i.id}`) || 0),
      }));
      if (
        rows.some(
          (r) =>
            !Number.isFinite(r.quantity) ||
            r.quantity < 0 ||
            r.quantity > 1000000000,
        )
      )
        throw new Error("Enter valid delivery quantities.");
      const received = rows.filter((r) => r.quantity > 0);
      if (!received.length)
        throw new Error("Enter a received quantity for at least one item.");
      const receipt = await tx.goodsReceipt.create({
        data: {
          shop: session.shop,
          purchaseOrderId: id,
          actor,
          requestKey,
          reference: String(form.get("reference") || "")
            .trim()
            .slice(0, 200),
          items: { create: received },
        },
      });
      for (const row of received)
        await tx.purchaseOrderItem.update({
          where: { id: row.purchaseOrderItemId },
          data: { receivedQty: { increment: row.quantity } },
        });
      const status = receiptStatus(
        po.items.map((item) => ({
          expectedQty: item.expectedQty,
          receivedQty:
            item.receivedQty +
            (rows.find((row) => row.purchaseOrderItemId === item.id)
              ?.quantity || 0),
        })),
      );
      await tx.purchaseOrder.update({
        where: { id },
        data: { status },
      });
      await tx.auditEvent.create({
        data: {
          shop: session.shop,
          actor,
          action: "GOODS_RECEIVED",
          detail: {
            receiptId: receipt.id,
            purchaseOrderId: id,
            items: received,
          },
        },
      });
    });
    await refreshPurchaseOrder(session.shop, id);
    return json({
      success: true as const,
      message: "Physical receipt recorded.",
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    return json(
      {
        success: false as const,
        error: merchantErrorMessage(error, "Receipt failed."),
      },
      { status: 400 },
    );
  }
}
export default function ReceiveStock() {
  const { po, requestKey } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  if (!po)
    return (
      <AppErrorState
        title="Purchase order not found"
        message="This purchase order is unavailable in your store. It may have been removed."
        backTo="/app/reconciliation"
        backLabel="Back to purchase orders"
      />
    );
  return (
    <Page
      title={`Receive ${po.poNumber || po.id.slice(0, 8)}`}
      subtitle={po.vendor.name}
      backAction={{ url: "/app/reconciliation" }}
    >
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Purchase order details
            </Text>
            <Text as="p">
              Expected delivery:{" "}
              {po.expectedDate
                ? new Date(po.expectedDate).toISOString().slice(0, 10)
                : "Not specified"}
            </Text>
            <Text as="p">
              Expected total: {formatMoney(po.totalAmount || 0, po.currency)} (
              {po.currency})
            </Text>
            {po.notes && <Text as="p">Notes: {po.notes}</Text>}
            {po.items.map((item) => (
              <Text as="p" key={item.id}>
                {item.name}: {item.expectedQty} ×{" "}
                {item.expectedRate == null
                  ? "Unit cost not specified"
                  : formatMoney(item.expectedRate, po.currency)}
              </Text>
            ))}
          </BlockStack>
        </Card>
        {result && (
          <Banner tone={result.success ? "success" : "critical"}>
            {result.success ? result.message : result.error}
          </Banner>
        )}
        <Card>
          <Form method="post" key={requestKey}>
            <input type="hidden" name="requestKey" value={requestKey} />
            <BlockStack gap="300">
              <Text as="p">
                Enter only the quantities physically delivered now. Previous
                deliveries are preserved. This records a receipt in SmartBill;
                it does not adjust Shopify stock levels.
              </Text>
              <label>
                Delivery note / reference <input name="reference" />
              </label>
              {po.items.map((i) => (
                <label key={i.id}>
                  {i.sku ? i.sku + " — " : ""}
                  {i.name} · Ordered {i.expectedQty} · Received {i.receivedQty}{" "}
                  · Billed {i.billedQty}
                  <br />
                  Received in this delivery{" "}
                  <input
                    type="number"
                    name={`qty:${i.id}`}
                    min={0}
                    step="any"
                    defaultValue={0}
                  />
                </label>
              ))}
              <Button submit variant="primary" loading={busy}>
                Record physical receipt
              </Button>
            </BlockStack>
          </Form>
        </Card>
        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">
              Delivery history
            </Text>
            {po.receipts.length ? (
              po.receipts.map((r) => (
                <Text as="p" key={r.id}>
                  {new Date(r.receivedAt).toLocaleString()} —{" "}
                  {r.reference || "Delivery"} —{" "}
                  {r.items.reduce((s, i) => s + i.quantity, 0)} units —{" "}
                  {r.actor}
                </Text>
              ))
            ) : (
              <Text as="p">No physical receipts recorded.</Text>
            )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  );
}
