export function staleInvoiceJobWhere(shop: string | undefined, cutoff: Date) {
  return {
    ...(shop ? { shop } : {}),
    status: "PROCESSING",
    lockedAt: { lt: cutoff },
  };
}

export function queuedInvoiceJobWhere(shop: string | undefined, now: Date) {
  return {
    ...(shop ? { shop } : {}),
    status: "QUEUED",
    availableAt: { lte: now },
  };
}
