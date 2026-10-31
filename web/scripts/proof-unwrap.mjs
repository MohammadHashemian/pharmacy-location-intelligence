/**
 * Proof for the "unwrap county family" toggle.
 *
 * The detail panel's «سایر شهرهای …» list is the only place a city's county
 * siblings normally appear. This asserts the toggle pulls the same set into the
 * main table as ordinary rows, and that the rows are marked.
 *
 *   node scripts/proof-unwrap.mjs [url] [outDir]
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:3737/";
const OUT = process.argv[3] ?? "shots";
const PORT = 9391;

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!CHROME) throw new Error("no chrome/edge");

const child = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${PORT}`,
   `--user-data-dir=${path.join(tmpdir(), `pharm-unwrap-${Date.now()}`)}`,
   "--window-size=1680,1250", "--hide-scrollbars", "--disable-gpu",
   "--no-first-run", "about:blank"],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const ok = (m) => console.log(`  OK   ${m}`);
const bad = (m) => { console.log(`  FAIL ${m}`); fails.push(m); };

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
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
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
  new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params })); });
async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr,
    returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log(`  shot ${path.join(OUT, name + ".png")}`);
}

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1680, height: 1250, deviceScaleFactor: 1, mobile: false,
});
await send("Page.navigate", { url: URL_ });
await sleep(7000);

const FAMILY = ["شیبان", "ملاثانی", "ویس"];

/* 1. baseline: search باوی so the county is genuinely in view */
await js(`(() => {
  const i = document.querySelector('input[placeholder^="جستجوی"]');
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  set.call(i, "باوی"); i.dispatchEvent(new Event("input",{bubbles:true}));
})()`);
await sleep(2000);
const before = await js(`(() => {
  const t = document.body.innerText;
  return { rows: document.querySelectorAll("tbody tr").length,
           hasFamily: ${JSON.stringify(FAMILY)}.filter(n => t.includes(n)),
           badge: document.querySelectorAll("tbody span").length &&
                  [...document.querySelectorAll("tbody span")]
                    .filter(s=>s.innerText.includes("هم‌خانواده")).length };
})()`);
console.log("=== with the toggle OFF ===");
console.log("  rows:", before.rows, "| family present:", before.hasFamily, "| badges:", before.badge);
await shot("unwrap-01-off");

/* 2. turn the toggle on */
const clicked = await js(`(() => {
  const b = [...document.querySelectorAll("button")]
    .find(x => x.innerText.includes("بازکردن همهٔ شهرهای"));
  if (!b) return false; b.click(); return true;
})()`);
if (!clicked) bad("unwrap toggle not found");
else ok("toggled «بازکردن همهٔ شهرهای هم‌شهرستان»");
await sleep(3000);

const after = await js(`(() => {
  const t = document.body.innerText;
  const rows = [...document.querySelectorAll("tbody tr")];
  return { rows: rows.length,
           hasFamily: ${JSON.stringify(FAMILY)}.filter(n => t.includes(n)),
           badges: rows.filter(r => r.innerText.includes("هم‌خانواده")).length,
           overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
           counter: [...document.querySelectorAll("span")]
             .map(s=>s.innerText.trim())
             .find(x => x.includes("شهر هم‌خانواده به جدول افزوده")) ?? null };
})()`);
console.log("\n=== with the toggle ON ===");
console.log("  rows:", after.rows, "| badges:", after.badges);
console.log("  counter:", after.counter);
console.log("  family present:", after.hasFamily);
await shot("unwrap-02-on");

if (after.rows > before.rows)
  ok(`the table grew (${before.rows} -> ${after.rows} rows)`);
else bad("row count unchanged — the toggle did nothing");
if (after.badges > 0) ok(`${after.badges} rows marked «هم‌خانواده»`);
else bad("unwrapped rows are not marked");
if (after.overflow <= 1) ok(`no horizontal overflow (${after.overflow}px)`);
else bad(`overflow ${after.overflow}px`);
const missing = FAMILY.filter((n) => !after.hasFamily.includes(n));
if (missing.length === 0) ok(`the باوی family is on screen: ${FAMILY.join(", ")}`);
else bad(`still missing from the table: ${missing.join(", ")}`);

console.log(`\n${fails.length === 0 ? "PROOF OK" : `PROOF FAILED (${fails.length})`}\n`);
ws.close();
child.kill();
process.exit(fails.length ? 1 : 0);
