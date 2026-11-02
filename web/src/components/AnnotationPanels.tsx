"use client";

/**
 * The two user-owned lists: places to go and look at, and areas already looked at.
 *
 * Both are scoped to the signed-in user's id (one seeded owner until auth exists), so the
 * work survives a reload and will survive multiple accounts when they arrive.
 */
import { useState } from "react";
import type { Measurement, Prospect, SurveyArea } from "@/lib/map";
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
  onPriority,
}: {
  items: Prospect[];
  onFocus: (p: Prospect) => void;
  onCycle: (p: Prospect) => void;
  onRemove: (p: Prospect) => void;
  /** reorder the trip: priority is 1-9 and the list has no size limit */
  onPriority: (p: Prospect, next: number) => void;
}) {
  const [filter, setFilter] = useState<"all" | Prospect["status"]>("all");
  const [q, setQ] = useState("");

  const todo = items.filter((p) => p.status === "todo").length;
  const shown = items
    .filter((p) => (filter === "all" ? true : p.status === filter))
    .filter((p) => (q.trim() ? (p.name + " " + (p.note ?? "")).includes(q.trim()) : true));

  return (
    <div data-panel="visit" className="rounded-2xl border border-line bg-surface p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ink">فهرست بازدید</span>
        <span className="tnum text-[10px] text-faint">
          {group(items.length)} مکان · {group(todo)} در انتظار
        </span>
      </div>

      {items.length ? (
        <>
          <div className="mb-1 flex flex-wrap items-center gap-1">
            {(
              [
                ["all", `همه ${group(items.length)}`],
                ["todo", `در انتظار ${group(todo)}`],
                ["visited", "بازدید‌شده"],
                ["rejected", "رد‌شده"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id as typeof filter)}
                className={`rounded-md border px-1.5 py-0.5 text-[9.5px] ${
                  filter === id
                    ? "border-accent/40 bg-accent-soft text-accent"
                    : "border-line-strong bg-surface text-muted"
                }`}
              >
                {label}
              </button>
            ))}
            {items.length > 6 ? (
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="جستجو در فهرست…"
                className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 text-[9.5px] text-ink placeholder:text-faint"
              />
            ) : null}
          </div>

          <ul className="max-h-72 space-y-1 overflow-auto">
            {shown.map((p) => {
              const st = STATUS.find((s) => s.id === p.status)!;
              return (
                <li
                  key={p.id}
                  className="flex items-center gap-1 rounded-lg border border-line/70 px-1.5 py-1"
                >
                  <button
                    type="button"
                    onClick={() => onPriority(p, p.priority >= 9 ? 1 : p.priority + 1)}
                    title="اولویت سفر را عوض کنید (۱ تا ۹)"
                    className="tnum w-4 shrink-0 rounded text-[9px] text-faint hover:bg-surface-2 hover:text-ink"
                  >
                    {p.priority}
                  </button>
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
            {!shown.length ? (
              <li className="py-2 text-center text-[10px] text-faint">چیزی در این فیلتر نیست</li>
            ) : null}
          </ul>
        </>
      ) : (
        <p className="text-[10.5px] leading-5 text-muted">
          روی نقشه جایی را که باید ببینید «نشان‌گذاری» کنید تا این فهرست پر شود؛ تعدادش محدود
          نیست و با اولویت ۱ تا ۹ مرتب می‌شود.
        </p>
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
    <div data-panel="survey" className="rounded-2xl border border-line bg-surface p-2.5">
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


/**
 * Saved measurements, side by side — «کوی منتظری» against «کوت نواصر».
 *
 * The comparison is the point: an area number on its own says nothing about whether a
 * pharmacy belongs there, but the same measure on two neighbourhoods does.
 */
export function MeasurePanel({
  items,
  onFocus,
  onRemove,
}: {
  items: Measurement[];
  onFocus: (m: Measurement) => void;
  onRemove: (m: Measurement) => void;
}) {
  if (!items.length) {
    return (
      <div className="rounded-2xl border border-line bg-surface p-2.5">
        <div className="text-[12px] font-semibold text-ink">مقایسهٔ مساحت‌ها</div>
        <p className="mt-1 text-[10.5px] leading-5 text-muted">
          با «اندازه‌گیری» دور یک محله خط بکشید تا مساحت، سطح مسکونی و جمعیت تخمینی‌اش را
          ببینید؛ دو تا را که ذخیره کنید، کنار هم مقایسه می‌شوند.
        </p>
      </div>
    );
  }

  const maxPop = Math.max(...items.map((m) => m.population), 1);

  return (
    <div className="rounded-2xl border border-line bg-surface p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-ink">مقایسهٔ مساحت‌ها</span>
        <span className="tnum text-[10px] text-faint">{group(items.length)} محدوده</span>
      </div>
      <div className="overflow-auto">
        <table className="w-full border-collapse text-[10px]">
          <thead>
            <tr>
              <th className="w-16 px-1 py-1 text-right font-medium text-faint">معیار</th>
              {items.map((m) => (
                <th key={m.id} className="px-1 py-1 text-left font-medium text-ink">
                  <button
                    type="button"
                    onClick={() => onFocus(m)}
                    className="w-full text-right hover:text-brand-ink"
                    title="نمایش روی نقشه"
                  >
                    <span className="block truncate">{m.name}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["مساحت", (m: Measurement) => num(m.areaKm2, 2), "km²"],
                ["مسکونی", (m: Measurement) => num(m.residentialKm2, 2), "km²"],
                ["جمعیت", (m: Measurement) => group(m.population), ""],
                ["تراکم", (m: Measurement) => group(m.density), "/km²"],
                ["داروخانه", (m: Measurement) => group(m.pharmacies), ""],
              ] as const
            ).map(([label, f, unit]) => (
              <tr key={label} className="border-t border-line/60">
                <td className="px-1 py-0.5 text-faint">{label}</td>
                {items.map((m) => (
                  <td key={m.id} className="tnum px-1 py-0.5 text-left text-ink-soft">
                    {f(m)}
                    {unit ? <span className="text-[8px] text-faint"> {unit}</span> : null}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t border-line/60">
              <td className="px-1 py-0.5 text-faint">سهم جمعیت</td>
              {items.map((m) => (
                <td key={m.id} className="px-1 py-0.5">
                  <span className="block h-1.5 rounded-full bg-brand/70"
                        style={{ width: `${Math.round((m.population / maxPop) * 100)}%` }} />
                </td>
              ))}
            </tr>
            <tr className="border-t border-line/60">
              <td className="px-1 py-0.5" />
              {items.map((m) => (
                <td key={m.id} className="px-1 py-0.5 text-left">
                  <button
                    type="button"
                    data-del={`measure-${m.id}`}
                    onClick={() => onRemove(m)}
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
