"use client";

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

const W = 660;
const H = 820;
const PAD = 14;
const MAX_ZOOM = 40;
const RING_EDGES = [25, 50, 75, 100, 150, 200, 300];

/* Marker sizes are radii in CSS px. They grow a little with zoom so a diamond is
   findable at 1x, then stop: at 8x a 14 px diamond covered the street detail and
   clusters of them merged into one blob. 9-10 px diameter is the size a map marker
   wants. */
const pharmRadiusPx = (k: number) => 2.4 + Math.min(1.4, Math.log2(Math.max(1, k)) * 0.5);
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
  pharm: { x: number; y: number }[];
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
    pharm: data.pharmacies.map((p) => {
      const [x, y] = proj(p.lat, p.lon);
      return { x, y };
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
  const [streetCity, setStreetCity] = useState<string | null>(null);
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

  /* Streets: one city at a time, whichever the view is centred on, fetched from
     2.5x. It used to start at 5x and draw at 4.5x, which left a band where the map
     showed density cells over imagery and no streets at all — the exact zoom a user
     reaches first when they zoom into a town. */
  useEffect(() => {
    if (!layers.streets || settled.k < 2.5) {
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
      const cx0 = -settled.tx / settled.k;
      const cy0 = -settled.ty / settled.k;
      const [vLat, vLon] = scene.inv(cx0 + W / 2 / settled.k, cy0 + H / 2 / settled.k);
      let best: (typeof idx)[number] | null = null;
      let bestD = Infinity;
      for (const c of idx) {
        const d = Math.hypot((c.lat - vLat) * 111, (c.lon - vLon) * 95);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (!best || bestD > best.r_km * 1.5) {
        /* Out of every city's disc: keep what is already drawn rather than blanking
           it, because those streets are still under the cursor and a flash of empty
           imagery reads as a bug. */
        return;
      }
      if (streetCache.current.has(best.slug)) {
        if (alive) {
          setStreetLines(streetCache.current.get(best.slug) ?? []);
          setStreetCity(best.city);
        }
        return;
      }
      const fc = await fetch(`/geo/streets_${best.slug}.json`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const feats = (fc?.features ?? [])
        .map((f: { properties?: { c?: string }; geometry?: { coordinates?: [number, number][] } }) => ({
          c: f.properties?.c ?? "residential",
          p: (f.geometry?.coordinates ?? []).map(([lon, lat]) => [lat, lon] as [number, number]),
        }))
        .filter((f: { p: [number, number][] }) => f.p.length >= 2);
      streetCache.current.set(best.slug, feats);
      if (alive) {
        setStreetLines(feats);
        setStreetCity(best.city);
      }
    })();
    return () => {
      alive = false;
    };
  }, [layers.streets, settled, scene]);

  /** Point chosen on empty ground: the "should I put a pharmacy here" probe. */
  const [probe, setProbe] = useState<{ lat: number; lon: number } | null>(null);
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

    let best = { s: -1, p: -1, m: -1 };
    let score = 2;

    for (let i = 0; i < scene.pts.length; i++) {
      const q = scene.pts[i];
      const d = Math.hypot(q.x - sx, q.y - sy) / tolS;
      if (d < 1 && d < score) {
        score = d;
        best = { s: i, p: -1, m: -1 };
      }
    }
    if (layers.osm) {
      for (let i = 0; i < scene.pharm.length; i++) {
        const q = scene.pharm[i];
        const d = (Math.hypot(q.x - sx, q.y - sy) / tolP) * 0.75;
        if (d < 1 && d < score) {
          score = d;
          best = { s: -1, p: i, m: -1 };
        }
      }
    }
    if (layers.med && view.k >= 1.6) {
      for (let i = 0; i < scene.med.length; i++) {
        const q = scene.med[i];
        const d = (Math.hypot(q.x - sx, q.y - sy) / tolM) * 0.75;
        if (d < 1 && d < score) {
          score = d;
          best = { s: -1, p: -1, m: i };
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
          return (
            <circle
              key={s.id}
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
    const px = pharmRadiusPx(view.k);
    const r = px / view.k;
    /* Greedy screen-space declutter: a marker is drawn only if no accepted marker
       is within one marker-width of it, otherwise it is folded into that marker's
       «+n». A lattice alone still let diagonal neighbours overlap. */
    const gapPx = px * 1.9;
    const gap = gapPx / view.k;
    const buckets = new Map<string, { x: number; y: number; n: number }>();
    const grid = new Map<string, { x: number; y: number; n: number }[]>();
    const gkey = (x: number, y: number) => `${Math.floor(x * view.k / gapPx)}:${Math.floor(y * view.k / gapPx)}`;
    for (const p of scene.pharm) {
      let host: { x: number; y: number; n: number } | null = null;
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
      const item = { x: p.x, y: p.y, n: 1 };
      buckets.set(`${gx}:${gy}:${p.x.toFixed(3)}`, item);
      const list = grid.get(gkey(p.x, p.y));
      if (list) list.push(item);
      else grid.set(gkey(p.x, p.y), [item]);
    }
    return (
      <g>
        {[...buckets.values()].map((b, i) => (
          <g key={i}>
            <path
              d={`M${b.x} ${b.y - r} L${b.x + r} ${b.y} L${b.x} ${b.y + r} L${b.x - r} ${b.y}Z`}
              fill={COLORS.pharmacy}
              fillOpacity={0.95}
              stroke="#ffffff"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
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
  }, [scene, layers.osm, view.k]);

  /* Demand side: clinics, doctors, dentists, hospitals, labs. Violet so it never
     reads as a pharmacy, and a plus sign for the ones that write prescriptions. */
  const medicalLayer = useMemo(() => {
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
  }, [data.medical, layers.med, scene.med, view.k]);

  /* Urban streets, projected once and grouped by class. Only the city the view
     is centred on is loaded, and only above ~5x. */
  const streetLayer = useMemo(() => {
    if (!layers.streets || !streetLines.length || view.k < 3.2) return null;
    const byClass = new Map<string, string[]>();
    for (const seg of streetLines) {
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
            stroke="#ffffff"
            strokeOpacity={0.9}
            strokeWidth={((width[cls] ?? 0.8) + 1.6) / view.k}
            strokeLinecap="round"
          />
        ))}
        {paths.map(([cls, ds]) => (
          <path
            key={cls}
            d={ds.join(" ")}
            fill="none"
            stroke="#8a9bad"
            strokeOpacity={0.95}
            strokeWidth={(width[cls] ?? 0.8) / view.k}
            strokeLinecap="round"
          />
        ))}
      </g>
    );
  }, [layers.streets, streetLines, scene, view.k]);

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
    const x0 = -settled.tx / settled.k;
    const y0 = -settled.ty / settled.k;
    const w = W / settled.k;
    const h = H / settled.k;
    const [latTop, lonLeft] = scene.inv(x0, y0);
    const [latBot, lonRight] = scene.inv(x0 + w, y0 + h);
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
  }, [settled, scene, settlements, mode, targetPerPharm, supply, popCells, popProvince]);

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
    const [latN, lonW] = scene.inv(-view.tx / k, -view.ty / k);
    const [latS, lonE] = scene.inv((W - view.tx) / k, (H - view.ty) / k);
    const lonSpan = Math.max(1e-6, Math.abs(lonE - lonW));
    /* Pick the zoom whose native resolution matches the screen, not "a few tiles
       across": one level short upsampled the image ~4x and the city read as flat
       desert. 256 px of tile per 360/2^z degrees, so z = log2(pxPerDeg*360/256). */
    const pxPerDeg = (svgRef.current?.clientWidth || W) / lonSpan;
    const z = Math.max(7, Math.min(17, Math.round(Math.log2((pxPerDeg * 360) / 256))));
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
    for (let ty = ty0; ty <= ty1 && out.length < 64; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = tx0; tx <= tx1 && out.length < 64; tx++) {
        const wrap = ((tx % n) + n) % n;
        const [ax, ay] = scene.proj(latOf(ty), lonOf(tx));
        const [bx, by] = scene.proj(latOf(ty + 1), lonOf(tx + 1));
        out.push({
          key: `${z}/${ty}/${wrap}`,
          href: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${wrap}`,
          x: ax,
          y: ay,
          w: bx - ax,
          h: by - ay,
        });
      }
    }
    return { z, tiles: out };
  }, [layers.sat, view.k, view.tx, view.ty, scene]);

  /* Roads: culled to the viewport and to the class the zoom level needs, then
     concatenated into two paths — 8k <path> nodes would choke the renderer. */
  const roadLayer = useMemo(() => {
    if (!roads || view.k < 1.25) return null;
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
        style={isFull ? undefined : { maxWidth: "min(100%, 920px, max(700px, calc((100vh - 140px) * 0.9)))" }}
        className={`mx-auto w-full min-w-0 bg-surface p-2.5 sm:p-3 ${
          isFull
            ? "flex h-screen w-screen max-w-none flex-col rounded-none border-0"
            : "rounded-2xl border border-line shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.12)]"
        }`}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-ink">
              نقشهٔ سکونتگاه‌ها و تراکم داروخانه
            </span>
            <span className="whitespace-nowrap rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-muted">
              {group(settlements.length)} نقطه · {group(scene.cells.length)} سلول مسکونی
            </span>
          </div>
          <div className="flex w-full flex-wrap items-center gap-1.5">
            {/* one segmented control instead of two loose mode buttons */}
            <div className="flex overflow-hidden rounded-lg border border-line-strong">
              {(
                [
                  ["dens", "تراکم داروخانه"],
                  ["ratio", "نفر به ازای داروخانه"],
                  ["gap", "شکاف ظرفیت"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
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
                  {label}
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
              title="روی هر نقطه از نقشه کلیک کنید تا جمعیت و داروخانه‌های اطراف آن سنجیده شود"
            >
              {probeMode ? "روی نقشه کلیک کنید…" : "تحلیل یک نقطه"}
            </button>
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
              title={isFull ? "خروج از تمام‌صفحه (Esc)" : "نمایش تمام‌صفحهٔ نقشه"}
              className="rounded-lg border border-line-strong bg-surface px-2.5 py-1 text-[11px] text-muted transition hover:border-brand hover:text-brand-ink"
            >
              {isFull ? "⤡ خروج" : "⤢ تمام‌صفحه"}
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
              const hit = hitTest(e.clientX, e.clientY);
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
                    />
                  ))}
                </g>
              ) : null}
              {layers.admin ? adminLayer : null}
              <g data-layer="roads">{roadLayer}</g>
              {layers.density && view.k < 1.2 ? cellLayer : null}
              {layers.density && fineCells ? (
                <g data-layer="density" shapeRendering="crispEdges" clipPath="url(#provClip)" opacity={0.92}>
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
                            (layers.sat ? 0.8 : 1)
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
              <g data-layer="settlements">{dotLayer}</g>
              <g data-layer="medical">{medicalLayer}</g>
              <g data-layer="pharmacy">{pharmacyLayer}</g>

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
        <PlacePanel
          key={`${selPharm ?? "x"}-${selMed ?? "x"}`}
          pharm={selPharm !== null ? data.pharmacies[selPharm] : null}
          medical={selMed !== null ? data.medical[selMed] : null}
          pharmacies={data.pharmacies}
          medicals={data.medical}
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
          <div className="rounded-2xl border border-brand/25 bg-surface p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.12)]">
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
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-ink">
              گزینه‌های تأسیس درون شعاع {group(radius)} کیلومتری
            </span>
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-muted">
              {group(candidates.length)} مورد
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="جستجوی نام، شهرستان، بخش یا دهستان…"
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
                <th className="px-1 py-1.5 text-left font-medium">جمعیت</th>
                <th className="px-1 py-1.5 text-left font-medium">داروخانه</th>
                <th className="px-1 py-1.5 text-left font-medium">نفر/داروخانه</th>
                <th className="px-1 py-1.5 text-left font-medium">شکاف</th>
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
                    <td className="tnum px-1 py-1 text-left">{group(s.pop)}</td>
                    <td className="tnum px-1 py-1 text-left">{group(s.ph)}</td>
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

