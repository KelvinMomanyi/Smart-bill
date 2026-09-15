import { useEffect, useRef, useState } from "react";
import { Link } from "@remix-run/react";
import { Banner, BlockStack, Button, Text } from "@shopify/polaris";
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

function throwUploadCancelled(signal: AbortSignal) {
  if (!signal.aborted) return;
  const error = new Error("Invoice upload was cancelled.");
  error.name = "AbortError";
  throw error;
}

export function useInvoiceOcr(onSaved: () => void) {
  const running = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const activeJob = useRef<{ id: string; filename: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeFilename, setActiveFilename] = useState("");
  const [progress, setProgress] = useState<BrowserOcrProgress>({
    status: "",
    progress: 0,
  });
  const [error, setError] = useState("");
  const [deleted, setDeleted] = useState("");
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

  async function recognizeAndSave(
    file: File,
    jobId: string,
    signal: AbortSignal,
  ) {
    try {
      const result = await processInvoiceInBrowser(
        file,
        (value) =>
          setProgress({ ...value, status: file.name + ": " + value.status }),
        undefined,
        signal,
      );
      throwUploadCancelled(signal);
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
      if (signal.aborted) throw failure;
      const message =
        failure instanceof Error ? failure.message : "OCR processing failed.";
      const body = jobForm("fail-browser-ocr", jobId);
      body.set("error", message);
      await requestJson("/api/jobs", body).catch(() => undefined);
      throw failure;
    }
  }

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (running.current) return;
    const runController = new AbortController();
    running.current = true;
    controller.current = runController;
    activeJob.current = null;
    setBusy(true);
    setCancelling(false);
    setError("");
    setDeleted("");
    setSaved([]);
    setPreview(null);
    try {
      await work(runController.signal);
    } catch (failure) {
      if (runController.signal.aborted) {
        const job = activeJob.current as {
          id: string;
          filename: string;
        } | null;
        if (job) {
          try {
            await requestJson("/api/jobs", jobForm("delete-upload", job.id));
            setDeleted(job.filename + " was deleted.");
          } catch (cleanupFailure) {
            setError(
              cleanupFailure instanceof Error
                ? cleanupFailure.message
                : "OCR stopped, but the uploaded document could not be deleted.",
            );
          }
        } else {
          setDeleted("The invoice upload was cancelled.");
        }
      } else {
        setError(
          failure instanceof Error ? failure.message : "OCR processing failed.",
        );
      }
    } finally {
      controller.current = null;
      activeJob.current = null;
      running.current = false;
      setBusy(false);
      setCancelling(false);
      setActiveFilename("");
      onSaved();
    }
  }

  async function capture(
    files: File[],
    metadata: { vendorName: string; purchaseOrderId: string },
  ) {
    await run(async (signal) => {
      files.forEach(validateBrowserOcrFile);
      const failures: string[] = [];
      for (const file of files) {
        throwUploadCancelled(signal);
        setActiveFilename(file.name);
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
          activeJob.current = { id: data.jobId, filename: file.name };
          throwUploadCancelled(signal);
          if (data.status === "COMPLETED" && data.invoiceId) {
            setSaved((items) => [
              ...items,
              { filename: file.name, invoiceId: data.invoiceId },
            ]);
          } else {
            await recognizeAndSave(file, data.jobId, signal);
          }
        } catch (failure) {
          if (signal.aborted) throw failure;
          failures.push(
            file.name +
              ": " +
              (failure instanceof Error ? failure.message : "Capture failed."),
          );
        } finally {
          if (!signal.aborted) activeJob.current = null;
        }
      }
      if (failures.length) throw new Error(failures.join(" • "));
    });
  }

  async function retry(jobId: string) {
    await run(async (signal) => {
      activeJob.current = { id: jobId, filename: "Uploaded document" };
      setProgress({ status: "Opening original document...", progress: 0 });
      try {
        const document = await requestJson(
          "/api/jobs/document?jobId=" + encodeURIComponent(jobId),
        );
        activeJob.current = { id: jobId, filename: document.filename };
        setActiveFilename(document.filename);
        // The scoped URL expires in 60 seconds and needs no server secret.
        const response = await fetch(document.url, {
          credentials: "omit",
          signal,
        });
        if (!response.ok)
          throw new Error(
            "Unable to download the original document. Please retry.",
          );
        const file = new File([await response.blob()], document.filename, {
          type: document.contentType,
        });
        await recognizeAndSave(file, jobId, signal);
      } finally {
        if (!signal.aborted) activeJob.current = null;
      }
    });
  }

  function cancel() {
    if (!controller.current || controller.current.signal.aborted) return;
    setCancelling(true);
    setProgress({
      status: activeFilename
        ? activeFilename + ": Deleting uploaded document..."
        : "Deleting uploaded document...",
      progress: progress.progress,
    });
    controller.current.abort();
  }

  return {
    busy,
    cancelling,
    activeFilename,
    progress,
    error,
    deleted,
    saved,
    preview,
    previewUrl,
    capture,
    retry,
    cancel,
  };
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
          <Button
            tone="critical"
            disabled={ocr.cancelling}
            loading={ocr.cancelling}
            onClick={() => {
              if (
                window.confirm(
                  `Delete ${ocr.activeFilename || "this uploaded document"}? Processing will stop and the original file will be removed.`,
                )
              )
                ocr.cancel();
            }}
          >
            Delete upload
          </Button>
        </div>
      )}
      {ocr.error && <Banner tone="critical">{ocr.error}</Banner>}
      {ocr.deleted && <Banner tone="success">{ocr.deleted}</Banner>}
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
