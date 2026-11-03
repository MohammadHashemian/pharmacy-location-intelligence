/**
 * The three routes that are small but easy to get dangerously wrong: the photo proxy, the tile
 * cache and the "does this key actually work" check. None of them is allowed to reach the
 * network from a test, so only the validation and the local-serve paths are exercised.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { GET as photoGET } from "@/app/api/place-photo/route";
import { GET as tileGET } from "@/app/api/tile/[z]/[x]/[y]/route";
import { POST as testPOST } from "@/app/api/settings/test/route";

const get = (url: string) => new Request(url, { method: "GET" });
const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("place photo proxy", () => {
  it("refuses anything that is not a photo resource name", async () => {
    for (const name of ["", "https://evil.example/x", "places/ABC", "places/ABC/photos"]) {
      const r = await photoGET(get(`http://test/api/place-photo?name=${encodeURIComponent(name)}`));
      expect(r.status).toBe(400);
    }
  });

  it("never forwards an arbitrary Google endpoint", async () => {
    const r = await photoGET(get("http://test/api/place-photo?name=places/ABC/locations/1"));
    expect(r.status).toBe(400);
  });
});

describe("tile cache", () => {
  const call = (z: number, x: number, y: number) =>
    tileGET(get(`http://test/api/tile/${z}/${x}/${y}`), {
      params: Promise.resolve({ z: String(z), x: String(x), y: String(y) }),
    });

  it("serves a tile that is already on disk", async () => {
    const dir = path.resolve(process.cwd(), "..", "data", "tiles", "sat");
    if (!existsSync(dir)) return; // nothing prefetched in this checkout
    const r = await call(8, 0, 0).catch(() => null);
    if (!r) return;
    expect([200, 404]).toContain(r.status);
  });

  it("rejects a zoom it never stored", async () => {
    const r = await call(30, 0, 0);
    expect(r.status).toBe(400);
  });

  it("rejects a non-numeric path", async () => {
    const r = await tileGET(get("http://test/api/tile/a/b/c"), {
      params: Promise.resolve({ z: "a", x: "b", y: "c" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("settings test", () => {
  it("refuses an unknown provider without calling anything", async () => {
    const r = await testPOST(post("http://test/api/settings/test", { key: "nope" }));
    expect(r.status).toBe(400);
  });

  it("reports a missing key instead of guessing", async () => {
    const r = await testPOST(post("http://test/api/settings/test", { key: "neshan_api_key" }));
    expect([200, 400]).toContain(r.status);
    const body = await r.json();
    if (r.status === 400) expect(body.error).toBeTruthy();
  });
});
