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
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { MapCell, MapData, MapSettlement, MapShape } from "@/lib/map";
import { group, num, shortCounty, toPersianDigits } from "@/lib/format";

const W = 660;
const H = 820;
const PAD = 14;
const RING_EDGES = [25, 50, 75, 100, 150, 200, 300];

const COLORS = {
  city: "#4338ca",
  village: "#475569",
  pharmacy: "#d97706",
  tree: "#94a3b8",
  reference: "#0f766e",
};

/* density ramps: low → high. The first stop is nearly transparent so an empty
   area stays "no data" instead of "healthy". */
const DENS_RAMP = ["#f0fdfa", "#99f6e4", "#2dd4bf", "#0d9488", "#115e59"];
const GAP_RAMP = ["#fef3c7", "#fcd34d", "#fb923c", "#f43f5e", "#9f1239"];

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

type Scene = {
  proj: Proj;
  scale: number;
  cellW: number;
  cellH: number;
  pts: { x: number; y: number; r: number }[];
  edges: [number, number, number, number][];
  cells: (MapCell & { x: number; y: number })[];
  bakhsh: { d: string; name: string; county: string | null; lx: number; ly: number }[];
  outline: string;
  dehestan: { d: string; name: string; county: string | null; lx: number; ly: number }[];
  counties: { name: string; x: number; y: number }[];
  dehestans: { name: string; x: number; y: number }[];
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

  const shapesOf = (list: MapShape[], kind: "bakhsh" | "dehestan") =>
    list.map((s) => {
      const [lx, ly] = proj(s.label[0], s.label[1]);
      return { d: path(s), name: s.name, county: s.county, lx, ly, kind };
    });

  const bakhsh = shapesOf(data.bakhsh, "bakhsh");
  const dehestan = shapesOf(data.dehestan, "dehestan");

  const pts = data.settlements.map((p) => {
    const [x, y] = proj(p.lat, p.lon);
    const pop = p.pop ?? 0;
    return { x, y, r: 1.7 + Math.min(7.5, Math.sqrt(pop) / 46) };
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
  // mean something — a one-village دهستان label is noise)
  const dehAcc = new Map<string, { x: number; y: number; n: number }>();
  for (let i = 0; i < data.settlements.length; i++) {
    const s = data.settlements[i];
    if (!s.dehestan) continue;
    const acc = dehAcc.get(s.dehestan) ?? { x: 0, y: 0, n: 0 };
    acc.x += pts[i].x;
    acc.y += pts[i].y;
    acc.n += 1;
    dehAcc.set(s.dehestan, acc);
  }
  const dehestans = [...dehAcc.entries()]
    .filter(([, a]) => a.n >= 4)
    .map(([name, a]) => ({ name, x: a.x / a.n, y: a.y / a.n }));

  const ringPath = (poly: number[][]) =>
    poly
      .map(([lo, la], i) => {
        const [x, y] = proj(la, lo);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(" ") + "Z";

  return {
    proj,
    scale,
    cellW: 0.033 * kx * scale,
    cellH: 0.03 * scale,
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
  const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
  /** Authoritative view for gestures: wheel events fire faster than React can
      re-render, and a stale `view` here would drop every second notch. */
  const viewRef = useRef(view);
  const [mode, setMode] = useState<"dens" | "gap">("dens");
  const [layers, setLayers] = useState({
    density: true,
    network: false,
    admin: true,
    labels: true,
    pharm: true,
  });
  const [targetPerPharm, setTargetPerPharm] = useState(
    Math.round((data.meta.residentsPerPharmacy || 5400) / 100) * 100,
  );

  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const indexOf = useMemo(() => {
    const m = new Map<number, number>();
    settlements.forEach((s, i) => m.set(s.id, i));
    return m;
  }, [settlements]);

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

  const candidates = useMemo(() => {
    const q = query.trim();
    const out: MapSettlement[] = [];
    for (const s of settlements) {
      if (s.dist > radius) continue;
      if ((s.pop ?? 0) < minPop) continue;
      const gap = (s.pop ?? 0) / targetPerPharm - s.ph;
      if (onlyGap && gap < 1) continue;
      if (q) {
        const hit =
          s.name.includes(q) ||
          (s.county ?? "").includes(q) ||
          (s.bakhsh ?? "").includes(q) ||
          (s.dehestan ?? "").includes(q);
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
  }, [settlements, radius, minPop, onlyGap, query, sortBy, targetPerPharm]);

  const searchHits = useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return [];
    return settlements
      .filter(
        (s) =>
          s.name.includes(q) ||
          (s.county ?? "").includes(q) ||
          (s.bakhsh ?? "").includes(q) ||
          (s.dehestan ?? "").includes(q),
      )
      .slice(0, 8);
  }, [settlements, query]);

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

  const clampView = useCallback((k: number, tx: number, ty: number) => {
    const kk = Math.max(1, Math.min(14, k));
    const minX = W - W * kk;
    const minY = H - H * kk;
    return {
      k: kk,
      tx: Math.max(minX, Math.min(0, tx)),
      ty: Math.max(minY, Math.min(0, ty)),
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

  const onWheel = (e: ReactWheelEvent<SVGSVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const my = ((e.clientY - rect.top) / rect.height) * H;
    const k = Math.max(1, Math.min(14, v.k * Math.exp(-e.deltaY * 0.0016)));
    commit(k, mx - (mx - v.tx) * (k / v.k), my - (my - v.ty) * (k / v.k));
  };

  const toScene = (clientX: number, clientY: number): [number, number, number] => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;
    const v = viewRef.current;
    return [(px * W - v.tx) / v.k, (py * H - v.ty) / v.k, rect.width / W];
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (drag.current) {
      const dx = ((e.clientX - drag.current.x) / (svgRef.current!.clientWidth || 1)) * W;
      const dy = ((e.clientY - drag.current.y) / (svgRef.current!.clientHeight || 1)) * H;
      commit(viewRef.current.k, drag.current.tx + dx, drag.current.ty + dy);
      return;
    }
    const [sx, sy, ratio] = toScene(e.clientX, e.clientY);
    const tol = 9 / ratio; // 9 css px
    let best = -1;
    let bestD = tol * tol;
    for (let i = 0; i < scene.pts.length; i++) {
      const p = scene.pts[i];
      const dx = p.x - sx;
      const dy = p.y - sy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) {
      if (hover) setHover(null);
      return;
    }
    const r = svgRef.current!.getBoundingClientRect();
    setHover({
      i: best,
      x: e.clientX - r.left,
      y: e.clientY - r.top,
    });
  };

  /* ----------------------------------------------------------- zoom helpers */
  const zoomBy = (f: number) => {
    const v = viewRef.current;
    const k = Math.max(1, Math.min(14, v.k * f));
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
          return (
            <circle
              key={s.id}
              cx={p.x}
              cy={p.y}
              r={p.r + (isSel ? 2 : 0)}
              fill={city ? COLORS.city : COLORS.village}
              fillOpacity={on ? (city ? 0.9 : 0.72) : 0.12}
              stroke={isSel ? "#0f172a" : s.ph > 0 && layers.pharm ? COLORS.pharmacy : "none"}
              strokeWidth={isSel ? 1.6 : 0.9}
              strokeOpacity={isSel ? 1 : 0.95}
            />
          );
        })}
      </g>
    ),
    [scene, settlements, inside, selected, layers.pharm],
  );

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
      <g opacity={0.85} shapeRendering="crispEdges" clipPath="url(#provClip)">
        {scene.cells.map((c, i) => (
          <rect
            key={i}
            x={c.x - scene.cellW / 2}
            y={c.y - scene.cellH / 2}
            width={scene.cellW + 0.4}
            height={scene.cellH + 0.4}
            fill={ramp(mode === "dens" ? DENS_RAMP : GAP_RAMP, vals[i] / hi)}
            fillOpacity={mode === "gap" && vals[i] <= 0 ? 0.15 : 0.9}
          />
        ))}
      </g>
    );
  }, [scene, mode]);

  const adminLayer = useMemo(
    () => (
      <g filter="url(#provShadow)">
        {scene.bakhsh.map((b, i) => (
          <path
            key={`b${i}`}
            d={b.d}
            fill="#dfe8f3"
            fillOpacity={0.96}
            stroke="#8b9bb2"
            strokeWidth={0.7}
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
    [scene],
  );

  const labelLayer = useMemo(() => {
    if (!layers.labels) return null;
    const k = view.k;
    const out: ReactNode[] = [];
    /* Greedy declutter. Labels live in scene units and are counter-scaled by
       1/k, so their on-screen size stays constant — which means the collision
       boxes only fit more labels as you zoom in, never fewer. */
    const boxes: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const place = (x: number, y: number, text: string, size: number): boolean => {
      const w = text.length * size * 0.64 + 4 / k;
      const h = size * 1.2 + 3 / k;
      const b = { x1: x - w / 2, y1: y - h / 2, x2: x + w / 2, y2: y + h / 2 };
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

    for (const c of scene.counties) {
      labels.push({
        key: `c${c.name}`,
        x: c.x,
        y: c.y,
        text: shortCounty(c.name),
        size: 12,
        weight: 700,
        fill: "#1e293b",
        opacity: 0.82,
        halo: 2.2,
      });
    }
    if (k >= 2.1) {
      for (const b of scene.bakhsh) {
        labels.push({
          key: `b${b.name}`,
          x: b.lx,
          y: b.ly,
          text: strip(b.name, "بخش "),
          size: 8,
          weight: 500,
          fill: "#475569",
          opacity: 0.7,
          halo: 1.6,
        });
      }
    }
    if (k >= 3.4) {
      for (const d of scene.dehestans) {
        labels.push({
          key: `d${d.name}`,
          x: d.x,
          y: d.y,
          text: strip(d.name, "دهستان "),
          size: 7,
          weight: 400,
          fill: "#64748b",
          opacity: 0.68,
          halo: 1.4,
        });
      }
    }
    if (k >= 4.6) {
      const vis = settlements.filter(
        (s) => inside[indexOf.get(s.id) ?? 0] === 1 && (s.pop ?? 0) >= 120,
      );
      for (const s of vis.slice(0, 160)) {
        const i = indexOf.get(s.id)!;
        const p = scene.pts[i];
        labels.push({
          key: `v${s.id}`,
          x: p.x,
          y: p.y - (p.r + 1.8) / k,
          text: `${s.name} ${group(s.pop)}`,
          size: 6.4,
          weight: 500,
          fill: "#0f172a",
          opacity: 0.9,
          halo: 1.4,
        });
      }
    }

    for (const l of labels) {
      if (!place(l.x, l.y, l.text, l.size)) continue;
      out.push(
        <text
          key={l.key}
          x={l.x}
          y={l.y}
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
  }, [scene, settlements, layers.labels, view.k, inside, indexOf]);

  const hoverS = hover ? settlements[hover.i] : null;

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start">
      {/* ------------------------------------------------------------ map -- */}
      <div className="mx-auto w-full max-w-[900px] rounded-2xl border border-line bg-surface p-3 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.12)] lg:sticky lg:top-3 lg:self-start">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-semibold text-ink">
              نقشهٔ سکونتگاه‌ها و تراکم داروخانه
            </span>
            <span className="rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-muted">
              {group(settlements.length)} نقطه · {group(scene.cells.length)} سلول مسکونی
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                ["dens", "تراکم داروخانه"],
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
                className={`rounded-lg border px-2 py-1 text-[11px] font-medium transition ${
                  mode === id && layers.density
                    ? "border-brand/40 bg-brand-soft text-brand-ink"
                    : "border-line bg-surface text-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
            {(
              [
                ["density", "سلول تراکم"],
                ["network", "شبکهٔ فاصله"],
                ["admin", "مرزها"],
                ["labels", "برچسب‌ها"],
                ["pharm", "داروخانه‌دار"],
              ] as const
            ).map(([id, label]) => (
              <label
                key={id}
                className="flex cursor-pointer items-center gap-1 rounded-lg border border-line bg-surface px-2 py-1 text-[11px] text-muted"
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
        </div>

        <div className="relative mx-auto w-fit max-w-full">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            style={{ height: "clamp(440px, 72vh, 880px)", width: "auto", maxWidth: "100%" }}
            className="block cursor-crosshair rounded-xl border border-line bg-[#f8fafc]"
            onWheel={onWheel}
            onPointerMove={onPointerMove}
            onPointerLeave={() => {
              drag.current = null;
              setHover(null);
            }}
            onPointerDown={(e) => {
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
              if (!moved && hover) {
                select(settlements[hover.i], false);
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
              {layers.admin ? adminLayer : null}
              {layers.density ? cellLayer : null}

              {/* distance rings around the reference city */}
              {RING_EDGES.map((km) => {
                const r = (km / 111.32) * scene.scale;
                const [cx, cy] = scene.proj(
                  data.meta.referenceLat,
                  data.meta.referenceLon,
                );
                return (
                  <circle
                    key={km}
                    cx={cx}
                    cy={cy}
                    r={r}
                    fill="none"
                    stroke="#0d9488"
                    strokeOpacity={0.22}
                    strokeWidth={0.8}
                    strokeDasharray="4 5"
                  />
                );
              })}

              {layers.network ? edgeLayer : null}
              {dotLayer}

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

              <circle
                cx={scene.proj(data.meta.referenceLat, data.meta.referenceLon)[0]}
                cy={scene.proj(data.meta.referenceLat, data.meta.referenceLon)[1]}
                r={5}
                fill={COLORS.reference}
                stroke="#fff"
                strokeWidth={1.6}
              />

              {labelLayer}
            </g>
            <text
              x={W - 12}
              y={20}
              textAnchor="end"
              fontSize={13}
              fontWeight={700}
              fill="#334155"
              opacity={0.8}
            >
              استان خوزستان
            </text>

          </svg>

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

          <div className="absolute bottom-2 right-2 rounded-lg border border-line bg-surface/95 px-2 py-1.5 shadow-sm">
            <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-muted">
              <span>{mode === "dens" ? "کمتر" : "بدون شکاف"}</span>
              <span>{mode === "dens" ? "بیشتر" : "شکاف بیشتر"}</span>
            </div>
            <div className="flex h-2 w-32 overflow-hidden rounded-full">
              {(mode === "dens" ? DENS_RAMP : GAP_RAMP).map((c) => (
                <span key={c} className="flex-1" style={{ background: c }} />
              ))}
            </div>
            <div className="mt-1 text-[10px] leading-4 text-faint">
              فقط داخل محدودهٔ مسکونی (≤{num(data.meta.maskKm, 1)} کم از یک آبادی)
            </div>
          </div>

          {hoverS ? (
            <div
              className="pointer-events-none absolute z-10 w-56 rounded-lg border border-line bg-surface/98 p-2 text-[11px] shadow-lg"
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
                <span className="text-faint">داروخانه</span>
                <span className="tnum text-left font-medium">{group(hoverS.ph)}</span>
                <span className="text-faint">از اهواز</span>
                <span className="tnum text-left font-medium">{fmtKm(hoverS.dist)}</span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] text-muted">
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
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: COLORS.reference }} />
            {data.meta.referenceName} (مبدأ فاصله)
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
      <div className="flex flex-col gap-3">
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

          <div className="mt-3 max-h-56 overflow-auto rounded-lg border border-line">
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
      <div className="rounded-2xl border border-line bg-surface p-3 lg:col-span-2">
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

        <div className="max-h-[420px] overflow-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-[11px]">
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
      <div className="rounded-2xl border border-line bg-surface p-3 lg:col-span-2">
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

