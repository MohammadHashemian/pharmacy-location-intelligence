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

export type LlmToolCall = {
  id: string;
  type?: string;
  function: { name: string; arguments?: string };
};

export type LlmMessage = {
  role?: string;
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: LlmToolCall[];
};

export type LlmEnvelope = {
  model?: string;
  choices?: { message?: LlmMessage }[];
  usage?: { total_tokens?: number };
};

/** Merges chunked deltas, the shape a streaming gateway sends. */
function mergeDeltas(text: string): LlmEnvelope | null {
  let model: string | undefined;
  let tokens: number | undefined;
  let content = "";
  let last: LlmMessage | null = null;
  const calls: LlmToolCall[] = [];

  for (const line of text.split(/\r?\n/)) {
    const chunk = line.startsWith("data:") ? line.slice(5).trim() : "";
    if (!chunk || chunk === "[DONE]") continue;
    let o: LlmEnvelope & {
      choices?: { message?: LlmMessage; delta?: Partial<LlmMessage> & { tool_calls?: (LlmToolCall & { index?: number })[] } }[];
    };
    try {
      o = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (o.model) model = o.model;
    if (o.usage?.total_tokens) tokens = o.usage.total_tokens;
    const ch = o.choices?.[0];
    if (!ch) continue;
    if (ch.message) last = ch.message; // a full message wins over any deltas
    const delta = ch.delta;
    if (!delta) continue;
    if (delta.content) content += delta.content;
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? calls.length;
      const slot = (calls[i] ??= { id: tc.id ?? `call_${i}`, type: "function", function: { name: "", arguments: "" } });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.function.name += tc.function.name;
      if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
    }
  }

  const message = last ?? (content || calls.length ? { role: "assistant", content: content || null, tool_calls: calls.length ? calls : undefined } : null);
  if (!message) return null;
  return { model, usage: tokens ? { total_tokens: tokens } : undefined, choices: [{ message }] };
}

/**
 * Reads a chat answer whatever envelope the gateway chose.
 *
 * 9Router (and any router built on a streaming core) answers `text/event-stream`
 * even when `stream` was never set — the body is then `{…json…}\r\ndata: [DONE]`,
 * which `JSON.parse` rejects. Every caller sends `stream: false`, but the reader
 * stays tolerant: plain JSON, a JSON body with SSE trailers, or real chunked SSE.
 */
export function parseChatPayload(raw: string): LlmEnvelope {
  const body = raw.trim();
  if (!body) throw new Error("empty answer");

  // hybrid body: a complete object followed by `data: [DONE]`
  const stripped = body.replace(/^data:.*$/gm, "").trim();
  try {
    return JSON.parse(stripped) as LlmEnvelope;
  } catch {
    /* streamed or malformed */
  }

  const merged = mergeDeltas(body);
  if (merged) return merged;

  // a bare chunk stream may put several objects on one line without `data:` prefixes
  const firstBrace = body.indexOf("{");
  const lastBrace = body.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(body.slice(firstBrace, lastBrace + 1)) as LlmEnvelope;
    } catch {
      /* fall through */
    }
  }
  throw new Error("not a chat answer");
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
