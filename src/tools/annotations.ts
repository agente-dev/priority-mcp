/**
 * Shared MCP annotations for every read tool in the priority-mcp surface.
 *
 * Train-3 contract: every registered read tool carries these hints so
 * clients (agents, IDEs) know a call is side-effect free. Write tools get
 * their own annotations in a later train — they are never registered while
 * `readOnly` is true, so these hints are only ever attached to reads.
 */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

export const READ_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: true,
};

/**
 * Write tools (train 4). The vendor offers NO idempotency mechanism and every
 * written record bills an API transaction — so idempotentHint stays FALSE and
 * destructiveHint FALSE except for delete.
 */
export const WRITE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: false,
  openWorldHint: true,
};

export const DELETE_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  idempotentHint: false,
  destructiveHint: true,
  openWorldHint: true,
};
