/**
 * Every vehicle a wreck can strike, drawn through its own crash replay.
 *
 * The replay (game/replay.js) is a recording, and it can only play back what it recorded: the
 * fleet's instances, which it finds by walking the scene, and the groups somebody else draws a car
 * with, which it has to be told about. On the impact frame `wreckShell` hides whatever was drawing
 * the struck car and a shell takes over from t0 — so a vehicle whose group is not taped is missing
 * from the approach of every cut and pops in with its own fireball. That was the cruiser, then the
 * racer and the fire engine, each found by a player one at a time.
 *
 * So this crashes into every kind the city has and plays the replay back across the hit: something
 * car-sized has to be drawn where the struck vehicle is on every frame of it, before, at and after
 * the impact. A new kind of vehicle belongs in `KINDS`.
 *
 *   node tools/wreckreplay.mjs [seed]
 *   OLDROOTS=1 node tools/wreckreplay.mjs    # tape only the taxi — the control: it has to go red
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createLayout } from '../src/city/layout.js';
import { createBuildings } from '../src/city/buildings.js';
import { createTraffic, setClosedLanes } from '../src/sim/traffic.js';
import { setHazardLanes } from '../src/game/route.js';
import { createPolice } from '../src/sim/police.js';
import { createFire } from '../src/game/fire.js';
import { createRace } from '../src/game/race.js';
import { createTape } from '../src/game/replay.js';
import { createWreckage } from '../src/game/wreckage.js';
import { setCityOccluders, clearCityOccluders } from '../src/game/sightline.js';

const seed = Number(process.argv[2] ?? 71624);
let passed = 0;
let total = 0;
const check = (name, pass, detail = '') => {
  total += 1;
  if (pass) passed += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const layout = createLayout(makeRng(seed));
const buildings = createBuildings(makeRng(seed + 22), layout);
setClosedLanes([]);
setClosedLanes([], 'fire');
setCityOccluders(buildings.mesh);

const STEP = 1 / 60;
const scene = new THREE.Scene();
// A truck in every few, and a classic or two, so every body the fleet draws turns up.
const traffic = createTraffic(makeRng(seed + 712), scene, 24, 24, 0.2, 3, 0.15);
const police = createPolice(scene);
const fire = createFire({ rng: makeRng(seed + 713), scene, blocks: layout, traffic, soon: true });
const race = createRace({ rng: makeRng(seed + 714), scene, traffic, routeTo: () => false });
const tick = () => {
  traffic.update(STEP);
  fire.update(STEP);
  race.update(STEP);
  police.update(STEP);
};
for (let step = 0; step < 120; step++) tick();

// Anything drawn that is the size of a car body, centred within `R` of (x, z): a visible mesh (its
// whole ancestry visible, its material switched on) or a live instance, whose world box is at least
// BODY_LONG across and BODY_TALL high. Wheels, lamp pods and glass are all smaller than that, and
// road paint (a stop bar is 4 units wide) is flat — so neither a stale pod nor the street under the
// car can pass for it. R is under half the closest two cars ever stand (CAR_LEN plus a gap), so a
// neighbour cannot either.
const R = 1.2;
const BODY_LONG = 2.5;
const BODY_TALL = 0.6;
const m4 = new THREE.Matrix4();
const box = new THREE.Box3();
const size = new THREE.Vector3();
const centre = new THREE.Vector3();
function bodyAt(geo, matrix, x, z) {
  if (!geo.boundingBox) geo.computeBoundingBox();
  box.copy(geo.boundingBox).applyMatrix4(matrix);
  box.getSize(size);
  if (Math.max(size.x, size.z) < BODY_LONG || size.y < BODY_TALL) return false;
  box.getCenter(centre);
  return Math.hypot(centre.x - x, centre.z - z) < R;
}
function drawnAt(x, z) {
  scene.updateMatrixWorld(true);
  const found = [];
  scene.traverseVisible((o) => {
    if (!o.isMesh || o.material?.visible === false) return;
    if (o.isInstancedMesh) {
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m4);
        if (bodyAt(o.geometry, m4.premultiply(o.matrixWorld), x, z)) found.push(`${o.name || 'instanced'}#${i}`);
      }
    } else if (bodyAt(o.geometry, o.matrixWorld, x, z)) {
      found.push(o.name || 'mesh');
    }
  });
  return found;
}

// How each kind turns up on the road. Answers the car, or null. `lonely` keeps anybody else's body
// out of the radius, so it is the struck car being found and not its neighbour.
const lonely = (car) => traffic.cars.every((c) => c === car || Math.hypot(c.x - car.x, c.z - car.z) > 2 * R);
const ambient = (pred) => traffic.cars.find((c) => !c.isTaxi && !c.guest && !c.police && !c.crashed && pred(c) && lonely(c));
const KINDS = [
  { name: 'a car', find: () => ambient((c) => !c.isTruck) },
  { name: 'a truck', find: () => ambient((c) => c.isTruck) },
  {
    // A cop brought on and dressed in the cruiser's group, as game/patrol.js does it. Rammed, the
    // cruiser lets go of it itself (`shed`, off `crashed`, in police.update).
    name: 'the patrol cruiser',
    find: () => {
      if (!traffic.enterPolice(1)) return null;
      const car = traffic.policeCars[traffic.policeCars.length - 1];
      police.wear(car, traffic, { fade: false });
      return car;
    },
  },
  { name: 'the racer', find: () => (race.summon() ? race.state.car : null) },
  {
    name: 'the fire engine',
    find: () => {
      for (let step = 0; step < 60 * 60 && !fire.state.truck; step++) tick();
      return fire.state.truck ?? null;
    },
  },
];
// Sim seconds off the impact. The replay's cuts open 0.3 before it; the frames either side of t0
// are where every one of these bugs has lived.
const AGES = [-0.25, -0.1, -0.02, 0, 0.02, 0.1];

for (const kind of KINDS) {
  const car = kind.find();
  if (!car) { check(`${kind.name} turns up to be wrecked`, false); continue; }
  // The roots main.js hands the tape. OLDROOTS is the hand-kept list this replaced, minus the
  // cruisers: the control, so the check is seen to fail on the bug it is here for.
  const roots = process.env.OLDROOTS ? [traffic.taxiGroup] : traffic.drawnRoots;
  const tape = createTape(scene, { roots });
  // Two thirds of a second of run-up on tape, so even the earliest cut has samples to draw.
  const track = [];
  let t = 0;
  for (let step = 0; step < 40; step++) {
    tick();
    t += STEP;
    track.push({ t, x: car.x, z: car.z });
    tape.record(t);
  }
  // The impact frame, in main.js's order: the shell taken over, then the frame's sample, forced.
  const wreckage = createWreckage();
  const shell = traffic.wreckShell(car);
  wreckage.take(shell, { hideBefore: true });
  const t0 = t;
  tape.record(t0, true);
  for (let step = 0; step < 20; step++) {
    tick();
    wreckage.update(STEP);
    t += STEP;
    tape.record(t);
  }
  tape.capture();
  const missing = [];
  for (const u of AGES) {
    tape.apply(t0 + u);
    wreckage.seek(u);
    // The shell takes no drift here, so after the impact it lies where the car was at t0.
    const when = Math.min(t0, t0 + u);
    const at = track.reduce((best, p) => (Math.abs(p.t - when) < Math.abs(best.t - when) ? p : best));
    if (!drawnAt(at.x, at.z).length) missing.push(u);
  }
  tape.restore();
  wreckage.seek();
  check(`${kind.name} is drawn on every frame across its own wreck`, missing.length === 0,
    missing.length ? `nothing car-sized drawn at u = ${missing.join(', ')}` : '');
  shell.removeFromParent();
}
check('every skin was dressed through wearSkin, so the tape can see it',
  traffic.unrootedSkins() === 0, `${traffic.unrootedSkins()} render passes drew an untaped skin`);

setClosedLanes([], 'fire');
setHazardLanes([]);
clearCityOccluders();

console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
