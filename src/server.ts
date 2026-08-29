/**
 * Server wiring for priority-mcp.
 *
 * `createServer(config)` builds the McpServer instance. Tool registration is
 * split into two surfaces so safety-critical gating stays structural:
 *
 * - `registerReadTools` — the read surface (train 3). Every read tool is
 *   registered here via the SDK's low-level `registerTool` form so it carries
 *   the shared READ_ANNOTATIONS (readOnly/idempotent/destructive/openWorld).
 * - `registerWriteTools` — the write surface. Gated BY OMISSION from
 *   tools/list: when `PRIORITY_READ_ONLY` is true (the default) this registers
 *   nothing, so no write tool is ever advertised to a client. It can only be
 *   enabled by explicitly setting `PRIORITY_READ_ONLY=false`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "./config.js";
import { PriorityClient } from "./priority/client.js";
import { PriorityError } from "./priority/errors.js";
import { MetadataStore } from "./priority/metadata.js";
import { DELETE_ANNOTATIONS, READ_ANNOTATIONS, WRITE_ANNOTATIONS } from "./tools/annotations.js";
import type { ReadToolContext } from "./tools/context.js";
import { getRecord } from "./tools/get.js";
import { getServerInfo } from "./tools/info.js";
import { getEntitySchema, listEntities } from "./tools/meta.js";
import { queryRecords } from "./tools/query.js";
import {
  createRecord,
  deleteRecord,
  setText,
  updateRecord,
  uploadAttachment,
} from "./tools/write.js";

export const VERSION = "0.1.0";

export const SERVER_NAME = "priority-mcp";

/** Build the shared ReadToolContext (client + metadata store) for a config. */
function buildContext(config: Config): ReadToolContext {
  const client = new PriorityClient({
    serviceRoot: config.serviceRoot,
    username: config.username,
    password: config.password,
    appId: config.appId,
    appKey: config.appKey,
    rateLimitPerMinute: config.rateLimitPerMinute,
    timeoutMs: config.requestTimeoutMs,
  });
  const meta = new MetadataStore(client, {
    envLabel: config.environment,
    company: config.company,
  });
  return { client, meta };
}

/**
 * Wrap a read tool function into an MCP `registerTool` callback. Data results
 * are serialized to a single text content block; typed PriorityErrors surface
 * as `isError` results, with `validation_error` kinds prefixed for agents to
 * branch on.
 */
function readCallback(
  ctx: ReadToolContext,
  fn: (ctx: ReadToolContext, args: unknown) => Promise<unknown>,
): (args: unknown) => Promise<CallToolResult> {
  return async (args) => {
    try {
      const result = await fn(ctx, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      if (error instanceof PriorityError) {
        const text =
          error.kind === "validation_error" ? `validation_error: ${error.message}` : error.message;
        return { content: [{ type: "text", text }], isError: true };
      }
      throw error;
    }
  };
}

const NoArgsSchema = z.object({});

const EntitySchemaArgs = z.object({
  entity: z.string().describe("Entity name, UPPERCASE (e.g. AINVOICES, CUSTOMERS, LOGPART)."),
});

const QueryRecordsArgs = z.object({
  entity: z.string().describe("Entity name, UPPERCASE (e.g. LOGPART)."),
  rawFilter: z
    .string()
    .optional()
    .describe("Raw OData $filter expression. Mutually exclusive with filterField."),
  filterField: z
    .string()
    .optional()
    .describe('Simple equality filter field, e.g. "TYPE". Validated against metadata.'),
  filterValue: z
    .union([z.string(), z.number()])
    .optional()
    .describe('Equality filter value, e.g. "P".'),
  top: z.number().int().min(1).max(2000).optional().describe("Result cap (default 50, max 2000)."),
  skip: z.number().int().min(0).optional().describe("Offset."),
  select: z.array(z.string()).optional().describe("Fields to return (validated against metadata)."),
  expand: z
    .array(z.string())
    .optional()
    .describe("Navigation subforms to expand (validated against metadata)."),
  orderBy: z.string().optional().describe("Order-by property name (validated against metadata)."),
  orderDir: z.enum(["asc", "desc"]).optional().describe("Sort direction (default asc)."),
  since: z
    .string()
    .optional()
    .describe("$since — a UTC datetime ending in Z (e.g. 2020-01-01T07:25:00Z)."),
});

const GetRecordArgs = z.object({
  entity: z.string().describe("Entity name, UPPERCASE (e.g. AINVOICES)."),
  key: z
    .record(z.string(), z.string())
    .describe("Record key — field → value. Must EXACTLY match metadata key fields."),
  select: z.array(z.string()).optional().describe("Fields to return (validated)."),
});

/**
 * Register the read surface (train 3). Returns the registered tool names so
 * tests can assert on the live surface.
 */
export function registerReadTools(server: McpServer, config: Config): string[] {
  const ctx = buildContext(config);

  server.registerTool(
    "priority_get_server_info",
    {
      title: "Get Priority server info",
      description:
        "Priority server version, current login name, and the companies available in the environment. Read-only.",
      inputSchema: NoArgsSchema,
      annotations: READ_ANNOTATIONS,
    },
    readCallback(ctx, async () => getServerInfo(ctx)),
  );

  server.registerTool(
    "priority_list_entities",
    {
      title: "List entities",
      description:
        "List available Priority entity-set names from the service root document (never $metadata, which times out).",
      inputSchema: NoArgsSchema,
      annotations: READ_ANNOTATIONS,
    },
    readCallback(ctx, async () => listEntities(ctx)),
  );

  server.registerTool(
    "priority_get_entity_schema",
    {
      title: "Get entity schema",
      description:
        "Entity metadata: key fields, properties, navigation properties, and subforms (names ending _SUBFORM).",
      inputSchema: EntitySchemaArgs,
      annotations: READ_ANNOTATIONS,
    },
    readCallback(ctx, (_ctx, args) => {
      const entity = (args as { entity?: string }).entity ?? "";
      return getEntitySchema(ctx, entity);
    }),
  );

  server.registerTool(
    "priority_query_records",
    {
      title: "Query records",
      description:
        "Query entity records with metadata-validated $filter/$select/$orderby/$expand/$since/$top/$skip. " +
        "Every filter/select/orderBy field is validated against the entity schema BEFORE any HTTP call — " +
        "an unknown field is rejected client-side (the Priority API silently swallows unknown filter fields).",
      inputSchema: QueryRecordsArgs,
      annotations: READ_ANNOTATIONS,
    },
    readCallback(ctx, (_ctx, args) => queryRecords(ctx, args as never)),
  );

  server.registerTool(
    "priority_get_record",
    {
      title: "Get a record by key",
      description:
        "Fetch a single record by its (possibly composite) key. Key fields must exactly match the entity metadata key fields.",
      inputSchema: GetRecordArgs,
      annotations: READ_ANNOTATIONS,
    },
    readCallback(ctx, (_ctx, args) => getRecord(ctx, args as never)),
  );

  return [
    "priority_get_server_info",
    "priority_list_entities",
    "priority_get_entity_schema",
    "priority_query_records",
    "priority_get_record",
  ];
}

const WRITE_NOTE =
  "⚠️ WRITE — bills Priority API transactions; requires PRIORITY_READ_ONLY=false. Use dryRun=true (default) to preview.";

const CreateRecordArgs = z.object({
  entity: z.string().describe("Entity name, UPPERCASE (e.g. FAMILY_LOG, ORDERS)."),
  fields: z
    .record(z.string(), z.unknown())
    .describe("Field → value for the new record (validated against metadata)."),
  subforms: z
    .record(z.string(), z.array(z.record(z.string(), z.unknown())))
    .optional()
    .describe("Subform name → rows (e.g. ORDERITEMS_SUBFORM); validated against metadata."),
  dryRun: z.boolean().optional().describe("Preview without writing (default true)."),
});

const UpdateRecordArgs = z.object({
  entity: z.string().describe("Entity name, UPPERCASE."),
  key: z
    .record(z.string(), z.string())
    .describe("Key field → value; must EXACTLY match metadata key fields."),
  fields: z
    .record(z.string(), z.unknown())
    .describe("Field → new value (validated against metadata)."),
  dryRun: z.boolean().optional().describe("Preview without writing (default true)."),
});

const DeleteRecordArgs = z.object({
  entity: z.string().describe("Entity name, UPPERCASE."),
  key: z
    .record(z.string(), z.string())
    .describe("Key field → value; must EXACTLY match metadata key fields."),
  confirm: z.boolean().describe("Must be explicitly true — deletes are not reversible."),
  dryRun: z.boolean().optional().describe("Preview without writing (default true)."),
});

const UploadAttachmentArgs = z.object({
  entity: z.string().describe("Entity name, UPPERCASE."),
  key: z.record(z.string(), z.string()).describe("Key field → value of the record to attach to."),
  fileLabel: z.string().describe("EXTFILEDES — label for the attachment."),
  dataUri: z.string().describe("data:<mime>;base64,<payload> — decoded size limit 2MB."),
  suffix: z.string().optional().describe('File extension WITH dot, e.g. ".pdf".'),
  dryRun: z.boolean().optional().describe("Preview without writing (default true)."),
});

const SetTextArgs = z.object({
  entity: z.string().describe("Entity name, UPPERCASE."),
  key: z.record(z.string(), z.string()).describe("Key field → value of the record."),
  textForm: z.string().describe('Text subform name ending in "_TEXT_SUBFORM" (validated).'),
  text: z.string().describe("HTML text; embed dir tags for RTL languages."),
  append: z.boolean().optional().describe("Append to existing text (default true) vs replace."),
  signature: z.boolean().optional().describe("Append the user's signature (default false)."),
  dryRun: z.boolean().optional().describe("Preview without writing (default true)."),
});

/**
 * Register the write surface (train 4). Gated by omission: when
 * `config.readOnly` is true nothing is registered here at all — the write
 * surface is absent from tools/list. Returns the registered tool names.
 */
export function registerWriteTools(server: McpServer, config: Config): string[] {
  if (config.readOnly) {
    return [];
  }
  const ctx = buildContext(config);

  server.registerTool(
    "priority_create_record",
    {
      title: "Create a record",
      description: `Create a record (optionally with subform rows) in an entity. ${WRITE_NOTE}`,
      inputSchema: CreateRecordArgs,
      annotations: WRITE_ANNOTATIONS,
    },
    readCallback(ctx, (_ctx, args) => createRecord(ctx, args as never)),
  );

  server.registerTool(
    "priority_update_record",
    {
      title: "Update a record",
      description: `Update an existing record by exact (possibly composite) key. ${WRITE_NOTE}`,
      inputSchema: UpdateRecordArgs,
      annotations: WRITE_ANNOTATIONS,
    },
    readCallback(ctx, (_ctx, args) => updateRecord(ctx, args as never)),
  );

  server.registerTool(
    "priority_delete_record",
    {
      title: "Delete a record",
      description: `Delete a record by exact key. Destructive and not reversible. ${WRITE_NOTE}`,
      inputSchema: DeleteRecordArgs,
      annotations: DELETE_ANNOTATIONS,
    },
    readCallback(ctx, (_ctx, args) => deleteRecord(ctx, args as never)),
  );

  server.registerTool(
    "priority_upload_attachment",
    {
      title: "Upload an attachment",
      description: `Attach a base64 file to a record via its EXTFILES_SUBFORM. ${WRITE_NOTE}`,
      inputSchema: UploadAttachmentArgs,
      annotations: WRITE_ANNOTATIONS,
    },
    readCallback(ctx, (_ctx, args) => uploadAttachment(ctx, args as never)),
  );

  server.registerTool(
    "priority_set_text",
    {
      title: "Set text on a record",
      description: `Write HTML text to a record's text subform (append or replace). ${WRITE_NOTE}`,
      inputSchema: SetTextArgs,
      annotations: WRITE_ANNOTATIONS,
    },
    readCallback(ctx, (_ctx, args) => setText(ctx, args as never)),
  );

  return [
    "priority_create_record",
    "priority_update_record",
    "priority_delete_record",
    "priority_upload_attachment",
    "priority_set_text",
  ];
}

/** Build the MCP server for a validated config. */
export function createServer(config: Config): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: VERSION,
  });

  registerReadTools(server, config);
  registerWriteTools(server, config);
  return server;
}
