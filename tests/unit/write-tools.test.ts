/**
 * Train-4 unit tests: gated write tools.
 *
 * Everything HTTP is injected/mocked — no network. Live sandbox coverage
 * lives in tests/integration/sandbox.spec.ts.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import type { PriorityClient } from "../../src/priority/client.js";
import { priorityError } from "../../src/priority/errors.js";
import type { EntitySchema } from "../../src/priority/metadata.js";
import { DELETE_ANNOTATIONS, WRITE_ANNOTATIONS } from "../../src/tools/annotations.js";
import type { ReadToolContext } from "../../src/tools/context.js";
import {
  createRecord,
  deleteRecord,
  setText,
  updateRecord,
  uploadAttachment,
} from "../../src/tools/write.js";

function makeSchema(overrides: Partial<EntitySchema> = {}): EntitySchema {
  return {
    entity: "FAMILY_LOG",
    keyFields: ["FAMILYNAME"],
    properties: [
      {
        name: "FAMILYNAME",
        type: "Edm.String",
        maxLength: 16,
        mandatory: true,
        description: undefined,
      },
      {
        name: "FAMILYDESC",
        type: "Edm.String",
        maxLength: 40,
        mandatory: false,
        description: undefined,
      },
    ],
    navigationProperties: [
      { name: "EXTFILES_SUBFORM", collection: true, target: "EXTFILES" },
      { name: "ORDERSTEXT_SUBFORM", collection: false, target: "ORDERSTEXT" },
    ],
    fetchedAt: Date.now(),
    source: "network",
    ...overrides,
  };
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function makeContext(
  schemaByEntity: Record<string, EntitySchema>,
  responses: Array<Record<string, unknown> | { status: number }> = [],
) {
  const calls: Call[] = [];
  let responseIndex = 0;
  const client = {
    get: async (path: string) => {
      calls.push({ method: "GET", path });
      const response = responses[responseIndex++];
      if (response && "status" in response && typeof response.status === "number") {
        throw priorityError(response.status === 404 ? "not_found" : "server_error", {
          message: `mock ${response.status}`,
        });
      }
      return response ?? {};
    },
    post: async (path: string, body: unknown) => {
      calls.push({ method: "POST", path, body });
      const response = responses[responseIndex++];
      if (response && "status" in response && typeof response.status === "number") {
        throw priorityError("validation_error", { message: `mock ${response.status}` });
      }
      return response ?? {};
    },
    patch: async (path: string, body: unknown) => {
      calls.push({ method: "PATCH", path, body });
      return responses[responseIndex++] ?? {};
    },
    deleteRecord: async (path: string) => {
      calls.push({ method: "DELETE", path });
      return {};
    },
  } as unknown as PriorityClient;
  const meta = {
    getEntitySchema: async (entity: string) => {
      const schema = schemaByEntity[entity];
      if (!schema) throw priorityError("not_found", { message: `no schema for ${entity}` });
      return schema;
    },
  };
  return { ctx: { client, meta } as unknown as ReadToolContext, calls };
}

describe("write tools — validation before HTTP", () => {
  it("rejects unknown plain fields with zero HTTP calls", async () => {
    const { ctx, calls } = makeContext({ FAMILY_LOG: makeSchema() });
    await expect(
      createRecord(ctx, {
        entity: "FAMILY_LOG",
        fields: { FAMILYNAME: "1", NOPE: "x" },
        dryRun: false,
      }),
    ).rejects.toThrow(/unknown field "NOPE"/);
    expect(calls).toHaveLength(0);
  });

  it("rejects unknown subform names with zero HTTP calls", async () => {
    const { ctx, calls } = makeContext({ FAMILY_LOG: makeSchema() });
    await expect(
      createRecord(ctx, {
        entity: "FAMILY_LOG",
        fields: { FAMILYNAME: "1" },
        subforms: { WRONG_SUBFORM: [{ A: 1 }] },
        dryRun: false,
      }),
    ).rejects.toThrow(/unknown subform "WRONG_SUBFORM"/);
    expect(calls).toHaveLength(0);
  });

  it("rejects partial composite keys with zero HTTP calls", async () => {
    const { ctx, calls } = makeContext({
      AINVOICES: makeSchema({ entity: "AINVOICES", keyFields: ["IVNUM", "IVTYPE", "DEBIT"] }),
    });
    await expect(
      updateRecord(ctx, {
        entity: "AINVOICES",
        key: { IVNUM: "T1" },
        fields: { STATDES: "x" },
        dryRun: false,
      }),
    ).rejects.toThrow(/missing key field\(s\): IVTYPE, DEBIT/);
    expect(calls).toHaveLength(0);
  });

  it("rejects missing mandatory fields (25.1 annotations)", async () => {
    // FAMILYDESC marked mandatory; key fields are exempt (server may assign).
    const schema = makeSchema({
      properties: [
        {
          name: "FAMILYNAME",
          type: "Edm.String",
          maxLength: 16,
          mandatory: true,
          description: undefined,
        },
        {
          name: "FAMILYDESC",
          type: "Edm.String",
          maxLength: 40,
          mandatory: true,
          description: undefined,
        },
      ],
    });
    const { ctx, calls } = makeContext({ FAMILY_LOG: schema });
    await expect(
      createRecord(ctx, { entity: "FAMILY_LOG", fields: { FAMILYNAME: "1" }, dryRun: false }),
    ).rejects.toThrow(/missing mandatory field\(s\) FAMILYDESC/);
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed data URIs before HTTP", async () => {
    const { ctx, calls } = makeContext({ FAMILY_LOG: makeSchema() });
    await expect(
      uploadAttachment(ctx, {
        entity: "FAMILY_LOG",
        key: { FAMILYNAME: "1" },
        fileLabel: "x",
        dataUri: "not-a-data-uri",
        dryRun: false,
      }),
    ).rejects.toThrow(/dataUri/);
    expect(calls).toHaveLength(0);
  });

  it("rejects delete without confirm=true before HTTP", async () => {
    const { ctx, calls } = makeContext({ FAMILY_LOG: makeSchema() });
    await expect(
      deleteRecord(ctx, {
        entity: "FAMILY_LOG",
        key: { FAMILYNAME: "1" },
        confirm: false,
        dryRun: false,
      }),
    ).rejects.toThrow(/confirm=true/);
    expect(calls).toHaveLength(0);
  });

  it("rejects text forms the entity does not have, before HTTP", async () => {
    const { ctx, calls } = makeContext({ FAMILY_LOG: makeSchema() });
    await expect(
      setText(ctx, {
        entity: "FAMILY_LOG",
        key: { FAMILYNAME: "1" },
        textForm: "NOTES_TEXT_SUBFORM",
        text: "hello",
        dryRun: false,
      }),
    ).rejects.toThrow(/has no "NOTES_TEXT_SUBFORM"/);
    expect(calls).toHaveLength(0);
  });
});

describe("write tools — dry run", () => {
  it("dryRun=true (default) makes ZERO HTTP calls and returns wouldSend", async () => {
    const { ctx, calls } = makeContext({ FAMILY_LOG: makeSchema() });
    const result = (await createRecord(ctx, {
      entity: "FAMILY_LOG",
      fields: { FAMILYNAME: "765", FAMILYDESC: "My Family" },
    })) as { dryRun: boolean; wouldSend: Record<string, unknown> };
    expect(result.dryRun).toBe(true);
    expect(result.wouldSend.FAMILYNAME).toBe("765");
    expect(calls).toHaveLength(0);
  });
});

describe("write tools — execution", () => {
  it("create posts, re-fetches by returned key, reports verified", async () => {
    const created = { FAMILYNAME: "765", FAMILYDESC: "My Family" };
    const { ctx, calls } = makeContext({ FAMILY_LOG: makeSchema() }, [created, created]);
    const result = (await createRecord(ctx, {
      entity: "FAMILY_LOG",
      fields: { FAMILYNAME: "765", FAMILYDESC: "My Family" },
      dryRun: false,
    })) as { created: boolean; verified: boolean; key: Record<string, string> };
    expect(result.created).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.key.FAMILYNAME).toBe("765");
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
  });

  it("delete verifies absence via 404 re-fetch", async () => {
    const { ctx, calls } = makeContext({ FAMILY_LOG: makeSchema() }, [{ status: 404 }]);
    const result = (await deleteRecord(ctx, {
      entity: "FAMILY_LOG",
      key: { FAMILYNAME: "765" },
      confirm: true,
      dryRun: false,
    })) as { deleted: boolean; verified: boolean };
    expect(result.deleted).toBe(true);
    expect(result.verified).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(["DELETE", "GET"]);
  });
});

describe("write annotations", () => {
  it("never claims idempotency; delete is destructive", () => {
    const write: ToolAnnotations = WRITE_ANNOTATIONS;
    expect(write.readOnlyHint).toBe(false);
    expect(write.idempotentHint).toBe(false);
    expect(write.destructiveHint).toBe(false);
    const del: ToolAnnotations = DELETE_ANNOTATIONS;
    expect(del.destructiveHint).toBe(true);
    expect(del.idempotentHint).toBe(false);
  });
});
