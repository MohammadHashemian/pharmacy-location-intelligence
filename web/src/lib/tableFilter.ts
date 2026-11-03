/**
 * Per-column filters for the ranking table (`PlacesTable`).
 *
 * Kept out of the component so the range rules are unit-tested
 * (`tests/tableFilter.test.ts`) instead of only observed in a browser.
 *
 * Contract that matters:
 *   · a filter whose ends are empty filters nothing (an empty box is not «zero»)
 *   · either end may stand alone, so «≥ ۵٬۰۰۰» and «≤ ۲۰٬۰۰۰» both work
 *   · a crossed pair (از ۵۰٬۰۰۰ تا ۱۰٬۰۰۰) is a typo, not an empty list — it
 *     reads as the same interval instead of silently showing nothing
 *   · a row whose value is unknown (null) never passes a numeric range: the
 *     cell renders «—», and keeping it in a «۱۰–۵۰ هزار» result would be a lie
 */
export interface ColFilter {
  /** lower bound, exactly as typed (Persian or Latin digits) */
  min?: string;
  /** upper bound, exactly as typed */
  max?: string;
  /** substring match for text columns */
  q?: string;
  /** exact values picked from the value list; empty/missing = every value */
  pick?: string[];
}

export type FilterMap = Partial<Record<string, ColFilter>>;

const FA = "۰۱۲۳۴۵۶۷۸۹";
const AR = "٠١٢٣٤٥٦٧٨٩";
/** Latin comma, Arabic thousands separator ٬, spaces (incl. نیم‌فاصله). */
const GROUPING = /[,\u066C\s\u200c]/g;

/**
 * A number typed in either digit system, or null when the box is empty or
 * unreadable. `٬`/`,` are grouping separators and are dropped, so «۲٬۵۰۰» and
 * `2500` are the same bound.
 */
export function parseNum(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw
    .replace(/[۰-۹]/g, (d) => String(FA.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(AR.indexOf(d)))
    .replace(/\u066B/g, ".") // ٫ decimal separator
    .replace(GROUPING, "");
  if (!/[0-9]/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** True when this filter narrows anything at all. */
export function filterActive(f: ColFilter | undefined): boolean {
  if (!f) return false;
  return (
    parseNum(f.min) !== null ||
    parseNum(f.max) !== null ||
    Boolean(f.q?.trim()) ||
    (f.pick?.length ?? 0) > 0
  );
}

export interface Candidate {
  /** the row's value for a numeric column; null when unknown */
  num?: number | null;
  /** the row's value for a text column */
  text?: string | null;
}

/** Inclusive on both ends; an empty end is open. */
export function passes(f: ColFilter | undefined, c: Candidate): boolean {
  if (!f) return true;
  const lo = parseNum(f.min);
  const hi = parseNum(f.max);
  if (lo !== null || hi !== null) {
    const v = c.num;
    if (v === null || v === undefined || !Number.isFinite(v)) return false;
    const a = lo ?? Number.NEGATIVE_INFINITY;
    const b = hi ?? Number.POSITIVE_INFINITY;
    if (v < Math.min(a, b) || v > Math.max(a, b)) return false;
  }
  const q = f.q?.trim();
  if (q) {
    const t = c.text ?? "";
    if (!t.includes(q) && !t.replace(/^[^\s]+\s+/u, "").includes(q)) return false;
  }
  if (f.pick?.length && !f.pick.includes(c.text ?? "")) return false;
  return true;
}
