"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PlaceMetrics } from "@/lib/analytics";
import { group } from "@/lib/format";

type Field = "population" | "n_pharmacy_real" | "n_pharmacy_legal";

/**
 * Inline editor for one numeric field of one place.
 *
 * The user is the authority: they may hold a census page, a yearbook table or
 * field knowledge the sources lack. Saving writes to `manual_override` through
 * /api/overrides — it never touches the source value, so clearing the override
 * restores exactly what the source said, and the journal keeps the history.
 *
 * Async states are explicit (idle/saving/saved/error) because a silent failure
 * here would leave the user believing a correction was recorded when it was not.
 */
export function EditableField({
  place,
  field,
  label,
  value,
  sourceValue,
  hint,
}: {
  place: PlaceMetrics;
  field: Field;
  label: string;
  /** The value currently in force (after overrides/mode). */
  value: number | null;
  /** What the source said, for comparison. */
  sourceValue: number | null;
  hint?: string;
}) {
  const router = useRouter();
  const manual =
    field === "population"
      ? place.manual_population
      : field === "n_pharmacy_real"
        ? place.manual_pharmacy_real
        : place.manual_pharmacy_legal;

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string>(
    manual != null ? String(manual) : "",
  );
  const [note, setNote] = useState<string>(place.manual_note ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  async function send(payloadValue: number | null) {
    setState("saving");
    setError(null);
    try {
      const res = await fetch("/api/overrides", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          location_id: place.location_id,
          field,
          value: payloadValue,
          note: note.trim() || null,
          author: "کاربر",
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setState("saved");
      setOpen(false);
      router.refresh();
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : "خطای نامشخص");
    }
  }

  const differs =
    manual != null && sourceValue != null && manual !== sourceValue;

  return (
    <div className="border-b border-line/70 py-1.5 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11.5px] text-muted" title={hint}>
          {label}
          {manual != null ? (
            <span className="ms-1 text-[10px] text-warn">✎ دستی</span>
          ) : null}
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="tnum text-[12.5px] font-medium text-ink">
            {group(value)}
          </span>
          <button
            type="button"
            onClick={() => {
              setDraft(
                manual != null ? String(manual) : String(sourceValue ?? ""),
              );
              setOpen((o) => !o);
              setState("idle");
            }}
            title="ویرایش دستی این مقدار"
            className="rounded border border-line-strong px-1 text-[10px] text-muted transition hover:border-brand hover:text-brand-ink"
          >
            ✎
          </button>
        </span>
      </div>

      {differs ? (
        <div className="mt-0.5 text-[10.5px] text-faint">
          مقدار منبع: <span className="tnum">{group(sourceValue)}</span>
        </div>
      ) : null}

      {open ? (
        <div className="mt-1.5 space-y-1.5 rounded-lg border border-line bg-surface-2 p-2">
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={0}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="مقدار جدید"
              className="tnum w-28 rounded border border-line-strong bg-surface px-2 py-1 text-[12px] outline-none focus:border-brand"
            />
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="منبع/دلیل (مثلاً: سرشماری ۱۳۹۵ صفحه ۲۲)"
              className="min-w-0 flex-1 rounded border border-line-strong bg-surface px-2 py-1 text-[11.5px] outline-none focus:border-brand"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={state === "saving" || draft.trim() === ""}
              onClick={() => {
                const n = Number(draft);
                if (Number.isFinite(n) && n >= 0) void send(n);
                else setError("عدد نامعتبر");
              }}
              className="rounded-lg border border-brand/40 bg-brand-soft px-2.5 py-1 text-[11.5px] font-medium text-brand-ink transition hover:border-brand disabled:opacity-50"
            >
              {state === "saving" ? "در حال ذخیره…" : "ذخیره"}
            </button>
            {manual != null ? (
              <button
                type="button"
                disabled={state === "saving"}
                onClick={() => void send(null)}
                className="rounded-lg border border-line-strong px-2.5 py-1 text-[11.5px] text-muted transition hover:border-danger hover:text-danger disabled:opacity-50"
              >
                حذف ویرایش (بازگشت به مقدار منبع)
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg px-2 py-1 text-[11.5px] text-faint hover:text-ink"
            >
              بستن
            </button>
            {state === "saved" ? (
              <span className="text-[11px] text-brand-ink">ذخیره شد ✓</span>
            ) : null}
          </div>
          {error ? (
            <div className="text-[11px] text-danger">خطا: {error}</div>
          ) : null}
          <p className="text-[10.5px] leading-4 text-faint">
            مقدار منبع هرگز بازنویسی نمی‌شود؛ ویرایش شما جداگانه ذخیره و در
            تاریخچه ثبت می‌شود. در حالت «دست‌ساز» اعمال می‌شود.
          </p>
        </div>
      ) : null}
    </div>
  );
}
