// app/routes/api/vision.ts
import type { ActionFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import vision from "@google-cloud/vision";
import { authenticate } from "../shopify.server";

const client = new vision.ImageAnnotatorClient();

export const action: ActionFunction = async ({ request }) => {
  try {
    await authenticate.admin(request);
    // Manual multipart parsing
    const contentType = request.headers.get("content-type");
    
    if (!contentType?.includes("multipart/form-data")) {
      return json({ success: false, error: "Invalid content type" }, { status: 400 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file || file.size === 0) {
      return json({ success: false, error: "No file provided" }, { status: 400 });
    }

    // Validate file type
    const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/webp', 'application/pdf'];
    if (!validTypes.includes(file.type)) {
      return json({ 
        success: false, 
        error: "Invalid file type. Please upload an image or PDF." 
      }, { status: 400 });
    }

    // Convert to buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Perform OCR
    const [result] = await client.textDetection({ 
      image: { content: buffer } 
    });
    
    const text = result.fullTextAnnotation?.text || "";
    
    return json({ 
      success: true, 
      text,
      filename: file.name,
      size: file.size,
      type: file.type
    });

  } catch (error: any) {
    console.error("OCR API Error:", error);
    return json({ 
      success: false, 
      error: error.message || "OCR processing failed" 
    }, { status: 500 });
  }
};
