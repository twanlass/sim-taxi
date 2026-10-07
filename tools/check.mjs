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
  '../src/game/pathdrag.js', '../src/game/sfx.js', '../src/game/audiopanel.js',
  '../src/game/dust.js', '../src/game/spray.js', '../src/game/blast.js', '../src/game/flyover.js', '../src/game/birds.js', '../src/game/ducks.js',
  '../src/city/blacktop.js', '../src/game/hoopers.js',
  '../src/game/clouds.js', '../src/geometry/cloud.js', '../src/game/rain.js', '../src/game/citylights.js', '../src/game/storm.js', '../src/game/squall.js',
  '../src/game/cityentry.js', '../src/city/garage.js', '../src/game/opening.js',
  '../src/city/burgerjoint.js', '../src/game/drivethru.js',
  '../src/city/bank.js', '../src/game/robbery.js', '../src/game/radio.js',
  '../src/game/robberline.js', '../src/game/copshout.js', '../src/game/patrol.js', '../src/game/bootleg.js', '../src/game/newmove.js', '../src/game/uturnclip.js', '../src/game/driftclip.js', '../src/game/moveclip.js', '../src/game/repairclip.js',
  '../src/game/speech.js',
  '../src/game/coplights.js', '../src/game/cashtrail.js',
  '../src/game/wipe.js',
  '../src/game/chopper.js', '../src/game/policeheli.js',
  '../src/game/flames.js', '../src/game/locoflame.js', '../src/game/sparks.js',
  '../src/game/repairfx.js',
  '../src/game/daylight.js', '../src/game/riderfinder.js',
  '../src/game/taxifinder.js',
  '../src/game/farepointers.js', '../src/game/sirenglow.js', '../src/game/robberyglow.js',
  '../src/game/vanish.js', '../src/game/wreckage.js', '../src/game/ejection.js', '../src/game/replay.js', '../src/game/runend.js',
  '../src/game/impact.js', '../src/game/taxidamage.js', '../src/game/taxidoor.js',
  '../src/util/viewport.js',
  '../src/game/energybits.js', '../src/game/carghosts.js', '../src/game/homescreen.js',
  '../src/game/ssao.js', '../src/game/crayon.js', '../src/game/cartoon.js',
  '../src/game/bloom.js', '../src/game/hdr.js',
  '../src/game/diag.js', '../src/game/recovery.js', '../src/game/pause.js', '../src/game/menupage.js', '../src/game/inspect.js',
  '../src/geometry/roadworks.js', '../src/game/roadwork.js',
  '../src/geometry/crate.js', '../src/game/flatbed.js',
  '../src/geometry/truckdoors.js', '../src/game/boxspill.js',
  '../src/geometry/firetruck.js', '../src/game/fire.js',
  '../src/city/river.js', '../src/geometry/bridge.js',
  '../src/geometry/boat.js', '../src/game/drawbridge.js', '../src/game/boats.js', '../src/game/wake.js', '../src/game/gulls.js',
  '../src/geometry/parcel.js', '../src/geometry/food.js', '../src/geometry/cargo.js',
  '../src/geometry/parcelpad.js', '../src/game/parcels.js',
  '../src/game/cargochip.js',
  '../src/game/tutorial.js', '../src/game/titlescreen.js', '../src/game/settings.js', '../src/game/highscores.js', '../src/game/locostash.js',
  '../src/util/platform.js', '../src/util/haptics.js',
  '../src/lab/labroad.js'];

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
  // The New Move card's U-turn is a recording of the sim (game/uturnreel.js); this films it again
  // and fails if the game's U-turn has moved on without it.
  { name: 'uturn',   args: ['tools/uturnreel.mjs'],    pick: /(\d+\/\d+) checks passed/ },
  // ...and the drift's card the same (game/driftreel.js).
  { name: 'drift',   args: ['tools/driftreel.mjs'],    pick: /(\d+\/\d+) checks passed/ },
  // ...and the overtake's (game/overtakereel.js).
  { name: 'overtake', args: ['tools/overtakereel.mjs'], pick: /(\d+\/\d+) checks passed/ },
];

let failed = 0;
const started = Date.now();

// scene.js actually builds its lights and sky here, which is what catches an undefined reference.
try {
  const { createScene, sinkShadowCaster, SHADOW_SINK } = await import('../src/game/scene.js');
  const { createDaylight, DAY_SECONDS } = await import('../src/game/daylight.js');
  const world = createScene();
  for (const mod of BOOT) await import(mod);

  // The bridges' shadow patch, run rather than trusted. It is a string replace into three's own
  // depth shader (see `sinkShadowCaster`), and a replace that stops matching does not throw — it
  // silently hands back the shader unpatched and the deck goes back to shadowing itself. Nothing
  // headless renders, so what is checked is that the *emitted source* carries the offset.
  const sunk = sinkShadowCaster({});
  const stub = { vertexShader: (await import('three')).ShaderLib.depth.vertexShader, uniforms: {} };
  sunk.customDepthMaterial.onBeforeCompile(stub);
  if (!stub.vertexShader.includes(`mvPosition.z -= ${SHADOW_SINK.toFixed(4)}`)) {
    throw new Error('sinkShadowCaster: the depth patch did not land in the shader');
  }

  // ...and the overtake's (game/overtakeclip.js): the taxi starts behind the car in its own lane, is
  // out in the far one past it, and finishes back in its own lane in front of it; and the picker
  // finds a long enough street (side or ring) in the shipped cities.
  {
    const { reelAt, clipKeys, pickOvertakeStreet, CLIP_LOOP } = await import('../src/game/overtakeclip.js');
    const { REEL } = await import('../src/game/overtakereel.js');
    const leadAt = (t) => REEL.lead[Math.min(REEL.lead.length - 1, Math.round(t / REEL.step))];
    const start = reelAt(0);
    const end = reelAt(CLIP_LOOP);
    if (!(start.lateral > 0 && end.lateral > 0)) throw new Error('overtakeclip: does not start and finish in its own lane');
    if (!REEL.frames.some((f) => f[1] < 0)) throw new Error('overtakeclip: never pulls out');
    if (!(start.along < leadAt(0)[0] - REEL.frames[0][0] + start.along)) throw new Error('overtakeclip: does not start behind the car');
    if (!(REEL.frames.at(-1)[0] > REEL.lead.at(-1)[0])) throw new Error('overtakeclip: does not finish in front of the car');
    const k = clipKeys(CLIP_LOOP * 0.5);
    if (!(k.boost.lit && k.blip.lit && k.blip.down && !k.boost.down)) throw new Error('overtakeclip: keys wrong mid-loop');
    const { createLayout } = await import('../src/city/layout.js');
    const { cityNetwork } = await import('../src/city/roadnet.js');
    const { makeRng } = await import('../src/util/rng.js');
    const camRight = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      createLayout(makeRng(seed));
      if (!pickOvertakeStreet({ network: cityNetwork(), cars: [], camRight })) throw new Error(`overtakeclip: no street in city ${seed}`);
    }
  }

  // The New Move card's U-turn clip (game/uturnclip.js). Played back off the reel (whose match
  // with the sim is tools/uturnreel.mjs's job) it has to actually do the move — along the street in
  // its own lane, back the other way in the far one, half a turn — and the street picker has to find
  // somewhere to film it in the shipped city, and refuse a blocked one.
  {
    const { reelAt, clipKeys, pickStreet, CLIP_LOOP, TAP_2 } = await import('../src/game/uturnclip.js');
    const start = reelAt(0.2);
    const end = reelAt(TAP_2 + 1);
    if (!(start.lateral > 0 && end.lateral < 0)) throw new Error('uturnclip: the spin does not change lanes');
    if (Math.abs(end.yaw - start.yaw - Math.PI) > 0.05) throw new Error('uturnclip: not a half turn');
    if (!(reelAt(1).along > start.along && reelAt(CLIP_LOOP).along < end.along)) throw new Error('uturnclip: car does not drive out then back');
    const k = clipKeys(CLIP_LOOP * 0.5);
    if (!(k.boost.lit && k.brake1.lit && k.brake2.lit)) throw new Error('uturnclip: keys not all lit mid-loop');
    if (clipKeys(0).boost.lit) throw new Error('uturnclip: the loop opens with a key already lit');
    const { createLayout } = await import('../src/city/layout.js');
    const { cityNetwork } = await import('../src/city/roadnet.js');
    const { makeRng } = await import('../src/util/rng.js');
    const camRight = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
    // Three blocks of straight street is a lot to ask of a city with a river and parks in it.
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      createLayout(makeRng(seed));
      if (!pickStreet({ network: cityNetwork(), cars: [], camRight })) throw new Error(`uturnclip: no street in city ${seed}`);
    }
    createLayout(makeRng(7));
    const street = pickStreet({ network: cityNetwork(), cars: [], camRight });
    if (!street) throw new Error('uturnclip: no street to film in an empty city');
    if (street.forward.x * camRight.x + street.forward.z * camRight.z <= 0) throw new Error('uturnclip: street runs right to left');
    const parked = [{ x: street.centre.x, z: street.centre.z }];
    const again = pickStreet({ network: cityNetwork(), cars: parked, camRight });
    if (again && Math.hypot(again.centre.x - street.centre.x, again.centre.z - street.centre.z) < 1) {
      throw new Error('uturnclip: picked a street with a car parked on it');
    }
  }

  // The drift's clip (game/driftclip.js): the reel has to come up the approach in its own lane, go
  // round to the left and leave up the exit, on the keys' timeline; and the corner picker has to
  // find a corner in the shipped city whose turn is the recorded one, and refuse a blocked one.
  {
    const { reelAt, clipKeys, pickCorner, CLIP_LOOP, TAP } = await import('../src/game/driftclip.js');
    const { MOVES } = await import('../src/game/newmove.js');
    const start = reelAt(0);
    const end = reelAt(CLIP_LOOP);
    if (!(start.along < -20 && start.lateral > 0)) throw new Error('driftclip: does not come up the approach');
    if (!(end.lateral < -15 && Math.abs(end.along - 2) < 1)) throw new Error('driftclip: does not leave up the exit lane');
    if (Math.abs(end.yaw - start.yaw - Math.PI / 2) > 0.15) throw new Error('driftclip: not a left turn');
    if (!(reelAt(TAP).along < -4)) throw new Error('driftclip: the tap lands after the corner');
    const k = clipKeys(CLIP_LOOP * 0.7);
    if (!(k.boost.lit && k.brake.lit && k.kick.lit)) throw new Error('driftclip: keys not all lit late in the loop');
    if (clipKeys(0).boost.lit) throw new Error('driftclip: the loop opens with a key already lit');
    // Every key on each card's pedal row is one its clip presses.
    const { clipKeys: uturnKeys } = await import('../src/game/uturnclip.js');
    for (const [move, keys] of [[MOVES.uturn, uturnKeys(0)], [MOVES.drift, k]]) {
      for (const [name] of move.keys) if (!(name in keys)) throw new Error(`newmove: ${move.line} has no key ${name}`);
    }
    if (!(MOVES.drift.after > MOVES.uturn.after)) throw new Error('newmove: the drift is taught before the U-turn');
    const { createLayout } = await import('../src/city/layout.js');
    const { cityNetwork } = await import('../src/city/roadnet.js');
    const { makeRng } = await import('../src/util/rng.js');
    const camRight = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      createLayout(makeRng(seed));
      if (!pickCorner({ network: cityNetwork(), cars: [], camRight })) throw new Error(`driftclip: no corner in city ${seed}`);
    }
    createLayout(makeRng(7));
    const corner = pickCorner({ network: cityNetwork(), cars: [], camRight });
    if (!corner) throw new Error('driftclip: no corner to film in an empty city');
    const parked = [{ x: corner.centre.x, z: corner.centre.z }];
    const again = pickCorner({ network: cityNetwork(), cars: parked, camRight });
    if (again && Math.hypot(again.centre.x - corner.centre.x, again.centre.z - corner.centre.z) < 1) {
      throw new Error('driftclip: picked a corner with a car parked on it');
    }
  }

  // The depot's card (game/repairclip.js): the visit it acts has to never drive the car through a door that is not up, turn it round only while the door
  // is down to its gap, and leave it on the lane heading away; and the card is not a move.
  {
    const { scriptVisit, CLIP_REPAIR } = await import('../src/game/repairclip.js');
    const { REPAIR_GAP, entryPath } = await import('../src/game/opening.js');
    const { REPAIR, MOVES } = await import('../src/game/newmove.js');
    const { garageSite } = await import('../src/city/garage.js');
    const { TAXI_TAILPIPE_BACK } = await import('../src/geometry/taxi.js');
    const { createLayout } = await import('../src/city/layout.js');
    const { makeRng } = await import('../src/util/rng.js');
    if (REPAIR.keys.length) throw new Error('repairclip: the depot card has a pedal row');
    if (Object.values(MOVES).some((m) => m.seenKey === REPAIR.seenKey)) throw new Error('newmove: the depot card shares a move\'s seen flag');
    for (const seed of [1, 2, 3]) {
      const site = garageSite(createLayout(makeRng(seed)).garageBlock);
      const { frames, step } = scriptVisit(site);
      const swap = frames.findIndex((f) => f.repaired);
      if (swap < 0 || Math.abs(frames[swap].door - REPAIR_GAP) > 1e-6) throw new Error('repairclip: the car is turned round with the door not at its gap');
      const working = frames.filter((f) => f.work).length * step;
      if (Math.abs(working - CLIP_REPAIR) > 2 * step) throw new Error(`repairclip: the shop works ${working.toFixed(2)}s`);
      for (const f of frames) {
        const across = f.x - TAXI_TAILPIPE_BACK < site.curtainX && f.x + TAXI_TAILPIPE_BACK > site.curtainX
          && Math.abs(f.z - site.doorZ) < 2;
        if (across && f.door < 0.99) throw new Error(`repairclip: the car crosses the door at ${f.door.toFixed(2)} open (${f.phase})`);
      }
      const last = frames.at(-1);
      const mouth = entryPath(site).mouth;
      if (!(Math.abs(last.yaw + Math.PI / 2) < 1e-6 && last.z > site.doorZ + site.turnR && Math.abs(last.x - mouth.x) < 0.01)) {
        throw new Error('repairclip: does not leave up the lane');
      }
    }
    createLayout(makeRng(7));
  }

  // The crash replay's tape, played back rather than trusted (game/replay.js). Three things it
  // has to get right and none of them throws when it gets them wrong: a car moving between two
  // samples is drawn between them, a pool slot reused for a new particle *snaps* rather than flying
  // the particle in across the map, and the live frame comes back exactly when the replay hands
  // over. Plus the wreck it scrubs alongside: a struck car's shell must not exist before the impact.
  {
    const THREE = await import('three');
    const { createTape } = await import('../src/game/replay.js');
    const { createWreckage } = await import('../src/game/wreckage.js');
    const scene = new THREE.Scene();
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 2);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);
    const root = new THREE.Group();
    scene.add(root);
    const at = (i, x) => mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0, 0));
    const xOf = (i) => mesh.instanceMatrix.array[i * 16 + 12];
    const tape = createTape(scene, { roots: [root] });
    at(0, 0); at(1, 0); root.position.x = 0; tape.record(0);
    at(0, 1); at(1, 50); root.position.x = 2; tape.record(1 / 30);
    at(0, 7); at(1, 9); root.position.x = 9;
    tape.capture();
    tape.apply(1 / 60);
    const fail = [];
    if (Math.abs(xOf(0) - 0.5) > 1e-6) fail.push(`lerp drew ${xOf(0)} for 0.5`);
    if (xOf(1) !== 50) fail.push(`a 50-unit jump drew ${xOf(1)}, not a snap to 50`);
    if (Math.abs(root.position.x - 1) > 1e-6) fail.push(`node drew ${root.position.x} for 1`);
    tape.restore();
    if (xOf(0) !== 7 || xOf(1) !== 9 || root.position.x !== 9) fail.push('restore did not put the live frame back');
    // A struck car is retired to a zero matrix on the impact frame, whose sample is forced at t0,
    // and its shell only exists from t0 on. Nearest-sample hid the instance for the back half of
    // the gap before it, so the car blinked out just before every replay cut's blast.
    {
      const retire = createTape(scene, { roots: [] });
      at(0, 3);
      retire.record(0);
      mesh.setMatrixAt(0, new THREE.Matrix4().makeScale(0, 0, 0));
      retire.record(1 / 30, true);
      retire.apply(0.9 / 30);
      if (xOf(0) !== 3) fail.push('a retired instance vanished before the sample that retires it');
      retire.apply(1 / 30);
      if (!(mesh.instanceMatrix.array[0] === 0)) fail.push('a retired instance survived its own sample');
    }
    const wreckage = createWreckage();
    const shell = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    wreckage.take(shell, { hideBefore: true });
    wreckage.seek(-0.5);
    if (shell.visible) fail.push('a struck shell drew before its impact');
    wreckage.seek();
    if (!shell.visible) fail.push('seek() did not hand the shell back');
    if (fail.length) throw new Error(`replay tape: ${fail.join('; ')}`);
  }

  // The driver thrown through the windscreen (game/ejection.js). A closed form like the wreck, so
  // the same promises: stepped and scrubbed agree, it never goes through the road, it comes to rest
  // lying down, and it does not exist before the impact. Plus the one it got wrong at first: thrown
  // along the taxi's heading it could land inside a building, so a sweep of headings from a
  // junction must every one come to rest on the road.
  {
    const THREE = await import('three');
    const { createEjection } = await import('../src/game/ejection.js');
    const { GRID_I, GRID_J, blockBounds, lineX, lineZ } = await import('../src/city/grid.js');
    const scene = new THREE.Scene();
    const lands = [];
    const ej = createEjection(scene, { roadY: 0, onLand: (x, z, hard) => lands.push(hard) });
    ej.fire({ x: lineX(2), z: lineZ(3), yaw: 0, closing: 21, side: 1 });
    const fail = [];
    let low = Infinity;
    for (let n = 0; n < 180; n++) {
      ej.update(1 / 60);
      low = Math.min(low, ej.group.position.y);
    }
    const end = ej.group.position.clone();
    const reach = Math.hypot(end.x - lineX(2), end.z - lineZ(3));
    if (low < 0.25) fail.push(`dipped to y ${low.toFixed(2)}`);
    if (Math.abs(end.y - 0.3) > 1e-3) fail.push(`rests at y ${end.y.toFixed(3)}, not lying`);
    if (!(reach > 12 && reach < 20)) fail.push(`landed ${reach.toFixed(1)} units out down an open street`);
    const inBlock = (x, z) => {
      for (let bi = 0; bi < GRID_I; bi++) {
        for (let bj = 0; bj < GRID_J; bj++) {
          const b = blockBounds(bi, bj);
          if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) return true;
        }
      }
      return false;
    };
    for (let k = 0; k < 24; k++) {
      const probe = createEjection(new THREE.Scene(), { roadY: 0 });
      probe.fire({ x: lineX(2), z: lineZ(3), yaw: (k / 24) * Math.PI * 2, closing: 34, side: k % 2 ? 1 : -1 });
      let through = false;
      for (let n = 0; n < 180; n++) {
        probe.update(1 / 60);
        if (probe.group.position.y < 1 && inBlock(probe.group.position.x, probe.group.position.z)) through = true;
      }
      if (through) { fail.push(`heading ${k}/24 put the driver on a block`); break; }
    }
    if (lands.length < 2) fail.push(`${lands.length} landings announced`);
    ej.seek(0.4);
    const scrubbed = ej.group.position.clone();
    const replayed = createEjection(new THREE.Scene(), { roadY: 0 });
    replayed.fire({ x: lineX(2), z: lineZ(3), yaw: 0, closing: 21, side: 1 });
    for (let n = 0; n < 24; n++) replayed.update(1 / 60);
    if (scrubbed.distanceTo(replayed.group.position) > 1e-6) fail.push('seek(0.4) disagrees with stepping to 0.4');
    ej.seek(-0.1);
    if (ej.group.visible) fail.push('drew before the impact');
    ej.seek();
    if (!ej.group.visible || ej.group.position.distanceTo(end) > 1e-6) fail.push('seek() did not hand it back');
    if (fail.length) throw new Error(`ejection: ${fail.join('; ')}`);
  }

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
