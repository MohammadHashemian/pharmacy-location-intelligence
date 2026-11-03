/**
 * The API routes, called as functions.
 *
 * Every handler is a normal async function taking a `Request`, so a test can hand it one and
 * read the JSON back — no server, no port, and the same code path Next runs in production.
 * Writes go to the copy of the database that `tests/setup.ts` points at.
 */
import { describe, expect, it } from "vitest";
import { GET as checksGET, POST as checksPOST, DELETE as checksDELETE } from "@/app/api/checks/route";
import { GET as capGET, POST as capPOST } from "@/app/api/capacity/route";
import { GET as densGET } from "@/app/api/density/route";
import { GET as prospGET, POST as prospPOST, PATCH as prospPATCH, PUT as prospPUT, DELETE as prospDELETE } from "@/app/api/prospects/route";
import { GET as survGET, POST as survPOST, PATCH as survPATCH, DELETE as survDELETE } from "@/app/api/surveys/route";
import { GET as shortGET, POST as shortPOST, DELETE as shortDELETE } from "@/app/api/shortlist/route";
import { GET as popGET, POST as popPOST, DELETE as popDELETE } from "@/app/api/population/route";
import { GET as phGET, POST as phPOST, PATCH as phPATCH, DELETE as phDELETE } from "@/app/api/pharmacies/route";
import { GET as setGET, POST as setPOST } from "@/app/api/settings/route";
import { GET as measGET, POST as measPOST, DELETE as measDELETE } from "@/app/api/measure/route";
import { POST as ovPOST, DELETE as ovDELETE } from "@/app/api/overrides/route";
import { all } from "@/lib/db";

const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const req = (url: string, body?: unknown, method = "POST") =>
  new Request(`http://test${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("GET /api/capacity", () => {
  it("returns metrics, a ranking and the unknown list", async () => {
    const { status, body } = await json(await capGET(req("/api/capacity")));
    expect(status).toBe(200);
    expect(body.metrics.length).toBeGreaterThan(5);
    expect(body.room.length).toBeGreaterThan(0);
    const keys = body.metrics.map((m: { key: string }) => m.key);
    expect(keys).toContain("builtup_km2");
    expect(keys).toContain("benchmark");
  });

  it("refuses a benchmark outside the plausible band", async () => {
    const { status } = await json(await capPOST(req("/api/capacity", { benchmark: 10 })));
    expect(status).toBe(400);
  });
});

describe("GET /api/density", () => {
  it("answers for a viewport and refuses a broken bbox", async () => {
    const ok = await json(await densGET(req("/api/density?bbox=31.25,48.60,31.40,48.75", undefined, "GET")));
    expect(ok.status).toBe(200);
    expect(ok.body.cells.length).toBeGreaterThan(100);
    expect(ok.body.benchmark).toBeGreaterThan(0);

    const bad = await json(await densGET(req("/api/density?bbox=1", undefined, "GET")));
    expect(bad.status).toBe(400);
  });
});

describe("checks", () => {
  it("marks a place, lists it, and unmarks it", async () => {
    const add = await json(await checksPOST(req("/api/checks", { kind: "settlement", ref: "999001" })));
    expect(add.status).toBe(200);
    expect(add.body.checked).toBe(true);

    const list = await json(await checksGET());
    expect(list.body.items.some((i: { ref: string }) => i.ref === "999001")).toBe(true);

    await checksPOST(req("/api/checks", { kind: "settlement", ref: "999001", checked: false }));
    const after = await json(await checksGET());
    expect(after.body.items.some((i: { ref: string }) => i.ref === "999001")).toBe(false);

    const del = await json(await checksDELETE(req("/api/checks?kind=settlement&ref=999001", undefined, "DELETE")));
    expect(del.status).toBe(200);
  });

  it("rejects an unknown kind", async () => {
    const { status } = await json(await checksPOST(req("/api/checks", { kind: "planet", ref: "1" })));
    expect(status).toBe(400);
  });
});

describe("prospects", () => {
  it("creates, edits, reorders and deletes", async () => {
    const made = await json(await prospPOST(req("/api/prospects", {
      name: "آزمون مکان API", lat: 31.3, lon: 48.6, priority: 3,
    })));
    expect(made.status).toBe(200);
    const id = made.body.id;

    const patched = await json(await prospPATCH(req("/api/prospects", { id, status: "visited", priority: 7 })));
    expect(patched.status).toBe(200);

    const list = await json(await prospGET());
    const row = list.body.items.find((i: { id: number }) => i.id === id);
    expect(row.status).toBe("visited");
    expect(row.priority).toBe(7);

    const del = await json(await prospDELETE(req(`/api/prospects?id=${id}`, undefined, "DELETE")));
    expect(del.status).toBe(200);
  });

  it("appends a new place to the end of the trip, with no cap", async () => {
    const made: number[] = [];
    for (const name of ["آزمون الف", "آزمون ب", "آزمون ج"]) {
      const r = await json(await prospPOST(req("/api/prospects", { name, lat: 31.3, lon: 48.6 })));
      made.push(r.body.id);
    }
    const list = await json(await prospGET());
    const mine = list.body.items.filter((i: { id: number }) => made.includes(i.id));
    // three appends → three increasing priorities, none of them clamped to a fixed menu
    expect(mine.length).toBe(3);
    const priorities = mine.map((i: { priority: number }) => i.priority);
    expect(Math.max(...priorities) - Math.min(...priorities)).toBe(2);

    // drag order = the sequence the UI sends
    const reordered = await json(await prospPUT(req("/api/prospects", {
      ids: [made[2], made[0], made[1]],
    })));
    expect(reordered.status).toBe(200);
    const after = await json(await prospGET());
    const byId = new Map<number, number>(
      after.body.items.map((i: { id: number; priority: number }) => [i.id, i.priority]));
    expect(byId.get(made[2])!).toBeLessThan(byId.get(made[0])!);

    for (const id of made) await prospDELETE(req(`/api/prospects?id=${id}`, undefined, "DELETE"));
  });

  it("refuses an order payload that is not a list of ids", async () => {
    expect((await json(await prospPUT(req("/api/prospects", { ids: [] })))).status).toBe(400);
    expect((await json(await prospPUT(req("/api/prospects", { ids: ["a"] })))).status).toBe(400);
  });

  it("refuses a place without a name", async () => {
    const { status } = await json(await prospPOST(req("/api/prospects", { name: "", lat: 31, lon: 48 })));
    expect(status).toBe(400);
  });

  it("refuses a patch with no id", async () => {
    const { status } = await json(await prospPATCH(req("/api/prospects", { status: "todo" })));
    expect(status).toBe(400);
  });
});

describe("surveys", () => {
  const poly = [[31.30, 48.66], [31.31, 48.66], [31.31, 48.67]];

  it("draws, renames and deletes an area", async () => {
    const made = await json(await survPOST(req("/api/surveys", { name: "آزمون محدوده API", points: poly })));
    expect(made.status).toBe(200);
    const id = made.body.id;

    const renamed = await json(await survPATCH(req("/api/surveys", { id, name: "آزمون نام تازه" })));
    expect(renamed.status).toBe(200);

    const list = await json(await survGET());
    expect(list.body.items.find((a: { id: number }) => a.id === id).name).toBe("آزمون نام تازه");

    await survDELETE(req(`/api/surveys?id=${id}`, undefined, "DELETE"));
  });

  it("needs three points and a real name", async () => {
    expect((await json(await survPOST(req("/api/surveys", { name: "آزمون", points: [[1, 2]] })))).status).toBe(400);
    expect((await json(await survPOST(req("/api/surveys", { name: "x", points: poly })))).status).toBe(400);
  });
});

describe("shortlist", () => {
  it("adds a candidate and removes it", async () => {
    const top = all<{ rank: number }>("SELECT rank FROM site_candidate ORDER BY rank LIMIT 1")[0];
    const made = await json(await shortPOST(req("/api/shortlist", { rank: top.rank })));
    expect(made.status).toBe(200);

    const list = await json(await shortGET());
    expect(list.body.items.length).toBeGreaterThan(0);

    for (const it of list.body.items) {
      await shortDELETE(req(`/api/shortlist?id=${it.id}`, undefined, "DELETE"));
    }
    const empty = await json(await shortGET());
    expect(empty.body.items.length).toBe(0);
  });
});

describe("population override", () => {
  it("sets a manual value, reads it back and clears it", async () => {
    const s = all<{ area_id: number }>(
      "SELECT area_id FROM v_admin_area_current WHERE area_id IS NOT NULL LIMIT 1")[0];
    const set = await json(await popPOST(req("/api/population", { areaId: s.area_id, value: 12345 })));
    expect(set.status).toBe(200);

    const list = await json(await popGET());
    expect(list.body.items.some((i: { areaId: number }) => i.areaId === s.area_id)).toBe(true);

    await popDELETE(req(`/api/population?areaId=${s.area_id}`, undefined, "DELETE"));
    const after = await json(await popGET());
    expect(after.body.items.some((i: { areaId: number }) => i.areaId === s.area_id)).toBe(false);
  });
});

describe("manual places", () => {
  it("adds a clinic, edits it and deletes it", async () => {
    const made = await json(await phPOST(req("/api/pharmacies", {
      kind: "clinic", name: "آزمون درمانگاه", lat: 31.3, lon: 48.6,
    })));
    expect(made.status).toBe(200);
    const id = made.body.id;

    const patched = await json(await phPATCH(req("/api/pharmacies", { id, name: "آزمون درمانگاه ۲" })));
    expect(patched.status).toBe(200);

    const list = await json(await phGET());
    expect(list.status).toBe(200);

    await phDELETE(req(`/api/pharmacies?id=${id}`, undefined, "DELETE"));
  });

  it("rejects an unknown kind", async () => {
    const { status } = await json(await phPOST(req("/api/pharmacies", {
      kind: "casino", name: "آزمون", lat: 31, lon: 48,
    })));
    expect(status).toBe(400);
  });
});

describe("settings", () => {
  it("never returns a full key", async () => {
    const { status, body } = await json(await setGET());
    expect(status).toBe(200);
    for (const p of body.providers) {
      expect(JSON.stringify(p)).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    }
  });

  it("refuses an unknown provider and a key that is obviously not one", async () => {
    expect((await json(await setPOST(req("/api/settings", { key: "nope", value: "abcdefgh" })))).status).toBe(400);
    expect((await json(await setPOST(req("/api/settings", { key: "openrouter_api_key", value: "short" })))).status).toBe(400);
  });
});

describe("measure", () => {
  it("estimates a polygon and refuses a broken one", async () => {
    const good = await json(await measPOST(req("/api/measure", {
      points: [[31.30, 48.66], [31.31, 48.66], [31.31, 48.67], [31.30, 48.67]],
    })));
    expect(good.status).toBe(200);
    expect(good.body.metrics.areaKm2).toBeGreaterThan(0.5);
    expect(good.body.metrics.population).toBeGreaterThan(0);

    const bad = await json(await measPOST(req("/api/measure", { points: [[1, 2]] })));
    expect(bad.status).toBe(400);
  });

  it("lists and deletes saved measurements", async () => {
    const list = await json(await measGET());
    expect(list.status).toBe(200);
    for (const m of list.body.items) {
      if (String(m.name).startsWith("آزمون")) {
        await measDELETE(req(`/api/measure?id=${m.id}`, undefined, "DELETE"));
      }
    }
  });
});

describe("overrides", () => {
  it("rejects a bad payload and a field the model does not read", async () => {
    expect((await json(await ovPOST(req("/api/overrides", {})))).status).toBe(400);
    expect((await json(await ovPOST(req("/api/overrides", {
      location_id: 1, field: "is_market", value: 1,
    })))).status).toBe(400);
  });

  it("journals a real override and can remove it again", async () => {
    const row = all<{ location_id: number }>("SELECT location_id FROM v_latest_snapshot LIMIT 1")[0];
    const set = await json(await ovPOST(req("/api/overrides", {
      location_id: row.location_id, field: "population", value: 4321, note: "آزمون",
    })));
    expect(set.status).toBe(200);
    const journal = all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM manual_override WHERE location_id = ?", [row.location_id])[0];
    expect(journal.n).toBeGreaterThan(0);
    const del = await json(await ovDELETE(req("/api/overrides", {
      location_id: row.location_id, field: "population",
    }, "DELETE")));
    expect(del.status).toBe(200);
  });
});
