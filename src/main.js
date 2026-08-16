import * as THREE from 'three';
import { makeRng } from './util/rng.js';
import { createScene } from './game/scene.js';
import { createCityCamera, attachDragPan, VIEW_DIR, PLAY_ZOOM } from './game/camera.js';
import { createLayout } from './city/layout.js';
import { createGround } from './city/ground.js';
import { createBuildings } from './city/buildings.js';
import { createProps } from './city/props.js';
import { createGarage } from './city/garage.js';
import { createTraffic, placeCar, TRUCK_CHANCE, laysPassRubber, BOOST_CRUISE } from './sim/traffic.js';
import { createCollisions } from './sim/collisions.js';
import { createPolice, POLICE_BUST_RANGE } from './sim/police.js';
import { createFareSystem, cornerFor, setFareSeconds, getFareSeconds, isFareClockPinned } from './game/fares.js';
import { createDebugPanel } from './game/debugpanel.js';
import { createBoost, BOOST_FARE_REWARD, BOOST_PARCEL_REWARD } from './game/boost.js';
import { createBoostMeter } from './game/boostmeter.js';
import { flyEnergyToBoost } from './game/energybits.js';
import { createSkidMarks } from './game/skidmarks.js';
import { createDust } from './game/dust.js';
import { createCityEntry } from './game/cityentry.js';
import { createBlast } from './game/blast.js';
import { createFlames } from './game/flames.js';
import { createVanish } from './game/vanish.js';
import { createFlyover } from './game/flyover.js';
import { createChopper } from './game/chopper.js';
import { createBirds } from './game/birds.js';
import { createCarGhosts } from './game/carghosts.js';
import { createRoadwork } from './game/roadwork.js';
import { showRunEnd } from './game/runend.js';
import { recordRun, lastName, clearScores, loadScores } from './game/highscores.js';
import {
  TAXI_TAILPIPE_BACK, TAXI_TAILPIPE_HEIGHT, TAXI_REAR_AXLE_BACK, TAXI_REAR_TRACK,
} from './geometry/taxi.js';
import { createDaylight, DAY_SECONDS } from './game/daylight.js';
import { createPicker } from './game/pick.js';
import { createRiderFinder } from './game/riderfinder.js';
import { createTaxiFinder } from './game/taxifinder.js';
import { createCargoChip } from './game/cargochip.js';
import { createTutorial } from './game/tutorial.js';
import { createOpening } from './game/opening.js';
import { createDropoffIndicator } from './game/dropoffindicator.js';
import { createSirenGlow } from './game/sirenglow.js';
import { createRouteLine, routePath, pointAlongPath } from './game/routeline.js';
import { createAmbientOcclusion, markOccluder } from './game/ssao.js';
import { setAmbientOcclusion } from './util/geo.js';
import * as difficulty from './game/difficulty.js';
import { createHomeScreenTip } from './game/homescreen.js';
import { createPause } from './game/pause.js';
import { findRoute, findRouteVia, planOrigin } from './game/route.js';
import { createPathDrag } from './game/pathdrag.js';
import { getActiveShot, getSeed, getRunSeed, getCarCount, getDifficultyPin, getAmbientOcclusion,
  getSafeMode, safeModeSource, getMsaa, getShadowMapSize, getPixelRatioCap,
  getDiagnostics, getParcelsPin } from './util/shot.js';
import { createParcelSystem, TAP_MAX_DETOUR } from './game/parcels.js';
import { popHighlight, POP_TIME } from './game/selectpop.js';
import { createDiagnostics } from './game/diag.js';
import { createViewport } from './util/viewport.js';
import { attachContextRecovery } from './game/recovery.js';
import { isCityConnected, GRID } from './city/grid.js';
import { cityNetwork } from './city/roadnet.js';
import { PALETTE } from './palette.js';

// Caches the app shell so a Home Screen launch still opens with no connection — see public/sw.js.
// Skipped under `npm run dev`: Vite's dev server rewrites module URLs on every change, and a
// worker caching those responses would serve stale code back at the page mid-session. Production
// (`npm run build` + `preview`, or the real deploy) is a static bundle, which is what the worker
// is for.
if (!import.meta.env.DEV && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}

const shot = getActiveShot();
// A fresh city every load. `?seed=N` still pins one you want to replay, and shot mode always
// pins to a known layout so screenshots stay comparable. On the ~1-in-a-lot chance a random
// pair of park closures makes some corner unreachable, reroll until the router can plan any
// (from, to) — the fare loop depends on that never being false.
let seed = getSeed({ deterministic: Boolean(shot) });
let layout;
let attempts = 0;
while (true) {
  attempts += 1;
  layout = createLayout(makeRng(seed));
  if (isCityConnected()) break;
  if (attempts > 32) throw new Error('city seed generator kept producing disconnected layouts');
  seed = (Math.random() * 0xffffffff) >>> 0;
}
const runSeed = getRunSeed(seed, Boolean(shot));    // this run's situation — random unless pinned
// The courier layer: on in an ordinary run, off in shot mode, and `?parcels=0`/`?parcels=1` beats
// both — see getParcelsPin for why the default is not a constant.
const parcelsEnabled = getParcelsPin() ?? !shot;

// `?d=0..1` freezes the difficulty curve, so the late game can be looked at without playing ten
// fares to reach it. Applied before anything constructs, because the car count is read off the
// curve and the fare system budgets its first clock from it.
//
// A shot that is *about* a point on the curve carries its own pin, so `./shots.sh` reproduces it
// without every caller having to remember the query parameter. An explicit `?d=` still wins.
difficulty.pinDifficulty(getDifficultyPin() ?? shot?.difficulty ?? null);

// What this page asks a GPU for, gathered in one place so it can be read off the diagnostics
// panel and turned down from the address bar. `?safe` sets all four at their cheapest at once and
// each individual flag still overrides it — see the long note in `util/shot.js` for why a device
// that renders nothing can only be bisected this way.
const budget = {
  safe: getSafeMode(),
  // 'url' | 'android' | null — see `safeModeSource`. The panel reports it, because a budget the
  // player asked for and one the platform default imposed are different things to be looking at.
  safeSource: safeModeSource(),
  msaa: getMsaa(),
  shadowMapSize: getShadowMapSize(),
  pixelRatioCap: getPixelRatioCap(),
  ao: getAmbientOcclusion(),
};

const renderer = new THREE.WebGLRenderer({
  antialias: budget.msaa,
  // Three defaults the stencil buffer OFF since r163. The taxi's ghost outline stamps its mask
  // into it every frame (see geometry/ghostoutline.js); without the buffer the stencil test
  // silently passes everywhere and the "outline" fills the whole hull. Asked for regardless of
  // `?msaa` — the two ride in the same back buffer but they are not the same request, and a run
  // with multisampling off should still get its outlines.
  stencil: true,
  preserveDrawingBuffer: Boolean(shot),
});
// NOT `window.innerWidth/innerHeight`: on an installed iOS app those stop short of the physical
// bottom of the screen, and the strip the canvas doesn't cover shows as bare sky under the game.
// See util/viewport.js for the measurement that is actually right.
const viewport = createViewport();
renderer.setPixelRatio(Math.min(window.devicePixelRatio, budget.pixelRatioCap));
renderer.setSize(viewport.width(), viewport.height());
renderer.shadowMap.enabled = budget.shadowMapSize > 0;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Ambient occlusion is decided here, before a single mesh exists, because `propMaterial()` bakes
// the decision into the shader it builds — see `util/geo.js`. `?ao=off` turns it off for a
// like-for-like cost comparison on a real device.
const aoEnabled = budget.ao;
setAmbientOcclusion(aoEnabled);
const ao = createAmbientOcclusion(renderer, { enabled: aoEnabled });

// `?diag`. A no-op without the flag; with it, the one readout that can tell a lost context from a
// scene that submitted nothing from a scene that drew and came out black. See `game/diag.js`.
const diag = createDiagnostics(renderer, { enabled: getDiagnostics(), flags: budget });

const { scene, sun, hemi, sky, fog } = createScene({ shadowMapSize: budget.shadowMapSize });

// A GPU that takes the context away gets the budget turned down rather than the player getting a
// black screen for the rest of the run — see `game/recovery.js` for the two steps and why the
// split between them is where it is. Attached after the sun exists, since step one shrinks its
// shadow map.
attachContextRecovery({ renderer, sun, budget, onNotice: (text) => diag.note(text) });

/**
 * The one place the frame is drawn. Three callers reach it — the live loop, shot mode's single
 * render, and `__taxi.redraw()` — and the AO prepass has to run before every one of them or a
 * frozen shot renders against whatever the previous frame left in the texture.
 *
 * The main render is untouched by the pass in front of it: still the default framebuffer, still
 * its own MSAA, still its own stencil buffer for the ghost outlines.
 */
function renderFrame() {
  ao.render(scene, camera);
  renderer.render(scene, camera);
}

// The clock that drives the sky. Parked at golden hour for now — the cycle works, but the night
// end of it needs more tuning before it earns its place, so it's off until the ⚙️ panel turns it
// on. Screenshots keep it frozen regardless: a rendered shot has to be reproducible.
const daylight = createDaylight({ sun, hemi, sky, fog });
daylight.setDayLength(DAY_SECONDS);
daylight.setCycling(false);

// Every generator draws from its own stream so that changing one system doesn't reshuffle the
// others — editing building code shouldn't move the parks. `layout` was already produced above
// so the connectivity guard could reroll before we spent time meshing.
// `markOccluder` is what puts a mesh into the AO depth prepass. The rule it enforces is that
// anything lit by `propMaterial()` has to be in there: a mesh that receives AO without casting it
// samples the occlusion of whatever stands behind it. See `game/ssao.js`.
scene.add(markOccluder(createGround(makeRng(seed + 11), layout)));
// Held onto for its `pad`: exactly one roof in the city carries a landing circle, and the
// helicopter below has to be told which one — see `choosePad` in city/buildings.js.
const city = createBuildings(makeRng(seed + 22), layout);
scene.add(markOccluder(city.mesh));
// Held onto for the entrance animation below — the trees rise out of the parks the same way the
// buildings rise out of their lots.
const propsMesh = createProps(makeRng(seed + 33), layout);
scene.add(markOccluder(propsMesh));

// The taxi's garage — the block `createLayout` took out of the tower generator's hands, and the
// subject of the opening vignette below. `null` on a city with nowhere to put one, which is a
// state the whole chain below handles rather than one to guard against here: no depot, no
// vignette, and the run opens the way it always did. See city/garage.js.
const garage = layout.garageBlock ? createGarage(layout.garageBlock, makeRng(seed + 99)) : null;
if (garage) {
  scene.add(garage.group);
  garage.meshes.forEach(markOccluder);
}

// Density is on the difficulty curve, so the run opens at its bottom and the instanced meshes are
// sized for its top — an InstancedMesh cannot be resized once built. An explicit `?cars=N` beats
// the curve at both ends, the way `?seed=` beats a random city: a pinned density is a pinned
// density, and a tool that asked for one car should get one car for the whole run.
const pinnedCars = getCarCount(null);
const traffic = createTraffic(
  makeRng(runSeed + 44), scene,
  pinnedCars ?? difficulty.carCount(0),
  pinnedCars ?? difficulty.carCount(Infinity),
  TRUCK_CHANCE,
);
// `reserved` is how the fare loop learns about the courier's corners without importing it. `parcels`
// is declared just below and this closure is only ever *called* from the frame loop, long after — the
// same forward reference `pathDrag`'s `canGrab` makes to `pause`.
const fares = createFareSystem(makeRng(runSeed + 55), scene, {
  reserved: () => parcels?.occupiedSpots() ?? [],
});
// The package courier — see game/parcels.js. Its own stream off the run seed, so adding this layer
// does not reshuffle where every rider spawns. `?parcels=0` turns it off.
//
// 255 rather than the 233 this shipped on: the helicopter landed on main using 233 too, and the merge
// resolved both files cleanly while leaving two systems drawing the *same* sequence — `makeRng` is
// seeded, so equal offsets are not independent streams, they are identical ones. `tools/probe.mjs`
// now asserts every offset in this file is distinct, because nothing about the collision was visible:
// no crash, no failing check, just a package board silently correlated with a helicopter.
const parcels = parcelsEnabled ? createParcelSystem(makeRng(runSeed + 255), scene) : null;
// Sim time the taxi's flourish was stamped at, or null when it is not running. See the frame loop —
// it lights the whole car for the length of a select pop.
//
// Two things fire it, and they are the same claim about the car: *this one, here*. A courier box
// landing in it is an acknowledgement that the thing arrived; the camera riding back to it (see
// `panToTaxi`) is a player who had lost the car being handed it again, at the moment it lands in
// frame. Reusing one flourish rather than inventing a second is the point — the player learns the
// gesture once.
let taxiFlashAt = null;
const flashTaxi = () => { taxiFlashAt = fares.state.elapsed; };
// Given the cars array so the cruiser can see who is in its lane and move over for them — see
// DODGE_* in sim/police.js. It never mutates it.
const police = createPolice(makeRng(runSeed + 66), scene, traffic.cars);
// The vehicles, so a car reads as sitting *on* the road rather than pasted over it. The stop bars
// are left out deliberately — they are 0.05-unit road paint, and their own outline is not a
// contact. The ghost outlines hung off the taxi are filtered out inside `markOccluder`.
markOccluder(traffic.mesh);
markOccluder(traffic.wheelMesh);
markOccluder(traffic.truckMesh);
markOccluder(traffic.truckWheelMesh);
markOccluder(traffic.truckBoxMesh);
markOccluder(traffic.taxiGroup);
markOccluder(police.group);
// The riders. They receive AO through `propMaterial()` either way, so leaving them out of the
// prepass would paint the kerb's own contact line across whoever is standing in front of it.
// Only the figure is taken — `markOccluder` filters out the translucent target disc under them.
for (const slot of fares.slots) markOccluder(slot.passenger.group);
// One fixed 3/4 framing of the whole city, plus drag-to-pan. The framing is still the default and
// the game is playable without ever touching it on a desktop — but in portrait the frustum is
// sized by height, so a phone cuts off both sides of the map and panning stops being optional.
const aspect = () => viewport.width() / viewport.height();
const controller = createCityCamera(aspect(), {
  zoom: shot?.zoom ?? PLAY_ZOOM,
  target: shot?.target ?? [0, 0],
});
const { camera } = controller;
controller.update(aspect());

// Below this viewport width the frustum is sized by height, so the city runs off both sides and
// the fixed framing stops working — that's where drag-to-pan and boost-follow earn their keep.
// Above it (any typical desktop or landscape tablet) the whole city already fits, so both would
// only move things around for no reason. Live viewport width rather than a media query lets a
// resize flip modes without a reload.
const NARROW_VIEWPORT = 768;
const isNarrow = () => viewport.width() < NARROW_VIEWPORT;

// The camera trails the taxi from the first frame of the run, and keeps doing it until the player
// takes the framing over — a swipe, or a tap on a rider-finder chip. Both are the player saying
// where they want to look, and a camera that slides back off it is fighting them.
//
// It exists for the same reason the boost-follow does: on a narrow viewport the fixed framing has
// already given up, so a run opens with the taxi somewhere off-screen and the player's first job is
// hunting for their own car. The follow is *gentler* than the boost's 3.2 — this one is ambient and
// runs for as long as the player leaves it alone, where the boost chase is a burst that ends with
// the button. At 1.5 the camera reads as drifting after the taxi rather than locked to it, and a
// turn at the edge of frame doesn't whip the city round.
//
// Narrow only, like the boost-follow: on a desktop the whole city is in frame at all times, and
// drag-to-pan is switched off there — so a follow would slide the map around under a player with
// no way to stop it.
const START_FOLLOW_SMOOTHING = 1.5;
const BOOST_FOLLOW_SMOOTHING = 3.2;

/**
 * What both follows aim past the taxi at — the heading it is travelling, and how much of the lead
 * that heading has earned. See camera.js's LEAD_FRACTION for the framing itself.
 *
 * The strength is the speed against the Loco Mode cruise ceiling, which is what makes one number
 * serve both follows: at the boost top the frame is fully open ahead, at ordinary cruise it is
 * about 45% of that, and a taxi held at a red drops back to centred — where there is no "ahead" to
 * look down and the player is reading the junction they are sitting in. It also means the two
 * follows never fight over the framing at the moment Loco Mode engages: the offset is already
 * part-way out, and the press extends it rather than starting it.
 *
 * `car.yaw` is a sim yaw, not a bearing — forward is `(cos yaw, -sin yaw)`, as everywhere else that
 * reads it (see the wreck's tyre fan).
 */
const followAim = (car) => ({
  x: Math.cos(car.yaw),
  z: -Math.sin(car.yaw),
  gain: Math.min(car.v / BOOST_CRUISE, 1),
  speed: car.v,
});

let cameraTakenOver = false;
// Assigned further down, once the fare board and the picker it reads exist. Declared here because
// the handover below is the one thing that has to reach it, and a swipe cannot arrive before the
// module has finished evaluating.
let tutorial = null;
// The opening vignette, built at the very bottom of this file: it has to be constructed *after*
// the traffic warm-up, because the first thing it does is take the taxi off the road and park it
// in the garage, and the warm-up would drive it straight back out. Null in shot mode and on a
// city with no depot. See game/opening.js.
let opening = null;
const releaseCameraToPlayer = () => {
  cameraTakenOver = true;
  // A swipe during the tutorial takes the framing off it too. It keeps talking — the lesson is
  // still worth reading — it just stops moving the map while the player reads it.
  tutorial?.releaseCamera();
};

// Screenshots frame themselves, and a shot run has no user to drag anything.
const pan = shot
  ? null
  : attachDragPan(controller, renderer.domElement, aspect, isNarrow, releaseCameraToPlayer);

const dust = createDust(scene, camera, makeRng(seed + 77));

// The city's entrance: buildings and trees rise out of the ground in a wave that spreads from the
// taxi's spawn — the run starts where the player's car is, and the city builds itself outward from
// them — with a puff of dust off each building's footprint as it lands. See game/cityentry.js. It
// borrows the boost trail's dust pool rather than building one of its own: the entrance runs out
// in the opening seconds, long before anything else can be spending slots. Shot mode settles it
// below, next to the markers — a frozen frame of half-grown city is never the screenshot anybody
// asked for.
const cityEntry = createCityEntry({
  // The garage rises with everything else, shell and shutter alike — both are stamped with the one
  // anchor, so it comes up as a building rather than as a building and a door.
  meshes: garage ? [city.mesh, propsMesh, ...garage.meshes] : [city.mesh, propsMesh],
  sites: garage ? [...city.entrySites, garage.entrySite] : city.entrySites,
  dust,
  // The spawn point for now — the wave is re-aimed at the taxi's *post-warmup* position at the
  // bottom of this file, which is where the player actually first sees the car.
  from: { x: traffic.taxi.x, z: traffic.taxi.z },
});
// The whole crash detonation — shockwave, fireball and shards — behind one `fire()` per car. One
// pool serves both cars: nothing here is re-shot from a stored position, so a second call cannot
// drag the first car's wreckage across to the second the way the old debris pools could.
const blast = createBlast(scene, makeRng(runSeed + 88));
const flames = createFlames(scene, makeRng(runSeed + 133));
const vanish = createVanish();

// A light aircraft crossing the city every minute or so. Scenery and nothing else — see
// game/flyover.js. On the run seed rather than the city seed: which way it crosses and when is
// part of the situation, not part of the map.
const flyover = createFlyover(scene, makeRng(runSeed + 155));

// And a helicopter dropping onto the city's one rooftop helipad every couple of minutes — see
// game/chopper.js. Run seed rather than city seed, like the aeroplane: *which* way it comes in and
// when is part of the situation. The pad it lands on is the map, and that comes from `city`.
//
// The wash goes through the dust pool the boost trail and the barricade already share, which is why
// it arrives as a callback rather than as this module handing `game/chopper.js` the pool: a puff
// this far off the ground is the only thing about it the pool did not already know how to do.
const chopper = createChopper(scene, makeRng(runSeed + 233), city.pad, {
  onWash: (x, z, y, yaw, power, count, startSize) => {
    if (count > 1) {
      // Opened out around the circle, so the burst reads as air pushed off a deck rather than as a
      // cloud sitting on top of the machine that made it — the wreck collar's argument, at a
      // twentieth of its size.
      dust.burst(x, z, yaw, count, power, { ring: city.pad.r * 0.8, linger: 1.25, startSize, y });
    } else {
      dust.add(x, z, yaw, power, 0.3, null, y);
    }
  },
});

// Flocks in the parks, walking about until something puts them up — see game/birds.js. Scenery on
// the same terms as the aeroplane, with one thread back to the game: the taxi coming past is what
// startles them. That runs one way only, so nothing about a run changes if it never happens.
//
// Run seed rather than city seed, like the flyover: *which* park they are in and when they leave is
// part of the situation. The parks themselves are the map, and those come from `layout`.
//
// **Two of them**, on separate offsets of that seed so they live separate lives — one is on the
// grass while the other is halfway across the city, which is what a five-by-five map with two to
// five parks in it needs to stop feeling like one lawn with something on it and four without. Each
// is told where the others are and picks a different green; `avoid` is called with the asking
// flock's own `state` so it can drop itself out of the list by identity. Built in a loop with
// `push` rather than `map` because `createBirds` settles the flock before it returns — it calls
// `avoid` during construction, so the array it closes over has to already exist.
const flocks = [];
for (const offset of [199, 211]) {
  flocks.push(createBirds(scene, makeRng(runSeed + offset), layout, {
    avoid: (state) => flocks.filter((f) => f.state !== state).map((f) => f.state.area),
  }));
}

// A street closed for roadworks, once per run, forty seconds or so in — see game/roadwork.js.
// Ambient traffic routes around it and the taxi has never heard of it, so the closed street is the
// emptiest road in the city with a ramp at each end. Run seed, like the flyover: which street and
// when is part of the situation rather than part of the map.
const roadwork = createRoadwork(makeRng(runSeed + 177), scene, camera);
roadwork.onSmash(({ x, z }) => {
  // Just under half the wreck's 2.4. It was 0.55, which is the shake a *kerb* would earn — this is
  // a trestle exploding across the windscreen, and the camera has to admit that something happened.
  // Still short of the wreck, because the wreck ends the run and this does not.
  controller.kickShake(1.1);
  // A proper burst. Two ordinary puffs was what a boosting taxi lays down in two frames, so the
  // impact read as exhaust rather than as hitting something. See `dust.burst`.
  dust.burst(x, z, traffic.taxi.yaw);
});
roadwork.onLand(({ x, z }) => {
  controller.kickShake(0.7);
  // The same burst turned down rather than a smaller hand-tuned one — half the puffs at 70% power.
  // Smaller than the smash on purpose: this is the landing, and it should not upstage the thing it
  // followed.
  dust.burst(x, z, traffic.taxi.yaw, 14, 0.7);
});
// Aim the next fare's drop-off at one end of the closed street. The router already prices those
// lanes low (see EDGE_COST.roadwork), which wins the zone any trip that passes nearby; this is what
// gets a trip to pass nearby in the first place. Neither alone is enough — measured over 24 runs,
// the discount by itself finds the zone in 67% of them and the aimed drop-off by itself in 50%,
// against 33% for neither and 96% for both (tools/roadwork-pull.mjs).
//
// The player is still not being steered: what moved is where the rider wants to go, not how the
// taxi chooses to get there, and they can take any route to it they like.
roadwork.onPlaced(({ ends }) => { fares.aimNextDropoff(ends); });

// Occluded-only outlines on the traffic nearest the taxi, faded in with Loco Mode — the one mode
// where a car hidden behind a tower is a crash rather than a surprise. See game/carghosts.js.
const carGhosts = createCarGhosts(scene, traffic);

// Collision detection between the taxi and ambient cars. Only fires while boosting — see
// src/sim/collisions.js. On impact *both* cars are wrecked: each detonates where it stands and
// each shell shrinks and fades into its own fireball, the camera shakes and pulls into a close-up,
// the sim drops into slow-mo, boost is released, and the fare system flips into game-over — but
// the run-end banner is held for CRASH_BANNER_DELAY (wallclock, so the delay is unaffected by
// the slow-mo).
const CRASH_BANNER_DELAY = 2600;
const WRECK_ZOOM = 26;
const SLOW_MO_MIN = 0.18;                // sim runs at this fraction of real time at impact
const SLOW_MO_DURATION = 2100;           // ms wallclock to ramp back to 1.0

// The bust runs the same cinematic on its own dial. It has something to show that a wreck does
// not — the cruiser breaking off its corridor run and coming for you — so the banner waits about
// a second longer, and the sim runs at less than half the slow-mo depth: at 0.18 the chase was
// wading through treacle, which is the opposite of "it came after you". BUST_BANNER_DELAY buys
// ~2.8s of sim time, against ~1.2s for the longest approach the bust range can set up (a 28-unit
// dog-leg at CHASE_SPEED) plus the 0.45s U-turn.
//
// But the delay is a floor, not the schedule: the banner waits for the cruiser to actually pull
// up. A park district can close the one road between the two cars and leave the only legal route
// three sides of a block long — 68 units and 3.5s on seed 8888 — and cutting to the retry screen
// mid-chase throws away the one beat this whole thing exists for. BUST_BANNER_MAX caps the wait
// for the pathological case; BUST_BANNER_HOLD is the beat after it stops, alongside.
const BUST_BANNER_DELAY = 3400;
const BUST_BANNER_MAX = 4800;
const BUST_BANNER_HOLD = 500;
const BUST_SLOW_MO_MIN = 0.42;

// And the third ending gets the same beat on its own dial again. A fare's clock running out has
// nothing happening *to the taxi* to look at — nothing hit it and nothing pulled it over — so the
// subject of the shot is the place the run failed instead: the drop-off ring the rider never
// reached, or the kerb corner they gave up waiting on. `fares.state.failSpot` is that corner, and
// the fare system leaves its pin standing rather than clearing it with the rest of the board.
//
// Shallower slow-mo than a wreck and a wider stop on the zoom, for the same reason in both cases:
// there is no blast to stretch out and no cruiser on its way in, so what the beat is doing is
// holding a look at a junction rather than replaying an event. At wreck depth the city around the
// marker crawls with nothing to justify it, and at wreck zoom the marker fills the frame and the
// junction it stands on — half of what makes it a place — is cropped away.
const TIMEOUT_BANNER_DELAY = 2400;
const TIMEOUT_ZOOM = 30;
const TIMEOUT_SLOW_MO_MIN = 0.4;

// Where the camera holds for whichever ending the run got, and how far in it pulls. Set by all
// three: a wreck and a bust put it on the taxi, a timeout on the corner the taxi never reached.
let endSpot = null;
let endZoom = WRECK_ZOOM;
let crashBannerAt = null;
let slowMoUntil = 0;
let slowMoMin = SLOW_MO_MIN;
let bustAt = 0;              // wallclock ms of the bust, while the banner is still waiting on the cop

const collisions = createCollisions(traffic.cars, traffic.taxi);
collisions.onImpact(({ x, z, other }) => {
  // One detonation per car — a shockwave ring on the tarmac, a fireball and a scatter of shards,
  // all of it inside game/blast.js. It used to be four effects stacked at each point plus a third
  // wave on a setTimeout, tuned as a simulation; the beat reads better as one graphic bang per
  // car, and the two of them a couple of units apart already give it the spread the follow-up
  // flare was there to fake.
  // The taxi's heading goes with it, and both cars get the taxi's: it is what throws the wreckage
  // downfield, and it is what the tyres roll away along. See `blast.fire`.
  blast.fire(x, z, PALETTE.taxiBody, traffic.taxi.yaw);
  controller.kickShake(2.4);

  // The car that was hit detonates at its own centre rather than at the shared impact point. The
  // two are only a couple of units apart, but that is enough to spread the blast across both
  // bodies instead of stacking it on the seam between them — and its shards fly in its own paint,
  // so what comes apart is visibly two cars.
  //
  // It used to spin out, snap back onto a lane and drive away. A boosting taxi arrives at ~19 u/s
  // and the survivor shrugging that off made the player's own wreck look like a rule rather than
  // a crash.
  blast.fire(other.x, other.z, PALETTE.carBody[other.colorIndex], traffic.taxi.yaw);

  // And a collar of smoke around the pair — the same lit, faceted puffs a barricade throws, tinted
  // grey and opened out into a ring (see `dust.wreckSmoke`). The fireball is unlit flat colour, so
  // on its own it is a bright silhouette that appears and is gone; the dust is Lambert and picks up
  // the sun, which is exactly the contrast that makes the fire read as the hot middle of something
  // bigger. One call for both cars, at the point between them: two collars would have packed grey
  // into the seam where the two fireballs meet, which is the middle of the blast.
  dust.wreckSmoke((x + other.x) / 2, (z + other.z) / 2, traffic.taxi.yaw);

  // Both shells collapse into their own fireballs — see game/vanish.js for why they are faded out
  // rather than simply hidden. `wreckShell` also takes each car off the road for good.
  vanish.take(traffic.wreckShell(traffic.taxi));
  vanish.take(traffic.wreckShell(other));

  endSpot = { x, z };
  endZoom = WRECK_ZOOM;
  crashBannerAt = performance.now() + CRASH_BANNER_DELAY;
  slowMoUntil = performance.now() + SLOW_MO_DURATION;
  slowMoMin = SLOW_MO_MIN;
  boost.release();
  fares.crash();
});

/**
 * Boost past a cop and you're done — reuses the wreck cinematic (zoom, slow-mo, delayed banner)
 * so the beat is the same as a collision, but the taxi stays visible (no blast) since nothing hit
 * it. The taxi is flagged crashed so it freezes on the spot for the pull-in, and the
 * fare system's title/reason drive the "Busted!" banner.
 *
 * The cruiser abandons its corridor run here and comes for the taxi — see `chase()` in
 * sim/police.js. That is the whole point of the delay before the banner: without it the cop sailed
 * on down its road as if nothing had happened, and being busted read as a rule firing somewhere
 * off-screen rather than as a cop noticing you. The camera frames the *taxi*, not the midpoint of
 * the two, so the siren swings into a held shot instead of the shot chasing the siren.
 */
function bustByPolice() {
  if (fares.state.gameOver || traffic.taxi.crashed) return;
  controller.kickShake(0.9);
  endSpot = { x: traffic.taxi.x, z: traffic.taxi.z };
  endZoom = WRECK_ZOOM;
  bustAt = performance.now();
  crashBannerAt = bustAt + BUST_BANNER_DELAY;
  slowMoUntil = performance.now() + SLOW_MO_DURATION;
  slowMoMin = BUST_SLOW_MO_MIN;
  traffic.taxi.crashed = true;
  traffic.taxi.v = 0;
  boost.release();
  police.chase(traffic.taxi);
  fares.crash("The fuzz caught you slippin'.", 'Busted!');
}

function checkPoliceBust() {
  // Engaged, not just active — the bust range still catches the taxi through the cooldown tail,
  // so braking off Loco Mode a beat too close to a cruiser doesn't buy a free pass.
  if (!boost.isEngaged()) return;
  // Armed, not merely active. A cruiser still fading in at the edge of the map used to be able to
  // end the run before it had drawn a pixel — see BUST_ARM_INSET in sim/police.js. The light bar
  // runs a block ahead of this on purpose: the siren says a cop is here, and the gap between the
  // two is the beat the player gets to lift off before one can bust them.
  if (!police.state.armed) return;
  if (fares.state.gameOver || traffic.taxi.crashed) return;
  const dx = traffic.taxi.x - police.group.position.x;
  const dz = traffic.taxi.z - police.group.position.z;
  if (dx * dx + dz * dz > POLICE_BUST_RANGE * POLICE_BUST_RANGE) return;
  bustByPolice();
}

// Orthographic camera: the vertical world span is exactly 2 * zoom, so world-units-per-pixel
// falls straight out of the frustum height.
const boost = createBoost();
const skids = createSkidMarks(scene);

// Lane-width, so it is sized in world units and needs no pixel factor: it is paint on the road
// rather than an overlay drawn at a constant screen weight.
const routeLine = createRouteLine(scene);

// `?blend=additive` picks how the band combines with the road. A URL parameter as well as the
// ⚙️ dropdown because a screenshot has to be able to pin it: the panel doesn't exist in shot mode.
const blendParam = new URLSearchParams(window.location.search).get('blend');
if (blendParam) routeLine.setBlend(blendParam);

/**
 * Paint the band in the clock the drive is spending, so the road ahead, the crystal at the end of
 * it and the disc it stops on are one colour. See game/urgency.js.
 *
 * A route with no fare behind it — the recovery re-route, or a target poked in from the console —
 * falls back to the taxi's own yellow, which is what every route wore before this.
 *
 * Called from both the frame loop and the shot path: a shot never runs the loop, and a screenshot
 * of the band in the wrong colour is exactly the review this is here to serve. A band being
 * dragged is painted from the same fare — the grab whitens whatever colour is under it (see
 * `uGrab` in game/routeline.js) rather than replacing it, so a re-route still says whose clock it
 * is spending while the player is holding it.
 */
function paintRouteBand() {
  // A route sent *at* a package end — the empty-seat dispatch, see `divertToParcel` — wears the
  // courier's own cyan: a package has no clock, so an urgency hue would be reporting a countdown
  // that does not exist, and the fallback yellow would say "no job here at all". Matched on
  // `pendingTarget`'s identity, the same identity the band's rollout sweep keys off — so a route
  // that merely *bends through* a pad on the way to a fare keeps that fare's colour, because the
  // clock the drive is spending is still the rider's.
  const target = traffic.taxi.pendingTarget;
  if (target && parcels?.state.parcels.some((p) => p.target === target)) {
    routeLine.setColor(parcels.colorOf());
    return;
  }
  const job = fares.directed();
  routeLine.setColor(job ? fares.colorOf(job) : PALETTE.routeLine);
}

// Drag the band to send the taxi round a different way. Declared here so the picker and the
// tutorial can both ask whether the click they are about to answer was the end of one; wired up
// below, once `routeTo` exists.
let pathDrag = null;

// --- Selection and routing --------------------------------------------------

// The taxi is permanently selected. There is only ever one, so a selection step was pure
// ceremony: every tap on it was either a no-op or an accidental deselect that made the next tap
// on a fare do nothing. Nothing draws on the road to say so any more either — see taxi.js.
const selected = true;

/**
 * Route the taxi to an intersection. Planning starts from the intersection the taxi is *heading
 * toward* plus its current heading, because that is the first point at which it can make a choice.
 *
 * `via` forces the route through one more junction on the way — the player dragging the route band
 * sideways (see game/pathdrag.js). It comes through here rather than assigning `car.route`
 * directly because everything else this function does is load-bearing for a route that is
 * *replacing* one already part-driven: `routeConsumed` has to be cleared or the turn the car has
 * already committed to eats the first step of the new plan, and `parked` has to be released.
 *
 * `maxDetour` overrides how much extra route a `via` may cost. Left out it is `MAX_VIA_DETOUR`, the
 * cap written for a dragged waypoint; the courier tap passes its own, because that cap is about a
 * finger that slipped and a tap cannot slip (see `TAP_MAX_DETOUR` in game/parcels.js).
 *
 * The target object's *identity* is what the band's rollout sweep keys off, so a re-plan that
 * keeps the same destination must pass the same object rather than an equal one — otherwise every
 * frame of a drag replays the sweep and the band never finishes drawing itself.
 */
function routeTo(target, { via = null, maxDetour } = {}) {
  const car = traffic.taxi;
  const route = via
    // `undefined` falls through to `findRouteVia`'s own default rather than reading as "no cap".
    ? findRouteVia(planOrigin(car), via, target, { maxDetour })
    : findRoute(planOrigin(car), target);
  if (!route) return false;
  car.route = route;
  car.routeConsumed = false;
  car.pendingTarget = target;
  // The player has just directed the taxi somewhere, so release the kerb hold even if the route
  // is empty (destination equals the intersection the taxi is already heading toward). Without
  // this the parked check in traffic.js keeps allowed = 0 forever — the taxi never enters the
  // junction, so arrival never fires, and Loco Mode can't help because parked overrides boost.
  car.parked = false;
  return true;
}

/**
 * A rider is in: send the taxi at their drop-off without waiting to be told.
 *
 * The destination was never a decision. It was drawn when they spawned, the price was fixed from
 * it, and its pin is on the map the instant they board — so the tap that used to be required here
 * confirmed a choice with exactly one option while the same flat clock that has to cover the
 * delivery kept draining. The decision this game is actually about — which kerbside rider to grab
 * with two clocks running — is untouched, and it is the seconds for *that* the tap was costing.
 *
 * Nothing is skipped: `directed` is still what resolves the drop-off (see fares.js), it is just
 * set from the pickup rather than from a second tap. And the taxi no longer parks, so a pickup is
 * a pause in a drive rather than a full stop and a restart.
 *
 * The fallback is unreachable in a shipped city — main.js rerolls any seed the router can't solve
 * every pair on — but a taxi that couldn't be routed must still be recoverable by hand rather than
 * cruising on random turns until the rider's clock runs out.
 */
function dispatchToDropoff(fare) {
  if (routeTo(fare.target)) {
    fares.markDirected(fare);
    return;
  }
  traffic.taxi.parked = true;
}

/**
 * A tap on a package. What it means turns on the seat — see game/parcels.js.
 *
 * **Rider aboard: a detour, never a dispatch.** The seat is a commitment and its clock is the one
 * draining, so nothing may re-aim the taxi at a package while somebody is riding. The tap is
 * `findRouteVia` with the waypoint named rather than aimed at: same origin, same destination, same
 * fare still `directed`, one junction added in the middle. It is exactly what a drag on the route
 * band produces when the finger lands on the box's corner, minus the aiming — which on a phone is
 * the whole difficulty of the gesture and none of the decision.
 *
 * **It does not inherit the drag's detour cap** (`TAP_MAX_DETOUR`, game/parcels.js). It did at first,
 * and at `MAX_VIA_DETOUR`'s 6 legs that silently refused 41% of every tap in the game — the measured
 * median diversion costs exactly 6. A cap on a dragged waypoint is protection against a finger that
 * slipped; a tap lands on one marker and means it.
 *
 * Two things the detour deliberately does not do:
 *
 * - **It does not persist.** The waypoint is spent the moment it is planned; the next thing that
 *   re-plans (a pickup dispatching itself, a tap on another rider) drops it, and the player taps the
 *   box again if they still want it. Re-applying it every frame is the one shape this must not take —
 *   `routeConsumed` is cleared on every re-plan, so a standing diversion means the turn the car has
 *   already committed to never retires from the route and the taxi sits re-deciding the same junction
 *   (measured in `tools/probe.mjs`: $34 earned in seven simulated minutes, nothing delivered).
 * - **It does not check the clock.** The detour is taken exactly as asked, even when it costs the
 *   rider in the back their fare. That is the trade the layer exists to offer, and it is the
 *   player's to make — the same one the drag has always let them make. Uncapped, this is the whole
 *   of what a box costs, which is why it has to be visible: the band redraws through the pad on the
 *   same frame, before a wheel has turned, and tapping the rider re-plans direct again.
 *
 * **Seat empty: a dispatch.** With nobody in the back there is no committed clock for a detour cap
 * to protect, so the box is allowed to be the destination: the taxi is routed straight at it, and
 * the band repaints in the courier's own cyan (`paintRouteBand`) — a package has no urgency, and
 * the hue says so. This replaces whatever the taxi was driving at, including a waiting rider the
 * player had tapped — the same retarget rule every fare tap already follows, applied to one more
 * kind of target, and the waiting rider's clock keeps draining exactly as it would have. The drive
 * retires itself on arrival (the `'pickup'`/`'delivered'` handling in the frame loop), the way a
 * fare's own legs do. It subsumes the old between-jobs case: with no destination at all there was
 * never anything to bend, and the tap has always routed at the box in that beat.
 */
function divertToParcel(parcel) {
  if (!parcel) return;
  const target = traffic.taxi.pendingTarget;
  // Both branches refuse only on a leg the router cannot solve, which a shipped city never has —
  // `main.js` rerolls any seed `findRoute` fails a pair on. When one does, `routeTo` leaves the
  // route exactly as it was and the corner flinches instead of swelling — see `acknowledge`.
  const taken = target && fares.carrying()
    ? routeTo(target, { via: parcel.target, maxDetour: TAP_MAX_DETOUR })
    : routeTo(parcel.target);
  parcels?.acknowledge(parcel, taken);
}

createPicker(
  camera,
  renderer.domElement,
  () => [traffic.taxiGroup, ...fares.pickables(), ...(parcels?.pickables() ?? [])],
  (kind, hit) => {
    if (fares.state.gameOver) return;

    // The courier board answers a tap with a detour rather than a destination, so it is handled
    // before the fare board rather than inside it — there is no fare behind a package and nothing
    // below this line would find one.
    if (kind === 'parcel' || kind === 'parcel-dropoff') {
      divertToParcel(parcels?.parcelFor(hit.object));
      return;
    }

    if (kind !== 'passenger' && kind !== 'destination') return;

    // With two fares on the board, *which* pin was tapped is the whole instruction — routing at
    // "the" target the way the single-fare version did would send the taxi at the wrong one.
    const fare = fares.fareFor(hit.object);
    if (!fare) return;

    // One seat. Refusing the tap outright, rather than driving there and quietly not picking
    // anyone up, is what teaches the rule the first time a second rider appears.
    //
    // Gated on the fare's stage rather than on `kind`: the two agree today, since a waiting fare's
    // only visible marker is its rider, but the rule is about the fare, not about which mesh was hit.
    if (fare.stage === 'waiting' && fares.carrying()) {
      return;
    }

    if (routeTo(fare.target)) {
      fares.markDirected(fare);
    }
  },
  // A gesture that moved the map, or one that pulled the route round, is not also a tap on
  // whatever it happened to finish over.
  () => Boolean(pan?.didPan() || pathDrag?.didDrag()),
);

// The band is only draggable once there is one: a destination is set, the run is live, and the
// player is not looking at a paused veil or a screenshot.
pathDrag = createPathDrag({
  camera,
  domElement: renderer.domElement,
  scene,
  routeLine,
  getCar: () => traffic.taxi,
  reroute: (via) => routeTo(traffic.taxi.pendingTarget, { via }),
  // `pause` is declared further down and only ever read from a pointer handler, which is long
  // after this module has finished evaluating — same as `homeTip` in the tutorial's guards.
  canGrab: () => Boolean(
    !shot && selected && traffic.taxi.pendingTarget
    && !fares.state.gameOver && !traffic.taxi.crashed && !pause?.state.paused,
  ),
});

// Camera shortcut: frame the waiting rider on demand. At play zoom on a phone the rider is a
// handful of pixels somewhere on a map that no longer fits in one screen, so taking the camera to
// them is faster than hunting for their diamond by hand. Narrow viewports only — see selectRider.
//
// It *pans* rather than cutting. A cut costs the player the one thing the fixed camera was chosen
// to give them: with the whole city no longer in frame, a teleport leaves them re-reading a screen
// of near-identical blocks to work out which way the map just moved, and whether the rider now
// under the chip is the one they tapped. Riding the move across keeps the city continuous, so they
// arrive already knowing where they are and where the taxi was left behind.
//
// And it comes *back*. Showing the rider is a glance, not a destination: the taxi is already
// driving at them, and a camera parked on the kerb leaves the player watching an empty corner
// while their car is somewhere off-screen — so every chip tap used to end with a drag back across
// the map, by hand, on a clock that is draining. The peek holds the rider for a beat and then
// rides home to the taxi (see camera.js's peekAt), which is the same distance the player would
// have dragged, in a move they don't have to make.
function panToRider(fare) {
  if (!fare) return;
  const c = cornerFor(fare.target.i, fare.target.j);
  // Same as a swipe: the player has aimed the camera somewhere deliberately, so the opening
  // follow-cam stops. Without this the taxi would tow the framing straight back off the rider the
  // chip was pointing at — and here it would do it *during* the pan, which reads as the camera
  // losing its nerve halfway.
  releaseCameraToPlayer();
  controller.peekAt(c.x, c.z, () => traffic.taxi, () => {
    // The return leg landed on the car and is travelling with it, so hand the framing back to the
    // opening follow rather than letting go here — parking the camera would only let the taxi
    // drive out of the frame the peek just spent a second putting it in. Only reached if the whole
    // sequence ran out; a swipe or a boost mid-peek drops the callback and the player keeps the
    // camera they took.
    cameraTakenOver = false;
  });
}

// Dispatch the taxi at that rider — same effect as tapping their pin on the map, without having to
// find it first. A pickup while already carrying someone would be refused at the picker; keep the
// rule consistent here.
function dispatchToRider(fare) {
  if (!fare || fares.state.gameOver) return;
  if (fares.carrying()) return;
  if (routeTo(fare.target)) {
    fares.markDirected(fare);
  }
}

// One tap on a chip picks that rider. The camera only follows on a narrow viewport, where the
// rider may well be off-screen and framing them is the other half of the job; on a desktop the
// whole city is already in frame, so a pan would shove the map out from under a player who can
// see the rider fine — same reason drag-to-pan and the follow-cams are narrow-only.
//
// The dispatch does not wait for the pan to land: the fare's clock is draining, and a camera move
// that delayed the taxi leaving would be charging the player for the convenience.
function selectRider(fare) {
  if (!fare) return;
  if (isNarrow()) panToRider(fare);
  dispatchToRider(fare);
}

// The same shortcut aimed the other way: back to the taxi, from wherever the player left the
// framing. The camera is theirs for good once they swipe — nothing drags it back onto the car —
// which on a phone means a look across town can leave the taxi off-frame entirely, and the only way
// home was to drag the map until the yellow car turned up. See game/taxifinder.js for when the chip
// that calls this is up.
function panToTaxi() {
  // Tracked rather than aimed once, for the same reason a peek's ride home is: the car has been
  // driving the whole time the chip was up, and a leg fixed at the tap would land on the road it
  // left. The landing is on the car and already travelling with it, so clearing `cameraTakenOver`
  // hands the framing to the opening follow-cam with no gap to close — and handing it back is the
  // point, since parking the camera on the car would only let it drive out of the frame the move
  // just spent half a second putting it in.
  controller.chaseTo(() => traffic.taxi, () => {
    cameraTakenOver = false;
    // And the car says which one it is, on the same flourish a courier box landing in it fires.
    // **On arrival, not on the tap**: the flash is over in 0.29s and the ride takes up to 0.75s, so
    // firing it at the press would spend the whole thing on a car that is still off-frame — a
    // flourish nobody is in a position to see. Here it lands on the frame the camera stops, which is
    // the frame the player is looking for their taxi in. It rides `onArrive`, so a swipe away
    // mid-ride cancels the flash along with the trip: the player has changed their mind about where
    // to look, and a car lighting up off-screen behind them would be answering a question they
    // withdrew.
    flashTaxi();
  });
}

const riderFinder = createRiderFinder({ onSelect: selectRider, sun, hemi });
// The chip that answers "where did my car go" — up only while the taxi is completely off-frame.
const taxiFinder = createTaxiFinder({
  sun,
  hemi,
  project: projectToScreen,
  // The frame the renderer actually draws, not `window.inner*` — which is short of it on an
  // installed iOS app, and would report a car in that strip as off-screen when it is on it.
  frame: viewport,
  // Orthographic, so world-units-per-pixel falls straight out of the frustum height: the vertical
  // world span is exactly 2 * zoom. Read per frame, since a wreck pulls the zoom in under it.
  pixelsPerUnit: () => viewport.height() / (2 * controller.state.zoom),
  onTap: panToTaxi,
});
// The courier load, pictured in the HUD's own corner while a package is aboard — see
// game/cargochip.js. Built only when the layer is on, because it opens a WebGL context of its own
// and a run under `?parcels=0` can never have anything to put in it.
const cargoChip = parcels ? createCargoChip({ sun, hemi }) : null;
const dropoffIndicator = createDropoffIndicator({
  camera,
  // Aim at the kerb corner where the pin actually stands, not the intersection centre — the
  // pointer's job is to show where the marker went off-screen, and the marker isn't at the
  // junction.
  pinLocation: cornerFor,
  // The same measurement the renderer trusts, so the arrow clamps to the edge of the frame that
  // is actually drawn — `window.inner*` is short of it on an installed iOS app.
  viewport,
});

// The other half of the same problem, aimed the other way: the drop-off is somewhere the player is
// driving to, and the police car is something driving at them. See game/sirenglow.js.
const sirenGlow = createSirenGlow({ camera, viewport });

// --- Opening tutorial -------------------------------------------------------

// Two bubbles and nothing else: "this car is you", then "tap that rider". See game/tutorial.js for
// why those two and no more. Off in shot mode — a screenshot has nobody to teach, and the bubble
// would be the loudest thing in every frame — and `?tutorial=off` skips it while iterating on the
// rest of the game.
//
// It runs on every new game, not just the first: the opening is short, it holds the clocks while it
// talks, and it costs nothing to sit through. Remembering it across loads was tried (a
// `localStorage` flag) and taken back out — see docs/gameplay.md.
const wantsTutorial = new URLSearchParams(window.location.search).get('tutorial') !== 'off';
// The same escape hatch for the beat before it — see the opening vignette at the bottom of this
// file, and `?vignette=off` there for why it is a *settle* rather than a skip.
const wantsVignette = new URLSearchParams(window.location.search).get('vignette') !== 'off';
const revealHud = () => document.body.classList.add('hud-ready');

// Set on the first successful press of Loco Mode, and never cleared. The tutorial's third beat
// reads it: a player who has already fired it does not need a bubble pointing at the pill.
let locoUsed = false;
tutorial = shot || !wantsTutorial ? null : createTutorial({
  controller,
  aspect,
  isNarrow,
  taxi: traffic.taxi,
  // The city's own rig, so the car in the bubble is lit by the same golden hour as the car on the
  // road. Read, not re-parented — an Object3D belongs to one scene.
  lights: { sun, hemi },
  project: projectToScreen,
  // Orthographic, so world-units-per-pixel falls straight out of the frustum height: the vertical
  // world span is exactly 2 * zoom. This is what keeps the spotlight the same size on every
  // viewport, and correct if a wreck ever pulls the zoom in under it.
  pixelsPerUnit: () => viewport.height() / (2 * controller.state.zoom),
  // The third beat points at a control rather than at something in the city, so its spotlight is
  // measured off the pill's own box. Declared after this call; `function` hoisting covers it.
  boostAnchor: boostScreenPos,
  // The one the game means by "the waiting fare" — the shortest clock on the kerb. At this point in
  // a run there is only ever one, but pointing at the same rider the rest of the HUD would is free.
  waitingFare: () => fares.waiting(),
  // The kerb corner, not the junction centre: at this zoom the corner building sits squarely
  // between the camera and the figure otherwise. Same aim as panToRider and the drop-off pointer.
  fareLocation: (fare) => cornerFor(fare.target.i, fare.target.j),
  // Any fare the player has actually sent the taxi at — including one they found and tapped on the
  // map while the first bubble was still up.
  isDispatched: () => Boolean(fares.carrying() || fares.state.fares.some((f) => f.directed)),
  // The third beat waits on this rather than on the dispatch: the Loco Mode hint lands a couple of
  // seconds after the first rider is actually dropped off, once the loop has closed one full turn.
  hasDelivered: () => fares.state.delivered > 0,
  // A player who has already found Loco Mode does not need the third beat pointing at it.
  boostUsed: () => locoUsed,
  isOver: () => fares.state.gameOver,
  // The "Add to Home Screen" screen gets there first on iOS in a tab, and holds the run until it is
  // tapped. `homeTip` is declared further down and only ever read from the frame loop, which is
  // long after this module has finished evaluating. The city's own entrance holds the tutorial the
  // same way: the spotlight dimming a city that is still building itself would upstage the build,
  // and the first bubble should land as the thing that happens *after* the last building does.
  // The 250ms beat between the two is the tutorial's own OPENING_HOLD.
  // ...and the opening vignette holds it after that, so the three queue: the city builds itself,
  // the taxi comes out of its garage, and only then does anything start talking. Each is a claim
  // about the same few seconds and any two of them at once is neither.
  isBlocked: () => Boolean(homeTip?.state.holding) || cityEntry.running()
    || Boolean(opening?.running()),
  // The same guard the picker uses: the click a mouse synthesises at the end of a drag must not
  // count as an answer to the bubble the player was dragging past.
  shouldIgnoreTap: () => Boolean(pan?.didPan() || pathDrag?.didDrag()),
  // Hold every fare's countdown for as long as the tutorial is talking. It ends on the player's
  // tap, so the clock they are taught with is the full sixty seconds.
  onRunning: (running) => {
    fares.setPaused(running);
    if (!running) revealHud();
  },
});

// The money counter, the streak counter, the Loco Mode pill and the rider chips all start off
// their own screen edge and slide in together — see the HUD entrance block in index.html. A run
// used to open with all four already lit, every one of them reading zero and answering a question
// nobody had asked yet. They arrive when the tutorial stops talking; with no tutorial to wait for
// (`?tutorial=off`, shot mode) they are simply there from the first frame.
if (!tutorial) revealHud();

// --- HUD --------------------------------------------------------------------

const hud = {
  money: document.getElementById('money'),
  streak: document.getElementById('streak'),
  streakCount: document.getElementById('streak-count'),
  banner: document.getElementById('run-end'),
};

// The counter lags the payout on purpose: the flying "$X" rises off the taxi, travels to the HUD,
// and only when it lands does the total tick up — so the payout has a visible path from the world
// into the counter rather than a number silently changing in the corner.
let shownMoney = 0;
let moneyRoll = null;

/** A world point in viewport pixels. The one place the NDC-to-pixels arithmetic lives. */
function projectToScreen(x, y, z) {
  const v = new THREE.Vector3(x, y, z).project(camera);
  return {
    x: (v.x * 0.5 + 0.5) * viewport.width(),
    y: (-v.y * 0.5 + 0.5) * viewport.height(),
  };
}

/** Screen position of the taxi, for anchoring the earnings pop. */
function taxiScreenPos() {
  return projectToScreen(traffic.taxi.x, 1.4, traffic.taxi.z);
}

/**
 * Centre of the Punch It pill, and the radius of a circle that clears it. The centre is where a
 * delivery's boost sparks are pulled to; the radius is what the tutorial's third beat sizes its
 * spotlight from. Read fresh on every call rather than cached, because the pill's own fill flutter
 * scales it and a resize moves it.
 */
function boostScreenPos() {
  if (!boostButton) return null;
  const r = boostButton.getBoundingClientRect();
  // A hidden pill measures 0×0 — shot mode and the run-end blackout both hide it. Null rather than
  // a rect at the origin, or a delivery landing next to a crash fires its sparks at the top-left
  // corner of the screen.
  if (!r.width) return null;
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
    // Half the pill's diagonal plus a margin, so the clear centre of a pool sitting on it leaves
    // some air around the outline rather than cropping it at the border.
    r: Math.hypot(r.width, r.height) / 2 + 20,
  };
}

/** Centre of the money counter in viewport coordinates — the flight's target. */
function counterScreenPos() {
  // Anchor on the `.money` wrapper rather than the `#money` span so the flight lands on the
  // whole "$X" unit, `$` prefix and all, rather than just the digits.
  const box = hud.money?.parentElement;
  if (!box) return null;
  const r = box.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * Roll the counter from its current value up to `target`. Uses rAF rather than a CSS tween so a
 * second delivery landing mid-roll simply re-aims the same animation at the new total instead of
 * two counters racing. The bump class is toggled off then on across a reflow, because a class that
 * stays put doesn't re-fire the keyframe.
 */
function rollMoneyTo(target) {
  if (!hud.money) return;
  if (moneyRoll) cancelAnimationFrame(moneyRoll);
  const from = shownMoney;
  const delta = target - from;
  if (delta <= 0) { shownMoney = target; hud.money.textContent = String(target); return; }
  // ~50ms per dollar so a $8 tick reads as a quick bump and a $35 one as a longer roll, clamped so
  // neither extreme feels wrong.
  const dur = Math.min(700, Math.max(240, delta * 50));
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / dur);
    const eased = 1 - (1 - t) * (1 - t);
    shownMoney = Math.round(from + delta * eased);
    hud.money.textContent = String(shownMoney);
    if (t < 1) moneyRoll = requestAnimationFrame(step);
    else { shownMoney = target; moneyRoll = null; }
  };
  moneyRoll = requestAnimationFrame(step);
  // Bump the whole "$X" unit — the `$` prefix lives on the parent — so the payout registers as one
  // visual event rather than just a digit changing. Toggle off / reflow / on to re-fire keyframes.
  const bump = hud.money.parentElement;
  if (bump) {
    bump.classList.remove('money-bumped');
    void bump.offsetWidth;
    bump.classList.add('money-bumped');
  }
}

function popEarning(amount) {
  const start = taxiScreenPos();
  const el = document.createElement('div');
  el.className = 'earning';
  el.textContent = `$${amount}`;
  el.style.left = `${start.x}px`;
  el.style.top = `${start.y}px`;
  document.body.append(el);

  // The counter's position is resolved *at launch* rather than baked into a CSS keyframe, so a
  // window resize between deliveries still aims each flight at where the counter actually is now.
  const target = counterScreenPos() ?? { x: start.x, y: start.y - 74 };
  const dx = target.x - start.x;
  const dy = target.y - start.y;

  // Phase 1: rise off the taxi. Reads as "the payout leaving the world" — same shape as the old
  // pop, just shorter so it can hand off to phase 2 without dragging.
  const rise = el.animate([
    { opacity: 0, transform: 'translate(-50%, -50%) translateY(4px)   scale(0.8)' },
    { opacity: 1, transform: 'translate(-50%, -50%) translateY(-22px) scale(1.06)', offset: 0.5 },
    { opacity: 1, transform: 'translate(-50%, -50%) translateY(-30px) scale(1)' },
  ], { duration: 620, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });

  rise.onfinish = () => {
    // Phase 2: fly to the counter and shrink, landing on top of it. Slight scale-down at the end
    // so the flight has a target rather than a vague fade-in-the-middle.
    const fly = el.animate([
      { opacity: 1, transform: 'translate(-50%, -50%) translateY(-30px) scale(1)' },
      { opacity: 0, transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(0.55)` },
    ], { duration: 460, easing: 'cubic-bezier(0.42, 0, 0.58, 1)', fill: 'forwards' });
    fly.onfinish = () => {
      el.remove();
      rollMoneyTo(fares.state.money);
    };
  };
}

/**
 * The multiplier counter, top right — no flight off the taxi like the payout gets, that's a later
 * concern. It is in the markup from the first frame (see index.html), so there is nothing to
 * reveal here; it bumps on every delivery whether or not the number changed, because the bump is
 * "that one counted" and the number is "and this is what they are worth now".
 *
 * It used to show `fares.state.delivered` and call that a streak, which meant the `×` was
 * decoration — the same number the run-end screen printed as "Fares", wearing a symbol that
 * implied an economy it did not have. It now shows `difficulty.payoutMultiplier`, which is the
 * real multiple every fare's price is stamped with at spawn.
 */
function updateStreak(multiplier, bump = true) {
  if (!hud.streak || !hud.streakCount) return;
  // A whole number prints as "2", a step prints as "1.5" — trailing zeros on a HUD number read as
  // precision that isn't there.
  hud.streakCount.textContent = String(Math.round(multiplier * 100) / 100);
  if (!bump) return;
  // Toggle off / reflow / on, same as the money bump — a class that stays put doesn't re-fire.
  hud.streak.classList.remove('streak-bumped');
  void hud.streak.offsetWidth;
  hud.streak.classList.add('streak-bumped');
}

// Paint the opening multiplier, without the bump — a counter that pops on load is announcing a
// change that hasn't happened. Read off the curve rather than left in the markup so the two cannot
// drift: `index.html` ships a placeholder, and the first shift's payout is what it should say.
updateStreak(difficulty.payoutMultiplier(0), false);

/**
 * Push the world half of the difficulty curve into the sim: more traffic, and a police corridor
 * that comes round more often.
 *
 * A pinned `?cars=N` opts out of the density ramp entirely — the pool was sized to that number, so
 * `setCarCount` has nowhere to grow into anyway, but saying so here is what makes it a decision
 * rather than an accident.
 */
function applyWorldPressure() {
  const delivered = fares.state.delivered;
  if (pinnedCars === null) traffic.setCarCount(difficulty.carCount(delivered));
  police.setCooldownRange(difficulty.policeCooldown(delivered));
}

/** Total seconds as `m:ss` + a trailing `s`, e.g. `1:03s` — the run-end screen's Time stat. */
function formatRunTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const secs = total % 60;
  return `${Math.floor(total / 60)}:${String(secs).padStart(2, '0')}s`;
}

/**
 * Whether this run is allowed onto the high-score table.
 *
 * Not every run is the same game. A pinned difficulty, a pinned car count, a fare clock dragged
 * around in the ⚙️ panel or a shot-mode framing all change what a dollar is worth, and a table with
 * a tuning session sitting at the top of it is worth nothing to the player who earned row two
 * honestly. Every one of these is already a signal the game keeps for its own reasons; this just
 * reads them together.
 *
 * The stats still show on an unranked run — it happened, and it is still worth a curtain call. It
 * simply isn't recorded, and the screen goes straight from the tally to Play again.
 */
function isRankedRun() {
  // `difficulty.getPinned()` rather than `getDifficultyPin()`: the URL flag is only one of the two
  // ways the curve gets pinned, and the ⚙️ panel's slider — the one anybody actually reaches for —
  // calls `pinDifficulty` directly without touching the URL. Reading the live state catches both.
  return !shot && pinnedCars === null && difficulty.getPinned() === null && !isFareClockPinned();
}

/**
 * Offer the finished run to the table and build what the run-end screen needs to show it.
 *
 * Returns `null` when there is nothing to show — an unranked run, or a browser with no storage,
 * where an empty "Leaderboard" heading would be a promise the game cannot keep.
 */
function collectScores() {
  if (!isRankedRun()) return null;
  const s = fares.state;
  const result = recordRun({
    cash: s.money,
    fares: s.delivered,
    seconds: s.elapsed,
    shift: difficulty.shiftFor(s.delivered).name,
  });
  if (!result.entries.length) return null;
  return {
    entries: result.entries,
    rank: result.rank,
    id: result.id,
    name: lastName(),
    onName: result.setName,
  };
}

function updateHud(dt) {
  const s = fares.state;

  // A bust holds the banner until the cruiser is alongside — see the BUST_BANNER_* block. The
  // floor keeps a chase that ends in half a block from cutting to the retry screen while the
  // camera is still moving; the ceiling covers a route the park closures made long.
  if (bustAt) {
    const elapsed = performance.now() - bustAt;
    if (police.state.arrived || elapsed >= BUST_BANNER_MAX) {
      crashBannerAt = bustAt + Math.min(BUST_BANNER_MAX,
        Math.max(BUST_BANNER_DELAY, elapsed + BUST_BANNER_HOLD));
      bustAt = 0;
    } else {
      crashBannerAt = Infinity;
    }
  }

  if (s.gameOver && hud.banner && hud.banner.hidden) {
    // Every ending holds the banner while its own closing beat plays — CRASH_BANNER_DELAY for the
    // blast, the cruiser's arrival for a bust, TIMEOUT_BANNER_DELAY for the pull-in on the corner a
    // fare's clock ran out on. All three are wallclock, so the slow-mo doesn't stretch the wait.
    // `crashBannerAt` is null only for a run ended from outside the game (the console hook), which
    // has nothing to wait for.
    if (crashBannerAt !== null && performance.now() < crashBannerAt) return;
    showRunEnd(hud.banner, {
      title: s.failTitle,
      reason: s.failReason,
      // Four numbers, in the order the run produced them: how long it lasted, what you carried,
      // how deep into the ramp that took you, and what it paid.
      //
      // "Shift" replaces what used to be "Streak", which printed `s.delivered` — the same number
      // as Fares directly above it, formatted with an `x`. Two rows counting out one number is a
      // stat sheet padding itself. How far up the difficulty curve the run got is a genuinely
      // different fact about it, and it is the one the multiplier was earned by.
      stats: [
        { label: 'Time', value: s.elapsed, format: formatRunTime },
        { label: 'Fares', value: s.delivered, format: (n) => `${n}` },
        // Rolls up through the shift names the run actually passed through, which is what the
        // counter does with every other stat. Clamped at the bottom because `countUp` paints
        // `format(0)` as the row's opening frame before it starts counting.
        { label: 'Shift', value: difficulty.shiftFor(s.delivered).index + 1,
          format: (n) => difficulty.SHIFTS[Math.max(0, n - 1)].name },
        { label: 'Cash', value: s.money, format: (n) => `$${n}` },
      ],
      // Recorded here rather than the moment the run ended, so the write happens on the frame the
      // screen is actually built — a bust holds this block for up to BUST_BANNER_MAX while the
      // cruiser closes, and a score saved during that hold would be sitting in storage before the
      // player had been told the run was over.
      scores: collectScores(),
      onRetry: () => location.reload(),
    });
    document.body.classList.add('game-over');
  }
}

// Through the viewport's own change feed rather than `window.resize`: an iOS cold-start settle —
// the screen's true height arriving a few hundred ms after launch — changes the measurement
// without ever firing a resize event, and the canvas has to follow it or the game keeps the
// dead strip the settle just revealed.
viewport.onChange((w, h) => {
  renderer.setSize(w, h);
  controller.resize(aspect());
});

// --- Crazy taxi button ------------------------------------------------------

const boostButton = document.getElementById('boost');

// A drop-off is the only thing that ever puts fuel in the tank (see game/boost.js), so the pour is
// the reward animation and it gets three layers: the bar overruns its new mark and eases back, the
// pill pulses yellow the whole time fuel is arriving, and a blurred bright edge rides the front of
// the fill. game/boostmeter.js owns the timing of all three; this just hands it the clock and the
// fuel level and paints what comes back onto three CSS variables.
const boostMeter = createBoostMeter();

function updateBoostButton(dt) {
  if (!boostButton) return;
  const mode = boost.state.mode;
  boostMeter.update(dt, boost.fraction(), boost.state.pending > 0);

  boostButton.classList.toggle('is-active', mode === 'active');
  boostButton.classList.toggle('is-empty', mode === 'empty');
  boostButton.classList.toggle('is-filling', boostMeter.state.fill > 0);
  boostButton.style.setProperty('--pct', `${(boostMeter.state.pct * 100).toFixed(1)}%`);
  boostButton.style.setProperty('--fill', boostMeter.state.fill.toFixed(3));
  boostButton.style.setProperty('--pulse', boostMeter.state.pulse.toFixed(3));
  // Dead until a drop-off pours fuel back in — nothing refills on its own, so a pressable-looking
  // pill on an empty tank would be a lie.
  boostButton.disabled = mode === 'empty';
}

// Hold-to-enable, release-to-pause. Pointer events cover both mouse and touch; capturing the
// pointer on press means dragging off the pill still counts as held, and the matching pointerup
// fires reliably wherever the finger lifts.
function pressBoost(event) {
  if (fares.state.gameOver || boostButton.disabled) return;
  event.preventDefault();
  boostButton.setPointerCapture?.(event.pointerId);
  holdLocoMode();
}

// The press itself, with no idea what pressed it — the pill and the spacebar both land here.
function holdLocoMode() {
  if (fares.state.gameOver || boostButton?.disabled) return;
  // Doing the thing the third bubble is asking for answers it. Called explicitly rather than left
  // to the tutorial's window-level tap handler, because the preventDefault in either caller can
  // suppress the click the gesture would otherwise synthesise — so the hint would outstay its own
  // lesson (on a phone for the pill, on every device for the key, which synthesises nothing).
  tutorial?.dismiss();
  if (boost.press()) {
    kickLocoMode();
  }
}

// Fires only on the transition into Loco Mode — not while it's already active — so a re-press
// during a running boost doesn't stack a fresh wheelie on top of one already animating (and
// doesn't double-fire the flame). `boost.press()` returns true only on that transition, which is
// why the whole kick is gated on it above.
function kickLocoMode() {
  // Fires only on the transition into Loco Mode, which makes it exactly the right place to record
  // that the player has now used it.
  locoUsed = true;
  const car = traffic.taxi;
  if (car.crashed) return;
  car.wheelieT = 0;
  const bx = -Math.cos(car.yaw);
  const bz = Math.sin(car.yaw);
  flames.burst(
    car.x + bx * TAXI_TAILPIPE_BACK,
    TAXI_TAILPIPE_HEIGHT,
    car.z + bz * TAXI_TAILPIPE_BACK,
    car.yaw,
  );
  // Break traction on the launch as well as in the corners. One pair stamped here so a standing
  // start (pressing while held at a red) still leaves a patch under the wheels — the distance
  // spacing in layRubber can't produce anything until the car actually moves.
  stampRearRubber(car);
  launchSkidT = LAUNCH_SKID_TIME;
}
function releaseBoost(event) {
  boost.release();
  boostButton.releasePointerCapture?.(event.pointerId);
}
// (The top-up flash used to live here as a one-shot class the delivery had to remember to fire,
// which meant back-to-back deliveries needed a reflow to restart the animation. The glow is now
// driven off `boost.state.pending` in updateBoostButton — it lasts exactly as long as fuel is
// actually arriving, and a second delivery mid-pour just extends it.)

boostButton?.addEventListener('pointerdown', pressBoost);
boostButton?.addEventListener('pointerup', releaseBoost);
boostButton?.addEventListener('pointercancel', releaseBoost);
boostButton?.addEventListener('lostpointercapture', releaseBoost);

// iOS runs text selection, the magnifier and double-tap zoom off the raw touch stream, and since
// iOS 15 it does all three on this pill regardless of `-webkit-user-select: none`
// (webkit.org/b/231161). Cancelling `pointerdown` — which pressBoost already does — does not reach
// them: that suppresses the compatibility *mouse* events, one layer above the gesture recogniser
// that is actually selecting "Loco Mode™" and zooming the city. Cancelling `touchstart` does, and
// on iOS it is the only thing that does.
//
// Unconditional, unlike pressBoost, which bails on a game over or an empty tank before it reaches
// its own preventDefault. Those are precisely the states a player jabs at twice in a row — a drained
// pill is what "why isn't this working" looks like — so they are the states that most need this.
// Nothing is lost by cancelling: the pointer events above are the primary stream and keep firing,
// and the only defaults being dropped are the synthesised click (nothing listens for one here; see
// spaceIsSpokenFor below) and focus-on-tap, which on a touchscreen has no keyboard behind it.
//
// `passive: false` is spelled out rather than left to the default. Browsers force `passive: true`
// for `touchstart` on window, document and body, and preventDefault from a passive listener is a
// silent no-op with nothing but a console warning — so a later refactor that moves this listener up
// to `window` would take the fix out without failing anything.
//
// The `cancelable` test is not defensive noise, it is the whole difference between the two engines.
// Chrome takes `touch-action: none` at its word: it knows there is no default action left on this
// element and dispatches the touch with `cancelable: false`, where a preventDefault would do
// nothing but log "Ignored attempt to cancel a touchstart event" on every single press. WebKit is
// the engine that still has a gesture to run here — which is the bug — so it is the engine that
// still marks the event cancelable, and the one this line actually fires on.
boostButton?.addEventListener('touchstart', (event) => {
  if (event.cancelable) event.preventDefault();
}, { passive: false });

// The spacebar is the same hold, for the hand that is already on the keyboard rather than dragging
// the mouse down to a pill in the corner. Desktop-only by construction rather than by sniffing for
// a desktop: a phone with no keyboard never fires a keydown, and a phone *with* one has earned it.
//
// `event.code`, not `event.key`: the physical bar on any layout, and it survives the modifiers a
// `key` of ' ' does not distinguish.

// Whether *this* handler started the hold. A keyup it never saw the keydown for — one typed into
// the initials field, say — must not cancel a boost the player is holding on the pill.
let spaceHeld = false;

// Space is the browser's own activation key for whatever has focus, and taking it away from a
// focused control is an accessibility regression — tabbing to "Play again" and pressing space has
// to press *that*. So the hotkey only claims the key when focus is somewhere inert (the canvas, the
// body) or on the pill itself, where the two mean the same thing anyway. Without the pill exemption
// a player who clicked the pill once would have moved focus onto it and lost the hotkey: the
// browser would synthesise a `click`, which nothing here listens for, and the key would go dead.
function spaceIsSpokenFor(target) {
  if (!(target instanceof Element) || target === boostButton) return false;
  return Boolean(target.closest('input, textarea, select, button, a[href], [contenteditable]'));
}

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (spaceIsSpokenFor(event.target)) return;
  // The "Add to Home Screen" screen sits above the run and holds it, and dismisses itself on Space.
  // Same guard the tutorial uses (`isBlocked`): the press that clears that screen must not also
  // spend fuel on a taxi that is parked behind it.
  if (homeTip?.state.holding) return;
  // A paused run takes no input at all. `frame()` returns before `boost.update`, so a press behind
  // the veil would sit in 'active' burning nothing and then resume into a launch the player never
  // asked for — the mirror image of the release `createPause`'s `onChange` does on the way in. The
  // veil is only escaped by ⏸, Escape, P or a tap, all of which stay live.
  if (pause?.state.paused) return;
  // Stops the page scrolling under the game, and stops a focused pill turning the keystroke into a
  // synthesised click on top of the hold this is already starting.
  event.preventDefault();
  spaceHeld = true;
  holdLocoMode();
});

window.addEventListener('keyup', (event) => {
  if (event.code !== 'Space' || !spaceHeld) return;
  spaceHeld = false;
  boost.release();
});

// Alt-tabbing away or switching apps mid-hold should not leave the boost stuck on — and a keyup
// that lands on another window never reaches us at all, so this is the only end that hold gets.
window.addEventListener('blur', () => {
  spaceHeld = false;
  boost.release();
});
window.addEventListener('contextmenu', (e) => {
  if (e.target === boostButton) e.preventDefault();
});

// Rubber gets laid from the rear wheels while boosting through a corner or off the line, spaced
// by distance so the trail is even regardless of frame rate.
let lastSkidAt = 0;

// How long the launch keeps laying rubber after the button goes down. Time-boxed rather than
// distance-boxed: pressing while stopped at a red would otherwise hold the streak in reserve and
// spend it whenever the light finally changed. At boost speed 0.5s is roughly two car lengths of
// rubber, which reads as a chirp off the line without turning every tap into a burnout.
const LAUNCH_SKID_TIME = 0.5;
let launchSkidT = 0;

/** One pair of marks under the rear wheels, at the car's current pose. */
function stampRearRubber(car) {
  const fx = Math.cos(car.yaw);
  const fz = -Math.sin(car.yaw);
  const rx = Math.sin(car.yaw);
  const rz = Math.cos(car.yaw);
  for (const side of [-1, 1]) {
    skids.add(
      car.x - fx * 1.2 + rx * side * 1.04,
      car.z - fz * 1.2 + rz * side * 1.04,
      car.yaw,
    );
  }
}

function layRubber(dt) {
  const car = traffic.taxi;
  if (launchSkidT > 0) launchSkidT = Math.max(0, launchSkidT - dt);

  // `state === 'turn'` covers every junction crossing, including going straight on — which is why
  // rubber was appearing on the straights. An actual turn means the exit direction differs from
  // the entry one, and only after the straight run-up to the junction is done.
  const cornering = car.boost
    && car.state === 'turn'
    && car.dOut !== car.d
    && Math.min(car.turnT, 1) * car.turnLen > car.leadIn;

  // Releasing mid-launch cuts the streak short — `car.boost` is the same gate the corners use, so
  // letting go always stops the rubber wherever the car happens to be.
  const launching = car.boost && launchSkidT > 0;

  // And the overtake, both halves of it. Throwing a car a full lane sideways at the overdrive top
  // is the one manoeuvre in the game that breaks traction without turning a corner, and it was the
  // only one leaving nothing on the road. Keyed on the crab angle rather than on `passing`, so the
  // marks bracket the two lane *changes* — out and back — and stop while the taxi is simply
  // driving along in the borrowed lane, which is not a moment anything is sliding.
  const swapping = laysPassRubber(car);

  if (!cornering && !launching && !swapping) { lastSkidAt = car.travelled; return; }
  // Closer than one mark length, so consecutive stamps overlap into a continuous streak.
  if (car.travelled - lastSkidAt < 0.42) return;
  lastSkidAt = car.travelled;

  stampRearRubber(car);
}

// Dust comes off the back of the car whenever it's boosting and actually moving — not only in
// corners like the rubber, since the point is to make speed itself read.
//
// Two plumes, one per rear tyre, off the contact patch each one actually stands on
// (TAXI_REAR_* in geometry/taxi.js). It used to be a single puff on the centreline 1.9 back, which
// is behind the axle and between the wheels — dust with nothing under it. Coming off the tyres
// instead gives the mode the thing that reads as traction breaking: two trails that separate on a
// straight and swing apart through a corner, because the outside wheel is travelling further than
// the inside one. They still merge behind the car — a puff swells to END_SIZE 2.3 against a track
// of 2 × 0.83 — so what the wide shot keeps is a wider wake, and what the close shot gains is a
// pair of sources. Same puff either side: this is the one effect duplicated, not a new one.
let lastDustAt = 0;
function kickDust() {
  const car = traffic.taxi;
  if (!car.boost || car.v < 2) { lastDustAt = car.travelled; return; }
  if (car.travelled - lastDustAt < 0.47) return;
  lastDustAt = car.travelled;
  const fx = Math.cos(car.yaw);
  const fz = -Math.sin(car.yaw);
  const rx = Math.sin(car.yaw);
  const rz = Math.cos(car.yaw);
  for (const side of [-1, 1]) {
    dust.add(
      car.x - fx * TAXI_REAR_AXLE_BACK + rx * side * TAXI_REAR_TRACK,
      car.z - fz * TAXI_REAR_AXLE_BACK + rz * side * TAXI_REAR_TRACK,
      car.yaw,
    );
  }
}

// The cruiser gets the same treatment while it is running the taxi down — rubber when it throws
// the car sideways, dust off the back the whole way. Driven from here rather than from
// sim/police.js because the effect pools live on this side; police.js publishes the yaw rate and
// the distance travelled and this reads them.
//
// 2.6 rad/s is chosen to sit above the weave and below a corner: the Loco Mode wave peaks at about
// 1.4 rad/s of yaw through the eased nose, a junction taken at chase speed hits 4.5, and the
// U-turn always counts. Below the gap the cruiser laid a continuous streak down every straight,
// which reads as a car that is permanently out of control rather than one being thrown about.
const POLICE_SLIDE_RATE = 2.6;
let lastPoliceSkidAt = 0;
let lastPoliceDustAt = 0;
function policeRubber() {
  const p = police.state;
  if (!p.chasing) return;

  const yaw = police.group.rotation.y;
  const fx = Math.cos(yaw);
  const fz = -Math.sin(yaw);
  const rx = Math.sin(yaw);
  const rz = Math.cos(yaw);

  const sliding = p.uturn !== null || Math.abs(p.yawRate) > POLICE_SLIDE_RATE;
  if (!sliding) {
    lastPoliceSkidAt = p.travelled;
  } else if (p.travelled - lastPoliceSkidAt >= 0.42) {
    lastPoliceSkidAt = p.travelled;
    // Rear wheels, at the offsets policeGeometry() puts them.
    for (const side of [-1, 1]) {
      skids.add(
        police.group.position.x - fx * 1.08 + rx * side * 0.88,
        police.group.position.z - fz * 1.08 + rz * side * 0.88,
        yaw,
      );
    }
  }

  if (p.v < 2) { lastPoliceDustAt = p.travelled; return; }
  if (p.travelled - lastPoliceDustAt < 0.47) return;
  lastPoliceDustAt = p.travelled;
  dust.add(police.group.position.x - fx * 1.9, police.group.position.z - fz * 1.9, yaw);
}

// The "add it to your Home Screen" screen, on iOS in a browser tab — the one platform with no
// install affordance of its own. See game/homescreen.js for the detection and for why it is worth
// showing. It bows out on every other platform and on a device that already launched from the Home
// Screen icon, so there is nothing to gate here beyond shot mode: a screenshot is not a place to
// advertise anything. `?hometip` forces it up anywhere, since this path is otherwise invisible on
// the machine the layout is being written on.
//
// Built here rather than after the boot below because the frame loop reads its `holding` flag from
// the very first frame.
const homeTip = shot ? null : createHomeScreenTip(document.getElementById('home-tip'), {
  force: new URLSearchParams(window.location.search).has('hometip'),
});

// While that screen is up the run is parked: no fare spawns, and no clock drains. The traffic keeps
// driving behind the black — the screen sinks the city rather than replacing it, so a frozen one
// would be visible through the gradient — but the *fare loop* has to wait, or a rider appears
// behind the overlay with a 60-second deadline already running and a player who reads the screen
// slowly loses a run they never started. One shared empty list rather than a fresh one per frame.
//
// The opening vignette takes the same hold, for a closely related reason. The board is *seeded* by
// the first `update` — `shouldRefill` fills an empty board immediately — so leaving the fare loop
// running through the vignette stood a rider and a two-metre crystal on a kerb while the camera
// was down at the garage door, and on the seed this was first watched on, that kerb was the one
// the door faces. The board belongs to the run, and the run starts when the taxi is on the road.
const NO_FARE_EVENTS = [];
const fareLoopHeld = () => Boolean(homeTip?.state.holding) || Boolean(opening?.running());

// The ⏸ at the top of the HUD. Unlike the two holds above it this one stops the *whole* frame (see
// the early return in `frame()`), because a pause the player asked for has to give back a city in
// the state they left it — a fare clock held while the traffic kept driving would hand the taxi's
// own junction back with a car in it.
const pause = shot ? null : createPause({
  button: document.getElementById('pause'),
  veil: document.getElementById('pause-veil'),
  // Nothing left to hold once the run is over — and the retry screen owns the whole display then.
  // Never asked on the way out: a pause can always be lifted.
  canPause: () => !fares.state.gameOver,
  onChange: (paused) => {
    // A pause with the gas still down would resume into a boost the player is no longer holding —
    // the pill's own pointer never comes back up, because the veil took the release. Same reason
    // the window's `blur` handler drops it.
    if (paused) boost.release();
  },
});

const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  // Read on every frame, paused or not: `getDelta` measures from its own last call, so skipping it
  // while paused would hand the first frame after a resume the whole length of the pause. The clamp
  // caps that at 0.05s — not a teleport, but still a frame of city the player never saw, and the
  // clamp is there to survive a stalled tab rather than to license stalling on purpose.
  let dt = Math.min(clock.getDelta(), 0.05);

  // Paused. Nothing updates — not the traffic, not the clocks, not the sky — but the frame is still
  // drawn: with `preserveDrawingBuffer` off, a resize or a rotation with the veil up repaints the
  // canvas from an empty buffer, and the city would blink out until the player resumed.
  if (pause?.state.paused) {
    renderFrame();
    return;
  }

  // Time dilation for the crash. Scale the whole frame's dt so the blast, the camera pull-in and
  // the shake decay all slow together — that's what sells it as a single cinematic beat rather than
  // one element being pushed around while everything else runs normally. Ramps linearly from
  // `slowMoMin` back to 1.0 across SLOW_MO_DURATION ms wallclock; the banner delay is separately
  // wallclock-anchored so this doesn't change when the retry screen appears. The depth is per
  // event — a wreck bottoms out at SLOW_MO_MIN, a bust much shallower so the chase still moves.
  const nowMs = performance.now();
  // Held before the crash dilation below: the diagnostics panel's fps is a question about the
  // device, and a slow-motion wreck would otherwise read as one running at a third of its rate.
  const wallDt = dt;
  if (nowMs < slowMoUntil) {
    const t = 1 - (slowMoUntil - nowMs) / SLOW_MO_DURATION;
    dt *= slowMoMin + (1 - slowMoMin) * t;
  }

  boost.update(dt);
  // Never re-arm boost on a wrecked taxi — the flag would flick on the next frame otherwise and
  // the collision detector already only checks `if (taxi.boost)`. `taxi.boost` covers the hold
  // *and* the one-second cooldown tail after release — collision, police bust range and running
  // reds all key off it, see BOOST_COOLDOWN in game/boost.js. `boostEasing` is the narrower flag
  // that's only true during that tail; traffic.js reads it to ease the speed cap back down instead
  // of holding full boost speed for the whole cooldown window.
  if (!traffic.taxi.crashed) {
    traffic.taxi.boost = boost.isEngaged();
    traffic.taxi.boostEasing = boost.isCoolingDown();
  }
  updateBoostButton(dt);
  skids.update(dt);
  // Before the dust pool ticks, so a building's ground-burst is at age zero on the frame it fires.
  // The "Add to Home Screen" screen (iOS in a tab) *skips* the entrance outright rather than
  // holding it: the overlay shows the city sunk into black, and a city that hasn't built yet is a
  // bare street grid under the veil — which reads as a broken load, not as a treat being saved
  // for later. `holding` is true from the module's creation (see game/homescreen.js), so the
  // settle lands before the first frame ever draws an empty block. Everyone else — desktop, and
  // installed standalone iOS — never constructs the tip and keeps the animation.
  if (homeTip?.state.holding) {
    if (cityEntry.running()) cityEntry.settle();
  } else {
    cityEntry.update(dt);
  }
  dust.update(dt);
  blast.update(dt);
  flames.update(dt);
  vanish.update(dt);
  flyover.update(dt);
  chopper.update(dt);
  // Handed last frame's taxi position, which is all a startle needs — it is a distance test with
  // eight units of slack, and running it here rather than after `traffic.update` keeps the whole
  // scenery block in one place.
  for (const flock of flocks) flock.update(dt, traffic.taxi);
  controller.updateShake(dt, aspect());
  daylight.update(dt);

  // The two halves of the ramp that live in `sim/`. They are pushed rather than pulled because
  // `sim/` must not import from `game/` — the same reason `traffic.taxi.boost` is written here
  // rather than read there. Both are idempotent and cheap: the density call adds at most one car
  // and returns immediately once it is at the mark, and the cooldown range is two numbers.
  applyWorldPressure();

  // Before `traffic.update`, because the vignette *is* the taxi's physics while it runs: it writes
  // the car's position, heading and speed by hand, and the render pass inside `traffic.update`
  // reads them on the same frame. See game/opening.js for the staging split.
  opening?.update(dt);

  police.update(dt);   // may flip a whole corridor green before traffic reads the signals
  traffic.update(dt);
  // After traffic has settled positions for the frame — that's what the overlap check reads, and
  // what the two wreck shells are copied out of. A detected impact takes both cars out of the
  // sim from this frame on; the loops in traffic.js already skip a crashed car, so no further
  // plumbing is needed here.
  collisions.update();
  checkPoliceBust();
  // Last of the three, and both halves of that matter. It copies the matrices traffic composed
  // *this* frame, so running it any earlier would slide every outline off its own car by a couple
  // of pixels at boost speed; and it runs after collisions so a car wrecked on this frame is
  // already flagged, rather than wearing a ghost over its own fireball for one frame.
  carGhosts.update(dt);

  // After collisions, for the same reason collisions runs after traffic: the barricade test is a
  // position test, and a taxi wrecked on this frame must not also be launched off a ramp. The
  // kerb corners it is handed are the ones riders are standing on — a zone must not close the
  // street a fare is waiting in.
  roadwork.update(dt, traffic.taxi, traffic.cars, fares.occupiedSpots());

  tutorial?.update(dt);

  // The camera's priority list, highest first. Two of the claims trail the taxi and are
  // narrow-viewport only (see START_FOLLOW_SMOOTHING): the opening follow, which runs until the
  // player takes the framing over, and Loco Mode, which chases harder and outranks it. Boost
  // ignores `cameraTakenOver` on purpose — a drag during a boost is quietly overridden on the next
  // frame, because panning is a planning gesture and boost is the opposite of planning. None of
  // them has a gate on the way *out*: the camera is left wherever it landed rather than snapping
  // back. Both aim past the taxi rather than at it (`followAim`), so the road it is driving down
  // gets the frame the road behind it used to.
  //
  // End-of-run focus outranks everything (and runs on every viewport, not only narrow ones): the
  // camera eases into whatever ended the run — the crash site, the cop pulling up, or the corner a
  // fare's clock ran out on — so the last thing the player sees is the reason, framed, before the
  // retry screen shows. One claim for all three; only the point and the zoom differ.
  //
  // The tutorial sits below Loco Mode and above the opening follow, and unlike the follows it runs
  // on every viewport — a desktop player has the whole city in frame and still cannot tell which
  // car is theirs, which is the entire reason the first bubble exists. It frames from here rather
  // than from its own update() so this list stays the one place the camera is decided.
  // The opening vignette outranks all of it, and on every viewport: it is a cut scene, and nothing
  // else can be claiming the framing three seconds into a run anyway. It hands back by letting
  // `holdsCamera` go false with the camera already sitting on `restFraming()` below, so there is
  // no gap for the follow-cam to snap across.
  const boosting = boost.isActive();
  if (opening?.holdsCamera()) {
    opening.frameCamera(dt);
  } else if (endSpot) {
    controller.focusOn(endSpot.x, endSpot.z, endZoom, dt, aspect());
  } else if (boosting && !fares.state.gameOver && isNarrow()) {
    controller.followXZ(traffic.taxi.x, traffic.taxi.z, dt, BOOST_FOLLOW_SMOOTHING, aspect(),
      followAim(traffic.taxi));
  } else if (tutorial?.holdsCamera()) {
    tutorial.frameCamera(dt);
  } else if (!cameraTakenOver && !fares.state.gameOver && isNarrow()) {
    controller.followXZ(traffic.taxi.x, traffic.taxi.z, dt, START_FOLLOW_SMOOTHING, aspect(),
      followAim(traffic.taxi));
  } else {
    // Bottom of the same priority list: a rider-finder chip's peek (see panToRider) — the pan out,
    // the beat on the rider and the ride home are all one glide, so all three sit at this rung. It
    // only ever gets here because the tap that started it also took the camera over, so the opening
    // follow is already out of the way; a wreck or a boost landing mid-peek drops it — both
    // `focusOn` and `followXZ` cancel it — rather than resuming a move the player has stopped
    // caring about. A no-op when nothing is panning, which is every frame on a desktop.
    controller.updateGlide(dt, aspect());
  }

  // More than one thing can land in a frame now — delivering the last fare clears the board and
  // spawns the next one in the same tick — so this is a list rather than a single event.
  for (const { type, fare } of
    (fareLoopHeld() ? NO_FARE_EVENTS : fares.update(dt, traffic.taxi))) {
    if (type === 'pickup') {
      traffic.taxi.route = [];
      traffic.taxi.pendingTarget = null;
      // The roof sign lights up while the rider is aboard.
      traffic.setTaxiOccupied(true);
      // Straight on to where they're going, on the same frame the pin appears — no kerb hold and
      // no confirming tap.
      dispatchToDropoff(fare);
    } else if (type === 'delivered') {
      popEarning(fare.value);
      updateStreak(difficulty.payoutMultiplier(fares.state.delivered));
      // A third of a tank of boost fuel as the ordinary delivery reward — the only way any fuel
      // enters the meter otherwise. A VIP pays out bigger here too: the tank tops all the way to
      // full rather than by a third, on the same delayed pour as everything else so it reads as
      // the same reward, just a bigger one. Read at arrival time rather than baked in now, so a
      // tank that drained (or filled) during the flight still tops out exactly full.
      flyEnergyToBoost({
        from: taxiScreenPos,
        to: boostScreenPos,
        onArrive: () => boost.topUp(fare.vip ? 1 - boost.fraction() : BOOST_FARE_REWARD),
      });
      traffic.taxi.route = [];
      traffic.taxi.pendingTarget = null;
      traffic.setTaxiOccupied(false);
    } else if (type === 'failed') {
      // The run ended on a clock rather than on an impact — see the TIMEOUT_* block. The camera
      // takes the corner the fare was counting down to (`failSpot`, left standing by fares.js), the
      // sim drops into a shallow slow-mo, and the retry screen waits for both.
      //
      // The taxi stops for it, the same way it does for a bust and for the same reason: the run is
      // over, and a car still driving a route to a fare that no longer exists — through the very
      // ring the shot is holding on — argues with the ending being shown. `crashed` is the flag
      // every loop in traffic.js already skips, so it does the whole job. Boost goes with it, or a
      // held pill would keep burning fuel behind the banner.
      endSpot = fares.state.failSpot ?? { x: traffic.taxi.x, z: traffic.taxi.z };
      endZoom = TIMEOUT_ZOOM;
      crashBannerAt = performance.now() + TIMEOUT_BANNER_DELAY;
      slowMoUntil = performance.now() + SLOW_MO_DURATION;
      slowMoMin = TIMEOUT_SLOW_MO_MIN;
      traffic.taxi.crashed = true;
      traffic.taxi.v = 0;
      boost.release();
    } else if (type === 'vip-missed') {
      // The one fare whose clock running out isn't a run-ending event — see fares.js. If it was
      // riding, the taxi is holding an empty seat with nowhere left to drive; free it up exactly
      // as a delivery would, minus the payout.
      if (fare.stage === 'riding') {
        traffic.taxi.route = [];
        traffic.taxi.pendingTarget = null;
        traffic.setTaxiOccupied(false);
      }
    }
  }

  // The package courier. Ticked after the fare loop so its spawn placement sees this frame's fare
  // board, and given nothing but the three facts it needs — where the fares are, how far up the ramp
  // the run is, and whether the run is over. With a rider aboard nothing routes the taxi at a
  // package — the player collects one by bending the route band through its pad — but an empty-seat
  // tap dispatches straight at one (see divertToParcel), and that drive has to retire on arrival
  // the way a fare's own legs do: the route-clearing on `'pickup'` and `'delivered'` below, guarded
  // on `pendingTarget`'s identity so a detour's collection leaves the fare's route alone.
  // See game/parcels.js.
  for (const { type, parcel, at } of
    (parcels && !fareLoopHeld()
      ? parcels.update(dt, traffic.taxi, {
        fareSpots: fares.occupiedSpots(),
        delivered: fares.state.delivered,
        over: fares.state.gameOver,
      })
      : NO_FARE_EVENTS)) {
    if (type === 'pickup') {
      // A box that was the destination — an empty-seat dispatch — retires the drive on arrival.
      // Without this the consumed route's stub and the stale `pendingTarget` keep the band
      // machinery live against a corner that no longer has anything on it. Guarded on identity so
      // a detour's collection leaves the fare's route alone.
      if (traffic.taxi.pendingTarget === parcel.pickup) {
        traffic.taxi.route = [];
        traffic.taxi.pendingTarget = null;
      }
      // The car's own acknowledgement, on the frame the detour paid off and the box leaves the pad.
      // It is not "the load arrived here" — the load is on its way to the corner of the screen — it is
      // the same flourish a tapped rider gets, fired on the object the player is watching at the
      // moment they collected something. Nothing appears on the taxi: there is no deck parcel any
      // more, which is what lets the pickup be one journey out of the world rather than two hops.
      flashTaxi();
    } else if (type === 'loaded') {
      // The lift is nearly done and the box is nearly transparent. `at` is where it had got to, in the
      // world, on *this* frame — `parcels.js` owns that fact; turning it into a pixel is this module's
      // half, because the projection is. The chip then comes in from that direction under the last of
      // the fade (see `flyIn` in game/cargochip.js).
      if (at && cargoChip) {
        const p = projectToScreen(at.x, at.y, at.z);
        cargoChip.flyIn({ x: p.x, y: p.y, yaw: at.yaw });
      } else {
        cargoChip?.setCarrying(true);
      }
    } else if (type === 'delivered') {
      // Same retirement as `'pickup'` above, for a dispatch aimed at the drop-off pad.
      if (traffic.taxi.pendingTarget === parcel.dropoff) {
        traffic.taxi.route = [];
        traffic.taxi.pendingTarget = null;
      }
      // The chip goes down now rather than when the outbound box lands, because that box *is* the load
      // leaving: the corner still holding one while a package is being set down on a pad would read as
      // the taxi carrying a second.
      cargoChip?.setCarrying(false);
      // Cash and fuel, the same two currencies a drop-off pays, and both take the same two-phase
      // flight a fare's does — off the taxi, then to the counter and to the pill — because it is the
      // same kind of event arriving from the same place, and a bonus that landed in either place
      // with no visible link to the car would read as a side effect. The fuel is deliberately *half*
      // a fare's (see BOOST_PARCEL_REWARD): an errand pays into the tank, but a fare still fills it
      // twice as fast, so the courier layer stays a detour rather than the way you fuel a run. What
      // a package still does not touch is the multiplier — that number means "this is what a *fare*
      // is worth now", and a package is not a fare.
      fares.credit(parcel.value);
      popEarning(parcel.value);
      flyEnergyToBoost({
        from: taxiScreenPos,
        to: boostScreenPos,
        onArrive: () => boost.topUp(BOOST_PARCEL_REWARD),
      });
    }
  }

  // The taxi's flourish, on the select pop's own envelope (game/selectpop.js) so a package landing in
  // the car — or the camera landing back on it — reads as the same *kind* of acknowledgement a tapped
  // rider gets rather than as a new effect to learn. Written every frame while it runs, so the frame
  // it retires is the one that puts the car back — and clamped at zero on the way out, because a
  // light going negative would dim the taxi below the city it is driving in.
  if (taxiFlashAt !== null) {
    const since = fares.state.elapsed - taxiFlashAt;
    if (since >= POP_TIME) {
      traffic.setTaxiHighlight(0);
      taxiFlashAt = null;
    } else {
      traffic.setTaxiHighlight(popHighlight(since));
    }
  }

  // Before the band is rebuilt, not after: a drag re-plans the route from where the taxi is *now*,
  // and the handle and the grab bloom are placed against the path that re-plan produces. Drawing
  // first would put both of them on last frame's route for a frame every time the detour changed.
  pathDrag.update(dt);

  // The route is a property of the selection, not of the world — deselecting clears it from view
  // even though the taxi keeps driving it.
  if (selected && traffic.taxi.pendingTarget && !fares.state.gameOver) {
    paintRouteBand();
    routeLine.update(traffic.taxi, traffic.taxi.route, dt);
  } else {
    routeLine.hide();
  }

  layRubber(dt);
  kickDust();
  policeRubber();
  updateHud(dt);
  riderFinder.update(dt, fares.waitingAll());
  // Armed only when nothing else already has the framing in hand: a run that has ended has the
  // closing shot, the tutorial is pointing the camera at the city itself, and a pan in flight is
  // already on its way somewhere — including this chip's own, which is what drops it on the tap.
  taxiFinder.update(dt, traffic.taxi,
    !fares.state.gameOver && !controller.isGliding() && !tutorial?.holdsCamera());
  // A no-op unless a package is aboard — it draws nothing while the chip is down.
  cargoChip?.render();
  // The arrow stands in for the ring it points at, so it is painted from the same fare — see
  // game/dropoffindicator.js.
  const aboard = fares.carrying();
  dropoffIndicator.update(aboard, aboard && fares.colorOf(aboard));
  // After the police update above, so the wash is aimed at where the cruiser is this frame rather
  // than trailing it by one.
  sirenGlow.update(police, traffic.taxi);
  renderFrame();
  // After the render, not before: `renderer.info` resets itself at the top of every `render()`,
  // so this is the frame that just went to the screen rather than the one before it.
  diag.update(wallDt);
}

if (shot) {
  document.body.classList.add('shot-mode');
  traffic.warmup(shot.warmup ?? 12);
  fares.update(0.016, traffic.taxi);          // spawn the first fare

  // Send the taxi at whichever fare the shot is about, and keep it directed there.
  // `pop: false` — the select pop is feedback for a finger, and there isn't one here. A shot that
  // staged its dispatch a frame or two before rendering would otherwise freeze a rider mid-swell.
  const send = (fare = fares.focus()) => {
    if (fare && routeTo(fare.target)) fares.markDirected(fare, { pop: false });
    return fare;
  };

  // Some shots are about the carrying state, which only exists after a pickup. Auto-play the
  // fare loop forward until it happens rather than pointing a camera at an arbitrary moment.
  if (shot.untilPickup) {
    send();
    for (let guard = 0; guard < 90 * 60 && !fares.carrying(); guard++) {
      traffic.update(1 / 60);
      for (const { type, fare } of fares.update(1 / 60, traffic.taxi)) {
        if (type !== 'pickup') continue;
        traffic.setTaxiOccupied(true);
        // Shot mode's stand-in for dispatchToDropoff — the interactive pickup path is in the frame
        // loop, which a shot never runs.
        send(fare);
        // Let the fare's diamond finish flying to the taxi, or the shot catches it mid-flight.
        for (let settle = 0; settle < 90; settle++) {
          traffic.update(1 / 60);
          fares.update(1 / 60, traffic.taxi);
        }
      }
    }
  }

  // Fill the board to the cap. Spawns are staggered by `difficulty.spawnGap`, so this is a matter
  // of running the clock — but the clock cannot simply be run, because a taxi that serves nobody
  // loses the first rider to their own deadline and the run is over before the second arrives
  // (the first attempt at this shot rendered the game-over screen). So it auto-plays the loop the
  // way `tools/soak.mjs` does: carry whoever is aboard, then the most urgent waiter.
  if (shot.untilBoardFull) {
    const want = difficulty.maxFares(0);
    let aim = null;
    for (let guard = 0; guard < 180 * 60; guard++) {
      if (fares.state.gameOver || fares.state.fares.length >= want) break;
      traffic.update(1 / 60);
      for (const { type, fare } of fares.update(1 / 60, traffic.taxi)) {
        if (type === 'pickup') { traffic.setTaxiOccupied(true); send(fare); }
        if (type === 'delivered') traffic.setTaxiOccupied(false);
      }
      const job = fares.carrying() ?? fares.waiting();
      if (job && job !== aim && !job.directed) { aim = send(job); }
    }
  }

  // Run forward until the police car is mid-city, so the shot shows a live corridor. `armed` is
  // the same "a block in from the edge" test this used to spell out as `|s| < 30`, and asking for
  // it by name keeps the shot from drifting off the arming line: armed is exactly the band where
  // the cruiser is fully opaque with its bar running, which is the car worth photographing.
  if (shot.untilPolice) {
    for (let guard = 0; guard < 90 * 60; guard++) {
      police.update(1 / 60);
      traffic.update(1 / 60);
      fares.update(1 / 60, traffic.taxi);
      if (police.state.armed) break;
    }
    // Follow the car rather than hoping it drives through the middle of the frame.
    const pos = police.group.position;
    controller.state.target.set(pos.x, 0, pos.z);
    controller.update(aspect());
  }

  // Stage an actual crash and freeze it `wreckAt` seconds in. The real path is driven rather than
  // mocked — the taxi is parked on top of an ambient car with boost on, and `collisions.update()`
  // detonates it through the same handler a live run uses — so this framing cannot drift out of
  // step with the crash it exists to review. Only the blast and the shrinking shells are stepped
  // afterwards: traffic must stay still, or the rest of the city drives on under a frozen wreck.
  if (shot.wreckAt) {
    // Offset by a couple of units along the victim's heading rather than parked exactly on it: a
    // real impact leaves the two centres about that far apart, and the pair of detonations spread
    // across both bodies is half of what the crash looks like.
    const victim = traffic.cars.find((c) => !c.isTaxi && c.state === 'drive');
    traffic.taxi.x = victim.x - Math.cos(victim.yaw) * 2;
    traffic.taxi.z = victim.z + Math.sin(victim.yaw) * 2;
    traffic.taxi.yaw = victim.yaw;
    traffic.taxi.boost = true;
    for (let guard = 0; guard < 90 && !traffic.taxi.crashed; guard++) {
      collisions.update();
      traffic.update(1 / 60);
    }
    controller.state.target.set(endSpot?.x ?? victim.x, 0, endSpot?.z ?? victim.z);
    controller.update(aspect());
    for (let step = 0; step < Math.round(shot.wreckAt * 60); step++) {
      blast.update(1 / 60);
      vanish.update(1 / 60);
      // The smoke collar is part of the wreck now, and it lives in the dust pool rather than in
      // blast.js — left out of this loop, `?shot=12` would freeze a crash with its smoke still
      // stacked on the impact point at zero age.
      dust.update(1 / 60);
    }
  }

  // Stage a flight and freeze it partway across. The plane is up for about six seconds every
  // minute or so, so without this the only way to look at one is to load the game and wait —
  // the same reason the wreck has a shot. `flyoverAt` is seconds into the flight; the run seed
  // fixes the heading, so the framing is reproducible.
  if (shot.flyoverAt) {
    flyover.launch();
    for (let step = 0; step < Math.round(shot.flyoverAt * 60); step++) flyover.update(1 / 60);
    // Follow the aeroplane rather than hoping it crosses the middle of the frame — the heading and
    // the sideways offset of the flight line are both drawn from the run seed. Same reason the
    // police shot chases its cruiser, with one extra step: the camera aims at a point on the
    // *ground*, and an orthographic camera projects everything along VIEW_DIR to the same place, so
    // the ground point that shares the aeroplane's screen position is its own position slid back
    // down the view axis to y = 0. Aiming at the point under it puts it 33 units off the top of a
    // close framing.
    const p = flyover.group.position;
    const drop = p.y / VIEW_DIR.y;
    controller.state.target.set(p.x - drop * VIEW_DIR.x, 0, p.z - drop * VIEW_DIR.z);
    controller.update(aspect());
  }

  // Stage a helicopter visit and freeze it wherever it has got to. `heliAt` is seconds into the
  // approach, which is enough to reach any part of it: the run is about 25 seconds door to door
  // (8 in, 2 down, 9 on the deck, 6 away), and the seed fixes the heading, so a given number is
  // the same picture every time.
  //
  // The camera follows the machine rather than the pad, with the same correction the flyover's aim
  // needs: an orthographic camera projects everything along VIEW_DIR onto the same screen point, so
  // aiming at the point *under* something eleven storeys up puts it off the top of a close framing.
  // Slide it back down the view axis to y = 0 instead.
  if (shot.heliAt !== undefined && chopper.group) {
    chopper.visit();
    for (let step = 0; step < Math.round(shot.heliAt * 60); step++) {
      chopper.update(1 / 60);
      // Stepped *with* it rather than afterwards. The wash rides in the dust pool, and a pool that
      // is only started once the flight is over shows every puff of a two-second landing at the
      // same age — the wreck-smoke lesson, on a roof.
      dust.update(1 / 60);
    }
    const p = chopper.position();
    const drop = p.y / VIEW_DIR.y;
    controller.state.target.set(p.x - drop * VIEW_DIR.x, 0, p.z - drop * VIEW_DIR.z);
    controller.update(aspect());
  }

  // Stage a take-off and freeze it partway up. Same argument as the flyover and the wreck: the
  // flock is on the grass for most of a run and the departure is over in a couple of seconds, so
  // without this the only way to look at one is to load the game and drive at a park. `birdsAt` is
  // seconds into the climb. The camera is aimed at the park rather than at the birds because which
  // park they picked comes from the run seed and moves between shots — and because an orthographic
  // camera aimed at a point in the air is aimed at the wrong point on the ground.
  //
  // Both flocks go up, and the framing follows the first: the second is a park or more away and a
  // zoom that held them both would put each of them back to a handful of pixels, which is the thing
  // this shot exists to look at closely.
  if (shot.birdsAt !== undefined) {
    for (const flock of flocks) flock.takeOff();
    for (let step = 0; step < Math.round(shot.birdsAt * 60); step++) {
      for (const flock of flocks) flock.update(1 / 60);
    }
    // Null only in the stub a parkless city gets, which no seed the generator has actually
    // produced — the shot then keeps whatever framing it was given.
    const home = flocks[0].state.area;
    if (home) {
      controller.state.target.set((home.x0 + home.x1) / 2, 0, (home.z0 + home.z1) / 2);
      controller.update(aspect());
    }
  }

  // Stage a construction zone and let it finish rising out of the road. Placed through the same
  // `place()` a live run calls, so the framing cannot drift out of step with what the player gets
  // — and the camera is aimed at whichever street it picked, since that is drawn from the run seed
  // and moves between shots.
  if (shot.roadworkAt !== undefined) {
    roadwork.place(traffic.taxi, traffic.cars, fares.occupiedSpots());
    for (let step = 0; step < Math.round(shot.roadworkAt * 60); step++) {
      roadwork.update(1 / 60, traffic.taxi, traffic.cars, []);
    }
    const cones = roadwork.cones;
    if (cones.length) {
      const mid = cones[Math.floor(cones.length / 2)];
      controller.state.target.set(mid.x, 0, mid.z);
      controller.update(aspect());
    }
  }

  // Drive the taxi into a barricade and freeze it mid-arc. The real path is driven rather than
  // mocked — the car is put on the closed lane a unit short of the trestle and the sim is stepped
  // — so this framing cannot drift out of step with what the player gets. The zone is let finish
  // rising first: a barricade half out of the road is a different picture.
  if (shot.smashAt) {
    const net = cityNetwork();
    while (roadwork.state.phase !== 'live') {
      roadwork.update(1 / 60, traffic.taxi, traffic.cars, []);
    }
    const lane = net.laneById.get(roadwork.closedLaneIds[0]);
    const landing = net.nodeById.get(lane.to);
    // placeCar takes the junction the car is *heading for*, so this lands it on the closed lane.
    placeCar(traffic.taxi, net.dirOfLane(lane), landing.gi, landing.gj, lane.length - 1);
    traffic.taxi.boost = true;
    traffic.taxi.v = 18;
    for (let guard = 0; guard < 240 && !roadwork.barriers.some((b) => b.hit); guard++) {
      traffic.update(1 / 60);
      roadwork.update(1 / 60, traffic.taxi, traffic.cars, []);
    }
    for (let step = 0; step < Math.round(shot.smashAt * 60); step++) {
      traffic.update(1 / 60);
      roadwork.update(1 / 60, traffic.taxi, traffic.cars, []);
      dust.update(1 / 60);
    }
    controller.state.target.set(traffic.taxi.x, 0, traffic.taxi.z);
    controller.update(aspect());
  }

  // Frame the drop-off of the fare aboard, on the kerb corner the pin actually stands on rather
  // than the junction centre — same reason as the rider below, the corner building is in the way.
  const aboard = fares.carrying();
  if (shot.atDropoff && aboard) {
    const c = cornerFor(aboard.target.i, aboard.target.j);
    controller.state.target.set(c.x, 0, c.z);
    controller.update(aspect());
  }

  // The package courier. Its board is gated on a delivered fare and a spawn gap, neither of which a
  // still frame has time for, so the gate is opened by hand: `delivered` is faked past
  // `PARCEL_MIN_DELIVERED` and the stagger is reset, then one tick puts a box on a corner.
  //
  // Only reachable with `?parcels=1`, which is also what turns the layer on in shot mode at all.
  if (shot.untilParcel && parcels) {
    parcels.state.nextSpawnAt = -Infinity;
    parcels.update(1 / 60, traffic.taxi, { fareSpots: fares.occupiedSpots(), delivered: 9 });
    // A few frames of sim time so the box is mid-spin rather than dead square to the camera, which
    // reads as a crate rather than as something waiting to be collected.
    for (let settle = 0; settle < 24; settle++) {
      parcels.update(1 / 60, traffic.taxi, { fareSpots: fares.occupiedSpots(), delivered: 9 });
    }
    const box = parcels.state.parcels[0];
    if (box) {
      // The kerb corner, not the junction centre — at close zoom the corner building stands squarely
      // between the camera and anything on the pavement. Same reason `atPassenger` does it.
      //
      // There were two more courier framings here, and both went with the deck parcel: `parcel-aboard`
      // photographed the box riding on the car, and `parcel-flight` froze the crossing `flightAt` of
      // the way along. A collected box goes to the HUD now, and shot mode hides the HUD — so what
      // those two framed no longer exists in a still. The flight is checked in `tools/smoke.mjs`, on a
      // page, which is the only place a DOM animation can be checked at all.
      const c = cornerFor(box.pickup.i, box.pickup.j);
      controller.state.target.set(c.x, 0, c.z);
      controller.update(aspect());
    }
  }

  // Frame the waiting rider rather than the middle of the map.
  const framed = fares.focus();
  if (shot.atPassenger && framed) {
    // Aim at the kerb the rider is standing on, not the middle of the junction — at close zoom
    // the corner building sits squarely between the camera and the figure otherwise.
    const c = cornerFor(framed.target.i, framed.target.j);
    controller.state.target.set(c.x, 0, c.z);
    controller.update(aspect());
  }


  // Not at a fare: at the opposite corner of the map, which is the only way to get a route
  // long enough to judge the band that draws it.
  if (shot.routeFar) {
    routeTo({ i: traffic.taxi.i > GRID / 2 ? 0 : GRID, j: traffic.taxi.j > GRID / 2 ? 0 : GRID });
    // Framed on the taxi rather than the middle of the map: the head of the band — the gap in
    // front of the bumper and the fade after it — is the part that needs looking at, and where
    // the taxi starts moves with the run seed.
    controller.state.target.set(traffic.taxi.x, 0, traffic.taxi.z);
    controller.update(aspect());
  }

  if (shot.route) send();
  // A finger on the band. The grab eases in over GRAB_RISE, so the settling dt below has to cover
  // it — it does, being the same 999 that settles the rollout sweep.
  if (shot.grabAt != null && traffic.taxi.pendingTarget) {
    const at = pointAlongPath(routePath(traffic.taxi, traffic.taxi.route), shot.grabAt);
    routeLine.setGrab(true, at.along);
    pathDrag.stage(at.x, at.z);
    pathDrag.update(999);
    // Aimed at the grab rather than at the taxi the way `routeFar` leaves it. The whole subject is
    // a bloom 11 units across on a route that runs to the far corner of the map — the first cut of
    // this shot framed the car and put the flourish off the bottom of the frame entirely.
    controller.state.target.set(at.x, 0, at.z);
    controller.update(aspect());
  }
  if (selected && traffic.taxi.pendingTarget) {
    paintRouteBand();
    // A shot reviews the band's steady state, not the moment it was picked — a shot mode frame is
    // never followed by another, so with a real dt the rollout sweep would freeze here mid-animation
    // and every route shot would show a truncated band. A dt this large settles even the longest
    // route's sweep well before this single frame renders.
    routeLine.update(traffic.taxi, traffic.taxi.route, 999);
  }
  // Same argument as the band's 999 above, for the discs and pads: a shot frame is never followed by
  // another, and a disc that grows out of its own centre is a function of sim time. A shot ticks the
  // fare loop once, so the grow never got past its first frame — and every rider's kerb disc went
  // missing from every screenshot the day that animation landed. This lands them all instead.
  fares.settleMarkers();
  parcels?.settleMarkers();
  // The city's own entrance is an animation that opens at zero too — unsettled, every screenshot
  // is an empty street grid.
  cityEntry.settle();
  // Shot mode never stages the taxi, so there is no vignette to land — but the garage still has to
  // be in the state a run is actually played in, which is shut, the car long gone and the door
  // come down behind it.
  garage?.setDoor(0);
  renderFrame();
  document.body.dataset.shotReady = 'true';
} else {
  traffic.warmup(10);
  // The opening vignette, and it is built here rather than up with everything else for one
  // reason: constructing it parks the taxi inside the garage, and the warm-up above would have
  // driven it back out. See game/opening.js.
  if (garage) {
    opening = createOpening({
      site: garage.site,
      setDoor: garage.setDoor,
      taxi: traffic.taxi,
      taxiGroup: traffic.taxiGroup,
      cars: traffic.cars,
      controller,
      aspect,
      playZoom: PLAY_ZOOM,
      // Where the camera is left. The same decision the priority list makes every other frame:
      // the whole city on a desktop, the car on a phone — where the opening follow-cam is about
      // to pick the framing up. Read per frame, because the taxi is moving while it is read.
      restFraming: () => (isNarrow()
        ? { x: traffic.taxi.x, z: traffic.taxi.z }
        : { x: 0, z: 0 }),
      // The city's own entrance goes first. Both are held behind the Home Screen tip on iOS in a
      // tab, which parks the whole run until it is dismissed.
      isBlocked: () => Boolean(homeTip?.state.holding) || cityEntry.running(),
      // Off the kerb. The same pool and the same call the boost trail uses, at about half a
      // barricade's power — two wheels coming off a 0.35-unit lip, not a car landing off a ramp.
      onDrop: () => dust.burst(traffic.taxi.x, traffic.taxi.z, traffic.taxi.yaw, 7, 0.5),
    });
    // `?vignette=off`, the same escape hatch `?tutorial=off` is: the opening is seven seconds
    // long and nobody iterating on the fare loop wants it on every reload. The module is
    // still constructed and then *landed* rather than not built at all, so the skip goes through
    // the same handover the real sequence does — a skip that reached the game by a different route
    // would be a second opening to keep working.
    if (!wantsVignette) opening.settle();
  }
  // Re-aim the entrance wave at the taxi *after* the warmup: it was created with the spawn
  // point, and ten sim-seconds of warmup drive the taxi a couple of blocks from there — so the
  // wave was visibly emanating from a spot the player's car had already left. Costs nothing:
  // the entrance clock hasn't taken its first tick yet. With a garage in the city the taxi is
  // already parked inside it by now, so the city builds itself outward from the depot — which is
  // exactly where the camera is about to go.
  cityEntry.replay(traffic.taxi);
  frame();
}

// The gear button sits top-right at small widths and started overlapping the streak counter
// there — most players never open it anyway, so it's opt-in now: `?debug` or `?settings` in the
// URL, either present with no value needed.
const wantsDebugPanel = new URLSearchParams(window.location.search);
if (!shot && (wantsDebugPanel.has('debug') || wantsDebugPanel.has('settings'))) {
  createDebugPanel({
    sun,
    hemi,
    sky,
    fog,
    daylight,
    carCount: getCarCount(),
    fares: { getSeconds: getFareSeconds, setSeconds: setFareSeconds, isPinned: isFareClockPinned },
    routeLine,
    ao,
    scores: { load: loadScores, clear: clearScores },
    // The entrance levers. The panel's replay re-aims the wave at wherever the taxi is *now* —
    // the point of replaying from the panel is judging the opening, and the opening's wave starts
    // at the player's car.
    cityEntry: {
      tuning: cityEntry.tuning,
      tune: cityEntry.tune,
      replay: () => cityEntry.replay(traffic.taxi),
    },
  });
}

window.__taxi = {
  traffic,
  daylight,
  boost,
  tutorial,
  carGhosts,
  skids,
  police,
  fares,
  /** The package courier, or null under `?parcels=0` and in shot mode. See game/parcels.js. */
  parcels,
  /**
   * The HUD's courier box, for `tools/smoke.mjs` — null whenever `parcels` is. Everything about this
   * chip is browser-only (a WebGL context in a DOM node, and now a Web Animation carrying it in from
   * the city), so a page is the only place it can be asserted at all. `flyIn` is what a `'pickup'`
   * does to it; `setCarrying` is the flightless version of the same, and what a delivery puts back.
   */
  cargoChip,
  /**
   * The "back to the taxi" chip, for `tools/smoke.mjs`: `isUp()` is whether it is currently
   * offering itself. Browser-only in the same way the cargo chip is — a WebGL context in a DOM
   * node, driven off a projection through the live camera.
   */
  taxiFinder,
  flyover,
  chopper,
  /**
   * The taxi's depot and the vignette that comes out of it, or null on a city with nowhere to put
   * one (and, for `opening`, in shot mode). `garage.setDoor(0..1)` scrubs the shutter by hand and
   * `opening.phase()` names where the sequence has got to — which is how `tools/smoke.mjs` watches
   * it without guessing at wallclock.
   */
  garage,
  opening: () => opening,
  /** The opening rise-out-of-the-ground animation. `cityEntry.replay()` reruns it on demand. */
  cityEntry,
  // Every flock in the city, in build order — `flocks[0]` is the one shot 18 frames.
  flocks,
  roadwork,
  pause,
  routeTo,
  findRoute,
  findRouteVia,
  /** The route-band drag, for `tools/smoke.mjs`: `isGrabbing`, `didDrag`, `via`. */
  pathDrag,
  camera: controller,
  /**
   * The band of paint down the road. Exposed for `tools/smoke.mjs`: the *wiring* that paints it in
   * the fare's clock lives in the frame loop up there, so the node suite can only assert the two
   * halves it joins — this is the one place the join itself is visible.
   */
  routeLine,
  isSelected: () => selected,
  /**
   * The high-score table, for `tools/smoke.mjs` — the node suite drives `game/highscores.js`
   * against a fake store, so this is the only place the *real* `localStorage` round trip is
   * exercised. `isRanked` is exposed alongside it because "why did my run not save?" is otherwise
   * a silent answer spread over four URL flags.
   */
  scores: { load: loadScores, record: recordRun, clear: clearScores, isRanked: isRankedRun },
  /**
   * Draw one frame on demand.
   *
   * Shot mode never starts the render loop — it warms the sim, renders once and stops — so a shot
   * poked from the console or over CDP keeps showing the frame it froze on. This is what makes a
   * frozen framing reviewable at states the shot list doesn't cover: set a fare's clock, redraw,
   * capture. Harmless while the loop is running, since the next frame overwrites it anyway.
   */
  redraw: () => renderFrame(),
  /**
   * Put the run-end screen up on demand, over a stub run — for `tools/smoke.mjs`.
   *
   * The initials prompt is the one screen in this game made of DOM a finger actually interacts
   * with: a real field, a real caret, a real soft keyboard. None of that exists in the node suite,
   * and the only other way in is to lose a run first, so the browser test needs a door. Everything
   * the screen needs has a default here; the test overrides just the part it is checking.
   */
  showRunEnd: (opts = {}) => showRunEnd(hud.banner, {
    title: 'Shift over',
    reason: '',
    stats: [{ label: 'Cash', value: 0, format: (n) => `$${n}` }],
    onRetry: () => {},
    ...opts,
  }),
  /** Screen-space helpers so the browser smoke test can click real pixels. */
  taxiScreenPosition: taxiScreenPos,
  /**
   * A point part way along the drawn route band, in screen space — the thing `tools/smoke.mjs`
   * has to press on to test the drag. Taken off the same `routePath` the band is built from, so a
   * band that stopped being drawn where the tool thinks it is fails rather than drifting.
   */
  routeScreenPosition: (fraction = 0.45) => {
    const path = routePath(traffic.taxi, traffic.taxi.route);
    if (path.length < 2) return null;
    // Along the band's *length*, not along its point indices. A junction arc is ten points over
    // four units and a straight is two points over twenty, so the middle by index is nowhere near
    // the middle by distance — half way through a two-leg route landed inside the first turn, a
    // couple of units from the car, which is inside the head gap where the band is not drawn and
    // a grab is refused. The tool read that as the drag being broken, intermittently.
    const at = pointAlongPath(path, fraction);
    return projectToScreen(at.x, 0, at.z);
  },
  /** The pin the player is meant to be driving at — the newest one if two are on the board. */
  targetScreenPosition: (fare = fares.focus()) => {
    if (!fare) return null;
    const c = fares.intersectionCentre(fare.target.i, fare.target.j);
    return projectToScreen(c.x, 5, c.z);
  },
  /**
   * Where to tap to reach the live end of the courier errand, for `tools/smoke.mjs`.
   *
   * The tap is a picker interaction, which is the one class of thing the node suite is blind to:
   * everything it could assert about `divertToParcel` is the router's, and what a browser has to
   * answer is whether a finger on that corner reaches the hit box at all — the same reason the
   * route-band drag is smoke-tested rather than probed.
   *
   * Aimed at the *junction centre* rather than the pad, matching `targetScreenPosition` above: the
   * hit box is 20 units square and centred there, so a centre tap is inside it at any camera angle
   * while the pad's own corner is 4 units out toward one edge.
   */
  parcelScreenPosition: (parcel = parcels?.state.parcels[0]) => {
    if (!parcel) return null;
    const c = fares.intersectionCentre(parcel.target.i, parcel.target.j);
    return projectToScreen(c.x, 5, c.z);
  },
};

// The city is random by default now, so surface the seed prominently — a player who wants that
// map back needs `?seed=<this>`. `attempts > 1` means the guard rerolled a disconnected layout.
console.log('[taxi] ready', {
  seed, runSeed, shot: shot?.name ?? 'interactive',
  cars: traffic.cars.length,
  ...(attempts > 1 ? { seedAttempts: attempts } : {}),
});
window.__taxi.seed = seed;         // pin this city with ?seed=<this>
window.__taxi.runSeed = runSeed;   // reproduce a run with ?run=<this>
