/**
 * Metadata / discovery tools:
 * - `priority_list_entities` — entity names from the service ROOT document.
 * - `priority_get_entity_schema` — keyFields, properties, navigationProperties,
 *   and `subforms` (navigation names ending `_SUBFORM`).
 *
 * Discovery protocol (verified in docs/priority-api-verified.md): the root
 * document is `GET {serviceRoot}/` → `{"value":[{name:"ENTITY"}]}`. The full
 * `$metadata` document is NEVER fetched — it times out (>30s on 25.0). Entity
 * schema details come from `GetMetadataFor(entity='X')` via MetadataStore,
 * which warms the form first and caches (memory + disk).
 */

import type { EntitySchema } from "../priority/metadata.js";
import type { ReadToolContext } from "./context.js";
import { validationError } from "./errors.js";

/** OData v4 service-root document: `{"@odata.context":…,"value":[{"name":"…"}]}`. */
interface ServiceRootDocument {
  "@odata.context"?: string;
  value?: Array<{ name?: string }>;
}

const ENTITY_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** List entity-set names from the service root document (never $metadata). */
export async function listEntities(ctx: ReadToolContext): Promise<string[]> {
  const root = await ctx.client.get<ServiceRootDocument>("", { op: "service root document" });
  const names = Array.isArray(root.value)
    ? root.value
        .map((entry) => entry.name)
        .filter((name): name is string => name !== undefined && ENTITY_NAME_RE.test(name))
    : [];

  const unique = [...new Set(names)].sort();
  return unique;
}

export interface EntitySchemaResult {
  entity: string;
  keyFields: string[];
  properties: Array<{
    name: string;
    type: string;
    maxLength: number | undefined;
    mandatory: boolean;
    description: string | undefined;
  }>;
  navigationProperties: Array<{
    name: string;
    collection: boolean;
    target: string;
  }>;
  /** Navigation property names ending `_SUBFORM` (subforms). */
  subforms: string[];
}

function toResult(schema: EntitySchema): EntitySchemaResult {
  const subforms = schema.navigationProperties
    .filter((nav) => nav.name.endsWith("_SUBFORM"))
    .map((nav) => nav.name);

  return {
    entity: schema.entity,
    keyFields: schema.keyFields,
    properties: schema.properties.map((property) => ({
      name: property.name,
      type: property.type,
      maxLength: property.maxLength,
      mandatory: property.mandatory,
      description: property.description,
    })),
    navigationProperties: schema.navigationProperties.map((nav) => ({
      name: nav.name,
      collection: nav.collection,
      target: nav.target,
    })),
    subforms,
  };
}

/** Entity schema from MetadataStore (key fields, properties, navigation, subforms). */
export async function getEntitySchema(
  ctx: ReadToolContext,
  entity: string,
): Promise<EntitySchemaResult> {
  if (!ENTITY_NAME_RE.test(entity)) {
    throw validationError(`entity names must be UPPERCASE ([A-Z][A-Z0-9_]*) — got "${entity}"`);
  }
  const schema = await ctx.meta.getEntitySchema(entity);
  return toResult(schema);
}
