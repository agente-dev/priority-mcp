# Plan: `priority-mcp` — Public Priority ERP MCP Server

**Date:** 2026-08-26 · **Status:** Ready for execution · **Origin:** Live audit of `prioritysoftware.github.io/restapi` docs + `assafch/Priority-Mcp` repo + vendor sandbox probes

## Goal

Ship a standalone, publicly distributed MCP server (`npx`-runnable, npm + MCP Registry) wrapping the **Priority ERP OData REST API**, built on the proven `invoice4u-mcp` chassis (AGC-781 train model). Unlike Invoice4U, we have a **live, write-capable vendor sandbox** — the integration ceiling is real verification, not mocked fixtures.

**Naming:** `agente-dev/priority-mcp`, npm package `priority-mcp` (both E404-verified free).

## Ground truth (all live-verified 2026-08-26 against the sandbox)

| Fact | Value | Verified by |
|---|---|---|
| Sandbox root | `https://t.eu.priority-connect.online/odata/Priority/tabbtd38.ini/usdemo` | curl 200 |
| Sandbox auth | `apidemo` / `123` (Basic) | every probe |
| Priority version | `25.0` (`GetPriorityVersion()` → `25.0-sandeu.sql.w27...`) | curl 200 |
| Full `$metadata` | **Times out >30s**; discovery must use `GetMetadataFor(entity=…)` | curl timeout |
| `GetMetadataFor` cold call | Returns stale/wrong entity; **warm-up first** (`?$top=1`), then call | probe returned ADDRECIPIENTS for CUSTOMERS pre-warm |
| Silent filter swallow | `CUSTOMERS?$filter=ZZZNOPE eq 'x'` → 200 + **unfiltered rows** | curl 200 |
| Composite keys | `AINVOICES` key = `(IVNUM, DEBIT, IVTYPE)`; single-key GET → 400 | metadata + 400 probe |
| Dead entities (hallucinated in assafch repo) | `OPENDEBT`, `AGED_BALANCES`, `SUP_AGED_BALANCES`, `CUST_AGED_BALANCES`, `PAYMENTHIST`, `BANKACCOUNTS`, `ORDERSBKMN`, `INVENTCOUNT`, `WAREHOUSE_TRANSFER`, `SUP_OPENDEBT` | double-probe 404 (warm-up fair) |
| Sandbox write scope | ORDERS/FAMILY_LOG writable (create 200 / delete 204 verified); AINVOICES denied for demo user (400 insufficient permissions, Hebrew message) | POST/DELETE probes |
| Metadata descriptions | Default **Hebrew**; English needs `,3` language segment | GetMetadataFor probe |
| Dead subform names | `AINVOICITEMS_SUBFORM`, `CINVOICITEMS_SUBFORM` (real: `AINVOICEITEMS_SUBFORM`) | metadata grep |
| Sandbox sunsets | Old sandbox off Sep 8 (already gone); **new sandbox on AWS live** | intro doc |
| npm landscape | `priority-mcp-server` (assafch) E404 — unpublished; `@boostmoveo/priority-mcp-server` published (ISC, heavy `priority-web-sdk` dep) | npm view |
| Error shape | OData v4 JSON `{"error":{"code","message"}}`, messages may arrive in Hebrew | bad-filter probe (partial), AINVOICES write probe |
| Company enumeration | `GETCOMPANIES` works (NAME+TITLE) — multi-company routing primitive | curl 200 |
| Rate/fair-use | 100 calls/min/user, 429 on breach, 3-min request kill, 5000/day per IP; `MAXAPILINES`=2000 default cap | docs |
| Transactions | Every written record **bills a transaction** (order+5 lines = 6) | docs |
| X-App-Id/X-App-Key | Optional per-application license headers | docs |

## Design decisions

1. **Fresh build, not fork.** Fixing assafch's discovery/composite-keys/retry/ini/domain-mapping = rewrite of every layer; MIT salvage = `ODataBuilder` skeleton, `docs/priority-notes.md` cheat-sheet, 12-domain tool copy. No obligation to preserve their API surface.
2. **Metadata-driven generic tools over per-domain hardcoded tools.** Their fabricated entities prove per-domain hardcoding rots. Our approach: discovery tools (`list_entities`, `get_entity_schema` via `GetMetadataFor`+warm-up+disk cache) + a small set of typed, schema-validated query tools whose filter fields are **validated against live metadata before send** (answers the silent-filter-swallow hazard) + write tools gated per train 4.
3.**PAT auth as first-class** (Basic + password literal `PAT`), `tabula.ini` name configurable, `X-App-Id`/`X-App-Key` optional, language segment (`,3` English default) in URL.
4. **Client invariants** (from `mcp-server-authoring`/`standalone-mcp-server` skills): fetch timeout < server 3-min kill; **writes never retried**; write-gating by omission from `tools/list`; MCP annotations on every tool; typed error union (auth/validation/not_found/rate_limited/server, `retryable` only on network/429); env-only credentials with `redact()`; integer minor units / decimal strings at boundary (Priority uses `Edm.Decimal`), 2-dp enforcement.
5. **No silent wrongness**: filter-field validation, subform-name validation (post-write re-fetch verification), `isError:true` structured results for expected failures.
6. **Sandbox integration tests in CI** (`workflow_dispatch` + nightly): discovery warm-up dance, filter-validation negatives, composite-key GET, create/delete round-trip on FAMILY_LOG + ORDERS. `describe.skipIf(!env)` so fork PRs aren't blocked; writes to sandbox are permitted and cleaned up (FAMILY_LOG('ZZTEST') round-trip verified).

**Train structure** (one PR per train, orchestrator re-runs gates independently, squash-merge on green):

- **Train 1 — Scaffold/config/CI:** repo, tsconfig, biome, vitest, GitHub Actions (lint→typecheck→unit→build→pack-verify), `files:["dist"]`, bin, strict env config (PRIORITY_API_URL, PRIORITY_ENVIRONMENT, PRIORITY_COMPANY, PRIORITY_USERNAME, PRIORITY_PASSWORD, PRIORITY_TABULA_INI=tabula.ini default, PRIORITY_LANGUAGE=3 default, optional X-App-Id/X-App-Key, PRIORITY_READ_ONLY, allowed/blocked tools), FIFO aliveness probe + invalid-config exit-1 probe in CI.
- **Train 2 — Client layer:** PriorityClient (timeouts, retry-on-read-only, typed errors, redaction, rate limiter ≤100/min, LRU cache for GETs), ODataBuilder (quoting, **composite-key segments**, `$since`, filter-field validation hook), metadata store (GetMetadataFor + warm-up + disk cache under OS tmp; Hebrew descriptions retained + `PRIORITY_LANGUAGE` segment routing).
- **Train 3 — Read tools:** `priority_get_server_info` (version/login/company/GETCOMPANIES), discovery (`list_entities`, `get_entity_schema`), `priority_query_records` (entity, validated filters, top/skip/select/expand/orderBy/since), `priority_get_record` (composite-key aware). Annotations: readOnlyHint:true, idempotentHint:true.
- **Train 4 — Write tools (gated):** `priority_create_record` (subform validation, dry-run default, transaction-count warning, $batch not exposed), `priority_update_record`, `priority_delete_record` (destructive, never idempotentHint), `priority_upload_attachment` (data-URI, SUFFIX), `priority_set_text` (TEXT/APPEND/SIGNATURE, RTL guidance). PRIORITY_READ_ONLY=true → tools absent from tools/list. Post-write re-fetch verification. idempotency: NO idempotentHint claims (no vendor mechanism).
- **Train 5 — Docs/publication:** README EN (+short HE section), SECURITY.md (env-only secrets, redaction), server.json (mcpName io.github.agente-dev/priority-mcp), npm OIDC release workflow (inert until human npm link), MCP Registry submission, CHANGELOG, coverage-manifest.json (tools × risk class × sandbox-verified status), unofficial-integration disclaimer EN+HE.

**Verification per train** (orchestrator-re-run, evidence or it didn't happen):

```bash
npm run lint && npx tsc --noEmit && npm test && npm run build && npm pack --dry-run
# Train 2+: FIFO aliveness probe (mkfifo /tmp/p; exec 3>/tmp/p), invalid-config exit-1
# Train 3+: sandbox read probes: GetPriorityVersion, list_entities, get_entity_schema('AINVOICES') shows composite key
# Train 4: FAMILY_LOG create→delete round-trip 200/204; dry-run emits no HTTP call; READ_ONLY omits tools from tools/list
```

## Files likely created

```
agente-dev/priority-mcp/
  src/index.ts src/config.ts src/server.ts src/logger.ts
  src/priority/{types.ts,errors.ts,money.ts,odata.ts,metadata.ts,client.ts}
  src/tools/{meta.ts,query.ts,write.ts,attachments.ts,text.ts,info.ts}
  src/lib/{write-guard.ts,annotations.ts,redact.ts}
  tests/unit/ tests/contract/ tests/integration/sandbox.spec.ts
  coverage-manifest.json server.json README.md README.he.md
  .github/workflows/{ci.yml,qa-sandbox.yml,release.yml}
```

## Risks & mitigations

- **Sandbox write-permission drift** (AINVOICES already denied): coverage-manifest marks sandbox-verified vs contract-test-only per tool; README states the honest ceiling.
- **`GetMetadataFor` cold-start races**: warm-up (`$top=1`) baked into metadata store; retry once on stale-detection (returned entity ≠ requested).
- **Sandbox sunset** (this is the new AWS one; old one dies Sep 8): keep root URL in one env/config point; QA workflow uses repository variable, swappable.
- **Transactions billed on sandbox writes**: tests clean up (delete) and stay tiny (1-3 records); nightly cadence, not per-push.
- **Silent filter swallow is the top silent-wrongness vector**: filter fields validated against `get_entity_schema` before send; validation failure = typed `validation` error, not a shrug and a 200.
- **Hebrew error messages** (user policy: English-only replies): client normalizes/annotates but **translates at the boundary** for tool output; raw text preserved in a `raw` field for fidelity.

## Open questions (parked, non-blocking)

- Bundle as desktop connector later? Park as issue; standalone-first per skill doctrine.
- `SUP_OPENDEBT`-class real-entity mapping for aged balances/debts (dead list above) — needs a sandbox metadata session during Train 3; candidates exist in catalog (e.g. ACCBAL-family); park mapping table in coverage-manifest notes.
- OAuth2/External-ID — out of scope for v0.1 (PAT + Basic cover machine-to-machine per docs' own guidance).
