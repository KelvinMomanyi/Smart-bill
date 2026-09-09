import prisma from "../db.server";
import { requireAdmin } from "../utils/rbac.server";
import { requireSubscription } from "./billing.server";
import { assertApproved, assertCurrencyMatch } from "../utils/invoiceRules";
import { fetchShopCurrency } from "./invoiceWorkflow.server";
import { variantsByIds } from "./invoiceReview.server";
import { lockInvoice } from "./invoiceLock.server";
import type { authenticate } from "../shopify.server";

type Admin = Awaited<ReturnType<typeof authenticate.admin>>["admin"];
async function writeCost(admin: Admin, inventoryItemId: string, cost: number) {
  const response = await admin.graphql(
    `#graphql
    mutation SmartBillCost($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id } userErrors { message } }
    }`,
    { variables: { id: inventoryItemId, input: { cost } } },
  );
  const body = await response.json();
  if (
    ("errors" in body && body.errors) ||
    !body.data?.inventoryItemUpdate?.inventoryItem ||
    body.data.inventoryItemUpdate.userErrors.length
  )
    throw new Error(
      "Shopify did not confirm the cost update. Refresh the preview and verify the current cost before retrying.",
    );
}
export async function prepareCostSync(request: Request, invoiceId: string) {
  const { session, admin, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, shop: session.shop },
    include: { items: true },
  });
  if (!invoice) throw new Error("Invoice not found.");
  assertApproved(invoice);
  if (
    invoice.cogsSyncStatus === "SYNCED" &&
    !(await prisma.costChange.count({
      where: { invoiceId, shop: session.shop },
    }))
  )
    throw new Error(
      "This invoice was synced by an older version. Verify its costs directly in Shopify; repeating that sync is blocked.",
    );
  const currency = await fetchShopCurrency(admin);
  assertCurrencyMatch(invoice.currency, currency);
  const items = invoice.items.filter((i) => i.syncCost);
  if (!items.length)
    throw new Error("Select at least one product line for cost sync.");
  if (items.some((i) => !i.matchConfirmed || !i.shopifyVariantId))
    throw new Error(
      "Confirm a Shopify variant for every line selected for cost sync.",
    );
  if (new Set(items.map((i) => i.shopifyVariantId)).size !== items.length)
    throw new Error(
      "Multiple lines target the same variant. Select one net unit cost per variant.",
    );
  const variants = await variantsByIds(
    admin,
    items.map((i) => i.shopifyVariantId!),
  );
  await prisma.$transaction(async (tx) => {
    const latest = await lockInvoice(tx, session.shop, invoiceId);
    assertApproved(latest);
    if (latest.revision !== invoice.revision)
      throw new Error("Invoice changed; review it again.");
    if (latest.costChanges.some((c) => c.status !== "PLANNED"))
      throw new Error(
        "Cost changes already exist. Check their status in the history.",
      );
    await tx.costChange.deleteMany({ where: { invoiceId, status: "PLANNED" } });
    await tx.costChange.createMany({
      data: items.map((item) => {
        const variant = variants.find((v) => v.id === item.shopifyVariantId)!;
        if (variant.inventoryItem.unitCost)
          assertCurrencyMatch(
            variant.inventoryItem.unitCost.currencyCode,
            currency,
          );
        return {
          shop: session.shop,
          invoiceId,
          invoiceItemId: item.id,
          inventoryItemId: variant.inventoryItem.id,
          variantId: variant.id,
          previousCost: variant.inventoryItem.unitCost
            ? Number(variant.inventoryItem.unitCost.amount)
            : null,
          newCost: item.price,
          currency,
          actor,
          status: "PLANNED",
        };
      }),
    });
  });
}
export async function syncApprovedCosts(request: Request, invoiceId: string) {
  const { session, admin, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const currency = await fetchShopCurrency(admin);
  const changes = await prisma.$transaction(async (tx) => {
    const invoice = await lockInvoice(tx, session.shop, invoiceId);
    assertApproved(invoice);
    assertCurrencyMatch(invoice.currency, currency);
    if (invoice.cogsSyncStatus === "SYNCING")
      throw new Error(
        "A cost sync is already running. Check the history before retrying.",
      );
    const planned = invoice.costChanges.filter((c) => c.status === "PLANNED");
    if (!planned.length) throw new Error("Preview the proposed costs first.");
    await tx.invoice.update({
      where: { id: invoiceId },
      data: { cogsSyncStatus: "SYNCING" },
    });
    return planned;
  });
  let failures = 0;
  for (const change of changes) {
    try {
      const [variant] = await variantsByIds(admin, [change.variantId]);
      const current = variant.inventoryItem.unitCost
        ? Number(variant.inventoryItem.unitCost.amount)
        : null;
      if (current !== change.previousCost)
        throw new Error(
          "The Shopify cost changed after preview. No overwrite was attempted.",
        );
      await prisma.costChange.update({
        where: { id: change.id },
        data: { status: "APPLYING" },
      });
      await writeCost(admin, change.inventoryItemId, change.newCost);
      await prisma.costChange.update({
        where: { id: change.id },
        data: { status: "APPLIED", error: null },
      });
      await prisma.auditEvent.create({
        data: {
          shop: session.shop,
          invoiceId,
          actor,
          action: "COST_UPDATED",
          detail: {
            variantId: change.variantId,
            previousCost: change.previousCost,
            newCost: change.newCost,
            currency,
          },
        },
      });
    } catch (error) {
      failures += 1;
      await prisma.costChange.update({
        where: { id: change.id },
        data: {
          status: "VERIFY",
          error:
            error instanceof Error
              ? error.message
              : "Verify the current Shopify cost.",
        },
      });
    }
  }
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { cogsSyncStatus: failures ? "PARTIAL" : "SYNCED" },
  });
  if (failures)
    throw new Error(
      "Some costs need verification. Check each result in the cost history.",
    );
}
export async function restoreCost(request: Request, changeId: string) {
  const { session, admin, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const change = await prisma.costChange.findFirst({
    where: { id: changeId, shop: session.shop },
  });
  if (!change || change.status !== "APPLIED")
    throw new Error("Only confirmed applied costs can be restored.");
  if (change.previousCost == null)
    throw new Error(
      "This variant had no previous cost. Clear its cost manually in Shopify if needed.",
    );
  const [variant] = await variantsByIds(admin, [change.variantId]);
  assertCurrencyMatch(change.currency, await fetchShopCurrency(admin));
  if (Number(variant.inventoryItem.unitCost?.amount) !== change.newCost)
    throw new Error(
      "The cost has changed since this update. Restore was blocked to preserve the newer value.",
    );
  const claim = await prisma.costChange.updateMany({
    where: { id: changeId, status: "APPLIED" },
    data: { status: "RESTORING" },
  });
  if (!claim.count) throw new Error("Another request is restoring this cost.");
  try {
    await writeCost(admin, change.inventoryItemId, change.previousCost);
    await prisma.$transaction([
      prisma.costChange.update({
        where: { id: changeId },
        data: { status: "RESTORED" },
      }),
      prisma.invoice.update({
        where: { id: change.invoiceId },
        data: { cogsSyncStatus: "RESTORED" },
      }),
      prisma.auditEvent.create({
        data: {
          shop: session.shop,
          invoiceId: change.invoiceId,
          actor,
          action: "COST_RESTORED",
          detail: { changeId },
        },
      }),
    ]);
  } catch (error) {
    await prisma.costChange.update({
      where: { id: changeId },
      data: {
        status: "VERIFY_RESTORE",
        error:
          "Restore response was not confirmed. Verify the cost in Shopify.",
      },
    });
    throw error;
  }
}

export async function verifyCost(request: Request, changeId: string) {
  const { session, admin, actor } = await requireAdmin(request);
  await requireSubscription(request);
  const change = await prisma.costChange.findFirst({
    where: { id: changeId, shop: session.shop },
  });
  if (
    !change ||
    !["VERIFY", "VERIFY_RESTORE", "APPLYING", "RESTORING", "PLANNED"].includes(
      change.status,
    )
  )
    throw new Error("This cost does not need recovery.");
  if (
    ["APPLYING", "RESTORING", "PLANNED"].includes(change.status) &&
    Date.now() - change.updatedAt.getTime() < 15 * 60 * 1000
  )
    throw new Error(
      "Allow 15 minutes for an interrupted sync to finish before recovering it.",
    );
  assertCurrencyMatch(change.currency, await fetchShopCurrency(admin));
  const [variant] = await variantsByIds(admin, [change.variantId]);
  const current = variant.inventoryItem.unitCost
    ? Number(variant.inventoryItem.unitCost.amount)
    : null;
  const restoring = ["VERIFY_RESTORE", "RESTORING"].includes(change.status);
  const status =
    current === change.newCost
      ? "APPLIED"
      : current === change.previousCost
        ? restoring
          ? "RESTORED"
          : "PLANNED"
        : null;
  if (!status)
    throw new Error(
      "Shopify now has a different cost. Review that value directly in Shopify; automatic recovery cannot overwrite it.",
    );
  await prisma.$transaction(async (tx) => {
    await lockInvoice(tx, session.shop, change.invoiceId);
    const updated = await tx.costChange.updateMany({
      where: {
        id: changeId,
        status: change.status,
        updatedAt: change.updatedAt,
      },
      data: { status, error: null },
    });
    if (!updated.count)
      throw new Error("Cost history changed. Reload it before recovery.");
    const changes = await tx.costChange.findMany({
      where: { invoiceId: change.invoiceId },
    });
    await tx.invoice.update({
      where: { id: change.invoiceId },
      data: {
        cogsSyncStatus: changes.every((c) => c.status === "APPLIED")
          ? "SYNCED"
          : changes.every((c) => c.status === "RESTORED")
            ? "RESTORED"
            : "PARTIAL",
      },
    });
    await tx.auditEvent.create({
      data: {
        shop: session.shop,
        invoiceId: change.invoiceId,
        actor,
        action: "COST_VERIFIED",
        detail: { changeId, current, status },
      },
    });
  });
}
