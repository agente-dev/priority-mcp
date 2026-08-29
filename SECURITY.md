# Security Policy

## Credentials are environment-only

All credentials are supplied via environment variables (`PRIORITY_USERNAME`, `PRIORITY_PASSWORD`, optional `PRIORITY_APP_ID` / `PRIORITY_APP_KEY`). The server **never accepts credentials as tool arguments** — an MCP client cannot smuggle secrets through a tool call, and tool arguments are never logged or echoed. Invalid config fails at boot with field-level errors (no values printed) and exit code 1.

## Redaction on error paths

Errors are a typed union, and every error message passes through redaction before it reaches the client: passwords, Authorization headers, and URL userinfo never appear in error text, logs, or tool results. OData error messages from the vendor are surfaced with their raw text preserved in a `raw` field, but they never carry your credentials (Basic auth headers are not part of error payloads).

## No idempotency mechanism → caller-owned write discipline

The Priority OData API has **no idempotency mechanism**: there is no deduplication key, and every written record bills a vendor API transaction. Therefore:

- This server issues **exactly one attempt per write** — writes are never retried, including on timeout. A timeout leaves the write's outcome unknown; do not blindly re-issue it (you may double-write and double-bill).
- **You** own write discipline: treat every `dryRun=false` call as a deliberate, billed operation. Check the post-write verification result (`verified: true`) before proceeding.
- Every write tool supports `dryRun: true` (the default) — validate and preview with zero HTTP side effects first.

## Dry-run contract

- `dryRun` defaults to **true** on all five write tools. A dry run performs full metadata validation (unknown fields are rejected client-side, zero HTTP calls) and returns a preview — it never writes.
- A real write happens only with an explicit `dryRun: false` **and**, when writes are enabled at all, `PRIORITY_READ_ONLY=false` in the environment.
- `priority_delete_record` additionally requires explicit `confirm: true`. Deletes are not reversible.

## Reporting a vulnerability

This is an unofficial, independently maintained integration. Please **do not open a public GitHub issue** for security vulnerabilities.

- Report privately via [GitHub Security Advisories](https://github.com/agente-dev/priority-mcp/security/advisories/new) ("Report a vulnerability").
- Include: affected version/commit, environment variables involved (names only — never values), and a minimal reproduction.
- You will get an acknowledgment and a fix timeline; coordinated disclosure is preferred.

Scope notes: this server holds only the credentials you give it, talks only to your configured `PRIORITY_API_URL` (https-enforced), and exposes no other network surface.
