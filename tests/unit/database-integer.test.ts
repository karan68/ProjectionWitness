import { parseSafeDatabaseInteger } from "@projection-witness/database";
import { describe, expect, it } from "vitest";

describe("parseSafeDatabaseInteger", () => {
  it("accepts non-negative safe integer strings and numbers", () => {
    expect(parseSafeDatabaseInteger("0", "value")).toBe(0);
    expect(parseSafeDatabaseInteger("12900", "value")).toBe(12_900);
    expect(parseSafeDatabaseInteger(42, "value")).toBe(42);
  });

  it("rejects negative, fractional, and unsafe values", () => {
    expect(() => parseSafeDatabaseInteger("-1", "money")).toThrow(/not a decimal integer/);
    expect(() => parseSafeDatabaseInteger(-1, "money")).toThrow(/not a decimal integer/);
    expect(() => parseSafeDatabaseInteger("1.5", "money")).toThrow(/not a decimal integer/);
    expect(() => parseSafeDatabaseInteger("9007199254740992", "money")).toThrow(
      /safe integer range/,
    );
  });
});
