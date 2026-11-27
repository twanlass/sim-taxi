/**
 * Generates the icons a speech line can put inside its text — `{:robotaxi}`, game/speech.js
 * `parseLine` — by rendering the real model in the engine (tools/inline-icon/). Like
 * tools/make-icon.mjs it is not part of `npm run check`: re-run it when the model's look changes,
 * then commit what it writes.
 *
 *   node tools/make-inline-icons.mjs
 *
 * Writes assets/hud/inline-<name>.png for every entry in tools/inline-icon/inline-icon.js.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withIconPage } from './icon/page.mjs';

const outDir = path.resolve('assets/hud');
const exitCode = await withIconPage('/tools/inline-icon/', async ({ evaluate }) => {
  await mkdir(outDir, { recursive: true });
  const icons = await evaluate('window.__inlineIcons');
  for (const [name, url] of Object.entries(icons)) {
    const out = path.join(outDir, `inline-${name}.png`);
    await writeFile(out, Buffer.from(url.split(',')[1], 'base64'));
    console.log(`wrote ${path.relative(process.cwd(), out)}`);
  }
});
process.exit(exitCode);
