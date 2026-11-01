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
        if ([401, 403, 480].includes(r.status)) break; // the key itself is bad
      }
      return NextResponse.json(
        {
          ok: false,
          status: last.status,
          error:
            last.status === 485
              ? "این کلید سرویس مکانیابی ندارد (485). در پنل نشان کلیدی با سرویس «مکانهای نزدیک» یا «جستجو» بسازید؛ فعالسازی با تیکت پشتیبانی انجام میشود."
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
      return NextResponse.json(
        {
          ok: false,
          status: r.status,
          error:
            r.status === 403
              ? "کلید معتبر نیست یا Places API فعال نشده / صورتحساب وصل نیست"
              : `Google پاسخ ${r.status} داد`,
          detail: text.slice(0, 300),
        },
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
