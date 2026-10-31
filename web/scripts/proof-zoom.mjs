/**
 * Zoom proof for /map: drives real Chrome, sets the zoom the way the user does
 * (wheel / + button), and reports what is actually on screen — symbols, labels,
 * roads, the fine grid — plus a screenshot per level.
 *
 *   node scripts/proof-zoom.mjs [url] [outDir]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:3737/map";
const OUT = process.argv[3] ?? "shots";
const PORT = 9338;
const chrome = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
mkdirSync(OUT, { recursive: true });
const profile = path.join(tmpdir(), `pharm-zoom-${Date.now()}`);
const child = spawn(chrome, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--window-size=1680,1150", "--hide-scrollbars", "--disable-gpu",
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--force-device-scale-factor=1", "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(p) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${p}`); if (r.ok) return await r.json(); } catch {}
    await sleep(400);
  }
  throw new Error("no cdp");
}
const targets = await getJSON("/json/list");
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
}

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1680, height: 1150, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: URL_ });
await sleep(9000);

const view = () => evaluate(`(() => {
  const g = document.querySelector("g#scene");
  const t = g.getAttribute("transform");
  const k = +t.split("scale(")[1].replace(")", "");
  return { transform: t, k };
})()`);

const measure = () => evaluate(`(() => {
  const svg = document.querySelector("svg");
  const texts = Array.from(svg.querySelectorAll('g[pointer-events="none"] text'));
  const labels = texts.map((t) => ({ s: t.textContent, px: +getComputedStyle(t).fontSize.replace("px", "") }));
  // a real settlement marker, not the distance rings around اهواز
  const dots = Array.from(svg.querySelectorAll("circle")).filter(
    (c) => c.getAttribute("fill") === "#475569" || c.getAttribute("fill") === "#4338ca",
  );
  const dotPx = dots.length ? Math.round(dots[0].getBoundingClientRect().width) : 0;
  return {
    zoom: +document.querySelector("g#scene").getAttribute("transform").split("scale(")[1].replace(")", ""),
    labels: labels.length,
    labelSample: labels.slice(0, 6).map((l) => l.s),
    smallestLabelPx: labels.length ? Math.min(...labels.map((l) => l.px)) : 0,
    dots: dots.length,
    dotDiameterPx: dotPx,
    rects: svg.querySelectorAll("rect").length,
    roadPaths: svg.querySelectorAll("path").length,
    scaleBar: (() => {
      const card = svg.closest("div");
      const el = Array.from(card.querySelectorAll("span")).find((t) => /کیلومتر/.test(t.textContent) && t.children.length === 0);
      return el ? el.textContent.trim() : null;
    })(),
    gridCells: document.querySelectorAll("svg rect").length,
    ariaBusy: false,
  };
})()`);

const zoomTo = async (target) => {
  const cur = (await view()).k;
  let clicks = Math.max(0, Math.round(Math.log(target / cur) / Math.log(1.5)));
  for (let i = 0; i < clicks; i++) {
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent.trim() === "+");
      b?.click();
    })()`);
    await sleep(220);
  }
  await sleep(900);
};

const results = [];
for (const [name, target] of [["z1", 1], ["z3", 3], ["z6", 6], ["z12", 12], ["z24", 24]]) {
  await zoomTo(target);
  const m = await measure();
  results.push({ name, ...m });
  await shot(`map-${name}`);
  console.log(name, JSON.stringify(m));
}

/* probe: pick a point and read the catchment panel */
await evaluate(`(() => {
  const b = Array.from(document.querySelectorAll("button")).find((x) => x.textContent.includes("تحلیل یک نقطه"));
  b?.click();
  return !!b;
})()`);
await sleep(500);
const pt = await evaluate(`(() => {
  const svg = document.querySelector("svg");
  const r = svg.getBoundingClientRect();
  const x = Math.round(r.x + r.width * 0.55);
  const y = Math.round(r.y + r.height * 0.55);
  svg.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y, bubbles: true, pointerId: 1 }));
  svg.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, bubbles: true, pointerId: 1 }));
  return { x, y };
})()`);
await sleep(1500);
const probe = await evaluate(`(() => {
  const el = Array.from(document.querySelectorAll("div")).find((d) => d.innerText?.startsWith("تحلیل نقطهٔ انتخابی"));
  return el ? el.innerText.split("\\n").slice(0, 14) : null;
})()`);
console.log("probe at", JSON.stringify(pt), "->", JSON.stringify(probe?.slice(0, 8) ?? null));
await shot("map-probe");

console.log("\nSUMMARY", JSON.stringify(results, null, 1));
ws.close(); child.kill(); process.exit(0);
