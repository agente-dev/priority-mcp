/**
 * Typed error model for the Priority OData client.
 *
 * Every failure the client surfaces is a `PriorityError` whose `kind` is
 * exactly one of the eight kinds below, with a `retryable` flag. Only
 * `network_error` and `rate_limited` are retryable — timeouts on writes are
 * NEVER retried (Priority has no idempotency mechanism; a blind retry can
 * double-post and double-bill an API transaction), and server errors surface
 * as `server_error` (retryable only inside the client's read path, where
 * GETs are idempotent).
 *
 * Verified wire facts (docs/priority-api-verified.md):
 * - Error envelope is OData v4 JSON `{"error":{"code","message"}}`; messages
 *   can be Hebrew (per language routing) — passed through verbatim with a
 *   `lang: "he"` marker.
 * - 401/404 responses on the live sandbox carry an EMPTY body (verified
 *   live) — kind mapping must work from the HTTP status alone.
 * - HTTP 200 carrying an error envelope is tolerated as
 *   `unexpected_response`.
 *
 * `redact(secret)` is applied on every error escape path so credentials
 * (password/PAT/app-key) never leak into thrown messages.
 */

/** The exact set of error kinds the client can produce. */
export type PriorityErrorKind =
  | "authentication_failed"
  | "validation_error"
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "network_error"
  | "timeout_uncertain"
  | "unexpected_response";

/** All kinds, in canonical order (useful for exhaustive checks). */
export const PRIORITY_ERROR_KINDS: readonly PriorityErrorKind[] = [
  "authentication_failed",
  "validation_error",
  "not_found",
  "rate_limited",
  "server_error",
  "network_error",
  "timeout_uncertain",
  "unexpected_response",
] as const;

/** Common fields carried by every `PriorityError`. */
export interface PriorityErrorFields {
  readonly kind: PriorityErrorKind;
  readonly message: string;
  readonly retryable: boolean;
  /** HTTP status when the failure came from a response. */
  readonly httpStatus?: number;
  /** Vendor envelope `code`, when the body carried one. */
  readonly code?: string;
  /** `"he"` when the message is Hebrew (pass-through, never translated). */
  readonly lang?: "he" | undefined;
  /** Operation label, e.g. "GET AINVOICES?$top=1". */
  readonly op?: string;
}

/**
 * Concrete error class. Instance values are assignable to the
 * `PriorityError` union shape.
 */
export class PriorityError extends Error {
  readonly kind: PriorityErrorKind;
  readonly retryable: boolean;
  readonly httpStatus?: number;
  readonly code?: string;
  readonly lang?: "he" | undefined;
  readonly op?: string;

  constructor(fields: PriorityErrorFields) {
    super(fields.message);
    this.name = "PriorityError";
    this.kind = fields.kind;
    this.retryable = fields.retryable;
    this.httpStatus = fields.httpStatus;
    this.code = fields.code;
    this.lang = fields.lang;
    this.op = fields.op;
  }

  /**
   * Defensive redaction: replace every occurrence of `secret` in the message.
   * The client calls this with the configured password (or PAT token) and
   * app key before any error escapes. Secrets shorter than 4 characters are
   * skipped — a 3-char password like `PAT` would otherwise mangle normal
   * words inside messages.
   */
  redact(secret: string): this {
    if (secret.length >= 4 && this.message.includes(secret)) {
      this.message = this.message.split(secret).join("[REDACTED]");
    }
    return this;
  }
}

const HEBREW_RE = /[\u0590-\u05FF]/;

/** True when a message contains Hebrew characters (pass-through marker). */
export function isHebrewText(text: string): boolean {
  return HEBREW_RE.test(text);
}

/** Only network errors and 429 rate limits are retryable. */
export function isRetryableKind(kind: PriorityErrorKind): boolean {
  return kind === "network_error" || kind === "rate_limited";
}

/** Build a typed error from a raw kind, deriving `retryable` from the kind. */
export function priorityError(
  kind: PriorityErrorKind,
  fields: Omit<PriorityErrorFields, "kind" | "retryable">,
): PriorityError {
  return new PriorityError({ kind, retryable: isRetryableKind(kind), ...fields });
}

/** Narrow an unknown value to `PriorityError`. */
export function isPriorityError(value: unknown): value is PriorityError {
  return value instanceof PriorityError && PRIORITY_ERROR_KINDS.includes(value.kind);
}

/**
 * Map an HTTP status to its error kind. 401/403 authenticate failed; 400 is
 * a validation error; 404 not found; 429 rate limited; 5xx server error;
 * anything else (including 200 with an error envelope) is unexpected.
 */
export function kindForHttpStatus(status: number): PriorityErrorKind {
  if (status === 401 || status === 403) return "authentication_failed";
  if (status === 400) return "validation_error";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "unexpected_response";
}

/** Standard reason phrase for a status code (falls back to the number). */
function statusText(status: number): string {
  const reason = REASONS.get(status);
  return reason === undefined ? String(status) : reason;
}

const REASONS: ReadonlyMap<number, string> = new Map([
  [400, "Bad Request"],
  [401, "Unauthorized"],
  [403, "Forbidden"],
  [404, "Not Found"],
  [405, "Method Not Allowed"],
  [429, "Too Many Requests"],
  [500, "Internal Server Error"],
  [502, "Bad Gateway"],
  [503, "Service Unavailable"],
  [504, "Gateway Timeout"],
]);

function truncate(text: string, max = 400): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Build a `PriorityError` from an HTTP response: parse the OData v4 error
 * envelope when the body carries one, pass Hebrew messages through verbatim,
 * and fall back to the status line for empty/non-JSON bodies (verified
 * live: 401 and 404 come back with 0-byte bodies).
 */
export function fromHttpError(
  status: number,
  bodyText: string,
  options: { op?: string } = {},
): PriorityError {
  const kind = kindForHttpStatus(status);
  let message: string | undefined;
  let code: string | undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    parsed = null;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "error" in parsed &&
    typeof parsed.error === "object" &&
    parsed.error !== null
  ) {
    const envelope = parsed.error as { code?: unknown; message?: unknown };
    if (typeof envelope.message === "string" && envelope.message !== "") {
      message = envelope.message;
    }
    if (typeof envelope.code === "string" || typeof envelope.code === "number") {
      code = String(envelope.code);
    }
  }

  const op = options.op === undefined ? "" : ` calling ${options.op}`;
  if (message === undefined) {
    message =
      bodyText.trim() === ""
        ? `HTTP ${status} (${statusText(status)})${op}`
        : `HTTP ${status} (${statusText(status)}): ${truncate(bodyText)}${op}`;
  } else {
    message = `${message}${op}`;
  }

  return new PriorityError({
    kind,
    retryable: isRetryableKind(kind),
    message,
    httpStatus: status,
    code,
    lang: isHebrewText(message) ? "he" : undefined,
    op: options.op,
  });
}

/** A network-level failure (fetch rejected, no response received). Retryable. */
export function networkError(message: string, op?: string): PriorityError {
  return priorityError("network_error", { message, op });
}

/**
 * A request timed out. Retryable flag is false: on writes the outcome is
 * unknown (no idempotency mechanism exists — never blind-retry); on reads
 * the client's read path maps timeouts to retryable network errors instead.
 */
export function timeoutUncertain(op: string, timeoutMs: number): PriorityError {
  return priorityError("timeout_uncertain", {
    message: `request ${op} timed out after ${timeoutMs}ms; outcome is uncertain`,
    op,
  });
}

/** An unexpected response shape (e.g. HTTP 200 carrying an error envelope). */
export function unexpectedResponse(message: string, options: { op?: string } = {}): PriorityError {
  return priorityError("unexpected_response", { message, op: options.op });
}
