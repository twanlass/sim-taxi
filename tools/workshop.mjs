/**
 * Headless checks for the model workshop — see docs/workshop.md.
 *
 * The workshop is only useful while every entry on its bench still builds: nothing else imports
 * `src/workshop/`, so a builder whose signature moved would leave the page throwing on the one
 * model you opened it for. So this builds every entry in the catalog through its own `build()`,
 * and asserts each one comes back as something that draws — real triangles, a finite size, and a
 * size a model can plausibly be (the bench frames by the bounding box, and a stray vertex at
 * x = 1e6 frames as an empty screen).
 *
 * The page's own two modules are parsed, since they are browser-only and nothing else loads them.
 *
 * And the agent bridge's prompt: it has to name the model's source file, or the agent starts
 * every turn by hunting for it.
 *
 *   node tools/workshop.mjs
 */

import * as THREE from 'three';
import { spawnSync } from 'node:child_process';
import { makeRng } from '../src/util/rng.js';
import { CATALOG } from '../src/workshop/catalog.js';
import { workshopPrompt } from './workshop-agent.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const ids = new Set();
for (const entry of CATALOG) {
  check(`${entry.id}: unique id`, !ids.has(entry.id));
  ids.add(entry.id);
  check(`${entry.id}: names its source file`, /^src\/\S+\.js · \S/.test(entry.source), entry.source);

  let built = null;
  try {
    built = entry.build(makeRng(7));
  } catch (error) {
    check(`${entry.id}: builds`, false, error.message);
    continue;
  }
  const object = built?.object;
  check(`${entry.id}: builds an Object3D`, Boolean(object?.isObject3D));
  if (!object?.isObject3D) continue;

  let triangles = 0;
  object.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    const g = node.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  check(`${entry.id}: has triangles`, triangles > 0, `${Math.round(triangles)}`);

  object.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  check(`${entry.id}: plausible size`, Number.isFinite(longest) && longest > 0.2 && longest < 80,
    `${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)}`);

  if (built.update) {
    let ok = true;
    try { built.update(1 / 60, 0); } catch { ok = false; }
    check(`${entry.id}: update runs`, ok);
  }
}

// The page's two browser modules touch the DOM on import, so nothing headless can load them — but
// it can parse them, which is the slip that would otherwise only show up as a blank page.
for (const file of ['src/workshop/viewer.js', 'src/workshop/chat.js']) {
  const run = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  check(`${file} parses`, run.status === 0, run.stderr.split('\n').find(Boolean) ?? '');
}

const prompt = workshopPrompt(CATALOG[0], { image: '/tmp/view.png' });
check('prompt names the model\'s source', prompt.includes(CATALOG[0].source));
check('prompt points at the screenshot', prompt.includes('/tmp/view.png'));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
