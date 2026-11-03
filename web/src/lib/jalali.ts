/**
 * Jalali (Solar Hijri) date, plus the small formatting rules the dashboard needs.
 *
 * The whole UI renders Persian digits, so a bare Gregorian ISO string in the
 * header is the one visibly foreign element. Iranian users read Shamsi dates,
 * so the snapshot stamp is converted rather than transliterated.
 */

import { toPersianDigits as faDigits } from "@/lib/format";

const div = (a: number, b: number) => Math.trunc(a / b);

/**
 * Gregorian -> Jalali, using the standard Birashk-style arithmetic
 * (the same conversion `jalaali-js` implements). Accurate for 1900-2100.
 */
export function toJalali(
  gy: number,
  gm: number,
  gd: number,
): [number, number, number] {
  const g_d_m = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days =
    355666 +
    365 * gy +
    div(gy2 + 3, 4) -
    div(gy2 + 99, 100) +
    div(gy2 + 399, 400) +
    gd +
    g_d_m[gm - 1];
  let jy = -1595 + 33 * div(days, 12053);
  days %= 12053;
  jy += 4 * div(days, 1461);
  days %= 1461;
  if (days > 365) {
    jy += div(days - 1, 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + div(days, 31) : 7 + div(days - 186, 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

const MONTHS = [
  "فروردین",
  "اردیبهشت",
  "خرداد",
  "تیر",
  "مرداد",
  "شهریور",
  "مهر",
  "آبان",
  "آذر",
  "دی",
  "بهمن",
  "اسفند",
];

/**
 * Render an ISO-8601 instant as a Persian Shamsi date.
 * `2026-10-10T09:16:48Z` -> "۱۸ مهر ۱۴۰۵"
 */
export function jalaliFromIso(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // Shamsi days roll over at local midnight in Tehran, so convert in that zone.
  const tehran = new Date(d.getTime() + 3.5 * 3600 * 1000);
  const [jy, jm, jd] = toJalali(
    tehran.getUTCFullYear(),
    tehran.getUTCMonth() + 1,
    tehran.getUTCDate(),
  );
  return `${faDigits(jd)} ${MONTHS[jm - 1]} ${faDigits(jy)}`;
}
