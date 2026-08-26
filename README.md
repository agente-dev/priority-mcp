# priority-mcp

Unofficial Model Context Protocol (MCP) server for the Priority ERP OData API.

> **Under construction.** Train 1 ships the scaffold, strict environment
> validation, and CI. No tools are registered yet — the server boots and
> waits on stdio.

## Status — tools table

| Tool | Description | Status |
| ---- | ----------- | ------ |
| _(none yet)_ | Read surface lands in later trains | planned |

- Write surface is gated **by omission**: with `PRIORITY_READ_ONLY=true`
  (the default), no write tool is ever advertised in `tools/list`. Writes
  require an explicit `PRIORITY_READ_ONLY=false`.

## Configuration

All configuration is via environment variables, validated at boot by
`src/config.ts` (aggregated, throw-free; invalid config prints field-level
errors to stderr and exits 1). Required: `PRIORITY_API_URL` (https),
`PRIORITY_ENVIRONMENT`, `PRIORITY_COMPANY`, `PRIORITY_USERNAME`,
`PRIORITY_PASSWORD`. See `src/config.ts` for defaults and optional fields
(`PRIORITY_TABULA_INI`, `PRIORITY_LANGUAGE`, `PRIORITY_READ_ONLY`,
`PRIORITY_APP_ID`/`PRIORITY_APP_KEY`, `PRIORITY_ALLOWED_TOOLS`/
`PRIORITY_BLOCKED_TOOLS`, `RATE_LIMIT_PER_MINUTE`, `REQUEST_TIMEOUT_MS`,
`LOG_LEVEL`).

## Verified API reference

The wire-level facts this server is built against (URL anatomy, auth modes,
quirk list, entity inventory) are live-verified against the vendor sandbox:
see [docs/priority-api-verified.md](docs/priority-api-verified.md). Read it
before wiring any tool.

## Disclaimer

This project is **not affiliated with, endorsed by, or sponsored by Priority
Software Ltd or its distributors**. "Priority" is a trademark of the
respective owner. This is an independent, unofficial integration with the
publicly documented Priority REST/OData API, built from live verification of
the vendor's sandbox. Use at your own risk; the vendor API can change or
limit access at any time.
