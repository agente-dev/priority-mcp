import { describe, expect, it } from "vitest";
import {
  and,
  encodeODataValue,
  functionCall,
  literal,
  normalizeUtcSince,
  ODataBuilder,
  ODataError,
  op,
  or,
  paren,
  quoteString,
  renderFilter,
  toDateTimeOffset,
} from "../../src/priority/odata.js";

describe("string quoting (OData injection safety)", () => {
  it("doubles embedded apostrophes, never strips them", () => {
    expect(quoteString("O'Brien")).toBe("'O''Brien'");
    expect(literal("it's")).toBe("'it''s'");
    expect(literal("plain")).toBe("'plain'");
  });

  it("renders numbers, booleans and dates as literals", () => {
    expect(literal(5)).toBe("5");
    expect(literal(true)).toBe("true");
    expect(literal(false)).toBe("false");
    expect(literal(new Date("2020-01-01T07:25:00Z"))).toBe("2020-01-01T07:25:00Z");
  });
});

describe("filter composition", () => {
  it("renders comparison ops", () => {
    expect(renderFilter(op("STATDES", "eq", "A"))).toBe("STATDES eq 'A'");
    expect(renderFilter(op("IVDATE", "ge", new Date("2020-01-01T07:25:00Z")))).toBe(
      "IVDATE ge 2020-01-01T07:25:00Z",
    );
    expect(renderFilter(op("TOTPRICE", "gt", 0))).toBe("TOTPRICE gt 0");
    expect(renderFilter(op("FINAL", "ne", "Y"))).toBe("FINAL ne 'Y'");
  });

  it("composes and/or with parentheses", () => {
    const filter = and(
      paren(or(op("STATDES", "eq", "A"), op("STATDES", "eq", "B"))),
      op("FINAL", "eq", "Y"),
    );
    expect(renderFilter(filter)).toBe("(STATDES eq 'A' or STATDES eq 'B') and FINAL eq 'Y'");
  });

  it("rejects and/or with no operands", () => {
    expect(() => and()).toThrow(ODataError);
    expect(() => or()).toThrow(ODataError);
  });

  it("rejects non-uppercase field names (silent filter swallow guard)", () => {
    expect(() => op("ivnum", "eq", "x")).toThrow(ODataError);
    expect(() => op("IVNUM ", "eq", "x")).toThrow(ODataError);
  });
});

describe("composite key segments", () => {
  it("builds the AINVOICES-style composite key in insertion order", () => {
    const keys = { IVNUM: "T00000001", IVTYPE: "A", DEBIT: "D" };
    expect(ODataBuilder.keySegment(keys)).toBe("(IVNUM='T00000001',IVTYPE='A',DEBIT='D')");
  });

  it("doubles apostrophes inside key values", () => {
    expect(ODataBuilder.keySegment({ IVNUM: "O'Brien" })).toBe("(IVNUM='O''Brien')");
  });

  it("requires at least one key and rejects lowercase fields", () => {
    expect(() => ODataBuilder.keySegment({})).toThrow(ODataError);
    expect(() => ODataBuilder.keySegment({ ivnum: "x" })).toThrow(ODataError);
  });

  it("includes the key segment in the built path", () => {
    const path = new ODataBuilder()
      .keys({ IVNUM: "T00000001", IVTYPE: "A", DEBIT: "D" })
      .select(["IVNUM", "IVTYPE"])
      .build("AINVOICES");
    expect(path).toBe("AINVOICES(IVNUM='T00000001',IVTYPE='A',DEBIT='D')?$select=IVNUM,IVTYPE");
  });
});

describe("$since — UTC Z enforcement", () => {
  it("accepts and normalizes UTC-Z datetimes", () => {
    expect(normalizeUtcSince("2020-01-01T07:25:00Z")).toBe("2020-01-01T07:25:00Z");
    expect(normalizeUtcSince("2020-01-01T07:25:00.123Z")).toBe("2020-01-01T07:25:00Z");
    expect(normalizeUtcSince("2020-01-01T07:25:00z")).toBe("2020-01-01T07:25:00Z");
  });

  it("rejects offset datetimes (DST hazard) and garbage", () => {
    expect(() => normalizeUtcSince("2020-01-01T07:25:00+02:00")).toThrow(ODataError);
    expect(() => normalizeUtcSince("2020-01-01T07:25:00")).toThrow(ODataError);
    expect(() => normalizeUtcSince("not-a-date")).toThrow(ODataError);
  });

  it("adds $since to the built path when given a Date", () => {
    const path = new ODataBuilder().since(new Date("2020-01-01T07:25:00Z")).build("ORDERS");
    expect(path).toBe("ORDERS?$since=2020-01-01T07:25:00Z");
  });

  it("rejects non-Z strings via .since()", () => {
    expect(() => new ODataBuilder().since("2020-01-01T07:25:00+02:00")).toThrow(ODataError);
  });
});

describe("URL encoding", () => {
  it("encodes spaces as %20 (never +)", () => {
    expect(encodeODataValue("IVDATE ge 2020-01-01T07:25:00Z")).toBe(
      "IVDATE%20ge%202020-01-01T07:25:00Z",
    );
  });

  it("keeps + encoded as %2B (datetime offsets) and ; as %3B (expand options)", () => {
    expect(encodeODataValue("2020-01-01T09:59:00+02:00")).toBe("2020-01-01T09:59:00%2B02:00");
    expect(encodeODataValue("AINVOICEITEMS_SUBFORM($select=QUANT;$orderby=QUANT)")).toBe(
      "AINVOICEITEMS_SUBFORM($select=QUANT%3B$orderby=QUANT)",
    );
  });

  it("leaves OData syntax characters raw and encodes separators", () => {
    // $ ( ) , = ' stay raw; & becomes %26; # becomes %23
    expect(encodeODataValue("CDES eq 'O''Brien & Sons'")).toBe(
      "CDES%20eq%20'O''Brien%20%26%20Sons'",
    );
  });

  it("builds a fully encoded filter URL", () => {
    const path = new ODataBuilder()
      .filter(
        and(
          op("CDES", "eq", "O'Brien & Sons"),
          paren(or(op("STATDES", "eq", "A"), op("STATDES", "eq", "B"))),
        ),
      )
      .top(10)
      .build("CUSTOMERS");
    expect(path).toBe(
      "CUSTOMERS?$top=10&$filter=CDES%20eq%20'O''Brien%20%26%20Sons'%20and%20(STATDES%20eq%20'A'%20or%20STATDES%20eq%20'B')",
    );
  });

  it("builds nested $expand options with %3B", () => {
    const path = new ODataBuilder()
      .expand([
        { path: "AINVOICEITEMS_SUBFORM", select: ["QUANT", "PARTNAME"], orderby: ["QUANT desc"] },
      ])
      .build("AINVOICES");
    expect(path).toBe(
      "AINVOICES?$expand=AINVOICEITEMS_SUBFORM($select=QUANT,PARTNAME%3B$orderby=QUANT%20desc)",
    );
  });

  it("encodes $skip values (numeric offsets carry no + here, but encoding is uniform)", () => {
    const path = new ODataBuilder().skip(20).top(5).build("AINVOICES");
    expect(path).toBe("AINVOICES?$top=5&$skip=20");
  });
});

describe("builder path assembly", () => {
  it("builds a bare entity path with no options", () => {
    expect(new ODataBuilder().build("AINVOICES")).toBe("AINVOICES");
  });

  it("orders query params deterministically (cache-key friendly)", () => {
    const a = new ODataBuilder()
      .orderby(["IVDATE desc"])
      .select(["IVNUM"])
      .top(1)
      .since("2020-01-01T07:25:00Z")
      .build("ORDERS");
    const b = new ODataBuilder()
      .since("2020-01-01T07:25:00Z")
      .top(1)
      .select(["IVNUM"])
      .orderby(["IVDATE desc"])
      .build("ORDERS");
    expect(a).toBe(b);
  });

  it("rejects lowercase/malformed entity names", () => {
    expect(() => new ODataBuilder().build("ainvoices")).toThrow(ODataError);
    expect(() => new ODataBuilder().build("AINVOICE S")).toThrow(ODataError);
  });

  it("validates top/skip bounds", () => {
    expect(() => new ODataBuilder().top(0)).toThrow(ODataError);
    expect(() => new ODataBuilder().top(-1)).toThrow(ODataError);
    expect(() => new ODataBuilder().skip(-1)).toThrow(ODataError);
    expect(() => new ODataBuilder().skip(1.5)).toThrow(ODataError);
  });

  it("builds unbound function call segments", () => {
    expect(functionCall("GetMetadataFor", { entity: "AINVOICES" })).toBe(
      "GetMetadataFor(entity='AINVOICES')",
    );
    expect(functionCall("GetPriorityVersion")).toBe("GetPriorityVersion");
  });

  it("renders dates via toDateTimeOffset without milliseconds", () => {
    expect(toDateTimeOffset(new Date("2020-01-01T07:25:00.000Z"))).toBe("2020-01-01T07:25:00Z");
  });
});
