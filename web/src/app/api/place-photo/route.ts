/** Proxy for Google Place photos: the API key stays on the server.
 *
 *   /api/place-photo?name=places/ChIJ.../photos/AeJbb3...&w=640
 *
 * Only photo resource names are accepted (they start with `places/` and contain
 * `/photos/`), so the route cannot be used to fetch arbitrary Google endpoints.
 */
import { NextResponse } from "next/server";
import { getKey } from "@/lib/settings";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const name = url.searchParams.get("name") ?? "";
    const width = Math.min(1600, Math.max(120, Number(url.searchParams.get("w") ?? 640)));

    if (!name.startsWith("places/") || !name.includes("/photos/")) {
      return NextResponse.json({ error: "invalid photo name" }, { status: 400 });
    }
    const key = getKey("google_places_key");
    if (!key) {
      return NextResponse.json({ error: "no google key" }, { status: 400 });
    }

    const upstream = await fetch(
      `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${width}`,
      {
        headers: { "X-Goog-Api-Key": key },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!upstream.ok) {
      return NextResponse.json({ error: `photo ${upstream.status}` }, { status: 502 });
    }
    const bytes = Buffer.from(await upstream.arrayBuffer());
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
        "Content-Length": String(bytes.byteLength),
        // the photo reference is stable; the bytes behind it change rarely
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "photo failed" },
      { status: 502 },
    );
  }
}
