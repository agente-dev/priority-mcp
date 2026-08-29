/**
 * Typed error helpers for the tool boundary. Tool-level failures (unknown
 * filter field, composite-key mismatch, invalid $since...) surface as
 * PriorityError with kind `validation_error` — the same typed model the
 * client layer uses, so agents and tests can branch on `error.kind`
 * instead of string-matching vendor messages.
 */
import { priorityError } from "../priority/errors.js";

/** A client-side validation failure — thrown BEFORE any HTTP call is made. */
export function validationError(message: string): import("../priority/errors.js").PriorityError {
  return priorityError("validation_error", { message });
}
