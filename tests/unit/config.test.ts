import { describe, expect, it } from "vitest";
import type { Config, ConfigError, ConfigResult } from "../../src/config.js";
import { loadConfig } from "../../src/config.js";

const VALID_ENV = {
  PRIORITY_API_URL: "https://example.com/odata/Priority",
  PRIORITY_COMPANY: "demodata",
  PRIORITY_USERNAME: "apidemo",
  PRIORITY_PASSWORD: "secret",
} as const;

function expectConfig(result: ConfigResult): Config {
  if (!result.ok) {
    throw new Error(`expected valid config, got: ${JSON.stringify(result.errors)}`);
  }
  return result.config;
}

function expectErrors(result: ConfigResult): ConfigError[] {
  if (result.ok) {
    throw new Error("expected invalid config, got a valid one");
  }
  return result.errors;
}

describe("loadConfig", () => {
  it("accepts a valid environment with defaults", () => {
    const config = expectConfig(loadConfig({ ...VALID_ENV }));
    expect(config.apiUrl).toBe("https://example.com/odata/Priority");
    expect(config.company).toBe("demodata");
    expect(config.username).toBe("apidemo");
    expect(config.password).toBe("secret");
  });

  it("defaults PRIORITY_TABULA_INI to tabula.ini", () => {
    const config = expectConfig(loadConfig({ ...VALID_ENV }));
    expect(config.tabulaIni).toBe("tabula.ini");
  });

  it("respects an explicit PRIORITY_TABULA_INI", () => {
    const config = expectConfig(loadConfig({ ...VALID_ENV, PRIORITY_TABULA_INI: "tabbtd38.ini" }));
    expect(config.tabulaIni).toBe("tabbtd38.ini");
  });

  it("defaults PRIORITY_LANGUAGE to 3 (US English)", () => {
    const config = expectConfig(loadConfig({ ...VALID_ENV }));
    expect(config.language).toBe("3");
  });

  it("respects an explicit PRIORITY_LANGUAGE", () => {
    const config = expectConfig(loadConfig({ ...VALID_ENV, PRIORITY_LANGUAGE: "1" }));
    expect(config.language).toBe("1");
  });

  it("derives serviceRoot as {apiUrl}/{ini},{lang}/{company}", () => {
    const config = expectConfig(
      loadConfig({
        ...VALID_ENV,
        PRIORITY_TABULA_INI: "tabbtd38.ini",
        PRIORITY_LANGUAGE: "3",
      }),
    );
    expect(config.serviceRoot).toBe("https://example.com/odata/Priority/tabbtd38.ini,3/demodata");
  });

  it("decomposes the verified sandbox (deviation example)", () => {
    // API_URL=https://t.eu.priority-connect.online/odata/Priority,
    // TABULA_INI=tabbtd38.ini, COMPANY=usdemo, LANG=3 (docs/priority-api-verified.md)
    const config = expectConfig(
      loadConfig({
        PRIORITY_API_URL: "https://t.eu.priority-connect.online/odata/Priority",
        PRIORITY_TABULA_INI: "tabbtd38.ini",
        PRIORITY_COMPANY: "usdemo",
        PRIORITY_LANGUAGE: "3",
        PRIORITY_USERNAME: "apidemo",
        PRIORITY_PASSWORD: "123",
      }),
    );
    expect(config.serviceRoot).toBe(
      "https://t.eu.priority-connect.online/odata/Priority/tabbtd38.ini,3/usdemo",
    );
  });

  it("accepts path-prefixed installs (ui/odata/Priority) and trims trailing slashes", () => {
    const config = expectConfig(
      loadConfig({
        ...VALID_ENV,
        PRIORITY_API_URL: "https://host.example/ui/odata/Priority/",
      }),
    );
    expect(config.apiUrl).toBe("https://host.example/ui/odata/Priority");
    expect(config.serviceRoot).toBe("https://host.example/ui/odata/Priority/tabula.ini,3/demodata");
  });

  it("defaults PRIORITY_ENVIRONMENT to the company value (label only)", () => {
    const config = expectConfig(loadConfig({ ...VALID_ENV }));
    expect(config.environment).toBe("demodata");
  });

  it("respects an explicit PRIORITY_ENVIRONMENT (label only, never a URL segment)", () => {
    const config = expectConfig(loadConfig({ ...VALID_ENV, PRIORITY_ENVIRONMENT: "wlnd" }));
    expect(config.environment).toBe("wlnd");
    // The environment label must not appear in the service root URL.
    expect(config.serviceRoot).not.toContain("wlnd");
  });

  it("defaults PRIORITY_READ_ONLY to true", () => {
    const config = expectConfig(loadConfig({ ...VALID_ENV }));
    expect(config.readOnly).toBe(true);
  });

  it("allows PRIORITY_READ_ONLY=false to enable writes", () => {
    const config = expectConfig(loadConfig({ ...VALID_ENV, PRIORITY_READ_ONLY: "false" }));
    expect(config.readOnly).toBe(false);
  });

  it("rejects an invalid PRIORITY_READ_ONLY value", () => {
    const errors = expectErrors(loadConfig({ ...VALID_ENV, PRIORITY_READ_ONLY: "yes" }));
    expect(errors.map((e) => e.field)).toContain("PRIORITY_READ_ONLY");
  });

  it("defaults RATE_LIMIT_PER_MINUTE to 60", () => {
    const config = expectConfig(loadConfig({ ...VALID_ENV }));
    expect(config.rateLimitPerMinute).toBe(60);
  });

  it("defaults REQUEST_TIMEOUT_MS to 60000", () => {
    const config = expectConfig(loadConfig({ ...VALID_ENV }));
    expect(config.requestTimeoutMs).toBe(60000);
  });

  it("parses positive integer limits", () => {
    const config = expectConfig(
      loadConfig({ ...VALID_ENV, RATE_LIMIT_PER_MINUTE: "90", REQUEST_TIMEOUT_MS: "120000" }),
    );
    expect(config.rateLimitPerMinute).toBe(90);
    expect(config.requestTimeoutMs).toBe(120000);
  });

  it("rejects non-positive integer limits", () => {
    const errors = expectErrors(
      loadConfig({ ...VALID_ENV, RATE_LIMIT_PER_MINUTE: "0", REQUEST_TIMEOUT_MS: "-5" }),
    );
    expect(errors.map((e) => e.field).sort()).toEqual([
      "RATE_LIMIT_PER_MINUTE",
      "REQUEST_TIMEOUT_MS",
    ]);
  });

  it("defaults LOG_LEVEL to info", () => {
    const config = expectConfig(loadConfig({ ...VALID_ENV }));
    expect(config.logLevel).toBe("info");
  });

  it("respects an explicit LOG_LEVEL", () => {
    const config = expectConfig(loadConfig({ ...VALID_ENV, LOG_LEVEL: "debug" }));
    expect(config.logLevel).toBe("debug");
  });

  it("rejects an invalid LOG_LEVEL", () => {
    const errors = expectErrors(loadConfig({ ...VALID_ENV, LOG_LEVEL: "verbose" }));
    expect(errors.map((e) => e.field)).toContain("LOG_LEVEL");
  });

  it("reads optional app id/key", () => {
    const config = expectConfig(
      loadConfig({ ...VALID_ENV, PRIORITY_APP_ID: "app-1", PRIORITY_APP_KEY: "key-1" }),
    );
    expect(config.appId).toBe("app-1");
    expect(config.appKey).toBe("key-1");
  });

  it("parses allowed/blocked tools as trimmed CSV", () => {
    const config = expectConfig(
      loadConfig({
        ...VALID_ENV,
        PRIORITY_ALLOWED_TOOLS: " one, two ,three ",
        PRIORITY_BLOCKED_TOOLS: "delete_invoice,delete_order",
      }),
    );
    expect(config.allowedTools).toEqual(["one", "two", "three"]);
    expect(config.blockedTools).toEqual(["delete_invoice", "delete_order"]);
  });

  it("reports a missing PRIORITY_API_URL", () => {
    const { PRIORITY_API_URL: _dropped, ...rest } = VALID_ENV;
    const errors = expectErrors(loadConfig({ ...rest }));
    expect(errors.map((e) => e.field)).toContain("PRIORITY_API_URL");
  });

  it("rejects an empty PRIORITY_API_URL", () => {
    const errors = expectErrors(loadConfig({ ...VALID_ENV, PRIORITY_API_URL: "   " }));
    expect(errors.map((e) => e.field)).toContain("PRIORITY_API_URL");
  });

  it("rejects a PRIORITY_API_URL that does not end in /odata/Priority", () => {
    for (const bad of [
      "https://example.com",
      "https://example.com/odata",
      "https://example.com/odata/AuthService",
      "https://example.com/odata/PriorityExtra",
      "https://example.com/odata/Priority/tabbtd38.ini,3/usdemo", // root already includes the tenant path — forbidden
    ]) {
      const errors = expectErrors(loadConfig({ ...VALID_ENV, PRIORITY_API_URL: bad }));
      expect(errors.map((e) => e.field)).toContain("PRIORITY_API_URL");
    }
  });

  it("rejects a non-https PRIORITY_API_URL", () => {
    const errors = expectErrors(
      loadConfig({ ...VALID_ENV, PRIORITY_API_URL: "http://insecure.example.com/odata/Priority" }),
    );
    expect(errors.map((e) => e.field)).toContain("PRIORITY_API_URL");
  });

  it("rejects a malformed PRIORITY_API_URL", () => {
    const errors = expectErrors(loadConfig({ ...VALID_ENV, PRIORITY_API_URL: "not-a-url" }));
    expect(errors.map((e) => e.field)).toContain("PRIORITY_API_URL");
  });

  it("reports each missing required field as its own error entry", () => {
    const errors = expectErrors(loadConfig({}));
    expect(errors.map((e) => e.field).sort()).toEqual([
      "PRIORITY_API_URL",
      "PRIORITY_COMPANY",
      "PRIORITY_PASSWORD",
      "PRIORITY_USERNAME",
    ]);
  });

  it("carries a field-level message on every error and never echoes values", () => {
    const errors = expectErrors(
      loadConfig({
        PRIORITY_API_URL: "http://insecure",
        PRIORITY_COMPANY: "x",
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error.field.length).toBeGreaterThan(0);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.message).toContain(error.field);
    }
    // Password is required; the missing-password error message must not leak
    // the surrounding value and must not echo the missing value (it's absent).
    const passwordError = errors.find((e) => e.field === "PRIORITY_PASSWORD");
    expect(passwordError).toBeDefined();
  });
});
