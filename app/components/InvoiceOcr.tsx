import { useEffect, useRef, useState } from "react";
import { Link } from "@remix-run/react";
import { Banner, BlockStack, Text } from "@shopify/polaris";
import {
  processInvoiceInBrowser,
  validateBrowserOcrFile,
  type BrowserOcrProgress,
  type BrowserOcrResult,
} from "../utils/browserOcr";

async function requestJson(url: string, body?: FormData) {
  const response = await fetch(
    url,
    body ? { method: "POST", body } : undefined,
  );
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "Unable to reach SmartBill. Reload the app to restore your session, then retry.",
    );
  const data = await response.json();
  if (!response.ok || data.success === false || data.error)
    throw new Error(data.error || "The document request failed. Please retry.");
  return data;
}

function jobForm(intent: string, jobId: string) {
  const form = new FormData();
  form.set("intent", intent);
  form.set("jobId", jobId);
  return form;
}

export function useInvoiceOcr(onSaved: () => void) {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BrowserOcrProgress>({
    status: "",
    progress: 0,
  });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<
    Array<{ filename: string; invoiceId: string }>
  >([]);
  const [preview, setPreview] = useState<
    (BrowserOcrResult & { filename: string }) | null
  >(null);
  const [previewUrl, setPreviewUrl] = useState("");
  useEffect(() => {
    if (!preview) return;
    const url = URL.createObjectURL(preview.preview);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [preview]);
  useEffect(() => {
    if (!busy) return;
    const preventClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventClose);
    return () => window.removeEventListener("beforeunload", preventClose);
  }, [busy]);

  async function recognizeAndSave(file: File, jobId: string) {
    try {
      const result = await processInvoiceInBrowser(file, (value) =>
        setProgress({ ...value, status: file.name + ": " + value.status }),
      );
      setPreview({ ...result, filename: file.name });
      setProgress({
        status: file.name + ": Saving invoice for review...",
        progress: 100,
      });
      const body = jobForm("complete-browser-ocr", jobId);
      body.set("rawText", result.rawText);
      body.set("pageCount", String(result.pageCount));
      const data = await requestJson("/api/jobs", body);
      setSaved((items) => [
        ...items,
        { filename: file.name, invoiceId: data.invoiceId },
      ]);
      onSaved();
    } catch (failure) {
      const message =
        failure instanceof Error ? failure.message : "OCR processing failed.";
      const body = jobForm("fail-browser-ocr", jobId);
      body.set("error", message);
      await requestJson("/api/jobs", body).catch(() => undefined);
      throw failure;
    }
  }

  async function run(work: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setSaved([]);
    setPreview(null);
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "OCR processing failed.",
      );
    } finally {
      running.current = false;
      setBusy(false);
      onSaved();
    }
  }

  async function capture(
    files: File[],
    metadata: { vendorName: string; purchaseOrderId: string },
  ) {
    await run(async () => {
      files.forEach(validateBrowserOcrFile);
      const failures: string[] = [];
      for (const file of files) {
        try {
          setProgress({
            status: file.name + ": Storing original document...",
            progress: 0,
          });
          const body = new FormData();
          body.set("file", file);
          body.set("processor", "browser");
          body.set("batchSize", String(files.length));
          body.set("vendorName", metadata.vendorName);
          body.set("purchaseOrderId", metadata.purchaseOrderId);
          const data = await requestJson("/api/upload-invoice", body);
          if (data.status === "COMPLETED" && data.invoiceId) {
            setSaved((items) => [
              ...items,
              { filename: file.name, invoiceId: data.invoiceId },
            ]);
          } else {
            await recognizeAndSave(file, data.jobId);
          }
        } catch (failure) {
          failures.push(
            file.name +
              ": " +
              (failure instanceof Error ? failure.message : "Capture failed."),
          );
        }
      }
      if (failures.length) throw new Error(failures.join(" • "));
    });
  }

  async function retry(jobId: string) {
    await run(async () => {
      setProgress({ status: "Opening original document...", progress: 0 });
      const document = await requestJson(
        "/api/jobs/document?jobId=" + encodeURIComponent(jobId),
      );
      // The scoped URL expires in 60 seconds and needs no server secret.
      const response = await fetch(document.url, { credentials: "omit" });
      if (!response.ok)
        throw new Error(
          "Unable to download the original document. Please retry.",
        );
      const file = new File([await response.blob()], document.filename, {
        type: document.contentType,
      });
      await recognizeAndSave(file, jobId);
    });
  }
  return { busy, progress, error, saved, preview, previewUrl, capture, retry };
}

export function InvoiceOcrStatus({
  ocr,
}: {
  ocr: ReturnType<typeof useInvoiceOcr>;
}) {
  return (
    <BlockStack gap="300">
      {ocr.busy && (
        <div role="status" aria-live="polite">
          <Text as="p">{ocr.progress.status}</Text>
          <progress
            value={ocr.progress.progress}
            max={100}
            aria-label="Invoice recognition progress"
            style={{ width: "100%" }}
          />
          <Text as="p">
            {ocr.progress.progress}% complete. Keep this page open.
          </Text>
        </div>
      )}
      {ocr.error && <Banner tone="critical">{ocr.error}</Banner>}
      {ocr.saved.length > 0 && (
        <Banner tone="success" title="Invoices saved for review">
          {ocr.saved.map((item, index) => (
            <p key={item.invoiceId + "-" + index}>
              <Link to={"/app/invoices/" + item.invoiceId}>
                {item.filename}: Review invoice
              </Link>
            </p>
          ))}
        </Banner>
      )}
      {ocr.preview && (
        <details>
          <summary>
            OCR preview: {ocr.preview.filename} ({ocr.preview.pageCount} pages, {Math.round(ocr.preview.confidence)}% recognition confidence)
          </summary>
          {ocr.previewUrl && (
            <img
              src={ocr.previewUrl}
              alt="Invoice document, first page"
              style={{ maxWidth: "100%", maxHeight: 400, objectFit: "contain" }}
            />
          )}
          <label>
            Extracted invoice text
            <textarea
              readOnly
              value={ocr.preview.rawText}
              rows={10}
              style={{ width: "100%" }}
            />
          </label>
          <Text as="p" tone="subdued">
            Confirm currency, decimal amounts, tax and total before approving
            the invoice. Recognition confidence is a reading aid, not an
            accounting validation.
          </Text>
        </details>
      )}
    </BlockStack>
  );
}
