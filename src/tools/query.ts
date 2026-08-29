/**
 * Query tool: `priority_query_records`.
 *
 * Reads entity rows with metadata-validated OData options. The CENTRAL
 * safety property (train-3, verified live): every filter/select/orderBy field
 * is validated against the entity's schema BEFORE any HTTP call is made. The
 * vendor SILENTLY SWALLOWS unknown filter fields — an unknown field name
 * returns HTTP 200 with UNFILTERED rows, which for a filter like
 * `ZZZNOPE eq 'x'` looks like success but is a data-integrity bug. We reject
 * those client-side with a typed `validation_error` and zero HTTP calls.
 */

import type { EntitySchema } from "../priority/metadata.js";
import { normalizeUtcSince, ODataBuilder, op } from "../priority/odata.js";
import type { FilterValue } from "../priority/types.js";
import type { ReadToolContext } from "./context.js";
import { validationError } from "./errors.js";

export interface QueryRecordsArgs {
  /** Entity name, UPPERCASE-validated. */
  entity: string;
  /** Raw OData `$filter` expression (escape hatch). Mutually exclusive with filterField. */
  rawFilter?: string;
  /** Simple equality filter field. */
  filterField?: string;
  /** Equality filter value for filterField. */
  filterValue?: string | number;
  /** Result cap: 1..2000, default 50. */
  top?: number;
  /** Offset: non-negative integer. */
  skip?: number;
  /** Fields to return. */
  select?: string[];
  /** Navigation subforms to expand. */
  expand?: string[];
  /** Order-by property name (default ascending). */
  orderBy?: string;
  /** Sort direction when orderBy is set. */
  orderDir?: "asc" | "desc";
  /** `$since` — UTC-Z datetime required. */
  since?: string;
}

export const DEFAULT_TOP = 50;
export const MAX_TOP = 2000;

/** The set of field names valid in a filter for an entity (properties + nav + keys). */
function fieldNameSet(schema: EntitySchema): Set<string> {
  const names = new Set<string>();
  for (const key of schema.keyFields) names.add(key);
  for (const property of schema.properties) names.add(property.name);
  for (const nav of schema.navigationProperties) names.add(nav.name);
  return names;
}

/**
 * Extract `[A-Z_][A-Z0-9_]*` field tokens from an OData expression, ignoring
 * quoted string literals so a literal like `TYPE eq 'ABC'` doesn't mis-flag
 * `ABC` (an actual value, not a field) as an unknown field.
 */
export function extractFilterFieldTokens(expression: string): string[] {
  const withoutStrings = expression.replace(/'((?:[^']|'')*)'/g, " ");
  const out: string[] = [];
  const re = /[A-Z_][A-Z0-9_]*/g;
  for (;;) {
    const match = re.exec(withoutStrings);
    if (match === null) break;
    out.push(match[0]);
  }
  return out;
}

function assertKnownField(schema: EntitySchema, field: string, option: string): void {
  if (!fieldNameSet(schema).has(field)) {
    throw validationError(
      `unknown field "${field}" for entity ${schema.entity} in ${option} — the Priority API ` +
        `silently swallows unknown filter fields (HTTP 200 + unfiltered rows), so this was ` +
        `rejected before any request was sent`,
    );
  }
}

/** Validate a simple equality filter value into an OData literal-compatible value. */
function toFilterValue(value: string | number | undefined): FilterValue {
  if (value === undefined) return "";
  if (typeof value === "number") return value;
  return value.trim();
}

/** Validate every option field/option against the schema BEFORE any HTTP call. */
async function validateOptions(
  ctx: ReadToolContext,
  args: QueryRecordsArgs,
): Promise<{
  schema: EntitySchema;
  top: number;
  orderBy: string | undefined;
  since: string | undefined;
}> {
  const schema = await ctx.meta.getEntitySchema(args.entity);

  if (args.rawFilter !== undefined && args.filterField !== undefined) {
    throw validationError("rawFilter and filterField are mutually exclusive — provide only one");
  }

  if (args.rawFilter !== undefined) {
    const unknown = [
      ...new Set(
        extractFilterFieldTokens(args.rawFilter).filter(
          (token) => !fieldNameSet(schema).has(token),
        ),
      ),
    ];
    if (unknown.length > 0) {
      throw validationError(
        `unknown field(s) ${unknown.join(", ")} in rawFilter for entity ${schema.entity} — ` +
          `the Priority API silently swallows unknown filter fields (HTTP 200 + unfiltered rows), ` +
          `so this was rejected before any request was sent`,
      );
    }
  }

  if (args.filterField !== undefined) assertKnownField(schema, args.filterField, "$filter");
  if (args.select !== undefined) {
    for (const field of args.select) assertKnownField(schema, field, "$select");
  }
  if (args.orderBy !== undefined) assertKnownField(schema, args.orderBy, "$orderby");

  if (args.expand !== undefined) {
    for (const nav of args.expand) {
      if (!schema.navigationProperties.some((candidate) => candidate.name === nav)) {
        if (schema.properties.some((candidate) => candidate.name === nav)) {
          throw validationError(
            `"${nav}" is a property, not a navigation subform, on ${schema.entity} — ` +
              `$expand expects a navigation property name`,
          );
        }
        throw validationError(
          `unknown navigation property "${nav}" for entity ${schema.entity} in $expand`,
        );
      }
    }
  }

  const top = args.top === undefined ? DEFAULT_TOP : args.top;
  if (!Number.isSafeInteger(top) || top < 1 || top > MAX_TOP) {
    throw validationError(`top must be an integer in [1, ${MAX_TOP}]`);
  }

  if (args.skip !== undefined && (!Number.isSafeInteger(args.skip) || args.skip < 0)) {
    throw validationError("skip must be a non-negative integer");
  }

  let since: string | undefined;
  if (args.since !== undefined) {
    // Throws ODataError on non-Z input — convert to a typed validation_error.
    try {
      since = normalizeUtcSince(args.since);
    } catch {
      throw validationError(
        `since must be a UTC datetime ending in Z (e.g. 2020-01-01T07:25:00Z) — got "${args.since}"`,
      );
    }
  }

  const orderBy =
    args.orderBy === undefined
      ? undefined
      : `${args.orderBy} ${args.orderDir === "desc" ? "desc" : "asc"}`;

  return { schema, top, orderBy, since };
}

/** Run a metadata-validated entity query and return the matching rows. */
export async function queryRecords(
  ctx: ReadToolContext,
  args: QueryRecordsArgs,
): Promise<Array<Record<string, unknown>>> {
  if (typeof args.entity !== "string" || args.entity.trim() === "") {
    throw validationError("entity is required");
  }

  const { schema, top, orderBy, since } = await validateOptions(ctx, args);

  const builder = new ODataBuilder().top(top);
  if (args.skip !== undefined) builder.skip(args.skip);
  if (args.select !== undefined && args.select.length > 0) builder.select(args.select);
  if (args.expand !== undefined && args.expand.length > 0) {
    builder.expand(args.expand.map((path) => ({ path })));
  }
  if (orderBy !== undefined) builder.orderby([orderBy]);
  if (since !== undefined) builder.since(since);

  if (args.rawFilter !== undefined) {
    builder.rawFilter(args.rawFilter);
  } else if (args.filterField !== undefined) {
    builder.filter(op(args.filterField, "eq", toFilterValue(args.filterValue)));
  }

  const path = builder.build(schema.entity);
  const response = await ctx.client.get<{ value?: Array<Record<string, unknown>> }>(path, {
    op: path,
  });
  return Array.isArray(response.value) ? response.value : [];
}
