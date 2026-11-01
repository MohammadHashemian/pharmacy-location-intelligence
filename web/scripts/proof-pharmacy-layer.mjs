/**
 * Zooms to اهواز through the UI (search -> chip -> fly) and shoots the pharmacy
 * layer, so the "existing pharmacies on the map" claim has a picture.
 *
 *   node scripts/proof-pharmacy-layer.mjs [url] [outDir]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:3737/map";
const OUT = process.argv[3] ?? "shots";
const PORT = 9341;
const chrome = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
mkdirSync(OUT, { recursive: true });
const profile = path.join(tmpdir(), `pharm-ph-${Date.now()}`);
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
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log("shot ->", path.join(OUT, `${name}.png`));
};

await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1680, height: 1150, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: URL_ });
await sleep(9000);

// search → first hit chip → the page flies to it
await evaluate(`(() => {
  const input = Array.from(document.querySelectorAll("input")).find(i => i.placeholder?.includes("جستجو"));
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(input, "اهواز");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
await sleep(1200);
const chip = await evaluate(`(() => {
  const b = Array.from(document.querySelectorAll("button")).find(x => x.textContent.trim().startsWith("اهواز ·"));
  b?.click();
  return b ? b.textContent.trim() : null;
})()`);
await sleep(1500);
await evaluate(`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "+")?.click()`);
await sleep(1200);
const info = await evaluate(`(() => {
  const svg = document.querySelector("svg");
  const diamonds = Array.from(svg.querySelectorAll("path")).filter((p) => (p.getAttribute("fill") || "") === "#d97706");
  const labels = Array.from(svg.querySelectorAll('g[pointer-events="none"] text')).map((t) => t.textContent);
  return {
    chip: ${JSON.stringify(chip)},
    pharmacyDiamonds: diamonds.length,
    labels: labels.slice(0, 10),
    transform: document.querySelector("g#scene").getAttribute("transform"),
  };
})()`);
console.log(JSON.stringify(info, null, 2));
await shot("map-pharmacies-ahvaz");
ws.close(); child.kill(); process.exit(0);
