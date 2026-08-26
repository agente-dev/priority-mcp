import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ConfigError } from "./config.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

function reportConfigErrors(errors: ConfigError[]): void {
  process.stderr.write("priority-mcp: invalid configuration:\n");
  for (const error of errors) {
    // Field NAMES only — never values (credentials must not leak to logs).
    process.stderr.write(`  - ${error.field}: ${error.message}\n`);
  }
}

async function main(): Promise<void> {
  const result = loadConfig(process.env);
  if (!result.ok) {
    reportConfigErrors(result.errors);
    process.exit(1);
  }

  // Train 1: boot a server with zero registered tools. The read surface lands
  // in later trains; writes stay omitted while PRIORITY_READ_ONLY is true.
  const server = createServer(result.config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `priority-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
