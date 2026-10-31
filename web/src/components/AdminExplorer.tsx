"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { group, toPersianDigits } from "@/lib/format";
import type { AdminData, AdminKind, AdminNode } from "@/lib/admin";

/* Kept here (not imported from lib/admin) because that module opens SQLite — a
   value import would drag `node:sqlite` into the client bundle. */
const SOURCE_LABEL: Record<string, string> = {
  "fa.wikipedia-county-table": "ویکی‌پدیا › جدول شهرستان",
  "fa.wikipedia-census-sentence": "ویکی‌پدیا › متن سرشماری",
  "fa.wikipedia-infobox": "ویکی‌پدیا › جعبه اطلاعات",
  wikidata: "ویکی‌داده (P1082)",
  "fda-feed": "فید سازمان غذا و دارو",
  "osm-tag": "OpenStreetMap",
};
import { Badge, Button, Card, Empty } from "./ui";

const KIND_LABEL: Record<AdminKind, string> = {
  county: "شهرستان",
  bakhsh: "بخش",
  dehestan: "دهستان",
  city: "شهر",
  village: "روستا",
};

const KIND_TONE: Record<AdminKind, "brand" | "accent" | "muted" | "good" | "warn"> = {
  county: "brand",
  bakhsh: "accent",
  dehestan: "muted",
  city: "good",
  village: "warn",
};

/** Fold the spellings that split a name in two: ZWNJ, Arabic yeh/kaf, spacing. */
function fold(s: string): string {
  return s
    .replace(/[\u200c\u200d\u200e\u200f]/g, " ")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ًٌٍَُِّْ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function faYear(y: number | null): string {
  return y ? toPersianDigits(y) : "—";
}

export function AdminExplorer({ data }: { data: AdminData }) {
  const [query, setQuery] = useState("");
  const [county, setCounty] = useState<string>("__all__");
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [selected, setSelected] = useState<number | null>(null);

  const { byId, children, roots, counties } = useMemo(() => {
    const byId = new Map<number, AdminNode>();
    for (const n of data.nodes) byId.set(n.id, n);
    const children = new Map<number | null, AdminNode[]>();
    for (const n of data.nodes) {
      const parent = n.parent !== null && byId.has(n.parent) ? n.parent : null;
      const list = children.get(parent);
      if (list) list.push(n);
      else children.set(parent, [n]);
    }
    const name = (n: AdminNode) => fold(n.name);
    for (const list of children.values()) {
      list.sort((a, b) => {
        const rank = (k: AdminKind) =>
          k === "bakhsh" ? 0 : k === "dehestan" ? 1 : k === "city" ? 2 : 3;
        if (a.kind !== b.kind) return rank(a.kind) - rank(b.kind);
        return name(a).localeCompare(name(b), "fa");
      });
    }
    const counties = (children.get(null) ?? [])
      .filter((n) => n.kind === "county")
      .map((n) => ({ id: n.id, name: n.name }));
    return { byId, children, roots: children.get(null) ?? [], counties };
  }, [data.nodes]);

  /* Pharmacies under every administrative node, so a بخش/دهستان answers
     «چند داروخانه در مجموع?» without expanding it first. */
  const rollup = useMemo(() => {
    const sum = new Map<number, number>();
    const walk = (n: AdminNode): number => {
      let total = n.pharmacyReal + n.pharmacyLegal;
      for (const kid of children.get(n.id) ?? []) total += walk(kid);
      sum.set(n.id, total);
      return total;
    };
    for (const root of roots) walk(root);
    return sum;
  }, [roots, children]);

  const q = fold(query);
  /* «ام الطمیر» and «امالطمیر» must both find the same place: compare the
     space-stripped form as well as the literal one. */
  const qCompact = q.replace(/\s+/g, "");

  /** Ids that survive the search, plus every ancestor (so matches keep context). */
  const visible = useMemo(() => {
    if (!q && county === "__all__") return null;
    const hit = new Set<number>();
    for (const n of data.nodes) {
      if (county !== "__all__" && n.county !== county) continue;
      if (q) {
        const hay = `${fold(n.name)} ${fold(n.bakhsh ?? "")} ${fold(n.dehestan ?? "")}`;
        if (!hay.includes(q) && !hay.replace(/\s+/g, "").includes(qCompact)) continue;
      }
      hit.add(n.id);
    }
    const withAncestors = new Set(hit);
    for (const id of hit) {
      let cur = byId.get(id)?.parent ?? null;
      while (cur !== null && !withAncestors.has(cur)) {
        withAncestors.add(cur);
        cur = byId.get(cur)?.parent ?? null;
      }
    }
    return withAncestors;
  }, [q, county, data.nodes, byId]);

  const matches = useMemo(() => {
    if (!q) return [];
    return data.nodes
      .filter(
        (n) =>
          (n.kind === "city" || n.kind === "village") &&
          (fold(n.name).includes(q) ||
            fold(n.name).replace(/\s+/g, "").includes(qCompact)) &&
          (county === "__all__" || n.county === county),
      )
      .slice(0, 12);
  }, [q, qCompact, county, data.nodes]);

  const isOpen = (id: number) => (visible ? visible.has(id) : open.has(id));

  const toggle = (id: number) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const select = (id: number) => {
    setSelected(id);
    // opening the ancestors of the chosen node keeps it in view
    setOpen((prev) => {
      const next = new Set(prev);
      let cur = byId.get(id)?.parent ?? null;
      while (cur !== null) {
        next.add(cur);
        cur = byId.get(cur)?.parent ?? null;
      }
      return next;
    });
  };

  const expandAll = () => {
    const all = new Set<number>();
    for (const [id, list] of children) if (id !== null && list.length) all.add(id);
    setOpen(all);
  };
  const collapseAll = () => setOpen(new Set());

  const rows: React.ReactNode[] = [];
  const walk = (node: AdminNode, depth: number) => {
    if (visible && !visible.has(node.id)) return;
    const kids = children.get(node.id) ?? [];
    const expanded = kids.length > 0 && isOpen(node.id);
    const active = selected === node.id;
    const ph = node.pharmacyReal + node.pharmacyLegal;
    rows.push(
      <div
        key={node.id}
        role="treeitem"
        aria-expanded={kids.length ? expanded : undefined}
        onClick={() => select(node.id)}
        className={`flex cursor-pointer items-center gap-2 border-b border-line/70 py-1.5 pr-1 text-[12.5px] transition hover:bg-surface-2 ${
          active ? "bg-brand-soft/60" : ""
        }`}
        style={{ paddingInlineStart: depth * 16 }}
      >
        {kids.length ? (
          <button
            type="button"
            aria-label={expanded ? "بستن" : "باز کردن"}
            onClick={(e) => {
              e.stopPropagation();
              toggle(node.id);
            }}
            className="grid h-4 w-4 shrink-0 place-items-center rounded text-[10px] text-muted hover:bg-line"
          >
            {expanded ? "▾" : "◂"}
          </button>
        ) : (
          <span className="h-4 w-4 shrink-0" />
        )}
        <Badge tone={KIND_TONE[node.kind]} className="shrink-0">
          {KIND_LABEL[node.kind]}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-medium text-ink">
          {node.name}
        </span>
        {kids.length ? (
          <span className="tnum shrink-0 text-[10.5px] text-faint">
            {group(kids.length)} زیرشاخه
          </span>
        ) : null}
        {node.kind === "city" || node.kind === "village" ? (
          ph > 0 ? (
            <Badge tone="good" className="shrink-0" title="داروخانهٔ فعال در فید FDA">
              {group(ph)} داروخانه
            </Badge>
          ) : node.inFda ? (
            <Badge tone="muted" className="shrink-0" title="در فید FDA هست، بدون داروخانه">
              بدون داروخانه
            </Badge>
          ) : (
            <Badge tone="muted" className="shrink-0" title="در فید FDA نیست">
              خارج از فید
            </Badge>
          )
        ) : (rollup.get(node.id) ?? 0) > 0 ? (
          <Badge
            tone="brand"
            className="shrink-0"
            title="جمع داروخانه در همهٔ زیرشاخه‌ها"
          >
            {group(rollup.get(node.id) ?? 0)} داروخانه
          </Badge>
        ) : null}
        <span
          className="tnum w-16 shrink-0 text-left text-[11.5px] text-ink-soft"
          title="جمعیت"
        >
          {node.population ? group(node.population) : "—"}
        </span>
      </div>,
    );
    if (expanded) for (const kid of kids) walk(kid, depth + 1);
  };
  for (const root of roots) walk(root, 0);

  const detail = selected !== null ? byId.get(selected) ?? null : null;
  const path = useMemo(() => {
    if (!detail) return [] as AdminNode[];
    const chain: AdminNode[] = [];
    let cur: number | null = detail.id;
    while (cur !== null) {
      const n = byId.get(cur);
      if (!n) break;
      chain.unshift(n);
      cur = n.parent;
    }
    return chain;
  }, [detail, byId]);

  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card padded={false} className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2/70 px-3 py-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="جست‌وجوی نام: روستا، دهستان، بخش، شهر…"
            className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] outline-none focus:border-brand"
          />
          <select
            value={county}
            onChange={(e) => setCounty(e.target.value)}
            className="max-w-[220px] rounded-lg border border-line bg-surface px-2 py-1.5 text-[12px] text-ink-soft"
          >
            <option value="__all__">همهٔ شهرستان‌ها</option>
            {counties.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name.replace(/^شهرستان\s+/, "")}
              </option>
            ))}
          </select>
          <Button variant="outline" onClick={expandAll}>
            باز کردن همه
          </Button>
          <Button onClick={collapseAll}>بستن همه</Button>
          <span className="tnum text-[11px] text-faint">
            {visible ? `${group(visible.size)} ردیف` : `${group(data.nodes.length)} واحد`}
          </span>
        </div>

        {matches.length > 0 ? (
          <div className="border-b border-line bg-brand-soft/30 px-3 py-2">
            <div className="mb-1 text-[11px] text-muted">نتیجهٔ جست‌وجو</div>
            <div className="flex flex-wrap gap-1">
              {matches.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => select(m.id)}
                  className="rounded-md border border-line bg-surface px-2 py-1 text-[11.5px] hover:border-brand hover:text-brand-ink"
                >
                  {m.name}
                  <span className="mr-1 text-faint">
                    ({KIND_LABEL[m.kind]} · {m.county?.replace(/^شهرستان\s+/, "")})
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="max-h-[calc(100vh-230px)] overflow-auto" role="tree">
          {rows.length ? rows : <Empty>موردی با این فیلتر پیدا نشد.</Empty>}
        </div>
      </Card>

      <div className="space-y-3">
        <Card>
          {detail ? (
            <div>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-[15px] font-bold text-ink">{detail.name}</h2>
                <Badge tone={KIND_TONE[detail.kind]}>{KIND_LABEL[detail.kind]}</Badge>
              </div>
              <p className="mt-1 text-[11.5px] leading-5 text-muted">
                {path
                  .slice(0, -1)
                  .map((p) => p.name.replace(/^شهرستان\s+/, ""))
                  .join(" › ") || "—"}
              </p>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-line bg-surface-2 px-2.5 py-2">
                  <div className="text-[10.5px] text-muted">جمعیت</div>
                  <div className="tnum text-base font-bold text-ink">
                    {detail.population ? group(detail.population) : "—"}
                  </div>
                  <div className="tnum text-[10px] text-faint">
                    سرشماری {faYear(detail.year)}
                  </div>
                </div>
                <div className="rounded-xl border border-line bg-surface-2 px-2.5 py-2">
                  <div className="text-[10.5px] text-muted">داروخانه</div>
                  <div className="tnum text-base font-bold text-ink">
                    {group(
                      detail.kind === "city" || detail.kind === "village"
                        ? detail.pharmacyReal + detail.pharmacyLegal
                        : rollup.get(detail.id) ?? 0,
                    )}
                  </div>
                  <div className="text-[10px] text-faint">
                    حقیقی {group(detail.pharmacyReal)} · حقوقی{" "}
                    {group(detail.pharmacyLegal)}
                  </div>
                </div>
              </div>

              <div className="mt-3">
                <div className="mb-1 text-[11px] font-semibold text-ink-soft">
                  همهٔ ارقام جمعیت
                </div>
                {detail.populations.length ? (
                  <ul className="space-y-1">
                    {detail.populations.map((p) => (
                      <li
                        key={`${p.source}-${p.year}-${p.population}`}
                        className="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-2 py-1 text-[11.5px]"
                      >
                        <span className="text-muted">
                          {SOURCE_LABEL[p.source] ?? p.source}
                        </span>
                        <span className="tnum font-semibold text-ink">
                          {group(p.population)}
                          <span className="mr-1 font-normal text-faint">
                            ({faYear(p.year)})
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[11.5px] text-faint">
                    هیچ منبعی جمعیت این مکان را ندارد؛ عددی ساخته نشده است.
                  </p>
                )}
              </div>

              <div className="mt-3 flex flex-wrap gap-1">
                <Badge tone={detail.inFda ? "good" : "muted"}>
                  {detail.inFda ? "در فید FDA" : "فقط در لایهٔ جغرافیایی"}
                </Badge>
                <Badge tone="muted">
                  {(children.get(detail.id) ?? []).length} زیرشاخه
                </Badge>
              </div>
            </div>
          ) : (
            <Empty>
              یک ردیف را انتخاب کنید تا همهٔ ارقام و منابعش را ببینید. برای دیدن
              همهٔ روستاها «باز کردن همه» را بزنید.
            </Empty>
          )}
        </Card>

        <Card>
          <div className="text-[11.5px] font-semibold text-ink-soft">
            پوشش این لایه
          </div>
          <ul className="mt-2 space-y-1 text-[11.5px] text-muted">
            <li className="flex justify-between">
              <span>شهرستان</span>
              <span className="tnum text-ink">{group(data.totals.county)}</span>
            </li>
            <li className="flex justify-between">
              <span>بخش</span>
              <span className="tnum text-ink">{group(data.totals.bakhsh)}</span>
            </li>
            <li className="flex justify-between">
              <span>دهستان</span>
              <span className="tnum text-ink">{group(data.totals.dehestan)}</span>
            </li>
            <li className="flex justify-between">
              <span>شهر</span>
              <span className="tnum text-ink">{group(data.totals.city)}</span>
            </li>
            <li className="flex justify-between">
              <span>روستا و آبادی</span>
              <span className="tnum text-ink">{group(data.totals.village)}</span>
            </li>
            <li className="flex justify-between border-t border-line pt-1">
              <span>با جمعیت</span>
              <span className="tnum text-ink">
                {group(data.totals.withPopulation)}
              </span>
            </li>
            <li className="flex justify-between">
              <span>دارای داروخانه</span>
              <span className="tnum text-ink">
                {group(data.totals.withPharmacy)}
              </span>
            </li>
          </ul>
          <Link
            href="/"
            className="mt-3 inline-block text-[11.5px] font-medium text-brand-ink hover:underline"
          >
            بازگشت به تحلیل موقعیت ←
          </Link>
          <Link
            href="/map"
            className="mr-3 mt-3 inline-block text-[11.5px] font-medium text-accent hover:underline"
          >
            نقشهٔ خوزستان و فاصله‌ها ←
          </Link>
        </Card>
      </div>
    </div>
  );
}
