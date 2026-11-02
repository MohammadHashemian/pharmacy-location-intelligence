"use client";

/**
 * The short list: the two to five places you are actually choosing between, side by side.
 *
 * The numbers are the ones saved with each row, not today's ranking — a comparison that
 * silently re-scores itself would put two different models in the same table. The header
 * says when the snapshot was taken, so a stale comparison is visible rather than assumed.
 */
import type { ShortlistItem } from "@/lib/map";
import { group, num } from "@/lib/format";

const ROWS: { key: keyof ShortlistItem; label: string; fmt: (v: number) => string }[] = [
  { key: "score", label: "امتیاز", fmt: (v) => num(v, 2) },
  { key: "demand", label: "جمعیت ۱٫۲ کم", fmt: (v) => group(Math.round(v)) },
  { key: "supplyMapped", label: "داروخانه", fmt: (v) => num(v, 1) },
  { key: "anchors", label: "درمانگر", fmt: (v) => num(v, 1) },
  { key: "gap", label: "نفر/داروخانه", fmt: (v) => group(Math.round(v)) },
  { key: "roadKm", label: "فاصله از اهواز", fmt: (v) => num(v, 0) },
];

export function ShortlistPanel({
  items,
  onRemove,
  onFocus,
}: {
  items: ShortlistItem[];
  onRemove: (id: number) => void;
  onFocus: (item: ShortlistItem) => void;
}) {
  if (!items.length) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-3">
        <div className="text-[12px] font-semibold text-ink">فهرست کوتاه</div>
        <p className="mt-1 text-[10.5px] leading-5 text-muted">
          روی یک پیشنهاد کلیک کنید و «افزودن به فهرست» را بزنید تا دو تا پنج گزینه را
          کنار هم مقایسه کنید. عددها در همان لحظه ثبت می‌شوند.
        </p>
      </div>
    );
  }

  const newest = items[0]?.snapshotAt?.slice(0, 10) ?? "";

  return (
    <div data-panel="shortlist" className="rounded-2xl border border-line bg-surface p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ink">
          فهرست کوتاه · {group(items.length)}
        </span>
        <span className="text-[9.5px] text-faint">ثبت: {newest}</span>
      </div>

      <div className="overflow-auto">
        <table className="w-full border-collapse text-[10px]">
          <thead>
            <tr>
              <th className="w-16 px-1 py-1 text-right font-medium text-faint">معیار</th>
              {items.map((it) => (
                <th key={it.id} className="px-1 py-1 text-left font-medium text-ink">
                  <button
                    type="button"
                    onClick={() => onFocus(it)}
                    className="w-full text-right hover:text-brand-ink"
                    title="نمایش روی نقشه"
                  >
                    <span className="block truncate">{it.settlement ?? "بلوک"}</span>
                    <span className="tnum block text-[9px] font-normal text-faint">
                      #{it.rank}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.key} className="border-t border-line/60">
                <td className="px-1 py-0.5 text-faint">{r.label}</td>
                {items.map((it) => (
                  <td key={it.id} className="tnum px-1 py-0.5 text-left text-ink-soft">
                    {r.fmt(it[r.key] as number)}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t border-line/60">
              <td className="px-1 py-0.5" />
              {items.map((it) => (
                <td key={it.id} className="px-1 py-0.5 text-left">
                  <button
                    type="button"
                    onClick={() => onRemove(it.id)}
                    className="rounded border border-line-strong px-1 text-[9px] text-danger hover:border-danger"
                  >
                    حذف
                  </button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
