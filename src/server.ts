/**
 * Server wiring for priority-mcp.
 *
 * `createServer(config)` builds the McpServer instance. Tool registration is
 * split into two surfaces so safety-critical gating stays structural:
 *
 * - `registerReadTools` — the read surface. Tool registrations land here in
 *   later trains; nothing is registered in train 1.
 * - `registerWriteTools` — the write surface. Gated BY OMISSION from
 *   tools/list: when `PRIORITY_READ_ONLY` is true (the default) this registers
 *   nothing, so no write tool is ever advertised to a client. It can only be
 *   enabled by explicitly setting `PRIORITY_READ_ONLY=false`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";

export const VERSION = "0.1.0";

export const SERVER_NAME = "priority-mcp";

/**
 * Register the read surface (later trains). Returns the registered tool names
 * so tests can assert on the live surface. Registers nothing in train 1 —
 * the server must still boot with zero tools.
 */
export function registerReadTools(_server: McpServer, _config: Config): string[] {
  return [];
}

/**
 * Register the write surface (later trains). Gated by omission: when
 * `config.readOnly` is true nothing is registered here at all. Returns the
 * registered tool names.
 */
export function registerWriteTools(_server: McpServer, config: Config): string[] {
  if (config.readOnly) {
    return [];
  }
  return [];
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
