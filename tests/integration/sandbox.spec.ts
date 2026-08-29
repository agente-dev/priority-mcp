import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { PriorityClient } from "../../src/priority/client.js";
import { MetadataStore } from "../../src/priority/metadata.js";
import type { ReadToolContext } from "../../src/tools/context.js";
import { getRecord } from "../../src/tools/get.js";
import { getServerInfo } from "../../src/tools/info.js";
import { queryRecords } from "../../src/tools/query.js";
import { createRecord, deleteRecord, updateRecord } from "../../src/tools/write.js";

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

describe.skipIf(liveConfig === undefined)("live sandbox write tools", () => {
  it("e) FAMILY_LOG create→verify→delete round-trip (central claim)", {
    timeout: 120_000,
  }, async () => {
    const c = buildContext();
    const key = { FAMILYNAME: `ZZT${Math.floor(Math.random() * 9000 + 1000)}` };
    try {
      // dryRun first — zero HTTP for the preview
      const preview = (await createRecord(c, {
        entity: "FAMILY_LOG",
        fields: { ...key, FAMILYDESC: "train4 probe" },
      })) as { dryRun: boolean };
      expect(preview.dryRun).toBe(true);

      // real create
      const created = (await createRecord(c, {
        entity: "FAMILY_LOG",
        fields: { ...key, FAMILYDESC: "train4 probe" },
        dryRun: false,
      })) as { created: boolean; verified: boolean; key: Record<string, string> };
      expect(created.created).toBe(true);
      expect(created.verified).toBe(true);
      expect(created.key.FAMILYNAME).toBe(key.FAMILYNAME);
    } finally {
      // cleanup even on assertion failure — writes bill vendor transactions
      const gone = (await deleteRecord(c, {
        entity: "FAMILY_LOG",
        key,
        confirm: true,
        dryRun: false,
      })) as { deleted: boolean; verified: boolean };
      expect(gone.deleted).toBe(true);
      expect(gone.verified).toBe(true); // re-fetch 404 after delete
    }
  });

  it("f) create with unknown field → typed validation_error, ZERO HTTP (writes get the same guard as reads)", {
    timeout: 60_000,
  }, async () => {
    const c = buildContext();
    await expect(
      createRecord(c, {
        entity: "FAMILY_LOG",
        fields: { FAMILYNAME: "ZZNOPE", NOT_A_FIELD: "x" },
        dryRun: false,
      }),
    ).rejects.toThrow(/unknown field "NOT_A_FIELD"/);
  });

  it("g) update_record live: create→UPDATE→verify→delete round-trip", {
    timeout: 120_000,
  }, async () => {
    const c = buildContext();
    const key = { FAMILYNAME: `ZZU${Math.floor(Math.random() * 9000 + 1000)}` };
    try {
      const created = (await createRecord(c, {
        entity: "FAMILY_LOG",
        fields: { ...key, FAMILYDESC: "before update" },
        dryRun: false,
      })) as { created: boolean; verified: boolean };
      expect(created.created && created.verified).toBe(true);

      const updated = (await updateRecord(c, {
        entity: "FAMILY_LOG",
        key,
        fields: { FAMILYDESC: "after update" },
        dryRun: false,
      })) as { updated: boolean; verified: boolean; refetched?: { FAMILYDESC?: string } };
      expect(updated.updated).toBe(true);
      expect(updated.verified).toBe(true);
      expect(updated.refetched?.FAMILYDESC).toBe("after update");
    } finally {
      const gone = (await deleteRecord(c, {
        entity: "FAMILY_LOG",
        key,
        confirm: true,
        dryRun: false,
      })) as { deleted: boolean; verified: boolean };
      expect(gone.deleted && gone.verified).toBe(true);
    }
  });
});
