"use client";

/**
 * Key entry form. The key is write-only: after saving, the page only ever shows
 * a masked tail, and «تست کلید» asks the server to call the provider, so a wrong
 * key fails here instead of silently at import time.
 */
import { useState } from "react";
import type { SettingStatus } from "@/lib/settings";

type TestResult = {
  ok: boolean;
  provider?: string;
  found?: number;
  sample?: { title: string; address: string }[];
  error?: string;
  detail?: string;
  status?: number;
};

export function SettingsForm({ initial }: { initial: SettingStatus[] }) {
  const [providers, setProviders] = useState(initial);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<Record<string, TestResult | undefined>>({});
  const [note, setNote] = useState<Record<string, string | undefined>>({});

  const post = async (url: string, body: unknown) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: r.ok, json: (await r.json()) as Record<string, unknown> };
  };

  const save = async (key: string) => {
    setBusy(key);
    setNote((n) => ({ ...n, [key]: undefined }));
    try {
      const { ok, json } = await post("/api/settings", {
        key,
        value: draft[key] ?? "",
      });
      if (ok && Array.isArray(json.providers)) {
        setProviders(json.providers as SettingStatus[]);
        setDraft((d) => ({ ...d, [key]: "" }));
        setNote((n) => ({ ...n, [key]: "ذخیره شد" }));
      } else {
        setNote((n) => ({ ...n, [key]: String(json.error ?? "ذخیره نشد") }));
      }
    } catch {
      setNote((n) => ({ ...n, [key]: "ارتباط با سرور برقرار نشد" }));
    } finally {
      setBusy(null);
    }
  };

  const clear = async (key: string) => {
    setBusy(key);
    try {
      const { ok, json } = await post("/api/settings", { key, value: "" });
      if (ok && Array.isArray(json.providers)) {
        setProviders(json.providers as SettingStatus[]);
        setTest((t) => ({ ...t, [key]: undefined }));
        setNote((n) => ({ ...n, [key]: "حذف شد" }));
      }
    } finally {
      setBusy(null);
    }
  };

  const runTest = async (key: string) => {
    setBusy(key);
    setTest((t) => ({ ...t, [key]: undefined }));
    try {
      const { json } = await post("/api/settings/test", { key });
      setTest((t) => ({ ...t, [key]: json as unknown as TestResult }));
    } catch {
      setTest((t) => ({
        ...t,
        [key]: { ok: false, error: "ارتباط با سرور برقرار نشد" },
      }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {providers.map((p) => {
        const t = test[p.key];
        const noteText = note[p.key];
        return (
          <div
            key={p.key}
            className="rounded-2xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.12)]"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-[14px] font-bold text-ink">{p.label}</h2>
                <p className="mt-0.5 text-[11px] leading-4 text-muted">{p.hint}</p>
              </div>
              <span
                className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                  p.configured
                    ? "border-good/25 bg-good-soft text-good"
                    : "border-line-strong bg-surface-2 text-muted"
                }`}
              >
                {p.configured ? "ذخیره‌شده" : "تنظیم‌نشده"}
              </span>
            </div>

            {p.configured ? (
              <div className="tnum mt-2 rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-[11px] text-ink-soft">
                <span className="text-faint">کلید ذخیره‌شده: </span>
                {p.masked}
                {p.updatedAt ? (
                  <span className="text-faint">
                    {" "}
                    · {p.updatedAt.slice(0, 16).replace("T", " ")}
                  </span>
                ) : null}
              </div>
            ) : null}

            <div className="mt-2 flex gap-1.5">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                value={draft[p.key] ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [p.key]: e.target.value }))
                }
                placeholder={p.configured ? "کلید جدید برای جایگزینی…" : "کلید را اینجا بچسبانید"}
                className="min-w-0 flex-1 rounded-lg border border-line-strong bg-surface-2 px-2 py-1.5 text-left text-[11.5px] text-ink placeholder:text-right placeholder:text-faint"
              />
              <button
                type="button"
                disabled={busy === p.key || !(draft[p.key] ?? "").trim()}
                onClick={() => save(p.key)}
                className="rounded-lg border border-brand bg-brand px-2.5 py-1.5 text-[11px] font-medium text-white disabled:opacity-40"
              >
                {busy === p.key ? "…" : "ذخیره"}
              </button>
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={busy === p.key || !p.configured}
                onClick={() => runTest(p.key)}
                className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[11px] text-ink-soft disabled:opacity-40"
              >
                تست کلید
              </button>
              <button
                type="button"
                disabled={busy === p.key || !p.configured}
                onClick={() => clear(p.key)}
                className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[11px] text-muted disabled:opacity-40"
              >
                حذف
              </button>
              <a
                href={p.docs}
                target="_blank"
                rel="noreferrer"
                className="text-[10.5px] text-accent hover:underline"
              >
                گرفتن کلید ↗
              </a>
              {noteText ? (
                <span className="text-[10.5px] text-brand-ink">{noteText}</span>
              ) : null}
            </div>

            {t ? (
              <div
                className={`mt-2 rounded-lg border px-2 py-1.5 text-[10.5px] leading-4 ${
                  t.ok
                    ? "border-good/25 bg-good-soft text-good"
                    : "border-danger/25 bg-danger-soft text-danger"
                }`}
              >
                {t.ok ? (
                  <>
                    کلید کار می‌کند · {t.provider} · {t.found} نتیجهٔ «داروخانه» در ۵
                    کیلومتری اهواز
                    {t.sample?.length ? (
                      <ul className="mt-1 space-y-0.5 text-ink-soft">
                        {t.sample.map((s, i) => (
                          <li key={i}>• {s.title}{s.address ? ` — ${s.address}` : ""}</li>
                        ))}
                      </ul>
                    ) : null}
                  </>
                ) : (
                  <>
                    {t.error ?? "تست ناموفق"}
                    {t.detail ? (
                      <div className="mt-0.5 text-[9.5px] text-muted">{t.detail}</div>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
