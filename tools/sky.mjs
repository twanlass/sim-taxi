/**
 * Headless probe for the sky: the day/night curve, the weather director, and everything the two
 * of them switch on and off.
 *
 * Its own tool rather than more of probe.mjs because what it asserts is a different kind of thing.
 * probe.mjs asks whether the simulation is *correct* — nobody ran a red, no two cars are in the
 * same place. This asks whether the game is still **playable to look at**: that midnight is never
 * darker than the floor, that a downpour at 2am still has a moon and a set of headlights in it,
 * that the weather actually moves through its types rather than parking on one, and that no
 * transition is a jump.
 *
 * The floor in particular is the assertion that matters. Every darkening influence in the game is
 * a multiplier, and multipliers compose: night × overcast × fog is three of them, and the reason
 * that combination cannot black the city out is a single clamp in daylight.js — which is worth
 * exactly as much as the test that says it is still there.
 *
 *   node tools/sky.mjs
 */

import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createScene } from '../src/game/scene.js';
import { createDaylight, DAY_SECONDS, VISIBILITY_FLOOR } from '../src/game/daylight.js';
import { createWeather, WEATHER_NEXT, WEATHER_TYPES } from '../src/game/weather.js';
import { createNightLights } from '../src/game/nightlights.js';
import { createLayout } from '../src/city/layout.js';
import { createGround } from '../src/city/ground.js';
import { createBuildings } from '../src/city/buildings.js';
import { createProps } from '../src/city/props.js';
import { createTraffic } from '../src/sim/traffic.js';

const seed = Number(process.argv[2] ?? 71624);
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const world = createScene();
const { scene, sun, moon, hemi } = world;

const layout = createLayout(makeRng(seed));
const ground = createGround(makeRng(seed + 11), layout);
const buildings = createBuildings(makeRng(seed + 22), layout, makeRng(seed + 202));
const props = createProps(makeRng(seed + 33), layout, makeRng(seed + 203));
scene.add(ground);
scene.add(buildings.mesh);
scene.add(props.mesh);

const nightLights = createNightLights(scene, { windows: buildings.windows, glow: props.glow });
const traffic = createTraffic(makeRng(seed + 44), scene, 12);

const daylight = createDaylight(world);
// The camera only has to say where it is looking — the precipitation field wraps around that
// point. A stub keeps this tool free of anything that needs a viewport.
const camera = { state: { target: new THREE.Vector3() } };
const weather = createWeather({ scene, ground, daylight, camera, rng: makeRng(seed + 144) });

// --- The curve itself --------------------------------------------------------

const at = (hour) => { daylight.apply(hour); return daylight.look(); };

weather.setCycling(false);
weather.setType('clear', { instant: true });

const noon = at(13);
const midnight = at(0);

check('the sun is out at midday', noon.power > 3, `sun ${noon.power.toFixed(2)}`);
check('the sun is down at midnight', midnight.power < 0.05, `sun ${midnight.power.toFixed(2)}`);
check('the moon takes over at night', midnight.moon > 0.9 && noon.moon === 0,
  `moon ${noon.moon.toFixed(2)} at noon, ${midnight.moon.toFixed(2)} at midnight`);
// The moon has to light the faces the camera can *see*. This view stands at (+X, +Y, +Z), so
// every visible wall has a +X or a +Z normal — and the first version of the arc put the moon
// opposite the sun, where a real moon goes, which lit the far side of every building and rendered
// a night of black boxes standing in bright pools of street light. Asserted as a direction rather
// than as an elevation, because the elevation was never the thing that was wrong.
let dimmestFace = Infinity;
let dimmestFaceAt = '';
let flatMoon = 0;
const moonDir = new THREE.Vector3();
for (const h of [19, 20.5, 22, 0, 2, 4, 5]) {
  daylight.apply(h);
  moonDir.copy(moon.position).normalize();
  // The brighter of the two faces the camera can see. One of them being in shadow is the point of
  // having a directional light at all; *both* of them being in shadow is the bug.
  const best = Math.max(moonDir.x, moonDir.z);
  if (best < dimmestFace) { dimmestFace = best; dimmestFaceAt = `${h}h`; }
  // And it must not be straight overhead, or every wall goes flat and only the roofs are lit.
  if (moonDir.y > 0.82) flatMoon += 1;
}
check('the moon lights the faces the camera can see', dimmestFace > 0.3,
  `weakest lit face ${dimmestFace.toFixed(2)} at ${dimmestFaceAt}`);
check('the moon rakes rather than sitting overhead', flatMoon === 0,
  `${flatMoon} night hours with the moon straight up`);
daylight.apply(0);
check('the city lights are on at night and off at midday',
  midnight.lit > 0.99 && noon.lit < 0.01,
  `lit ${noon.lit.toFixed(2)} at noon, ${midnight.lit.toFixed(2)} at midnight`);

// Both dusk and dawn have to be a ramp rather than a switch — a city whose lights all arrive in
// one frame reads as a bug. 18:00 → 21:00 is the interesting window.
let duskSteps = 0;
let prevLit = at(18).lit;
for (let h = 18.1; h <= 21; h += 0.1) {
  const l = at(h).lit;
  if (l > prevLit + 1e-6) duskSteps += 1;
  prevLit = l;
}
check('the lights come up over dusk rather than snapping on', duskSteps > 12,
  `${duskSteps} increasing steps between 18:00 and 21:00`);

// --- The visibility floor ----------------------------------------------------
//
// The whole day against every kind of weather. This is the sweep the floor exists for.

let worstTotal = Infinity;
let worstAt = '';
let worstDirectional = Infinity;
let worstDirectionalAt = '';
let unlitDark = 0;

for (const type of WEATHER_TYPES) {
  weather.setType(type, { instant: true });
  for (let h = 0; h < 24; h += 0.05) {
    daylight.apply(h);
    weather.update(1 / 60);
    const total = sun.intensity + moon.intensity + hemi.intensity;
    if (total < worstTotal) { worstTotal = total; worstAt = `${type} @ ${h.toFixed(1)}h`; }
    // A directional term is what gives every surface a lit side. Ambient fill alone is a flat
    // wash that turns the city into a silhouette, so the darkest hours are checked for one.
    const directional = sun.intensity + moon.intensity;
    if (directional < worstDirectional) {
      worstDirectional = directional;
      worstDirectionalAt = `${type} @ ${h.toFixed(1)}h`;
    }
    // And the hours that are genuinely dark have to have the city's own lights up.
    if (directional < 0.9 && daylight.lit() < 0.35) unlitDark += 1;
  }
}

check('nothing the weather can do puts the city under the floor',
  worstTotal >= VISIBILITY_FLOOR - 1e-6,
  `worst ${worstTotal.toFixed(2)} (floor ${VISIBILITY_FLOOR}) at ${worstAt}`);
check('there is always a light with a direction to it', worstDirectional > 0.35,
  `worst ${worstDirectional.toFixed(2)} at ${worstDirectionalAt}`);
check('no dark hour is left without the city\'s own lights', unlitDark === 0,
  `${unlitDark} samples dark with the lights still down`);

// The floor is a backstop, not the design. If it is doing work on an ordinary night the keyframes
// are wrong, so check the two worst *realistic* cases land above it on their own.
weather.setType('rain', { instant: true });
const wetMidnight = at(0);
weather.setType('fog', { instant: true });
const foggyMidnight = at(0);
check('a midnight downpour clears the floor without the clamp',
  wetMidnight.moon + wetMidnight.fill > VISIBILITY_FLOOR + 0.2,
  `rain ${(wetMidnight.moon + wetMidnight.fill).toFixed(2)}, fog ${(foggyMidnight.moon + foggyMidnight.fill).toFixed(2)}`);

// --- Weather, as a machine ---------------------------------------------------

weather.setType('clear', { instant: true });
weather.setCycling(true);
daylight.setCycling(true);

// Reachability is a property of the successor table, not of a soak: a type that nothing leads to
// would only show up in a run long enough to have missed it, and "run it longer until it passes"
// is not a test. BFS the graph instead, and let the soak below check pace and continuity.
const unreachable = [];
for (const start of WEATHER_TYPES) {
  const found = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const [name] of WEATHER_NEXT[queue.shift()]) {
      if (!found.has(name)) { found.add(name); queue.push(name); }
    }
  }
  for (const name of WEATHER_TYPES) if (!found.has(name)) unreachable.push(`${start}→${name}`);
}
check('every kind of weather can be reached from every other', unreachable.length === 0,
  unreachable.slice(0, 4).join(', '));

// Two soaks. A short one at the frame loop's own 1/60 measures continuity — the per-frame step is
// only meaningful at the rate the game actually runs. A long one at the loop's dt clamp (0.05,
// the worst step the game will ever take) measures pace, which needs in-game hours to say anything.
let biggestJump = 0;
let prevSun = weather.state.blend.sun;
for (let step = 0; step < 60 * 120; step++) {
  daylight.update(1 / 60);
  weather.update(1 / 60);
  const s = weather.state.blend.sun;
  biggestJump = Math.max(biggestJump, Math.abs(s - prevSun));
  prevSun = s;
}

const seen = new Set();
let fogBad = 0;
let transitions = 0;
let prevName = weather.current();
const SOAK = 1800;              // seconds of weather, ~10 in-game days
for (let step = 0; step < SOAK / 0.05; step++) {
  daylight.update(0.05);
  weather.update(0.05);
  seen.add(weather.current());
  if (weather.current() !== prevName) { transitions += 1; prevName = weather.current(); }
  if (scene.fog && !(scene.fog.near < scene.fog.far)) fogBad += 1;
}

check('the weather actually moves through its kinds', seen.size >= 4,
  `${[...seen].sort().join(', ')}`);
// A range, not a floor. Too few means it parked; too many means a hold that isn't holding — which
// is exactly the bug this caught, where `hold` was never re-armed and every change ran straight
// into the next. One cycle is TRANSITION + hold, so 30 minutes allows 21 at the slowest and 42 at
// the fastest; the bounds are those with room either side.
check('it keeps changing, at the pace it is supposed to',
  transitions >= 18 && transitions <= 48,
  `${transitions} changes in ${SOAK / 60} minutes`);
// The whole blend takes TRANSITION seconds, so the per-frame step is bounded by the largest gap
// between two profiles over 12s * 60fps. Anything near a tenth means something jumped.
check('no weather change is a jump', biggestJump < 0.02,
  `biggest one-frame change in the sun multiplier ${biggestJump.toFixed(4)}`);
check('fog is always a valid range', fogBad === 0, `${fogBad} frames with near >= far`);

weather.setCycling(false);
weather.setType('clear', { instant: true });
weather.update(1 / 60);
check('clear weather has no fog at all', scene.fog === null);
weather.setType('fog', { instant: true });
weather.update(1 / 60);
check('fog fades the far edge of the city, not the near one',
  Boolean(scene.fog) && scene.fog.near > 300 && scene.fog.far > scene.fog.near,
  scene.fog ? `near ${scene.fog.near.toFixed(0)}, far ${scene.fog.far.toFixed(0)}` : 'no fog');

// --- Rain, snow and wet tarmac -----------------------------------------------

const drops = () => weather.precip.rain.count;
const flakes = () => weather.precip.snow.count;

weather.setType('rain', { instant: true });
weather.update(1 / 60);
const rainDrops = drops();
const rainWet = ground.material.color.r;
check('rain puts rain in the air', rainDrops > 900 && flakes() === 0,
  `${rainDrops} drops, ${flakes()} flakes`);
check('rain darkens the road', rainWet < 0.75, `ground tint ${rainWet.toFixed(2)}`);

weather.setType('snow', { instant: true });
weather.update(1 / 60);
check('snow puts snow in the air', flakes() > 400 && drops() === 0,
  `${drops()} drops, ${flakes()} flakes`);

weather.setType('clear', { instant: true });
weather.update(1 / 60);
check('clear weather has neither', drops() === 0 && flakes() === 0);
check('the road dries out again', ground.material.color.r > 0.99,
  `ground tint ${ground.material.color.r.toFixed(2)}`);

// Drops have to be inside the field around whatever the camera is looking at, or a pan leaves the
// weather behind. Move the focus a long way and step until the field has caught up.
camera.state.target.set(60, 0, -40);
weather.setType('rain', { instant: true });
for (let step = 0; step < 4; step++) weather.update(1 / 60);
let outside = 0;
const m = new THREE.Matrix4();
for (let i = 0; i < weather.precip.rain.count; i++) {
  weather.precip.rain.getMatrixAt(i, m);
  if (Math.abs(m.elements[12] - 60) > 90 || Math.abs(m.elements[14] + 40) > 90) outside += 1;
}
check('the rain field follows the camera', outside === 0,
  `${outside} drops left behind after a 72-unit pan`);
camera.state.target.set(0, 0, 0);

// --- What the night switches on ----------------------------------------------

weather.setType('clear', { instant: true });
daylight.setCycling(false);

daylight.apply(13);
weather.update(1 / 60);
nightLights.setLit(daylight.lit());
traffic.setLit(daylight.lit());
const dayWindows = nightLights.group.visible;
const dayHeadlights = traffic.lightMesh.visible;

daylight.apply(1);
weather.update(1 / 60);
nightLights.setLit(daylight.lit());
traffic.setLit(daylight.lit());
check('the city\'s lights are off in daylight and on at night',
  !dayWindows && nightLights.group.visible);
check('headlights are off in daylight and on at night',
  !dayHeadlights && traffic.lightMesh.visible && traffic.taxiLights.visible);
check('the city has windows to light and lamps to light them with',
  buildings.litWindows > 80 && props.lamps > 40,
  `${buildings.litWindows} lit panes, ${props.lamps} lamps`);

// A rainy afternoon has to have its headlights on — that is most of what sells the rain, and it
// is the one case that is not a function of the hour.
weather.setType('rain', { instant: true });
daylight.apply(15);
weather.update(1 / 60);
check('a downpour turns the headlights on in the afternoon', daylight.lit() > 0.5,
  `lit ${daylight.lit().toFixed(2)} at 15:00 in the rain`);

// --- The headlight rig's pose ------------------------------------------------
//
// The rig rides an upright matrix rather than the car body's, so a car leaning through a corner
// doesn't swing its beam under the road. That is invisible in a screenshot until it is wrong, so
// it is asserted here: every light matrix must be level and sitting on the road.

traffic.warmup(60);
let tilted = 0;
let offRoad = 0;
const rigMatrix = new THREE.Matrix4();
const rigPos = new THREE.Vector3();
const rigQuat = new THREE.Quaternion();
const rigScale = new THREE.Vector3();
const euler = new THREE.Euler();
for (const car of traffic.cars) {
  if (car.isTaxi || car.crashed) continue;
  traffic.lightMesh.getMatrixAt(car.instanceIndex, rigMatrix);
  rigMatrix.decompose(rigPos, rigQuat, rigScale);
  euler.setFromQuaternion(rigQuat, 'YXZ');
  if (Math.abs(euler.x) > 1e-6 || Math.abs(euler.z) > 1e-6) tilted += 1;
  if (Math.abs(rigPos.x - car.x) > 1e-4 || Math.abs(rigPos.z - car.z) > 1e-4) offRoad += 1;
}
check('every headlight rig is level', tilted === 0, `${tilted} rigs pitched or rolled`);
check('every headlight rig is on its car', offRoad === 0, `${offRoad} rigs adrift`);

// A wrecked car's lights go out with it — otherwise a pair of beams is left on the road pointing
// at nothing after the shell has been handed to the wreck effects.
const victim = traffic.cars.find((c) => !c.isTaxi && !c.crashed);
traffic.wreckShell(victim);
traffic.lightMesh.getMatrixAt(victim.instanceIndex, rigMatrix);
rigMatrix.decompose(rigPos, rigQuat, rigScale);
check('a wreck takes its headlights with it', rigScale.length() < 1e-6,
  `scale ${rigScale.length().toFixed(3)}`);

console.log(`\nday length ${DAY_SECONDS}s · ${WEATHER_TYPES.length} weather types · `
  + `worst illumination ${worstTotal.toFixed(2)} vs floor ${VISIBILITY_FLOOR}`);

const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
