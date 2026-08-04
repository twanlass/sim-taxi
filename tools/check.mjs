/**
 * One command for the whole headless suite.
 *
 * The point is round trips, not compute: the four tools below total well under a second, but
 * running them separately costs four exchanges. This runs them together and prints one compact
 * summary, so a change can be made and verified in a single step.
 *
 *   npm run check
 */
import { spawnSync } from 'node:child_process';

// Boot the browser-only modules in node before anything else. They construct fine outside a
// browser, and a scope slip in scene.js shipped undetected because nothing headless imported it.
const BOOT = ['../src/game/scene.js', '../src/game/debugpanel.js', '../src/geometry/taxi.js',
  '../src/geometry/lightshaft.js', '../src/geometry/person.js', '../src/game/routeline.js',
  '../src/game/dust.js', '../src/game/sparks.js', '../src/game/smoke.js',
  '../src/game/debris.js', '../src/game/flames.js', '../src/game/daylight.js', '../src/game/riderfinder.js',
  '../src/game/dropoffindicator.js', '../src/city/level.js', '../src/editor/overlay.js'];

const TOOLS = [
  { name: 'probe',   args: ['tools/probe.mjs'],        pick: /(\d+\/\d+) checks passed/ },
  { name: 'routing', args: ['tools/taxi.mjs', '30'],   pick: /arrived (\S+)/ },
  // Nine seeds, not one. A single soak run is trip-length luck more than it is difficulty, so a
  // one-seed gate went red or green on which junction the spawner happened to pick.
  { name: 'fares',   args: ['tools/soak.mjs', '25', '4', '9'], pick: /delivered (\S+ median)/ },
  { name: 'signals', args: ['tools/signals.mjs'],      pick: /throughput\s+: (\S+)/, info: true },
];

let failed = 0;
const started = Date.now();

// scene.js actually builds its lights and sky here, which is what catches an undefined reference.
try {
  const { createScene } = await import('../src/game/scene.js');
  const { createDaylight, DAY_SECONDS } = await import('../src/game/daylight.js');
  const world = createScene();
  for (const mod of BOOT) await import(mod);

  // Drive a whole day past the lights. Every keyframe gets applied, so a bad colour or a uniform
  // that moved out from under the daylight module surfaces here rather than at dusk in the browser.
  const daylight = createDaylight(world);
  let noon = 0;
  let midnight = 1;
  for (let step = 0; step < 240; step++) {
    daylight.update(DAY_SECONDS / 240);
    const hour = daylight.state.hour;
    if (hour > 12 && hour < 13) noon = world.sun.intensity;
    if (hour < 1) midnight = Math.min(midnight, world.sun.intensity);
  }
  if (!(noon > 3 && midnight < 0.05)) {
    throw new Error(`day/night flat: noon ${noon.toFixed(2)}, midnight ${midnight.toFixed(2)}`);
  }
  console.log(`ok    modules  all import and construct · sun ${midnight.toFixed(2)}→${noon.toFixed(2)}`);
} catch (error) {
  failed += 1;
  console.log(`FAIL  modules  ${error.message}`);
}

// Level format round-trip: a procedural map serialised to JSON, then reloaded, should produce a
// layout the router can still solve — that's the invariant the editor's Play button depends on.
try {
  const { makeRng } = await import('../src/util/rng.js');
  const { proceduralLayout, layoutFromLevel } = await import('../src/city/layout.js');
  const { serialize, validate, encodeUrl, decodeUrl } = await import('../src/city/level.js');
  const { findRoute, allIntersections } = await import('../src/game/route.js');
  const { DIR } = await import('../src/city/grid.js');

  const original = proceduralLayout(makeRng(71624));
  const level = serialize(original);
  const errors = validate(level);
  if (errors.length) throw new Error(`serialize failed validation: ${errors.join('; ')}`);

  const round = decodeUrl(encodeUrl(level));
  if (JSON.stringify(round) !== JSON.stringify(level)) throw new Error('base64url round-trip changed the payload');

  const reloaded = layoutFromLevel(level);
  if (reloaded.length !== original.length) throw new Error(`block count changed: ${original.length} → ${reloaded.length}`);
  for (let i = 0; i < original.length; i++) {
    if (original[i].type !== reloaded[i].type) {
      throw new Error(`block ${i} type changed: ${original[i].type} → ${reloaded[i].type}`);
    }
  }

  const nodes = allIntersections();
  let broken = 0;
  for (const from of nodes) {
    for (const to of nodes) {
      if (from.i === to.i && from.j === to.j) continue;
      if (!findRoute({ i: from.i, j: from.j, d: DIR.PX }, to)) broken += 1;
    }
  }
  if (broken > 0) throw new Error(`${broken} approach → destination pairs unroutable after round-trip`);
  console.log(`ok    level    round-trip stable · ${nodes.length} nodes, ${original.length} blocks, ${level.closed.length} closures`);
} catch (error) {
  failed += 1;
  console.log(`FAIL  level    ${error.message}`);
}

for (const tool of TOOLS) {
  const run = spawnSync('node', tool.args, { encoding: 'utf8' });
  const out = `${run.stdout}${run.stderr}`;
  const summary = out.match(tool.pick)?.[1] ?? '?';
  const ok = tool.info || run.status === 0;
  if (!ok) failed += 1;

  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${tool.name.padEnd(8)} ${summary}`);

  // On failure, surface just the failing assertions rather than the whole log.
  if (!ok) {
    out.split('\n').filter((l) => /FAIL|ENDED|Error|MISS/.test(l)).slice(0, 8)
      .forEach((l) => console.log(`        ${l.trim()}`));
  }
}

console.log(`\n${failed ? `${failed} tool(s) failing` : 'all green'} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);
