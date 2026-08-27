import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PriorityClient } from "../../src/priority/client.js";
import { PriorityError } from "../../src/priority/errors.js";
import { MetadataStore, parseEntitySchema } from "../../src/priority/metadata.js";

/**
 * The REAL GetMetadataFor(entity='AINVOICES') sandbox response (33KB),
 * saved during train 1 — verified byte-identical to the live response
 * (2026-08-26, Priority 25.0). Used when present; CI falls back to the
 * embedded equivalent fixture below (same composite key IVNUM/DEBIT/IVTYPE,
 * Hebrew descriptions, Mandatory annotation, collection + singleton
 * navigation subforms).
 */
const REAL_FIXTURE_PATH = "/tmp/ainv_meta.xml";
const realFixture: string | null = existsSync(REAL_FIXTURE_PATH)
  ? readFileSync(REAL_FIXTURE_PATH, "utf8")
  : null;

/** Embedded equivalent fixture — always present, so CI runs the same parser. */
const EMBEDDED_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Priority.OData" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <Term Name="AutoUnique" Type="Edm.Boolean"></Term>
      <Term Name="Description" Type="Edm.String"></Term>
      <Term Name="DateType" Type="Edm.String"></Term>
      <Term Name="Mandatory" Type="Edm.Boolean"></Term>
      <Function Name="GetMetadataFor">
        <ReturnType Type="Edm.String" Nullable="false"></ReturnType>
        <Parameter Name="entity" Type="Edm.String" Nullable="false"></Parameter>
      </Function>
      <Action Name="ClearEntityMetadata">
        <Parameter Name="Entity" Type="Edm.String"></Parameter>
      </Action>
      <EntityType Name="GETCOMPANIES">
        <Key>
          <PropertyRef Name="NAME"></PropertyRef>
        </Key>
        <Property Name="NAME" Type="Edm.String" MaxLength="8"></Property>
        <Property Name="TITLE" Type="Edm.String" MaxLength="48"></Property>
      </EntityType>
      <EntityType Name="AINVOICES">
        <Key>
          <PropertyRef Name="IVNUM"></PropertyRef>
          <PropertyRef Name="DEBIT"></PropertyRef>
          <PropertyRef Name="IVTYPE"></PropertyRef>
        </Key>
        <Property Name="CUSTNAME" Type="Edm.String" MaxLength="16">
          <Annotation Term="Priority.OData.Description" String="מס. לקוח"></Annotation>
        </Property>
        <Property Name="CDES" Type="Edm.String" MaxLength="48">
          <Annotation Term="Priority.OData.Description" String="שם לקוח"></Annotation>
        </Property>
        <Property Name="IVNUM" Type="Edm.String" MaxLength="16">
          <Annotation Term="Priority.OData.Mandatory" Bool="true"></Annotation>
          <Annotation Term="Priority.OData.Description" String="חשבונית"></Annotation>
          <Annotation Term="Org.OData.Core.V1.Permissions">
            <EnumMember>Org.OData.Core.V1.Permission/Read</EnumMember>
          </Annotation>
        </Property>
        <Property Name="FINAL" Type="Edm.String" MaxLength="1">
          <Annotation Term="Priority.OData.Description" String="סופית"></Annotation>
        </Property>
        <Property Name="IVDATE" Type="Edm.DateTimeOffset">
          <Annotation Term="Priority.OData.DateType" String="Date"></Annotation>
          <Annotation Term="Priority.OData.Description" String="תאריך"></Annotation>
        </Property>
        <Property Name="PERCENT" Type="Edm.Decimal" Precision="8" Scale="2">
          <Annotation Term="Priority.OData.Description" String="קביעת הנחה כללית %"></Annotation>
        </Property>
        <Property Name="QPRICE" Type="Edm.Decimal" Precision="16" Scale="2">
          <Annotation Term="Priority.OData.Description" String="סכום לפני הנחה"></Annotation>
        </Property>
        <Property Name="TOTPRICE" Type="Edm.Decimal" Precision="16" Scale="2">
          <Annotation Term="Priority.OData.Description" String="סה&quot;כ"></Annotation>
        </Property>
        <Property Name="VAT" Type="Edm.Decimal" Precision="16" Scale="2">
          <Annotation Term="Priority.OData.Description" String="מע&quot;מ"></Annotation>
        </Property>
        <Property Name="STATDES" Type="Edm.String" MaxLength="12">
          <Annotation Term="Priority.OData.Description" String="סטטוס"></Annotation>
        </Property>
        <Property Name="OWNERLOGIN" Type="Edm.String" MaxLength="20">
          <Annotation Term="Priority.OData.Description" String="לטיפול"></Annotation>
        </Property>
        <Property Name="DEBIT" Type="Edm.String" MaxLength="1">
          <Annotation Term="Priority.OData.Mandatory" Bool="true"></Annotation>
        </Property>
        <Property Name="IVTYPE" Type="Edm.String" MaxLength="1">
          <Annotation Term="Priority.OData.Mandatory" Bool="true"></Annotation>
        </Property>
        <NavigationProperty Name="AINVOICEITEMS_SUBFORM" Type="Collection(Priority.OData.AINVOICEITEMS)" ContainsTarget="true">
          <Annotation Term="Priority.OData.Description" String="מוצרי חשבונית"></Annotation>
        </NavigationProperty>
        <NavigationProperty Name="SHIPTO2_SUBFORM" Type="Priority.OData.SHIPTO2" ContainsTarget="true">
          <Annotation Term="Priority.OData.Description" String="אספקה"></Annotation>
        </NavigationProperty>
      </EntityType>
      <EntityContainer Name="DefaultContainer">
        <EntitySet Name="GETCOMPANIES" EntityType="Priority.OData.GETCOMPANIES"></EntitySet>
        <EntitySet Name="AINVOICES" EntityType="Priority.OData.AINVOICES"></EntitySet>
        <FunctionImport Name="GetMetadataFor" Function="Priority.OData.GetMetadataFor"></FunctionImport>
        <ActionImport Name="ClearEntityMetadata" Action="Priority.OData.ClearEntityMetadata"></ActionImport>
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;

const fixture: string = realFixture ?? EMBEDDED_FIXTURE;

function xmlResponse(xml: string, status = 200): Response {
  return new Response(xml, { status, headers: { "Content-Type": "application/xml" } });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ROOT = "https://x.example/odata/Priority/tabula.ini,3/demo";

interface Call {
  url: string;
  init?: RequestInit;
}

function makeStore(
  handler: (call: Call) => Promise<Response>,
  calls: Call[],
  diskDir: string,
): MetadataStore {
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: Call = { url, init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  const client = new PriorityClient({
    serviceRoot: ROOT,
    username: "apidemo",
    password: "123",
    fetchImpl,
    rateLimitPerMinute: 10_000,
    cacheSize: 32,
  });
  return new MetadataStore(client, {
    envLabel: "demo",
    company: "demo",
    diskDir,
  });
}

const WRONG_ENTITY_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Priority.OData" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="ADDRECIPIENTS">
        <Key><PropertyRef Name="TYPE"></PropertyRef></Key>
        <Property Name="TYPE" Type="Edm.String" MaxLength="8"></Property>
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;

const CUSTOMERS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Priority.OData" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="CUSTOMERS">
        <Key><PropertyRef Name="CUSTNAME"></PropertyRef></Key>
        <Property Name="CUSTNAME" Type="Edm.String" MaxLength="16"></Property>
        <Property Name="CDES" Type="Edm.String" MaxLength="48"></Property>
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>
`;

describe("parseEntitySchema — CSDL XML parsing", () => {
  it("extracts the composite key in metadata order (IVNUM, DEBIT, IVTYPE)", () => {
    const parsed = parseEntitySchema(fixture, "AINVOICES");
    expect(parsed.name).toBe("AINVOICES");
    expect(parsed.keyFields).toEqual(["IVNUM", "DEBIT", "IVTYPE"]);
  });

  it("extracts properties with types, maxLength and Hebrew descriptions", () => {
    const parsed = parseEntitySchema(fixture, "AINVOICES");
    expect(parsed.properties.length).toBeGreaterThan(10);

    const custname = parsed.properties.find((p) => p.name === "CUSTNAME");
    expect(custname?.type).toBe("Edm.String");
    expect(custname?.maxLength).toBe(16);
    expect(custname?.description).toBe("מס. לקוח");

    const ivdate = parsed.properties.find((p) => p.name === "IVDATE");
    expect(ivdate?.type).toBe("Edm.DateTimeOffset");
    expect(ivdate?.maxLength).toBeUndefined();
    expect(ivdate?.description).toBe("תאריך");

    const qprice = parsed.properties.find((p) => p.name === "QPRICE");
    expect(qprice?.type).toBe("Edm.Decimal");
  });

  it("extracts collection and singleton navigation properties", () => {
    const parsed = parseEntitySchema(fixture, "AINVOICES");
    const subform = parsed.navigationProperties.find((nav) => nav.name === "AINVOICEITEMS_SUBFORM");
    expect(subform?.collection).toBe(true);
    expect(subform?.target).toBe("AINVOICEITEMS");

    const singleton = parsed.navigationProperties.find((nav) => nav.name === "SHIPTO2_SUBFORM");
    expect(singleton?.collection).toBe(false);
    expect(singleton?.target).toBe("SHIPTO2");
  });

  it("parses the Mandatory annotation (embedded fixture guarantees a case)", () => {
    const parsed = parseEntitySchema(EMBEDDED_FIXTURE, "AINVOICES");
    expect(parsed.properties.find((p) => p.name === "IVNUM")?.mandatory).toBe(true);
    expect(parsed.properties.find((p) => p.name === "CDES")?.mandatory).toBe(false);
  });

  it("decodes numeric character references in attribute values (live sandbox uses &#34;)", () => {
    // Real sandbox: PARTNAME Description = "מק&#34;ט" (מק"ט — Hebrew "SKU").
    const xml = `<?xml version="1.0"?>
<edmx:Edmx xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Priority.OData" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="LOGPART">
        <Key><PropertyRef Name="PARTNAME"></PropertyRef></Key>
        <Property Name="PARTNAME" Type="Edm.String" MaxLength="22">
          <Annotation Term="Priority.OData.Description" String="מק&#34;ט"></Annotation>
        </Property>
      </EntityType>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
    const parsed = parseEntitySchema(xml, "LOGPART");
    expect(parsed.properties.find((p) => p.name === "PARTNAME")?.description).toBe('מק"ט');
  });

  it("reports the FIRST EntityType when the requested one is absent (stale detection hook)", () => {
    const parsed = parseEntitySchema(fixture, "ZZZNOPE");
    expect(parsed.name).toBe("GETCOMPANIES");
  });

  it("parses single-key entities (GETCOMPANIES)", () => {
    const parsed = parseEntitySchema(fixture, "GETCOMPANIES");
    expect(parsed.keyFields).toEqual(["NAME"]);
    expect(parsed.properties.map((p) => p.name)).toEqual(["NAME", "TITLE"]);
  });

  it.skipIf(realFixture === null)(
    "parses the REAL sandbox fixture (train-1 artifact, byte-identical to live)",
    () => {
      const parsed = parseEntitySchema(fixture, "AINVOICES");
      expect(parsed.properties.length).toBeGreaterThan(50);
      expect(parsed.navigationProperties.length).toBeGreaterThan(10);
    },
  );
});

describe("MetadataStore", () => {
  let diskDir: string;
  let calls: Call[];

  beforeEach(async () => {
    diskDir = await mkdtemp(path.join(tmpdir(), "priority-mcp-test-"));
    calls = [];
  });

  afterEach(async () => {
    await rm(diskDir, { recursive: true, force: true });
  });

  it("warms up (GET ?$top=1) BEFORE GetMetadataFor, then parses and caches to disk", async () => {
    const store = makeStore(
      (call) => {
        if (call.url.endsWith("AINVOICES?$top=1"))
          return Promise.resolve(jsonResponse({ value: [] }));
        if (call.url.includes("GetMetadataFor")) return Promise.resolve(xmlResponse(fixture));
        return Promise.resolve(jsonResponse({}, 404));
      },
      calls,
      diskDir,
    );

    const schema = await store.getEntitySchema("AINVOICES");
    expect(schema.entity).toBe("AINVOICES");
    expect(schema.keyFields).toEqual(["IVNUM", "DEBIT", "IVTYPE"]);
    expect(schema.source).toBe("network");
    expect(schema.properties.length).toBeGreaterThan(10);

    // Order: warm-up first, metadata second.
    expect(calls[0]?.url).toContain("AINVOICES?$top=1");
    expect(calls[1]?.url).toContain("GetMetadataFor(entity='AINVOICES')");

    // Disk cache: a brand-new store on the same diskDir must not re-fetch.
    const calls2: Call[] = [];
    const store2 = makeStore(
      (call) => {
        calls2.push(call);
        return Promise.resolve(jsonResponse({}, 500));
      },
      calls2,
      diskDir,
    );
    const fromDisk = await store2.getEntitySchema("AINVOICES");
    expect(fromDisk.source).toBe("disk");
    expect(fromDisk.keyFields).toEqual(["IVNUM", "DEBIT", "IVTYPE"]);
    expect(calls2).toHaveLength(0);
  });

  it("detects stale metadata (wrong EntityType), warms up once more and retries", async () => {
    let metadataCalls = 0;
    const store = makeStore(
      (call) => {
        if (call.url.endsWith("CUSTOMERS?$top=1"))
          return Promise.resolve(jsonResponse({ value: [] }));
        if (call.url.includes("GetMetadataFor")) {
          metadataCalls += 1;
          return Promise.resolve(
            xmlResponse(metadataCalls === 1 ? WRONG_ENTITY_FIXTURE : CUSTOMERS_FIXTURE),
          );
        }
        return Promise.resolve(jsonResponse({}, 404));
      },
      calls,
      diskDir,
    );

    const schema = await store.getEntitySchema("CUSTOMERS");
    expect(schema.entity).toBe("CUSTOMERS");
    expect(schema.keyFields).toEqual(["CUSTNAME"]);
    // One stale metadata response + one retried metadata response.
    expect(metadataCalls).toBe(2);
    // Warm-up ran twice (before each metadata fetch).
    const warmUps = calls.filter((call) => call.url.endsWith("CUSTOMERS?$top=1"));
    expect(warmUps).toHaveLength(2);
  });

  it("fails loudly when metadata is stale even after the warm-up retry", async () => {
    const store = makeStore(
      (call) => {
        if (call.url.endsWith("CUSTOMERS?$top=1"))
          return Promise.resolve(jsonResponse({ value: [] }));
        if (call.url.includes("GetMetadataFor"))
          return Promise.resolve(xmlResponse(WRONG_ENTITY_FIXTURE));
        return Promise.resolve(jsonResponse({}, 404));
      },
      calls,
      diskDir,
    );

    await expect(store.getEntitySchema("CUSTOMERS")).rejects.toMatchObject({
      kind: "unexpected_response",
    });
  });

  it("double-probes 404s on warm-up before declaring an entity dead", async () => {
    const store = makeStore(() => Promise.resolve(jsonResponse({}, 404)), calls, diskDir);

    await expect(store.getEntitySchema("ZZZNOPE")).rejects.toMatchObject({ kind: "not_found" });
    const warmUps = calls.filter((call) => call.url.endsWith("ZZZNOPE?$top=1"));
    expect(warmUps).toHaveLength(2);
    expect(calls.some((call) => call.url.includes("GetMetadataFor"))).toBe(false);
  });

  it("invalidates via ClearEntityMetadata POST and clears memory + disk caches", async () => {
    let metadataCalls = 0;
    let clearCalls = 0;
    const store = makeStore(
      (call) => {
        if (call.url.endsWith("AINVOICES?$top=1"))
          return Promise.resolve(jsonResponse({ value: [] }));
        if (call.url.includes("GetMetadataFor")) {
          metadataCalls += 1;
          return Promise.resolve(xmlResponse(fixture));
        }
        if (call.url.includes("ClearEntityMetadata")) {
          clearCalls += 1;
          return Promise.resolve(new Response("All metadata cleared", { status: 200 }));
        }
        return Promise.resolve(jsonResponse({}, 404));
      },
      calls,
      diskDir,
    );

    await store.getEntitySchema("AINVOICES");
    await store.invalidate("AINVOICES");

    expect(clearCalls).toBe(1);
    const clearCall = calls.find((call) => call.url.includes("ClearEntityMetadata"));
    expect(clearCall?.init?.method).toBe("POST");
    expect(clearCall?.init?.body).toBe(JSON.stringify({ Entity: "AINVOICES" }));

    // Disk file removed — a fresh store on the same dir must re-fetch.
    await expect(
      readFile(path.join(diskDir, `${store.cacheKey("AINVOICES")}.json`)),
    ).rejects.toThrow();
    const before = metadataCalls;
    const calls2: Call[] = [];
    const store2 = makeStore(
      (call) => {
        if (call.url.endsWith("AINVOICES?$top=1"))
          return Promise.resolve(jsonResponse({ value: [] }));
        if (call.url.includes("GetMetadataFor")) {
          metadataCalls += 1;
          return Promise.resolve(xmlResponse(fixture));
        }
        return Promise.resolve(jsonResponse({}, 404));
      },
      calls2,
      diskDir,
    );
    const refetched = await store2.getEntitySchema("AINVOICES");
    expect(refetched.source).toBe("network");
    expect(metadataCalls).toBe(before + 1);
  });

  it("normalizes entity names to UPPERCASE and validates them", async () => {
    const store = makeStore(() => Promise.resolve(xmlResponse(fixture)), calls, diskDir);
    const schema = await store.getEntitySchema("  ainvoices ");
    expect(schema.entity).toBe("AINVOICES");

    await expect(store.getEntitySchema("ain voices")).rejects.toThrow(PriorityError);
  });
});
