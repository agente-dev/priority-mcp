/**
 * Write tools (train 4): create/update/delete/upload_attachment/set_text.
 *
 * Safety contract (all verified by unit tests + live sandbox):
 * - GATED BY OMISSION: none of these are registered while PRIORITY_READ_ONLY
 *   is true (the default) — the write surface is absent from tools/list, not
 *   merely refused at call time.
 * - dryRun defaults TRUE: no HTTP call is made; the exact body that would be
 *   sent is returned for inspection.
 * - Metadata-validated BEFORE HTTP: unknown field names, unknown subforms,
 *   bad data URIs and partial composite keys are typed validation_errors —
 *   the vendor silently swallows unknowns in some paths and returns
 *   plausible-looking wrong results, so nothing unvalidated is ever sent.
 * - Post-write verification: creates/updates re-fetch the record; deletes
 *   re-fetch expecting absence. `verified` tells the truth.
 * - NO idempotency claims: the vendor has no idempotency mechanism and every
 *   written record bills an API transaction — annotations say so.
 */

import { PriorityError } from "../priority/errors.js";
import type { EntitySchema } from "../priority/metadata.js";
import { ODataBuilder } from "../priority/odata.js";
import type { ReadToolContext } from "./context.js";
import { validationError } from "./errors.js";

export interface CreateRecordArgs {
  entity: string;
  fields: Record<string, unknown>;
  subforms?: Record<string, Array<Record<string, unknown>>>;
  dryRun?: boolean;
}

export interface UpdateRecordArgs {
  entity: string;
  key: Record<string, string>;
  fields: Record<string, unknown>;
  dryRun?: boolean;
}

export interface DeleteRecordArgs {
  entity: string;
  key: Record<string, string>;
  confirm?: boolean;
  dryRun?: boolean;
}

export interface UploadAttachmentArgs {
  entity: string;
  key: Record<string, string>;
  fileLabel: string;
  dataUri: string;
  suffix?: string;
  dryRun?: boolean;
}

export interface SetTextArgs {
  entity: string;
  key: Record<string, string>;
  textForm: string;
  text: string;
  append?: boolean;
  signature?: boolean;
  dryRun?: boolean;
}

const MAX_ATTACHMENT_BYTES = 2_000_000;

/** Property names valid as plain fields on the entity. */
function propertyNames(schema: EntitySchema): Set<string> {
  return new Set(schema.properties.map((property) => property.name));
}

/** Navigation property names (subforms) on the entity. */
function navigationNames(schema: EntitySchema): Set<string> {
  return new Set(schema.navigationProperties.map((nav) => nav.name));
}

/** Enforce that key fields exactly match the entity's metadata keyFields. */
function assertKeyExact(schema: EntitySchema, key: Record<string, string>): Record<string, string> {
  const provided = Object.keys(key);
  const expected = schema.keyFields;
  const missing = expected.filter((field) => !provided.includes(field));
  const extra = provided.filter((field) => !expected.includes(field));
  if (missing.length > 0 || extra.length > 0) {
    const detail =
      missing.length > 0
        ? `missing key field(s): ${missing.join(", ")}`
        : `unexpected key field(s): ${extra.join(", ")}`;
    throw validationError(
      `key for entity ${schema.entity} must exactly match metadata keyFields [${expected.join(", ")}] — ${detail}`,
    );
  }
  const out: Record<string, string> = {};
  for (const field of provided) out[field] = key[field] ?? "";
  return out;
}

/** Validate plain fields + subform names against the schema; returns the checked body. */
function validateWriteBody(
  schema: EntitySchema,
  fields: Record<string, unknown>,
  subforms: Record<string, Array<Record<string, unknown>>> | undefined,
): Record<string, unknown> {
  const props = propertyNames(schema);
  for (const field of Object.keys(fields)) {
    if (!props.has(field)) {
      throw validationError(
        `unknown field "${field}" for entity ${schema.entity} — rejected before any request was sent`,
      );
    }
  }
  const body: Record<string, unknown> = { ...fields };
  if (subforms !== undefined) {
    const navs = navigationNames(schema);
    for (const [name, rows] of Object.entries(subforms)) {
      if (!navs.has(name)) {
        throw validationError(
          `unknown subform "${name}" for entity ${schema.entity} — valid subforms: ` +
            [...navs].join(", "),
        );
      }
      if (!Array.isArray(rows) || rows.length === 0) {
        throw validationError(`subform "${name}" must be a non-empty array of row objects`);
      }
      body[name] = rows;
    }
  }
  return body;
}

/** Mandatory-property presence check (25.1+ metadata annotation; absent → no-op). */
function assertMandatoryPresent(schema: EntitySchema, body: Record<string, unknown>): void {
  const mandatory = schema.properties.filter((property) => property.mandatory);
  if (mandatory.length === 0) return; // annotations not available pre-25.1
  const missing = mandatory
    .filter((property) => !(property.name in body))
    .filter((property) => !schema.keyFields.includes(property.name))
    .map((property) => property.name);
  if (missing.length > 0) {
    throw validationError(
      `missing mandatory field(s) ${missing.join(", ")} for entity ${schema.entity}`,
    );
  }
}

/** Build the keyed entity path (composite-key aware). */
function keyedPath(entity: string, key: Record<string, string>): string {
  return new ODataBuilder().keys(key).build(entity);
}

/** Extract the created record's key from its returned representation. */
function keyFromRecord(
  schema: EntitySchema,
  record: Record<string, unknown>,
): Record<string, string> {
  const key: Record<string, string> = {};
  for (const field of schema.keyFields) {
    const value = record[field];
    if (value === undefined || value === null) {
      throw new PriorityError({
        kind: "unexpected_response",
        message: `created ${schema.entity} record is missing key field "${field}" — cannot verify`,
        retryable: false,
      });
    }
    key[field] = String(value);
  }
  return key;
}

function dryRunResult(action: string, wouldSend: unknown): Record<string, unknown> {
  return {
    dryRun: true,
    action,
    wouldSend,
    note: "No changes were made. Set dryRun=false to execute.",
  };
}

/** Create a record (optionally with subform rows), then verify by re-fetch. */
export async function createRecord(
  ctx: ReadToolContext,
  args: CreateRecordArgs,
): Promise<Record<string, unknown>> {
  if (typeof args.entity !== "string" || args.entity.trim() === "") {
    throw validationError("entity is required");
  }
  if (typeof args.fields !== "object" || args.fields === null) {
    throw validationError("fields is required");
  }
  const schema = await ctx.meta.getEntitySchema(args.entity);
  const body = validateWriteBody(schema, args.fields, args.subforms);
  assertMandatoryPresent(schema, body);
  if (args.dryRun !== false) return dryRunResult(`CREATE ${schema.entity}`, body);

  const created = await ctx.client.post<Record<string, unknown>>(
    new ODataBuilder().build(schema.entity),
    body,
  );
  const key = keyFromRecord(schema, created);
  let verified = false;
  let refetched: Record<string, unknown> | undefined;
  try {
    refetched = await ctx.client.get<Record<string, unknown>>(keyedPath(schema.entity, key));
    verified = true;
  } catch {
    verified = false;
  }
  return { created: true, key, record: created, verified, refetched };
}

/** Update a record by exact key, then verify by re-fetch. */
export async function updateRecord(
  ctx: ReadToolContext,
  args: UpdateRecordArgs,
): Promise<Record<string, unknown>> {
  if (typeof args.entity !== "string" || args.entity.trim() === "") {
    throw validationError("entity is required");
  }
  if (typeof args.key !== "object" || args.key === null) {
    throw validationError("key is required");
  }
  if (
    typeof args.fields !== "object" ||
    args.fields === null ||
    Object.keys(args.fields).length === 0
  ) {
    throw validationError("fields is required (non-empty)");
  }
  const schema = await ctx.meta.getEntitySchema(args.entity);
  const key = assertKeyExact(schema, args.key);
  const body = validateWriteBody(schema, args.fields, undefined);
  if (args.dryRun !== false) return dryRunResult(`UPDATE ${schema.entity}`, { key, body });

  const updated = await ctx.client.patch<Record<string, unknown>>(
    keyedPath(schema.entity, key),
    body,
  );
  let verified = false;
  let refetched: Record<string, unknown> | undefined;
  try {
    refetched = await ctx.client.get<Record<string, unknown>>(keyedPath(schema.entity, key));
    verified = true;
  } catch {
    verified = false;
  }
  return { updated: true, key, record: updated, verified, refetched };
}

/** Delete a record by exact key; verify by re-fetch expecting absence. */
export async function deleteRecord(
  ctx: ReadToolContext,
  args: DeleteRecordArgs,
): Promise<Record<string, unknown>> {
  if (typeof args.entity !== "string" || args.entity.trim() === "") {
    throw validationError("entity is required");
  }
  if (typeof args.key !== "object" || args.key === null) {
    throw validationError("key is required");
  }
  if (args.confirm !== true) {
    throw validationError("confirm=true is required for delete operations");
  }
  const schema = await ctx.meta.getEntitySchema(args.entity);
  const key = assertKeyExact(schema, args.key);
  if (args.dryRun !== false) return dryRunResult(`DELETE ${schema.entity}`, { key });

  await ctx.client.deleteRecord(keyedPath(schema.entity, key));
  let verified = false;
  try {
    await ctx.client.get(keyedPath(schema.entity, key));
  } catch (error) {
    if (error instanceof PriorityError && error.kind === "not_found") verified = true;
  }
  return { deleted: true, key, verified };
}

/** Validate a data URI and return its decoded byte length. */
function parseDataUri(dataUri: string): { mime: string; bytes: number } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/.exec(dataUri);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw validationError('dataUri must look like "data:<mime>;base64,<payload>"');
  }
  const mime = match[1];
  const payload = match[2];
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((payload.length * 3) / 4) - padding;
  if (bytes > MAX_ATTACHMENT_BYTES) {
    throw validationError(`attachment is ~${bytes} bytes; limit is ${MAX_ATTACHMENT_BYTES}`);
  }
  return { mime, bytes };
}

/** Attach a base64 file to a record via its EXTFILES_SUBFORM. */
export async function uploadAttachment(
  ctx: ReadToolContext,
  args: UploadAttachmentArgs,
): Promise<Record<string, unknown>> {
  if (typeof args.entity !== "string" || args.entity.trim() === "") {
    throw validationError("entity is required");
  }
  if (typeof args.fileLabel !== "string" || args.fileLabel.trim() === "") {
    throw validationError("fileLabel (EXTFILEDES) is required");
  }
  const parsed = parseDataUri(args.dataUri ?? "");
  const schema = await ctx.meta.getEntitySchema(args.entity);
  const key = assertKeyExact(schema, args.key);
  if (!navigationNames(schema).has("EXTFILES_SUBFORM")) {
    throw validationError(
      `entity ${schema.entity} has no EXTFILES_SUBFORM navigation — attachments are not supported on it`,
    );
  }
  if (args.suffix !== undefined && !args.suffix.startsWith(".")) {
    throw validationError('suffix must include the leading period, e.g. ".pdf"');
  }
  const body: Record<string, unknown> = {
    EXTFILEDES: args.fileLabel,
    EXTFILENAME: args.dataUri,
  };
  if (args.suffix !== undefined) body.SUFFIX = args.suffix;
  if (args.dryRun !== false) {
    return dryRunResult(`ATTACH ${schema.entity}`, { key, ...body, decodedBytes: parsed.bytes });
  }
  const path = `${new ODataBuilder().keys(key).build(schema.entity)}/EXTFILES_SUBFORM`;
  const attached = await ctx.client.post<Record<string, unknown>>(path, body);
  return { attached: true, key, mime: parsed.mime, decodedBytes: parsed.bytes, record: attached };
}

/** Write a text form (HTML) on a record. POST ≡ PATCH for text; APPEND governs. */
export async function setText(
  ctx: ReadToolContext,
  args: SetTextArgs,
): Promise<Record<string, unknown>> {
  if (typeof args.entity !== "string" || args.entity.trim() === "") {
    throw validationError("entity is required");
  }
  if (typeof args.text !== "string" || args.text.length === 0) {
    throw validationError("text is required");
  }
  // Real Priority text forms are e.g. ORDERSTEXT_SUBFORM — no underscore
  // before "TEXT" (verified against live metadata), so the suffix check is
  // "TEXT_SUBFORM", not "_TEXT_SUBFORM".
  if (typeof args.textForm !== "string" || !args.textForm.endsWith("TEXT_SUBFORM")) {
    throw validationError('textForm must be a text subform name ending in "TEXT_SUBFORM"');
  }
  const schema = await ctx.meta.getEntitySchema(args.entity);
  const key = assertKeyExact(schema, args.key);
  if (!navigationNames(schema).has(args.textForm)) {
    throw validationError(
      `entity ${schema.entity} has no "${args.textForm}" navigation — valid text forms: ` +
        [...navigationNames(schema)].filter((name) => name.endsWith("_TEXT_SUBFORM")).join(", "),
    );
  }
  const body = {
    TEXT: args.text,
    APPEND: args.append !== false,
    SIGNATURE: args.signature === true,
  };
  if (args.dryRun !== false)
    return dryRunResult(`TEXT ${schema.entity}/${args.textForm}`, { key, ...body });
  const path = `${new ODataBuilder().keys(key).build(schema.entity)}/${args.textForm}`;
  const result = await ctx.client.patch<Record<string, unknown>>(path, body);
  return { setText: true, key, textForm: args.textForm, record: result };
}
