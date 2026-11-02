"use client";

/**
 * The "what" behind a dot: Google's public profile for a pharmacy (photo, rating,
 * phone, website, hours), plus the local competition — pharmacies and medical
 * places inside 1 km — which is the number the site decision turns on.
 *
 * Photos are fetched through /api/place-photo so the API key never reaches the
 * browser.
 */
import { useEffect, useState } from "react";
import type { MapMedical, MapPharmacy } from "@/lib/map";
import { group, num } from "@/lib/format";

const KIND_FA: Record<MapMedical["kind"], string> = {
  doctor: "پزشک",
  clinic: "کلینیک",
  dentist: "دندانپزشک",
  hospital: "بیمارستان",
  lab: "آزمایشگاه",
};

const SOURCE_FA: Record<string, string> = {
  osm: "OSM",
  neshan: "نشان",
  google: "گوگل",
};

function km(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371.0088;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dp = rad(bLat - aLat);
  const dl = rad(bLon - aLon);
  const h =
    Math.sin(dp / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearby<T extends { lat: number; lon: number }>(
  list: T[],
  lat: number,
  lon: number,
  radiusKm: number,
): T[] {
  return list.filter((p) => km(lat, lon, p.lat, p.lon) <= radiusKm);
}

export function PlacePanel({
  pharm,
  medical,
  pharmacies,
  medicals,
  onClose,
  onChanged,
}: {
  pharm: MapPharmacy | null;
  medical: MapMedical | null;
  pharmacies: MapPharmacy[];
  medicals: MapMedical[];
  onClose: () => void;
  /** called after an edit or a delete so the page re-reads the layer */
  onChanged?: () => void;
}) {
  /* declared before the early return: a hook after it changes the hook count the
     moment a selection appears */
  const [photoReady, setPhotoReady] = useState(false);
  /* Only a hand-added pin is editable: OSM and Google rows are rewritten by the next ETL
     run, so an edit there would disappear without saying so. */
  const manualId =
    pharm?.source === "manual"
      ? Number(pharm.id.split("/")[1])
      : medical?.source === "manual"
        ? -medical.id
        : null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    kind: "pharmacy",
    name: "",
    address: "",
    phone: "",
    note: "",
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!pharm && !medical) return null;

  const anchor = pharm ?? medical!;
  const near = nearby(pharmacies, anchor.lat, anchor.lon, 1);
  const care = nearby(medicals, anchor.lat, anchor.lon, 1);
  const careByKind = (["clinic", "doctor", "dentist", "hospital", "lab"] as const)
    .map((k) => ({ k, n: care.filter((c) => c.kind === k).length }))
    .filter((x) => x.n > 0);

  /* Opportunity is deliberately blunt: prescriptions are written in clinics, so a
     km with care but no pharmacy is the best corner; five pharmacies on the same
     km is not a corner at all. */
  const verdict =
    near.length >= 5
      ? { text: "اشباع — ۵ داروخانه یا بیشتر در ۱ کیلومتر", tone: "danger" as const }
      : care.length >= 3 && near.length <= 1
        ? { text: "فرصت — درمانگر زیاد، داروخانه کم", tone: "ok" as const }
        : near.length <= 1
          ? { text: "کم‌رقابت", tone: "ok" as const }
          : { text: "رقابت متعادل", tone: "mid" as const };

  const profile = pharm?.profile ?? null;
  const photo = profile?.photos?.[0];
  useEffect(() => setPhotoReady(false), [photo]);

  return (
    <div className="rounded-2xl border border-line bg-surface p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.12)]">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-bold text-ink">{anchor.name}</div>
          <div className="mt-0.5 text-[10.5px] text-muted">
            {medical ? (
              KIND_FA[medical.kind]
            ) : (
              <span className="rounded bg-warn-soft px-1 text-[9.5px] text-warn">
                {SOURCE_FA[pharm!.source] ?? pharm!.source}
              </span>
            )}{" "}
            {anchor.settlement ? `· ${anchor.settlement}` : ""}
            {anchor.county ? ` · ${anchor.county}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {manualId ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setDraft({
                    kind: pharm ? "pharmacy" : (medical?.kind ?? "clinic"),
                    name: anchor.name,
                    address: pharm?.profile?.address ?? (medical?.address ?? ""),
                    phone: pharm?.profile?.phone ?? "",
                    note: "",
                  });
                  setMsg(null);
                  setEditing((v) => !v);
                }}
                className="rounded-md border border-line-strong px-1.5 py-0.5 text-[10px] text-brand-ink hover:border-brand"
              >
                {editing ? "انصراف" : "ویرایش"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  if (!window.confirm(`«${anchor.name}» حذف شود؟`)) return;
                  setBusy(true);
                  const r = await fetch(`/api/pharmacies?id=${manualId}`, { method: "DELETE" });
                  setBusy(false);
                  if (r.ok) {
                    onChanged?.();
                    onClose();
                  } else {
                    setMsg({ ok: false, text: "حذف نشد" });
                  }
                }}
                className="rounded-md border border-line-strong px-1.5 py-0.5 text-[10px] text-danger hover:border-danger"
              >
                حذف
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line-strong px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
          >
            بستن
          </button>
        </div>
      </div>

      {pharm?.unnamed ? (
        <div className="mb-2 rounded-lg border border-warn/40 bg-warn-soft px-2 py-1.5 text-[10.5px] leading-4 text-warn">
          <b>بدون نام.</b> این نقطه از OSM آمده و کسی نامش را ثبت نکرده — احتمالاً داروخانهٔ
          واقعی است. روی تصویر ماهواره‌ای بررسی کنید؛ اگر تأیید شد، با «افزودن داروخانه» نامش را
          ثبت کنید و این نقطهٔ بی‌نام را نادیده بگیرید.
        </div>
      ) : null}

      {manualId && editing ? (
        <div className="mb-2 rounded-lg border border-line bg-surface-2 p-2">
          <label className="mb-1.5 block">
            <span className="text-[10px] text-faint">نوع خدمت</span>
            <select
              value={draft.kind}
              onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value }))}
              className="mt-0.5 w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] text-ink"
            >
              <option value="pharmacy">داروخانه</option>
              <option value="clinic">درمانگاه / کلینیک</option>
              <option value="doctor">مطب پزشک</option>
              <option value="dentist">دندانپزشکی</option>
              <option value="hospital">بیمارستان</option>
              <option value="lab">آزمایشگاه</option>
            </select>
          </label>
          <div className="grid gap-1.5">
            {(
              [
                ["name", draft.kind === "pharmacy" ? "نام داروخانه" : "نام مکان", "text"],
                ["address", "نشانی", "text"],
                ["phone", "تلفن", "tel"],
                ["note", "یادداشت", "text"],
              ] as const
            ).map(([key, label, type]) => (
              <label key={key} className="block">
                <span className="text-[10px] text-faint">{label}</span>
                <input
                  type={type}
                  dir={key === "phone" ? "ltr" : "rtl"}
                  value={draft[key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  className={`mt-0.5 w-full rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] text-ink ${
                    key === "phone" ? "text-left" : ""
                  }`}
                />
              </label>
            ))}
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy || draft.name.trim().length < 3}
              onClick={async () => {
                setBusy(true);
                setMsg(null);
                const r = await fetch("/api/pharmacies", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id: manualId, ...draft }),
                });
                const j = (await r.json()) as { ok?: boolean; error?: string };
                setBusy(false);
                if (r.ok && j.ok) {
                  setEditing(false);
                  setMsg({ ok: true, text: "ذخیره شد" });
                  onChanged?.();
                } else {
                  setMsg({ ok: false, text: j.error ?? "ذخیره نشد" });
                }
              }}
              className="rounded-md bg-brand px-2 py-1 text-[10.5px] font-bold text-white disabled:opacity-50"
            >
              ذخیره
            </button>
            <span className="text-[10px] text-faint">
              با تغییر نوع، نقطه به لایهٔ همان خدمت می‌رود
            </span>
          </div>
        </div>
      ) : null}

      {msg ? (
        <div className={`mb-2 text-[10.5px] ${msg.ok ? "text-brand-ink" : "text-danger"}`}>
          {msg.text}
        </div>
      ) : null}

      {photo ? (
        /* the box only exists once the bytes are in: an empty bordered frame reads
           as a broken image */
        <div className="mb-2 h-36 w-full overflow-hidden rounded-lg border border-line bg-surface-2">
          <img
            key={photo}
            src={`/api/place-photo?name=${encodeURIComponent(photo)}&w=640`}
            alt={anchor.name}
            onLoad={() => setPhotoReady(true)}
            className={`h-36 w-full object-cover transition-opacity duration-300 ${
              photoReady ? "opacity-100" : "opacity-0"
            }`}
          />
        </div>
      ) : null}

      {profile?.rating ? (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px]">
          <span className="tnum font-bold text-warn">★ {profile.rating.toFixed(1)}</span>
          <span className="text-faint">
            ({group(profile.reviews ?? 0)} نظر در گوگل)
          </span>
          {profile.priceLevel ? (
            <span className="rounded bg-surface-2 px-1 text-[10px] text-muted">
              {profile.priceLevel.replace("PRICE_LEVEL_", "")}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-1 text-[11px] leading-5">
        {pharm?.profile?.address || medical?.address ? (
          <div className="text-muted">
            <span className="text-faint">نشانی: </span>
            {pharm?.profile?.address ?? medical?.address}
          </div>
        ) : null}
        {pharm?.profile?.phone ? (
          <div>
            <span className="text-faint">تلفن: </span>
            <a dir="ltr" className="text-brand-ink hover:underline" href={`tel:${pharm.profile.phone}`}>
              {pharm.profile.phone}
            </a>
          </div>
        ) : null}
        {pharm?.profile?.website ? (
          <div className="truncate">
            <span className="text-faint">وب‌سایت: </span>
            <a
              href={pharm.profile.website}
              target="_blank"
              rel="noreferrer"
              className="text-brand-ink hover:underline"
            >
              {pharm.profile.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </a>
          </div>
        ) : null}
        {pharm?.profile?.mapsUri ? (
          <a
            href={pharm.profile.mapsUri}
            target="_blank"
            rel="noreferrer"
            className="inline-block rounded-md border border-line-strong px-1.5 py-0.5 text-[10.5px] text-muted hover:border-brand hover:text-brand-ink"
          >
            باز کردن در گوگل‌مپ
          </a>
        ) : null}
      </div>

      {pharm?.profile?.hours?.length ? (
        <details className="mt-1.5 text-[10.5px] text-muted">
          <summary className="cursor-pointer text-faint">ساعات کاری</summary>
          <ul className="mt-1 space-y-0.5">
            {pharm.profile.hours.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {pharm?.profile?.summary ? (
        <p className="mt-1.5 text-[10.5px] leading-5 text-muted">{pharm.profile.summary}</p>
      ) : null}

      <div className="mt-2 rounded-lg bg-surface-2 p-2">
        <div className="mb-1 text-[11px] font-semibold text-ink">رقابت در شعاع ۱ کیلومتر</div>
        <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10.5px]">
          <span className="text-faint">داروخانه</span>
          <span className="tnum text-left font-bold text-ink">{group(near.length)}</span>
          <span className="text-faint">مرکز درمانی</span>
          <span className="tnum text-left font-bold text-ink">{group(care.length)}</span>
          {careByKind.map((c) => (
            <span key={c.k} className="contents">
              <span className="text-faint">{KIND_FA[c.k]}</span>
              <span className="tnum text-left text-ink-soft">{group(c.n)}</span>
            </span>
          ))}
        </div>
        <div
          className={`mt-1.5 rounded-md px-1.5 py-1 text-center text-[10.5px] font-medium ${
            verdict.tone === "danger"
              ? "bg-danger-soft text-danger"
              : verdict.tone === "ok"
                ? "bg-brand-soft text-brand-ink"
                : "bg-surface text-muted"
          }`}
        >
          {verdict.text}
        </div>
        {pharm ? (
          <div className="mt-1 text-[10px] text-faint">
            نزدیک‌ترین درمانگر:{" "}
            {care.length
              ? (() => {
                  const best = care
                    .map((c) => ({ c, d: km(pharm.lat, pharm.lon, c.lat, c.lon) }))
                    .sort((a, b) => a.d - b.d)[0];
                  return `${best.c.name} · ${num(best.d, 2)} کیلومتر`;
                })()
              : "—"}
          </div>
        ) : null}
      </div>
    </div>
  );
}
