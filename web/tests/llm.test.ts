/**
 * The LLM settings layer: base-URL normalisation, validation, the stored round-trip,
 * the legacy-OpenRouter fallback and the two routes that must not go near the network.
 */
import { describe, expect, it } from "vitest";
import { LLM_PRESETS, apiErrorText, chatUrl, getLlm, llmStatus, modelsUrl, normalizeBaseUrl, saveLlm } from "@/lib/llm";
import { run } from "@/lib/db";
import { POST as llmPOST } from "@/app/api/settings/llm/route";
import { POST as llmTestPOST } from "@/app/api/settings/llm/test/route";

const saveReq = (body: unknown) =>
  new Request("http://test/api/settings/llm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("base url", () => {
  it("accepts a pasted full endpoint or a bare base", () => {
    expect(normalizeBaseUrl("https://api.gw.dev/v1/chat/completions")).toBe("https://api.gw.dev/v1");
    expect(normalizeBaseUrl("https://api.gw.dev/v1///")).toBe("https://api.gw.dev/v1");
    expect(normalizeBaseUrl("  http://localhost:20128/v1  ")).toBe("http://localhost:20128/v1");
  });

  it("refuses a non-http scheme", () => {
    expect(() => normalizeBaseUrl("ftp://x/v1")).toThrow();
    expect(() => normalizeBaseUrl("not a url")).toThrow();
  });

  it("builds the two OpenAI paths once", () => {
    expect(chatUrl("https://x/v1/")).toBe("https://x/v1/chat/completions");
    expect(modelsUrl("https://x/v1")).toBe("https://x/v1/models");
  });
});

describe("validation", () => {
  it("refuses an unknown provider, an empty model, a model with spaces and a short key", () => {
    expect(saveLlm({ provider: "nope", baseUrl: "https://x/v1", model: "m" })).toMatchObject({ ok: false });
    expect(saveLlm({ provider: "custom", baseUrl: "https://x/v1", model: " " })).toMatchObject({ ok: false });
    expect(saveLlm({ provider: "custom", baseUrl: "https://x/v1", model: "two words" })).toMatchObject({ ok: false });
    expect(saveLlm({ provider: "custom", baseUrl: "https://x/v1", model: "m", apiKey: "short" })).toMatchObject({ ok: false });
    expect(saveLlm({ provider: "custom", baseUrl: "", model: "m" })).toMatchObject({ ok: false });
  });

  it("ships the four presets the panel renders", () => {
    expect(LLM_PRESETS.map((p) => p.id)).toEqual(["openrouter", "openai", "9router", "custom"]);
    for (const p of LLM_PRESETS) expect(p.label.length).toBeGreaterThan(2);
  });
});

describe("round trip", () => {
  it("saves, keeps the key when omitted, and clears it on demand", () => {
    const saved = saveLlm({
      provider: "9router",
      baseUrl: "https://9router.com/v1/chat/completions",
      model: "cc/claude-sonnet-4",
      apiKey: "sk-test-12345678",
    });
    expect(saved).toEqual({ ok: true });

    const cfg = getLlm();
    expect(cfg).toMatchObject({
      provider: "9router",
      baseUrl: "https://9router.com/v1",
      model: "cc/claude-sonnet-4",
      apiKey: "sk-test-12345678",
      keySource: "llm",
    });

    // a second save without a key must not wipe the stored one
    expect(saveLlm({ provider: "9router", baseUrl: cfg.baseUrl, model: "glm/glm-4.7" })).toEqual({ ok: true });
    expect(getLlm().apiKey).toBe("sk-test-12345678");
    expect(getLlm().model).toBe("glm/glm-4.7");

    const status = llmStatus();
    expect(status.configured).toBe(true);
    expect(status.keyMasked).toBe("••••••••5678");
    expect(JSON.stringify(status)).not.toContain("sk-test-12345678");

    expect(saveLlm({ provider: "9router", baseUrl: cfg.baseUrl, model: "glm/glm-4.7", clearKey: true })).toEqual({ ok: true });
    expect(getLlm().apiKey).toBeNull();
    expect(llmStatus().configured).toBe(false);
  });

  it("falls back to the legacy OpenRouter pair when no provider was ever chosen", () => {
    run("DELETE FROM app_setting WHERE key LIKE 'llm_%'");
    run("INSERT OR REPLACE INTO app_setting (key, value, updated_at) VALUES ('openrouter_api_key','sk-legacy-9999','2026-01-01T00:00:00Z')");
    run("INSERT OR REPLACE INTO app_setting (key, value, updated_at) VALUES ('openrouter_model','google/gemini-2.5-flash','2026-01-01T00:00:00Z')");

    const cfg = getLlm();
    expect(cfg).toMatchObject({ provider: "openrouter", model: "google/gemini-2.5-flash", keySource: "legacy" });
    expect(cfg.baseUrl).toBe("https://openrouter.ai/api/v1");
    expect(llmStatus().configured).toBe(true);

    run("DELETE FROM app_setting WHERE key LIKE 'openrouter_%'");
  });
});

describe("routes", () => {
  it("refuses an unknown provider with a 400, not a crash", async () => {
    const r = await llmPOST(saveReq({ provider: "nope", baseUrl: "https://x/v1", model: "m" }));
    expect(r.status).toBe(400);
  });

  it("refuses a probe with no saved key before any network call", async () => {
    run("DELETE FROM app_setting WHERE key = 'llm_api_key'");
    const r = await llmTestPOST();
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toContain("کلید");
  });
});

describe("api error text", () => {
  it("reads the message out of an OpenAI-shaped error and never dumps a long body", () => {
    expect(apiErrorText('{"error":{"message":"bad model"}}')).toBe("bad model");
    expect(apiErrorText("x".repeat(1000))).toHaveLength(300);
  });
});
