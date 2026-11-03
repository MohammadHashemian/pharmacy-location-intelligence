import { describe, expect, it } from "vitest";
import { filterActive, parseNum, passes } from "@/lib/tableFilter";

describe("parseNum", () => {
  it("reads Latin, Persian and Arabic digits as one number", () => {
    expect(parseNum("12500")).toBe(12500);
    expect(parseNum("۱۲٬۵۰۰")).toBe(12500);
    expect(parseNum("١٢٥٠٠")).toBe(12500);
    expect(parseNum(" ۲ ۵۰۰ ")).toBe(2500);
  });

  it("treats ٫ as a decimal separator", () => {
    expect(parseNum("۲٫۵")).toBe(2.5);
  });

  it("is null for an empty or unreadable box", () => {
    expect(parseNum("")).toBeNull();
    expect(parseNum(undefined)).toBeNull();
    expect(parseNum("   ")).toBeNull();
    expect(parseNum("abc")).toBeNull();
    expect(parseNum("-")).toBeNull();
  });
});

describe("filterActive", () => {
  it("ignores blank input", () => {
    expect(filterActive(undefined)).toBe(false);
    expect(filterActive({})).toBe(false);
    expect(filterActive({ min: "", max: " ", q: "  " })).toBe(false);
  });

  it("counts either end, text and picks", () => {
    expect(filterActive({ min: "۱۰۰۰" })).toBe(true);
    expect(filterActive({ max: "۹۰۰۰" })).toBe(true);
    expect(filterActive({ q: "اهواز" })).toBe(true);
    expect(filterActive({ pick: ["شهرستان اهواز"] })).toBe(true);
  });
});

describe("passes", () => {
  const row = (num: number | null) => ({ num });

  it("passes everything when the filter is empty", () => {
    expect(passes(undefined, row(5))).toBe(true);
    expect(passes({}, row(null))).toBe(true);
  });

  it("holds both ends inclusively", () => {
    const f = { min: "۱۰۰۰", max: "۵۰۰۰" };
    expect(passes(f, row(999))).toBe(false);
    expect(passes(f, row(1000))).toBe(true);
    expect(passes(f, row(5000))).toBe(true);
    expect(passes(f, row(5001))).toBe(false);
  });

  it("accepts a one-ended range", () => {
    expect(passes({ min: "۲۰۰۰۰" }, row(15_000))).toBe(false);
    expect(passes({ min: "۲۰۰۰۰" }, row(20_000))).toBe(true);
    expect(passes({ max: "۲۰۰۰۰" }, row(19_999))).toBe(true);
    expect(passes({ max: "۲۰۰۰۰" }, row(20_001))).toBe(false);
  });

  it("reads a crossed pair as the same interval, not an empty list", () => {
    const f = { min: "۵۰٬۰۰۰", max: "۱۰٬۰۰۰" };
    expect(passes(f, row(30_000))).toBe(true);
    expect(passes(f, row(5_000))).toBe(false);
  });

  it("never lets an unknown value through a range", () => {
    expect(passes({ min: "0" }, row(null))).toBe(false);
    expect(passes({ max: "9000" }, row(null))).toBe(false);
  });

  it("matches text by substring, with or without the descriptive prefix", () => {
    expect(passes({ q: "اهواز" }, { text: "شهرستان اهواز" })).toBe(true);
    expect(passes({ q: "شهرستان" }, { text: "شهرستان اهواز" })).toBe(true);
    expect(passes({ q: "دزفول" }, { text: "شهرستان اهواز" })).toBe(false);
  });

  it("keeps only picked values", () => {
    const f = { pick: ["شهرستان اهواز", "شهرستان دزفول"] };
    expect(passes(f, { text: "شهرستان اهواز" })).toBe(true);
    expect(passes(f, { text: "شهرستان شوش" })).toBe(false);
  });
});
