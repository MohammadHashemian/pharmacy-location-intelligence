/**
 * The regional report: computed facts for one settlement, plus the written analysis.
 *
 *   GET  ?area_id=212                 → the stored report (404 if it was never built)
 *   POST { area_id, llm? }            → rebuild it (runs etl/area_report.py), then return it
 *
 * The POST path is the only place the app shells out, and it only ever runs that one script
 * for one area — the numbers come from the database, never from the model.
 */
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import { all, one } from "@/lib/db";

function stored(areaId: number) {
  return one<{ payload: string; generated_at: string }>(
    "SELECT payload, generated_at FROM area_report WHERE area_id = ?", [areaId]);
}

export async function GET(req: Request) {
  const areaId = Number(new URL(req.url).searchParams.get("area_id"));
  if (!Number.isInteger(areaId) || areaId <= 0) {
    return NextResponse.json({ error: "area_id لازم است" }, { status: 400 });
  }
  const row = stored(areaId);
  if (!row) return NextResponse.json({ error: "گزارشی برای این منطقه ساخته نشده است" }, { status: 404 });
  return NextResponse.json({ ...JSON.parse(row.payload), generatedAt: row.generated_at });
}

function run(areaId: number, llm: boolean): Promise<number> {
  return new Promise((resolve) => {
    const args = ["etl/area_report.py", "--area-id", String(areaId)];
    if (llm) args.push("--llm");
    const child = spawn("python", args, {
      cwd: path.join(process.cwd(), ".."),
      windowsHide: true,
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { area_id?: unknown; llm?: unknown };
  const areaId = Number(body.area_id);
  if (!Number.isInteger(areaId)) {
    return NextResponse.json({ error: "area_id لازم است" }, { status: 400 });
  }
  const code = await run(areaId, body.llm !== false);
  const row = stored(areaId);
  if (code !== 0 && !row) {
    return NextResponse.json({ error: "ساخت گزارش ناموفق بود" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...JSON.parse(row!.payload), generatedAt: row!.generated_at });
}

/** Which areas already have a report — the map uses this to badge the option. */
export async function OPTIONS() {
  return NextResponse.json({ ready: all("SELECT area_id FROM area_report").map((r) => r.area_id) });
}
