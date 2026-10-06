/**
 * The one check every iOS build path runs before trusting what it built: does the .app carry the
 * web bundle as a `web/` folder, or did it arrive flattened?
 *
 * Shared by `tools/ios-push.mjs` and `tools/ios-archive.mjs`. A flattened bundle is a green build
 * and a dead app — `BundleSchemeHandler` `fatalError`s on launch and every asset path 404s — so a
 * path that skipped this would be the one that ships the break. See docs/ios.md, "The bundle
 * layout".
 *
 * Returns `{ ok: true, count }`, or `{ ok: false, message }` for the caller to report in its own
 * voice.
 */

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

export async function checkBundleLayout(appPath) {
  if (!existsSync(appPath)) {
    return { ok: false, message: `the build reported success but produced no app at ${appPath}` };
  }
  const scripts = [];
  const walk = async (dir, rel = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const at = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(path.join(dir, entry.name), at); continue; }
      if (entry.name.endsWith('.js') || entry.name === 'index.html') scripts.push(at);
    }
  };
  await walk(appPath);

  const stray = scripts.filter((f) => !f.startsWith('web/'));
  if (!scripts.includes('web/index.html')) {
    return { ok: false, message: 'the app has no web/index.html — BundleSchemeHandler will fatalError on launch.\n'
      + `          Found instead: ${scripts.join(', ') || '(nothing)'}\n`
      + '          Fix: docs/ios.md — the sync group needs explicitFolders = ( web, ).' };
  }
  if (stray.length) {
    return { ok: false, message: 'the web bundle was flattened into the app root — every asset path will 404.\n'
      + `          Loose at the root: ${stray.join(', ')}\n`
      + '          Fix: docs/ios.md — the sync group needs explicitFolders = ( web, ).' };
  }
  return { ok: true, count: scripts.length };
}
