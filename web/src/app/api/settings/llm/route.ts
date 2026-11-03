/**
 * Save the language-model configuration: provider → base URL → model → key.
 *
 * Nothing is returned except the masked status, exactly like `/api/settings`;
 * the key itself never leaves the server. `apiKey` omitted keeps the stored key.
 *
 *   POST { provider, baseUrl, model, apiKey?, clearKey? }
 */
import { NextResponse } from "next/server";
import { llmStatus, saveLlm } from "@/lib/llm";

export async function POST(req: Request) {
  let body: { provider?: unknown; baseUrl?: unknown; model?: unknown; apiKey?: unknown; clearKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const result = saveLlm({
    provider: String(body.provider ?? ""),
    baseUrl: String(body.baseUrl ?? ""),
    model: String(body.model ?? ""),
    apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
    clearKey: body.clearKey === true,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, status: llmStatus() });
}
