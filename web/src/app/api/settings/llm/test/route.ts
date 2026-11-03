/**
 * Prove the saved provider + key + model with one real, tiny chat call.
 *
 *   POST -> { ok, model, ms, reply } | { ok:false, status?, error, detail? }
 *
 * A wrong key fails here, not halfway through an ETL run. Never echoes the key.
 */
import { NextResponse } from "next/server";
import { apiErrorText, authHeaders, chatUrl, getLlm } from "@/lib/llm";

export async function POST() {
  const cfg = getLlm();
  if (!cfg.apiKey) {
    return NextResponse.json({ ok: false, error: "اول کلید را ذخیره کنید" }, { status: 400 });
  }
  if (!cfg.model) {
    return NextResponse.json({ ok: false, error: "اول مدل را انتخاب کنید" }, { status: 400 });
  }

  const started = Date.now();
  try {
    const r = await fetch(chatUrl(cfg.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(cfg.apiKey) },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 8,
        temperature: 0,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    const ms = Date.now() - started;
    if (!r.ok) {
      return NextResponse.json({
        ok: false,
        status: r.status,
        error:
          r.status === 401
            ? "کلید پذیرفته نشد (۴۰۱)"
            : r.status === 403
              ? "کلید اجازهٔ این مدل را ندارد (۴۰۳)"
              : r.status === 404
                ? "مدل یا مسیر پیدا نشد (۴۰۴) — شناسهٔ مدل و Base URL را بررسی کنید"
                : r.status === 429
                  ? "سهمیه یا محدودیت نرخ دروازه (۴۲۹)"
                  : `دروازه پاسخ ${r.status} داد`,
        detail: apiErrorText(text),
      });
    }
    const j = JSON.parse(text) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
      usage?: { total_tokens?: number };
    };
    const reply = (j.choices?.[0]?.message?.content ?? "").trim().slice(0, 80);
    return NextResponse.json({
      ok: true,
      model: j.model ?? cfg.model,
      ms,
      reply,
      tokens: j.usage?.total_tokens ?? null,
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: "درخواست به دروازه نرسید",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}
