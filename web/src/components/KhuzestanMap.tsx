"use client";

import { useRouter } from "next/navigation";

/**
 * Interactive map of استان خوزستان.
 *
 * Everything is drawn from the data, no tile server and no map library:
 *
 *   • بخش / دهستان polygons   filled administrative ground
 *   • density cells           one rect per residential grid cell (a cell exists
 *                             only near a settlement, so no colour can land in
 *                             the desert, the salt flats or the Zagros)
 *   • spanning tree           the settlement graph the network distance is
 *                             walked on — visible so the number is traceable
 *   • settlement dots         named شهر/روستا, sized by population, with the
 *                             live pharmacy count in the tooltip and the panel
 *
 * The expansion control is the point of the page: start at اهواز, grow the
 * radius ring by ring, and read the candidate list — nearest first or biggest
 * gap first — instead of trusting a single opaque score.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { MapCell, MapData, MapSettlement, MapShape } from "@/lib/map";
import { group, num, shortCounty, toPersianDigits } from "@/lib/format";
import { PlacePanel } from "@/components/PharmacyPanel";
import { ShortlistPanel } from "@/components/ShortlistPanel";
import { VisitPanel, SurveyPanel, MeasurePanel, nextStatus } from "@/components/AnnotationPanels";

const W = 660;
const H = 820;
const PAD = 14;
/* 40x put the map at ~12 m/px — Esri zoom 14, which is «aerial photo», not «I can see
   the roof». Detail is a function of the scene scale (194 units per degree), so 600x
   lands near 0.7 m/px and the tile loader below asks for z18-19 there. */
const MAX_ZOOM = 600;
const RING_EDGES = [25, 50, 75, 100, 150, 200, 300];

/* Marker sizes are radii in CSS px. They grow a little with zoom so a diamond is
   findable at 1x, then stop: at 8x a 14 px diamond covered the street detail and
   clusters of them merged into one blob. 9-10 px diameter is the size a map marker
   wants. */
const pharmRadiusPx = (k: number) => {
  const base = 2.4 + Math.min(1.4, Math.log2(Math.max(1, k)) * 0.5);
  /* Above 12x you are looking for a shop, not a province: 7.6 px diamonds got lost
     among the street lattice, which is exactly the «none of the pharmacies are
     displayed» report from Golestan. */
  return base + (k >= 12 ? Math.min(2.0, (k - 12) * 0.22) : 0);
};
const medRadiusPx = (k: number) => 2.2 + Math.min(1.2, Math.log2(Math.max(1, k)) * 0.44);

const COLORS = {
  city: "#4338ca",
  village: "#334155",
  pharmacy: "#d97706",
  tree: "#94a3b8",
  reference: "#0f766e",
};

/* density ramps: low → high. The first stop is nearly transparent so an empty
   area stays "no data" instead of "healthy". */
const DENS_RAMP = ["#f2fdfb", "#99f6e4", "#2dd4bf", "#0d9488", "#115e59"];
const GAP_RAMP = ["#fef3c7", "#fcd34d", "#fb923c", "#f43f5e", "#9f1239"];
/* residents per pharmacy: blue = covered, red = many people per shop (a gap) */
const RATIO_RAMP = ["#1d4ed8", "#0ea5e9", "#facc15", "#f97316", "#b91c1c"];

function ramp(stops: string[], t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = hex(stops[i]);
  const b = hex(stops[i + 1]);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(
    a[1] + (b[1] - a[1]) * f,
  )},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

function hex(c: string): [number, number, number] {
  const v = parseInt(c.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

type Proj = (lat: number, lon: number) => [number, number];

type Road = { d: string; cls: string; b: [number, number, number, number] };

type Scene = {
  proj: Proj;
  pharm: { x: number; y: number; i: number }[];
  /** Clinics, doctors, dentists, hospitals, labs — the demand side. */
  med: { x: number; y: number }[];
  /** Screen units -> degrees, and km per scene unit (for the scale bar). */
  inv: (x: number, y: number) => [number, number];
  kmPerUnit: number;
  /** scene units per degree of longitude (latitude is `scale`). */
  kx: number;
  scale: number;
  cellW: number;
  cellH: number;
  pts: { x: number; y: number; r: number }[];
  edges: [number, number, number, number][];
  cells: (MapCell & { x: number; y: number })[];
  bakhsh: AdminShape[];
  outline: string;
  dehestan: AdminShape[];
  counties: { name: string; x: number; y: number }[];
  dehestans: { key: string; name: string; x: number; y: number }[];
};

type AdminShape = {
  /** unique across the province; a name alone never is (see shapesOf) */
  key: string;
  d: string;
  name: string;
  county: string | null;
  lx: number;
  ly: number;
  kind: "bakhsh" | "dehestan";
};

function buildScene(data: MapData): Scene {
  const shapes = [...data.bakhsh, ...data.dehestan];
  let lonMin = 180, lonMax = -180, latMin = 90, latMax = -90;
  const eat = (lat: number, lon: number) => {
    if (lon < lonMin) lonMin = lon;
    if (lon > lonMax) lonMax = lon;
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
  };
  for (const s of shapes) for (const poly of s.rings) for (const [lo, la] of poly) eat(la, lo);
  for (const p of data.settlements) eat(p.lat, p.lon);
  if (!Number.isFinite(lonMin)) {
    lonMin = 47.6; lonMax = 50.4; latMin = 29.9; latMax = 33.1;
  }

  const kx = Math.cos((31.4 * Math.PI) / 180);
  const gw = (lonMax - lonMin) * kx;
  const gh = latMax - latMin;
  const scale = Math.min((W - 2 * PAD) / gw, (H - 2 * PAD) / gh);
  const offX = (W - gw * scale) / 2;
  const offY = (H - gh * scale) / 2;
  const proj: Proj = (lat, lon) => [
    offX + (lon - lonMin) * kx * scale,
    offY + (latMax - lat) * scale,
  ];

  const path = (s: MapShape): string =>
    s.rings
      .map(
        (poly) =>
          poly
            .map(([lo, la], i) => {
              const [x, y] = proj(la, lo);
              return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
            })
            .join(" ") + "Z",
      )
      .join(" ");

  const shapesOf = (list: MapShape[], kind: "bakhsh" | "dehestan"): AdminShape[] =>
    list.map((s) => {
      const [lx, ly] = proj(s.label[0], s.label[1]);
      /* Identity comes from the source shape, never from the name: «بخش مرکزی»
         exists in every شهرستان, its `county` is unresolved in that capture, and
         14 دهستان names span more than one county. Name/county-keyed children
         were being dropped with a React duplicate-key warning. */
      return {
        key: `${kind}:${s.id}`,
        d: path(s),
        name: s.name,
        county: s.county,
        lx,
        ly,
        kind,
      };
    });

  const bakhsh = shapesOf(data.bakhsh, "bakhsh");
  const dehestan = shapesOf(data.dehestan, "dehestan");

  const pts = data.settlements.map((p) => {
    const [x, y] = proj(p.lat, p.lon);
    const pop = p.pop ?? 0;
    /* Screen-constant radius: 1.3 px for a hamlet, 4.6 px for a 300k city.
       It used to reach 9 px, which merged neighbours into one blob and hid the
       density cells underneath. */
    return { x, y, r: 1.2 + Math.min(2.5, Math.sqrt(Math.max(0, pop)) / 190) };
  });

  const edges: [number, number, number, number][] = data.edges.map(([a, b]) => [
    pts[a].x,
    pts[a].y,
    pts[b].x,
    pts[b].y,
  ]);

  const cells = data.cells.map((c) => {
    const [x, y] = proj(c.lat, c.lon);
    return { ...c, x, y };
  });

  // county label anchor: population-weighted mean of its settlements, which
  // lands inside the built-up area instead of at the geometric bbox centre
  const countyAcc = new Map<string, { x: number; y: number; w: number }>();
  for (let i = 0; i < data.settlements.length; i++) {
    const s = data.settlements[i];
    if (!s.county) continue;
    const w = Math.max(1, s.pop ?? 1);
    const acc = countyAcc.get(s.county) ?? { x: 0, y: 0, w: 0 };
    acc.x += pts[i].x * w;
    acc.y += pts[i].y * w;
    acc.w += w;
    countyAcc.set(s.county, acc);
  }
  const counties = [...countyAcc.entries()].map(([name, a]) => ({
    name,
    x: a.x / a.w,
    y: a.y / a.w,
  }));

  // دهستان label from its settlements (only where there are enough of them to
  // mean something — a one-village دهستان label is noise). Grouped by county as
  // well as name: 14 names exist in more than one county, and averaging them
  // together dropped a label between two places that are not the same place.
  const dehAcc = new Map<string, { key: string; name: string; x: number; y: number; n: number }>();
  for (let i = 0; i < data.settlements.length; i++) {
    const s = data.settlements[i];
    if (!s.dehestan) continue;
    const key = `${s.county ?? ""}|${s.dehestan}`;
    const acc = dehAcc.get(key) ?? { key, name: s.dehestan, x: 0, y: 0, n: 0 };
    acc.x += pts[i].x;
    acc.y += pts[i].y;
    acc.n += 1;
    dehAcc.set(key, acc);
  }
  const dehestans = [...dehAcc.values()]
    .filter((a) => a.n >= 4)
    .map(({ key, name, x, y, n }) => ({ key, name, x: x / n, y: y / n }));

  const ringPath = (poly: number[][]) =>
    poly
      .map(([lo, la], i) => {
        const [x, y] = proj(la, lo);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ") + "Z";

  return {
    proj,
    inv: (x: number, y: number): [number, number] => [
      latMax - (y - offY) / scale,
      lonMin + (x - offX) / (kx * scale),
    ],
    kmPerUnit: 110.57 / scale,
    kx: kx * scale,
    scale,
    cellW: 0.033 * kx * scale,
    cellH: 0.03 * scale,
    pharm: data.pharmacies.map((p, i) => {
      const [x, y] = proj(p.lat, p.lon);
      // `i` keeps the drawn marker tied to the row it came from, so the rendered
      // position can be checked against the coordinate instead of trusted
      return { x, y, i };
    }),
    med: data.medical.map((m) => {
      const [x, y] = proj(m.lat, m.lon);
      return { x, y };
    }),
    outline: data.outline.map(ringPath).join(" "),
    pts,
    edges,
    cells,
    bakhsh,
    dehestan,
    counties,
    dehestans,
  };
}

/* ---------------------------------------------------------------- helpers -- */
const KIND_FA = { city: "شهر", village: "روستا" } as const;

function fmtKm(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${num(v, v < 10 ? 1 : 0)} کیلومتر`;
}

/** Persian digits with a true minus sign: a Latin hyphen in RTL text reads as a dash. */
function signed(v: number, digits = 1): string {
  return num(v, digits).replace("-", "−");
}

function fmtPop(v: number | null | undefined): string {
  return v ? group(v) : "نامعلوم";
}

function sourceFa(s: string | null | undefined): string {
  switch (s) {
    case "road":
      return "اندازه‌گیری جاده (OSRM)";
    case "network":
      return "برآورد شبکه (کالیبره‌شده)";
    case "straight":
      return "خط مستقیم (گراف گسسته)";
    case "reference":
      return "شهر مرجع";
    case "wikidata":
      return "ویکی‌داده";
    case "fa.wikipedia-infobox":
      return "ویکی‌پدیا › جعبه اطلاعات";
    case "fa.wikipedia-census-sentence":
      return "ویکی‌پدیا › متن سرشماری";
    case "fa.wikipedia-county-table":
      return "ویکی‌پدیا › جدول شهرستان";
    case "fda-feed":
      return "فید سازمان غذا و دارو";
    case "osm-tag":
      return "OpenStreetMap";
    case "manual":
      return "دستی (خودتان)";
    default:
      return s ?? "—";
  }
}

/** Fold ZWNJ, spacing and Arabic letter variants so «امالطمیر» finds «ام الطمیر». */
const fold = (v: string): string =>
  v
    .replace(/[‌‍‎‏\s]/g, "")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک");

const strip = (v: string, prefix: string) =>
  v.startsWith(prefix) ? v.slice(prefix.length).trim() : v;

/* ------------------------------------------------------------------ page -- */
export function KhuzestanMap({ data }: { data: MapData }) {
  const scene = useMemo(() => buildScene(data), [data]);
  const settlements = data.settlements;

  const [radius, setRadius] = useState(60);
  const [minPop, setMinPop] = useState(0);
  const [onlyGap, setOnlyGap] = useState(false);
  const [sortBy, setSortBy] = useState<"dist" | "gap">("dist");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [hover, setHover] = useState<{
    i: number;
    x: number;
    y: number;
  } | null>(null);
  const [selPharm, setSelPharm] = useState<number | null>(null);
  /* ?pharm=poi/123 deep-links a pharmacy, so a competitor card can be shared or
     bookmarked; it is also how the panel is verified end to end. */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const pid = q.get("pharm");
    if (pid) {
      const i = data.pharmacies.findIndex((p) => p.id === pid);
      if (i >= 0) setSelPharm(i);
    }
    const dlat = Number(q.get("lat"));
    const dlon = Number(q.get("lon"));
    if (Number.isFinite(dlat) && Number.isFinite(dlon) && dlat && dlon) {
      const [x, y] = scene.proj(dlat, dlon);
      const kz = Math.max(1, Math.min(MAX_ZOOM, Number(q.get("k")) || 8));
      commit(kz, W / 2 - x * kz, H / 2 - y * kz);
    }
    const mid = q.get("med");
    if (mid) {
      const i = data.medical.findIndex((m) => String(m.id) === mid);
      if (i >= 0) setSelMed(i);
    }
    /* mode, radius, target and the open candidate travel too: a recommendation you cannot
       send to a partner is half a decision. */
    const m = q.get("m");
    if (m === "gap" || m === "ratio" || m === "dens") {
      setMode(m);
      setLayers((l) => ({ ...l, density: true }));
    }
    const rr = Number(q.get("r"));
    if (Number.isFinite(rr) && rr > 0) setRadius(Math.min(300, rr));
    const tt = Number(q.get("t"));
    if (Number.isFinite(tt) && tt > 0) setTargetPerPharm(Math.round(tt));
    const sr = Number(q.get("site"));
    if (Number.isInteger(sr) && sr > 0) setSelSite(sr);
    /* ?settle=<area_id> opens a settlement card — used by links and by the tests */
    const st = Number(q.get("settle"));
    if (Number.isInteger(st) && st > 0) setSelected(st);
  }, [data.pharmacies, data.medical]);
  const [selMed, setSelMed] = useState<number | null>(null);
  const [hoverMed, setHoverMed] = useState<{ i: number; x: number; y: number } | null>(null);
  const [hoverPharm, setHoverPharm] = useState<{
    i: number;
    x: number;
    y: number;
  } | null>(null);
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  /** Authoritative view for gestures: wheel events fire faster than React can
      re-render, and a stale `view` here would drop every second notch. */
  const viewRef = useRef(view);
  const [mode, setMode] = useState<"dens" | "gap" | "ratio">("dens");
  const [layers, setLayers] = useState({
    density: true,
    network: false,
    admin: true,
    labels: true,
    pharm: true,
    osm: true,
    med: true,
    streets: true,
    sat: false,
    sites: true,
    prospects: true,
    surveys: true,
    measures: true,
    hoods: true,
  });
  const [targetPerPharm, setTargetPerPharm] = useState(
    Math.round((data.meta.residentsPerPharmacy || 5400) / 100) * 100,
  );

  /** Phones: the viewBox is scaled to ~340 px, so the same font size renders at
      half the pixels. Labels get a boost and the dehestan tier is dropped. */
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const sync = () => setCompact(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  /* Full screen renders the card itself, not the document: the sidebar and the
     header stay out of the way, and ESC restores the page exactly. */
  const [isFull, setIsFull] = useState(false);
  useEffect(() => {
    const sync = () => setIsFull(document.fullscreenElement === cardRef.current);
    /* headless browsers fire fullscreenchange but ignore the Escape key, so the
       key is handled here as well; the browser still owns the real exit */
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && document.fullscreenElement) void document.exitFullscreen();
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  const toggleFull = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void cardRef.current?.requestFullscreen?.().catch(() => setIsFull(false));
    }
  };
  /** SVG user units per CSS pixel. A font size in user units is multiplied by
      the viewBox→CSS ratio, so 12 units is 12 px on a 660 px-wide frame and 6 px
      on a 348 px phone — labels must be divided by this to stay legible. */
  const [unitsPerPx, setUnitsPerPx] = useState(1);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const sync = () =>
      setUnitsPerPx(W / Math.max(1, el.getBoundingClientRect().width));
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  /** Names that occur more than once in the province — their label needs the
      شهرستان or the map shows six identical «مرکزی» pins. */
  const dupNames = useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of settlements) seen.set(s.name, (seen.get(s.name) ?? 0) + 1);
    return new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
  }, [settlements]);

  const indexOf = useMemo(() => {
    const m = new Map<number, number>();
    settlements.forEach((s, i) => m.set(s.id, i));
    return m;
  }, [settlements]);

  /* Four corner points of what the current pan/zoom shows, in scene units.
     Labels, roads and the settlement tiers are all filtered by it, so the map
     stays readable instead of drawing 3.6k names at every zoom. */
  const visible = useMemo(() => {
    const x0 = -view.tx / view.k;
    const y0 = -view.ty / view.k;
    return { x0, y0, x1: x0 + W / view.k, y1: y0 + H / view.k };
  }, [view]);

  /* The fine density grid is recomputed from the settlement list whenever the
     view settles — 30-60 ms of work that must not run on every wheel tick. */
  /* Population surface: census population spread over OSM building counts
     (etl/build_pop_surface.py → /geo/urban_pop.json). Loaded only when the ratio
     layer is on, so the first paint stays light. */
  const [popCells, setPopCells] = useState<{ lat: number; lon: number; pop: number }[] | null>(
    null,
  );
  /* 1 km surface for the whole province (etl/build_pop_province.py). The 250 m
     urban file covers the surveyed cities; this one covers everything else. */
  const [popProvince, setPopProvince] = useState<
    { lat: number; lon: number; pop: number }[] | null
  >(null);
  /* Streets for the city the reader is zoomed into (one at a time, fetched on
     demand from /geo/streets_<slug>.json). */
  const streetCache = useRef<Map<string, { c: string; p: [number, number][] }[]>>(new Map());
  const ruralCache = useRef<Map<string, { c: string; p: [number, number][] }[]>>(new Map());
  const ruralIndex = useRef<{ county: string; slug: string; lat: number; lon: number; r_km: number }[] | null>(null);
  const [streetCity, setStreetCity] = useState<string | null>(null);
  /* tertiary / unclassified ways for the whole province: the roads *between* towns,
     which the per-city files never held and which made a small town look stranded. */
  const [connectors, setConnectors] = useState<{ c: string; p: [number, number][] }[] | null>(
    null,
  );
  /* Village lanes and outskirts, per county, loaded only for counties in view — this is
     the half of OSM's residential ways that no city disc ever contained. */
  const [rural, setRural] = useState<{ c: string; p: [number, number][] }[]>([]);
  const [streetLines, setStreetLines] = useState<{ c: string; p: [number, number][] }[]>([]);
  const streetIndex = useRef<{ city: string; slug: string; lat: number; lon: number; r_km: number }[] | null>(null);

  const [settled, setSettled] = useState(view);
  useEffect(() => {
    const t = setTimeout(() => setSettled(view), 160);
    return () => clearTimeout(t);
  }, [view]);

  /* Load the population surface the first time the ratio layer is opened. */
  useEffect(() => {
    if (mode !== "ratio" || popCells) return;
    let alive = true;
    fetch("/geo/urban_pop.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { cells?: [number, number, number, number][] } | null) => {
        if (!alive || !d?.cells) return;
        setPopCells(d.cells.map(([lat, lon, pop]) => ({ lat, lon, pop })));
      })
      .catch(() => setPopCells([]));
    fetch("/geo/pop_province.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { cells?: [number, number, number][] } | null) => {
        if (!alive || !d?.cells) return;
        setPopProvince(d.cells.map(([lat, lon, pop]) => ({ lat, lon, pop })));
      })
      .catch(() => setPopProvince([]));
    return () => {
      alive = false;
    };
  }, [mode, popCells]);

  useEffect(() => {
    if (!layers.streets || connectors) return;
    let alive = true;
    fetch("/geo/streets_connectors.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((fc: { features?: { properties?: { c?: string }; geometry?: { coordinates?: [number, number][] } }[] } | null) => {
        if (!alive) return;
        const feats = (fc?.features ?? [])
          .map((f) => ({
            c: f.properties?.c ?? "unclassified",
            p: (f.geometry?.coordinates ?? []).map(([lo, la]) => [la, lo] as [number, number]),
          }))
          .filter((f) => f.p.length >= 2);
        setConnectors(feats);
      })
      .catch(() => setConnectors([]));
    return () => {
      alive = false;
    };
  }, [layers.streets, connectors, settled.k]);

  useEffect(() => {
    if (!layers.streets || settled.k < 3.2) return;
    let alive = true;
    (async () => {
      if (!ruralIndex.current) {
        const idx = await fetch("/geo/rural_index.json")
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []);
        ruralIndex.current = Array.isArray(idx) ? idx : [];
      }
      const idx = ruralIndex.current ?? [];
      if (!idx.length) return;
      const cx0 = -settled.tx / settled.k;
      const cy0 = -settled.ty / settled.k;
      const [latA, lonA] = scene.inv(cx0, cy0);
      const [latB, lonB] = scene.inv(cx0 + W / settled.k, cy0 + H / settled.k);
      const latMid = (latA + latB) / 2;
      const lonMid = (lonA + lonB) / 2;
      const halfKm = Math.max(Math.abs(latB - latA) * 55.5, Math.abs(lonB - lonA) * 47.5);
      const wanted = idx
        .map((c: { county: string; slug: string; lat: number; lon: number; r_km: number }) => ({
          c, d: Math.hypot((c.lat - latMid) * 111, (c.lon - lonMid) * 95),
        }))
        .filter((x) => x.d <= x.c.r_km + halfKm * 1.2)
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map((x) => x.c);
      const parts: { c: string; p: [number, number][] }[] = [];
      for (const county of wanted) {
        const hit = ruralCache.current.get(county.slug);
        if (hit) {
          parts.push(...hit);
          continue;
        }
        const d = await fetch(`/geo/${county.slug}.json`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        const feats = (d?.features ?? [])
          .map((f: { properties?: { c?: string }; geometry?: { coordinates?: [number, number][] } }) => ({
            c: f.properties?.c ?? "residential",
            p: (f.geometry?.coordinates ?? []).map(([lo, la]) => [la, lo] as [number, number]),
          }))
          .filter((f: { p: [number, number][] }) => f.p.length >= 2);
        ruralCache.current.set(county.slug, feats);
        parts.push(...feats);
      }
      if (alive) setRural(parts);
    })();
    return () => {
      alive = false;
    };
  }, [layers.streets, settled, scene]);

  /* Streets: one city at a time, whichever the view is centred on, fetched from
     2.5x. It used to start at 5x and draw at 4.5x, which left a band where the map
     showed density cells over imagery and no streets at all — the exact zoom a user
     reaches first when they zoom into a town. */
  useEffect(() => {
    if (!layers.streets || settled.k < 1.6) {
      if (streetLines.length) setStreetLines([]);
      return;
    }
    let alive = true;
    (async () => {
      if (!streetIndex.current) {
        const idx = await fetch("/geo/streets_index.json")
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => []);
        streetIndex.current = Array.isArray(idx) ? idx : [];
      }
      const idx = streetIndex.current ?? [];
      /* Every city whose disc intersects what the screen shows — not just the one
         under the centre. A town's neighbour 3 km away used to render as bare
         imagery because its file was never asked for: «ملاثانی has streets,
         کریشان جدید next to it has none». */
      const cx0 = -settled.tx / settled.k;
      const cy0 = -settled.ty / settled.k;
      const [latA, lonA] = scene.inv(cx0, cy0);
      const [latB, lonB] = scene.inv(cx0 + W / settled.k, cy0 + H / settled.k);
      const latMid = (latA + latB) / 2;
      const lonMid = (lonA + lonB) / 2;
      const halfKm = Math.max(
        Math.abs(latB - latA) * 55.5,          // half height, km
        Math.abs(lonB - lonA) * 47.5,          // half width, km
      );
      const wanted = idx
        .map((c) => ({ c, d: Math.hypot((c.lat - latMid) * 111, (c.lon - lonMid) * 95) }))
        .filter((x) => x.d <= x.c.r_km + halfKm * 1.2)
        .sort((a, b) => a.d - b.d)
        .slice(0, 6)
        .map((x) => x.c);
      if (!wanted.length) return;             // nothing in view: keep what is drawn

      const parts: { c: string; p: [number, number][] }[] = [];
      const cities: string[] = [];
      for (const city of wanted) {
        cities.push(city.city);
        const cached = streetCache.current.get(city.slug);
        if (cached) {
          parts.push(...cached);
          continue;
        }
        const fc = await fetch(`/geo/streets_${city.slug}.json`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        const feats = (fc?.features ?? [])
          .map((f: { properties?: { c?: string }; geometry?: { coordinates?: [number, number][] } }) => ({
            c: f.properties?.c ?? "residential",
            p: (f.geometry?.coordinates ?? []).map(([lon, lat]) => [lat, lon] as [number, number]),
          }))
          .filter((f: { p: [number, number][] }) => f.p.length >= 2);
        streetCache.current.set(city.slug, feats);
        parts.push(...feats);
      }
      if (alive) {
        setStreetLines(parts);
        setStreetCity(cities.join(" · "));
      }
    })();
    return () => {
      alive = false;
    };
  }, [layers.streets, settled, scene]);

  /** Point chosen on empty ground: the "should I put a pharmacy here" probe. */
  const [probe, setProbe] = useState<{ lat: number; lon: number } | null>(null);
  /* Hand-added pharmacy: click a spot, name it, save. The row lives in
     `manual_pharmacy`, which no ETL run rewrites. */
  const router = useRouter();
  const [addMode, setAddMode] = useState(false);
  /* ---- user-owned annotations: places to visit, and areas already walked ---- */
  const [markMode, setMarkMode] = useState(false);
  const [markPin, setMarkPin] = useState<{ lat: number; lon: number } | null>(null);
  const [markName, setMarkName] = useState("");
  const [markNote, setMarkNote] = useState("");
  const [markPriority, setMarkPriority] = useState(2);
  const [markBusy, setMarkBusy] = useState(false);
  const [popDraft, setPopDraft] = useState("");
  const [popBusy, setPopBusy] = useState(false);
  const [popMsg, setPopMsg] = useState<string | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  /** «survey» records ground already walked; «measure» answers «how big is this, and how
   *  many people live here» — the same gesture, a different question. */
  const [drawKind, setDrawKind] = useState<"survey" | "measure">("survey");
  const [measure, setMeasure] = useState<{
    areaKm2: number; residentialKm2: number; population: number; density: number;
    pharmacies: number; method: string;
  } | null>(null);
  const [drawPts, setDrawPts] = useState<[number, number][]>([]);
  const [drawName, setDrawName] = useState("");
  const [drawBusy, setDrawBusy] = useState(false);
  const [addPin, setAddPin] = useState<{ lat: number; lon: number } | null>(null);
  const [addKind, setAddKind] = useState<string>("pharmacy");
  /** Show only the pharmacies nobody named — the ones that still need a human look. */
  const [onlyUnnamed, setOnlyUnnamed] = useState(false);
  const rankAt = useRef<string | null>(null);
  const unnamedCount = data.pharmacies.filter((p) => p.unnamed).length;
  const [addName, setAddName] = useState("");
  const [addAddr, setAddAddr] = useState("");
  const [addPhone, setAddPhone] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addMsg, setAddMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [selSite, setSelSite] = useState<number | null>(null);
  const [probeMode, setProbeMode] = useState(false);

  /* Roads come from a static asset (1.5 MB), not the RSC payload: they never
     change between requests and the browser caches them. */
  const [roads, setRoads] = useState<Road[] | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/geo/khuzestan_roads.geojson")
      .then((r) => r.json())
      .then((fc: {
        features: {
          properties: { cls: string; bbox: [number, number, number, number] };
          geometry: { coordinates: [number, number][] };
        }[];
      }) => {
        if (!alive) return;
        const out: Road[] = fc.features.map((f) => {
          const pts = f.geometry.coordinates;
          const d =
            pts
              .map(([lo, la], i) => {
                const [x, y] = scene.proj(la, lo);
                return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
              })
              .join(" ") || "";
          const [x0, y0, x1, y1] = f.properties.bbox;
          const [ax, ay] = scene.proj(y0, x0);
          const [bx, by] = scene.proj(y1, x1);
          return {
            cls: f.properties.cls,
            b: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)],
            d,
          };
        });
        setRoads(out);
      })
      .catch(() => setRoads(null));
    return () => {
      alive = false;
    };
  }, [scene]);

  const selectedIdx = selected === null ? undefined : indexOf.get(selected);
  const selectedS = selectedIdx === undefined ? null : settlements[selectedIdx];
  /* which source currently wins the number the analysis uses */
  const checkedSet = useMemo(() => new Set(data.checked), [data.checked]);
  const toggleCheck = async (kind: "settlement" | "hood", ref: string | number, on: boolean) => {
    await fetch("/api/checks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, ref: String(ref), checked: on }),
    });
    router.refresh();
  };

  const popWinner = selectedS?.popManual != null
    ? "manual"
    : (selectedS?.popSource ?? "").startsWith("fa.wikipedia")
      ? "wiki"
      : selectedS?.popSource === "fda-feed"
        ? "fda"
        : selectedS?.popSource === "osm-tag"
          ? "osm"
          : "admin";

  /* ------------------------------------------------------------- filtering */
  const inside = useMemo(() => {
    const flags = new Uint8Array(settlements.length);
    for (let i = 0; i < settlements.length; i++) {
      flags[i] = settlements[i].dist <= radius ? 1 : 0;
    }
    return flags;
  }, [settlements, radius]);

  /** Pre-folded search keys, one per settlement: folding 3.6k names per
      keystroke would be wasteful, and the arrays never change. */
  const folded = useMemo(() => {
    const f = (v: string | null) => fold(v ?? "");
    return {
      name: settlements.map((s) => f(s.name)),
      county: settlements.map((s) => f(s.county)),
      bakhsh: settlements.map((s) => f(s.bakhsh)),
      dehestan: settlements.map((s) => f(s.dehestan)),
    };
  }, [settlements]);

  const candidates = useMemo(() => {
    const q = fold(query);
    const out: MapSettlement[] = [];
    for (let i = 0; i < settlements.length; i++) {
      const s = settlements[i];
      if (s.dist > radius) continue;
      if ((s.pop ?? 0) < minPop) continue;
      const gap = (s.pop ?? 0) / targetPerPharm - s.ph;
      if (onlyGap && gap < 1) continue;
      if (q) {
        const hit =
          folded.name[i].includes(q) || folded.county[i].includes(q) ||
          folded.bakhsh[i].includes(q) || folded.dehestan[i].includes(q);
        if (!hit) continue;
      }
      out.push(s);
    }
    out.sort(
      sortBy === "gap"
        ? (a, b) =>
            (b.pop ?? 0) / targetPerPharm - b.ph - ((a.pop ?? 0) / targetPerPharm - a.ph) ||
            a.dist - b.dist
        : (a, b) => a.dist - b.dist,
    );
    return out;
  }, [settlements, folded, radius, minPop, onlyGap, query, sortBy, targetPerPharm]);

  const searchHits = useMemo(() => {
    const q = fold(query);
    if (q.length < 2) return [];
    const out: MapSettlement[] = [];
    for (let i = 0; i < settlements.length && out.length < 8; i++) {
      if (
        folded.name[i].includes(q) ||
        folded.county[i].includes(q) ||
        folded.bakhsh[i].includes(q) ||
        folded.dehestan[i].includes(q)
      ) {
        out.push(settlements[i]);
      }
    }
    return out;
  }, [settlements, folded, query]);

  const hoodHits = useMemo(() => {
    const q = fold(query);
    if (q.length < 2) return [];
    const out = [];
    for (const n of data.neighbourhoods) {
      const hay = fold(`${n.name} ${n.alias ?? ""} ${n.city ?? ""}`);
      if (hay.includes(q)) out.push(n);
      if (out.length >= 6) break;
    }
    return out;
  }, [data.neighbourhoods, query]);

  const stats = useMemo(() => {
    let pop = 0;
    let ph = 0;
    let empty = 0;
    for (const s of candidates) {
      pop += s.pop ?? 0;
      ph += s.ph;
      if (s.ph === 0) empty += 1;
    }
    return { n: candidates.length, pop, ph, empty };
  }, [candidates]);

  /* Catchment around the picked point. This is the number the decision needs:
     how many people and how many pharmacies inside 1/2/5/10 km, and what that
     implies per pharmacy against the target. */
  const probeStats = useMemo(() => {
    if (!probe) return null;
    const R = 6371.0088;
    const rad = (d: number) => (d * Math.PI) / 180;
    const km = (aLat: number, aLon: number, bLat: number, bLon: number) => {
      const dp = rad(bLat - aLat);
      const dl = rad(bLon - aLon);
      const h =
        Math.sin(dp / 2) ** 2 +
        Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dl / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    const withDist = settlements
      .filter((s) => s.lat !== null)
      .map((s) => ({ s, km: km(probe.lat, probe.lon, s.lat, s.lon) }))
      .sort((a, b) => a.km - b.km);
    const radii = [1, 2, 5, 10].map((r) => {
      const inR = withDist.filter((x) => x.km <= r);
      const pop = inR.reduce((a, x) => a + (x.s.pop ?? 0), 0);
      const ph = inR.reduce((a, x) => a + x.s.ph, 0);
      return {
        r,
        n: inR.length,
        pop,
        ph,
        perPharm: ph ? Math.round(pop / ph) : null,
        gap: pop / targetPerPharm - ph,
      };
    });
    const nearestCity = withDist.find((x) => x.s.kind === "city");
    const distAhvaz = km(probe.lat, probe.lon, data.meta.referenceLat, data.meta.referenceLon);
    const nearest = withDist.slice(0, 6);
    /* the closest pharmacy somebody actually mapped, in km */
    let nearestPharm: { name: string; km: number } | null = null;
    for (const p of data.pharmacies) {
      const d = km(probe.lat, probe.lon, p.lat, p.lon);
      if (!nearestPharm || d < nearestPharm.km) nearestPharm = { name: p.name, km: d };
    }
    return { radii, nearestCity, distAhvaz, nearest, nearestPharm, point: probe };
  }, [probe, settlements, targetPerPharm, data.meta.referenceLat, data.meta.referenceLon, data.pharmacies]);

  const ladder = useMemo(() => {
    const edges = [0, ...RING_EDGES];
    return edges.map((lo, i) => {
      const hi = RING_EDGES[i] ?? 9999;
      let n = 0, pop = 0, ph = 0, empty = 0;
      for (const s of settlements) {
        if (s.dist < lo || s.dist >= hi) continue;
        n += 1;
        pop += s.pop ?? 0;
        ph += s.ph;
        if (s.ph === 0) empty += 1;
      }
      return { lo, hi, n, pop, ph, empty };
    });
  }, [settlements]);

  /* --------------------------------------------------------------- gesture */
  const applyView = useCallback((k: number, tx: number, ty: number) => {
    const g = svgRef.current?.querySelector("g#scene") as SVGGElement | null;
    if (g) g.setAttribute("transform", `translate(${tx} ${ty}) scale(${k})`);
  }, []);

  /* Pointer -> viewBox coordinates through the SVG's own screen matrix. Reading
     rect.width/W only works while the element keeps the viewBox aspect, which
     stops being true the moment full screen crops it (preserveAspectRatio slice)
     — the matrix is right in both layouts. */
  const viewBoxPoint = (clientX: number, clientY: number): [number, number, number] => {
    const svg = svgRef.current!;
    const ctm = svg.getScreenCTM();
    if (!ctm) return [0, 0, 1];
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const p = pt.matrixTransform(ctm.inverse());
    return [p.x, p.y, ctm.a || 1];
  };

  /** The slice of the viewBox that is actually on screen (they differ in full
      screen, where the map is cropped instead of letterboxed). */
  const visibleBox = (): { x0: number; y0: number; x1: number; y1: number } => {
    const svg = svgRef.current;
    if (!svg) return { x0: 0, y0: 0, x1: W, y1: H };
    const r = svg.getBoundingClientRect();
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x0: 0, y0: 0, x1: W, y1: H };
    const inv = ctm.inverse();
    const pt = svg.createSVGPoint();
    pt.x = r.left;
    pt.y = r.top;
    const a = pt.matrixTransform(inv);
    pt.x = r.right;
    pt.y = r.bottom;
    const b = pt.matrixTransform(inv);
    return {
      x0: Math.min(a.x, b.x),
      y0: Math.min(a.y, b.y),
      x1: Math.max(a.x, b.x),
      y1: Math.max(a.y, b.y),
    };
  };

  /* Bounds come from what the screen actually shows, not from the viewBox. In
     full screen the map is cropped (xMidYMid slice), so the visible box is only a
     window into the province and panning has to be allowed inside that window —
     with the old `min = W - W*k` the map was nailed at translate(0,0) until you
     zoomed, and the southern half was unreachable. */
  const clampView = useCallback((k: number, tx: number, ty: number) => {
    const kk = Math.max(1, Math.min(MAX_ZOOM, k));
    const { x0, y0, x1, y1 } = visibleBox();
    /* 0 is the ceiling: the scene never slides past its own top-left. The floor
       is whatever makes the visible window's bottom-right edge reach the scene. */
    const maxX = 0;
    const maxY = 0;
    const minX = Math.min(0, x1 - W * kk);
    const minY = Math.min(0, y1 - H * kk);
    return {
      k: kk,
      tx: Math.min(maxX, Math.max(minX, tx)),
      ty: Math.min(maxY, Math.max(minY, ty)),
    };
  }, []);

  const commit = useCallback(
    (k: number, tx: number, ty: number) => {
      const v = clampView(k, tx, ty);
      viewRef.current = v;
      setView(v);
      applyView(v.k, v.tx, v.ty);
    },
    [applyView, clampView],
  );

  const preFull = useRef<{ k: number; tx: number; ty: number } | null>(null);
  useEffect(() => {
    /* Entering full screen changes the element's geometry, and the browser
       reports the old screen matrix until it has laid the new size out — so the
       recentre is driven by the resize, not by the state flag. */
    const svg = svgRef.current;
    if (!svg) return;
    const recentre = () => {
      // idempotent: a resize is a layout change, not a pan, so re-running is safe
      if (isFull) {
        const v = viewRef.current;
        const cx = (W / 2 - v.tx) / v.k;
        const cy = (H / 2 - v.ty) / v.k;
        const b = visibleBox();
        commit(v.k, (b.x0 + b.x1) / 2 - cx * v.k, (b.y0 + b.y1) / 2 - cy * v.k);
      } else if (preFull.current) {
        const p = preFull.current;
        preFull.current = null;
        commit(p.k, p.tx, p.ty);
        /* the restore lands while the element still reports full-screen geometry,
           so it is clamped by the wrong bounds; re-apply once the page is back */
        window.setTimeout(() => commit(p.k, p.tx, p.ty), 300);
      }
    };
    if (isFull) preFull.current = viewRef.current;
    const ro = new ResizeObserver(() => recentre());
    ro.observe(svg);
    const t = window.setTimeout(recentre, 220);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, [isFull, commit]);

  /* Wheel over the map zooms the map and must not scroll the page. React attaches
     `onWheel` as a passive listener at the root, so `preventDefault()` there is
     ignored by the browser — the listener has to be native and non-passive. */
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    wheelRef.current = (e: WheelEvent) => {
      const [mx, my] = viewBoxPoint(e.clientX, e.clientY);
      const v = viewRef.current;
      const k = Math.max(1, Math.min(MAX_ZOOM, v.k * Math.exp(-e.deltaY * 0.0016)));
      commit(k, mx - (mx - v.tx) * (k / v.k), my - (my - v.ty) * (k / v.k));
    };
  });
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      wheelRef.current(e);
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, []);

  const toScene = (clientX: number, clientY: number): [number, number, number] => {
    const [px, py, scale] = viewBoxPoint(clientX, clientY);
    const v = viewRef.current;
    return [(px - v.tx) / v.k, (py - v.ty) / v.k, scale];
  };

  /* One hit test for both hover and click: a pointerdown/up without a prior move
     (touch, or a scripted click) still lands on the right marker. */
  /* Test hook: where a coordinate actually lands on screen. A marker drawn at the
     wrong place is invisible in a screenshot; comparing this against the marker's own
     bounding box is not. Kept tiny and read-only. */
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    (window as unknown as { __khz?: unknown }).__khz = {
      screenOf: (lat: number, lon: number): [number, number] => {
        const [x, y] = scene.proj(lat, lon);
        const pt = svg.createSVGPoint();
        pt.x = x;
        pt.y = y;
        /* The scene group carries translate+scale of its own; the SVG's matrix does
           not include it, and using only that matrix reported every marker as
           hundreds of pixels off — the test was wrong, not the map. */
        const g = svg.querySelector("g#scene") as SVGGElement | null;
        const m = g?.getScreenCTM();
        if (!m) return [-1, -1];
        const p = pt.matrixTransform(m);
        return [p.x, p.y];
      },
      k: () => viewRef.current.k,
    };
  }, [scene, view.k]);

  const hitTest = (clientX: number, clientY: number) => {
    const [sx, sy, ratio] = toScene(clientX, clientY);
    /* Every layer competes on the same normalised distance, with a bonus for the
       specific markers: clicking a pharmacy that sits inside a town used to open
       the town instead, because the settlement test ran first and won at 9 px. */
    /* A settlement's own symbol is 1.2–3.7 px, so a 9 px catch area made the
       neighbouring village win the hover and show the wrong name. 6 px is one
       finger-width on a phone and one pixel of intent with a mouse. */
    const tolS = 6 / ratio;
    const pharmPx = pharmRadiusPx(view.k);
    const tolP = Math.max(9, pharmPx + 5) / ratio;
    const medPx = medRadiusPx(view.k);
    const tolM = Math.max(9, medPx + 5) / ratio;

    let best = { s: -1, p: -1, m: -1, si: -1 };
    let score = 2;

    if (layers.sites && data.sites.length) {
      const tol = 9 / ratio;
      for (let i = 0; i < data.sites.length; i++) {
        const q = data.sites[i];
        const [qx, qy] = scene.proj(q.lat, q.lon);
        const d = (Math.hypot(qx - sx, qy - sy) / tol) * 0.6;
        if (d < 1 && d < score) {
          score = d;
          best = { s: -1, p: -1, m: -1, si: i };
        }
      }
    }

    for (let i = 0; i < scene.pts.length; i++) {
      const q = scene.pts[i];
      const d = Math.hypot(q.x - sx, q.y - sy) / tolS;
      if (d < 1 && d < score) {
        score = d;
        best = { s: i, p: -1, m: -1, si: -1 };
      }
    }
    if (layers.osm) {
      for (let i = 0; i < scene.pharm.length; i++) {
        const q = scene.pharm[i];
        const d = (Math.hypot(q.x - sx, q.y - sy) / tolP) * 0.75;
        if (d < 1 && d < score) {
          score = d;
          best = { s: -1, p: i, m: -1, si: -1 };
        }
      }
    }
    if (layers.med && view.k >= 1.6) {
      for (let i = 0; i < scene.med.length; i++) {
        const q = scene.med[i];
        const d = (Math.hypot(q.x - sx, q.y - sy) / tolM) * 0.75;
        if (d < 1 && d < score) {
          score = d;
          best = { s: -1, p: -1, m: i, si: -1 };
        }
      }
    }
    return best;
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (drag.current) {
      const [, , scale] = viewBoxPoint(e.clientX, e.clientY);
      const dx = (e.clientX - drag.current.x) / scale;
      const dy = (e.clientY - drag.current.y) / scale;
      commit(viewRef.current.k, drag.current.tx + dx, drag.current.ty + dy);
      return;
    }
    const r0 = svgRef.current!.getBoundingClientRect();
    const { s, p, m } = hitTest(e.clientX, e.clientY);
    setHover(s < 0 ? null : { i: s, x: e.clientX - r0.left, y: e.clientY - r0.top });
    setHoverPharm(p < 0 ? null : { i: p, x: e.clientX - r0.left, y: e.clientY - r0.top });
    setHoverMed(m < 0 ? null : { i: m, x: e.clientX - r0.left, y: e.clientY - r0.top });
  };

  /* ----------------------------------------------------------- zoom helpers */
  const zoomBy = (f: number) => {
    const v = viewRef.current;
    const k = Math.max(1, Math.min(MAX_ZOOM, v.k * f));
    commit(k, W / 2 - (W / 2 - v.tx) * (k / v.k), H / 2 - (H / 2 - v.ty) * (k / v.k));
  };

  /** Frame a bare coordinate — used by the unnamed-pharmacy review list. */
  const flyLatLon = (lat: number, lon: number, k = 15) => {
    const [x, y] = scene.proj(lat, lon);
    commit(k, W / 2 - x * k, H / 2 - y * k);
  };

  /** Refresh now, then again when the background re-rank has finished.
   *
   *  The gap table, density and ratio are live views — they are correct on the first
   *  refresh. The numbered site badges come from `etl/rank_sites.py` (~8 s), so the page
   *  polls `rankAt` and refreshes once when it moves. Without this a new pharmacy changed
   *  the table but left the recommendations stale, which is what was reported. */
  /** km between two points — used by the candidate popup for its rival list. */
  const havKm = (alat: number, alon: number, blat: number, blon: number) => {
    const R = 6371.0088;
    const rad = (d: number) => (d * Math.PI) / 180;
    const dp = rad(blat - alat);
    const dl = rad(blon - alon);
    const h =
      Math.sin(dp / 2) ** 2 + Math.cos(rad(alat)) * Math.cos(rad(blat)) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };

  /** Mirror the decision state into the address bar, without a navigation. */
  const urlSynced = useRef(false);
  useEffect(() => {
    /* first pass is the hydrated state arriving from the URL itself — rewriting it there
       would replace the parameters we were opened with by the defaults they override */
    if (!urlSynced.current) {
      urlSynced.current = true;
      return;
    }
    const q = new URLSearchParams(window.location.search);
    const set = (k: string, v: string | null) => {
      if (v === null || v === "") q.delete(k);
      else q.set(k, v);
    };
    set("m", mode);
    set("r", radius === 60 ? null : String(radius));
    set("t", String(targetPerPharm));
    set("site", selSite === null ? null : String(selSite));
    const next = `${window.location.pathname}?${q.toString()}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, "", next);
    }
  }, [mode, radius, targetPerPharm, selSite]);

  useEffect(() => {
    if (drawKind !== "measure" || drawPts.length < 3) {
      if (drawKind === "measure") setMeasure(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(async () => {
      const j = (await fetch("/api/measure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: drawPts }),
      })
        .then((r) => r.json())
        .catch(() => null)) as { metrics?: typeof measure } | null;
      if (alive && j?.metrics) setMeasure(j.metrics);
    }, 350);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [drawKind, drawPts]);

  const refreshSoon = () => {
    router.refresh();
    let tries = 0;
    const tick = async () => {
      tries += 1;
      const j = (await fetch("/api/pharmacies")
        .then((r) => r.json())
        .catch(() => null)) as { rankAt?: string | null } | null;
      const at = j?.rankAt ?? null;
      if (at && at !== rankAt.current) {
        rankAt.current = at;
        router.refresh();
        return;
      }
      if (tries < 12) window.setTimeout(tick, 2000);
    };
    window.setTimeout(tick, 2000);
  };

  const flyTo = (s: MapSettlement, k = 6) => {
    const [x, y] = scene.proj(s.lat, s.lon);
    commit(k, W / 2 - x * k, H / 2 - y * k);
  };

  const select = (s: MapSettlement, zoom = false) => {
    setSelected(s.id);
    if (zoom) flyTo(s);
  };

  /* -------------------------------------------------------------- renders */
  const dotLayer = useMemo(
    () => (
      <g>
        {scene.pts.map((p, i) => {
          const s = settlements[i];
          const on = inside[i] === 1;
          const isSel = s.id === selected;
          const city = s.kind === "city";
          /* 3,677 dots on one province view is a texture, not a map: below 2x a
             village only appears once it holds 5,000 people (or is selected). */
          if (!city && view.k < 2 && (s.pop ?? 0) < 2500 && s.id !== selected) return null;
          /* Screen-constant symbol: a marker must stay a marker when the map is
             zoomed 20x, otherwise the whole town is one dot. */
          const r = (p.r + (isSel ? 2 : 0)) / view.k;
          const done = checkedSet.has(`settlement:${s.id}`);
          return (
            <g key={s.id} data-settlement={s.id} data-checked={done ? "1" : undefined}>
              <circle
                cx={p.x}
                cy={p.y}
                r={r}
                fill={city ? COLORS.city : COLORS.village}
                fillOpacity={on ? (city ? 0.9 : 0.72) : 0.12}
                stroke={isSel ? "#0f172a" : s.ph > 0 && layers.pharm ? COLORS.pharmacy : "none"}
                strokeWidth={isSel ? 1.8 : 1.1}
                vectorEffect="non-scaling-stroke"
                strokeOpacity={isSel ? 1 : 0.95}
              />
              {/* «I have been here»: a small tick beside the dot, not another colour */}
              {done ? (
                <text
                  x={p.x + r * 1.5}
                  y={p.y - r * 1.2}
                  fontSize={11 / view.k}
                  fontWeight={700}
                  fill="#15803d"
                  paintOrder="stroke"
                  stroke="#ffffff"
                  strokeWidth={2 / view.k}
                  pointerEvents="none"
                >
                  ✓
                </text>
              ) : null}
            </g>
          );
        })}
      </g>
    ),
    [scene, settlements, inside, selected, layers.pharm, view.k],
  );

  /* Mapped pharmacies: exact points from OSM, drawn as diamonds above 2x. They
     are a SAMPLE (223 of the ~884 the FDA counts), so the legend says «نقشه‌شده». */
  const pharmacyLayer = useMemo(() => {
    /* Mapped pharmacies are the layer the site decision is made on, so they are
       drawn from the province view too — but two shops on the same street corner
       must not become one orange blob: markers are deduped in SCREEN space on a
       7 px lattice, and a merged marker carries «+n», so 105 diamonds in a district
       stay countable instead of stacking. */
    if (!layers.osm) return null;
    const px = Math.max(pharmRadiusPx(view.k), onlyUnnamed ? 8 : 0);
    const r = px / view.k;
    /* Greedy screen-space declutter: a marker is drawn only if no accepted marker
       is within one marker-width of it, otherwise it is folded into that marker's
       «+n». A lattice alone still let diagonal neighbours overlap. */
    /* Merging is for the province and city views; at district zoom every shop must be
       its own pin, otherwise a street of four pharmacies shows as «+3». */
    /* review mode never merges: the point is to see each unnamed pin separately */
    const declutter = view.k < 13 && !onlyUnnamed;
    const gapPx = declutter ? px * 1.9 : 1;
    const gap = declutter ? gapPx / view.k : 0;
    const buckets = new Map<string, { x: number; y: number; n: number; i: number }>();
    const grid = new Map<string, { x: number; y: number; n: number; i: number }[]>();
    const gkey = (x: number, y: number) => `${Math.floor(x * view.k / gapPx)}:${Math.floor(y * view.k / gapPx)}`;
    for (const p of scene.pharm) {
      if (onlyUnnamed && !data.pharmacies[p.i]?.unnamed) continue;
      if (!declutter) {
        buckets.set(`${p.i}`, { x: p.x, y: p.y, n: 1, i: p.i });
        continue;
      }
      let host: { x: number; y: number; n: number; i: number } | null = null;
      const gx = Math.floor((p.x * view.k) / gapPx);
      const gy = Math.floor((p.y * view.k) / gapPx);
      for (let ox = -1; ox <= 1 && !host; ox++) {
        for (let oy = -1; oy <= 1 && !host; oy++) {
          for (const q of grid.get(`${gx + ox}:${gy + oy}`) ?? []) {
            if (Math.hypot(q.x - p.x, q.y - p.y) < gap) {
              host = q;
              break;
            }
          }
        }
      }
      if (host) {
        host.n += 1;
        continue;
      }
      const item = { x: p.x, y: p.y, n: 1, i: p.i };
      buckets.set(`${gx}:${gy}:${p.x.toFixed(3)}`, item);
      const list = grid.get(gkey(p.x, p.y));
      if (list) list.push(item);
      else grid.set(gkey(p.x, p.y), [item]);
    }
    return (
      <g>
        {[...buckets.values()].map((b, i) => (
          <g
            key={i}
            data-lat={data.pharmacies[b.i]?.lat}
            data-lon={data.pharmacies[b.i]?.lon}
            data-merged={b.n}
            data-shape={data.pharmacies[b.i]?.source === "manual" ? "manual" : "fetched"}
          >
            {/* An OSM pharmacy with no name is probably real — somebody mapped the shop
                but not its sign. Kept on the map so the count stays honest, drawn hollow
                and dashed so it is never mistaken for a verified point. */}
            {data.pharmacies[b.i]?.source === "manual" ? (
              /* a pin somebody placed by hand — a different shape from every fetched
                 point, so «I added this» is readable at a glance */
              <g>
                <path
                  /* a hair larger than the diamonds: at city zoom the silhouette has to
                     win against 430 identical neighbours */
                  d={`M${b.x} ${b.y + r * 1.35}
                      C${b.x - r * 1.18} ${b.y + r * 0.05} ${b.x - r * 1.18} ${b.y - r * 1.1} ${b.x} ${b.y - r * 1.1}
                      C${b.x + r * 1.18} ${b.y - r * 1.1} ${b.x + r * 1.18} ${b.y + r * 0.05} ${b.x} ${b.y + r * 1.35}Z`}
                  fill="#4338ca"
                  /* indigo on dark imagery needs a light rim, same rule the streets use */
                  stroke={layers.sat ? "#ffffff" : "#1e1b4b"}
                  strokeWidth={1.4}
                  vectorEffect="non-scaling-stroke"
                />
                <circle cx={b.x} cy={b.y - r * 0.32} r={r * 0.4} fill="#ffffff" />
              </g>
            ) : (
            <path
              d={`M${b.x} ${b.y - r} L${b.x + r} ${b.y} L${b.x} ${b.y + r} L${b.x - r} ${b.y}Z`}
              /* hollow white on a pale basemap is invisible — the unnamed pin is a pale
                 amber fill with a heavier dashed rim, unmistakably «not verified» next to
                 a solid orange diamond */
              fill={data.pharmacies[b.i]?.unnamed ? "#fbbf24" : COLORS.pharmacy}
              fillOpacity={data.pharmacies[b.i]?.unnamed ? 0.9 : 0.98}
              stroke="#7c2d12"
              strokeWidth={data.pharmacies[b.i]?.unnamed ? 1.9 : 1.3}
              strokeDasharray={data.pharmacies[b.i]?.unnamed ? `${2.2 / view.k} ${1.6 / view.k}` : undefined}
              vectorEffect="non-scaling-stroke"
            />
            )}
            {data.pharmacies[b.i]?.unnamed && view.k >= 10 ? (
              <text
                x={b.x}
                y={b.y + r * 0.55}
                fontSize={7 / view.k}
                fontWeight={700}
                textAnchor="middle"
                fill="#7c2d12"
                pointerEvents="none"
              >
                ؟
              </text>
            ) : null}
            {b.n >= 3 && view.k >= 5 ? (
              <text
                x={b.x + r * 1.1}
                y={b.y - r * 0.9}
                fontSize={7.5 / view.k}
                fontWeight={700}
                fill="#7c2d12"
                paintOrder="stroke"
                stroke="#ffffff"
                strokeWidth={2.4 / view.k}
                strokeOpacity={0.9}
              >
                {`+${b.n - 1}`}
              </text>
            ) : null}
          </g>
        ))}
      </g>
    );
  }, [scene, layers.osm, view.k, onlyUnnamed, data.pharmacies, checkedSet]);

  /* Demand side: clinics, doctors, dentists, hospitals, labs. Violet so it never
     reads as a pharmacy, and a plus sign for the ones that write prescriptions. */
  const medicalLayer = useMemo(() => {
    /* filtering to the unnamed pharmacies is a review mode: leave only them and the
       streets, otherwise twelve hollow diamonds hide among 865 medical pins */
    if (onlyUnnamed) return null;
    if (!layers.med || view.k < 1.6) return null;
    const px = medRadiusPx(view.k);
    const r = px / view.k;
    const cell = 6 / view.k;
    const seen = new Set<string>();
    const shown: { i: number; x: number; y: number }[] = [];
    scene.med.forEach((p, i) => {
      const key = `${Math.round(p.x / cell)}:${Math.round(p.y / cell)}`;
      if (seen.has(key)) return;
      seen.add(key);
      shown.push({ i, x: p.x, y: p.y });
    });
    return (
      <g>
        {shown.map(({ i, x, y }) => {
          const m = data.medical[i];
          const p = { x, y };
          const plus = m.kind === "clinic" || m.kind === "hospital" || m.kind === "lab";
          return plus ? (
            <path
              key={m.id}
              d={`M${p.x} ${p.y - r} h${r * 0.34} v${r * 0.66} h${r * 0.66} v${r * 0.34} h${-r * 0.66} v${r * 0.66} h${-r * 0.34} v${-r * 0.66} h${-r * 0.66} v${-r * 0.34} h${r * 0.66} Z`}
              fill="#7c3aed"
              fillOpacity={0.9}
              stroke="#ffffff"
              strokeWidth={0.9 / view.k}
            />
          ) : (
            <circle
              key={m.id}
              cx={p.x}
              cy={p.y}
              r={r * 0.62}
              fill={m.kind === "dentist" ? "#0ea5e9" : "#7c3aed"}
              fillOpacity={0.85}
              stroke="#ffffff"
              strokeWidth={0.8 / view.k}
            />
          );
        })}
      </g>
    );
  }, [data.medical, layers.med, scene.med, view.k, onlyUnnamed]);

  /* Urban streets, projected once and grouped by class. Only the city the view
     is centred on is loaded, and only above ~5x. */
  /* Ranked places to open a pharmacy. Drawn as numbered badges because the order is
     the point: a star without a rank says nothing. */
  /* Visited ground and places to visit: drawn under the sites and pharmacy layers so they
     never hide a shop, but above the wash so the wash cannot hide them. */
  const surveyLayer = useMemo(() => {
    if (!layers.surveys || !data.surveys.length) return null;
    return (
      <g data-layer="surveys">
        {data.surveys.map((a) => {
          const pts = a.points.map(([la, lo]) => scene.proj(la, lo));
          if (pts.length < 3) return null;
          const d = `M${pts.map(([x, y]) => `${x} ${y}`).join(" L")} Z`;
          const [cx, cy] = [pts.reduce((t, p) => t + p[0], 0) / pts.length,
                            pts.reduce((t, p) => t + p[1], 0) / pts.length];
          return (
            <g key={a.id} data-survey={a.id}>
              <path d={d} fill="#0ea5e9" fillOpacity={0.16} stroke="none" />
              <path d={d} fill="url(#surveyHatch)" stroke="#0369a1"
                    strokeWidth={2.4 / view.k} strokeDasharray={`${7 / view.k} ${4 / view.k}`} />
              <text x={cx} y={cy} textAnchor="middle" fontSize={10 / view.k} fontWeight={700}
                    fill="#075985" paintOrder="stroke" stroke="#ffffff"
                    strokeWidth={2.2 / view.k} pointerEvents="none">
                {a.name}
              </text>
            </g>
          );
        })}
      </g>
    );
  }, [layers.surveys, data.surveys, scene, view.k]);

  /* محله labels. The administrative layer knows شهر and روستا, not neighbourhoods — 312 of
     them were invisible, including «کوت نواصر» and «کوی هادی». Drawn from 5x, under the
     settlement labels so a city name still wins the eye. */
  const neighbourhoodLayer = useMemo(() => {
    if (!layers.hoods || view.k < 5) return null;
    const box = visibleBox();
    const out: { id: number; x: number; y: number; text: string }[] = [];
    const taken: { sx: number; sy: number }[] = [];
    /* Greedy screen-space declutter, same idea as the markers: a name is drawn only if no
       accepted name sits within ~62 px, otherwise the city core turns into a word cloud.
       Nearer-to-city-centre names win, so a neighbourhood keeps its label over a hamlet. */
    const ordered = [...data.neighbourhoods].sort((a, b) => {
      /* a curated alias is a name somebody bothered to record — it wins the slot */
      const ai = a.alias ? 0 : 1;
      const bi = b.alias ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return (a.cityKm ?? 99) - (b.cityKm ?? 99);
    });
    for (const n of ordered) {
      const [x, y] = scene.proj(n.lat, n.lon);
      const sx = x * view.k + view.tx;
      const sy = y * view.k + view.ty;
      if (sx < box.x0 - 60 || sx > box.x1 + 60 || sy < box.y0 - 30 || sy > box.y1 + 30) continue;
      if (taken.some((t) => Math.hypot(t.sx - sx, t.sy - sy) < 26)) continue;
      taken.push({ sx, sy });
      out.push({
        id: n.osmId,
        x,
        y,
        /* the alias is the name people use: show it instead of the OSM label, not beside it */
        text: `${checkedSet.has(`hood:${n.osmId}`) ? "✓ " : ""}${n.alias ?? n.name.split(" - ")[0]}`,
      });
      if (out.length >= 180) break;          // a wall of names is not a map
    }
    return (
      <g data-layer="hoods">
        {out.map((n) => (
          <g key={n.id} data-hood={n.id}>
            <circle cx={n.x} cy={n.y} r={1.6 / view.k} fill="#7c3aed" opacity={0.75} />
            <text
              x={n.x}
              y={n.y - 3 / view.k}
              textAnchor="middle"
              fontSize={7.4 / view.k}
              fill={checkedSet.has(`hood:${n.id}`) ? "#15803d" : "#5b21b6"}
              paintOrder="stroke"
              stroke="#ffffff"
              strokeWidth={2 / view.k}
              pointerEvents="none"
            >
              {n.text}
            </text>
          </g>
        ))}
      </g>
    );
  }, [layers.hoods, data.neighbourhoods, scene, view.k, view.tx, view.ty, checkedSet]);

  const measureLayer = useMemo(() => {
    if (!layers.measures || !data.measurements.length) return null;
    return (
      <g data-layer="measures">
        {data.measurements.map((m) => {
          const pts = m.points.map(([la, lo]) => scene.proj(la, lo));
          if (pts.length < 3) return null;
          const d = `M${pts.map(([x, y]) => `${x} ${y}`).join(" L")} Z`;
          const cx = pts.reduce((t, p) => t + p[0], 0) / pts.length;
          const cy = pts.reduce((t, p) => t + p[1], 0) / pts.length;
          return (
            <g key={m.id} data-measure={m.id}>
              <path d={d} fill="#f59e0b" fillOpacity={0.12} stroke="#b45309"
                    strokeWidth={2 / view.k} strokeDasharray={`${2 / view.k} ${5 / view.k}`} />
              <text x={cx} y={cy} textAnchor="middle" fontSize={9 / view.k} fontWeight={700}
                    fill="#92400e" paintOrder="stroke" stroke="#ffffff"
                    strokeWidth={2.4 / view.k} pointerEvents="none">
                {`${m.name} · ${m.areaKm2.toFixed(2)} کم²`}
              </text>
            </g>
          );
        })}
      </g>
    );
  }, [layers.measures, data.measurements, scene, view.k]);

  const prospectLayer = useMemo(() => {
    if (!layers.prospects || !data.prospects.length) return null;
    const tone = (s: string) =>
      s === "visited" ? "#16a34a" : s === "rejected" ? "#94a3b8" : "#d97706";
    return (
      <g data-layer="prospects">
        {data.prospects.map((p) => {
          const [x, y] = scene.proj(p.lat, p.lon);
          const r = 6 / view.k;
          return (
            <g key={p.id} data-prospect={p.id} className="cursor-pointer"
               onClick={(e) => {
                 e.stopPropagation();
                 flyLatLon(p.lat, p.lon, 15);
               }}>
              {/* flag on a pole: nothing else on this map has that silhouette */}
              <line x1={x} y1={y} x2={x} y2={y - r * 2.6} stroke="#334155" strokeWidth={1.4 / view.k} />
              <path d={`M${x} ${y - r * 2.6} L${x + r * 2.2} ${y - r * 2.0} L${x} ${y - r * 1.4} Z`}
                    fill={tone(p.status)} stroke="#334155" strokeWidth={1 / view.k} />
              <circle cx={x} cy={y} r={1.6 / view.k} fill="#334155" />
              <text x={x} y={y - r * 3.2} textAnchor="middle" fontSize={7.5 / view.k}
                    fontWeight={700} fill="#0f172a" paintOrder="stroke" stroke="#ffffff"
                    strokeWidth={2 / view.k} pointerEvents="none">
                {p.priority}
              </text>
            </g>
          );
        })}
      </g>
    );
  }, [layers.prospects, data.prospects, scene, view.k]);

  const siteLayer = useMemo(() => {
    if (onlyUnnamed) return null;
    if (!layers.sites || !data.sites.length) return null;
    return (
      <g>
        {data.sites.map((site) => {
          const [x, y] = scene.proj(site.lat, site.lon);
          const hot = site.score >= 0.8;
          const fill = hot ? "#16a34a" : site.score >= 0.6 ? "#0d9488" : "#f59e0b";
          const on = selSite === site.rank;
          return (
            <g
              key={site.rank}
              data-lat={site.lat}
              data-lon={site.lon}
              data-rank={site.rank}
              data-selected={on ? "1" : undefined}
              className="cursor-pointer"
              onClick={(e) => {
                e.stopPropagation();
                setSelSite(site.rank);
                setSelPharm(null);
                setSelMed(null);
              }}
            >
              {/* a 5.4 px badge is not a click target: an invisible disc makes it one */}
              <circle cx={x} cy={y} r={11 / view.k} fill="transparent" />
              {on ? (
                <circle cx={x} cy={y} r={12 / view.k} fill="none" stroke={fill} strokeWidth={2 / view.k} />
              ) : null}
              <circle cx={x} cy={y} r={9 / view.k} fill={fill} opacity={0.22} />
              <circle cx={x} cy={y} r={5.4 / view.k} fill={fill} stroke="#fff" strokeWidth={1.4 / view.k} />
              <text
                x={x}
                y={y + 1.9 / view.k}
                textAnchor="middle"
                fontSize={6.4 / view.k}
                fontWeight={700}
                fill="#fff"
                paintOrder="stroke"
                stroke={fill}
                strokeWidth={0.6 / view.k}
              >
                {site.rank}
              </text>
            </g>
          );
        })}
      </g>
    );
  }, [layers.sites, data.sites, scene, view.k, onlyUnnamed, selSite]);

  const connectorPts = useMemo(() => {
    if (!connectors?.length) return null;
    return connectors.map((seg) => {
      const pts = seg.p.map(([la, lo]) => scene.proj(la, lo));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pts) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      return { c: seg.c, pts, box: [x0, y0, x1, y1] as [number, number, number, number] };
    });
  }, [connectors, scene]);

  const connectorLayer = useMemo(() => {
    if (!layers.streets || !connectorPts) return null;
    const vb = visibleBox();
    const bx0 = (vb.x0 - view.tx) / view.k - 20 / view.k;
    const by0 = (vb.y0 - view.ty) / view.k - 20 / view.k;
    const bx1 = (vb.x1 - view.tx) / view.k + 20 / view.k;
    const by1 = (vb.y1 - view.ty) / view.k + 20 / view.k;
    const byClass = new Map<string, string[]>();
    let n = 0;
    for (const seg of connectorPts) {
      const [x0, y0, x1, y1] = seg.box;
      if (x1 < bx0 || x0 > bx1 || y1 < by0 || y0 > by1) continue;
      let d = `M${seg.pts[0][0].toFixed(1)} ${seg.pts[0][1].toFixed(1)}`;
      for (let i = 1; i < seg.pts.length; i++) d += `L${seg.pts[i][0].toFixed(1)} ${seg.pts[i][1].toFixed(1)}`;
      const list = byClass.get(seg.c);
      if (list) list.push(d);
      else byClass.set(seg.c, [d]);
      n += 1;
      if (n > 24000) break;
    }
    const width: Record<string, number> = { tertiary: 1.5, unclassified: 1.0, living_street: 0.8 };
    return (
      <g pointerEvents="none" opacity={0.9}>
        {[...byClass.entries()].map(([cls, ds]) => (
          <path
            key={cls}
            d={ds.join(" ")}
            fill="none"
            stroke="#9aa8bc"
            strokeWidth={(width[cls] ?? 1) / view.k}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </g>
    );
  }, [layers.streets, connectorPts, view.k, view.tx, view.ty]);

  const streetLayer = useMemo(() => {
    if (!layers.streets || view.k < 3.2) return null;
    if (!streetLines.length && !rural.length) return null;
    const byClass = new Map<string, string[]>();
    for (const seg of [...streetLines, ...rural]) {
      const pts = seg.p.map(([la, lo]) => scene.proj(la, lo));
      if (pts.length < 2) continue;
      let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) d += `L${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`;
      const list = byClass.get(seg.c);
      if (list) list.push(d);
      else byClass.set(seg.c, [d]);
    }
    const width: Record<string, number> = {
      tertiary: 1.7, secondary: 2.1, residential: 1.0, unclassified: 0.8, living_street: 0.7,
    };
    const paths = [...byClass.entries()];
    return (
      <g pointerEvents="none">
        {paths.map(([cls, ds]) => (
          <path
            key={`c-${cls}`}
            d={ds.join(" ")}
            fill="none"
            stroke={layers.sat ? "#0b1220" : "#ffffff"}
            strokeOpacity={layers.sat ? 0.55 : 0.9}
            strokeWidth={((width[cls] ?? 0.8) + 1.6) / view.k}
            strokeLinecap="round"
          />
        ))}
        {paths.map(([cls, ds]) => (
          <path
            key={cls}
            d={ds.join(" ")}
            fill="none"
            /* On imagery a grey line on grey rooftops is invisible — the town core
               read as «no streets», which is what was reported. Light body with a
               dark casing is the standard pairing over photography. */
            stroke={layers.sat ? "#f8fafc" : "#8a9bad"}
            strokeOpacity={0.95}
            strokeWidth={((width[cls] ?? 0.8) + (layers.sat ? 0.6 : 0)) / view.k}
            strokeLinecap="round"
          />
        ))}
      </g>
    );
  }, [layers.streets, streetLines, rural, scene, view.k, layers.sat]);

  const edgeLayer = useMemo(
    () => (
      <g stroke={COLORS.tree} strokeWidth={0.7} strokeOpacity={0.5} fill="none">
        {scene.edges.map(([x1, y1, x2, y2], i) => (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />
        ))}
      </g>
    ),
    [scene],
  );

  const cellLayer = useMemo(() => {
    const vals = scene.cells.map((c) => (mode === "dens" ? c.dens : Math.max(0, c.gap)));
    const sorted = [...vals].sort((a, b) => a - b);
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 1;
    const hi = Math.max(1e-9, p(0.97));
    return (
      <g
        opacity={view.k >= 3.4 ? 0 : Math.max(0.18, 0.78 - (view.k - 1) * 0.16)}
        shapeRendering="crispEdges"
        clipPath="url(#provClip)"
      >
        {scene.cells.map((c, i) => (
          <rect
            key={i}
            x={c.x - scene.cellW / 2}
            y={c.y - scene.cellH / 2}
            width={scene.cellW + 0.4}
            height={scene.cellH + 0.4}
            fill={ramp(mode === "dens" ? DENS_RAMP : GAP_RAMP, vals[i] / hi)}
            fillOpacity={mode === "gap" && vals[i] <= 0 ? 0.15 : 0.62}
          />
        ))}
      </g>
    );
  }, [scene, mode, view.k]);

  /* Fine density at city scale. The province-wide grid is 3.3 km, which is the
     right unit for a region and far too coarse for "which side of this town".
     Above 4x this recomputes the same measure on a 1 km grid over the visible
     box only, straight from the settlement list — population and pharmacies
     within 3 km, cells kept only where a settlement is within 1.2 km. */
  /* Supply points for the fine grid. A city's FDA count used to sit on one
     centroid, so داخل the city every 1 km cell inherited the same number and
     کیانپارس looked like the desert. Each mapped pharmacy now carries
     total / n_mapped (total preserved), and a settlement with nothing mapped
     keeps its count on the centroid — same rule as etl/build_map_layer.py. */
  /* Two halves of the same number, kept apart on purpose:
       located  — a pharmacy with a coordinate (OSM / Neshan / Google), weight 1
       residual — the FDA count for the settlement MINUS the ones located there:
                  they exist, we just do not know where, so they are spread over
                  the town's built-up disc as a density (per km²) instead of being
                  stacked on a centroid or smeared over the located ones.
     located + residual == the FDA count, so the province total is untouched. */
  const supply = useMemo(() => {
    const located: { lat: number; lon: number }[] = [];
    const locatedByArea = new Map<number, number>();
    for (const p of data.pharmacies) {
      located.push({ lat: p.lat, lon: p.lon });
      if (p.areaId != null) locatedByArea.set(p.areaId, (locatedByArea.get(p.areaId) ?? 0) + 1);
    }
    const residual: { lat: number; lon: number; perKm2: number; km: number; n: number }[] = [];
    let expected = 0;
    let placed = 0;
    for (const st of settlements) {
      expected += st.ph;
      if (!st.ph) continue;
      const n = Math.min(st.ph, locatedByArea.get(st.id) ?? 0);
      placed += n;
      const left = st.ph - n;
      if (left <= 0) continue;
      const km = Math.max(2.5, Math.min(12, 0.9 * Math.sqrt(Math.max(0, st.pop ?? 0) / 1000)));
      residual.push({ lat: st.lat, lon: st.lon, perKm2: left / (Math.PI * km * km), n: left, km });
    }
    return { located, residual, expected, placed };
  }, [data.pharmacies, settlements]);

  const fineCells = useMemo(() => {
    if (settled.k < 1.2) return null;
    /* The screen's own box, not the viewBox: in full screen the map is cropped with
       `slice`, so a grid built from W x H covered only the middle of the window and
       the edges looked unloaded. */
    const vb = visibleBox();
    const x0 = (vb.x0 - settled.tx) / settled.k;
    const y0 = (vb.y0 - settled.ty) / settled.k;
    const x1 = (vb.x1 - settled.tx) / settled.k;
    const y1 = (vb.y1 - settled.ty) / settled.k;
    const [latTop, lonLeft] = scene.inv(x0, y0);
    const [latBot, lonRight] = scene.inv(x1, y1);
    const latLo = Math.min(latTop, latBot);
    const latHi = Math.max(latTop, latBot);
    const lonLo = Math.min(lonLeft, lonRight);
    const lonHi = Math.max(lonLeft, lonRight);
    if (latHi - latLo > 3.9) return null;          // never on the province view

    /* Resolution follows the zoom, because a fixed 3.3 km province grid is far
       too coarse to judge a district: 2 km while the view is still regional,
       1 km from 3x, 500 m from 7x (that is roughly a city block per cell). */
    const stepKm = settled.k < 1.6 ? 4 : settled.k < 3 ? 2 : settled.k < 7 ? 1 : 0.5;
    if (((latHi - latLo) / (stepKm / 110.57)) * ((lonHi - lonLo) / (stepKm / 95)) > 26000) {
      return null;
    }
    const dLat = stepKm / 110.57;
    const dLon = stepKm / (111.32 * Math.cos((((latHi + latLo) / 2) * Math.PI) / 180));

    // bucket the settlements on 3 km cells: the window is 3 km
    /* A city is an area, not a point: masking cells to 1.5 km around the single
       centroid of اهواز deleted every district (کیانپارس is 4 km out). The mask
       grows with population — the usual built-up radius of a town. */
    const maskKm = settlements.map((st) =>
      Math.max(2.5, Math.min(12, 0.9 * Math.sqrt(Math.max(0, st.pop ?? 0) / 1000))),
    );

    const b: Map<number, number[]> = new Map();
    const key = (la: number, lo: number) => Math.floor(la / 0.03) * 100000 + Math.floor(lo / 0.03);
    settlements.forEach((s, i) => {
      const kk = key(s.lat, s.lon);
      const list = b.get(kk);
      if (list) list.push(i);
      else b.set(kk, [i]);
    });

    const wb: Map<number, number[]> = new Map();
    supply.located.forEach((p, i) => {
      const kk = key(p.lat, p.lon);
      const list = wb.get(kk);
      if (list) list.push(i);
      else wb.set(kk, [i]);
    });
    const popBuckets: Map<number, number[]> = new Map();
    (popCells ?? []).forEach((pc, i) => {
      const kk = key(pc.lat, pc.lon);
      const list = popBuckets.get(kk);
      if (list) list.push(i);
      else popBuckets.set(kk, [i]);
    });
    const provBuckets: Map<number, number[]> = new Map();
    (popProvince ?? []).forEach((pc, i) => {
      const kk = key(pc.lat, pc.lon);
      const list = provBuckets.get(kk);
      if (list) list.push(i);
      else provBuckets.set(kk, [i]);
    });
    const residualBuckets: Map<number, number[]> = new Map();
    supply.residual.forEach((r, i) => {
      const kk = key(r.lat, r.lon);
      const list = residualBuckets.get(kk);
      if (list) list.push(i);
      else residualBuckets.set(kk, [i]);
    });

    const R = 6371.0088;
    const rad = (d: number) => (d * Math.PI) / 180;
    const dist = (aLat: number, aLon: number, bLat: number, bLon: number) => {
      const dp = rad(bLat - aLat);
      const dl = rad(bLon - aLon);
      const hh =
        Math.sin(dp / 2) ** 2 +
        Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dl / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(hh));
    };

    const out: { x: number; y: number; v: number; pop: number; ph: number; n: number }[] = [];
    let maxV = 1;
    for (let la = latLo; la <= latHi; la += dLat) {
      for (let lo = lonLo; lo <= lonHi; lo += dLon) {
        let near = 0;
        let pop = 0;
        let ph = 0;
        let n = 0;
        for (let oa = -1; oa <= 1; oa++) {
          for (let ol = -1; ol <= 1; ol++) {
            for (const i of b.get(key(la + oa * 0.03, lo + ol * 0.03)) ?? []) {
              const s = settlements[i];
              const d = dist(la, lo, s.lat, s.lon);
              if (d <= maskKm[i]) near = 1;
              if (d <= 3) {
                pop += s.pop ?? 0;
                n += 1;
              }
            }
          }
        }
        /* Two different questions, two kernels:
           - «تراکم داروخانه» inside a city is a SPATIAL question (how many shops
             per km²). Population is only known per settlement, and اهواز's 1.2 M
             people sit on one point, so a per-capita ratio is flat across the
             whole city and never shows that کیانپارس has a pharmacy every 200 m.
           - «شکاف ظرفیت» stays per-capita, which is the right unit for a region.
        */
        const R = mode === "dens" || mode === "ratio" ? 1.5 : 3;
        let surface = 0;                     // pharmacies/km² we cannot place
        let popHere = 0;                     // people on the same kernel
        for (let oa = -1; oa <= 1; oa++) {
          for (let ol = -1; ol <= 1; ol++) {
            const kk = key(la + oa * 0.03, lo + ol * 0.03);
            for (const i of wb.get(kk) ?? []) {
              const q = supply.located[i];
              if (dist(la, lo, q.lat, q.lon) <= R) ph += 1;
            }
            for (const i of residualBuckets.get(kk) ?? []) {
              const r = supply.residual[i];
              if (dist(la, lo, r.lat, r.lon) <= r.km) surface += r.perKm2;
            }
            for (const i of popBuckets.get(kk) ?? []) {
              const q = popCells![i];
              if (dist(la, lo, q.lat, q.lon) <= R) popHere += q.pop;
            }
            for (const i of provBuckets.get(kk) ?? []) {
              const q = popProvince![i];
              if (dist(la, lo, q.lat, q.lon) <= R) popHere += q.pop;
            }
          }
        }
        if (!near) continue;
        if (mode === "gap" && pop <= 0) continue;
        const areaKm2 = Math.PI * R * R;
        const supplyKm2 = ph / areaKm2 + surface;   // pharmacies per km²
        let v: number;
        if (mode === "dens") {
          v = supplyKm2;
        } else if (mode === "ratio") {
          /* People per pharmacy. Where the building surface exists it is used
             as-is (census population spread over footprints); elsewhere the
             settlement population is spread over the town disc, which is the same
             assumption the density layer already makes. */
          let popKm2 = popHere / areaKm2;
          if (popHere <= 0) {
            for (let oa = -1; oa <= 1; oa++) {
              for (let ol = -1; ol <= 1; ol++) {
                for (const i of b.get(key(la + oa * 0.03, lo + ol * 0.03)) ?? []) {
                  const st = settlements[i];
                  const d = dist(la, lo, st.lat, st.lon);
                  const km2 = Math.max(2.5, Math.min(12, 0.9 * Math.sqrt(Math.max(0, st.pop ?? 0) / 1000)));
                  if (d <= km2) popKm2 += (st.pop ?? 0) / (Math.PI * km2 * km2);
                }
              }
            }
          }
          v = Math.min(60000, popKm2 / Math.max(0.05, supplyKm2));
        } else {
          v = Math.max(0, pop / targetPerPharm - ph - surface * areaKm2);
        }
        if (v > maxV) maxV = v;
        const [cx, cy] = scene.proj(la, lo);
        out.push({ x: cx, y: cy, v, pop, ph, n });
      }
    }
    /* Colour is capped at the 95th percentile: one dense block (the bazaar
       cluster in اهواز reaches ~10x the city median) otherwise washes every other
       district to the palest step and the map reads as empty. */
    const sorted = out.map((c) => c.v).sort((a, b) => a - b);
    const cap = sorted.length
      ? Math.max(1e-6, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))])
      : 1;
    return { cells: out, max: maxV, cap, stepKm, dLat, dLon };
  }, [settled, scene, settlements, mode, targetPerPharm, supply, popCells, popProvince, isFull]);

  /* Satellite base. Hand-rolled like the rest of the map: no map library, so the
     visible scene box is inverted to lat/lon, the Esri World Imagery zoom that puts
     ~3 tiles across that box is picked, and each tile is projected to the rectangle
     its corners fall on. The imagery is Mercator, the scene is equirectangular, so a
     tile is stretched inside its box (`preserveAspectRatio="none"`) — the error is
     sub-pixel at city zoom and a few pixels at province zoom, where the raster is
     context rather than evidence. Attribution stays on screen: Esri's terms require
     it, and a hidden credit is the same as no credit. */
  const satTiles = useMemo(() => {
    if (!layers.sat) return null;
    const k = view.k;
    const vb = visibleBox();
    const [latN, lonW] = scene.inv((vb.x0 - view.tx) / k, (vb.y0 - view.ty) / k);
    const [latS, lonE] = scene.inv((vb.x1 - view.tx) / k, (vb.y1 - view.ty) / k);
    const lonSpan = Math.max(1e-6, Math.abs(lonE - lonW));
    /* Pick the zoom whose native resolution matches the screen, not "a few tiles
       across": one level short upsampled the image ~4x and the city read as flat
       desert. 256 px of tile per 360/2^z degrees, so z = log2(pxPerDeg*360/256). */
    const pxPerDeg = (svgRef.current?.clientWidth || W) / lonSpan;
    /* Device pixels, not CSS pixels: a 2x screen needs one tile step more to look
       sharp, and Esri serves World Imagery up to z19 in the province. */
    const dpr = typeof window === "undefined" ? 1 : Math.min(3, window.devicePixelRatio || 1);
    /* z19 answers with a 2 KB placeholder over خوزستان — measured, not assumed — so
       the real ceiling is 18; the parent-tile fallback covers the rest. */
    let z = Math.max(7, Math.min(18,
      Math.round(Math.log2((pxPerDeg * dpr * 360) / 256))));
    /* Past ~300x the screen is finer than z17's metre-per-pixel, and rounding down
       there is what made deep zoom look upscaled. Ask for the best tile the source
       has (18 in خوزستان; 19 returns a 2 KB placeholder). */
    if (view.k >= 300) z = 18;
    const n = 2 ** z;
    const yOf = (lat: number) =>
      (1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) /
        Math.PI) / 2;
    const lonOf = (x: number) => (x / n) * 360 - 180;
    const latOf = (y: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    const tx0 = Math.floor(((lonW + 180) / 360) * n);
    const tx1 = Math.floor(((lonE + 180) / 360) * n);
    const ty0 = Math.floor(yOf(latN) * n);
    const ty1 = Math.floor(yOf(latS) * n);
    const out: { key: string; href: string; x: number; y: number; w: number; h: number }[] = [];
    for (let ty = ty0; ty <= ty1 && out.length < 200; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = tx0; tx <= tx1 && out.length < 200; tx++) {
        const wrap = ((tx % n) + n) % n;
        const [ax, ay] = scene.proj(latOf(ty), lonOf(tx));
        const [bx, by] = scene.proj(latOf(ty + 1), lonOf(tx + 1));
        out.push({
          key: `${z}/${ty}/${wrap}`,
          /* Through our own route, which stores the tile on first fetch: the
             provider is touched once per tile, never again per view. */
          href: `/api/tile/${z}/${wrap}/${ty}`,
          x: ax,
          y: ay,
          w: bx - ax,
          h: by - ay,
        });
      }
    }
    return { z, tiles: out };
  }, [layers.sat, view.k, view.tx, view.ty, scene, isFull]);

  /* Roads: culled to the viewport and to the class the zoom level needs, then
     concatenated into two paths — 8k <path> nodes would choke the renderer. */
  const roadLayer = useMemo(() => {
    if (!roads) return null;
    const pad = 20 / view.k;
    const heavy: string[] = [];
    const light: string[] = [];
    for (const r of roads) {
      const [x0, y0, x1, y1] = r.b;
      if (
        x1 < visible.x0 - pad ||
        x0 > visible.x1 + pad ||
        y1 < visible.y0 - pad ||
        y0 > visible.y1 + pad
      ) {
        continue;
      }
      const isHeavy = r.cls === "motorway" || r.cls === "trunk" || r.cls === "primary";
      if (!isHeavy && view.k < 2.5) continue;
      (isHeavy ? heavy : light).push(r.d);
    }
    return (
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {light.length ? (
          <path
            d={light.join(" ")}
            stroke="#c3cedd"
            strokeWidth={1.2}
            strokeOpacity={0.75}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        <path
          d={heavy.join(" ")}
          stroke="#8fa0b8"
          strokeWidth={2}
          strokeOpacity={0.6}
          vectorEffect="non-scaling-stroke"
        />
      </g>
    );
  }, [roads, visible, view.k]);

  const adminLayer = useMemo(
    () => (
      <g filter="url(#provShadow)">
        {scene.bakhsh.map((b, i) => (
          <path
            key={`b${i}`}
            d={b.d}
            /* the vector land colour would bury the imagery; with satellite on the
               shape still has to exist (it is the clip path), just not paint */
            fill={layers.sat ? "#ffffff" : "#dfe8f3"}
            fillOpacity={layers.sat ? 0 : 0.96}
            stroke={layers.sat ? "#ffffff" : "#8b9bb2"}
            strokeWidth={0.7}
            strokeOpacity={layers.sat ? 0.5 : 1}
          />
        ))}
        {scene.dehestan.map((d, i) => (
          <path
            key={`d${i}`}
            d={d.d}
            fill="none"
            stroke="#cbd5e1"
            strokeWidth={0.35}
            strokeOpacity={0.55}
            strokeDasharray="2 3"
          />
        ))}
        <path
          d={scene.outline}
          fill="none"
          stroke="#3f5065"
          strokeWidth={2.2}
          strokeLinejoin="round"
        />
      </g>
    ),
    [scene, layers.sat],
  );

  const labelLayer = useMemo(() => {
    if (!layers.labels) return null;
    const k = view.k;
    const u = unitsPerPx;
    const out: ReactNode[] = [];
    /* Greedy declutter. Labels live in scene units and are counter-scaled by
       1/k, so their on-screen size stays constant — which means the collision
       boxes only fit more labels as you zoom in, never fewer. */
    const boxes: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const place = (x: number, y: number, text: string, size: number): boolean => {
      const em = size / k;                 // the font is rendered at size/k
      const w = text.length * em * 0.8 + 5 / k;
      const h = em * 1.25 + 4 / k;
      // SVG text sits on a baseline, not centred on y: the glyph box is mostly
      // above the anchor, which is exactly where the boxes have to collide
      const b = { x1: x - w / 2, y1: y - h * 0.95, x2: x + w / 2, y2: y + h * 0.35 };
      for (const o of boxes) {
        if (!(b.x2 < o.x1 || b.x1 > o.x2 || b.y2 < o.y1 || b.y1 > o.y2)) return false;
      }
      boxes.push(b);
      return true;
    };

    type Label = {
      key: string;
      x: number;
      y: number;
      text: string;
      size: number;
      weight: number;
      fill: string;
      opacity: number;
      halo: number;
    };
    const labels: Label[] = [];

    const vis = visible;
    const inView = (x: number, y: number) =>
      x > vis.x0 - 30 && x < vis.x1 + 30 && y > vis.y0 - 30 && y < vis.y1 + 30;

    /* Province scale used to show county names only; without the towns the map
       read as an abstract blob. The biggest cities get a label from zoom 1. */
    if (k < 2.6) {
      const cap = compact ? 14 : 28;
      const shown = settlements
        /* every plotted town, not only those inside the radius ring: at province
           scale the ring is 60 km and the map would show nine labels */
        .filter((s) => s.kind === "city" && indexOf.get(s.id) !== undefined)
        .sort((a, b) => (b.pop ?? 0) - (a.pop ?? 0))
        .slice(0, cap);
      for (const s of shown) {
        const p = scene.pts[indexOf.get(s.id)!];
        if (!inView(p.x, p.y)) continue;
        labels.push({
          key: `city${s.id}`,
          x: p.x,
          y: p.y - (p.r + 2.6) / k,
          text: s.name,
          size: 11.5 * u,
          weight: 600,
          fill: "#0f172a",
          opacity: 0.95,
          halo: 2.8,
        });
      }
    }

    /* A county and its capital share a name; drawing both puts «اهواز» twice on
       the same spot, which reads as a rendering bug. Census names win, and a
       county label yields to any town label within 34 px (the Ahvaz ring:
       کارون / باوی / ملاثانی pressed against the city name). */
    const cityNames = new Set(
      settlements.filter((s) => s.kind === "city").map((s) => s.name),
    );
    const townLabels = labels.filter((l) => l.key.startsWith("city"));
    if (k < 8)
      for (const c of scene.counties) {
      if (k < 2.6 && cityNames.has(shortCounty(c.name))) continue;
      if (k < 2.6 && townLabels.some((t) => Math.hypot(t.x - c.x, t.y - c.y) < 34)) continue;
      labels.push({
        key: `c${c.name}`,
        x: c.x,
        y: c.y,
        text: shortCounty(c.name),
        size: 12.5 * u,
        weight: 700,
        fill: "#0f172a",
        opacity: 0.9,
        halo: 3.1,
      });
    }
    if (k >= 2.1 && k < 16) {
      for (const b of scene.bakhsh) {
        if (!inView(b.lx, b.ly)) continue;
        labels.push({
          key: b.key,
          x: b.lx,
          y: b.ly,
          text: strip(b.name, "بخش "),
          size: 10.5 * u,
          weight: 500,
          fill: "#334155",
          opacity: 0.8,
          halo: 2.6,
        });
      }
    }
    if (k >= 3.4 && k < 13 && !compact) {
      for (const d of scene.dehestans) {
        if (!inView(d.x, d.y)) continue;
        labels.push({
          key: d.key,
          x: d.x,
          y: d.y,
          text: strip(d.name, "دهستان "),
          size: 10 * u,
          weight: 400,
          fill: "#475569",
          opacity: 0.78,
          halo: 2.6,
        });
      }
    }
    /* Settlements by zoom: at province scale only the big cities, at street
       scale every village in view with its pharmacy count. This is the layer
       the site decision is actually made on. */
    if (k >= 2.6) {
      const minPop = k < 4 ? 2500 : k < 6 ? 700 : k < 10 ? 150 : 0;
      const cap = compact ? 90 : k < 4 ? 80 : k < 8 ? 180 : 340;
      const shown = settlements
        .filter((s) => {
          if (inside[indexOf.get(s.id) ?? 0] !== 1) return false;
          if ((s.pop ?? 0) < minPop) return false;
          const i = indexOf.get(s.id)!;
          return inView(scene.pts[i].x, scene.pts[i].y);
        })
        .slice(0, cap);
      for (const s of shown) {
        const i = indexOf.get(s.id)!;
        const p = scene.pts[i];
        const ph = k >= 6 && s.ph > 0 ? ` · ${group(s.ph)}` : "";
        labels.push({
          key: `v${s.id}`,
          x: p.x,
          y: p.y - (p.r + 2.2) / k,
          text:
            k >= 6 && dupNames.has(s.name) && s.county
              ? `${s.name} · ${shortCounty(s.county)}${ph}`
              : `${s.name}${ph}`,
          size: 10.5 * u,
          weight: s.ph > 0 ? 600 : 450,
          fill: s.ph > 0 ? "#0b3b36" : "#0f172a",
          opacity: 0.96,
          halo: 2.8,
        });
      }
    }

    for (const l of labels) {
      if (!place(l.x, l.y, l.text, l.size)) continue;
      /* a town on the province edge had its label cut by the frame («رامهرمز»
         came out as «رامز»); keep the text inside the canvas instead */
      const half = (l.text.length * (l.size / k) * 0.8) / 2;
      const lx = Math.min(W - half - 4, Math.max(half + 4, l.x));
      const ly = Math.min(H - 6, Math.max((l.size / k) + 4, l.y));
      out.push(
        <text
          key={l.key}
          x={lx}
          y={ly}
          textAnchor="middle"
          fontSize={l.size / k}
          fontWeight={l.weight}
          fill={l.fill}
          opacity={l.opacity}
          paintOrder="stroke"
          stroke="#ffffff"
          strokeWidth={(l.halo + 0.8) / k}
          strokeOpacity={0.95}
        >
          {l.text}
        </text>,
      );
    }
    return <g pointerEvents="none">{out}</g>;
  }, [scene, settlements, layers.labels, view.k, inside, indexOf, compact, unitsPerPx, visible, dupNames]);

  /* Scale bar: constant 90 CSS px, with the kilometre value following the zoom.
     Drawn outside the pan/zoom group so it never moves with the map. */
  const scaleBar = useMemo(() => {
    const kmPerUnit = scene.kmPerUnit / view.k;      // km per viewBox unit
    const unitsFor90 = 90 * unitsPerPx;
    const raw = unitsFor90 * kmPerUnit;
    const nice = [1, 2, 5, 10, 20, 50, 100, 200].find((v) => v >= raw) ?? 250;
    return { km: nice, units: nice / kmPerUnit };
  }, [scene.kmPerUnit, view.k, unitsPerPx]);

  const hoverS = hover ? settlements[hover.i] : null;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
      {/* ------------------------------------------------------------ map -- */}
      {/* The map is the point of the page: it takes the whole column and only
          gives up width when the window is short (the province is 0.805 as wide
          as it is tall, so width alone decides legibility). Never sticky — a
          sticky card slid over the sidebar and the table while scrolling. */}
      <div
        ref={cardRef}
        /* The width used to be capped by viewport height, which left a wide empty band
           between the sidebar and the map on a short window — the map is the page's whole
           point, so it takes the column and the page scrolls instead. 980 is only there to
           stop it becoming absurd on a 2k monitor. */
        style={isFull ? undefined : { maxWidth: "min(100%, 980px)" }}
        className={`w-full min-w-0 bg-surface p-2.5 sm:p-3 ${
          isFull
            ? "flex h-screen w-screen max-w-none flex-col rounded-none border-0"
            : "rounded-2xl border border-line shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.12)]"
        }`}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-ink">
              نقشهٔ سکونتگاه‌ها و تراکم داروخانه
            </span>
            <span className="whitespace-nowrap rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-muted">
              {group(settlements.length)} نقطه · {group(scene.cells.length)} سلول مسکونی
            </span>
            <span
              className="whitespace-nowrap rounded-md border border-[#7c3aed]/30 bg-[#7c3aed]/10 px-1.5 py-0.5 text-[10.5px] text-[#5b21b6]"
              title="محله‌ها واحد تقسیمات کشوری نیستند و در جدول آبادی‌ها نمی‌آیند"
            >
              {group(data.neighbourhoods.length)} محله
            </span>
            {data.checked.length ? (
              <span
                className="whitespace-nowrap rounded-md border border-good/40 bg-good-soft px-1.5 py-0.5 text-[10.5px] font-medium text-good"
                title="مکان‌هایی که این کاربر بررسی کرده — در پایگاه داده ذخیره شده‌اند"
              >
                ✓ {group(data.checked.length)} بررسی‌شده
              </span>
            ) : null}
            <span className="flex-1" />
            {/* six checkboxes used to eat three wrapped rows; they live in one
                popover now, and the toolbar stays a single line */}
            <details className="relative sm:ml-auto">
              <summary className="flex cursor-pointer list-none items-center gap-1 rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] text-muted transition hover:text-ink">
                لایه‌های نقشه
                <span aria-hidden className="text-[9px] leading-none">▾</span>
              </summary>
              <div className="absolute left-0 z-30 mt-1 grid w-48 gap-0.5 rounded-xl border border-line bg-surface p-2 shadow-xl">
                {(
                  [
                    ["density", "سلول تراکم"],
                    ["network", "شبکهٔ فاصله"],
                    ["admin", "مرزها"],
                    ["labels", "برچسب‌ها"],
                    ["pharm", "داروخانه‌دار"],
                    ["streets", "خیابان‌ها"],
                    ["med", "خدمات درمانی"],
                    ["osm", "داروخانه‌های نقشه"],
                    ["sat", "تصویر ماهواره‌ای"],
                    ["sites", "پیشنهادهای مکانی"],
                    ["prospects", "فهرست بازدید"],
                    ["surveys", "محدوده‌های بررسی‌شده"],
                    ["measures", "مساحت‌های اندازه‌گیری‌شده"],
                    ["hoods", "نام محله‌ها"],
                  ] as const
                ).map(([id, label]) => (
                  <label
                    key={id}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-ink-soft hover:bg-surface-2"
                  >
                    <input
                      type="checkbox"
                      className="h-3 w-3 accent-[#0d9488]"
                      checked={layers[id]}
                      onChange={(e) => setLayers((l) => ({ ...l, [id]: e.target.checked }))}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </details>
            <button
              type="button"
              onClick={toggleFull}
              aria-label={isFull ? "خروج از تمام‌صفحه" : "تمام‌صفحه"}
              title={isFull ? "خروج از تمام‌صفحه (Esc)" : "نمایش تمام‌صفحهٔ نقشه"}
              className="rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] text-muted transition hover:border-brand hover:text-brand-ink"
            >
              {isFull ? "⤡ خروج" : "⤢"}
            </button>
          </div>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5">
            {unnamedCount > 0 ? (
              <button
                type="button"
                onClick={() => {
                  const next = !onlyUnnamed;
                  setOnlyUnnamed(next);
                  /* twelve pins scattered across the province are invisible at street zoom:
                     entering review mode frames all of them, otherwise the toggle looks
                     like it did nothing. */
                  if (!next) return;
                  const pts = data.pharmacies.filter((p) => p.unnamed);
                  if (!pts.length) return;
                  const lat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
                  const lon = pts.reduce((a, p) => a + p.lon, 0) / pts.length;
                  const spanLat = Math.max(0.04, 2 * Math.max(...pts.map((p) => Math.abs(p.lat - lat))));
                  const spanLon = Math.max(0.04, 2 * Math.max(...pts.map((p) => Math.abs(p.lon - lon))));
                  const [x, y] = scene.proj(lat, lon);
                  const k = Math.max(
                    2,
                    Math.min(MAX_ZOOM, 0.82 * Math.min(H / (spanLat * 194), W / (spanLon * 194))),
                  );
                  commit(k, W / 2 - x * k, H / 2 - y * k);
                }}
                title="داروخانه‌هایی که در OSM نام ندارند — احتمالاً واقعی‌اند ولی کسی نامشان را ثبت نکرده"
                className={`rounded-lg border px-2 py-1 text-[10.5px] font-medium transition ${
                  onlyUnnamed
                    ? "border-warn bg-warn-soft text-warn"
                    : "border-line-strong bg-surface text-muted hover:text-ink"
                }`}
              >
                {group(unnamedCount)} بدون نام{onlyUnnamed ? " · فقط این‌ها" : ""}
              </button>
            ) : null}
            {onlyUnnamed ? (
              <div className="mt-1.5 w-full rounded-lg border border-warn/40 bg-warn-soft/50 p-1.5">
                <div className="mb-1 flex items-center justify-between text-[10px] text-warn">
                  <b>{group(unnamedCount)} داروخانهٔ بی‌نام — برای بررسی</b>
                  <span className="text-faint">کلیک = نزدیک‌شدن</span>
                </div>
                <div className="grid max-h-28 gap-1 overflow-auto sm:grid-cols-2">
                  {data.pharmacies
                    .filter((p) => p.unnamed)
                    .map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => flyLatLon(p.lat, p.lon, 16)}
                        className="flex items-center justify-between gap-1 rounded border border-line-strong bg-surface px-1.5 py-0.5 text-[10px] text-ink hover:border-warn"
                      >
                        <span className="truncate">{p.settlement ?? "بدون آبادی"}</span>
                        <span className="tnum shrink-0 text-faint">{p.km.toFixed(1)} کم</span>
                      </button>
                    ))}
                </div>
              </div>
            ) : null}
            {/* one segmented control instead of two loose mode buttons */}
            <div className="flex overflow-hidden rounded-lg border border-line-strong">
              {(
                [
                  /* short visible label, full accessible name: the toolbar has to fit on
                     one line, and tests should not depend on copy */
                  ["dens", "تراکم", "تراکم داروخانه"],
                  ["ratio", "نفر/داروخانه", "نفر به ازای داروخانه"],
                  ["gap", "شکاف", "شکاف ظرفیت"],
                ] as const
              ).map(([id, short, long]) => (
                <button
                  key={id}
                  type="button"
                  aria-label={long}
                  onClick={() => {
                    setMode(id);
                    setLayers((l) => ({ ...l, density: true }));
                  }}
                  className={`px-2.5 py-1 text-[11px] font-medium transition ${
                    mode === id && layers.density
                      ? "bg-brand-soft text-brand-ink"
                      : "bg-surface text-muted hover:text-ink"
                  }`}
                >
                  {short}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setProbeMode((v) => !v);
                if (probeMode) setProbe(null);
              }}
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition ${
                probeMode
                  ? "border-danger/40 bg-danger-soft text-danger"
                  : "border-line bg-surface text-muted hover:text-ink"
              }`}
              aria-label="تحلیل یک نقطه"
              title="روی هر نقطه از نقشه کلیک کنید تا جمعیت و داروخانه‌های اطراف آن سنجیده شود"
            >
              {probeMode ? "روی نقشه کلیک کنید…" : "تحلیل نقطه"}
            </button>
            <button
              type="button"
              onClick={() => {
                setAddMode((v) => !v);
                setAddPin(null);
                setAddMsg(null);
                setProbeMode(false);
              }}
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition ${
                addMode
                  ? "border-good/50 bg-good-soft text-good"
                  : "border-line bg-surface text-muted hover:text-ink"
              }`}
              aria-label="افزودن داروخانه"
              title="اگر داروخانه‌ای روی نقشه نیست، اینجا اضافه کنید"
            >
              {addMode ? "روی نقشه کلیک کنید…" : "افزودن"}
            </button>
            <button
              type="button"
              aria-label="نشان‌گذاری مکان"
              onClick={() => {
                setMarkMode((v) => !v);
                setMarkPin(null);
                setDrawMode(false);
                setDrawPts([]);
                setAddMode(false);
                setProbeMode(false);
              }}
              title="مکانی که باید بروید و از نزدیک ببینید را روی نقشه علامت بزنید"
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition ${
                markMode
                  ? "border-accent/50 bg-accent-soft text-accent"
                  : "border-line bg-surface text-muted hover:text-ink"
              }`}
            >
              {markMode ? "روی نقشه کلیک کنید…" : "نشان‌گذاری"}
            </button>
            <button
              type="button"
              aria-label="اندازه‌گیری مساحت"
              onClick={() => {
                setDrawMode(true);
                setDrawKind("measure");
                setDrawPts([]);
                setDrawName("");
                setMeasure(null);
                setMarkMode(false);
                setAddMode(false);
                setProbeMode(false);
              }}
              title="مساحت را بکشید تا اندازه و جمعیت تخمینی‌اش را ببینید"
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition ${
                drawMode && drawKind === "measure"
                  ? "border-warn/50 bg-warn-soft text-warn"
                  : "border-line bg-surface text-muted hover:text-ink"
              }`}
            >
              {drawMode && drawKind === "measure" ? `${drawPts.length} نقطه…` : "اندازه‌گیری"}
            </button>
            <button
              type="button"
              aria-label="کشیدن محدوده"
              onClick={() => {
                setDrawMode((v) => !v);
                setDrawKind("survey");
                setDrawPts([]);
                setDrawName("");
                setMarkMode(false);
                setAddMode(false);
                setProbeMode(false);
              }}
              title="محدوده‌ای که قبلاً گشته‌اید را دور بکشید تا دوباره بررسی نشود"
              className={`shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition ${
                drawMode
                  ? "border-[#0284c7]/50 bg-[#0ea5e9]/15 text-[#075985]"
                  : "border-line bg-surface text-muted hover:text-ink"
              }`}
            >
              {drawMode ? `${drawPts.length} نقطه…` : "کشیدن محدوده"}
            </button>
          </div>
        </div>

        <div
          className={
            isFull
              ? "relative mx-auto flex min-h-0 w-full flex-1 items-center justify-center"
              : "relative mx-auto w-full min-w-0"
          }
        >
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio={isFull ? "xMidYMid slice" : "xMidYMid meet"}
            style={{
              aspectRatio: isFull ? undefined : `${W} / ${H}`,
              ...(isFull
                ? { height: "100%", width: "100%" }
                : { width: "100%", height: "auto" }),
              touchAction: "none",
            }}
            className="block cursor-crosshair rounded-xl border border-line bg-[#f8fafc]"
            onPointerMove={onPointerMove}
            onPointerLeave={() => {
              drag.current = null;
              setHover(null);
            }}
            onPointerDown={(e) => {
              // a drag must not leave a tooltip pinned over the map
              setHover(null);
              setHoverPharm(null);
              setHoverMed(null);
              (e.target as Element).setPointerCapture?.(e.pointerId);
              drag.current = {
                x: e.clientX,
                y: e.clientY,
                tx: viewRef.current.tx,
                ty: viewRef.current.ty,
              };
            }}
            onPointerUp={(e) => {
              const moved =
                drag.current &&
                Math.hypot(e.clientX - drag.current.x, e.clientY - drag.current.y) > 4;
              drag.current = null;
              if (moved) return;
              if (probeMode) {
                const [sx, sy] = toScene(e.clientX, e.clientY);
                const [lat, lon] = scene.inv(sx, sy);
                setProbe({ lat, lon });
                setSelected(null);
                if (viewRef.current.k < 6) {
                  commit(6, W / 2 - sx * 6, H / 2 - sy * 6);
                }
                return;
              }
              if (markMode) {
                const [px, py] = toScene(e.clientX, e.clientY);
                const [la, lo] = scene.inv(px, py);
                setMarkPin({ lat: la, lon: lo });
                return;
              }
              if (drawMode) {
                const [px, py] = toScene(e.clientX, e.clientY);
                const [la, lo] = scene.inv(px, py);
                setDrawPts((pts) => [...pts, [la, lo]]);
                return;
              }
              if (addMode) {
                const [px, py] = toScene(e.clientX, e.clientY);
                const [la, lo] = scene.inv(px, py);
                setAddPin({ lat: la, lon: lo });
                setAddMsg(null);
                return;
              }
              const hit = hitTest(e.clientX, e.clientY);
              if (hit.si >= 0) {
                setSelSite(data.sites[hit.si].rank);
                setSelPharm(null);
                setSelMed(null);
                return;
              }
              if (hit.s >= 0) {
                select(settlements[hit.s], false);
              } else if (hit.p >= 0) {
                setSelPharm(hit.p);
                setSelMed(null);
              } else if (hit.m >= 0) {
                setSelMed(hit.m);
                setSelPharm(null);
              }
            }}
          >
            <defs>
              {/* A wash alone reads as map shading. A hatch says «marked by a person» —
                  this is ground somebody has already walked. */}
              <pattern id="surveyHatch" width="9" height="9" patternUnits="userSpaceOnUse"
                       patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="9" stroke="#0369a1" strokeOpacity="0.35"
                      strokeWidth="2.2" />
              </pattern>
              <clipPath id="provClip">
                <path d={scene.bakhsh.map((b) => b.d).join(" ")} />
              </clipPath>
              <filter id="provShadow" x="-8%" y="-8%" width="116%" height="116%">
                <feDropShadow
                  dx="0"
                  dy="1.4"
                  stdDeviation="2.4"
                  floodColor="#0f172a"
                  floodOpacity="0.22"
                />
              </filter>
            </defs>
            <g
              id="scene"
              /* Tests (and the user) need to know when the async layers have landed;
                 measuring a half-loaded map is how «roads disappear at some zooms»
                 got reported in the first place. */
              data-ready={roads && settlements.length ? "1" : "0"}
              transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}
            >
              {satTiles ? (
                <g data-layer="satellite" clipPath="url(#provClip)">
                  {satTiles.tiles.map((t) => (
                    <image
                      key={t.key}
                      href={t.href}
                      x={t.x}
                      y={t.y}
                      width={t.w}
                      height={t.h}
                      preserveAspectRatio="none"
                      style={{ imageRendering: "auto" }}
                      /* Rural Iran is not photographed at z19. When the tile is
                         missing, take the parent tile instead of showing a hole;
                         the browser caches it, so this costs one request. */
                      onError={(e) => {
                        const el = e.currentTarget;
                        const m = el.getAttribute("href")?.match(/tile\/(\d+)\/(\d+)\/(\d+)/);
                        if (!m) return;
                        const zz = Number(m[1]);
                        if (zz <= 12) return;
                        const px = Math.floor(Number(m[3]) / 2);
                        const py = Math.floor(Number(m[2]) / 2);
                        el.setAttribute(
                          "href",
                          `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zz - 1}/${py}/${px}`,
                        );
                      }}
                    />
                  ))}
                </g>
              ) : null}
              {layers.admin ? adminLayer : null}
              <g data-layer="roads">{roadLayer}</g>
              <g data-layer="connectors">{connectorLayer}</g>
              {layers.density && view.k < 1.2 ? cellLayer : null}
              {layers.density && fineCells ? (
                <g
                  data-layer="density"
                  shapeRendering="crispEdges"
                  clipPath="url(#provClip)"
                  opacity={onlyUnnamed ? 0 : 0.92}
                >
                  {fineCells.cells.map((c, i) => (
                    <rect
                      key={i}
                      x={c.x - (fineCells.dLon * scene.kx) / 2}
                      y={c.y - (fineCells.dLat * scene.scale) / 2}
                      width={fineCells.dLon * scene.kx + 0.25}
                      height={fineCells.dLat * scene.scale + 0.25}
                      /* Three states, because "no pharmacy mapped" and "few
                         pharmacies" used to look identical: grey = residential
                         with no mapped supply, teal = supply, nothing = no data. */
                      fill={
                        mode === "dens" && c.v <= 0
                          ? layers.sat
                            ? "none"
                            : "#e2e8f0"
                          : ramp(
                              mode === "dens"
                                ? DENS_RAMP
                                : mode === "gap"
                                  ? GAP_RAMP
                                  : RATIO_RAMP,
                              Math.min(1, c.v / fineCells.cap),
                            )
                      }
                      fillOpacity={
                        /* on imagery the grey «no supply» wash covered exactly the
                           built-up blocks the photo was opened to show */
                        mode === "dens" && c.v <= 0
                          ? 0
                          : ((view.k >= 4.5 ? 0.17 : 0.35) +
                              0.45 * Math.min(1, c.v / fineCells.cap)) *
                            (layers.sat ? (view.k >= 6 ? 0.45 : 0.8) : 1) *
                            /* Past 80x a single 500 m cell covers the screen and its
                               wash is a teal filter over the photo: the statistic is
                               meaningless at building scale, so fade it out rather
                               than pretend it means something. */
                            (view.k <= 80 ? 1 : view.k <= 200 ? 0.45 : 0)
                      }
                    />
                  ))}
                </g>
              ) : null}

              {/* One ring, the one the sidebar set: seven dashed circles made the
                  map look like a target and nobody read them as "distance from
                  اهواز". */}
              {(() => {
                const [cx, cy] = scene.proj(data.meta.referenceLat, data.meta.referenceLon);
                const r = (radius / 111.32) * scene.scale;
                const px = r * view.k;
                const label = `${group(radius)} کیلومتر از ${data.meta.referenceName}`;
                return (
                  <g pointerEvents="none">
                    <circle
                      cx={cx}
                      cy={cy}
                      r={r}
                      fill="none"
                      stroke="#0d9488"
                      strokeOpacity={0.55}
                      strokeWidth={1.5 / view.k}
                      strokeDasharray={`${7 / view.k} ${5 / view.k}`}
                    />
                    <text
                      x={cx}
                      y={cy - r - 6 / view.k}
                      textAnchor="middle"
                      fontSize={11 / view.k}
                      fontWeight={600}
                      fill="#0f766e"
                      paintOrder="stroke"
                      stroke="#ffffff"
                      strokeWidth={3 / view.k}
                      strokeOpacity={0.95}
                    >
                      {label}
                    </text>
                  </g>
                );
              })()}

              <g data-layer="streets">{streetLayer}</g>
              <g data-layer="network">{layers.network ? edgeLayer : null}</g>
              {/* 3,677 settlement dots hide twelve pins: reviewing them is a different map */}
              <g data-layer="settlements">{onlyUnnamed ? null : dotLayer}</g>
              <g data-layer="medical">{medicalLayer}</g>
              <g data-layer="pharmacy">{pharmacyLayer}</g>
              {surveyLayer}
              {measureLayer}
              {neighbourhoodLayer}
              <g data-layer="sites">{siteLayer}</g>
              {prospectLayer}

              {drawPts.length ? (
                <g pointerEvents="none" data-layer="draw-preview">
                  <path
                    d={
                      drawPts.length > 1
                        ? `M${drawPts.map(([la, lo]) => scene.proj(la, lo).join(" ")).join(" L")}`
                        : ""
                    }
                    fill="none" stroke="#0284c7" strokeWidth={2 / view.k}
                    strokeDasharray={`${5 / view.k} ${4 / view.k}`}
                  />
                  {drawPts.map(([la, lo], i) => {
                    const [x, y] = scene.proj(la, lo);
                    return <circle key={i} cx={x} cy={y} r={3.5 / view.k} fill="#0284c7" />;
                  })}
                  {drawPts.length > 2 ? (
                    <path
                      d={`M${drawPts.map(([la, lo]) => scene.proj(la, lo).join(" ")).join(" L")} Z`}
                      fill="#0ea5e9" fillOpacity={0.12} stroke="none"
                    />
                  ) : null}
                </g>
              ) : null}

              {addPin ? (
                <g pointerEvents="none">
                  {(() => {
                    const [cx, cy] = scene.proj(addPin.lat, addPin.lon);
                    return (
                      <g>
                        <circle cx={cx} cy={cy} r={9 / view.k} fill="#16a34a" opacity={0.18} />
                        <circle cx={cx} cy={cy} r={4 / view.k} fill="#16a34a" stroke="#fff" strokeWidth={1.6 / view.k} />
                        <line x1={cx - 14 / view.k} y1={cy} x2={cx + 14 / view.k} y2={cy} stroke="#16a34a" strokeWidth={1 / view.k} />
                        <line x1={cx} y1={cy - 14 / view.k} x2={cx} y2={cy + 14 / view.k} stroke="#16a34a" strokeWidth={1 / view.k} />
                      </g>
                    );
                  })()}
                </g>
              ) : null}

              {probe ? (
                <g pointerEvents="none">
                  {[1, 2, 5, 10].map((r) => (
                    <circle
                      key={r}
                      cx={scene.proj(probe.lat, probe.lon)[0]}
                      cy={scene.proj(probe.lat, probe.lon)[1]}
                      r={r / scene.kmPerUnit}
                      fill="none"
                      stroke="#be123c"
                      strokeOpacity={r <= 2 ? 0.85 : 0.45}
                      strokeWidth={1.4}
                      strokeDasharray={r <= 2 ? "none" : "5 4"}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                  <circle
                    cx={scene.proj(probe.lat, probe.lon)[0]}
                    cy={scene.proj(probe.lat, probe.lon)[1]}
                    r={4 / view.k}
                    fill="#be123c"
                    stroke="#fff"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              ) : null}

              {selectedS ? (
                <circle
                  cx={scene.pts[indexOf.get(selectedS.id)!].x}
                  cy={scene.pts[indexOf.get(selectedS.id)!].y}
                  r={scene.pts[indexOf.get(selectedS.id)!].r + 5}
                  fill="none"
                  stroke="#0f172a"
                  strokeWidth={1.2}
                  strokeDasharray="3 3"
                />
              ) : null}

              {/* origin of every distance on this map: a crosshair, not a dot */}
              {(() => {
                const [cx, cy] = scene.proj(data.meta.referenceLat, data.meta.referenceLon);
                return (
                  <g pointerEvents="none">
                    <circle cx={cx} cy={cy} r={7 / view.k} fill="#fff" opacity={0.9} />
                    <circle
                      cx={cx}
                      cy={cy}
                      r={4 / view.k}
                      fill={COLORS.reference}
                      stroke="#fff"
                      strokeWidth={1.6 / view.k}
                    />
                    {[10, 15].map((t) => (
                      <g key={t} stroke={COLORS.reference} strokeWidth={1.4 / view.k} opacity={0.9}>
                        <line x1={cx - t / view.k} y1={cy} x2={cx + t / view.k} y2={cy} />
                        <line x1={cx} y1={cy - t / view.k} x2={cx} y2={cy + t / view.k} />
                      </g>
                    ))}
                  </g>
                );
              })()}



              <g data-layer="labels">{labelLayer}</g>
            </g>

          </svg>
          {layers.sat ? (
            <div className="pointer-events-none absolute bottom-1 left-2 z-10 rounded bg-white/85 px-1.5 py-0.5 text-[9.5px] text-[#334155] shadow-sm">
              تصویر: Esri · Maxar · Earthstar Geographics
            </div>
          ) : null}

          {layers.sites && data.sites.length ? (
            <details className="absolute bottom-2 left-2 z-20 w-[246px] max-w-[80vw] rounded-xl border border-line bg-surface/97 text-[10.5px] shadow-lg">
              <summary className="cursor-pointer list-none px-2 py-1.5 font-medium text-ink">
                پیشنهاد در سطح بلوک جمعیتی · {data.sites.length.toLocaleString("fa-IR")} مورد
              </summary>
              <p className="border-t border-line px-2 py-1 text-[9.5px] leading-4 text-faint">
                امتیاز ۰ تا ۱ از جمعیت، شمارش داروخانه، درمانگران و دسترسی. با «کمبود
                داروخانه» در جدول آبادی‌ها یکی نیست — آن یکی در واحد «تعداد داروخانه» است.
              </p>
              <ol className="max-h-52 overflow-auto border-t border-line px-1 py-1">
                {data.sites.slice(0, 12).map((site) => (
                  <li key={site.rank}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelSite(site.rank);
                        const [sx, sy] = scene.proj(site.lat, site.lon);
                        commit(12, W / 2 - sx * 12, H / 2 - sy * 12);
                      }}
                      className="flex w-full items-baseline justify-between gap-1 rounded px-1 py-0.5 text-right hover:bg-surface-2"
                    >
                      <span className="tnum w-4 text-faint">{site.rank}</span>
                      <span className="flex-1 truncate text-ink-soft">
                        {site.settlement ?? "—"}
                        {site.settleKm > 0.15 ? (
                          <span className="text-faint">
                            {" "}
                            {site.settleKm.toLocaleString("fa-IR", { maximumFractionDigits: 1 })}کم
                          </span>
                        ) : null}
                      </span>
                      <span className="tnum text-[9.5px] text-muted">
                        {Math.round(site.demand / 1000)}k
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </details>
          ) : null}

          {selSite !== null ? (() => {
            const site = data.sites.find((x) => x.rank === selSite);
            if (!site) return null;
            return (
              <div className="absolute bottom-2 right-2 z-30 max-h-[76vh] w-[290px] max-w-[88vw] overflow-auto rounded-xl border border-[#16a34a]/40 bg-surface p-2.5 text-[11px] shadow-xl">
                <div className="flex items-start justify-between gap-2">
                  <b className="text-[12px] text-ink">
                    پیشنهاد #{site.rank} · {site.settlement ?? "—"}
                    {site.settleKm > 0.15 ? (
                      <span className="font-normal text-muted">
                        {" "}
                        ({site.settleKm.toLocaleString("fa-IR", { maximumFractionDigits: 1 })} کم از مرکز)
                      </span>
                    ) : null}
                  </b>
                  <button
                    type="button"
                    onClick={() => setSelSite(null)}
                    className="rounded border border-line-strong px-1 text-[10px] text-muted"
                  >
                    ×
                  </button>
                </div>
                <div className="mt-0.5 text-[10.5px] text-muted">
                  {site.county ?? ""} · امتیاز {site.score.toFixed(2)}
                  {site.scoreHigh > site.scoreLow + 0.005 ? (
                    <span className="tnum text-faint" title="بازه: یک رقیب تازه باز شود و جمعیت ۲۰٪ خطا داشته باشد">
                      {" "}
                      <bdi dir="ltr">
                        ({site.scoreLow.toFixed(2)}–{site.scoreHigh.toFixed(2)})
                      </bdi>
                    </span>
                  ) : null}
                </div>
                {/* the ranking already writes this sentence — it was never shown */}
                <p className="mt-1 rounded bg-surface-2 px-1.5 py-1 text-[10px] leading-4 text-ink-soft">
                  {site.reason}
                </p>
                <ul className="mt-1 space-y-0.5 text-[10.5px] text-ink-soft">
                  <li>جمعیت در ۱٫۲ کم: <b className="tnum">{Math.round(site.demand).toLocaleString("fa-IR")}</b></li>
                  <li>داروخانهٔ ثبت‌شده: <b className="tnum">{site.supplyMapped.toFixed(0)}</b> · مجوز ثبت‌نشده: <b className="tnum">{site.supplyExpected.toFixed(0)}</b></li>
                  <li>امتیاز درمانی (پزشک/کلینیک/بیمارستان): <b className="tnum">{site.anchors.toFixed(1)}</b></li>
                  <li>نفر به ازای هر داروخانه: <b className="tnum">{Math.round(site.gap).toLocaleString("fa-IR")}</b></li>
                  <li>فاصلهٔ جاده‌ای از اهواز: <b className="tnum">{Math.round(site.roadKm).toLocaleString("fa-IR")}</b> کم</li>
                </ul>
                {(() => {
                  const rivals = data.pharmacies
                    .map((p) => ({ p, d: havKm(site.lat, site.lon, p.lat, p.lon) }))
                    .filter((x) => x.d <= 1.2)
                    .sort((a, b) => a.d - b.d);
                  return (
                    <div className="mt-1.5 rounded bg-surface-2 px-1.5 py-1">
                      <div className="flex items-center justify-between text-[10px] text-muted">
                        <b className="text-ink">رقبا در ۱٫۲ کیلومتر</b>
                        <span className="tnum">{rivals.length.toLocaleString("fa-IR")}</span>
                      </div>
                      {rivals.length ? (
                        <ul className="mt-0.5 space-y-0.5 text-[9.5px] text-muted">
                          {rivals.slice(0, 3).map((r) => (
                            <li key={r.p.id} className="flex items-center justify-between gap-1">
                              <span className="truncate">{r.p.name}</span>
                              <span className="tnum shrink-0 text-faint">
                                {r.d.toLocaleString("fa-IR", { maximumFractionDigits: 2 })} کم
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-0.5 text-[9.5px] text-good">بدون داروخانهٔ نقشه‌شده</p>
                      )}
                    </div>
                  );
                })()}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={async () => {
                      await fetch("/api/shortlist", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ rank: site.rank }),
                      });
                      router.refresh();
                    }}
                    className="rounded-lg border border-brand bg-brand-soft px-2 py-1 text-[10.5px] font-medium text-brand-ink"
                  >
                    افزودن به فهرست
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const [sx, sy] = scene.proj(site.lat, site.lon);
                      commit(14, W / 2 - sx * 14, H / 2 - sy * 14);
                    }}
                    className="rounded-lg border border-[#16a34a] bg-[#16a34a] px-2 py-1 text-[10.5px] font-medium text-white"
                  >
                    بزرگ‌نمایی ۱۴×
                  </button>
                  <a
                    href={`https://www.google.com/maps?q=${site.lat},${site.lon}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[10.5px] text-ink-soft"
                  >
                    گوگل‌مپ ↗
                  </a>
                </div>
              </div>
            );
          })() : null}

          {markMode && markPin ? (
            <div className="absolute bottom-2 right-2 z-30 w-[276px] max-w-[86vw] rounded-xl border border-accent/40 bg-surface p-2.5 text-[11px] shadow-xl">
              <div className="flex items-center justify-between gap-2">
                <b className="text-[12px] text-ink">مکان برای بازدید</b>
                <span className="text-[9.5px] text-faint">
                  <bdi dir="ltr">{markPin.lat.toFixed(5)}, {markPin.lon.toFixed(5)}</bdi>
                </span>
              </div>
              <input
                autoFocus
                value={markName}
                onChange={(e) => setMarkName(e.target.value)}
                placeholder="نام مکان (مثلاً نبش خیابان …)"
                className="mt-1.5 w-full rounded-lg border border-line-strong bg-surface-2 px-2 py-1.5 text-[11.5px] text-ink placeholder:text-faint"
              />
              <input
                value={markNote}
                onChange={(e) => setMarkNote(e.target.value)}
                placeholder="یادداشت: اجاره، متراژ، تماس…"
                className="mt-1 w-full rounded-lg border border-line-strong bg-surface-2 px-2 py-1.5 text-[11px] text-ink placeholder:text-faint"
              />
              <label className="mt-1 flex items-center gap-1.5 text-[10.5px] text-muted">
                اولویت سفر
                <select
                  value={markPriority}
                  onChange={(e) => setMarkPriority(Number(e.target.value))}
                  className="rounded-md border border-line-strong bg-surface-2 px-1 py-0.5 text-[11px] text-ink"
                >
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                    <option key={n} value={n}>
                      {n === 1 ? "۱ — اول" : n === 9 ? "۹ — آخر" : toPersianDigits(n)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={markBusy || markName.trim().length < 2}
                  onClick={async () => {
                    setMarkBusy(true);
                    await fetch("/api/prospects", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        name: markName,
                        lat: markPin.lat,
                        lon: markPin.lon,
                        note: markNote,
                        priority: markPriority,
                      }),
                    });
                    setMarkBusy(false);
                    setMarkName("");
                    setMarkNote("");
                    setMarkPin(null);
                    setMarkMode(false);
                    router.refresh();
                  }}
                  className="rounded-lg border border-accent bg-accent px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                >
                  {markBusy ? "…" : "افزودن به فهرست"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMarkPin(null);
                    setMarkName("");
                    setMarkNote("");
                  }}
                  className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[11px] text-muted"
                >
                  لغو
                </button>
              </div>
            </div>
          ) : null}

          {drawMode && drawKind === "measure" ? (
            <div className="absolute bottom-2 right-2 z-30 w-[290px] max-w-[88vw] rounded-xl border border-warn/40 bg-surface p-2.5 text-[11px] shadow-xl">
              <div className="flex items-center justify-between gap-2">
                <b className="text-[12px] text-ink">اندازه‌گیری مساحت</b>
                <span className="tnum text-[9.5px] text-faint">{drawPts.length} نقطه</span>
              </div>
              {drawPts.length < 3 ? (
                <p className="mt-1 text-[10px] leading-4 text-muted">
                  روی نقشه کلیک کنید تا گوشه‌ها را ببندید؛ از سه نقطه به بعد اندازه و جمعیت
                  تخمینی محاسبه می‌شود.
                </p>
              ) : measure ? (
                <div className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10.5px]">
                  <span className="text-faint">مساحت کل</span>
                  <span className="tnum text-left font-bold text-ink">{num(measure.areaKm2, 2)} کم²</span>
                  <span className="text-faint">سطح مسکونی</span>
                  <span className="tnum text-left text-ink-soft">{num(measure.residentialKm2, 2)} کم²</span>
                  <span className="text-faint">جمعیت تخمینی</span>
                  <span className="tnum text-left font-bold text-ink">{group(measure.population)}</span>
                  <span className="text-faint">تراکم</span>
                  <span className="tnum text-left text-ink-soft">{group(measure.density)} /کم²</span>
                  <span className="text-faint">داروخانه داخل محدوده</span>
                  <span className="tnum text-left text-ink-soft">{group(measure.pharmacies)}</span>
                </div>
              ) : (
                <p className="mt-1 text-[10px] text-faint">محاسبه…</p>
              )}
              {measure ? (
                <p className="mt-1 text-[9px] leading-3 text-faint">{measure.method}</p>
              ) : null}
              <input
                value={drawName}
                onChange={(e) => setDrawName(e.target.value)}
                placeholder="نام محدوده (مثلاً کوی منتظری)"
                className="mt-1.5 w-full rounded-lg border border-line-strong bg-surface-2 px-2 py-1.5 text-[11.5px] text-ink placeholder:text-faint"
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={drawBusy || !measure || drawName.trim().length < 2}
                  onClick={async () => {
                    setDrawBusy(true);
                    await fetch("/api/measure", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: drawName, points: drawPts }),
                    });
                    setDrawBusy(false);
                    setDrawPts([]);
                    setDrawName("");
                    setMeasure(null);
                    setDrawMode(false);
                    router.refresh();
                  }}
                  className="rounded-lg border border-warn bg-warn px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                >
                  {drawBusy ? "…" : "ذخیره برای مقایسه"}
                </button>
                <button
                  type="button"
                  onClick={() => setDrawPts((p) => p.slice(0, -1))}
                  disabled={!drawPts.length}
                  className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[11px] text-muted disabled:opacity-40"
                >
                  واگرد
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDrawPts([]);
                    setDrawName("");
                    setMeasure(null);
                    setDrawMode(false);
                  }}
                  className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[11px] text-muted"
                >
                  بستن
                </button>
              </div>
            </div>
          ) : null}

          {drawMode && drawKind === "survey" ? (
            <div className="absolute bottom-2 right-2 z-30 w-[276px] max-w-[86vw] rounded-xl border border-[#0284c7]/40 bg-surface p-2.5 text-[11px] shadow-xl">
              <div className="flex items-center justify-between gap-2">
                <b className="text-[12px] text-ink">محدودهٔ بررسی‌شده</b>
                <span className="tnum text-[9.5px] text-faint">{drawPts.length} نقطه</span>
              </div>
              <p className="mt-1 text-[10px] leading-4 text-muted">
                روی نقشه کلیک کنید تا گوشه‌ها را ببندید؛ از سه نقطه به بعد قابل ثبت است.
              </p>
              <input
                value={drawName}
                onChange={(e) => setDrawName(e.target.value)}
                placeholder="نام محله یا محدوده"
                className="mt-1.5 w-full rounded-lg border border-line-strong bg-surface-2 px-2 py-1.5 text-[11.5px] text-ink placeholder:text-faint"
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  disabled={drawBusy || drawPts.length < 3 || drawName.trim().length < 2}
                  onClick={async () => {
                    setDrawBusy(true);
                    await fetch("/api/surveys", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ name: drawName, points: drawPts }),
                    });
                    setDrawBusy(false);
                    setDrawPts([]);
                    setDrawName("");
                    setDrawMode(false);
                    router.refresh();
                  }}
                  className="rounded-lg border border-[#0284c7] bg-[#0284c7] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                >
                  {drawBusy ? "…" : "ثبت محدوده"}
                </button>
                <button
                  type="button"
                  onClick={() => setDrawPts((p) => p.slice(0, -1))}
                  disabled={!drawPts.length}
                  className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[11px] text-muted disabled:opacity-40"
                >
                  واگرد
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDrawPts([]);
                    setDrawName("");
                    setDrawMode(false);
                  }}
                  className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[11px] text-muted"
                >
                  لغو
                </button>
              </div>
            </div>
          ) : null}

          {addMode && addPin ? (
            <div className="absolute bottom-2 right-2 z-30 w-[268px] max-w-[86vw] rounded-xl border border-good/40 bg-surface p-2.5 text-[11px] shadow-xl">
              <div className="flex items-center justify-between gap-2">
                <b className="text-[12px] text-ink">
                  {addKind === "pharmacy" ? "داروخانهٔ جدید" : "مکان درمانی جدید"}
                </b>
                <span className="text-[9.5px] text-faint">
                  <bdi dir="ltr">
                    {addPin.lat.toFixed(5)}, {addPin.lon.toFixed(5)}
                  </bdi>
                </span>
              </div>
              <select
                value={addKind}
                onChange={(e) => setAddKind(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-line-strong bg-surface-2 px-2 py-1.5 text-[11.5px] text-ink"
              >
                <option value="pharmacy">داروخانه</option>
                <option value="clinic">درمانگاه / کلینیک</option>
                <option value="doctor">مطب پزشک</option>
                <option value="dentist">دندانپزشکی</option>
                <option value="hospital">بیمارستان</option>
                <option value="lab">آزمایشگاه</option>
              </select>
              <input
                autoFocus
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder={addKind === "pharmacy" ? "نام داروخانه (الزامی)" : "نام مکان (الزامی)"}
                className="mt-1.5 w-full rounded-lg border border-line-strong bg-surface-2 px-2 py-1.5 text-[11.5px] text-ink placeholder:text-faint"
              />
              <input
                value={addAddr}
                onChange={(e) => setAddAddr(e.target.value)}
                placeholder="نشانی (اختیاری)"
                className="mt-1 w-full rounded-lg border border-line-strong bg-surface-2 px-2 py-1.5 text-[11px] text-ink placeholder:text-faint"
              />
              <input
                value={addPhone}
                onChange={(e) => setAddPhone(e.target.value)}
                placeholder="تلفن (اختیاری)"
                dir="ltr"
                className="mt-1 w-full rounded-lg border border-line-strong bg-surface-2 px-2 py-1.5 text-left text-[11px] text-ink placeholder:text-right placeholder:text-faint"
              />
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={addBusy || addName.trim().length < 3}
                  onClick={async () => {
                    setAddBusy(true);
                    setAddMsg(null);
                    try {
                      const r = await fetch("/api/pharmacies", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          kind: addKind,
                          name: addName,
                          lat: addPin.lat,
                          lon: addPin.lon,
                          address: addAddr,
                          phone: addPhone,
                        }),
                      });
                      const j = (await r.json()) as {
                        ok?: boolean;
                        error?: string;
                        settlement?: string;
                        km?: number;
                        kindFa?: string;
                      };
                      if (r.ok && j.ok) {
                        setAddMsg({
                          ok: true,
                          text: `${j.kindFa ?? ""} ثبت شد · ${j.settlement ?? ""} (${j.km ?? 0} کم)`,
                        });
                        setAddName("");
                        setAddAddr("");
                        setAddPhone("");
                        /* keep the pin and the form: clearing them unmounted the success
                           message in the same tick, so the user saw nothing happen */
                        refreshSoon();
                      } else {
                        setAddMsg({ ok: false, text: j.error ?? "ثبت نشد" });
                      }
                    } catch {
                      setAddMsg({ ok: false, text: "ارتباط با سرور برقرار نشد" });
                    } finally {
                      setAddBusy(false);
                    }
                  }}
                  className="rounded-lg border border-good bg-good px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-40"
                >
                  {addBusy ? "…" : "ذخیره"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAddPin(null);
                    setAddMsg(null);
                  }}
                  className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[11px] text-muted"
                >
                  لغو
                </button>
                <span className="text-[9.5px] text-faint">
                  روی نقشه کلیک کنید تا نقطه عوض شود
                </span>
              </div>
              {addMsg ? (
                <div
                  className={`mt-1.5 rounded-lg border px-2 py-1 text-[10.5px] ${
                    addMsg.ok
                      ? "border-good/25 bg-good-soft text-good"
                      : "border-danger/25 bg-danger-soft text-danger"
                  }`}
                >
                  {addMsg.text}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* zoom + legend */}
          <div className="absolute left-2 top-2 flex flex-col gap-1">
            {([
              ["+", () => zoomBy(1.5)],
              ["−", () => zoomBy(1 / 1.5)],
              ["⌂", () => commit(1, 0, 0)],
            ] as [string, () => void][]).map(([label, fn]) => (
              <button
                key={String(label)}
                type="button"
                onClick={fn}
                className="h-7 w-7 rounded-md border border-line-strong bg-surface/95 text-[13px] font-bold text-ink-soft shadow-sm hover:border-brand hover:text-brand-ink"
              >
                {label}
              </button>
            ))}
          </div>



          {hoverMed ? (
            <div
              className="pointer-events-none absolute z-10 w-52 max-w-[72vw] rounded-lg border border-[#7c3aed]/40 bg-surface/98 p-2 text-[11px] shadow-lg"
              style={{
                left: Math.max(
                  4,
                  Math.min(
                    (svgRef.current?.clientWidth ?? 400) - 214,
                    (hoverMed.x ?? 0) + 14,
                  ),
                ),
                top: Math.max(
                  4,
                  Math.min(
                    (hoverMed.y ?? 0) + 12,
                    (svgRef.current?.clientHeight ?? 400) - 78,
                  ),
                ),
              }}
            >
              <div className="flex items-baseline justify-between gap-1">
                <b className="text-[12px] text-ink">{data.medical[hoverMed.i].name}</b>
                <span className="rounded bg-[#7c3aed]/10 px-1 text-[9px] text-[#7c3aed]">
                  {{ doctor: "پزشک", clinic: "کلینیک", dentist: "دندان‌پزشک", hospital: "بیمارستان", lab: "آزمایشگاه" }[
                    data.medical[hoverMed.i].kind
                  ]}
                </span>
              </div>
              <div className="text-[10.5px] text-muted">
                {data.medical[hoverMed.i].settlement ?? "—"}
                {data.medical[hoverMed.i].county ? ` › ${data.medical[hoverMed.i].county}` : ""}
              </div>
              <div className="mt-0.5 text-[10px] text-faint">کلیک = پروفایل و رقابت ۱ کیلومتری</div>
            </div>
          ) : null}

          {hoverPharm ? (
            <div
              className="pointer-events-none absolute z-10 w-56 max-w-[72vw] rounded-lg border border-warn/40 bg-surface/98 p-2 text-[11px] shadow-lg"
              style={{
                left: Math.max(
                  4,
                  Math.min(
                    (svgRef.current?.clientWidth ?? 400) - 232,
                    (hoverPharm.x ?? 0) + 14,
                  ),
                ),
                top: Math.max(
                  4,
                  Math.min(
                    (hoverPharm.y ?? 0) + 12,
                    (svgRef.current?.clientHeight ?? 400) - 92,
                  ),
                ),
              }}
            >
              <div className="flex items-baseline justify-between gap-1">
                <b className="text-[12px] text-ink">{data.pharmacies[hoverPharm.i].name}</b>
                <span className="rounded bg-warn-soft px-1 text-[9px] text-warn">
                  {data.pharmacies[hoverPharm.i].source === "osm"
                    ? "OSM"
                    : data.pharmacies[hoverPharm.i].source === "neshan"
                      ? "نشان"
                      : data.pharmacies[hoverPharm.i].source === "google"
                        ? "گوگل"
                        : data.pharmacies[hoverPharm.i].source}
                </span>
              </div>
              <div className="text-[10.5px] text-muted">
                {data.pharmacies[hoverPharm.i].settlement ?? "—"}
                {data.pharmacies[hoverPharm.i].county
                  ? ` › ${shortCounty(data.pharmacies[hoverPharm.i].county ?? "")}`
                  : ""}
              </div>
              <div className="tnum mt-0.5 text-[10.5px] text-faint">
                {num(data.pharmacies[hoverPharm.i].lat, 4)} ,{" "}
                {num(data.pharmacies[hoverPharm.i].lon, 4)} ·{" "}
                {fmtKm(data.pharmacies[hoverPharm.i].km)} از آبادی
              </div>
            </div>
          ) : null}

          {hoverS ? (
            <div
              className="pointer-events-none absolute z-10 w-56 max-w-[72vw] rounded-lg border border-line bg-surface/98 p-2 text-[11px] shadow-lg"
              style={{
                left: Math.max(
                  4,
                  Math.min(
                    (svgRef.current?.clientWidth ?? 400) - 232,
                    (hover?.x ?? 0) + 14,
                  ),
                ),
                top: Math.max(4, Math.min((hover?.y ?? 0) + 12, 300)),
              }}
            >
              <div className="flex items-baseline justify-between gap-1">
                <b className="text-[12px] text-ink">{hoverS.name}</b>
                <span className="text-[10px] text-faint">{KIND_FA[hoverS.kind]}</span>
              </div>
              <div className="text-[10.5px] text-muted">
                {[hoverS.county, hoverS.bakhsh && `بخش ${hoverS.bakhsh}`, hoverS.dehestan]
                  .filter(Boolean)
                  .join(" › ")}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10.5px]">
                <span className="text-faint">جمعیت</span>
                <span className="tnum text-left font-medium">{fmtPop(hoverS.pop)}</span>
                <span className="text-faint">داروخانه (FDA)</span>
                <span className="tnum text-left font-medium">{group(hoverS.ph)}</span>
                <span className="text-faint">نقشه‌شده</span>
                <span className="tnum text-left font-medium text-brand-ink">
                  {group(hoverS.mapped)}
                </span>
                {hoverS.ph > hoverS.mapped ? (
                  <>
                    <span className="text-faint">بدون موقعیت</span>
                    <span className="tnum text-left font-medium text-warn">
                      {group(hoverS.ph - hoverS.mapped)}
                    </span>
                  </>
                ) : null}
                <span className="text-faint">از اهواز</span>
                <span className="tnum text-left font-medium">{fmtKm(hoverS.dist)}</span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-soft">
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS.city }} />
            شهر
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: COLORS.village }} />
            روستا
          </span>
          <span className="flex items-center gap-1">
            <span
              className="h-2 w-2 rounded-full border"
              style={{ borderColor: COLORS.pharmacy, background: "#fff" }}
            />
            دارای داروخانه در فید سازمان
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex h-2 w-24 overflow-hidden rounded-full">
              {(mode === "dens" ? DENS_RAMP : mode === "gap" ? GAP_RAMP : RATIO_RAMP).map((c) => (
                <span key={c} className="flex-1" style={{ background: c }} />
              ))}
            </span>
            {mode === "dens"
              ? view.k >= 1.8
                ? "داروخانه در هر کم² (۱٫۵ کم) · خاکستری = مسکونی بدون داروخانهٔ نقشه‌شده"
                : "داروخانه به ازای ۱۰٬۰۰۰ نفر"
              : mode === "ratio"
                ? "نفر به ازای هر داروخانه · آبی = پوشش، قرمز = کمبود"
                : "شکاف ظرفیت کم → زیاد"}
            <span className="text-faint">
              {view.k >= 3.4 ? "· شبکهٔ ۱ کم" : `· فقط مسکونی`}
            </span>
          </span>
          <span className="flex items-center gap-1">
            <span className="text-[11px] font-bold text-[#7c3aed]">✚</span>
            پزشک / کلینیک / بیمارستان
          </span>
          <span className="flex items-center gap-1">
            <svg width="11" height="13" viewBox="0 0 11 13" aria-hidden>
              <path
                d="M5.5 12.4C2.2 9.6 0.6 7.4 0.6 4.9a4.9 4.9 0 0 1 9.8 0c0 2.5-1.6 4.7-4.9 7.5Z"
                fill="#4338ca"
                stroke="#1e1b4b"
              />
              <circle cx="5.5" cy="4.9" r="1.7" fill="#fff" />
            </svg>
            داروخانهٔ دست‌افزوده (سنجاق)
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: COLORS.reference }} />
            {data.meta.referenceName} (مبدأ فاصله)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-[3px] w-[90px] rounded-full bg-ink-soft/70" />
            {group(scaleBar.km)} کیلومتر
          </span>
          <span className="flex items-center gap-1">
            <span className="h-0 w-4 border-t border-dashed border-brand" />
            دایره‌های خط‌چین: فاصله از {data.meta.referenceName} (۲۵ تا ۳۰۰ کیلومتر)
          </span>
          <span className="text-faint">
            چرخ ماوس = بزرگ‌نمایی · کشیدن = جابه‌جایی · کلیک روی نقطه = جزئیات
          </span>
        </div>
      </div>

      {/* --------------------------------------------------------- sidebar -- */}
      <div className="flex min-w-0 flex-col gap-3">
        <MeasurePanel
          items={data.measurements}
          onFocus={(m) => {
            const lat = m.points.reduce((t, p) => t + p[0], 0) / m.points.length;
            const lon = m.points.reduce((t, p) => t + p[1], 0) / m.points.length;
            flyLatLon(lat, lon, 14);
          }}
          onRemove={async (m) => {
            await fetch(`/api/measure?id=${m.id}`, { method: "DELETE" });
            router.refresh();
          }}
        />

        <VisitPanel
          items={data.prospects}
          onFocus={(p) => flyLatLon(p.lat, p.lon, 15)}
          onCycle={async (p) => {
            await fetch("/api/prospects", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: p.id, status: nextStatus(p.status) }),
            });
            router.refresh();
          }}
          onRemove={async (p) => {
            await fetch(`/api/prospects?id=${p.id}`, { method: "DELETE" });
            router.refresh();
          }}
          onPriority={async (p, next) => {
            await fetch("/api/prospects", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: p.id, priority: next }),
            });
            router.refresh();
          }}
        />

        <SurveyPanel
          items={data.surveys}
          onFocus={(a) => {
            const lat = a.points.reduce((t, p) => t + p[0], 0) / a.points.length;
            const lon = a.points.reduce((t, p) => t + p[1], 0) / a.points.length;
            flyLatLon(lat, lon, 13);
          }}
          onRemove={async (a) => {
            await fetch(`/api/surveys?id=${a.id}`, { method: "DELETE" });
            router.refresh();
          }}
        />

        <ShortlistPanel
          items={data.shortlist}
          onRemove={async (id) => {
            await fetch(`/api/shortlist?id=${id}`, { method: "DELETE" });
            router.refresh();
          }}
          onFocus={(it) => {
            setSelSite(it.rank);
            flyLatLon(it.lat, it.lon, 14);
          }}
        />

        <PlacePanel
          key={`${selPharm ?? "x"}-${selMed ?? "x"}`}
          pharm={selPharm !== null ? data.pharmacies[selPharm] : null}
          medical={selMed !== null ? data.medical[selMed] : null}
          pharmacies={data.pharmacies}
          medicals={data.medical}
          onChanged={refreshSoon}
          onClose={() => {
            setSelPharm(null);
            setSelMed(null);
          }}
        />

        <div className="rounded-2xl border border-line bg-surface p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.12)]">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[13px] font-semibold text-ink">گسترش از اهواز</span>
            <span className="tnum rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-bold text-brand-ink">
              {group(radius)} کیلومتر
            </span>
          </div>
          <input
            type="range"
            min={10}
            max={300}
            step={5}
            value={radius}
            onChange={(e) => setRadius(Number(e.target.value))}
            className="w-full"
          />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {RING_EDGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRadius(r)}
                className={`rounded-md border px-1.5 py-0.5 text-[10.5px] transition ${
                  radius === r
                    ? "border-brand/40 bg-brand-soft text-brand-ink"
                    : "border-line bg-surface text-muted hover:text-ink"
                }`}
              >
                {group(r)}
              </button>
            ))}
          </div>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <div className="rounded-lg bg-surface-2 px-2 py-1.5">
              <div className="text-[10px] text-muted">سکونتگاه در شعاع</div>
              <div className="tnum text-[13px] font-bold text-ink">{group(stats.n)}</div>
            </div>
            <div className="rounded-lg bg-surface-2 px-2 py-1.5">
              <div className="text-[10px] text-muted">جمعیت</div>
              <div className="tnum text-[13px] font-bold text-ink">{group(stats.pop)}</div>
            </div>
            <div className="rounded-lg bg-surface-2 px-2 py-1.5">
              <div className="text-[10px] text-muted">داروخانه</div>
              <div className="tnum text-[13px] font-bold text-ink">{group(stats.ph)}</div>
            </div>
            <div className="rounded-lg bg-surface-2 px-2 py-1.5">
              <div className="text-[10px] text-muted">بدون داروخانه</div>
              <div className="tnum text-[13px] font-bold text-warn">{group(stats.empty)}</div>
            </div>
          </div>

          <div className="mt-3 max-h-56 overflow-auto rounded-lg border border-line [scrollbar-gutter:stable]">
            <table className="w-full text-[10.5px]">
              <thead className="sticky top-0 bg-surface-2 text-muted">
                <tr>
                  <th className="px-1.5 py-1 text-right font-medium">حلقه</th>
                  <th className="px-1 py-1 text-left font-medium">آبادی</th>
                  <th className="px-1 py-1 text-left font-medium">جمعیت</th>
                  <th className="px-1 py-1 text-left font-medium">داروخانه</th>
                  <th className="px-1 py-1 text-left font-medium">نفر/داروخانه</th>
                </tr>
              </thead>
              <tbody>
                {ladder.map((b) => (
                  <tr
                    key={b.lo}
                    onClick={() => setRadius(b.hi === 9999 ? 300 : b.hi)}
                    className={`cursor-pointer border-t border-line/70 hover:bg-brand-soft/40 ${
                      radius === b.hi || (b.hi === 9999 && radius === 300)
                        ? "bg-brand-soft/60"
                        : ""
                    }`}
                  >
                    <td className="tnum px-1.5 py-1 text-right">
                      {group(b.lo)}–{b.hi === 9999 ? "∞" : group(b.hi)}
                    </td>
                    <td className="tnum px-1 py-1 text-left">{group(b.n)}</td>
                    <td className="tnum px-1 py-1 text-left">{group(b.pop)}</td>
                    <td className="tnum px-1 py-1 text-left">{group(b.ph)}</td>
                    <td className="tnum px-1 py-1 text-left">
                      {b.ph ? group(Math.round(b.pop / b.ph)) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1 text-[10px] leading-4 text-faint">
            حلقه = فاصلهٔ جاده‌ای از {data.meta.referenceName}؛ هر ردیف را بزنید تا شعاع
            جستجو روی همان لبه تنظیم شود.
          </p>
        </div>

        {probeStats ? (
          <div className="rounded-2xl border border-danger/25 bg-surface p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.12)]">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[13px] font-semibold text-danger">تحلیل نقطهٔ انتخابی</div>
                <div className="tnum text-[10.5px] leading-4 text-muted">
                  {num(probeStats.point.lat, 4)} , {num(probeStats.point.lon, 4)}
                </div>
                <div className="text-[10.5px] leading-4 text-muted">
                  {fmtKm(probeStats.distAhvaz)} از {data.meta.referenceName}
                  {probeStats.nearestCity
                    ? ` · نزدیک‌ترین شهر: ${probeStats.nearestCity.s.name} (${fmtKm(probeStats.nearestCity.km)})`
                    : ""}
                  {probeStats.nearestPharm
                    ? ` · نزدیک‌ترین داروخانهٔ نقشه‌شده: ${probeStats.nearestPharm.name} (${fmtKm(probeStats.nearestPharm.km)})`
                    : " · هیچ داروخانهٔ نقشه‌شده‌ای ثبت نشده"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setProbe(null)}
                className="rounded-md border border-line-strong px-1.5 py-0.5 text-[10px] text-muted hover:text-ink"
              >
                بستن
              </button>
            </div>

            <table className="mt-2 w-full text-[10.5px]">
              <thead className="text-muted">
                <tr>
                  <th className="py-1 text-right font-medium">شعاع</th>
                  <th className="py-1 text-left font-medium">آبادی</th>
                  <th className="py-1 text-left font-medium">جمعیت</th>
                  <th className="py-1 text-left font-medium">داروخانه</th>
                  <th className="py-1 text-left font-medium">نفر/داروخانه</th>
                  <th className="py-1 text-left font-medium">شکاف</th>
                </tr>
              </thead>
              <tbody>
                {probeStats.radii.map((r) => (
                  <tr key={r.r} className="border-t border-line/70">
                    <td className="tnum py-1 text-right">{group(r.r)} کم</td>
                    <td className="tnum py-1 text-left">{group(r.n)}</td>
                    <td className="tnum py-1 text-left">{group(r.pop)}</td>
                    <td className="tnum py-1 text-left">{group(r.ph)}</td>
                    <td className="tnum py-1 text-left">{r.perPharm ? group(r.perPharm) : "—"}</td>
                    <td className={`tnum py-1 text-left font-medium ${r.gap > 0 ? "text-warn" : "text-muted"}`}>
                      {signed(r.gap)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-2 text-[10px] text-muted">نزدیک‌ترین آبادی‌ها</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {probeStats.nearest.map((n) => (
                <button
                  key={n.s.id}
                  type="button"
                  onClick={() => select(n.s, false)}
                  className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-soft hover:border-brand hover:text-brand-ink"
                >
                  {n.s.name} · {fmtKm(n.km)}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] leading-4 text-faint">
              جمعیت و داروخانه از سکونتگاه‌هایی است که مرکزشان داخل حلقه افتاده؛
              شکاف = جمعیت ÷ هدف ({group(targetPerPharm)}) منهای داروخانه.
            </p>
          </div>
        ) : null}

        {selectedS ? (
          /* order-first: you just clicked this settlement, its card belongs at the top of
             the column instead of six cards down */
          <div className="order-first rounded-2xl border border-brand/25 bg-surface p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.12)]">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[15px] font-bold text-ink">{selectedS.name}</div>
                <div className="text-[10.5px] leading-4 text-muted">
                  استان خوزستان › {selectedS.county ?? "—"}
                  {selectedS.bakhsh ? ` › بخش ${selectedS.bakhsh}` : ""}
                  {selectedS.dehestan ? ` › ${selectedS.dehestan}` : ""}
                </div>
              </div>
              <span className="rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
                {KIND_FA[selectedS.kind]}
              </span>
            </div>
            <button
              type="button"
              onClick={() => toggleCheck("settlement", selectedS.id, !checkedSet.has(`settlement:${selectedS.id}`))}
              className={`mt-1.5 w-full rounded-lg border px-2 py-1 text-[10.5px] font-medium ${
                checkedSet.has(`settlement:${selectedS.id}`)
                  ? "border-good/50 bg-good-soft text-good"
                  : "border-line-strong bg-surface text-muted hover:border-good hover:text-good"
              }`}
              title="این مکان را بررسی کرده‌اید — برای این کاربر ذخیره می‌شود و پس از رفرش می‌ماند"
            >
              {checkedSet.has(`settlement:${selectedS.id}`)
                ? "✓ بررسی‌شده — برداشتن علامت"
                : "علامت‌گذاری به‌عنوان بررسی‌شده"}
            </button>

            <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
              {[
                ["جمعیت", fmtPop(selectedS.pop)],
                [
                  "سال/منبع",
                  selectedS.popYear
                    ? `${toPersianDigits(selectedS.popYear)} · ${sourceFa(selectedS.popSource)}`
                    : sourceFa(selectedS.popSource),
                ],
                ["داروخانه", `${group(selectedS.ph)} (${group(selectedS.phReal)} حقیقی + ${group(selectedS.phLegal)} حقوقی)`],
                ["نفر به ازای هر داروخانه", selectedS.ph ? group(Math.round((selectedS.pop ?? 0) / selectedS.ph)) : "—"],
                ["شکاف تا هدف", signed((selectedS.pop ?? 0) / targetPerPharm - selectedS.ph)],
                ["فاصله از اهواز", `${fmtKm(selectedS.dist)} · ${sourceFa(selectedS.distSource)}`],
                ["خط مستقیم", fmtKm(selectedS.straight)],
                ["شبکه/جادهٔ اندازه‌گیری‌شده", `${selectedS.net !== null ? fmtKm(selectedS.net) : "—"} / ${selectedS.road !== null ? fmtKm(selectedS.road) : "—"}`],
                ["گام‌های شبکه", selectedS.deg === null ? "—" : group(selectedS.deg)],
                ["داروخانهٔ نقشه‌شده (≤۳ کم)", group(selectedS.mapped)],
                [
                  "بدون موقعیت (FDA منهای نقشه‌شده)",
                  group(Math.max(0, selectedS.ph - selectedS.mapped)),
                ],
                ["در فید سازمان", selectedS.inFda ? "بله" : "خیر"],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <span className="text-faint">{k}</span>
                  <span className="tnum text-left font-medium text-ink-soft">{v}</span>
                </div>
              ))}
            </div>
            {/* every source, side by side: a population number is a claim, not a fact */}
            <div className="mt-2 rounded-lg bg-surface-2 p-1.5">
              <div className="mb-1 flex items-center justify-between text-[10px]">
                <b className="text-ink">جمعیت بر پایهٔ منبع</b>
                <span className="text-faint">عددی که در محاسبات استفاده می‌شود: {fmtPop(selectedS.pop)}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
                {(
                  [
                    ["admin", "تقسیمات کشوری", selectedS.popAdmin],
                    ["wiki", "ویکی‌پدیا", selectedS.popWiki],
                    ["fda", "فید سازمان", selectedS.popFda],
                    ["osm", "OpenStreetMap", selectedS.popOsm],
                    ["manual", "دستی", selectedS.popManual],
                  ] as const
                ).map(([key, label, value]) => (
                  <span key={key} className="contents">
                    <span className={popWinner === key ? "font-bold text-brand-ink" : "text-faint"}>
                      {label}
                      {popWinner === key ? " ✓" : ""}
                    </span>
                    <span className="tnum text-left text-ink-soft">
                      {value === null || value === undefined ? "—" : group(value)}
                    </span>
                  </span>
                ))}
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                <input
                  value={popDraft}
                  onChange={(e) => setPopDraft(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="جمعیت دقیق را وارد کنید"
                  dir="ltr"
                  className="tnum w-full rounded-md border border-line-strong bg-surface px-1.5 py-1 text-left text-[10.5px] text-ink placeholder:text-right placeholder:text-faint"
                />
                <button
                  type="button"
                  disabled={popBusy || !popDraft || Number(popDraft) <= 0}
                  onClick={async () => {
                    setPopBusy(true);
                    setPopMsg(null);
                    const r = await fetch("/api/population", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ areaId: selectedS.id, value: Number(popDraft) }),
                    });
                    setPopBusy(false);
                    if (r.ok) {
                      setPopMsg("ثبت شد — جدول شکاف و رتبه‌بندی به‌روز می‌شوند");
                      setPopDraft("");
                      refreshSoon();
                    } else {
                      const j = (await r.json().catch(() => ({}))) as { error?: string };
                      setPopMsg(j.error ?? "ثبت نشد");
                    }
                  }}
                  className="shrink-0 rounded-md border border-brand bg-brand-soft px-1.5 py-1 text-[10px] font-medium text-brand-ink disabled:opacity-40"
                >
                  {popBusy ? "…" : "ثبت"}
                </button>
                {selectedS.popManual !== null ? (
                  <button
                    type="button"
                    disabled={popBusy}
                    onClick={async () => {
                      setPopBusy(true);
                      await fetch(`/api/population?areaId=${selectedS.id}`, { method: "DELETE" });
                      setPopBusy(false);
                      setPopMsg("به مقدار واردشده برگشت");
                      refreshSoon();
                    }}
                    className="shrink-0 rounded-md border border-line-strong px-1.5 py-1 text-[10px] text-danger"
                    title="حذف مقدار دستی"
                  >
                    حذف
                  </button>
                ) : null}
              </div>
              {popMsg ? <p className="mt-1 text-[9.5px] text-brand-ink">{popMsg}</p> : null}
            </div>

            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => flyTo(selectedS)}
                className="rounded-lg border border-brand/30 bg-brand-soft px-2 py-1 text-[11px] font-medium text-brand-ink"
              >
                بزرگ‌نمایی روی نقطه
              </button>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[11px] text-muted"
              >
                بستن
              </button>
            </div>
          </div>
        ) : null}

        <div className="rounded-2xl border border-line bg-surface p-3">
          <div className="mb-1.5 text-[12px] font-semibold text-ink">هدف ظرفیت</div>
          <label className="flex items-center justify-between gap-2 text-[11px] text-muted">
            <span>جمعیت به ازای هر داروخانه</span>
            <input
              type="number"
              min={1000}
              max={20000}
              step={250}
              value={targetPerPharm}
              onChange={(e) => setTargetPerPharm(Math.max(500, Number(e.target.value) || 5000))}
              className="tnum w-24 rounded-lg border border-line-strong bg-surface-2 px-2 py-1 text-left text-[11px] text-ink"
            />
          </label>
          <p className="mt-1 text-[10px] leading-4 text-faint">
            مبنا: {group(data.meta.residentsPerPharmacy)} نفر در استان (از همین داده). عدد
            کوچک‌تر = استاندارد سخت‌گیرانه‌تر.
          </p>
        </div>
      </div>

      {/* ---------------------------------------------------------- table -- */}
      <div className="min-w-0 rounded-2xl border border-line bg-surface p-3 lg:col-span-2">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-ink">
              گزینه در سطح آبادی · شعاع {group(radius)} کیلومتر · معیار: کمبود داروخانه
            </span>
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-muted">
              {group(candidates.length)} مورد
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="جستجوی نام، محله، شهرستان، بخش یا دهستان…"
              className="w-56 rounded-lg border border-line-strong bg-surface-2 px-2 py-1 text-[11.5px] text-ink placeholder:text-faint"
            />
            <select
              value={minPop}
              onChange={(e) => setMinPop(Number(e.target.value))}
              className="rounded-lg border border-line-strong bg-surface-2 px-1.5 py-1 text-[11px] text-ink"
            >
              <option value={0}>هر جمعیتی</option>
              <option value={1000}>≥ ۱٬۰۰۰</option>
              <option value={5000}>≥ ۵٬۰۰۰</option>
              <option value={20000}>≥ ۲۰٬۰۰۰</option>
            </select>
            <label className="flex items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-[11px] text-muted">
              <input
                type="checkbox"
                className="h-3 w-3 accent-[#0d9488]"
                checked={onlyGap}
                onChange={(e) => setOnlyGap(e.target.checked)}
              />
              فقط دارای شکاف
            </label>
            <div className="flex overflow-hidden rounded-lg border border-line">
              {(
                [
                  ["dist", "نزدیک‌ترین"],
                  ["gap", "بیشترین شکاف"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSortBy(id)}
                  className={`px-2 py-1 text-[11px] ${
                    sortBy === id
                      ? "bg-brand-soft font-medium text-brand-ink"
                      : "bg-surface text-muted"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => downloadCsv(candidates, targetPerPharm)}
              className="rounded-lg border border-line-strong bg-surface px-2 py-1 text-[11px] text-ink-soft hover:border-brand hover:text-brand-ink"
            >
              ↓ CSV
            </button>
          </div>
        </div>

        {hoodHits.length ? (
          <div className="mb-1 flex flex-wrap gap-1">
            <span className="self-center text-[9.5px] text-faint">محله:</span>
            {hoodHits.map((n) => (
              <button
                key={n.osmId}
                type="button"
                onClick={() => flyLatLon(n.lat, n.lon, 14)}
                className="rounded-md border border-[#7c3aed]/30 bg-[#7c3aed]/10 px-1.5 py-0.5 text-[10.5px] text-[#5b21b6]"
                title={`${n.city ?? ""}${n.county ? " · " + n.county : ""}`}
              >
                {n.alias ? `${n.name.split(" - ")[0]} (${n.alias})` : n.name}
              </button>
            ))}
          </div>
        ) : null}

        {searchHits.length ? (
          <div className="mb-2 flex flex-wrap gap-1">
            {searchHits.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => select(s, true)}
                className="rounded-md border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-[10.5px] text-accent"
              >
                {s.name} · {shortCounty(s.county ?? "")}
              </button>
            ))}
          </div>
        ) : null}

        <div className="max-h-[420px] overflow-auto rounded-lg border border-line [scrollbar-gutter:stable]">
          <table className="w-full min-w-[720px] border-collapse text-[11px]">
            <thead className="sticky top-0 z-1 bg-surface-2 text-muted">
              <tr>
                <th className="px-2 py-1.5 text-right font-medium">نام</th>
                <th className="px-1 py-1.5 text-right font-medium">نوع</th>
                <th className="px-1 py-1.5 text-right font-medium">شهرستان</th>
                <th className="px-1 py-1.5 text-right font-medium">بخش / دهستان</th>
                <th className="px-1 py-1.5 text-left font-medium">فاصله</th>
                <th className="px-1 py-1.5 text-left font-medium" title="جمعیت سکونتگاه، با سال و منبع در tooltip">
                  جمعیت
                </th>
                <th className="px-1 py-1.5 text-left font-medium" title="منبع شمارش: فید سازمان، یا نقشه‌شده/دست‌افزوده">
                  داروخانه
                </th>
                <th className="px-1 py-1.5 text-left font-medium">نفر/داروخانه</th>
                <th
                  className="px-1 py-1.5 text-left font-medium"
                  title="کمبود = جمعیت ÷ هدف − داروخانهٔ شمارش‌شده؛ عدد مثبت یعنی به‌اندازهٔ این تعداد داروخانه کم دارد"
                >
                  کمبود داروخانه
                </th>
              </tr>
            </thead>
            <tbody>
              {candidates.slice(0, 400).map((s) => {
                const gap = (s.pop ?? 0) / targetPerPharm - s.ph;
                return (
                  <tr
                    key={s.id}
                    onClick={() => select(s, false)}
                    className={`cursor-pointer border-t border-line/70 hover:bg-brand-soft/40 ${
                      s.id === selected ? "bg-brand-soft/60" : ""
                    }`}
                  >
                    <td className="px-2 py-1 font-medium text-ink">{s.name}</td>
                    <td className="px-1 py-1 text-muted">{KIND_FA[s.kind]}</td>
                    <td className="px-1 py-1 text-muted">{shortCounty(s.county ?? "—")}</td>
                    <td className="px-1 py-1 text-muted">
                      {[s.bakhsh, strip(s.dehestan ?? "", "دهستان ")]
                        .filter(Boolean)
                        .join(" / ") || "—"}
                    </td>
                    <td className="tnum px-1 py-1 text-left">{num(s.dist, 1)}</td>
                    <td
                      className="tnum px-1 py-1 text-left"
                      title={
                        s.pop == null
                          ? "جمعیت نامعلوم"
                          : `${s.popSource ?? "نامعلوم"}${s.popYear ? ` · ${s.popYear}` : ""}`
                      }
                    >
                      {group(s.pop)}
                      {s.popYear ? (
                        <span className="mr-1 text-[9px] text-faint">{s.popYear}</span>
                      ) : null}
                    </td>
                    <td className="tnum px-1 py-1 text-left">
                      {group(s.ph)}
                      {/* which source won the max(): the reader must be able to tell */}
                      <span
                        className={`mr-1 rounded px-1 text-[8.5px] ${
                          s.inFda
                            ? "bg-brand-soft text-brand-ink"
                            : s.mapped > 0
                              ? "bg-warn-soft text-warn"
                              : "bg-surface-2 text-faint"
                        }`}
                        title={
                          s.inFda
                            ? "شمارش از فید سازمان غذا و دارو"
                            : s.mapped > 0
                              ? "در فید سازمان نیست؛ شمارش از نقاط نقشه‌شده و دست‌افزوده"
                              : "هیچ داروخانه‌ای ثبت نشده"
                        }
                      >
                        {s.inFda ? "فید" : s.mapped > 0 ? "نقشه" : "—"}
                      </span>
                    </td>
                    <td className="tnum px-1 py-1 text-left">
                      {s.ph ? group(Math.round((s.pop ?? 0) / s.ph)) : "—"}
                    </td>
                    <td
                      className={`tnum px-1 py-1 text-left font-medium ${
                        gap > 0 ? "text-warn" : "text-muted"
                      }`}
                    >
                      {signed(gap)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[10px] leading-4 text-faint">
          شکاف = جمعیت ÷ هدف ({group(targetPerPharm)}) منهای داروخانهٔ ثبت‌شده؛ عدد مثبت
          یعنی کمبود. «۰ داروخانه» یعنی در فید سازمان ثبت نشده — نه اینکه قطعاً
          داروخانه ندارد. {group(candidates.length)} مورد در شعاع، {group(Math.min(400, candidates.length))} ردیف
          نمایش داده شده است.
        </p>
      </div>

      {/* -------------------------------------------------------- coverage -- */}
      <div className="min-w-0 rounded-2xl border border-line bg-surface p-3 lg:col-span-2">
        <div className="grid gap-2 text-[11px] leading-5 text-muted sm:grid-cols-2 lg:grid-cols-3">
          <p>
            <b className="text-ink">پوشش مکانی:</b> {group(data.meta.nPlotted)} سکونتگاه از{" "}
            {group(data.meta.nSettlement)} سکونتگاه لایهٔ تقسیمات کشوری مختصات دارند؛{" "}
            {group(data.meta.nMissingCoord)} روستا بدون مختصات است و روی نقشه نمی‌آید
            (به‌جای حدس زدن موقعیت، کنار گذاشته شده). جمعیت سکونتگاه‌های نقشه‌دار:{" "}
            {group(data.totals.population)}.
          </p>
          <p>
            <b className="text-ink">فاصله:</b> گراف همسایگی سکونتگاه‌ها ({group(data.meta.kNeighbors)}{" "}
            همسایهٔ نزدیک + هر نقطه درون {group(data.meta.connectKm)} کیلومتر) از{" "}
            {data.meta.referenceName} پیموده شده است. {group(data.meta.nRoadSample)} نقطه فاصلهٔ
            واقعی جاده‌ای دارد؛ نسبت میانهٔ جاده/شبکه{" "}
            {num(data.meta.roadCalibration ?? 1, 2)} است و برای بقیه اعمال می‌شود
            (برچسب «برآورد شبکه»).
          </p>
          <p>
            <b className="text-ink">تراکم:</b> سلول‌ها شبکهٔ {num(data.meta.gridStepKm, 1)} کیلومتری‌اند
            و فقط جایی ساخته می‌شوند که سکونتگاهی در {num(data.meta.maskKm, 1)} کیلومتری باشد؛
            در هر سلول جمعیت و داروخانهٔ درون {group(data.meta.windowKm)} کیلومتر جمع می‌شود.
            داروخانه‌ها از فید سازمان (جمع{" "}
            {group(data.totals.pharmacies)} در سکونتگاه‌های نقشه‌دار) و جمعیت از لایهٔ
            مرجع (ویکی‌داده/سرشماری) است.
          </p>
        </div>
        <p className="mt-2 text-[10px] text-faint">
          ساخته‌شده: {data.meta.builtAt.slice(0, 16).replace("T", " ")} ·{" "}
          {data.meta.stale
            ? "لایهٔ اداری جدیدتر از این نقشه است — etl/build_map_layer.py را دوباره اجرا کنید."
            : "هم‌زمان با آخرین بارگذاری لایهٔ اداری"}
        </p>
      </div>
    </div>
  );
}

function downloadCsv(rows: MapSettlement[], target: number) {
  const head = [
    "name",
    "kind",
    "county",
    "bakhsh",
    "dehestan",
    "population",
    "population_year",
    "population_source",
    "pharmacies",
    "pharmacies_real",
    "pharmacies_legal",
    "dist_km",
    "dist_source",
    "straight_km",
    "network_km",
    "road_km",
    "gap",
    "lat",
    "lon",
  ];
  const body = rows.map((s) =>
    [
      s.name,
      s.kind,
      s.county ?? "",
      s.bakhsh ?? "",
      s.dehestan ?? "",
      s.pop ?? "",
      s.popYear ?? "",
      s.popSource ?? "",
      s.ph,
      s.phReal,
      s.phLegal,
      s.dist.toFixed(1),
      s.distSource,
      s.straight.toFixed(1),
      s.net ?? "",
      s.road ?? "",
      ((s.pop ?? 0) / target - s.ph).toFixed(1),
      s.lat,
      s.lon,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(","),
  );
  const blob = new Blob(["\uFEFF" + [head.join(","), ...body].join("\n")], {
    type: "text/csv;charset=utf-8",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "khuzestan-pharmacy-candidates.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

