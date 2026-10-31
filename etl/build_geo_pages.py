"""Build the Khuzestan geographic atlas: live map + network graph + distance ladder.

Reads only what the ETL produced (`web/public/geo/*.geojson`,
`data/derived/geo_network.json`, the SQLite views) and writes self-contained HTML:

  reports/khuzestan-atlas.html          full-detail standalone page
  reports/khuzestan-atlas-widget.html   compact twin for the chat preview pane

Everything is one file with the data embedded, so it opens straight from the
filesystem with no server and no build step. The only external request is the
OpenStreetMap basemap tiles — all vector layers, the network graph and the tables
work with no network at all.

Chart layout follows the project's rule (see the iran-pharmacy-capacity-data
skill): charts are drawn in CSS pixels from a measured container width, never
with a fixed viewBox that would scale the type as well as the geometry. Text is
rendered at a Persian-capable size and Persian digits are used throughout.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys

HOME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(HOME, "db", "pharmacy.sqlite")
GEO_DIR = os.path.join(HOME, "web", "public", "geo")
NET_PATH = os.path.join(HOME, "data", "derived", "geo_network.json")
DENSITY_PATH = os.path.join(HOME, "data", "derived", "geo_density.json")
OUT_FULL = os.path.join(HOME, "reports", "khuzestan-atlas.html")
OUT_WIDGET = os.path.join(HOME, "reports", "khuzestan-atlas-widget.html")

AHVAZ = (31.3203, 48.6693)


def s(v) -> str:
    """SQLite-safe string."""
    return "" if v is None else str(v)


def load_data() -> dict:
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    places = json.load(open(os.path.join(GEO_DIR, "khuzestan_places.geojson"),
                            encoding="utf-8"))
    bakhsh = json.load(open(os.path.join(GEO_DIR, "khuzestan_bakhsh.geojson"),
                            encoding="utf-8"))
    net = json.load(open(NET_PATH, encoding="utf-8"))
    if not os.path.exists(DENSITY_PATH):
        raise SystemExit("missing data/derived/geo_density.json — "
                         "run: python etl/build_geo_density.py")
    density = json.load(open(DENSITY_PATH, encoding="utf-8"))
    ladder = [dict(r) for r in c.execute("""
        SELECT * FROM v_geo_distance_bands ORDER BY band_km""")]
    summary = [dict(r) for r in c.execute("""
        SELECT status, COUNT(*) n,
               SUM(CASE WHEN place_kind IN ('city','town') THEN 1 ELSE 0 END) urban,
               SUM(CASE WHEN place_kind = 'neighbourhood' THEN 1 ELSE 0 END) nb,
               SUM(COALESCE(population_best,0)) pop
        FROM v_geo_place GROUP BY status""")]
    coverage = [dict(r) for r in c.execute("SELECT metric, value, detail FROM v_geo_coverage")]
    counties = [dict(r) for r in c.execute("""
        SELECT * FROM v_geo_county_rollup ORDER BY n_map_new DESC LIMIT 30""")]
    top_new = [dict(r) for r in c.execute("""
        SELECT name, place_kind, county, population_best, distance_km, road_km,
               pop_ref_source, pop_ref_url, dq_flags, intra_city, pop_suspect
        FROM v_geo_new_places
        WHERE size_unknown = 0 AND pop_suspect = 0 AND intra_city = 0
        ORDER BY population_best DESC LIMIT 40""")]
    variants = [dict(r) for r in c.execute("""
        SELECT name, place_kind, county, fda_place, fda_county, fda_population,
               n_pharmacy_total, match_score, match_method
        FROM v_geo_variants ORDER BY fda_population DESC LIMIT 60""")]
    sources = [dict(r) for r in c.execute("""
        SELECT layer, ref, licence, observed_at, element_count, notes
        FROM geo_sources ORDER BY id DESC LIMIT 6""")]
    c.close()
    return {"places": places, "bakhsh": bakhsh, "net": net, "ladder": ladder,
            "density": density, "summary": summary, "coverage": coverage,
            "counties": counties, "top_new": top_new, "variants": variants,
            "sources": sources}


def build_html(data: dict, compact: bool) -> str:
    # The compact twin keeps the same code path, just smaller payload.
    if compact:
        for f in data["bakhsh"]["features"]:
            coords = f["geometry"]["coordinates"]
            f["geometry"]["coordinates"] = coords[::3] + [coords[-1]]
        for f in data["places"]["features"]:
            p = f["properties"]
            # Only what the page actually reads. The 2.4 MB of GeoJSON is almost
            # entirely these property strings, so dropping the unused ones is what
            # makes the chat-sized twin manageable.
            for k in ("pop_match_method", "pop_match_score", "admin_method",
                      "admin_confidence", "match_method", "match_score",
                      "direction_from_ahvaz", "wikipedia", "name_en", "district",
                      "wilson", "pop_osm", "pop_wikidata", "pop_wikipedia",
                      "wikidata", "separation_m", "distance_band_km"):
                p.pop(k, None)
            for k in ("distance_km", "road_km", "road_minutes"):
                if p.get(k) is not None:
                    p[k] = round(p[k], 1)
        data["variants"] = data["variants"][:25]
        data["top_new"] = data["top_new"][:25]
        for n in data["net"]["nodes"]:
            for k in ("settlements_20km", "population_20km",
                      "settlements_50km", "population_50km"):
                n.pop(k, None)
            for k in ("distance_km", "road_km"):
                if n.get(k) is not None:
                    n[k] = round(n[k], 1)
        for c in data["density"]["cells"]:
            c.pop("city", None)
            c.pop("dehestan", None)
            c["lat"] = round(c["lat"], 3)
            c["lon"] = round(c["lon"], 3)

    blob = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return (TEMPLATE
            .replace("__DATA__", blob)
            .replace("__AHVAZ_LAT__", str(AHVAZ[0]))
            .replace("__AHVAZ_LON__", str(AHVAZ[1]))
            .replace("__COMPACT__", "true" if compact else "false")
            .replace("__BODY_BG__", "transparent" if compact else "radial-gradient(1200px 600px at 80% -10%, #1d2b4a 0%, #0b1020 55%, #080c17 100%)"))


TEMPLATE = r"""<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>اطلس مکانی خوزستان — یکپارچه‌سازی نقشه و دادهٔ داروخانه</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
  :root{
    --fg: var(--foreground, #e8eef7);
    --muted: var(--muted-foreground, #93a4bd);
    --acc: var(--accent, #4cc4ff);
    --bd: var(--border, rgba(255,255,255,.14));
    --card: var(--card, rgba(255,255,255,.05));
    --ok:#2fbf71; --warn:#e8a33d; --new:#e0529c; --fda:#4c8dff;
  }
  *{box-sizing:border-box}
  body{margin:0;background:__BODY_BG__;color:var(--fg);
       font-family:"Segoe UI",Tahoma,system-ui,sans-serif;font-size:13px}
  .app{padding:10px 12px}
  .head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between;
        margin-block-end:8px}
  .title{font-weight:700;font-size:15px}
  .sub{color:var(--muted);font-size:11.5px}
  .tabs{display:flex;gap:6px}
  .tab{border:1px solid var(--bd);background:var(--card);color:var(--fg);
       padding:5px 12px;border-radius:999px;cursor:pointer;font-family:inherit;font-size:12.5px}
  .tab[aria-selected="true"]{border-color:var(--acc);color:var(--acc)}
  .panel{display:none}
  .panel.on{display:block}
  .cards{display:flex;flex-wrap:wrap;gap:8px;margin-block-end:8px}
  .card{border:1px solid var(--bd);background:var(--card);border-radius:10px;
        padding:7px 10px;min-width:104px}
  .card b{display:block;font-size:17px;line-height:1.3}
  .card span{color:var(--muted);font-size:11px}
  .row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-block-end:8px}
  .row label{display:flex;gap:5px;align-items:center;color:var(--muted);font-size:12px}
  input[type=text],input[type=number],select{background:var(--card);border:1px solid var(--bd);
        color:var(--fg);border-radius:8px;padding:4px 8px;font-family:inherit;font-size:12px}
  #map{height:560px;border:1px solid var(--bd);border-radius:12px;overflow:hidden}
  .leaflet-popup-content{direction:rtl;text-align:right;font-family:"Segoe UI",Tahoma,sans-serif}
  .pop b{font-size:14px}
  .pop table{border-collapse:collapse;margin-block-start:4px}
  .pop td{padding:1px 4px;font-size:12px}
  .pop td:first-child{color:#667;white-space:nowrap}
  .lg{display:flex;flex-wrap:wrap;gap:12px;margin-block-start:6px;color:var(--muted);font-size:11.5px}
  .lg i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-inline-end:4px}
  .scroll{overflow:auto;max-height:520px;border:1px solid var(--bd);border-radius:12px}
  table.grid{width:100%;border-collapse:collapse;font-size:12px}
  table.grid th,table.grid td{padding:5px 7px;border-block-end:1px solid var(--bd);text-align:right;
        white-space:nowrap}
  table.grid th{position:sticky;top:0;background:var(--card);backdrop-filter:blur(6px);
        font-weight:600;color:var(--muted);z-index:2}
  .pill{border-radius:999px;padding:1px 7px;font-size:11px;border:1px solid var(--bd)}
  .p-new{color:var(--new);border-color:var(--new)}
  .p-match{color:var(--ok);border-color:var(--ok)}
  .p-var{color:var(--warn);border-color:var(--warn)}
  .warn{color:var(--warn)}
  .muted{color:var(--muted)}
  .chartwrap{position:relative;width:100%}
  svg{display:block;width:100%;overflow:visible}
  .note{color:var(--muted);font-size:11.5px;margin-block:6px 2px;line-height:1.7}
  .net-tip{position:absolute;pointer-events:none;background:rgba(8,14,26,.94);color:#fff;
      border:1px solid var(--bd);border-radius:8px;padding:6px 8px;font-size:12px;display:none;z-index:9}
  a{color:var(--acc)}
</style>
</head>
<body>
<div class="app">
  <div class="head">
    <div>
      <div class="title">اطلس مکانی استان خوزستان — نقشه، شبکهٔ فاصله، و مقایسه با فهرست سازمان غذا و دارو</div>
      <div class="sub" id="subline"></div>
    </div>
    <div class="tabs" role="tablist">
      <button class="tab" role="tab" data-tab="map" aria-selected="true">نقشهٔ زنده</button>
      <button class="tab" role="tab" data-tab="grow" aria-selected="false">گسترش از اهواز</button>
      <button class="tab" role="tab" data-tab="net" aria-selected="false">شبکه و فاصله</button>
      <button class="tab" role="tab" data-tab="tbl" aria-selected="false">جدول‌ها</button>
    </div>
  </div>

  <div class="cards" id="cards"></div>

  <section class="panel on" id="panel-map">
    <div class="row">
      <label>وضعیت:
        <select id="f-status">
          <option value="all">همه</option>
          <option value="new">تازه‌یافته (خارج از فهرست سازمان)</option>
          <option value="variant">نیازمند بازبینی (نام مشابه)</option>
          <option value="matched">منطبق با فهرست سازمان</option>
        </select></label>
      <label>نوع:
        <select id="f-kind">
          <option value="all">همه</option>
          <option value="city-t">شهر</option>
          <option value="village">روستا</option>
          <option value="hamlet">آبادی کوچک</option>
          <option value="neighbourhood">محلهٔ شهری</option>
        </select></label>
      <label>حداقل جمعیت <input type="number" id="f-pop" value="0" step="500" style="width:88px"></label>
      <label>حداکثر فاصله از اهواز <input type="number" id="f-dist" value="400" step="25" style="width:88px"></label>
      <label>جست‌وجوی نام <input type="text" id="f-q" placeholder="مثلاً: ملاشیه" style="width:130px"></label>
      <label><input type="checkbox" id="f-rings" checked> حلقه‌های فاصله</label>
      <label><input type="checkbox" id="f-bakhsh"> مرز بخش‌ها</label>
      <label><input type="checkbox" id="f-dens" checked> تراکم داروخانه (فقط مناطق مسکونی)</label>
    </div>
    <div id="map"></div>
    <div class="lg">
      <span><i style="background:var(--ok)"></i>منطبق با فهرست سازمان</span>
      <span><i style="background:var(--new)"></i>تازه‌یافته (پیشنهاد مکانیابی)</span>
      <span><i style="background:var(--warn)"></i>نام مشابه، نیازمند بازبینی</span>
      <span>اندازهٔ دایره ∝ جمعیت</span>
      <span>حلقه‌ها: ۲۵ / ۵۰ / ۷۵ / ۱۰۰ / ۱۵۰ کیلومتر از اهواز</span>
      <span id="shown"></span>
    </div>
    <div class="lg" id="densLegend"></div>
    <div class="note" id="mapnote"></div>
  </section>

  <section class="panel" id="panel-grow">
    <div class="row">
      <label>حداکثر فاصلهٔ شبکه از اهواز:
        <input type="range" id="g-dist" min="15" max="320" step="5" value="60" style="width:170px">
        <b id="g-distv">۶۰</b> کیلومتر</label>
      <label>حداقل جمعیت <input type="number" id="g-pop" value="5000" step="1000" style="width:92px"></label>
      <label><input type="checkbox" id="g-empty"> فقط جای بدون داروخانه</label>
      <label><input type="checkbox" id="g-sortgap"> ترتیب بر اساس شکاف</label>
    </div>
    <div class="cards" id="growCards"></div>
    <div class="scroll"><table class="grid" id="growTable"></table></div>
    <div class="note" id="grownote"></div>
  </section>

  <section class="panel" id="panel-net">
    <div class="chartwrap" id="netwrap">
      <svg id="netsvg"></svg>
      <div class="net-tip" id="nettip"></div>
    </div>
    <div class="note" id="netnote"></div>
    <div class="row" style="margin-block-start:10px">
      <button class="tab" id="btn-scatter">نمودار پراکندگی فاصله–جمعیت</button>
      <button class="tab" id="btn-net">گراف شبکه (درخت پوشای کمینه)</button>
    </div>
    <div class="chartwrap" id="scatterwrap" style="display:none"><svg id="scattersvg"></svg></div>
  </section>

  <section class="panel" id="panel-tbl">
    <div class="row"><b>بلندترین فاصله‌ها از اهواز (شهر و روستا)</b>
      <label>تعداد ردیف <input type="number" id="f-rows" value="30" min="5" max="200" step="5" style="width:70px"></label>
      <label><input type="checkbox" id="f-onlynew"> فقط تازه‌یافته‌ها</label></div>
    <div class="scroll"><table class="grid" id="distTable"></table></div>
    <div class="row" style="margin-block-start:10px"><b>نردبان فاصله از اهواز (حلقه‌های ۲۵ کیلومتری)</b></div>
    <div class="scroll" style="max-height:none"><table class="grid" id="ladderTable"></table></div>
    <div class="row" style="margin-block-start:10px"><b>کاندیداهای تازه‌یافته با بزرگ‌ترین جمعیت</b></div>
    <div class="scroll"><table class="grid" id="newTable"></table></div>
    <div class="row" style="margin-block-start:10px"><b>صف بازبینی: نام مشابه با یک ردیف سازمان</b></div>
    <div class="scroll"><table class="grid" id="varTable"></table></div>
    <div class="row" style="margin-block-start:10px"><b>منابع و پوشش</b></div>
    <div class="scroll" style="max-height:none"><table class="grid" id="srcTable"></table></div>
  </section>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const D = __DATA__;
window.__GEO_DATA = D;          // exposed for the headless verifier
const COMPACT = __COMPACT__;
const AHVAZ = [__AHVAZ_LAT__, __AHVAZ_LON__];
const FA = "۰۱۲۳۴۵۶۷۸۹";
const faNum = (v, dec=0) => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  let out = dec ? n.toFixed(dec) : Math.round(n).toString();
  const [ip, fp] = out.split(".");
  const grouped = ip.replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
  return (grouped + (fp ? "٫" + fp : "")).replace(/[0-9]/g, d => FA[+d]);
};
const faInt = v => faNum(v, 0);
const STATUS_FA = {matched:"منطبق", new:"تازه‌یافته", variant:"نیازمند بازبینی"};
const KIND_FA = {city:"شهر", town:"شهر", village:"روستا", hamlet:"آبادی",
                 isolated_dwelling:"مزرعه/آبادی تک", neighbourhood:"محلهٔ شهری"};
const COLOR = {matched:"#2fbf71", new:"#e0529c", variant:"#e8a33d"};
const esc = s => (s===null||s===undefined) ? "" : String(s).replace(/[&<>"]/g,
      c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

/* ---------- header + summary cards ---------- */
const P = D.places.features.map(f => Object.assign({}, f.properties, {lat:f.geometry.coordinates[1], lon:f.geometry.coordinates[0]}));
const totals = {};
P.forEach(p => { const t = totals[p.status] = totals[p.status] || {n:0, urban:0, pop:0, nb:0};
  t.n++; if (p.place_kind==="city"||p.place_kind==="town") t.urban++;
  if (p.place_kind==="neighbourhood") t.nb++; t.pop += (p.population_best||0); });
const cov = Object.fromEntries(D.coverage.map(r => [r.metric, r.value]));
document.getElementById("cards").innerHTML = [
  ["کل مکان‌های نقشه", faInt(P.length)],
  ["منطبق با فهرست سازمان", faInt((totals.matched||{}).n)],
  ["تازه‌یافته", faInt((totals.new||{}).n)],
  ["از آن، شهر/شهرک", faInt((totals.new||{}).urban)],
  ["نیازمند بازبینی", faInt((totals.variant||{}).n)],
  ["فهرست سازمان بدون معادل نقشه", faInt(cov.fda_places_not_on_map)],
  ["فهرست سازمان (کل خوزستان)", faInt(cov.fda_places_total)],
  ["جمعیت مکان‌های نقشه", faInt(P.reduce((a,p)=>a+(p.population_best||0),0))]
].map(([l,v]) => `<div class="card"><b>${v}</b><span>${l}</span></div>`).join("");
document.getElementById("subline").textContent =
  `منبع نقشه: OpenStreetMap (${faInt(cov.osm_places_raw)} شیء مکان، ${faInt(cov.osm_places_deduped)} مکان پس از حذف تکرارها) · `
  + `جمعیت: Wikidata و سرشماری ویکی‌پدیای فارسی · شهرستان‌ها: زنجیرهٔ P131 · مرجع فاصله: شهر اهواز`;

/* ---------- map ---------- */
const map = L.map("map", {zoomControl:true, preferCanvas:true}).setView(AHVAZ, 8);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {maxZoom:18, attribution:"© OpenStreetMap"}).addTo(map);
const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {maxZoom:18, attribution:"Esri"});
const bakhsh = L.geoJSON(D.bakhsh, {style:{color:"#7d8aa3",weight:1,fill:false,dashArray:"3 4"},
  onEachFeature:(f,l)=>l.bindTooltip(
    `${esc(f.properties.name)||""}${f.properties.county ? " — " + esc(f.properties.county) : ""}`,
    {sticky:true})});
const ringLayer = L.layerGroup();
[25,50,75,100,150].forEach(km => L.circle(AHVAZ, {radius:km*1000, color:"#4c8dff",
  weight:1, opacity:.5, fill:false, dashArray:"2 6"}).addTo(ringLayer)
  .bindTooltip(faInt(km)+" کیلومتر از اهواز", {sticky:true}));
ringLayer.addTo(map);
const ahvaz = L.circleMarker(AHVAZ, {radius:9, color:"#fff", weight:2, fillColor:"#ffd166",
  fillOpacity:1}).addTo(map).bindPopup("<div class='pop'><b>اهواز — مرجع فاصله</b><br>کلیهٔ فاصله‌ها از این نقطه اندازه‌گیری شده است.</div>");
const popMax = Math.max(1, ...P.map(p => p.population_best||0));
const mkRad = v => 2.6 + 9.5 * Math.sqrt(Math.max(v||0, 0)/popMax);
const markers = L.layerGroup().addTo(map);
const markerOf = new Map();
function popupHtml(p){
  const rows = [
    ["نوع", KIND_FA[p.place_kind] || p.place_kind],
    ["شهرستان", p.county],
    ["بخش", p.district],
    ["جمعیت", p.population_best ? faInt(p.population_best) : "ثبت‌نشده"],
    ["منبع جمعیت", p.pop_ref_source === "wikidata" ? "ویکی‌داده (P1082)"
        : p.pop_ref_source === "wikipedia-census" ? "سرشماری — ویکی‌پدیای فارسی"
        : p.pop_ref_source === "osm-tag" ? "برچسب نقشه" : "—"],
    ["سال سرشماری", p.pop_ref_year_sh ? faInt(p.pop_ref_year_sh) : "—"],
    ["فاصلهٔ هوایی از اهواز", p.distance_km !== null ? faNum(p.distance_km,1)+" کیلومتر" : "—"],
    ["فاصلهٔ جاده‌ای", p.road_km ? faNum(p.road_km,1)+" کیلومتر"+(p.road_minutes? " ("+faInt(p.road_minutes)+" دقیقه)":"") : "محاسبه نشده"],
    ["وضعیت", STATUS_FA[p.status] || p.status]
  ];
  if (p.status === "matched") rows.push(["ردیف سازمان", `${p.fda_place} — ${p.fda_county} — ${faInt(p.fda_population)} نفر — ${faInt(p.n_pharmacy_total)} داروخانه`]);
  if (p.status === "variant") rows.push(["ردیف مشابه در سازمان", `${p.fda_place} — ${p.fda_county}`]);
  if (p.dq_flags) rows.push(["هشدار", esc(p.dq_flags)]);
  const cite = p.pop_ref_url ? `<div style="margin-top:4px"><a href="${esc(p.pop_ref_url)}" target="_blank">مأخذ جمعیت</a></div>` : "";
  return `<div class="pop"><b>${esc(p.name)}</b> <span class="pill p-${{matched:"match",new:"new",variant:"var"}[p.status]}">${STATUS_FA[p.status]||p.status}</span>
    <table>${rows.map(([k,v])=>`<tr><td>${k}</td><td>${v===null||v===undefined||v===""?"—":esc(v)}</td></tr>`).join("")}</table>${cite}</div>`;
}
function passes(p){
  const st = document.getElementById("f-status").value, kd = document.getElementById("f-kind").value;
  const minPop = +document.getElementById("f-pop").value || 0;
  const maxD = +document.getElementById("f-dist").value || 1e9;
  const q = document.getElementById("f-q").value.trim();
  if (st !== "all" && p.status !== st) return false;
  if (kd === "city-t" && !(p.place_kind === "city" || p.place_kind === "town")) return false;
  if (kd === "village" && p.place_kind !== "village") return false;
  if (kd === "hamlet" && p.place_kind !== "hamlet" && p.place_kind !== "isolated_dwelling") return false;
  if (kd === "neighbourhood" && p.place_kind !== "neighbourhood") return false;
  if ((p.population_best||0) < minPop) return false;
  if ((p.distance_km||0) > maxD) return false;
  if (q && !(p.name||"").includes(q) && !(p.county||"").includes(q)) return false;
  return true;
}
function redraw(){
  markers.clearLayers(); markerOf.clear();
  const shown = P.filter(passes);
  shown.forEach(p => {
    const m = L.circleMarker([p.lat,p.lon], {radius:mkRad(p.population_best),
      color: "#ffffff88", weight: .6, fillColor: COLOR[p.status]||"#888",
      fillOpacity: .85});
    m.bindPopup(popupHtml(p), {maxWidth:340, minWidth:240});
    m.bindTooltip(esc(p.name), {sticky:true});
    m.addTo(markers); markerOf.set(p, m);
  });
  document.getElementById("shown").textContent = `نمایش: ${faInt(shown.length)} از ${faInt(P.length)} مکان`;
  if (shown.length && shown.length <= 400){
    const g = L.featureGroup(shown.map(p => markerOf.get(p)));
    map.fitBounds(g.getBounds().pad(0.05), {maxZoom:11});
  }
}
["f-status","f-kind","f-pop","f-dist"].forEach(id =>
  document.getElementById(id).addEventListener("change", redraw));
document.getElementById("f-q").addEventListener("input", redraw);
document.getElementById("f-rings").addEventListener("change", e =>
  e.target.checked ? ringLayer.addTo(map) : map.removeLayer(ringLayer));
document.getElementById("f-bakhsh").addEventListener("change", e =>
  e.target.checked ? bakhsh.addTo(map) : map.removeLayer(bakhsh));
redraw();
document.getElementById("mapnote").innerHTML =
 `شهرستان‌های نقشه از زنجیرهٔ P131 ویکی‌داده می‌آیند، چون نگاشت خوزستان در OpenStreetMap سطح شهرستان ندارد`
 + ` (۶۷ رابطه در سطح <span class="muted">admin_level=6</span>، همه با نام «بخش …»).`
 + ` «تازه‌یافته» یعنی نام و شهرستان آن در فهرست سازمان غذا و دارو پیدا نشد؛`
 + ` مکان‌های مبهم (نام یکسان با شهرستان متفاوت، یا نام با یک حرف اختلاف) در گروه «نیازمند بازبینی» نگه داشته شده‌اند تا به‌اشتباه تازه‌یافته شمرده نشوند.`;

/* ---------- tabs ---------- */
document.querySelectorAll(".tab[data-tab]").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll(".tab[data-tab]").forEach(x => x.setAttribute("aria-selected","false"));
  b.setAttribute("aria-selected","true");
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("on"));
  document.getElementById("panel-" + b.dataset.tab).classList.add("on");
  if (b.dataset.tab !== "map") { drawNet(); }
  map.invalidateSize();
}));

/* ---------- network graph (measured, CSS pixels) ---------- */
const N = D.net;
const COSLAT = Math.cos(31.5 * Math.PI / 180);   // lon degrees are ~0.85 of lat ones here
function projX(lon, minLon, maxLon, W){ return (lon - minLon)*COSLAT/((maxLon-minLon)*COSLAT) * W; }
function projY(lat, minLat, maxLat, H){ return H - (lat - minLat)/(maxLat-minLat) * H; }
function svgEl(tag, attrs){ const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]); return e; }
let netMode = "graph";
function drawNet(){
  const wrap = document.getElementById("netwrap");
  const W = Math.max(360, wrap.clientWidth), H = Math.round(Math.min(560, Math.max(360, W*0.62)));
  drawGraph(W,H);
  if (netMode === "scatter"){ document.getElementById("scatterwrap").style.display="block";
    drawScatter(Math.max(360, document.getElementById("scatterwrap").clientWidth), 330); }
}
function drawGraph(W,H){
  const svg = document.getElementById("netsvg");
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  svg.removeAttribute("viewBox"); svg.innerHTML = "";
  const nodes = N.nodes;   // the exporter already dropped the population outliers
  if (!nodes.length) return;
  const pad = 26;
  const lons = nodes.map(n=>n.lon), lats = nodes.map(n=>n.lat);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const iw = W - pad*2, ih = H - pad*2;
  const px = n => pad + projX(n.lon, minLon, maxLon, iw);
  const py = n => pad + projY(n.lat, minLat, maxLat, ih);
  const g = svgEl("g", {});
  const maxE = Math.max(1, ...N.edges.map(e=>e.km));
  N.edges.forEach(e => {
    const a = nodes[e.a], b = nodes[e.b];
    if (!a || !b) return;
    g.appendChild(svgEl("line", {x1:px(a), y1:py(a), x2:px(b), y2:py(b),
      stroke: netMode==="graph" ? "#6f87b0" : "#6f87b0",
      "stroke-width": (0.6 + 1.8*(1 - e.km/maxE)).toFixed(2), "stroke-opacity": .7}));
  });
  const popMax = Math.max(1, ...nodes.map(n=>n.pop||0));
  const towns = [];
  nodes.forEach((n,i) => {
    const big = n.place_kind === "city" || n.place_kind === "town";
    const r = 1.6 + 5.2*Math.sqrt((n.pop||0)/popMax) + (big ? 1.6 : 0);
    const c = n.distance_km < 50 ? "#ffd166" : n.distance_km < 100 ? "#7ee787"
            : n.distance_km < 150 ? "#4cc4ff" : "#c792ea";
    const c0 = svgEl("circle", {cx:px(n), cy:py(n), r:r.toFixed(2),
      fill: n.status === "new" ? c : c, "fill-opacity": big? .95 : .7,
      stroke: n.status === "new" ? "#e0529c" : (big ? "#fff" : "none"),
      "stroke-width": big ? 1.3 : 1});
    c0.dataset.i = i; g.appendChild(c0);
    if ((n.pop||0) >= 90000 || n.name === "اهواز") towns.push(n);
  });
  const A = {name:"اهواز", lat:AHVAZ[0], lon:AHVAZ[1], pop:1184788, distance_km:0,
             status:"matched", county:"شهرستان اهواز", place_kind:"city"};
  g.appendChild(svgEl("circle", {cx:px(A), cy:py(A), r:8, fill:"none", stroke:"#fff",
    "stroke-width":2}));
  towns.forEach(t => {
    const label = svgEl("text", {x:px(t)+7, y:py(t)-6, style:"fill:var(--fg)", "font-size":"11.5px",
      direction:"rtl", "font-family":"Tahoma, Segoe UI, sans-serif"});
    label.textContent = t.name; g.appendChild(label);
  });
  svg.appendChild(g);
  const tip = document.getElementById("nettip");
  svg.onmousemove = ev => {
    const t = ev.target;
    if (t.tagName !== "circle" || t.dataset.i === undefined){ tip.style.display="none"; return; }
    const n = nodes[+t.dataset.i];
    tip.style.display = "block";
    tip.style.left = (ev.offsetX + 12) + "px"; tip.style.top = (ev.offsetY + 8) + "px";
    tip.innerHTML = `<b>${esc(n.name)}</b><br>${KIND_FA[n.place_kind]||""} — ${STATUS_FA[n.status]||""}<br>`
      + `جمعیت ${faInt(n.pop)}<br>فاصله از اهواز ${faNum(n.distance_km,1)} کیلومتر<br>`
      + `سکونتگاه در ۳۰ کیلومتر: ${faInt(n.settlements_30km)}<br>جمعیت ۳۰ کیلومتر: ${faInt(n.population_30km)}`;
  };
  svg.onmouseleave = () => tip.style.display = "none";
  document.getElementById("netnote").innerHTML =
    `گراف: ${faInt(N.meta.node_count)} سکونتگاه (شهر/روستا) و ${faInt(N.meta.edge_count)} یال `
    + `(${N.meta.edge_rule}). لبه‌ها در واقعیت نقشه رسم شده‌اند، پس گراف شکل شبکهٔ تراکم جمعیت را نشان می‌دهد. `
    + `رنگ دایره‌ها = فاصلهٔ هوایی از اهواز (زرد < ۵۰، سبز < ۱۰۰، آبی < ۱۵۰، بنفش ≥ ۱۵۰ کیلومتر)؛ `
    + `حاشیهٔ بنفش = مکان تازه‌یافته (بدون ردیف در فهرست سازمان).`;
}
function drawScatter(W,H){
  const svg = document.getElementById("scattersvg");
  svg.setAttribute("width", W); svg.setAttribute("height", H); svg.innerHTML = "";
  const pts = P.filter(p => (p.population_best||0) > 0 && p.place_kind !== "neighbourhood");
  if (!pts.length) return;
  const padL = 56, padR = 16, padT = 18, padB = 34;
  const maxD = Math.max(...pts.map(p=>p.distance_km||0));
  const maxP = Math.max(...pts.map(p=>p.population_best));
  const X = d => padL + (d/maxD) * (W-padL-padR);
  const Y = v => H-padB - (Math.log10(Math.max(v,10))/Math.log10(maxP)) * (H-padT-padB);
  for (let i=0;i<=5;i++){
    const v = Math.pow(10, Math.log10(maxP)*i/5);
    const y = Y(v);
    svg.appendChild(svgEl("line", {x1:padL, y1:y, x2:W-padR, y2:y, stroke:"#ffffff22"}));
    const t = svgEl("text", {x:padL-6, y:y+4, style:"fill:var(--muted)", "font-size":"11px",
      "text-anchor":"end", direction:"ltr"}); t.textContent = faInt(v); svg.appendChild(t);
  }
  [0,50,100,150,200,250].filter(d=>d<=maxD).forEach(d => {
    const x = X(d);
    svg.appendChild(svgEl("line", {x1:x, y1:padT, x2:x, y2:H-padB, stroke:"#ffffff14"}));
    const t = svgEl("text", {x:x, y:H-padB+16, style:"fill:var(--muted)", "font-size":"11px",
      "text-anchor":"middle"}); t.textContent = faInt(d); svg.appendChild(t);
  });
  pts.forEach(p => {
    svg.appendChild(svgEl("circle", {cx:X(p.distance_km||0), cy:Y(p.population_best),
      r: (p.place_kind==="city"||p.place_kind==="town") ? 4 : 2.4,
      fill: COLOR[p.status], "fill-opacity":.75}));
  });
  const xl = svgEl("text", {x:(padL+W-padR)/2, y:H-4, style:"fill:var(--muted)", "font-size":"11.5px",
    "text-anchor":"middle"}); xl.textContent = "فاصلهٔ هوایی از اهواز (کیلومتر)"; svg.appendChild(xl);
  const yl = svgEl("text", {x:12, y:H/2, style:"fill:var(--muted)", "font-size":"11.5px",
    "text-anchor":"middle", transform:`rotate(-90 12 ${H/2})`});
  yl.textContent = "جمعیت (مقیاس لگاریتمی)"; svg.appendChild(yl);
}
document.getElementById("btn-scatter").onclick = () => {
  netMode = netMode === "scatter" ? "graph" : "scatter";
  document.getElementById("scatterwrap").style.display = netMode === "scatter" ? "block" : "none";
  drawNet();
};
document.getElementById("btn-net").onclick = () => { netMode = "graph";
  document.getElementById("scatterwrap").style.display = "none"; drawNet(); };
let rt = null;
new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(drawNet, 160); })
  .observe(document.getElementById("netwrap"));

/* ---------- tables ---------- */
function table(el, cols, rows){
  document.getElementById(el).innerHTML =
    "<thead><tr>" + cols.map(c=>`<th>${c[0]}</th>`).join("") + "</tr></thead><tbody>"
    + rows.map(r => "<tr>" + cols.map(c=>`<td>${c[1](r)}</td>`).join("") + "</tr>").join("")
    + "</tbody>";
}
const pill = st => `<span class="pill p-${{matched:"match",new:"new",variant:"var"}[st]||"match"}">${STATUS_FA[st]||st}</span>`;
function drawDist(){
  const onlyNew = document.getElementById("f-onlynew").checked;
  const n = +document.getElementById("f-rows").value || 30;
  let rows = P.filter(p => p.place_kind !== "neighbourhood" && (!onlyNew || p.status === "new"));
  rows.sort((a,b) => (b.distance_km||0)-(a.distance_km||0));
  rows = rows.slice(0, n);
  table("distTable", [
    ["نام", r=>esc(r.name)], ["نوع", r=>KIND_FA[r.place_kind]||""],
    ["شهرستان", r=>esc(r.county)],
    ["جمعیت", r=>faInt(r.population_best)], ["منبع", r=>r.pop_ref_source||"—"],
    ["هوایی (کم)", r=>faNum(r.distance_km,1)],
    ["جاده‌ای (کم)", r=>r.road_km? faNum(r.road_km,1) : "—"],
    ["زمان (دقیقه)", r=>r.road_minutes? faInt(r.road_minutes) : "—"],
    ["جهت", r=>r.direction_from_ahvaz||""],
    ["وضعیت", r=>pill(r.status)]
  ], rows);
}
document.getElementById("f-rows").addEventListener("change", drawDist);
document.getElementById("f-onlynew").addEventListener("change", drawDist);
drawDist();
table("ladderTable", [
  ["حلقه (کیلومتر)", r=>r.distance_band_fa],
  ["تعداد مکان", r=>faInt(r.n_places)],
  ["شهر/شهرک", r=>faInt(r.n_urban)],
  ["تازه‌یافته", r=>faInt(r.n_new)],
  ["جمعیت", r=>faInt(r.population)],
  ["داروخانهٔ ثبت‌شده", r=>faInt(r.n_pharmacies)]
], D.ladder);
table("newTable", [
  ["نام", r=>esc(r.name)], ["نوع", r=>KIND_FA[r.place_kind]||""], ["شهرستان", r=>esc(r.county)],
  ["جمعیت", r=>faInt(r.population_best)], ["منبع جمعیت", r=>r.pop_ref_source||"—"],
  ["فاصله (کم)", r=>faNum(r.distance_km,1)], ["مأخذ", r=>r.pop_ref_url? `<a href="${esc(r.pop_ref_url)}" target="_blank">صفحه</a>`:"—"],
  ["هشدار", r=>r.dq_flags? `<span class="warn">${esc(r.dq_flags)}</span>`:"—"]
], D.top_new);
table("varTable", [
  ["نام روی نقشه", r=>esc(r.name)], ["نوع", r=>KIND_FA[r.place_kind]||""],
  ["شهرستان نقشه", r=>esc(r.county)],
  ["ردیف سازمان", r=>esc(r.fda_place)], ["شهرستان سازمان", r=>esc(r.fda_county)],
  ["جمعیت سازمان", r=>faInt(r.fda_population)], ["داروخانه", r=>faInt(r.n_pharmacy_total)],
  ["دلیل", r=>`<span class="muted">${esc(r.match_method)}</span>`]
], D.variants);
table("srcTable", [
  ["لایه", r=>r.layer], ["مأخذ", r=>`<span class="muted">${esc(r.ref)}</span>`],
  ["مجوز", r=>r.licence], ["زمان برداشت", r=>r.observed_at],
  ["تعداد عنصر", r=>faInt(r.element_count)], ["یادداشت", r=>`<span class="muted">${esc(r.notes)}</span>`]
], D.sources.concat(D.coverage.map(c => ({layer:"شمارنده", ref:c.metric, licence:"—",
  observed_at:"—", element_count:c.value, notes:c.detail}))));
</script>
</body>
</html>
"""


def check_js(html: str) -> None:
    """Parse the inline script with node before shipping it.

    A single misplaced quote inside one of the many template literals produced a
    file that loaded Leaflet fine and then did nothing, with the error only
    visible in the browser console. `node --check` catches that class of mistake
    at build time instead.
    """
    import re
    import shutil
    import subprocess
    import tempfile

    if not shutil.which("node"):
        return
    m = re.search(r"<script>\n(const D = .*?)</script>", html, re.S)
    if not m:
        raise SystemExit("could not locate the inline script to check")
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False,
                                     encoding="utf-8") as fh:
        fh.write(m.group(1))
        path = fh.name
    try:
        r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit("generated JavaScript does not parse:\n" + r.stderr[:2000])
    finally:
        os.unlink(path)


def main() -> int:
    data = load_data()
    for compact, out in ((False, OUT_FULL), (True, OUT_WIDGET)):
        html = build_html(data, compact)
        check_js(html)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        open(out, "w", encoding="utf-8").write(html)
        print(f"wrote {out}  ({os.path.getsize(out)/1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
