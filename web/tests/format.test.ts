import { describe, expect, it } from "vitest";
import {
  group,
  irr,
  num,
  shortCounty,
  shortDistrict,
  shortPlace,
  tick,
  toPersianDigits,
} from "@/lib/format";
import { jalaliFromIso, toJalali } from "@/lib/jalali";

const FA = "۰۱۲۳۴۵۶۷۸۹";
const TH = "\u066C";
const DEC = "\u066B";

describe("digits", () => {
  it("converts every Latin digit", () => {
    expect(toPersianDigits("0123456789")).toBe(FA);
  });

  it("accepts numbers", () => {
    expect(toPersianDigits(42)).toBe("۴۲");
  });
});

describe("group", () => {
  it("rounds and groups with the Arabic separator", () => {
    expect(group(1234567)).toBe(`۱${TH}۲۳۴${TH}۵۶۷`);
  });

  it("has an em dash for missing and infinite values", () => {
    expect(group(null)).toBe("—");
    expect(group(undefined)).toBe("—");
    expect(group(Number.NaN)).toBe("—");
    expect(group(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("keeps zero", () => {
    expect(group(0)).toBe("۰");
  });
});

describe("num", () => {
  it("uses the Arabic decimal separator, not a dot", () => {
    expect(num(73.25, 2)).toBe(`۷۳${DEC}۲۵`);
  });

  it("the default digit count is one", () => {
    expect(num(1.5)).toBe(`۱${DEC}۵`);
  });

  it("is an em dash when there is no number", () => {
    expect(num(null)).toBe("—");
  });
});

describe("irr", () => {
  it("compacts trillions", () => {
    expect(irr(2.4e12)).toContain("هزار میلیارد ریال");
  });

  it("compacts billions", () => {
    expect(irr(3.2e9)).toContain("میلیارد ریال");
  });

  it("compacts millions", () => {
    expect(irr(5.5e6)).toContain("میلیون ریال");
  });

  it("prints small amounts in full", () => {
    expect(irr(1500)).toContain("ریال");
    expect(irr(1500)).not.toContain("میلیون");
  });

  it("handles a missing value", () => {
    expect(irr(null)).toBe("—");
  });
});

describe("tick", () => {
  it("labels millions", () => {
    expect(tick(2_000_000)).toBe("۲ میلیون");
    expect(tick(1_500_000)).toBe(`۱${DEC}۵ میلیون`);
  });

  it("groups thousands", () => {
    expect(tick(25_000)).toBe(`۲۵${TH}۰۰۰`);
  });

  it("never leaves a Latin dot below a thousand", () => {
    expect(tick(73.25)).toBe(`۷۳${DEC}۳`);   // toFixed rounds
    expect(tick(73.25)).not.toContain(".");
  });

  it("prints a small integer plainly", () => {
    expect(tick(12)).toBe("۱۲");
  });

  it("has an em dash for a non-number", () => {
    expect(tick(Number.NaN)).toBe("—");
  });
});

describe("place-name shortening", () => {
  it("drops the administrative prefix", () => {
    expect(shortPlace("روستای کوت نواصر")).toBe("کوت نواصر");
    expect(shortPlace("شهرستان اهواز")).toBe("اهواز");
    expect(shortPlace("دهستان باوی")).toBe("باوی");
  });

  it("leaves a name without a prefix alone", () => {
    expect(shortPlace("عین دو")).toBe("عین دو");
  });

  it("shortens counties and districts", () => {
    expect(shortCounty("شهرستان اهواز")).toBe("اهواز");
    expect(shortDistrict("بخش مرکزی")).toBe("مرکزی");
  });
});

describe("jalali", () => {
  it("knows a date it can be checked against", () => {
    // 2026-03-21 is 1 Farvardin 1405
    expect(toJalali(2026, 3, 21)).toEqual([1405, 1, 1]);
  });

  it("handles the leap-day boundary", () => {
    expect(toJalali(2024, 2, 29)).toEqual([1402, 12, 10]);
  });

  it("renders an ISO instant with Persian digits", () => {
    expect(jalaliFromIso("2026-03-21T09:00:00Z")).toBe("۱ فروردین ۱۴۰۵");
  });

  it("returns an em dash for junk", () => {
    expect(jalaliFromIso(null)).toBe("—");
    expect(jalaliFromIso("not a date")).toBe("—");
  });
});
