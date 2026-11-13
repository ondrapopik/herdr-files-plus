// files-plus diagrams: renders Mermaid and BPMN blocks of a Markdown preview to PNG files.
// Run by the panel as `node diagrams.mjs <job.json>`. It needs Node.js 22+ and Google Chrome
// (or Chromium, or $CHROME), driven headless over --remote-debugging-pipe; nothing is installed.
//
// job.json: { dir, dark, items: [{ id, kind: "mermaid" | "bpmn", source }] }
// Each item becomes <dir>/<id>-<w>x<h>.png (w, h in CSS px; the PNG has 2× the pixels), reused
// while it exists. Prints one JSON line: { results: [{ id, file, w, h } | { id, error }] }.
//
// The libraries are fetched once into <dir>/lib/ from jsDelivr, pinned and checked by SHA-256:
// mermaid (MIT, mermaid.js.org) and bpmn-js (bpmn.io license, bpmn.io).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const LIBS = [
  { name: "mermaid-12.2.0.min.js", url: "https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.min.js",
    sha256: "a8a6a6f805b074a8261a2825c86f99c8054acb3b35f50bb7e24a4f9f2c3c3b9f" },
  { name: "bpmn-viewer-18.31.1.min.js", url: "https://cdn.jsdelivr.net/npm/bpmn-js@18.31.1/dist/bpmn-viewer.production.min.js",
    sha256: "3e86176f1be59ab1d7fb052d4bf458b93af598e7e80f2c7742ad37da98bf4733" },
];
const MAX_PX = 8000; // the longer side of a PNG at most, in pixels
const CHROMES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/snap/bin/chromium", "/usr/bin/microsoft-edge",
].filter(Boolean);

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));
const results = [];
const done = () => { process.stdout.write(JSON.stringify({ results }) + "\n"); process.exit(0); };
const fail = message => { for (const it of job.items) if (!results.some(r => r.id === it.id)) results.push({ id: it.id, error: message }); done(); };

// Already rendered: reuse, and touch it so the sweep keeps it.
mkdirSync(job.dir, { recursive: true });
const existing = readdirSync(job.dir);
const todo = [];
for (const it of job.items) {
  const name = existing.find(f => f.startsWith(`${it.id}-`) && f.endsWith(".png"));
  const m = name?.match(/-(\d+)x(\d+)\.png$/);
  if (m) {
    const file = join(job.dir, name), now = new Date();
    try { utimesSync(file, now, now); } catch { /* keep going */ }
    results.push({ id: it.id, file, w: Number(m[1]), h: Number(m[2]) });
  } else todo.push(it);
}
if (!todo.length) done();

async function library(lib) {
  const dir = join(job.dir, "lib"), file = join(dir, lib.name);
  if (existsSync(file)) return file;
  mkdirSync(dir, { recursive: true });
  const res = await fetch(lib.url);
  if (!res.ok) throw new Error(`Cannot download ${lib.url} (${res.status})`);
  const body = Buffer.from(await res.arrayBuffer());
  if (createHash("sha256").update(body).digest("hex") !== lib.sha256) throw new Error(`${lib.name} did not match its checksum`);
  writeFileSync(file + ".part", body);
  renameSync(file + ".part", file);
  return file;
}

// The page: draws one diagram into #out at its natural size, returns its CSS box.
const PAGE = (scripts, dark) => `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}#out{display:inline-block;padding:8px}
#out.bpmn{background:#fff;border-radius:6px;padding:12px}#out svg{display:block;max-width:none!important}</style>
${scripts.map(s => `<script src="${s}"></script>`).join("\n")}
<div id="out"></div>
<script>
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: ${dark ? '"dark"' : '"default"'},
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif" });
let n = 0;
window.draw = async (kind, source) => {
  const out = document.getElementById("out");
  out.className = kind; out.innerHTML = "";
  try {
    if (kind === "mermaid") {
      const { svg } = await mermaid.render("d" + (++n), source);
      out.innerHTML = svg;
      const el = out.querySelector("svg"), vb = el.viewBox?.baseVal;
      if (vb && vb.width && vb.height) { el.setAttribute("width", vb.width); el.setAttribute("height", vb.height); el.style.width = vb.width + "px"; }
    } else {
      const host = document.createElement("div");
      host.style.cssText = "position:absolute;left:-10000px;top:0;width:1200px;height:800px";
      document.body.appendChild(host);
      const viewer = new BpmnJS({ container: host });
      try {
        const { warnings } = await viewer.importXML(source);
        const { svg } = await viewer.saveSVG();
        out.innerHTML = svg;
        if (!out.querySelector("svg g")) throw new Error("the diagram has no shapes (no BPMNDiagram section?)");
      } finally { viewer.destroy(); host.remove(); }
    }
    await document.fonts.ready;
    const r = out.getBoundingClientRect();
    return { w: Math.ceil(r.width), h: Math.ceil(r.height) };
  } catch (e) {
    out.innerHTML = "";
    document.querySelectorAll("body > [id^=dd]").forEach(x => x.remove()); // mermaid's leftovers after an error
    return { error: String(e?.message ?? e).split("\\n").slice(0, 3).join(" ").slice(0, 300) };
  }
};
</script>`;

function chrome() {
  const bin = CHROMES.find(p => existsSync(p));
  if (!bin) throw new Error("Install Google Chrome or Chromium to draw diagrams");
  const profile = mkdtempSync(join(tmpdir(), "files-plus-chrome-"));
  const proc = spawn(bin, ["--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--no-first-run",
    "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "--hide-scrollbars", "--mute-audio", "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  let next = 0, buf = "";
  const waiting = new Map(), listeners = [];
  proc.stdio[4].on("data", chunk => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (msg.id && waiting.has(msg.id)) {
        const w = waiting.get(msg.id); waiting.delete(msg.id);
        msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
      } else for (const l of listeners) l(msg);
    }
  });
  const exited = new Promise(r => proc.on("exit", r));
  proc.on("exit", () => { for (const w of waiting.values()) w.reject(new Error("Chrome quit")); waiting.clear(); });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    proc.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  const once = (method, sessionId) => new Promise(r => listeners.push(function l(m) {
    if (m.method === method && m.sessionId === sessionId) { listeners.splice(listeners.indexOf(l), 1); r(m.params); }
  }));
  const quit = async () => {
    try { await Promise.race([send("Browser.close"), new Promise(r => setTimeout(r, 2000))]); } catch { /* gone */ }
    proc.kill(); await Promise.race([exited, new Promise(r => setTimeout(r, 2000))]);
    rmSync(profile, { recursive: true, force: true });
  };
  return { send, once, quit };
}

const timer = setTimeout(() => fail("Drawing took too long"), 110_000);
let browser = null;
try {
  const libs = [];
  for (const lib of LIBS) libs.push(pathToFileURL(await library(lib)).href);
  const page = join(job.dir, "lib", `page-${job.dark ? "dark" : "light"}.html`);
  writeFileSync(page, PAGE(libs, job.dark));

  browser = chrome();
  const { send, once } = browser;
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  await s("Page.enable");
  await s("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await s("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  const loaded = once("Page.loadEventFired", sessionId);
  await s("Page.navigate", { url: pathToFileURL(page).href });
  await loaded;

  for (const it of todo) {
    const r = (await s("Runtime.evaluate", {
      expression: `draw(${JSON.stringify(it.kind)}, ${JSON.stringify(it.source)})`, awaitPromise: true, returnByValue: true,
    })).result?.value;
    if (!r || r.error) { results.push({ id: it.id, error: r?.error ?? "Cannot draw this diagram" }); continue; }
    const scale = Math.min(2, MAX_PX / Math.max(r.w, r.h, 1));
    const shot = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: r.w, height: r.h, scale: scale / 2 } });
    const file = join(job.dir, `${it.id}-${r.w}x${r.h}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    results.push({ id: it.id, file, w: r.w, h: r.h });
  }
} catch (e) {
  clearTimeout(timer);
  await browser?.quit();
  fail(String(e?.message ?? e));
}
clearTimeout(timer);
await browser?.quit();
done();
