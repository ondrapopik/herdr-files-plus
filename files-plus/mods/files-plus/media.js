// files-plus media: audio plays in a bar at the bottom of the panel (ffplay without a window),
// video opens in the system player (QuickTime), else in an ffplay window.
// Herdr has no audio/video element, so playback runs as a separate process on this computer.
// Files on another machine are first copied to data/files-plus-media/ (swept after a day).
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, notify } from "herdr";

export const AUDIO = /\.(mp3|m4a|aac|wav|aiff?|flac|ogg|oga|opus|caf|alac|wma)$/i;
export const VIDEO = /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv|mpe?g|3gp|ts)$/i;
const CACHE = "data/files-plus-media";
const MAX_BYTES = 4 * 1024 * 1024 * 1024;
const CHUNK_MIB = 7; // below hc exec's 8 MB stdout cap
const FFPLAY = 'P=$(command -v ffplay || echo /opt/homebrew/bin/ffplay); [ -x "$P" ] || P=/usr/local/bin/ffplay; ';

const hash = s => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };
const clock = s => { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`; };
const mb = n => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

// A local path for `src`: itself here, or a cached copy of the file on machine `on`.
// hooks: progress(doneBytes, totalBytes) after each chunk, cancelled() checked between chunks.
async function localCopy(src, on, hooks = {}) {
  if (!on) return src;
  const size = await exec("sh", ["-c", 'wc -c < "$1"', "media", src], { on });
  if (size.code !== 0) throw new Error(size.stderr.trim() || "Cannot read this file");
  const n = Number(size.stdout.trim());
  if (n > MAX_BYTES) throw new Error(`Too large to copy here (${mb(n)})`);
  const name = src.slice(src.lastIndexOf("/") + 1);
  const dst = `${appHome()}/${CACHE}/${hash(`${on}:${src}`)}-${name}`;
  const cached = await exec("sh", ["-c", '[ -f "$1" ] && [ "$(wc -c < "$1")" -eq "$2" ]', "media", dst, String(n)]);
  if (cached.code === 0) return dst;
  hooks.progress?.(0, n);
  // `hc exec` keeps only the first 8 MB of stdout (and still exits 0), so the file comes over in chunks below that.
  const start = await exec("sh", ["-c", 'mkdir -p "$(dirname "$1")" && : > "$1.part"', "media", dst]);
  if (start.code !== 0) throw new Error(start.stderr.trim() || "Cannot write the local copy");
  const chunk = 'H=$(command -v hc || echo "$HOME/.local/bin/hc"); '
    + '"$H" exec --on "$1" --timeout 120 -- dd if="$2" bs=1048576 skip="$3" count="$4" 2>/dev/null >> "$5.part"';
  const chunks = Math.max(1, Math.ceil(n / (CHUNK_MIB * 1048576)));
  for (let i = 0; i < chunks; i++) {
    if (hooks.cancelled?.()) {
      await exec("rm", ["-f", `${dst}.part`]).catch(() => null);
      throw Object.assign(new Error("Download cancelled"), { cancelled: true });
    }
    const r = await exec("sh", ["-c", chunk, "media", on, src, String(i * CHUNK_MIB), String(CHUNK_MIB), dst], { timeout: 150000 });
    if (r.code !== 0) {
      await exec("rm", ["-f", `${dst}.part`]).catch(() => null);
      throw new Error(r.stderr.trim() || `Cannot copy this file from ${on}`);
    }
    hooks.progress?.(Math.min(n, (i + 1) * CHUNK_MIB * 1048576), n);
  }
  const done = await exec("sh", ["-c", '[ "$(wc -c < "$1.part")" -eq "$2" ] && mv "$1.part" "$1" || { rm -f "$1.part"; exit 1; }', "media", dst, String(n)]);
  if (done.code !== 0) throw new Error(`Copy from ${on} came out incomplete`);
  return dst;
}

export async function sweepCache() {
  await exec("find", [`${appHome()}/${CACHE}`, "-type", "f", "-mtime", "+1", "-delete"]).catch(() => null);
}

export const HTML = /\.(html?|xhtml)$/i;

// Opens an HTML file in the default browser. A file on another machine is copied here
// first, alone: pages that load relative CSS, scripts or images show without them.
export async function openInBrowser(src, on, hooks) {
  try {
    const path = await localCopy(src, on, hooks);
    const r = await exec("open", [path]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "No browser opened this file");
  } catch (e) { if (!e?.cancelled) notify({ title: "Cannot open in browser", body: String(e?.message ?? e), level: "error" }); }
}

export async function openVideo(src, on, hooks) {
  try {
    const path = await localCopy(src, on, hooks);
    const r = await exec("open", [path]);
    if (r.code === 0) return;
    // no app for this format (mkv, webm…): ffplay's own window (space pauses, ←/→ seek, q quits)
    const f = await exec("sh", ["-c", FFPLAY + '"$P" -autoexit -loglevel quiet -window_title "$2" -i "$1" </dev/null >/dev/null 2>&1 & echo $!', "media", path, path.split("/").pop()]);
    if (f.code !== 0 || !f.stdout.trim()) throw new Error("No player for this video (install IINA or VLC, or ffmpeg for ffplay)");
  } catch (e) { if (!e?.cancelled) notify({ title: "Cannot play video", body: String(e?.message ?? e), level: "error" }); }
}

// A file being copied here from another machine: { name, done, total, startedAt, cancelled }.
export function newDownload(name) {
  return { name, done: 0, total: 0, startedAt: Date.now(), cancelled: false };
}

// The download bar at the bottom of the Files panel: name, bytes, speed, a bar and a cancel button.
export function downloadView(dl, t, button, onCancel) {
  const frac = dl.total ? Math.min(1, dl.done / dl.total) : 0;
  const secs = (Date.now() - dl.startedAt) / 1000, rate = secs > 0.5 ? dl.done / secs : 0;
  const eta = rate && dl.total > dl.done ? ` · ${clock((dl.total - dl.done) / rate)} left` : "";
  const text = dl.total ? `${Math.round(frac * 100)} % · ${mb(dl.done)} / ${mb(dl.total)}${rate ? ` · ${mb(rate)}/s` : ""}${eta}` : "Preparing…";
  return v_flex().id("download-bar").flex_none().gap(6).px(12).py(8).border_t(1).border_color(t.border).bg(t.surface)
    .child(h_flex().gap(6).items_center()
      .child(div().flex_none().text_size(12).text_color(t.dim).child("↓"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).child(dl.name))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(text))
      .child(button("download-cancel", "✕", onCancel, t)))
    .child(div().id("download-progress").h(6).w_full().rounded(3).bg(t.border)
      .child(div().h(6).rounded(3).bg(t.accent).w(`${(frac * 100).toFixed(2)}%`)));
}

// One audio track at a time. Pause/seek restart ffplay at a position, so nothing sits stopped.
export class Player {
  constructor() { this.track = null; }

  get active() { return Boolean(this.track); }

  position() {
    const t = this.track;
    if (!t) return 0;
    const p = t.playing ? t.offset + (Date.now() - t.startedAt) / 1000 : t.offset;
    return t.duration ? Math.min(p, t.duration) : p;
  }

  play(src, on, cx) {
    this.stop();
    const track = this.track = { src, on, name: src.split("/").pop(), path: null, duration: 0, offset: 0, playing: false, pid: null, status: "Loading…", error: null };
    cx.spawn(async cx => {
      try {
        track.path = await localCopy(src, on, {
          progress: (done, total) => { track.copied = total ? done / total : 0; track.status = `Copying ${Math.round(track.copied * 100)} % of ${mb(total)}`; if (this.track === track) cx.notify(); },
          cancelled: () => this.track !== track,
        });
        track.copied = null;
        if (this.track !== track) return;
        const d = await exec("sh", ["-c", 'P=$(command -v ffprobe || echo /opt/homebrew/bin/ffprobe); "$P" -v error -show_entries format=duration -of default=nw=1:nk=1 -i "$1"', "media", track.path]).catch(() => null);
        track.duration = Number(d?.stdout.trim()) || 0;
        track.status = null;
        await this.launch(track, 0);
      } catch (e) { if (this.track === track) { track.error = String(e?.message ?? e); track.status = null; track.copied = null; } }
      finally { cx.notify(); }
    });
  }

  async launch(track, at) {
    const r = await exec("sh", ["-c", FFPLAY + '"$P" -nodisp -autoexit -loglevel quiet -ss "$2" -i "$1" </dev/null >/dev/null 2>&1 & echo $!', "media", track.path, String(at)]);
    const pid = Number(r.stdout.trim());
    if (r.code !== 0 || !pid) throw new Error("Cannot start ffplay (brew install ffmpeg)");
    if (this.track !== track) { exec("kill", [String(pid)]).catch(() => null); return; }
    Object.assign(track, { pid, offset: at, startedAt: Date.now(), playing: true, error: null });
  }

  kill(track) {
    if (track?.pid) { exec("kill", [String(track.pid)]).catch(() => null); track.pid = null; }
  }

  toggle(cx) {
    const t = this.track;
    if (!t || !t.path) return;
    if (t.playing) { t.offset = this.position(); t.playing = false; this.kill(t); cx.notify(); return; }
    const at = t.duration && t.offset >= t.duration - 0.5 ? 0 : t.offset;
    cx.spawn(async cx => { try { await this.launch(t, at); } catch (e) { t.error = String(e?.message ?? e); } finally { cx.notify(); } });
  }

  seek(seconds, cx) {
    const t = this.track;
    if (!t || !t.path) return;
    const at = Math.max(0, t.duration ? Math.min(seconds, t.duration - 0.25) : seconds);
    if (!t.playing) { t.offset = at; cx.notify(); return; }
    this.kill(t); t.playing = false; t.offset = at;
    cx.spawn(async cx => { try { await this.launch(t, at); } catch (e) { t.error = String(e?.message ?? e); } finally { cx.notify(); } });
  }

  stop() {
    this.kill(this.track);
    this.track = null;
  }

  // Called once a second: notices the end of a track.
  tick(cx) {
    const t = this.track;
    if (!t?.playing) return;
    const pid = t.pid;
    cx.spawn(async cx => {
      const alive = pid ? (await exec("kill", ["-0", String(pid)]).catch(() => ({ code: 1 }))).code === 0 : false;
      if (this.track !== t || t.pid !== pid) return;
      if (!alive) { t.playing = false; t.pid = null; t.offset = t.duration || this.position(); }
      cx.notify();
    });
  }

  // The bar at the bottom of the Files panel.
  view(t, button) {
    const tr = this.track;
    if (!tr) return null;
    const pos = this.position(), frac = tr.copied != null ? tr.copied : tr.duration ? Math.min(1, pos / tr.duration) : 0;
    return v_flex().id("media-bar").flex_none().gap(6).px(12).py(8).border_t(1).border_color(t.border).bg(t.surface)
      .child(h_flex().gap(6).items_center()
        .child(button("media-play", tr.playing ? "❚❚" : "▶", cx => this.toggle(cx), t, "primary"))
        .child(button("media-back", "−10s", cx => this.seek(pos - 10, cx), t))
        .child(button("media-fwd", "+10s", cx => this.seek(pos + 10, cx), t))
        .child(div().flex_1().min_w(0).truncate().text_size(12).child(tr.name))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(tr.status || `${clock(pos)} / ${tr.duration ? clock(tr.duration) : "–:––"}`))
        .child(button("media-stop", "✕", cx => { this.stop(); cx.notify(); }, t)))
      .child(div().id("media-progress").h(6).w_full().rounded(3).bg(t.border).cursor_pointer()
        .on_mouse_down("left", (e, cx) => {
          if (tr.duration && e.local_position && e.bounds?.width) this.seek(tr.duration * e.local_position.x / e.bounds.width, cx);
        })
        .child(div().h(6).rounded(3).bg(tr.copied != null ? t.dim : t.accent).w(`${(frac * 100).toFixed(2)}%`)))
      .when(Boolean(tr.error), el => el.child(div().text_size(11.5).text_color(t.ansi1).child(tr.error)));
  }
}
