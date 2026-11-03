/**
 * The model catalogue of whatever gateway is configured — so the user picks a
 * model id instead of typing one from memory (a typo costs a failed run).
 *
 *   GET -> { ok, count, models: string[] }
 *
 * The saved base URL decides the host; the key is optional because OpenRouter's
 * catalogue is public. Never returns the key.
 */
import { NextResponse } from "next/server";
import { apiErrorText, authHeaders, getLlm, modelsUrl } from "@/lib/llm";

export async function GET() {
  const cfg = getLlm();
  if (!cfg.baseUrl) {
    return NextResponse.json({ ok: false, error: "ابتدا ارائه‌دهنده و Base URL را ذخیره کنید" }, { status: 400 });
  }
  try {
    const r = await fetch(modelsUrl(cfg.baseUrl), {
      headers: { Accept: "application/json", ...authHeaders(cfg.apiKey) },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    if (!r.ok) {
      return NextResponse.json({
        ok: false,
        status: r.status,
        error:
          r.status === 401 || r.status === 403
            ? "کلید برای گرفتن فهرست مدل‌ها پذیرفته نشد"
            : `دروازه پاسخ ${r.status} داد`,
        detail: apiErrorText(text),
      });
    }
    let ids: string[] = [];
    try {
      const j = JSON.parse(text) as
        | { data?: ({ id?: string } | string)[]; models?: ({ id?: string } | string)[] }
        | string[];
      const rows = Array.isArray(j) ? j : (j.data ?? j.models ?? []);
      ids = rows
        .map((m) => (typeof m === "string" ? m : m?.id ?? ""))
        .filter(Boolean);
    } catch {
      return NextResponse.json({
        ok: false,
        error: "پاسخ دروازه فهرست مدل نیست",
        detail: text.slice(0, 300),
      });
    }
    ids.sort();
    return NextResponse.json({ ok: true, count: ids.length, models: ids.slice(0, 400) });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: "درخواست به دروازه نرسید",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}
