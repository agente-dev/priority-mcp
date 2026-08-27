/**
 * Decimal-string money module for Priority amounts.
 *
 * ZERO float arithmetic on values: every amount is carried as a canonical
 * decimal string ("1234.56") or, between operations, as integer minor units
 * (agorot, fixed 2dp). Integer arithmetic in JS `number` is exact within
 * ±2^53-1 minor units — far beyond any realistic ERP total.
 *
 * Verified wire fact (docs/priority-api-verified.md + live probes): Priority
 * sends Edm.Decimal as JSON numbers (e.g. `QPRICE: 211.86`, `CONV: 1.0000000`)
 * with variable scale — `decimalFromApi` normalizes them via the shortest
 * round-trip decimal representation and string-only rounding, never float
 * arithmetic on the value.
 */

/** Reason codes for `MoneyError`. */
export type MoneyErrorCode = "invalid_format" | "too_many_decimals" | "not_finite";

/** Typed error for money operations. */
export class MoneyError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = "MoneyError";
    this.code = code;
  }
}

/** Accepted input shape: optional sign, digits, at most 2 fraction digits. */
const DECIMAL_RE = /^-?\d+(\.\d{1,2})?$/;

/** Shape rejected with `too_many_decimals`: 3+ fraction digits. */
const TOO_MANY_DECIMALS_RE = /^-?\d+(\.\d{3,})$/;

/**
 * Parse a decimal string into integer minor units (agorot/cents).
 * Rejects: empty strings, >2dp precision, non-numeric input. Negative values
 * are allowed (credit documents). Exact for |result| < 2^53.
 */
export function parseDecimal(value: string): number {
  if (typeof value !== "string" || value.length === 0) {
    throw new MoneyError("invalid_format", "money value must be a non-empty decimal string");
  }
  if (TOO_MANY_DECIMALS_RE.test(value)) {
    throw new MoneyError(
      "too_many_decimals",
      `"${value}" has more than 2 fraction digits; money is fixed at 2dp precision`,
    );
  }
  if (!DECIMAL_RE.test(value)) {
    throw new MoneyError(
      "invalid_format",
      `"${value}" is not a valid decimal money string (expected d+ or d+.d{1,2})`,
    );
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const dot = unsigned.indexOf(".");
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? "" : unsigned.slice(dot + 1);
  const minor = Number(intPart) * 100 + Number(fracPart.padEnd(2, "0"));
  if (!Number.isSafeInteger(minor)) {
    throw new MoneyError("not_finite", `"${value}" exceeds the supported integer minor-unit range`);
  }
  return negative ? -minor : minor;
}

/**
 * Format integer minor units back to the canonical decimal string,
 * `formatMinor(123456) === "1234.56"`. Input must be a safe integer.
 */
export function formatMinor(minor: number): string {
  if (!Number.isSafeInteger(minor)) {
    throw new MoneyError("not_finite", `minor value ${minor} must be a safe integer`);
  }
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const intPart = Math.floor(abs / 100);
  const fracPart = abs % 100;
  return `${sign}${intPart}.${String(fracPart).padStart(2, "0")}`;
}

/** Exact addition in minor units — `addMoney("0.1", "0.2") === "0.30"`. */
export function addMoney(a: string, b: string): string {
  return formatMinor(parseDecimal(a) + parseDecimal(b));
}

/**
 * Normalize a Priority Edm.Decimal boundary value (JSON number or decimal
 * string) to the canonical 2dp money string. Numbers travel through their
 * shortest round-trip decimal representation; both paths round half-up with
 * string arithmetic — no float arithmetic on the value.
 */
export function decimalFromApi(value: number | string): string {
  if (typeof value === "string") {
    if (value.length === 0 || !/^-?\d+(\.\d+)?$/.test(value)) {
      throw new MoneyError("invalid_format", `"${value}" is not a decimal numeric string`);
    }
    return roundHalfUpAtTwo(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MoneyError("not_finite", `expected a finite number, got ${String(value)}`);
  }
  return roundHalfUpAtTwo(expandExponent(String(value)));
}

/** Expand exponent notation ("1.5e-7", "1e+21") to plain decimal digits. */
function expandExponent(raw: string): string {
  const eIndex = raw.search(/[eE]/);
  if (eIndex === -1) return raw;
  const mantissa = raw.slice(0, eIndex);
  const exponent = Number(raw.slice(eIndex + 1));
  const sign = mantissa.startsWith("-") ? "-" : "";
  const unsigned = sign === "" ? mantissa : mantissa.slice(1);
  const dot = unsigned.indexOf(".");
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? "" : unsigned.slice(dot + 1);
  const allDigits = intPart + fracPart;
  const pointPos = intPart.length + exponent;
  if (pointPos <= 0) {
    return `${sign}0.${"0".repeat(-pointPos)}${allDigits}`;
  }
  if (pointPos >= allDigits.length) {
    return `${sign}${allDigits}${"0".repeat(pointPos - allDigits.length)}`;
  }
  return `${sign}${allDigits.slice(0, pointPos)}.${allDigits.slice(pointPos)}`;
}

/** Round a plain decimal string to 2 fraction digits, half up, string-only. */
function roundHalfUpAtTwo(value: string): string {
  const sign = value.startsWith("-") ? "-" : "";
  const unsigned = sign === "" ? value : value.slice(1);
  const dot = unsigned.indexOf(".");
  const intPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracPart = dot === -1 ? "" : unsigned.slice(dot + 1);
  const kept = fracPart.slice(0, 2);
  const dropped = fracPart.slice(2);
  const roundUp = dropped.length > 0 && Number(dropped[0] ?? "0") >= 5;
  let int = intPart;
  let frac = kept.padEnd(2, "0");
  if (roundUp) {
    let next = Number(frac) + 1;
    if (next >= 100) {
      next -= 100;
      int = (BigInt(intPart) + 1n).toString();
    }
    frac = String(next).padStart(2, "0");
  }
  return `${sign}${int}.${frac}`;
}
