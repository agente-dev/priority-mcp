import { describe, expect, it } from "vitest";
import {
  addMoney,
  decimalFromApi,
  formatMinor,
  MoneyError,
  parseDecimal,
} from "../../src/priority/money.js";

describe("parseDecimal → integer minor units", () => {
  it("parses canonical values", () => {
    expect(parseDecimal("1234.56")).toBe(123456);
    expect(parseDecimal("0.05")).toBe(5);
    expect(parseDecimal("0.5")).toBe(50);
    expect(parseDecimal("1")).toBe(100);
    expect(parseDecimal("0")).toBe(0);
    expect(parseDecimal("999999999999.99")).toBe(99999999999999);
  });

  it("parses negative values (credit documents)", () => {
    expect(parseDecimal("-1234.56")).toBe(-123456);
    expect(parseDecimal("-5")).toBe(-500);
  });

  it("rejects more than 2 decimal places", () => {
    for (const bad of ["1.234", "0.001", "-1.005", "1.0000000"]) {
      expect(() => parseDecimal(bad)).toThrow(MoneyError);
      expect(() => parseDecimal(bad)).toThrowError(/more than 2 fraction digits/);
    }
  });

  it("rejects garbage", () => {
    for (const bad of ["", "abc", "1,5", "1.2.3", "0x10", " 1.5", "1.5 "]) {
      expect(() => parseDecimal(bad)).toThrow(MoneyError);
    }
  });
});

describe("formatMinor → canonical decimal string", () => {
  it("formats minor units", () => {
    expect(formatMinor(123456)).toBe("1234.56");
    expect(formatMinor(5)).toBe("0.05");
    expect(formatMinor(50)).toBe("0.50");
    expect(formatMinor(100)).toBe("1.00");
    expect(formatMinor(0)).toBe("0.00");
    expect(formatMinor(-123456)).toBe("-1234.56");
  });

  it("rejects non-safe-integer input", () => {
    expect(() => formatMinor(Number.NaN)).toThrow(MoneyError);
    expect(() => formatMinor(1.5)).toThrow(MoneyError);
  });

  it("round-trips through parse/format", () => {
    for (const value of ["0.00", "0.05", "0.10", "1.00", "1234.56", "-999.99", "999999999999.99"]) {
      expect(formatMinor(parseDecimal(value))).toBe(value);
    }
  });
});

describe("0.1 + 0.2 exactness in minor units", () => {
  it("is exact in integer minor units", () => {
    const minorSum = parseDecimal("0.1") + parseDecimal("0.2");
    expect(minorSum).toBe(30);
    expect(minorSum).toBe(parseDecimal("0.3"));
    expect(addMoney("0.1", "0.2")).toBe("0.30");
  });

  it("adds larger sums exactly", () => {
    expect(addMoney("1234.56", "765.44")).toBe("2000.00");
    expect(addMoney("-5.00", "2.50")).toBe("-2.50");
  });
});

describe("decimalFromApi — Edm.Decimal boundary normalization", () => {
  it("normalizes JSON numbers via shortest-repr round-trip", () => {
    expect(decimalFromApi(211.86)).toBe("211.86");
    expect(decimalFromApi(966633)).toBe("966633.00");
    expect(decimalFromApi(0)).toBe("0.00");
    expect(decimalFromApi(-7.5)).toBe("-7.50");
    // Variable scale seen live: CONV: 1.0000000, TOTQUANT: 0.000
    expect(decimalFromApi(1.0)).toBe("1.00");
    expect(decimalFromApi(0.005)).toBe("0.01"); // half-up rounding, string-only
  });

  it("normalizes decimal strings", () => {
    expect(decimalFromApi("1234.56")).toBe("1234.56");
    expect(decimalFromApi("966633.00")).toBe("966633.00");
    expect(decimalFromApi("1.005")).toBe("1.01"); // rounds, does not throw
    expect(decimalFromApi("-0.5")).toBe("-0.50");
  });

  it("rejects non-finite numbers and malformed strings", () => {
    expect(() => decimalFromApi(Number.NaN)).toThrow(MoneyError);
    expect(() => decimalFromApi(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
    expect(() => decimalFromApi("abc")).toThrow(MoneyError);
    expect(() => decimalFromApi("")).toThrow(MoneyError);
  });
});
