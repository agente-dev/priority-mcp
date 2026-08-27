import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { PriorityClient } from "../../src/priority/client.js";
import { MetadataStore } from "../../src/priority/metadata.js";

// Live sandbox integration — skips cleanly when creds absent.
// Sandbox coordinates: docs/priority-api-verified.md
const cfg = loadConfig();
const live = cfg.ok;
const config = live ? cfg.config : undefined;
const client = live ? new PriorityClient(config!) : undefined;
const meta = client
  ? new MetadataStore(client, {
      envLabel: config!.environment,
      company: config!.company,
    })
  : undefined;

describe.skipIf(!live)("live sandbox", () => {
  it("fetches Priority version", { timeout: 60_000 }, async () => {
    const ver = (await client!.request("GetPriorityVersion()")) as { value?: string };
    expect(ver.value).toMatch(/^2[0-9]\./);
  });

  it("resolves LOGPART schema via warm-up + GetMetadataFor", { timeout: 60_000 }, async () => {
    const schema = await meta!.getEntitySchema("LOGPART");
    expect(schema.properties.length).toBeGreaterThan(10);
    expect(schema.keyFields).toContain("PARTNAME");
  });

  it("GETs a row by full composite key (AINVOICES)", { timeout: 60_000 }, async () => {
    const row = (await client!.request("AINVOICES?$top=1&$select=IVNUM,IVTYPE,DEBIT")) as {
      value: Array<{ IVNUM: string; IVTYPE: string; DEBIT: string }>;
    };
    const inv = row.value[0];
    if (!inv) throw new Error("sandbox returned no AINVOICES rows");
    const keySeg = `AINVOICES(IVNUM='${inv.IVNUM}',IVTYPE='${inv.IVTYPE}',DEBIT='${inv.DEBIT}')`;
    const one = (await client!.request(`${keySeg}?$select=IVNUM,IVTYPE,DEBIT`)) as {
      IVNUM: string;
    };
    expect(one.IVNUM).toBe(inv.IVNUM);
  });
});
