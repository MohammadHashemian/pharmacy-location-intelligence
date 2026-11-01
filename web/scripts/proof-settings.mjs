/**
 * Proof for /settings: save a key through the HTTP API, confirm the page shows a
 * masked value and that the key never reaches the browser, then clear it.
 *
 *   node scripts/proof-settings.mjs [baseUrl] [outDir]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3737";
const OUT = process.argv[3] ?? "shots";
const PORT = 9343;
const chrome = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
mkdirSync(OUT, { recursive: true });
const profile = path.join(tmpdir(), `pharm-set-${Date.now()}`);
const child = spawn(chrome, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--window-size=1440,1000", "--hide-scrollbars", "--disable-gpu",
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

// 1. save a key straight through the API (what the form does)
const saved = await fetch(`${BASE}/api/settings`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ key: "neshan_api_key", value: "service.proof-1234567890" }),
}).then((r) => r.json());
console.log("save:", JSON.stringify(saved.providers?.[0] ?? saved));

// 2. load the page and read what the browser actually received
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `${BASE}/settings` });
await sleep(6000);
const dom = await evaluate(`(() => {
  const html = document.documentElement.outerHTML;
  const chips = Array.from(document.querySelectorAll("span")).map((s) => s.textContent.trim());
  return {
    hasKeyInHtml: html.includes("service.proof-1234567890"),
    maskedShown: chips.some((t) => t.includes("••••")),
    statusChips: chips.filter((t) => t === "ذخیره‌شده" || t === "تنظیم‌نشده"),
    inputs: document.querySelectorAll('input[type="password"]').length,
    maskLine: (document.body.innerText.split(String.fromCharCode(10)).find((l) => l.includes("کلید ذخیره‌شده")) || ""),
    buttons: Array.from(document.querySelectorAll("button")).map((b) => b.textContent.trim()).slice(0, 8),
  };
})()`);
console.log("page:", JSON.stringify(dom, null, 2));
const img = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(path.join(OUT, "settings.png"), Buffer.from(img.data, "base64"));

// 3. clean up
const cleared = await fetch(`${BASE}/api/settings`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ key: "neshan_api_key", value: "" }),
}).then((r) => r.json());
console.log("cleared:", JSON.stringify(cleared.providers?.[0] ?? cleared));

ws.close(); child.kill(); process.exit(0);
