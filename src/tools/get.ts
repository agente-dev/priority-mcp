/**
 * Record get tool: `priority_get_record`.
 *
 * Fetches a single record by key. Priority entities may have COMPOSITE keys
 * (AINVOICES = IVNUM/DEBIT/IVTYPE). A single-key GET on a composite-keyed
 * entity returns HTTP 200 with an ARBITRARY row (verified live) — so the key
 * fields provided MUST exactly match the entity's metadata key fields, in any
 * order. The key segment is built in the order the caller supplies; the API
 * accepts key fields in any order as long as ALL are present.
 *
 * Key fields are validated against `schema.keyFields` BEFORE any HTTP call —
 * a missing key field is a typed `validation_error`, not a silent wrong row.
 */

import { ODataBuilder } from "../priority/odata.js";
import type { ReadToolContext } from "./context.js";
import { validationError } from "./errors.js";

export interface GetRecordArgs {
  /** Entity name, UPPERCASE-validated. */
  entity: string;
  /** Key field → value. Fields must EXACTLY match the entity metadata key fields. */
  key: Record<string, string>;
  /** Optional fields to return (default: all). */
  select?: string[];
}

/**
 * Fetch a single record by its (possibly composite) key. Key fields are
 * validated against the entity's metadata keyFields before any HTTP call.
 */
export async function getRecord(
  ctx: ReadToolContext,
  args: GetRecordArgs,
): Promise<Record<string, unknown>> {
  if (typeof args.entity !== "string" || args.entity.trim() === "") {
    throw validationError("entity is required");
  }
  if (typeof args.key !== "object" || args.key === null) {
    throw validationError("key is required");
  }

  // Resolve the REAL schema first — key validation must never be guessed.
  const schema = await ctx.meta.getEntitySchema(args.entity);

  const provided = Object.keys(args.key);
  const expected = schema.keyFields;

  const missing = expected.filter((field) => !provided.includes(field));
  const extra = provided.filter((field) => !expected.includes(field));
  if (missing.length > 0 || extra.length > 0) {
    const detail =
      missing.length > 0
        ? `missing key field(s): ${missing.join(", ")}`
        : `unexpected key field(s): ${extra.join(", ")}`;
    throw validationError(
      `key for entity ${schema.entity} must exactly match metadata keyFields ` +
        `[${expected.join(", ")}] — ${detail} (a partial key GET returns an arbitrary row, ` +
        `so this was rejected before any request was sent)`,
    );
  }

  // Build the composite key segment in the order the caller supplied.
  const keyMap: Record<string, string> = {};
  for (const field of provided) keyMap[field] = args.key[field] ?? "";

  const builder = new ODataBuilder().keys(keyMap);
  if (args.select !== undefined && args.select.length > 0) {
    // select fields are validated against the schema too (silent-swallow guard).
    for (const field of args.select) {
      if (!schema.properties.some((property) => property.name === field)) {
        throw validationError(
          `unknown field "${field}" for entity ${schema.entity} in $select — rejected before ` +
            `any request was sent`,
        );
      }
    }
    builder.select(args.select);
  }

  const path = builder.build(schema.entity);
  return ctx.client.get<Record<string, unknown>>(path, { op: path });
}
