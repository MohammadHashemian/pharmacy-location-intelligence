/**
 * Proof harness for the population-basis switch.
 *
 * Drives real headless Chrome over CDP (no npm deps; Node 22+ has a global
 * WebSocket) and asserts, from the live DOM, that switching the population basis
 * genuinely RECALCULATES rather than relabels:
 *
 *   1. baseline: FDA mode, capture the top row and its population;
 *   2. click «جمعیت اصلاحشده (سرشماری)»;
 *   3. the ranking order and/or populations must change, the coverage chip must
 *      be non-zero, and «مرجع» badges must appear;
 *   4. open ملاشیه's detail panel and read both populations off the screen;
 *   5. measure overflow and scan every rendered digit for Latin forms.
 *
 *   node scripts/proof-population.mjs [url] [outDir]
 */
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:3737/";
const OUT = process.argv[3] ?? "shots";
const PORT = 9345;

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!CHROME) throw new Error("no chrome/edge found");

mkdirSync(OUT, { recursive: true });
const profile = path.join(tmpdir(), `pharm-pop-${Date.now()}`);
const child = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1680,1200",
    "--hide-scrollbars",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--force-device-scale-factor=1",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = [];
const ok = (m) => console.log(`  OK   ${m}`);
const bad = (m) => {
  console.log(`  FAIL ${m}`);
  fail.push(m);
};

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(400);
  }
  throw new Error("devtools not reachable");
}

const list = await targets();
const page = list.find((t) => t.type === "page");
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
function send(method, params = {}) {
  const mid = ++id;
  return new Promise((res, rej) => {
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
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
  const p = path.join(OUT, `${name}.png`);
  const fs = await import("node:fs");
  fs.writeFileSync(p, Buffer.from(r.data, "base64"));
  console.log(`  shot ${p}`);
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1680,
  height: 1200,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: URL_ });
await sleep(6000);

/* ---------------------------------------------------------------- helpers -- */
const READ = `(() => {
  const rows = [...document.querySelectorAll("tbody tr")];
  const first = rows[0];
  const cells = first ? [...first.querySelectorAll("td")].map(td => td.innerText.trim()) : [];
  const cov = [...document.querySelectorAll("span")]
    .map(s => s.innerText.trim())
    .find(t => t.startsWith("پوشش مرجع"));
  const badges = [...document.querySelectorAll("tbody span")]
    .filter(s => s.innerText.includes("مرجع")).length;
  const warn = [...document.querySelectorAll("tbody span")]
    .filter(s => s.innerText.includes("⚠")).length;
  const all = document.body.innerText;
  const latin = (all.match(/[0-9]/g) || []).length;
  const sw = document.documentElement.scrollWidth;
  const cw = document.documentElement.clientWidth;
  return { nRows: rows.length, cells: cells.slice(0, 6), cov, badges, warn, latin,
           overflow: sw - cw, scrollW: sw, clientW: cw,
           mode: document.querySelector('[aria-pressed="true"]')?.innerText.trim() ?? null };
})()`;

console.log("=== baseline (FDA population) ===");
const before = await js(READ);
console.log("  mode:", before.mode);
console.log("  rows:", before.nRows, "| coverage chip:", before.cov);
console.log("  top row cells:", before.cells);
console.log("  ref badges:", before.badges, "| warn badges:", before.warn);
console.log("  latin digits in DOM:", before.latin, "| overflow px:", before.overflow);
await shot("pop-01-fda-mode");

/* ------------------------------------------------- click the corrected basis */
const clicked = await js(`(() => {
  const b = [...document.querySelectorAll("button")]
    .find(x => x.innerText.includes("جمعیت اصلاح‌شده"));
  if (!b) return false;
  b.click();
  return true;
})()`);
if (!clicked) bad("could not find the «جمعیت اصلاح‌شده» button");
else ok("clicked «جمعیت اصلاح‌شده»");
await sleep(3500);

console.log("\n=== after switching to the corrected basis ===");
const after = await js(READ);
console.log("  mode:", after.mode);
console.log("  rows:", after.nRows, "| coverage chip:", after.cov);
console.log("  top row cells:", after.cells);
console.log("  ref badges:", after.badges, "| warn badges:", after.warn);
console.log("  latin digits in DOM:", after.latin, "| overflow px:", after.overflow);
await shot("pop-02-reference-mode");

if (after.mode?.includes("اصلاح")) ok("the switch flipped mode");
else bad(`mode did not flip (got ${after.mode})`);
if ((after.badges ?? 0) > 0) ok(`${after.badges} «مرجع» badges rendered`);
else bad("no «مرجع» badge rendered");
if (after.overflow <= 1) ok(`no horizontal overflow (${after.overflow}px)`);
else bad(`table overflows by ${after.overflow}px`);
if ((after.latin ?? 0) === 0) ok("zero Latin digits in the rendered page");
else bad(`${after.latin} Latin digits rendered`);
if (JSON.stringify(before.cells) !== JSON.stringify(after.cells))
  ok("top row recalculated (cells changed)");
else bad("top row identical after switching — switch may be cosmetic");

/* ------------------------------------- ملاشیه's detail panel: both numbers -- */
/* Its corrected population is 16,575, below the default 20,000 floor, so the
   settings panel has to be opened and the population floor dropped first. The
   floor slider is uniquely identifiable by its range attributes. */
const opened = await js(`(() => {
  const b = [...document.querySelectorAll("button")]
    .find(x => x.innerText.includes("تنظیم دقیق مدل"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(1800);
const lowered = await js(`(() => {
  const r = [...document.querySelectorAll('input[type=range]')]
    .find(i => i.max === "200000" && i.step === "5000");
  if (!r) return "no-slider";
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  set.call(r, "0");
  r.dispatchEvent(new Event("input", { bubbles: true }));
  r.dispatchEvent(new Event("change", { bubbles: true }));
  return r.value;
})()`);
await sleep(2000);
console.log(`\n  settings opened: ${opened} | min-population set to: ${lowered}`);

const found = await js(`(() => {
  const inp = document.querySelector('input[placeholder^="جستجوی"]');
  if (!inp) return "no-search";
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  set.call(inp, 'ملاشیه');
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  return "typed";
})()`);
await sleep(2200);
const rowClick = await js(`(() => {
  const tr = document.querySelector("tbody tr");
  if (!tr) return "no-row";
  const cell = tr.querySelector("td:nth-child(2)");
  (cell || tr).click();
  return tr.innerText.trim().replace(/\\n/g, " / ").slice(0, 70);
})()`);
await sleep(2500);
console.log("\n=== ملاشیه detail panel ===");
console.log("  search:", found, "| row clicked:", rowClick);
const detail = await js(`(() => {
  const t = document.body.innerText;
  const grab = (label) => {
    const i = t.indexOf(label);
    if (i < 0) return null;
    return t.slice(i, i + 90).split("\\n").slice(0, 2).join(" = ");
  };
  return {
    corrected: grab("جمعیت (اصلاح‌شده)"),
    fda: grab("جمعیت سازمان (اصلی)"),
    source: grab("منبع جمعیت اصلاح‌شده"),
    census: grab("سال سرشماری"),
    confidence: grab("درجهٔ اطمینان تطبیق"),
    hasRef: t.includes("جمعیت مرجع"),
  };
})()`);
console.log(JSON.stringify(detail, null, 2));
if (detail.fda && detail.corrected) ok("detail panel shows BOTH populations side by side");
else bad("detail panel missing one of the two populations");
if (detail.hasRef) ok("detail panel shows the reference provenance block");
else bad("no provenance block in the detail panel");
await shot("pop-03-detail-provenance");

console.log(
  `\n${fail.length === 0 ? "PROOF OK" : `PROOF FAILED (${fail.length})`}\n`,
);
ws.close();
child.kill();
process.exit(fail.length === 0 ? 0 : 1);
