/**
 * OData v4 query builder for the Priority REST API.
 *
 * Verified wire facts (docs/priority-api-verified.md + live probes):
 * - String literals are quoted with apostrophes; embedded apostrophes are
 *   DOUBLED (`O'Brien` → `O''Brien`), never stripped — the injection-safe
 *   OData escaping rule.
 * - Date/datetime values use DateTimeOffset literals; `$since` MUST be UTC
 *   with a trailing `Z` (DST-proof) — non-Z input is rejected.
 * - URL encoding: spaces → `%20`, `+` (in numeric offsets) → `%2B`,
 *   semicolons in nested `$expand` options → `%3B` (IIS strips raw `;`).
 *   OData syntax characters servers expect raw (`$`, `(`, `)`, `,`, `=`,
 *   `'`) are left unencoded.
 * - Composite keys: `AINVOICES(IVNUM='T00000001',IVTYPE='A',DEBIT='D')`.
 *   A single-key GET on such an entity returns HTTP 200 with an arbitrary
 *   row (verified live) — callers MUST provide every key field (the key
 *   fields come from entity metadata, see MetadataStore).
 * - `URLSearchParams` is deliberately NOT used: it encodes spaces as `+`,
 *   which breaks the documented `%20` form seen in live requests.
 *
 * Field names are validated UPPERCASE (`[A-Z][A-Z0-9_]*`) so wrong-case
 * fields fail fast instead of triggering the server's silent filter swallow
 * (a bad filter field returns HTTP 200 with unfiltered rows).
 */

/** Error thrown by the builder for invalid input (client-side, offline). */
export class ODataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ODataError";
  }
}

export type FilterOp = "eq" | "ne" | "gt" | "ge" | "lt" | "le";

export type FilterNode =
  | { kind: "op"; field: string; op: FilterOp; value: import("./types.js").FilterValue }
  | { kind: "and"; parts: FilterNode[] }
  | { kind: "or"; parts: FilterNode[] }
  | { kind: "paren"; node: FilterNode };

export function op(
  field: string,
  filterOp: FilterOp,
  value: import("./types.js").FilterValue,
): FilterNode {
  assertFieldName(field);
  return { kind: "op", field, op: filterOp, value };
}

export function and(...parts: FilterNode[]): FilterNode {
  if (parts.length === 0) throw new ODataError("and() requires at least one operand");
  return { kind: "and", parts };
}

export function or(...parts: FilterNode[]): FilterNode {
  if (parts.length === 0) throw new ODataError("or() requires at least one operand");
  return { kind: "or", parts };
}

export function paren(node: FilterNode): FilterNode {
  return { kind: "paren", node };
}

/** Quote a string as an OData literal, doubling embedded apostrophes. */
export function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Render a filter value as an OData literal. */
export function literal(value: import("./types.js").FilterValue): string {
  if (typeof value === "string") return quoteString(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof Date) return toDateTimeOffset(value);
  return quoteString(String(value));
}

/** Render a Date as a DateTimeOffset literal in UTC ("2020-01-01T07:25:00Z"). */
export function toDateTimeOffset(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

const UTC_DATETIME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z$/i;

/**
 * Validate that `value` is a UTC datetime ending in `Z` and normalize it
 * (uppercase Z, fractional seconds stripped). Rejects offset datetimes
 * (`+02:00`) — `$since` must be UTC-Z per the verified reference.
 */
export function normalizeUtcSince(value: string): string {
  const match = UTC_DATETIME_RE.exec(value);
  if (match === null) {
    throw new ODataError(
      `$since must be a UTC datetime ending in Z (e.g. 2020-01-01T07:25:00Z), got "${value}"`,
    );
  }
  const base = match[1];
  if (base === undefined) {
    throw new ODataError(`$since must be a UTC datetime ending in Z, got "${value}"`);
  }
  return `${base}Z`;
}

/** Render a filter node tree to an OData `$filter` expression. */
export function renderFilter(node: FilterNode): string {
  switch (node.kind) {
    case "op":
      return `${node.field} ${node.op} ${literal(node.value)}`;
    case "and":
      return node.parts.map(renderFilter).join(" and ");
    case "or":
      return node.parts.map(renderFilter).join(" or ");
    case "paren":
      return `(${renderFilter(node.node)})`;
  }
}

const FIELD_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** Field names are UPPERCASE and case-sensitive (verified reference). */
function assertFieldName(field: string): void {
  if (!FIELD_NAME_RE.test(field)) {
    throw new ODataError(
      `field names must be UPPERCASE ([A-Z][A-Z0-9_]*) — got "${field}" — ` +
        "wrong-case fields fail silently server-side (filter swallow)",
    );
  }
}

export const ENTITY_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Percent-encode a value for use in an OData query string.
 *
 * `encodeURIComponent` leaves `A-Za-z0-9-_.!~*'()` raw and encodes the rest;
 * we additionally re-allow the OData syntax characters servers expect raw
 * (`/`, `:`, `@`, `$`, `,`, `=`, `[`, `]`) while KEEPING encoded the
 * documented-critical ones: space `%20`, plus `%2B` (datetime offsets),
 * semicolon `%3B` (nested expand options), plus `#?&%"`-class separators.
 */
export function encodeODataValue(value: string): string {
  return encodeURIComponent(value)
    .replace(/%2F/g, "/")
    .replace(/%3A/g, ":")
    .replace(/%40/g, "@")
    .replace(/%24/g, "$")
    .replace(/%2C/g, ",")
    .replace(/%3D/g, "=")
    .replace(/%5B/g, "[")
    .replace(/%5D/g, "]");
}

/** Unbound OData function call segment, e.g. `GetMetadataFor(entity='AINVOICES')`. */
export function functionCall(
  name: string,
  params?: Record<string, import("./types.js").FilterValue>,
): string {
  if (params === undefined) return name;
  return `${name}(${Object.entries(params)
    .map(([key, value]) => `${key}=${literal(value)}`)
    .join(",")})`;
}

export interface ExpandSpec {
  /** Navigation property name, e.g. "AINVOICEITEMS_SUBFORM". */
  path: string;
  /** Nested `$select` options (separated with `;` → encoded `%3B`). */
  select?: string[];
  /** Nested `$orderby` options. */
  orderby?: string[];
}

/**
 * Fluent OData query builder. `build(entity)` returns the relative request
 * path (e.g. `AINVOICES(IVNUM='T00000001',IVTYPE='A',DEBIT='D')?$top=1`),
 * deterministic — suitable as a cache key.
 */
export class ODataBuilder {
  private filterNode: FilterNode | undefined;
  private rawFilterValue: string | undefined;
  private topValue: number | undefined;
  private skipValue: number | undefined;
  private selectList: string[] | undefined;
  private expandList: ExpandSpec[] | undefined;
  private orderbyList: string[] | undefined;
  private sinceValue: string | undefined;
  private keyMap: Record<string, import("./types.js").FilterValue> | undefined;

  /**
   * Composite-key segment, e.g.
   * `keySegment({IVNUM:'T00000001',IVTYPE:'A',DEBIT:'D'})` →
   * `(IVNUM='T00000001',IVTYPE='A',DEBIT='D')`.
   */
  static keySegment(keys: Record<string, import("./types.js").FilterValue>): string {
    const entries = Object.entries(keys);
    if (entries.length === 0) throw new ODataError("keySegment requires at least one key");
    for (const [field] of entries) assertFieldName(field);
    return `(${entries.map(([field, value]) => `${field}=${literal(value)}`).join(",")})`;
  }

  filter(node: FilterNode): this {
    if (this.rawFilterValue !== undefined) {
      throw new ODataError("cannot combine filter() and rawFilter() on one query");
    }
    this.filterNode = node;
    return this;
  }

  /**
   * Set the `$filter` clause from a raw OData expression string (escape
   * hatch for expressions the node composer cannot express). Mutually
   * exclusive with `filter()`. The caller is responsible for validating the
   * expression's field names against entity metadata BEFORE calling this —
   * the vendor silently ignores unknown filter fields (HTTP 200 +
   * unfiltered rows), so the guard lives at the tool boundary.
   */
  rawFilter(expression: string): this {
    if (this.filterNode !== undefined) {
      throw new ODataError("cannot combine filter() and rawFilter() on one query");
    }
    if (typeof expression !== "string" || expression.trim() === "") {
      throw new ODataError("a raw $filter expression must be a non-empty string");
    }
    this.rawFilterValue = expression;
    return this;
  }

  top(value: number): this {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ODataError("$top must be a positive integer");
    }
    this.topValue = value;
    return this;
  }

  skip(value: number): this {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ODataError("$skip must be a non-negative integer");
    }
    this.skipValue = value;
    return this;
  }

  select(fields: string[]): this {
    this.selectList = [...fields];
    return this;
  }

  expand(specs: ExpandSpec[]): this {
    this.expandList = [...specs];
    return this;
  }

  orderby(clauses: string[]): this {
    this.orderbyList = [...clauses];
    return this;
  }

  /** `$since` — UTC only; a Date is converted, a string must end in `Z`. */
  since(value: Date | string): this {
    this.sinceValue = value instanceof Date ? toDateTimeOffset(value) : normalizeUtcSince(value);
    return this;
  }

  /** Entity keys (composite or single) — key segment added to the path. */
  keys(keys: Record<string, import("./types.js").FilterValue>): this {
    this.keyMap = { ...keys };
    return this;
  }

  /** Relative request path for the entity, e.g. `AINVOICES?$top=5&$select=IVNUM`. */
  build(entityName: string): string {
    if (!ENTITY_NAME_RE.test(entityName)) {
      throw new ODataError(
        `entity names must be UPPERCASE ([A-Z][A-Z0-9_]*) — got "${entityName}"`,
      );
    }
    const path =
      this.keyMap === undefined
        ? entityName
        : `${entityName}${ODataBuilder.keySegment(this.keyMap)}`;

    const params: string[] = [];
    if (this.topValue !== undefined) params.push(`$top=${this.topValue}`);
    if (this.skipValue !== undefined) params.push(`$skip=${this.skipValue}`);
    if (this.filterNode !== undefined) {
      params.push(`$filter=${encodeODataValue(renderFilter(this.filterNode))}`);
    } else if (this.rawFilterValue !== undefined) {
      params.push(`$filter=${encodeODataValue(this.rawFilterValue)}`);
    }
    if (this.selectList !== undefined && this.selectList.length > 0) {
      params.push(`$select=${encodeODataValue(this.selectList.join(","))}`);
    }
    if (this.expandList !== undefined && this.expandList.length > 0) {
      const rendered = this.expandList
        .map((spec) => {
          const inner: string[] = [];
          if (spec.select !== undefined && spec.select.length > 0) {
            inner.push(`$select=${spec.select.join(",")}`);
          }
          if (spec.orderby !== undefined && spec.orderby.length > 0) {
            inner.push(`$orderby=${spec.orderby.join(",")}`);
          }
          return inner.length === 0 ? spec.path : `${spec.path}(${inner.join(";")})`;
        })
        .join(",");
      params.push(`$expand=${encodeODataValue(rendered)}`);
    }
    if (this.orderbyList !== undefined && this.orderbyList.length > 0) {
      params.push(`$orderby=${encodeODataValue(this.orderbyList.join(","))}`);
    }
    if (this.sinceValue !== undefined) params.push(`$since=${this.sinceValue}`);

    return params.length === 0 ? path : `${path}?${params.join("&")}`;
  }
}
