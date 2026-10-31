/**
 * Verify the "edited by me" badge renders.
 *
 * ملاشیه carries a manual override but its edited population (17,250) is below
 * the default 20,000 floor, so it is filtered out of the default view — the badge
 * cannot be seen without lowering the floor. Lower it, search for the place, and
 * assert the badge and the edited value both appear.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";

const PORT = 9371;
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
const child = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${tmpdir()}/badge-${Date.now()}`,
    "--window-size=1680,1250",
    "--hide-scrollbars",
    "--disable-gpu",
    "--no-first-run",
    "about:blank",
  ],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let list;
for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    if (r.ok) {
      list = await r.json();
      break;
    }
  } catch {}
  await sleep(400);
}
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const js = async (expression) =>
  (
    await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
  ).result.value;

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1680, height: 1250, deviceScaleFactor: 1, mobile: false,
});
await send("Page.navigate", { url: "http://localhost:3737/" });
await sleep(7000);

// open the model settings panel, then drop the population floor to 0
await js(`(() => { const b=[...document.querySelectorAll("button")]
  .find(x=>x.innerText.includes("تنظیم دقیق مدل")); if(b) b.click(); })()`);
await sleep(1800);
const lowered = await js(`(() => {
  const r=[...document.querySelectorAll('input[type=range]')]
    .find(i=>i.max==="200000" && i.step==="5000");
  if(!r) return "no-slider";
  const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  set.call(r,"0"); r.dispatchEvent(new Event("input",{bubbles:true}));
  r.dispatchEvent(new Event("change",{bubbles:true}));
  return r.value; })()`);
await sleep(2200);

const found = await js(`(() => {
  const inp=document.querySelector('input[placeholder^="جستجوی"]');
  const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  set.call(inp,'ملاشیه'); inp.dispatchEvent(new Event("input",{bubbles:true}));
  return "typed"; })()`);
await sleep(2200);
const res = await js(`(() => {
  const rows=[...document.querySelectorAll("tbody tr")];
  const badged=rows.filter(r=>r.innerText.includes("ویرایش من"));
  return { typed: ${JSON.stringify("typed")}, rows: rows.length,
           badges: badged.length,
           rowText: badged[0]?.innerText.replace(/\\n/g," / ").slice(0,110) ?? null };
})()`);
console.log(`floor lowered to ${lowered}; search ${found}`);
console.log(JSON.stringify(res, null, 2));
const r = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync("shots/vis-04-manual-badge.png", Buffer.from(r.data, "base64"));
console.log("shot shots/vis-04-manual-badge.png");
console.log(res.badges > 0 ? "\nBADGE OK" : "\nBADGE MISSING");
ws.close();
child.kill();
process.exit(res.badges > 0 ? 0 : 1);
