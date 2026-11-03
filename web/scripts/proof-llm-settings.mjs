/**
 * Proof for the advanced LLM panel on /settings.
 *
 * Read-only: it never saves a key (the owner's key lives in the live DB), so it asserts
 * what the browser actually received — provider presets, base URL, model list wiring,
 * masked key, no horizontal overflow — at desktop and phone widths, plus two screenshots.
 *
 *   node scripts/proof-llm-settings.mjs [baseUrl] [outDir]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3737";
const OUT = process.argv[3] ?? "shots";
const PORT = 9344;
const chrome = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!chrome) throw new Error("no chrome");
mkdirSync(OUT, { recursive: true });

const profile = path.join(tmpdir(), `pharm-llm-${Date.now()}`);
const child = spawn(chrome, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--window-size=1440,1100", "--hide-scrollbars", "--disable-gpu",
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (file) => {
  const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path.join(OUT, file), Buffer.from(r.data, "base64"));
};

await send("Page.enable"); await send("Runtime.enable");

const measure = `(() => {
  const panel = document.querySelector('section');
  const btns = Array.from(panel.querySelectorAll('button[aria-pressed]'));
  const inputs = Array.from(panel.querySelectorAll('input'));
  const boxes = Array.from(panel.querySelectorAll('label,input,button,div')).map((el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName, text: (el.textContent || '').trim().slice(0, 20), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  });
  return {
    title: panel.querySelector('h2')?.textContent.trim(),
    providers: btns.map((b) => ({ label: b.textContent.trim(), active: b.getAttribute('aria-pressed') === 'true' })),
    baseUrl: inputs[0]?.value,
    model: inputs[1]?.value,
    keyType: inputs[2]?.type,
    keyPlaceholder: inputs[2]?.placeholder,
    keyLine: (panel.innerText.match(/کلید ذخیره‌شده: [^\\n]+/) || [''])[0],
    maskedChip: panel.innerText.includes('از تنظیمات قدیمی OpenRouter'),
    datalist: !!document.getElementById('llm-models'),
    buttons: Array.from(panel.querySelectorAll('button')).map((b) => b.textContent.trim()).filter((t) => !btns.some((x) => x.textContent.trim() === t)),
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    panelBox: panel.getBoundingClientRect().toJSON(),
    narrowInputs: boxes.filter((b) => b.tag === 'INPUT' && b.w < 120).length,
  };
})()`;

const report = {};
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `${BASE}/settings` });
await sleep(5000);
report.desktop = await evaluate(measure);
await shot("llm-settings-1440.png");

await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 900, deviceScaleFactor: 1, mobile: true });
await send("Page.reload");
await sleep(4000);
report.phone = await evaluate(measure);
await shot("llm-settings-390.png");

const readJson = async (res) => {
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text.slice(0, 300) }; }
};
// the model catalogue of the SAVED gateway — real request, read-only
report.models = await fetch(`${BASE}/api/settings/llm/models`).then(readJson);
// a validation-only save must be refused without touching the stored values
report.badProvider = await fetch(`${BASE}/api/settings/llm`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ provider: "nope", baseUrl: "https://x/v1", model: "m" }),
}).then(readJson);

const { writeFileSync } = await import("node:fs");
writeFileSync(path.join(OUT, "llm-settings-report.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.desktop, null, 1));
console.log(JSON.stringify(report.phone, null, 1));
console.log(`shots: ${path.resolve(OUT, "llm-settings-1440.png")} / ${path.resolve(OUT, "llm-settings-390.png")}`);
child.kill();
