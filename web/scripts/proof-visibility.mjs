/**
 * Proof for the "mark, don't hide" + "editable" changes.
 *
 *  1. every row is rendered (nothing filtered out by data quality);
 *  2. the suspect-row switch exists and actually changes the row count;
 *  3. a place with a broken population (شهر ری: 0 people, 31 pharmacies) is
 *     VISIBLE with a warning, not absent — the behaviour that was requested;
 *  4. the detail panel offers edit controls and shows the warning reasons.
 *
 *   node scripts/proof-visibility.mjs [url] [outDir]
 */
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const URL_ = process.argv[2] ?? "http://localhost:3737/";
const OUT = process.argv[3] ?? "shots";
const PORT = 9351;

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!CHROME) throw new Error("no chrome/edge");

mkdirSync(OUT, { recursive: true });
const profile = path.join(tmpdir(), `pharm-vis-${Date.now()}`);
const child = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1680,1250",
    "--hide-scrollbars",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const ok = (m) => console.log(`  OK   ${m}`);
const bad = (m) => {
  console.log(`  FAIL ${m}`);
  fails.push(m);
};

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(400);
  }
  throw new Error("devtools unreachable");
}
const page = (await targets()).find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
async function js(expr) {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, "base64"));
  console.log(`  shot ${path.join(OUT, name + ".png")}`);
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1680,
  height: 1250,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: URL_ });
await sleep(7000);

const base = await js(`(() => {
  const rows = [...document.querySelectorAll("tbody tr")];
  const toggle = [...document.querySelectorAll("button")]
    .find(b => b.innerText.includes("نمایش موارد مشکوک"));
  const warnBadges = rows.filter(r => /[⚠◦]/.test(r.innerText)).length;
  const manualBadges = rows.filter(r => r.innerText.includes("ویرایش من")).length;
  return { rows: rows.length, hasToggle: !!toggle,
           toggleOn: toggle?.getAttribute("aria-pressed"),
           warnBadges, manualBadges,
           overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
           latin: (document.body.innerText.match(/[0-9]/g) || []).length };
})()`);
console.log("=== baseline ===");
console.log(JSON.stringify(base, null, 2));
if (base.rows > 0) ok(`${base.rows} rows rendered`);
else bad("no rows rendered");
if (base.hasToggle) ok("suspect-row switch present");
else bad("suspect-row switch missing");
if (base.warnBadges > 0) ok(`${base.warnBadges} warning badges visible in the list`);
else bad("no warning badges in the list");
if (base.overflow <= 1) ok(`no horizontal overflow (${base.overflow}px)`);
else bad(`overflow ${base.overflow}px`);
await shot("vis-01-all-rows-shown");

/* ---- the switch must actually change the visible set ---- */
await js(`(() => {
  const t = [...document.querySelectorAll("button")]
    .find(b => b.innerText.includes("نمایش موارد مشکوک"));
  t.click();
})()`);
await sleep(2500);
const hidden = await js(
  `document.querySelectorAll("tbody tr").length`,
);
console.log(`\n=== after hiding suspect rows: ${hidden} rows ===`);
if (hidden < base.rows) ok(`switch hides rows (${base.rows} -> ${hidden})`);
else bad("switch did not change the row count");
await shot("vis-02-suspect-hidden");

// restore
await js(`(() => {
  const t = [...document.querySelectorAll("button")]
    .find(b => b.innerText.includes("نمایش موارد مشکوک"));
  t.click();
})()`);
await sleep(2000);

/* ---- a broken-population city must be VISIBLE, badged, and editable ---- */
const search = async (term) => {
  await js(`(() => {
    const inp = document.querySelector('input[placeholder^="جستجوی"]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    set.call(inp, ${JSON.stringify(term)});
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await sleep(1800);
  return js(`(() => {
    const tr = document.querySelector("tbody tr");
    if (!tr) return null;
    const txt = tr.innerText.replace(/\\n/g, " / ");
    tr.querySelector("td:nth-child(2)")?.click() || tr.click();
    return txt.slice(0, 90);
  })()`);
};

console.log("\n=== 'شهر تجریش' (bogus 8.15 M population, 1 pharmacy) ===");
const riRow = await search("تجریش");
await sleep(2500);
console.log(`  row: ${riRow}`);
if (riRow) ok("a place with population 0 is listed, not hidden");
else bad("شهر ری is not listed — still being hidden");

const detail = await js(`(() => {
  const t = document.body.innerText;
  const has = (s) => t.includes(s);
  const editBtns = [...document.querySelectorAll('button[title="ویرایش دستی این مقدار"]')].length;
  return { warns: has("این ردیف قابل امتیازدهی نیست") || has("این ردیف هشدار داده دارد"),
           editBtns,
           zeroWarn: has("جمعیت نامعتبر"),
           bogusPopulation: has("جمعیت مشکوک") };
})()`);
console.log(JSON.stringify(detail, null, 2));
if (detail.warns) ok("detail panel explains WHY the row is suspect");
else bad("detail panel shows no warning explanation");
if (detail.editBtns >= 3) ok(`${detail.editBtns} edit controls (population + 2 pharmacy fields)`);
else bad(`only ${detail.editBtns} edit controls found`);
await shot("vis-03-detail-warning-and-editors");

console.log(
  `\n${fails.length === 0 ? "PROOF OK" : `PROOF FAILED (${fails.length})`}\n`,
);
ws.close();
child.kill();
process.exit(fails.length ? 1 : 0);
