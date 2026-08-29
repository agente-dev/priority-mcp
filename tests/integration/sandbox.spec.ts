import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { PriorityClient } from "../../src/priority/client.js";
import { MetadataStore } from "../../src/priority/metadata.js";
import type { ReadToolContext } from "../../src/tools/context.js";
import { getRecord } from "../../src/tools/get.js";
import { getServerInfo } from "../../src/tools/info.js";
import { queryRecords } from "../../src/tools/query.js";

// Live sandbox integration — skips cleanly when creds absent.
// Sandbox coordinates: docs/priority-api-verified.md
const cfg = loadConfig();
const liveConfig = cfg.ok ? cfg.config : undefined;

function buildContext(): ReadToolContext {
  if (!liveConfig) throw new Error("live sandbox configuration missing");
  const client = new PriorityClient({
    serviceRoot: liveConfig.serviceRoot,
    username: liveConfig.username,
    password: liveConfig.password,
    rateLimitPerMinute: liveConfig.rateLimitPerMinute,
    timeoutMs: liveConfig.requestTimeoutMs,
  });
  const meta = new MetadataStore(client, {
    envLabel: liveConfig.environment,
    company: liveConfig.company,
  });
  return { client, meta };
}

describe.skipIf(liveConfig === undefined)("live sandbox read tools", () => {
  it("a) server_info: version 25.x, non-empty companies array", { timeout: 60_000 }, async () => {
    const c = buildContext();
    const info = await getServerInfo(c);
    expect(info.priorityVersion).toMatch(/^25\./);
    expect(info.loginName.length).toBeGreaterThan(0);
    expect(Array.isArray(info.companies)).toBe(true);
    expect(info.companies.length).toBeGreaterThan(0);
  });

  it("b) query LOGPART filterField=TYPE filterValue=P top=5 → all rows TYPE==='P', ≤5 rows", {
    timeout: 60_000,
  }, async () => {
    const c = buildContext();
    // Resolve the schema first so the metadata is warm for case (c)'s zero-HTTP check.
    await c.meta.getEntitySchema("LOGPART");
    const rows = await queryRecords(c, {
      entity: "LOGPART",
      filterField: "TYPE",
      filterValue: "P",
      top: 5,
    });
    expect(rows.length).toBeLessThanOrEqual(5);
    for (const row of rows) {
      expect(row.TYPE).toBe("P");
    }
  });

  it("c) filterField=ZZZNOPE → typed validation_error, ZERO HTTP calls (silent-swallow guard)", {
    timeout: 60_000,
  }, async () => {
    // Use a fetch-counting client so we can assert ZERO HTTP calls. The shared
    // MetadataStore already has LOGPART cached (warmed in case b), so schema
    // resolution stays in-memory and validation rejects the unknown field
    // before any GET is issued.
    const lc = liveConfig;
    if (!lc) throw new Error("live sandbox configuration missing");
    let httpCalls = 0;
    const countingFetch: typeof fetch = (input, init) => {
      httpCalls += 1;
      return fetch(input, init);
    };
    const countingClient = new PriorityClient({
      serviceRoot: lc.serviceRoot,
      username: lc.username,
      password: lc.password,
      fetchImpl: countingFetch,
      rateLimitPerMinute: 100_000,
    });
    const c = buildContext();
    const spyCtx: ReadToolContext = { client: countingClient, meta: c.meta };

    await expect(
      queryRecords(spyCtx, { entity: "LOGPART", filterField: "ZZZNOPE", filterValue: "x" }),
    ).rejects.toMatchObject({ kind: "validation_error" });
    expect(httpCalls).toBe(0);
  });

  it("d) get_record AINVOICES by full composite key", { timeout: 60_000 }, async () => {
    const c = buildContext();
    const list = (await c.client.get("AINVOICES?$top=1&$select=IVNUM,IVTYPE,DEBIT")) as {
      value: Array<{ IVNUM: string; IVTYPE: string; DEBIT: string }>;
    };
    const inv = list.value[0];
    if (!inv) throw new Error("sandbox returned no AINVOICES rows");

    const record = await getRecord(c, {
      entity: "AINVOICES",
      key: { IVNUM: inv.IVNUM, IVTYPE: inv.IVTYPE, DEBIT: inv.DEBIT },
    });
    expect(record.IVNUM).toBe(inv.IVNUM);
    expect(record.DEBIT).toBe(inv.DEBIT);
    expect(record.IVTYPE).toBe(inv.IVTYPE);
  });
});
