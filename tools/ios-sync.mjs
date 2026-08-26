/**
 * Copies the built web bundle into the iOS app, for `npm run build:ios`.
 *
 *   node tools/ios-sync.mjs        # dist/ -> ios/SimTaxi/web/
 *
 * Node rather than `rsync -a --delete`, which is what this replaced. `rsync` is on macOS today, but
 * it is Apple-deprecated and swapped for openrsync in recent versions, and it is absent from plenty
 * of Linux containers — including the one this repo's CI-ish checks run in, which meant the sync
 * step was the one part of the iOS build nobody could test outside a Mac. Everything else in
 * `tools/` is a `.mjs`; this is now too, and it runs anywhere node does.
 *
 * **Mirror, not merge.** The destination is emptied first. A copy that only ever adds files leaves
 * the previous build's hashed chunks behind, and since `index.html` names the current ones by hash,
 * the stale ones are invisible dead weight that grows with every build — until the day one of them
 * gets served instead, which is the bug this whole directory is trying not to have.
 */

import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('dist');
const DEST = path.resolve('ios/SimTaxi/web');

/**
 * What `dist/` contains that the app must not ship.
 *
 * - **`lab`** — the passing lab (`/lab/`), a developer workbench with no route into it from the
 *   game and `robots: noindex` on it. It exists as a second Vite entry, so it lands in `dist/`
 *   whether or not anyone wants it in the .ipa. Excluded here rather than in `vite.config.js`
 *   on purpose: that file carries an explicit warning that a `manualChunks` rule reaching into
 *   `src/` turns an import into a boot, and the web deploy genuinely wants the lab.
 * - **`sw.js`** — the service worker. `src/main.js` skips registering it in the native shell (the
 *   bundle is already local, and a cache-first worker survives an App Store update and serves the
 *   old game to someone who just installed the new one). Nothing would load it, but shipping the
 *   file anyway invites a future reader to wire it back up.
 */
const EXCLUDE = new Set(['lab', 'sw.js']);

/**
 * The lab's *code*, which is a separate problem from the lab's page.
 *
 * Rollup gives every entry its own chunk, so excluding `lab/index.html` above leaves
 * `assets/lab-<hash>.js` behind — 9kB of unreachable developer workbench inside the App Store
 * binary, with nothing left in the bundle that references it. The name is stable because it is
 * derived from the entry key in `vite.config.js`; only the hash moves.
 *
 * Dropped matches are printed rather than removed quietly. If a Vite upgrade changes the naming and
 * this stops matching, the silence would read exactly like success — so the report below always
 * says what went and what stayed.
 */
const EXCLUDE_ASSET = /^lab-[^/]*\.js$/;

if (!existsSync(SRC)) {
  console.error('No dist/ — run `vite build` first (or use `npm run build:ios`, which does both).');
  process.exit(1);
}

await rm(DEST, { recursive: true, force: true });
await mkdir(DEST, { recursive: true });

let files = 0;
let bytes = 0;

const dropped = [];

for (const name of await readdir(SRC)) {
  if (EXCLUDE.has(name)) { dropped.push(name); continue; }
  await cp(path.join(SRC, name), path.join(DEST, name), { recursive: true });
}

// The hashed chunks land under `assets/`, so the per-file exclusion happens after the copy rather
// than during it — `cp` is recursive and has no filter hook.
const assetsDir = path.join(DEST, 'assets');
if (existsSync(assetsDir)) {
  for (const name of await readdir(assetsDir)) {
    if (!EXCLUDE_ASSET.test(name)) continue;
    await rm(path.join(assetsDir, name));
    dropped.push(`assets/${name}`);
  }
}

// Counted by walking the destination rather than by totalling the copy above, so the number
// reported is what actually landed. The bundle is ~1MB and every byte of it goes into the .ipa; a
// sudden jump here is worth noticing.
async function measure(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await measure(full); continue; }
    files += 1;
    bytes += (await stat(full)).size;
  }
}
await measure(DEST);

console.log(`ios-sync  ${files} files · ${(bytes / 1024).toFixed(0)} kB → ${path.relative(process.cwd(), DEST)}/`);
console.log(`          dropped: ${dropped.length ? dropped.sort().join(', ') : 'nothing (check the exclusions still match)'}`);
