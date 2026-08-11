import * as THREE from 'three';
import { makeRng } from './util/rng.js';
import { createScene } from './game/scene.js';
import { createCityCamera, attachDragPan, VIEW_DIR } from './game/camera.js';
import { createLayout } from './city/layout.js';
import { createGround } from './city/ground.js';
import { createBuildings } from './city/buildings.js';
import { createProps } from './city/props.js';
import { createTraffic, placeCar, TRUCK_CHANCE } from './sim/traffic.js';
import { createCollisions } from './sim/collisions.js';
import { createPolice, POLICE_BUST_RANGE } from './sim/police.js';
import { createFareSystem, cornerFor, setFareSeconds, getFareSeconds, isFareClockPinned } from './game/fares.js';
import { createDebugPanel } from './game/debugpanel.js';
import { createBoost, BOOST_FARE_REWARD } from './game/boost.js';
import { createBoostMeter } from './game/boostmeter.js';
import { flyEnergyToBoost } from './game/energybits.js';
import { createSkidMarks } from './game/skidmarks.js';
import { createDust } from './game/dust.js';
import { createBlast } from './game/blast.js';
import { createFlames } from './game/flames.js';
import { createVanish } from './game/vanish.js';
import { createFlyover } from './game/flyover.js';
import { createCarGhosts } from './game/carghosts.js';
import { createRoadwork } from './game/roadwork.js';
import { showRunEnd } from './game/runend.js';
import { TAXI_TAILPIPE_BACK, TAXI_TAILPIPE_HEIGHT } from './geometry/taxi.js';
import { createDaylight, DAY_SECONDS } from './game/daylight.js';
import { createPicker } from './game/pick.js';
import { createRiderFinder } from './game/riderfinder.js';
import { createTutorial } from './game/tutorial.js';
import { createDropoffIndicator } from './game/dropoffindicator.js';
import { createRouteLine } from './game/routeline.js';
import { createAmbientOcclusion, markOccluder } from './game/ssao.js';
import { setAmbientOcclusion } from './util/geo.js';
import * as difficulty from './game/difficulty.js';
import { createHomeScreenTip } from './game/homescreen.js';
import { findRoute, planOrigin } from './game/route.js';
import { getActiveShot, getSeed, getRunSeed, getCarCount, getDifficultyPin, getAmbientOcclusion,
  getSafeMode, safeModeSource, getMsaa, getShadowMapSize, getPixelRatioCap,
  getDiagnostics } from './util/shot.js';
import { createDiagnostics } from './game/diag.js';
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, budget.pixelRatioCap));
renderer.setSize(window.innerWidth, window.innerHeight);
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

const { scene, sun, hemi, sky } = createScene({ shadowMapSize: budget.shadowMapSize });

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
const daylight = createDaylight({ sun, hemi, sky });
daylight.setDayLength(DAY_SECONDS);
daylight.setCycling(false);

// Every generator draws from its own stream so that changing one system doesn't reshuffle the
// others — editing building code shouldn't move the parks. `layout` was already produced above
// so the connectivity guard could reroll before we spent time meshing.
// `markOccluder` is what puts a mesh into the AO depth prepass. The rule it enforces is that
// anything lit by `propMaterial()` has to be in there: a mesh that receives AO without casting it
// samples the occlusion of whatever stands behind it. See `game/ssao.js`.
scene.add(markOccluder(createGround(makeRng(seed + 11), layout)));
scene.add(markOccluder(createBuildings(makeRng(seed + 22), layout).mesh));
scene.add(markOccluder(createProps(makeRng(seed + 33), layout)));

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
const fares = createFareSystem(makeRng(runSeed + 55), scene);
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
const aspect = () => window.innerWidth / window.innerHeight;
const controller = createCityCamera(aspect(), {
  zoom: shot?.zoom ?? 52,
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
const isNarrow = () => window.innerWidth < NARROW_VIEWPORT;

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
let cameraTakenOver = false;
// Assigned further down, once the fare board and the picker it reads exist. Declared here because
// the handover below is the one thing that has to reach it, and a swipe cannot arrive before the
// module has finished evaluating.
let tutorial = null;
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
let wreckSpot = null;
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
  blast.fire(x, z, PALETTE.taxiBody);
  controller.kickShake(2.4);

  // The car that was hit detonates at its own centre rather than at the shared impact point. The
  // two are only a couple of units apart, but that is enough to spread the blast across both
  // bodies instead of stacking it on the seam between them — and its shards fly in its own paint,
  // so what comes apart is visibly two cars.
  //
  // It used to spin out, snap back onto a lane and drive away. A boosting taxi arrives at ~19 u/s
  // and the survivor shrugging that off made the player's own wreck look like a rule rather than
  // a crash.
  blast.fire(other.x, other.z, PALETTE.carBody[other.colorIndex]);

  // Both shells collapse into their own fireballs — see game/vanish.js for why they are faded out
  // rather than simply hidden. `wreckShell` also takes each car off the road for good.
  vanish.take(traffic.wreckShell(traffic.taxi));
  vanish.take(traffic.wreckShell(other));

  wreckSpot = { x, z };
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
  wreckSpot = { x: traffic.taxi.x, z: traffic.taxi.z };
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
  // end the run before it had drawn a pixel — see BUST_ARM_INSET in sim/police.js. Its light bar
  // comes on with this, so what the player sees and what can bust them are the same flag.
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

// --- Selection and routing --------------------------------------------------

// The taxi is permanently selected. There is only ever one, so a selection step was pure
// ceremony: every tap on it was either a no-op or an accidental deselect that made the next tap
// on a fare do nothing. Nothing draws on the road to say so any more either — see taxi.js.
const selected = true;

/**
 * Route the taxi to an intersection. Planning starts from the intersection the taxi is *heading
 * toward* plus its current heading, because that is the first point at which it can make a choice.
 */
function routeTo(target) {
  const car = traffic.taxi;
  const route = findRoute(planOrigin(car), target);
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

createPicker(
  camera,
  renderer.domElement,
  () => [traffic.taxiGroup, ...fares.pickables()],
  (kind, hit) => {
    if (fares.state.gameOver) return;
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
  () => Boolean(pan?.didPan()),
);

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

const riderFinder = createRiderFinder({ onSelect: selectRider, sun, hemi });
const dropoffIndicator = createDropoffIndicator({
  camera,
  // Aim at the kerb corner where the pin actually stands, not the intersection centre — the
  // pointer's job is to show where the marker went off-screen, and the marker isn't at the
  // junction.
  pinLocation: cornerFor,
});

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
  pixelsPerUnit: () => window.innerHeight / (2 * controller.state.zoom),
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
  // long after this module has finished evaluating.
  isBlocked: () => Boolean(homeTip?.state.holding),
  // The same guard the picker uses: the click a mouse synthesises at the end of a drag must not
  // count as an answer to the bubble the player was dragging past.
  shouldIgnoreTap: () => Boolean(pan?.didPan()),
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
    x: (v.x * 0.5 + 0.5) * window.innerWidth,
    y: (-v.y * 0.5 + 0.5) * window.innerHeight,
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
    // A crash holds the banner for CRASH_BANNER_DELAY so the blast and the camera pull-in
    // land before the retry screen appears. Timeouts have no such beat — reveal immediately.
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
      onRetry: () => location.reload(),
    });
    document.body.classList.add('game-over');
  }
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
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
  // Doing the thing the third bubble is asking for answers it. Called explicitly rather than left
  // to the tutorial's window-level tap handler, because the preventDefault above can suppress the
  // click a touch would otherwise synthesise — so on a phone the hint would outstay its own lesson.
  tutorial?.dismiss();
  boostButton.setPointerCapture?.(event.pointerId);
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
// Alt-tabbing away or switching apps mid-hold should not leave the boost stuck on.
window.addEventListener('blur', () => boost.release());
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

  if (!cornering && !launching) { lastSkidAt = car.travelled; return; }
  // Closer than one mark length, so consecutive stamps overlap into a continuous streak.
  if (car.travelled - lastSkidAt < 0.42) return;
  lastSkidAt = car.travelled;

  stampRearRubber(car);
}

// Dust comes off the back of the car whenever it's boosting and actually moving — not only in
// corners like the rubber, since the point is to make speed itself read.
let lastDustAt = 0;
function kickDust() {
  const car = traffic.taxi;
  if (!car.boost || car.v < 2) { lastDustAt = car.travelled; return; }
  if (car.travelled - lastDustAt < 0.47) return;
  lastDustAt = car.travelled;
  dust.add(car.x - Math.cos(car.yaw) * 1.9, car.z + Math.sin(car.yaw) * 1.9, car.yaw);
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
const NO_FARE_EVENTS = [];

const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  let dt = Math.min(clock.getDelta(), 0.05);

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
  dust.update(dt);
  blast.update(dt);
  flames.update(dt);
  vanish.update(dt);
  flyover.update(dt);
  controller.updateShake(dt, aspect());
  daylight.update(dt);

  // The two halves of the ramp that live in `sim/`. They are pushed rather than pulled because
  // `sim/` must not import from `game/` — the same reason `traffic.taxi.boost` is written here
  // rather than read there. Both are idempotent and cheap: the density call adds at most one car
  // and returns immediately once it is at the mark, and the cooldown range is two numbers.
  applyWorldPressure();

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
  // back.
  //
  // Wreck focus outranks everything (and runs on every viewport, not only narrow ones): the camera
  // eases into the crash site so the fireball fills the frame before the retry screen shows.
  //
  // The tutorial sits below Loco Mode and above the opening follow, and unlike the follows it runs
  // on every viewport — a desktop player has the whole city in frame and still cannot tell which
  // car is theirs, which is the entire reason the first bubble exists. It frames from here rather
  // than from its own update() so this list stays the one place the camera is decided.
  const boosting = boost.isActive();
  if (wreckSpot) {
    controller.focusOn(wreckSpot.x, wreckSpot.z, WRECK_ZOOM, dt, aspect());
  } else if (boosting && !fares.state.gameOver && isNarrow()) {
    controller.followXZ(traffic.taxi.x, traffic.taxi.z, dt, BOOST_FOLLOW_SMOOTHING, aspect());
  } else if (tutorial?.holdsCamera()) {
    tutorial.frameCamera(dt);
  } else if (!cameraTakenOver && !fares.state.gameOver && isNarrow()) {
    controller.followXZ(traffic.taxi.x, traffic.taxi.z, dt, START_FOLLOW_SMOOTHING, aspect());
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
    (homeTip?.state.holding ? NO_FARE_EVENTS : fares.update(dt, traffic.taxi))) {
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

  // The route is a property of the selection, not of the world — deselecting clears it from view
  // even though the taxi keeps driving it.
  if (selected && traffic.taxi.pendingTarget && !fares.state.gameOver) {
    routeLine.update(traffic.taxi, traffic.taxi.route, dt);
  } else {
    routeLine.hide();
  }

  layRubber(dt);
  kickDust();
  policeRubber();
  updateHud(dt);
  riderFinder.update(dt, fares.waitingAll());
  dropoffIndicator.update(fares.carrying());
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
    controller.state.target.set(wreckSpot?.x ?? victim.x, 0, wreckSpot?.z ?? victim.z);
    controller.update(aspect());
    for (let step = 0; step < Math.round(shot.wreckAt * 60); step++) {
      blast.update(1 / 60);
      vanish.update(1 / 60);
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
  if (selected && traffic.taxi.pendingTarget) {
    // A shot reviews the band's steady state, not the moment it was picked — a shot mode frame is
    // never followed by another, so with a real dt the rollout sweep would freeze here mid-animation
    // and every route shot would show a truncated band. A dt this large settles even the longest
    // route's sweep well before this single frame renders.
    routeLine.update(traffic.taxi, traffic.taxi.route, 999);
  }
  renderFrame();
  document.body.dataset.shotReady = 'true';
} else {
  traffic.warmup(10);
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
    daylight,
    carCount: getCarCount(),
    fares: { getSeconds: getFareSeconds, setSeconds: setFareSeconds, isPinned: isFareClockPinned },
    routeLine,
    ao,
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
  flyover,
  roadwork,
  routeTo,
  findRoute,
  camera: controller,
  isSelected: () => selected,
  /**
   * Draw one frame on demand.
   *
   * Shot mode never starts the render loop — it warms the sim, renders once and stops — so a shot
   * poked from the console or over CDP keeps showing the frame it froze on. This is what makes a
   * frozen framing reviewable at states the shot list doesn't cover: set a fare's clock, redraw,
   * capture. Harmless while the loop is running, since the next frame overwrites it anyway.
   */
  redraw: () => renderFrame(),
  /** Screen-space helpers so the browser smoke test can click real pixels. */
  taxiScreenPosition: taxiScreenPos,
  /** The pin the player is meant to be driving at — the newest one if two are on the board. */
  targetScreenPosition: (fare = fares.focus()) => {
    if (!fare) return null;
    const c = fares.intersectionCentre(fare.target.i, fare.target.j);
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
