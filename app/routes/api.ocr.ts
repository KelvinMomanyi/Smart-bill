import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { extractTextFromDocument } from "../utils/ocr.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    await authenticate.admin(request);
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return json(
        { success: false, error: "No file provided" },
        { status: 400 },
      );
    }

    if (
      !file.type.startsWith("image/") &&
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      return json(
        { success: false, error: "File must be an image or PDF" },
        { status: 400 },
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const result = await extractTextFromDocument(buffer, {
      filename: file.name,
      mimeType: file.type,
    });

    return json({
      success: true,
      confidence: result.confidence,
      pageCount: result.pageCount,
      source: result.source,
      text: result.text,
    });
  } catch (error) {
    console.error("OCR processing failed:", error);
    return json(
      { success: false, error: "OCR processing failed" },
      { status: 500 },
    );
  }
};
