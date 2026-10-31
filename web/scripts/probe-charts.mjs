/**
 * Geometry probe for the Charts tab. Answers, from the live DOM rather than a
 * screenshot read:
 *   - effective type size in each chart (must be identical in CSS pixels, and
 *     must not change with the window width)
 *   - any text box that overflows its SVG, and any two text boxes that overlap
 *   - the histogram's bin tooltips and the scatter's clipped-outlier markers
 *   - console errors / page exceptions
 *
 *   node scripts/probe-charts.mjs [url] [width] [height]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:3737/";
const VW = Number(process.argv[3] ?? 1680);
const VH = Number(process.argv[4] ?? 1150);
const PORT = 9355 + (VW % 20);
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));

const profile = mkdtempSync(path.join(tmpdir(), "pharm-probe-"));
const child = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${VW},${VH}`,
    "--hide-scrollbars",
    "--disable-gpu",
    "--no-first-run",
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
  throw new Error("CDP never came up");
}

const ver = await getJSON("/json/version");
const t = (await getJSON("/json/list")).find((x) => x.type === "page");
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown")
    problems.push("EXCEPTION " + m.params.exceptionDetails.text);
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error")
    problems.push("LOG " + m.params.entry.text);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: VW,
  height: VH,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: URL_ });
await sleep(8000);
await evaluate(`(() => {
  const b = Array.from(document.querySelectorAll("button")).find(x => x.textContent.includes("نمودارها"));
  if (b) b.click();
})()`);
await sleep(2200);

console.log(`\n=== ${VW}x${VH} · ${ver["Browser"]} ===`);
const out = await evaluate(`(() => {
  const charts = Array.from(document.querySelectorAll("svg"))
    .filter(s => s.closest("main") && s.getBoundingClientRect().width > 200);
  const report = charts.map((s, i) => {
    const svgRect = s.getBoundingClientRect();
    const boxes = Array.from(s.querySelectorAll("text")).map(t => {
      const b = t.getBoundingClientRect();
      return {
        txt: t.textContent.replace(/\\s+/g, " ").trim().slice(0, 34),
        px: getComputedStyle(t).fontSize,
        l: Math.round(b.left - svgRect.left),
        r: Math.round(b.right - svgRect.left),
        t: Math.round(b.top - svgRect.top),
        b: Math.round(b.bottom - svgRect.top),
      };
    });
    const W = Math.round(svgRect.width), H = Math.round(svgRect.height);
    const overflow = boxes.filter(b => b.l < -1 || b.r > W + 1 || b.t < -1 || b.b > H + 1);
    const overlaps = [];
    for (let a = 0; a < boxes.length; a++)
      for (let c = a + 1; c < boxes.length; c++) {
        const A = boxes[a], B = boxes[c];
        if (A.l < B.r && B.l < A.r && A.t < B.b && B.t < A.b)
          overlaps.push([A.txt, B.txt]);
      }
    return {
      i,
      size: { W, H },
      textPx: [...new Set(boxes.map(b => b.px))],
      nText: boxes.length,
      overflow,
      overlaps,
      circles: s.querySelectorAll("circle").length,
      polys: s.querySelectorAll("polygon").length,
      bars: s.querySelectorAll("rect").length,
    };
  });
  const hist = charts[1], sc = charts[0];
  return {
    charts: report,
    docScrollsHorizontally: document.documentElement.scrollWidth > innerWidth + 2,
    scatterOutliers: sc ? Array.from(sc.querySelectorAll("polygon")).map(p =>
      p.querySelector("title")?.textContent?.replace(/\\s+/g," ").trim() ?? "") : [],
    histTitles: hist ? Array.from(hist.querySelectorAll("rect")).map(r =>
      r.querySelector("title")?.textContent?.replace(/\\s+/g," ").trim() ?? "(none)") : [],
  };
})()`);
console.log(JSON.stringify(out, null, 2));
if (problems.length) console.log("CONSOLE PROBLEMS:", problems);
else console.log("console: clean");

ws.close();
child.kill();
await sleep(500);
try {
  rmSync(profile, { recursive: true, force: true });
} catch {}
process.exit(0);
