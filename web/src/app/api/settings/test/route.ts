/**
 * Live key check: calls the provider from the SERVER with the stored key and
 * reports what came back. This is the difference between "a string is saved" and
 * "the key works" — and it never exposes the key to the browser.
 *
 *   POST { key: "neshan_api_key" | "google_places_key" }
 */
import { NextResponse } from "next/server";
import { getKey, isProviderKey } from "@/lib/settings";

const AHVAZ = { lat: 31.3189, lon: 48.6842 };

export async function POST(req: Request) {
  let body: { key?: unknown };
  try {
    body = (await req.json()) as { key?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const key = String(body.key ?? "");
  if (!isProviderKey(key)) {
    return NextResponse.json({ error: "unknown key" }, { status: 400 });
  }
  const value = getKey(key);
  if (!value) {
    return NextResponse.json({ error: "کلیدی ذخیره نشده است" }, { status: 400 });
  }

  const timeout = AbortSignal.timeout(20_000);
  try {
    if (key === "openrouter_api_key" || key === "openrouter_model") {
      /* OpenRouter: cheap and public to verify — one call proves the key, one proves
         the model id exists. The model list needs no key, so a model typo is caught
         even before a key is saved. */
      const apiKey = getKey("openrouter_api_key");
      const model = getKey("openrouter_model");
      const modelsRes = await fetch("https://openrouter.ai/api/v1/models", { signal: timeout });
      const modelsJson = modelsRes.ok
        ? ((await modelsRes.json()) as { data?: { id: string; pricing?: { prompt?: string } }[] })
        : { data: [] };
      const ids = new Set((modelsJson.data ?? []).map((m) => m.id));
      if (key === "openrouter_model" && !ids.has(value)) {
        return NextResponse.json({
          ok: false,
          error: "این شناسهٔ مدل در OpenRouter نیست",
          detail: `«${value}» — فهرست https://openrouter.ai/models`,
        });
      }
      if (!apiKey) {
        return NextResponse.json({
          ok: false,
          error: "ابتدا کلید OpenRouter را ذخیره کنید",
        });
      }
      const r = await fetch("https://openrouter.ai/api/v1/key", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: timeout,
      });
      const text = await r.text();
      if (!r.ok) {
        return NextResponse.json({
          ok: false,
          status: r.status,
          error:
            r.status === 401
              ? "کلید OpenRouter پذیرفته نشد (۴۰۱)"
              : `OpenRouter پاسخ ${r.status} داد`,
          detail: text.slice(0, 300),
        });
      }
      const info = JSON.parse(text) as {
        data?: { label?: string; usage?: number; limit?: number | null; is_free_tier?: boolean };
      };
      const used = info.data?.usage ?? 0;
      const limit = info.data?.limit ?? null;
      return NextResponse.json({
        ok: true,
        provider: "OpenRouter",
        found: 0,
        message: [
          "کلید معتبر است",
          info.data?.label ? `«${info.data.label}»` : "",
          limit ? `مصرف ${used.toFixed(3)} از ${limit}` : `مصرف ${used.toFixed(3)} دلار`,
          info.data?.is_free_tier ? "سطح رایگان" : "",
          model ? (ids.has(model) ? `مدل ${model} موجود است` : `مدل ${model} پیدا نشد`) : "مدل تنظیم نشده",
        ]
          .filter(Boolean)
          .join(" · "),
      });
    }

    if (key === "neshan_api_key") {
      // A Neshan key is bound to the service picked when it was created, so probe
      // both point services: nearby (location+radius) first, then search
      // (term+center). /v1/search is retired; its error 485 means "wrong service".
      const q = JSON.stringify({
        term: "داروخانه",
        center: { latitude: AHVAZ.lat, longitude: AHVAZ.lon },
      });
      const tries: { name: string; url: string }[] = [
        {
          name: "مکان‌های نزدیک /v1/nearby",
          url: `https://api.neshan.org/v1/nearby?location=${AHVAZ.lat},${AHVAZ.lon}&radius=1500`,
        },
        {
          name: "جستجو /v3/search",
          url: `https://api.neshan.org/v3/search?q=${encodeURIComponent(q)}`,
        },
      ];
      let last = { status: 0, text: "" };
      for (const t of tries) {
        const r = await fetch(t.url, { headers: { "Api-Key": value }, signal: timeout });
        const text = await r.text();
        if (r.ok) {
          const json = JSON.parse(text) as {
            count?: number;
            items?: { title?: string; address?: string; type?: string; category?: string }[];
          };
          return NextResponse.json({
            ok: true,
            provider: `نشان — ${t.name}`,
            found: json.count ?? json.items?.length ?? 0,
            sample: (json.items ?? []).slice(0, 4).map((i) => ({
              title: i.title ?? "",
              address: [i.address, i.type].filter(Boolean).join(" · "),
            })),
          });
        }
        last = { status: r.status, text };
        if ([401, 403, 480, 483].includes(r.status)) break; // the key itself is wrong
      }
      return NextResponse.json(
        {
          ok: false,
          status: last.status,
          kind:
            value.startsWith("service.")
              ? "service"
              : value.startsWith("web.")
                ? "web"
                : value.startsWith("mobile.")
                  ? "mobile"
                  : "unknown",
          error:
            last.status === 483 || value.startsWith("web.")
              ? "این کلید از نوع «وب / SDK نقشه» است (web.…)، نه کلید سرویس. در پنل نشان یک کلید نوع «سرویس» با سرویس «مکان‌های نزدیک» یا «جستجو» بسازید."
              : last.status === 485
                ? "این کلید سرویس مکان‌یابی ندارد (485). در پنل نشان کلید نوع «سرویس» با سرویس «مکان‌های نزدیک» یا «جستجو» بسازید؛ فعال‌سازی با تیکت پشتیبانی انجام می‌شود."
                : last.status === 480 || last.status === 401 || last.status === 403
                  ? "کلید پذیرفته نشد — کلید سرویس را بررسی کنید"
                  : last.status === 481 || last.status === 482
                    ? "سهمیهٔ درخواست نشان تمام شده (۴۸۱/۴۸۲)"
                    : `نشان پاسخ ${last.status} داد`,
          detail: last.text.slice(0, 300),
        },
        { status: 200 },
      );
    }

    // Google Places (New) — nearby search around اهواز, type pharmacy
    const r = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": value,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress",
      },
      body: JSON.stringify({
        includedTypes: ["pharmacy"],
        maxResultCount: 5,
        locationRestriction: {
          circle: { center: { latitude: AHVAZ.lat, longitude: AHVAZ.lon }, radius: 5000 },
        },
      }),
      signal: timeout,
    });
    const text = await r.text();
    if (!r.ok) {
      // Google puts the reason in error.status; "403" alone tells you nothing.
      let reason = "";
      let message = "";
      try {
        const e = JSON.parse(text) as { error?: { status?: string; message?: string } };
        reason = e.error?.status ?? "";
        message = e.error?.message ?? "";
      } catch {
        /* not JSON */
      }
      const low = `${reason} ${message}`.toLowerCase();
      const error =
        reason === "SERVICE_DISABLED" || low.includes("has not been used in project")
          ? "Places API (New) برای این پروژه فعال نیست — در Google Cloud Console → APIs & Services آن را Enable کنید"
          : reason === "API_KEY_INVALID" || reason === "API_KEY_SERVICE_BLOCKED"
            ? "کلید گوگل نامعتبر است یا برای Places مسدود شده"
            : reason === "INVALID_ARGUMENT"
              ? "کلید یا درخواست نامعتبر است — شکل کلید Google API باید با AIza شروع شود و Places API (New) روی همان پروژه فعال باشد"
            : low.includes("billing")
              ? "صورتحساب پروژه وصل نیست — گوگل حتی برای سهمیهٔ رایگان هم کارت می‌خواهد"
              : low.includes("referer") || low.includes("ip, site or mobile application")
                ? "کلید به Referer/IP محدود شده — برای فراخوانی سروری، محدودیت کلید را بردارید"
                : r.status === 403
                  ? "دسترسی رد شد — کلید، صورتحساب یا فعال‌سازی Places را بررسی کنید"
                  : `Google پاسخ ${r.status} داد`;
      return NextResponse.json(
        { ok: false, status: r.status, reason, error, detail: text.slice(0, 300) },
        { status: 200 },
      );
    }
    const json = JSON.parse(text) as {
      places?: { displayName?: { text?: string }; formattedAddress?: string }[];
    };
    return NextResponse.json({
      ok: true,
      provider: "Google Places",
      found: json.places?.length ?? 0,
      sample: (json.places ?? []).slice(0, 4).map((p) => ({
        title: p.displayName?.text ?? "",
        address: p.formattedAddress ?? "",
      })),
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "درخواست به سرویس نرسید",
        detail: e instanceof Error ? e.message : String(e),
      },
      { status: 200 },
    );
  }
}
