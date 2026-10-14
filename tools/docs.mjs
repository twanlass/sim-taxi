/**
 * The docs against the code, for the two kinds of drift a reader cannot see.
 *
 *  1. Every URL parameter the game reads is in the table in docs/params.md, and every parameter in
 *     the table is still read somewhere. The table was written because ~70 of them had ended up
 *     spread across nine docs with nothing listing them all — and a list nobody checks rots the same
 *     way the scattered mentions did.
 *  2. Every relative link between the docs lands on a file that exists and, when it names one, on a
 *     heading that exists. Splitting gameplay.md and rendering.md into current and history halves
 *     moved hundreds of paragraphs; a link that stops resolving does not throw, it just opens the
 *     top of a 2,000-line file.
 *
 *   node tools/docs.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const failures = [];
const check = (ok, message) => { checks++; if (!ok) failures.push(message); };

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

// --- 1. URL parameters ------------------------------------------------------------------------
// What the code reads: any `.get('x')` / `.has('x')` on something URLSearchParams-shaped. The
// receiver is matched by name because the game reads its params through a handful of spellings
// (`params`, `debugParams`, `new URLSearchParams(location.search)`), and Map/Set `.get` calls on
// other names are not URL parameters.
const READ = /(?:[Pp]arams|URLSearchParams\([^)]*\)|searchParams)\s*\.\s*(?:get|has)\(\s*['"]([A-Za-z0-9_-]+)['"]/g;
const inCode = new Map();
for (const file of walk(join(ROOT, 'src'), '.js')) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(READ)) {
    if (!inCode.has(m[1])) inCode.set(m[1], relative(ROOT, file));
  }
}
// The lab is its own page with its own parameters; docs/lab.md covers those.
for (const [name, file] of inCode) if (file.startsWith('src/lab/')) inCode.delete(name);

const table = readFileSync(join(ROOT, 'docs/params.md'), 'utf8');
// A row is `| \`?name…\` |` — the first cell names the parameter, with or without a value.
const inTable = new Set([...table.matchAll(/^\|\s*`\?([A-Za-z0-9_-]+)[^`]*`/gm)].map((m) => m[1]));
for (const [name, file] of inCode) {
  check(inTable.has(name), `params: ?${name} is read in ${file} but missing from docs/params.md`);
}
for (const name of inTable) {
  check(inCode.has(name), `params: ?${name} is in docs/params.md but nothing in src/ reads it`);
}

// --- 2. Links between the docs ----------------------------------------------------------------
// GitHub's heading slug: lowercase, punctuation other than `-` and `_` dropped, spaces to `-`,
// repeats numbered. Code spans keep their text.
function slugs(markdown) {
  const seen = new Map();
  const out = new Set();
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const base = h[1].toLowerCase()
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

const DOCS = [...walk(join(ROOT, 'docs'), '.md'), join(ROOT, 'README.md'), join(ROOT, 'CLAUDE.md')];
const slugCache = new Map();
const slugsOf = (file) => {
  if (!slugCache.has(file)) slugCache.set(file, slugs(readFileSync(file, 'utf8')));
  return slugCache.get(file);
};
for (const file of DOCS) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^[a-z]+:/i.test(href)) continue; // http(s), mailto
    const [path, anchor] = href.split('#');
    const target = path ? resolve(dirname(file), path) : file;
    const where = relative(ROOT, file);
    if (!existsSync(target)) { check(false, `links: ${where} → ${href}: no such file`); continue; }
    if (anchor && target.endsWith('.md')) {
      check(slugsOf(target).has(decodeURIComponent(anchor).toLowerCase()), `links: ${where} → ${href}: no such heading`);
    } else {
      check(true);
    }
  }
}

for (const f of failures) console.log(`FAIL  ${f}`);
console.log(`${checks - failures.length}/${checks} checks passed (${inCode.size} params)`);
process.exit(failures.length ? 1 : 0);
