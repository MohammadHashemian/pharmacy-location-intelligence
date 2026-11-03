"use client";

/**
 * «ساخت / بازسازی گزارش» — the only interactive part of the report page.
 *
 * Rebuilding runs `etl/area_report.py` on the server (numbers from SQLite, then the written
 * analysis from the configured model), so the button reports progress instead of pretending
 * to be instant.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

export function ReportActions({ areaId, hasNarrative }: { areaId: number; hasNarrative: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"none" | "data" | "llm">("none");
  const [err, setErr] = useState("");

  const build = async (llm: boolean) => {
    setBusy(llm ? "llm" : "data");
    setErr("");
    try {
      const r = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area_id: areaId, llm }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "خطا");
      router.refresh();
    } catch (e) {
      setErr(String(e).replace("Error: ", ""));
    } finally {
      setBusy("none");
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => build(true)}
        disabled={busy !== "none"}
        className="rounded-lg border border-brand bg-brand-soft px-2.5 py-1 text-[11px] font-medium text-brand-ink disabled:opacity-50"
      >
        {busy === "llm" ? "در حال تحلیل…" : hasNarrative ? "بازسازی تحلیل" : "ساخت تحلیل با مدل"}
      </button>
      <button
        type="button"
        onClick={() => build(false)}
        disabled={busy !== "none"}
        className="rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] text-muted disabled:opacity-50"
      >
        {busy === "data" ? "…" : "فقط اعداد"}
      </button>
      {err ? <span className="text-[10.5px] text-danger">{err}</span> : null}
    </div>
  );
}
