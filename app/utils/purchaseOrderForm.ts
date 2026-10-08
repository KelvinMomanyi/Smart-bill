export type PoFormRow = {
  sku: string;
  name: string;
  quantity: string;
  rate: string;
};

export type PoFormValues = {
  vendorName: string;
  poNumber: string;
  expectedDate: string;
  notes: string;
  itemRows: string;
  items: PoFormRow[];
};

export type PoField =
  | "vendorName"
  | "poNumber"
  | "expectedDate"
  | "notes"
  | "submissionId"
  | "items";
export type PoFieldErrors = Partial<Record<PoField, string>>;

export function emptyPoRow(): PoFormRow {
  return { sku: "", name: "", quantity: "1", rate: "" };
}

export function formText(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

export function readPoFormValues(form: FormData): PoFormValues {
  let items: PoFormRow[] = [];
  // Named controls are authoritative, including before React has hydrated.
  if (form.has("itemName")) {
    const names = form.getAll("itemName");
    const skus = form.getAll("itemSku");
    const quantities = form.getAll("itemQuantity");
    const rates = form.getAll("itemRate");
    items = names.map((name, index) => ({
      name: formText(name),
      sku: formText(skus[index]),
      quantity: formText(quantities[index]),
      rate: formText(rates[index]),
    }));
  } else {
    // Accept earlier clients that submitted a JSON snapshot of their rows.
    try {
      const parsed = JSON.parse(formText(form.get("structuredItems")) || "[]");
      if (Array.isArray(parsed))
        items = parsed.map((item) => ({
          name: formText(item?.name),
          sku: formText(item?.sku),
          quantity: formText(item?.expectedQty ?? item?.quantity),
          rate: formText(item?.expectedRate ?? item?.rate),
        }));
    } catch {
      /* Validation reports malformed legacy JSON separately. */
    }
  }
  return {
    vendorName: formText(form.get("vendorName")),
    poNumber: formText(form.get("poNumber")),
    expectedDate: formText(form.get("expectedDate")),
    notes: formText(form.get("notes")),
    itemRows: formText(form.get("itemRows")),
    items: items.length ? items : [emptyPoRow()],
  };
}
