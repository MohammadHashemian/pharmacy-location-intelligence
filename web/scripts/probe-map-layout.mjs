/**
 * Layout probe for /map: reports the box of every top-level card, the grid
 * template actually computed, and anything that pushes the page wider than the
 * viewport. Read-only — no assertions, just numbers.
 *
 *   node scripts/probe-map-layout.mjs [url] [width] [height]
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:3737/map";
const VW = Number(process.argv[3] ?? 1568);
const VH = Number(process.argv[4] ?? 900);
const PORT = 9335;

const chrome = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));

const profile = path.join(tmpdir(), `pharm-probe-${Date.now()}`);
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
  throw new Error(`CDP ${p} never came up`);
}

const targets = await getJSON("/json/list");
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
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
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: VW,
  height: VH,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: URL_ });
await sleep(8000);

const out = await evaluate(`(() => {
  const r = (el) => {
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
             right: Math.round(b.right), bottom: Math.round(b.bottom) };
  };
  const main = document.querySelector("main");
  const grid = main.querySelector("div.grid");
  const cards = Array.from(grid.children).map((c, i) => ({
    i,
    cls: c.className.slice(0, 60),
    ...r(c),
    overflowX: getComputedStyle(c).overflowX,
    position: getComputedStyle(c).position,
  }));
  // widest offenders
  const wide = Array.from(document.querySelectorAll("body *"))
    .filter((el) => {
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.right > innerWidth + 1;
    })
    .slice(0, 12)
    .map((el) => ({
      tag: el.tagName,
      cls: (el.getAttribute("class") || "").slice(0, 90),
      right: Math.round(el.getBoundingClientRect().right),
      w: Math.round(el.getBoundingClientRect().width),
    }));
  // only the decluttered label group: the cartographic title is not a map label
  const texts = Array.from(document.querySelectorAll('svg g[pointer-events="none"] text'));
  const px = texts.map((t) => +getComputedStyle(t).fontSize.replace("px", ""));
  const svgBox = document.querySelector("svg").getBoundingClientRect();
  return {
    viewport: { w: innerWidth, h: innerHeight },
    svg: { w: Math.round(svgBox.width), h: Math.round(svgBox.height) },
    labels: (() => {
      const b = texts.map((t) => t.getBoundingClientRect());
      let ov = 0;
      for (let i = 0; i < b.length; i++)
        for (let j = i + 1; j < b.length; j++) {
          const a = b[i], c = b[j];
          if (!(a.right < c.left || c.right < a.left || a.bottom < c.top || c.bottom < a.top)) ov++;
        }
      const hs = b.map((r) => r.height).sort((x, y) => x - y);
      return {
        n: texts.length,
        minPx: +Math.min(...px).toFixed(1),
        maxPx: +Math.max(...px).toFixed(1),
        renderedHeightPx: +hs[Math.floor(hs.length / 2)].toFixed(1),
        overlaps: ov,
      };
    })(),
    doc: {
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      scrollH: document.documentElement.scrollHeight,
    },
    main: r(main),
    grid: { ...r(grid), cols: getComputedStyle(grid).gridTemplateColumns, dir: getComputedStyle(grid).direction },
    cards,
    wide,
  };
})()`);
console.log(JSON.stringify(out, null, 2));

// optional screenshot: node scripts/probe-map-layout.mjs url w h shots/name.png
const shotPath = process.argv[5];
if (shotPath) {
  const again = await evaluate(`document.documentElement.scrollTo(0, 0), true`);
  await sleep(400);
  const img = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(shotPath, Buffer.from(img.data, "base64"));
  console.log("shot ->", shotPath, again);
}
ws.close();
child.kill();
process.exit(0);
