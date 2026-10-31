/**
 * Measure the Charts tab geometry: how the scatter/histogram SVGs render at a
 * given viewport width, and what the effective CSS-pixel font sizes are inside
 * them (SVG viewBox scaling makes those resolution-dependent).
 *
 *   node scripts/measure-charts.mjs [url] [width] [height]
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:3737/";
const VW = Number(process.argv[3] ?? 1680);
const VH = Number(process.argv[4] ?? 1150);
const OUT = "shots";
const PORT = 9344;

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) throw new Error("no chrome/edge found");

const profile = path.join(tmpdir(), `pharm-measure-${Date.now()}`);
mkdirSync(OUT, { recursive: true });

const child = spawn(
  chrome,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${VW},${VH}`,
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
    clip = {
      x: 0,
      y: 0,
      width: Math.ceil(m.cssContentSize.width),
      height: Math.min(Math.ceil(m.cssContentSize.height), 16000),
      scale: 1,
    };
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
  width: VW,
  height: VH,
  deviceScaleFactor: 1,
  mobile: false,
});

console.log(`\nnavigating -> ${URL_} @ ${VW}x${VH}`);
await send("Page.navigate", { url: URL_ });
await sleep(8000);

/* go to the charts tab */
await evaluate(`(() => {
  const b = Array.from(document.querySelectorAll("button"))
    .find(x => x.textContent.includes("نمودارها"));
  if (b) b.click();
  return !!b;
})()`);
await sleep(2200);
await evaluate(`(() => {
  window.scrollTo(0, document.body.scrollHeight * 0.55);
})()`);
await sleep(900);

const m = await evaluate(`(() => {
  const svgs = Array.from(document.querySelectorAll("svg"))
    .filter(s => s.closest("main") && s.getBoundingClientRect().width > 200)
    .map((s, i) => {
      const r = s.getBoundingClientRect();
      const vb = s.getAttribute("viewBox");
      const card = s.closest("div.overflow-x-auto")?.parentElement ?? s.parentElement;
      const cardRect = card.getBoundingClientRect();
      // scale = rendered px per viewBox unit
      const parts = (vb || "0 0 1 1").split(/\\s+/).map(Number);
      const scale = parts[2] ? r.width / parts[2] : 1;
      const texts = Array.from(s.querySelectorAll("text")).map(t => {
        const fs = Number(t.getAttribute("font-size") || 0);
        const tr = t.getBoundingClientRect();
        return {
          t: t.textContent.slice(0, 28),
          svgPx: fs,
          cssPx: +(fs * scale).toFixed(2),
          w: +tr.width.toFixed(1),
          h: +tr.height.toFixed(1),
        };
      });
      const circles = s.querySelectorAll("circle");
      return {
        idx: i,
        viewBox: vb,
        rendered: { w: Math.round(r.width), h: Math.round(r.height) },
        svgTextPx: (() => {
          const t = s.querySelector("text");
          return t ? getComputedStyle(t).fontSize : null;
        })(),
        cardPad: (() => {
          const c = s.closest("div.rounded-2xl");
          return c ? getComputedStyle(c).padding : null;
        })(),
        circles: circles.length,
        polys: s.querySelectorAll("polygon").length,
        rects: s.querySelectorAll("rect").length,
        lines: s.querySelectorAll("line").length,
        texts: Array.from(s.querySelectorAll("text")).map((t) =>
          t.textContent.replace(/\s+/g, " ").slice(0, 46),
        ),
        textCount: texts.length,
        cardTitle: null,
        box: { x: Math.round(r.x), y: Math.round(r.y + scrollY) },
        minWidthClass: s.getAttribute("class"),
      };
    });
  return {
    viewport: { w: innerWidth, h: innerHeight },
    mainWidth: Math.round(document.querySelector("main").getBoundingClientRect().width),
    mainMaxWidth: getComputedStyle(document.querySelector("main")).maxWidth,
    docScrollsHorizontally: document.documentElement.scrollWidth > innerWidth + 2,
    svgs,
  };
})()`);
console.log("\n=== CHARTS TAB GEOMETRY ===");
console.log(JSON.stringify(m, null, 2));

/* clipped screenshot of each chart card, so scale is judged 1:1 */
for (const s of m.svgs) {
  const card = await evaluate(`(() => {
    const svgs = Array.from(document.querySelectorAll("svg"))
      .filter(s => s.closest("main") && s.getBoundingClientRect().width > 200);
    const el = svgs[${s.idx}].closest("div.rounded-2xl");
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y + scrollY, width: r.width, height: r.height };
  })()`);
  const r = await send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { ...card, scale: 1 },
  });
  const file = path.join(OUT, `card-${VW}-${s.idx}.png`);
  writeFileSync(file, Buffer.from(r.data, "base64"));
  console.log(`  card -> ${file}`);
}

await shot(`charts-${VW}`, { fullPage: true });

ws.close();
child.kill();
await sleep(600);
try {
  rmSync(profile, { recursive: true, force: true });
} catch {}
process.exit(0);
