/**
 * Persian-Latin formatting helpers.
 *
 * Convention for this UI: everything the user READS is Persian — Persian
 * digits, the Arabic thousands separator ٬ (U+066C) and the decimal separator
 * ٫ (U+066B). Latin digits are reserved for identifiers you would copy/paste
 * (file hashes, the /api paths) and for CSV export, which stays machine-readable.
 *
 * Mixing Latin and Persian numerals inside one table reads as sloppy, so the
 * display helpers below own that decision once, here.
 */

const LATIN = "0123456789";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";
const FA_THOUSANDS = "\u066C"; // ٬
const FA_DECIMAL = "\u066B"; // ٫

export function toPersianDigits(s: string | number): string {
  return String(s).replace(/[0-9]/g, (d) => PERSIAN[LATIN.indexOf(d)]);
}

/** Integer with thousands grouping, in Persian digits. */
export function group(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return toPersianDigits(Math.round(n).toLocaleString("en-US")).replace(
    /,/g,
    FA_THOUSANDS,
  );
}

/** Fixed-decimal number, Persian digits and Persian decimal separator. */
export function num(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return toPersianDigits(n.toFixed(digits)).replace(".", FA_DECIMAL);
}

/** Rial amounts, Persian digits, compacted for readability. */
export function irr(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e12) return `${num(n / 1e12, 2)} هزار میلیارد ریال`;
  if (a >= 1e9) return `${num(n / 1e9, 2)} میلیارد ریال`;
  if (a >= 1e6) return `${num(n / 1e6, 1)} میلیون ریال`;
  return `${group(n)} ریال`;
}

/** Compact axis tick label: ۲۰٬۰۰۰ · ۱ میلیون · ۷۳٫۵ — never a Latin '.' */
export function tick(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? toPersianDigits(m) : num(m, 1)} میلیون`;
  }
  if (n >= 1000) return group(n);
  // Axis values below 1000 can be fractional (histogram bin edges), and a bare
  // toPersianDigits() would leave the Latin '.' in place — ۷۳.۲۵ instead of ٫.
  return Number.isInteger(n) ? toPersianDigits(n) : num(n, 1);
}

/** Strip the descriptive Persian prefix so tables read as place names. */
export function shortPlace(place: string): string {
  return place.replace(
    /^(شهرستان|بخش|شهر|شهرک|روستای|روستاي|روستا|دهستان|ده|آبادی)\s+/u,
    "",
  );
}

export function shortCounty(county: string): string {
  return county.replace(/^شهرستان\s+/u, "");
}

export function shortDistrict(district: string): string {
  return district.replace(/^بخش\s+/u, "");
}
