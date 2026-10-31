/**
 * Headless proof harness for the Khuzestan map page.
 *
 * Drives real Chrome over CDP (no npm deps — Node 22+ ships a global WebSocket),
 * reads the DOM back, and captures screenshots. Every interaction the page
 * claims to support is exercised here: hover tooltip, click-to-select detail,
 * ring expansion, layer toggles, search filtering and zoom.
 *
 *   node scripts/proof-map.mjs [url] [outDir]
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:3737/map";
const OUT = process.argv[3] ?? "shots";
const PORT = 9334;

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) throw new Error("no chrome/edge found");

const profile = path.join(tmpdir(), `pharm-map-proof-${Date.now()}`);
mkdirSync(OUT, { recursive: true });

const child = spawn(
  chrome,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1680,1150",
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

async function getJSON(p) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(400);
  }
  throw new Error(`CDP endpoint ${p} never came up`);
}

const version = await getJSON("/json/version");
console.log("browser:", version["Browser"]);
const targets = await getJSON("/json/list");
const pageTarget = targets.find((t) => t.type === "page");
if (!pageTarget) throw new Error("no page target");

const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  }
};
function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

async function shot(name, clip) {
  const r = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: !!clip,
    ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
  });
  const file = path.join(OUT, `${name}.png`);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`  shot -> ${file}`);
  return file;
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1680,
  height: 1150,
  deviceScaleFactor: 1,
  mobile: false,
});

console.log(`\nnavigating -> ${URL_}`);
await send("Page.navigate", { url: URL_ });
await sleep(8000);

/* ------------------------------------------------------------ structure --- */
const base = await evaluate(`(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const svg = q("svg");
  const r = svg.getBoundingClientRect();
  const card = svg.closest("div.mx-auto");
  const cr = card ? card.getBoundingClientRect() : null;
  const texts = qa("svg text");
  const boxes = texts.map(t => { const b = t.getBBox(); return [b.x, b.y, b.width, b.height]; });
  let overlaps = 0;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (!(a[0]+a[2] < b[0] || b[0]+b[2] < a[0] || a[1]+a[3] < b[1] || b[1]+b[3] < a[1])) overlaps++;
  }
  const paths = qa("svg path").filter(p => p.getAttribute("fill") !== "none");
  return {
    title: document.title,
    dir: document.documentElement.dir,
    h1: q("h1")?.textContent?.trim(),
    svg: { w: Math.round(r.width), h: Math.round(r.height), viewBox: svg.getAttribute("viewBox") },
    card: cr ? { w: Math.round(cr.width), h: Math.round(cr.height), x: Math.round(cr.x), y: Math.round(cr.y) } : null,
    circles: qa("svg circle").length,
    cells: qa("svg rect").length,
    filledPaths: paths.length,
    edgeLines: qa("svg line").length,
    labels: texts.length,
    labelOverlaps: overlaps,
    tableRows: qa("tbody tr").length,
    tables: qa("table").length,
    chips: qa("header span").map(s => s.textContent.trim()).slice(0, 10),
    ladderRows: qa("table")[0] ? qa("table")[0].querySelectorAll("tbody tr").length : 0,
    horizonatalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    docHeight: document.documentElement.scrollHeight,
  };
})()`);
console.log("\n=== MAP BASE ===");
console.log(JSON.stringify(base, null, 2));

await shot("map-01-viewport");
const cardRect = await evaluate(`(() => {
  const svg = document.querySelector("svg");
  const card = svg.closest("div.mx-auto");
  const r = card.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) };
})()`);
await shot("map-02-card", cardRect);

/* -------------------------------------------------------- hover tooltip --- */
const hoverRes = await evaluate(`(() => {
  const svg = document.querySelector("svg");
  const r = svg.getBoundingClientRect();
  // biggest dot in the middle of the province = a city
  const dots = Array.from(svg.querySelectorAll("circle")).filter(c => +c.getAttribute("r") > 3);
  const target = dots[2];
  const b = target.getBoundingClientRect();
  const opts = { clientX: b.x + b.width / 2, clientY: b.y + b.height / 2, bubbles: true };
  svg.dispatchEvent(new PointerEvent("pointermove", opts));
  return { dots: dots.length, x: Math.round(b.x), y: Math.round(b.y) };
})()`);
await sleep(700);
const tooltip = await evaluate(`(() => {
  const box = Array.from(document.querySelectorAll("div")).find(d =>
    d.className.includes("pointer-events-none") && d.className.includes("absolute"));
  return box ? { text: box.innerText.replace(/\\n/g, " | "), visible: box.getBoundingClientRect().width > 0 } : null;
})()`);
console.log("\n=== HOVER ===", JSON.stringify({ hoverRes, tooltip }, null, 2));
await shot("map-03-hover");

/* -------------------------------------------------------------- select --- */
const selected = await evaluate(`(() => {
  const svg = document.querySelector("svg");
  svg.dispatchEvent(new PointerEvent("pointerdown", { clientX: 0, clientY: 0, bubbles: true, pointerId: 1 }));
  svg.dispatchEvent(new PointerEvent("pointerup", { clientX: 0, clientY: 0, bubbles: true, pointerId: 1 }));
  return true;
})()`);
await sleep(900);
const detail = await evaluate(`(() => {
  const h = Array.from(document.querySelectorAll("div")).find(d => d.className.includes("border-brand/25"));
  return h ? { open: true, text: h.innerText.split("\\n").slice(0, 14) } : { open: false };
})()`);
console.log("\n=== SELECT ===", JSON.stringify({ selected, detail }, null, 2));

/* ---------------------------------------------------- ring expansion ----- */
const ringBefore = await evaluate(`document.querySelectorAll("tbody tr").length`);
const ladderClick = await evaluate(`(() => {
  const table = document.querySelectorAll("table")[0];
  const rows = Array.from(table.querySelectorAll("tbody tr"));
  const target = rows.find(r => r.innerText.includes("—")) ?? rows[3];
  target.click();
  return target.innerText.split("\\t")[0];
})()`);
await sleep(1200);
const ringAfter = await evaluate(`(() => ({
  rows: document.querySelectorAll("tbody tr").length,
  radiusChip: Array.from(document.querySelectorAll("span")).map(s => s.textContent.trim()).find(t => t.includes("کیلومتر")) ?? null,
  heading: Array.from(document.querySelectorAll("span")).map(s => s.textContent.trim()).find(t => t.includes("درون شعاع")) ?? null,
}))()`);
console.log("\n=== RING EXPANSION ===", JSON.stringify({ ringBefore, ladderClick, ringAfter }, null, 2));

/* ------------------------------------------------------------ layers ----- */
const layersOff = await evaluate(`(() => {
  const labels = Array.from(document.querySelectorAll("label"));
  const netLabel = labels.find(l => l.textContent.includes("شبکهٔ فاصله"));
  const adminLabel = labels.find(l => l.textContent.includes("مرزها"));
  netLabel?.querySelector("input")?.click();
  adminLabel?.querySelector("input")?.click();
  return { netChecked: netLabel?.querySelector("input")?.checked, adminChecked: adminLabel?.querySelector("input")?.checked };
})()`);
await sleep(900);
const layerCounts = await evaluate(`(() => ({
  lines: document.querySelectorAll("svg line").length,
  paths: document.querySelectorAll("svg path").length,
}))()`);
console.log("\n=== LAYERS ===", JSON.stringify({ layersOff, layerCounts }, null, 2));
await shot("map-04-network");

/* -------------------------------------------------------------- zoom ----- */
const zoomRes = await evaluate(`(() => {
  const before = document.querySelector("g#scene").getAttribute("transform");
  const plus = Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === "+");
  plus?.click();
  plus?.click();
  const after = document.querySelector("g#scene").getAttribute("transform");
  return { before, after, labels: document.querySelectorAll("svg text").length };
})()`);
await sleep(900);
const zoomLabels = await evaluate(`document.querySelectorAll("svg text").length`);
console.log("\n=== ZOOM ===", JSON.stringify({ zoomRes, zoomLabels }, null, 2));
await shot("map-05-zoomed");

/* ------------------------------------------------------------ search ----- */
const search = await evaluate(`(() => {
  const input = Array.from(document.querySelectorAll("input")).find(i => i.placeholder?.includes("جستجو"));
  if (!input) return { ok: false };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  const before = document.querySelectorAll("tbody tr").length;
  setter.call(input, "امالطمیر");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return { ok: true, before };
})()`);
await sleep(1200);
const searchAfter = await evaluate(`(() => ({
  rows: document.querySelectorAll("tbody tr").length,
  chips: Array.from(document.querySelectorAll("button")).filter(b => b.textContent.includes("شهرستان")).slice(0, 4).map(b => b.textContent.trim()),
}))()`);
console.log("\n=== SEARCH ===", JSON.stringify({ search, searchAfter }, null, 2));

await shot("map-06-fullpage", { x: 0, y: 0, width: 1680, height: Math.min(base.docHeight, 2400) });

ws.close();
child.kill();
await sleep(600);
try {
  rmSync(profile, { recursive: true, force: true });
} catch {}
console.log("\nDONE");
process.exit(0);
