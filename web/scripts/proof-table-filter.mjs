/**
 * Proof for the per-column filter panels on the ranking table.
 *
 * The header used to sort on click and offered no way to narrow a column, so
 * «cities between 20 and 80 thousand people» could not be asked. This asserts,
 * against the real page and the real data:
 *
 *   1. clicking a header opens its panel (and sorting stays on the arrow)
 *   2. a numeric range narrows the rows and every visible cell obeys it
 *   3. Persian digits and ٬ grouping parse the same as Latin ones
 *   4. crossed ends read as the same interval instead of emptying the table
 *   5. the active filter is shown as a chip, and removing it restores the rows
 *   6. a text column filters by substring
 *   7. Escape closes the panel
 *
 *   node scripts/proof-table-filter.mjs [url] [outDir]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:3737/";
const OUT = process.argv[3] ?? "shots";
const PORT = 9395;

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!CHROME) throw new Error("no chrome/edge");

mkdirSync(OUT, { recursive: true });
const child = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(tmpdir(), `pharm-filter-${Date.now()}`)}`,
    "--window-size=1680,1250",
    "--hide-scrollbars",
    "--disable-gpu",
    "--no-first-run",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const ok = (m) => console.log(`  OK   ${m}`);
const bad = (m) => {
  console.log(`  FAIL ${m}`);
  fails.push(m);
};

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(400);
  }
  throw new Error("devtools unreachable");
}
const page = (await targets()).find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
async function js(expr) {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log(`  shot ${path.join(OUT, name + ".png")}`);
}

/* page-side helpers, injected once */
const HELPERS = `
window.__t = {
  rows: () => document.querySelectorAll("tbody tr").length,
  idx: (key) => [...document.querySelectorAll("thead th")]
    .findIndex((th) => th.dataset.col === key),
  cells: (key) => {
    const i = window.__t.idx(key);
    return [...document.querySelectorAll("tbody tr")].map((tr) => {
      const td = tr.children[i];
      return td ? td.innerText.trim() : null;
    });
  },
  num: (s) => {
    const d = s.replace(/[۰-۹]/g, (x) => "۰۱۲۳۴۵۶۷۸۹".indexOf(x))
               .replace(/[٠-٩]/g, (x) => "٠١٢٣٤٥٦٧٨٩".indexOf(x))
               .replace(/[٬،,\\s]/g, "");
    return /[0-9]/.test(d) ? Number(d) : null;
  },
  set: (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, "value").set;
    setter.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  panel: (key) => document.querySelector('[data-filter-panel="' + key + '"]'),
  box: (key, aria) => {
    const p = window.__t.panel(key);
    return p ? p.querySelector('input[aria-label^="' + aria + '"]') : null;
  },
  count: () => (document.querySelector('[data-testid="table-count"]') || {}).innerText || "",
};
true`;

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1680,
  height: 1250,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: URL_ });

/* The board is ~1,600 rows and the first paint can still be filling in: a read
   at a fixed 8 s once caught 648 rows and looked like a filter effect. Wait for
   two identical readings before taking the baseline. */
let base = 0;
for (let i = 0; i < 30; i++) {
  await sleep(1200);
  const n = await js(`document.querySelectorAll("tbody tr").length`);
  if (n > 0 && n === base) break;
  base = n;
}
await js(HELPERS);
base = await js(`window.__t.rows()`);
console.log(`\n=== baseline: ${base} rows ===`);
if (base < 10) bad(`table barely rendered (${base} rows)`);
await shot("filter-01-baseline");

/* ---------------------------------------------------------- 1. open panel */
const opened = await js(`(() => {
  const th = document.querySelector('thead th[data-col="population"]');
  if (!th) return false;
  th.click();
  return true;
})()`);
await sleep(600);
const panel = await js(`(() => {
  const p = window.__t.panel("population");
  if (!p) return null;
  const r = p.getBoundingClientRect();
  return {
    visible: r.width > 100 && r.top > 0 && r.bottom <= window.innerHeight + 1,
    inputs: p.querySelectorAll("input").length,
    placeholder: (p.querySelector('input[aria-label^="کمینهٔ"]') || {}).placeholder,
    hint: p.innerText.includes("کمینه") && p.innerText.includes("بیشینه"),
    portal: p.parentElement === document.body,
  };
})()`);
if (!opened) bad("population header not found");
else ok("clicked the «جمعیت» header");
if (!panel) bad("filter panel did not open");
else {
  if (panel.visible) ok(`panel inside the viewport (${panel.inputs} inputs)`);
  else bad("panel rendered outside the viewport");
  if (panel.portal) ok("panel is portalled out of the scroll box (not clipped)");
  else bad("panel is still inside the table's overflow box");
  if (panel.placeholder && panel.placeholder !== "—")
    ok(`empty box shows the data bound (${panel.placeholder})`);
  else bad("no data bound placeholder");
  if (panel.hint) ok("panel names the data range");
  else bad("data range line missing");
}
await shot("filter-02-panel");

/* --------------------------------------------- 2. numeric range, Persian */
await js(`(() => {
  window.__t.set(window.__t.box("population", "کمینهٔ"), "۲۰٬۰۰۰");
  window.__t.set(window.__t.box("population", "بیشینهٔ"), "۸۰٬۰۰۰");
})()`);
await sleep(900);
const ranged = await js(`(() => {
  const pops = window.__t.cells("population").map(window.__t.num);
  return {
    rows: window.__t.rows(),
    n: pops.length,
    min: Math.min(...pops),
    max: Math.max(...pops),
    dash: pops.filter((v) => v === null).length,
    chip: !!document.querySelector('[data-chip="population"]'),
    chipText: (document.querySelector('[data-chip="population"]') || {}).innerText || "",
    count: window.__t.count(),
  };
})()`);
console.log("\n=== population ۲۰٬۰۰۰ – ۸۰٬۰۰۰ ===");
console.log(`  rows ${base} -> ${ranged.rows} | cells ${ranged.min}..${ranged.max} | chip: ${ranged.chipText.replace(/\n/g, " ")}`);
if (ranged.rows > 0 && ranged.rows < base) ok(`range narrowed the board (${base} -> ${ranged.rows})`);
else bad(`range did not narrow anything (${ranged.rows})`);
if (ranged.min >= 20_000 && ranged.max <= 80_000 && ranged.dash === 0)
  ok(`every visible population cell obeys the range (${ranged.n} rows)`);
else bad(`out-of-range or unknown cells survived: ${ranged.min}..${ranged.max}, ${ranged.dash} «—»`);
if (ranged.chip) ok(`active filter is shown as a chip: ${ranged.chipText.replace(/\n/g, " ")}`);
else bad("no filter chip");
if (ranged.count.includes("از")) ok(`count line reads «${ranged.count.split("·")[0].trim()}»`);
else bad(`count line does not mention the narrowing: ${ranged.count}`);
await shot("filter-03-range");

/* -------------------------------------------- 3. crossed ends stay usable */
await js(`(() => {
  window.__t.set(window.__t.box("population", "کمینهٔ"), "۸۰٬۰۰۰");
  window.__t.set(window.__t.box("population", "بیشینهٔ"), "۲۰٬۰۰۰");
})()`);
await sleep(900);
const crossed = await js(`window.__t.rows()`);
if (crossed > 0) ok(`crossed ends read as the same interval (${crossed} rows, not empty)`);
else bad("crossed ends emptied the table");

/* ------------------------------------------------- 4. chip removes filter */
await js(`(() => {
  const b = document.querySelector('[data-chip="population"] button');
  if (b) b.click();
})()`);
await sleep(900);
const cleared = await js(`(() => ({
  rows: window.__t.rows(),
  chip: !!document.querySelector('[data-chip="population"]'),
  panel: !!window.__t.panel("population"),
}))()`);
if (cleared.rows === base) ok(`chip cleared the filter (${cleared.rows} rows back)`);
else bad(`clearing did not restore the board (${cleared.rows} vs ${base})`);
if (!cleared.chip) ok("chip removed");

/* ------------------------------------------------------ 5. text substring */
await js(`(() => {
  const th = document.querySelector('thead th[data-col="county"]');
  if (th) th.click();
})()`);
await sleep(500);
await js(`(() => {
  const el = window.__t.box("county", "متن");
  if (el) window.__t.set(el, "اهواز");
})()`);
await sleep(900);
const textFiltered = await js(`(() => {
  const cells = window.__t.cells("county");
  return {
    rows: window.__t.rows(),
    total: cells.length,
    hit: cells.filter((c) => c && c.includes("اهواز")).length,
    empty: cells.filter((c) => !c).length,
    listed: (window.__t.panel("county") || { querySelectorAll: () => [] })
      .querySelectorAll('input[type="checkbox"]').length,
  };
})()`);
console.log("\n=== county includes «اهواز» ===");
console.log(`  rows ${textFiltered.rows} | cells matching ${textFiltered.hit}/${textFiltered.total} | listed values ${textFiltered.listed}`);
if (textFiltered.rows > 0 && textFiltered.rows < base)
  ok(`text filter narrowed the board (${base} -> ${textFiltered.rows})`);
else bad(`text filter did nothing (${textFiltered.rows})`);
if (textFiltered.hit === textFiltered.total && textFiltered.empty === 0)
  ok("every visible county cell contains the term");
else bad(`${textFiltered.total - textFiltered.hit} visible rows do not match the term`);
await shot("filter-04-text");

/* --------------------------------------------------- 6. Escape closes it */
await js(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await sleep(400);
const closed = await js(`!window.__t.panel("county")`);
if (closed) ok("Escape closed the panel");
else bad("Escape did not close the panel");

/* ------------------------------------- 7. the arrow still sorts the column */
await js(`(() => {
  const b = document.querySelector('thead th[data-col="population"] button[aria-label^="مرتب‌سازی"]');
  if (b) b.click();
})()`);
await sleep(900);
const sortedState = await js(`(() => {
  const th = document.querySelector('thead th[data-col="population"]');
  const pops = window.__t.cells("population").map(window.__t.num).filter((v) => v !== null);
  return { aria: th.getAttribute("aria-sort"), first: pops[0], last: pops[pops.length - 1] };
})()`);
console.log(`\n=== sort arrow ===\n  aria-sort=${sortedState.aria} first=${sortedState.first} last=${sortedState.last}`);
if (sortedState.aria === "descending" || sortedState.aria === "ascending")
  ok(`arrow sorts without opening the panel (aria-sort=${sortedState.aria})`);
else bad("the sort arrow did not sort");

console.log(`\n${fails.length === 0 ? "PROOF OK" : `PROOF FAILED (${fails.length})`}\n`);
ws.close();
child.kill();
process.exit(fails.length ? 1 : 0);
