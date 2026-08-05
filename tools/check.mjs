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
  '../src/geometry/ridermeter.js', '../src/geometry/person.js', '../src/game/routeline.js',
  '../src/game/dust.js', '../src/game/sparks.js', '../src/game/smoke.js',
  '../src/game/debris.js', '../src/game/flames.js', '../src/game/daylight.js', '../src/game/riderfinder.js',
  '../src/game/dropoffindicator.js', '../src/game/vanish.js', '../src/game/runend.js',
  '../src/geometry/carkit.js'];

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

// The vehicle kit behind /editor.html. Every preset has to build, and the sedan preset has to
// keep matching carGeometry() in sim/traffic.js — the kit is only a trustworthy editing surface
// for the game's vehicles while its baseline *is* the game's vehicle.
try {
  const { PRESETS, buildVehicleGeometry, normalizeSpec, randomSpec, partAtFace } = await import('../src/geometry/carkit.js');
  for (const [key, preset] of Object.entries(PRESETS)) {
    const geo = buildVehicleGeometry(preset);
    if (!geo.attributes.position?.count || !geo.attributes.color) {
      throw new Error(`${key} built without position/color attributes`);
    }
    if (geo.index) throw new Error(`${key} is indexed — flat shading needs non-indexed geometry`);
    geo.computeBoundingBox();
    const b = geo.boundingBox;
    if (b.min.y < -1e-6 || b.max.y > 4 || b.max.x - b.min.x > 8) {
      throw new Error(`${key} bounds look wrong: ${JSON.stringify(b)}`);
    }
    // The manifest is the editor's picking truth: ranges must tile the geometry exactly.
    const manifest = geo.userData.manifest;
    let cursor = 0;
    for (const part of manifest) {
      if (part.start !== cursor || part.count <= 0) throw new Error(`${key} manifest has a gap at ${part.name}`);
      cursor += part.count;
    }
    if (cursor !== geo.attributes.position.count) throw new Error(`${key} manifest does not cover the geometry`);
    if (new Set(manifest.map((p) => p.name)).size !== manifest.length) throw new Error(`${key} manifest repeats a name`);
    if (partAtFace(manifest, 0) !== 'body') throw new Error(`${key} face 0 should belong to the body`);
    geo.dispose();
  }
  // A part colour override must actually land in the baked vertex colours.
  {
    const geo = buildVehicleGeometry({ ...PRESETS.sedan, partColors: { body: '#ff0000' } });
    const c = geo.attributes.color;
    if (!(Math.abs(c.getX(0) - 1) < 1e-4 && c.getY(0) < 1e-4)) throw new Error('partColors override did not bake');
    geo.dispose();
  }
  // A wrecked profile must degrade to the rectangle, and a real one must change the shape.
  {
    const junk = normalizeSpec({ body: { profile: [[9, 'x'], [null], 3] } });
    if (junk.body.profile.length !== 4) throw new Error('junk profile did not fall back to the rectangle');
    const wedge = buildVehicleGeometry(PRESETS.sports);
    wedge.computeBoundingBox();
    if (!(wedge.boundingBox.max.y < 1.9)) throw new Error('sports wedge lost its chopped roofline');
    wedge.dispose();
  }
  // Obtuse angles: a chain that doubles back (a nose jutting at mid-height) is legal as long
  // as the outline stays simple; a chain that folds through itself gets repaired, not kept.
  {
    const nose = normalizeSpec({ body: { profile: [[0.4, 0], [0.5, 0.45], [0.3, 1], [-0.5, 1], [-0.5, 0]] } });
    if (!(nose.body.profile[1][0] > nose.body.profile[0][0])) {
      throw new Error('simple doubled-back chain was flattened to monotonic');
    }
    buildVehicleGeometry(nose).dispose();
    const crossed = normalizeSpec({ body: { profile: [[0.5, 0], [-0.5, 1], [0.5, 1], [-0.5, 0]] } });
    for (let i = 1; i < crossed.body.profile.length; i++) {
      if (crossed.body.profile[i][0] > crossed.body.profile[i - 1][0] + 1e-9) {
        throw new Error('crossing chain survived sanitisation un-repaired');
      }
    }
    buildVehicleGeometry(crossed).dispose();
  }
  // Cabin and cargo silhouettes: a drawn chain builds, and cargo shape controls move the mesh.
  {
    const shaped = buildVehicleGeometry({
      ...PRESETS.boxtruck,
      cabin: { ...PRESETS.boxtruck.cabin, profile: [[0.5, 0], [0.1, 1], [-0.5, 0.9], [-0.5, 0]] },
      cargo: { ...PRESETS.boxtruck.cargo, boxOverhang: 0.5, profile: [[0.5, 0], [0.5, 1], [-0.45, 1], [-0.5, 0.6], [-0.5, 0]] },
    });
    shaped.computeBoundingBox();
    if (!(shaped.boundingBox.min.x < -(4.9 / 2) - 0.4)) throw new Error('box overhang did not extend past the bumper');
    shaped.dispose();
  }
  // Wheel controls: the segment count must reach the cylinders, the colour must bake.
  {
    const coarse = buildVehicleGeometry({ ...PRESETS.sedan, wheels: { ...PRESETS.sedan.wheels, segments: 6 } });
    const fine = buildVehicleGeometry({ ...PRESETS.sedan, wheels: { ...PRESETS.sedan.wheels, segments: 16 } });
    if (coarse.attributes.position.count >= fine.attributes.position.count) {
      throw new Error('wheel segments did not change the mesh');
    }
    coarse.dispose();
    const red = buildVehicleGeometry({ ...PRESETS.sedan, colors: { ...PRESETS.sedan.colors, wheels: '#ff0000' } });
    const wheels = red.userData.manifest.find((p) => p.name === 'wheels');
    if (!(red.attributes.color.getX(wheels.start) > 0.9)) throw new Error('wheel colour did not bake');
    red.dispose();
    fine.dispose();
  }
  const sedan = buildVehicleGeometry(PRESETS.sedan);
  sedan.computeBoundingBox();
  const s = sedan.boundingBox;
  // carGeometry() after the doubled wheels and CHASSIS_LIFT: body 3.4 long, cabin roof at
  // 1.45 + 0.32 + 0.3 = 2.07, wheels on the road and proud of the flanks — outer tread face at
  // ±(0.85 + WHEEL_PROUD) = ±0.96, same as it always was, because wheels anchor by that face.
  const near = (a, b) => Math.abs(a - b) < 1e-4;
  if (!(near(s.max.x, 1.7) && near(s.min.x, -1.7) && near(s.max.z, 0.96) && near(s.max.y, 2.07) && near(s.min.y, 0))) {
    throw new Error(`sedan drifted from the game car: ${JSON.stringify(s)}`);
  }
  sedan.dispose();
  // A malformed import must degrade to a buildable car, and a random roll must always build.
  buildVehicleGeometry(normalizeSpec({ body: { len: 999, width: 'nope' }, cargo: { type: 'lorry' } })).dispose();
  for (let i = 0; i < 20; i++) buildVehicleGeometry(randomSpec()).dispose();
  console.log(`ok    carkit   ${Object.keys(PRESETS).length} presets build · sedan matches the game car`);
} catch (error) {
  failed += 1;
  console.log(`FAIL  carkit   ${error.message}`);
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
