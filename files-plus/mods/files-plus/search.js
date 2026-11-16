// files-plus: search the panel's folder by file name (every file under it) or by content (rg, git grep or grep).
// Both run through `sh` with `exec(…, { on })`, so they work on another machine too.
import { exec } from "herdr";

const PATHS = 'PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"; export PATH; ';
export const MAX_FILES = 50000; // names kept for filtering
export const MAX_LINES = 2000;  // content matches read

// Every file and folder under $1, relative, NUL separated, folders ending with "/". In a git work tree
// (and not in an ignored folder) the files git knows plus untracked ones not ignored; else find without
// .git and node_modules. Cut below hc exec's 8 MB output limit.
const LIST = PATHS + 'cd "$1" || exit 2; ' +
  'if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && ! git check-ignore -q . 2>/dev/null; then ' +
  'printf "#git\\0"; git -c core.fsmonitor=false ls-files -z --cached --others --exclude-standard 2>/dev/null; ' +
  'else printf "#find\\0"; find . \\( -name .git -o -name node_modules \\) -prune -o -type d -exec printf "%s/\\0" {} + -o -print0 2>/dev/null; fi | head -c 6000000';

// Lines containing $1 (literal, any case) under $2: "path:line:text", the first line names the tool.
const GREP = PATHS + 'q=$1; cd "$2" || exit 2; ' +
  'if command -v rg >/dev/null 2>&1; then echo "#rg"; rg --no-heading --line-number --color never -i -F --max-count 20 --max-filesize 5M -e "$q" 2>/dev/null; ' +
  'elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "#git grep"; git -c core.fsmonitor=false grep -n -I -i -F --untracked -e "$q" 2>/dev/null; ' +
  'else echo "#grep"; grep -rnI -i -F -m 20 --exclude-dir=.git --exclude-dir=node_modules -e "$q" . 2>/dev/null; fi | head -n ' + (MAX_LINES + 2) + ' | cut -c 1-600';

// [{ path, dir, lower }] for everything under root; git lists files only, so their folders are added.
export async function listAll(root, on) {
  const r = await exec("sh", ["-c", LIST, "files", root], { on, timeout: 60000 });
  if (r.code !== 0 && !r.stdout) throw new Error((r.stderr || "Cannot list this folder").trim());
  const fields = r.stdout.split("\0");
  const tool = fields[0] === "#git" ? "git" : "find";
  const seen = new Set(), out = [];
  const add = (path, dir) => {
    if (!path || seen.has(path) || out.length >= MAX_FILES) return;
    seen.add(path); out.push({ path, dir, lower: path.toLowerCase() });
  };
  // The last field is empty, or cut mid-name by head -c: drop it.
  for (const raw of fields.slice(1, -1)) {
    let p = raw.replace(/^\.\//, ""), dir = false;
    if (p.endsWith("/")) { dir = true; p = p.replace(/\/+$/, ""); }
    if (!p || p === ".") continue;
    if (tool === "git") for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) add(p.slice(0, i), true);
    add(p, dir);
  }
  return { entries: out, tool, limited: out.length >= MAX_FILES };
}

const termsOf = query => query.toLowerCase().split(/\s+/).filter(Boolean);

// Entries whose path holds every word of the query; names that hold them all first, then shorter paths.
export function matchNames(entries, query, max = 300) {
  const terms = termsOf(query);
  if (!terms.length) return { total: 0, items: [] };
  const hits = [];
  for (const e of entries) {
    if (!terms.every(t => e.lower.includes(t))) continue;
    const base = e.lower.slice(e.lower.lastIndexOf("/") + 1);
    const score = (terms.every(t => base.includes(t)) ? 0 : 100000) + (base.startsWith(terms[0]) ? 0 : 10000) + (e.dir ? 0 : 1) + e.path.length * 2;
    hits.push({ e, score });
  }
  hits.sort((a, b) => a.score - b.score || a.e.path.localeCompare(b.e.path));
  return { total: hits.length, items: hits.slice(0, max).map(h => h.e) };
}

// { tool, files: [{ path, lines: [{ line, text }] }], count, limited }
export async function grepContents(root, on, query) {
  const r = await exec("sh", ["-c", GREP, "files", query, root], { on, timeout: 60000 });
  if (r.code !== 0 && !r.stdout) throw new Error((r.stderr || "Search failed").trim());
  const lines = r.stdout.split("\n");
  const tool = lines[0]?.startsWith("#") ? lines.shift().slice(1) : "grep";
  const files = new Map();
  let count = 0;
  for (const l of lines) {
    const m = /^(.+?):(\d+):(.*)$/.exec(l);
    if (!m || count >= MAX_LINES) continue;
    const path = m[1].replace(/^\.\//, "");
    if (!files.has(path)) files.set(path, { path, lines: [] });
    files.get(path).lines.push({ line: Number(m[2]), text: m[3].replace(/�+$/, "") });
    count++;
  }
  return { tool, files: [...files.values()], count, limited: count >= MAX_LINES };
}

// Splits text into [{ s, hit }] around every occurrence of the query's words (any case), or of
// the whole query when `whole` (content search looks for it as one string).
export function highlight(text, query, whole) {
  const terms = whole ? [query.toLowerCase()].filter(Boolean) : termsOf(query).sort((a, b) => b.length - a.length);
  if (!terms.length) return [{ s: text, hit: false }];
  const lower = text.toLowerCase(), out = [];
  let i = 0, plain = "";
  while (i < text.length) {
    const t = terms.find(t => lower.startsWith(t, i));
    if (t) { if (plain) out.push({ s: plain, hit: false }); plain = ""; out.push({ s: text.slice(i, i + t.length), hit: true }); i += t.length; }
    else plain += text[i++];
  }
  if (plain) out.push({ s: plain, hit: false });
  return out;
}

// A matched line for the list: no indentation, and the match within the first ~60 characters.
export function excerpt(text, query) {
  let s = text.replace(/^\s+/, "");
  const at = s.toLowerCase().indexOf(query.toLowerCase());
  if (at > 60) s = "…" + s.slice(at - 30);
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}
