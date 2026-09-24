import { describe, it, expect } from "vitest";
import { nonNegativeDecimalString, shareString } from "./routers";

describe("nonNegativeDecimalString", () => {
  it("accepts a plain non-negative decimal string", () => {
    expect(nonNegativeDecimalString.safeParse("12.5").success).toBe(true);
    expect(nonNegativeDecimalString.safeParse("0").success).toBe(true);
  });

  it("rejects non-numeric, negative, or scientific-notation strings", () => {
    expect(nonNegativeDecimalString.safeParse("abc").success).toBe(false);
    expect(nonNegativeDecimalString.safeParse("-5").success).toBe(false);
    expect(nonNegativeDecimalString.safeParse("1e5").success).toBe(false);
    expect(nonNegativeDecimalString.safeParse("").success).toBe(false);
  });
});

describe("shareString", () => {
  it("accepts a decimal string between 0 and 1 inclusive", () => {
    expect(shareString.safeParse("0").success).toBe(true);
    expect(shareString.safeParse("1").success).toBe(true);
    expect(shareString.safeParse("0.5").success).toBe(true);
    expect(shareString.safeParse("1.0").success).toBe(true);
  });

  it("rejects a share above 1, even though it's still a valid non-negative decimal", () => {
    const result = shareString.safeParse("1.5");
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric or negative strings, same as nonNegativeDecimalString", () => {
    expect(shareString.safeParse("abc").success).toBe(false);
    expect(shareString.safeParse("-0.1").success).toBe(false);
  });
});
