// Shows one image file: fit to the pane, or zoomed with scrollbars. Opened by the Files panel.
// image-viewer-plus: also images on another machine (fetched in 7 MiB chunks with `hc exec --on <machine> -- dd`),
// and the pixel size on macOS (sips) and Linux (file), so 100% and zoom work there too.
//
// image() only loads paths inside the app folder (absolute paths and ".." do not load), so the
// file is copied to data/image-viewer/ first and the copy is deleted when the viewer closes.
import { View, div } from "gpui-kit";
import { image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, exec, appHome, window, theme, settings } from "herdr";

const EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i;
const MAX_BYTES = 64 * 1024 * 1024;
const STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8];
const CACHE = "data/image-viewer-plus";

const kb = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const quote = s => "'" + s.replaceAll("'", "''") + "'";
const hash = s => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };

// Copies `src` to `dst` and reports "size width height" (width and height are 0 when unknown).
async function stage(src, dst, on) {
  if (on) return stageRemote(src, dst, on);
  const windows = window()?.platform === "windows";
  if (windows) {
    const script = "& { param($s,$d) $i=Get-Item -LiteralPath $s -ErrorAction Stop; if ($i.Length -gt " + MAX_BYTES + ") { 'big ' + $i.Length; return };"
      + " New-Item -ItemType Directory -Force (Split-Path $d) | Out-Null; Copy-Item -LiteralPath $s -Destination $d -Force;"
      + " $w=0; $h=0; try { Add-Type -AssemblyName System.Drawing; $m=[System.Drawing.Image]::FromFile($d); $w=$m.Width; $h=$m.Height; $m.Dispose() } catch {};"
      + " '' + $i.Length + ' ' + $w + ' ' + $h } " + quote(src) + " " + quote(dst);
    const r = await exec("powershell", ["-NoProfile", "-Command", script]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this file");
    return r.stdout.trim();
  }
  return stageUnix(src, dst);
}

// Width and height of a copied image, read where the copy is ("0 0" when unknown).
async function dimensions(path) {
  try {
    if (window()?.platform === "macos") {
      const r = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path]);
      const w = r.stdout.match(/pixelWidth:\s*(\d+)/), h = r.stdout.match(/pixelHeight:\s*(\d+)/);
      if (w && h) return `${w[1]} ${h[1]}`;
    } else if (window()?.platform === "linux") {
      const m = (await exec("file", ["-b", path])).stdout.match(/(\d+)\s*x\s*(\d+)/);
      if (m) return `${m[1]} ${m[2]}`;
    }
  } catch { /* size unknown: Fit only */ }
  return "0 0";
}

// Copies `src` from machine `on` to the local `dst`. Paths and the machine go in as arguments, never as shell code.
async function stageRemote(src, dst, on) {
  const size = await exec("sh", ["-c", 'wc -c < "$1"', "image", src], { on });
  if (size.code !== 0) throw new Error(size.stderr.trim() || "Cannot read this file");
  const n = Number(size.stdout.trim());
  if (n > MAX_BYTES) return `big ${n}`;
  // `hc exec` keeps only the first 8 MB of stdout (and still exits 0): copy in 7 MiB chunks, then check the size.
  const copy = 'mkdir -p "$(dirname "$3")" && : > "$3" || exit 1; H=$(command -v hc || echo "$HOME/.local/bin/hc"); i=0;'
    + ' while [ $((i * 7340032)) -lt "$4" ]; do "$H" exec --on "$1" --timeout 60 -- dd if="$2" bs=1048576 skip=$((i * 7)) count=7 2>/dev/null >> "$3" || { rm -f "$3"; exit 1; }; i=$((i + 1)); done;'
    + ' [ "$(wc -c < "$3")" -eq "$4" ] || { rm -f "$3"; echo "Copy came out incomplete" >&2; exit 1; }';
  const r = await exec("sh", ["-c", copy, "image", on, src, dst, String(n)], { timeout: 300000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `Cannot copy this file from ${on}`);
  return `${n} ${await dimensions(dst)}`;
}

async function stageUnix(src, dst) {
  const script = 'n=$(wc -c < "$1") || exit 1; if [ "$n" -gt ' + MAX_BYTES + ' ]; then echo "big $n"; exit 0; fi; mkdir -p "$(dirname "$2")" && cp "$1" "$2" && echo "$n 0 0"';
  const r = await exec("sh", ["-c", script, "image", src, dst]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this file");
  const out = r.stdout.trim();
  return out.startsWith("big") ? out : `${out.split(" ")[0]} ${await dimensions(dst)}`;
}

export default class ImageViewer extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.file = p.file ?? null;
    this.on = p.fileOn ?? null;
    // Optional prop `zoom`: "fit" (default) or a scale such as 1 or 0.5.
    this.zoom = typeof p.zoom === "number" && p.zoom > 0 ? p.zoom : "fit";
    // Optional prop `files`: the images to step through with ← and → (absolute paths, in order).
    this.files = Array.isArray(p.files) && p.files.includes(this.file) ? p.files : this.file ? [this.file] : [];
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => this.handle.focus());
    this.view = null;
    this.status = this.file ? "loading" : "empty";
    cx.spawn(async cx => { await this.sweep(); });
    if (this.file) this.load(cx);
  }

  name() { return this.file?.split(/[\\/]/).pop() ?? ""; }

  load(cx) {
    this.unstage();
    if (!EXT.test(this.file)) { this.status = "error"; this.error = "This file is not an image the viewer can open."; return; }
    const ext = this.file.split(".").pop().toLowerCase();
    // A newer load (← / → pressed again) wins: an older one that finishes later drops its copy.
    const seq = this.seq = (this.seq ?? 0) + 1;
    const id = `${hash(`${this.on ?? ""}:${this.file}`)}-${Date.now().toString(36)}-${seq}`;
    const rel = `${CACHE}/${id}.${ext}`;
    this.status = "loading";
    cx.spawn(async cx => {
      try {
        const out = await stage(this.file, `${appHome()}/${rel}`, this.on);
        if (seq !== this.seq) { exec("rm", ["-f", `${appHome()}/${rel}`]).catch(() => null); return; }
        const [a, w, h] = out.split(" ");
        if (a === "big") { this.status = "error"; this.error = `This image is larger than ${kb(MAX_BYTES)}.`; return; }
        this.staged = rel;
        this.bytes = Number(a);
        this.size = Number(w) > 0 && Number(h) > 0 ? { w: Number(w), h: Number(h) } : null;
        if (!this.size) this.zoom = "fit";
        this.status = "ready";
      } catch (e) { if (seq === this.seq) { this.status = "error"; this.error = String(e?.message ?? e); } }
      finally { cx.notify(); }
    });
  }

  // Deletes this copy's staged file.
  unstage() {
    if (!this.staged) return Promise.resolve();
    const path = `${appHome()}/${this.staged}`;
    this.staged = null;
    return (window()?.platform === "windows"
      ? exec("powershell", ["-NoProfile", "-Command", "Remove-Item -LiteralPath " + quote(path) + " -Force -ErrorAction SilentlyContinue"])
      : exec("rm", ["-f", path])).catch(() => null);
  }

  // Removes staged files that an earlier crash left behind (older than 1 day).
  async sweep() {
    const dir = `${appHome()}/${CACHE}`;
    try {
      if (window()?.platform === "windows") await exec("powershell", ["-NoProfile", "-Command",
        "Get-ChildItem -LiteralPath " + quote(dir) + " -File -ErrorAction SilentlyContinue | Where-Object LastWriteTime -lt (Get-Date).AddDays(-1) | Remove-Item -Force -ErrorAction SilentlyContinue"]);
      else await exec("find", [dir, "-type", "f", "-mtime", "+1", "-delete"]);
    } catch { /* nothing to sweep */ }
  }

  async close(_cx) { await this.unstage(); }

  // Shows the previous (-1) or next (+1) image of `files`, wrapping around; keeps Fit or the zoom.
  go(dir, cx) {
    const n = this.files.length;
    if (n < 2) return;
    const i = this.files.indexOf(this.file);
    this.file = this.files[((i < 0 ? 0 : i) + dir + n) % n];
    this.size = null;
    this.load(cx);
    cx.notify();
  }

  // The scale now on screen: the fit scale in Fit mode.
  scale() {
    if (this.zoom !== "fit") return this.zoom;
    if (!this.size || !this.view) return 1;
    return Math.min(1, this.view.width / this.size.w, this.view.height / this.size.h);
  }

  step(dir, cx) {
    if (!this.size) return;
    const now = this.scale();
    const next = dir > 0 ? STEPS.find(s => s > now + 1e-6) : [...STEPS].reverse().find(s => s < now - 1e-6);
    if (next) { this.zoom = next; cx.notify(); }
  }

  button(label, id, active, onClick, t, disabled = false) {
    return div().id(id).h(24).px(9).flex_none().rounded(6).flex().items_center().text_size(12)
      .text_color(disabled ? t.dim : active ? t.accent_foreground : t.foreground)
      .bg(active ? t.accent : t.raised).when(!disabled, el => el.cursor_pointer().hover(s => s.bg(active ? t.accent : t.hover)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  render(cx) {
    const t = theme(), zoomable = Boolean(this.size), many = this.files.length > 1;
    const bar = h_flex().h(42).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().flex_none().child("Image"))
      .when(many, el => el
        .child(this.button("‹", "iv-prev", false, cx => this.go(-1, cx), t))
        .child(div().flex_none().text_size(12).text_color(t.muted).child(`${this.files.indexOf(this.file) + 1} / ${this.files.length}`))
        .child(this.button("›", "iv-next", false, cx => this.go(1, cx), t)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted)
        .child(this.status === "ready" ? [this.name(), this.on, this.size ? `${this.size.w}×${this.size.h}` : null, kb(this.bytes)].filter(Boolean).join(" · ") : this.name()))
      .when(this.status === "ready", el => el
        .child(this.button("Fit", "iv-fit", this.zoom === "fit", cx => { this.zoom = "fit"; cx.notify(); }, t))
        .child(this.button("100%", "iv-100", this.zoom === 1, cx => { this.zoom = 1; cx.notify(); }, t, !zoomable))
        .child(this.button("−", "iv-out", false, cx => this.step(-1, cx), t, !zoomable))
        .child(div().w(44).flex_none().text_center().text_size(12).text_color(t.muted).child(zoomable ? `${Math.round(this.scale() * 100)}%` : ""))
        .child(this.button("+", "iv-in", false, cx => this.step(1, cx), t, !zoomable))
        .child(this.button("↻", "iv-reload", false, cx => { this.load(cx); cx.notify(); }, t)));

    let body;
    if (this.status === "ready") {
      const v = this.view;
      let pic;
      if (this.zoom !== "fit") pic = image(this.staged).flex_none().w(this.size.w * this.zoom).h(this.size.h * this.zoom);
      else if (this.size) { const s = this.scale(); pic = image(this.staged).flex_none().w(this.size.w * s).h(this.size.h * s); }
      // Size unknown (SVG, WebP, remote): a box of the visible area, the image fits inside it.
      else pic = image(this.staged).flex_none().w(v?.width ?? 400).h(v?.height ?? 300);
      body = this.zoom === "fit"
        ? div().id("iv-view").flex_1().min_h(0).p(10).flex().items_center().justify_center().overflow_hidden().child(pic)
        : div().id("iv-scroll").flex_1().min_h(0).overflow_scroll().p(10).child(pic);
    } else {
      const text = this.status === "loading" ? "Loading image…" : this.status === "empty" ? "Open an image from the Files panel." : this.error;
      body = div().flex_1().min_h(0).p(16).text_color(this.status === "error" ? t.ansi1 : t.dim).child(text);
    }

    // The visible area for the image: the pane minus the 42 px bar and the 10 px padding.
    // on_size_change reports the size with the app zoom applied (measured: 1.1 zoom gave a fit
    // 10% too wide), while w() and h() are in unzoomed px. So divide by the zoom.
    return v_flex().id("image-viewer").track_focus(this.handle).size_full().min_h(0).overflow_hidden().bg(t.canvas).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "left") { cx.stop_propagation(); this.go(-1, cx); }
        else if (e.key === "right") { cx.stop_propagation(); this.go(1, cx); }
      })
      .on_size_change((size, cx) => {
        const zoom = Number(settings()?.zoom) > 0 ? Number(settings().zoom) : 1;
        const view = { width: Math.max(1, size.width / zoom - 20), height: Math.max(1, size.height / zoom - 62) };
        if (!this.view || this.view.width !== view.width || this.view.height !== view.height) { this.view = view; cx.notify(); }
      })
      .child(bar).child(body);
  }
}
