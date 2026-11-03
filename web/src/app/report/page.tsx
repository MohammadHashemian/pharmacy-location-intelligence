"use client";

/**
 * «تحلیل هر منطقه» — pick a town, run the analysis, land on its report.
 *
 * The report page can build a missing analysis, but you had to know its area id first. This
 * page turns the capability into a feature: search, choose, run.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Row = { area_id: number; name: string; county: string; kind: string; population: number };

const FA = "۰۱۲۳۴۵۶۷۸۹";
const pd = (v: number | string) => String(v).replace(/[0-9]/g, (d) => FA[Number(d)]);

export default function ReportIndexPage() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (q.trim().length < 2) {
      setRows([]);
      return;
    }
    const t = setTimeout(() => {
      fetch(`/api/settlements?q=${encodeURIComponent(q.trim())}`)
        .then((r) => r.json())
        .then((d) => setRows(d.items ?? []))
        .catch(() => setRows([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const run = async (row: Row) => {
    setBusy(row.area_id);
    setErr("");
    try {
      const r = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area_id: row.area_id, llm: false }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "خطا");
      router.push(`/report/${row.area_id}`);
    } catch (e) {
      setErr(String(e).replace("Error: ", ""));
      setBusy(null);
    }
  };

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <div className="rounded-2xl border border-line bg-linear-to-l from-brand/[0.10] via-accent/[0.07] to-transparent px-3 py-2.5">
        <h1 className="text-[17px] font-extrabold text-ink">تحلیل یک منطقه</h1>
        <p className="mt-1 text-[11.5px] leading-5 text-muted">
          نام شهر یا آبادی را بنویس؛ اعداد از پایگاه داده محاسبه می‌شوند (جمعیت، عرضه، مراکز
          درمانی، خیابان‌ها، تقاضای بدون پوشش) و بعد متن تحلیلی روی همان اعداد نوشته می‌شود.
        </p>
      </div>

      <div className="mt-3">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="نام شهر، آبادی یا شهرستان… مثلاً کوت عبدالله"
          className="w-full rounded-xl border border-line-strong bg-surface px-3 py-2 text-[12.5px] text-ink placeholder:text-faint"
        />
      </div>

      {err ? <p className="mt-2 text-[11px] text-danger">{err}</p> : null}

      <ul className="mt-3 space-y-1">
        {rows.map((r) => (
          <li
            key={r.area_id}
            className="flex items-center justify-between gap-2 rounded-xl border border-line bg-surface px-2.5 py-1.5"
          >
            <div className="min-w-0">
              <div className="truncate text-[12px] font-medium text-ink">
                {r.name}
                <span className="ms-1.5 text-[10px] font-normal text-faint">
                  {r.kind === "city" ? "شهر" : "آبادی"} · {r.county}
                </span>
              </div>
              <div className="text-[10px] text-muted">{pd(r.population?.toLocaleString("en-US") ?? "0")} نفر</div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Link
                href={`/report/${r.area_id}`}
                className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[10.5px] text-muted"
              >
                گزارش موجود
              </Link>
              <button
                type="button"
                onClick={() => run(r)}
                disabled={busy !== null}
                className="rounded-lg border border-brand bg-brand-soft px-2.5 py-1 text-[10.5px] font-medium text-brand-ink disabled:opacity-50"
              >
                {busy === r.area_id ? "در حال ساخت…" : "تحلیل کن"}
              </button>
            </div>
          </li>
        ))}
        {q.trim().length >= 2 && !rows.length ? (
          <li className="py-3 text-center text-[11px] text-faint">چیزی پیدا نشد</li>
        ) : null}
      </ul>

      <div className="mt-4 text-[11px] text-muted">
        <Link href="/map" className="text-brand-ink underline">بازگشت به نقشه</Link>
      </div>
    </main>
  );
}
