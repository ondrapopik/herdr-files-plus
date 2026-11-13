# Files+

The Files panel on the right of the window, extended so that every kind of file does something
useful on a click, here or on another machine: images open in a viewer dialog, audio plays in a
bar at the bottom of the panel, videos and HTML open in their apps after a download with a progress
bar, Markdown shows rendered, and other text files open in an editor you can save from. A
right-click downloads, renames, creates and moves to the Trash; files dropped from Finder upload.

![Files+](preview.png)

## What you see

Two mods: `files-plus` (the panel) and `image-viewer-plus` (a dialog it opens). Both use the
theme's colors only (`t.background`, `t.border`, `t.surface`, `t.accent`, `t.dim`, …) and the
UI font at 13px.

**The panel** (`files-plus`), a rounded (10px) column with a 1px `t.border` border:

1. **Header**, 42px, bottom border. In the tree: `Files` (semibold), the folder's name right
   aligned in `t.dim` 12px, and `+` (opens the menu for the root). With a file open: `←` first,
   then `Files`, the file's path, a `●` in `t.blocked` when there are unsaved edits, and buttons:
   `Source` / `Preview` (Markdown only), `Save` (primary while dirty, `Saving…` while saving), or
   `read-only` in 11px `t.dim` when the file can't be saved.
2. **Body**, one of:
   - **The tree**: rows 28px, 8px left padding plus 18px per level, a 12px chevron (folders), a
     14px folder or file icon in `t.muted`, the name (truncated), and a git mark on the right
     (`A` in `t.ansi2`, `D` / `U` in `t.ansi1`, `M` in `t.blocked`). The right-clicked row is
     `t.selected`. Under it, a **menu row** of 22px buttons: `Download` (files, another machine
     only), `Edit` (HTML only), `Rename`,
     `New file`, `New folder`, `Move to Trash` (danger, `t.ansi1`), `✕`. A Trash confirmation row
     reads `Move "name" to the Trash?` with `Move` and `Cancel`. Rename and create put an inline
     input (24px, `t.accent` border) in place of / under the row. At the end, `Loading files…`,
     `No files` or the error, and `File list limited to 500 entries per folder and 5,000 total`.
   - **A text file**: a code editor (12px, the terminal font, syntax colors from the ANSI palette),
     with an `Unsaved changes` row (`Save` / `Discard` / `Cancel`) when leaving with edits, and a
     status row (`Saved`, or the error in `t.ansi1` with `Reload from disk`).
   - **A Markdown file**: the rendered document, scrollable, 16px side and 12px vertical padding,
     selectable text. Local images sit between the text blocks at their size, never wider than the
     pane (unknown size: a 480×240 box they fit in); while copying `🖼 alt …` in `t.dim`, on error
     `🖼 alt: not found` in `t.ansi1`. Mermaid and BPMN blocks show as pictures the same way
     (a click opens one in the image dialog to zoom); while drawing `◇ Drawing the Mermaid diagram…`
     in `t.dim`, on error `◇ Mermaid diagram: <message>` in `t.ansi1` with the block's source under it.
   - **A PDF**: its first page as an image at the pane's width, under it `Page 1 of 3 · Open shows
     every page in your PDF app` in 11px `t.dim`; `Open` in the header. While it loads:
     `Copying from <machine>… 45 %` or `Rendering the first page…`.
3. **Transfer bar** (while a file is copied between machines), `t.surface` with a top border:
   `↓` (download, open) or `↑` (upload), the file name, `+2 waiting` when more are queued,
   `42 % · 120 MB / 286 MB · 38 MB/s · 0:04 left` in 11px `t.dim` (or `Preparing…`,
   `Cancelling…`), a `✕` button, and under it a 6px `t.border` track with a `t.accent` fill.
4. **Audio bar** (while a track is loaded), same style: `▶` / `❚❚` (primary), `−10s`, `+10s`, the
   track name, `1:23 / 4:56` (or `Copying 45 % of 12 MB`), `✕`, and a 6px progress bar: `t.dim`
   fill while copying, `t.accent` while playing.

**The image dialog** (`image-viewer-plus`, a dialog 920px wide, 85 % high, `t.canvas`): a 42px bar
with `Image`, `‹ 3 / 12 ›` when there are several, `name · machine · 1920×1080 · 2.4 MB`, and
buttons `Fit`, `100%`, `−`, the zoom in %, `+`, `↻` (24px, `t.accent` when active). Below it the
image fitted (never above 100 %) or zoomed with scrollbars, or `Loading image…` / the error in
`t.ansi1`.

## How it behaves

The panel follows the focused pane's folder (`pane.cwd`, else the focused terminal's `cwd`, else
the space's folder). A terminal of another machine, or a space on another machine, makes every
action run there (`on`). The tree reloads every 10 s and on folder changes (local only), and
remembers open folders and the open file (with unsaved edits) per location.

A click on:
- **a folder** opens or closes it (lazy: its entries load on first open).
- **an image** (`png jpg gif webp bmp svg ico tif`) opens the image dialog with the folder's images
  in list order as `files`; ← / → (keys or `‹ ›`) step through them, wrapping.
- **audio** (`mp3 m4a aac wav aif flac ogg oga opus caf alac wma`) loads it in the audio bar and
  plays it. Pause, seek (±10 s or a click on the bar) restart `ffplay` at the position. Once a
  second the panel checks whether the player is still running and notices the end.
- **video** (`mp4 m4v mov mkv webm avi wmv flv mpg mpeg 3gp ts`) opens it with `open`, or in an
  `ffplay` window when that fails.
- **HTML** opens it in the default browser (copied alone: relative CSS and images don't come).
- **Markdown** (`md markdown mdown mkd`) opens it in Preview. `Source` shows the editor; edits
  show in the preview before saving. Links: `http(s):` and `mailto:` open with `open`; relative
  links resolve from the file's folder and open that file in the panel (images in the dialog).
  Images: `![alt](path "title")`, `[![alt](path)](link)` and `<img src="path">` with a local path
  (relative to the file, or absolute) are copied into the app folder one after another (up to 40
  per file, 25 MB each) and drawn in place; a click opens one in the image dialog. Web images
  (`http(s):`, `data:`) become their alt text. Lines inside ``` / ~~~ fences are left alone (a
  fence closes only on the same character, at least as long, so ```` blocks can quote ``` ones).
  Diagrams: fenced ```` ```mermaid ```` and ```` ```bpmn ```` blocks (BPMN XML with its BPMNDiagram
  section) are drawn to PNG by `diagrams.mjs` (`node`, up to 60 per file, all in one run): it starts
  Google Chrome / Chromium headless over `--remote-debugging-pipe`, loads mermaid 12.2.0 and the
  bpmn-js 18.31.1 viewer (fetched once from jsDelivr into `data/files-plus-diagrams/lib/`, checked
  by SHA-256), draws each block at its natural size (BPMN on a white card, Mermaid in the `dark` or
  `default` theme by the background's lightness) and screenshots it at 2×. PNGs are named by a hash
  of kind, theme and source, so an unchanged diagram is not drawn again; a theme switch light ↔ dark
  draws them anew; unused ones are swept after 14 days. A `.bpmn`, `.mmd` or `.mermaid` file
  opens in Preview as its one diagram (`previewParts`), with `Source` / `Preview` like Markdown;
  on error only the message shows (`Source` has the text).
- **⤢** (in the header while a Markdown, diagram or PDF file is shown) opens the viewer window:
  `openOverlay({ mod: "files-plus", kind: "dialog", width: 0.92, height: 0.92, props: { view: true,
  root, file, on } })`. With `props().view` the mod skips the tree, timers and location tracking and
  shows that one file read-only: header with ← (back through links followed in it), the file name,
  `Source` / `Preview`, `Open` for a PDF, ✕ (`closeOverlay(props().overlay)`); Markdown in a
  centered column at most 900 px wide, 15 px text; pictures fit that column.
- **Several entries**: ⌘ / Ctrl-click toggles one into `selected` (a set of relative paths, kept
  per tab in `saved`), Shift-click adds the range between the last click and this one in the shown
  order; a plain click clears it and opens as before. Selected rows use `t.selected`. A bar above the
  tree (`t.raised`, 12px): `N selected`, `Copy`, `Move`, `Download` (another machine, files only,
  queued one by one), `Copy path` (absolute paths, one per line, `cx.write_to_clipboard`), `Move to
  Trash` (asks `Move N items to the Trash?`), `✕`. Entries inside a selected folder go with it.
  Copy / Move keep `{ mode, on, paths }` (also across tabs); the bar then shows `N to move`, `Paste
  into <root>` and `✕`, and a folder's right-click menu gets `Paste here`. Paste runs one `sh`
  script on the machine: it checks every name first (`already exists there`), refuses a folder into
  itself, `cp -R` or `mv`; a move into the folder the entries are already in says so. Pasting on
  another machine than the entries' is refused. Entries that vanish leave the selection.
- **a PDF** renders its first page here: copied first from another machine (with progress), then
  `qlmanage -t -s 1600` on macOS or `pdftoppm -png -r 110 -f 1 -l 1` elsewhere. The page count is
  a best guess (`/Type /Page` objects); `Open` hands the local copy to `open` / `xdg-open`.
- **anything else** opens it as text. A file with a NUL byte says `Binary file · no text preview`.

Files on another machine are copied to `data/files-plus-media/<hash>-<name>` before playing or
opening (up to 4 GB; images up to 64 MB to `data/image-viewer-plus/`). A copy with the right size
is reused. During the copy the download bar (or the audio bar) shows progress; `✕` cancels after
the chunk in flight and deletes the partial file. Opening another video or HTML file cancels the
running open (not downloads or uploads). Copies older than a day are deleted when the panel
starts.

Transfers (opening a remote video or HTML file, Download, uploads) run one at a time from a queue.
`✕` cancels the running one after its chunk in flight, deletes its `.part`, and the next starts.
A failure shows an error notification `Download failed` / `Upload failed` with the reason.

**Download** (right-click a file when the space or terminal is on another machine) saves it to
`~/Downloads/<name>`, or `<name> (1).<ext>`, `(2)`… when taken, then notifies `Downloaded` with
the path (`~/Downloads/…`).

**Drop** files from Finder: on the empty tree they go into the root, on a folder row into that
folder (it opens), on a file row beside it. Here they are copied with `cp -R` (folders too); on
another machine each file goes over in 7 MiB chunks (6 at once) into `<name>.part` and is renamed when the
size matches; folders are refused (`Folders can't be uploaded to another machine yet`). An
existing name is never overwritten (`<name> already exists`). The folder reloads afterwards.

Editing: the editor is writable only when the whole file was read (≤ 1 MiB, ≤ 400,000 chars).
⌘S / Ctrl+S or `Save` writes it. Here through `writeTextFile` (refuses a stale file); on another
machine as base64 chunks through `sh`, refusing when the file's `mtime:size` changed. Leaving a
dirty file (`←`, another location) asks first.

Right-click a row, the empty tree, or `+`: Rename (selects the name without the extension), New
file, New folder (inside a folder, or beside a file), Move to Trash (`/usr/bin/trash` on macOS,
`gio trash` or `trash-put` on Linux). None of them overwrite; Escape closes the input.

## Built from

- `mods/files-plus/main.js`: the panel, a `View` class `Files`. Clone of the shipped `files` mod
  (0.1.13). Uses `spaces()`, `panes()`, `focused()` for the location; `exec(…, { on })` for listing
  (a `sh` loop printing `d|f\0name\0`, max 501), git status (`--no-optional-locks`,
  `core.fsmonitor=false`), `stat`, file operations; `readTextFile`, `writeTextFile`,
  `watchFolder`, `theme()`, `settings()`, `window()`, `openOverlay({ mod: "image-viewer-plus",
  kind: "dialog", width: 920, height: 0.85, props: { file, fileOn, files } })`. From `gpui-base`:
  `Editor`, `EditorState`, `InputState`, `Input`, `TextView.markdown(id, text)`.
- `mods/files-plus/media.js`: `pull` (the chunked copy here), `localCopy` (cached copies for
  playing), `download` (to `~/Downloads`), `upload` (chunks piped into `hc exec -i`),
  `stageImage` (a Markdown image into the app folder, with its pixel size), `pdfPreview` (the
  first page), `renderDiagrams` (runs `diagrams.mjs` with a job file), `openVideo`, `openInBrowser`, `Player` (the audio bar), `newDownload` / `downloadView` (the
  transfer bar), `sweepCache`. The queue (`enqueue`, `next`) and `drop` live in `main.js`;
  drops arrive through `.on_drop(e => e.paths)` on the tree and on each row.
- `mods/files-plus/diagrams.mjs`: a Node.js script (no packages) that drives Chrome over the
  DevTools protocol (`Target.createTarget`, `Runtime.evaluate` of `draw(kind, source)`,
  `Page.captureScreenshot` with a clip and a transparent background) and prints `{ results }`.
- `mods/image-viewer-plus/main.js`: clone of the shipped `image-viewer`. Stages the image into the
  app folder (`image()` only loads paths there), reads its pixel size with `sips` (macOS) or
  `file` (Linux) or `System.Drawing` (Windows), deletes the copy on close.
- Programs: `sh`, `git`, `stat`, `hc exec --on <machine> -- dd`, `dd … | hc exec --on <machine>
  -i -- sh -c 'cat >> …'`, `cp`, `open` / `xdg-open`, `qlmanage` / `pdftoppm`, `sips` / `file`, `ffplay`, `ffprobe`,
  `kill`, `find`, `trash` / `gio` / `trash-put`, `sips` / `file`, `node` + Chrome (diagrams).
- Icons: `chevron-down.svg`, `chevron-right.svg`, `file.svg`, `folder.svg` (14px / 12px, `svg()`).
- The layout: the `files` block of a cloned `main` layout points at `files-plus`.

## Watch out

- `hc exec` keeps only the **first 8 MB** of a program's stdout and still exits 0 (it prints
  `output cut` on stderr). A plain `hc exec -- cat file > copy` silently truncates. Copy in chunks
  below that (`dd bs=1048576 skip=… count=7`), write each at its offset (`dd seek=… conv=notrunc`),
  and compare the final size with `wc -c` on the other machine.
- Each `hc exec` costs ~0.3 s by itself, so one chunk after another is slow (100 MB in 5.2 s on a
  LAN). Six chunks in flight at once (`PARALLEL` in `media.js`) did it in 2.1 s, close to plain
  `ssh`.
- Never pipe `hc exec … | dd …`: the pipe's exit code is the last `dd`'s, so a failed chunk leaves
  a hole of zeros that a size check doesn't see. Each chunk goes to its own temp file, is checked
  for its expected byte count, then written in place (on the other machine too, for uploads).
- Piped stdin (`hc exec -i`) is capped at 8 MB too, but refused cleanly (`at most 8 MB piped in`,
  exit 6): upload in chunks below it as well.
- A drop on a row may also reach the tree: rows call `cx.stop_propagation()` and `drop` ignores
  the same paths again within a second.
- `exec` times out after 30 s by default. Give every chunk its own `exec` with a longer timeout
  (here 150 s; `hc exec --timeout 120`) instead of one long copy.
- `ExecResult.stdout` is text: binary data must go to a file inside the shell command, never
  through `stdout`.
- `image()` loads only paths inside the app folder: stage images under `data/`.
- `on_size_change` reports sizes with the app zoom applied while `w()` / `h()` are unzoomed: divide
  by `settings().zoom`.
- Herdr has no audio or video element: playback is a separate `ffplay` / player process; kill it
  when the panel closes (`close()`).
- `ffplay` and `ffprobe` are looked up on `PATH`, then `/opt/homebrew/bin` and `/usr/local/bin`.
- `TextView.markdown` draws no images at all, not even from the app folder: split the Markdown
  into text blocks and images (`mdParts`) and draw each image with `image()`.
- `image()` loads only paths inside the app folder: stage Markdown images and the PDF page under
  `data/files-plus-media/`. Give each PDF render a new file name, or `image()` may show an older
  render of the same path.
- Quick Look writes `<name>.pdf.png` into the output folder; `qlmanage` can hang, so its `exec`
  has a 60 s timeout.
- `mermaid.render` sets `max-width: 100%` on its SVG: set its `width` / `height` from the viewBox,
  or wide diagrams shrink to the page. bpmn-js needs a container in the page while importing; its
  `saveSVG()` has no watermark and no background.
- Watching the folder works only on this computer; another machine relies on the 10 s refresh.

## Done when

- `herdr-app check` passes for `mods/files-plus` and `mods/image-viewer-plus`.
- A file larger than 8 MB on another machine (a video) downloads with the bar moving through %,
  MB and speed, ends with the same SHA-1 as the original, and opens in the player.
- `✕` on the transfer bar stops it and leaves no `.part` file in `data/files-plus-media/`.
- Right-click → Download on a remote file saves it to `~/Downloads` with the same SHA-1; a second
  Download of it saves `name (1).ext`.
- A 20 MB file dropped on a folder of another machine arrives with the same SHA-1; dropping it
  again fails with `already exists`; two files dropped together show `+1 waiting`.
- An image on another machine opens in the dialog with its pixel size; ← / → step through the
  folder's images.
- An mp3 plays from the bar; `❚❚`, `−10s`, `+10s` and a click on the bar work.
- A `README.md` opens rendered; `Source` shows the editor; an edit shows in `Preview`; ⌘S saves.
- A Markdown file with `![x](img/a.png)` shows the picture at the pane's width, also on another
  machine; a missing one says `🖼 x: not found`; a web badge shows as its alt text.
- A ```` ```mermaid ```` flowchart and a ```` ```bpmn ```` process show as pictures; a broken Mermaid
  block shows `Parse error on line …` and its source; opening the file again draws nothing new.
- A `.bpmn` file and a `.mmd` file open as their diagram; `Source` shows the text and saves.
- A two-page PDF shows page 1 and `Page 1 of 2`; `Open` opens it in the PDF app.
- A relative link in the Markdown opens the linked file in the panel.
- ⤢ on an open `README.md` shows it in a big dialog with the text in a centered column; ✕ closes it.
- Right-click → Rename, New file, New folder and Move to Trash work, here and on another machine.
- ⌘-click two files and Shift-click a third: `3 selected`; Move, then right-click a folder → Paste
  here moves them there; Copy and Paste again says `already exists there`.
- Saving a file that changed on disk since it was opened is refused with `Reload from disk`.
