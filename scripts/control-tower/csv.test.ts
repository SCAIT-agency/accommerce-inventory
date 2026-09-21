import { describe, it, expect } from "vitest";
import { parseCsv, normalizeNumber, normalizeDate, normalizeBool } from "./csv";

describe("parseCsv", () => {
  it("parses quoted fields with embedded commas, quotes and newlines", () => {
    const text = '"a","b,c","d ""q"" e","line1\nline2"\r\n"1","","3","4"\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b,c", 'd "q" e', "line1\nline2"],
      ["1", "", "3", "4"],
    ]);
  });

  it("drops a trailing empty line only", () => {
    expect(parseCsv('"x"\n"y"\n')).toEqual([["x"], ["y"]]);
  });

  it("handles unquoted fields and a final row without newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("normalizeNumber", () => {
  it("strips thousands separators", () => expect(normalizeNumber("50,040")).toBe("50040"));
  it("keeps decimals and sign", () => expect(normalizeNumber("-3,534.78")).toBe("-3534.78"));
  it("returns null for blank", () => expect(normalizeNumber("")).toBeNull());
  it("returns null for whitespace", () => expect(normalizeNumber("  ")).toBeNull());
  it("throws on currency symbols", () => expect(() => normalizeNumber("€2.87")).toThrow(/not a number/));
  it("throws on percent", () => expect(() => normalizeNumber("11%")).toThrow(/not a number/));
});

describe("normalizeDate", () => {
  it("accepts ISO", () => expect(normalizeDate("2026-07-06")).toBe("2026-07-06"));
  it("returns null for blank", () => expect(normalizeDate("")).toBeNull());
  it("throws on other formats", () => expect(() => normalizeDate("06.07.2026")).toThrow(/not an ISO date/));
});

describe("normalizeBool", () => {
  it("parses TRUE/FALSE case-insensitively", () => {
    expect(normalizeBool("TRUE")).toBe(true);
    expect(normalizeBool("false")).toBe(false);
    expect(normalizeBool("")).toBe(false);
  });
});
