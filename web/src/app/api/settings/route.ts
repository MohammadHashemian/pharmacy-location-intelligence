/**
 * Read/save API keys. The value is write-only: GET never returns it, only a
 * masked tail, so a stolen page or a screenshot cannot leak the key.
 *
 *   GET  -> { providers: SettingStatus[] }
 *   POST { key, value }   value "" clears the entry
 */
import { NextResponse } from "next/server";
import { isProviderKey, listStatus, setKey } from "@/lib/settings";

export async function GET() {
  return NextResponse.json({ providers: listStatus() });
}

export async function POST(req: Request) {
  let body: { key?: unknown; value?: unknown };
  try {
    body = (await req.json()) as { key?: unknown; value?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const key = String(body.key ?? "");
  const value = String(body.value ?? "").trim();
  if (!isProviderKey(key)) {
    return NextResponse.json({ error: "unknown key" }, { status: 400 });
  }
  // Keys are opaque tokens; length is the only thing worth policing locally.
  if (value && (value.length < 8 || value.length > 400)) {
    return NextResponse.json(
      { error: "کلید باید بین ۸ تا ۴۰۰ نویسه باشد" },
      { status: 400 },
    );
  }
  setKey(key, value);
  return NextResponse.json({ ok: true, providers: listStatus() });
}
