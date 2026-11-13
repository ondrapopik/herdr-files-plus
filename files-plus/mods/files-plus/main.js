// A lazy file browser for the focused pane's folder, with bounded read-only previews.
// files-plus: a click on an image opens it in the image-viewer-plus dialog, from this computer or another machine.
// files-plus: right-click a file or folder (or the empty area, or "+") to rename, create, or move to the Trash.
// files-plus: audio plays in a bar at the bottom (media.js); video opens in the system player.
// files-plus: copies from another machine show a progress bar at the bottom; Markdown opens as a rendered preview.
// files-plus: right-click → Download saves a file of another machine to ~/Downloads; files dropped on the panel are uploaded.
// files-plus: the Markdown preview shows its local images; a PDF shows its first page.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, openOverlay, notify, home } from "herdr";
import { Buffer } from "buffer";
import { Player, AUDIO, VIDEO, HTML, openVideo, openInBrowser, sweepCache, newDownload, downloadView, download, upload, stageImage, pdfPreview, renderDiagrams } from "./media.js";

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i;
const MARKDOWN = /\.(md|markdown|mdown|mkd)$/i;
// A diagram file opens as its picture, like Markdown in Preview (Source shows the text).
const DIAGRAM_FILE = /\.(bpmn|mmd|mermaid)$/i;
const PREVIEWABLE = /\.(md|markdown|mdown|mkd|bpmn|mmd|mermaid)$/i;
const PDF = /\.pdf$/i;
// ![alt](src "title"), also wrapped in a link [![alt](src)](href), or <img src="…">
const IMG = /\[?!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)(?:\]\([^)]*\))?|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const WEB = /^(https?:|data:|\/\/)/i;
const MAX_MD_IMAGES = 40;
const MAX_DIAGRAMS = 60;
// A dark theme draws Mermaid in its dark style (by the background's lightness, "#rrggbb").
const isDark = t => { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(t?.background ?? "");
  return !m || (0.2126 * parseInt(m[1], 16) + 0.7152 * parseInt(m[2], 16) + 0.0722 * parseInt(m[3], 16)) < 128; };

// TextView draws no images, so the Markdown is split into text, local images and diagrams, in order.
// Images from the web stay in the text as their alt text. ```mermaid and ```bpmn blocks become
// { diagram, source }; other fenced code (also ```` blocks quoting a ``` block) stays text.
function mdParts(text) {
  const parts = [];
  let buf = [], fence = null, diagram = null;
  const flush = () => { if (buf.length) { parts.push({ text: buf.join("\n") }); buf = []; } };
  for (const line of text.split("\n")) {
    if (fence) {
      const c = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) {
        fence = null;
        if (diagram) { parts.push({ diagram: diagram.kind, source: diagram.lines.join("\n") }); diagram = null; continue; }
      }
      if (diagram) diagram.lines.push(line); else buf.push(line);
      continue;
    }
    const f = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/);
    if (f) {
      fence = f[1];
      const kind = f[2].toLowerCase();
      if (kind === "mermaid" || kind === "bpmn") { flush(); diagram = { kind, lines: [] }; } else buf.push(line);
      continue;
    }
    if (!line.includes("![") && !/<img/i.test(line)) { buf.push(line); continue; }
    let last = 0, pending = "", any = false;
    for (const m of line.matchAll(IMG)) {
      const src = m[2] ?? m[3], alt = m[1] ?? m[0].match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] ?? "";
      pending += line.slice(last, m.index); last = m.index + m[0].length;
      if (WEB.test(src)) { pending += alt; continue; }
      if (pending.trim()) buf.push(pending);
      pending = ""; flush(); parts.push({ image: src, alt }); any = true;
    }
    pending += line.slice(last);
    if (!any || pending.trim()) buf.push(pending);
  }
  if (diagram) buf.push("```" + diagram.kind, ...diagram.lines); // never closed: show it as code
  flush();
  return parts;
}

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

// File operations, here or on the space's machine. Each refuses to overwrite.
const OPS = {
  rename: '[ -e "$2" ] && { echo "${2##*/} already exists" >&2; exit 1; }; mv -- "$1" "$2"',
  file: '[ -e "$1" ] && { echo "${1##*/} already exists" >&2; exit 1; }; : > "$1"',
  folder: 'mkdir -- "$1"',
  trash: 'if [ "$(uname)" = Darwin ] && [ -x /usr/bin/trash ]; then /usr/bin/trash "$1"; ' +
    'elif command -v gio >/dev/null 2>&1; then gio trash -- "$1"; ' +
    'elif command -v trash-put >/dev/null 2>&1; then trash-put -- "$1"; ' +
    'else echo "No Trash on this machine (install gio or trash-cli)" >&2; exit 1; fi',
};
// "mtime:size" of a file (GNU stat, else BSD/macOS stat)
const STAMP = 'stat -c %Y:%s -- "$1" 2>/dev/null || stat -f %m:%z "$1"';
// Writes base64 chunks ($3…) to $1 if its stamp is still $2; keeps the file's inode and permissions.
const WRITE = 'f=$1; want=$2; shift 2; ' +
  'now=$(stat -c %Y:%s -- "$f" 2>/dev/null || stat -f %m:%z "$f"); ' +
  '[ -n "$want" ] && [ "$now" != "$want" ] && { echo "The file changed on disk since it was opened" >&2; exit 3; }; ' +
  'tmp=$(mktemp) || exit 1; ' +
  'for c in "$@"; do printf %s "$c"; done | base64 -d > "$tmp" || { rm -f "$tmp"; echo "Cannot decode" >&2; exit 1; }; ' +
  'cat "$tmp" > "$f"; rc=$?; rm -f "$tmp"; exit $rc';
const parentOf = (path) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const baseOf = (path) => path.slice(path.lastIndexOf("/") + 1);

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.player = new Player();
    this.transfer = null; this.queue = [];
    this.mdImages = new Map(); this.diagrams = new Map(); this.pdf = null;
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
    cx.timer.every(1000, cx => { this.player.tick(cx); if (this.transfer) cx.notify(); }); // only does work while a track plays or a copy runs
    cx.spawn(async () => { await sweepCache(); });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, draft: this.draft() });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.menu = null; this.edit = null; this.trashing = null; this.opError = null;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx, saved.draft);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // draft: unsaved edits kept from an earlier visit ({ path, text, original, stamp })
  show(path, cx, draft) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    this.original = null; this.stamp = null; this.editable = false; this.dirty = false;
    this.saving = false; this.saveError = null; this.saveNote = null; this.leaving = null;
    this.preview = Boolean(path) && PREVIEWABLE.test(path);
    this.pdf = null; this.mdImages = new Map(); this.diagrams = new Map();
    if (!path || !cx) return;
    if (PDF.test(path)) return this.loadPdf(path, cx);
    const context = this.context, root = this.root, on = this.on, abs = `${root}/${path}`;
    cx.spawn(async cx => {
      try {
        const [text, stamp] = await Promise.all([readTextFile(abs, { on }), exec("sh", ["-c", STAMP, "files", abs], { on }).catch(() => null)]);
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        const size = stamp?.code === 0 ? Number(stamp.stdout.trim().split(":")[1]) : NaN;
        // Editable only when we hold the whole file: readTextFile stops at 1 MiB, the view at 400k chars.
        this.editable = text.length <= 400000 && Buffer.from(text, "utf8").length === size;
        this.stamp = stamp?.code === 0 ? stamp.stdout.trim() : null;
        this.original = text;
        const resume = draft?.path === path && draft.original === text ? draft.text : null;
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: !this.editable,
          value: resume ?? (text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text),
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        this.dirty = resume !== null && resume !== text;
        if (draft?.path === path && resume === null) this.saveNote = "The file changed on disk; your unsaved edits were dropped";
        const code = this.code;
        this.loadMdImages(cx);
        code.on("change", (_e, cx) => {
          if (this.code !== code) return;
          const dirty = code.value() !== this.original;
          if (dirty !== this.dirty || this.saveNote) { this.dirty = dirty; this.saveNote = null; cx.notify(); }
        });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  draft() {
    return this.dirty && this.code ? { path: this.file, text: this.code.value(), original: this.original, stamp: this.stamp } : null;
  }

  save(cx) {
    if (!this.editable || !this.code || this.saving) return;
    const text = this.code.value(), path = this.file, code = this.code, context = this.context;
    const abs = `${this.root}/${path}`, on = this.on, original = this.original, stamp = this.stamp;
    this.saving = true; this.saveError = null; this.saveNote = null; cx.notify();
    cx.spawn(async cx => {
      try {
        if (!on) {
          await writeTextFile(abs, text, original); // refuses when the file changed on disk
        } else {
          const b64 = Buffer.from(text, "utf8").toString("base64"), chunks = [];
          for (let i = 0; i < b64.length; i += 65536) chunks.push(b64.slice(i, i + 65536));
          const r = await exec("sh", ["-c", WRITE, "files", abs, stamp ?? "", ...chunks], { on });
          if (r.code !== 0) throw new Error((r.stderr || "Save failed").trim());
        }
        const after = await exec("sh", ["-c", STAMP, "files", abs], { on }).catch(() => null);
        if (this.code !== code || !this.current(context)) return;
        this.original = text; this.stamp = after?.code === 0 ? after.stdout.trim() : null;
        this.dirty = code.value() !== text; this.saveNote = "Saved";
        if (this.leaving) { const next = this.leaving; this.leaving = null; next(cx); }
      } catch (e) {
        if (this.code !== code) return;
        const msg = String(e?.message ?? e);
        this.saveError = /stale|changed|match/i.test(msg) ? "Not saved: the file changed on disk since you opened it" : `Not saved: ${msg}`;
        this.leaving = null;
      } finally { if (this.code === code) this.saving = false; cx.notify(); }
    });
  }

  // Leave the open file, asking first when it has unsaved edits.
  leave(next, cx) {
    if (!this.dirty) { next(cx); return; }
    this.leaving = next; cx.notify();
  }

  // Opens an image in the viewer dialog instead of the text preview. The other images of the same
  // folder (in list order) go along as `files`, so ← and → in the viewer step through them.
  openImage(path) {
    const cut = path.lastIndexOf("/"), prefix = cut < 0 ? "" : path.slice(0, cut);
    const files = (this.entries.get(prefix) ?? []).filter(e => !e.dir && IMAGE.test(e.name))
      .map(e => `${this.root}/${prefix ? `${prefix}/` : ""}${e.name}`);
    openOverlay({ mod: "image-viewer-plus", kind: "dialog", width: 920, height: 0.85,
      props: { file: `${this.root}/${path}`, fileOn: this.on ?? null, files } });
  }

  // ---- editing: a menu row under the right-clicked entry, an inline name field, a Trash confirmation

  openMenu(path, dir, cx) {
    this.menu = { path, dir }; this.edit = null; this.trashing = null; this.opError = null;
    cx.notify();
  }

  closeEditing(cx) {
    this.menu = null; this.edit = null; this.trashing = null;
    cx.notify();
  }

  // mode: "rename" (path is the entry), "file" / "folder" (created inside parent)
  startEdit(mode, path, dir, cx) {
    const parent = mode === "rename" ? parentOf(path) : dir ? path : parentOf(path);
    if (mode !== "rename" && parent && !this.folders.has(parent)) this.toggle(parent, cx);
    const value = mode === "rename" ? baseOf(path) : "";
    const input = InputState.new({ value });
    const dot = value.lastIndexOf(".");
    if (value) input.set_selected_range({ start: 0, end: !dir && dot > 0 ? dot : value.length });
    input.on("submit", (_e, cx) => this.commit(cx));
    this.menu = null; this.trashing = null; this.opError = null;
    this.edit = { mode, path, parent, dir, input };
    input.focus();
    cx.timer.after(50, () => { if (this.edit?.input === input) input.focus(); });
    cx.notify();
  }

  fileOp(op, args, refreshFolders, cx, after) {
    const context = this.context, on = this.on;
    cx.spawn(async cx => {
      try {
        const r = await exec("sh", ["-c", OPS[op], "files", ...args], { on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `${op} failed`).trim());
        if (!this.current(context)) return;
        after?.();
        this.edit = null; this.menu = null; this.trashing = null; this.opError = null;
        for (const folder of refreshFolders) if (!folder || this.folders.has(folder)) await this.loadFolder(folder, context);
        this.refresh(cx);
      } catch (e) {
        if (this.current(context)) this.opError = String(e.message ?? e);
      } finally { cx.notify(); }
    });
  }

  commit(cx) {
    const edit = this.edit;
    if (!edit) return;
    const name = edit.input.value().trim();
    if (!name || name === "." || name === ".." || name.includes("/")) { this.opError = "Enter a name without “/”"; cx.notify(); return; }
    const abs = (rel) => rel ? `${this.root}/${rel}` : this.root;
    const target = edit.parent ? `${edit.parent}/${name}` : name;
    if (edit.mode === "rename") {
      if (name === baseOf(edit.path)) { this.closeEditing(cx); return; }
      this.fileOp("rename", [abs(edit.path), abs(target)], [edit.parent], cx, () => {
        // keep renamed folders (and what's open inside them) expanded
        for (const folder of [...this.folders]) if (folder === edit.path || folder.startsWith(edit.path + "/")) {
          this.folders.delete(folder); this.entries.delete(folder);
          this.folders.add(target + folder.slice(edit.path.length));
        }
        if (this.file === edit.path) this.file = target;
      });
    } else {
      this.fileOp(edit.mode, [abs(target)], [edit.parent], cx);
    }
  }

  trash(path, cx) {
    this.fileOp("trash", [`${this.root}/${path}`], [parentOf(path)], cx, () => {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder); this.entries.delete(folder);
      }
    });
  }

  button(id, label, onClick, t, tone) {
    return h_flex().id(id).h(22).px(8).items_center().rounded(6).flex_none().cursor_pointer().text_size(12)
      .border_1().border_color(tone === "danger" ? t.ansi1 : tone === "primary" ? t.solid : t.border)
      .text_color(tone === "danger" ? t.ansi1 : tone === "primary" ? t.solid_foreground : t.foreground).bg(tone === "primary" ? t.solid : t.raised)
      .hover(s => s.bg(t.hover)).on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); }).child(label);
  }

  menuRow(path, dir, depth, t) {
    const b = (key, label, fn, tone) => this.button(`fm-${key}-${path}`, label, fn, t, tone);
    return h_flex().id(`fm-${path}`).flex_none().flex_wrap().gap(5).py(4).pl(8 + depth * 18 + 19).pr(8)
      .when(!dir && Boolean(this.on), el => el.child(b("download", "Download", cx => { this.menu = null; this.downloadFile(path, cx); })))
      .when(!dir && HTML.test(path), el => el.child(b("edit", "Edit", cx => { this.menu = null; this.show(path, cx); cx.notify(); })))
      .when(path !== "", el => el.child(b("rename", "Rename", cx => this.startEdit("rename", path, dir, cx))))
      .child(b("file", "New file", cx => this.startEdit("file", path, dir, cx)))
      .child(b("folder", "New folder", cx => this.startEdit("folder", path, dir, cx)))
      .when(path !== "", el => el.child(b("trash", "Move to Trash", cx => { this.menu = null; this.trashing = path; cx.notify(); }, "danger")))
      .child(b("close", "✕", cx => this.closeEditing(cx)));
  }

  trashRow(path, depth, t) {
    return h_flex().id(`ft-${path}`).flex_none().gap(6).py(4).pl(8 + depth * 18 + 19).pr(8).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(`Move “${baseOf(path)}” to the Trash?`))
      .child(this.button(`ft-yes-${path}`, "Move", cx => this.trash(path, cx), t, "danger"))
      .child(this.button(`ft-no-${path}`, "Cancel", cx => this.closeEditing(cx), t));
  }

  // the name field, replacing a row (rename) or as a new row (create)
  inputRow(id, depth, icon, t) {
    return h_flex().id(id).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center()
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.closeEditing(cx); } })
      .child(div().w(12).flex_none())
      .child(svg(`mods/files-plus/${icon}.svg`).size(14).flex_none().text_color(t.muted))
      .child(Input.new(this.edit.input).flex_1().min_w(0).h(24).px(6).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(13).text_color(t.foreground));
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    const edit = this.edit;
    if (edit && edit.mode !== "rename" && edit.parent === prefix)
      out.push(this.inputRow(`fe-new-${prefix}`, depth, edit.mode === "folder" ? "folder" : "file", t));
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      if (edit?.mode === "rename" && edit.path === path) {
        out.push(this.inputRow(`fe-rename-${path}`, depth, entry.dir ? "folder" : "file", t));
        if (entry.dir && open) this.rows(path, depth + 1, out, t);
        continue;
      }
      const picked = this.menu?.path === path || this.trashing === path;
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .when(picked, el => el.bg(t.selected))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(path, entry.dir, cx); })
        .on_click((_e, cx) => this.open(path, entry, cx))
        .on_drop((e, cx) => { cx.stop_propagation(); this.drop(e.paths, entry.dir ? path : prefix, cx); })
        .child(entry.dir ? svg(`mods/files-plus/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files-plus/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (this.menu?.path === path) out.push(this.menuRow(path, entry.dir, depth, t));
      if (this.trashing === path) out.push(this.trashRow(path, depth, t));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    // The theme turned light or dark: draw the diagrams again in its style.
    if (this.code && this.preview && PREVIEWABLE.test(this.file ?? "") && this.diagramsDark !== isDark(t)) { this.diagramsDark = isDark(t); this.loadDiagrams(cx); }
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted)
          .on_click((_e, cx) => this.leave(cx => { this.show(null); cx.notify(); }, cx)).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(this.file) && this.dirty, el => el.child(div().flex_none().text_color(t.blocked).child("●")))
        .when(Boolean(this.file) && Boolean(this.code) && PREVIEWABLE.test(this.file ?? ""), el => el.child(this.button("files-md-mode", this.preview ? "Source" : "Preview", cx => { this.preview = !this.preview; this.loadMdImages(cx); cx.notify(); }, t)))
        .when(this.pdf?.status === "ready", el => el.child(this.button("files-pdf-open", "Open", () => { exec(window()?.platform === "macos" ? "open" : "xdg-open", [this.pdf.local]).catch(() => null); }, t)))
        .when(Boolean(this.file) && this.editable, el => el.child(this.button("files-save", this.saving ? "Saving…" : "Save", cx => this.save(cx), t, this.dirty ? "primary" : undefined)))
        .when(Boolean(this.file) && Boolean(this.code) && !this.editable, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child("read-only")))
        .when(!this.file && Boolean(this.root), el => el.child(div().id("files-new").w(20).flex_none().text_center().cursor_pointer().text_color(t.muted).hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => this.menu?.path === "" ? this.closeEditing(cx) : this.openMenu("", true, cx)).child("+"))))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        .on_drop((e, cx) => this.drop(e.paths, "", cx))
        .on_mouse_down("right", (_e, cx) => this.openMenu("", true, cx))
        .when(this.menu?.path === "", el => el.child(this.menuRow("", true, -1, t)))
        .when(Boolean(this.opError), el => el.child(h_flex().id("files-op-error").flex_none().gap(6).p(8).items_start().text_size(12).text_color(t.ansi1)
          .child(div().flex_1().min_w(0).child(this.opError))
          .child(div().id("files-op-error-x").cursor_pointer().text_color(t.dim).on_click((_e, cx) => { this.opError = null; cx.notify(); }).child("✕"))))
        .children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file) && Boolean(this.leaving), el => el.child(h_flex().id("files-leave").flex_none().gap(6).px(14).py(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child("Unsaved changes"))
        .child(this.button("files-leave-save", "Save", cx => this.save(cx), t, "primary"))
        .child(this.button("files-leave-discard", "Discard", cx => { const next = this.leaving; this.leaving = null; this.dirty = false; next(cx); }, t, "danger"))
        .child(this.button("files-leave-cancel", "Cancel", cx => { this.leaving = null; cx.notify(); }, t))))
      .when(Boolean(this.file) && Boolean(this.saveError || this.saveNote), el => el.child(h_flex().id("files-save-status").flex_none().gap(6).px(14).py(4).items_center().text_size(12)
        .text_color(this.saveError ? t.ansi1 : t.dim)
        .child(div().flex_1().min_w(0).child(this.saveError || this.saveNote))
        .when(Boolean(this.saveError), el => el.child(this.button("files-reload", "Reload from disk", cx => { this.dirty = false; this.show(this.file, cx); }, t)))))
      .when(Boolean(this.file), el => el.child(this.pdf
        ? v_flex().id("files-pdf").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(8).on_size_change((size, cx) => this.measure(size, cx))
          .child(this.pdf.status === "ready" ? this.picture(this.pdf, "files-pdf-page", t) : div().text_size(12).text_color(this.pdf.status === "error" ? t.ansi1 : t.dim).child(this.pdf.note))
          .when(this.pdf.status === "ready", el => el.child(div().text_size(11).text_color(t.dim)
            .child(`Page 1${this.pdf.pages ? ` of ${this.pdf.pages}` : ""} · Open shows ${this.pdf.pages === 1 ? "it" : "every page"} in your PDF app`)))
        : this.code && this.preview
        ? v_flex().id("files-markdown").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).text_size(13).on_size_change((size, cx) => this.measure(size, cx))
          .children(this.previewParts().map((part, i) => part.text !== undefined
            ? TextView.markdown(`files-md-${this.file}-${i}`, part.text).selectable(true).on_link_click((url, cx) => this.followLink(url, cx))
            : part.diagram ? this.mdDiagram(part, i, t) : this.mdImage(part, i, t)))
        : this.code
        ? v_flex().id("files-editor").flex_1().min_h(0)
          .on_key_down((e, cx) => {
            if (e.key === "s" && (e.modifiers?.platform || e.modifiers?.control) && !e.modifiers?.shift && !e.modifiers?.alt) { cx.stop_propagation(); this.save(cx); }
          })
          .child(Editor.new(this.code).flex_1().min_h(0))
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")))
      .when(Boolean(this.transfer), el => el.child(downloadView(this.transfer, t, (...a) => this.button(...a), cx => { this.transfer.cancelled = true; cx.notify(); }, this.queue.length)))
      .when(this.player.active, el => el.child(this.player.view(t, (...a) => this.button(...a))));
  }

  // Opens a file by kind: folder, image, audio (bar below), video (system player), else text.
  open(path, entry, cx) {
    if (entry.dir) return this.toggle(path, cx);
    if (IMAGE.test(entry.name)) return this.openImage(path);
    if (AUDIO.test(entry.name)) { this.player.play(`${this.root}/${path}`, this.on ?? null, cx); cx.notify(); return; }
    if (VIDEO.test(entry.name)) return this.fetch(openVideo, path, cx);
    if (HTML.test(entry.name)) return this.fetch(openInBrowser, path, cx); // Edit: right-click menu
    this.show(path, cx);
  }

  // Runs openVideo / openInBrowser; a file on another machine is copied first, shown in the transfer bar.
  // Opening another one cancels the previous open (downloads and uploads stay queued).
  fetch(opener, path, cx) {
    const src = `${this.root}/${path}`, on = this.on ?? null;
    if (!on) { opener(src, null); return; }
    for (const job of [this.transfer, ...this.queue]) if (job?.kind === "open") job.cancelled = true;
    this.queue = this.queue.filter(job => !job.cancelled);
    this.enqueue({ ...newDownload(baseOf(path)), kind: "open", run: hooks => opener(src, on, hooks) }, cx);
  }

  // Saves a file of the space's machine to ~/Downloads.
  downloadFile(path, cx) {
    const src = `${this.root}/${path}`, on = this.on;
    this.enqueue({ ...newDownload(baseOf(path)), kind: "download", run: async hooks => {
      const dst = await download(src, on, hooks);
      const shown = dst.startsWith(home() + "/") ? `~${dst.slice(home().length)}` : dst;
      notify({ title: "Downloaded", body: shown, timeout: 5000 });
    } }, cx);
  }

  // Files dropped from Finder: uploaded into `folder` (relative to the root, "" for the root), one after another.
  drop(paths, folder, cx) {
    const key = `${folder}\n${paths.join("\n")}`;
    if (this.lastDrop?.key === key && Date.now() - this.lastDrop.at < 1000) return; // a row and the tree both got it
    this.lastDrop = { key, at: Date.now() };
    const root = this.root, on = this.on ?? null, context = this.context;
    if (!root || !paths?.length) return;
    if (folder && !this.folders.has(folder)) this.toggle(folder, cx);
    for (const src of paths) {
      const name = baseOf(src.replace(/\/+$/, ""));
      const dst = `${root}/${folder ? `${folder}/` : ""}${name}`;
      this.enqueue({ ...newDownload(name, true), kind: "upload", run: async hooks => {
        await upload(src, on, dst, hooks);
        if (this.current(context)) { await this.loadFolder(folder, context).catch(() => null); }
      } }, cx);
    }
  }

  // Transfers run one at a time; the bar shows the running one and how many wait.
  enqueue(job, cx) {
    this.queue.push(job);
    if (!this.transfer) this.next(cx); else cx.notify();
  }

  next(cx) {
    const job = this.transfer = this.queue.shift() ?? null;
    cx.notify();
    if (!job) return;
    job.startedAt = Date.now();
    cx.spawn(async cx => {
      try {
        await job.run({
          progress: (done, total) => { job.done = done; job.total = total; if (this.transfer === job) cx.notify(); },
          cancelled: () => job.cancelled,
        });
      } catch (e) {
        if (!e?.cancelled) notify({ title: job.up ? "Upload failed" : "Download failed", body: `${job.name}: ${String(e?.message ?? e)}`, level: "error" });
      } finally { if (this.transfer === job) this.next(cx); }
    });
  }

  // The width for pictures in the preview: the pane in unzoomed px, minus the padding.
  measure(size, cx) {
    const zoom = Number(settings()?.zoom) > 0 ? Number(settings().zoom) : 1;
    const width = Math.max(80, Math.floor(size.width / zoom) - 32);
    if (width !== this.viewWidth) { this.viewWidth = width; cx.notify(); }
  }

  // A staged picture ({ rel, w, h }) at its size, never wider than the pane; unknown size: a box it fits in.
  picture(p, id, t) {
    const max = this.viewWidth ?? 360, s = p.w && p.h ? Math.min(1, max / p.w) : 0;
    return div().id(id).flex_none().child(s ? image(p.rel).w(p.w * s).h(p.h * s) : image(p.rel).w(Math.min(max, 480)).h(240));
  }

  // Where a Markdown image points: absolute, here or on the space's machine.
  mdImagePath(src) {
    let p = src;
    try { p = decodeURIComponent(src); } catch { /* keep it */ }
    p = p.replace(/^file:\/\//, "").split(/[?#]/)[0];
    const parts = [];
    for (const x of (p.startsWith("/") ? p : `${this.root}/${parentOf(this.file ?? "")}/${p}`).split("/")) {
      if (x === "..") parts.pop(); else if (x && x !== ".") parts.push(x);
    }
    return "/" + parts.join("/");
  }

  // Copies the preview's images into the app folder (image() loads only there), one after another.
  loadMdImages(cx) {
    if (!this.code || !this.preview || !PREVIEWABLE.test(this.file ?? "")) return;
    this.loadDiagrams(cx);
    const on = this.on ?? null, images = this.mdImages;
    const todo = [...new Set(this.previewParts().filter(p => p.image).map(p => this.mdImagePath(p.image)))]
      .slice(0, MAX_MD_IMAGES).filter(abs => !images.has(abs));
    if (!todo.length) return;
    for (const abs of todo) images.set(abs, { status: "loading" });
    cx.spawn(async cx => {
      for (const abs of todo) {
        if (this.mdImages !== images) return;
        const entry = images.get(abs);
        try {
          if (!IMAGE.test(abs)) throw new Error("not an image");
          Object.assign(entry, await stageImage(abs, on), { status: "ready" });
        } catch (e) { Object.assign(entry, { status: "error", error: String(e?.message ?? e) }); }
        cx.notify();
      }
    });
  }

  // What Preview shows: a diagram file is one diagram, Markdown is split by mdParts.
  previewParts() {
    const text = this.code?.value() ?? "", m = (this.file ?? "").match(DIAGRAM_FILE);
    if (!m) return mdParts(text);
    return text.trim() ? [{ diagram: m[1].toLowerCase() === "bpmn" ? "bpmn" : "mermaid", source: text }] : [{ text: "*Empty diagram file*" }];
  }

  // Draws the preview's Mermaid and BPMN blocks, all in one run; again when the theme turns light/dark.
  loadDiagrams(cx) {
    const dark = isDark(theme()), diagrams = this.diagrams;
    const todo = [...new Map(this.previewParts().filter(p => p.diagram).slice(0, MAX_DIAGRAMS)
      .map(p => [`${dark}:${p.diagram}:${p.source}`, { kind: p.diagram, source: p.source }])).entries()]
      .filter(([k]) => !diagrams.has(k));
    if (!todo.length) return;
    for (const [k] of todo) diagrams.set(k, { status: "loading" });
    cx.spawn(async cx => {
      let out;
      try { out = await renderDiagrams(todo.map(([, d]) => d), dark); }
      catch (e) { out = todo.map(() => ({ error: String(e?.message ?? e) })); }
      todo.forEach(([k], i) => Object.assign(diagrams.get(k), out[i], { status: out[i].error ? "error" : "ready" }));
      if (this.diagrams === diagrams) cx.notify();
    });
  }

  // A diagram: the picture (a click opens it in the viewer to zoom), or its state; an error shows the source too.
  mdDiagram(part, i, t) {
    const label = part.diagram === "bpmn" ? "BPMN" : "Mermaid";
    const e = this.diagrams.get(`${isDark(t)}:${part.diagram}:${part.source}`);
    if (e?.status === "ready") return div().id(`files-md-dia-${i}`).flex_none().py(6).cursor_pointer()
      .on_click(() => openOverlay({ mod: "image-viewer-plus", kind: "dialog", width: 920, height: 0.85, props: { file: e.file, fileOn: null, files: [e.file] } }))
      .child(this.picture(e, `files-md-dia-pic-${i}`, t));
    return v_flex().id(`files-md-dia-${i}`).flex_none().py(4).gap(4)
      .child(div().text_size(12).text_color(e?.status === "error" ? t.ansi1 : t.dim)
        .child(e?.status === "error" ? `◇ ${label} diagram: ${e.error}` : `◇ Drawing the ${label} diagram…`))
      .when(e?.status === "error" && !DIAGRAM_FILE.test(this.file ?? ""), el => el.child(TextView.markdown(`files-md-dia-src-${this.file}-${i}`, "```" + (part.diagram === "bpmn" ? "xml" : "") + "\n" + part.source + "\n```").selectable(true)));
  }

  mdImage(part, i, t) {
    const abs = this.mdImagePath(part.image), e = this.mdImages.get(abs), label = part.alt || baseOf(abs);
    if (e?.status === "ready") return div().id(`files-md-img-${i}`).flex_none().py(6).cursor_pointer()
      .on_click(() => { if (abs.startsWith(`${this.root}/`)) this.openImage(abs.slice(this.root.length + 1)); })
      .child(this.picture(e, `files-md-pic-${i}`, t));
    return div().id(`files-md-img-${i}`).flex_none().py(4).text_size(12).text_color(e?.status === "error" ? t.ansi1 : t.dim)
      .child(e?.status === "error" ? `🖼 ${label}: ${e.error}` : !e ? `🖼 ${label}` : `🖼 ${label} …`);
  }

  // A PDF: its first page rendered here (copied first from another machine), Open for the rest.
  loadPdf(path, cx) {
    const src = `${this.root}/${path}`, on = this.on ?? null;
    const pdf = this.pdf = { status: "loading", note: "Rendering the first page…" };
    cx.spawn(async cx => {
      try {
        const r = await pdfPreview(src, on, {
          progress: (done, total) => { pdf.note = `Copying from ${on}… ${Math.round(done / Math.max(1, total) * 100)} %`; if (this.pdf === pdf) cx.notify(); },
          cancelled: () => this.pdf !== pdf,
        });
        Object.assign(pdf, r, { status: "ready" });
      } catch (e) { if (!e?.cancelled) Object.assign(pdf, { status: "error", note: `Cannot preview this PDF: ${String(e?.message ?? e)}` }); }
      finally { if (this.pdf === pdf) cx.notify(); }
    });
  }

  // A link in the Markdown preview: web links open in the browser, relative ones open that file here.
  followLink(url, cx) {
    if (/^(https?|mailto):/i.test(url)) { exec("open", [url]).catch(() => null); return; }
    let target = decodeURIComponent(url.replace(/^file:\/\//, "").split("#")[0]);
    if (!target) return;
    if (target.startsWith(this.root + "/")) target = target.slice(this.root.length + 1);
    else if (target.startsWith("/")) return;
    else target = [parentOf(this.file ?? ""), target].filter(Boolean).join("/");
    const parts = [];
    for (const part of target.split("/")) { if (part === "..") parts.pop(); else if (part && part !== ".") parts.push(part); }
    const rel = parts.join("/");
    if (!rel) return;
    if (IMAGE.test(rel)) return this.openImage(rel);
    this.leave(cx => this.show(rel, cx), cx);
  }

  async close(_cx) {
    for (const job of [this.transfer, ...this.queue]) if (job) job.cancelled = true;
    const pid = this.player?.track?.pid;
    if (pid) await exec("kill", [String(pid)]).catch(() => null);
  }
}
