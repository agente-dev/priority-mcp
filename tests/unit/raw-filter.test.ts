import { describe, expect, it } from "vitest";
import { ODataBuilder, ODataError } from "../../src/priority/odata.js";

describe("rawFilter escape hatch", () => {
  it("renders a raw $filter expression into the built path", () => {
    const path = new ODataBuilder()
      .rawFilter("IVDATE ge 2020-01-01T07:25:00Z")
      .top(5)
      .build("ORDERS");
    expect(path).toBe("ORDERS?$top=5&$filter=IVDATE%20ge%202020-01-01T07:25:00Z");
  });

  it("is mutually exclusive with filter()", () => {
    const builder = new ODataBuilder().filter({
      kind: "op",
      field: "STATDES",
      op: "eq",
      value: "A",
    });
    expect(() => builder.rawFilter("FINAL eq 'Y'")).toThrow(ODataError);
  });

  it("rawFilter wins when set first, and a later filter() throws", () => {
    const builder = new ODataBuilder().rawFilter("FINAL eq 'Y'");
    expect(() => builder.filter({ kind: "op", field: "STATDES", op: "eq", value: "A" })).toThrow(
      ODataError,
    );
  });

  it("rejects empty and non-string expressions", () => {
    expect(() => new ODataBuilder().rawFilter("")).toThrow(ODataError);
    expect(() => new ODataBuilder().rawFilter("   ")).toThrow(ODataError);
    expect(() => new ODataBuilder().rawFilter("   " as string).build("ORDERS")).toThrow(ODataError);
  });
});
