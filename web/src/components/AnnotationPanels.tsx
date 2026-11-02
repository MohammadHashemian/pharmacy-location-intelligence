"use client";

/**
 * The two user-owned lists: places to go and look at, and areas already looked at.
 *
 * Both are scoped to the signed-in user's id (one seeded owner until auth exists), so the
 * work survives a reload and will survive multiple accounts when they arrive.
 */
import type { Prospect, SurveyArea } from "@/lib/map";
import { group, num } from "@/lib/format";

const STATUS: { id: Prospect["status"]; label: string; tone: string }[] = [
  { id: "todo", label: "برای بازدید", tone: "bg-warn-soft text-warn" },
  { id: "visited", label: "بازدید شد", tone: "bg-good-soft text-good" },
  { id: "rejected", label: "رد شد", tone: "bg-surface-2 text-muted" },
];

function nextStatus(s: Prospect["status"]): Prospect["status"] {
  return s === "todo" ? "visited" : s === "visited" ? "rejected" : "todo";
}

export function VisitPanel({
  items,
  onFocus,
  onCycle,
  onRemove,
}: {
  items: Prospect[];
  onFocus: (p: Prospect) => void;
  onCycle: (p: Prospect) => void;
  onRemove: (p: Prospect) => void;
}) {
  const todo = items.filter((p) => p.status === "todo").length;
  return (
    <div className="rounded-2xl border border-line bg-surface p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ink">فهرست بازدید</span>
        <span className="tnum text-[10px] text-faint">
          {group(items.length)} مکان · {group(todo)} در انتظار
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-[10.5px] leading-5 text-muted">
          روی نقشه جایی را که باید ببینید «نشان‌گذاری» کنید تا این فهرست پر شود؛ با هر کلیک
          وضعیتش را عوض کنید.
        </p>
      ) : (
        <ul className="max-h-52 space-y-1 overflow-auto">
          {items.map((p) => {
            const st = STATUS.find((s) => s.id === p.status)!;
            return (
              <li
                key={p.id}
                className="flex items-center gap-1 rounded-lg border border-line/70 px-1.5 py-1"
              >
                <span className="tnum w-4 shrink-0 text-[9px] text-faint">{p.priority}</span>
                <button
                  type="button"
                  onClick={() => onFocus(p)}
                  className="min-w-0 flex-1 text-right"
                  title="نمایش روی نقشه"
                >
                  <span className="block truncate text-[10.5px] font-medium text-ink">
                    {p.name}
                  </span>
                  {p.note ? (
                    <span className="block truncate text-[9px] text-faint">{p.note}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={() => onCycle(p)}
                  className={`shrink-0 rounded px-1 py-0.5 text-[9px] ${st.tone}`}
                  title="تغییر وضعیت"
                >
                  {st.label}
                </button>
                <button
                  type="button"
                  data-del={`prospect-${p.id}`}
                  onClick={() => onRemove(p)}
                  className="shrink-0 rounded border border-line-strong px-1 text-[9px] text-danger"
                  title="حذف"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function SurveyPanel({
  items,
  onFocus,
  onRemove,
}: {
  items: SurveyArea[];
  onFocus: (a: SurveyArea) => void;
  onRemove: (a: SurveyArea) => void;
}) {
  const totalKm2 = items.reduce((s, a) => s + (a.areaKm2 ?? 0), 0);
  return (
    <div className="rounded-2xl border border-line bg-surface p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ink">محدوده‌های بررسی‌شده</span>
        <span className="tnum text-[10px] text-faint">
          {group(items.length)} محدوده · {num(totalKm2, 1)} کم²
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-[10.5px] leading-5 text-muted">
          با «کشیدن محدوده» دور محله‌ای که قبلاً گشته‌اید خط بکشید؛ دفعهٔ بعد می‌بینید کجا
          را هنوز ندیده‌اید.
        </p>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-auto">
          {items.map((a) => (
            <li key={a.id} className="flex items-center gap-1 rounded-lg border border-line/70 px-1.5 py-1">
              <button
                type="button"
                onClick={() => onFocus(a)}
                className="min-w-0 flex-1 text-right text-[10.5px] text-ink hover:text-brand-ink"
                title="نمایش روی نقشه"
              >
                <span className="block truncate">{a.name}</span>
              </button>
              <span className="tnum shrink-0 text-[9px] text-faint">
                {num(a.areaKm2 ?? 0, 1)} کم²
              </span>
              <button
                type="button"
                data-del={`survey-${a.id}`}
                onClick={() => onRemove(a)}
                className="shrink-0 rounded border border-line-strong px-1 text-[9px] text-danger"
                title="حذف"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export { nextStatus };
