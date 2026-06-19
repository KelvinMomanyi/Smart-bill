import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { createInvoiceFromInput } from "../services/invoiceWorkflow.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
    const { imageUrl, ocrText, syncCogs, purchaseOrderId, vendorName } = await request.json();
    const result = await createInvoiceFromInput({
      request,
      shop: session.shop,
      imageUrl,
      rawText: ocrText,
      syncCogs: Boolean(syncCogs),
      purchaseOrderId: purchaseOrderId || null,
      vendorName: vendorName || null,
    });

    return json({
      success: true,
      invoice: result.invoice,
      syncResult: result.syncResult,
      reconciliationResult: result.reconciliationResult,
      warnings: result.warnings,
    });
  } catch (error) {
    return json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
};
