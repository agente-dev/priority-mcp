# Changelog

All notable changes to this project are documented in this file.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning: [SemVer](https://semver.org).

## [0.1.0] - 2026-08-29

- Train 1 — scaffold: TypeScript strict scaffold, strict env config with boot-time validation (exit 1 on invalid), biome + vitest + CI chain, npm tarball verification.
- Train 2 — client layer: OData query builder (composite keys, date encoding), typed errors with redaction, decimal-string money handling, rate-limited client (timeouts, GET cache, writes never retried), GetMetadataFor-based metadata store with warm-up + disk cache.
- Train 3 — read tools: server info, entity listing, entity schema, metadata-validated queries (client-side filter validation against the silent-swallow hazard), composite-key record get.
- Train 4 — write tools (gated by omission behind `PRIORITY_READ_ONLY=false`): create/update/delete/upload attachment/set text, dry-run default, post-write verification, no idempotency claims, live sandbox create→delete round-trip test.
- Train 5 — docs + publication scaffolding: honest README rewrite, coverage manifest, security policy, MCP Registry server.json (pre-publication shape), inert-until-linked npm OIDC release workflow, this changelog.

[0.1.0]: https://github.com/agente-dev/priority-mcp/releases/tag/v0.1.0
