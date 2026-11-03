/**
 * Settlement search for «تحلیل هر منطقه» — the smallest thing that makes the report a feature
 * rather than a URL you have to know.
 *
 *   GET ?q=کوت            → up to 15 settlements, town-sized ones first
 *   GET ?area_id=212      → that one
 */
import { NextResponse } from "next/server";
import { all } from "@/lib/db";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const areaId = Number(q.get("area_id"));
  if (Number.isInteger(areaId) && areaId > 0) {
    const row = all(`SELECT area_id, name, county, kind, population, lat, lon
                       FROM v_map_settlement WHERE area_id = ?`, [areaId]);
    return NextResponse.json({ items: row });
  }
  const term = (q.get("q") ?? "").trim();
  if (term.length < 2) return NextResponse.json({ items: [] });
  const rows = all(
    `SELECT area_id, name, county, kind, population, lat, lon
       FROM v_map_settlement
      WHERE lat IS NOT NULL AND (name LIKE ? OR county LIKE ?)
      ORDER BY (kind = 'city') DESC, population DESC
      LIMIT 15`,
    [`%${term}%`, `%${term}%`],
  );
  return NextResponse.json({ items: rows });
}
