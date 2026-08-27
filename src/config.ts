/**
 * Environment-based configuration for the priority-mcp server.
 *
 * Validation is total and exception-free: `loadConfig` never throws. It
 * returns a discriminated result that either carries a fully validated
 * `Config` or a list of field-level `ConfigError`s, so a boot with invalid
 * config can print every problem at once and exit 1.
 *
 * URL contract (train-2 correction, rationale in docs/priority-api-verified.md):
 * installs vary in URL shape — the sandbox is `{host}/odata/Priority/...`
 * while some installs carry a path prefix (`{host}/ui/odata/Priority/...`).
 * ONE env var owns the whole prefix: `PRIORITY_API_URL` must be an https URL
 * ending in `/odata/Priority` (after trailing-slash trim; validation error
 * otherwise). The service root is derived:
 * `serviceRoot = {API_URL}/{INI},{LANG}/{COMPANY}`.
 *
 * `PRIORITY_ENVIRONMENT` is an OPTIONAL metadata label (defaults to the
 * company value) used for cache namespacing and logs only — it is NEVER a
 * URL segment.
 *
 * Safety note: error messages echo field NAMES only, never values — password
 * and app-key secrets must never leak into logs or back to an agent.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Config {
  /**
   * Priority OData base URL. https, ends with `/odata/Priority` (trailing
   * slashes trimmed). Never logged as validated output.
   */
  apiUrl: string;
  /**
   * Optional metadata label (defaults to the company value). Cache
   * namespacing and logs only — never a URL segment.
   */
  environment: string;
  /** Priority company code within the environment. */
  company: string;
  /** Priority API username. */
  username: string;
  /** Priority API password or PAT value. Never logged. */
  password: string;
  /** tabula.ini segment name (varies per install; e.g. `tabbtd38.ini`). */
  tabulaIni: string;
  /** Language code (3 = US English). */
  language: string;
  /** Derived service root: `{apiUrl}/{tabulaIni},{language}/{company}`. */
  serviceRoot: string;
  /** Optional per-app license header value `X-App-Id`. */
  appId?: string;
  /** Optional per-app license header value `X-App-Key`. */
  appKey?: string;
  /** When true (the default), write tools are not registered at all. */
  readOnly: boolean;
  /** Optional allowlist of tool names (CSV). */
  allowedTools?: string[];
  /** Optional denylist of tool names (CSV). */
  blockedTools?: string[];
  /** Calls per minute (default 60, under the vendor's 100/min fair use). */
  rateLimitPerMinute: number;
  /** Request timeout (default 60000, under the vendor's 3-min kill). */
  requestTimeoutMs: number;
  logLevel: LogLevel;
}

export interface ConfigError {
  /** The environment variable that failed validation. */
  field: string;
  /** Human-readable, field-level explanation. Echoes the field name only. */
  message: string;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; errors: ConfigError[] };

type EnvSource = Record<string, string | undefined>;

function parseCsv(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePositiveInt(
  field: string,
  raw: string | undefined,
  fallback: number,
  errors: ConfigError[],
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) {
    errors.push({ field, message: `${field} must be a positive integer; got an invalid value.` });
    return fallback;
  }
  return value;
}

/** Strip trailing slashes — `https://x/odata/Priority/` → `https://x/odata/Priority`. */
function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export function loadConfig(env: EnvSource = process.env): ConfigResult {
  const errors: ConfigError[] = [];

  // --- Required: PRIORITY_API_URL (https, ends with /odata/Priority) ---
  let apiUrl = "";
  const rawApiUrl = env.PRIORITY_API_URL;
  if (rawApiUrl === undefined || rawApiUrl.trim() === "") {
    errors.push({ field: "PRIORITY_API_URL", message: "PRIORITY_API_URL is required." });
  } else {
    const trimmed = rawApiUrl.trim();
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:") {
        errors.push({
          field: "PRIORITY_API_URL",
          message: "PRIORITY_API_URL must be an https URL.",
        });
      } else {
        const pathname = trimTrailingSlashes(parsed.pathname);
        if (!pathname.endsWith("/odata/Priority")) {
          errors.push({
            field: "PRIORITY_API_URL",
            message:
              "PRIORITY_API_URL must end with /odata/Priority " +
              "(e.g. https://host/odata/Priority or https://host/ui/odata/Priority); " +
              "the whole prefix lives in this one variable.",
          });
        } else {
          // Normalize: no trailing slash, no query/hash — the service root
          // is appended below and must not inherit query strings.
          apiUrl = trimTrailingSlashes(`${parsed.origin}${parsed.pathname}`);
        }
      }
    } catch {
      errors.push({
        field: "PRIORITY_API_URL",
        message: "PRIORITY_API_URL must be a valid absolute URL.",
      });
    }
  }

  // --- Required strings ---
  const requiredFields = ["PRIORITY_COMPANY", "PRIORITY_USERNAME", "PRIORITY_PASSWORD"] as const;
  for (const field of requiredFields) {
    const raw = env[field];
    if (raw === undefined || raw.trim() === "") {
      errors.push({ field, message: `${field} is required and must be a non-empty string.` });
    }
  }

  // --- Optional with defaults ---
  const tabulaIni = env.PRIORITY_TABULA_INI?.trim() || "tabula.ini";
  const language = env.PRIORITY_LANGUAGE?.trim() || "3";

  // PRIORITY_ENVIRONMENT is an optional label (default: company value). It is
  // used for cache namespacing and logs only — never a URL segment.
  const rawEnvironment = env.PRIORITY_ENVIRONMENT?.trim();
  const company = env.PRIORITY_COMPANY ?? "";
  const environment =
    rawEnvironment === undefined || rawEnvironment === "" ? company : rawEnvironment;

  // PRIORITY_READ_ONLY defaults to true — writes gated off until explicit opt-in.
  let readOnly = true;
  const rawReadOnly = env.PRIORITY_READ_ONLY;
  if (rawReadOnly !== undefined && rawReadOnly !== "") {
    if (rawReadOnly === "true") {
      readOnly = true;
    } else if (rawReadOnly === "false") {
      readOnly = false;
    } else {
      errors.push({
        field: "PRIORITY_READ_ONLY",
        message:
          'PRIORITY_READ_ONLY must be exactly "true" or "false" (defaults to true when unset).',
      });
    }
  }

  const appId = env.PRIORITY_APP_ID?.trim() || undefined;
  const appKey = env.PRIORITY_APP_KEY?.trim() || undefined;
  const allowedTools = parseCsv(env.PRIORITY_ALLOWED_TOOLS);
  const blockedTools = parseCsv(env.PRIORITY_BLOCKED_TOOLS);

  const rateLimitPerMinute = parsePositiveInt(
    "RATE_LIMIT_PER_MINUTE",
    env.RATE_LIMIT_PER_MINUTE,
    60,
    errors,
  );
  const requestTimeoutMs = parsePositiveInt(
    "REQUEST_TIMEOUT_MS",
    env.REQUEST_TIMEOUT_MS,
    60000,
    errors,
  );

  let logLevel: LogLevel = "info";
  const rawLogLevel = env.LOG_LEVEL;
  if (rawLogLevel !== undefined && rawLogLevel !== "") {
    if (
      rawLogLevel === "debug" ||
      rawLogLevel === "info" ||
      rawLogLevel === "warn" ||
      rawLogLevel === "error"
    ) {
      logLevel = rawLogLevel;
    } else {
      errors.push({
        field: "LOG_LEVEL",
        message: "LOG_LEVEL must be one of debug, info, warn, error (defaults to info when unset).",
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      apiUrl,
      environment,
      company,
      username: env.PRIORITY_USERNAME as string,
      password: env.PRIORITY_PASSWORD as string,
      tabulaIni,
      language,
      serviceRoot: `${apiUrl}/${tabulaIni},${language}/${company}`,
      appId,
      appKey,
      readOnly,
      allowedTools,
      blockedTools,
      rateLimitPerMinute,
      requestTimeoutMs,
      logLevel,
    },
  };
}
