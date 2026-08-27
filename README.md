# priority-mcp

Unofficial Model Context Protocol (MCP) server for the Priority ERP OData API.

> **Under construction.** Train 1 ships the scaffold, strict environment
> validation, and CI. Train 2 adds the client layer: OData query builder
> (composite keys), typed errors with redaction, decimal-string money
> handling, the `PriorityClient` (timeouts / no-retry-writes / rate limit /
> GET cache) and the `GetMetadataFor`-based `MetadataStore` with warm-up.
> No MCP tools are registered yet — the server boots and waits on stdio.

## Status — tools table

| Tool | Description | Status |
| ---- | ----------- | ------ |
| _(none yet)_ | Read surface lands in train 3 on top of the client layer | planned |

- Write surface is gated **by omission**: with `PRIORITY_READ_ONLY=true`
  (the default), no write tool is ever advertised in `tools/list`. Writes
  require an explicit `PRIORITY_READ_ONLY=false`.

## Configuration

All configuration is via environment variables, validated at boot by
`src/config.ts` (aggregated, throw-free; invalid config prints field-level
errors to stderr and exits 1).

| Variable | Required | Default | Meaning |
| -------- | -------- | ------- | ------- |
| `PRIORITY_API_URL` | yes | — | https base URL that **ends with `/odata/Priority`** (trailing slashes trimmed; installs with a path prefix like `https://host/ui/odata/Priority` work — one variable owns the whole prefix). E.g. `https://t.eu.priority-connect.online/odata/Priority` |
| `PRIORITY_TABULA_INI` | no | `tabula.ini` | tabula.ini segment name, varies per install (sandbox: `tabbtd38.ini`) |
| `PRIORITY_LANGUAGE` | no | `3` | Language segment (`3` = US English; `1` = Hebrew) — affects error messages and metadata Description annotations |
| `PRIORITY_COMPANY` | yes | — | Company code. Example: `usdemo` |
| `PRIORITY_ENVIRONMENT` | no | value of `PRIORITY_COMPANY` | **Metadata label only** (cache namespacing, logs) — never a URL segment |
| `PRIORITY_USERNAME` | yes | — | API username (or PAT token, with password `PAT`) |
| `PRIORITY_PASSWORD` | yes | — | API password (or literal `PAT` for PAT auth). Never logged |
| `PRIORITY_APP_ID` / `PRIORITY_APP_KEY` | no | — | Optional per-app license headers `X-App-Id`/`X-App-Key` |
| `PRIORITY_READ_ONLY` | no | `true` | `false` enables the write surface (train 4) |
| `PRIORITY_ALLOWED_TOOLS` / `PRIORITY_BLOCKED_TOOLS` | no | — | CSV tool allow/denylists |
| `RATE_LIMIT_PER_MINUTE` | no | `60` | Token-bucket rate (vendor fair use: 100/min) |
| `REQUEST_TIMEOUT_MS` | no | `60000` | Per-request timeout, under the vendor's 3-min kill |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |

The service root is derived as
`serviceRoot = {PRIORITY_API_URL}/{PRIORITY_TABULA_INI},{PRIORITY_LANGUAGE}/{PRIORITY_COMPANY}`,
e.g. `https://t.eu.priority-connect.online/odata/Priority/tabbtd38.ini,3/usdemo`
(the verified sandbox decomposition).

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
