import { describe, expect, it } from "vitest";
import {
  fromHttpError,
  isHebrewText,
  isPriorityError,
  isRetryableKind,
  kindForHttpStatus,
  networkError,
  PRIORITY_ERROR_KINDS,
  PriorityError,
  priorityError,
  timeoutUncertain,
  unexpectedResponse,
} from "../../src/priority/errors.js";

const HEBREW_MESSAGE = "אין הרשאות מספיקות כדי לבצע את הפעולה";

describe("OData v4 envelope parsing", () => {
  it("maps a 400 envelope to validation_error with code and message", () => {
    const error = fromHttpError(
      400,
      JSON.stringify({ error: { code: "400", message: "Bad filter" } }),
      {
        op: "GET CUSTOMERS",
      },
    );
    expect(error.kind).toBe("validation_error");
    expect(error.message).toContain("Bad filter");
    expect(error.code).toBe("400");
    expect(error.httpStatus).toBe(400);
    expect(error.op).toBe("GET CUSTOMERS");
    expect(error.retryable).toBe(false);
  });

  it("passes Hebrew messages through verbatim with lang:he", () => {
    const error = fromHttpError(
      400,
      JSON.stringify({ error: { code: "400", message: HEBREW_MESSAGE } }),
    );
    expect(error.message).toContain(HEBREW_MESSAGE);
    expect(error.lang).toBe("he");
    expect(isHebrewText(error.message)).toBe(true);
  });

  it("tolerates HTTP 200 with an error body as unexpected_response", () => {
    const error = fromHttpError(200, JSON.stringify({ error: { code: "0", message: "oops" } }));
    expect(error.kind).toBe("unexpected_response");
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(200);
  });

  it("maps empty-body 401/404 by status alone (verified live)", () => {
    const auth = fromHttpError(401, "");
    expect(auth.kind).toBe("authentication_failed");
    expect(auth.message).toContain("HTTP 401");
    expect(auth.retryable).toBe(false);

    const missing = fromHttpError(404, "");
    expect(missing.kind).toBe("not_found");
    expect(missing.message).toContain("HTTP 404");
  });

  it("maps non-envelope body text into the message (truncated)", () => {
    const error = fromHttpError(502, "<html>bad gateway</html>", { op: "warm-up ZZZNOPE" });
    expect(error.kind).toBe("server_error");
    expect(error.message).toContain("bad gateway");
    expect(error.message).toContain("warm-up ZZZNOPE");
  });
});

describe("kind/status mapping", () => {
  it("maps status codes to kinds", () => {
    expect(kindForHttpStatus(401)).toBe("authentication_failed");
    expect(kindForHttpStatus(403)).toBe("authentication_failed");
    expect(kindForHttpStatus(400)).toBe("validation_error");
    expect(kindForHttpStatus(404)).toBe("not_found");
    expect(kindForHttpStatus(429)).toBe("rate_limited");
    expect(kindForHttpStatus(500)).toBe("server_error");
    expect(kindForHttpStatus(503)).toBe("server_error");
    expect(kindForHttpStatus(200)).toBe("unexpected_response");
    expect(kindForHttpStatus(302)).toBe("unexpected_response");
  });

  it("marks only network_error + rate_limited retryable", () => {
    const expectations: Record<string, boolean> = {
      authentication_failed: false,
      validation_error: false,
      not_found: false,
      rate_limited: true,
      server_error: false,
      network_error: true,
      timeout_uncertain: false,
      unexpected_response: false,
    };
    for (const kind of PRIORITY_ERROR_KINDS) {
      expect(isRetryableKind(kind)).toBe(expectations[kind]);
    }
  });

  it("constructs typed errors with derived retryable flags", () => {
    expect(networkError("boom").retryable).toBe(true);
    expect(timeoutUncertain("POST ORDERS", 1000).kind).toBe("timeout_uncertain");
    expect(timeoutUncertain("POST ORDERS", 1000).retryable).toBe(false);
    expect(unexpectedResponse("weird").retryable).toBe(false);
    const auth = priorityError("authentication_failed", { message: "no" });
    expect(auth.retryable).toBe(false);
  });
});

describe("redaction", () => {
  it("scrubs the secret from thrown messages", () => {
    const error = new PriorityError({
      kind: "network_error",
      retryable: true,
      message: "failed auth with long-secret-token-abc123",
    });
    error.redact("long-secret-token-abc123");
    expect(error.message).toBe("failed auth with [REDACTED]");
    expect(error.message).not.toContain("abc123");
  });

  it("skips secrets shorter than 4 chars (e.g. the literal PAT)", () => {
    const error = networkError("PAT token flow failed");
    error.redact("PAT");
    expect(error.message).toBe("PAT token flow failed");
  });

  it("redacts on the client escape path via the same primitive", () => {
    const error = fromHttpError(400, JSON.stringify({ error: { message: "pwd: hunter2hunter2" } }));
    error.redact("hunter2hunter2");
    expect(error.message).not.toContain("hunter2");
  });
});

describe("identity", () => {
  it("narrows via isPriorityError and rejects plain Errors", () => {
    expect(isPriorityError(networkError("x"))).toBe(true);
    expect(isPriorityError(new Error("x"))).toBe(false);
    expect(isPriorityError(null)).toBe(false);
  });

  it("detects Hebrew text", () => {
    expect(isHebrewText("שלום עולם")).toBe(true);
    expect(isHebrewText("hello world")).toBe(false);
    expect(isHebrewText("mixed שלום")).toBe(true);
  });

  it("carries the op label and http status for callers", () => {
    const error = fromHttpError(429, "", { op: "GET ORDERS?$top=1" });
    expect(error.kind).toBe("rate_limited");
    expect(error.httpStatus).toBe(429);
    expect(error.op).toBe("GET ORDERS?$top=1");
    expect(error.message).toContain("GET ORDERS?$top=1");
  });
});
