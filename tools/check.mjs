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
  '../src/game/faremarker.js', '../src/geometry/person.js', '../src/game/routeline.js',
  '../src/game/pathdrag.js',
  '../src/game/dust.js', '../src/game/blast.js', '../src/game/flyover.js', '../src/game/birds.js',
  '../src/game/cityentry.js',
  '../src/game/chopper.js',
  '../src/game/flames.js', '../src/game/daylight.js', '../src/game/riderfinder.js',
  '../src/game/dropoffindicator.js', '../src/game/sirenglow.js',
  '../src/game/vanish.js', '../src/game/runend.js',
  '../src/util/viewport.js',
  '../src/game/energybits.js', '../src/game/carghosts.js', '../src/game/homescreen.js',
  '../src/game/ssao.js', '../src/game/diag.js', '../src/game/recovery.js', '../src/game/pause.js',
  '../src/geometry/roadworks.js', '../src/game/roadwork.js',
  '../src/geometry/parcel.js', '../src/geometry/parcelpad.js', '../src/game/parcels.js',
  '../src/game/tutorial.js', '../src/game/highscores.js', '../src/lab/labroad.js'];

const TOOLS = [
  // Runs first: it is the control on every later step. If the road network stops describing the
  // same city as the grid, the traffic and routing numbers below stop meaning anything.
  { name: 'roadnet', args: ['tools/roadnet.mjs'],      pick: /(\d+\/\d+) checks passed/ },
  { name: 'probe',   args: ['tools/probe.mjs'],        pick: /(\d+\/\d+) checks passed/ },
  { name: 'routing', args: ['tools/taxi.mjs', '30'],   pick: /arrived (\S+)/ },
  // Pure logic against a fake `localStorage`, so it costs nothing and covers the half of the score
  // table a browser on this machine never reaches: a store that throws, and a corrupt payload.
  { name: 'scores',  args: ['tools/scores.mjs'],       pick: /(\d+\/\d+) checks passed/ },
  // Every fare's deadline is budgeted from `estimateSeconds`, so its error is a difficulty knob
  // whether or not anyone tuned it. Runs before the soak: if the estimator has drifted, the soak's
  // numbers are measuring the drift.
  { name: 'eta',     args: ['tools/eta.mjs', '40', '3'],
    pick: /shipped.*->\s+(MAE \S+\s+bias \S+)/ },
  // Nine seeds, not one. A single soak run is trip-length luck more than it is difficulty, so a
  // one-seed gate went red or green on which junction the spawner happened to pick.
  { name: 'fares',   args: ['tools/soak.mjs', '25', '4', '9'],
    pick: /delivered over \d+ runs: (p10 \d+ · median \d+ · p90 \d+)/ },
  // `info` means the number printed is a metric to watch, not a threshold to fail on. The tool
  // still has to *run*: it used to be excused from its exit status entirely, which meant an import
  // error printed `ok signals ?` and the suite stayed green with a whole tool dead.
  { name: 'signals', args: ['tools/signals.mjs'],      pick: /throughput\s+: (\S+)/, info: true },
  // The passing lab at /lab/. Nothing else imports `src/lab/`, so without this the one page in
  // the project whose entire job is to be looked at could stop working silently.
  { name: 'lab',     args: ['tools/lab.mjs'],          pick: /(\d+\/\d+) checks passed/ },
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

for (const tool of TOOLS) {
  const run = spawnSync('node', tool.args, { encoding: 'utf8' });
  const out = `${run.stdout}${run.stderr}`;
  const summary = out.match(tool.pick)?.[1] ?? '?';
  const ok = run.status === 0;
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
