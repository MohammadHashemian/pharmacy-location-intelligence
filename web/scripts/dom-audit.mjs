/**
 * Focused DOM audit: exact rendered strings + real overflow measurement.
 * Vision on a downscaled screenshot guesses at separators; the DOM does not.
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:3737/";
const PORT = 9344;
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));

const profile = path.join(tmpdir(), `pharm-audit-${Date.now()}`);
const child = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--window-size=1680,1150", "--hide-scrollbars", "--disable-gpu", "--no-first-run",
  "--no-default-browser-check", "--force-device-scale-factor=1", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(p) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return await r.json(); } catch {}
    await sleep(400);
  }
  throw new Error("CDP not up");
}
const t = (await getJSON("/json/list")).find((x) => x.type === "page");
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id; pend.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expr) => (await send("Runtime.evaluate",
  { expression: expr, returnByValue: true, awaitPromise: true })).result.value;

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1680, height: 1150, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: URL_ });
await sleep(7000);

const cp = (s) => Array.from(s).map((c) => c.codePointAt(0));

console.log("=== exact cell strings (first data row) with codepoints ===");
const row = await evaluate(`(() => {
  const tr = document.querySelector("table tbody tr");
  return Array.from(tr.querySelectorAll("td")).map(td => td.textContent.trim());
})()`);
row.forEach((v, i) => {
  const codes = cp(v).filter(c => c > 127).map(c => "U+" + c.toString(16).toUpperCase());
  console.log(`  [${String(i).padStart(2)}] ${JSON.stringify(v)}  special=${codes.join(",") || "-"}`);
});

console.log("\n=== separator inventory across the whole page text ===");
const seps = await evaluate(`(() => {
  const t = document.body.innerText;
  const count = (re) => (t.match(re) || []).length;
  return {
    latinDigits: count(/[0-9]/g),
    persianDigits: count(/[\\u06F0-\\u06F9]/g),
    persianThousands_U066C: count(/\\u066C/g),
    persianDecimal_U066B: count(/\\u066B/g),
    latinComma: count(/,/g),
    latinPeriod: count(/\\./g),
    sampleThousands: (t.match(/[\\u06F0-\\u06F9\\u066C]+\\u066C[\\u06F0-\\u06F9]+/g) || []).slice(0,4),
    sampleDecimals: (t.match(/[\\u06F0-\\u06F9]+\\u066B[\\u06F0-\\u06F9]+/g) || []).slice(0,4),
    latinNumberRuns: (t.match(/[0-9]+(?:[.,][0-9]+)*/g) || []).slice(0, 12),
  };
})()`);
console.log(JSON.stringify(seps, null, 2));

console.log("\n=== overflow audit (every element wider than its parent) ===");
const overflow = await evaluate(`(() => {
  const bad = [];
  document.querySelectorAll("*").forEach((el) => {
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === "hidden") {
      bad.push({ tag: el.tagName, cls: (el.className||"").toString().slice(0,60),
                 scrollW: el.scrollWidth, clientW: el.clientWidth });
    }
    const r = el.getBoundingClientRect();
    if (r.width > 0 && (r.left < -2 || r.right > window.innerWidth + 2)) {
      if (el.tagName !== "HTML" && el.tagName !== "BODY")
        bad.push({ outOfViewport: true, tag: el.tagName,
                   cls: (el.className||"").toString().slice(0,60),
                   left: Math.round(r.left), right: Math.round(r.right) });
    }
  });
  return { docScrollW: document.documentElement.scrollWidth,
           viewportW: window.innerWidth, offenders: bad.slice(0, 15) };
})()`);
console.log(JSON.stringify(overflow, null, 2));

console.log("\n=== text-overflow / clipping on table cells ===");
const clip = await evaluate(`(() => {
  const out = [];
  document.querySelectorAll("table td, table th").forEach((el) => {
    if (el.scrollWidth > el.clientWidth + 1)
      out.push({ text: el.textContent.trim().slice(0,40), scrollW: el.scrollWidth, clientW: el.clientWidth });
  });
  return out.slice(0, 12);
})()`);
console.log(clip.length ? JSON.stringify(clip, null, 2) : "  none — no cell is clipped");

console.log("\n=== date + observability strings ===");
console.log(await evaluate(`Array.from(document.querySelectorAll("span,div"))
  .map(e=>e.textContent.trim())
  .filter(t=>t.includes("UTC")||t.includes("لحظه"))
  .slice(0,4)`));

ws.close(); child.kill(); await sleep(500);
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
