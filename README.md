# priority-mcp

Unofficial [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for the **Priority ERP** OData REST API. Typed, metadata-validated read and write tools for MCP-compatible agents (Claude Desktop, Claude Code, and any stdio MCP client). MIT-licensed. Runnable via `npx priority-mcp` once published to npm (not yet published — see [Status](#status--honest-v01-scope)).

> **Disclaimer — unofficial integration.** This project is **not affiliated with, endorsed by, or sponsored by Priority Software Ltd or its distributors**. "Priority" is a trademark of the respective owner. This is an independent, unofficial integration with the publicly documented Priority REST/OData API, built from live verification against the vendor's sandbox. Use at your own risk; the vendor API can change or limit access at any time.

## Quick start

All configuration is via environment variables — **credentials are never accepted as tool arguments**. Config is validated at boot; invalid config prints field-level errors to stderr and exits 1.

### Environment variables

| Variable | Required | Default | Meaning |
| -------- | -------- | ------- | ------- |
| `PRIORITY_API_URL` | yes | — | https base URL that **must end with `/odata/Priority`** (trailing slashes trimmed). One variable owns the whole prefix — installs with a path prefix like `https://host/ui/odata/Priority` work too. Example: `https://t.eu.priority-connect.online/odata/Priority` |
| `PRIORITY_TABULA_INI` | no | `tabula.ini` | tabula.ini segment name. **Varies per install** — the vendor sandbox uses `tabbtd38.ini`; obtain yours via the Send Program Activation Link program. |
| `PRIORITY_LANGUAGE` | no | `3` | URL language segment: `3` = US English, `1` = Hebrew, `2` = UK English. Affects error messages and metadata Description annotations (sandbox defaults to Hebrew). |
| `PRIORITY_COMPANY` | yes | — | Company code, e.g. `usdemo`. |
| `PRIORITY_ENVIRONMENT` | no | value of `PRIORITY_COMPANY` | **Metadata label only** (cache namespacing, logs) — never a URL segment. |
| `PRIORITY_USERNAME` | yes | — | API username (from the Personnel File) or a PAT token. |
| `PRIORITY_PASSWORD` | via 2 vars | — | API password, or the literal `PAT` when the username is a PAT token. Never logged; errors are redacted. |
| `PRIORITY_APP_ID` / `PRIORITY_APP_KEY` | no | — | Optional per-app license headers `X-App-Id` / `X-App-Key` (18.3+). |
| `PRIORITY_READ_ONLY` | no | `true` | `false` enables the write surface. At the default `true`, the five write tools are **absent from `tools/list` entirely** (gating by omission, not refusal at call time). |
| `PRIORITY_ALLOWED_TOOLS` / `PRIORITY_BLOCKED_TOOLS` | no | — | CSV allow/denylists applied to the tool surface. |
| `RATE_LIMIT_PER_MINUTE` | no | `60` | Token-bucket rate limit (vendor fair use ceiling: 100/min). |
| `REQUEST_TIMEOUT_MS` | no | `60000` | Per-request timeout, kept under the vendor's 3-minute request kill. |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. |

The service root is derived as `{PRIORITY_API_URL}/{PRIORITY_TABULA_INI},{PRIORITY_LANGUAGE}/{PRIORITY_COMPANY}`, e.g. `https://t.eu.priority-connect.online/odata/Priority/tabbtd38.ini,3/usdemo`.

### Claude Desktop / Claude Code / generic MCP client

`claude_desktop_config.json` (Claude Desktop, ⊂ Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "priority": {
      "command": "npx",
      "args": ["-y", "priority-mcp"],
      "env": {
        "PRIORITY_API_URL": "https://t.eu.priority-connect.online/odata/Priority",
        "PRIORITY_TABULA_INI": "tabbtd38.ini",
        "PRIORITY_LANGUAGE": "3",
        "PRIORITY_COMPANY": "usdemo",
        "PRIORITY_USERNAME": "your-api-username",
        "PRIORITY_PASSWORD": "your-api-password"
      }
    }
  }
}
```

Claude Code (one line, same env vars as `-e` flags):

```bash
claude mcp add priority -e PRIORITY_API_URL=https://t.eu.priority-connect.online/odata/Priority -e PRIORITY_TABULA_INI=tabbtd38.ini -e PRIORITY_LANGUAGE=3 -e PRIORITY_COMPANY=usdemo -e PRIORITY_USERNAME=your-api-username -e PRIORITY_PASSWORD=your-api-password -- npx -y priority-mcp
```

Generic stdio MCP client — same shape: `command: "npx"`, `args: ["-y", "priority-mcp"]`, `env: { ... }` with the variables from the table above.

**Write access:** add `"PRIORITY_READ_ONLY": "false"` to `env` in any of the above.

## Tools

10 tools: 5 read (always present) + 5 write (gated — see below). Enable/disable with `PRIORITY_ALLOWED_TOOLS` / `PRIORITY_BLOCKED_TOOLS`.

### Read tools

| Tool | Kind | Risk | Description |
| ---- | ---- | ---- | ----------- |
| `priority_get_server_info` | read | free | Priority server version, login name, and companies in the environment. |
| `priority_list_entities` | read | free | Entity-set names from the service root document (never `$metadata`, which times out). |
| `priority_get_entity_schema` | read | free | Entity metadata: key fields, properties, navigation properties, subforms. |
| `priority_query_records` | read | free | Metadata-validated `$filter`/`$select`/`$orderby`/`$expand`/`$since`/`$top`/`$skip` queries. |
| `priority_get_record` | read | free | Fetch one record by its exact (possibly composite) key. |

### Write tools — gated: absent from `tools/list` unless `PRIORITY_READ_ONLY=false`; dry-run default true

| Tool | Kind | Risk | Description |
| ---- | ---- | ---- | ----------- |
| `priority_create_record` | write | billed | Create a record (optionally with subform rows, e.g. `ORDERITEMS_SUBFORM`). |
| `priority_update_record` | write | billed | Update a record by exact (possibly composite) key. |
| `priority_delete_record` | write | destructive | Delete a record by exact key. Requires explicit `confirm: true`. |
| `priority_upload_attachment` | write | billed | Base64 data-URI attachment on a record's `EXTFILES_SUBFORM` (≤2 MB decoded). |
| `priority_set_text` | write | billed | HTML text on a record's text subform (append/replace, optional signature). |

## Safety model

- **Gating by omission.** With `PRIORITY_READ_ONLY=true` (the default), no write tool is ever advertised in `tools/list` — the gate is structural, not a refusal at call time.
- **Metadata validation before HTTP.** Every filter, select, orderBy, and write field is validated against live entity metadata **before any HTTP call**. Priority silently swallows unknown filter fields (returns HTTP 200 + unfiltered rows); this server rejects unknown fields client-side with a typed `validation_error` and issues zero HTTP traffic.
- **Composite-key exactness.** Key fields must exactly match the entity metadata key fields (e.g. `AINVOICES` = `(IVNUM, DEBIT, IVTYPE)`); single-key GETs on composite entities fail fast client-side.
- **Dry-run default.** Every write tool takes `dryRun` (default **true**): the default call validates and previews without emitting a single HTTP write.
- **Post-write verification.** After a real write, the record is re-fetched and the write result reports `verified: true` only if the re-fetch confirms the change (and a delete confirms 404).
- **No idempotency claims.** Priority has **no idempotency mechanism** — a timed-out write must never be blindly retried. This server issues **exactly one attempt per write** (never retries writes), and makes no `idempotentHint` claims on write tools.
- **Transaction billing.** Each written record bills a vendor API transaction (an order with 5 lines = 6 transactions; shared pool on 25.1+). Writes stay small and deliberate.
- **Rate limit under vendor fair use.** Token-bucket client, default 60 req/min against the vendor's 100/min fair-use ceiling.

## Priority quirks (live-verified, distilled)

All facts below are live-verified against the vendor sandbox — full detail in [docs/priority-api-verified.md](docs/priority-api-verified.md).

- **Metadata warm-up is mandatory.** `GetMetadataFor` returns a stale/wrong entity's metadata if the form wasn't warmed up first (a `?$top=1` probe). The metadata store warms up automatically before every schema call.
- **Never use `$metadata`.** The full `$metadata` document times out (>30 s on the 25.0 sandbox). Discovery uses the service root document + `GetMetadataFor(entity=…)`.
- **Hebrew-first metadata and errors.** Descriptions and error messages arrive in Hebrew by default; set `PRIORITY_LANGUAGE=3` for English.
- **Date filter encoding.** Spaces encode as `%20` and a `+` UTC offset as `%2B` (e.g. `...ge%202018-...T09:59:00%2B02:00`); semicolons in nested `$expand` options must be `%3B`.
- **`$batch` is not exposed in v0.1.** The API supports JSON-format `$batch` (max 100 ops, no rollback), but this server issues single operations only — aligned with the no-retry/no-idempotency posture.
- **Sandbox coordinates are install-specific.** The sandbox root ends `/odata/Priority/tabbtd38.ini/usdemo`; `tabula.ini` names and permissions **vary per install and drift** (the demo user cannot write `AINVOICES` — Hebrew "insufficient permissions"). Expect variance on any other install.

## Development

```bash
npm ci          # install
npm run lint    # biome check .
npm run typecheck  # tsc --noEmit
npm test        # vitest run (unit tests only)
npm run build   # tsup -> dist/
npm run pack-verify  # npm pack --dry-run tarball check
```

### Live sandbox integration tests

`tests/integration/sandbox.spec.ts` runs real read probes and a real create→verify→delete round-trip against the vendor sandbox (test cases a–f). It is skipped unless live credentials are present in the environment, so a plain `npm test` on a fork stays green. To run it:

```bash
export PRIORITY_API_URL="https://t.eu.priority-connect.online/odata/Priority"
export PRIORITY_TABULA_INI="tabbtd38.ini"
export PRIORITY_LANGUAGE="3"
export PRIORITY_COMPANY="usdemo"
export PRIORITY_USERNAME="..."   # your sandbox API username
export PRIORITY_PASSWORD="..."   # your sandbox API password
npx vitest run tests/integration/sandbox.spec.ts
```

The write round-trip (case e) creates a random `FAMILY_LOG` row, verifies it via re-fetch, and deletes it in a `finally` block — cleanup runs even on assertion failure, because writes bill vendor transactions.

### CI

GitHub Actions (`.github/workflows/ci.yml`): lint → typecheck → unit tests → build → npm tarball verification (pack dry-run asserts `dist/`, `README.md`, `LICENSE` present and no source/test leakage) on Node 22.

## Status — honest v0.1 scope

- **Verified against one Priority 25.0 sandbox only** (`t.eu.priority-connect.online`, `tabbtd38.ini`, `usdemo`). Other Priority versions, cloud tenants, and on-prem installs are **untested**.
- **Sandbox permissions drift.** What the demo user can write there (e.g. `FAMILY_LOG`, `ORDERS` writable; `AINVOICES` denied) does not generalize to your install's user and field-level permissions (22.1+).
- Not yet published to npm or the MCP Registry; `npx priority-mcp` works only after the first publish.
- Per-tool verification status: [coverage-manifest.json](coverage-manifest.json).
- Security posture and reporting: [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
