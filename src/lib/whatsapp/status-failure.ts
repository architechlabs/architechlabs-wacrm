const MAX_FAILURE_REASON_LENGTH = 500;

export interface MetaStatusError {
  code?: number;
  title?: string;
  message?: string;
  error_data?: {
    details?: string;
  };
}

export interface SanitizedFailureDetails {
  failureCode: number | null;
  failureReason: string | null;
}

/**
 * Keep Meta's useful diagnosis while removing values that should never be
 * persisted or rendered. The webhook payload itself is deliberately not
 * retained.
 */
export function sanitizeFailureText(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(
      /\b(authorization|access[_ -]?token|refresh[_ -]?token|api[_ -]?key|app[_ -]?secret)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bwamid\.[^\s,;]+/gi, "[message id redacted]")
    .replace(
      /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[token redacted]",
    )
    .replace(/https?:\/\/[^\s]+/gi, "[link redacted]")
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[email redacted]",
    )
    .replace(/(?:\+?\d[\d ().-]{5,}\d)/g, (candidate) => {
      const digits = candidate.replace(/\D/g, "");
      return digits.length >= 7 ? "[number redacted]" : candidate;
    })
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[secret redacted]")
    .replace(/\s+/g, " ")
    .trim();

  if (!sanitized) return null;
  return sanitized.slice(0, MAX_FAILURE_REASON_LENGTH);
}

/**
 * Meta documents an errors array on failed delivery status webhooks. The
 * first structured error is the primary cause; retaining one bounded summary
 * avoids storing the raw array or unrelated webhook identifiers.
 */
export function extractFailureDetails(
  errors: MetaStatusError[] | undefined,
): SanitizedFailureDetails | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;

  const first = errors.find(
    (error) =>
      Number.isSafeInteger(error?.code) ||
      typeof error?.title === "string" ||
      typeof error?.message === "string" ||
      typeof error?.error_data?.details === "string",
  );
  if (!first) return null;

  const failureCode =
    Number.isSafeInteger(first.code) && (first.code ?? -1) >= 0
      ? first.code!
      : null;
  const parts = [
    sanitizeFailureText(first.title),
    sanitizeFailureText(first.message),
    sanitizeFailureText(first.error_data?.details),
  ].filter((part): part is string => Boolean(part));
  const uniqueParts = [...new Set(parts)];
  const failureReason =
    uniqueParts.length > 0
      ? uniqueParts.join(" - ").slice(0, MAX_FAILURE_REASON_LENGTH)
      : null;

  if (failureCode === null && failureReason === null) return null;
  return { failureCode, failureReason };
}
