/**
 * Shared types for the priority-mcp client layer.
 *
 * These mirror the wire shapes verified in docs/priority-api-verified.md:
 * OData v4 JSON list responses, function results, and error envelopes.
 */

/** Accepted filter-value types. Strings are OData-quoted, numbers/booleans literal, Dates as DateTimeOffset. */
export type FilterValue = string | number | boolean | Date;

/**
 * OData v4 JSON list response, e.g. entity sets:
 * `{"@odata.context": "...", "value": [ ... ]}`.
 */
export interface ODataListResponse<T> {
  "@odata.context"?: string;
  "@odata.count"?: number;
  value: T[];
}

/**
 * OData v4 function result, e.g. GetPriorityVersion:
 * `{"@odata.context": "...", "value": "25.0-..."}`.
 */
export interface ODataFunctionResult {
  "@odata.context"?: string;
  value?: unknown;
}

/**
 * OData v4 error envelope, `{"error":{"code","message"}}`. Messages may arrive
 * in Hebrew (per language routing); `code` may be a number or string.
 */
export interface ODataErrorEnvelope {
  error?: {
    code?: string | number;
    message?: string;
  };
}

/** Guard for object types after JSON round-trips. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
