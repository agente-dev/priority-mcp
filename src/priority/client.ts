/**
 * PriorityClient — the single sanctioned way to talk to the Priority OData API.
 *
 * Verified wire facts (docs/priority-api-verified.md + live probes):
 * - Basic auth: `Authorization: Basic base64(username:password)`; PAT mode
 *   works free (username = token, password = literal `PAT`). Optional
 *   per-app license headers X-App-Id / X-App-Key.
 * - Reads (GET) retry ≤2 with exponential backoff on network errors, 5xx and
 *   429 only — GETs are idempotent, retrying them is safe.
 * - Writes (POST/PATCH/DELETE) are NEVER retried: Priority has no idempotency
 *   mechanism and every written record bills an API transaction — a blind
 *   retry can double-post and double-bill. A write timeout surfaces as
 *   `timeout_uncertain` (outcome unknown, caller decides).
 * - Rate limit: 100 calls/min/user (429 on breach) — the client token-buckets
 *   at the configured per-minute rate (default 60).
 * - GET results are cached in an LRU keyed by the relative path; ANY write to
 *   an entity invalidates that entity's cached entries (server-side state
 *   changed). Warm-up/schema reads share the same cache.
 * - Responses over the size guard (default 350MB, the vendor cap) are
 *   rejected early via Content-Length, with a late byte-length check.
 * - Error bodies are OData v4 envelopes `{"error":{"code","message"}}` when
 *   present; 401/404 may arrive with an empty body. Messages may be Hebrew —
 *   passed through verbatim with a `lang:"he"` marker. Secrets are redacted
 *   from every escaped error.
 *
 * `fetchImpl` is injectable — unit tests never touch the network.
 */

import {
  fromHttpError,
  networkError,
  PriorityError,
  timeoutUncertain,
  unexpectedResponse,
} from "./errors.js";
import type { ODataErrorEnvelope } from "./types.js";
import { isRecord } from "./types.js";

/** Per-request timeout, well under the server's 3-minute kill. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Default token-bucket rate, under the vendor's 100/min fair use. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

/** Read retries: ≤2 retries → up to 3 attempts. */
export const MAX_READ_RETRIES = 2;

/** Base exponential backoff for read retries (100ms, 200ms). */
const RETRY_BASE_DELAY_MS = 100;

/** Vendor response cap (verified reference) — reject larger reads early. */
const VENDOR_MAX_RESPONSE_BYTES = 350 * 1024 * 1024;

/** Default LRU GET cache capacity (entries). */
const DEFAULT_CACHE_SIZE = 128;

export interface PriorityClientConfig {
  /**
   * OData service root: `{API_URL}/{INI},{LANG}/{COMPANY}` — derived by
   * `loadConfig` (train-1 config contract). E.g.
   * `https://t.eu.priority-connect.online/odata/Priority/tabbtd38.ini,3/usdemo`.
   */
  serviceRoot: string;
  /** API username (or PAT token in PAT mode). */
  username: string;
  /** API password, or the literal `PAT` in PAT mode. Never logged. */
  password: string;
  /** Optional per-app license header value `X-App-Id`. */
  appId?: string;
  /** Optional per-app license header value `X-App-Key`. Never logged. */
  appKey?: string;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 60000). */
  timeoutMs?: number;
  /** Token-bucket rate (default 60/min, under the vendor's 100/min). */
  rateLimitPerMinute?: number;
  /** LRU GET cache capacity in entries (default 128). */
  cacheSize?: number;
  /** Response size guard in bytes (default 350MB — the vendor cap). */
  maxResponseBytes?: number;
  /** Optional logger (default silent); messages are never secrets. */
  log?: (level: "debug" | "info" | "warn", message: string) => void;
}

export interface RequestOptions {
  /** Operation label for error messages, e.g. "GET AINVOICES?$top=1". */
  op?: string;
  /** HTTP method; defaults to GET (reads). POST/PATCH/DELETE are writes. */
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** JSON body for writes. */
  body?: unknown;
  /**
   * Bypass the GET cache on both sides (no lookup, no store). Used by
   * metadata warm-ups, whose purpose is to hit the SERVER (compiling the
   * form) — a cached warm-up defeats the stale-metadata retry protocol.
   */
  noCache?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}

/** Token-bucket rate limiter (single consumer; waits for the next token). */
class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private lastRefill: number;

  constructor(ratePerMinute: number) {
    if (!Number.isInteger(ratePerMinute) || ratePerMinute <= 0) {
      throw new TypeError("rateLimitPerMinute must be a positive integer");
    }
    this.capacity = ratePerMinute;
    this.tokens = ratePerMinute;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedMs = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsedMs / 60_000) * this.capacity);
    this.lastRefill = now;
  }

  /** Consume one token, waiting until one is available. */
  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil(((1 - this.tokens) / this.capacity) * 60_000);
    await sleep(waitMs);
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

/** Minimal LRU: Map insertion order + move-to-end on get. */
class LruCache<T> {
  private readonly map = new Map<string, T>();
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError("cacheSize must be a positive integer");
    }
    this.capacity = capacity;
  }

  get(key: string): T | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  /** Drop every entry whose key matches `predicate`. */
  deleteWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.map.keys()]) {
      if (predicate(key)) this.map.delete(key);
    }
  }
}

/** Tolerant JSON parse: non-JSON bodies (XML metadata, plain text) pass through. */
function parseTolerant(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function isErrorEnvelope(value: unknown): value is ODataErrorEnvelope {
  return isRecord(value) && isRecord(value.error);
}

/** First path segment of a request path — the entity name when present. */
function entityFromPath(path: string): string | undefined {
  const clean = path.replace(/^\/+/, "");
  const end = clean.search(/[?(/]/);
  const head = end === -1 ? clean : clean.slice(0, end);
  return head.length > 0 ? head : undefined;
}

export class PriorityClient {
  private readonly serviceRoot: string;
  private readonly username: string;
  private readonly password: string;
  private readonly appId: string | undefined;
  private readonly appKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly bucket: TokenBucket;
  private readonly cache: LruCache<unknown>;
  private readonly log: (level: "debug" | "info" | "warn", message: string) => void;
  private readonly authHeader: string;

  constructor(config: PriorityClientConfig) {
    const root = config.serviceRoot.trim().replace(/\/+$/, "");
    if (root === "") throw new TypeError("PriorityClient: serviceRoot is required");
    if (config.username.trim() === "") throw new TypeError("PriorityClient: username is required");
    if (config.password.trim() === "") throw new TypeError("PriorityClient: password is required");
    this.serviceRoot = root;
    this.username = config.username;
    this.password = config.password;
    this.appId = config.appId;
    this.appKey = config.appKey;
    this.fetchImpl = config.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = config.maxResponseBytes ?? VENDOR_MAX_RESPONSE_BYTES;
    this.bucket = new TokenBucket(config.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE);
    this.cache = new LruCache<unknown>(config.cacheSize ?? DEFAULT_CACHE_SIZE);
    this.log = config.log ?? (() => {});
    // Basic auth; PAT mode = username:token, password:"PAT" (verified).
    this.authHeader = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
  }

  /** Absolute URL for a relative request path. */
  absolute(path: string): string {
    return `${this.serviceRoot}/${path.replace(/^\/+/, "")}`;
  }

  /**
   * Core request. Public methods build on this:
   * - GET: rate-limited, cached, retried ≤2 on network/5xx/429.
   * - POST/PATCH/DELETE: rate-limited, single attempt, cache invalidated for
   *   the touched entity on any response (2xx or error) — a write may have
   *   changed server state even when the response was ambiguous.
   */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? "GET";
    const isWrite = method !== "GET";
    const op = options.op ?? `${method} ${path}`;

    await this.bucket.acquire();

    if (!isWrite && !options.noCache) {
      const cached = this.cache.get(path);
      if (cached !== undefined) {
        this.log("debug", `cache hit: ${path}`);
        return cached as T;
      }
    }

    const maxAttempts = isWrite ? 1 : 1 + MAX_READ_RETRIES;
    let lastError: PriorityError | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.attemptOnce<T>(path, method, options, op);
        if (isWrite) {
          this.cache.deleteWhere((key) => this.keyTouchesEntity(key, entityFromPath(path)));
        }
        return result;
      } catch (error) {
        if (!(error instanceof PriorityError)) throw error;
        // Every escape path is redacted — secrets never reach callers.
        error.redact(this.password).redact(this.appKey ?? "");
        lastError = error;
        const retryable =
          !isWrite &&
          attempt < MAX_READ_RETRIES &&
          (error.kind === "network_error" ||
            error.kind === "rate_limited" ||
            error.kind === "server_error");
        if (retryable) {
          const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
          this.log(
            "debug",
            `retrying ${op} (attempt ${attempt + 1}) in ${delay}ms after ${error.kind}`,
          );
          await sleep(delay);
          continue;
        }
        if (isWrite) {
          this.cache.deleteWhere((key) => this.keyTouchesEntity(key, entityFromPath(path)));
        }
        throw error;
      }
    }
    // Unreachable: maxAttempts >= 1 and every iteration either returns or throws.
    throw lastError ?? networkError(`request ${op} failed without a typed error`);
  }

  /** Does a cached key concern `entity` (prefix match on the path)? */
  private keyTouchesEntity(key: string, entity: string | undefined): boolean {
    if (entity === undefined) return false;
    return key === entity || key.startsWith(`${entity}(`) || key.startsWith(`${entity}?`);
  }

  /** Single HTTP attempt — never retries, always normalizes failures. */
  private async attemptOnce<T>(
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    options: RequestOptions,
    op: string,
  ): Promise<T> {
    const url = this.absolute(path);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: this.headersFor(body),
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted && isAbortError(error)) {
        // Outcome unknown: reads map to a retryable network error (idempotent),
        // writes surface as timeout_uncertain — never silently retried.
        if (method === "GET") {
          throw networkError(`${op} timed out after ${this.timeoutMs}ms`, op);
        }
        throw timeoutUncertain(op, this.timeoutMs);
      }
      throw networkError(`network error calling ${op}`, op);
    } finally {
      clearTimeout(timer);
    }

    // Size guard: reject oversized reads early via Content-Length when present.
    const contentLengthRaw = response.headers.get("content-length");
    if (contentLengthRaw !== null) {
      const contentLength = Number(contentLengthRaw);
      if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
        const mb = Math.round(this.maxResponseBytes / (1024 * 1024));
        throw unexpectedResponse(
          `response to ${op} exceeds the ${mb}MB size guard (content-length ${contentLength})`,
          { op },
        );
      }
    }

    const rawText = await response.text();
    // Late guard for responses without a Content-Length header.
    if (Buffer.byteLength(rawText, "utf8") > this.maxResponseBytes) {
      const mb = Math.round(this.maxResponseBytes / (1024 * 1024));
      throw unexpectedResponse(`response to ${op} exceeds the ${mb}MB size guard`, { op });
    }

    if (response.status >= 200 && response.status < 300) {
      if (response.status === 204 || rawText.trim() === "") return undefined as T;
      const parsed = parseTolerant(rawText);
      if (isErrorEnvelope(parsed)) {
        // HTTP 200 carrying an error envelope — tolerated as unexpected.
        throw fromHttpError(response.status, rawText, { op });
      }
      if (method === "GET" && !options.noCache && typeof parsed === "object" && parsed !== null) {
        this.cache.set(path, parsed);
      }
      return parsed as T;
    }

    throw fromHttpError(response.status, rawText, { op });
  }

  private headersFor(body: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
    if (this.appId !== undefined) headers["X-App-Id"] = this.appId;
    if (this.appKey !== undefined) headers["X-App-Key"] = this.appKey;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return headers;
  }

  // --- Thin typed methods -------------------------------------------------

  /** GET a relative path (`builder.build(entity)` output or a function call). */
  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "GET" });
  }

  /** POST JSON to a relative path (writes: single attempt, never retried). */
  post<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "POST", body });
  }

  /** PATCH JSON to a relative path (writes: single attempt, never retried). */
  patch<T>(path: string, body: unknown, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(path, { ...options, method: "PATCH", body });
  }

  /** DELETE a record (writes: single attempt, never retried). */
  deleteRecord(path: string, options: RequestOptions = {}): Promise<unknown> {
    return this.request<unknown>(path, { ...options, method: "DELETE" });
  }
}
