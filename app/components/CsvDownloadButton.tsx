import { useState } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { Button } from "@shopify/polaris";

function responseFilename(response: Response) {
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quoted = disposition.match(/filename="([^"]+)"/i)?.[1];
  const plain = disposition.match(/filename=([^;]+)/i)?.[1];
  const candidate = encoded
    ? decodeURIComponent(encoded)
    : quoted || plain?.trim() || "approved-invoices.csv";
  return candidate.replace(/[\\/:*?"<>|\r\n]/g, "-");
}

export function CsvDownloadButton({
  children,
  invoiceId,
  disabled = false,
}: {
  children: string | string[];
  invoiceId?: string;
  disabled?: boolean;
}) {
  const shopify = useAppBridge();
  const [loading, setLoading] = useState(false);

  async function download() {
    setLoading(true);
    try {
      const sessionToken = await shopify.idToken();
      const query = invoiceId
        ? `?invoiceId=${encodeURIComponent(invoiceId)}`
        : "";
      const response = await fetch(`/api/exportCSV${query}`, {
        headers: {
          Accept: "text/csv",
          Authorization: `Bearer ${sessionToken}`,
        },
        credentials: "same-origin",
      });
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok || !contentType.includes("text/csv")) {
        const message = await response.text();
        throw new Error(
          response.ok
            ? "The CSV download returned an authentication page. Reload SmartBill and try again."
            : message.slice(0, 250) || "The CSV download failed.",
        );
      }

      const objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = responseFilename(response);
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      shopify.toast.show("CSV downloaded");
    } catch (error) {
      shopify.toast.show(
        error instanceof Error ? error.message : "The CSV download failed.",
        { isError: true },
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button onClick={download} loading={loading} disabled={disabled || loading}>
      {children}
    </Button>
  );
}
