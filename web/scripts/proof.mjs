/**
 * Headless proof harness — drives real Chrome over CDP (no npm deps; Node 22+
 * ships a global WebSocket) and captures a screenshot + DOM measurements for
 * each dashboard tab.
 *
 *   node scripts/proof.mjs [url] [outDir]
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:3737/";
const OUT = process.argv[3] ?? "shots";
const PORT = 9333;

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) throw new Error("no chrome/edge found");

const profile = path.join(tmpdir(), `pharm-proof-${Date.now()}`);
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
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
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

async function shot(name, { fullPage = false } = {}) {
  let clip;
  if (fullPage) {
    const m = await send("Page.getLayoutMetrics");
    const h = Math.min(Math.ceil(m.cssContentSize.height), 16000);
    clip = { x: 0, y: 0, width: Math.ceil(m.cssContentSize.width), height: h, scale: 1 };
  }
  const r = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: fullPage,
    ...(clip ? { clip } : {}),
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
await sleep(7000);

/* ------------------------------------------------------------- measure --- */
const base = await evaluate(`(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s));
  const table = q("table");
  const rows = qa("table tbody tr");
  const tabs = qa("button").map(b => b.textContent.trim())
     .filter(t => t && !t.includes("بازنشانی"));
  return {
    title: document.title,
    dir: document.documentElement.dir,
    lang: document.documentElement.lang,
    h1: q("h1")?.textContent?.trim(),
    fontFamily: getComputedStyle(document.body).fontFamily,
    tableRows: rows.length,
    tableCols: table ? table.querySelectorAll("thead th").length : 0,
    bodyScrollsHorizontally:
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    docHeight: document.documentElement.scrollHeight,
    statTiles: qa(".tnum").length,
    firstRow: rows[0] ? Array.from(rows[0].querySelectorAll("td")).map(td => td.textContent.trim()) : null,
    secondRow: rows[1] ? Array.from(rows[1].querySelectorAll("td")).map(td => td.textContent.trim()) : null,
    headingText: qa("h1,h2,h3").map(h => h.textContent.trim()).slice(0, 12),
    tabLabels: [...new Set(tabs)].slice(0, 24),
  };
})()`);
console.log("\n=== BASE MEASUREMENTS ===");
console.log(JSON.stringify(base, null, 2));

await shot("01-ranking", { fullPage: true });
await shot("02-ranking-viewport");

/* --------------------------------------------------- click a table row --- */
const opened = await evaluate(`(() => {
  const row = document.querySelector("table tbody tr");
  if (!row) return false;
  row.click();
  return true;
})()`);
await sleep(1400);
const detail = await evaluate(`(() => {
  const aside = document.querySelector("aside");
  if (!aside) return { open: false };
  const r = aside.getBoundingClientRect();
  return {
    open: true, width: Math.round(r.width), height: Math.round(r.height),
    h2: aside.querySelector("h2")?.textContent?.trim(),
    sections: Array.from(aside.querySelectorAll("h3")).map(h => h.textContent.trim()),
    noHorizontalOverflow: aside.scrollWidth <= aside.clientWidth + 2,
  };
})()`);
console.log("\n=== DETAIL DRAWER ===");
console.log(JSON.stringify(detail, null, 2));
if (detail.open) await shot("03-detail-drawer");

await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
await sleep(700);

/* ------------------------------------------------------------- tabs ----- */
const tabsToShoot = [
  ["04-whitespace", "فضای خالی بازار"],
  ["05-counties", "شهرستان‌ها"],
  ["06-charts", "نمودارها"],
  ["07-data", "داده و منبع"],
];
for (const [name, label] of tabsToShoot) {
  const ok = await evaluate(`(() => {
    const b = Array.from(document.querySelectorAll("button"))
      .find(x => x.textContent.includes(${JSON.stringify(label)}));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(1800);
  const measure = await evaluate(`(() => ({
    heading: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0,6).map(h=>h.textContent.trim()),
    svgs: document.querySelectorAll("svg").length,
    tableRows: document.querySelectorAll("table tbody tr").length,
    tables: document.querySelectorAll("table").length,
    bodyScrollsHorizontally:
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    docHeight: document.documentElement.scrollHeight,
  }))()`);
  console.log(`\n=== TAB ${label} (clicked=${ok}) ===`);
  console.log(JSON.stringify(measure, null, 2));
  await shot(name, { fullPage: true });
}

/* --------------------------------------------------- scoring response --- */
console.log("\n=== RE-SCORING CHECK (change a weight, read the top row) ===");
// go back to the ranking tab, the weight sliders only exist inside the model panel
await evaluate(`(() => {
  const b = Array.from(document.querySelectorAll("button"))
    .find(x => x.textContent.includes("رتبه‌بندی و مرتب‌سازی"));
  if (b) b.click();
})()`);
await sleep(1200);
await evaluate(`(() => {
  const b = Array.from(document.querySelectorAll("button"))
    .find(x => x.textContent.includes("تنظیم دقیق مدل") || x.textContent.includes("تنظیم مدل"));
  if (b) b.click();
})()`);
await sleep(1500);

const before = await evaluate(
  `document.querySelector("table tbody tr")?.querySelectorAll("td")[1]?.textContent?.trim()`,
);
const weightBefore = await evaluate(
  `document.querySelectorAll('input[type=range]')[0]?.value`,
);
// drive the FIRST weight slider (market size) to its maximum
await evaluate(`(() => {
  const r = document.querySelectorAll('input[type=range]')[0];
  if (!r) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
  setter.call(r, r.max);
  r.dispatchEvent(new Event('input',{bubbles:true}));
  r.dispatchEvent(new Event('change',{bubbles:true}));
  return true;
})()`);
await sleep(1500);
const after = await evaluate(
  `document.querySelector("table tbody tr")?.querySelectorAll("td")[1]?.textContent?.trim()`,
);
const weightAfter = await evaluate(
  `document.querySelectorAll('input[type=range]')[0]?.value`,
);
const summary = await evaluate(
  `Array.from(document.querySelectorAll("span")).map(s=>s.textContent.trim()).find(t=>t.includes("بازار")&&t.includes("٪")) ?? null`,
);
console.log(
  JSON.stringify(
    {
      weightSliderBefore: weightBefore,
      weightSliderAfter: weightAfter,
      topRowBefore: before,
      topRowAfter: after,
      modelSummaryAfter: summary,
    },
    null,
    2,
  ),
);
await shot("08-rescored", { fullPage: false });

ws.close();
child.kill();
await sleep(600);
try {
  rmSync(profile, { recursive: true, force: true });
} catch {}
console.log("\nDONE");
process.exit(0);
