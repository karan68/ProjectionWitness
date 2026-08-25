import { canonicalJson, canonicalJsonBytes, canonicalSha256 } from "@projection-witness/evidence";
import { describe, expect, it } from "vitest";

describe("RFC 8785 canonical JSON", () => {
  it("matches the RFC 8785 sections 3.2.2 and 3.2.3 sample", () => {
    const sample = {
      numbers: [Number("333333333.33333329"), 1e30, 4.5, 2e-3, 1e-27],
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    };
    const expected = `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA'B\\"\\\\\\\\\\"/"}`;

    expect(canonicalJson(sample)).toBe(expected);
    expect(canonicalJsonBytes(sample)).toEqual(Buffer.from(expected, "utf8"));
  });

  it("matches the RFC 8785 section 3.2.3 UTF-16 property order", () => {
    const sorted = canonicalJson({
      "€": "Euro Sign",
      "\r": "Carriage Return",
      דּ: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
    });

    expect(sorted).toBe(
      `{"\\r":"Carriage Return","1":"One","":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}`,
    );
  });

  it("produces the same digest for different object insertion order", () => {
    const first = { rowVersion: "9", paidCents: "12900", orderId: "ORD-1042" };
    const second = { orderId: "ORD-1042", paidCents: "12900", rowVersion: "9" };

    expect(canonicalSha256(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalSha256(first)).toBe(canonicalSha256(second));
  });

  it.each([1n, Number.NaN, Number.POSITIVE_INFINITY, "\ud800"])(
    "rejects non-I-JSON input %#",
    (value) => {
      expect(() => canonicalJson(value)).toThrow();
    },
  );
});
