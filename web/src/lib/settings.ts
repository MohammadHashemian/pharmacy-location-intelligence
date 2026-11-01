/**
 * The one table the APP owns (everything else belongs to the Python ETL).
 *
 * API keys entered in /settings live here, in `db/pharmacy.sqlite`, and never
 * leave the server: the browser only ever receives a masked tail. The table is
 * created on first use, so a fresh clone works without an ETL run, and a
 * `load.py --reset` (which only clears fact tables) leaves the keys in place.
 */
import { all, run } from "./db";

export const PROVIDERS = [
  {
    key: "neshan_api_key",
    label: "نشان (Neshan)",
    hint: "کلید نوع «سرویس» (با پیشوند service.) — کلیدهای web.… فقط برای SDK نقشه در مرورگر کار می‌کنند و API با خطای ۴۸۳ رد می‌کند؛ سرویس «مکان‌های نزدیک» یا «جستجو» را انتخاب کنید (فعال‌سازی با تیکت).",
    docs: "https://platform.neshan.org",
  },
  {
    key: "google_places_key",
    label: "Google Places",
    hint: "کلید Places API (New) با صورتحساب. ۵٬۰۰۰ فراخوان در ماه رایگان؛ سرویس Near/Text Search در SKU «Pro» حدود $۳۲ برای هر ۱٬۰۰۰ فراخوان. توجه: ایران در فهرست Prohibited Territories گوگل است.",
    docs: "https://console.cloud.google.com/google/maps-apis",
  },
] as const;

export type ProviderKey = (typeof PROVIDERS)[number]["key"];

export type SettingStatus = {
  key: ProviderKey;
  label: string;
  hint: string;
  docs: string;
  configured: boolean;
  /** Only the last 4 characters are ever returned. */
  masked: string | null;
  updatedAt: string | null;
};

function ensureTable(): void {
  run(`CREATE TABLE IF NOT EXISTS app_setting (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

export function maskKey(value: string): string {
  const tail = value.slice(-4);
  return `••••••••${tail}`;
}

export function getKey(key: ProviderKey): string | null {
  ensureTable();
  const rows = all<{ value: string }>(
    "SELECT value FROM app_setting WHERE key = ?",
    [key],
  );
  return rows[0]?.value ?? null;
}

export function setKey(key: ProviderKey, value: string): void {
  ensureTable();
  if (!value) {
    run("DELETE FROM app_setting WHERE key = ?", [key]);
    return;
  }
  run(
    `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, new Date().toISOString()],
  );
}

export function listStatus(): SettingStatus[] {
  ensureTable();
  const rows = all<{ key: string; value: string; updated_at: string }>(
    "SELECT key, value, updated_at FROM app_setting",
  );
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return PROVIDERS.map((p) => {
    const row = byKey.get(p.key);
    return {
      key: p.key,
      label: p.label,
      hint: p.hint,
      docs: p.docs,
      configured: !!row?.value,
      masked: row?.value ? maskKey(row.value) : null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

export function isProviderKey(v: string): v is ProviderKey {
  return PROVIDERS.some((p) => p.key === v);
}
