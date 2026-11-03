/**
 * The LLM half of /settings: provider → base URL → model → key.
 *
 * All supported gateways speak the OpenAI wire format (`/chat/completions`, `/models`), so one
 * code path serves OpenRouter, OpenAI, 9Router and whatever the user defines as «سفارشی».
 * Values live in the same `app_setting` table as the map keys; the browser only ever sees a
 * masked tail, exactly like `settings.ts`.
 *
 * Installs that still carry the old `openrouter_api_key` / `openrouter_model` keep working:
 * they are read only when no `llm_provider` row exists, so saving a new provider does not
 * silently borrow an old key.
 */
import { all, one, run } from "./db";
import { ensureTable, maskKey } from "./settings";

export type LlmPreset = {
  id: string;
  label: string;
  /** Editable starting point; empty means the user must type one. */
  baseUrl: string;
  keyUrl: string;
  modelsUrl: string;
  modelHint: string;
  hint: string;
};

export const LLM_PRESETS: LlmPreset[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    modelsUrl: "https://openrouter.ai/models",
    modelHint: "google/gemini-2.5-flash",
    hint: "یک کلید برای مدل‌های همهٔ شرکت‌ها؛ برای برچسب‌زدن، ارزان‌ترین مدل کافی است.",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    modelsUrl: "https://platform.openai.com/docs/models",
    modelHint: "gpt-4o-mini",
    hint: "کلید مستقیم OpenAI؛ برای ایران معمولاً از دروازه لازم است.",
  },
  {
    id: "9router",
    label: "9Router",
    baseUrl: "https://9router.com/v1",
    keyUrl: "https://9router.com",
    modelsUrl: "https://9router.com",
    modelHint: "cc/claude-sonnet-4-20250514",
    hint: "دروازهٔ OpenAI-compatible با مسیریابی خودکار؛ نسخهٔ محلی: http://localhost:20128/v1",
  },
  {
    id: "custom",
    label: "سفارشی (OpenAI-compatible)",
    baseUrl: "",
    keyUrl: "",
    modelsUrl: "",
    modelHint: "your-model",
    hint: "هر سروری که /v1/chat/completions و /v1/models سازگار با OpenAI دارد (LiteLLM، Ollama، vLLM، …).",
  },
];

export type LlmKeySource = "llm" | "legacy" | null;

export type LlmConfig = {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  keySource: LlmKeySource;
};

export type LlmStatus = {
  provider: string;
  presets: LlmPreset[];
  baseUrl: string;
  model: string;
  /** A key AND a model are what the classifier actually needs. */
  configured: boolean;
  keyMasked: string | null;
  keySource: LlmKeySource;
  updatedAt: string | null;
};

const KEYS = [
  "llm_provider",
  "llm_base_url",
  "llm_model",
  "llm_api_key",
  "openrouter_api_key",
  "openrouter_model",
];

export function presetOf(id: string): LlmPreset | undefined {
  return LLM_PRESETS.find((p) => p.id === id);
}

/** Accepts a pasted full endpoint (`…/v1/chat/completions`) as well as a bare base. */
export function normalizeBaseUrl(raw: string): string {
  const u = new URL(raw.trim());
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("not http(s)");
  }
  const path = u.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return `${u.origin}${path}${u.search}`;
}

export function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

export function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

export function authHeaders(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** Pulls `error.message` out of an OpenAI-style error body; never echoes the key. */
export function apiErrorText(raw: string): string {
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    if (typeof j.error === "string") return j.error.slice(0, 300);
    if (j.error && typeof j.error === "object" && j.error.message) return j.error.message.slice(0, 300);
    if (j.message) return j.message.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return raw.slice(0, 300);
}

export function getLlm(): LlmConfig {
  ensureTable();
  const rows = all<{ key: string; value: string }>(
    `SELECT key, value FROM app_setting WHERE key IN (${KEYS.map(() => "?").join(",")})`,
    KEYS,
  );
  const v = new Map(rows.map((r) => [r.key, r.value]));
  const provider = v.get("llm_provider");
  if (provider) {
    return {
      provider,
      baseUrl: v.get("llm_base_url") || presetOf(provider)?.baseUrl || "",
      model: v.get("llm_model") ?? "",
      apiKey: v.get("llm_api_key") || null,
      keySource: v.get("llm_api_key") ? "llm" : null,
    };
  }
  const legacyKey = v.get("openrouter_api_key") || null;
  return {
    provider: "openrouter",
    baseUrl: LLM_PRESETS[0].baseUrl,
    model: v.get("openrouter_model") ?? "",
    apiKey: legacyKey,
    keySource: legacyKey ? "legacy" : null,
  };
}

export function llmStatus(): LlmStatus {
  const c = getLlm();
  const updatedAt =
    one<{ u: string | null }>(
      `SELECT MAX(updated_at) AS u FROM app_setting WHERE key IN (${KEYS.map(() => "?").join(",")})`,
      KEYS,
    )?.u ?? null;
  return {
    provider: c.provider,
    presets: LLM_PRESETS,
    baseUrl: c.baseUrl,
    model: c.model,
    configured: !!c.apiKey && !!c.model,
    keyMasked: c.apiKey ? maskKey(c.apiKey) : null,
    keySource: c.keySource,
    updatedAt,
  };
}

export type LlmInput = {
  provider: string;
  baseUrl: string;
  model: string;
  /** Omitted = keep the stored key. Empty string is treated as "no change" too. */
  apiKey?: string;
  clearKey?: boolean;
};

function put(key: string, value: string): void {
  run(
    `INSERT INTO app_setting (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, new Date().toISOString()],
  );
}

export function saveLlm(input: LlmInput): { ok: true } | { ok: false; error: string } {
  const preset = presetOf(input.provider);
  if (!preset) return { ok: false, error: "ارائه‌دهندهٔ ناشناخته" };

  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(input.baseUrl.trim() || preset.baseUrl);
  } catch {
    return { ok: false, error: "Base URL باید یک نشانی http یا https باشد" };
  }
  if (baseUrl.length > 300) return { ok: false, error: "Base URL بیش از حد بلند است" };

  const model = input.model.trim();
  if (!model) return { ok: false, error: "نام مدل را وارد کنید" };
  if (/\s/.test(model) || model.length > 160) {
    return { ok: false, error: "نام مدل بدون فاصله و حداکثر ۱۶۰ نویسه است" };
  }

  const apiKey = (input.apiKey ?? "").trim();
  if (apiKey && (apiKey.length < 8 || apiKey.length > 400)) {
    return { ok: false, error: "کلید باید بین ۸ تا ۴۰۰ نویسه باشد" };
  }

  ensureTable();
  put("llm_provider", preset.id);
  put("llm_base_url", baseUrl);
  put("llm_model", model);
  if (apiKey) put("llm_api_key", apiKey);
  else if (input.clearKey) run("DELETE FROM app_setting WHERE key = 'llm_api_key'");
  return { ok: true };
}
