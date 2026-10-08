// Legacy business validation uses ordinary Error objects. Keep those useful
// messages, but never pass transport, provider configuration or database details
// through to merchant banners or saved job errors.
export function merchantErrorMessage(error: unknown, fallback: string): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (
    !message ||
    message.length > 600 ||
    (error instanceof Error &&
      /Prisma|SyntaxError|TypeError|ReferenceError/i.test(error.name)) ||
    /HTTP\s*\d{3}|failed to fetch|fetch failed|networkerror|load failed|https?:\/\/|postgres(?:ql)?:|\b(?:SELECT|INSERT|UPDATE|DELETE)\b.+\b(?:FROM|INTO|WHERE|SET)\b|\b(?:access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|stack trace|invalid `prisma|(?:SUPABASE|XERO|QB|SHOPIFY)_[A-Z0-9_]+|DATABASE_URL|P\d{4})\b|\n\s+at\s/i.test(
      message,
    )
  )
    return fallback;
  return message;
}
