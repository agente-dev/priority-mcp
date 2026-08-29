import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { PriorityClient } from "../../src/priority/client.js";
import { createServer, registerReadTools } from "../../src/server.js";
import { READ_ANNOTATIONS } from "../../src/tools/annotations.js";

/** A minimal, valid Config (read tools never touch the network at registration). */
const CONFIG: Config = {
  apiUrl: "https://x.example/odata/Priority",
  environment: "demo",
  company: "demo",
  username: "apidemo",
  password: "123",
  tabulaIni: "tabula.ini",
  language: "3",
  serviceRoot: "https://x.example/odata/Priority/tabula.ini,3/demo",
  readOnly: true,
  rateLimitPerMinute: 100_000,
  requestTimeoutMs: 60_000,
  logLevel: "info",
};

const READ_TOOL_NAMES = [
  "priority_get_server_info",
  "priority_list_entities",
  "priority_get_entity_schema",
  "priority_query_records",
  "priority_get_record",
];

function registeredTools(server: McpServer): Record<string, { annotations?: unknown }> {
  return (server as unknown as { _registeredTools: Record<string, { annotations?: unknown }> })
    ._registeredTools;
}

describe("registerReadTools", () => {
  it("registers every read tool with READ_ANNOTATIONS", () => {
    const server = createServer(CONFIG);
    const tools = registeredTools(server);

    for (const name of READ_TOOL_NAMES) {
      const tool = tools[name];
      if (tool === undefined) {
        throw new Error(`tool ${name} was not registered`);
      }
      expect(tool.annotations).toEqual(READ_ANNOTATIONS);
    }
    expect(Object.keys(tools).length).toBe(READ_TOOL_NAMES.length);
  });

  it("returns the registered tool names", () => {
    const fresh = new McpServer({ name: "priority-mcp", version: "0.1.0" });
    const names = registerReadTools(fresh, CONFIG);
    expect(names.sort()).toEqual([...READ_TOOL_NAMES].sort());
  });

  it("builds a functioning PriorityClient from the config service root", () => {
    // The context client must point at the config's service root.
    const client = new PriorityClient({
      serviceRoot: CONFIG.serviceRoot,
      username: CONFIG.username,
      password: CONFIG.password,
    });
    expect(client.absolute("AINVOICES")).toBe(
      "https://x.example/odata/Priority/tabula.ini,3/demo/AINVOICES",
    );
  });
});
