/**
 * MetadataStore — schema discovery for Priority entities.
 *
 * Discovery protocol (verified in docs/priority-api-verified.md):
 * 1. WARM UP the form first: `GET {entity}?$top=1`. Cold forms can 404 on
 *    first probe (LOGCOUNTERS: 404 then 200) and `GetMetadataFor` right
 *    after a cold boot can return metadata for a DIFFERENT entity — the
 *    warm-up compiles the server-side form and metadata.
 * 2. `GET GetMetadataFor(entity='X')` returns CSDL XML (verified live; the
 *    sandbox response is 33KB XML, parsed here with a tiny no-dependency
 *    XML reader). Full `$metadata` fetch is FORBIDDEN — it times out.
 * 3. Stale detection: if the returned EntityType name ≠ requested, warm up
 *    once more and refetch; if STILL stale, fail loudly.
 * 4. Results (key fields, properties with Mandatory/Description annotations,
 *    navigation properties) are cached in memory and on disk under
 *    `os.tmpdir()/priority-mcp/`, keyed by hash(env label + company +
 *    entity), TTL 24h. `invalidate(entity)` clears both caches AND posts
 *    `ClearEntityMetadata` `{Entity}` (an OData Action, 22.0+, verified
 *    live: 200 "All metadata cleared").
 *
 * Descriptions arrive in Hebrew by default and pass through verbatim —
 * translation happens at the tool boundary, never here.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PriorityClient } from "./client.js";
import { PriorityError, priorityError } from "./errors.js";
import { quoteString } from "./odata.js";
import { isRecord } from "./types.js";

/** Default disk-cache TTL: 24 hours. */
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface PropertySchema {
  name: string;
  /** CSDL type, e.g. "Edm.String", "Edm.Decimal", "Edm.DateTimeOffset". */
  type: string;
  /** `MaxLength` attribute when present (strings). */
  maxLength: number | undefined;
  /** `Priority.OData.Mandatory` annotation. */
  mandatory: boolean;
  /** `Priority.OData.Description` annotation — may be Hebrew, passed through. */
  description: string | undefined;
}

export interface NavigationPropertySchema {
  name: string;
  /** True for subforms (`Collection(...)`), false for singleton subforms. */
  collection: boolean;
  /** Target entity name (namespace stripped), e.g. "AINVOICEITEMS". */
  target: string;
}

export interface EntitySchema {
  /** Requested entity name, UPPERCASE. */
  entity: string;
  /** Key fields from `<Key>` in metadata order (composite for AINVOICES). */
  keyFields: string[];
  properties: PropertySchema[];
  navigationProperties: NavigationPropertySchema[];
  /** Epoch ms when the schema was fetched. */
  fetchedAt: number;
  /** Where this result came from. */
  source: "network" | "disk";
}

export interface MetadataStoreOptions {
  /** Environment label (PRIORITY_ENVIRONMENT; defaults to company). Cache namespace + logs only — never a URL segment. */
  envLabel: string;
  /** Company code — part of the cache namespace. */
  company: string;
  /** Cache TTL (default 24h). */
  cacheTtlMs?: number;
  /** Disk cache directory (default `${os.tmpdir()}/priority-mcp`). */
  diskDir?: string;
  log?: (level: "debug" | "info" | "warn", message: string) => void;
}

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

class XmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlParseError";
  }
}

/**
 * Minimal no-dependency XML reader. Handles the shapes CSDL actually uses:
 * declarations (`<?xml ...?>`), comments, attributes in double/single quotes,
 * self-closing tags, and named closing tags. Text content is skipped (all
 * CSDL data lives in attributes and elements). Entities `&amp; &lt; &gt;
 * &quot; &apos;` are decoded; UTF-8 Hebrew flows through untouched.
 */
export function parseXml(xml: string): XmlElement {
  let pos = 0;
  const len = xml.length;

  function skipWhitespace(): void {
    while (pos < len && /\s/.test(xml[pos] ?? "")) pos++;
  }

  function skipPreamble(): void {
    for (;;) {
      if (xml.startsWith("<?", pos)) {
        const end = xml.indexOf("?>", pos);
        if (end === -1) throw new XmlParseError("unterminated declaration");
        pos = end + 2;
      } else if (xml.startsWith("<!--", pos)) {
        const end = xml.indexOf("-->", pos);
        if (end === -1) throw new XmlParseError("unterminated comment");
        pos = end + 3;
      } else {
        break;
      }
      skipWhitespace();
    }
  }

  function readName(): string {
    const start = pos;
    while (pos < len && /[\w:.-]/.test(xml[pos] ?? "")) pos++;
    if (pos === start) throw new XmlParseError(`expected a tag name at offset ${start}`);
    return xml.slice(start, pos);
  }

  function readAttrValue(): string {
    skipWhitespace();
    const quote = xml[pos];
    if (quote !== '"' && quote !== "'") {
      throw new XmlParseError(`expected a quoted attribute value at offset ${pos}`);
    }
    pos++;
    let value = "";
    for (;;) {
      if (pos >= len) throw new XmlParseError("unterminated attribute value");
      const ch = xml[pos] ?? "";
      if (ch === quote) {
        pos++;
        return value;
      }
      if (ch === "&") {
        const entity = /^&(amp|lt|gt|quot|apos);/.exec(xml.slice(pos, pos + 6));
        if (entity !== null) {
          const decoded: Record<string, string> = {
            amp: "&",
            lt: "<",
            gt: ">",
            quot: '"',
            apos: "'",
          };
          value += decoded[entity[1] ?? "amp"] ?? "";
          pos += entity[0].length;
          continue;
        }
        // Numeric character references: &#34; (decimal), &#x22; (hex) — the
        // live sandbox emits these (e.g. Hebrew "מק&#34;ט" for מק"ט).
        const numeric = /^&#(x[0-9a-fA-F]+|[0-9]+);/.exec(xml.slice(pos, pos + 10));
        if (numeric !== null) {
          const body = numeric[1] ?? "0";
          const codePoint = body.startsWith("x")
            ? Number.parseInt(body.slice(1), 16)
            : Number.parseInt(body, 10);
          value += String.fromCodePoint(codePoint);
          pos += numeric[0].length;
          continue;
        }
        value += ch;
        pos++;
      } else {
        value += ch;
        pos++;
      }
    }
  }

  function readAttrs(): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (;;) {
      skipWhitespace();
      if (pos >= len) throw new XmlParseError("unterminated tag");
      const ch = xml[pos] ?? "";
      if (ch === ">" || ch === "/") return attrs;
      const name = readName();
      skipWhitespace();
      if ((xml[pos] ?? "") !== "=") {
        throw new XmlParseError(`expected '=' after attribute "${name}"`);
      }
      pos++;
      attrs[name] = readAttrValue();
    }
  }

  function parseElement(): XmlElement {
    skipWhitespace();
    skipPreamble();
    if ((xml[pos] ?? "") !== "<") {
      throw new XmlParseError(`expected '<' at offset ${pos}`);
    }
    pos++;
    const name = readName();
    const attrs = readAttrs();
    if ((xml[pos] ?? "") === "/") {
      pos++;
      if ((xml[pos] ?? "") !== ">") throw new XmlParseError("malformed self-closing tag");
      pos++;
      return { name, attrs, children: [] };
    }
    pos++; // consume '>'
    const children: XmlElement[] = [];
    for (;;) {
      skipWhitespace();
      if (pos >= len) throw new XmlParseError(`unterminated element <${name}>`);
      if ((xml[pos] ?? "") === "<") {
        if (xml.startsWith("</", pos)) {
          pos += 2;
          const closeName = readName();
          skipWhitespace();
          if ((xml[pos] ?? "") !== ">") throw new XmlParseError("malformed closing tag");
          pos++;
          if (closeName !== name) {
            throw new XmlParseError(`mismatched closing tag </${closeName}> for <${name}>`);
          }
          return { name, attrs, children };
        }
        children.push(parseElement());
      } else {
        pos++; // text content — not needed for CSDL shapes
      }
    }
  }

  return parseElement();
}

function findElementsByTag(element: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of element.children) {
    if (child.name === name) out.push(child);
    out.push(...findElementsByTag(child, name));
  }
  return out;
}

function findChildren(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

function findChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}

function annotationValue(element: XmlElement, term: string): XmlElement | undefined {
  return element.children.find((child) => child.name === "Annotation" && child.attrs.Term === term);
}

/** `Priority.OData.Description` annotation text (Hebrew passes through). */
function descriptionOf(element: XmlElement): string | undefined {
  const annotation = annotationValue(element, "Priority.OData.Description");
  if (annotation === undefined) return undefined;
  const value = annotation.attrs.String;
  return value === undefined ? undefined : value;
}

/** `Priority.OData.Mandatory` annotation — `Bool="true"` (or String, tolerated). */
function mandatoryOf(element: XmlElement): boolean {
  const annotation = annotationValue(element, "Priority.OData.Mandatory");
  if (annotation === undefined) return false;
  const attr = annotation.attrs.Bool ?? annotation.attrs.String;
  return attr === "true";
}

function stripNamespace(type: string): string {
  const prefix = "Priority.OData.";
  return type.startsWith(prefix) ? type.slice(prefix.length) : type;
}

export interface ParsedEntityType {
  /** The EntityType name the response actually contained. */
  name: string;
  keyFields: string[];
  properties: PropertySchema[];
  navigationProperties: NavigationPropertySchema[];
}

/**
 * Parse a GetMetadataFor CSDL XML response into a typed schema. When the
 * requested EntityType is absent, returns the FIRST EntityType found (the
 * caller uses `name !== requested` for stale detection).
 */
export function parseEntitySchema(xml: string, requested: string): ParsedEntityType {
  const root = parseXml(xml);
  const schemas = findElementsByTag(root, "Schema");
  const schema = schemas[0];
  if (schema === undefined) {
    throw priorityError("unexpected_response", {
      message: "GetMetadataFor response contains no Schema element",
    });
  }
  const entityTypes = findChildren(schema, "EntityType");
  if (entityTypes.length === 0) {
    throw priorityError("unexpected_response", {
      message: "GetMetadataFor response contains no EntityType element",
    });
  }
  const match =
    entityTypes.find((entityType) => entityType.attrs.Name === requested) ?? entityTypes[0];
  if (match === undefined) {
    throw priorityError("unexpected_response", {
      message: "GetMetadataFor response contains no EntityType element",
    });
  }

  const keyElement = findChild(match, "Key");
  const keyFields = (keyElement === undefined ? [] : keyElement.children)
    .filter((child) => child.name === "PropertyRef")
    .map((child) => child.attrs.Name ?? "")
    .filter((name) => name !== "");

  const properties = findChildren(match, "Property").map((property) => {
    const name = property.attrs.Name ?? "";
    const rawMaxLength = property.attrs.MaxLength;
    const maxLength = rawMaxLength === undefined ? undefined : Number(rawMaxLength);
    return {
      name,
      type: property.attrs.Type ?? "",
      maxLength: Number.isFinite(maxLength) ? maxLength : undefined,
      mandatory: mandatoryOf(property),
      description: descriptionOf(property),
    };
  });

  const navigationProperties = findChildren(match, "NavigationProperty").map((navProperty) => {
    const type = navProperty.attrs.Type ?? "";
    const collection = type.startsWith("Collection(");
    const target = collection ? type.slice("Collection(".length, -1) : type;
    return {
      name: navProperty.attrs.Name ?? "",
      collection,
      target: stripNamespace(target),
    };
  });

  return {
    name: match.attrs.Name ?? "",
    keyFields,
    properties,
    navigationProperties,
  };
}

interface DiskCacheEntry {
  schema: EntitySchema;
  cachedAt: number;
}

export class MetadataStore {
  private readonly client: PriorityClient;
  private readonly envLabel: string;
  private readonly company: string;
  private readonly diskDir: string;
  private readonly cacheTtlMs: number;
  private readonly log: (level: "debug" | "info" | "warn", message: string) => void;
  private readonly memory = new Map<string, EntitySchema>();

  constructor(client: PriorityClient, options: MetadataStoreOptions) {
    this.client = client;
    this.envLabel = options.envLabel;
    this.company = options.company;
    this.diskDir = options.diskDir ?? path.join(tmpdir(), "priority-mcp");
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.log = options.log ?? (() => {});
  }

  /** Hash namespace: env label + company + entity. */
  cacheKey(entity: string): string {
    return createHash("sha1")
      .update(`${this.envLabel}|${this.company}|${entity}`)
      .digest("hex")
      .slice(0, 20);
  }

  private diskPath(entity: string): string {
    return path.join(this.diskDir, `${this.cacheKey(entity)}.json`);
  }

  /**
   * Resolve the schema for an entity: memory → disk (24h TTL) → network
   * (warm-up → GetMetadataFor → stale retry). Never throws on cache I/O —
   * the cache is an optimization, correctness comes from the network path.
   */
  async getEntitySchema(entity: string): Promise<EntitySchema> {
    const normalized = entity.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(normalized)) {
      throw priorityError("validation_error", {
        message: `entity names must be UPPERCASE ([A-Z][A-Z0-9_]*) — got "${entity}"`,
      });
    }

    const cached = this.memory.get(normalized);
    if (cached !== undefined && this.isFresh(cached.fetchedAt)) {
      return cached;
    }

    const disk = await this.readDisk(normalized);
    if (disk !== null) {
      this.memory.set(normalized, disk);
      return disk;
    }

    // Network path: warm-up (double-probe 404s, per verified reference) then
    // GetMetadataFor; stale EntityType → one more warm-up + refetch.
    await this.warmUp(normalized);
    const xml = await this.fetchMetadataXml(normalized);
    let parsed = parseEntitySchema(xml, normalized);
    if (parsed.name !== normalized) {
      this.log(
        "info",
        `stale metadata for ${normalized} (got ${parsed.name}) — warming up and retrying once`,
      );
      await this.warmUp(normalized);
      const retryXml = await this.fetchMetadataXml(normalized);
      parsed = parseEntitySchema(retryXml, normalized);
      if (parsed.name !== normalized) {
        throw priorityError("unexpected_response", {
          message: `GetMetadataFor(${normalized}) returned metadata for ${parsed.name} even after a warm-up retry`,
          op: `GetMetadataFor(${normalized})`,
        });
      }
    }

    const schema: EntitySchema = {
      entity: normalized,
      keyFields: parsed.keyFields,
      properties: parsed.properties,
      navigationProperties: parsed.navigationProperties,
      fetchedAt: Date.now(),
      source: "network",
    };
    this.memory.set(normalized, schema);
    await this.writeDisk(schema);
    return schema;
  }

  /**
   * Invalidate server-side metadata AND both caches for an entity. POSTs
   * `ClearEntityMetadata` `{Entity}` (OData Action, 22.0+; verified live:
   * HTTP 200 "All metadata cleared").
   */
  async invalidate(entity: string): Promise<void> {
    const normalized = entity.trim().toUpperCase();
    this.log("info", `invalidating metadata cache for ${normalized}`);
    await this.client.post(
      "ClearEntityMetadata",
      { Entity: normalized },
      {
        op: `ClearEntityMetadata(${normalized})`,
      },
    );
    this.memory.delete(normalized);
    await unlink(this.diskPath(normalized)).catch(() => {});
  }

  private isFresh(fetchedAt: number): boolean {
    return Date.now() - fetchedAt < this.cacheTtlMs;
  }

  private async readDisk(entity: string): Promise<EntitySchema | null> {
    try {
      const raw = await readFile(this.diskPath(entity), "utf8");
      const entry = JSON.parse(raw) as DiskCacheEntry;
      if (!isRecord(entry) || !isRecord(entry.schema)) return null;
      if (entry.schema.entity !== entity || !this.isFresh(entry.cachedAt)) {
        return null;
      }
      return { ...entry.schema, source: "disk" };
    } catch {
      return null;
    }
  }

  private async writeDisk(schema: EntitySchema): Promise<void> {
    try {
      await mkdir(this.diskDir, { recursive: true });
      const entry: DiskCacheEntry = { schema, cachedAt: Date.now() };
      await writeFile(this.diskPath(schema.entity), JSON.stringify(entry));
    } catch (error) {
      // Disk cache is an optimization — a full disk must never break reads.
      this.log("warn", `metadata disk cache write failed: ${String(error)}`);
    }
  }

  /**
   * Warm-up probe: `GET {entity}?$top=1` compiles the server-side form so
   * GetMetadataFor returns the RIGHT entity. A single 404 on first probe is
   * tolerated (verified cold-start behavior); a second 404 declares the
   * entity dead. noCache: the probe must reach the SERVER every time — a
   * cached warm-up would defeat the stale-metadata retry protocol.
   */
  private async warmUp(entity: string): Promise<void> {
    try {
      await this.client.get(`${entity}?$top=1`, { op: `warm-up ${entity}`, noCache: true });
    } catch (error) {
      if (error instanceof PriorityError && error.kind === "not_found") {
        await this.client.get(`${entity}?$top=1`, {
          op: `warm-up ${entity} (double-probe)`,
          noCache: true,
        });
        return;
      }
      throw error;
    }
  }

  /** Fetch the GetMetadataFor XML. Response may be raw XML or JSON-wrapped. */
  private async fetchMetadataXml(entity: string): Promise<string> {
    const response = await this.client.get(`GetMetadataFor(entity=${quoteString(entity)})`, {
      op: `GetMetadataFor(entity='${entity}')`,
    });
    if (typeof response === "string") return response;
    if (isRecord(response)) {
      for (const key of ["value", "result", "GetMetadataForResult"]) {
        const candidate = response[key];
        if (typeof candidate === "string") return candidate;
      }
    }
    throw priorityError("unexpected_response", {
      message: `GetMetadataFor(${entity}) returned a non-XML response`,
      op: `GetMetadataFor(entity='${entity}')`,
    });
  }
}
