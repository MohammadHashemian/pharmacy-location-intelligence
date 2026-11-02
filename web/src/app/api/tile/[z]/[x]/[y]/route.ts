import fs from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";

/**
 * Satellite tiles, served from disk after the first look.
 *
 * The map used to point the browser straight at ArcGIS World Imagery, so every pan and every
 * reload paid a round trip to the internet. This route keeps the same credits and the same
 * pictures but stores each tile in `data/tiles/sat/<z>/<x>/<y>.jpg` on first request and
 * serves it from there forever after — the network is touched once per tile, not once per view.
 *
 * Kept out of `web/public` on purpose: files written under public are copied at build time,
 * so a tile fetched at runtime would 404 in production.
 */
const DIR = path.join(process.cwd(), "..", "data", "tiles", "sat");
const Z_MIN = 6;
const Z_MAX = 19;

function png(buf: Buffer) {
  return buf[0] === 0x89 && buf[1] === 0x50;              // a JPEG that is really a PNG placeholder
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ z: string; x: string; y: string }> },
) {
  const { z: zs, x: xs, y: ys } = await params;
  const z = Number(zs);
  const x = Number(xs);
  const y = Number(ys);
  const max = 2 ** z;
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) ||
      z < Z_MIN || z > Z_MAX || x < 0 || y < 0 || x >= max || y >= max) {
    return new Response("bad tile", { status: 400 });
  }

  const file = path.join(DIR, String(z), String(x), `${y}.jpg`);
  try {
    const buf = await fs.readFile(file);
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": "image/jpeg",
        "cache-control": "public, max-age=31536000, immutable",
        "x-tile-cache": "disk",
      },
    });
  } catch {
    // not cached yet
  }

  const upstream = await fetch(
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    { headers: { "user-agent": "pharmacy-location-intelligence/1.0" } },
  ).catch(() => null);
  if (!upstream || !upstream.ok) {
    return new Response("tile unavailable", { status: 502 });
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  /* z19 over خوزستان answers 200 with a ~2 KB placeholder; caching that would freeze a
     blank tile on the map forever, so placeholders are passed through and never stored. */
  const cachable = buf.length > 4000 && !png(buf);
  if (cachable) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, buf).then(() => fs.rename(`${file}.tmp`, file));
  }
  return new Response(new Uint8Array(buf), {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": cachable ? "public, max-age=31536000, immutable" : "public, max-age=600",
      "x-tile-cache": cachable ? "miss-stored" : "miss-placeholder",
    },
  });
}
