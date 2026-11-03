"use client";

/**
 * The language-model panel: pick a provider first, then (optionally) pull its
 * model catalogue, then the key. One «ذخیره» writes provider + base URL + model
 * (and the key, only when a new one was typed) so the four values can never drift
 * out of sync. The saved key is shown as a masked tail and never comes back from
 * the server in full.
 */
import { useState } from "react";
import type { LlmStatus } from "@/lib/llm";

type Probe = {
  ok: boolean;
  model?: string;
  ms?: number;
  reply?: string;
  tokens?: number | null;
  error?: string;
  detail?: string;
  status?: number;
};

export function LlmSettings({ initial }: { initial: LlmStatus }) {
  const [status, setStatus] = useState(initial);
  const [provider, setProvider] = useState(initial.provider);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [model, setModel] = useState(initial.model);
  const [key, setKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "save" | "models" | "test" | "clear">("");
  const [note, setNote] = useState("");
  const [probe, setProbe] = useState<Probe | null>(null);

  const preset = status.presets.find((p) => p.id === provider) ?? status.presets[0];

  const post = async (url: string, body: unknown) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: r.ok, json: (await r.json()) as Record<string, unknown> };
  };

  const pick = (id: string) => {
    setProvider(id);
    const p = status.presets.find((x) => x.id === id);
    if (p?.baseUrl) setBaseUrl(p.baseUrl);
    setNote("");
    setProbe(null);
  };

  const save = async () => {
    setBusy("save");
    setNote("");
    setProbe(null);
    try {
      const { ok, json } = await post("/api/settings/llm", {
        provider,
        baseUrl,
        model,
        apiKey: key.trim() ? key : undefined,
      });
      if (ok && json.status) {
        setStatus(json.status as LlmStatus);
        setKey("");
        setNote("ذخیره شد");
      } else {
        setNote(String(json.error ?? "ذخیره نشد"));
      }
    } catch {
      setNote("ارتباط با سرور برقرار نشد");
    } finally {
      setBusy("");
    }
  };

  const clearKey = async () => {
    setBusy("clear");
    setNote("");
    try {
      const { ok, json } = await post("/api/settings/llm", { provider, baseUrl, model, clearKey: true });
      if (ok && json.status) {
        setStatus(json.status as LlmStatus);
        setKey("");
        setNote("کلید حذف شد");
      } else {
        setNote(String(json.error ?? "حذف نشد"));
      }
    } catch {
      setNote("ارتباط با سرور برقرار نشد");
    } finally {
      setBusy("");
    }
  };

  const listModels = async () => {
    setBusy("models");
    setNote("");
    try {
      const r = await fetch("/api/settings/llm/models");
      const json = (await r.json()) as { ok?: boolean; models?: string[]; count?: number; error?: string; detail?: string };
      if (json.ok && json.models) {
        setModels(json.models);
        setNote(`${json.count} مدل پیدا شد — از فهرست انتخاب کنید`);
      } else {
        setNote([json.error, json.detail].filter(Boolean).join(" — ") || "فهرست گرفته نشد");
      }
    } catch {
      setNote("ارتباط با سرور برقرار نشد");
    } finally {
      setBusy("");
    }
  };

  const runTest = async () => {
    setBusy("test");
    setProbe(null);
    try {
      const { json } = await post("/api/settings/llm/test", {});
      setProbe(json as unknown as Probe);
    } catch {
      setProbe({ ok: false, error: "ارتباط با سرور برقرار نشد" });
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="rounded-2xl border border-line bg-surface p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.12)]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-[14px] font-bold text-ink">مدل زبانی (LLM) — ارائه‌دهنده، مدل و کلید</h2>
          <p className="mt-0.5 max-w-2xl text-[11px] leading-4 text-muted">
            اول ارائه‌دهنده را انتخاب کنید؛ هر دروازه‌ای که با OpenAI سازگار باشد پذیرفته است
            (OpenRouter، OpenAI، 9Router یا نشانی سفارشی). سپس مدل را از فهرست خودِ دروازه
            بردارید و کلید را بگذارید.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
            status.configured
              ? "border-good/25 bg-good-soft text-good"
              : "border-line-strong bg-surface-2 text-muted"
          }`}
        >
          {status.configured ? "آماده" : "تنظیم‌نشده"}
        </span>
      </div>

      <div className="mt-3 space-y-2.5">
        <div>
          <div className="text-[10.5px] font-medium text-faint">۱. ارائه‌دهنده</div>
          <div className="mt-1 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
            {status.presets.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={provider === p.id}
                onClick={() => pick(p.id)}
                className={`rounded-lg border px-2 py-1.5 text-right text-[11.5px] transition ${
                  provider === p.id
                    ? "border-brand bg-brand-soft font-semibold text-brand-ink"
                    : "border-line-strong bg-surface-2 text-ink-soft hover:border-brand/50"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10.5px] leading-4 text-muted">{preset.hint}</p>
        </div>

        <div>
          <label className="block text-[10.5px] font-medium text-faint" htmlFor="llm-base">
            ۲. Base URL (سازگار با OpenAI)
          </label>
          <input
            id="llm-base"
            type="url"
            dir="ltr"
            spellCheck={false}
            autoComplete="off"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.example.com/v1"
            className="mt-1 w-full rounded-lg border border-line-strong bg-surface-2 px-2 py-1.5 text-left text-[11.5px] text-ink placeholder:text-right placeholder:text-faint"
          />
          {preset.modelsUrl ? (
            <a
              href={preset.modelsUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-[10.5px] text-accent hover:underline"
            >
              فهرست مدل‌های {preset.label} ↗
            </a>
          ) : null}
        </div>

        <div>
          <label className="block text-[10.5px] font-medium text-faint" htmlFor="llm-model">
            ۳. مدل
          </label>
          <div className="mt-1 flex gap-1.5">
            <input
              id="llm-model"
              list="llm-models"
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={preset.modelHint}
              className="min-w-0 flex-1 rounded-lg border border-line-strong bg-surface-2 px-2 py-1.5 text-left text-[11.5px] text-ink placeholder:text-right placeholder:text-faint"
            />
            <button
              type="button"
              disabled={busy !== ""}
              onClick={listModels}
              className="shrink-0 rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-[11px] text-ink-soft disabled:opacity-40"
            >
              {busy === "models" ? "…" : "فهرست مدل‌ها"}
            </button>
          </div>
          <datalist id="llm-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p className="mt-1 text-[10.5px] leading-4 text-muted">
            شناسهٔ مدل را از خود دروازه می‌گیرد و هر دروازه نام‌گذاری خودش را دارد (مثلاً{" "}
            <bdi dir="ltr" className="tnum">
              {preset.id === "openrouter" ? "vendor/model" : preset.modelHint}
            </bdi>
            ). «فهرست مدل‌ها» از تنظیمات <b>ذخیره‌شده</b> می‌خواند.
          </p>
        </div>

        <div>
          <label className="block text-[10.5px] font-medium text-faint" htmlFor="llm-key">
            ۴. کلید
          </label>
          <input
            id="llm-key"
            type="password"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={status.keyMasked ? "کلید جدید برای جایگزینی…" : "کلید دروازه را اینجا بچسبانید"}
            className="mt-1 w-full rounded-lg border border-line-strong bg-surface-2 px-2 py-1.5 text-left text-[11.5px] text-ink placeholder:text-right placeholder:text-faint"
          />
          {status.keyMasked ? (
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[10.5px] text-muted">
              <span>کلید ذخیره‌شده:</span>
              <bdi dir="ltr" className="tnum text-ink-soft">
                {status.keyMasked}
              </bdi>
              {status.keySource === "legacy" ? <span>· از تنظیمات قدیمی OpenRouter</span> : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={busy !== ""}
          onClick={save}
          className="rounded-lg border border-brand bg-brand px-2.5 py-1.5 text-[11px] font-medium text-white disabled:opacity-40"
        >
          {busy === "save" ? "…" : "ذخیره"}
        </button>
        <button
          type="button"
          disabled={busy !== "" || !status.configured}
          onClick={runTest}
          className="rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-[11px] text-ink-soft disabled:opacity-40"
        >
          {busy === "test" ? "…" : "تست اتصال و مدل"}
        </button>
        <button
          type="button"
          disabled={busy !== "" || !status.keyMasked}
          onClick={clearKey}
          className="rounded-lg border border-line-strong bg-surface px-2 py-1.5 text-[11px] text-muted disabled:opacity-40"
        >
          حذف کلید
        </button>
        {note ? <span className="text-[10.5px] text-brand-ink">{note}</span> : null}
      </div>

      {probe ? (
        <div
          className={`mt-2 rounded-lg border px-2 py-1.5 text-[10.5px] leading-4 ${
            probe.ok
              ? "border-good/25 bg-good-soft text-good"
              : "border-danger/25 bg-danger-soft text-danger"
          }`}
        >
          {probe.ok ? (
            <>
              کلید و مدل کار می‌کنند · <bdi dir="ltr">{probe.model}</bdi> · {probe.ms}ms
              {probe.tokens ? ` · ${probe.tokens} توکن` : ""}
              {probe.reply ? ` · پاسخ: «${probe.reply}»` : ""}
            </>
          ) : (
            <>
              {probe.error ?? "تست ناموفق"}
              {probe.detail ? <div className="mt-0.5 text-[9.5px] text-muted">{probe.detail}</div> : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
