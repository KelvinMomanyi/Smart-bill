// app/routes/api.upload-invoice.ts
import type { ActionFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { uploadInvoiceImage } from "../utils/upload.server";
import { extractTextFromFile } from "../utils/ocr.server";
import { authenticate } from "../shopify.server";

export const action: ActionFunction = async ({ request }) => {
  try {
    await authenticate.admin(request);
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return json({ error: "No file provided" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let extractedText = "";
    let uploadUrl = "";

    if (
      !file.type.startsWith("image/") &&
      file.type !== "application/pdf" &&
      !file.name.toLowerCase().endsWith(".pdf")
    ) {
      return json(
        { error: "Upload an invoice image or PDF." },
        { status: 400 },
      );
    }

    try {
      extractedText = await extractTextFromFile(buffer, {
        filename: file.name,
        mimeType: file.type,
      });
    } catch (ocrError) {
      console.error("OCR failed:", ocrError);
      // Continue with upload even if OCR fails.
    }

    // Upload to Firebase
    try {
      uploadUrl = await uploadInvoiceImage(buffer, file.name, file.type);
    } catch (uploadError) {
      console.error("Upload failed:", uploadError);
      return json({ error: "File upload failed" }, { status: 500 });
    }

    return json({
      success: true,
      uploadUrl,
      extractedText,
      filename: file.name,
    });
  } catch (error) {
    console.error("Processing failed:", error);
    return json({ error: "Processing failed" }, { status: 500 });
  }
};
