import { describe, expect, it } from "vitest";
import type { PriorityClientConfig } from "../../src/priority/client.js";
import { MAX_READ_RETRIES, PriorityClient } from "../../src/priority/client.js";

const ROOT = "https://x.example/odata/Priority/tabula.ini,3/demo";

type FetchInput = Parameters<typeof fetch>[0];

interface Call {
  url: string;
  init?: RequestInit;
}

function makeClient(
  handler: (call: Call) => Promise<Response>,
  calls: Call[],
  overrides: Partial<PriorityClientConfig> = {},
): PriorityClient {
  const fetchImpl = (async (input: FetchInput, init?: RequestInit) => {
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
    rateLimitPerMinute: 10_000,
    cacheSize: 32,
    ...overrides,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function oDataError(status: number, message: string): Response {
  return jsonResponse({ error: { code: String(status), message } }, status);
}

/** fetch that hangs until the client aborts it (timeout simulation). */
function hangingFetch(calls: Call[]): typeof fetch {
  return (async (input: FetchInput, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    await new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  }) as unknown as typeof fetch;
}

describe("write discipline — single attempt, never retried", () => {
  it("surfaces a write timeout as timeout_uncertain with exactly one attempt", async () => {
    const calls: Call[] = [];
    const client = new PriorityClient({
      serviceRoot: ROOT,
      username: "u",
      password: "p",
      fetchImpl: hangingFetch(calls),
      timeoutMs: 25,
      rateLimitPerMinute: 10_000,
    });

    await expect(client.post("ORDERS", { CUSTNAME: "x" })).rejects.toMatchObject({
      kind: "timeout_uncertain",
      retryable: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("surfaces a write 503 as server_error with exactly one attempt (no retry)", async () => {
    const calls: Call[] = [];
    const client = makeClient(() => Promise.resolve(oDataError(503, "busy")), calls);

    await expect(client.patch("ORDERS('#1')", { CDES: "x" })).rejects.toMatchObject({
      kind: "server_error",
    });
    expect(calls).toHaveLength(1);
  });

  it("does not retry DELETE on 429 either", async () => {
    const calls: Call[] = [];
    const client = makeClient(() => Promise.resolve(oDataError(429, "slow down")), calls);
    await expect(client.deleteRecord("ORDERS('#1')")).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(calls).toHaveLength(1);
  });
});

describe("read retries — ≤2 with exponential backoff on network/5xx/429", () => {
  it("retries a 503 and succeeds on the third attempt", async () => {
    const statuses = [503, 503, 200];
    let index = 0;
    const calls: Call[] = [];
    const client = makeClient(() => {
      const status = statuses[index] ?? 500;
      index += 1;
      return Promise.resolve(
        status === 200
          ? jsonResponse({ value: [{ IVNUM: "T123457666" }] })
          : oDataError(status, "busy"),
      );
    }, calls);

    const data = await client.get<{ value: unknown[] }>("AINVOICES?$top=1");
    expect(data.value).toHaveLength(1);
    expect(index).toBe(3);
  });

  it("gives up after 1 + MAX_READ_RETRIES attempts on persistent 503s", async () => {
    const calls: Call[] = [];
    const client = makeClient(() => Promise.resolve(oDataError(503, "busy")), calls);
    await expect(client.get("AINVOICES?$top=1")).rejects.toMatchObject({
      kind: "server_error",
    });
    expect(calls).toHaveLength(1 + MAX_READ_RETRIES);
  });

  it("surfaces 429 as rate_limited after the read retry budget", async () => {
    const calls: Call[] = [];
    const client = makeClient(() => Promise.resolve(oDataError(429, "slow down")), calls);
    await expect(client.get("AINVOICES?$top=1")).rejects.toMatchObject({
      kind: "rate_limited",
      retryable: true,
    });
    expect(calls).toHaveLength(1 + MAX_READ_RETRIES);
  });

  it("retries a GET timeout (idempotent) and throws network_error when it keeps timing out", async () => {
    const calls: Call[] = [];
    const client = new PriorityClient({
      serviceRoot: ROOT,
      username: "u",
      password: "p",
      fetchImpl: hangingFetch(calls),
      timeoutMs: 25,
      rateLimitPerMinute: 10_000,
    });
    await expect(client.get("AINVOICES?$top=1")).rejects.toMatchObject({
      kind: "network_error",
      retryable: true,
    });
    expect(calls).toHaveLength(1 + MAX_READ_RETRIES);
  });

  it("maps a 404 to not_found without retrying", async () => {
    const calls: Call[] = [];
    const client = makeClient(() => Promise.resolve(oDataError(404, "no such entity")), calls);
    await expect(client.get("BOGUS?$top=1")).rejects.toMatchObject({ kind: "not_found" });
    expect(calls).toHaveLength(1);
  });
});

describe("GET cache — LRU with entity-prefix invalidation", () => {
  it("serves repeated GETs from cache without hitting fetch", async () => {
    const calls: Call[] = [];
    let responses = 0;
    const client = makeClient(() => {
      responses += 1;
      return Promise.resolve(jsonResponse({ value: [{ a: 1 }] }));
    }, calls);
    const first = await client.get<{ value: unknown[] }>("AINVOICES?$top=1");
    const second = await client.get<{ value: unknown[] }>("AINVOICES?$top=1");
    expect(first).toBe(second); // same cached object
    expect(responses).toBe(1);
  });

  it("invalidates the entity's cached entries after any write to it", async () => {
    const calls: Call[] = [];
    let responses = 0;
    const client = makeClient((call) => {
      if (call.init?.method === "POST") {
        return Promise.resolve(jsonResponse({ IVNUM: "T123457666" }, 201));
      }
      responses += 1;
      return Promise.resolve(jsonResponse({ value: [{ n: responses }] }));
    }, calls);

    await client.get("AINVOICES?$top=1");
    await client.post("AINVOICES", { CUSTNAME: "x" });
    await client.get("AINVOICES?$top=1");
    expect(responses).toBe(2); // pre-write GET + post-write refetch
    expect(calls.filter((call) => call.url.endsWith("AINVOICES?$top=1"))).toHaveLength(2);
  });

  it("keeps cached entries for OTHER entities after a write", async () => {
    const calls: Call[] = [];
    let responses = 0;
    const client = makeClient((call) => {
      if (call.init?.method === "POST") return Promise.resolve(jsonResponse({}, 201));
      responses += 1;
      return Promise.resolve(jsonResponse({ value: [{ n: responses }] }));
    }, calls);

    await client.get("AINVOICES?$top=1");
    await client.post("ORDERS", { CUSTNAME: "x" });
    await client.get("AINVOICES?$top=1");
    expect(responses).toBe(1); // AINVOICES cache survived the ORDERS write
  });
});

describe("auth, headers and guards", () => {
  it("sends Basic auth built from username:password", async () => {
    const calls: Call[] = [];
    const client = makeClient(() => Promise.resolve(jsonResponse({})), calls, {
      appId: "app-1",
      appKey: "key-1",
    });
    await client.get("AINVOICES?$top=1");
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe(`Basic ${Buffer.from("apidemo:123").toString("base64")}`);
    expect(headers?.["X-App-Id"]).toBe("app-1");
    expect(headers?.["X-App-Key"]).toBe("key-1");
  });

  it("supports PAT auth (username = token, password = literal PAT)", async () => {
    const calls: Call[] = [];
    const client = makeClient(() => Promise.resolve(jsonResponse({})), calls, {
      username: "token-value",
      password: "PAT",
    });
    await client.get("GetPriorityVersion");
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe(
      `Basic ${Buffer.from("token-value:PAT").toString("base64")}`,
    );
  });

  it("rejects responses over the size guard before reading them", async () => {
    const calls: Call[] = [];
    let textRead = false;
    const fetchImpl = (async (input: FetchInput, _init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, init: undefined });
      const response = new Response("", {
        status: 200,
        headers: { "content-length": String(350 * 1024 * 1024 + 1) },
      });
      Object.defineProperty(response, "text", {
        value: () => {
          textRead = true;
          return Promise.resolve("");
        },
      });
      return response;
    }) as typeof fetch;
    const client = new PriorityClient({
      serviceRoot: ROOT,
      username: "u",
      password: "p",
      fetchImpl,
      rateLimitPerMinute: 10_000,
    });

    await expect(client.get("AINVOICES?$top=1")).rejects.toMatchObject({
      kind: "unexpected_response",
    });
    expect(textRead).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("tolerates HTTP 200 carrying an OData error envelope as unexpected_response", async () => {
    const calls: Call[] = [];
    const client = makeClient(
      () => Promise.resolve(jsonResponse({ error: { code: "ABC", message: "oops" } }, 200)),
      calls,
    );
    await expect(client.get("AINVOICES?$top=1")).rejects.toMatchObject({
      kind: "unexpected_response",
    });
    expect(calls).toHaveLength(1); // 200-with-error is not retried
  });

  it("resolves DELETE 204 to undefined without JSON parsing", async () => {
    const calls: Call[] = [];
    const client = makeClient(() => Promise.resolve(new Response(null, { status: 204 })), calls);
    await expect(client.deleteRecord("ORDERS('#1')")).resolves.toBeUndefined();
  });

  it("passes through non-JSON 2xx bodies (XML metadata, plain text)", async () => {
    const calls: Call[] = [];
    const client = makeClient(
      () => Promise.resolve(new Response('<?xml version="1.0"?><EntityType/>', { status: 200 })),
      calls,
    );
    const body = await client.get<string>("GetMetadataFor(entity='AINVOICES')");
    expect(body.startsWith("<?xml")).toBe(true);
  });
});
