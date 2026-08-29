import { describe, expect, it } from "vitest";
import { PriorityClient } from "../../src/priority/client.js";
import type { EntitySchema, MetadataStore } from "../../src/priority/metadata.js";
import { READ_ANNOTATIONS } from "../../src/tools/annotations.js";
import type { ReadToolContext } from "../../src/tools/context.js";
import { getRecord } from "../../src/tools/get.js";
import { getServerInfo } from "../../src/tools/info.js";
import { getEntitySchema, listEntities } from "../../src/tools/meta.js";
import { queryRecords } from "../../src/tools/query.js";

const ROOT = "https://x.example/odata/Priority/tabula.ini,3/demo";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Call {
  url: string;
  init?: RequestInit;
}

/** A real PriorityClient with an injectable fetch; every call is recorded. */
function makeClient(handler: (call: Call) => Promise<Response>, calls: Call[]): PriorityClient {
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = { url, init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return new PriorityClient({
    serviceRoot: ROOT,
    username: "apidemo",
    password: "123",
    fetchImpl,
    rateLimitPerMinute: 100_000,
    cacheSize: 128,
  });
}

/** A stubbed MetadataStore — schema resolution never touches the network. */
function makeMeta(schemas: Record<string, EntitySchema>): MetadataStore {
  return {
    getEntitySchema: async (entity: string) => {
      const schema = schemas[entity];
      if (schema === undefined) {
        throw new Error(`no schema fixture for ${entity}`);
      }
      return schema;
    },
  } as unknown as MetadataStore;
}

function makeContext(client: PriorityClient, meta: MetadataStore): ReadToolContext {
  return { client, meta };
}

const LOGPART_SCHEMA: EntitySchema = {
  entity: "LOGPART",
  keyFields: ["PARTNAME"],
  properties: [
    {
      name: "PARTNAME",
      type: "Edm.String",
      maxLength: 22,
      mandatory: true,
      description: undefined,
    },
    { name: "TYPE", type: "Edm.String", maxLength: 1, mandatory: false, description: undefined },
    {
      name: "QUANT",
      type: "Edm.Decimal",
      maxLength: undefined,
      mandatory: false,
      description: undefined,
    },
  ],
  navigationProperties: [],
  fetchedAt: Date.now(),
  source: "network",
};

const AINVOICES_SCHEMA: EntitySchema = {
  entity: "AINVOICES",
  keyFields: ["IVNUM", "DEBIT", "IVTYPE"],
  properties: [
    { name: "IVNUM", type: "Edm.String", maxLength: 16, mandatory: true, description: undefined },
    { name: "DEBIT", type: "Edm.String", maxLength: 1, mandatory: true, description: undefined },
    { name: "IVTYPE", type: "Edm.String", maxLength: 1, mandatory: true, description: undefined },
    { name: "CDES", type: "Edm.String", maxLength: 48, mandatory: false, description: undefined },
  ],
  navigationProperties: [
    {
      name: "AINVOICEITEMS_SUBFORM",
      collection: true,
      target: "AINVOICEITEMS",
    },
  ],
  fetchedAt: Date.now(),
  source: "network",
};

describe("priority_get_server_info", () => {
  it("returns version, login name and companies with ≤3 HTTP requests", async () => {
    const calls: Call[] = [];
    const client = makeClient((call) => {
      if (call.url.includes("GetPriorityVersion()"))
        return Promise.resolve(jsonResponse({ value: "25.0-123" }));
      if (call.url.includes("GetLoginName()"))
        return Promise.resolve(jsonResponse({ value: "apidemo" }));
      if (call.url.includes("GETCOMPANIES?$top=100"))
        return Promise.resolve(jsonResponse({ value: [{ NAME: "usdemo", TITLE: "US Demo" }] }));
      return Promise.resolve(jsonResponse({}, 404));
    }, calls);
    const ctx = makeContext(client, makeMeta({}));

    const info = await getServerInfo(ctx);
    expect(info.priorityVersion).toBe("25.0-123");
    expect(info.loginName).toBe("apidemo");
    expect(info.companies).toEqual([{ NAME: "usdemo", TITLE: "US Demo" }]);
    expect(calls).toHaveLength(3);
  });
});

describe("priority_list_entities", () => {
  it("reads the service ROOT document, never $metadata, and dedupes + sorts", async () => {
    const calls: Call[] = [];
    const client = makeClient((call) => {
      if (call.url.endsWith(`${ROOT}/`))
        return Promise.resolve(
          jsonResponse({
            value: [
              { name: "CUSTOMERS" },
              { name: "AINVOICES" },
              { name: "AINVOICES" },
              { name: "lowercase_ignored" },
            ],
          }),
        );
      return Promise.resolve(jsonResponse({}, 404));
    }, calls);
    const ctx = makeContext(client, makeMeta({}));

    const entities = await listEntities(ctx);
    expect(entities).toEqual(["AINVOICES", "CUSTOMERS"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${ROOT}/`);
    expect(calls[0]?.url.includes("$metadata")).toBe(false);
  });
});

describe("priority_get_entity_schema", () => {
  it("returns keyFields, properties, navigationProperties and _SUBFORM subforms", async () => {
    const calls: Call[] = [];
    const client = makeClient(() => Promise.resolve(jsonResponse({}, 404)), calls);
    const ctx = makeContext(client, makeMeta({ AINVOICES: AINVOICES_SCHEMA }));

    const schema = await getEntitySchema(ctx, "AINVOICES");
    expect(schema.entity).toBe("AINVOICES");
    expect(schema.keyFields).toEqual(["IVNUM", "DEBIT", "IVTYPE"]);
    expect(schema.properties.map((p) => p.name)).toContain("CDES");
    expect(schema.navigationProperties[0]?.name).toBe("AINVOICEITEMS_SUBFORM");
    expect(schema.subforms).toEqual(["AINVOICEITEMS_SUBFORM"]);
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed entity names with a typed validation_error", async () => {
    const ctx = makeContext(
      makeClient(() => Promise.resolve(jsonResponse({}, 404)), []),
      makeMeta({}),
    );
    await expect(getEntitySchema(ctx, "ainvoices")).rejects.toMatchObject({
      kind: "validation_error",
    });
  });
});

describe("priority_query_records — metadata-validated queries", () => {
  const meta = makeMeta({ LOGPART: LOGPART_SCHEMA });

  it("builds a simple eq filter with top and returns rows", async () => {
    const calls: Call[] = [];
    const client = makeClient((call) => {
      if (call.url.includes("LOGPART?$top=5&$filter=TYPE%20eq%20'P'"))
        return Promise.resolve(jsonResponse({ value: [{ PARTNAME: "A", TYPE: "P" }] }));
      return Promise.resolve(jsonResponse({}, 404));
    }, calls);
    const ctx = makeContext(client, meta);

    const rows = await queryRecords(ctx, {
      entity: "LOGPART",
      filterField: "TYPE",
      filterValue: "P",
      top: 5,
    });
    expect(rows).toEqual([{ PARTNAME: "A", TYPE: "P" }]);
    expect(calls).toHaveLength(1);
  });

  it("rejects an unknown filter field with typed validation_error BEFORE any HTTP call", async () => {
    const calls: Call[] = [];
    const client = makeClient(() => Promise.resolve(jsonResponse({}, 404)), calls);
    const ctx = makeContext(client, meta);

    await expect(
      queryRecords(ctx, { entity: "LOGPART", filterField: "ZZZNOPE", filterValue: "x" }),
    ).rejects.toMatchObject({ kind: "validation_error" });
    expect(calls).toHaveLength(0);
  });

  it("rejects unknown fields in select/orderBy/expand and rawFilter tokens before HTTP", async () => {
    const calls: Call[] = [];
    const client = makeClient(() => Promise.resolve(jsonResponse({}, 404)), calls);
    const ctx = makeContext(client, meta);

    await expect(queryRecords(ctx, { entity: "LOGPART", select: ["NOPE"] })).rejects.toMatchObject({
      kind: "validation_error",
    });
    await expect(queryRecords(ctx, { entity: "LOGPART", orderBy: "NOPE" })).rejects.toMatchObject({
      kind: "validation_error",
    });
    await expect(
      queryRecords(ctx, { entity: "LOGPART", rawFilter: "ZZZNOPE eq 'x'" }),
    ).rejects.toMatchObject({ kind: "validation_error" });
    expect(calls).toHaveLength(0);
  });

  it("ignores UPPERCASE tokens inside quoted string literals in rawFilter", async () => {
    const calls: Call[] = [];
    const client = makeClient((call) => {
      if (call.url.includes("LOGPART?")) return Promise.resolve(jsonResponse({ value: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }, calls);
    const ctx = makeContext(client, meta);

    // "P" is a value, not a field — must not be flagged as unknown.
    const rows = await queryRecords(ctx, { entity: "LOGPART", rawFilter: "TYPE eq 'P'" });
    expect(rows).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("rejects rawFilter + filterField together with a typed validation_error", async () => {
    const calls: Call[] = [];
    const ctx = makeContext(
      makeClient(() => Promise.resolve(jsonResponse({}, 404)), calls),
      meta,
    );
    await expect(
      queryRecords(ctx, {
        entity: "LOGPART",
        rawFilter: "TYPE eq 'P'",
        filterField: "TYPE",
        filterValue: "P",
      }),
    ).rejects.toMatchObject({ kind: "validation_error" });
    expect(calls).toHaveLength(0);
  });

  it("validates top bounds and non-Z since before HTTP", async () => {
    const calls: Call[] = [];
    const ctx = makeContext(
      makeClient(() => Promise.resolve(jsonResponse({}, 404)), calls),
      meta,
    );

    await expect(queryRecords(ctx, { entity: "LOGPART", top: 5000 })).rejects.toMatchObject({
      kind: "validation_error",
    });
    await expect(
      queryRecords(ctx, { entity: "LOGPART", since: "2020-01-01T07:25:00+02:00" }),
    ).rejects.toMatchObject({ kind: "validation_error" });
    expect(calls).toHaveLength(0);
  });
});

describe("priority_get_record — composite keys", () => {
  const meta = makeMeta({ AINVOICES: AINVOICES_SCHEMA });

  it("builds a composite key segment (any key order) and GETs the record", async () => {
    const calls: Call[] = [];
    const client = makeClient((call) => {
      if (call.url.includes("AINVOICES(IVNUM='T00000001',IVTYPE='A',DEBIT='D')"))
        return Promise.resolve(jsonResponse({ IVNUM: "T00000001", IVTYPE: "A", DEBIT: "D" }));
      return Promise.resolve(jsonResponse({}, 404));
    }, calls);
    const ctx = makeContext(client, meta);

    const record = await getRecord(ctx, {
      entity: "AINVOICES",
      key: { IVNUM: "T00000001", IVTYPE: "A", DEBIT: "D" },
    });
    expect(record.IVNUM).toBe("T00000001");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("AINVOICES(IVNUM='T00000001',IVTYPE='A',DEBIT='D')");
  });

  it("rejects a partial key with typed validation_error BEFORE any HTTP call", async () => {
    const calls: Call[] = [];
    const ctx = makeContext(
      makeClient(() => Promise.resolve(jsonResponse({}, 404)), calls),
      meta,
    );

    await expect(
      getRecord(ctx, { entity: "AINVOICES", key: { IVNUM: "T00000001" } }),
    ).rejects.toMatchObject({ kind: "validation_error" });
    expect(calls).toHaveLength(0);
  });

  it("rejects extra key fields not in metadata keyFields", async () => {
    const calls: Call[] = [];
    const ctx = makeContext(
      makeClient(() => Promise.resolve(jsonResponse({}, 404)), calls),
      meta,
    );
    await expect(
      getRecord(ctx, {
        entity: "AINVOICES",
        key: { IVNUM: "T00000001", DEBIT: "D", IVTYPE: "A", EXTRA: "x" },
      }),
    ).rejects.toMatchObject({ kind: "validation_error" });
    expect(calls).toHaveLength(0);
  });

  it("validates select fields against the schema before HTTP", async () => {
    const calls: Call[] = [];
    const ctx = makeContext(
      makeClient(() => Promise.resolve(jsonResponse({}, 404)), calls),
      meta,
    );
    await expect(
      getRecord(ctx, {
        entity: "AINVOICES",
        key: { IVNUM: "T00000001", DEBIT: "D", IVTYPE: "A" },
        select: ["NOPE"],
      }),
    ).rejects.toMatchObject({ kind: "validation_error" });
    expect(calls).toHaveLength(0);
  });
});

describe("READ_ANNOTATIONS", () => {
  it("marks reads as read-only, idempotent, non-destructive and open-world", () => {
    expect(READ_ANNOTATIONS).toEqual({
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
  });
});
