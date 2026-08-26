# Priority ERP — Verified REST API Reference (2026-08-26)

Live-verified against the vendor sandbox: `https://t.eu.priority-connect.online/odata/Priority/tabbtd38.ini/usdemo` (Priority **25.0**, auth `apidemo`/`123`, Basic). Docs: `prioritysoftware.github.io/restapi` (raw markdown in `github.com/prioritysoftware/prioritysoftware.github.io` `_restapi/` — rendered site has no sitemap/llms.txt; curl the repo). Load before any Priority integration or priority-mcp work.

## Auth (3 modes)

1. **Basic** — user + password (API username from Personnel File, distinct from UI login).
2. **PAT** (19.1+) — Authorization: Basic, username = token, password = literal `PAT`. Multiple PATs per user; minted in **REST Interface Access Tokens** form. Machine-to-machine default.
3. **OAuth2** (External ID module, paid) — Authorization-Code+PKCE only; IdP at `https://<domain>/accounts/connect/authorize` + `/token`, discovery at `/accounts/.well-known/openid-configuration`, scope `openid rest_api`. For browser/mobile apps, not servers.
- Optional per-app license headers `X-App-Id` / `X-App-Key` (18.3+). Debug via `X-App-Trace=1` (needs `Sqldebug=1` in tabula.ini `[Internet]`).

## URL anatomy

`{server}/odata/Priority/{ini},{lang}/{environment}/{company}` — e.g. `.../tabula.ini,3/wlnd/demodata/ORDERS`. Language `3`=US English, `1`=Hebrew, `2`=UK English; affects **error messages and metadata Description annotations** (default is Hebrew on the sandbox). **`tabula.ini` name varies per install** — sandbox uses `tabbtd38.ini`; get it via the Send Program Activation Link program. Entity/field names are UPPERCASE, case-sensitive. Decimals: period separator, always (22.0+).

## Quirks (all live-verified)

- **Silent filter swallow:** `CUSTOMERS?$filter=ZZZNOPE eq 'x'` → HTTP 200 + unfiltered rows. Filter fields MUST be validated client-side against entity metadata before send.
- **`$metadata` times out (>30s on 25.0 sandbox); server kills requests at 3 min.** Use `GetMetadataFor(entity='X')` (25.0+) — but **warm up the form first** (`GET X?$top=1`), else you get a stale/wrong entity's metadata. `LOGCOUNTERS` 404'd on first probe, 200 on second — same warm-up effect on entity access.
- **Composite keys:** `AINVOICES` key = `(IVNUM, DEBIT, IVTYPE)` → `AINVOICES(IVNUM='T00000001',IVTYPE='A',DEBIT='D')`. Single-key GET → 400 "number of keys does not match". Auto-unique keys are read-only (can't PATCH by them, 21.1+).
- **`GETCOMPANIES`** entity works (NAME/TITLE) — enumerates companies in the environment (multi-company primitive).
- **Error envelope:** OData v4 JSON `{"error":{"code","message"}}`; messages can be **Hebrew** (per language routing). Field-level permissions enforced since 22.1; sandbox demo user cannot write AINVOICES (400, Hebrew "insufficient permissions").
- **Date filter encoding:** spaces `%20`, `+` offset → `%2B` (`...ge%202018-...T09:59:00%2B02:00`). Semicolons in nested `$expand` options may be stripped by IIS → use `%3B`.
- **$since** (BPM entities only): `ORDERS?$since=2020-01-01T07:25:00Z` — always UTC-Z (DST-proof).
- **Writes:** POST/PATCH/DELETE; `PUT` removed. Deep-create parent+children in one POST (`ORDERITEMS_SUBFORM` array) or `$batch` (JSON format, `$1` references, **max 100 ops**, no rollback, 22.1+ response format = request format). Attachments = base64 data-URI in `EXTFILES_SUBFORM` (+ optional `SUFFIX` with dot, 22.0+). Text forms = `TEXT`/`APPEND`/`SIGNATURE` (POST≡PATCH; RTL: embed dir tags; text-only forms reject HTML). **No idempotency mechanism exists** — timeouts must never blindly retry.
- **Sub-form name pitfalls:** real names are `AINVOICEITEMS_SUBFORM` (not `AINVOICITEMS`), `CINVOICEITEMS_SUBFORM`, `ORDERITEMS_SUBFORM`; **verify every subform name in metadata before wiring a write tool**.
- **Limits:** 100 calls/min/user (429), ≤10 concurrent +5 queued, 3-min kill, 5000/day/IP, 350MB response cap, `MAXAPILINES`=2000 records default (25.1+; `MAXFORMLINES` before). **Every written record bills an API transaction** (order + 5 lines = 6); 25.1+ = shared pool.
- **Entities that do NOT exist** (hallucinated by assafch/Priority-Mcp, all 404 on warm-up-fair double-probe): `OPENDEBT`, `AGED_BALANCES`, `SUP_AGED_BALANCES`, `CUST_AGED_BALANCES`, `PAYMENTHIST`, `BANKACCOUNTS`, `ORDERSBKMN`, `INVENTCOUNT`, `WAREHOUSE_TRANSFER`, `SUP_OPENDEBT`. Live entities worth noting: `ORDERS`, `CUSTOMERS`, `PHONEBOOK`, `AINVOICES`, `PORDERS`, `LOGPART`, `LOGCOUNTERS`, `SUPPLIERS`, `PRICELIST`, `EXTFILES`, `WAREHOUSES`, `ORDERITEMS`, `COMPANIES`, `CINVOICES`, `FAMILY_LOG`. Real-form mapping for aged balances/debts/payments (ACCBAL-family and friends) still needs a metadata session — do not guess.
- **Hebrew-first metadata:** `GetMetadataFor` `Priority.OData.Description` annotations come back Hebrew by default; add `,{3}` to the ini segment for English.
- **Write scope on sandbox:** ORDERS and FAMILY_LOG writable (create 200 → delete 204 round-trip verified). Good integration-test targets.

## Existing MCP landscape (2026-08-26)

- **assafch/Priority-Mcp** — MIT, 72 tools, NOT on npm (`npx priority-mcp-server` → E404 despite README). ~60% of tools functional: fabricated entities (14+ tools dead), composite-key blindness (invoice get/update dead), `$metadata`-based discovery times out + XML parsed as JSON, `tabula.ini` hardcoded, write retry loop double-POSTs (no idempotency + transaction billing), no MCP annotations, write-gate by refusal not omission, `AINVOICITEMS_SUBFORM`/`CINVOICITEMS_SUBFORM` typos, `IPRICEDATE` abused as price field, invoice "void" = writing `STATDES` description string. Tests are mocks-only — zero live verification ever performed. Salvage: layering, `ODataBuilder` skeleton, `docs/priority-notes.md` field cheat-sheet, 12-domain tool copy. **Fresh-build verdict: don't fork.**
- **@boostmoveo/priority-mcp-server** — npm, ISC, v1.0.5, `priority-web-sdk` + axios + `natural` NLP; generic `search_forms → get_form_fields → query_records / mutate_record` workflow; correct env contract (`PRIORITY_TABULAINI`, language codes, PAT). No official vendor MCP exists.

## priority-mcp plan pointer

Full build plan (trains, verification probes, risks): `.hermes/plans/2026-08-26_213028-priority-mcp.md` in the session workspace — repo `agente-dev/priority-mcp`, npm `priority-mcp` (both free, verified).
