import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
// First, before anything builds a material: it patches three's fog chunk for every program.
import { EDGE_FOG, createEdgeFogFloor, tickEdgeFog } from './game/edgefog.js';
import { makeRng } from './util/rng.js';
import { findZFighting, describeZFighting } from './util/zfight.js';
import { createScene, sinkShadowCaster, setHazeTop, HAZE_TOP } from './game/scene.js';
import { createRain, GRIP } from './game/rain.js';
import { createStorm } from './game/storm.js';
import { createComboMeter, comboScope, comboValue, formatMult } from './game/combometer.js';
import { createSquall, RAMP, RAMP_CLASSIC, CELL_EDGE } from './game/squall.js';
import { pedalZones as growPedalZones, pedalAfterMove } from './game/pedalzones.js';
import {
  collectPanes, litWindows, streetLamps, entrances, switchedLights, createTaxiHeadlights, setCityLights,
} from './game/citylights.js';
import {
  createCityCamera, attachDragPan, VIEW_DIR, PLAY_ZOOM, LOCO_PUNCH_HOLD, RIGHT,
} from './game/camera.js';
import { createLayout } from './city/layout.js';
import { createGround, KERB_H } from './city/ground.js';
import { createManholes } from './city/manholes.js';
import { createManholeSteam } from './game/manholesteam.js';
import { createAsphaltPatches } from './city/asphaltpatch.js';
import { createRiver, bridgeLines, bridgeSpan, deckHeightAt } from './city/river.js';
import { createHarbor } from './city/harbor.js';
import { createNorthPark } from './city/northpark.js';
import { createSouthShore } from './city/southshore.js';
import { createParkShore } from './city/parkshore.js';
import { createWestEdge } from './city/westedge.js';
import { createHorizon } from './city/horizon.js';
import { tickRiverWater, bindRiverDrawbridge, setWaterStyle } from './city/riverwater.js';
import { createDrawbridge } from './game/drawbridge.js';
import { createBoats } from './game/boats.js';
import { createHarborShips } from './game/harborships.js';
import { createBridge, jointParts, BRIDGE_NORMALS_CLASSIC } from './geometry/bridge.js';
import { createBuildings } from './city/buildings.js';
import { createProps, parkPlots, setAutumn } from './city/props.js';
import { createLeaves } from './game/leaves.js';
import { createGrass } from './city/grass.js';
import { createCanopyFuzz } from './city/canopyfuzz.js';
import { createGarage, LANDMARK as GARAGE_LANDMARK } from './city/garage.js';
import { createBurgerJoint, SIGN_SPIN, LANDMARK as BURGER_LANDMARK } from './city/burgerjoint.js';
import { createVetClinic, VET_CLASSIC } from './city/vetclinic.js';
import { createGraveyard, LANDMARK as GRAVEYARD_LANDMARK } from './city/graveyard.js';
import { plantedCrowns } from './city/props.js';
import {
  createTraffic, placeCar, TRUCK_CHANCE, CLASSIC_CHANCE, TRUCK_LEN, TRUCK_W, laysPassRubber, copLaysRubber, SPEED,
  ROAD_Y, CAR_LEN, CAR_W, wheelAnchors,
  boostCruise, locoTuning, setLocoTuning, resetLocoTuning, locoRamp, LOCO_DEFAULTS, driftTaxi, kickDrift, driftHolds, DRIFT_CHAIN,
  onDriftLaunch, hopProgress, setSpinStyle, setBarrelRoll, setMegaFlip, setBridgeStunt, setPassTurnGate, setPassPace, setHopStyle, setDodge, setOvertakeStyle, setPeek, setTaxiScatter,
  configureSignals, setGrip, setRunningLights, setRunningLightsAt, runningLightsAt, isLaneClosed, FISHTAIL_TIME,
} from './sim/traffic.js';
import { createCollisions, TAXI_HP, setCrush, setCrushSplash } from './sim/collisions.js';
import { createVanish } from './game/vanish.js';
import { createCrushSlowMo } from './game/crushslowmo.js';
import { createPolice } from './sim/police.js';
import {
  createFareSystem, cornerFor, kerbFor, setFareSeconds, getFareSeconds, isFareClockPinned, BURGER_PRICE, REPAIR_PRICE,
  BOARD_SECONDS, MAX_STRIKES, RATING_FLOOR, ratingFor,
} from './game/fares.js';
import { createDebugPanel } from './game/debugpanel.js';
import { createPhoneFrame } from './game/phoneframe.js';
import { createDriveThru } from './game/drivethru.js';
import { createBurgerRun } from './game/burgerrun.js';
import { createDepotRun } from './game/depotrun.js';
import {
  createBoost, BOOST_FARE_REWARD, BOOST_PARCEL_REWARD, BOOST_BURGER_REWARD,
} from './game/boost.js';
import { createBoostMeter } from './game/boostmeter.js';
import { bandPath as fuelBandPath, frontAt as fuelFrontAt, glintAt as fuelGlintAt, RIM as FUEL_RIM, CAP as FUEL_CAP, useClassicArc as useClassicFuelArc, useClassicGap as useClassicFuelGap, flameRadius as fuelFlameRadius, bendFlame as fuelBendFlame, flameAngle as fuelFlameAngle } from './game/fuelarc.js';
import { createImpact } from './game/impact.js';
import { createTaxiDamage, SMOKE_FRACTION, BOOT_FRACTION } from './game/taxidamage.js';
import { createHitCue, hitCueMode } from './game/hitcue.js';
import { createCarDamage } from './game/cardamage.js';
import { createTaxiDoor } from './game/taxidoor.js';
import { flyEnergyToBoost } from './game/energybits.js';
import { createSkidMarks, createTyreTrail } from './game/skidmarks.js';
import { createDust, DUST_ROAD_Y } from './game/dust.js';
import { createSpray } from './game/spray.js';
import { createCityEntry } from './game/cityentry.js';
import { createBlast, WRECK_STYLES } from './game/blast.js';
import { createFlames } from './game/flames.js';
import { createSparks } from './game/sparks.js';
import { createRepairFx } from './game/repairfx.js';
import {
  createLocoFlame, tongueOutline, FLAME_FRAMES, FLAME_FRAME_TIME, FLAME_LAYER_SCALES, FLAME_LEN,
} from './game/locoflame.js';
import { createWreckage } from './game/wreckage.js';
import { createEjection, EJECT_CLOSING } from './game/ejection.js';
import { createWindshield } from './game/windshield.js';
import { createTape, createCrashReplay, REPLAY_SHOTS } from './game/replay.js';
import { CARRY_DRAG, carrySpeed, carryTravel } from './util/carry.js';
import { createFlyover } from './game/flyover.js';
import { createSoundRings } from './game/soundrings.js';
import { createSoundPins } from './game/soundpins.js';
import { createChopper } from './game/chopper.js';
import { createPoliceHeli } from './game/policeheli.js';
import { createBirds, chooseRoosts } from './game/birds.js';
import { createDucks } from './game/ducks.js';
import { createHoopers } from './game/hoopers.js';
import { createBoombox } from './game/boombox.js';
import { createTubeMan } from './game/tubeman.js';
import { createCarWash, LANDMARK as CARWASH_LANDMARK } from './city/carwash.js';
import { createGasStation, LANDMARK as GAS_LANDMARK } from './city/gasstation.js';
import { roadsideKind } from './city/roadside.js';
import { createLTrain, planLTrain, LTRAIN_DIMENSIONS } from './game/ltrain.js';
import { courtRect } from './city/blacktop.js';
import { createSkaters } from './game/skaters.js';
import { createClassicSkaters } from './game/skatersclassic.js';
import { skateRect } from './city/skatepark.js';
import { createClouds } from './game/clouds.js';
import { createCarGhosts } from './game/carghosts.js';
import { createRoadwork } from './game/roadwork.js';
import { createStreetProps, planStreetProps } from './game/streetprops.js';
import { createFire } from './game/fire.js';
import { createGarbage, planTrashPiles, PROP_KEEP_OUT } from './game/garbage.js';
import { createRace, WIN_PAY, LOSE_COST, TANK_FLOOR, COUNT_STEP, COUNTDOWN } from './game/race.js';
import { createSpeech } from './game/speech.js';
import { MARKER_BASE } from './game/faremarker.js';
import { createFlatbed } from './game/flatbed.js';
import { createBoxSpill } from './game/boxspill.js';
import { showRunEnd } from './game/runend.js';
import { createSnapshot, PHOTO } from './game/polaroid.js';
import { recordRun, lastName, clearScores, loadScores } from './game/highscores.js';
import { loadLocoTuning, saveLocoTuning, clearLocoTuning } from './game/locostash.js';
import {
  TAXI_TAILPIPE_BACK, TAXI_TAILPIPE_HEIGHT, TAXI_REAR_AXLE_BACK, TAXI_REAR_TRACK,
  TAXI_FRONT_AXLE_FWD, TAXI_FRONT_TRACK, TAXI_SCALE,
} from './geometry/taxi.js';
import { createDaylight, DAY_SECONDS } from './game/daylight.js';
import { createPicker } from './game/pick.js';
import { createRiderFinder } from './game/riderfinder.js';
import { createTaxiFinder } from './game/taxifinder.js';
import { createCargoChip } from './game/cargochip.js';
import { createChaseSiren } from './game/chasesiren.js';
import { createTutorial, LOCO_HINT_HOLD } from './game/tutorial.js';
import { createOpening, entryPath } from './game/opening.js';
import { createGlint } from './game/glint.js';
import { createWipe } from './game/wipe.js';
import { createFarePointers } from './game/farepointers.js';
import { createSirenGlow } from './game/sirenglow.js';
import { createRobberyGlow } from './game/robberyglow.js';
import { createRouteLine, routePath, pointAlongPath } from './game/routeline.js';
import { markOccluder } from './game/ssao.js';
import { markEmissive } from './game/bloom.js';
import { renderBudget, decideLooks, createRenderPath } from './game/renderpath.js';
import {
  propMaterial, setGlossCity, setGlossGlobal, PAINT_UNIFORMS, placeJunctionPaving,
} from './util/geo.js';
import * as difficulty from './game/difficulty.js';
import { createHomeScreenTip } from './game/homescreen.js';
import { createTitleScreen, TITLE_CAM } from './game/titlescreen.js';
import { BACKSTORY_VOICES, backstoryMode, backstoryVoiced, tellBackstory, wantsBackstory } from './game/backstory.js';
import { createTitleReel } from './game/titlereel.js';
import { splashCovers, SPLASH_SKIP_KEY } from './game/splash.js';
import { BACKDROP } from './game/backdrop.js';
import { createSettings, qualityOf } from './game/settings.js';
import { createPause } from './game/pause.js';
import { createInspect } from './game/inspect.js';
import {
  findRoute, findRouteVia, findRouteOnto, findRouteAlong, planOrigin, crossingOrigin, carryOn, setBigAirRoute,
} from './game/route.js';
import { streetAt, routeDrives, STREET_TAP_MAX_DETOUR } from './game/streettap.js';
import { createPathDrag } from './game/pathdrag.js';
import { getActiveShot, getSeed, getRunSeed, getCarCount, getDifficultyPin, getDifficultyMode,
  getSafeMode, safeModeSource, getPixelRatioCap,
  getDiagnostics, getParcelsPin, getRain, getStorm, getSquall, getSquallRampClassic, getSunRaysClassic, getWetTyres, getWreckStyle, getFall, getFoliageClassic, getWater, getUturnStyle, getCrt } from './util/shot.js';
import { createParcelSystem, TAP_MAX_DETOUR } from './game/parcels.js';
import { createRobbery } from './game/robbery.js';
import { createRadio, LOST_CALL, ROBBERY_CALL } from './game/radio.js';
import { createDepotCall } from './game/depotcall.js';
import {
  createPatrol, createPin, holdArrest, ramOf, ESCAPE_HOLD, SIGHT_HOLD,
} from './game/patrol.js';
import { createCopShout } from './game/copshout.js';
import { createRobberLine, ROBBER_LINES } from './game/robberline.js';
import { createBankJob } from './game/bankjob.js';
import { createCopLights } from './game/coplights.js';
import { createCashTrail } from './game/cashtrail.js';
import { setCityOccluders, sightlineClear } from './game/sightline.js';
import { createBootleg, COMBO_GAP_MS as BOOTLEG_GAP_MS } from './game/bootleg.js';
import { createOvertakeCombo, OVERTAKE_GRACE } from './game/overtake.js';
import { createNewMove, createSeenFlag, MOVES, REPAIR, SHOW_DELAY } from './game/newmove.js';
import { demoMode } from './game/progress.js';
import { createUturnClip, pickStreet, clipKeys as uturnKeys, LANDS_AT as UTURN_LANDS } from './game/uturnclip.js';
import { createDriftClip, pickCorner, clipKeys as driftKeys, LANDS_AT as DRIFT_LANDS } from './game/driftclip.js';
import { createOvertakeClip, pickOvertakeStreet, clipKeys as overtakeKeys, LANDS_AT as OVERTAKE_LANDS } from './game/overtakeclip.js';
import { createRepairClip, clipKeys as repairKeys } from './game/repairclip.js';
import { SKYLINE_CEILING } from './city/buildings.js';
import { popHighlight, POP_TIME } from './game/selectpop.js';
import { createDiagnostics, describeGpu } from './game/diag.js';
import { createHitchLogger, getHitchLogger } from './game/hitch.js';
import { warmFirstDraws } from './game/warmup.js';
import { createBench } from './game/bench.js';
import { createSoak } from './game/soak.js';
import { createGovernor } from './game/governor.js';
import { createViewport } from './util/viewport.js';
import { isNative } from './util/platform.js';
import { tap as haptic, setHapticPrefs } from './util/haptics.js';
import { createSfx, DASH, MUSIC_FADE_AT_HINT } from './game/sfx.js';
import { attachContextRecovery } from './game/recovery.js';
import { isCityConnected, GRID_I, GRID_J, MAX_SPAN, lineX, lineZ } from './city/grid.js';
import { cityNetwork } from './city/roadnet.js';
import { PALETTE, color as paletteColor, roadsClassic } from './palette.js';

// Caches the app shell so a Home Screen launch still opens with no connection — see public/sw.js.
// Skipped under `npm run dev`: Vite's dev server rewrites module URLs on every change, and a
// worker caching those responses would serve stale code back at the page mid-session. Production
// (`npm run build` + `preview`, or the real deploy) is a static bundle, which is what the worker
// is for.
//
// Skipped in the native shell too, and there the reason is sharper than "unnecessary". The .ipa
// already carries the whole bundle — there is no connection to survive the loss of — so the worker
// buys nothing, and what it costs is a cache that outlives an App Store update: the shipped files
// change under it while its `CACHE_NAME` does not, and a cache-first worker keeps serving the old
// build to a player who has already installed the new one. `public/sw.js` bumps that name by hand
// on the web, which works because a deploy is one atomic thing we control; an app update is not.
if (!import.meta.env.DEV && !isNative() && 'serviceWorker' in navigator) {
  // Caught, because a registration that fails (no connection for the update check) only costs
  // the offline copy, and left unhandled it would put the error panel over a game that is running.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('sw: not registered', err));
  });
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
// The player's settings, read this early because one of them is part of the renderer budget below:
// the Resolution choice is the pixel-ratio cap. Shot mode ignores it, so a stored 1.5 on the machine
// taking screenshots cannot soften every reference image.
const settings = createSettings();
// Demo mode (game/progress.js): every once-ever moment shows again, and nothing is written. Read
// live — it is a switch on the title screen's Settings page, flipped moments before Play.
const demo = demoMode();
// The tutorial tips, which Demo mode holds on: a demo is for showing the tips off.
const tipsOn = () => demo.on() || settings.get().tips;
// The Difficulty row (Easy / Regular / Hard). Applied here, before the fare system budgets its first
// clock, and live from then on: a change takes effect from the next rider to spawn. `?difficulty=`
// pins it for the load and leaves the saved choice alone; shot mode holds Easy, so a stored Hard on
// the machine taking screenshots cannot move a reference image.
const difficultyPinned = shot ? 'easy' : getDifficultyMode();
difficulty.setMode(difficultyPinned ?? settings.get().difficulty);
// Only on an actual change of mode: any other setting moving would otherwise reset the tuning, and
// wipe whatever the ⚙️ panel's sliders had dialled in.
settings.onChange((v) => {
  if (!difficultyPinned && v.difficulty !== difficulty.getMode()) difficulty.setMode(v.difficulty);
});
const resolutionPinned = new URLSearchParams(window.location.search).has('dpr');
const budget = {
  safe: getSafeMode(),
  // 'url' | 'android' | null — see `safeModeSource`. The panel reports it, because a budget the
  // player asked for and one the platform default imposed are different things to be looking at.
  safeSource: safeModeSource(),
  pixelRatioCap: getPixelRatioCap(getSafeMode() ? 1 : shot ? 2 : qualityOf(settings.get()).resolution),
  // msaa, shadowMapSize, ao, crayon, cartoon, hdr, bloom: the shared render path's (game/renderpath.js).
  ...renderBudget(),
  // The CRT screen (game/crt.js) — the game's alone, so not in the shared `renderBudget`.
  crt: getCrt(),
};
// The Antialiasing setting, as it stood at launch (MSAA is a context attribute). `?msaa=` beats it,
// as `?dpr=` beats Quality, and shot mode keeps MSAA so screenshots don't depend on a saved setting.
if (!shot && !new URLSearchParams(window.location.search).has('msaa')) {
  budget.msaa = budget.msaa && settings.atLaunch().antialias;
}

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
// Named for the stylesheet: the title's intro blurs this canvas and no other (game/titlescreen.js).
renderer.domElement.classList.add('city-canvas');
document.body.appendChild(renderer.domElement);

// AO, Crayon, Cartoon, painterly, the paint look, the rim and cloud shadows: all baked into the
// shader `propMaterial()` builds, so all decided here, before a single mesh exists. In
// game/renderpath.js because the model workshop's bench takes the same decisions.
decideLooks(budget);
const aoEnabled = budget.ao;
const crayonEnabled = budget.crayon;
const cartoonEnabled = budget.cartoon;
// Which brush a static mesh wears (see PAINT_FRAGMENT): 1 buildings, 2 ground (lawns only).
const brush = (mesh, kind) => {
  mesh.material.userData.brush = kind;
  return mesh;
};
// Notices raised while the passes below are being built, replayed into `game/diag.js` once it
// exists. See `onNotice` on `createHdr`.
const declined = [];

// HDR, AO, bloom, Crayon and Cartoon, and the order a frame runs them in — game/renderpath.js,
// shared with the workshop's bench. It settles `budget.hdr` and `budget.bloom` as it goes.
const renderPath = createRenderPath(renderer, budget, {
  // Queued rather than passed straight to `diag`, which does not exist yet: hdr declines the flag
  // *during construction*, and reaching a `const` declared thirty lines further down is a
  // temporal-dead-zone throw that takes the whole page with it.
  onNotice: (text) => { declined.push(text); },
  // Shot mode pins the CRT's flicker, so a still does not depend on when it was taken.
  still: Boolean(shot),
});
const { ao, bloom, crayon, cartoon, hdr, crt } = renderPath;
// The weather. `?storm` runs a storm across the afternoon and back on a loop (game/storm.js);
// `?rain` is the same storm pinned at its peak. Either way the whole wet city is built up front —
// see game/rain.js — and `applyWeather` below turns each part of it up and down with the clock.
//
// The squall is the other kind of weather, and the default one: not the whole sky changing, but one
// rain cell crossing a sunny city (game/squall.js), `?squall=off` to drop it. An explicit `?squall`
// wins over the other two — they are both "the sky over everything" — but the *default* steps aside
// for either (`getSquall`). Run seed, so `?run=` replays the same crossings.
const squallFlag = getSquall();
const stormFlag = squallFlag ? null : (getRain() ?? getStorm());
const storm = stormFlag ? createStorm(stormFlag) : null;
const squallRng = makeRng(runSeed + 733);
// `?squallramp=classic`: the first front, which brought the shade, the rain and the lights in
// together. The graded one is described at `RAMP` in game/squall.js.
const squallRampClassic = getSquallRampClassic();
const squall = squallFlag ? createSquall({
  ...squallFlag, rng: () => squallRng.next(), ramp: squallRampClassic ? RAMP_CLASSIC : RAMP,
}) : null;
const rain = createRain(renderer, { enabled: Boolean(storm || squall), mood: stormFlag?.mood });
if (squall) {
  // Sun rays in the cell's wake, as it passes (`SUN_RAYS` in game/rain.js); `?sunrays=classic` none.
  rain.attachSquall(squall, { sunRays: !getSunRaysClassic() });
  // A car's headlights come on as the cell reaches it — from a third of the way into the soft edge
  // — rather than across the city at once.
  // Headlights with the city's lights, half way through them — under the first front, with the rain.
  setRunningLightsAt(squallRampClassic
    ? (x, z) => THREE.MathUtils.smoothstep(squall.rainAt(x, z), 0.15, 0.5)
    : (x, z) => THREE.MathUtils.smoothstep(squall.lightAt(x, z), 0.3, 0.6));
}

// `?diag`. A no-op without the flag; with it, the one readout that can tell a lost context from a
// scene that submitted nothing from a scene that drew and came out black. See `game/diag.js`.
const diag = createDiagnostics(renderer, { enabled: getDiagnostics(), flags: budget });
declined.forEach((text) => diag.note(text));

const { scene, sun, hemi, sky, fog } = createScene({ shadowMapSize: budget.shadowMapSize });

// The crayon page and the bloom composite, over the city and under every read-out.
renderPath.addOverlays(scene);

// The falling rain, and the two overlays that must stay out of its mirror pass.
rain.addTo(scene);
rain.hideInMirror(crayon.overlay, bloom.overlay, scene.getObjectByName('sky'));

// A GPU that takes the context away gets the budget turned down rather than the player getting a
// black screen for the rest of the run — see `game/recovery.js` for the two steps and why the
// split between them is where it is. Attached after the sun exists, since step one shrinks its
// shadow map.
attachContextRecovery({ renderer, sun, budget, onNotice: (text) => diag.note(text) });
// Steps the pixel ratio down when a warm phone starts dropping frames, never below 2x, and back up
// once it can keep up again. `?governor=off` holds it where the budget put it. See game/governor.js.
const governor = createGovernor({
  renderer,
  budget,
  enabled: !shot && new URLSearchParams(window.location.search).get('governor') !== 'off',
  onChange: (text) => diag.note(text),
  targetMs: () => 1000 / Math.min(60, frameRateCap()),
});
// The Quality setting's resolution, live: the cap moves and the governor re-derives its ratio from
// it. Not while `?dpr=` pins it, nor under `?safe`, whose whole point is the cheapest budget. The
// frame-rate half needs nothing here: `frameRateCap` reads the setting every frame.
settings.onChange((v) => {
  const { resolution } = qualityOf(v);
  if (shot || resolutionPinned || budget.safe || resolution === budget.pixelRatioCap) return;
  budget.pixelRatioCap = resolution;
  governor.reset();
  renderer.setPixelRatio(governor.ratio());
  // A ratio change resizes the canvas, which empties it — and this is usually changed from the pause
  // screen, where the city is drawn once and then left. Redraw it under the veil.
  stillDrawn = false;
});

/**
 * The one place the frame is drawn. Three callers reach it — the live loop, shot mode's single
 * render, and `__taxi.redraw()` — and the AO prepass has to run before every one of them or a
 * frozen shot renders against whatever the previous frame left in the texture.
 *
 * The main render is untouched by the pass in front of it: still the default framebuffer, still
 * its own MSAA, still its own stencil buffer for the ghost outlines.
 */
/**
 * One frame of the city. `cam` is the city camera unless the New Move card is filming its U-turn
 * clip through a camera of its own (game/uturnclip.js), which wants the whole frame — the AO, the
 * bloom, the haze — and not a lesser render of its own.
 */
function renderFrame(cam = camera) {
  // The pass order lives in game/renderpath.js, shared with the workshop's bench; the weather and
  // the diagnostics are the game's own and ride in with it.
  renderPath.render(scene, cam, { rain, rainLightsOn, diag });
}

// Weather, ringing the island — see game/clouds.js. Scenery on the same terms as the aeroplane and
// the flocks, and placed by where it lands **on screen** rather than by where it is in the world:
// the one thing a cloud must never do under this camera is come over the city and sit on the taxi.
// Run seed, like the flyover: which way the sky is moving today is part of the situation.
//
// Built here, out of order with the rest of the scenery, because the clock below tints it: the
// clouds are the one unlit thing in the sky and `daylight.apply()` is the only thing that moves
// their colour over a day.
const clouds = createClouds(scene, makeRng(runSeed + 277));

// The clock that drives the sky. Parked at golden hour for now — the cycle works, but the night
// end of it needs more tuning before it earns its place, so it's off until the ⚙️ panel turns it
// on. Screenshots keep it frozen regardless: a rendered shot has to be reproducible.
const daylight = createDaylight({ sun, hemi, sky, fog, clouds });
daylight.setDayLength(DAY_SECONDS);
daylight.setCycling(false);
if (rain.grade) daylight.setGrade(rain.grade);

/**
 * Hand the storm's three levels (game/storm.js) to everything that reads them. Every frame while a
 * storm is on, and once here so a pinned `?storm=` or `?rain` is in place before the first render.
 *
 * - `dark` grades the sky (through `daylight.apply`, which calls `rain.grade`), thickens the haze,
 *   switches the city's windows and lamps on one at a time, and puts the headlights on — all
 *   together over a short stretch of it, the way drivers do once it is properly gloomy.
 * - `rain` is the streaks, the splashes and the drops on the lens (inside `rain.setWeather`).
 * - `wet` is the ground's gloss and the mirror pass, and the grip: every car brakes softer on a
 *   wet road and plans its stops against the softer brake.
 */
// The taxi's own headlights (game/citylights.js), and the level every set of headlights is at. Both
// hoisted up here because the first `applyWeather` below runs before the taxi exists; the pair is
// built with the rest of the taxi's lamps and handed this level then.
let taxiHeadlights = null;
let runningLevel = 0;
// The taxi, for the squall's per-position grip and headlights — set once traffic exists.
let taxiNow = null;

/**
 * Switch the taxi's headlights to `level`, unless its nose is inside the depot. The cones reach
 * 5.4 units past the bumper and are drawn additive without writing depth, so with the taxi parked
 * behind a shut door they came straight out through it — a pool of light on the forecourt and two
 * glowing lamps seen through the curtain. A parked car has its lights off anyway, so they fade up
 * as the nose crosses the curtain on the way out (and down on the way back in), over 1.5 units.
 * Read off `garage.site` rather than the door's state so the answer does not depend on which of
 * the vignette, the depot run or the tip happens to be holding the door this frame.
 */
function setTaxiHeadlights(level) {
  if (!taxiHeadlights) return;
  const car = taxiNow?.();
  let inDepot = 0;
  if (car && garage) {
    const { curtainX, doorZ, doorW, bayX } = garage.site;
    if (Math.abs(car.z - doorZ) < doorW / 2 + 1 && car.x > bayX - 1) {
      const noseX = car.x + Math.cos(car.yaw) * TAXI_TAILPIPE_BACK;
      inDepot = 1 - THREE.MathUtils.smoothstep(noseX, curtainX, curtainX + 1.5);
    }
  }
  taxiHeadlights.setLevel(level * (1 - inDepot));
}
// How present the squall is, eased: a cell crossing the city greys the whole sky a little.
let squallPresence = 0;

/**
 * How near the cell is to the middle of the frame, for that grey: 1 with it overhead, 0 from
 * `SQUALL_NEAR` units outside its shade. The first front greyed the whole sky over 4s the moment a
 * cell came on outside a corner, wherever the player was — the grey arrived with nothing to explain
 * it, and then the rest of the storm arrived on top of it. Read by distance, it builds over ~30s
 * as the cell comes closer and goes the same way, which is the sky ahead of a storm darkening.
 */
const SQUALL_NEAR = 60;
function squallNearness(cell, c) {
  if (!cell.on) return 0;
  const d = Math.hypot(cell.x - c.x, cell.z - c.z);
  const far = cell.r * 1.18 + CELL_EDGE * squall.ramp.shadeOut + SQUALL_NEAR;
  return cell.strength * (1 - THREE.MathUtils.smoothstep(d, cell.r, far));
}

/**
 * The squall's half of `applyWeather`. Nothing here is city-wide except a faint grade while a cell
 * is on the map: the rain, the wet ground, the cloud shade and the city's lights all follow the
 * cell, through the uniforms `rain.attachSquall` wired up. What is left to do on the CPU is what
 * only one place can have — the grip under the taxi, the taxi's own headlights, and the drops on the
 * lens, which are on while the taxi is under the rain.
 */
function applySquall(dt) {
  squall.update(dt);
  const { cell } = squall;
  const presence = squallRampClassic ? (cell.on ? 1 : 0) : squallNearness(cell, rain.centre);
  squallPresence += (presence - squallPresence) * Math.min(1, dt / 4);
  // The lens follows the taxi, not the frame: it is the taxi's windscreen. Before the taxi exists
  // (the opening, a still) it falls back to the ground under the middle of the frame.
  const c = taxiNow?.() ?? rain.centre;
  rain.setWeather({
    dark: SQUALL_GREY * squallPresence,
    rain: cell.on ? 1 : 0,
    wet: squall.state.maxWet,
    lens: squall.rainNear(c.x, c.z, LENS_REACH),
    lensWet: LENS_WET,
    lensDry: LENS_DRY_SQUALL,
  }, dt);
  if (taxiNow) {
    const t = taxiNow();
    setGrip(THREE.MathUtils.lerp(1, GRIP, squall.wetAt(t.x, t.z)));
    setTaxiHeadlights(runningLightsAt(t.x, t.z));
  }
  setRunningLights(0);
  setCityLights(0, dt);
  setHazeTop(fog, THREE.MathUtils.lerp(HAZE_TOP, rain.mood.haze, SQUALL_GREY * squallPresence));
  daylight.apply();
  rain.setSunDir(sun.position);
  // Off the sun's own power, as the heli's searchlight reads night: no rays without a sun.
  rain.setSunRays(THREE.MathUtils.smoothstep(sun.intensity, 0.3, 2.6));
}

/** How far the whole sky greys while a squall's cell is on the map — the rest of the city is sunny. */
const SQUALL_GREY = 0.2;

/**
 * Seconds for the lens drops to come in as the taxi drives under the squall, and to clear once it
 * drives out, and how far outside the rain's own edge they start. The storm's 12s dry-off left drops
 * on the glass a block into the sunshine; 1.5s and the rain's own footprint (#445) went too far the
 * other way — a cell crosses about once every 100s and covers part of the city, so the drops read
 * as gone. 5s lets them trail the taxi out of the rain, and `LENS_REACH` (a cell 20 ± 4 across its
 * core) widens the patch of city that catches them by about a block. A short ease in keeps them
 * from popping on at boost speed.
 */
const LENS_WET = 0.5;
const LENS_DRY_SQUALL = 5;
const LENS_REACH = 15;

// The storm's one city-wide wetness, for the tyres (`groundWetAt`).
let stormWet = 0;
function applyWeather(dt = 0) {
  if (squall) { applySquall(dt); return; }
  if (!storm) return;
  const w = storm.update(dt);
  stormWet = w.wet;
  rain.setWeather(w, dt);
  setGrip(THREE.MathUtils.lerp(1, GRIP, w.wet));
  runningLevel = THREE.MathUtils.smoothstep(w.dark, 0.25, 0.42);
  setRunningLights(runningLevel);
  // The taxi's own pair on the same level as the fleet's: dark in the sun, on once it is gloomy.
  setTaxiHeadlights(runningLevel);
  setCityLights(w.dark, dt);
  setHazeTop(fog, THREE.MathUtils.lerp(HAZE_TOP, rain.mood.haze, w.dark));
  daylight.apply();
  rain.setSunDir(sun.position);
}
applyWeather();

// Every generator draws from its own stream so that changing one system doesn't reshuffle the
// others — editing building code shouldn't move the parks. `layout` was already produced above
// so the connectivity guard could reroll before we spent time meshing.
// `markOccluder` is what puts a mesh into the AO depth prepass. The rule it enforces is that
// anything lit by `propMaterial()` has to be in there: a mesh that receives AO without casting it
// samples the occlusion of whatever stands behind it. See `game/ssao.js`.
scene.add(markOccluder(rain.wetGround(brush(createGround(makeRng(seed + 11), layout), 2))));
// A few manhole covers in the streets (city/manholes.js). City seed, its own stream. Wet in the rain
// like the asphalt they sit in; not brushed, because iron under a road stroke reads as road.
// Seven or eight, three of them venting steam (game/manholesteam.js); `?manholes=classic` is the
// four or five that stood there before, with no steam.
const manholes = createManholes(makeRng(seed + 193),
  { classic: new URLSearchParams(location.search).get('manholes') === 'classic' });
if (manholes) scene.add(markOccluder(rain.wetGround(manholes)));
// The ground past the coast, for the fog of war to swallow — game/edgefog.js.
if (EDGE_FOG) scene.add(createEdgeFogFloor());

// The river, and the spans that get over it. Its own stream, like every other generator, so that
// moving a bridge cannot reshuffle a park.
//
// The water is **not** an occluder: `markOccluder` puts a mesh in the AO depth prepass, and the
// contract there is that anything lit by `propMaterial()` casts as well as receives. The channel's
// walls and parapets do both; the water is two units down at the bottom of a hole with nothing
// under it to crease, and putting a translucent surface in a depth prepass writes its depth over
// whatever it is meant to be seen through.
setWaterStyle(getWater());
const river = createRiver(makeRng(seed + 44), layout);
if (river) {
  scene.add(river.group);
  markOccluder(river.shell);

  const bridgeRng = makeRng(seed + 55);
  for (const line of bridgeLines()) {
    const span = bridgeSpan(line);
    // The lifting span is `game/drawbridge.js`'s: it needs its leaf as an object it can turn, not
    // as geometry merged into a static city mesh.
    if (span.kind !== 'fixed') continue;
    // Smooth so the deck lights off the arch's own normals rather than facet by facet; the parts that
    // should stay hard carry face normals (`BRIDGE_NORMALS_CLASSIC` in geometry/bridge.js).
    const mesh = new THREE.Mesh(
      createBridge(span, bridgeRng), propMaterial({ smooth: !BRIDGE_NORMALS_CLASSIC }),
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // A deck is a shell a third of a unit thick that both casts and receives, which is the one
    // shape the sun's shadow map cannot separate from its own underside. See `sinkShadowCaster`.
    sinkShadowCaster(mesh);
    mesh.name = `bridge-${line}`;
    // Wet like the street either side of it, with the hump handed over so the carriageway still
    // reads as road two metres up — see `wetGround`.
    rain.wetGround(mesh, { deck: (x, z) => deckHeightAt(x, z).y });
    scene.add(markOccluder(mesh));
  }

  // The joints where every bridge, the drawbridge included, meets the road (`jointParts` in
  // geometry/bridge.js). Road paint, so it receives shadows and never casts them. Its own stream.
  const jointRng = makeRng(seed + 58);
  const joints = bridgeLines().flatMap((line) => jointParts(bridgeSpan(line), jointRng));
  if (joints.length) {
    const jointMesh = new THREE.Mesh(mergeGeometries(joints, false), propMaterial());
    joints.forEach((part) => part.dispose());
    jointMesh.receiveShadow = true;
    jointMesh.name = 'bridge-joints';
    scene.add(markOccluder(rain.wetGround(jointMesh)));
  }
}
// The harbor at the river's east mouth: quays, yards, cranes and a moored ship, all outside the ring
// road (city/harbor.js). Its own stream. Null under `?harbor=classic`.
const harbor = createHarbor(makeRng(seed + 47));
if (harbor) scene.add(markOccluder(harbor.mesh));
// The big park past the north ring road, where the map ends (city/northpark.js). Its own stream.
// Null under `?northpark=classic`.
const northPark = createNorthPark(makeRng(seed + 53));
if (northPark) {
  scene.add(markOccluder(brush(northPark.mesh, 2)));
  scene.add(northPark.water);
  scene.add(northPark.fade);
}
// The ground between the north park and the seawall that now runs on north beside it
// (city/parkshore.js). Null under `?parkshore=classic`.
const parkShoreStrip = createParkShore();
if (parkShoreStrip) {
  scene.add(markOccluder(parkShoreStrip.mesh));
  scene.add(parkShoreStrip.fade);
}
// The harbor's rocky shore carried on round the south end, with a strip of park between the ring
// road and the water (city/southshore.js). Its own stream. Null under `?southshore=classic`.
const southShore = createSouthShore(makeRng(seed + 61));
if (southShore) {
  scene.add(markOccluder(southShore.mesh));
  scene.add(southShore.fade);
}
// Held onto for its `pad`: exactly one roof in the city carries a landing circle, and the
// helicopter below has to be told which one — see `choosePad` in city/buildings.js.
const stopPanes = rain.enabled ? collectPanes() : null;
// The season, before anything plants a tree: the parks, the medians and the courtyards all grow the
// same broadleaf, and autumn is one fact about the whole city (`autumnBase` in city/props.js).
const fall = getFall();
setAutumn(fall, { classicColours: getFoliageClassic() });
const city = createBuildings(makeRng(seed + 22), layout);
scene.add(markOccluder(city.mesh));
// The window frames: not occluders, on purpose (`frameMesh` in city/facade.js).
if (city.frames) scene.add(city.frames);
// The bank's patinated dome is a glossy mesh of its own, not part of the merged one (city/bank.js).
if (city.domeMesh) scene.add(markOccluder(city.domeMesh));
// The windows, on the same reflection as the cars' paint (`glassMeshes` in city/buildings.js).
// Not occluders: the wall a hair behind each pane already is.
for (const glass of city.glass) scene.add(glass);
// The high rises past the west ring road, the streets carrying on to them and the barricades shutting
// them off (city/westedge.js). Built before the panes are collected, so Rain Mode lights their windows
// too. Its own stream. Null under `?westedge=classic`.
const westEdge = createWestEdge(makeRng(seed + 59));
if (westEdge) scene.add(markOccluder(brush(westEdge.ground, 2)), markOccluder(westEdge.towers), ...westEdge.glass);
if (westEdge?.frames) scene.add(westEdge.frames);
// The northwest corner's asphalt skirt (`?westcorner=classic` drops the corner). Transparent, so not
// an occluder.
if (westEdge?.fade) scene.add(westEdge.fade);
// The city carrying on past the edge of the map and fading into the sky (city/horizon.js,
// `?horizon=classic` for the bare edge). Not an occluder and not in the entrance wave: it is the
// world the island stands in, so it is already there while the island builds itself.
const horizon = createHorizon(makeRng(seed + 63), sky.uniforms);
if (horizon) scene.add(horizon.mesh);

// Rain Mode's city lights — lit windows over the panes just built, and street lamps. A wet street
// is a mirror for lamps, and a daytime city has almost none. See game/citylights.js. Their own
// streams, so switching the rain on cannot move a building.
const paneFaces = stopPanes ? stopPanes() : null;
const litPanes = paneFaces ? litWindows(makeRng(seed + 391), paneFaces) : null;
const lamps = rain.enabled
  ? streetLamps(makeRng(seed + 392), layout, entrances(paneFaces ?? [], city.bank))
  : null;
if (litPanes) scene.add(litPanes);
if (lamps) {
  scene.add(markOccluder(lamps.posts), lamps.heads, lamps.pools);
  rain.hideInMirror(lamps.pools);
}
// Dark until the entrance wave has finished: the city arrives, then switches its lights on. Set
// once the wave exists, at the bottom of the scenery; read in `renderFrame`.
let rainLightsOn = null;
for (const mesh of [litPanes, lamps?.pools]) if (mesh) mesh.visible = false;
// Held onto for the entrance animation below — the trees rise out of the parks the same way the
// buildings rise out of their lots — and for its `pond`: exactly one park in the city has water in
// it, and the ducks floating on it have to be told which one. Null on a city with no park big
// enough, which the chain below handles rather than guards against. See city/pond.js.
const props = createProps(makeRng(seed + 33), layout);
const propsMesh = props.mesh;
scene.add(markOccluder(propsMesh));
// The pond's water, which wears the river's surface and so rides outside the merge — and outside
// the AO prepass, for the river water's reasons (`pondWaterMesh` in city/pond.js). Null under
// `?water=classic`, whose flat fan is still in `propsMesh`.
if (props.pondMesh) scene.add(props.pondMesh);
// The graveyard — the third block `createLayout` took out of the tower generator's hands. Scenery
// only: not tappable, nothing routes into it. `null` on `?graveyard=classic` or a city with no
// room, and nothing below needs to know. See city/graveyard.js.
// Built here rather than beside the depot and the burger joint because its tree has to be planted
// before the leaf cards below are dressed onto every tree, and its stones placed before the grass
// below keeps off them.
const graveyard = layout.graveyardBlock
  ? createGraveyard(layout.graveyardBlock, makeRng(seed + 131)) : null;
if (graveyard) {
  scene.add(graveyard.group);
  graveyard.meshes.forEach(markOccluder);
}
// Tufts of long grass on the same lawns, kept out of the furniture `createProps` just placed. Its own
// stream, so retuning the grass moves no tree. **Not** `markOccluder`: the AO prepass would draw
// every card as a solid quad. See city/grass.js.
// The edge lawns (north park, park shore, south shore) grow the same tufts in the same mesh, off
// a stream of their own and kept off the L's columns where it walks across them. The graveyard's
// lawn grows them last, off a third stream (`?gravegrass=classic` leaves it flat).
const lColumns = new URLSearchParams(window.location.search).get('ltrain') !== 'classic'
  ? (() => { const plan = planLTrain(); return plan ? plan.columns.map((a) => plan.world(a)) : []; })() : [];
const grass = createGrass(makeRng(seed + 122), layout, props, {
  rng: makeRng(seed + 123),
  areas: [northPark?.grass, parkShoreStrip?.grass, southShore?.grass].filter(Boolean),
  avoid: (x, z, reach) => lColumns.some((c) => Math.abs(x - c.x) < LTRAIN_DIMENSIONS.FOOTING_W / 2 + reach
    && Math.abs(z - c.z) < LTRAIN_DIMENSIONS.FOOTING_W / 2 + reach),
}, graveyard ? { area: graveyard.grass, rng: makeRng(seed + 124) } : null);
scene.add(grass.mesh);
// Leaf cards round every tree crown — the parks', the medians' and the courtyard's — on the same
// terms as the grass. See city/canopyfuzz.js.
// Every tree in the city, whoever planted it (`plantedCrowns`, city/props.js) — so a new kind of
// tree can't come out without its leaves.
const canopyFuzz = createCanopyFuzz(makeRng(seed + 144), plantedCrowns());
scene.add(canopyFuzz.mesh);
// The basketball court's hoops, which ride outside the merged props mesh so the fare board's
// sightline field never sees them (see `courtParts`) — and the people shooting around on the court. Run seed for the players, like the ducks:
// where the court is is the map, who is out on it is the situation. Built here rather than beside
// the ducks because the entrance wave below has to be handed them. See city/blacktop.js and
// game/hoopers.js.
if (props.courtMesh) scene.add(markOccluder(props.courtMesh));
const hoopers = createHoopers(scene, makeRng(runSeed + 313), props.court);
// And the boom box on the lawn beside it, playing to them. Where it stands is the map's
// (`planBoombox`, in the props stream without a draw); which notes it puts out is the run's.
const boombox = createBoombox(scene, makeRng(runSeed + 317), props.boombox);
// And the skatepark beside it, on the same two terms: its rail and coping ride outside the props
// mesh, and who is riding it is the run seed's. See city/skatepark.js and game/skaters.js;
// `?skater=classic` brings back the first cut's pair of riders (game/skatersclassic.js).
if (props.skateMesh) scene.add(markOccluder(props.skateMesh));
// `?skater=stiff` is the default rider in #461's pose, before it learned to bend.
const skaterFlag = new URLSearchParams(window.location.search).get('skater');
const skaters = (skaterFlag === 'classic' ? createClassicSkaters : createSkaters)(
  scene, makeRng(runSeed + 349), props.skatepark, { stiff: skaterFlag === 'stiff' });

// The elevated train down the north-south arterial's median and west along the east-west one's
// (`?ltrainwest=classic`: straight on south; `?lroute=classic`: the east-west one only) — see game/ltrain.js. On by default
// since 2026-10-11 (Tyler); `?ltrain=classic` takes it out for comparison. Built here rather than beside the boats because the entrance wave below has to
// be handed it. Run seed: where the line runs is the arterial's, so the map's already; which way
// the first train goes and how long the line stands empty is the situation.
const ltrain = new URLSearchParams(window.location.search).get('ltrain') !== 'classic' || shot?.atLTrain
  ? createLTrain(scene, makeRng(runSeed + 421), {
    // Wheel sparks through the shared pool, which is built further down — only ever called from
    // the frame loop, by which time it exists.
    sparks: { burst: (...args) => sparks.burst(...args) },
    // Headlights and tail lamps (2026-10-13, Tyler); `?trainlights=classic` runs it unlit.
    lights: new URLSearchParams(window.location.search).get('trainlights') !== 'classic',
    // Its own intro, bents then track (2026-10-13, Tyler); `?trainintro=classic` grows the whole
    // structure with the city's wave instead. Started and driven beside `cityEntry` below.
    intro: new URLSearchParams(window.location.search).get('trainintro') !== 'classic',
  }) : null;

// The taxi's garage — the block `createLayout` took out of the tower generator's hands, and the
// subject of the opening vignette below. `null` on a city with nowhere to put one, which is a
// state the whole chain below handles rather than one to guard against here: no depot, no
// vignette, and the run opens the way it always did. See city/garage.js.
// `?depot=model` puts the 3D taxi on its roof in place of the cutout, `?depot=classic` the wrench.
const depotFlag = new URLSearchParams(window.location.search).get('depot');
const garage = layout.garageBlock
  ? createGarage(layout.garageBlock, makeRng(seed + 99), {
    sign: depotFlag === 'classic' || depotFlag === 'model' ? depotFlag : 'cutout',
    // `?depotneon=classic`: no blue tube round the roofline.
    trim: new URLSearchParams(window.location.search).get('depotneon') !== 'classic',
    // `?signflames=classic`: no tailpipe on the cutout and no backfire out of it.
    flames: new URLSearchParams(window.location.search).get('signflames') !== 'classic',
  })
  : null;
if (garage) {
  scene.add(garage.group);
  garage.meshes.forEach(markOccluder);
  // ...and tappable, on the burger joint's terms (see below): a damaged taxi sent back here is
  // repaired, by the opening vignette played backwards and forwards again. See game/depotrun.js.
  garage.group.userData.pickable = 'depot';
}
// The depot's office windows, lit with the rest of the city when night or a squall comes over — so
// only in a city with weather, like `litPanes`, and dark until the entrance wave is done the same
// way. `?depotwindows=classic` leaves them dark.
const depotPanes = garage && rain.enabled
  && new URLSearchParams(window.location.search).get('depotwindows') !== 'classic'
  ? switchedLights(garage.litWindows, 'depotWindows') : null;
if (depotPanes) {
  scene.add(depotPanes);
  depotPanes.visible = false;
}

// The burger joint — the second block `createLayout` took out of the tower generator's hands, and
// the one building in the city with something on it that moves. `null` on a city with nowhere to
// put one, exactly as the depot is, and handled the same way all the way down: no joint, no
// drive-through, and nothing else notices. See city/burgerjoint.js.
const burger = layout.burgerBlock ? createBurgerJoint(layout.burgerBlock, makeRng(seed + 111)) : null;
if (burger) {
  scene.add(burger.group);
  // The shell and the lit windows, not the sign: `markOccluder` is the AO prepass, and a burger
  // turning three units above a roof has nothing under it to crease.
  burger.meshes.forEach(markOccluder);
  // ...and the whole joint is tappable, which is the secret: it sends the taxi through the
  // drive-through for a splash of boost (game/burgerrun.js). Tagged on the root group, so the walk
  // up the ancestors that `createPicker` already does answers for the shell, the lit windows and
  // the turning burger alike — a player aiming at this is aiming at the sign as often as not.
  //
  // No invisible hit box, unlike every fare marker on the board. Those are a few pixels of geometry
  // standing on a corner and their targets have to be *drawn* rather than raycast, with all the
  // trouble that brings (see `BILLBOARD` in game/camera.js). A building occupying most of a block is
  // 150px across at play zoom and already exactly the shape it looks like — and raycasting the real
  // mass is the one version that can never cover a marker the player can see past it.
  burger.group.userData.pickable = 'burger';
}
// The vet clinic: an ordinary shop `createBuildings` built and then picked out, with a dog's head on
// its roof and an OPEN sign in its window (city/vetclinic.js). Scenery only. Null on `?vet=classic`
// or a city with no shop that fits.
const vet = city.vet && !VET_CLASSIC ? createVetClinic(city.vet) : null;
if (vet) {
  scene.add(vet.group);
  markOccluder(vet.shell);
}
// The roadside business — the fourth block `createLayout` took from the towers, a car wash or a gas
// station as the city seed rolls it (`?roadside=carwash` / `=gas` pins one) — and the inflatable tube man flailing on its corner, which is what
// it is there for. Scenery only: not tappable, nothing routes into it. `null` on
// `?roadside=classic` or a city with no room. See city/roadside.js. The tube man is
// not tappable either: 4.5 units of tall thin target is exactly the shape that steals taps from a
// marker up-screen of it (CLAUDE.md). Where he stands is the map's; how he flails is the run's.
const roadside = !layout.roadsideBlock ? null
  : (roadsideKind(seed) === 'gas' ? createGasStation : createCarWash)(layout.roadsideBlock, makeRng(seed + 141));
if (roadside) {
  scene.add(roadside.group);
  roadside.meshes.forEach(markOccluder);
}
const tubeMan = createTubeMan(scene, makeRng(runSeed + 331), roadside?.site.tubeMan ?? null, roadside?.entry ?? null);
// Steam out of three of the manhole covers (game/manholesteam.js). Which covers is the city's (the
// plan marks them); which way the wind leans the plumes is too, on a stream of its own.
const manholeSteam = createManholeSteam(scene, manholes?.userData.spots, makeRng(seed + 194));

// Which kerb corners this camera can see, settled once now that everything permanent is standing.
// The board consults it when it places a marker — a rider, a drop-off ring or a courier pad on a
// corner with a tower in front of it is a job the player cannot find. See game/sightline.js, and
// `cornerSeen` in game/fares.js. Everything that can stand in front of a mark goes in: the towers,
// the trees, and the depot. Nothing transient does — a construction zone is 3 units of barrier and
// comes and goes, and the boards would have to be re-asked every time one moved.
const occluders = setCityOccluders(
  city.mesh, ...(city.domeMesh ? [city.domeMesh] : []), propsMesh, ...(garage?.meshes ?? []),
  ...(burger?.meshes ?? []), ...(graveyard?.meshes ?? []), ...(roadside?.meshes ?? []),
  ...(vet ? [vet.shell] : []),
);
// The same field is what the cars' paint reflects (`propMaterial({ gloss })`, util/geo.js).
setGlossCity(occluders, SKYLINE_CEILING);
// Five to seven mended cuts in a side street's lane (city/asphaltpatch.js), its own stream, each one
// where the camera can see all of it — hence here, after the sightline field. Part of the road look,
// so `?roads=classic` leaves them out.
const asphaltPatches = createAsphaltPatches(makeRng(seed + 197), {
  enabled: !roadsClassic(), visible: (x, z) => sightlineClear(x, 0.05, z),
});
if (asphaltPatches) scene.add(markOccluder(rain.wetGround(asphaltPatches)));
// The paved plaza goes to a random side-street junction the camera can see, on its own stream, now
// that the sightline field exists (`placeJunctionPaving`, util/geo.js). `?plazaspot=classic` keeps it
// on the one nearest the middle, which was beside the garage in most cities.
if (new URLSearchParams(location.search).get('plazaspot') !== 'classic') {
  placeJunctionPaving(makeRng(seed + 198), (x, z) => sightlineClear(x, 0.05, z));
}

// Density is on the difficulty curve, so the run opens at its bottom and the instanced meshes are
// sized for its top — an InstancedMesh cannot be resized once built. An explicit `?cars=N` beats
// the curve at both ends, the way `?seed=` beats a random city: a pinned density is a pinned
// density, and a tool that asked for one car should get one car for the whole run.
const pinnedCars = getCarCount(null);
// The rare classics — the convertible and the Westfalia (CLASSIC_CHANCE in sim/traffic.js).
// `?classics=classic` is the fleet without them; a number is the chance of each, so `?classics=0.3`
// puts several on the map to look at.
const classicsFlag = new URLSearchParams(window.location.search).get('classics');
const classicChance = classicsFlag === 'classic' ? 0
  : Number.isFinite(Number.parseFloat(classicsFlag))
    ? Math.min(0.5, Math.max(0, Number.parseFloat(classicsFlag))) : CLASSIC_CHANCE;
const traffic = createTraffic(
  makeRng(runSeed + 44), scene,
  pinnedCars ?? difficulty.carCount(0),
  pinnedCars ?? difficulty.carCount(Infinity),
  TRUCK_CHANCE,
  // At least one, so the flatbed (game/flatbed.js) always has a truck to load. See createTraffic.
  1,
  classicChance,
);
// Experiment: the stop bars are the only thing on screen that shows a signal, so hiding them
// leaves the traffic model obeying lights the player cannot see. Hidden by default while we look
// at the city without them; `?stopbars=on` brings them back for an A/B. `visible` rather than
// removing the mesh: the per-frame colour writes keep running and nothing else has to know.
traffic.barMesh.visible = new URLSearchParams(window.location.search).get('stopbars') === 'on';
// Experiment, the other half of the one above: with nothing on screen showing a signal, the
// signalised junctions run as all-way stops (see `stopSigns` in sim/traffic.js). `?lights=on` puts
// the sim back on the phase plan — pair it with `?stopbars=on` to see the lamps it is obeying.
if (new URLSearchParams(window.location.search).get('lights') === 'on') {
  configureSignals({ stopSigns: false });
}
// `reserved` is how the fare loop learns about the courier's corners without importing it. `parcels`
// is declared just below and this closure is only ever *called* from the frame loop, long after — the
// same forward reference `pathDrag`'s `canGrab` makes to `pause`.
// The combo meter (game/combometer.js): combos landed on a job build a multiplier, and the fare
// loop asks it for the verdict at the drop-off. Per ride by default; `?combo=run` keeps it across
// fares.
const combo = createComboMeter({ scope: comboScope(new URLSearchParams(window.location.search)) });
// The strikes read as a driver's star rating by default; `?rating=off` puts the three rings back.
// See RATING_START in game/fares.js.
const ratingOn = new URLSearchParams(window.location.search).get('rating') !== 'off';
const fares = createFareSystem(makeRng(runSeed + 55), scene, {
  rating: ratingOn,
  // The bank rider's coin loads with every one who rides — BANK_ROBBER_STEP in game/fares.js.
  risingOdds: new URLSearchParams(window.location.search).get('robberyodds') !== 'classic',
  // Demo mode: every bank rider is the robbery, whatever BANK_ROBBER_ALWAYS says. Read live, since
  // the switch is in Settings and flips mid-session.
  forceRob: () => demo.on(),
  // ...and the bank rider is the first spawn after BANK_MIN_DELIVERED rather than a 30% chance,
  // so the robbery comes up inside the first four rides.
  forceBank: () => demo.on(),
  reserved: () => parcels?.occupiedSpots() ?? [],
  judgeRun: () => combo.judge(),
});
// The package courier — see game/parcels.js. Its own stream off the run seed, so adding this layer
// does not reshuffle where every rider spawns. `?parcels=0` turns it off.
//
// 255 rather than the 233 this shipped on: the helicopter landed on main using 233 too, and the merge
// resolved both files cleanly while leaving two systems drawing the *same* sequence — `makeRng` is
// seeded, so equal offsets are not independent streams, they are identical ones. `tools/probe.mjs`
// now asserts every offset in this file is distinct, because nothing about the collision was visible:
// no crash, no failing check, just a package board silently correlated with a helicopter.
//
// `foodPickup` is the burger joint's own corner junction, and it is the whole of what that module
// knows about the city: a food order is collected there and nowhere else (see game/parcels.js). The
// **+X+Z** corner of the joint's block, because `cornerFor` puts a kerb pin on the −X−Z side of its
// junction — so junction (bi + 1, bj + 1) is the one whose pin stands on the joint's *own* slab
// rather than across the road from it. It is also the corner the drive-through's exit crosses, which
// is as close to "at the window" as a mark on a junction can be. A city that failed to place a joint
// (`chooseBurgerBlock` can come back empty) passes null and serves boxes only.
const parcels = parcelsEnabled
  ? createParcelSystem(makeRng(runSeed + 255), scene, {
    foodPickup: burger ? { i: burger.site.bi + 1, j: burger.site.bj + 1 } : null,
    towardHud: towardCargoDock,
  })
  : null;
// Seconds since the taxi's flourish was fired, or null when it is not running. See the frame loop —
// it lights the whole car for the length of a select pop.
//
// Three things fire it, and they are the same claim about the car: *this one, here*. A courier box
// landing in it is an acknowledgement that the thing arrived; the camera riding back to it (see
// `panToTaxi`) is a player who had lost the car being handed it again, at the moment it lands in
// frame; and a tap on the car itself (the picker, below). Reusing one flourish rather than
// inventing a second is the point — the player learns the gesture once.
//
// Its own clock rather than `fares.state.elapsed`, which it used to be stamped against: the fare
// loop is held through the opening and the first-rider beat (`fareLoopHeld`), so its clock stands
// still there — and that is exactly when new players tap the car. A flash stamped on a stopped
// clock never retires, and the taxi stayed lit until the first rider was picked up.
let taxiFlashAge = null;
const flashTaxi = () => { taxiFlashAge = 0; };
// The drive-through, if the city has a joint to run one. Given the cars array for the same reason
// the police cruiser is: it has to see who is on the road it is pulling cars off and back onto.
// On the **run** seed rather than the city's — which cars stop for lunch is part of the situation,
// not part of the map. See game/drivethru.js.
const driveThru = burger
  ? createDriveThru({ site: burger.site, cars: traffic.cars, rng: makeRng(runSeed + 311) })
  : null;

// ...and the player's own trip through it, which is the tap on the joint. It owns the route to the
// mouth and what happens to the job the detour interrupted; the lot itself drives the taxi exactly
// as it drives everybody else. See game/burgerrun.js.
//
// `routeTo` is a hoisted function declaration further down this file, and the two callbacks below
// are only ever *called* from the frame loop — the same forward reference `fares`'s `reserved`
// closure makes to `parcels`.
const burgerRun = driveThru
  ? createBurgerRun({
    site: burger.site,
    lot: driveThru,
    taxi: traffic.taxi,
    routeTo,
    // Both halves of the counter transaction, on the frame the order is handed over. The boost
    // arrives on the same energy bit a delivery pays with (`flyEnergyToBoost`), so the reward reads
    // as the reward rather than as a meter that moved on its own — it is the smallest top-up in the
    // game, see BOOST_BURGER_REWARD — and the money leaves on the same flight a fare's payout
    // arrives on, just wearing the other sign.
    //
    // The two travel in opposite directions across the screen on purpose: the bit flies *to* the
    // pill and the price flies *to* the counter, and a player who never reads a number still sees
    // one thing bought with another. `charge` returns what it could actually take (see fares.js), so
    // a near-empty till pops the number that really left rather than the price on the board.
    onServed: () => {
      flyEnergyToBoost({
        from: taxiScreenPos,
        to: fuelScreenPos,
        onArrive: () => boost.topUp(BOOST_BURGER_REWARD),
      });
      const paid = fares.charge(BURGER_PRICE);
      if (paid > 0) popEarning(-paid);
      haptic('burger');
    },
    onFinish: (handBack) => resumeJob(handBack),
  })
  : null;

// ...and the trip back to the depot for repairs, which is the tap on the garage. Same shape as the
// burger run: it owns the route to the driveway and catches the taxi there, and the visit itself is
// the opening vignette played backwards and then forwards again (`enter` in game/opening.js).
// Nothing in shot mode, where the vignette is never built.
//
// The fare board's clocks are held for the whole visit, from the turn in off the lane to the camera
// being handed back — the cost of a repair is the drive there, not the cut scene. See
// `holdFareClocks`.
// `?garageroute=classic` is the depot reached by its right turn in only — the lap round the block
// whenever the taxi comes down the far side of the road (see the header of game/depotrun.js).
const garageRouteClassic = new URLSearchParams(window.location.search).get('garageroute') === 'classic';
const depotRun = garage && !shot
  ? createDepotRun({
    site: garage.site,
    mouth: entryPath(garage.site).mouth,
    farMouth: garageRouteClassic ? null : entryPath(garage.site, 'far')?.mouth ?? null,
    cars: traffic.cars,
    taxi: traffic.taxi,
    routeTo,
    onArrive: (s0, handBack, side) => {
      if (!opening?.enter(s0, {
        side,
        // Behind the shut door, so nobody sees the damage go.
        onRepair: () => {
          traffic.taxi.hp = TAXI_HP;
          taxiDamage.reset();
          hitCue?.clear();
        },
        // The car is back on the lane, 5.5 units short of a junction: put a job under it before it
        // gets there. A route the player planned while it was inside stands — `stageCar` never saw
        // it, and the lane it was planned from is the one the car is released onto.
        onRelease: () => {
          if (!traffic.taxi.pendingTarget) resumeJob(handBack);
          // The bill, as the car comes back out onto the road: the red `−$25` rises off the taxi
          // and flies to the counter, the burger's charge on a bigger number. Here rather than
          // behind the door so the player sees what the repair cost on the car it bought. See
          // REPAIR_PRICE in game/fares.js.
          const paid = fares.charge(REPAIR_PRICE);
          if (paid > 0) popEarning(-paid);
        },
        onDone: holdFareClocks,
      })) return false;
      // `stageCar` has already emptied the route; the target goes with it, so the band comes down
      // and nothing reads the depot as still being where the taxi is headed.
      traffic.taxi.pendingTarget = null;
      holdFareClocks();
      // The depot is a hideout: a chase on the taxi's tail is called off the frame it turns in.
      // `patrol` is built further down, but this only ever runs from the frame loop.
      patrol.hideout();
      return true;
    },
  })
  : null;

// The bank robbery — see game/robbery.js. `city.bank` is null on a city with nowhere to put a
// bank (38 seeds in 40 have one), and the whole layer simply does not exist behind that: same
// shape as the depot, the burger joint and the courier, and for the same reason — a city that
// cannot host a feature should still be a playable city.
//
// Off in shot mode alongside the courier, for the same reason that one is: a screenshot warms the
// sim forward on a scripted path, and an event that fires off *where the taxi happens to be* would
// put a robber in half the shot list at random.
// Dispatch breaking in when the robber gets in — the one thing that says this pickup is not a fare
// on the frame it happens. See game/radio.js. Built whether or not the city has a bank, because the
// patrol cruiser's chase talks on the same channel (game/patrol.js).
const radio = !shot ? createRadio({ project: projectToScreen, viewport }) : null;
// The depot's repair tip: a line in the speech card with its tag on the garage door, the first time
// the taxi smokes in a run, until the player has once sent it in. `?repairtip=classic` is the New
// Move-style card with the clip that it replaced. See game/depotcall.js.
const repairTipClassic = new URLSearchParams(window.location.search).get('repairtip') === 'classic';
const depotCall = !shot && garage && !repairTipClassic
  ? createDepotCall({
    project: projectToScreen, viewport, site: garage.site,
    // Its tag at the screen edge rides the camera to the garage, which is then there to tap.
    onEdgeTap: () => lookAtTalker(garage.site.focus, () => Boolean(depotCall?.state.open || depotCall?.state.marked), () => {
      depotCall.extend();
    }),
    edgeTappable: () => isNarrow(),
  }) : null;
// Seconds of game time until dispatch breaks in, once the robber's line has been cleared; 0 when
// nothing is pending. A beat after the police come on rather than with them, so the tap that
// clears the robber's bubble does not also land a second bubble on the same frame.
const RADIO_DELAY = 1.5;
let radioIn = 0;
// The robber boarded and is still running for the cab — the robber's line opens the frame they are
// in. Null when nothing is waiting on it.
let robberBoarding = null;
// The robber's door is shut when the world comes back, not on the boarding clock. The line opens on
// the frame the figure is in — BOARD_SECONDS, the very moment `boardSound` schedules the close — and
// its freeze suspends the audio context a frame later, so the close got a few milliseconds out
// before the hold cut it: a lone blip under the bubble, and the rest of the slam after it. Set when
// the robber boards, cleared by the slam on the first unheld frame.
let robberDoorOpen = false;
// The robber's line: the world stops while it is up — see game/robberline.js and the early return
// in `frame()`. Its dismissal is what calls the police.
const robberLine = city.bank && !shot
  ? createRobberLine({
    viewport,
    taxi: traffic.taxi,
    project: projectToScreen,
    pixelsPerUnit: () => viewport.height() / (2 * controller.viewZoom()),
    pickLine: (() => {
      const rng = makeRng(runSeed + 419);
      return () => rng.pick(ROBBER_LINES);
    })(),
    onDone: () => {
      robbery?.raiseAlarm();
      radioIn = RADIO_DELAY;
      // The cut's door slams and its camera comes home as the getaway starts.
      bankJob?.release();
    },
  })
  : null;
// The robbery opens on a cut (`?robbery=classic` for the old drive-past) — the alarm, the robber out of the door, a
// bystander shoved over, the run to the cab — before the robber's line. See game/bankjob.js; the
// module itself is built further down, once the cash trail it sheds notes into exists.
const robberyIntro = new URLSearchParams(window.location.search).get('robbery') !== 'classic';
// ...framed on the screen around everything in it, with the L's deck thinned over the shove
// (`frameCut` in game/bankjob.js). `?robberycam=classic` is the first framing, averaged in the ground
// plane round the cab, which put the bank at the edge of an upright phone whenever the cab was
// picked up across the street.
const classicRobberyCam = new URLSearchParams(window.location.search).get('robberycam') === 'classic';
// ...and it starts with the bank rider: a fare on the bank's steps, a coin tossed when they spawn,
// and the robber taking their seat on tails (BANK_CHANCE in game/fares.js). `?bankfare=classic`
// keeps the drive-past, with a bystander always outside and the alarm always on the building.
const bankFare = robberyIntro && new URLSearchParams(window.location.search).get('bankfare') !== 'classic';
const robbery = city.bank && !shot
  ? createRobbery({
    site: city.bank,
    taxi: traffic.taxi,
    fares,
    traffic,
    // The bank job owns the run to the cab, so the fare loop's boarding animation stands down.
    scripted: robberyIntro,
    trigger: bankFare ? 'fare' : 'drive',
    // The police wait for the robber's line to be cleared — see `robberLine` above.
    holdAlarm: true,
    // ...and the robbery waits for a patrol chase to be over — see `busy` in game/robbery.js.
    busy: () => patrol.busy(),
    // Demo mode waives the fairness gates, so the bank rider is the robbery every time.
    forced: () => demo.on(),
    // Never take a cop off the map where the player can see it — see `inShot` in game/robbery.js.
    inShot,
    // Delivered: the nearest cop comes after the taxi as an ordinary patrol chase — caught on a
    // touch, lost two and a half blocks out — while the rest fan out round the robber on the corner
    // (game/arrest.js). The robber is delivered, so the chase can end the run: that is the trade
    // the drop-off asks for, and the full tank the robber boarded with is what pays for it.
    handOff: (cops) => patrol.pursueNearest(cops),
    // The frame the robber is in the car. It is the ordinary `'pickup'` handler's job, said once
    // here rather than smuggled into the event loop: the seat is full, the route the taxi was
    // driving is void, and the getaway dispatches itself exactly as any other drop-off does.
    onBoard: (fare) => {
      traffic.taxi.route = [];
      traffic.taxi.pendingTarget = null;
      traffic.setTaxiOccupied(true);
      dispatchToDropoff(fare);
      // ...and a burger run, if one was going, is called off rather than put back in front of the
      // car the way the `'pickup'` handler does: the drive-through is shut for the getaway
      // (`getaway()` below), and a detour to it with four cop cars behind is not a standing
      // instruction anybody would want kept.
      burgerRun?.abandon();
      // A full tank for the getaway, poured the way a VIP's reward is: exactly what is missing,
      // read when the bits land. The event is imposed — it takes the seat whatever the meter says —
      // and a getaway opened on a dry pill is a slow chase the player never chose, with every cop
      // on the street cruising faster than an unboosted taxi.
      flyEnergyToBoost({
        from: taxiScreenPos,
        to: fuelScreenPos,
        onArrive: () => boost.topUp(1 - boost.fraction()),
      });
      // Not the depot, though: a repair is refused with anyone aboard, so the drop-off just
      // dispatched stands and `depotRun.update` sees its target gone and stands down.
      haptic('pick');
      robberDoorOpen = true;
      robberBoarding = fare;
      // The bank job's cut plays first, with the world stopped, and opens the door itself as the
      // robber reaches it.
      if (bankJob) {
        bankJob.begin(fare, traffic.taxi, (f, at) => {
          fares.boardScripted(f, at.x, at.z);
          robberIn();
        });
        return;
      }
      sfx?.play('doorOpen');
      // Not the radio, and not the robber's line yet: the figure is still running down the bank's
      // steps for the cab (BOARD_SECONDS in game/fares.js), and the line is about them being *in*
      // it. The frame loop opens it once they are.
      robberBoarding = fare;
    },
  })
  : null;

/**
 * The robber is in the car: stop the world and let them speak. From the frame loop once the
 * boarding run is over, or from the bank job's cut once its robber has hopped in.
 */
function robberIn() {
  robberBoarding = null;
  // No bubble to show (its markup missing) is no reason to have no police.
  if (!robberLine.open()) { robbery.raiseAlarm(); radioIn = RADIO_DELAY; bankJob?.release(); }
}

/**
 * A rider getting in: the door opens on the frame the taxi reaches them and shuts once they are in,
 * which is the BOARD_SECONDS run from the kerb (game/fares.js). Scheduled on the audio clock, so a
 * pause mid-boarding holds the door open with the rest of the world.
 */
function boardSound() {
  sfx?.play('doorOpen');
  sfx?.play('doorClose', { delay: BOARD_SECONDS });
}

// The sound — see game/sfx.js. Silent in shot mode, which renders stills and has nobody listening.
// Its own stream, which draws the take each one-shot plays (the designer's A/B/C variants).
// `menuMusic`: the radio stays off the air under the title menu and Play opens it on the announcer
// (`goOnAir` in `beginRun`); with no title screen, `beginRun` runs at boot and the radio opens on
// the intro as ever. The menu itself is effects only; `?titlemusic=classic` plays songs under it
// until Play cuts them. `?menumusic=classic` opens on the intro under the menu instead.
// No sound at all under `?backdrop` (game/backdrop.js), so none of it is fetched.
const sfx = shot || BACKDROP ? null : createSfx({
  rng: makeRng(runSeed + 811),
  menuMusic: new URLSearchParams(window.location.search).get('menumusic') !== 'classic',
  menuSongs: new URLSearchParams(window.location.search).get('titlemusic') === 'classic',
  // The DJ talks over the edges of the songs; `?radiofade=classic` cuts hard between tracks.
  radioFade: new URLSearchParams(window.location.search).get('radiofade') !== 'classic',
});
// The dash radio (`DASH` in game/sfx.js): Play puts the station in the taxi's own speakers, and it
// opens out into the full mix when the car rolls out of its garage. `?radiointro=classic` keeps the
// station full-range from Play.
const dashRadio = new URLSearchParams(window.location.search).get('radiointro') !== 'classic';
// The vignette beats the car is still in its garage for, so the radio stays in the dash. Anything
// else — `roll` onward, a skip, `?vignette=off`, a city with no depot — opens it.
const DASH_PHASES = new Set(['wait', 'approach', 'settle', 'door', 'reveal']);
// The ⚙️ panel's handle once it exists (`createDebugPanel` at the bottom of the file), so the frame
// can ask whether it is open — the sound rings below show only then.
let debugPanel = null;
// The title screen's Settings, remembered across visits (game/settings.js). The two volumes are
// applied to the engine here and on every change; the tips on Play, and again if the pause screen's
// copy switches them off mid-run (`dropTutorial`).
sfx?.setVolumes(settings.get());
settings.onChange((v) => sfx?.setVolumes(v));
setHapticPrefs(settings.get());
settings.onChange(setHapticPrefs);

// The one mute, as the Settings pages on the title and pause screens see it. M flips it from a
// keyboard; the choice is remembered (localStorage, soft — see game/sfx.js). The pages re-read it
// each time they come up, so M needs to tell nobody.
const soundSwitch = {
  isOn: () => Boolean(sfx && !sfx.state.muted),
  set: (on) => { sfx?.setMuted(!on); },
};
window.addEventListener('keydown', (event) => {
  if (event.key !== 'm' && event.key !== 'M') return;
  // Not while typing initials, where M is a letter — the pause key's rule.
  if (event.target instanceof HTMLInputElement) return;
  sfx?.toggleMuted();
});

// The patrol cruiser's look (sim/police.js) and its life (game/patrol.js): a police car that
// crosses town edge to edge with its bar swinging red and blue, and comes after you if you boost in
// front of it. "Pull over!" goes up over its roof the moment it does (game/copshout.js).
const police = createPolice(scene);
// ...and the extra cruisers the harder Difficulty modes put on patrol (`extraPatrols` in
// game/difficulty.js), one per patrol the hardest mode can have. All built up front, so a mode
// switched from the pause screen has its cars ready; until one wears a car it is a hidden shell and
// costs no draw. No lamps on these: see `createPolice`.
const cruisers = [police, ...Array.from(
  { length: Math.max(...Object.values(difficulty.MODES).map((m) => m.tuning.extraPatrols ?? 0)) },
  () => createPolice(scene, { lamps: false }),
)];
// The cops no longer talk during a chase — no "pull over" on spotting, no "lost the suspect" when
// they give up (Tyler, 2026-10-13): the bar, the strobe and the chirp already say both. The bubbles
// come back with `?copchat=classic`. The robbery's dispatch call is a different thing and stays.
const copChat = new URLSearchParams(window.location.search).get('copchat') === 'classic';
const copShout = shot || !copChat ? null : createCopShout({ project: projectToScreen, viewport });

/**
 * Is a getaway on? The robbery owns the run while it is: the depot and the drive-through both
 * refuse the taxi (`canRepair`, `sendForBurger`, the picker's stand-in rule), since a repair or a
 * burger mid-chase is a pause button with cops waiting outside it.
 */
const getaway = () => Boolean(robbery?.state.active);
// The street race (game/race.js), built further down beside the fire; declared here because the
// gates below read it.
let race = null;
/**
 * ...and the wider version the tips are held behind: a getaway, or the chase its drop-off hands to
 * the patrol (`handOff`). Tyler got "Head to the shop for repairs" over the road mid-getaway. A
 * held tip is *deferred*, not dropped — see the depot's card (`newMoveCalm`) and `quiet` in
 * game/tutorial.js.
 */
const hushTips = () => getaway() || patrol.busy() || Boolean(race?.active());
// How the police end a run (game/patrol.js, "The capture model"): a hit on a cop is a hit on a car,
// and "Busted!" is being pinned — stopped with a chasing cop's bumper on you — by the patrol or by a
// getaway's fleet alike. `?capture=classic` keeps the three rules it replaced: any patrol touch is
// the bust, a boosted hit on any cop is the wreck, and a getaway's cops never arrest anybody.
const captureClassic = new URLSearchParams(window.location.search).get('capture') === 'classic';
const getawayPin = createPin(traffic.taxi);
const makePatrol = (cruiser, k) => createPatrol({
  // The first keeps the stream it always had, so an Easy run is the run it was.
  rng: makeRng(k === 0 ? runSeed + 66 : runSeed + 6600 + k),
  police: cruiser,
  traffic,
  taxi: traffic.taxi,
  // A robbery owns the streets while it runs, and its cops are still in the shared fleet while
  // they drive off afterwards — see `busy` in game/robbery.js for the other half of this.
  blocked: () => Boolean(robbery?.state.active) || traffic.policeCars.some((cop) => !cop.patrol),
  onSpotted: (cop) => {
    copShout?.show(cop);
    haptic('pick');
    sfx?.play('chirp', { at: placeAt(cop.x, cop.z) });
  },
  onCaught: (cop, ram) => bustByPolice(ram),
  capture: !captureClassic,
  // A cop that loses you goes back on patrol, bar swinging; `?standdown=classic` has it go dark and
  // drive off the map instead.
  resume: new URLSearchParams(window.location.search).get('standdown') !== 'classic',
  // A ram at speed is a hit like any other, charged through the same path a boosted one is.
  onRammed: (cop) => { collisions.strike(cop); },
  // Said by the cruiser that lost you, from over its own roof — `?copchat=classic` only.
  onLost: (cop) => { if (copChat && !fares.state.gameOver) radio?.show(LOST_CALL, cop); },
  onHid: (cop) => { if (copChat && !fares.state.gameOver) radio?.show(LOST_CALL, cop); },
});
/**
 * Every patrol, behind the one-patrol interface the rest of this file was written against. Each runs
 * its own life (its own cruiser, cooldown, chase and pin), and `difficulty.patrolCount()` says how
 * many may be out: one on Easy, two on Regular, three on Hard. One that drops out of the count
 * mid-run (the mode switched down) finishes whatever it is doing before it stops.
 *
 * `state` is the busy patrol's when there is one, so the chase siren and the tips read the chase,
 * and the first patrol's otherwise.
 */
const patrols = cruisers.map(makePatrol);
// A run opens with a patrol due (5-12s); the extras come in later and a little apart, rather than
// three cruisers arriving in the same breath.
patrols.forEach((p, k) => { p.state.cooldown += k * 12; });
const patrolOut = (p, k) => k < difficulty.patrolCount() || p.state.phase !== 'off';
const patrol = {
  get state() { return (patrols.find((p) => p.busy()) ?? patrols[0]).state; },
  update(dt, opts) { patrols.forEach((p, k) => { if (patrolOut(p, k)) p.update(dt, opts); }); },
  setCooldownRange(range) { for (const p of patrols) p.setCooldownRange(range); },
  // A getaway's cop handed over goes to a patrol with no car of its own first, so the hand-off
  // does not take a cruiser off the road mid-crossing; failing that, to the first, as it always did.
  pursueNearest(cops) {
    const free = patrols.filter((p, k) => patrolOut(p, k) && !p.state.cop);
    for (const p of free.length ? free : [patrols[0]]) {
      const cop = p.pursueNearest(cops);
      if (cop) return cop;
    }
    return null;
  },
  rammed(cop) { for (const p of patrols) p.rammed(cop); },
  hideout() { return patrols.map((p) => p.hideout()).some(Boolean); },
  busy: () => patrols.some((p) => p.busy()),
};
// Boost, then two quick taps of the brake: the taxi spins round onto the far lane. See game/bootleg.js.
setSpinStyle(getUturnStyle());
// The drift launch rolls the taxi a full turn in mid-air; `?barrelroll=classic` flies it level.
setBarrelRoll(new URLSearchParams(window.location.search).get('barrelroll'));
// Mega Air front-flips the taxi twice over the drawbridge; `?megaflip=classic` flips it once.
setMegaFlip(new URLSearchParams(window.location.search).get('megaflip'));
setBigAirRoute(new URLSearchParams(window.location.search).get('bigairroute'));
// The taxi waits for a car already turning left before pulling out round it; `?passturn=classic`
// pulls out anyway and grinds along its flank, as before.
setPassTurnGate(new URLSearchParams(window.location.search).get('passturn'));
// The overtake combo throws the taxi into the oncoming lane the moment it is thrown, with no
// judgement about what is there; `?overtake=classic` puts the judgement back.
setOvertakeStyle(new URLSearchParams(window.location.search).get('overtake'));
setPeek(new URLSearchParams(window.location.search).get('peek'));
// Ambient traffic no longer flees the boosting taxi; `?scatter=classic` puts the flee back.
setTaxiScatter(new URLSearchParams(window.location.search).get('scatter'));
// A swinging-out taxi keeps its pace instead of matching the car it is going round, and a truck it
// is passing stops holding it back through junctions; `?passpace=classic` puts both back.
setPassPace(new URLSearchParams(window.location.search).get('passpace'));
// The overtake combo also swerves round a car stopped or creeping in the junction ahead;
// `?swerve=classic` keeps it for leaders only.
setDodge(new URLSearchParams(window.location.search).get('swerve'));
// A hop always comes down; `?hop=classic` lets the brake park the taxi in mid-air again.
setHopStyle(new URLSearchParams(window.location.search).get('hop'));
const bootleg = createBootleg({
  taxi: traffic.taxi,
  destination: () => traffic.taxi.pendingTarget ?? null,
  plan: (target) => {
    const origin = planOrigin(traffic.taxi);
    const route = findRoute(origin, target);
    return route && carryOn(route, target, onwardFrom(target), origin.d);
  },
  // It has to land like a hit: the screech, a jolt of shake, a buzz, and all four wheels marking the
  // road on the frame it starts. `layRubber` carries the streak on from there.
  onSpin: () => {
    sfx?.play('skid');
    haptic('uturn');
    controller.kickShake(0.55);
    stampAllRubber(traffic.taxi);
    if (!fares.state.gameOver) landCombo('uturn');
  },
});
// Loco behind a car, a blip off the pill and back on: the taxi goes round. See game/overtake.js.
function overtakeGrace(params) {
  const asked = params.get('grace');
  return asked !== null && Number.isFinite(Number(asked)) ? Math.max(0, Number(asked)) : OVERTAKE_GRACE;
}
// A car the taxi has just caught is tailgated for OVERTAKE_GRACE before it can be rammed, so there
// is time to throw the combo (Tyler, 2026-10-07: "feels better"). `?grace=1.6` tries another
// length and `?grace=0` is the old rule, rammed the moment you catch it.
const overtake = createOvertakeCombo({
  taxi: traffic.taxi,
  grace: overtakeGrace(new URLSearchParams(window.location.search)),
  // A fresh press behind a car is tailgated for OVERTAKE_PRESS_GRACE, so the combo's first tap
  // from a taxi already sitting behind one is not itself a ram. `?pressgrace=classic` drops it.
  ...(new URLSearchParams(window.location.search).get('pressgrace') === 'classic' ? { pressGrace: 0 } : {}),
});
// The vehicles, so a car reads as sitting *on* the road rather than pasted over it. The stop bars
// are left out deliberately — they are 0.05-unit road paint, and their own outline is not a
// contact. The ghost outlines hung off the taxi are filtered out inside `markOccluder`.
markOccluder(traffic.mesh);
for (const classic of traffic.classicDrawn) markOccluder(classic);
markOccluder(traffic.wheelMesh);
markOccluder(traffic.truckMesh);
markOccluder(traffic.truckWheelMesh);
markOccluder(traffic.truckBoxMesh);
markOccluder(traffic.bumperMesh);
markOccluder(traffic.truckBumperMesh);
markOccluder(traffic.taxiGroup);
for (const cruiser of cruisers) markOccluder(cruiser.group);

// --- What glows ---------------------------------------------------------------------------
// The bloom's draw list, marked here for the reason the AO occluders are: `sim/` may not import
// from `game/`, so the two vehicle modules hand their light meshes back instead. This is the whole
// selector — there is no luminance threshold anywhere in the pass, deliberately, because at golden
// hour a fare's timer ring is exactly as bright as a brake light and only one of them is a lamp.
// See `game/bloom.js`.
//
// The intensity is per *kind* rather than per mesh, and it is per kind because spill is a total
// rather than a peak: a four-pixel pod and a menu board forty times its area do not want the same
// number. See BLOOM_INTENSITY.
// Each mesh names its own kind — a brake pod blooms at `pod`, a cop car's light bar at the
// cruiser's own `siren`. Read off the mesh rather than stated here, so a new lamp arrives in the
// bloom at the right strength by being built rather than by being remembered in two places.
for (const mesh of traffic.emissiveMeshes) markEmissive(mesh, mesh.userData.bloomKind ?? 'pod');
if (litPanes) markEmissive(litPanes, 'window');
// The taxi's own headlights and their cones, hung on its group so they ride the body. The group is
// also what becomes the wreck (see `wreckShell` in sim/traffic.js), so they go dark while it is one.
taxiHeadlights = rain.enabled ? createTaxiHeadlights() : null;
if (taxiHeadlights) {
  taxiNow = () => traffic.taxi;
  setTaxiHeadlights(runningLevel);
  traffic.taxiGroup.add(taxiHeadlights.group);
  markEmissive(taxiHeadlights.pods, 'pod');
}
if (lamps) markEmissive(lamps.heads, 'bay');
for (const mesh of cruisers.flatMap((c) => c.emissiveMeshes)) markEmissive(mesh, 'siren');
if (ltrain?.lamps) markEmissive(ltrain.lamps, 'pod');
// The landmarks name their own lit meshes (`LANDMARK.glow` in each module), the same list the
// workshop's bench blooms, so a landmark cannot glow on one and not the other. One mesh can be
// three lit things: the burger joint's pickup window, menu board and roofline neon are all merged
// into its `glow`, so the neon arrived in the bloom with nothing to wire.
for (const [built, landmark] of [
  [burger, BURGER_LANDMARK], [graveyard, GRAVEYARD_LANDMARK], [garage, GARAGE_LANDMARK],
  [roadside, roadsideKind(seed) === 'gas' ? GAS_LANDMARK : CARWASH_LANDMARK],
]) {
  if (built) for (const [mesh, kind] of landmark.glow(built)) markEmissive(mesh, kind);
}
if (depotPanes) markEmissive(depotPanes, 'window');
// The vet's OPEN sign, at the strength the depot's and the burger joint's neon bloom at.
if (vet) markEmissive(vet.glow, 'window');
// The riders. They receive AO through `propMaterial()` either way, so leaving them out of the
// prepass would paint the kerb's own contact line across whoever is standing in front of it.
// Only the figure is taken — `markOccluder` filters out the translucent target disc under them.
for (const slot of fares.slots) markOccluder(slot.passenger.group);

// Cartoon Mode's hero outlines, and **after every `markOccluder` above rather than beside them**.
// A hull is an opaque colour-writing mesh, so `markOccluder` would happily enrol one — and a hull
// in the depth prepass stamps a silhouette a third of a unit bigger than the car it wraps, which
// would leave the city's own screen-space line tracing the outline instead of the vehicle.
//
// The taxi and the cruiser are per-mesh groups and wear child hulls; the ambient fleet is
// instanced and gets sibling meshes sharing traffic's own matrices, so the whole fleet costs three
// draw calls and no per-frame work. Wheels are skipped for the fleet and included on the two hero
// vehicles, which is the same split `game/carghosts.js` measured: a wheel sits inside the body's
// hull on every axis but a sliver, and at play zoom a truck is a shape while the taxi is *read*.
if (cartoonEnabled) {
  cartoon.outline(traffic.taxiGroup, { group: 'taxi' });
  for (const cruiser of cruisers) cartoon.outline(cruiser.group);
  for (const source of [traffic.mesh, ...traffic.classicDrawn, traffic.truckMesh, traffic.truckBoxMesh]) {
    scene.add(...cartoon.fleet(source));
  }
}
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

// Is the frame currently pushed in for Loco Mode (see LOCO_PUNCH in game/camera.js)? Latched rather
// than recomputed from the button every frame, because it has to survive the release: `isEngaged()`
// is the hold *plus* the momentum tail, so feathering the pill — letting go and grabbing it again
// inside the second the taxi is still at full tilt — holds the frame where it is instead of
// breathing it out and back in under the player. Earning it still takes a hold, every time: the
// latch can only stay on through the tail, never switch on during one.
let locoPunched = false;

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
  gain: Math.min(car.v / boostCruise(), 1),
  speed: car.v,
});

let cameraTakenOver = false;
// Was Loco Mode held last frame? A press is the edge, and the edge is what hands the camera back.
let wasBoosting = false;
// Assigned further down, once the fare board and the picker it reads exist. Declared here because
// the handover below is the one thing that has to reach it, and a swipe cannot arrive before the
// module has finished evaluating.
let tutorial = null;
// The opening vignette, built at the very bottom of this file: it has to be constructed *after*
// the traffic warm-up, because the first thing it does is take the taxi off the road and park it
// in the garage, and the warm-up would drive it straight back out. Null in shot mode and on a
// city with no depot. See game/opening.js.
let opening = null;
// Is the tutorial talking? One of the two things that hold the board's clocks — see holdFareClocks.
let tutorialTalking = false;

// Debug mode: the ⚙️ panel's flags (`?debug`, `?settings`, or `?audio`). Decided up here rather than
// beside the panel because two things well before it read it: a tuning session runs with no
// tutorial and with the fare clocks held, so the game can be left open behind the panel without
// having to be played to stay alive.
// `?dev` is the working shortcut: debug mode, straight past the title screen and the opening
// vignette, into a run — the three flags a playtest of anything in the ⚙️ panel wants together.
const devMode = new URLSearchParams(window.location.search).has('dev');
const debugMode = (() => {
  const params = new URLSearchParams(window.location.search);
  return !shot && (devMode || params.has('debug') || params.has('settings') || params.has('audio'));
})();

/**
 * Freeze or free every fare's countdown. Three things hold it and any is enough: debug mode, for
 * good; the tutorial while it talks; and a repair visit to the depot. One place decides, so none
 * can release a hold another still wants — a visit landing mid-lesson would otherwise start the
 * clocks the tutorial had stopped.
 */
function holdFareClocks() {
  fares.setPaused(debugMode || tutorialTalking || Boolean(opening?.visiting()));
}
const releaseCameraToPlayer = () => {
  cameraTakenOver = true;
  // A swipe during the tutorial takes the framing off it too. It keeps talking — the lesson is
  // still worth reading — it just stops moving the map while the player reads it.
  tutorial?.releaseCamera();
};

// Screenshots frame themselves, and a shot run has no user to drag anything.
//
// On a desktop the whole city fits and nothing pans (NARROW_VIEWPORT) — except in debug mode, where
// the map drags on any screen: the placed sounds are heard from the middle of the screen (`placeAt`),
// and auditioning the court's falloff means being able to put the court there.
const pan = shot
  ? null
  : attachDragPan(controller, renderer.domElement, aspect, () => isNarrow() || debugMode,
    releaseCameraToPlayer);

const dust = createDust(scene, camera, makeRng(seed + 77));
const spray = createSpray(scene, makeRng(seed + 78));

// A post box and a hot dog cart on the kerb, which an overtake up onto the pavement takes out — see
// game/streetprops.js. City seed for where they stand, after the sightline field exists (they only
// go where the camera can see them) and clear of the rain's street lamps. Run seed for the spray.
const lampSpots = lamps?.spots.map((p) => ({ x: p.px, z: p.pz })) ?? [];
const streetPropPlan = planStreetProps(makeRng(seed + 211), layout, lampSpots);
const streetProps = createStreetProps(scene, streetPropPlan, { dust, rng: makeRng(runSeed + 212) });

// Bags piled on the kerb at street corners, and the garbage truck that drives round collecting them
// — see game/garbage.js. City seed for where the piles stand (clear of the lamps and the street
// props' swipe), run seed for the bags and the truck. The truck is a car in traffic like the fire
// engine, and holds off in shot mode and through the opening vignette. `?garbage=soon` brings it on
// a second in; `?garbage=classic` has neither.
const garbage = createGarbage({
  rng: makeRng(runSeed + 731), scene, traffic,
  plan: planTrashPiles(makeRng(seed + 733), layout,
    [...lampSpots, ...streetPropPlan.map((p) => ({ x: p.x, z: p.z, r: PROP_KEEP_OUT }))]),
  blocked: () => Boolean(shot) || traffic.taxi.staged,
  soon: new URLSearchParams(window.location.search).get('garbage') === 'soon',
});
// The beacon blooms at the cruiser's bar's strength.
for (const mesh of garbage.emissiveMeshes ?? []) markEmissive(mesh, 'siren');

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
  meshes: [city.mesh, ...city.glass, ...(city.frames ? [city.frames] : []), ...(city.domeMesh ? [city.domeMesh] : []), ...(westEdge ? [westEdge.towers, ...westEdge.glass] : []), ...(westEdge?.frames ? [westEdge.frames] : []), propsMesh, grass.mesh, canopyFuzz.mesh, ...(garage?.meshes ?? []),
    ...(burger?.meshes ?? []), ...(graveyard?.meshes ?? []), ...(roadside?.meshes ?? []),
    ...(vet?.meshes ?? []),
    ...(lamps ? [lamps.posts, lamps.heads] : []),
    ...(props.courtMesh ? [props.courtMesh] : []), ...(props.skateMesh ? [props.skateMesh] : []),
    ...(props.pondMesh ? [props.pondMesh] : [])],
  // The two things in the city the wave's vertex shader cannot reach, because they turn: the
  // depot's sign and the burger over the drive-through. See the `objects` note in
  // game/cityentry.js.
  objects: [...(garage ? [garage.entryObject] : []), ...(burger ? [burger.entryObject] : []),
    ...(vet ? [vet.entryObject] : []),
    ...(graveyard ? [graveyard.entryObject] : []),
    ...hoopers.entryObjects, ...boombox.entryObjects, ...skaters.entryObjects,
    ...tubeMan.entryObjects, ...(roadside?.entryObjects ?? []), ...(ltrain?.entryObjects ?? []),
    ...streetProps.entryObjects, ...garbage.entryObjects],
  sites: [...city.entrySites, ...(garage ? [garage.entrySite] : []),
    ...(burger ? [burger.entrySite] : []), ...(graveyard ? [graveyard.entrySite] : []),
    ...(roadside ? [roadside.entrySite] : [])],
  dust,
  // The spawn point for now — the wave is re-aimed at the taxi's *post-warmup* position at the
  // bottom of this file, which is where the player actually first sees the car.
  from: { x: traffic.taxi.x, z: traffic.taxi.z },
});
// The L's intro runs on the city entry's wave and levers, but on its own clock, since the track
// is still being laid after the last building has landed.
const replayLTrainIntro = (from) => ltrain?.intro?.start(from, cityEntry.tuning());
replayLTrainIntro(traffic.taxi);
if (litPanes || lamps || depotPanes) {
  rainLightsOn = () => {
    if (cityEntry.running()) return;
    for (const mesh of [litPanes, lamps?.pools, depotPanes]) if (mesh) mesh.visible = true;
    rainLightsOn = null;
  };
}
// The whole crash detonation — shockwave, fireball and shards — behind one `fire()` per car. One
// pool serves both cars: nothing here is re-shot from a stored position, so a second call cannot
// drag the first car's wreckage across to the second the way the old debris pools could.
const blast = createBlast(scene, makeRng(runSeed + 88));
blast.setStyle(getWreckStyle());
const flames = createFlames(scene, makeRng(runSeed + 133));
// Sparks off the underside of the car as it lands a jump — see game/sparks.js and `landedHard`
// below. Run seed, like the flames: which way a shower scatters is part of the situation, and a
// stunt landing is not something a screenshot is ever staged on.
const sparks = createSparks(scene, makeRng(runSeed + 134));
// The depot at work during a repair visit: arc light, sparks and grit out from under a door left a
// fifth open. Off the same two pools as everything else — see game/repairfx.js. Not in shot mode,
// which never builds the vignette that drives it.
const repairFx = garage && !shot
  ? createRepairFx({ scene, site: garage.site, sparks, dust, rng: makeRng(runSeed + 135) })
  : null;
// A glint off the front-right fender as the taxi rolls out of the garage, at the top of a run and
// after every repair — see game/glint.js. `?glint=classic` leaves the car plain.
const glint = garage && !shot && new URLSearchParams(window.location.search).get('glint') !== 'classic'
  ? createGlint({ scene, taxiGroup: traffic.taxiGroup })
  : null;
// The red and blue a cop car throws on the road during a robbery — the half of a siren that the
// bar on the roof cannot do. Two point lights, parked on the nearest cop cars each frame; off
// under `?safe`, where the bars keep flashing on their own. See game/coplights.js.
const copLights = createCopLights(scene, { enabled: !budget.safe });
// Banknotes off the back of a boosting getaway — the one part of the robbery that pays the player
// back while the risk is being taken rather than at the drop-off. See game/cashtrail.js.
const cashTrail = createCashTrail(scene, makeRng(runSeed + 211));
// The bank job's cut — see `robberyIntro` above and game/bankjob.js. Null under `?robbery=classic`,
// and on a city with no robbery.
const bankJob = robbery && robberyIntro
  ? createBankJob({
    scene,
    site: city.bank,
    cashTrail,
    controller,
    setDoor: traffic.setTaxiDoor,
    play: (name, x = null, z = null) => sfx?.play(name, x === null ? {} : { at: placeAt(x, z) }),
    scenery: !bankFare,
    skippable: new URLSearchParams(window.location.search).get('robberyskip') === 'classic',
    classicFraming: classicRobberyCam,
  })
  : null;
if (bankJob && bankFare) {
  fares.setBankStop({
    junction: robbery.junction,
    x: bankJob.home.x,
    z: bankJob.home.z,
    away: bankJob.along,
    swapReady: () => robbery.swapReady(),
    // Collected level with the steps, routed down the bank's own street (BANK_REACH_ALONG in
    // game/fares.js). `?bankpickup=classic`: the junction's ARRIVE_RADIUS, from any side.
    tight: new URLSearchParams(window.location.search).get('bankpickup') !== 'classic',
  });
}
// The other half of the tailpipe: `flames` is the bark on the press, this is the plume that burns
// for as long as the button is held. No seed — the flicker is a flipbook on a clock, and a flame
// that came out differently on two runs of the same seed would take the screenshots with it.
const locoFlame = createLocoFlame(scene);
// The street racer's Loco Mode (Tyler: "racer should use loco, show flames out tailpipe"). Its pace is
// its own (`RIVAL_CHASE`, a lifted cruise ceiling), so what it shows is when it is spending it: lit
// above RACER_FLAME_SPEED, out as it brakes for a corner, the way the player's thumb goes on and off
// the pill. Off an ordinary car body, so the pipe is at the back of CAR_LEN rather than the taxi's.
const racerFlame = createLocoFlame(scene, { back: CAR_LEN / 2 + 0.05 });
// 1.5× ordinary cruise (8.5): well clear of anything traffic does, and reached a second or so off
// every corner on the racer's 21.7 ceiling.
const RACER_FLAME_SPEED = 12.75;
const NO_CAR = { x: 0, z: 0, yaw: 0, crashed: true };
// Where the two wrecked cars end up: crumpled, scorched and **left on the road** rather than faded
// out from under their own fireballs. See game/wreckage.js for why the fade went — the short of it
// is that a crash has to answer "what did I just hit" for as long as the shot is held, and the
// half-second of flame it used to be answered by is long gone by the time the retry card arrives.
//
// The smoulder goes through the same dust pool the boost trail and the barricade share, off the
// wreck's own heading so it trails behind it. `traffic.taxi.yaw` is frozen from the impact frame
// on — a crashed car is skipped by every loop in traffic.js — so this reads the crash's heading
// however long the wisps go on for.
const wreckage = createWreckage({
  smoke: (x, y, z) => dust.add(x, z, traffic.taxi.yaw, 0.5, 0.45, PALETTE.wreckSmoke, y),
});

// The driver, thrown through the windscreen by a hard enough wreck — see game/ejection.js and
// EJECT_CLOSING. Each time they hit the road: a small grey puff, and the taxi's own landing thud
// turned down (there is no recording of a person landing; the jump's is the softest impact in the
// set).
const ejection = createEjection(scene, {
  roadY: ROAD_Y,
  onLand: (x, z, hard) => {
    dust.burst(x, z, traffic.taxi.yaw, 4 + Math.round(hard * 6), 0.35 + hard * 0.3,
      { tint: PALETTE.wreckSmoke, linger: 0.6 });
    sfx?.play('land', { gain: 0.25 + hard * 0.45 });
  },
});
// And the windscreen they went through: a spray of glass along the throw, left glinting on the
// road. See game/windshield.js.
const windshield = createWindshield(scene, { rng: makeRng(runSeed + 919), roadY: ROAD_Y });
// And the car the taxi hit loses its glass too, on every wreck rather than only an ejection: it is
// the one that took the blow. Blown out along the taxi's heading, the way its shell slides, with no
// flash — one burst of light per crash is the taxi's.
const struckGlass = createWindshield(scene, { rng: makeRng(runSeed + 921), roadY: ROAD_Y, withFlash: false });

// The crash replay's recording and its director — see game/replay.js, and REPLAY_LEAD for how the
// two endings fit together. The boats' wake is left off the tape because the boats are: the world
// is frozen for the replay, and a wake playing back behind a boat standing still is a wake coming
// off nothing.
const tape = shot ? null : createTape(scene, {
  // The taxi's group and every group a car has worn in place of its instance — the cruisers, the
  // racer, the fire engine — kept by traffic as they are dressed (`wearSkin`). Live, so a skin
  // added later is taped from its first frame; a hand-kept list here is how the racer came to pop
  // in with its own fireball.
  roots: traffic.drawnRoots,
  exclude: (mesh) => mesh.name === 'boat-wake',
});
const replayOverlay = document.getElementById('replay');
const replay = tape && createCrashReplay({
  tape, controller, aspect, wreckage, taxiGroup: traffic.taxiGroup, overlay: replayOverlay,
  // The bang again on each cut, a little under the live one: it is the same crash being shown,
  // and at full gain each cut reads as another collision.
  onImpact: () => sfx?.play('crash', { gain: 0.75 }),
  hide: [clouds.group],
  scrub: [ejection, windshield, struckGlass],
});
// A tap anywhere skips to the card, and so does any key — a replay is a reward for looking, and a
// player who wants the retry button should not have to sit through it to get there.
function skipReplay(event) {
  if (!replay?.active()) return;
  event?.preventDefault();
  replay.skip();
  crashBannerAt = performance.now() + REPLAY_TAIL;
}
replayOverlay?.addEventListener('pointerdown', skipReplay);
replayOverlay?.addEventListener('touchstart', (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
window.addEventListener('keydown', (e) => { if (replay?.active()) skipReplay(e); });

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

// The getaway's police helicopter — see game/policeheli.js. In once the taxi has made its first
// checkpoint, its searchlight on the cab for the rest of the run to the drop-off; then over the
// robber on the corner through the arrest, after the car that takes them away for a few seconds,
// and home. Cinematic only: nothing in the robbery or the patrol reads it. Null with no robbery.
const HELI_FROM_CHECKPOINT = 1;
const HELI_TAIL_SECONDS = 6;
const policeHeli = robbery
  ? createPoliceHeli(scene, makeRng(runSeed + 457), {
    groundY: (x, z) => deckHeightAt(x, z).y,
    // The first searchlight, before it was softened — see LOOKS in game/policeheli.js.
    classic: new URLSearchParams(window.location.search).get('helispot') === 'classic',
  })
  : null;
// The car the robber was put in, once the arrest has handed it back to traffic: `{ car, left }`.
let heliTail = null;

/** What the helicopter is watching this frame, or null to send it home. See `update` there. */
function heliTarget(dt) {
  if (!robbery || fares.state.gameOver) return null;
  if (robbery.state.active) {
    if (!robbery.state.alarmed) return null;
    const f = fares.state.fares.find((r) => r.robber && r.stage === 'riding');
    if (!f || f.checkpointsTotal - f.checkpoints.length < Math.min(HELI_FROM_CHECKPOINT, f.checkpointsTotal)) {
      return null;
    }
    const t = traffic.taxi;
    return { x: t.x, z: t.z, yaw: t.yaw, moving: t.v > 1 };
  }
  const { arrest } = robbery;
  if (arrest.active()) {
    const figure = arrest.figure();
    if (figure) return figure;
    const car = arrest.boarder();
    if (car) heliTail = { car, left: HELI_TAIL_SECONDS };
    else if (!heliTail) {
      // The robber is still climbing out on the scene's first frames: hold over the corner rather
      // than turning for home and straight back.
      const J = arrest.state.phase === 'converge' ? arrest.junction() : null;
      return J ? { x: lineX(J.i), z: lineZ(J.j) } : null;
    }
  }
  if (!heliTail) return null;
  const { car } = heliTail;
  heliTail.left -= dt;
  if (heliTail.left <= 0 || car.crashed || !traffic.policeCars.includes(car)) {
    heliTail = null;
    return null;
  }
  return { x: car.x, z: car.z, yaw: car.yaw, moving: car.v > 1 };
}

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
//
// The pond is the one thing on a lawn a walking bird cannot be allowed to cross, so both flocks are
// handed it as a keep-out. A little wider than the water itself: the outline never exceeds the
// pond's nominal radius, and the rest is a bird's own length, so one stops *beside* the water
// rather than with its tail over it.
//
// And a few flat roofs they can land on as well — see `chooseRoosts`. City seed, not run seed:
// which roofs the pigeons use is part of the map, the same way which lawns there are is. Shared by
// both flocks as the *same objects*, because `avoid` keeps them apart by identity.
const roosts = chooseRoosts(city.decks, makeRng(seed + 155));
const flocks = [];
for (const offset of [199, 211]) {
  flocks.push(createBirds(scene, makeRng(runSeed + offset), layout, {
    avoid: (state) => flocks.filter((f) => f.state !== state).map((f) => f.state.area),
    keepOut: [
      ...(props.pond ? [{ x: props.pond.x, z: props.pond.z, r: props.pond.r + 0.7 }] : []),
      // And the basketball court, with the same bird's length to spare.
      ...(props.court ? [courtRect(props.court, 0.5)] : []),
      ...(props.skatepark ? [skateRect(props.skatepark, 0.5)] : []),
    ],
    roosts,
  }));
}

// And the birds that are already on it. Their own life, and a much smaller one than a flock's: they
// paddle about, sit, dabble, and never leave. Run seed like the flocks — which park has the water
// in it is the map, and what the birds on it are doing is the situation. See game/ducks.js.
const ducks = createDucks(scene, makeRng(runSeed + 299), props.pond);
// Leaves the squall strips off the park trees (game/leaves.js). Park crowns only — a median tree
// shedding onto a carriageway is litter rather than autumn, and a courtyard's falls where no one
// sees it. Run seed: which leaf comes off when is the situation, not the map.
const leafPlots = parkPlots(layout).map((p) => p.bounds);
const leaves = fall && squall ? createLeaves(scene, makeRng(runSeed + 337), props.crowns.filter((c) =>
  leafPlots.some(({ x0, z0, x1, z1 }) => c.tx >= x0 && c.tx <= x1 && c.tz >= z0 && c.tz <= z1)), leafPlots, squall)
  : null;

// The one span that lifts, and the only thing in this game that changes the road network mid-run.
// See game/drawbridge.js. `null` on a city with no river, which the chain below handles rather than
// guards against — the same contract the depot and the burger joint keep.
//
// **City seed, not run seed**, unlike the roadworks below it: which span lifts is a fact about the
// map, decided by `planRiver` alongside the rest of the layout, and the map has to stay learnable.
// What runs on the run seed is *when* it lifts, which is the boat's business (game/boats.js).
//
// `replan` is the callback shape `pathdrag` uses for the same reason: main.js owns `routeTo`, and
// a module that reached in to assign `car.route` itself would skip everything else that function
// does to a route already part-driven.
// Split down the middle, and the leaves on their way up are a ramp the taxi can jump: Mega Air (see
// `gate` in game/drawbridge.js). `?bridgejump=classic` is the one long leaf and the old re-route.
const bridgeJump = new URLSearchParams(window.location.search).get('bridgejump') !== 'classic';
const drawbridge = createDrawbridge(scene, makeRng(seed + 66), {
  wet: rain.wetGround,
  stunt: bridgeJump,
  // The leaf coming home is the one moment in the cycle with an impact in it, and it was landing in
  // silence. A puff at each abutment, out of the same pool the roadworks smash and the boosting
  // taxi both throw — a bridge dropping a hundred tonnes onto a stone seat kicks up what a car
  // scrubbing its tyres does, and it is the same dust either way.
  //
  // Smaller and shorter than a barricade smash (which runs `power` well over 1): this is a heavy
  // thing settling, not something exploding. Aimed along the span so the two collars spread down
  // the road rather than out over the water.
  onLand: (feet) => {
    for (const foot of feet) dust.burst(foot.x, foot.z, Math.PI / 2, 14, 0.7, { linger: 1.3 });
  },
  replan: () => {
    // Unconditional, and it does not need to ask whether the old route used the span. By the time
    // this fires the two lanes are already in `setBlockedLanes`, so `findRoute` cannot return them
    // — a route that never went near the river re-plans to itself, and one that crossed comes back
    // going round. Passing the **same target object** is what keeps that free: the band's rollout
    // sweep keys off `pendingTarget`'s identity, so an unchanged route does not restart the draw.
    const car = traffic.taxi;
    if (car.pendingTarget) routeTo(car.pendingTarget);
  },
});
if (drawbridge) bindRiverDrawbridge(() => drawbridge.state.lift);
setBridgeStunt(drawbridge?.stunt ?? null);

// Traffic on the river, and the thing that asks the span to lift — see game/boats.js. Run seed,
// unlike the bridge itself: a barge every twenty seconds or so and a tug every minute and a half
// is the situation, not the map. Null wherever the drawbridge is null, and for the same reason.
const boats = createBoats(scene, makeRng(runSeed + 401), drawbridge);
// The container ships that come in to the harbor's berth and go back out to sea
// (game/harborships.js). Run seed: when one arrives is the situation.
const harborShips = createHarborShips(scene, makeRng(runSeed + 431), harbor?.berth);

// A street closed for roadworks, once per run, forty seconds or so in — see game/roadwork.js.
// Ambient traffic routes around it and the taxi has never heard of it, so the closed street is the
// emptiest road in the city with a ramp at each end. Run seed, like the flyover: which street and
// when is part of the situation rather than part of the map.
const roadwork = createRoadwork(makeRng(runSeed + 177), scene, camera);
// Stuntman (Tyler, 2026-10-14): smashing through a barricade is a combo, and pays Loco back the way
// a drift's first kick does. Any smash counts, at any speed — the taxi only gets there by being
// routed down a street the city has closed, which is the choice; the hop off the trestle is what
// it earns. `?stuntman=classic` keeps the smash as scenery and nothing else.
const stuntman = new URLSearchParams(window.location.search).get('stuntman') !== 'classic';
const STUNTMAN_FUEL = DRIFT_CHAIN.fuel[0];
// Big Air pays a sixth of the tank back on touchdown, the stuntman's refund (Tyler, 2026-10-23: "it
// also requires you to boost a lot to get around a corner and make a jump"). Once per landing:
// Crushin' It is the end of the same Big Air, so a car underneath adds its combo step and no more
// fuel. `?bigairfuel=classic` lands with nothing.
const bigAirFuel = new URLSearchParams(window.location.search).get('bigairfuel') !== 'classic';
const BIG_AIR_FUEL = DRIFT_CHAIN.fuel[0];
roadwork.onSmash(({ x, z }) => {
  if (stuntman && !fares.state.gameOver) {
    flyEnergyToBoost({
      from: taxiScreenPos,
      to: fuelScreenPos,
      delay: 0,
      onArrive: () => boost.topUp(STUNTMAN_FUEL),
    });
    haptic('drift-kick');
    landCombo('stuntman');
  }
  // Just under half the wreck's 2.4. It was 0.55, which is the shake a *kerb* would earn — this is
  // a trestle exploding across the windscreen, and the camera has to admit that something happened.
  // Still short of the wreck, because the wreck ends the run and this does not.
  controller.kickShake(1.1);
  // The crash, turned down and pitched up: a trestle going, not a car.
  sfx?.play('crash', { gain: 0.5, rate: 1.25 });
  // A proper burst. Two ordinary puffs was what a boosting taxi lays down in two frames, so the
  // impact read as exhaust rather than as hitting something. See `dust.burst`.
  dust.burst(x, z, traffic.taxi.yaw);
});
// A post box or a hot dog cart knocked off the kerb (game/streetprops.js). Half a step on the meter,
// on top of the overtake that carried the taxi into it: it is a lucky line through a pass rather
// than a move of its own. The shake and the crash are the barricade's, turned down further —
// a box of letters, not a trestle.
streetProps.onSmash(({ kind }) => {
  if (!fares.state.gameOver) landCombo(kind === 'cart' ? 'hotdog' : 'mailbox');
  haptic('drift-kick');
  controller.kickShake(0.7);
  sfx?.play('crash', { gain: 0.35, rate: kind === 'cart' ? 1.35 : 1.6 });
});
// Touchdown, off whichever ramp — the roadworks barricade or the crest of an arched bridge under
// Loco Mode. One handler for both, because it is one event: `traffic.onTaxiLand` fires on the frame
// the arc ends and hands over where it landed, how fast, and how high the surface under it is.
//
// Three things come out of it, and they are stacked in order of what they say. The **shake** says
// the car hit something; the **dust** says it was heavy; the **sparks** say it was hard enough to
// drag metal along the road, which is the half that was missing while the only ramp in the game was
// one a taxi could crawl over at walking pace.
//
// Everything scales on `hit`, which is 0 at cruise and 1 at the Loco top — a barricade can be
// taken at any speed and a bridge only ever at overdrive, so the same landing has to read at both.
// At 0 it is exactly what the barricade landing has always been (14 puffs at 0.7, a 0.7 shake);
// at 1 it is half again as much and still under the barricade *smash*'s 1.1, which is the beat it
// must not upstage on the one ramp where the two happen a second apart.
traffic.onTaxiLand(({ x, z, yaw, v, deck, big, kind }) => {
  // Over the drawbridge the route was bent straight on at the far bank so the flight could cross
  // it (sim/traffic.js, `stuntVerdict`). Plan the rest of the trip from where the taxi came down.
  if (kind === 'bridge' && traffic.taxi.pendingTarget) routeTo(traffic.taxi.pendingTarget);
  // `boostCruise()` rather than a constant: the Loco top is a tunable (the ⚙️ panel moves it), and
  // a landing measured against a number that has stopped being the top speed reads wrong at both
  // ends of the slider.
  const hit = Math.max(0, Math.min(1, (v - SPEED) / Math.max(1e-6, boostCruise() - SPEED)));
  // The drift launch comes down from ten units, and is allowed to be the loudest landing in the
  // game: there is no barricade smash a second before it to upstage. Shake at the wreck's end of
  // the range, a body thud under the tyres' land, and the dust thrown out in a ring the way the
  // helipad's downdraft is, which is what reads as weight arriving rather than exhaust.
  if (big) {
    if (!fares.state.gameOver) landCombo(kind === 'bridge' ? 'megaair' : 'launch');
    if (bigAirFuel && !fares.state.gameOver) {
      flyEnergyToBoost({
        from: taxiScreenPos,
        to: fuelScreenPos,
        delay: 0,
        onArrive: () => boost.topUp(BIG_AIR_FUEL),
      });
    }
    // Came down on a car on the way: Crushin' It is called after the Big Air it was the end of.
    if (crushOwed) {
      crushOwed = false;
      if (!fares.state.gameOver) landCombo('crush');
      // ...and the cars it took with it, if they have all gone up already.
      if (pileupOwed) {
        if (!fares.state.gameOver) landCombo('pileup', pileupOwed);
        pileupOwed = 0;
      }
    }
    controller.kickShake(1.6);
    sfx?.play('land', { gain: 1 });
    sfx?.play('crash', { gain: 0.35, rate: 0.7 });
    dust.burst(x, z, yaw, 30, 1.2, { y: DUST_ROAD_Y + deck, ring: 2.2, linger: 1.3 });
    // The wreck's shockwave ring, smaller and in the dust's colour rather than the wreck's yellow,
    // with none of the fire — so the slam reads as weight and never, at a glance, as the run
    // ending. Tyler's call over the drift flame's colour, which was the first cut. See `shock` in
    // game/blast.js.
    blast.shock(x, z, { y: deck, tint: PALETTE.landRing, yaw, speed: v });
  } else {
    controller.kickShake(0.7 + hit * 0.3);
    sfx?.play('land', { gain: 0.7 + hit * 0.3 });
  }
  // The same burst the smash throws, turned down rather than a smaller hand-tuned one, and lifted
  // onto the deck: a landing on the hump of a bridge that puffed at road level would leave its dust
  // hanging in the channel two units under the car.
  dust.burst(x, z, yaw, 14 + Math.round(hit * 6), 0.7 + hit * 0.25,
    { y: DUST_ROAD_Y + deck });
  // Off all four contact patches rather than the two the boost trail uses. The trail comes off the
  // driven wheels because that is where traction breaks; a landing lands on everything at once, and
  // two streaks under the back of a car reads as a wheelspin rather than as an impact — the same
  // argument the brake's four-wheel skid is made from.
  const fx = Math.cos(yaw);
  const fz = -Math.sin(yaw);
  const rx = Math.sin(yaw);
  const rz = Math.cos(yaw);
  const perWheel = big ? 12 : 4 + Math.round(hit * 2);
  for (const [along, track] of [[TAXI_FRONT_AXLE_FWD, TAXI_FRONT_TRACK],
    [-TAXI_REAR_AXLE_BACK, TAXI_REAR_TRACK]]) {
    for (const side of [-1, 1]) {
      sparks.burst(
        x + fx * along + rx * side * track,
        ROAD_Y + deck,
        z + fz * along + rz * side * track,
        yaw, perWheel, v,
      );
    }
  }
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

// A flatbed shedding its load — see game/flatbed.js. One of the city's trucks carries a stack of
// crates, and some while in it starts going over bumps and dropping them. Anything that drives
// into one smashes it; the taxi does too, for free — the crates are not in sim/collisions.js.
// Run seed like the roadworks: which truck and when is the situation. `?flatbed=soon` starts the
// shedding three seconds in, for looking at it.
const flatbed = createFlatbed(makeRng(runSeed + 523), scene, traffic, camera, {
  soon: new URLSearchParams(window.location.search).get('flatbed') === 'soon',
});
flatbed.onSmash(({ x, z, yaw, byTaxi }) => {
  if (byTaxi) {
    // Well under the barricade's 1.1: a crate is a lighter thing than a trestle, and it happens
    // eight times rather than once. Enough that the taxi feels it went through something.
    controller.kickShake(0.45);
    sfx?.play('crash', { gain: 0.3, rate: 1.6 });
    dust.burst(x, z, yaw, 12, 0.6);
  } else {
    // Ambient cars smash them too — it is that or drive through them — but quietly: the city's
    // business, not the player's.
    dust.burst(x, z, yaw, 6, 0.4);
  }
});
// A crate hitting the road kicks up a little of what it lands on.
flatbed.onLand(({ x, z }) => { dust.burst(x, z, 0, 5, 0.3); });

// Ram a box truck and its back doors burst open and some of its load pours out — more of it the
// harder the hit (game/boxspill.js). Fired from the bump and the wreck below. Scenery: no HP, no
// blocking; a car that drives into a box knocks it on down the road.
const boxSpill = createBoxSpill(makeRng(runSeed + 529), scene, traffic);
boxSpill.onLand(({ x, z, v }) => { if (v > 1.5) dust.burst(x, z, 0, 4, 0.3); });
boxSpill.onPunt(({ x, z, yaw, byTaxi }) => {
  dust.burst(x, z, yaw, byTaxi ? 6 : 3, 0.35);
  if (byTaxi) sfx?.play('bump', { gain: 0.18 });
});

// A building on fire, and the engine that comes and puts it out — see game/fire.js. The engine is a
// car in traffic (`enterGuest`): it drives to the fire, stops in its lane with the cars behind it
// queueing, and puts its ladder up. Run seed like the roadworks; held off while the taxi is in a cut
// scene or a robbery is on, so it never upstages either, and never in shot mode, where nothing
// should move under an unrelated change. `?fire=soon` starts one three seconds in.
const fire = createFire({
  rng: makeRng(runSeed + 611), scene, blocks: layout, traffic,
  blocked: () => Boolean(shot) || traffic.taxi.staged || Boolean(robbery?.state.active)
    || fares.state.gameOver,
  soon: new URLSearchParams(window.location.search).get('fire') === 'soon',
  // Not under the squall's cell, nor on its way; and rain that reaches one puts it out.
  ...(squall && { rainAt: squall.rainAt, rainSoon: squall.rainSoon }),
});
// The engine's bar blooms at the cruiser's strength; the flames bloom on their own (`flame`).
for (const mesh of fire.emissiveMeshes) markEmissive(mesh, 'siren');

// The street race: with the cab empty, a violet racer turns up and tails the
// taxi, calling out the stakes (game/race.js). Tap it and the screen cuts to the two of them side by
// side, the camera looks at the finish and comes back, and it is three, two, one; from the tap the
// board steps aside the way it does for a getaway (`setHold`). `?race=classic` has no racers in the
// city; `?race=soon` brings the first one a few seconds in.
const raceParam = new URLSearchParams(window.location.search).get('race');
// No "Ready?" to tap (Tyler cut it): the count starts as soon as the camera is back from the
// finish. `?racetap=classic` keeps it — the count waits on a tap on the racer's "Ready?".
const raceTapClassic = new URLSearchParams(window.location.search).get('racetap') === 'classic';
race = shot || raceParam === 'classic' ? null : createRace({
  rng: makeRng(runSeed + 743), scene, traffic, routeTo,
  soon: raceParam === 'soon',
  // The racer's body bounces on hydraulics in the race's scenes (game/hydraulics.js).
  hydraulics: new URLSearchParams(window.location.search).get('hydraulics') !== 'classic',
  // `?racetap=classic`: the racer asks "Ready?" once the camera is back, and the tap on it is the start.
  readyGate: raceTapClassic,
  // The finish goes down as the camera arrives on it, rather than before the pan.
  lateReveal: new URLSearchParams(window.location.search).get('racereveal') !== 'classic',
  snapCut: new URLSearchParams(window.location.search).get('racecut') !== 'classic',
  // Demo mode: the first racer turns up after the first drop-off rather than the 2nd to 4th.
  firstDue: demo.on() ? 1 : null,
  // The rocket start: Loco pressed on the count's "2" and held to the green launches on the drift's
  // tier-1 kick. `?rocketstart=classic` has no such thing.
  loco: () => boost.state.held,
  rocketStart: new URLSearchParams(window.location.search).get('rocketstart') !== 'classic',
  // ...and one held from the "3" fishtails off the line instead. `?racefishtail=classic`: a plain start.
  fishtail: new URLSearchParams(window.location.search).get('racefishtail') !== 'classic',
  // The turnaround is the ring alone, the flag only over the finish. `?raceflag=classic` flags both.
  midFlag: new URLSearchParams(window.location.search).get('raceflag') === 'classic',
  // The underglow pulses to whatever the music is doing (game/sfx.js, `bass`).
  bass: () => sfx?.bass?.() ?? 0,
  // Nothing turns up over anything that owns the run, or over a trip the taxi is already on to the
  // depot or the drive-through.
  blocked: () => traffic.taxi.staged || getaway() || patrol.busy() || fares.state.gameOver
    || fareLoopHeld() || tutorialTalking || Boolean(tutorial?.holdsCamera())
    || Boolean(burgerRun?.active() || depotRun?.active()),
  // ...but once one is on screen only something that owns the run outright takes it away. The tap
  // it waits for has to keep working through a tutorial tip or a trip to the burger joint, or the
  // racer is a car that ignores the player (Tyler: "if I tap on the purple racer, nothing happens").
  interrupted: () => traffic.taxi.staged || getaway() || patrol.busy() || fares.state.gameOver,
  // An empty cab: the tap is refused with a rider aboard.
  canStart: () => !fares.carrying(),
  // Two units inside the frame to come up, two outside to go, so a car on the edge does not flick.
  seen: (car, keep) => inShot(car.x, car.z, keep ? 2 : -2),
  delivered: () => fares.state.delivered,
  onEvent: onRaceEvent,
});
fares.setHold(() => Boolean(race?.holdsBoard()));
// The rival's speech bubble — the challenge, with the stakes on it, pinned to its roof.
const raceTalkRoot = document.getElementById('race-talk');
const raceTalk = race && raceTalkRoot ? createSpeech(raceTalkRoot, {
  viewport,
  // At the screen edge the tag rides the camera onto the car and asks — the same first tap it
  // always was, plus the pan — so the second tap, on the racer itself, takes it on.
  onEdgeTap: () => {
    if (!race?.offering() || fares.state.gameOver) return false;
    let last = race.rivalAt();
    const rival = () => { last = race?.rivalAt() ?? last; return last; };
    return lookAtTalker(rival, () => Boolean(race?.offering()), () => { if (!race.state.asked) race.ask(); });
  },
  edgeTappable: () => isNarrow(),
}) : null;
// The tag answers a tap too, and the card under it: the racer can be off screen when it offers,
// and then the tag at the edge is the only thing there is to tap. On a narrow screen an edge tag's
// press is taken by `onEdgeTap` above and never reaches this; on a wide one, where there is no pan
// to hand over, the edge tag still asks from where it is.
raceTalkRoot?.addEventListener('pointerup', (e) => {
  if (!e.target.closest('.speech-tag-pin, .speech-card')) return;
  if (race?.state.phase === 'ready') race.ready();
  else acceptRace();
});
const raceTalkAt = () => {
  const at = race?.rivalAt();
  // Just over the roof: it used to clear the flag the racer flew there, which put it 3.6 up.
  return at ? projectToScreen(at.x, 2.2, at.z) : null;
};

// The purple side-quest "!" (Tyler, 2026-10-21): the racer's offer, the garage door while the taxi
// smokes (game/depotcall.js), and the bank rider in place of the pie (game/fares.js hides it).
// `?questmark=classic` keeps the dots and the pie.
const questMarks = new URLSearchParams(window.location.search).get('questmark') !== 'classic';
const bankMarkRoot = document.getElementById('bank-mark');
const bankMark = questMarks && !shot && bankMarkRoot ? createSpeech(bankMarkRoot, { viewport }) : null;
let bankMarkFare = null;
/** The "!" over the bank rider while they wait, pointing where the pie's underside would be. */
function updateBankMark(dt) {
  if (!bankMark) return;
  const fare = fares.waitingAll().find((f) => f.bank && f.slot.marker.group.visible) ?? null;
  if (fare !== bankMarkFare) {
    bankMarkFare = fare;
    if (fare) {
      const at = fare.slot.marker.group.position;
      bankMark.showTag(() => projectToScreen(at.x, MARKER_BASE, at.z), { quest: true });
    } else bankMark.hide();
  }
  bankMark.update(dt);
  bankMarkRoot.classList.toggle('at-edge', bankMark.atEdge());
}

/**
 * Everything the player sees off the race: the bubble, the count, the money. game/race.js knows a
 * race happened; what a run's cash and a tank are for is this file's.
 */
function onRaceEvent(type, detail) {
  if (type === 'available') {
    // In reach with an empty cab: just the talker's "!" tag until the player taps it (`race.ask`) —
    // pointing in from the screen edge when the car is off it. No horn: the racer makes no sound of
    // its own anywhere in the vignette (Tyler: "remove all the horn sounds"). Without a
    // tag (`?bubbles=classic`/`dock`), a card with only the dots on it.
    if (raceTalk && !raceTalk.showTag(raceTalkAt, { quest: true })) {
      raceTalkRoot?.classList.add('is-ellipsis');
      raceTalk.show('', '…', raceTalkAt);
    }
  } else if (type === 'asked') {
    haptic('snap');
    raceTalkRoot?.classList.remove('is-ellipsis');
    raceTalk?.show('Street racer', 'Wanna {race}?', raceTalkAt);
  } else if (type === 'unavailable') {
    // Out of reach, a rider aboard, or something owning the run: gone until that changes.
    raceTalk?.hide();
  } else if (type === 'accepted') {
    fares.undirect();
    // Answered on the frame of the tap, before the cut: the racer's own word. The
    // first build only hid the bubble and started the wipe, so the first thing the player could
    // see was the next bubble half a second later (Tyler: "I tap it and then a little while later
    // I see a little chat bubble... What's the delay for?") — and on a phone browser the haptic,
    // the one thing that did land on the tap, does not exist.
    haptic('pick');
    raceTalk?.show('Street racer', "You're on!", raceTalkAt);
    // ...and then the cut to the start, once that has been heard: both cars are put side by side
    // under the black (game/race.js, `stage`). The bubble sits under the wipe, so cutting at once
    // would black it out before it had finished growing.
    setTimeout(() => {
      if (race?.state.phase !== 'cut') return;
      if (wipe) wipe.cut(() => race?.stage(), RACE_CUT_HOLD); else race.stage();
    }, RACE_CUT_DELAY);
  } else if (type === 'staged') {
    // Open on the two of them, close up — the faceoff — and hold it until the look at the finish.
    raceShot = { x: detail.x, z: detail.z };
    raceZoomHome ??= controller.state.zoom;
    controller.cutTo(detail.x, detail.z, RACE_SHOT_ZOOM, controller.state.yaw, aspect());
    raceTalk?.show('Street racer', 'Round the flag and back.', raceTalkAt);
  } else if (type === 'declined') {
    raceShot = null;
    raceTalkRoot?.classList.remove('is-ellipsis');
    raceTalk?.show('Street racer', 'Next time, then.', raceTalkAt);
    // ...and gone once it has been read, unless the offer is back up by then.
    setTimeout(() => { if (race && !race.offering() && !race.busy()) raceTalk?.hide(); }, RACE_DECLINE_MS);
  } else if (type === 'lined-up') {
    raceShot = null;
    // The bubble is pinned to the rival, which the camera is about to leave behind.
    raceTalk?.hide();
    // Go and look at the finish, and come back to the taxi; the count starts when the camera is
    // home. The rider-finder chip's move (`panToRider`), with the faceoff's zoom easing back out
    // beside it. A swipe mid-pan drops the callback and the race counts in on its own clock
    // (REVEAL_MAX in game/race.js).
    releaseCameraToPlayer();
    controller.peekAt(detail.x, detail.z, () => traffic.taxi, () => {
      cameraTakenOver = false;
      race?.countIn();
    }, { onLook: () => race?.revealFinish(), hold: RACE_PEEK_HOLD });
  } else if (type === 'ready') {
    // Back from the finish, side by side: the racer's "Ready?", and the tap on it starts the count.
    haptic('snap');
    raceTalk?.show('Street racer', '{Ready}?', raceTalkAt);
  } else if (type === 'ready-nag') {
    // Not tapped: once more (READY_NAG), before it counts in on its own (READY_MAX).
    raceTalk?.show('Street racer', 'Tap me when you\'re {ready}!', raceTalkAt);
  } else if (type === 'readied') {
    haptic('pick');
    raceTalk?.hide();
  } else if (type === 'count') {
    raceTalk?.hide();
    popLabel(String(detail.n), raceCountClass, COUNT_STEP * 1000, raceCountAt);
    haptic('snap');
    // A full tank for the race, flown in on the "3" the way the getaway's is (Tyler: "fully top up
    // the player's loco meter so it's 100% so they can at least have a fighting chance"). On the
    // count rather than the tap so it is seen landing; the taxi is parked until the green, so none
    // of it can be spent on the way. `?racetank=classic` keeps the old floor at the green.
    if (raceFullTank && detail.n === COUNTDOWN) {
      flyEnergyToBoost({ from: taxiScreenPos, to: fuelScreenPos, onArrive: () => boost.topUp(1 - boost.fraction()) });
    }
  } else if (type === 'go') {
    popLabel('Go!', raceCountClass, LABEL_RISE_MS, raceCountAt);
    haptic('loco');
    // Enough in the tank to race on — full, or TANK_FLOOR under `?racetank=classic`. Poured straight
    // in rather than flown: the player's thumb is already on the pill, and anything the count's
    // flight has not landed yet is made good here.
    const floor = raceFullTank ? 1 : TANK_FLOOR;
    if (boost.fraction() < floor) boost.topUp(floor - boost.fraction());
  } else if (type === 'rocket-start') {
    // The pill went down on the "2" and stayed down: the taxi is already doing the drift's tier-1
    // kick (game/race.js, ROCKET_COUNT). Said the way a drift kick says it: the bark of fire, the
    // shake, the whoosh. No word on screen (Tyler: "No rocket start label"): the launch says it.
    const car = traffic.taxi;
    haptic('drift-kick');
    controller.kickShake(0.5);
    sfx?.locoOn();
    stampAllRubber(car);
    flames.burst(
      car.x - Math.cos(car.yaw) * TAXI_TAILPIPE_BACK,
      TAXI_TAILPIPE_HEIGHT,
      car.z + Math.sin(car.yaw) * TAXI_TAILPIPE_BACK,
      car.yaw,
    );
  } else if (type === 'fishtail') {
    // Held from the "3": the tail steps out and back before it goes (sim/traffic.js,
    // `launchFishtail`). The squeal and a patch of rubber; the flame is already burning off the hold.
    const car = traffic.taxi;
    haptic('snap');
    sfx?.play('skid');
    stampRearRubber(car);
    launchSkidT = Math.max(launchSkidT, FISHTAIL_TIME);
  } else if (type === 'rounded') {
    // Halfway: the flag has just jumped back to the start line, which is easy to miss on a phone.
    popLabel('Head back!', 'is-count', RACE_LABEL_MS);
    haptic('snap');
  } else if (type === 'home') {
    // The first one is over the line, and the screen cuts to black at once (game/race.js,
    // WINNER_HOLD; `?racecut=classic` lets it pull up first). Nothing on
    // screen says who yet: that waits for the loser to be in (Tyler's steps 1-5, `updateFinale`).
    haptic('snap');
  } else if (type === 'arrival-cut') {
    // Step 3: cut to the loser, a block out — under the black, like the start.
    if (wipe) wipe.cut(() => race?.stageArrival(), RACE_CUT_HOLD); else race?.stageArrival();
  } else if (type === 'arrival') {
    // ...and open on it, rolling in at RACE_WATCH_ZOOM, followed until it has stopped beside the
    // winner and the money has moved (`settleRaceWatch`).
    raceWatch = detail.loser;
    raceZoomHome ??= controller.state.zoom;
    cameraTakenOver = false;
    controller.cutTo(detail.loser.x, detail.loser.z, RACE_WATCH_ZOOM, controller.state.yaw, aspect());
  } else if (type === 'skid') {
    // Step 4's skid: the squeal, and rubber off the back wheels while it slides (`raceRubber`).
    raceSkid = detail.car;
    sfx?.play('skid', { at: placeAt(detail.car.x, detail.car.z) });
  } else if (type === 'decided') {
    // Step 5: pulled up beside the winner — the word. The money is RESULT_HOLD later ('won'/'lost').
    raceSkid = null;
    popLabel(detail.winner === 'taxi' ? 'You won!' : 'You lost!', 'is-count', RACE_LABEL_MS);
    haptic(detail.winner === 'taxi' ? 'pick' : 'snap');
    raceWatch ??= detail.loser;
    raceZoomHome ??= controller.state.zoom;
  } else if (type === 'won') {
    fares.credit(WIN_PAY);
    popEarning(WIN_PAY);
    haptic('pick');
    settleRaceWatch();
  } else if (type === 'lost') {
    // Through `charge`, so an empty till pays what it has (see BURGER_PRICE's note in fares.js).
    // Flown to the racer rather than up into the counter: it is the racer's money now.
    const paid = fares.charge(LOSE_COST);
    if (paid > 0) {
      const car = detail.car;
      popEarning(-paid, () => (car ? projectToScreen(car.x, 1, car.z) : null));
    }
    settleRaceWatch();
  } else if (type === 'void') {
    raceShot = null;
    raceWatch = null;
    raceSkid = null;
    popLabel('Race off');
  }
}

// The cut to the start: the skip's own beat of black (game/wipe.js). It was 250ms, to read as a
// scene change, and that read as lag instead: 160 + 250 + the fade back before anything answered
// the tap. The close-up it opens on — tighter than the wreck's 26, since
// the two cars are side by side in the middle of it. At 30 the first browser pass read as barely
// closer than play.
const RACE_CUT_HOLD = 90;
// How long "You're on!" gets before the screen goes: its ten letters type in 0.26s (speech.js).
const RACE_CUT_DELAY = 500;
// The race's words ("Head back!", "You won!") rise for twice an ordinary label's 1.4s: Tyler, "hold
// messages longer". "You won!" then sits through RESULT_HOLD (2.2s) before the money moves.
const RACE_LABEL_MS = 2800;
// Where the three, two, one stand: one fixed point, a third of the way down the screen, rather than
// over a taxi the camera is still easing back to — which moved each digit sideways from the last.
const raceFullTank = new URLSearchParams(window.location.search).get('racetank') !== 'classic';
const raceCountClassic = new URLSearchParams(window.location.search).get('racecount') === 'classic';
const raceCountClass = raceCountClassic ? 'is-count' : 'is-count is-countdown';
const raceCountAt = () => ({ x: viewport.width() / 2, y: viewport.height() * (raceCountClassic ? 0.36 : RACE_COUNT_Y) });
// The count's height on screen, as a fraction of it. Not quite the middle Tyler asked for: the
// camera is back on the taxi when it counts, so dead centre (0.5) put each 80px digit squarely over
// the two cars on the line, which on a 390x844 phone stand at ~0.47-0.51. At 0.4 the digit's
// bottom clears the roofs by ~60px and is still the middle of everything above them.
const RACE_COUNT_Y = 0.4;
// The look at the finish holds long enough to watch it go down: the ring's 0.3s grow (RING_GROW_TIME)
// and then a beat over the 0.9 an ordinary peek gives a rider.
const RACE_PEEK_HOLD = 1.4;
// How long "Next time, then." stays up: its 16 letters type in ~0.4s (speech.js), then a beat to read.
const RACE_DECLINE_MS = 1800;
const RACE_SHOT_ZOOM = 22;
// The faceoff's framing, while it holds the camera; and the zoom to walk back to after it.
let raceShot = null;
let raceZoomHome = null;
// The loser, followed home after the winner is in ('decided'), at RACE_WATCH_ZOOM.
let raceWatch = null;
const RACE_WATCH_ZOOM = 30;
// The finale's loser while it skids in to stop beside the winner — see `raceRubber`.
let raceSkid = null;
let raceSkidAt = -Infinity;
// How long the camera stays on the line once the money is up: popEarning's pop and flight
// (560 + 380ms), so the zoom back out starts as the money lands.
const RACE_MONEY_MS = 940;
let raceWatchTimer = 0;
function settleRaceWatch() {
  clearTimeout(raceWatchTimer);
  raceWatchTimer = setTimeout(() => { raceWatch = null; }, RACE_MONEY_MS);
}

/** A tap on the racer: the first one asks what it wants, the second takes it on. */
function acceptRace() {
  if (!race || fares.state.gameOver || !race.offering()) return;
  raceTalkRoot?.classList.remove('is-ellipsis');
  if (fares.carrying()) {
    raceTalk?.show('Street racer', 'Drop your fare off first.', raceTalkAt);
    return;
  }
  if (!race.state.asked) race.ask();
  else race.accept();
}

// Occluded-only outlines on the traffic nearest the taxi, faded in with Loco Mode — the one mode
// where a car hidden behind a tower is a crash rather than a surprise. See game/carghosts.js.
const carGhosts = createCarGhosts(scene, traffic);

// Collision detection between the taxi and ambient cars. Only fires while boosting — see
// src/sim/collisions.js. Every hit but the one that empties the taxi's HP is a bump (`onBump`,
// below the handler); on the last one *both* cars are wrecked: each detonates where it stands and
// each shell slides out of the blast, crumples and is left lying in the road, the camera shakes and
// pulls into a close-up, the sim drops into slow-mo, boost is released, and the fare system flips
// into game-over — but the run-end banner is held for CRASH_BANNER_DELAY (wallclock, so the delay
// is unaffected by the slow-mo).
const CRASH_BANNER_DELAY = 2600;
const WRECK_ZOOM = 26;
const SLOW_MO_MIN = 0.18;                // sim runs at this fraction of real time at impact
const SLOW_MO_DURATION = 2100;           // ms wallclock to ramp back to 1.0

// The bust runs the same cinematic on its own dial, and a shallower one: nothing hit the taxi, so
// there is no blast to stretch out, and the thing worth a look is the cop that has just pulled it
// over. It used to hold the banner for the cruiser to *drive* to the arrest (up to 4.8s); the
// arrest is now the end of a chase the player watched, so the cop is already there when it fires
// (game/patrol.js) and the banner only has to wait for the camera to come in.
const BUST_BANNER_DELAY = 2000;
const BUST_SLOW_MO_MIN = 0.42;

// The catch is a ram: the cop's nose into the taxi, played as a bump (the starburst, the bump
// recording, sparks off the seam, a dent) before the banner. Measured over the probe's staged
// catches the cop arrives at 3–12 u/s closing, median ~9, and the low end makes a starburst the
// size of a nudge — so the effects read off at least RAM_MIN_CLOSING, which is what keeps the end
// of a chase from looking softer than a bump the player shrugged off a minute earlier.
const RAM_MIN_CLOSING = 10;
const RAM_SHAKE = 1.2;
// And the taxi is knocked along the hit, on util/carry.js's drag rather than frozen where it was
// touched: `closing × RAM_SHOVE` u/s at launch, so ~1.8 units of slide at RAM_MIN_CLOSING. The
// shells' SHELL_CARRY (0.26) is the same idea one size up.
const RAM_SHOVE = 0.3;
let ramShove = null;

// And the third ending gets the same beat on its own dial again. A fare's clock running out has
// nothing happening *to the taxi* to look at — nothing hit it and nothing pulled it over — so the
// subject of the shot is the rider instead: they get out where they are, swear about it and go
// (`beginBail` in game/fares.js, the same animation a missed VIP has always had). The camera comes
// in on wherever that happens — the taxi for a rider aboard, their own kerb corner for one who gave
// up waiting — which is what `fares.state.failSpot` names.
//
// Shallower slow-mo than a wreck and a wider stop on the zoom, for the same reason in both cases:
// there is no blast to stretch out and no cruiser on its way in, so what the beat is doing is
// holding a look at a junction rather than replaying an event. At wreck depth the city around the
// marker crawls with nothing to justify it, and at wreck zoom the marker fills the frame and the
// junction it stands on — half of what makes it a place — is cropped away.
//
// **The delay is sized off that animation, in the sim's time rather than its own.** It is wallclock
// and the bail is 2.2 seconds of BAIL_SECONDS, which the slow-mo stretches: the ramp spends its
// first SLOW_MO_DURATION = 2100ms at an average scale of (0.4 + 1) / 2, so 1.47s of sim time goes by
// in it, and the remaining 0.73s runs at 1.0. 2200ms of sim is therefore ~2830ms on the clock, and
// 3000 clears it with a beat to spare. It was 2400 while the shot was a standing pin, which nothing
// but the zoom was moving — at that number the retry screen now slides over a rider still running.
const TIMEOUT_BANNER_DELAY = 3000;
const TIMEOUT_ZOOM = 30;
const TIMEOUT_SLOW_MO_MIN = 0.4;

// Where the camera holds for whichever ending the run got, and how far in it pulls. Set by all
// three: a wreck and a bust put it on the taxi, a timeout on the corner the taxi never reached.
let endSpot = null;
let endZoom = WRECK_ZOOM;
let crashBannerAt = null;
let slowMoUntil = 0;
let slowMoMin = SLOW_MO_MIN;

// The drift launch's hang (sim/traffic.js, DRIFT_LAUNCH_LEN). Twenty units at a 31 u/s kick is
// 0.65s of flight, which is over before it reads as one; slowed toward the apex it is ~1.1s on the
// clock. Keyed to how far through the arc the taxi is rather than to a wall-clock ramp like the
// wreck's, so it cannot outlive the flight, and full speed at both ends: the takeoff keeps its
// punch and the slam comes down at real time, which is the half that has to hit hard.
const LAUNCH_SLOW_MO_MIN = 0.4;
// Mega Air, off the drawbridge, hangs longer: its flight is ~25 units against twenty and it has a
// double front flip to show, so the bottom of the curve goes lower rather than the curve going longer.
const MEGA_SLOW_MO_MIN = 0.28;
const launchTimeScale = (u, min = LAUNCH_SLOW_MO_MIN) => 1 - (1 - min) * Math.sin(Math.PI * u) ** 2;

// The wreck's replay (game/replay.js): after the live beat, three quick cuts on the moment of
// impact from a recording, then the retry card. The live beat is shortened to make room for it —
// it was the whole CRASH_BANNER_DELAY and is now REPLAY_LEAD — and it has a floor that is not a
// matter of taste: the replay can only show what the tape recorded, and the tape records the
// seconds after the impact *during* this beat. Under the slow-mo ramp (SLOW_MO_MIN 0.18 rising
// over 2100ms) 1.55s of wall clock is ~0.75s of sim, against the REPLAY_POST (0.7) the longest
// shot plays out past the hit — the last cut's, lengthened by a second of wall clock; at 1.2 the
// live beat recorded 0.49 and that shot was capped at 0.45. A shot asking for more than was recorded is cut short, not broken.
//
// Not in shot mode — a still has no replay to show — and not for a bust or a timeout: nothing
// happened fast enough in either to be worth seeing twice.
const REPLAY_LEAD = 1550;
// The breath between a tap that skips the replay and the card arriving — long enough that the tap
// has let go before the card is there to take it as a tap on the tally. A replay that plays out
// has no tail: its last slow-mo frame jump cuts straight to the card. It used to hand back to the
// live wreck for 350ms first (1100ms when the driver was ejected, to watch them land), and a beat
// of real-time wreck after three slow-mo cuts read as an anticlimax rather than an ending.
const REPLAY_TAIL = 350;
let replayAt = null;
// The sim clock the tape is stamped in: the sum of every dilated `dt` the world has been stepped by.
let simClock = 0;
// Set by the impact handler so the tape takes a sample on the impact frame itself — see `record`.
let tapeImpact = false;

// The polaroid on the run-end card (game/polaroid.js), and the new card layout it comes with:
// `?gameover=classic` is the card without a print and with "Tap to continue" over the retry slot.
const gameOverClassic = new URLSearchParams(window.location.search).get('gameover') === 'classic';
// `?statcount=classic` is the quicker stat roll with the values in yellow beside their labels.
const statCountClassic = new URLSearchParams(window.location.search).get('statcount') === 'classic';
// `?playagain=classic` ends the card on the yellow Play again pill instead of "Tap to continue".
const playAgainClassic = new URLSearchParams(window.location.search).get('playagain') === 'classic';
// `?runendfit=classic` is the full-size print and gaps, with nothing held back for the foot hint.
const runEndFitClassic = new URLSearchParams(window.location.search).get('runendfit') === 'classic';
// `?musicfade=classic` fades the music as the run-end card appears, instead of letting it play
// under the stats and fading it once "Tap to continue" comes up.
const musicFadeClassic = new URLSearchParams(window.location.search).get('musicfade') === 'classic';
const snapshot = gameOverClassic ? null : createSnapshot(renderer.domElement);
// How far past the impact, in sim seconds, the replay's last cut is photographed: far enough for
// the fireball to have bloomed over both cars, not so far that the smoke has swallowed them. Every
// frame of that cut from the impact on is taken until one lands past this, because the cut can only
// run as far past the hit as the live beat recorded — a slow device records less — and the last
// frame it has is a better print than none. The live beat's last frame, taken as the replay cuts
// in, is the fallback for a replay tapped past before it gets there.
const PHOTO_AFTER = 0.14;
let replayPhotoDone = false;

// What the two shells keep of the taxi's speed as they slide out of the impact — the drift and the
// slew in game/wreckage.js, both on util/carry.js's drag.
//
// The shells are where the momentum reads hardest, because they are the only recognisable objects
// in the wreck: a fireball is an abstraction and can be forgiven for standing still, a car cannot.
//
// The two are **not** given the same numbers, and that asymmetry is the point of doing it at all:
// the taxi hit something and loses more of its speed to it, the car it hit is shoved. Give both the
// same drift and the pair travels as a rigid unit, which is a wreck being panned across rather than
// one car hitting another.
//
// SHELL_CARRY was 0.62 while the shells faded out under their own fireballs, and **the number had
// to be more than halved when they stopped doing that**, for no change in what is on screen. A
// fading shell only ever spent the first 0.34s of the drag curve, which is `carryTravel` = 0.245 of
// its 0.588 bound; a shell that stays spends all of it, so the same fraction buys 2.4× the ground.
// At the old number a boost-speed wreck slid 6.4 units to rest and shunted the car it hit ten —
// half a block, which is a car being launched down the road rather than a crash coming to a stop.
// 0.26 puts the taxi at the 2.7 units the collapsing shell used to show and the struck car at 4.2.
const SHELL_CARRY = 0.26;
const STRUCK_SHOVE = 1.25;      // the shunted car keeps this much more than the base share
const TAXI_KEEP = 0.8;          // and the taxi this much less, for having hit something

// How hard each one is slewed off its own line, in rad/s on the same decaying curve. These are
// **not** rescaled alongside the drift, and for the same reason the drift had to be: run to the end
// of the curve they now turn the taxi 20° and the car it shunted 64°, against the 8° and 27° the
// fade used to cut them off at. That is the whole difference between a car parked askew and a car
// spun out — a wreck at rest wants to be sideways across the road it stopped on.
//
// Signed away from the impact below: a car struck on its left is turned to the right, and the taxi
// the opposite way, so the two shells open apart instead of both swinging the same way.
const SHELL_SPIN = 0.6;
const STRUCK_SPIN = 1.9;

// A police car is priced like any other car (the capture model, above). Under `?capture=classic`,
// ramming one is the wreck whatever the taxi's HP (`lethalPolice` in sim/collisions.js, #466) —
// unless `?cop=classic` as well, which was the rule before that.
const collisions = createCollisions(traffic.cars, traffic.taxi, {
  lethalPolice: captureClassic && new URLSearchParams(window.location.search).get('cop') !== 'classic',
});

// Hit points. Arming `hp` is what turns every contact but the last into a bump rather than the
// wreck — see TAXI_HP in sim/collisions.js. A retry reloads the page, so this is also the refill.
traffic.taxi.hp = TAXI_HP;
const impact = createImpact(scene, camera);
// What the car wears for it — a crushed corner and a crooked sign, then a boot lid up and a bumper
// dragging sparks, then smoke, a sputtering sign and a list. Tiered off the HP bar's own steps; see
// game/taxidamage.js.
const taxiDamage = createTaxiDamage({
  damage: traffic.taxiDamage, group: traffic.taxiGroup, taxi: traffic.taxi, maxHp: TAXI_HP,
  sparks, dust, roadY: ROAD_Y,
  // The ladder before the first hit was made to show (flash, grime and steam): see the top of
  // game/taxidamage.js.
  classic: new URLSearchParams(window.location.search).get('damage') === 'classic',
  // The paint dulling toward `taxiGrime` instead of chipping to the metal (geometry/taxiscratches.js).
  tint: new URLSearchParams(window.location.search).get('taxidamage') === 'classic',
});
// ...and what the cars it hits wear: the same lids, lamps and bumper, on a pool of rigs. See
// game/cardamage.js.
const carDamageRng = makeRng(runSeed + 137);
const carDamage = createCarDamage({
  scene, traffic, sparks, roadY: ROAD_Y, rng: () => carDamageRng.next(),
});
for (const mesh of carDamage.meshes) markOccluder(mesh);
// The rear door, swung open on the kerb side while a rider hops in. See game/taxidoor.js.
const taxiDoor = createTaxiDoor({ setDoor: traffic.setTaxiDoor });

// A survivable hit: the struck car is launched or spun off its line (sim/collisions.js `bump`),
// the taxi loses most of its speed, and here is the noise — a comic starburst on the contact
// point (game/impact.js), a shake a fraction of the wreck's, sparks sprayed out along the contact
// normal and a small puff. Sized off the closing speed so a nudge and a T-bone are told apart
// without the bar.
const BUMP_SHAKE = 0.35;
const BUMP_SHAKE_PER_UNIT = 0.03;
// What the hit cost, up for a second and a half and then gone (game/hitcue.js). Off unless
// `?hitcue=chip|edge|both`.
const hitCue = shot ? null : createHitCue({
  mode: hitCueMode(new URLSearchParams(window.location.search)),
  project: projectToScreen, maxHp: TAXI_HP, lowAt: SMOKE_FRACTION, midAt: BOOT_FRACTION,
});
collisions.onBump(({ x, z, closing, nx, nz, speed, rearEnd, other, taxiStruck, damage, hp, taxi }) => {
  hitCue?.hit({ damage, hp, taxi });
  const yaw = traffic.taxi.yaw;
  // Ramming the patrol car on the pill is a bump like any other, not a bust — game/patrol.js
  // `rammed`. The collision pass runs before the patrol's, so this lands the same frame. Under the
  // capture model the cop ramming a boosting taxi is the same hit, already charged here, so the
  // patrol is told either way — or it would charge the same contact a second time as its own ram.
  if (other.police && (taxiStruck || !captureClassic)) patrol.rammed(other);
  // Every bump costs HP, and any HP lost empties the combo meter (game/combometer.js). When it was
  // showing a streak, the hand is told it has gone as the meter falls.
  if (combo.damage()) {
    comboTag.lost = true;
    haptic('perfect-lost');
  }
  controller.kickShake(BUMP_SHAKE + closing * BUMP_SHAKE_PER_UNIT);
  // The designer's bump — light hits against other cars, a recording of its own since Block 1 —
  // scaled by the same closing speed the shake is. 0.3 at a nudge, full at a T-bone at the Loco top.
  sfx?.play('bump', { gain: Math.min(1, 0.3 + closing * 0.04) });
  // At the point of contact (`cx/cz` off the deepest pair of circles in sim/collisions.js), not
  // the midpoint of the two cars' centres — on a T-bone that midpoint sits inside the struck car,
  // a unit and a half from the door the sparks should be coming off.
  impact.fire(x, z, closing);
  // Two sprays fanning out either side of the contact normal, so the sparks come off the seam
  // sideways rather than trailing behind the taxi like a landing's.
  const normalYaw = Math.atan2(-nz, nx);
  const count = 8 + Math.round(closing * 0.5);
  sparks.burst(x, ROAD_Y + 0.6, z, normalYaw + Math.PI / 2, count, speed * 0.5);
  sparks.burst(x, ROAD_Y + 0.6, z, normalYaw - Math.PI / 2, count, speed * 0.5);
  dust.burst(x, z, yaw, 8, 0.5, { tint: PALETTE.wreckSmoke, linger: 0.7 });
  taxiDamage.hit(x, z, { rearEnd });
  carDamage.hit(other, x, z, { closing });
  // Only when the taxi did the hitting: a truck that runs into the taxi has nothing to throw out.
  if (taxiStruck) boxSpill.hit(other, closing, nx, nz);
});

// Crushin' It: Big Air coming down on a car (sim/collisions.js `crush`). The car underneath is
// wrecked and the taxi is not — no HP, no speed, no knock — so it is the wreck's bang on one car
// rather than two: the same `blast.fire` and smoke collar `onImpact` throws for the struck car, so
// a rework of the wreck fire (game/blast.js) reaches this too. Its shell is not left lying in the
// road the way a run-ending wreck's is (game/wreckage.js): the run goes on, traffic would drive
// through it, and so does the taxi. It is consumed under its own fireball instead (game/vanish.js,
// which the passing lab uses for the same reason) and dropped once it has gone.
//
// Landed before the touchdown, the combo waits for it so the labels read "Big Air", then
// "Crushin' It".
//
// The splash (`CRUSH_SPLASH` in sim/collisions.js): every car near the one landed on goes up after
// it, nearest first, one pop every CRUSH_POP_GAP, so it reads as a chain running out from the
// landing rather than one bigger bang. Each pop is the crush's own bang, its shell thrown *away
// from* the car the taxi landed on and spun, and each one shakes harder than the last, up to the
// wreck's 2.4 — the run-ending crash is the one thing it must not outdo. "Pile-Up" lands after the
// last pop, a half per car (game/combometer.js). The pops run on sim time (`updateCrushShells`), so
// they hold under pause and stretch with the crash slow-mo like the rest of the debris.
setCrush(new URLSearchParams(window.location.search).get('crush'));
setCrushSplash(new URLSearchParams(window.location.search).get('crushsplash'));
const CRUSH_POP_FIRST = 0.14;  // s after the crush; a beat for its fireball to open first
const CRUSH_POP_GAP = 0.12;    // s between pops — long enough that three read as three
const CRUSH_POP_THROW = 7;     // u/s outward on the carry curve, on top of the taxi's momentum
const CRUSH_POP_SPIN = 3;      // rad/s
let crushOwed = false;
let pileupOwed = 0;
const crushVanish = createVanish();
const crushShells = [];
const crushPops = [];
// The beat it all plays in (game/crushslowmo.js). `?crushslowmo=classic` runs it at full speed.
const crushSlowMo = createCrushSlowMo({
  enabled: new URLSearchParams(window.location.search).get('crushslowmo') !== 'classic',
});
function crushBang(car, speed, yaw, { driftX, driftZ, spin = 0, shake, gain = 0.8, rate = 1 }) {
  const paint = car.police ? PALETTE.policeBody : PALETTE.carBody[car.colorIndex];
  blast.fire(car.x, car.z, paint, yaw, speed * STRUCK_SHOVE);
  if (blast.wantsCollar()) dust.wreckSmoke(car.x, car.z, yaw, speed);
  struckGlass.fire({ x: car.x, z: car.z, yaw, scale: 0.6, ahead: 0, drop: 0.15 });
  // A box truck in the blast throws out its load like a wrecked one does.
  if (car.isTruck) boxSpill.wreck(car, speed);
  controller.kickShake(shake);
  sfx?.play('crash', { gain, rate });
  haptic('perfect');
  const shell = traffic.wreckShell(car);
  crushShells.push(shell);
  crushVanish.take(shell, { driftX, driftZ, spin });
}
collisions.onCrush(({ speed, other, airborne, splash }) => {
  if (airborne) crushOwed = true;
  else if (!fares.state.gameOver) landCombo('crush');
  crushSlowMo.start(performance.now());
  const yaw = traffic.taxi.yaw;
  const carry = carrySpeed(speed);
  const fx = Math.cos(yaw) * carry * SHELL_CARRY * STRUCK_SHOVE;
  const fz = -Math.sin(yaw) * carry * SHELL_CARRY * STRUCK_SHOVE;
  crushBang(other, speed, yaw, { driftX: fx, driftZ: fz, shake: splash.length ? 2 : 1.8 });
  splash.forEach(({ car, dist }, k) => {
    // Straight out from the car underneath, plus half the taxi's own carry: the blast throws them
    // clear, and the chain still leans the way the taxi was going.
    const ux = dist > 1e-3 ? (car.x - other.x) / dist : Math.cos(yaw);
    const uz = dist > 1e-3 ? (car.z - other.z) / dist : -Math.sin(yaw);
    const side = Math.sign(Math.cos(yaw) * uz + Math.sin(yaw) * ux) || 1;
    crushPops.push({
      car,
      at: CRUSH_POP_FIRST + k * CRUSH_POP_GAP,
      last: k === splash.length - 1,
      count: splash.length,
      speed,
      yaw,
      opts: {
        driftX: ux * CRUSH_POP_THROW + fx * 0.5,
        driftZ: uz * CRUSH_POP_THROW + fz * 0.5,
        spin: side * CRUSH_POP_SPIN,
        shake: Math.min(2.4, 2.1 + 0.15 * k),
        gain: 0.7,
        // Each one a touch lower than the last, so the chain sounds like it is getting bigger.
        rate: Math.max(0.75, 1.05 - 0.08 * k),
      },
    });
  });
});
function landPileup(count) {
  if (crushOwed) { pileupOwed = count; return; }
  if (!fares.state.gameOver) landCombo('pileup', count);
}
function updateCrushShells(dt) {
  for (let k = crushPops.length - 1; k >= 0; k--) {
    const pop = crushPops[k];
    pop.at -= dt;
    if (pop.at > 0) continue;
    crushPops.splice(k, 1);
    crushBang(pop.car, pop.speed, pop.yaw, pop.opts);
    if (pop.last) landPileup(pop.count);
  }
  if (!crushShells.length) return;
  crushVanish.update(dt);
  for (let k = crushShells.length - 1; k >= 0; k--) {
    const shell = crushShells[k];
    if (shell.visible) continue;
    scene.remove(shell);
    shell.traverse((node) => node.material?.dispose?.());
    crushShells.splice(k, 1);
  }
}

collisions.onImpact(({ x, z, speed, closing, other }) => {
  // A wrecked box truck throws out whatever was still aboard.
  boxSpill.wreck(other, closing);
  // One detonation per car — a shockwave ring on the tarmac, a fireball and a scatter of shards,
  // all of it inside game/blast.js. It used to be four effects stacked at each point plus a third
  // wave on a setTimeout, tuned as a simulation; the beat reads better as one graphic bang per
  // car, and the two of them a couple of units apart already give it the spread the follow-up
  // flare was there to fake.
  // The taxi's heading goes with it, and both cars get the taxi's: it is what throws the wreckage
  // downfield, and it is what the tyres roll away along. So does the speed it arrived at, which is
  // what carries the whole burst along that heading instead of detonating it on the spot — a wreck
  // that blooms out of a stationary origin reads as a car stopping and *then* exploding. See
  // `blast.fire` and util/carry.js.
  const yaw = traffic.taxi.yaw;
  blast.fire(x, z, PALETTE.taxiBody, yaw, speed);
  controller.kickShake(2.4);
  sfx?.play('crash');
  sfx?.locoOff();

  // The car that was hit detonates at its own centre rather than at the shared impact point. The
  // two are only a couple of units apart, but that is enough to spread the blast across both
  // bodies instead of stacking it on the seam between them — and its shards fly in its own paint,
  // so what comes apart is visibly two cars.
  //
  // It used to spin out, snap back onto a lane and drive away. A boosting taxi arrives at ~19 u/s
  // and the survivor shrugging that off made the player's own wreck look like a rule rather than
  // a crash.
  // In the paint it was actually wearing: a cop is an ordinary car under `policeBody`, and its own
  // `colorIndex` draw is whatever hatchback it would otherwise have been.
  const struckPaint = other.police ? PALETTE.policeBody : PALETTE.carBody[other.colorIndex];
  blast.fire(other.x, other.z, struckPaint, yaw, speed * STRUCK_SHOVE);

  // And a collar of smoke around the pair — the same lit, faceted puffs a barricade throws, tinted
  // grey and opened out into a ring (see `dust.wreckSmoke`). The fireball is unlit flat colour, so
  // on its own it is a bright silhouette that appears and is gone; the dust is Lambert and picks up
  // the sun, which is exactly the contrast that makes the fire read as the hot middle of something
  // bigger. One call for both cars, at the point between them: two collars would have packed grey
  // into the seam where the two fireballs meet, which is the middle of the blast.
  // Not under the default `burn` style, whose own smoke column does this job — see `wantsCollar`.
  if (blast.wantsCollar()) dust.wreckSmoke((x + other.x) / 2, (z + other.z) / 2, yaw, speed);

  // And both cars are left lying there. `wreckShell` takes each one off the road for good and hands
  // its bodywork over as a standalone group; game/wreckage.js slides it out of the impact, crumples
  // it, scorches it and never touches it again. It used to shrink and fade into the fireball
  // instead (game/vanish.js, which the passing lab still uses) — the note at the top of
  // wreckage.js is why that stopped: the run-end hold is 2.6 seconds and the fire is out after
  // one, so the question a crash exists to answer had nothing left on screen to answer it.
  //
  // They slide while still *moving*, along the taxi's heading and at their own share of its
  // speed — saturated here, because these two calls are the only place the speed is done
  // arithmetic with by hand; `blast.fire` and `dust.wreckSmoke` both clamp what they are handed.
  const carry = carrySpeed(speed);
  const fx = Math.cos(yaw);
  const fz = -Math.sin(yaw);

  // Which way each shell is slewed comes off which side of the taxi's line the car it hit was
  // sitting on: the cross product of the heading with the offset between the two centres. A car
  // clipped on its left is turned to the right and the taxi recoils the other way, so the pair
  // opens apart — a glance rather than two objects deleted in formation. Cars meeting dead centre
  // give a cross near zero, and `|| 1` picks a side rather than leaving both shells unturned.
  const struckSide = Math.sign(fx * (other.z - traffic.taxi.z) - fz * (other.x - traffic.taxi.x)) || 1;
  // The last hit's chips, before the wreck takes the shell's colours to scorch from.
  taxiDamage.scuff(x, z);
  const taxiShell = traffic.wreckShell(traffic.taxi);
  wreckage.take(taxiShell, {
    driftX: fx * carry * SHELL_CARRY * TAXI_KEEP,
    driftZ: fz * carry * SHELL_CARRY * TAXI_KEEP,
    spin: -struckSide * SHELL_SPIN,
    // The settle leans the same way the slew turns it, so the two wrecks tip apart as well as
    // opening apart — the pair reads as one impact from either side of it.
    lean: -struckSide,
  });
  // A hard enough hit throws the driver out through the windscreen, away from the struck car's
  // side so they do not land in its fireball. Off the closing speed rather than the taxi's own, so
  // a T-bone or a head-on does it and rear-ending traffic going the same way does not.
  if (closing >= EJECT_CLOSING) {
    ejection.fire({ x: traffic.taxi.x, z: traffic.taxi.z, yaw, closing, side: struckSide });
    windshield.fire({ x: traffic.taxi.x, z: traffic.taxi.z, yaw, scale: ejection.throwScale() });
    traffic.taxiDamage.breakScreen();
  }
  // Its glass, out of the side the taxi came into: from its own centre (so `ahead` 0), a little
  // lower than the taxi's screen because an ambient car is not scaled up, and carried shorter —
  // shoved rather than thrown. Shards that reach a pavement stay there; nothing walks this track
  // the way ejection.js walks the driver's, because a 0.3-unit plate on a kerb reads as glass.
  struckGlass.fire({ x: other.x, z: other.z, yaw, scale: 0.6, ahead: 0, drop: 0.15 });
  const struckShell = traffic.wreckShell(other);
  wreckage.take(struckShell, {
    // A copy made on this frame: before it, the car was an instance the replay draws instead.
    hideBefore: true,
    driftX: fx * carry * SHELL_CARRY * STRUCK_SHOVE,
    driftZ: fz * carry * SHELL_CARRY * STRUCK_SHOVE,
    spin: struckSide * STRUCK_SPIN,
    lean: struckSide,
    // A truck is 5.6 long against a car's 3.4, which is 6cm more sagitta under the settle pitch —
    // enough to bury a wheel. See the `lift` in game/wreckage.js.
    ...(other.isTruck ? { len: TRUCK_LEN, width: TRUCK_W } : {}),
  });
  // And both keep burning through the hold — flames on the shells, a smoke column, the firelight
  // on the road (`blast.burn`; a no-op under the older `?wreck=` styles). Off the shells rather than
  // the impact point because the shells slide, and fire left behind on the tarmac reads as a spill.
  blast.burn(taxiShell);
  blast.burn(struckShell, { scale: 0.85 });

  // Framed on the middle of the whole picture when the driver was thrown: the throw runs ~16 units,
  // past the edge of a portrait phone at wreck zoom if the shot stays on the wreck. Halfway puts
  // the wreck and the landing each ~8 from the centre.
  const landing = ejection.active() ? ejection.landing() : null;
  endSpot = landing ? { x: (x + landing.x) / 2, z: (z + landing.z) / 2 } : { x, z };
  endZoom = WRECK_ZOOM;
  if (replay) {
    replay.arm({ t0: simClock, x, z, yaw });
    tapeImpact = true;
    replayAt = performance.now() + REPLAY_LEAD;
    // Held until the replay hands back, which sets it — see the replay block in `frame()`.
    crashBannerAt = Infinity;
  } else {
    crashBannerAt = performance.now() + CRASH_BANNER_DELAY;
  }
  slowMoUntil = performance.now() + SLOW_MO_DURATION;
  slowMoMin = SLOW_MO_MIN;
  boost.release();
  fares.crash();
});

/**
 * The patrol car has caught you — reuses the wreck cinematic (zoom, slow-mo, delayed banner) so the
 * beat is the same as a collision. The catch is a ram, played as a bump (`ram`, from game/patrol.js:
 * starburst, bump sound, sparks, a dent, the taxi knocked along the hit) rather than the wreck's
 * blast — the taxi survives it and stays in shot. It used to be a bare touch and a freeze, which
 * read as the cop nudging your bumper. The taxi is flagged crashed so it drops out of the sim for
 * the pull-in, and the fare system's title/reason drive the "Busted!" banner.
 *
 * Called by game/patrol.js, the moment a chasing cop touches the taxi (TOUCH_SLACK). It used to
 * fire the moment the taxi boosted within a block of the cruiser, and then send the cruiser after a
 * taxi that was already frozen; the chase is now the part the player gets to play.
 */
function bustByPolice(ram) {
  if (fares.state.gameOver || traffic.taxi.crashed) return;
  if (ram) {
    const closing = Math.max(RAM_MIN_CLOSING, ram.closing);
    controller.kickShake(RAM_SHAKE);
    sfx?.play('bump', { gain: 1 });
    impact.fire(ram.x, ram.z, closing);
    const normalYaw = Math.atan2(-ram.nz, ram.nx);
    const count = 8 + Math.round(closing * 0.5);
    sparks.burst(ram.x, ROAD_Y + 0.6, ram.z, normalYaw + Math.PI / 2, count, closing * 0.5);
    sparks.burst(ram.x, ROAD_Y + 0.6, ram.z, normalYaw - Math.PI / 2, count, closing * 0.5);
    dust.burst(ram.x, ram.z, traffic.taxi.yaw, 8, 0.5, { tint: PALETTE.wreckSmoke, linger: 0.7 });
    taxiDamage.hit(ram.x, ram.z);
    const v = closing * RAM_SHOVE;
    ramShove = { x: traffic.taxi.x, z: traffic.taxi.z, vx: ram.nx * v, vz: ram.nz * v, age: 0 };
  } else {
    controller.kickShake(0.9);
  }
  // Where the shove will leave it rather than where it was touched, so the pull-in lands on it.
  endSpot = ramShove
    ? { x: ramShove.x + ramShove.vx / CARRY_DRAG, z: ramShove.z + ramShove.vz / CARRY_DRAG }
    : { x: traffic.taxi.x, z: traffic.taxi.z };
  endZoom = WRECK_ZOOM;
  crashBannerAt = performance.now() + BUST_BANNER_DELAY;
  slowMoUntil = performance.now() + SLOW_MO_DURATION;
  slowMoMin = BUST_SLOW_MO_MIN;
  traffic.taxi.crashed = true;
  traffic.taxi.v = 0;
  boost.release();
  fares.crash("The fuzz caught you slippin'.", 'Busted!');
}


// Orthographic camera: the vertical world span is exactly 2 * zoom, so world-units-per-pixel
// falls straight out of the frustum height.
const boost = createBoost();
const skids = createSkidMarks(scene);
// The squall's tyre tracks: the rubber's streak machinery, repainted per stamp (`wetTyres` below).
// A bigger pool than the rubber's because it is laid on every straight, not only in a slide: two
// stamps per TRACK_STEP at the 34 u/s Loco top is ~162 a second, ~450 alive across a 2.8s life.
const wetTracks = createSkidMarks(scene, {
  tint: paletteColor('wetTrack'), max: 512, life: 2.8, alpha: 0.5, width: 0.55,
});

// Lane-width, so it is sized in world units and needs no pixel factor: it is paint on the road
// rather than an overlay drawn at a constant screen weight.
const routeLine = createRouteLine(scene);
// Out of the rain's mirror, like the lamp pools: it is paint on the road, and it sits at exactly the
// mirror's clip height (both 0.03), so whether it made the reflection came down to rounding. Measured
// headless: 3,128 mirror pixels at its own height, none 0.5mm lower. On a phone that tie flipped as
// the camera moved and the band flashed in every wet street and puddle it crossed.
rain.hideInMirror(routeLine.mesh);
// The street racer's route, from the green to the line (Tyler: "a ghost path for the racer too so
// we can see their charted path"): the same band, in the racer's violet and fainter than the
// taxi's, so the two can cross without the player losing which one is theirs.
// 0.22 against the taxi's ROUTE_OPACITY 0.38: where the two bands overlap, the taxi's still reads on top.
const RIVAL_LINE_OPACITY = 0.22;
const rivalLine = race ? createRouteLine(scene) : null;
if (rivalLine) {
  rivalLine.setColor(PALETTE.racerBody);
  rivalLine.setOpacity(RIVAL_LINE_OPACITY);
  rain.hideInMirror(rivalLine.mesh);
}

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

// `?route=classic`: the route stops dead at a waiting rider's kerb, and the taxi rolls a random
// exit through their junction like it did before the look-ahead (see `onwardFrom`).
const routeLookAhead = new URLSearchParams(window.location.search).get('route') !== 'classic';

/**
 * Where the taxi goes *after* `target`, when that is already decided: the drop-off of the waiting
 * rider `target` belongs to. Null for anything else — a drop-off, a package, the depot — because
 * the next trip after those is the player's to pick.
 *
 * Matched on identity, the same way the band's sweep and `resumeJob` match targets: a rider's
 * `target` is their pickup junction object until `beginRide` swaps it for `dropoff`.
 */
function onwardFrom(target) {
  if (!routeLookAhead) return null;
  const fare = fares.state.fares.find((f) => f.stage === 'waiting' && f.target === target);
  return fare?.dropoff ?? null;
}

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
 * `onto` names the *direction* the taxi has to be travelling when it gets there, which turns the
 * destination from a junction into a lane. The burger run and the depot run ask for one — the
 * drive-through's mouth opens off one kerbside lane and a route that arrives from any other side
 * drives past it — and `findRouteOnto` carries why the obvious `via` version does not work. A target
 * can also carry its own: the bank rider's does (`bankApproach` in game/fares.js), so every re-plan
 * of that trip — a tap, a drag, a reset — keeps coming down the bank's street without being told.
 *
 * `along` is a tapped street, `{ a, b }`, which the route has to drive down rather than merely touch
 * — see game/streettap.js. It takes `maxDetour` the way `via` does, and never comes with `onto`:
 * the street tap stands down during the two trips that need a lane (see `tapStreet`).
 *
 * The target object's *identity* is what the band's rollout sweep keys off, so a re-plan that
 * keeps the same destination must pass the same object rather than an equal one — otherwise every
 * frame of a drag replays the sweep and the band never finishes drawing itself.
 */
function routeTo(target, { via = null, along = null, maxDetour, onto = target?.onto ?? null } = {}) {
  const car = traffic.taxi;
  const plan = (from) => (along
    ? findRouteAlong(from, along, target, { maxDetour })
    : via
    // `undefined` falls through to `findRouteVia`'s own default rather than reading as "no cap".
    ? findRouteVia(from, via, target, { maxDetour, onto })
    : onto !== null
      ? findRouteOnto(from, target, onto)
      : findRoute(from, target));
  const origin = planOrigin(car);
  const route = plan(origin);
  if (!route) return false;
  // Compared on the bare plans: the onward leg is the same Dijkstra from the same junction either
  // way, and its length depends on the heading each plan arrives on, which is not what "does the
  // late turn save a leg" is asking.
  const crossing = crossingOrigin(car);
  const late = crossing && plan(crossing);
  const takeLate = late && late[0] !== car.d && late.length < route.length + 1;
  const onward = onwardFrom(target);
  car.route = carryOn(route, target, onward, origin.d);
  car.routeConsumed = false;
  // A taxi that has only just crossed the hold line going straight can still take the corner in
  // front of it (see `crossingOrigin`). Offered only when turning there saves a whole leg: the
  // late plan's first step is the crossing itself, so it is compared against `route` plus one.
  // `route` stays as the fallback — the swap is the sim's to refuse — so the band is right on
  // every frame whichever way that goes.
  car.lateTurn = takeLate ? carryOn(late, target, onward, crossing.d) : null;
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
  // Keyed on `taken`, not on the tap. A refused detour already answers itself visually — the corner
  // flinches instead of swelling (see `acknowledge`) — and a confirming buzz on top of a refusal
  // says the opposite of what the animation does.
  if (taken) haptic('pick');
  parcels?.acknowledge(parcel, taken);
}

/**
 * A tap on empty road: drive the trip down that street instead. See game/streettap.js.
 *
 * Only ever reached for a tap the picker found nothing under, so every rider, pin, package and
 * building outranks it. Gated like the band drag (`canGrab`): there has to be a trip to bend. And
 * it stands down during a burger run or a repair visit, whose destinations are lanes rather than
 * junctions — their own `reroute` carries that, and a junction-level re-plan would drop it.
 *
 * Refusals are silent, the same as a tap on the sky always was: a tap on a building, on a street
 * the plan already drives, or on one past the detour cap. The last is the one a player might wonder
 * about, and the band not moving is the answer — the same answer a drag gives at the cap.
 */
function tapStreet(ray) {
  if (!ray || !pathDrag || !canBendRoute()) return;
  if (burgerRun?.active() || depotRun?.active()) return;
  // Same for the bank rider, whose target carries its lane (see `routeTo`): `along` has no `onto`.
  if (traffic.taxi.pendingTarget?.onto != null) return;
  const point = ray.intersectPlane(GROUND_PLANE, tapPoint);
  if (!point) return;
  // A finger on a roof is a finger on the roof. The ray reaches the ground a long way up-screen of
  // where it went in, so without this a tap on a tower re-routes the taxi down a street behind it.
  if (!sightlineClear(point.x, 0.1, point.z)) return;
  const street = streetAt(point.x, point.z);
  if (!street) return;

  const car = traffic.taxi;
  if (routeDrives(planOrigin(car), car.route, street)) return;
  const before = car.route.join(',');
  if (!routeTo(car.pendingTarget, { along: street, maxDetour: STREET_TAP_MAX_DETOUR })) return;
  if (car.route.join(',') === before) return;
  // Same destination, so `pendingTarget`'s identity is unchanged and the band would snap into its
  // new shape with no rollout. Ask for it, the way the double-tap reset does.
  routeLine.replaySweep();
  pathDrag.ping(point.x, point.z);
  haptic('pick');
}
const GROUND_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const tapPoint = new THREE.Vector3();

/**
 * A tap on the burger joint. The one thing on the map that is not a job.
 *
 * It reads like every other dispatch — the taxi is re-aimed and the band redraws on the same frame —
 * and it is deliberately not gated on anything: a rider in the back does not refuse it, an empty
 * tank does not refuse it, and no clock is consulted first. What it costs is time, in front of the
 * player, on whatever clock is already running. See game/burgerrun.js.
 */
function sendForBurger() {
  if (!burgerRun || getaway() || race?.busy()) return;
  // Same rule as the fare and package taps: the buzz reports that the taxi is now going somewhere
  // else, so it is gated on the route actually being taken.
  if (burgerRun.send()) haptic('pick');
}

/**
 * A tap on the depot: in for repairs. Refused on an undamaged car — there is nothing to fix, and a
 * visit holds every clock on the board, so a free one would be a pause button with a garage on it.
 * Refused as well while the depot is busy, which covers the run's own opening, and with a rider
 * aboard — nobody hails a cab to sit in its garage, and the visit's held clocks would pause the very
 * fare that is in the back.
 */
function sendForRepairs() {
  if (!(canRepair() && depotRun.send())) return;
  haptic('pick');
  // The tip has been taken: down now, and not again on later runs.
  depotCall?.hide();
  repairUsed.set();
}

/** Whether a tap on the depot would be taken right now — `sendForRepairs`'s refusals, and the picker's. */
function canRepair() {
  if (!depotRun || !opening || opening.running() || opening.visiting()) return false;
  // Shut for a getaway — see `getaway` — and for a race the taxi is lined up for or running.
  if (getaway() || race?.busy()) return false;
  // Nor while anything else is driving the car — the drive-through, mostly. A route planned under a
  // staged taxi would be overwritten by the job that trip hands back on the way out.
  if (traffic.taxi.staged || traffic.taxi.hp >= TAXI_HP) return false;
  return !fares.carrying();
}

/**
 * The trip is over — put the taxi back on the job it was taken off. A burger run and a repair
 * visit both end here.
 *
 * The seat outranks whatever was remembered at the tap. A rider who boarded *during* the detour
 * (the fare loop resolves a pickup on proximity, and the joint's block can be a corner away from a
 * waiting one) leaves a stale `handBack` aimed at their own kerb, and the only drive that makes
 * sense with somebody in the car is the one to their drop-off.
 *
 * Everything else has to still exist. A remembered target is a plain `{ i, j }` belonging to a fare
 * or a package, and both can be delivered, missed or timed out while the taxi is sitting at a
 * window — so it is matched by *identity* against the boards rather than trusted, and a target that
 * has gone leaves the taxi cruising with an empty route, exactly as a delivery does.
 */
function resumeJob(handBack) {
  const riding = fares.carrying();
  if (riding) {
    if (routeTo(riding.target)) fares.markDirected(riding, { pop: false });
    return;
  }
  if (!handBack) return;
  const live = [
    ...fares.state.fares.map((f) => f.target),
    ...(parcels?.state.parcels.map((p) => p.target) ?? []),
  ];
  if (live.includes(handBack)) routeTo(handBack);
}

// The pickables a tap during a repair visit still answers to rather than skipping it — see the top
// of the picker below.
const JOB_KINDS = new Set(['passenger', 'destination', 'parcel', 'parcel-dropoff']);

createPicker(
  camera,
  renderer.domElement,
  () => [traffic.taxiGroup, ...fares.pickables(), ...(parcels?.pickables() ?? []),
    ...(burger ? [burger.group] : []), ...(garage ? [garage.group] : []),
    ...(race?.pickables() ?? [])],
  (kind, hit, ray) => {
    if (fares.state.gameOver) return;

    // The street race: from the second tap to the green the race is on and a tap changes nothing
    // (game/race.js, `locked`); and once the racer has asked, a tap anywhere but on it (or its
    // card, which answers on its own pointerup) turns it down — "Next time, then." — and then does
    // whatever it would have done.
    // `?racetap=classic`: the start waits on a tap on the racer's "Ready?" — on its card, or the car.
    if (kind === 'racer' && race?.ready()) return;
    if (race?.locked()) return;
    if (kind !== 'racer') race?.decline();

    // **A tap skips a repair visit**, behind the opening's own cut to black — unless it lands on a
    // rider, a drop-off or a package. The board is live through a visit (only its clocks are
    // held), and a tap on a rider has to keep meaning the rider: it plans the job the car comes
    // back out to. Anything else — the sky, the depot, the taxi — is the player asking to be let
    // out of the wait. Only once the vignette owns the camera, as the opening's skip is.
    if (opening?.visiting() && opening.holdsCamera() && !JOB_KINDS.has(kind)) {
      if (wipe) wipe.cut(() => opening.skip()); else opening.skip();
      return;
    }

    // **A tap on the taxi honks it.** Playtesters coming from RTS games tap their own car first,
    // expecting to select it before giving it an order — and nothing here is ever selected, a tap
    // on a rider is the whole instruction. Making the car a real first step was considered and
    // turned down: it is a gesture that is only ever made in a player's first few seconds, and a
    // selection state built for it would be a mode everyone else has to carry. So the tap is
    // answered rather than obeyed — the horn, and the same flash a tapped rider gets — which is
    // enough to say "yes, that's yours" and leave the player looking for the next thing to tap.
    // No haptic: every buzz reports an accepted *order* (src/util/haptics.js), and this is not one.
    // Not while the opening runs: a tap there is the skip (`skipVignette`, on the press), and the
    // pointerup that follows it would otherwise honk over the cut to black.
    if (kind === 'taxi') {
      if (opening?.running()) return;
      sfx?.play('horn');
      flashTaxi();
      return;
    }

    if (kind === 'burger') {
      sendForBurger();
      return;
    }
    if (kind === 'racer') {
      acceptRace();
      return;
    }
    if (kind === 'depot') {
      sendForRepairs();
      return;
    }

    // The courier board answers a tap with a detour rather than a destination, so it is handled
    // before the fare board rather than inside it — there is no fare behind a package and nothing
    // below this line would find one.
    if (kind === 'parcel' || kind === 'parcel-dropoff') {
      divertToParcel(parcels?.parcelFor(hit.object));
      return;
    }

    // Nothing pickable under the finger: if it is on a street, that is a street tap.
    if (kind === null) {
      tapStreet(ray);
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
      // ...and *say so*. The refusal used to return here with nothing at all, which is the same
      // response as a tap on the sky — see `fares.refuse`, which shakes the rider's crystal and
      // swells the drop-off the player has to clear first. No haptic on purpose: every buzz in this
      // game reports an accepted input (src/util/haptics.js).
      fares.refuse(fare);
      return;
    }

    // Same rule as the package tap above: the buzz reports that the taxi is now going somewhere
    // else, so it is gated on the route actually being taken. The two refusals above this line —
    // a second rider while carrying, a pin with no fare behind it — return without one.
    if (routeTo(fare.target)) {
      haptic('pick');
      fares.markDirected(fare);
      if (fare.stage === 'waiting') rideHomeAfterPick();
    }
  },
  // A gesture that moved the map, or one that pulled the route round, is not also a tap on
  // whatever it happened to finish over.
  () => Boolean(pan?.didPan() || pathDrag?.didDrag()),
  // A tap on the depot's or the joint's own wall is a tap on the building, even where a rider's
  // invisible hit box stands in front of it — see the stand-in rule in game/pick.js. The depot only
  // while it would take the car: a tap it would refuse keeps meaning the rider.
  (kind) => (kind === 'depot' ? canRepair() : kind === 'burger' && Boolean(burgerRun) && !getaway()),
);

// The band is only draggable once there is one: a destination is set, the run is live, and the
// player is not looking at a paused veil or a screenshot.
pathDrag = createPathDrag({
  camera,
  domElement: renderer.domElement,
  scene,
  routeLine,
  getCar: () => traffic.taxi,
  // A burger run's destination is a *lane* rather than a junction (game/burgerrun.js), and a
  // re-plan that forgets which one drops the taxi at the right corner facing the wrong way — so
  // the module that owns the constraint owns the re-plan too. Everything else is the plain one.
  reroute: (via) => (burgerRun?.active()
    ? burgerRun.reroute(via)
    : depotRun?.active()
      ? depotRun.reroute(via)
      : routeTo(traffic.taxi.pendingTarget, { via })),
  // `pause` is declared further down and only ever read from a pointer handler, which is long
  // after this module has finished evaluating — same as `homeTip` in the tutorial's guards.
  canGrab: () => routeDragOn && canBendRoute(),
});

// **The band drag is off unless `?drag=on`.** Tyler's call (2026-10-05), to find out what the game
// is like with the street tap as the only way to bend a route (game/streettap.js). The double-tap
// reset lives in pathdrag.js too, so it goes with it: a tapped detour's only undo is tapping the
// destination pin, which re-plans it direct. Everything stays wired so the experiment is one flag to reverse.
const routeDragOn = new URLSearchParams(window.location.search).get('drag') === 'on';

/** Whether the route can be bent by hand right now — the band drag and the street tap alike. */
function canBendRoute() {
  return Boolean(
    !shot && selected && traffic.taxi.pendingTarget
    && !fares.state.gameOver && !traffic.taxi.crashed && !traffic.taxi.staged
    && !pause?.state.paused,
  );
}

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
  const c = kerbFor(fare);
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
  // Same refusal as the picker's, and it has to answer the same way: a chip and a pin are one
  // instruction wearing two hats, so one of them going quiet would make the rule look conditional.
  if (fares.carrying()) { fares.refuse(fare); return; }
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
  // Already home, by the player's own hand — an arrow's look has nothing left to come back from.
  arrowLookOut = false;
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

// The camera comes home on its own, too. A swipe hands the framing to the player, and for a long time
// nothing took it back: on a phone the city is bigger than the frame, so a look across town ended
// with the taxi lost somewhere in a busy frame or off it entirely, found again by dragging the map
// by hand. This is a fast game and a look is a glance, so once the map has been left alone for
// CAMERA_RETURN_IDLE seconds the camera rides back to the car (`panToTaxi`, flash and all), and the
// follow-cam picks it up from there. Any touch on the map restarts the count, and a finger resting
// on it holds it, so reading the map with a thumb down never gets yanked away.
// `?camreturn=classic` leaves the camera wherever the player put it.
//
// 1.5 seconds is a feel pick after playing the first guess of 3, not a measurement. It is a trade
// with the edge arrow's look-out (below), which was deliberately *not* put on a timer: a player who
// rode out to a fare and is deciding whether to take it can be reading the board, not touching it.
const CAMERA_RETURN_IDLE = 1.5;
const cameraReturns = new URLSearchParams(window.location.search).get('camreturn') !== 'classic';
let cameraIdle = 0;
let fingersOnMap = 0;
if (!shot && cameraReturns) {
  const el = renderer.domElement;
  el.addEventListener('pointerdown', () => { fingersOnMap++; cameraIdle = 0; tipLook = null; });
  const lift = () => { fingersOnMap = Math.max(0, fingersOnMap - 1); cameraIdle = 0; };
  el.addEventListener('pointerup', lift);
  el.addEventListener('pointercancel', lift);
  el.addEventListener('pointermove', () => { if (fingersOnMap > 0) cameraIdle = 0; });
  el.addEventListener('wheel', () => { cameraIdle = 0; }, { passive: true });
}
function updateCameraReturn(dt) {
  if (tipLook) {
    tipLook.left -= dt;
    if (tipLook.left <= 0 || !tipLook.stillUp()) tipLook = null;
  }
  const waiting = cameraReturns && cameraTakenOver && isNarrow() && fingersOnMap === 0 && !tipLook
    && !fares.state.gameOver && !controller.isGliding() && !endSpot
    && !title?.holding() && !opening?.holdsCamera() && !tutorial?.holdsCamera();
  if (!waiting) { cameraIdle = 0; return; }
  cameraIdle += dt;
  if (cameraIdle < CAMERA_RETURN_IDLE) return;
  cameraIdle = 0;
  panToTaxi();
}

// A tap on an off-screen fare's edge arrow (see game/farepointers.js): ride the camera to the mark
// the arrow was pointing at. The third of the three camera shortcuts, and the plainest — it is a
// pan the player would otherwise have made by dragging the map in that direction and guessing when
// to stop.
//
// It does *not* dispatch the taxi. An arrow answers "where", and answering "shall I take it" in the
// same press is what the rider-finder chips did and what the board was deliberately rebuilt without
// (see `wantsRiderChips` below). Nor does it come back on its own, unlike `panToRider`: a chip tap
// was a glance at a rider the taxi was already driving at, where this is the player asking to look
// somewhere and then act there — a camera that rode home on a timer would undo the press.
//
// It comes back on the *act* instead. The arrow leaves `arrowLookOut` set, and the pick that takes a
// rider off the board after it (see `rideHomeAfterPick`) rides the camera home to the car: the
// player went out to find a fare, found it, and the trip they just started begins at the taxi —
// which is where every one of those players then dragged the map back to by hand.
let arrowLookOut = false;
function lookAtMark(x, z) {
  // Same as a swipe, and for the same reason it is in `panToRider`: without it the opening
  // follow-cam would tow the framing back onto the taxi *during* the pan.
  releaseCameraToPlayer();
  controller.glideTo(x, z);
  arrowLookOut = true;
}

// A tap on a talker's "…" tag while it waits at the screen edge (game/speech.js, `onEdgeTap`) — the
// garage's repair tip, the street racer's offer: the same ride as an arrow's (Tyler: "tapping the
// little dot, dot, dot pinned to the edge of the screen should work just like a rider off-screen
// indicator"), onto the talker, so the thing it is about is on screen to be tapped. `at` is a point
// or a getter for one that moves (the racer), and `then` runs on the tap — the depot's line holds
// itself up for the trip, the racer asks.
//
// It holds the camera there while the tip is still up (`stillUp`), up to TIP_LOOK_MAX. The idle ride
// home (CAMERA_RETURN_IDLE) would otherwise take it back 1.5s after landing, and a player who has
// just asked to look at the garage is reading the screen with their thumb off it, about to tap —
// which is the very case the idle return cannot tell from a player who has forgotten the camera.
// A touch on the map ends the hold at once (see the listeners below `CAMERA_RETURN_IDLE`), and so
// does the tip going: tapped, timed out, or the racer gone.
const TIP_LOOK_MAX = 8;
let tipLook = null;
function lookAtTalker(at, stillUp, then = () => {}) {
  if (!isNarrow() || fares.state.gameOver) return false;
  releaseCameraToPlayer();
  if (typeof at === 'function') controller.chaseTo(at, null);
  else controller.glideTo(at.x, at.z);
  tipLook = { stillUp, left: TIP_LOOK_MAX };
  then();
  return true;
}

// The second half of an arrow's look: a rider was just dispatched to, so take the camera home.
// A peek at where the camera already *is* — a zero-length travel (see camera.js's updateGlide) —
// so it holds the same `PEEK_HOLD` beat on the rider first: the pick's feedback (the crystal
// flipping to directed, the route band drawing out of the taxi) lands on screen before the map
// moves, rather than the press appearing to have thrown the camera somewhere. Then it is the chip
// peek's ride home, and lands the same way `panToTaxi` does.
//
// Consumed by one pick, and only by a pickup: a drop-off pin is not a fare being found, and a
// refused tap (carrying already) sent the taxi nowhere, so there is no trip to go and watch.
function rideHomeAfterPick() {
  if (!arrowLookOut) return;
  arrowLookOut = false;
  if (!isNarrow()) return;
  const t = controller.state.target;
  controller.peekAt(t.x, t.z, () => traffic.taxi, () => {
    cameraTakenOver = false;
    flashTaxi();
  });
}

// The rider-finder chips, off by default — `?chips=on` brings them back to compare against.
//
// A chip was a portrait of a waiting rider with their own countdown ring and a tap that dispatched
// the taxi at them, so the whole fare loop could be played off the HUD without ever finding a pin
// on the map: the board sorted itself into a row and picking the next fare was choosing the
// reddest ring. Finding the rider *is* the game, so what says "over there, and this urgent" is now
// an edge arrow per rider (see game/farepointers.js) and nothing says "take this one".
const wantsRiderChips = new URLSearchParams(window.location.search).get('chips') === 'on';
const riderFinder = wantsRiderChips
  ? createRiderFinder({ onSelect: selectRider, sun, hemi })
  : { update: () => {} };
// The chip that answers "where did my car go" — up only while the taxi is completely off-frame.
// Off by default since 2026-10-20 (Tyler: "get rid of the taxi button"): the camera already rides
// home on its own after CAMERA_RETURN_IDLE, so the chip only ever covered that 1.5s gap.
// `?taxifinder=classic` brings it back; without it there is no chip and no extra WebGL context.
const wantsTaxiFinder = new URLSearchParams(window.location.search).get('taxifinder') === 'classic';
const taxiFinder = !wantsTaxiFinder ? null : createTaxiFinder({
  sun,
  hemi,
  project: projectToScreen,
  // The frame the renderer actually draws, not `window.inner*` — which is short of it on an
  // installed iOS app, and would report a car in that strip as off-screen when it is on it.
  frame: viewport,
  // Orthographic, so world-units-per-pixel falls straight out of the frustum height: the vertical
  // world span is exactly 2 * the drawn zoom. Read per frame, since a wreck pulls the zoom in under
  // it and Loco Mode's push-in rides on top of that — `viewZoom()` is both.
  pixelsPerUnit: () => viewport.height() / (2 * controller.viewZoom()),
  onTap: panToTaxi,
});
// The courier load, pictured in the HUD's own corner while a package is aboard — see
// game/cargochip.js. Built only when the layer is on, because it opens a WebGL context of its own
// and a run under `?parcels=0` can never have anything to put in it.
const cargoChip = parcels ? createCargoChip({ sun, hemi }) : null;
// The NES pedals (Tyler, 2026-10-15): B and A on plastic buttons with a dished centre, a shorter
// fuel arc, and the 🚨 standing over Loco Mode rather than on the cash row. `?pedals=classic` puts
// back the round pedals with their stop and lightning icons, the wider arc, and the siren beside
// the pause. Both pedal drawings ship in the markup; the body class picks one (index.html).
if (new URLSearchParams(window.location.search).get('pedals') === 'classic') {
  document.body.classList.add('pedals-classic');
  useClassicFuelArc();
  const siren = document.getElementById('chase-siren');
  if (siren) document.getElementById('hud')?.appendChild(siren);
}
// The NES buttons without their white shine (Tyler, 2026-10-20: the glint, its dot and the dish's
// lit rim; index.html `.nes-shine`), and the fuel arc 8 units further off Loco Mode.
// `?buttons=classic` puts back the shine and the arc's old gap. `?pedals=classic` predates both,
// so it takes the old gap too.
if (new URLSearchParams(window.location.search).get('buttons') === 'classic'
  || document.body.classList.contains('pedals-classic')) {
  document.body.classList.add('buttons-classic');
  useClassicFuelGap();
}
// The 🚨 over Loco Mode while the police are after the taxi; `?chasesiren=classic` goes without.
const chaseSiren = new URLSearchParams(window.location.search).get('chasesiren') !== 'classic'
  ? createChaseSiren() : null;
const farePointers = createFarePointers({
  camera,
  // Aim at the kerb corner where the mark actually stands, not the intersection centre — a
  // pointer's job is to show where the marker went off-screen, and the marker isn't at the
  // junction.
  pinLocation: cornerFor,
  // The same measurement the renderer trusts, so the arrow clamps to the edge of the frame that
  // is actually drawn — `window.inner*` is short of it on an installed iOS app.
  viewport,
  onTap: lookAtMark,
  // Narrow only, like drag-to-pan and both follow-cams: above this width the whole city is in
  // frame, so no mark is ever off it and there is no pan to hand over. Passed as the predicate
  // rather than a boolean so a resize flips it without a reload.
  tappable: isNarrow,
});

// The other half of the same problem, aimed the other way: the drop-off is somewhere the player is
// driving to, and the police car is something driving at them. See game/sirenglow.js.
const sirenGlow = createSirenGlow({ camera, viewport });
const nearestLitCruiser = () => {
  let best = police;
  let bestD = Infinity;
  for (const cruiser of cruisers) {
    if (!cruiser.state.lit) continue;
    const at = cruiser.group.position;
    const d = Math.hypot(at.x - traffic.taxi.x, at.z - traffic.taxi.z);
    if (d < bestD) { best = cruiser; bestD = d; }
  }
  return best;
};
// The robbery's version of the same light: round every edge at once while a getaway runs, since
// four cop cars on every side have no one bearing to point at. See game/robberyglow.js.
const robberyGlow = createRobberyGlow({ viewport });

// --- Opening tutorial -------------------------------------------------------

// Two bubbles and nothing else: "this car is you", then "tap that rider". See game/tutorial.js for
// why those two and no more. Off in shot mode — a screenshot has nobody to teach, and the bubble
// would be the loudest thing in every frame — and `?tutorial=off` skips it while iterating on the
// rest of the game.
//
// It runs on every new game, not just the first: the opening is short, it holds the clocks while it
// talks, and it costs nothing to sit through. Remembering it across loads was tried (a
// `localStorage` flag) and taken back out — see docs/gameplay.md.
// Debug mode skips it too — see `debugMode`. Not by writing the title screen's tips setting, which
// is the player's and would stay off after the debug session ended.
const wantsTutorial = !debugMode
  && new URLSearchParams(window.location.search).get('tutorial') !== 'off';
// The same escape hatch for the beat before it — see the opening vignette at the bottom of this
// file, and `?vignette=off` there for why it is a *settle* rather than a skip.
const wantsVignette = !devMode && new URLSearchParams(window.location.search).get('vignette') !== 'off';
// The cut to black the player's own skip happens behind — a tap during the vignette, wired at the
// bottom of this file where the vignette itself is built. Declared here because the tutorial's
// `isBlocked` below has to see it: the skip hands the run over on a frame nobody can see, and a
// bubble that started typing under the black would have spent half its line by the time the screen
// came back. Null in shot mode, which has no vignette to skip. See game/wipe.js.
const wipe = shot ? null : createWipe(document.getElementById('wipe'));
// The pedals come in on their own cue, ahead of the rest of the HUD — see `pedalsDue` in the
// frame loop. `hud-ready` implies them (in the stylesheet), so a run with no tutorial gets
// everything on frame one.
const revealPedals = () => document.body.classList.add('pedals-ready');
const revealHud = () => document.body.classList.add('hud-ready');
let hudAway = false;
const setHudAway = (away) => {
  if (away === hudAway) return;
  hudAway = away;
  document.body.classList.toggle('hud-away', away);
};

// Set the first time that press is *held* past LOCO_HINT_HOLD with the boost actually engaged, and
// never cleared. This is what retires the third beat, because it is the only evidence that the
// player has met the thing the pill does: a tap gives a flicker of boost and hands it straight back,
// so retiring the hint on the first press closed it on the exact gesture it exists to correct.
//
// `isEngaged` rather than `isActive` deliberately, so a hold that ran the tank dry still counts —
// the fuel ending is not the player letting go, and the one-second cooldown tail is where a hold
// that outlasted its tank sits.
let locoHeld = false;
tutorial = shot || !wantsTutorial ? null : createTutorial({
  controller,
  aspect,
  isNarrow,
  taxi: traffic.taxi,
  viewport,
  project: projectToScreen,
  // Orthographic, so world-units-per-pixel falls straight out of the frustum height: the vertical
  // world span is exactly 2 * the drawn zoom. This is what keeps the spotlight the same size on
  // every viewport, and correct when a wreck pulls the zoom in under it or Loco Mode pushes in.
  pixelsPerUnit: () => viewport.height() / (2 * controller.viewZoom()),
  // The third beat points at a control rather than at something in the city: its bubble stands on
  // the pedal's top. Declared after this call; `function` hoisting covers it.
  boostTarget: gasPedalTop,
  // The one the game means by "the waiting fare" — the shortest clock on the kerb. At this point in
  // a run there is only ever one, but pointing at the same rider the rest of the HUD would is free.
  waitingFare: () => fares.waiting(),
  // The kerb corner, not the junction centre: at this zoom the corner building sits squarely
  // between the camera and the figure otherwise. Same aim as panToRider and the drop-off pointer.
  fareLocation: (fare) => kerbFor(fare),
  // Any fare the player has actually sent the taxi at — including one they found and tapped on the
  // map while the first bubble was still up.
  isDispatched: () => Boolean(fares.carrying() || fares.state.fares.some((f) => f.directed)),
  // The third beat waits on this rather than on the dispatch: the Loco Mode hint lands a couple of
  // seconds after the first rider is actually dropped off, once the loop has closed one full turn.
  hasDelivered: () => fares.state.delivered > 0,
  // A player who has already *held* Loco Mode does not need the third beat pointing at it — and one
  // who has only tapped it very much does, which is the whole difference between these two.
  boostHeld: () => locoHeld,
  isOver: () => fares.state.gameOver,
  // Not a word during a getaway — see `hushTips`. The Loco Mode beat is the one that can still be
  // waiting this late (a player who has never held the pill), and it waits a little longer.
  isQuiet: hushTips,
  // The "Add to Home Screen" screen gets there first on iOS in a tab, and holds the run until it is
  // tapped. `homeTip` is declared further down and only ever read from the frame loop, which is
  // long after this module has finished evaluating. The city's own entrance holds the tutorial the
  // same way: the spotlight dimming a city that is still building itself would upstage the build,
  // and the first bubble should land as the thing that happens *after* the last building does.
  // The 250ms beat between the two is the tutorial's own OPENING_HOLD.
  // ...and the opening vignette holds it after that, so the three queue: the city builds itself,
  // the taxi comes out of its garage, and only then does anything start talking. Each is a claim
  // about the same few seconds and any two of them at once is neither.
  // ...and the wipe holds it across a *skipped* vignette, which is the one case where the sequence
  // stops running while the player still cannot see anything: the hold has to last until the black
  // starts lifting rather than until the vignette ends.
  isBlocked: () => parked() || cityEntry.running()
    || Boolean(opening?.running()) || Boolean(wipe?.covering()),
  // The same guard the picker uses: the click a mouse synthesises at the end of a drag must not
  // count as an answer to the bubble the player was dragging past.
  shouldIgnoreTap: () => Boolean(pan?.didPan() || pathDrag?.didDrag()),
  // Hold every fare's countdown for as long as the tutorial is talking. It ends on the player's
  // tap, so the clock they are taught with is the full sixty seconds.
  onRunning: (running) => {
    tutorialTalking = running;
    holdFareClocks();
    if (!running) revealHud();
  },
});

// The boost meter, the money counter and the rider chips start off their own screen edge and
// slide in together — see the HUD entrance block in index.html. A run used to open with all of them
// already lit, every one reading zero and answering a question nobody had asked yet. They arrive
// when the tutorial stops talking; with no tutorial to wait for (`?tutorial=off`, shot mode) they
// are simply there from the first frame. The two pedals are the exception and come in earlier —
// see `pedalsDue` in the frame loop.
if (!tutorial) revealHud();
// Debug mode holds the fare clocks for the whole session — see `debugMode`.
if (debugMode) holdFareClocks();

// --- HUD --------------------------------------------------------------------

const hud = {
  money: document.getElementById('money'),
  runs: document.getElementById('runs'),
  strikes: document.getElementById('strikes'),
  rating: document.getElementById('rating'),
  banner: document.getElementById('run-end'),
};

function updateRunTags() {
  if (hud.runs) updateComboTag(hud.runs);
}

// The combo meter (game/combometer.js): the multiplier, "3x", centred on the screen on
// the cash row, with the tailpipe's flame burning sideways out of its left (Tyler, 2026-10-07).
// There is no bar: the meter has no full state worth drawing, since a ×5 run keeps combo'ing.
//
// The flame is the Loco plume's own silhouette (`tongueOutline` in game/locoflame.js) drawn as
// SVG — three nested tongues, four flipbook frames at the plume's 16fps — in Loco orange, growing a
// little and flaring with each whole step. It climbed the drift chain's colours with the multiplier
// (violet, blue, teal, pink) for one build; Tyler: "the colors right now don't work", orange for now.
//
// It only shows above 1x, the baseline (Tyler), and only while a job is in hand. A step up rolls the
// count: the new number slides up from below and pushes the old one out of the top, landing with a
// bounce, the "x" a beat behind it. A hit that breaks the streak shakes it side to side and drops it
// out of sight. A drop-off cashes it in: the meter flies down into the fare's price and multiplies
// it, and the new total flies to the counter (`popComboPayout`).
const COMBO_FLAME = [PALETTE.locoFlameOuter, PALETTE.locoFlameMid, PALETTE.locoFlameCore];
const COMBO_FLAME_STEPS = 4;
const comboFlameTier = (mult) => Math.max(0, Math.min(COMBO_FLAME_STEPS, Math.floor(mult) - 1));

// The SVG, built once. The tongue's u runs right-to-left here — the pipe is at the number and the
// tip licks away to the left — and the view box is the outer tongue's reach in world units,
// FLAME_LEN long by ±0.9 wide (HALF_W × the ruffle, plus the tip's sway), so it keeps the plume's
// proportions.
function comboFlameSvg() {
  const W = 0.9;
  const frames = Array.from({ length: FLAME_FRAMES }, (_, f) => {
    const phase = (f / FLAME_FRAMES) * Math.PI * 2;
    const outline = tongueOutline(phase);
    const paths = FLAME_LAYER_SCALES.map(([len, wide], layer) => {
      const d = outline.map(([u, y], i) =>
        `${i ? 'L' : 'M'}${(FLAME_LEN * (1 - u * len)).toFixed(3)} ${(y * wide).toFixed(3)}`).join('') + 'Z';
      return `<path class="t${layer}" d="${d}"/>`;
    }).join('');
    return `<g class="f" style="animation-delay:${(f * FLAME_FRAME_TIME).toFixed(4)}s">${paths}</g>`;
  }).join('');
  return `<svg class="combo-flame" viewBox="0 ${-W} ${FLAME_LEN} ${2 * W}" preserveAspectRatio="none" aria-hidden="true">${frames}</svg>`;
}

const comboTag = {
  el: null, roll: null, shown: 1, lost: false, landed: false, lingerUntil: 0, hiddenSince: 0, breaking: false,
};
// How long the meter stays up after a drop-off: until `popComboPayout` lifts it off the HUD, which
// it does as soon as the fare's price has popped (~0.56s). This is only the backstop.
const COMBO_LINGER_MS = 1500;
const COMBO_FADE_MS = 350;   // the CSS opacity fade (0.3s) and a frame's margin

function comboCount(mult) {
  const el = document.createElement('span');
  el.className = 'combo-count';
  el.innerHTML = `<span class="combo-num">${formatMult(mult).slice(0, -1)}</span><span class="combo-x">x</span>`;
  return el;
}

/** Show `mult` on the meter: rolled in with a bounce when `roll`, set in place otherwise. */
function setComboCount(mult, roll) {
  const el = comboTag.el;
  const next = comboCount(mult);
  // Out of hiding at 1x there is nothing on screen to push out of the way.
  const fromHidden = el.classList.contains('is-off-job');
  for (const old of comboTag.roll.querySelectorAll('.combo-count:not(.is-leaving)')) {
    if (!roll || fromHidden) { old.remove(); continue; }
    old.classList.add('is-leaving');
    old.addEventListener('animationend', () => old.remove(), { once: true });
  }
  if (roll) next.classList.add('is-entering');
  comboTag.roll.append(next);
  const tier = comboFlameTier(mult);
  el.style.setProperty('--flame-size', String(1 + 0.12 * tier));
  if (roll && tier > comboFlameTier(comboTag.shown)) {
    el.classList.remove('is-flaring');
    void el.offsetWidth;
    el.classList.add('is-flaring');
  }
  comboTag.shown = mult;
}

function updateComboTag(box) {
  // Only on a job — heading to a rider or carrying one (Tyler, 2026-10-07) — and only above 1x,
  // the baseline. A drop-off holds it up for the payout (`lingerUntil`) until `popComboPayout` flies
  // it into the fare; a break holds it up for its own animation. Either way it never shows a 1x.
  const now = performance.now();
  const mult = combo.state.mult;
  let el = comboTag.el;
  if (!el) {
    if (mult === 1) return;
    el = comboTag.el = document.createElement('div');
    el.className = 'combo-meter is-off-job';
    el.innerHTML = `${comboFlameSvg()}<span class="combo-roll"></span>`;
    const [outer, mid, core] = COMBO_FLAME;
    el.style.setProperty('--flame-outer', outer);
    el.style.setProperty('--flame-mid', mid);
    el.style.setProperty('--flame-core', core);
    comboTag.roll = el.querySelector('.combo-roll');
    box.classList.add('is-combo');
    box.append(el);
    comboTag.lost = false;
  }
  if (comboTag.lost && el.classList.contains('is-off-job')) {
    // Lost out of sight (a bump between fares): nothing to shake, just reset it.
    comboTag.lost = false;
    setComboCount(mult, false);
  }
  if (comboTag.lost) {
    // Shake, then drop out of sight. It stays hidden at 1x until the next combo.
    comboTag.lost = false;
    comboTag.breaking = true;
    el.classList.add('is-broken');
    el.addEventListener('animationend', function done(e) {
      if (e.animationName !== 'combo-broken') return;
      el.removeEventListener('animationend', done);
      comboTag.breaking = false;
      el.classList.add('is-off-job');
      comboTag.hiddenSince = performance.now();
      el.classList.remove('is-broken');
      setComboCount(combo.state.mult, false);
    });
    return;
  }
  if (comboTag.breaking) return;
  const lingering = now < comboTag.lingerUntil;
  const shown = lingering || (mult > 1 && fares.job() && !fares.state.gameOver);
  if (shown === el.classList.contains('is-off-job')) {
    // Roll the number in before the fade starts, so a fresh streak arrives already bouncing.
    if (shown && mult !== comboTag.shown) { setComboCount(mult, true); comboTag.landed = false; }
    el.classList.toggle('is-off-job', !shown);
    el.classList.remove('is-cashed');
    if (!shown) comboTag.hiddenSince = now;
  }
  if (mult === comboTag.shown) return;
  // A drop hidden from view (a cash-in) is set in place once the fade is done; one in view waits
  // for the payout to lift it. The count only ever rolls upward.
  if (mult < comboTag.shown && !comboTag.landed) {
    if (!shown && now - comboTag.hiddenSince >= COMBO_FADE_MS) setComboCount(mult, false);
    return;
  }
  comboTag.landed = false;
  setComboCount(mult, true);
}

/**
 * A combo landed: step the meter and say what it added off the roof. Only on a job —
 * on the way to a rider or carrying one — so a stunt done idling between fares builds nothing.
 */
function landCombo(key, tier) {
  if (!fares.job()) return;
  const landed = combo.land(key, tier);
  if (landed?.added > 0) comboTag.landed = true;
  if (landed?.added > 0) popLabel(`${landed.label} ${formatMult(landed.mult)}`, 'run-combo');
}

// Light one ring per rider let go on the kerb (see MAX_STRIKES). The newest pops, so the HUD answers
// the rider storming off on the same frame.
function showStrikes(count) {
  if (ratingOn) { showRating(count); return; }
  if (!hud.strikes) return;
  const marks = hud.strikes.querySelectorAll('.strike');
  marks.forEach((mark, k) => {
    const used = k < count;
    mark.classList.toggle('is-used', used);
    if (k === count - 1) {
      mark.classList.remove('is-new');
      void mark.offsetWidth;
      mark.classList.add('is-new');
    }
  });
  const left = MAX_STRIKES - count;
  hud.strikes.setAttribute('aria-label', count === 0 ? 'No riders lost'
    : `${count} ${count === 1 ? 'rider' : 'riders'} lost, ${left} to go`);
}

// The same count as a star rating (see RATING_START): a star off per strike, the new number
// dropping in, and red once one more miss would end the run.
function showRating(count) {
  if (!hud.rating) return;
  const rating = ratingFor(count);
  const text = rating.toFixed(1);
  const num = hud.rating.querySelector('.rating-num');
  if (num.textContent === text) return;
  num.textContent = text;
  hud.rating.classList.toggle('is-last', rating - 1 <= RATING_FLOOR);
  hud.rating.classList.remove('is-drop');
  void hud.rating.offsetWidth;
  hud.rating.classList.add('is-drop');
  hud.rating.setAttribute('aria-label', `Rating ${text} stars`);
}
// The rating row is off the HUD for now (Tyler, 2026-10-20) — the rating still counts, and still
// fires you at RATING_FLOOR, it just isn't drawn. `?stars=classic` puts it back under the cash.
const starsShown = new URLSearchParams(window.location.search).get('stars') === 'classic';
if (hud.strikes) hud.strikes.hidden = ratingOn;
if (hud.rating) hud.rating.hidden = !ratingOn || !starsShown;

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

/**
 * Which way a collected box should leave the world: from where it stands on screen toward the cargo
 * dock's centre, in pixels with y down (game/parcels.js turns it back into a ground direction).
 *
 * Measured off the dock's *resting* box rather than its live one. Mid-entrance, or with the bottom
 * row slid away (`hud-away`), the dock is translated up to 200% of its height off the bottom edge
 * (index.html), and aiming at that would point the box at somewhere it is not going to be. The
 * `offset*` box ignores transforms and `translate` alike, so it is where the dock rests, and for a
 * `position: fixed` element it is measured from the viewport's origin — the same frame
 * `projectToScreen` answers in. A dock that is not laid out at all (shot mode's `display: none`)
 * measures 0×0 and answers null, which takes the module's own down-and-right.
 */
function towardCargoDock(x, y, z) {
  const dock = document.getElementById('cargo-dock');
  if (!dock || dock.offsetWidth === 0) return null;
  const p = projectToScreen(x, y, z);
  return {
    x: dock.offsetLeft + dock.offsetWidth / 2 - p.x,
    y: dock.offsetTop + dock.offsetHeight / 2 - p.y,
  };
}

/**
 * Could the player be looking at world point (x, z)? On screen, or within `margin` world units of its
 * edge — enough for a car's length and the light bar standing up off its roof. For anything that
 * wants to take a car off the map without being seen doing it (game/robbery.js).
 */
function inShot(x, z, margin = 6) {
  const p = projectToScreen(x, 0, z);
  const m = margin * viewport.height() / (2 * controller.viewZoom());
  return p.x > -m && p.x < viewport.width() + m && p.y > -m && p.y < viewport.height() + m;
}

/** Screen position of the taxi, for anchoring the earnings pop. */
function taxiScreenPos() {
  return projectToScreen(traffic.taxi.x, 1.4, traffic.taxi.z);
}

/**
 * Centre of the Punch It pill, and the radius of a circle that clears it. The sparks go to the
 * fuel meter (`fuelScreenPos`) and only come here when it can't be measured. Read fresh on every call rather than cached, because the pill's own fill flutter
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

/**
 * The robbery's cop car nearest the bank's door — the one dispatch's call is pinned on (see
 * game/radio.js). Read when the call goes out, 1.5s after the police come on, so they are already on
 * the road; null if there is no robbery or no cop to point at.
 */
function copNearestBank() {
  const door = robbery?.site.door;
  if (!door) return null;
  let best = null;
  let bestD = Infinity;
  for (const cop of traffic.policeCars) {
    if (cop.patrol) continue;
    const d = Math.hypot(cop.x - door.x, cop.z - door.z);
    if (d < bestD) { bestD = d; best = cop; }
  }
  return best;
}

/** The top of the gas pedal, where the tutorial's Loco Mode bubble points. Null while hidden. */
function gasPedalTop() {
  const r = boostButton?.getBoundingClientRect();
  if (!r?.width) return null;
  return { x: r.left + r.width / 2, y: r.top };
}

/**
 * Where a delivery's boost sparks land: the crown of the fuel gauge arcing over the gas pedal,
 * since that is what they fill. The track's box is the whole arc, so its top edge is the crown.
 * Falls back to the pedal when the meter isn't measurable, so a flight always has somewhere to go.
 */
function fuelScreenPos() {
  const arc = boostMeterEl?.querySelector('.boost-track');
  const r = arc?.getBoundingClientRect();
  if (!r?.width) return boostScreenPos();
  return { x: r.left + r.width / 2, y: r.top + 3, r: r.width / 2 + 20 };
}

/** Where a payout pops: the middle of the screen, a little above centre so it clears the pedals' row of thumbs. */
function payoutScreenPos() {
  return { x: viewport.width() / 2, y: viewport.height() * 0.42 };
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
 * Roll the counter from its current value to `target`. Uses rAF rather than a CSS tween so a
 * second delivery landing mid-roll simply re-aims the same animation at the new total instead of
 * two counters racing. The bump class is toggled off then on across a reflow, because a class that
 * stays put doesn't re-fire the keyframe.
 *
 * **It rolls both ways.** This used to snap on any `delta <= 0`, which was safe only while nothing
 * in the game could take money *off* the player: the burger's counter charge (`BURGER_PRICE`) is
 * the first thing that can, and left alone it would have landed as digits silently dropping — the
 * exact side effect the two-phase flight exists to prevent. Same tween, same rate, and the bump
 * carries the sign: green for money arriving, red for money leaving.
 *
 * `up` is the *event's* sign and not the roll's, which are not the same question. The roll is aimed
 * at whatever the total is now, so a charge landing while a payout is still in the air computes a
 * positive delta and would otherwise bump green for money the player just spent. What the counter
 * is reacting to is the thing that flew into it, and only the caller knows which that was.
 */
function rollMoneyTo(target, up = true) {
  if (!hud.money) return;
  if (moneyRoll) cancelAnimationFrame(moneyRoll);
  const from = shownMoney;
  const delta = target - from;
  if (delta === 0) { hud.money.textContent = String(target); return; }
  // ~50ms per dollar so a $8 tick reads as a quick bump and a $35 one as a longer roll, clamped so
  // neither extreme feels wrong.
  const dur = Math.min(700, Math.max(240, Math.abs(delta) * 50));
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
  // visual event rather than just a digit changing. Toggle off / reflow / on to re-fire keyframes,
  // and drop the other direction's class while doing it: the two keyframes animate the same two
  // properties, so a leftover class would let a charge finish on the colour of a payout.
  const bump = hud.money.parentElement;
  if (bump) {
    bump.classList.remove('money-bumped', 'money-charged');
    void bump.offsetWidth;
    bump.classList.add(up ? 'money-bumped' : 'money-charged');
  }
}

/**
 * The flying number: it pops in the middle of the screen and flies up into the counter.
 *
 * It flew off the taxi at first, which put it wherever the car happened to be — and with a run
 * bonus's three steps in a row, that was a lot of reading done over the busiest part of the map.
 * Then it popped just under the counter, which was tidy and easy to miss. The middle of the screen
 * is where the eye can find it every time, and the combo cash-in lands in the same place
 * (`payoutScreenPos`, `popComboPayout`).
 *
 * Negative is a **charge** — the burger's `BURGER_PRICE` and the depot's `REPAIR_PRICE`. It takes the same
 * flight rather than one of its own, because it is the same claim: this is what moved the counter.
 * What changes is the sign, the colour (red, `.is-charge`) and nothing else — including the
 * direction, which stays up into the counter. A charge flown out of the counter would read as the
 * player being *given* something.
 *
 * `to` sends it somewhere else instead, read at the moment of the flight: a street race lost pays
 * the racer, so the money flies to the car (Tyler) and the counter only rolls once it has gone.
 */
function popEarning(amount, to = null) {
  const counter = counterScreenPos();
  const start = payoutScreenPos();
  const el = document.createElement('div');
  el.className = amount < 0 ? 'earning is-charge' : 'earning';
  el.textContent = amount < 0 ? `−$${-amount}` : `$${amount}`;
  el.style.left = `${start.x}px`;
  el.style.top = `${start.y}px`;
  document.body.append(el);

  // Phase 1: pop in and hold a beat, long enough to read the amount.
  const rise = el.animate([
    { opacity: 0, transform: 'translate(-50%, -50%) translateY(10px) scale(0.7)' },
    { opacity: 1, transform: 'translate(-50%, -50%) translateY(0)    scale(1.12)', offset: 0.35 },
    { opacity: 1, transform: 'translate(-50%, -50%) translateY(0)    scale(1)' },
  ], { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });

  rise.onfinish = () => {
    // The target is resolved *at launch* rather than baked into a CSS keyframe, so a window resize
    // between deliveries still aims each flight at where the counter actually is now — and a car
    // flown to is wherever it has driven to by then.
    const target = to?.() ?? counter ?? { x: start.x, y: start.y - 74 };
    const dx = target.x - start.x;
    const dy = target.y - start.y;
    // Phase 2: fly to the counter and shrink, landing on top of it. Slight scale-down at the
    // end so the flight has a target rather than a vague fade-in-the-middle.
    const fly = el.animate([
      { opacity: 1, transform: 'translate(-50%, -50%) scale(1)' },
      { opacity: 0, transform: `translate(-50%, -50%) translate(${dx}px, ${dy}px) scale(0.55)` },
    ], { duration: 380, easing: 'cubic-bezier(0.42, 0, 0.58, 1)', fill: 'forwards' });
    fly.onfinish = () => {
      el.remove();
      rollMoneyTo(fares.state.money, amount >= 0);
    };
  };
}

/**
 * A word rising off the taxi and fading where it is — the getaway's "Checkpoint 1/2", a combo's
 * "Big Air 3x". The first half of `popEarning`'s flight with no counter to land on, since nothing
 * is being paid.
 *
 * Labels take turns (Tyler, 2026-10-19: Big Air landing on a roadworks barricade drew "Big Air" and
 * "Stuntman" on top of each other, since both start at the taxi on the same frame). One that
 * arrives while another is up waits until that one has been readable for LABEL_HOLD_MS, then
 * clears it with a quick fade and takes its place, so a pile-up reads in order without the last
 * word turning up seconds after the move. A lone label still plays its whole 1.9s.
 *
 * Both were 1400/700 until Tyler, 2026-10-25: "shown just a little too fast". The pop and the fade
 * are fixed at 420ms and 350ms, so the extra half second all goes on the steady hold between them:
 * a lone label now sits still and readable for 1130ms rather than 630ms.
 */
const LABEL_RISE_MS = 1900;
const LABEL_HOLD_MS = 1000;  // well past the pop's 420ms peak, long enough to read "Crushin' It 4x"
const LABEL_CLEAR_MS = 140;
const labelQueue = [];
let labelUp = null;          // { el, rise, at } — the one on screen
let labelTimer = 0;

/**
 * @param ms   how long it rises for, `LABEL_RISE_MS` unless the caller wants it held longer
 * @param at   `() => {x, y}` to anchor at instead of the taxi — the race's count stands in one place,
 *             where a taxi still easing in under the camera walked its digits sideways
 */
function popLabel(text, cls = '', ms = LABEL_RISE_MS, at = null) {
  labelQueue.push({ text, cls, ms, at });
  pumpLabels();
}

function pumpLabels() {
  if (!labelQueue.length) return;
  if (labelUp) {
    const wait = LABEL_HOLD_MS - (performance.now() - labelUp.at);
    if (wait > 0) {
      clearTimeout(labelTimer);
      labelTimer = setTimeout(pumpLabels, wait);
      return;
    }
    clearLabel(labelUp);
  }
  showLabel(labelQueue.shift());
  if (labelQueue.length) labelTimer = setTimeout(pumpLabels, LABEL_HOLD_MS);
}

function clearLabel(up) {
  const { el, rise } = up;
  rise.pause();
  el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }],
    { duration: LABEL_CLEAR_MS, fill: 'forwards' }).onfinish = () => el.remove();
  if (labelUp === up) labelUp = null;
}

function showLabel({ text, cls, ms = LABEL_RISE_MS, at = null }) {
  const start = at?.() ?? taxiScreenPos();
  const el = document.createElement('div');
  el.className = `earning is-label ${cls}`;
  el.textContent = text;
  el.style.left = `${start.x}px`;
  el.style.top = `${start.y}px`;
  document.body.append(el);
  const rise = el.animate([
    { opacity: 0, transform: 'translate(-50%, -50%) translateY(4px)   scale(0.8)' },
    // The pop and the fade keep fixed timings (420ms up, 350ms out) whatever `ms` is, so a
    // label held longer holds rather than rising in slow motion.
    { opacity: 1, transform: 'translate(-50%, -50%) translateY(-26px) scale(1.06)', offset: 420 / ms },
    { opacity: 1, transform: 'translate(-50%, -50%) translateY(-34px) scale(1)', offset: 1 - 350 / ms },
    { opacity: 0, transform: 'translate(-50%, -50%) translateY(-44px) scale(1)' },
  ], { duration: ms, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });
  const up = { el, rise, at: performance.now() };
  labelUp = up;
  rise.onfinish = () => {
    el.remove();
    if (labelUp === up) labelUp = null;
  };
}

/**
 * A drop-off paid at the combo meter. The fare's own price pops mid-screen as usual and
 * holds; the meter lifts off the HUD and flies down into it, the price punches and rolls up to the
 * multiplied total, and that total flies into the counter (Tyler, 2026-10-07: "combine with the
 * cash and multiply it when it hits"). One number travels the whole way, so the payout reads as
 * price × meter rather than the Perfect Run's price, label, extra.
 *
 * The meter that flies is a copy: the real one is hidden the frame it leaves (`is-cashed`), and on
 * a whole-run meter (`?combo=run`), which a drop-off does not empty, it simply stays where it is.
 */
const COMBO_FLY_MS = 420;
const COMBO_TALLY_MS = 520;
function popComboPayout(fare) {
  const base = fare.basePay;
  const total = fare.value;
  const mult = fare.runs[0].mult;
  const start = payoutScreenPos();
  const el = document.createElement('div');
  el.className = 'earning';
  el.textContent = `$${base}`;
  el.style.left = `${start.x}px`;
  el.style.top = `${start.y}px`;
  document.body.append(el);
  const at = (scale, dy = 0) => `translate(-50%, -50%) translateY(${dy}px) scale(${scale})`;
  const flyHome = () => {
    const target = counterScreenPos() ?? { x: start.x, y: start.y - 74 };
    el.animate([
      { opacity: 1, transform: at(1) },
      { opacity: 0, transform: `translate(-50%, -50%) translate(${target.x - start.x}px, ${target.y - start.y}px) scale(0.55)` },
    ], { duration: 380, easing: 'cubic-bezier(0.42, 0, 0.58, 1)', fill: 'forwards' }).onfinish = () => {
      el.remove();
      rollMoneyTo(fares.state.money);
    };
  };
  const tally = () => {
    haptic('perfect');
    el.classList.add('run-combo');
    el.animate([
      { transform: at(1) },
      { transform: at(1.45), offset: 0.18 },
      { transform: at(0.92), offset: 0.45 },
      { transform: at(1.06), offset: 0.7 },
      { transform: at(1) },
    ], { duration: COMBO_TALLY_MS, easing: 'ease-out', fill: 'forwards' });
    const t0 = performance.now();
    const roll = (now) => {
      const t = Math.min(1, (now - t0) / COMBO_TALLY_MS);
      el.textContent = `$${Math.round(base + (total - base) * (1 - (1 - t) ** 3))}`;
      if (t < 1) requestAnimationFrame(roll);
      else setTimeout(flyHome, 380);
    };
    requestAnimationFrame(roll);
  };
  el.animate([
    { opacity: 0, transform: at(0.7, 10) },
    { opacity: 1, transform: at(1.12), offset: 0.35 },
    { opacity: 1, transform: at(1) },
  ], { duration: 560, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' }).onfinish = () => {
    // Lift the meter off the HUD. Measured now rather than at the drop-off: it may have moved.
    const meter = comboTag.el;
    const from = meter && !meter.classList.contains('is-off-job') ? meter.getBoundingClientRect() : null;
    if (!from?.width) { tally(); return; }
    const fly = meter.cloneNode(true);
    fly.classList.remove('is-flaring', 'is-cashed');
    fly.classList.add('combo-fly');
    for (const old of fly.querySelectorAll('.combo-count')) old.remove();
    fly.querySelector('.combo-roll').append(comboCount(mult));
    fly.style.left = `${from.left}px`;
    fly.style.top = `${from.top}px`;
    document.body.append(fly);
    if (combo.scope === 'meter') {
      comboTag.lingerUntil = 0;
      meter.classList.add('is-cashed');
    }
    // Aim the count — the right-hand part of the meter, past the flame — at the price's centre.
    const roll = fly.querySelector('.combo-roll').getBoundingClientRect();
    const dx = start.x - (roll.left + roll.width / 2);
    const dy = start.y - (roll.top + roll.height / 2);
    fly.animate([
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 24}px) scale(1.25)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.6)`, opacity: 0.2 },
    ], { duration: COMBO_FLY_MS, easing: 'cubic-bezier(0.5, 0, 0.75, 0.4)', fill: 'forwards' }).onfinish = () => {
      fly.remove();
      tally();
    };
  };
}

/**
 * Push the world half of the difficulty curve into the sim: more traffic, and a police patrol
 * that comes round more often.
 *
 * A pinned `?cars=N` opts out of the density ramp entirely — the pool was sized to that number, so
 * `setCarCount` has nowhere to grow into anyway, but saying so here is what makes it a decision
 * rather than an accident.
 */
function applyWorldPressure() {
  const delivered = fares.state.delivered;
  if (pinnedCars === null) traffic.setCarCount(difficulty.carCount(delivered));
  patrol.setCooldownRange(difficulty.policeCooldown(delivered));
}

/** Total seconds as `m:ss` + a trailing `s`, e.g. `1:03s` — the run-end screen's Time stat. */
function formatRunTime(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const secs = total % 60;
  return `${Math.floor(total / 60)}:${String(secs).padStart(2, '0')}`;
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
  updateRunTags();

  if (s.gameOver && hud.banner && hud.banner.hidden) {
    // Every ending holds the banner while its own closing beat plays — CRASH_BANNER_DELAY for the
    // blast, BUST_BANNER_DELAY for the pull-in on a bust, TIMEOUT_BANNER_DELAY for the pull-in on the corner a
    // fare's clock ran out on. All three are wallclock, so the slow-mo doesn't stretch the wait.
    // `crashBannerAt` is null only for a run ended from outside the game (the console hook), which
    // has nothing to wait for.
    if (crashBannerAt !== null && performance.now() < crashBannerAt) return;
    // A bust or a firing has no impact to pick a frame from: its print is the frame its pull-in
    // ended on, drawn again here so it is in the buffer to be read.
    if (snapshot && !snapshot.photo()) {
      renderFrame();
      snapshot.grab(PHOTO.END);
    }
    showRunEnd(hud.banner, {
      title: s.failTitle,
      reason: s.failReason,
      // What the run paid, which is what it is ranked on; the highest the combo meter got; and how
      // long it lasted. Fares and Shift were cut (Tyler, 2026-10-06): with every rider's clock
      // budgeted off the work it takes, both mostly restate Time, and four rows of near-synonyms
      // buried the one number the table sorts by. Max combo is not one of those — it is the only
      // row about *how* the run was driven — so it went back in (Tyler, 2026-10-21). It counts in
      // tenths because the roll is integer, and floors at 1x so it climbs from where the meter
      // starts rather than from 0x; a run that never landed a combo says 1x rather than dropping
      // the row, so the card is the same shape every time.
      stats: [
        { label: 'Cash', value: s.money, format: (n) => `$${n}` },
        // Cash counts up; these two are typed out (Tyler, 2026-10-23) — a combo or a clock rolling
        // up from zero says nothing the final figure doesn't.
        { label: 'Max combo', value: Math.round(combo.state.best * 10), format: (n) => formatMult(Math.max(1, n / 10)), reveal: 'type' },
        { label: 'Time', value: s.elapsed, format: formatRunTime, reveal: 'type' },
      ],
      // Recorded here rather than the moment the run ended, so the write happens on the frame the
      // screen is actually built — every ending holds this block for a beat, and a score saved
      // during that hold would be sitting in storage before the player had been told the run was
      // over.
      scores: collectScores(),
      onRetry: playAgain,
      // What the run unlocked, after the table and before the button. The tap that closes the card
      // starts the next run rather than going back to the table (Tyler, 2026-10-25: "progress to
      // start a new game after this and not show the leaderboard again") — the table has already
      // been read once, and the card's own "Tap to continue" is the run-end screen's. Under
      // `?moveexit=classic` the card closes back onto the table and its Play again.
      finale: (done) => showUnlockedMoves(moveExitClassic ? done : playAgain),
      photo: snapshot?.photo() ?? null,
      footHint: !gameOverClassic,
      statCount: !statCountClassic,
      tapRetry: !playAgainClassic,
      fit: !runEndFitClassic,
      // The song plays on under the stats and goes when the card starts waiting on the player
      // (Tyler, 2026-10-23: "a little bit of music in the game over state"). A tap that skips the
      // count brings the hint, and the fade, forward with it.
      onStatsShown: musicFadeClassic ? null : () => sfx?.fadeOutMusic(MUSIC_FADE_AT_HINT),
    });
    document.body.classList.add('game-over');
    if (musicFadeClassic) sfx?.fadeOutMusic();
  }
}

// Has the paused still been drawn? See the pause branch of `tick`.
let stillDrawn = false;
// Through the viewport's own change feed rather than `window.resize`: an iOS cold-start settle —
// the screen's true height arriving a few hundred ms after launch — changes the measurement
// without ever firing a resize event, and the canvas has to follow it or the game keeps the
// dead strip the settle just revealed.
viewport.onChange((w, h) => {
  renderer.setSize(w, h);
  stillDrawn = false;
  controller.resize(aspect());
});

// --- Crazy taxi button ------------------------------------------------------

const boostButton = document.getElementById('boost');
// The same fuel, read out on a gauge arc over the gas button (see #boost-meter in index.html). It
// takes the pedal's classes and variables verbatim, so the two can never disagree about the tank.
const boostMeterEl = document.getElementById('boost-meter');

// A drop-off is the only thing that ever puts fuel in the tank (see game/boost.js), so the pour is
// the reward animation and it gets three layers: the bar overruns its new mark and eases back, the
// pill pulses yellow the whole time fuel is arriving, and a blurred bright edge rides the front of
// the fill. game/boostmeter.js owns the timing of all three; this just hands it the clock and the
// fuel level and paints what comes back onto three CSS variables.
const boostMeter = createBoostMeter();

// The gauge is a filled band, so it is geometry rather than a stroke (game/fuelarc.js): the track
// is drawn once and the fuel re-outlined whenever the level moves by more than a hair — a pour or a
// burn changes it every frame, a parked tank not at all.
const fuelTrack = boostMeterEl?.querySelector('.boost-track');
const fuelFill = boostMeterEl?.querySelector('.boost-fill');
const fuelEdge = boostMeterEl?.querySelector('.boost-edge');
const fuelGlint = boostMeterEl?.querySelector('.boost-glint');
fuelTrack?.setAttribute('d', fuelBandPath(0, 1, FUEL_RIM));
let fuelDrawn = -1;
function drawFuelArc(level) {
  if (!fuelFill || Math.abs(level - fuelDrawn) < 0.0005) return;
  fuelDrawn = level;
  fuelFill.setAttribute('d', fuelBandPath(0, level));
  const front = fuelFrontAt(level);
  fuelEdge.setAttribute('cx', front.x.toFixed(2));
  fuelEdge.setAttribute('cy', front.y.toFixed(2));
  // Twice the band's half-width: the gradient's solid core is the band, the rest is its halo.
  fuelEdge.setAttribute('r', front.w.toFixed(2));
  // The glint across the front. Off on an empty tank, where there is no front to mark — a white
  // tick sitting on the bare track at the empty end would read as fuel.
  if (fuelGlint) {
    // An attribute rather than `.hidden`, which is an HTMLElement property and a no-op on SVG.
    fuelGlint.toggleAttribute('hidden', level < 0.01);
    const g = fuelGlintAt(level);
    for (const k of ['x1', 'y1', 'x2', 'y2']) fuelGlint.setAttribute(k, g[k].toFixed(2));
  }
}

// The fuse flame (index.html, "The fuse flame"): the tailpipe's tongue burning off the fuel's front,
// in Loco orange. Built once — four frames of three nested tongues,
// cycled by CSS like the combo meter's — and then each frame is one `transform` on the group, and
// only while it burns: a parked tank writes nothing. `?locobar=classic` goes without.
const fuseFlame = new URLSearchParams(window.location.search).get('locobar') !== 'classic'
  ? boostMeterEl?.querySelector('.boost-flame') : null;
// In the button's viewBox units: the outer tongue 40 long and 1.4x the plume's own width, which puts
// it ~15 across where the fade lets it show and ~20 at its widest, against the 16-wide band (Tyler,
// 2026-10-20: "base roughly the width of the bar"; 1.2x read as a sliver once the base faded). The cut before was 56 at 2.1x, 41 across, and sat on the bar
// like a sticker.
const FUSE_LEN = 40;
const FUSE_WIDE = 1.4;
// The base starts FUSE_SINK units back inside the fuel and comes in over FUSE_FADE, from clear to
// solid, so the flame rises out of the bar rather than starting at a hard edge on its end.
const FUSE_SINK = 6;
const FUSE_FADE = 14;
if (fuseFlame) {
  const k = FUSE_LEN / FLAME_LEN;
  // One gradient per tongue, in the flame's own drawn space: the base sits at screen angle 0, where
  // `s` runs straight down the page, so the fade is a vertical ramp from the sunk base. The bend
  // over 14 units of a ~99 radius is under 1 unit, which a fade does not show.
  const colors = [PALETTE.locoFlameOuter, PALETTE.locoFlameMid, PALETTE.locoFlameCore];
  const y0 = FUEL_CAP.y - FUSE_SINK, y1 = y0 + FUSE_FADE;
  const defs = colors.map((c, layer) =>
    `<linearGradient id="fuse-fade-${layer}" gradientUnits="userSpaceOnUse" x1="0" y1="${y0}" x2="0" y2="${y1}">`
    + `<stop stop-color="${c}" stop-opacity="0"/><stop offset="1" stop-color="${c}"/></linearGradient>`).join('');
  fuseFlame.innerHTML = `<defs>${defs}</defs>` + Array.from({ length: FLAME_FRAMES }, (_, f) => {
    const outline = tongueOutline((f / FLAME_FRAMES) * Math.PI * 2);
    const paths = FLAME_LAYER_SCALES.map(([len, wide], layer) => {
      const d = outline.map(([u, y], i) => {
        const [x, yy] = fuelBendFlame(u * len * FLAME_LEN * k - FUSE_SINK, y * wide * k * FUSE_WIDE);
        return `${i ? 'L' : 'M'}${x.toFixed(2)} ${yy.toFixed(2)}`;
      }).join('') + 'Z';
      return `<path class="t${layer}" fill="url(#fuse-fade-${layer})" d="${d}"/>`;
    }).join('');
    return `<g class="f" style="animation-delay:${(f * FLAME_FRAME_TIME).toFixed(4)}s">${paths}</g>`;
  }).join('');
  fuseFlame.style.display = 'none';
}
let fuseDrawn = '';
function drawFuseFlame(level) {
  if (!fuseFlame) return;
  // Burns with the plume (its attack and release included), and not on an empty tank, where there
  // is no front for it to stand on.
  const heat = level > 0.005 ? locoFlame.state.heat : 0;
  let tf = '';
  if (heat > 0.01) {
    // Turned about the button's centre onto the front, and grown out of its own base.
    const bx = (FUEL_CAP.x + fuelFlameRadius()).toFixed(2), by = FUEL_CAP.y;
    tf = `rotate(${fuelFlameAngle(level).toFixed(2)} ${FUEL_CAP.x} ${FUEL_CAP.y}) `
      + `translate(${bx} ${by}) scale(${heat.toFixed(3)}) translate(-${bx} -${by})`;
  }
  if (tf !== fuseDrawn) {
    if (!tf !== !fuseDrawn) {
      fuseFlame.style.display = tf ? '' : 'none';
      boostMeterEl.classList.toggle('is-fuse', !!tf);
    }
    fuseDrawn = tf;
    if (tf) fuseFlame.setAttribute('transform', tf);
  }
}

// The bar is grey for the climb out of empty and snaps back to gold with a flash on the frame the
// pedal wakes (index.html, `.is-woke`). `?locogrey=classic` keeps the muted gold and no flash.
const locoGrey = new URLSearchParams(window.location.search).get('locogrey') !== 'classic';
if (!locoGrey) document.body.classList.add('locogrey-classic');
let locoWasEmpty = false;
let locoWokeTimer = 0;
function wakeLoco() {
  for (const el of [boostButton, boostMeterEl]) {
    if (!el) continue;
    // Off, a reflow, and on again: a CSS animation only restarts when its class is re-added.
    el.classList.remove('is-woke');
    void el.offsetWidth;
    el.classList.add('is-woke');
  }
  clearTimeout(locoWokeTimer);
  locoWokeTimer = setTimeout(() => {
    boostButton?.classList.remove('is-woke');
    boostMeterEl?.classList.remove('is-woke');
  }, 600);
}

function updateBoostButton(dt) {
  if (!boostButton) return;
  const mode = boost.state.mode;
  if (locoWasEmpty && mode !== 'empty' && locoGrey) wakeLoco();
  locoWasEmpty = mode === 'empty';
  // The recharge out of 'empty' is fed to the meter as a pour, because to the player it is one:
  // fuel is arriving and the bar is moving. That buys the climb the leading edge and the glow for
  // free, and — the part worth the reuse — the spring on the end, which fires on the frame the
  // trickle stops and the button wakes. What it must NOT buy is the pill's 4Hz flutter; a dead
  // button bouncing reads as pressable, so `#boost.is-charging` takes the movement back out.
  const charging = boost.isCharging();
  boostMeter.update(dt, boost.fraction(), boost.state.pending > 0 || charging);

  for (const el of [boostButton, boostMeterEl]) {
    if (!el) continue;
    el.classList.toggle('is-active', mode === 'active');
    el.classList.toggle('is-empty', mode === 'empty');
    el.classList.toggle('is-charging', charging);
    el.classList.toggle('is-filling', boostMeter.state.fill > 0);
    el.style.setProperty('--pct', `${(boostMeter.state.pct * 100).toFixed(1)}%`);
    el.style.setProperty('--fill', boostMeter.state.fill.toFixed(3));
    el.style.setProperty('--pulse', boostMeter.state.pulse.toFixed(3));
  }
  drawFuelArc(boostMeter.state.pct);
  drawFuseFlame(boostMeter.state.pct);
  // The pedal sinks while it is held, however it is held — the Space key never touches the
  // pointer's `is-held`. See "The press" in index.html.
  boostButton.classList.toggle('is-down', boost.state.held);
  // The overtake combo's cue: a steady glow once the blip has taken.
  const taxi = traffic.taxi;
  const live = !taxi.crashed && !fares.state.gameOver && boost.isEngaged();
  boostButton.classList.toggle('is-pass-armed', live && (overtake.state.armed || taxi.passing));
  // Dead until there is something worth pressing for: a drop-off pouring fuel back in, or the
  // trickle finishing its climb to a quarter tank (game/boost.js). A pressable-looking pill over a
  // tank with a sixtieth of a second in it would be a lie, so 'empty' covers the whole recharge and
  // the bar climbing behind the dead button is what says it is coming back.
  boostButton.disabled = mode === 'empty';
}

// The press itself, with no idea what pressed it — the pill, the spacebar and a thumb sliding onto
// the pill from the brake all land here. Hold-to-enable, release-to-pause; the pointer plumbing
// that reaches it lives in "The pedal slide" below, because a press on either half of the bottom
// row can end up on either pedal.
//
// Returns whether the pedal is now down — false only when nothing can press it (the run is over, or
// the tank is empty and the pill is dead). Not the same question as `boost.press()` a few lines
// down, which answers the narrower "did this press *start* a boost": a re-press during a boost that
// is already running has the pedal down and nothing to kick.
function holdLocoMode() {
  if (fares.state.gameOver || boostButton?.disabled) return false;
  // Not while the HUD is off its edges: the opening, the city building itself, a skip's black, a
  // repair visit. The pill is hidden then and cannot be pressed, but Space can — and it played the
  // Loco sound on a taxi still parked in the garage.
  if (!pedalsLive()) return false;
  // Nothing to press against: the drive-through has the wheel and the car is between two kerbs.
  // See the release beside `boost.update` in the frame loop.
  if (burgerRun?.holdsTaxi()) return false;
  // ...and the same in the depot, where the car is a cut scene rather than a car.
  if (opening?.visiting()) return false;
  // Still called on the press, and still explicit rather than left to the tutorial's window-level
  // tap handler, because the preventDefault in either caller can suppress the click the gesture
  // would otherwise synthesise (on a phone for the pill, on every device for the key, which
  // synthesises nothing). What changed is what it does with it: the *third* bubble no longer takes
  // a press for an answer — a jab is the gesture it exists to correct — so this now only clears the
  // first two, which a player reaching for the pill mid-lesson has plainly finished with.
  tutorial?.dismiss();
  // The other half of "last pedal pressed wins" — see holdBrake. Without this a player holding the
  // brake button with one thumb and jabbing the pill with the other would spend fuel on a car the
  // brake is still pinning to the road.
  releaseBrake();
  // The drift's second half: back on the pill after the tap. This is where the slide starts — the
  // tap was only a brake — so the screech, the shake and the four-wheel stamp are here rather than
  // on the tap. The kick itself goes on as the taxi lands (see `driftsPaid`).
  if (!driftHolds(traffic.taxi) && kickDrift(traffic.taxi)) {
    sfx?.play('skid');
    haptic('drift');
    controller.kickShake(0.3);
    stampAllRubber(traffic.taxi);
  }
  if (boost.press()) {
    kickLocoMode();
  }
  return true;
}

// Fires only on the transition into Loco Mode — not while it's already active — so a re-press
// during a running boost doesn't stack a fresh wheelie on top of one already animating (and
// doesn't double-fire the flame). `boost.press()` returns true only on that transition, which is
// why the whole kick is gated on it above.
function kickLocoMode() {
  // Whether the player went on to *hold* this press is a question this function cannot answer —
  // the press is one frame and the hold is the seconds after it — so `locoHeld` is latched in the
  // frame loop instead.
  // Above the `crashed` bail deliberately: the press was accepted either way — `boost.press()`
  // already returned true and the fuel is already committed — so the hand should be told even when
  // the wrecked car has no wheelie left to answer with.
  haptic('loco');
  const car = traffic.taxi;
  if (car.crashed) return;
  sfx?.locoOn();
  car.wheelieT = 0;
  const bx = -Math.cos(car.yaw);
  const bz = Math.sin(car.yaw);
  flames.burst(
    car.x + bx * TAXI_TAILPIPE_BACK,
    TAXI_TAILPIPE_HEIGHT,
    car.z + bz * TAXI_TAILPIPE_BACK,
    car.yaw,
  );
  // ...and a fistful of notes out of the back, if there is a robber in there. Here with the flame
  // and the rubber rather than in `spillCash` for the reason all three are here: this is the frame
  // the button went down, and a stream that only ramps up has nothing to say on it. See
  // game/cashtrail.js.
  if (fares.robbing()) cashTrail.kick(car, TAXI_TAILPIPE_HEIGHT + deckHeightAt(car.x, car.z).y);
  // Break traction on the launch as well as in the corners. One pair stamped here so a standing
  // start (pressing while held at a red) still leaves a patch under the wheels — the distance
  // spacing in layRubber can't produce anything until the car actually moves.
  stampRearRubber(car);
  launchSkidT = LAUNCH_SKID_TIME;
}

// (The top-up flash used to live here as a one-shot class the delivery had to remember to fire,
// which meant back-to-back deliveries needed a reflow to restart the animation. The glow is now
// driven off `boost.state.pending` in updateBoostButton — it lasts exactly as long as fuel is
// actually arriving, and a second delivery mid-pour just extends it.)

// iOS runs text selection, the magnifier and double-tap zoom off the raw touch stream, and since
// iOS 15 it does all three on this pill regardless of `-webkit-user-select: none`
// (webkit.org/b/231161). Cancelling `pointerdown` — which pressPedal already does — does not reach
// them: that suppresses the compatibility *mouse* events, one layer above the gesture recogniser
// that is actually selecting "Loco Mode™" and zooming the city. Cancelling `touchstart` does, and
// on iOS it is the only thing that does.
//
// Unconditional, unlike pressPedal, which bails on a game over before it reaches its own
// preventDefault. Those are precisely the states a player jabs at twice in a row — a drained
// pill is what "why isn't this working" looks like — so they are the states that most need this.
// Nothing is lost by cancelling: the pointer events above are the primary stream and keep firing,
// and the only defaults being dropped are the synthesised click (nothing listens for one here; see
// keyIsSpokenFor below) and focus-on-tap, which on a touchscreen has no keyboard behind it.
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


// --- Brake ------------------------------------------------------------------
//
// The other half of the bottom row, and deliberately the simpler half: no meter, no fuel, no
// cooldown, nothing to earn and nothing to spend. Hold it and the taxi hauls itself to a stop
// wherever it is; let go and it drives itself again exactly as it did before, because "drives
// itself" is the game's resting state and the brake never took that away — it only outranked it
// for as long as it was held (see `car.braking` in sim/traffic.js).
//
// Kept as a plain boolean here rather than a module of its own: `game/boost.js` exists because the
// tank is a *clock* three different systems read, and there is no equivalent state to own. What is
// worth testing lives in the sim, where the flag actually does something.
const brakeButton = document.getElementById('brake');
let brakeHeld = false;

// How slowly the car can be moving and still lock its wheels into visible rubber. Below a walking
// pace the streak would be a couple of stamps at a standstill, which reads as a stain rather than
// as a skid — and the marks stop dead at the point the car stopped, which is the whole picture the
// brake is drawing.
const BRAKE_SKID_V = 2.5;

// The drift (`driftTaxi` / `kickDrift` in sim/traffic.js): Loco, tap the brake just before a turn,
// Loco again. The tap arms it and is otherwise an ordinary brake — held, it stops the car like any
// other press. Getting back on the pill before the arc is over is what slides the taxi round at
// the boost cruise and earns the exit kick (and a thumb sliding back onto the pill lets go of the
// brake on the way: `holdLocoMode` releases it). The slide used to start on the tap and hold the
// cruise with the pill off, so a tap with no second press read as the brake shoving the car on.
// A landed kick also pays Loco back: a sixth of a tank at tier 1, as much as a parcel, and less
// further up a chain (DRIFT_CHAIN.fuel). It is what lets a player running low drift their way to a
// drop-off rather than crawl there.
let driftTapAt = -Infinity;
let driftsPaid = 0;
// And the handbrake U-turn's exit kick (`car.spinKicks`), which borrows the drift's.
let spinKicksFelt = 0;
// The same tally-and-catch-up for the taxi's overtakes (`car.overtakes` in sim/traffic.js).
let overtakesFelt = 0;

/**
 * The press, from the button, the B key, or a thumb sliding onto the brake from the pill beside it.
 * Returns whether the pedal is now down — false only on a run that is over. Already-held counts as
 * down: the second press of a two-thumbed player changes nothing, and saying "no" to it would
 * report the pedal up while the car is stopping.
 */
function holdBrake() {
  if (fares.state.gameOver) return false;
  // Same as `holdLocoMode`: B reaches this while the button is hidden, and a skid on a staged car
  // is a sound with nothing on screen making it.
  if (!pedalsLive()) return false;
  if (brakeHeld) return true;
  brakeHeld = true;
  // Below the `brakeHeld` guard, so a hold buzzes once on the way down rather than on every event
  // that re-asserts it — the button, the B key and a thumb sliding on from the pill all land here.
  // Unconditional on speed, unlike the skid stamp two lines down: the pedal has a detent whether or
  // not the car was moving fast enough to lock a wheel, and a control that answers only sometimes
  // reads as a control that is broken.
  haptic('brake');
  // Only when there is speed to shed — the pedal's detent is the haptic's job, and a brake noise
  // from a car at a standstill is a car that is not doing what the sound says. From above cruise
  // it is the Loco stop; from cruise it is the ordinary one.
  // A second tap hard on the drift's first is the bootleg asking, and the bootleg wins: the drift
  // is dropped and the spin goes in (buffered by the bootleg until the taxi is back on a straight
  // lane, as any combo landed mid-junction is). So two taps are always a U-turn and a tap then the
  // pill is the drift kick; the first tap is the same in both, and only the second input tells them
  // apart. A later stab before the kick is just the brake again (below); once the drift is sliding
  // the pedal is the drift's, and a stab is ignored.
  const drift = traffic.taxi.drift;
  if (drift && drift.phase !== 'carry') {
    if (!drift.kicked && performance.now() - driftTapAt <= BOOTLEG_GAP_MS) {
      brakeButton?.classList.add('is-on');
      traffic.taxi.drift = null;
      bootleg.spin();
      return true;
    }
    if (drift.kicked) {
      brakeButton?.classList.add('is-on');
      return true;
    }
  }
  // The drift: Loco Mode, at speed, a turn just ahead. Before the bootleg, and it clears the
  // bootleg's first tap, so the press that arms a drift can't be half of a spin. Arming is all it
  // does: the press carries on below as a plain brake, sound and rubber included, and the slide
  // waits for the pill (`holdLocoMode`).
  if (boost.isEngaged() && driftTaxi(traffic.taxi) === null) {
    bootleg.reset();
    driftTapAt = performance.now();
  } else if (bootleg.brakeTap({ engaged: boost.isEngaged() })) {
    // The bootleg: two taps in Loco Mode. Read before the pill is released below, which is the
    // first tap's own doing — its one-second tail still counts (game/bootleg.js).
    boost.release();
    brakeButton?.classList.add('is-on');
    return true;
  }
  if (traffic.taxi.v > SPEED * 1.1) sfx?.play('locoBrake');
  else if (traffic.taxi.v > BRAKE_SKID_V) sfx?.play('brake');
  // Gas and brake are one pedal each and the last one pressed wins. Releasing Loco Mode here rather
  // than letting the two fight it out means a stab of the brake mid-boost doesn't sit there quietly
  // burning fuel against a speed target of zero — the tank keeps whatever is left in it.
  boost.release();
  brakeButton?.classList.add('is-on');
  // Standing on the brake at speed breaks traction on the spot, and the distance spacing in
  // layRubber cannot produce anything until the car has travelled 0.42 of a unit — at which point
  // the streak starts a stamp late and misses the moment of the press. Same reason the Loco Mode
  // launch stamps its own first pair.
  if (traffic.taxi.v > BRAKE_SKID_V) stampAllRubber(traffic.taxi);
  return true;
}

/** Idempotent, and every path out of a hold goes through it: the button, the key, blur, a pause. */
function releaseBrake() {
  brakeHeld = false;
  brakeButton?.classList.remove('is-on');
}

// Same iOS gesture suppression the pill needs, for the same reasons and with the same `cancelable`
// guard — see the long note under boostButton's `touchstart` above.
brakeButton?.addEventListener('touchstart', (event) => {
  if (event.cancelable) event.preventDefault();
}, { passive: false });
window.addEventListener('contextmenu', (e) => {
  if (e.target === brakeButton) e.preventDefault();
});

// --- The pedal slide --------------------------------------------------------
//
// The bottom row is one control surface, not two buttons that happen to sit beside each other. A
// thumb that goes down on Loco Mode and slides right onto the brake hands the car over as it
// crosses, with no lift in between, and sliding back hands it straight back. On a phone that is the
// difference between "press the gas, let go, find the brake, press the brake" — four beats, two of
// them spent with the taxi doing neither — and one continuous movement of the one thumb that is
// already down there.
//
// Nothing about the pedals themselves changed to allow it. They already arbitrate: `holdBrake`
// releases the boost and `holdLocoMode` releases the brake ("last pedal pressed wins", see the note
// in holdBrake), so a handover mid-gesture is the same transition a two-thumbed player was already
// making. What was missing was a gesture that could reach both, which is all this section is.
//
// It is driven off *coordinates*, never off which element an event lands on. A press captures the
// pointer to the button it started on, so for the rest of the gesture every move is delivered there
// whatever is actually under the finger — which is exactly what makes a hold survive a wandering
// thumb, and exactly what makes hit-testing the event target useless here.

// Where the thumb counts as on a pedal is game/pedalzones.js: each pedal's zone is its button grown
// by `--pedal-reach`, the two meeting a `--pedal-deadband` apart in the middle of the gap, and a
// claimed pedal is only dropped once the thumb is PEDAL_SLOP clear of its zone. Claiming means being
// *inside* a zone and dropping means being clear of it, and the band between those two answers is
// where a still finger sits — a fresh press of Loco Mode is not a quiet event (a wheelie, a flame
// burst, a launch skid and a haptic tick), and brake–Loco–brake inside 350ms is a U-turn.
// The CSS owns the numbers because it also has to grow the buttons' own hit area for the first
// press (`#boost::before` in index.html); read back here so the two can't disagree.
function pedalCssPx(name, fallback) {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
  return Number.isFinite(v) ? v : fallback;
}

// The row, left to right. `hold` reports whether the pedal actually went down; `release` is
// idempotent, because every path out of a gesture goes through it.
const pedals = [
  { el: boostButton, hold: holdLocoMode, release: () => boost.release() },
  { el: brakeButton, hold: holdBrake, release: releaseBrake },
].filter((pedal) => pedal.el);

// The pointer that owns the row, and the pedal it has claimed. One pointer at a time on purpose: a
// second thumb landing on the other pedal takes the row over, which is the game's own "last pedal
// pressed wins" rather than a special case, and the first thumb's eventual lift then has nothing
// left to release.
let pedalPointer = null;
let pedalOn = null;
// The button holding the pointer capture, which is the one the press started on and not necessarily
// the one currently down. Kept so the capture can be handed back from a `pointerup` that arrives
// somewhere else entirely — see the listeners at the end of this section.
let pedalCapture = null;
// Measured on the press and then left alone. The buttons are `position: fixed` and nothing moves
// them mid-gesture, but both of them *scale* while held — the press dip, and the pill's flutter
// while a top-up pours in — so re-measuring per move would let a pedal's own animation shift the
// boundary the finger is being tested against, under a finger that never moved.
let pedalZones = [];

/**
 * Claim one pedal and let go of whatever was claimed before. Idempotent; `null` lets go of both.
 *
 * "Claimed" is the finger's business and not the pedal's: an empty tank leaves the pill dead under
 * a thumb that has plainly arrived on it, and that thumb has still left the brake. So the claim
 * moves either way and only the *press* is conditional — which is what `hold` reports, and what
 * decides whether anything is painted as held.
 */
function engagePedal(next) {
  if (next === pedalOn) return;
  if (pedalOn) {
    pedalOn.release();
    pedalOn.el.classList.remove('is-held');
  }
  pedalOn = next;
  // The press dip follows this class for the length of a gesture rather than following `:active`,
  // which the browser pins to the button the pointer went *down* on and leaves there however far
  // the finger has since travelled — see the `body.pedal-slide` rules in index.html.
  if (next?.hold()) next.el.classList.add('is-held');
}

/** Drop the whole gesture: both pedals up, the capture handed back, nobody owning the row. */
function dropPedalGesture() {
  // Guarded rather than called blind: `releasePointerCapture` throws `NotFoundError` for a pointer
  // the browser no longer considers active, and by the time a run ends under the player's thumb the
  // button holding the capture has been taken off the screen (`body.game-over #brake`).
  if (pedalCapture && pedalPointer !== null && pedalCapture.hasPointerCapture?.(pedalPointer)) {
    pedalCapture.releasePointerCapture(pedalPointer);
  }
  pedalCapture = null;
  pedalPointer = null;
  engagePedal(null);
  document.body.classList.remove('pedal-slide');
}

function pressPedal(event) {
  if (fares.state.gameOver) return;
  const pedal = pedals.find((p) => p.el === event.currentTarget);
  if (!pedal) return;
  event.preventDefault();
  // Measured before anything goes down, so the rectangles are the pedals at rest — see pedalZones.
  pedalZones = growPedalZones(
    pedals.map((p) => p.el.getBoundingClientRect()),
    pedalCssPx('--pedal-reach', 20),
    pedalCssPx('--pedal-deadband', 8),
  );
  pedalPointer = event.pointerId;
  // Set for the whole gesture and not just while a pedal is claimed: a thumb parked off the end of
  // the row is holding nothing, and is still holding the `:active` this press started.
  document.body.classList.add('pedal-slide');
  // The pedal goes down before the capture is claimed, not after. `setPointerCapture` throws
  // `NotFoundError` for a pointer id the browser has no active pointer for — which is every
  // synthesised `PointerEvent`, so a console line, a probe or a test driving these buttons the way
  // the tutorial's own dismissal does would take the throw *instead of* the press. Nothing is lost
  // by the order: capture only redirects the events that follow.
  engagePedal(pedal);
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pedalCapture = event.currentTarget;
  } catch {
    // A synthesised pointer has nothing to capture. The gesture runs perfectly well without one —
    // the listeners below are on the window precisely so that it can.
  }
}

function movePedal(event) {
  if (event.pointerId !== pedalPointer) return;
  // Inside a zone, that pedal wins outright — that is the handover. Outside both, the claimed one
  // keeps the finger until it is PEDAL_SLOP clear, which covers the deadband between them and gives
  // a thumb that has slid off the end of the row a way to let go without lifting.
  const next = pedalAfterMove(pedalZones, pedals.indexOf(pedalOn), event.clientX, event.clientY);
  engagePedal(pedals[next] ?? null);
}

function liftPedal(event) {
  if (event.pointerId !== pedalPointer) return;
  dropPedalGesture();
}

for (const { el } of pedals) el.addEventListener('pointerdown', pressPedal);

// Everything after the press listens on the *window*, not on the two buttons. Capture normally
// redirects the rest of the gesture to the button it started on, and a listener there would be
// enough — but only while the capture holds. It never takes for a synthesised pointer (see
// pressPedal), and it is dropped outright when the capturing button leaves the screen, which is
// exactly what a run ending under the player's thumb does (`body.game-over #brake`). A `pointerup`
// on a hidden element is not something to hang a stuck pedal on. On the window all three arrive
// either way — retargeted events still bubble — and cost one failed comparison when no gesture is
// open. Same shape as the route band's listener, and for the same reason: a listener on an ancestor
// is the only ordering that holds regardless of who registered first.
window.addEventListener('pointermove', movePedal);
window.addEventListener('pointerup', liftPedal);
window.addEventListener('pointercancel', liftPedal);

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
function keyIsSpokenFor(target, own) {
  if (!(target instanceof Element) || target === own) return false;
  return Boolean(target.closest('input, textarea, select, button, a[href], [contenteditable]'));
}

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (keyIsSpokenFor(event.target, boostButton)) return;
  // The "Add to Home Screen" screen sits above the run and holds it, and dismisses itself on Space.
  // Same guard the tutorial uses (`isBlocked`): the press that clears that screen must not also
  // spend fuel on a taxi that is parked behind it.
  if (parked()) return;
  // The robber's line takes Space as its own answer (game/robberline.js). Registered after this
  // one, so this has to stand down for it rather than the other way round.
  if (robberLine?.isOpen() || newMove?.isOpen() || bankJob?.running()) return;
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

// B is the brake, one key over from the bar and on the same terms as it — including the guard
// against typing a `b` into the initials field, which is why the spoken-for test takes the button
// it should exempt rather than naming the pill. A letter key activates nothing on its own, so
// unlike Space there is no focused-control behaviour to preserve; the test is here so that typing
// somewhere never also drives the car.
let brakeKeyHeld = false;

window.addEventListener('keydown', (event) => {
  if (event.code !== 'KeyB' || event.repeat) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (keyIsSpokenFor(event.target, brakeButton)) return;
  if (parked() || pause?.state.paused || robberLine?.isOpen() || newMove?.isOpen()
    || bankJob?.running()) return;
  event.preventDefault();
  brakeKeyHeld = true;
  holdBrake();
});

window.addEventListener('keyup', (event) => {
  if (event.code !== 'KeyB' || !brakeKeyHeld) return;
  brakeKeyHeld = false;
  releaseBrake();
});

// Alt-tabbing away or switching apps mid-hold should not leave the boost stuck on — and a keyup
// that lands on another window never reaches us at all, so this is the only end that hold gets.
// The brake goes with it: a pedal held by a window that no longer has the keyboard is a taxi
// stopped in the road with nothing on screen explaining why.
window.addEventListener('blur', () => {
  spaceHeld = false;
  boost.release();
  brakeKeyHeld = false;
  releaseBrake();
  // And any thumb that was on the row. A pointer whose window has gone away never comes back up
  // either — and unlike the two keys above, a gesture left open would keep a pedal painted as held.
  dropPedalGesture();
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
let wasSliding = false;

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

/**
 * All four, for the brake — everything else in the game marks the road with the driven wheels
 * alone, and a car standing on its brakes has locked the front pair too. Off the anchors the
 * wheels are actually built at (geometry/taxi.js), rather than the hand-typed 1.2/1.04 above: a
 * mark 1.5 long at each axle of a 4-unit car leaves one near-continuous streak per side, which is
 * what a locked wheel draws.
 */
function stampAllRubber(car) {
  const fx = Math.cos(car.yaw);
  const fz = -Math.sin(car.yaw);
  const rx = Math.sin(car.yaw);
  const rz = Math.cos(car.yaw);
  stampRearRubber(car);
  for (const side of [-1, 1]) {
    skids.add(
      car.x + fx * TAXI_FRONT_AXLE_FWD + rx * side * TAXI_FRONT_TRACK,
      car.z + fz * TAXI_FRONT_AXLE_FWD + rz * side * TAXI_FRONT_TRACK,
      car.yaw,
    );
  }
}

// The bootleg's rubber, along each tyre's own path rather than on the heading (game/skidmarks.js).
const spinTrail = createTyreTrail();
const stampSkid = (x, z, yaw, strength) => skids.add(x, z, yaw, strength);

function layRubber(dt) {
  const car = traffic.taxi;
  if (car.uturn?.kind === 'spin') {
    spinTrail.update(car, stampSkid);
    lastSkidAt = car.travelled;
    return;
  }
  spinTrail.reset();
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

  // And the brake, which is the only one of the four that marks the road with all four wheels —
  // see stampAllRubber. It needs no `boost` term: the pedal is the whole input, and a screech from
  // cruise is as much a skid as one from the overdrive top, just a shorter one (1.0 unit of rubber
  // against 16.5 — see HARD_BRAKE in sim/traffic.js).
  // Not the bootleg, which is a skid from start to finish but lays its own — see spinTrail above.
  // The drift does: all four wheels from the kick press to the exit.
  const skidding = (car.braking && car.v > BRAKE_SKID_V) || (driftHolds(car) && car.drift.phase !== 'carry');

  // The screech, once per slide rather than per stamp: on the frame a corner or a lane swap starts
  // breaking traction. Not the launch or the brake, which each already have a sound of their own.
  // A drift screeched on its kick press (holdLocoMode), so its corner doesn't screech a second time.
  const sliding = (cornering || swapping) && !driftHolds(car);
  if (sliding && !wasSliding) sfx?.play('skid');
  wasSliding = sliding;

  if (!cornering && !launching && !swapping && !skidding) { lastSkidAt = car.travelled; return; }
  // Closer than one mark length, so consecutive stamps overlap into a continuous streak.
  if (car.travelled - lastSkidAt < 0.42) return;
  lastSkidAt = car.travelled;

  if (skidding) stampAllRubber(car); else stampRearRubber(car);
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

// The tyres on a wet road (`?wet=`, see util/shot.js): water spray off the rear pair, and wet
// tracks behind them. Both read how wet the ground under the car is — the squall's wet map, or
// the storm's one city-wide level — and the tracks also carry `tyreWet`, how much water the treads
// are still holding, so they print a little way out onto dry road past the edge of the cell's trail
// and fade as the car drives it off.
const WET_TYRES = getWetTyres();
const WET_DUST_OFF = 0.25;     // ground this wet throws water rather than dust
const SPRAY_MIN_V = 3;         // below this a tyre rolls through the water rather than throwing it
const SPRAY_STEP = 0.55;       // units between stamps; per tyre
const TRACK_STEP = 0.42;       // the rubber's spacing, so the streaks blend the same way
const TREAD_DRY = 14;          // units of dry road that take the treads' water down by e
const TRACK_DARK = paletteColor('wetTrack');
const TRACK_SHEEN = paletteColor('wetSheen');
const TRACK_HUE = new THREE.Color();
let roadWet = 0;
let tyreWet = 0;
let lastSprayAt = 0;
let lastTrackAt = 0;
let lastTyreAt = 0;

function groundWetAt(x, z) {
  if (squall) return squall.wetAt(x, z);
  if (storm) return stormWet;
  return 0;
}

function wetTyres() {
  const car = traffic.taxi;
  roadWet = groundWetAt(car.x, car.z);
  const moved = car.travelled - lastTyreAt;
  lastTyreAt = car.travelled;
  // Soaked straight up off a wet road, wrung out over distance on a dry one.
  tyreWet = roadWet >= tyreWet ? roadWet : tyreWet * Math.exp(-Math.max(0, moved) / TREAD_DRY);

  const fx = Math.cos(car.yaw), fz = -Math.sin(car.yaw);
  const rx = Math.sin(car.yaw), rz = Math.cos(car.yaw);
  const y = deckHeightAt(car.x, car.z).y;

  if (WET_TYRES.spray && roadWet > 0.15 && car.v > SPRAY_MIN_V) {
    if (car.travelled - lastSprayAt >= SPRAY_STEP) {
      lastSprayAt = car.travelled;
      // Speed against the cruise-to-overdrive range, times how much water there is to throw.
      const pace = THREE.MathUtils.clamp((car.v - SPRAY_MIN_V) / 14, 0, 1);
      const amount = Math.min(1, roadWet * 1.25) * (0.25 + 0.75 * pace) * (car.boost ? 1.25 : 1);
      for (const side of [-1, 1]) {
        spray.add(
          car.x - fx * TAXI_REAR_AXLE_BACK + rx * side * TAXI_REAR_TRACK,
          car.z - fz * TAXI_REAR_AXLE_BACK + rz * side * TAXI_REAR_TRACK,
          car.yaw, car.v, Math.min(1, amount), side, 0.25 + y,
        );
      }
    }
  } else {
    lastSprayAt = car.travelled;
  }

  if (WET_TYRES.tracks && tyreWet > 0.08 && car.v > 0.5) {
    if (car.travelled - lastTrackAt >= TRACK_STEP) {
      lastTrackAt = car.travelled;
      const strength = Math.min(1, tyreWet * 1.4);
      // Sheen on wet road, a dark print on dry: blended across the trail's own edge.
      const hue = TRACK_HUE.copy(TRACK_DARK).lerp(TRACK_SHEEN, THREE.MathUtils.smoothstep(roadWet, 0.1, 0.45));
      for (const side of [-1, 1]) {
        wetTracks.add(
          car.x - fx * TAXI_REAR_AXLE_BACK + rx * side * TAXI_REAR_TRACK,
          car.z - fz * TAXI_REAR_AXLE_BACK + rz * side * TAXI_REAR_TRACK,
          car.yaw, strength, hue,
        );
      }
    }
  } else {
    lastTrackAt = car.travelled;
  }
}

function kickDust() {
  const car = traffic.taxi;
  // The brake joins the boost here for the same reason it lays rubber: the point of both effects is
  // that traction has broken, and a locked wheel throws exactly as much off the road as a spinning
  // one does. It stops on its own the moment the car does — this is paced by distance travelled.
  // A wet road throws water, not dust — `wetTyres` has the tyres while the ground under them is wet.
  const wetOut = (WET_TYRES.spray || WET_TYRES.tracks) && roadWet > WET_DUST_OFF;
  // And the handbrake U-turn, which is a slide from start to finish with neither pedal down.
  const sliding = car.uturn?.sp;
  if ((!car.boost && !car.braking && !sliding) || car.v < 2 || wetOut) { lastDustAt = car.travelled; return; }
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

/**
 * Cash out of the back of a boosting getaway. See game/cashtrail.js.
 *
 * **The gate is the robbery, not the boost**, and that is the one decision in this function. Money
 * off the back of any boosting taxi is a fun effect with nothing behind it — the player has not
 * got any money to lose, and the game already has a flying `$20` that means something precise. Off
 * the back of a *getaway* it is a picture of what is happening: a bag of notes in the back seat and
 * the lid off. It is one condition, so widening it to every boost is one word if that is wanted.
 *
 * Down here with the rubber, the dust and the plume, and for the reason they are: this is pinned to
 * where the car is *this* frame, after `traffic.update` has settled it. At the Loco top the taxi
 * covers 0.57 units in a frame, so a note emitted before that would leave the bumper visibly short.
 *
 * `deckHeightAt` rather than road level: the three river crossings are up to two units above the
 * water, and notes thrown off a bridge have to settle onto the deck rather than sink through it.
 */
function spillCash(dt) {
  const car = traffic.taxi;
  const spilling = boost.isActive() && fares.robbing() && !fares.state.gameOver;
  cashTrail.feed(dt, spilling, car, TAXI_TAILPIPE_HEIGHT + deckHeightAt(car.x, car.z).y);
}

// A police squeal, heard from where the taxi is. The camera follows the taxi, so distance from it
// is distance from the middle of the screen: full level inside COP_SQUEAL_NEAR, gone by
// COP_SQUEAL_FAR, which is about where a car leaves the frame on a phone at play zoom. Past that
// it is a car the player cannot see, and a squeal with nothing to hang it on reads as the taxi's.
// A touch of pitch spread so a fleet cornering in turn is four cars rather than one sample.
const COP_SQUEAL_NEAR = 18;
const COP_SQUEAL_FAR = 55;
function copSquealAt(x, z) {
  const d = Math.hypot(x - traffic.taxi.x, z - traffic.taxi.z);
  const level = Math.min(1, Math.max(0, (COP_SQUEAL_FAR - d) / (COP_SQUEAL_FAR - COP_SQUEAL_NEAR)));
  if (level > 0) sfx?.play('copSkid', { gain: level, rate: 0.94 + Math.random() * 0.12 });
}

// The siren, heard from where the taxi is: the nearest car with its siren running (`car.siren`, the
// same flag the bar and the wash are written off — a patrol giving chase, a robbery's cops, the
// arrest crew), full inside SIREN_NEAR and easing down to SIREN_FLOOR by SIREN_FAR. A floor rather
// than the squeal's silence past the edge of the frame, because a siren is the one sound that
// should carry: a chase on the far side of the map is still after *you*, and the off-screen wash
// (game/sirenglow.js) is already saying so with its light. The master is Block 2's
// `25_NPC_siren_loop`, -28.5 dB RMS against the crash's -26.3, so it ships at 0 dB.
const SIREN_NEAR = 18;
const SIREN_FAR = 70;
const SIREN_FLOOR = 0.35;
function sirenLevel() {
  let d = Infinity;
  for (const car of traffic.cars) {
    if (!car.siren || car.crashed) continue;
    d = Math.min(d, Math.hypot(car.x - traffic.taxi.x, car.z - traffic.taxi.z));
  }
  if (d === Infinity) return 0;
  const k = Math.min(1, Math.max(0, (SIREN_FAR - d) / (SIREN_FAR - SIREN_NEAR)));
  return SIREN_FLOOR + (1 - SIREN_FLOOR) * k;
}

// --- Block 2: the city's sounds ------------------------------------------------------------------
//
// Everything below is heard from somewhere. `placeAt` is the one place that says how far a point is
// from the listener and where it sits across the screen; the falloff itself is in mix.json's `place`
// (sfx.js `falloff`), so the ⚙️ panel can move it. See docs/audio.md.
//
// **The listener is the middle of the screen, not the taxi** (Tyler, October 2026): the player pans
// away to look at things, and panning over to the court should bring the court up. The camera
// follows the taxi while nobody is panning, so in play the two are nearly the same point. The siren
// and the cop squeal still measure from the taxi — they are about the taxi being chased.
const placeProbe = new THREE.Vector3();
function placeAt(x, z, y = 0) {
  const ear = controller.state.target;
  const d = Math.hypot(x - ear.x, z - ear.z);
  placeProbe.set(x, y, z).project(camera);
  // Framed as a phone (the ⚙️ panel's 📱), the screen's edges are the frame's, not the window's.
  return { d, pan: placeProbe.x * (phoneFrame?.panScale() ?? 1) };
}

// The street works: one zone a run, heard from the middle of its closed block while it stands.
function roadworkSpot() {
  const edge = roadwork.state.edge;
  const phase = roadwork.state.phase;
  if (!edge || phase === 'waiting' || phase === 'gone') return null;
  const net = cityNetwork();
  const a = net.nodeById.get(edge.a);
  const b = net.nodeById.get(edge.b);
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, level: roadwork.state.alpha ?? 1 };
}

// The barges' gulls: the barge carrying them nearest the listener, while it is on the river. A boat
// keeps its place as `x`/`z` (its `mesh` is the drawn hull); boats.js drops it from the list once
// it has sailed off, so anything in the list is on the water.
function nearestGulls() {
  const ear = controller.state.target;
  let best = null;
  for (const b of boats?.boats ?? []) {
    if (!b.gulls) continue;
    const d = Math.hypot(b.x - ear.x, b.z - ear.z);
    if (!best || d < best.d) best = { d, x: b.x, z: b.z };
  }
  return best;
}

// What the L's deck must not hide (game/ltrain.js): every rider waiting on a kerb and the drop-off
// pin of the fare aboard, neither of which has any other way of showing through. **Not the taxi**:
// it wears the ghost outline (geometry/ghostoutline.js), which traces it through the deck exactly
// as it does through a tower, so the deck stays solid over it the way a building does (Tyler,
// 2026-10-20: "why does the train track fade out around the taxi and not just stay solid like
// buildings"). A hole following the cab round was the one thing in the city that moved with it.
// `?trainfade=classic` thins the deck over the taxi as well, which is what it did before.
// Reused rather than allocated per frame.
const classicTrainFade = new URLSearchParams(window.location.search).get('trainfade') === 'classic';
const ltrainFade = [];
function ltrainFadePoints() {
  ltrainFade.length = 0;
  // Behind the title menu the subject is whatever the reel has cut to (game/titlereel.js).
  if (title?.holding() && titleReel && !storyCam) ltrainFade.push(...titleReel.fadePoints());
  const t = traffic.taxi;
  if (classicTrainFade) ltrainFade.push({ x: t.x, z: t.z });
  for (const slot of fares.slots) {
    for (const pin of [slot.passenger.group, slot.destination.group]) {
      if (!pin.visible || !slot.root.visible) continue;
      pin.getWorldPosition(ltrainProbe);
      ltrainFade.push({ x: ltrainProbe.x, z: ltrainProbe.z });
    }
  }
  return ltrainFade;
}
const ltrainProbe = new THREE.Vector3();

/** The ambient beds' levels for this frame — handed to `sfx.update` as `ambient`. */
function ambientLevels() {
  const t = traffic.taxi;
  const out = { city: { level: 1 } };
  const works = roadworkSpot();
  if (works) out.construction = { ...placeAt(works.x, works.z), level: works.level };
  if (props.court) out.court = placeAt(props.court.x, props.court.z);
  // The boom box's music goes here once there is a file for it: a bed keyed like the court's
  // (FILES, SOUNDS, PLACED, LOOPS, AMBIENT and LOOP_SECONDS in game/sfx.js), placed at its speakers —
  //   if (boombox.emitter) out.boombox = placeAt(boombox.emitter.x, boombox.emitter.z);
  // — and a pin for it beside the court's in `soundSources` below.
  const gulls = nearestGulls();
  if (gulls) out.seagulls = placeAt(gulls.x, gulls.z, 4);
  // The L's rumble, from the middle of the train and swelling with its own speed, so it rolls in and
  // out with the ramps at each end (`ltrain.emitter()` is null while the line is empty). Tyler's
  // recording of a train going by, its steady middle looped, so the falloff makes the pass-by.
  const el = ltrain?.emitter();
  if (el) out.ltrain = { ...placeAt(el.x, el.z, el.y), level: el.level };
  // Rain is where the taxi is: the squall's cell grown by the lens's reach, so it is heard a little
  // before the drops land; the storm is the whole city at once. Not placed — it is all around.
  const rainLevel = squall ? squall.rainNear(t.x, t.z, LENS_REACH) : storm ? storm.state.rain : 0;
  out.rain = { level: rainLevel };
  return out;
}

// The one-shots: read off each system's own counters and phases, so none of them needs a callback
// it did not already have. Every one is a no-op until the first tap has started the audio, and
// until its own file has decoded.
const birdCounts = flocks.map((f) => ({ up: f.state.flights, down: f.state.landings }));
let lastBridgePhase = drawbridge?.state.phase ?? null;
let bridgeVoice = null;
let bridgeSince = 0;
let lastFlights = flyover.state.flights;
let planeVoice = null;
let lastVisits = chopper.state.visits;
let heliVoice = null;
let lastOpeningPhase = null;
let spawnHeard = false;
let lastEntryT = 0;
// The aeroplane's run is ~10s of which the middle ~6 are on screen; the master is 7.25s, so it
// starts this far in, which centres it on the pass. It is steered by distance besides.
const PLANE_LEAD = 1.4;
// The drawbridge master is the whole cycle in one (26s), from the arms starting down. The deck
// clears *before* that (game/drawbridge.js), so a held span holds the sound back rather than
// stretching the middle of it. It is steered for as long as it can be sounding.
const BRIDGE_SECONDS = 26;
// The fade when the gates start rising: a time constant, so it is all but silent by ~0.75s.
const BRIDGE_CUT = 0.15;

function cityOneShots(dt) {
  if (!sfx) return;
  // The city building itself, once per entrance, on the first frame of it there is a context and a
  // decoded spawn take — `play` answers null until both, so this keeps asking for as long as the
  // city is still rising and gives up once it has risen. Not gated on `sfx.state.ready`: that waits
  // for all ~75 files, and on a slow decode the entrance was over first and the spawn never played.
  // Re-armed when the entrance's clock goes back to zero, which is the ⚙️ panel's replay.
  const entryT = cityEntry.time();
  if (entryT < lastEntryT) spawnHeard = false;
  lastEntryT = entryT;
  if (!spawnHeard && cityEntry.running() && sfx.play('spawn')) spawnHeard = true;

  // The depot's door going up at the start of a run. Only out of 'settle' — the repair visit's
  // second 'door' is the same door already running.
  const phase = opening?.phase?.() ?? null;
  if (phase === 'door' && lastOpeningPhase === 'settle' && garage) {
    sfx.play('gate', { at: placeAt(garage.entrySite.x, garage.entrySite.z) });
  }
  lastOpeningPhase = phase;

  // Pigeons: the frame a flock scatters (`takeOff`), and the frame the last of it is down.
  flocks.forEach((flock, n) => {
    const c = birdCounts[n];
    if (flock.state.flights !== c.up) {
      const p = flock.state.launch;
      sfx.play('birdsUp', { at: placeAt(p.x, p.z) });
    }
    if (flock.state.landings !== c.down) {
      const p = flock.centre();
      sfx.play('birdsDown', { at: placeAt(p.x, p.z) });
    }
    c.up = flock.state.flights;
    c.down = flock.state.landings;
  });

  // The drawbridge: the whole cycle in one file, from the barriers starting down.
  if (drawbridge) {
    const span = drawbridge.span;
    const at = placeAt(span.cx, (span.z0 + span.z1) / 2);
    const bp = drawbridge.state.phase;
    if (bp === 'closing' && lastBridgePhase !== 'closing') {
      bridgeVoice = sfx.play('bridge', { at, steered: true });
      bridgeSince = 0;
    }
    // Cut it as the gates start back up. The file runs the full 26s, and a lift that a boat
    // releases early has the deck home and the arms rising while the bell is still ringing.
    if (bp === 'raising' && lastBridgePhase !== 'raising' && bridgeVoice) {
      sfx.release(bridgeVoice, BRIDGE_CUT);
      bridgeVoice = null;
    }
    lastBridgePhase = bp;
    if (bridgeVoice) {
      bridgeSince += dt;
      sfx.steer(bridgeVoice, 'bridge', at);
      if (bridgeSince > BRIDGE_SECONDS) bridgeVoice = null;
    }
  }

  // The aeroplane, from its launch, steered as it crosses.
  if (flyover.state.flights !== lastFlights) {
    lastFlights = flyover.state.flights;
    const p = flyover.group.position;
    planeVoice = sfx.play('plane', { delay: PLANE_LEAD, at: placeAt(p.x, p.z, p.y), steered: true });
  }
  if (planeVoice) {
    const p = flyover.group.position;
    sfx.steer(planeVoice, 'plane', placeAt(p.x, p.z, p.y));
    if (!flyover.state.active) planeVoice = null;
  }

  // The rooftop helicopter, from the start of a visit to the moment it is gone.
  if (chopper.state.visits !== lastVisits) {
    lastVisits = chopper.state.visits;
    heliVoice = sfx.play('heli', {
      at: placeAt(chopper.state.x, chopper.state.z, chopper.state.y), steered: true,
    });
  }
  if (heliVoice) {
    sfx.steer(heliVoice, 'heli', placeAt(chopper.state.x, chopper.state.z, chopper.state.y));
    if (chopper.state.mode === 'away') { sfx.release(heliVoice, 0.6); heliVoice = null; }
  }
}

// The ⚙️ panel's ⚡ buttons (game/audiopanel.js): make the rare thing behind a sound happen now,
// rather than waiting a minute or three for it. Each one starts the *real* event — the systems'
// own `launch`/`visit`/`takeOff`/`request`, the ones shot mode stages with — so the sound arrives
// through `cityOneShots` above, placed and steered exactly as in play. Each answers null, or why
// it could not.
const soundTriggers = {
  spawn: () => { cityEntry.replay(traffic.taxi); replayLTrainIntro(traffic.taxi); return null; },
  plane: () => {
    if (flyover.state.active) return 'already crossing';
    flyover.launch();
    return null;
  },
  heli: () => {
    if (!chopper.group) return 'no helipad in this city';
    if (chopper.state.mode !== 'away') return 'already on a visit';
    chopper.visit();
    return null;
  },
  // The flock nearest the taxi, since a scatter is heard from where the birds are. Its landing,
  // `birdsDown`, follows on its own once it has settled again.
  birdsUp: () => {
    const grounded = flocks.filter((f) => f.state.mode === 'ground');
    if (!grounded.length) return 'every flock is in the air';
    const t = traffic.taxi;
    const dist = (f) => { const c = f.centre(); return Math.hypot(c.x - t.x, c.z - t.z); };
    grounded.reduce((a, b) => (dist(b) < dist(a) ? b : a)).takeOff();
    return null;
  },
  ltrain: () => {
    if (!ltrain) return 'no L train in this city';
    if (ltrain.state.phase === 'run') return 'already running';
    ltrain.launch();
    return null;
  },
  bridge: () => {
    if (!drawbridge) return 'no drawbridge in this city';
    if (drawbridge.state.phase !== 'open') return 'already cycling';
    // Lowered again by its own hold (HOLD_SECONDS in game/drawbridge.js) with no boat to wait for.
    drawbridge.request();
    return null;
  },
  // The walk-off, staged: a rider on one fixed kerb corner storms off with the purple curse bubble
  // (`fares.demoBail`), the camera peeks at them, and the sound plays from that corner — so what
  // is heard can be seen (Tyler, October 2026). Placed sounds are heard from the 👂, the camera's
  // target, and the peek is what brings the 👂 to that corner — so the sound is played as heard
  // from where the camera is going (full level, centred) rather than from where it starts. Placed
  // from the start of the pan, it could be past `far`, and a placed one-shot that far off is not
  // played at all: that is how this button once did nothing while the label blamed the min gap.
  angry: () => {
    if (!sfx?.state.ready) return 'no audio yet (tap the game)';
    const kerb = fares.demoBail();
    if (!kerb) return 'every rider slot is busy';
    releaseCameraToPlayer();
    controller.peekAt(kerb.x, kerb.z, () => traffic.taxi, () => { cameraTakenOver = false; });
    if (!sfx.play('angry', { at: { d: 0, pan: 0 } })) return 'inside its min gap';
    return null;
  },
};
soundTriggers.birdsDown = soundTriggers.birdsUp;

// ⏸ Hold (the ⚙️ panel): one moving source frozen where it is — its own update skipped, so the
// taxi and the rest of the city carry on — with its sound looping and steered off it, so the
// falloff can be tuned by driving to and from something that stays put. Held, a source is
// `{ sound, voice, flock? }`; `heldSounds` below loops each. Holding something that is not in the
// air sends it up first and steps it to where it can be seen. The L train is the exception to the
// looping: its sound is a bed, which `ambientLevels` already plays off the train for as long as it
// stands mid-run, so holding it only has to stop it moving.
const holds = { plane: null, heli: null, birds: null, ltrain: null };
const holdOf = (key) => (key === 'birdsUp' || key === 'birdsDown' ? 'birds' : key);
function heldAt(which) {
  if (which === 'plane') { const p = flyover.group.position; return placeAt(p.x, p.z, p.y); }
  if (which === 'heli') return placeAt(chopper.state.x, chopper.state.z, chopper.state.y);
  const c = holds.birds.flock.centre();
  return placeAt(c.x, c.z);
}
function setHold(key, on) {
  const which = holdOf(key);
  const held = holds[which];
  if (!on) {
    if (!held) return null;
    holds[which] = null;
    // The plane and the chopper go on with the loop playing out as their own voice, steered as
    // usual; the birds' scatter is only ever a one-shot, so it just fades.
    if (which === 'plane' && held.voice) { sfx?.unloop(held.voice); planeVoice = held.voice; }
    else if (which === 'heli' && held.voice) { sfx?.unloop(held.voice); heliVoice = held.voice; }
    else if (held.voice) sfx?.release(held.voice, 0.3);
    return null;
  }
  if (held) return null;
  let flock = null;
  if (which === 'ltrain') {
    if (!ltrain) return 'no L train in this city';
    // An empty line is sent a train and stepped to the middle of its run, over the city at cruise.
    if (ltrain.state.phase !== 'run') {
      ltrain.launch();
      for (let step = 0; step < 60 * 30 && ltrain.state.t < ltrain.runTime / 2; step++) ltrain.update(1 / 60);
    }
  } else if (which === 'plane') {
    if (!flyover.state.active) {
      flyover.launch();
      // To the middle of the run, which is over the city (`s` runs -RUN_MARGIN..RUN_MARGIN).
      while (flyover.state.active && flyover.state.s < 0) flyover.update(1 / 60);
    }
    lastFlights = flyover.state.flights;   // or `cityOneShots` starts its own pass on top
    if (planeVoice) { sfx.release(planeVoice, 0.2); planeVoice = null; }
  } else if (which === 'heli') {
    if (!chopper.group) return 'no helipad in this city';
    if (chopper.state.mode === 'away') {
      chopper.visit();
      // Down onto the pad; capped, in case a visit ever cannot finish its approach.
      for (let step = 0; step < 60 * 30 && !['settle', 'idle'].includes(chopper.state.mode); step++) {
        chopper.update(1 / 60);
      }
    }
    lastVisits = chopper.state.visits;
    if (heliVoice) { sfx.release(heliVoice, 0.2); heliVoice = null; }
  } else {
    const t = traffic.taxi;
    const dist = (f) => { const c = f.centre(); return Math.hypot(c.x - t.x, c.z - t.z); };
    const seen = flocks.filter((f) => f.state.mode !== 'gone');
    if (!seen.length) return 'every flock has flown off';
    flock = seen.reduce((a, b) => (dist(b) < dist(a) ? b : a));
    // A flock on the ground is sent up and held a second into the climb, where it is in the air.
    if (flock.state.mode === 'ground') {
      flock.takeOff();
      for (let step = 0; step < 60; step++) flock.update(1 / 60);
    }
    const n = flocks.indexOf(flock);
    birdCounts[n].up = flock.state.flights;
    birdCounts[n].down = flock.state.landings;
  }
  holds[which] = { sound: key, voice: null, flock };
  return null;
}
/** Loop each held source's sound, aimed at where it is frozen. Every frame, after `cityOneShots`. */
function heldSounds() {
  if (!sfx) return;
  for (const which of Object.keys(holds)) {
    const held = holds[which];
    if (!held || which === 'ltrain') continue;
    const at = heldAt(which);
    if (!held.voice || held.voice.ended) held.voice = sfx.play(held.sound, { at, steered: true, loop: true });
    else sfx.steer(held.voice, held.sound, at);
  }
}
const soundHolds = Object.fromEntries(['plane', 'heli', 'birdsUp', 'birdsDown', 'ltrain'].map((key) => [key, {
  held: () => Boolean(holds[holdOf(key)]),
  set: (on) => setHold(key, on),
}]));

// The falloff circles for the ⚙️ panel (game/soundrings.js): every placed source the frame can
// name, so the panel's "Full within"/"Silent past" sliders have something to move.
const soundRings = sfx && debugMode ? createSoundRings(scene) : null;
// ...and a 🔊 pin over each, whose chips open the ⚙️ panel on that sound (game/soundpins.js).
const soundPins = sfx && debugMode ? createSoundPins({
  project: projectToScreen,
  viewport,
  onPick: (key) => debugPanel?.showSound(key),
  groundAt: groundUnder,
  onResize: (key, part, radius, done) => debugPanel?.setPlace(key, part, radius, done),
}) : null;
// Viewport pixels to the ground under them — the ring handles' drag.
const groundRay = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const groundHit = new THREE.Vector3();
function groundUnder(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  groundRay.setFromCamera(new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  ), camera);
  return groundRay.ray.intersectPlane(groundPlane, groundHit) ? { x: groundHit.x, z: groundHit.z } : null;
}
const screenRight = new THREE.Vector3();
// Where the panel's ▶ plays a sound from: its pin nearest the 👂 (the birds have one per flock),
// measured the way the game measures it. Null for a sound with no pin on the map right now.
function soundPlace(key) {
  const ear = controller.state.target;
  let best = null;
  for (const s of soundSources()) {
    if (s.key !== key) continue;
    if (!best || Math.hypot(s.x - ear.x, s.z - ear.z) < Math.hypot(best.x - ear.x, best.z - ear.z)) best = s;
  }
  return best ? placeAt(best.x, best.z, best.y ?? 0) : null;
}
function soundSources() {
  const out = [];
  const works = roadworkSpot();
  if (works) out.push({ key: 'construction', x: works.x, z: works.z });
  if (props.court) out.push({ key: 'court', x: props.court.x, z: props.court.z });
  const gulls = nearestGulls();
  if (gulls) out.push({ key: 'seagulls', x: gulls.x, z: gulls.z });
  if (garage) out.push({ key: 'gate', x: garage.entrySite.x, z: garage.entrySite.z });
  // Not placed — the speaker plays at full level while the taxi is in the lot — but it has a spot on
  // the map, so it gets a pin to find its controls by. No `place` entry, so no rings.
  if (burger) out.push({ key: 'driveThru', x: burger.entrySite.x, z: burger.entrySite.z });
  if (drawbridge) {
    const span = drawbridge.span;
    out.push({ key: 'bridge', x: span.cx, z: (span.z0 + span.z1) / 2 });
  }
  for (const flock of flocks) {
    const c = flock.centre();
    out.push({ key: 'birdsUp', x: c.x, z: c.z }, { key: 'birdsDown', x: c.x, z: c.z });
  }
  if (chopper.state.mode !== 'away') {
    out.push({ key: 'heli', x: chopper.state.x, z: chopper.state.z, y: chopper.state.y });
  }
  if (flyover.state.active) {
    const p = flyover.group.position;
    out.push({ key: 'plane', x: p.x, z: p.z, y: p.y });
  }
  // The L train, from its middle while it runs — where its bed plays from (`ambientLevels`).
  const train = ltrain?.emitter();
  if (train) out.push({ key: 'ltrain', x: train.x, z: train.z, y: train.y });
  return out;
}

// The drive-through's speaker, once per visit — the player's, never an ambient car's: on the frame
// the lot takes the taxi, faded out on the frame it hands it back. The visit is timed to the clip
// (TAXI_ORDER_DWELL in game/drivethru.js) with two seconds to spare, so the fade has nothing left
// to trim unless the lane was queued.
// The radio ducks for the length of it, or the speaker is under the music.
let driveThruVoice = null;
function driveThruSpeaker() {
  const inLot = Boolean(burgerRun?.holdsTaxi());
  if (inLot && driveThruVoice == null) {
    driveThruVoice = sfx?.play('driveThru') ?? false;
    sfx?.duckMusic(true);
  }
  if (!inLot && driveThruVoice != null) {
    if (driveThruVoice) sfx.release(driveThruVoice, 0.4);
    sfx?.duckMusic(false);
    driveThruVoice = null;
  }
}

// Cops in a chase — the robbery's and the patrol's — lay rubber and squeal the way the taxi does — corners carried at
// speed, their own overtake, and the swing into a roadblock. The rule is `copLaysRubber` in
// sim/traffic.js; this is only the pools. Rear wheels off the anchors the ambient body is built
// at, and per car, so spacing and the once-per-slide squeal each follow their own car.
const COP_REAR = wheelAnchors(CAR_LEN, CAR_W).find((w) => !w.front && w.z > 0);
const copSkidAt = new WeakMap();
const copWasSliding = new WeakSet();
/**
 * Rubber off the street race's loser as it skids in beside the winner — the cop's stamp (`copRubber`)
 * off its two back wheels, scaled up for the taxi, whose drawn body is TAXI_SCALE longer.
 */
function raceRubber() {
  const car = raceSkid;
  if (!car || car.v < 0.5) { raceSkidAt = -Infinity; return; }
  if (car.travelled - raceSkidAt < 0.42) return;
  raceSkidAt = car.travelled;
  const k = car.isTaxi ? TAXI_SCALE : 1;
  const fx = Math.cos(car.yaw);
  const fz = -Math.sin(car.yaw);
  const rx = Math.sin(car.yaw);
  const rz = Math.cos(car.yaw);
  for (const side of [-1, 1]) {
    skids.add(car.x + (fx * COP_REAR.x + rx * side * COP_REAR.z) * k,
      car.z + (fz * COP_REAR.x + rz * side * COP_REAR.z) * k, car.yaw);
  }
}

// The burnout on the line (Tyler: "when holding loco during the countdown have the taxi doing a
// braked burnout (wheels spinning, smoke, fire tailpipes etc."): the pill down through the count
// with the taxi held on `parked`. The tailpipe plume is already burning — Loco Mode is on, and
// `locoFlame` does not ask whether the car is moving — so this is everything a held car cannot
// produce off distance travelled: white smoke boiling off the back tyres, rubber building up under
// them, the squeal, and the body squatting and shaking on its springs. The rear wheels are part of
// the merged shell (geometry/taxi.js), so they cannot be turned on their own; the smoke and the
// shake are what say they are spinning. `?raceburnout=classic` keeps a still car with the plume.
const raceBurnoutOn = new URLSearchParams(window.location.search).get('raceburnout') !== 'classic';
// One puff off each back tyre this often. 2 / 0.07 × LIFE (1.05s) ≈ 30 live puffs of the dust
// pool's 200, so the rest of the city's dust is not starved.
const BURNOUT_PUFF_EVERY = 0.07;
const BURNOUT_PUFF_SCALE = 1.35;
// A pair of marks every so often, so the patch darkens the longer it is held.
const BURNOUT_RUBBER_EVERY = 0.3;
// A squeal on the press and again while it is held. The takes are ~0.8s.
const BURNOUT_SQUEAL_EVERY = 1.1;
// The shake: nose up (the tail squats under power) and a fast roll and pitch shiver, in radians.
const BURNOUT_SQUAT = 0.035;
const BURNOUT_SHIVER = 0.018;
const burnout = { on: false, t: 0, puff: 0, rubber: 0, squeal: 0 };

function raceBurnout(dt) {
  const car = traffic.taxi;
  const on = raceBurnoutOn && Boolean(race?.burningOut()) && !fares.state.gameOver;
  if (!on) {
    if (burnout.on) {
      burnout.on = false;
      car.joltRoll = 0;
      car.joltPitch = 0;
    }
    return;
  }
  if (!burnout.on) {
    burnout.on = true;
    burnout.t = 0;
    burnout.puff = 0;
    burnout.rubber = 0;
    burnout.squeal = 0;
  }
  burnout.t += dt;
  // Eased in over a fifth of a second, so it winds up rather than switching on.
  const k = Math.min(1, burnout.t / 0.2);
  car.joltPitch = k * (BURNOUT_SQUAT + BURNOUT_SHIVER * Math.sin(burnout.t * 47));
  car.joltRoll = k * BURNOUT_SHIVER * Math.sin(burnout.t * 59 + 1.3);

  const fx = Math.cos(car.yaw);
  const fz = -Math.sin(car.yaw);
  const rx = Math.sin(car.yaw);
  const rz = Math.cos(car.yaw);
  burnout.puff -= dt;
  if (burnout.puff <= 0) {
    burnout.puff += BURNOUT_PUFF_EVERY;
    for (const side of [-1, 1]) {
      dust.add(
        car.x - fx * TAXI_REAR_AXLE_BACK + rx * side * TAXI_REAR_TRACK,
        car.z - fz * TAXI_REAR_AXLE_BACK + rz * side * TAXI_REAR_TRACK,
        car.yaw, BURNOUT_PUFF_SCALE, 0.45,
      );
    }
  }
  burnout.rubber -= dt;
  if (burnout.rubber <= 0) {
    burnout.rubber += BURNOUT_RUBBER_EVERY;
    stampRearRubber(car);
  }
  burnout.squeal -= dt;
  if (burnout.squeal <= 0) {
    burnout.squeal += BURNOUT_SQUEAL_EVERY;
    sfx?.play('skid', { gain: 0.7 });
  }
}

function copRubber() {
  for (const car of traffic.policeCars) {
    const sliding = copLaysRubber(car);
    if (sliding && !copWasSliding.has(car)) copSquealAt(car.x, car.z);
    if (sliding) copWasSliding.add(car); else copWasSliding.delete(car);
    if (!sliding) { copSkidAt.set(car, car.travelled); continue; }
    if (car.travelled - (copSkidAt.get(car) ?? -Infinity) < 0.42) continue;
    copSkidAt.set(car, car.travelled);
    const fx = Math.cos(car.yaw);
    const fz = -Math.sin(car.yaw);
    const rx = Math.sin(car.yaw);
    const rz = Math.cos(car.yaw);
    for (const side of [-1, 1]) {
      skids.add(
        car.x + fx * COP_REAR.x + rx * side * COP_REAR.z,
        car.z + fz * COP_REAR.x + rz * side * COP_REAR.z,
        car.yaw,
      );
    }
  }
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

// The title screen: Play, Settings, Credits, over the live city — see game/titlescreen.js. It parks
// the run on the same terms the Home Screen tip does (`parked()` below), and Play is what lets the
// run begin. Not in shot mode, not on `?title=off` (the escape hatch `?vignette=off` is, for anyone
// iterating on the run itself), and not on the reload "Play again" does — that player has already
// pressed Play once.
const TITLE_SKIP_KEY = 'simTaxi.skipTitle';
function skipTitleNextLoad() {
  try { window.sessionStorage.setItem(TITLE_SKIP_KEY, '1'); } catch { /* soft: they see the menu */ }
}
function consumeTitleSkip() {
  try {
    const skip = window.sessionStorage.getItem(TITLE_SKIP_KEY) === '1';
    window.sessionStorage.removeItem(TITLE_SKIP_KEY);
    return skip;
  } catch { return false; }
}
// One line of the backstory read out, for `tellBackstory`: null when there is nothing to hear (muted,
// not decoded yet, `?introvo=classic`), and the line is told in text alone.
function speakBackstory(i) {
  const name = BACKSTORY_VOICES[i];
  const voice = name && backstoryVoiced() ? sfx?.play(name) : null;
  if (!voice) return null;
  return {
    seconds: voice.src.buffer.duration,
    stop: () => sfx.release(voice, 0.08),
    ended: () => Boolean(voice.ended),
  };
}
function startBackstory(screen, done) {
  tellBackstory(screen, { done, speak: speakBackstory });
  // The camera goes to the garage and drifts there while dispatch talks (`storyFrame`) — so Play
  // then eases down onto the door from close by. Off the slide it flies there (`STORY_GLIDE`),
  // one continuous shot (Tyler, 2026-10-22); off the reel, which is all cuts, it cuts under the
  // wipe, and so does reduced motion.
  const glide = !titleReel && !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const atGarage = () => {
    titleReel?.clear();
    const { target, zoom } = controller.state;
    storyCam = { t: 0, glide, from: { x: target.x, z: target.z, zoom } };
  };
  if (opening) { if (wipe && !glide) wipe.cut(atGarage); else atGarage(); }
}
/**
 * Demo mode holds between Play and the story for one more tap anywhere (or Enter/Space), so the
 * presenter can talk over the city first (Tyler, 2026-10-25). Nothing on screen says so — a prompt
 * would be talking to the audience. The camera stays on the title's slow slide meanwhile, which is
 * built to be watched for minutes, and the glide to the garage waits for the tap: the story's own
 * drift moves 0.35 units a second and would have wandered ~20 units off the door over a minute's
 * preamble.
 */
function holdForPreamble(screen, then) {
  const layer = document.createElement('div');
  layer.className = 'title-story';
  screen.append(layer);
  const go = (event) => {
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    layer.remove();
    window.removeEventListener('keydown', go, true);
    then();
  };
  layer.addEventListener('click', go);
  window.addEventListener('keydown', go, true);
}
const wantsTitle = !shot && !devMode && !consumeTitleSkip()
  && new URLSearchParams(window.location.search).get('title') !== 'off';
const title = wantsTitle ? createTitleScreen(document.getElementById('title-screen'), {
  sound: soundSwitch,
  settings,
  demo,
  // The first Play on a device hears dispatch out first, over the backdrop, with the gate still shut —
  // see game/backstory.js. `?intro=classic` goes straight to the garage as before.
  beforePlay: (done) => {
    if (!wantsBackstory(backstoryMode({ always: settings.get().introAlways }))) return false;
    const screen = document.getElementById('title-screen');
    if (demo.on()) { holdForPreamble(screen, () => startBackstory(screen, done)); return true; }
    startBackstory(screen, done);
    return true;
  },
  onPlay: () => {
    beginRun();
    // Play jump cuts to the depot under the wipe, rather than easing down onto it from wherever
    // the reel had the camera: the reel is a run of cuts, and a swoop out of it reads as a new
    // kind of move. The slide (and the classic ellipse) keeps its ease — that is one continuous shot.
    // Already beside the garage after the backstory: the approach eases in from there.
    if (storyCam) { storyCam = null; titleReel?.clear(); return; }
    if (!titleReel) return;
    titleReel.clear();
    if (wipe && opening) wipe.cut(() => opening?.cutToDoor());
    else opening?.cutToDoor();
  },
}) : null;
// The title's backdrop is one slow slide across the city (`panAt` in game/titlescreen.js, Tyler
// 2026-10-22). `?titlecam=reel` is the reel of jump cuts round the landmarks it replaced
// (game/titlereel.js), each a few seconds with a slow drift. Each shot is aimed at its subject's
// middle, at that height: the players' chests, the skaters', the train's roof rail, and halfway up
// the burger joint's pole.
const titleReel = title && TITLE_CAM === 'reel'
  ? createTitleReel({
    cover: title.cover,
    still: () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    shots: [
      hoopers.court && { name: 'court', at: () => ({ x: hoopers.court.x, y: 1.5, z: hoopers.court.z }) },
      skaters.park && { name: 'skatepark', at: () => ({ x: skaters.park.x, y: 1, z: skaters.park.z }) },
      ltrain && {
        name: 'train', live: true, at: () => ltrain.subject(), minLeft: () => ltrain.islandLeft(),
      },
      burger && {
        name: 'burger',
        at: () => ({
          x: (burger.site.focus.x + burger.site.signAt.x) / 2,
          y: (burger.site.focus.y + burger.site.signAt.y) / 2,
          z: (burger.site.focus.z + burger.site.signAt.z) / 2,
        }),
      },
    ].filter(Boolean),
  }) : null;
// The backstory's shot (game/backstory.js): set under the wipe once the story is up, null otherwise.
// A slow slide along screen-right past the garage door, wider than the door shot Play lands on.
let storyCam = null;
const STORY_ZOOM = 24;
const STORY_DRIFT = 0.35;   // world units a second along screen-right
const STORY_FROM = -3;      // where the slide starts, along screen-right of the door
/**
 * Seconds for the flight from the title's slide down to the story's shot. A blend of the two moving
 * frames rather than an ease toward the second: the weight runs 0 to 1 on a smootherstep, so the
 * camera leaves at exactly the slide's own speed and arrives at exactly the story drift's — an
 * exponential ease (`focusOn`) does its fastest moving on the first frame, which reads as a lurch
 * out of a shot that was barely moving. The far side of the map from the garage is ~60 units, so
 * 3.5 s peaks near 32 units a second, about the taxi's Loco top speed.
 */
const STORY_GLIDE = 3.5;
function storyFrame(dt) {
  storyCam.t += dt;
  const door = opening.doorAt();
  const across = STORY_FROM + storyCam.t * STORY_DRIFT;
  return { x: door.x + RIGHT.x * across, z: door.z + RIGHT.z * across, zoom: STORY_ZOOM };
}
// The camera cuts onto the drift on the first frame the title holds, rather than easing to it from
// wherever boot left it — the menu's first frame is the first frame anyone sees.
let titleFramed = false;

/** Is the run parked behind a screen that has to be answered first? */
function parked() {
  return Boolean(homeTip?.state.holding) || Boolean(title?.holding());
}

/**
 * The run starting: Play on the title screen, or boot itself when there is no title screen. The
 * one thing decided here rather than at boot is the tips — they are a setting the player can flip
 * on the title screen moments before pressing Play.
 */
let runBegun = false;
function beginRun() {
  runBegun = true;
  sfx?.goOnAir({ dash: dashRadio });
  if (!tipsOn()) dropTutorial();
}
function dropTutorial() {
  if (!tutorial) return;
  tutorial.stop();
  tutorial = null;
  tutorialTalking = false;
  holdFareClocks();
  revealHud();
}
// The pause screen's Settings has the tips switch too. Off mid-run silences a tutorial still
// talking; on again cannot bring it back, but the New Move cards read the setting live and resume.
// Before Play it waits for `beginRun` — dropping it under the title screen would let the HUD in.
settings.onChange((v) => { if (runBegun && !v.tips && !demo.on()) dropTutorial(); });
if (!title) beginRun();

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
//
// A skipped vignette (the `wipe` above) carries the hold the last few frames to the same rule read
// literally: the taxi is on the road from the moment the skip lands, but the screen is still black
// for a beat after that, and a board seeded under it opens the run with a rider whose entrance the
// player never saw.
const NO_FARE_EVENTS = [];
/**
 * Is the taxi on the road and the screen the player's to see? Not before the vignette's handover
 * (a staged car has nowhere to boost to, and fuel spent on one is simply lost), not behind a
 * skip's black or the Home Screen tip, and not while the city is still building itself, which
 * `?vignette=off` would otherwise put the pedals on top of.
 */
let pedalsShown = false;
const pedalsDue = () => !cityEntry.running() && !parked() && !wipe?.covering()
  && !(opening?.running() && opening.phase() !== 'release');

// The pedals on screen and the taxi the player's to drive: `pedalsDue`, less a repair visit until it
// hands back. The HUD's exit reads it too, so a pedal can be pressed exactly when it can be seen.
const pedalsLive = () => pedalsDue()
  && !(opening?.visiting() && opening.phase() !== 'release');

const fareLoopHeld = () => parked() || Boolean(opening?.running())
  || Boolean(wipe?.covering());

// The ⏸ at the top of the HUD. Unlike the two holds above it this one stops the *whole* frame (see
// the early return in `frame()`), because a pause the player asked for has to give back a city in
// the state they left it — a fare clock held while the traffic kept driving would hand the taxi's
// own junction back with a car in it.
const pause = shot ? null : createPause({
  button: document.getElementById('pause'),
  veil: document.getElementById('pause-veil'),
  demo,
  // Nothing left to hold once the run is over — and the retry screen owns the whole display then.
  // Never asked on the way out: a pause can always be lifted.
  canPause: () => !fares.state.gameOver && !title?.holding(),
  sound: soundSwitch,
  settings,
  // Quit abandons the run: a reload without the "Play again" skip flag lands back on the title —
  // but not through the logo smash again, which this player already watched on the way in.
  onQuit: () => {
    try { window.sessionStorage.setItem(SPLASH_SKIP_KEY, '1'); } catch { /* soft: they see the logo */ }
    location.reload();
  },
  onChange: (paused) => {
    // A pause with the gas still down would resume into a boost the player is no longer holding —
    // the pill's own pointer never comes back up, because the veil took the release. Same reason
    // the window's `blur` handler drops it. The brake is dropped with it: the veil swallows that
    // release too, and resuming onto a pedal nobody is holding is the same bug wearing red.
    // `dropPedalGesture` covers a thumb that was on the row when the veil went up; the two explicit
    // releases beside it are for the keyboard's holds, which it knows nothing about.
    if (paused) { boost.release(); releaseBrake(); dropPedalGesture(); bootleg.reset(); overtake.reset(); }
  },
});

// "New Move Unlocked": the card that teaches the overtake, the bootleg and the drift, each once ever,
// once a run has reached that move's `after` fares (MOVES in game/newmove.js). By default it goes up
// after the run, behind the high-score table and before Play again (`showUnlockedMoves`); under
// `?newmove=classic`, a beat after the drop-off that unlocked it, mid-run. The world stops while it
// is up — the early return in `frame()` beside the robber's line's. See game/newmove.js for why.
// Centred over a dim, with the move acted out inside it on a real street of this city — see
// game/moveclip.js. The street (or for the drift, the corner) is chosen when the card opens, off the
// cars where they stand then, since they stay there until it closes.
const freezeFrame = document.getElementById('freeze-frame');
const clipSite = () => ({
  network: cityNetwork(),
  cars: traffic.cars,
  camRight: new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0),
  visible: (x, z) => sightlineClear(x, 0.4, z),
  closed: isLaneClosed,
});
const clipStage = (cardCanvas) => ({
  scene, camera, renderFrame, canvas: renderer.domElement, freeze: freezeFrame, cardCanvas,
});
// The player's taxi and the ambient traffic, as meshes — what a clip takes out of shot to film on a
// street that has cars on it. Meshes only, so none of this changes the light count (the cruiser,
// which carries lamps, stays: CLAUDE.md).
const trafficMeshes = () => [traffic.taxiGroup, traffic.mesh, ...traffic.classicDrawn, traffic.wheelMesh,
  traffic.truckMesh, traffic.truckWheelMesh,
  traffic.truckBoxMesh, traffic.bumperMesh, traffic.truckBumperMesh, ...traffic.emissiveMeshes,
  ...carDamage.meshes];
/**
 * A move's clip, filmed where `pick` says. A street with a car parked on it is passed over, since
 * the city stays frozen under the card — and late in a long run, with traffic at its densest, that
 * can be every street there is: the overtake's picker, which wants a whole ring-road side clear,
 * came up empty on one city in five at the end of a run, and the card went up as a bare title with
 * its keys stuck on their first frame (Tyler, 2026-10-13). So when nothing is clear it picks again
 * with the cars ignored and films with the traffic out of shot, put back when the card closes. The
 * still under the card is taken before they go, so the city behind it is the one the player left.
 */
const filmMove = (pick, make) => (cardCanvas) => {
  if (!freezeFrame) return null;
  const clear = pick(clipSite());
  if (clear) return make(clipStage(cardCanvas), clear);
  const anywhere = pick({ ...clipSite(), cars: [] });
  const clip = anywhere && make(clipStage(cardCanvas), anywhere);
  if (!clip) return null;
  const hidden = trafficMeshes().filter((mesh) => mesh?.visible);
  for (const mesh of hidden) mesh.visible = false;
  const dispose = clip.dispose.bind(clip);
  clip.dispose = () => {
    for (const mesh of hidden) mesh.visible = true;
    dispose();
  };
  return clip;
};
const moves = {
  overtake: {
    ...MOVES.overtake, seen: createSeenFlag({ key: MOVES.overtake.seenKey }), clipKeys: overtakeKeys,
    combo: { ...comboValue('overtake'), at: OVERTAKE_LANDS },
    makeClip: filmMove(pickOvertakeStreet, (stage, street) => createOvertakeClip({ ...stage, street })),
  },
  uturn: {
    ...MOVES.uturn, seen: createSeenFlag({ key: MOVES.uturn.seenKey }), clipKeys: uturnKeys,
    combo: { ...comboValue('uturn'), at: UTURN_LANDS },
    makeClip: filmMove(pickStreet, (stage, street) => createUturnClip({ ...stage, street })),
  },
  drift: {
    ...MOVES.drift, seen: createSeenFlag({ key: MOVES.drift.seenKey }), clipKeys: driftKeys,
    combo: { ...comboValue('drift'), at: DRIFT_LANDS },
    makeClip: filmMove(pickCorner, (stage, corner) => createDriftClip({ ...stage, corner })),
  },
};
// The depot's card, on the same layer: once ever, a beat after the taxi first starts smoking. It
// replaced a "Head to the shop for repairs." bubble over the garage door — see REPAIR in
// game/newmove.js and game/repairclip.js.
const repairCard = {
  ...REPAIR, seen: createSeenFlag({ key: REPAIR.seenKey }), clipKeys: repairKeys,
  makeClip: (cardCanvas) => freezeFrame && garage && createRepairClip({
    ...clipStage(cardCanvas), site: garage.site, setDoor: garage.setDoor, workshop: repairFx, sparks, dust,
    // The player's taxi, and the ambient traffic frozen wherever it stood — a car stopped on the
    // depot's lane sat on the stand-in's path.
    hide: trafficMeshes(),
  }),
};
// Seconds of game time until it lands, or negative while the car is not smoking.
let repairCardIn = -1;
// The line that replaced the card (game/depotcall.js) asks again every run — a card that stopped the
// world earned "once ever", one line over the fuel arc does not — but only until the player has
// sent the taxi in once: after that they know, and it would only be nagging. One per run (a run is
// a page load), so a car repaired and smoking again is left to know the way.
const repairUsed = createSeenFlag({ key: 'simTaxi.used.repair' });
let depotCallSaid = false;
// `?newmove=classic` puts the move cards back mid-run, a beat after the drop-off. The depot's card
// is not a move and stays mid-run either way: it is about the car smoking now.
const movesAfterRun = new URLSearchParams(window.location.search).get('newmove') !== 'classic';
// `?moveexit=classic`: the last card closes back onto the run-end table instead of playing again.
const moveExitClassic = new URLSearchParams(window.location.search).get('moveexit') === 'classic';
// "Play again" means the run, not the menu: the reload goes straight past the title screen.
function playAgain() { skipTitleNextLoad(); location.reload(); }
// The card's clip on polaroid paper and its keys in the HUD's own colours, without the glint
// (Tyler, 2026-10-20). `?movecard=classic` is the bare rounded clip and the greyed keys.
if (new URLSearchParams(window.location.search).get('movecard') === 'classic') {
  document.body.classList.add('move-card-classic');
}
// The card's combo meter and word over the clip, and the ring on the key to press next (Tyler,
// 2026-10-21; newmove.js). `?cardcombo=classic` is the bare clip and plain keys.
if (new URLSearchParams(window.location.search).get('cardcombo') === 'classic') {
  document.body.classList.add('card-combo-classic');
}
// The overtake card's keys grey unless held, with a ring filling round the held one (Tyler,
// 2026-10-22; newmove.js `holds`). `?overtakekeys=classic` is both keys orange once pressed.
if (new URLSearchParams(window.location.search).get('overtakekeys') === 'classic') {
  document.body.classList.add('overtake-keys-classic');
}
// Every flying price and rising word wears the speech card's dark outline (Tyler, 2026-10-25; the
// `.earning` rule in index.html). `?poptext=classic` is the soft drop shadow they had before.
if (new URLSearchParams(window.location.search).get('poptext') === 'classic') {
  document.body.classList.add('poptext-classic');
}
// What a closing card hands over to — the next card of the run's queue (`showUnlockedMoves`).
let afterNewMove = null;
const newMove = shot ? null : createNewMove({
  viewport, onClose: () => afterNewMove?.(),
  // The HUD's own combo meter and word, played in the clip (newmove.js `comboOverlay`).
  comboMeter: { flame: comboFlameSvg(), colors: COMBO_FLAME, format: formatMult, tier: comboFlameTier },
});
// Seconds of game time until the card lands, or negative when none is due, and which move it is.
let newMoveIn = -1;
let newMoveDue = null;
/**
 * The move a drop-off at `delivered` fares would teach, or null: the first not yet seen, in order,
 * if the run is far enough in for it. In order means the drift waits for the U-turn's card, so one
 * drop-off never has two to show.
 */
function nextMove(delivered) {
  const move = Object.values(moves).find((m) => !m.seen.get());
  return move && delivered >= move.after ? move : null;
}
/**
 * Is this run one the card may still be shown in? The tips setting and debug mode turn it off the
 * way they turn off the opening tutorial (read live: the setting can flip on the title screen), and
 * it waits out the tutorial's Loco Mode beat — a move built on Loco Mode means nothing to someone
 * who has not been shown it yet.
 */
const newMoveWanted = (move = newMoveDue) => Boolean(newMove) && Boolean(move) && !move.seen.get()
  && wantsTutorial && tipsOn() && (!tutorial || tutorial.state.step === 'done');
/**
 * Is now a calm beat? Checked when the delay runs out rather than at the drop-off, because the
 * drop-off of a robber *starts* a patrol chase, and anything that has taken the taxi or the screen
 * in the meantime outranks a lesson. A beat that is not calm is skipped, and the next drop-off
 * tries again.
 */
const newMoveCalm = () => !fares.state.gameOver && !traffic.taxi.crashed
  && !robbery?.state.active && !patrol.busy() && !robberLine?.isOpen()
  && !opening?.visiting() && !depotRun?.active() && !burgerRun?.holdsTaxi()
  && !replay?.active() && replayAt === null;
/**
 * The run is over and its high-score table has landed: the first move it unlocked that has not been
 * shown yet, then `done` (the run-end screen's Play again). Answers false when there is
 * nothing to show. Over the blackout rather than instead of it (`body.new-move-after-run`), so the
 * card closes back onto the run's own screen; the clip still films the city under it.
 */
function showUnlockedMoves(done) {
  if (!movesAfterRun || !newMove) return false;
  // One card per run's end, the first not yet shown (Tyler, 2026-10-13); a run that unlocked more
  // leaves the rest for the runs after it, which still have to reach each one's `after`.
  // Demo mode shows one every run, however short, taking the moves in turn across runs — with every
  // flag unseen, "the first not yet shown" would be the overtake every time.
  const queue = demo.on()
    ? [demo.rotate(Object.values(moves).filter((m) => newMoveWanted(m)), 'move')].filter(Boolean)
    : Object.values(moves).filter((m) => newMoveWanted(m) && fares.state.delivered >= m.after)
      .slice(0, 1);
  if (!queue.length) return false;
  document.body.classList.add('new-move-after-run');
  const next = () => {
    const move = queue.shift();
    if (!move) {
      afterNewMove = null;
      // Straight into the next run: the blackout stays up through the reload, rather than the
      // table flashing back for the frames before the page goes.
      if (done !== playAgain) document.body.classList.remove('new-move-after-run');
      done();
      return;
    }
    afterNewMove = next;
    if (!openNewMove(move)) next();
  };
  next();
  return true;
}
/** The depot's line, if the run will take it now — the card's gates, read the same way. */
function sayDepotCall() {
  if (!wantsTutorial || !tipsOn() || (tutorial && tutorial.state.step !== 'done')) return false;
  if (!newMoveCalm() || newMove?.isOpen()) return false;
  depotCall.show();
  depotCallSaid = true;
  return true;
}
function openNewMove(move = newMoveDue ?? moves.uturn) {
  if (!newMove?.open(move)) return false;
  move.seen.set();
  // Same releases as the pause, for the same reason: the card takes the release of anything held.
  boost.release(); releaseBrake(); dropPedalGesture(); bootleg.reset(); overtake.reset();
  return true;
}

const clock = new THREE.Clock();
// `?bench` — the on-device benchmark, built at the bottom of this file once everything it drives
// exists. See game/bench.js.
let bench = null;

// The rAF callback is a wrapper so the bench can time the whole of `tick`, early returns and all.
// Still named `frame`: tools/perf.mjs closes its per-frame counters on the callback's name.
// The frame-rate cap: `?fps=30` or the Settings choice. Under 30 every other vsync is skipped
// outright — nothing is stepped or drawn — and `tick` picks up the longer gap through the clock's
// own delta. The 4 ms of slack is so a vsync that lands a hair early is not skipped as well, which
// would drop the rate to 20.
// Set by the talk's `presenter.hold()` — read by the early returns in `tick` below.
let presenterHeld = false;
const fpsPin = Number.parseInt(new URLSearchParams(window.location.search).get('fps'), 10);
const frameRateCap = () => (shot ? 60 : fpsPin > 0 ? fpsPin : qualityOf(settings.get()).frameRate);
let lastFrameAt = 0;

function frame(t) {
  requestAnimationFrame(frame);
  // The startup screen is drawing over the whole page (game/splash.js): nothing here would be seen,
  // and a city frame behind it is GPU the drop needs. The sim waits too — the dt clamp below is the
  // whole of the catch-up when it lets go, and the governor ignores a gap that long.
  if (splashCovers()) return;
  if (frameRateCap() < 60 && t - lastFrameAt < 1000 / frameRateCap() - 4) return;
  lastFrameAt = t;
  // Only frames of live play count toward the governor: a paused or finished run is cheap and
  // would read as headroom. It goes *before* the draw, never after: a step resizes the canvas,
  // which empties it, and a canvas emptied after this callback has drawn is what gets composited —
  // the page's pale sky (#dcedf7) for a whole frame, two under the 30 fps cap, reported as a white
  // flash across the screen. Headless under `?squall&fps=30`, 4 of the run's 6 resizes landed
  // that way before the move and none after.
  governor.frame(t, !pause?.state.paused && !presenterHeld && !fares.state.gameOver && !document.hidden);
  hitch.begin(t);
  bench?.begin(t);
  tick();
  bench?.end();
  hitch.end();
}

// `?hitch`: frames that arrive late, and what was on screen when they did — see game/hitch.js.
const hitch = createHitchLogger(renderer, {
  enabled: getHitchLogger(),
  cap: frameRateCap,
  probes: {
    glass: () => document.querySelector('.speech-liquid.is-open:not([hidden])'),
    speech: () => document.querySelector('.speech-glass.is-open:not([hidden])'),
    truck: () => garbage.state.truck,
    paused: () => pause?.state.paused,
  },
});

let edgeFogTime = 0;
// Whether the radio is ducked under the robber's line — see `sfx.hold` in `tick`.
let robberDucked = false;
function tick() {
  // Read on every frame, paused or not: `getDelta` measures from its own last call, so skipping it
  // while paused would hand the first frame after a resume the whole length of the pause. The clamp
  // caps that at 0.05s — not a teleport, but still a frame of city the player never saw, and the
  // clamp is there to survive a stalled tab rather than to license stalling on purpose.
  let dt = Math.min(clock.getDelta(), 0.05);

  // Paused. Nothing updates — not the traffic, not the clocks, not the sky — but the frame is still
  // drawn: with `preserveDrawingBuffer` off, a resize or a rotation with the veil up repaints the
  // canvas from an empty buffer, and the city would blink out until the player resumed.
  // The sound stops with the world — the pause below, and the talk's presenter hold — and starts
  // with it again. Not under the robber's line, though it freezes the world the same way:
  // suspending the context there cut off the cab door the robber had just opened mid-sample, a
  // click and a ding, and took the radio with it, so the getaway opened on what sounded like the
  // game breaking. The radio ducks under the line instead, and the city keeps its hum while the
  // world holds still.
  sfx?.hold(Boolean(pause?.state.paused || newMove?.isOpen() || inspect?.state.on || presenterHeld));
  const robberTalking = Boolean(robberLine?.isOpen());
  if (robberTalking !== robberDucked) { robberDucked = robberTalking; sfx?.duckMusic(robberTalking); }
  // Drawn once, not every frame. Nothing in the world moves while paused, and a canvas that is not
  // drawn keeps showing its last frame — so drawing the same still sixty times a second was pure
  // heat and battery, for as long as the player left the game paused. `stillDrawn` is cleared on a
  // resize, which is the one thing that empties the buffer under a pause (see the note above).
  if (pause?.state.paused) {
    if (!stillDrawn) renderFrame();
    stillDrawn = true;
    return;
  }
  stillDrawn = false;
  // `?debug`'s inspect mode: the same freeze as the pause with nothing drawn over the city, and the
  // camera handed to game/inspect.js — which moves it from input events, so all this has to do is
  // draw.
  if (inspect?.state.on) {
    renderFrame();
    return;
  }
  // Held by the talk at /talk/ (see the `presenter` handle on `window.__taxi`): the same freeze
  // again, for the slide that shows the game as a still before it comes alive. Drawn every frame
  // rather than once, because the talk moves the camera's projection under the hold.
  if (presenterHeld) {
    renderFrame();
    return;
  }

  // The robber's line is up. The world stops exactly as it does for the pause — nothing updates,
  // the frame is still drawn — and only the bubble ticks, on wall time, since there is no game time
  // passing. See game/robberline.js for why this beat stops the world rather than running over it.
  if (robberLine?.isOpen()) {
    robberLine.update(dt);
    renderFrame();
    return;
  }
  // The bank job's cut: the same freeze, with the cut itself — robber, bystander, alarm, notes,
  // camera — running on wall time. It hands over to the robber's line above when the robber is in.
  if (bankJob?.running()) {
    bankJob.update(dt, aspect());
    // The L's deck thins over the cut's own subjects rather than over wherever the taxi and the
    // pins were on the frame the world stopped (`fadePoints` in game/bankjob.js). Left as they are
    // for the robber's line after it, which is about the same cab.
    if (ltrain && !classicRobberyCam) ltrain.setFadePoints(bankJob.fadePoints());
    renderFrame();
    return;
  }
  // Slam it as the getaway starts — see `robberDoorOpen`. Waits out any other hold too (`play`
  // refuses while held), and a robbery over before then has no door left to shut.
  if (robberDoorOpen && !robberBoarding && !sfx?.state.held) {
    robberDoorOpen = false;
    if (robbery?.state.active && !fares.state.gameOver) sfx?.play('doorClose');
  }
  // The New Move card: the same freeze. Only the bubble ticks, to stay pinned to the pedal; the
  // pedal row's loop is CSS.
  if (newMove?.isOpen()) {
    // With a clip, the card draws the frame itself (through the clip camera, under the still).
    if (!newMove.update(dt)) renderFrame();
    return;
  }

  // Time dilation for the crash. Scale the whole frame's dt so the blast, the camera pull-in and
  // the shake decay all slow together — that's what sells it as a single cinematic beat rather than
  // one element being pushed around while everything else runs normally. Ramps linearly from
  // `slowMoMin` back to 1.0 across SLOW_MO_DURATION ms wallclock; the banner delay is separately
  // wallclock-anchored so this doesn't change when the retry screen appears. The depth is per
  // event — a wreck bottoms out at SLOW_MO_MIN, a bust much shallower so the chase still moves.
  const nowMs = performance.now();
  // Held before the crash dilation below, for the things that run on wall time — the replay, the
  // robbery glow, the crayon wobble — rather than slowing with the wreck.
  const wallDt = dt;

  // The crash replay holds the frame outright. Nothing in the world is stepped while it runs —
  // the tape is drawing it — so the whole update block below is skipped, exactly as it is for a
  // pause. The slow-mo ramp keeps running out on its wall clock underneath, so the world the replay
  // hands back to is already at full speed behind the card.
  if (replayAt !== null && nowMs >= replayAt) {
    replayAt = null;
    // A tape too short to reach back before the impact (a wreck in the first moments of a run)
    // has nothing to replay, and the card comes up on the old hold instead.
    // The live beat's last frame, pulled in on the wreck: the polaroid if the replay is tapped past.
    if (snapshot) {
      renderFrame();
      snapshot.grab(PHOTO.LIVE);
    }
    if (!replay.start()) crashBannerAt = nowMs + CRASH_BANNER_DELAY - REPLAY_LEAD;
  }
  if (replay?.active()) {
    replay.update(wallDt);
    // The last cut goes straight to the card, on this frame — see REPLAY_TAIL.
    if (!replay.active()) {
      crashBannerAt = nowMs;
      updateHud(0);
    }
    renderFrame();
    // The polaroid: the last, tightest cut, from the impact up to the first frame past PHOTO_AFTER.
    const at = replay.progress();
    if (snapshot && at && !replayPhotoDone && at.shot === REPLAY_SHOTS - 1 && at.u >= 0) {
      snapshot.grab(PHOTO.REPLAY);
      replayPhotoDone = at.u >= PHOTO_AFTER;
    }
    return;
  }

  // Crushin' It's beat is read every frame so it can let go on its own clock, and under the wreck
  // or the Big Air hang it takes whichever is slower — a crush lands on the hang's last few percent,
  // where the hang is already back near 1.
  const crushScale = crushSlowMo.scale(nowMs, crushPops.length > 0);
  if (nowMs < slowMoUntil) {
    const t = 1 - (slowMoUntil - nowMs) / SLOW_MO_DURATION;
    dt *= Math.min(crushScale, slowMoMin + (1 - slowMoMin) * t);
  } else if (onDriftLaunch(traffic.taxi)) {
    dt *= Math.min(crushScale, launchTimeScale(hopProgress(traffic.taxi),
      traffic.taxi.hopKind === 'bridge' ? MEGA_SLOW_MO_MIN : LAUNCH_SLOW_MO_MIN));
  } else {
    dt *= crushScale;
  }
  simClock += dt;

  // A taxi at a pickup window cannot move, and a pill leaned on there would pour the whole tank
  // into a parked car — fifteen seconds of it, if the queue in front is two cars deep. Released
  // every frame rather than once on the way in, for the reason the flags below are written every
  // frame: a thumb that never comes back up must not be able to leave the pedal stuck down. The
  // press itself is refused for the same window, in `holdLocoMode`.
  // A repair visit is the same claim for longer: from the turn in off the lane until the camera
  // is handed back, the taxi is being driven by the vignette.
  if (burgerRun?.holdsTaxi() || opening?.visiting()) boost.release();
  boost.update(dt);
  // Latched here rather than on the press, because the whole point of it is that it cannot be
  // answered by one — see `locoHeld` where it is declared. Read every frame off the same hold clock
  // the camera's push-in uses, which stops with a paused run rather than banking the pause.
  if (!locoHeld && boost.isEngaged() && boost.heldSeconds() >= LOCO_HINT_HOLD) locoHeld = true;
  // Never re-arm boost on a wrecked taxi — the flag would flick on the next frame otherwise and
  // the collision detector only charges hits `if (taxi.boost)`. `taxi.boost` covers the hold
  // *and* the one-second cooldown tail after release — collision, police bust range and running
  // reds all key off it, see BOOST_COOLDOWN in game/boost.js. `boostEasing` is the narrower flag
  // that's only true during that tail; traffic.js reads it to ease the speed cap back down instead
  // of holding full boost speed for the whole cooldown window.
  if (!traffic.taxi.crashed) {
    // Never on a staged taxi: the cooldown tail outlasts the turn in off the lane at the depot, and
    // collisions would otherwise charge a car a cut scene is driving over a kerb. `taxi.boost` is
    // what sim/collisions.js charges hits off; the unarmed shove is closed on `staged` there.
    traffic.taxi.boost = boost.isEngaged() && !traffic.taxi.staged;
    traffic.taxi.boostEasing = boost.isCoolingDown();
    // Written every frame rather than on the press, so the flag cannot be left stuck on by a
    // pointer that never came back up — a run ending under the player's thumb takes the button off
    // the screen (`body.game-over #brake`), and a `pointerup` on a removed element is not something
    // to rely on. Same self-healing shape as the two flags above it.
    // Through the bootleg, which holds the brake off from a spin until the pedal comes back up.
    // And not through a sliding drift, whose corner is deaf to the pedal. An armed one is not: until
    // the pill comes back the tap is a brake (see holdBrake).
    const bootlegBrake = bootleg.update(dt, { brakeHeld: brakeHeld && !fares.state.gameOver });
    overtake.update(dt, { held: boost.isActive() && !traffic.taxi.staged, brakeHeld });
    const drifting = driftHolds(traffic.taxi) && traffic.taxi.drift.phase !== 'carry';
    // Or the street race's, for the finale: the winner pulling up and the loser skidding in. Through
    // the pedal because `parked` stops a car dead on the frame it is set (game/race.js).
    // And the depot run's, holding a left into the garage short of the driveway for a gap.
    traffic.taxi.braking = (bootlegBrake && !drifting) || Boolean(race?.brakesTaxi())
      || Boolean(depotRun?.holdsTaxi());
  }
  updateBoostButton(dt);
  skids.update(dt);
  wetTracks.update(dt);
  // Before the dust pool ticks, so a building's ground-burst is at age zero on the frame it fires.
  // The "Add to Home Screen" screen (iOS in a tab) *skips* the entrance outright rather than
  // holding it: the overlay shows the city sunk into black, and a city that hasn't built yet is a
  // bare street grid under the veil — which reads as a broken load, not as a treat being saved
  // for later. `holding` is true from the module's creation (see game/homescreen.js), so the
  // settle lands before the first frame ever draws an empty block. Everyone else — desktop, and
  // installed standalone iOS — never constructs the tip and keeps the animation.
  // The title screen settles it for the same reason and one more: the menu is meant to sit over a
  // finished city with its traffic running, not over the city building itself.
  if (parked()) {
    if (cityEntry.running()) cityEntry.settle();
    if (ltrain?.intro?.running()) ltrain.intro.settle();
  } else {
    cityEntry.update(dt);
    ltrain?.intro?.update(dt);
  }
  dust.update(dt);
  spray.update(dt);
  blast.update(dt);
  flames.update(dt);
  sparks.update(dt);
  repairFx?.update(dt);
  glint?.update(dt);
  wreckage.update(dt);
  updateCrushShells(dt);
  ejection.update(dt);
  windshield.update(dt);
  struckGlass.update(dt);
  // A source held from the ⚙️ panel (`holds`) is frozen by skipping its update.
  if (!holds.plane) flyover.update(dt);
  // Night, for the searchlight: off the sun's own power, which the day/night keys run 0 to 3.85.
  policeHeli?.update(dt, heliTarget(dt), { dark: 1 - THREE.MathUtils.smoothstep(sun.intensity, 0.3, 2.6) });
  if (!holds.heli) chopper.update(dt, { hold: Boolean(policeHeli?.busy()) });
  clouds.update(dt);
  rain.update(dt, camera);
  applyWeather(dt);
  if (taxiHeadlights) taxiHeadlights.group.visible = !traffic.taxi.crashed;
  // Handed last frame's taxi position, which is all a startle needs — it is a distance test with
  // eight units of slack, and running it here rather than after `traffic.update` keeps the whole
  // scenery block in one place.
  for (const flock of flocks) if (flock !== holds.birds?.flock) flock.update(dt, traffic.taxi);
  ducks.update(dt);
  leaves?.update(dt);
  hoopers.update(dt);
  // No track yet: the box keeps its own time. Once it plays music, pass the track's playback time as
  // the second argument so the bounce and the notes land on the track's beat (game/boombox.js).
  boombox.update(dt);
  skaters.update(dt);
  if (ltrain) {
    // Held from the ⚙️ panel (`holds`), it stands where it is, its bed still playing.
    if (!holds.ltrain) ltrain.update(dt);
    ltrain.setFadePoints(ltrainFadePoints());
    // Beams on in the rain, the way the cars' are, and after dark — the searchlight's night measure.
    ltrain.setBeams(Math.max(runningLightsAt(ltrain.plan.world(ltrain.state.x).x, ltrain.plan.world(ltrain.state.x).z),
      1 - THREE.MathUtils.smoothstep(sun.intensity, 0.3, 2.6)));
  }
  // The burger turning on its pole. Scenery in the same sense the flock and the flyover are, and
  // paused with them: `frame()` has already returned by here on a paused frame.
  burger?.update(dt, SIGN_SPIN);
  vet?.update(dt);
  // The car wash's brushes and curtain, and the tube man on its corner.
  roadside?.update(dt);
  tubeMan.update(dt);
  manholeSteam.update(dt, traffic.taxi, 1 - THREE.MathUtils.smoothstep(sun.intensity, 0.3, 2.6));
  // And the sign on the depot's roof, on the same terms — see DEPOT_SPIN in city/garage.js.
  garage?.update(dt);
  // The graveyard's ground mist, thicker after dark — the same night measure as the searchlight's.
  graveyard?.update(dt, 1 - THREE.MathUtils.smoothstep(sun.intensity, 0.3, 2.6));
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
  if (sfx?.state.dashRadio && !(opening?.running() && DASH_PHASES.has(opening.phase()))) sfx.openDash();
  // The pedals arrive the moment the taxi is the player's to drive — on the lane, with the
  // vignette's pull-back still running — rather than with the rest of the HUD. They used to wait
  // for `hud-ready`, which is the *tutorial's* second beat being answered: the pull-back, a
  // breath, a pan to the rider, a bubble typing itself out and a tap. Several seconds of a live
  // taxi on a live road with nothing to press, which read as the game not having started yet.
  // The counters can wait for the lesson; a control cannot, because it is the thing the lesson is
  // standing in front of. A press during the rider beat ends it, by design (`holdLocoMode`).
  // The squall's crossings count from here too: its first cell is `FIRST` seconds of driving away,
  // not of title menu and garage door (game/squall.js).
  if (!pedalsShown && pedalsDue()) { pedalsShown = true; revealPedals(); squall?.begin(); }
  // ...and the HUD steps off its edges whenever the taxi is in the garage: the opening before the
  // car is out of the door, and a repair visit from the turn-in until it is back on the lane. The
  // same `release` the pedals wait on, so a run's first arrival and every return from the depot
  // are one beat. See the HUD exit block in index.html.
  setHudAway(!pedalsLive());
  // ...and the drive-through is the same claim about somebody else's car: while one is in the lot
  // this is its physics, so it has to have written the position before the render pass reads it.
  driveThru?.update(dt);
  // After the lot, not before it: a taxi handed back to the road on this frame is released inside
  // the call above, and this is what puts a route back under it before `traffic.update` asks which
  // way to go at the next junction.
  burgerRun?.update(dt);
  driveThruSpeaker();
  // ...and the depot's catch at its driveway, on the same timing: it reads where last frame's
  // `traffic.update` left the taxi, and a car taken here is staged before this frame's render pass.
  depotRun?.update(dt);

  // The patrol's ram knocking the busted taxi along (`bustByPolice`). Before `traffic.update`, which
  // is what draws the taxi where this leaves it; a crashed taxi is otherwise never moved.
  if (ramShove) {
    ramShove.age += dt;
    const k = carryTravel(ramShove.age);
    traffic.taxi.x = ramShove.x + ramShove.vx * k;
    traffic.taxi.z = ramShove.z + ramShove.vz * k;
  }
  // The kerb swipe at a post box or a hot dog cart is an offset `traffic.update` draws the taxi at,
  // so it is set before it (game/streetprops.js).
  streetProps.update(dt, traffic.taxi);
  traffic.update(dt);
  if (traffic.taxi.overtakes > overtakesFelt) {
    overtakesFelt = traffic.taxi.overtakes;
    if (!fares.state.gameOver) {
      haptic('overtake');
      landCombo('overtake');
    }
  }
  if ((traffic.taxi.spinKicks ?? 0) > spinKicksFelt) {
    // The handbrake U-turn lands on the drift's exit kick (sim/traffic.js), and says so the same
    // way, minus the fuel: the U-turn has already paid its combo on the frame it started.
    spinKicksFelt = traffic.taxi.spinKicks;
    if (!fares.state.gameOver) {
      const car = traffic.taxi;
      haptic('drift-kick');
      controller.kickShake(0.5);
      sfx?.locoOn();
      flames.burst(
        car.x - Math.cos(car.yaw) * TAXI_TAILPIPE_BACK,
        TAXI_TAILPIPE_HEIGHT,
        car.z + Math.sin(car.yaw) * TAXI_TAILPIPE_BACK,
        car.yaw,
      );
    }
  }
  if (traffic.taxi.drifts > driftsPaid) {
    driftsPaid = traffic.taxi.drifts;
    // The exit kick (DRIFT_EXIT in sim/traffic.js) has to read at a glance — playtesting said it
    // didn't, with only a buzz and a shake. So it says so: a bark of fire out of the pipe on top of
    // the double-barrelled plume (`locoFlame` below), the Loco whoosh, and the fuel flying off the
    // car into the gauge on the same sparks a drop-off pays with — it once went straight into
    // `topUp`, so the meter grew with nothing to say why. (A "DRIFT BOOST!" word off the roof was
    // tried and cut.) No HANDOFF: there is no payout coin here to wait behind.
    if (!fares.state.gameOver) {
      const car = traffic.taxi;
      const tier = car.driftTier - 1;
      const fuel = DRIFT_CHAIN.fuel[tier];
      flyEnergyToBoost({
        from: taxiScreenPos,
        to: fuelScreenPos,
        delay: 0,
        onArrive: () => boost.topUp(fuel),
      });
      haptic('drift-kick');
      landCombo('drift', car.driftTier);
      // Harder up a chain, as the plume is (`locoFlame` below): the tier has to be felt, since
      // nothing writes it on screen.
      controller.kickShake(0.5 * DRIFT_CHAIN.flame[tier]);
      sfx?.locoOn();
      flames.burst(
        car.x - Math.cos(car.yaw) * TAXI_TAILPIPE_BACK,
        TAXI_TAILPIPE_HEIGHT,
        car.z + Math.sin(car.yaw) * TAXI_TAILPIPE_BACK,
        car.yaw,
      );
    }
  }
  // A pass carried the taxi straight through a junction its route wanted to turn at, and the sim
  // dropped the route there (`detoured` in traffic.js). Re-plan from the far side, through the
  // same owner a dragged band goes through: a burger run or a depot run knows which way it has to
  // arrive and the plain `routeTo` does not.
  if (traffic.taxi.detoured) {
    traffic.taxi.detoured = false;
    if (traffic.taxi.pendingTarget) {
      if (burgerRun?.active()) burgerRun.reroute(null);
      else if (depotRun?.active()) depotRun.reroute(null);
      else routeTo(traffic.taxi.pendingTarget);
    }
  }
  sfx?.update(dt, traffic.taxi, {
    cruise: SPEED,
    top: boostCruise(),
    holding: boost.isEngaged() && !boost.isCoolingDown(),
    over: fares.state.gameOver,
    menu: !runBegun,
    siren: sirenLevel(),
    rotor: policeHeli ? policeHeli.loudness(traffic.taxi.x, traffic.taxi.z) : 0,
    ambient: sfx ? ambientLevels() : undefined,
  });
  cityOneShots(dt);
  heldSounds();
  // Only the sound being edited in the panel — see `focused` in game/audiopanel.js.
  if (soundRings) {
    const open = Boolean(debugPanel && !debugPanel.panel.hidden);
    const key = open ? debugPanel.audioFocus() : null;
    const sources = soundSources();
    soundRings.update(open, controller.state.target,
      key ? sources.filter((s) => s.key === key) : [], sfx.tuning().place);
    // The handles go on the selected sound's first source — the one ring set a drag can mean.
    const first = key ? sources.find((s) => s.key === key) : null;
    const place = first ? sfx.tuning().place[key] : null;
    screenRight.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
    soundPins.update(Boolean(debugPanel) && !fares.state.gameOver, sources, key,
      open ? controller.state.target : null,
      open && place ? { key, x: first.x, z: first.z, near: place.near, far: place.far,
        right: { x: screenRight.x, z: screenRight.z } } : null);
  }
  // After traffic has settled positions for the frame — that's what the overlap check reads, and
  // what the two wreck shells are copied out of. A detected impact takes both cars out of the
  // sim from this frame on; the loops in traffic.js already skip a crashed car, so no further
  // plumbing is needed here.
  collisions.update(dt);
  impact.update(dt);
  // After traffic has written the taxi's transform: the lean and the rattle ride on top of it.
  taxiDamage.update(dt);
  // After traffic too: it hangs the parts off the body matrices traffic wrote this frame.
  carDamage.update(dt);
  taxiDoor.update(dt, fares.state.fares.find((f) => f.boarding !== undefined) ?? null);
  // After the physics, like the collision check: it measures where traffic left the cop and the
  // taxi this frame, and a catch ends the run the same way a wreck does. Engaged rather than held —
  // the cooldown tail after release still counts, so braking off Loco Mode a beat too close to a
  // patrol doesn't buy a free pass.
  //
  // **Not during a getaway**, and that is a design call rather than a special case. A robbery puts
  // four cop cars on the street in the same paint, and pays a bonus on the clock that boosting is
  // how you beat — so the patrol stands down while one runs (`blocked` above) rather than being a
  // fifth blue car that punishes the thing the event asks for. Reported from a real run before the
  // rule existed: "I got busted by the actual cop car; none of the other police actually moved."
  patrol.update(dt, { boosting: boost.isEngaged() && !fares.state.gameOver });
  // The getaway's cops can arrest too, under the capture model: the same pin the patrol's catch is.
  // Only once the alarm is up — the robber climbing in at the bank is a taxi stopped among nobody's
  // police yet — and never the arrest crew at the drop-off, whose cars belong to their scene.
  if (!captureClassic && getaway() && robbery.state.alarmed && !fares.state.gameOver) {
    const cop = getawayPin.update(dt, traffic.policeCars.filter((c) => !c.patrol && !c.arrest && !c.staged));
    if (cop) {
      const ram = ramOf(cop, traffic.taxi);
      holdArrest(cop);
      getawayPin.reset();
      bustByPolice(ram);
    }
  } else {
    getawayPin.reset();
  }
  // The cruiser's mesh and lamps, after the traffic car it wears has moved and after the patrol
  // has decided whether its bar is on.
  for (const cruiser of cruisers) cruiser.update(dt);
  // Last of the three, and both halves of that matter. It copies the matrices traffic composed
  // *this* frame, so running it any earlier would slide every outline off its own car by a couple
  // of pixels at boost speed; and it runs after collisions so a car wrecked on this frame is
  // already flagged, rather than wearing a ghost over its own fireball for one frame.
  carGhosts.update(dt);

  // After collisions, for the same reason collisions runs after traffic: the barricade test is a
  // position test, and a taxi wrecked on this frame must not also be launched off a ramp. The
  // kerb corners it is handed are the ones riders are standing on — a zone must not close the
  // street a fare is waiting in.
  // Beside `roadwork`, and for the same reason it sits here rather than before `traffic.update`:
  // both are handed the cars as they stand *after* the step, which is what a "is anything on the
  // deck" test wants to be reading. A closure taken now lands on the next frame's turn decisions,
  // which is a frame later than it could be and a frame earlier than anything can act on it — the
  // barriers take `BARRIER_SECONDS` (2.2) to come down before the leaf moves at all.
  //
  // The two no longer fight over the lane set: they hold their closures under separate source keys
  // (`setClosedLanes` in sim/traffic.js), so whichever runs second no longer clears the other.
  // Boats first, so a tug that reaches its asking distance this frame gets the barriers moving on
  // the same frame rather than the next one.
  boats?.update(dt);
  harborShips?.update(dt);
  drawbridge?.update(dt, traffic.cars);
  tickRiverWater(dt);
  edgeFogTime += dt;
  tickEdgeFog(edgeFogTime);
  roadwork.update(dt, traffic.taxi, traffic.cars, fares.occupiedSpots());
  // After the traffic step for the same reason: it rides the truck's instance matrix, which has to
  // be this frame's, and it tests crates against the cars where they now are.
  flatbed.update(dt, traffic.taxi, traffic.cars);
  boxSpill.update(dt, traffic.cars);
  // After the traffic step too: the engine's pose is written by it, and the ladder and the jet are
  // aimed off that pose.
  fire.update(dt);
  // After the traffic step for the same reason: the bags are aimed at the hopper where it now is.
  garbage.update(dt);
  if (fares.state.gameOver) race?.abandon();
  race?.update(dt);
  raceTalk?.update(dt);
  // Up for as long as the racer is on the road — its parting word included, said as it drives off.
  if (race?.state.phase === 'waiting' && raceTalk?.isOpen()) raceTalk.hide();
  // The faceoff's close-up walked back out to the zoom the player had, beside whichever claim owns
  // the target — the bank job's arrangement (`easeZoom`).
  if (raceZoomHome != null && !raceShot && !raceWatch && !endSpot) {
    controller.easeZoom(raceZoomHome, dt, aspect());
    if (Math.abs(controller.state.zoom - raceZoomHome) < 0.05) raceZoomHome = null;
  }

  tutorial?.update(dt);

  // The camera's priority list, highest first. Two of the claims trail the taxi and are
  // narrow-viewport only (see START_FOLLOW_SMOOTHING): the opening follow, which runs until the
  // player takes the framing over, and Loco Mode, which chases harder and outranks it. Boost
  // ignores `cameraTakenOver` on purpose — a drag during a boost is quietly overridden on the next
  // frame, because panning is a planning gesture and boost is the opposite of planning. A press
  // also *hands the camera back*: it clears `cameraTakenOver`, so letting go drops to the momentum
  // chase below and then the opening follow, and the camera stays on the car until the player
  // swipes again. It used to stop dead on release, and the release is exactly when a drift's exit
  // kick fires — the taxi left the frame at 1.4-1.7x the boost cruise with nothing following it.
  // The momentum chase keeps the boost's 3.2 through the post-release tail and any kick still being
  // carried, because the opening follow's 1.5 is set for cruising, not for a car at its fastest.
  // A swipe after the release still takes the framing, at once. The way *out* is idleness: once the
  // player has left the map alone for CAMERA_RETURN_IDLE, the camera rides home to the taxi
  // (`updateCameraReturn`). Both aim past the taxi rather than at it (`followAim`), so the road it
  // is driving down gets the frame the road behind it used to.
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
  // The title screen's drift sits above even the vignette, which is held behind it anyway.
  updateCameraReturn(dt);
  const boosting = boost.isActive();
  // On the press, not every frame of the hold: a swipe made *while* holding is still the player
  // asking for the map, and it should hold once the button comes up.
  if (boosting && !wasBoosting) cameraTakenOver = false;
  wasBoosting = boosting;
  const momentum = boost.isEngaged() || traffic.taxi.drift?.phase === 'carry';
  // Debug mode follows Loco Mode on a desktop too: the placed sounds are heard from the middle of
  // the screen, so playtesting them while driving means the camera has to come along.
  const locoFollows = isNarrow() || debugMode;
  if (title?.holding() && storyCam && opening) {
    const p = storyFrame(dt);
    const u = storyCam.glide ? Math.min(storyCam.t / STORY_GLIDE, 1) : 1;
    if (u < 1) {
      // The slide keeps running underneath, followed the way the title branch below follows it
      // (the camera trails the slide by the same 0.8 ease), so the blend leaves at its own speed.
      const pan = title.pan(dt);
      const { from } = storyCam;
      const k = 1 - Math.exp(-dt * 0.8);
      from.x += (pan.x - from.x) * k;
      from.z += (pan.z - from.z) * k;
      from.zoom += (pan.zoom - from.zoom) * k;
      const w = u * u * u * (u * (u * 6 - 15) + 10);
      p.x = from.x + (p.x - from.x) * w;
      p.z = from.z + (p.z - from.z) * w;
      p.zoom = from.zoom + (p.zoom - from.zoom) * w;
    }
    controller.cutTo(p.x, p.z, p.zoom, 0, aspect());
  } else if (title?.holding() && titleReel) {
    const p = titleReel.frame(dt, aspect());
    controller.cutTo(p.x, p.z, p.zoom, 0, aspect());
  } else if (title?.holding()) {
    const p = title.pan(dt);
    if (titleFramed) controller.focusOn(p.x, p.z, p.zoom, dt, aspect(), 0.8);
    else { controller.cutTo(p.x, p.z, p.zoom, 0, aspect()); titleFramed = true; }
  } else if (opening?.holdsCamera()) {
    opening.frameCamera(dt);
  } else if (endSpot) {
    controller.focusOn(endSpot.x, endSpot.z, endZoom, dt, aspect());
  } else if (raceShot) {
    // The street race's faceoff: the two cars side by side, close up, from the cut until the
    // camera leaves to look at the finish (`onRaceEvent`). The taxi is parked, so nothing below
    // has anywhere better to be.
    controller.focusOn(raceShot.x, raceShot.z, RACE_SHOT_ZOOM, dt, aspect());
  } else if (raceWatch && !fares.state.gameOver) {
    // The street race's finale: following the loser home, then holding on the line while the
    // money moves (`settleRaceWatch`). Above Loco Mode's follow, because the loser can be the taxi
    // and the winner is home already.
    controller.focusOn(raceWatch.x, raceWatch.z, RACE_WATCH_ZOOM, dt, aspect());
  } else if (boosting && !fares.state.gameOver && locoFollows) {
    controller.followXZ(traffic.taxi.x, traffic.taxi.z, dt, BOOST_FOLLOW_SMOOTHING, aspect(),
      followAim(traffic.taxi));
  } else if (momentum && !cameraTakenOver && !fares.state.gameOver && locoFollows) {
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
  // The bank job on game time (game/bankjob.js): the bystander getting back up, the alarm for as long
  // as the robbery runs, the door the robber left open, and the zoom coming home after its cut —
  // after the claims above, since it eases only the zoom and leaves the target to whichever won.
  bankJob?.tick(dt, {
    alarm: Boolean(robbery?.state.active) && !fares.state.gameOver,
    aspectRatio: aspect(),
    narrow: isNarrow(),
  });

  // The frame tightens a few percent while Loco Mode is *held* — the ortho stand-in for a lens
  // pushing in, see LOCO_PUNCH in game/camera.js. It sits outside the priority list above rather
  // than in it: the list decides where the camera points and this decides how tight it is, so it
  // composes with whichever claim won the frame instead of competing for it.
  //
  // Keyed on the hold and not on the press. A tap is a designed input here (it spends a short slice
  // of fuel) and the pill gets jabbed constantly, so a push-in that answered every press would pop
  // the frame on all of them — LOCO_PUNCH_HOLD is the line between the two gestures.
  locoPunched = (boost.isActive() && boost.heldSeconds() >= LOCO_PUNCH_HOLD)
    || (locoPunched && boost.isEngaged());
  // Narrow-only, like the follows, and for a sharper reason than theirs: the desktop framing is
  // *sideways*-tight, not vertically tight. Measured across 12 seeds, the city reaches 92.5% of the
  // half-frame across a 4:3 desktop at PLAY_ZOOM (only 77% of it up-screen), so the push-in would
  // carry its edge to 122% and crop the map outright — with drag-to-pan switched off up there,
  // permanently. And it gives way to the two claims that set the zoom
  // themselves, the opening vignette and the end-of-run focus; neither can be up while the player
  // is holding the pill, but both would fight it if they were.
  const punchAllowed = isNarrow() && !fares.state.gameOver && !endSpot
    && !opening?.holdsCamera();
  controller.punchZoom(locoPunched && punchAllowed, dt, aspect());

  // The bank robbery, ticked **before** the fare loop rather than after it, which is the opposite
  // of where the courier sits and is deliberate. A robber that gets in on this frame is a fare on
  // the board before `fares.update` snapshots it, so their clock starts, their crystal flies and
  // their ring appears on the same frame the player sees them run out of the building — rather than
  // on the one after, with a beat of nothing in between. It reads the taxi's settled position from
  // `traffic.update` above, which is what the trigger's range is measured against.
  //
  // Held by the same gate the fare loop is: the opening vignette, the wipe and the Home Screen tip
  // each stop the world, and an event firing behind any of them is one the player never saw.
  if (!fareLoopHeld()) robbery?.update(dt);
  radio?.update(dt, { over: fares.state.gameOver });
  copShout?.update(dt, { over: fares.state.gameOver });
  hitCue?.update(dt, traffic.taxi);
  // The depot's card: SHOW_DELAY after the car starts smoking, so the hit that did it has landed
  // first. A beat that is not calm — a getaway, a chase, the taxi already on its way in for repairs —
  // defers it rather than spending it: it is tried again every half second for as long as the car
  // is still smoking, and a car repaired in the meantime starts the count again next time.
  //
  // The line (the default) takes the card's trigger and its gates, less `newMoveWanted`'s seen flag:
  // it has its own rule for when it stops (`repairUsed`).
  // The "!" on the garage door: up whenever a tap there would send a smoking taxi in. Smoking
  // rather than any scratch, so it says "go and get that seen to" and not "you have been touched".
  depotCall?.update(dt, {
    over: fares.state.gameOver,
    mark: questMarks && traffic.taxi.hp <= TAXI_HP * SMOKE_FRACTION && canRepair(),
  });
  updateBankMark(dt);
  const repairTipDue = depotCall
    ? !depotCallSaid && !repairUsed.get()
    : garage && newMove && !repairCard.seen.get();
  if (repairTipDue) {
    if (traffic.taxi.hp > TAXI_HP * SMOKE_FRACTION) repairCardIn = -1;
    else if (repairCardIn < 0) repairCardIn = SHOW_DELAY;
    else {
      repairCardIn -= dt;
      if (repairCardIn <= 0) {
        if (!(depotCall ? sayDepotCall() : newMoveWanted(repairCard) && newMoveCalm() && openNewMove(repairCard))) {
          repairCardIn = 0.5;
        }
      }
    }
  }
  if (newMoveIn > 0) {
    newMoveIn -= dt;
    if (newMoveIn <= 0 && newMoveWanted() && newMoveCalm()) openNewMove();
  }
  if (radioIn > 0) {
    radioIn -= dt;
    // A getaway over before dispatch got a word in — a wreck in the first second and a half — has
    // nothing left to call in.
    if (radioIn <= 0 && robbery?.state.alarmed && !fares.state.gameOver) {
      radio?.show(ROBBERY_CALL, copNearestBank());
    }
  }

  // More than one thing can land in a frame now — delivering the last fare clears the board and
  // spawns the next one in the same tick — so this is a list rather than a single event.
  for (const { type, fare } of
    (fareLoopHeld() ? NO_FARE_EVENTS : fares.update(dt, traffic.taxi))) {
    // The bank rider's coin came up tails: they are off the board, and the robber takes the seat
    // they were about to — `onBoard` above dispatches the getaway and the bank job's cut opens.
    if (type === 'swapped') {
      robbery?.swap();
      // Take the "!" down now: the bank job's cut stops the world from the next frame, and the
      // frozen frame returns before `updateBankMark` above ever runs again — the tag sat over the
      // robber for the whole cut.
      updateBankMark(0);
      continue;
    }
    if (type === 'pickup') {
      boardSound();
      traffic.taxi.route = [];
      traffic.taxi.pendingTarget = null;
      // The roof sign lights up while the rider is aboard.
      traffic.setTaxiOccupied(true);
      // Straight on to where they're going, on the same frame the pin appears — no kerb hold and
      // no confirming tap.
      dispatchToDropoff(fare);
      // ...unless the taxi was on its way to the burger joint, in which case the rider was collected
      // *en route* and the detour is still the player's standing instruction. `send` puts the burger
      // back in front of the car and takes the drop-off just dispatched as what to return to, so the
      // trip ends by driving the fare it interrupted. It refuses while the taxi is already in the
      // lot, where the route above is the one that will be planned again on the way out anyway.
      // See game/burgerrun.js.
      if (burgerRun?.active()) burgerRun.send();
      // A taxi on its way in for repairs is *not* sent back: no rider rides along to the garage
      // (`sendForRepairs`), so the pickup ends the trip — the drop-off above has replaced its
      // target and `depotRun.update` stands down on the next frame. A car already staged in the
      // driveway finishes its visit and `resumeJob` hands it the drop-off on the way out.
    } else if (type === 'delivered') {
      if (!movesAfterRun) {
        newMoveDue = nextMove(fares.state.delivered);
        if (newMoveWanted()) newMoveIn = SHOW_DELAY;
      }
      // Out they get: open, and shut a beat later once they are clear of the car.
      sfx?.play('doorOpen');
      sfx?.play('doorClose', { delay: 0.7 });
      comboTag.lingerUntil = performance.now() + COMBO_LINGER_MS;
      if (fare.runs?.length) popComboPayout(fare);
      else popEarning(fare.value);
      // A third of a tank of boost fuel as the ordinary delivery reward — the only way any fuel
      // enters the meter otherwise. A VIP pays out bigger here too: the tank tops all the way to
      // full rather than by a third, on the same delayed pour as everything else so it reads as
      // the same reward, just a bigger one. Read at arrival time rather than baked in now, so a
      // tank that drained (or filled) during the flight still tops out exactly full.
      //
      // A robber fills it too, and for a harder reason: the drop-off sets a patrol chase on the
      // taxi (`handOff` above), and that chase is the patrol's, tank table and all (game/patrol.js)
      // — a third of a tank is five seconds of boost, which is its coin flip, and none at all is
      // caught 15 times in 16. Full is 14 in 16 lost. The chase is still there to lose; it is not
      // there to end the run of a player who did everything the getaway asked.
      flyEnergyToBoost({
        from: taxiScreenPos,
        to: fuelScreenPos,
        onArrive: () => boost.topUp(fare.vip || fare.robber ? 1 - boost.fraction() : BOOST_FARE_REWARD),
      });
      traffic.taxi.route = [];
      traffic.taxi.pendingTarget = null;
      traffic.setTaxiOccupied(false);
    } else if (type === 'checkpoint') {
      // A getaway checkpoint (ROBBER_CHECKPOINTS in game/fares.js): a full tank, poured the way the
      // robber's boarding one is, and the route re-aimed at the next corner — the fare's `target`
      // has already moved on. The clock keeps running; only the drop-off pays.
      flyEnergyToBoost({
        from: taxiScreenPos,
        to: fuelScreenPos,
        onArrive: () => boost.topUp(1 - boost.fraction()),
      });
      popLabel(`Checkpoint ${fare.checkpointsTotal - fare.checkpoints.length}/${fare.checkpointsTotal}`);
      haptic('pick');
      traffic.taxi.route = [];
      traffic.taxi.pendingTarget = null;
      dispatchToDropoff(fare);
    } else if (type === 'failed') {
      // The run ended on a clock rather than on an impact — see the TIMEOUT_* block. The camera
      // takes wherever the rider is getting out (`failSpot`, set by fares.js as it hands them to
      // the bail), the sim drops into a shallow slow-mo, and the retry screen waits for both.
      //
      // The taxi stops for it, the same way it does for a bust and for the same reason: the run is
      // over, and a car still driving a route to a fare that no longer exists — out from under the
      // rider climbing out of it — argues with the ending being shown. `crashed` is the flag every
      // loop in traffic.js already skips, so it does the whole job. Boost goes with it, or a held
      // pill would keep burning fuel behind the banner.
      showStrikes(fares.state.strikes);
      endSpot = fares.state.failSpot ?? { x: traffic.taxi.x, z: traffic.taxi.z };
      endZoom = TIMEOUT_ZOOM;
      crashBannerAt = performance.now() + TIMEOUT_BANNER_DELAY;
      slowMoUntil = performance.now() + SLOW_MO_DURATION;
      slowMoMin = TIMEOUT_SLOW_MO_MIN;
      traffic.taxi.crashed = true;
      traffic.taxi.v = 0;
      boost.release();
      // The seat is empty from this frame on — they are getting out of it in shot — so the roof
      // sign goes back to vacant rather than holding "occupied" over a cab nobody is in.
      traffic.setTaxiOccupied(false);
    } else if (type === 'vip-missed' || type === 'robber-missed' || type === 'missed') {
      // The rider swearing as they storm off (geometry/cursebubble.js) — out of the cab if they
      // were aboard, off their kerb if not.
      const riding = fare.stage === 'riding';
      sfx?.play('angry', { at: riding ? placeAt(traffic.taxi.x, traffic.taxi.z)
        : placeAt(lineX(fare.pickup.i), lineZ(fare.pickup.j)) });
      // An ordinary rider let go on the kerb is a strike as well as a freed taxi — see MAX_STRIKES.
      if (type === 'missed') showStrikes(fares.state.strikes);
      // And the job the combo meter was building toward has walked off with them, so the streak
      // breaks exactly as a hit breaks it — any kind of rider, either scope (game/combometer.js).
      if (combo.walkout(fare)) {
        comboTag.lost = true;
        haptic('perfect-lost');
      }
      // The one fare whose clock running out isn't a run-ending event — see fares.js. The rider is
      // getting out and running off on their own (fares.js `beginBail`); what is left here is the
      // taxi, which is either holding an empty seat or still driving at a kerb nobody is standing
      // on any more. Free it up exactly as a delivery would, minus the payout.
      //
      // `directed` covers the second case: a VIP whose clock ran out while the taxi was on its way
      // to collect them leaves a live route and a `pendingTarget` aimed at a corner with nothing on
      // it, which is the same stale drive the courier's own arrivals retire below.
      //
      // A robber's clock running out lands here too, and it is the same event from the taxi's side:
      // somebody getting out mid-street and the seat coming free. It is never the kerb case — a
      // robber is aboard from the frame they appear — so only the first branch below can fire for
      // one. See the timeout branch in game/fares.js for why a robbery cannot end a run.
      if (fare.stage === 'riding' || fare.directed) {
        traffic.taxi.route = [];
        traffic.taxi.pendingTarget = null;
      }
      if (fare.stage === 'riding') traffic.setTaxiOccupied(false);
    }
  }

  // The robber has finished running for the cab: stop the world and let them speak. Read off the
  // fare's own boarding animation (`fare.boarding` goes undefined on the frame the figure is in),
  // with `ridingFor` as the backstop so a figure that somehow never finishes cannot leave the
  // police waiting forever. A getaway gone before the line opened — a run over mid-boarding — is
  // dropped rather than shouted about over a retry screen.
  if (robberBoarding && !robberBoarding.scripted) {
    const f = robberBoarding;
    if (fares.state.gameOver || !robbery?.state.active || !fares.state.fares.includes(f)) {
      robberBoarding = null;
    } else if (f.boarding === undefined || f.ridingFor > 1.5) robberIn();
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
        concealed: fares.concealed(),
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
      // Beside the flash rather than on `'loaded'` a moment later: this is the frame the box leaves
      // the pad and the frame the flourish plays, and the two want to be the same beat. `'loaded'`
      // is the *chip's* cue — the tail of an animation the player is watching finish, not the
      // moment anything happened.
      haptic('parcel-in');
    } else if (type === 'loaded') {
      // The lift is nearly done and the box is nearly transparent. `at` is where it had got to, in the
      // world, on *this* frame — `parcels.js` owns that fact; turning it into a pixel is this module's
      // half, because the projection is. The chip then comes in from that direction under the last of
      // the fade (see `flyIn` in game/cargochip.js).
      if (at && cargoChip) {
        const p = projectToScreen(at.x, at.y, at.z);
        // `at.cargo` is which load it was — a box or a food order (game/parcels.js). It rides on the
        // event rather than being read back off the package, because the package is already carried
        // by the time this lands and the chip has to raise the same thing that is fading out over
        // the kerb.
        cargoChip.flyIn({ x: p.x, y: p.y, yaw: at.yaw, kind: at.cargo });
      } else {
        cargoChip?.setCarrying(true, at?.cargo);
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
      // On the delivery itself, not on either bonus arriving. The two flights below take about a
      // second to reach the counter and the pill, and a buzz that waited for them would land on a
      // frame the player has already stopped associating with the pad they just left.
      haptic('parcel-out');
      // Cash and fuel, the same two currencies a drop-off pays, and both take the same two-phase
      // flight a fare's does — off the taxi, then to the counter and to the pill — because it is the
      // same kind of event arriving from the same place, and a bonus that landed in either place
      // with no visible link to the car would read as a side effect. The fuel is deliberately *half*
      // a fare's (see BOOST_PARCEL_REWARD): an errand pays into the tank, but a fare still fills it
      // twice as fast, so the courier layer stays a detour rather than the way you fuel a run. What
      // a package still does not touch is a run bonus — that number means "this is what a *fare*
      // is worth now", and a package is not a fare.
      fares.credit(parcel.value);
      popEarning(parcel.value);
      flyEnergyToBoost({
        from: taxiScreenPos,
        to: fuelScreenPos,
        onArrive: () => boost.topUp(BOOST_PARCEL_REWARD),
      });
    }
  }

  // The taxi's flourish, on the select pop's own envelope (game/selectpop.js) so a package landing in
  // the car — or the camera landing back on it — reads as the same *kind* of acknowledgement a tapped
  // rider gets rather than as a new effect to learn. Written every frame while it runs, so the frame
  // it retires is the one that puts the car back — and clamped at zero on the way out, because a
  // light going negative would dim the taxi below the city it is driving in.
  if (taxiFlashAge !== null) {
    if (taxiFlashAge >= POP_TIME) {
      traffic.setTaxiHighlight(0);
      taxiFlashAge = null;
    } else {
      traffic.setTaxiHighlight(popHighlight(taxiFlashAge));
      taxiFlashAge += dt;
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
  // Through the finale too while the racer is the one still coming home.
  // Not in the finale: what it is driving then is the staged drive-in, not a line to race.
  const rivalCar = race?.state.phase === 'racing' ? race.state.car : null;
  if (rivalCar && !fares.state.gameOver) rivalLine.update(rivalCar, rivalCar.route, dt);
  else rivalLine?.hide();

  layRubber(dt);
  wetTyres(dt);
  kickDust();
  // Down here with the rubber and the dust rather than up with `flames.update`, and for the same
  // reason both of those are: it is pinned to the car's position this frame, not emitted and left
  // behind. At the Loco Mode top the taxi covers 0.57 units in a frame, so a plume ticked before
  // `traffic.update` would sit visibly off the back of the bumper the whole time it burned.
  // The drift kick burns double-barrelled for as long as it holds (`carry` in DRIFT_CHAIN), and
  // bigger the further up a chain it is.
  locoFlame.update(dt, traffic.taxi, boost.isActive(), traffic.taxi.drift?.phase === 'carry',
    DRIFT_CHAIN.flame[Math.max(0, traffic.taxi.driftTier - 1)], Math.max(0, traffic.taxi.driftTier - 1));
  const racer = race?.state.car;
  racerFlame.update(dt, racer ?? NO_CAR, Boolean(racer?.racer && racer.v > RACER_FLAME_SPEED));
  copRubber();
  raceRubber();
  raceBurnout(dt);
  // `sim/` publishes where its cars are and this side owns anything that reaches into the scene
  // — the patrol cruiser's rubber included, since it is one of `traffic.policeCars` now. Off the
  // sim clock the bars strobe on
  // (`stats.time`), so the wash on the road and the lamp over it are one siren.
  copLights.update(traffic.policeCars, traffic.taxi, traffic.stats.time);
  // Fed and then ticked, in that order and on this side of `traffic.update`: the pool only writes
  // an instance matrix in its update pass, so a note fed after it would be drawn one frame late —
  // 0.57 units of road at the Loco top, which reads as the trail starting a car length back.
  spillCash(dt);
  cashTrail.update(dt);
  updateHud(dt);
  riderFinder.update(dt, fares.waitingAll());
  // Armed only when nothing else already has the framing in hand: a run that has ended has the
  // closing shot, the tutorial is pointing the camera at the city itself, and a pan in flight is
  // already on its way somewhere — including this chip's own, which is what drops it on the tap.
  taxiFinder?.update(dt, traffic.taxi,
    !fares.state.gameOver && !controller.isGliding() && !tutorial?.holdsCamera());
  // A no-op unless a package is aboard — it draws nothing while the chip is down.
  cargoChip?.render();
  // Up for a patrol chase or a getaway, and down for the arrest itself: once the cuffs are on, the
  // chase is over. `losing` is how far the patrol's own two escape counters have run (game/patrol.js),
  // which is what cools the lamp while the cop has lost sight of you.
  if (chaseSiren) {
    const chasing = patrol.state.phase === 'chase';
    chaseSiren.update(!fares.state.gameOver && (chasing || getaway()), {
      losing: chasing && !getaway()
        ? Math.max(patrol.state.clear / ESCAPE_HOLD, patrol.state.unseen / SIGHT_HOLD) : 0,
      caught: patrol.state.phase === 'arrest' || fares.state.gameOver,
    });
  }
  // Every arrow stands in for a mark it points at, so each is painted from its own fare — see
  // game/farepointers.js. The waiting riders get one too now that the chips are gone, which is
  // what keeps an off-screen fare findable at all.
  const aboard = fares.carrying();
  farePointers.update(aboard, fares.state.gameOver ? [] : fares.waitingAll(), fares.colorOf);
  // After the police update above, so the wash is aimed at where the cruiser is this frame rather
  // than trailing it by one.
  // With more than one cruiser out, the wash warns about the nearest one with its bar up.
  sirenGlow.update(nearestLitCruiser(), traffic.taxi);
  // Wall clock for the envelope, so the crash's slow-motion does not hold the frame up; the strobe
  // stays on the sim clock the cop cars' own bars run off.
  robberyGlow.update(wallDt, !!robbery?.state.alarmed && !fares.state.gameOver, traffic.stats.time);
  // Undilated: the slow-motion ramp at the end of a run is a statement about the sim, and a
  // drawing does not slow down because a taxi did. Skipped entirely on a paused frame above, which
  // is right — a held frame is a held drawing.
  crayon.update(wallDt);
  // Three assignments: an instanced hull draws `count` instances and nothing watches that for it,
  // while traffic moves it when a truck spawns and when the panel's car slider is dragged.
  cartoon.update();
  // Last thing before the frame is drawn, so the sample is the frame the player sees. Stops once a
  // run is over and no replay is coming — a bust or a timeout has nothing to show.
  if (tape && (!fares.state.gameOver || replay.armed())) tape.record(simClock, tapeImpact);
  tapeImpact = false;
  renderFrame();
  // The title reel's crossfade takes its still of the outgoing shot here, straight after the draw
  // and in the same task — the only moment the canvas can be read (game/titlereel.js).
  if (title?.holding() && !storyCam && titleReel?.snapDue()) titleReel.snapshot(renderer.domElement);
}

// The gear button sits top-right at small widths and started overlapping the streak counter
// there — most players never open it anyway, so it's opt-in now: `?debug` or `?settings` in the
// URL, either present with no value needed.
const debugParams = new URLSearchParams(window.location.search);
// `?audio` was the sound designer's own panel; it is the Audio sections of this one now, and the
// flag still opens it.
const wantsDebugPanel = debugMode;
// The panel's 🖥 / 📱 switch (game/phoneframe.js): built with the panel, and read by `placeAt` for
// the pan a phone would hear.
const phoneFrame = !shot && wantsDebugPanel ? createPhoneFrame() : null;
// Freeze-and-zoom for tuning things that are a few pixels across at play zoom — see
// game/inspect.js. `I` toggles it; the debug panel has the buttons.
const inspect = !shot && wantsDebugPanel ? createInspect({
  controller,
  canvas: renderer.domElement,
  aspect,
  // The taxi first, then every other vehicle nearest-first, so "Next car" walks outward from it.
  focusables: () => {
    const { x, z } = traffic.taxi;
    const others = traffic.cars
      .filter((car) => car !== traffic.taxi && Number.isFinite(car.x) && Number.isFinite(car.z)
        && Math.abs(car.x) < MAX_SPAN && Math.abs(car.z) < MAX_SPAN)
      .sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z));
    return [traffic.taxi, ...others];
  },
  // Same release the pause does on the way in: a held boost or brake would otherwise resume into a
  // pedal nobody is holding.
  onChange: (on) => { if (on) { boost.release(); releaseBrake(); dropPedalGesture(); } },
}) : null;
// `?finishes` opens on the car finishes' false-colour view (util/geo.js) — the same switch as the
// panel's "Show finishes", reachable from a screenshot URL, which has no panel.
if (debugParams.has('finishes')) setGlossGlobal('showFinishes', true);

// The Loco Mode ramp. Pushed into the panel rather than imported by it for the same reason the
// difficulty knobs are pushed into `sim/` — the sim owns these numbers, and the panel is one more
// thing allowed to move them, alongside `traffic.taxi.boost` and `setCarCount`.
//
// Hoisted out of the panel's arguments so `window.__taxi.loco` can hand out the same handle. The
// panel's sliders are bounded and this is not: `setLocoTuning` takes any finite positive number,
// so `__taxi.loco.set({ overdriveSpeed: 60 })` from the console is the way past the top of a
// slider. There is nothing to protect — a silly number makes a silly game, which is the point.
const loco = {
  get: locoTuning, set: setLocoTuning, reset: resetLocoTuning, ramp: locoRamp,
  defaults: LOCO_DEFAULTS,
  /**
   * Persist the current tuning, or forget it once it is back to shipped — so "Reset" survives a
   * reload as surely as a tweak does. Returns whether the stash now matches what is on screen,
   * which is false only when storage refused the write. See game/locostash.js.
   */
  save: () => {
    const tuning = locoTuning();
    const tweaked = Object.keys(LOCO_DEFAULTS).some((key) => tuning[key] !== LOCO_DEFAULTS[key]);
    if (!tweaked) return clearLocoTuning();
    return saveLocoTuning(tuning);
  },
};

/**
 * Restore a stashed tuning — **only under `?debug`**, and before the warmup below, so the ten sim
 * seconds it drives run on the same numbers the rest of the page will.
 *
 * The gate is the whole point rather than a precaution. Without the panel on screen nothing says
 * the game is not the game, so a stash left over from a tuning session would make an ordinary run
 * silently unlike everyone else's — and put its score on the table. Shot mode is out for the same
 * reason from the other end: a screenshot has to be of the shipped build.
 */
const stashedLoco = !shot && wantsDebugPanel ? loadLocoTuning() : null;
if (stashedLoco) loco.set(stashedLoco);

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

  // Run forward until the patrol cruiser has been in town for a few seconds, so the shot shows it
  // out on patrol — in traffic, bar swinging red and blue, which is how a player meets it. It comes in
  // at the island's edge dissolving in (FADE_TIME in sim/police.js), so the first frames of a patrol
  // are exactly the ones not worth photographing — and four seconds is well past the fade.
  if (shot.untilPolice) {
    patrol.state.cooldown = 0;
    let onPatrol = 0;
    for (let guard = 0; guard < 90 * 60 && onPatrol < 4 * 60; guard++) {
      traffic.update(1 / 60);
      patrol.update(1 / 60);
      police.update(1 / 60);
      fares.update(1 / 60, traffic.taxi);
      if (patrol.state.phase === 'patrol') onPatrol += 1;
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
  let wreckStep = null;
  if (shot.wreckAt) {
    // Offset by a couple of units along the victim's heading rather than parked exactly on it: a
    // real impact leaves the two centres about that far apart, and the pair of detonations spread
    // across both bodies is half of what the crash looks like.
    const victim = traffic.cars.find((c) => !c.isTaxi && c.state === 'drive');
    traffic.taxi.x = victim.x - Math.cos(victim.yaw) * 2;
    traffic.taxi.z = victim.z + Math.sin(victim.yaw) * 2;
    traffic.taxi.yaw = victim.yaw;
    // **One staged frame before the boost goes on**, and it is not optional. A taxi's `x`/`z` are
    // derived from its lane every frame, so writing them by hand moves the *collision test* onto
    // the victim and nothing else: the impact fires from the frame the flag goes on, `crashed`
    // takes the taxi out of the render loop on that same frame, and `taxiGroup` is therefore
    // handed to the wreck still standing wherever the warm-up left it — on seed 1234, 65 units
    // away from the fire. `staged` is the flag that says "whoever is driving this by hand owns its
    // position" and is the one state the render loop honours without a lane, so one update through
    // it is what puts the group where the crash is about to happen. Not `stageCar()`, which zeroes
    // the speed the whole blast is sized off.
    //
    // It was invisible for as long as the shells faded out inside a third of a second: the taxi's
    // vanished off-screen and the picture was one car's wreck, which is what a crash looked like.
    traffic.taxi.staged = true;
    traffic.update(1 / 60);
    traffic.taxi.staged = false;
    traffic.taxi.boost = true;
    // One hit from the end, so the staged contact is the wreck rather than a bump.
    traffic.taxi.hp = 1;
    for (let guard = 0; guard < 90 && !traffic.taxi.crashed; guard++) {
      collisions.update();
      traffic.update(1 / 60);
    }
    controller.state.target.set(endSpot?.x ?? victim.x, 0, endSpot?.z ?? victim.z);
    controller.update(aspect());
    // `&wreckAt=` overrides the shot's own beat, and `window.__wreckStep(frames)` steps the same
    // pools on and redraws — which is how tools/wreckreel.mjs films the whole crash a frame at a
    // time out of one staging, rather than restaging it once per frame.
    const wreckAt = Number(new URLSearchParams(window.location.search).get('wreckAt') ?? shot.wreckAt);
    wreckStep = (frames) => { for (let step = 0; step < frames; step++) stepWreck(); };
    wreckStep(Math.round(wreckAt * 60));
  }
  function stepWreck() {
    blast.update(1 / 60);
    wreckage.update(1 / 60);
    ejection.update(1 / 60);
    windshield.update(1 / 60);
    struckGlass.update(1 / 60);
    // The smoke collar is part of the wreck now, and it lives in the dust pool rather than in
    // blast.js — left out of this loop, `?shot=12` would freeze a crash with its smoke still
    // stacked on the impact point at zero age.
    dust.update(1 / 60);
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

  // The pond, framed on the water itself. `pond-far` uses the same aim at play zoom, which is why
  // this is one flag and not two: the question the far shot asks is whether the thing you can see
  // close up is still legible in the frame the game is actually played in, and that only means
  // anything if both are pointed at the same water.
  if (shot.atPond && ducks.pond) {
    controller.state.target.set(ducks.pond.x, 0, ducks.pond.z);
    controller.update(aspect());
  }

  // The basketball court, on the same terms as the pond: one flag for the close and the far frame.
  if (shot.atCourt && hoopers.court) {
    controller.state.target.set(hoopers.court.x, 0, hoopers.court.z);
    controller.update(aspect());
  }
  // And the L, framed on its focus, where the train is settled below: the corner where it turns
  // west, or over the river crossing on the straight north-south line (`?ltrainwest=classic`).
  if (shot.atLTrain && ltrain) {
    const at = ltrain.plan.focus;
    controller.state.target.set(at.x, 0, at.z);
    controller.update(aspect());
  }
  // And the skatepark, the same way.
  if (shot.atSkatepark && skaters.park) {
    controller.state.target.set(skaters.park.x, 0, skaters.park.z);
    controller.update(aspect());
  }

  // The burger joint, framed on the drive-through lane rather than on the building — which is one
  // flag for both of its framings, for exactly the reason the pond's is. The close shot asks
  // whether a burger on a pole and a car at a window read as what they are; the far one asks
  // whether any of it survives the frame the game is actually played in, and that only means
  // anything if the two are pointed at the same lane.
  if (shot.atBurger && burger) {
    controller.state.target.set(burger.site.focus.x, 0, burger.site.focus.z);
    controller.update(aspect());
  }
  // The roadside business, framed on its lot; and its tube man, close enough to see his face.
  if (shot.atCarWash && roadside) {
    controller.state.target.set(roadside.site.focus.x, 0, roadside.site.focus.z);
    controller.update(aspect());
  }
  if (shot.atTubeMan && tubeMan.at) {
    controller.state.target.set(tubeMan.at.x, 0, tubeMan.at.z);
    controller.update(aspect());
  }

  // And the depot, on the same two framings. `site.focus` is the middle of the door opening, which
  // is a couple of units below the middle of the building — but an orthographic camera aimed at a
  // point in the air is aimed at the wrong point on the ground (see the birds), so the target is
  // taken flat off the ground the way every other `at*` shot here takes it.
  if (shot.atGraveyard && graveyard) {
    controller.state.target.set(graveyard.site.focus.x, 0, graveyard.site.focus.z);
    controller.update(aspect());
  }

  // A manhole cover, the first one planned: close, does it read as iron; at play zoom, is it a
  // detail you notice or noise on the road.
  if (shot.atManhole && manholes) {
    // `atManhole: 'steam'` is the first one venting instead.
    const spots = manholes.userData.spots;
    const at = (shot.atManhole === 'steam' && spots.find((s) => s.steam)) || spots[0];
    controller.state.target.set(at.x, 0, at.z);
    controller.update(aspect());
  }

  // The one paved junction: which one it is lives in the paint uniforms, as (i, j).
  if (shot.atPlaza) {
    const at = PAINT_UNIFORMS.uJunctionAt.value;
    if (at.x >= 0) {
      controller.state.target.set(lineX(at.x), 0, lineZ(at.y));
      controller.update(aspect());
    }
  }

  // A post box or the hot dog cart (game/streetprops.js), standing or — with `streetPropSmash` —
  // that many seconds after a taxi swiped it. The swipe is staged by hand with a stand-in taxi
  // heading up the prop's lane at the Loco cruise, since nothing in a still frame drives there.
  if (shot.atStreetProp) {
    const prop = streetProps.props.find((p) => p.kind === shot.atStreetProp);
    if (prop) {
      if (shot.streetPropSmash) {
        streetProps.smash(prop, { yaw: -Math.PI / 2, v: SPEED * 1.6, x: prop.x, z: prop.z });
        streetProps.settle(shot.streetPropSmash);
        for (let t = 0; t < shot.streetPropSmash; t += 1 / 60) dust.update(1 / 60);
      }
      controller.state.target.set(prop.x, 0, prop.z);
      controller.update(aspect());
    }
  }

  // A pile of bags (game/garbage.js) — and with `garbageAt`, the truck parked at it that many
  // seconds into taking it. The pile nearest the city's middle, so the framing does not depend on
  // which piles this seed drew at the coast.
  if (shot.atTrashPile && garbage.piles.length) {
    const pile = garbage.piles.reduce((a, b) => (Math.hypot(b.x, b.z) < Math.hypot(a.x, a.z) ? b : a));
    if (shot.garbageAt != null) garbage.stage(pile, shot.garbageAt, () => traffic.update(1 / 60));
    controller.state.target.set(pile.x, 0, pile.z);
    controller.update(aspect());
  }

  if (shot.atDepot && garage) {
    controller.state.target.set(garage.site.focus.x, 0, garage.site.focus.z);
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

  // Run the drawbridge's own cycle forward and freeze it, aimed at the span. Like the wreck and
  // the flyover, the lift has no steady state — it is up for a dozen seconds once or twice a
  // session — so the only way to look at it is to stage it. The cycle is the *real* one, stepped
  // rather than posed, so a screenshot cannot drift out of step with what the player gets.
  //
  // The boats are placed by `settle()` above and then stepped along with it, which is what puts the
  // tug at the span rather than wherever a minute and a half of waiting would have left it.
  if (shot.drawbridgeAt !== undefined && drawbridge) {
    // The boats are placed **before** the cycle is stepped, not after. `settle()` further down runs
    // for every other shot and would have put the tug down at the end of a cycle it had taken no
    // part in — parked short of a bridge that opened for nobody, which is the picture this framing
    // exists to not be.
    boats?.settle();
    drawbridge.request();
    for (let step = 0; step < Math.round(shot.drawbridgeAt * 60); step++) {
      boats?.update(1 / 60);
      drawbridge.update(1 / 60, traffic.cars);
      // **The traffic has to run too, and this is not optional staging.** `clearing` holds until
      // the deck is empty, and a car left standing on it by the warm-up never drives off unless the
      // sim is stepped — so a shot that ticked only the bridge photographed a span with its
      // lamps flashing and its leaf still flat, every time, which is a real state and not the one
      // being framed.
      traffic.update(1 / 60);
    }
    const barge = shot.onBarge ? boats?.boats.find((b) => b.kind === 'barge') : null;
    if (barge) controller.state.target.set(barge.x, 0, barge.z);
    else controller.state.target.set(drawbridge.span.cx, 0, (drawbridge.span.z0 + drawbridge.span.z1) / 2);
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

  // The package courier. Its board is gated on a delivered fare and a spawn gap, neither of which a
  // still frame has time for, so the gate is opened by hand: `delivered` is faked past
  // `PARCEL_MIN_DELIVERED` and the stagger is reset, then one tick puts a box on a corner.
  //
  // Only reachable with `?parcels=1`, which is also what turns the layer on in shot mode at all.
  if (shot.untilParcel && parcels) {
    // Which load to photograph, when the shot asks for a particular one. Which kind a package is
    // carrying is a coin flip inside the run seed, so a framing of the food order that waited for the
    // draw to answer would be a framing that moves the day anything upstream of it changes.
    if (shot.cargoKind) parcels.forceKind(shot.cargoKind);
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
    const c = kerbFor(framed);
    controller.state.target.set(c.x, 0, c.z);
    controller.update(aspect());
  }


  // Not at a fare: at the opposite corner of the map, which is the only way to get a route
  // long enough to judge the band that draws it.
  if (shot.routeFar) {
    routeTo({
      i: traffic.taxi.i > GRID_I / 2 ? 0 : GRID_I,
      j: traffic.taxi.j > GRID_J / 2 ? 0 : GRID_J,
    });
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
  // The lot is filled by hand, for the reason the helicopter and the flock are staged: a shot
  // ticks the world once, and a drive-through left to fill itself is one photographed empty. The
  // sim frame after it is not optional — `settle` writes each car's position, and the *instanced*
  // matrix those cars are drawn from is composed inside `traffic.update`, so without it three
  // cars are standing in a lot that nothing has been told about.
  if (driveThru) {
    driveThru.settle();
    traffic.update(1 / 60);
  }
  fares.settleMarkers();
  parcels?.settleMarkers();
  // The river's own two, for the drive-through's reason: a shot ticks the world once, so a boat
  // that has not been spawned yet never will be and every screenshot of the river is of an empty
  // one. `settle` places one of each beside the lifting span instead of waiting a minute for a tug.
  boats?.settle();
  harborShips?.settle();
  drawbridge?.settle();
  // A train mid-crossing over the frame's own target, and the deck already faded over the board.
  // `&introAt=1.9` instead freezes the L's own intro that many seconds in, from the frame's target,
  // with no train on it yet — for looking at the intro a frame at a time.
  const introAt = Number(new URLSearchParams(window.location.search).get('introAt') ?? NaN);
  const freezeIntro = Boolean(ltrain?.intro) && Number.isFinite(introAt);
  if (ltrain) {
    if (!freezeIntro) ltrain.settle(controller.state.target);
    ltrain.setFadePoints(ltrainFadePoints());
    ltrain.setBeams(Math.max(runningLightsAt(ltrain.plan.world(ltrain.state.x).x, ltrain.plan.world(ltrain.state.x).z),
      1 - THREE.MathUtils.smoothstep(sun.intensity, 0.3, 2.6)));
    sparks.update(0.12);
  }
  // The city's own entrance is an animation that opens at zero too — unsettled, every screenshot
  // is an empty street grid.
  cityEntry.settle();
  if (freezeIntro) {
    ltrain.intro.start(controller.state.target, cityEntry.tuning());
    ltrain.intro.update(introAt);
  } else {
    ltrain?.intro?.settle();
  }
  // Shot mode never stages the taxi, so there is no vignette to land — but the garage still has to
  // be in the state a run is actually played in, which is shut, the car long gone and the door
  // come down behind it.
  garage?.setDoor(0);
  renderFrame();
  if (wreckStep) window.__wreckStep = (frames = 1) => { wreckStep(frames); renderFrame(); };
  // A still cannot say whether steam billows, and shot mode never draws a second frame: this steps
  // the plumes on and redraws, for filming them (shots `steam` and `steam-far`).
  window.__steamStep = (dt = 1 / 30) => { manholeSteam.update(dt, null); renderFrame(); };
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
      isBlocked: () => parked() || cityEntry.running(),
      // Off the kerb. The same pool and the same call the boost trail uses, at about half a
      // barricade's power — two wheels coming off a 0.35-unit lip, not a car landing off a ramp.
      onDrop: () => dust.burst(traffic.taxi.x, traffic.taxi.z, traffic.taxi.yaw, 7, 0.5),
      // The nose out into daylight: the fender catches the sun. See game/glint.js.
      onClear: () => glint?.fire(),
      // What a repair visit shows while the door is down to its gap. See game/repairfx.js.
      workshop: repairFx,
      // The car stays in its doorway until the dash radio's first song has played crushed for a
      // few seconds (`DASH.music` in game/sfx.js), so the open lands on music, not the announcer.
      holdReveal: () => Boolean(sfx?.state.dashRadio) && sfx.dashMusicSeconds() < DASH.music,
    });
    // `?vignette=off`, the same escape hatch `?tutorial=off` is: the opening is seven seconds
    // long and nobody iterating on the fare loop wants it on every reload. The module is
    // still constructed and then *landed* rather than not built at all, so the skip goes through
    // the same handover the real sequence does — a skip that reached the game by a different route
    // would be a second opening to keep working.
    if (!wantsVignette) opening.settle();

    // **Tap anywhere to skip it.** No button and no "skip" label: the vignette is seven seconds at
    // the top of a run the player has already chosen to start, so the affordance costs more screen
    // than the thing it escapes — and a tap is what every other beat of the opening already answers
    // to (the tutorial's bubbles, the Home Screen screen, the run-end tally).
    //
    // Three things it is careful about:
    //   - **Only while the vignette owns the camera.** `holdsCamera()` is false in `wait`, which is
    //     the city's own entrance still building itself: a tap there belongs to the city rising, and
    //     skipping a sequence that has not started reads as the tap having broken something.
    //   - **Only a tap on the city.** The ⏸ is live through all of this (it is not part of the HUD's
    //     entrance), and a `window` listener would otherwise skip the opening *and* pause the game
    //     on the same press. Every other pointer target on the page is a control with its own job.
    //   - **`pointerdown`, not `click`.** A skip has to land on the press or it reads as laggy on
    //     the one gesture whose whole promise is getting out of a wait. Nothing here is tappable
    //     while the vignette runs — the board is held empty, the HUD has not arrived and there is no
    //     route band — so there is no gesture for this one to steal.
    const skipVignette = (event) => {
      if (!opening?.running()) {
        window.removeEventListener('pointerdown', skipVignette);
        return;
      }
      if (!opening.holdsCamera() || event.target !== renderer.domElement) return;
      // Behind the black, always: `opening.skip()` throws the camera across the map, and doing that
      // in plain sight is a worse thing to watch than the vignette was. See game/wipe.js.
      if (wipe) wipe.cut(() => opening.skip()); else opening.skip();
      window.removeEventListener('pointerdown', skipVignette);
    };
    if (wantsVignette) window.addEventListener('pointerdown', skipVignette);
  }
  // Re-aim the entrance wave at the taxi *after* the warmup: it was created with the spawn
  // point, and ten sim-seconds of warmup drive the taxi a couple of blocks from there — so the
  // wave was visibly emanating from a spot the player's car had already left. Costs nothing:
  // the entrance clock hasn't taken its first tick yet. With a garage in the city the taxi is
  // already parked inside it by now, so the city builds itself outward from the depot — which is
  // exactly where the camera is about to go.
  cityEntry.replay(traffic.taxi);
  replayLTrainIntro(traffic.taxi);
  // Every program the city needs, linked here rather than on the frame that first draws it.
  //
  // Three compiles a material's shader lazily, at its first draw, and half this game's meshes are
  // pooled effects sitting in the scene with `visible = false` — a blast, a wreck, a rider's
  // crystal, a roadworks zone. Each of those linked its program on the frame it first appeared,
  // which is to say on the frame something interesting was happening. `compile()` walks the scene
  // with `traverse`, not `traverseVisible`, so the hidden ones are covered too: measured at
  // `tools/links.mjs`, it moves six program links out of the run and into the boot, where they are
  // behind the wipe and the vignette and nobody is being made to wait for them mid-corner.
  renderer.compile(scene, camera);
  // ...and drawn once, because linking is not the whole of a first sight on iOS: Metal builds its
  // pipelines and three uploads the buffers on the first *draw*, per pass. Left to the run, that
  // was a first play that hitched every time the camera reached somewhere new and a second play
  // that didn't (see game/warmup.js). `?warmup=classic` skips it. The second draw is so the frame
  // left in the canvas is the real one, not the city with every pool showing.
  if (new URLSearchParams(window.location.search).get('warmup') !== 'classic') {
    warmFirstDraws(scene, () => renderFrame());
    renderFrame();
  }
  const benchHooks = {
    renderer,
    ready: () => Boolean(traffic.taxi) && !traffic.taxi.staged,
    // The taxi on a job the whole time, so each row measures the frame a player sees rather than an
    // idle city: the rider aboard to their drop-off, otherwise the most urgent rider on the kerb.
    drive: () => {
      if (fares.state.gameOver || traffic.taxi.pendingTarget) return;
      const riding = fares.carrying();
      if (riding) dispatchToDropoff(riding);
      else dispatchToRider(fares.state.fares.find((f) => f.stage === 'waiting'));
    },
    ended: () => fares.state.gameOver,
    gpu: describeGpu(renderer.getContext()).renderer,
  };
  // `?bench` or `?soak` — at most one; see game/bench.js and game/soak.js.
  bench = createBench(benchHooks) ?? createSoak(benchHooks);
  frame(performance.now());
}

if (!shot && wantsDebugPanel) {
  debugPanel = createDebugPanel({
    phoneFrame,
    sun,
    hemi,
    sky,
    fog,
    daylight,
    carCount: getCarCount(),
    fares: { getSeconds: getFareSeconds, setSeconds: setFareSeconds, isPinned: isFareClockPinned },
    routeLine,
    ao,
    crayon,
    cartoon,
    bloom,
    hdr,
    crt,
    scores: { load: loadScores, clear: clearScores },
    clouds,
    inspect,
    // The entrance levers. The panel's replay re-aims the wave at wherever the taxi is *now* —
    // the point of replaying from the panel is judging the opening, and the opening's wave starts
    // at the player's car.
    cityEntry: {
      tuning: cityEntry.tuning,
      tune: cityEntry.tune,
      replay: () => { cityEntry.replay(traffic.taxi); replayLTrainIntro(traffic.taxi); },
    },
    loco,
    /** True when the sliders opened on a tuning restored from a previous session. */
    locoRestored: Boolean(stashedLoco),
    sfx,
    soundTriggers,
    soundHolds,
    soundPlace,
    wreck: { styles: Object.keys(WRECK_STYLES), current: getWreckStyle(), set: blast.setStyle },
  });
}

window.__taxi = {
  traffic,
  // The CRT screen's `{ state, set, preset }` — see game/crt.js.
  crt,
  locoFlame,
  // The city camera — `state.punch` is how a browser test stages a cut opening on a held Loco push-in.
  controller,
  // The combo meter — see game/combometer.js — and the drop-off that cashes it in.
  combo,
  landCombo,
  popComboPayout,
  // The crash replay and its recording — see game/replay.js.
  replay,
  tape,
  daylight,
  boost,
  // The bump's starburst, so a check can fire one where it can see it — see game/impact.js.
  impact,
  // And the tiers of damage the car wears, so a check can stage one — see game/taxidamage.js.
  taxiDamage,
  // ...and on the cars it hits — see game/cardamage.js.
  carDamage,
  /**
   * Loco Mode's speed ramp — `get`, `set`, `reset`, `ramp`, `defaults`. The ⚙️ panel's sliders
   * drive the same handle, so this is where you go for a value past the end of one of them.
   */
  loco,
  /**
   * The two look modes — `{ state, set }` each, the same handles the ⚙️ panel's sliders drive.
   * Here for the reason `loco` is: this is where you go for a value past the end of a slider, and
   * where a browser test reaches a look it cannot see from a still. `set(key, value)` takes any key
   * in `state`; see CRAYON_DEFAULTS and CARTOON_DEFAULTS for what each one means. Both are inert
   * stubs unless their flag is on.
   */
  crayon,
  cartoon,
  /** Rain Mode's handles — uniforms and the mirror target. Inert unless `?rain`. */
  rain,
  /** The storm's clock — `pin(v)`, `seek(t)` and its `state`. Null unless `?storm` or `?rain`. */
  storm,
  /** The squall — its `cell`, `state`, `pin(v)`, `seek(t)`, `wetAt`, `rainAt`. Null unless `?squall`. */
  squall,
  /** The squall's falling leaves — `stats()`, `positions()`. Null with `?fall=off` or no squall. */
  leaves,
  /**
   * The two bloom routes — `{ state, set }` each, the same handles the ⚙️ panel drives, plus
   * `target()` on the emissive one so a browser test can look at what the lamps actually wrote.
   * Only ever one of them is enabled; the other is an inert stub. See game/bloom.js, game/hdr.js.
   */
  bloom,
  hdr,
  tutorial,
  /** Dispatch's bubble — the robbery's and the patrol chase's — or null in shot mode. See game/radio.js. */
  radio,
  carGhosts,
  skids,
  // The wet tyres — spray and tracks, `?wet=` (see `wetTyres`).
  spray,
  wetTracks,
  police,
  /** The patrol cruisers' lives — patrol, chase, leave — as one. See game/patrol.js. */
  patrol,
  /** ...and each one on its own: one per cruiser, `difficulty.patrolCount()` of them out. */
  patrols,
  /** The brake-tap spin (game/bootleg.js) — `spin()` fires one, `state` tallies them. */
  bootleg,
  overtake,
  /**
   * The "New Move Unlocked" card (game/newmove.js), null in shot mode. `open(name)` shows that
   * move's card ('uturn', the default, or 'drift') now, whatever the gates say; `seen` is the
   * U-turn's remembered flag and `moves` every move's, `wanted`/`calm` the two gates, `next` the
   * move a drop-off at that many deliveries would teach.
   */
  newMove: newMove && {
    open: (name = 'uturn') => openNewMove(name === 'repair' ? repairCard : moves[name]), isOpen: newMove.isOpen, close: newMove.close,
    seek: newMove.seek, seen: moves.uturn.seen, moves, wanted: newMoveWanted, calm: newMoveCalm,
    due: () => newMoveIn, next: (n) => nextMove(n)?.line ?? null, showing: () => newMove.move()?.line ?? null,
  },
  /**
   * The z-fighting scan (util/zfight.js) over the live scene, down the game's own view. It is what
   * `tools/zfight.mjs` checks headless, here over everything main.js actually added — including
   * whatever the tool's copy of the city has not caught up with. Logs a line per tie, returns them.
   */
  zfight: () => {
    const found = findZFighting(scene, { view: VIEW_DIR });
    console.log(found.length ? describeZFighting(found, 50).join('\n') : 'no z-fighting found');
    return found;
  },
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
  chaseSiren,
  /**
   * The "back to the taxi" chip, for `tools/smoke.mjs`: `isUp()` is whether it is currently
   * offering itself. Browser-only in the same way the cargo chip is — a WebGL context in a DOM
   * node, driven off a projection through the live camera. Null unless `?taxifinder=classic`.
   */
  taxiFinder,
  flyover,
  chopper,
  /** The weather ringing the island — `clouds.state` is where the band is, `clouds.clouds` the sky. */
  clouds,
  /**
   * The taxi's depot and the vignette that comes out of it, or null on a city with nowhere to put
   * one (and, for `opening`, in shot mode). `garage.setDoor(0..1)` scrubs the shutter by hand and
   * `opening.phase()` names where the sequence has got to — which is how `tools/smoke.mjs` watches
   * it without guessing at wallclock.
   */
  garage,
  opening: () => opening,
  /**
   * The title screen (null in shot mode, on `?title=off`, and after "Play again"), and the
   * settings it writes. `title.holding()` is the run's gate; `tutorial()` is live rather than the
   * snapshot `tutorial` above, because Play with the tips off is what drops it.
   */
  title,
  settings,
  tutorialNow: () => tutorial,
  /**
   * The burger joint and its drive-through, or null on a city with nowhere to put one.
   * `burger.site` is every number the lane is built from and `driveThru.state.queue` is who is
   * currently in it — which is how `tools/probe.mjs` watches the lot without guessing at wallclock.
   */
  burger,
  driveThru,
  /**
   * The bank robbery, or null on a city with nowhere to put a bank and in shot mode.
   * `robbery.site` is the building (`city/bank.js`), `robbery.state.active` is whether one is
   * running and `robbery.range()` how far the taxi currently is from the door — which is how a
   * browser test watches the trigger without guessing at wallclock. See game/robbery.js.
   */
  robbery,
  /** The getaway's police helicopter, or null with no robbery — see game/policeheli.js. */
  policeHeli,
  /** The banknotes a boosting getaway throws — `live()` is how many are in the air. */
  cashTrail,
  /**
   * The player's own trip through that lot, or null with it — `state`, `send()`, `active()`,
   * `holdsTaxi()`. `send()` is what a tap on the joint does, so a browser test can take the secret
   * without having to land a synthesised click on a building.
   */
  burgerRun,
  /**
   * The street race, or null under `?race=classic` and in shot mode — `state.phase`, `summon()` to
   * bring a racer now if the taxi is free. See game/race.js.
   */
  race,
  /** The trip back to the depot for repairs — `depotRun.send()` is the tap on the garage. */
  depotRun,
  /** The glint off the fender on the way out of the garage — see game/glint.js. Null under `?glint=classic`. */
  glint,
  /** The depot's tip card — `newMove.open('repair')` opens it. See game/repairclip.js. */
  repairCard,
  depotCall,
  sendForRepairs,
  /** The opening rise-out-of-the-ground animation. `cityEntry.replay()` reruns it on demand. */
  cityEntry,
  // Every flock in the city, in build order — `flocks[0]` is the one shot 18 frames.
  flocks,
  /** The birds on the park pond, and `ducks.pond` the water they are on — null if the city has none. */
  ducks,
  /** The players on the basketball court, and `hoopers.court` the court — absent if the city has none. */
  hoopers,
  /** The boom box beside the court — `boombox.emitter` is where its music will play from. */
  boombox,
  /** The steam out of the manhole covers — `vents` are its covers, `kick` how torn each plume is. */
  manholeSteam,
  /** The tube man on the roadside lot's corner — `tubeMan.at` is where he stands, null with none. */
  tubeMan,
  /** The car wash or gas station (`?roadside=`), or null. */
  roadside,
  /** The riders on the skatepark, and `skaters.park` the park — absent if the city has none. */
  skaters,
  /** The elevated train, or null under `?ltrain=classic` — see game/ltrain.js. */
  ltrain,
  roadwork,
  /** The truck that sheds crates. `flatbed.stage()` starts it now; `state`, `crates`, `loose()`. */
  flatbed,
  /** Box trucks spilling their load. `boxSpill.hit(truck, closing)` rams one; `boxes`, `doors`. */
  boxSpill,
  /** The building fire and its engine. `fire.ignite()` starts one now; `state`, `engine`. */
  fire,
  /** The bag piles and the garbage truck. `garbage.spawn()` brings the truck on now; `piles`, `state`. */
  garbage,
  pause,
  routeTo,
  findRoute,
  // The lifting span, so a reel or a hand test can ask for a lift and stage the Mega Air jump.
  drawbridge,
  findRouteVia,
  /** The route-band drag, for `tools/smoke.mjs`: `isGrabbing`, `didDrag`, `via`. */
  pathDrag,
  camera: controller,
  /**
   * The talk at /talk/ (src/talk/talk.js) drives the game from outside, through a same-origin
   * iframe. `hold(true)` freezes the world the way the pause does but with nothing drawn over it;
   * `settle()` finishes the city's entrance at once, so the still is a whole city. Everything else
   * the talk does — the camera's close-up, hiding the HUD — it does from its own side.
   */
  presenter: {
    hold: (on) => { presenterHeld = Boolean(on); },
    held: () => presenterHeld,
    settle: () => {
      if (cityEntry.running()) cityEntry.settle();
      if (ltrain?.intro?.running()) ltrain.intro.settle();
    },
  },
  /**
   * A world point in viewport pixels, the kerb corner a fare's marks stand on, and the frame the
   * renderer actually draws — for `tools/smoke.mjs`, which uses the three together to work out
   * which fares are outside the frame and assert that each one has an edge arrow on it (see
   * game/farepointers.js). The same functions the HUD aims with, so a test cannot disagree with the
   * game about where a mark is or how big the frame around it is.
   */
  projectToScreen,
  cornerFor,
  viewport,
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
   * Hurt the taxi as a bump would — `damage` HP off, the hit landing on its front right corner — with
   * none of the bump's shove. Everything the car wears for it (game/taxidamage.js) and the hit cue
   * (`?hitcue=`, game/hitcue.js) play as they would for real. For judging the look on a phone, and
   * for the frames in a PR. Never empties the car: the wreck is collisions.js's to call.
   */
  /**
   * Wreck the taxi into the nearest car, as a last-HP hit would — the blast, the replay and the
   * run-end card with its polaroid. For the frames in a PR; nothing in the game calls it.
   */
  wreck: () => {
    const taxi = traffic.taxi;
    let near = null;
    let best = Infinity;
    for (const car of traffic.cars) {
      if (car.crashed) continue;
      const d = Math.hypot(car.x - taxi.x, car.z - taxi.z);
      if (d < best) { best = d; near = car; }
    }
    if (!near) return false;
    taxi.hp = 1;
    return collisions.strike(near);
  },
  hurt: (damage = 24) => {
    const taxi = traffic.taxi;
    damage = Math.min(damage, taxi.hp - 1);
    taxi.hp -= damage;
    taxiDamage.hit(taxi.x + Math.cos(taxi.yaw) * 1.5 + Math.sin(taxi.yaw) * 0.7,
      taxi.z - Math.sin(taxi.yaw) * 1.5 + Math.cos(taxi.yaw) * 0.7);
    hitCue?.hit({ damage, hp: taxi.hp, taxi });
  },
  /**
   * Fire one haptic by name — `'pick'` or `'loco'`, see `src/util/haptics.js`.
   *
   * Here because a haptic is the one thing this game does that **cannot be observed**: no pixel
   * changes, nothing is logged, and the only witness is a thumb. So the question "is the bridge
   * alive?" has no answer from the outside, and answering it by playing until the right event
   * happens conflates a broken bridge with a game that never fired one. `window.__taxi.haptic('loco')`
   * in Safari Web Inspector, against the app on a real phone, separates the two in one line.
   *
   * Note that a phone is genuinely required: there is no Taptic Engine in the Simulator or on any
   * iPad, and on those the whole path runs correctly and produces nothing.
   */
  haptic,
  /**
   * The sound — `state` says whether the context is up and how many of the files decoded, and
   * `play('crash')` fires any one-shot by name (see SFX_EVENTS in game/sfx.js). Null in shot mode.
   * A decode that failed is otherwise a single console warning and a silent event.
   * `tuning()`/`tune(partial)`/`reset()` are the mix the `?audio` panel edits (assets/audio/mix.json).
   */
  sfx: sfx ? {
    state: sfx.state, play: (name) => sfx.play(name),
    tuning: sfx.tuning, tune: sfx.tune, reset: sfx.reset,
    // The mixer's mute and solo, and the peak meter on Master — see BUSES in game/sfx.js.
    monitor: sfx.monitor, setMonitor: sfx.setMonitor, clearMonitor: sfx.clearMonitor,
    audible: sfx.audible, meter: sfx.meter,
    // The ⚙️ panel's Replace… — which local file, if any, stands in for a sound this session.
    replaced: sfx.replaced,
    // The long city sounds that are steered while they play, and their gain right now — for
    // checking a flight or a lift is actually being heard.
    steered: () => Object.fromEntries([['bridge', bridgeVoice], ['plane', planeVoice], ['heli', heliVoice]]
      .map(([k, v]) => [k, v ? Number(v.gain.gain.value.toFixed(4)) : null])),
  } : null,
  /**
   * Draw one frame on demand.
   *
   * Shot mode never starts the render loop — it warms the sim, renders once and stops — so a shot
   * poked from the console or over CDP keeps showing the frame it froze on. This is what makes a
   * frozen framing reviewable at states the shot list doesn't cover: set a fare's clock, redraw,
   * capture. Harmless while the loop is running, since the next frame overwrites it anyway.
   */
  redraw: () => renderFrame(),
  // The fog of war's clock, for filming its drift from a frozen shot: `edgeFogAt(12.5)` sets it and
  // redraws (game/edgefog.js).
  edgeFogAt: (seconds) => { tickEdgeFog(seconds); renderFrame(); },
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
    footHint: !gameOverClassic,
    statCount: !statCountClassic,
    tapRetry: !playAgainClassic,
    fit: !runEndFitClassic,
    ...opts,
  }),
  /** The polaroid's print as it stands, for tools/smoke.mjs: which grab it came from, or -1. */
  photoRank: () => snapshot?.rank() ?? -1,
  /** Screen-space helpers so the browser smoke test can click real pixels. */
  taxiScreenPosition: taxiScreenPos,
  /**
   * A point part way along the drawn route band, in screen space — the thing `tools/smoke.mjs`
   * has to press on to test the drag. Taken off the same `routePath` the band is built from, so a
   * band that stopped being drawn where the tool thinks it is fails rather than drifting.
   */
  /**
   * Where a street's midpoint lands on screen, for tools/smoke.mjs's street tap — `{ a, b }` as
   * game/streettap.js names one. Null if that point is behind a building, which a real finger could
   * not tap either.
   */
  streetScreenPosition: ({ a, b }) => {
    const x = (lineX(a.i) + lineX(b.i)) / 2;
    const z = (lineZ(a.j) + lineZ(b.j)) / 2;
    return sightlineClear(x, 0.1, z) ? projectToScreen(x, 0, z) : null;
  },
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
  /**
   * The pin the player is meant to be driving at — the newest one if two are on the board.
   *
   * Aimed at the **kerb corner**, which is where the marker is drawn and where the tap target sits
   * over it (geometry/marker.js). It used to aim at the junction centre, five units up, on the
   * strength of a hit box 20 units square that covered the junction and the corner alike. That box
   * is gone: it was picking the wrong marker whenever two were close together, and the aim it
   * licensed here was the same mistake — a tool tapping a point the player never taps.
   */
  targetScreenPosition: (fare = fares.focus()) => {
    if (!fare) return null;
    const c = kerbFor(fare);
    return projectToScreen(c.x, KERB_H, c.z);
  },
  /**
   * Where to tap to reach the live end of the courier errand, for `tools/smoke.mjs`.
   *
   * The tap is a picker interaction, which is the one class of thing the node suite is blind to:
   * everything it could assert about `divertToParcel` is the router's, and what a browser has to
   * answer is whether a finger on that corner reaches the hit box at all — the same reason the
   * route-band drag is smoke-tested rather than probed.
   *
   * Aimed at the middle of the pad, matching `targetScreenPosition` above — the tap target is the
   * marker's own silhouette now, so the only honest aim is the thing the player is looking at.
   */
  parcelScreenPosition: (parcel = parcels?.state.parcels[0]) => {
    if (!parcel) return null;
    const c = cornerFor(parcel.target.i, parcel.target.j);
    return projectToScreen(c.x, KERB_H, c.z);
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
