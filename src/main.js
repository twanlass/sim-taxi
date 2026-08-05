import * as THREE from 'three';
import { makeRng } from './util/rng.js';
import { createScene } from './game/scene.js';
import { createCityCamera, attachDragPan } from './game/camera.js';
import { createLayout } from './city/layout.js';
import { createGround } from './city/ground.js';
import { createBuildings } from './city/buildings.js';
import { createProps } from './city/props.js';
import { createTraffic, speedMph } from './sim/traffic.js';
import { createCollisions } from './sim/collisions.js';
import { createPolice, POLICE_BUST_RANGE } from './sim/police.js';
import { createFareSystem, cornerFor, setFareSeconds, getFareSeconds } from './game/fares.js';
import { createDebugPanel } from './game/debugpanel.js';
import { createBoost } from './game/boost.js';
import { createSkidMarks } from './game/skidmarks.js';
import { createDust } from './game/dust.js';
import { createSparks } from './game/sparks.js';
import { createSmoke } from './game/smoke.js';
import { createDebris } from './game/debris.js';
import { createFlames } from './game/flames.js';
import { createVanish } from './game/vanish.js';
import { showRunEnd } from './game/runend.js';
import { TAXI_TAILPIPE_BACK, TAXI_TAILPIPE_HEIGHT } from './geometry/taxi.js';
import { createDaylight, DAY_SECONDS } from './game/daylight.js';
import { createPicker } from './game/pick.js';
import { createRiderFinder } from './game/riderfinder.js';
import { createDropoffIndicator } from './game/dropoffindicator.js';
import { createRouteLine } from './game/routeline.js';
import { findRoute, planOrigin } from './game/route.js';
import { getActiveShot, getSeed, getRunSeed, getCarCount } from './util/shot.js';
import { isCityConnected, GRID } from './city/grid.js';
import { PALETTE } from './palette.js';

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

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: Boolean(shot),
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const { scene, sun, hemi, sky } = createScene();

// The clock that drives the sky. Parked at golden hour for now — the cycle works, but the night
// end of it needs more tuning before it earns its place, so it's off until the ⚙️ panel turns it
// on. Screenshots keep it frozen regardless: a rendered shot has to be reproducible.
const daylight = createDaylight({ sun, hemi, sky });
daylight.setDayLength(DAY_SECONDS);
daylight.setCycling(false);

// Every generator draws from its own stream so that changing one system doesn't reshuffle the
// others — editing building code shouldn't move the parks. `layout` was already produced above
// so the connectivity guard could reroll before we spent time meshing.
scene.add(createGround(makeRng(seed + 11), layout));
scene.add(createBuildings(makeRng(seed + 22), layout).mesh);
scene.add(createProps(makeRng(seed + 33), layout));

const traffic = createTraffic(makeRng(runSeed + 44), scene, getCarCount());
const fares = createFareSystem(makeRng(runSeed + 55), scene);
const police = createPolice(makeRng(runSeed + 66), scene);
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

// Screenshots frame themselves, and a shot run has no user to drag anything.
const pan = shot ? null : attachDragPan(controller, renderer.domElement, aspect, isNarrow);

const dust = createDust(scene, camera, makeRng(seed + 77));
const sparks = createSparks(scene, makeRng(runSeed + 88));
const smoke = createSmoke(scene, makeRng(runSeed + 99));
// One debris pool per car in a crash — a pool re-shoots its own pieces, so a shared one would
// snap the taxi's wreckage across to the other car's the instant the second burst fired.
const debris = createDebris(scene, makeRng(runSeed + 111));
const victimDebris = createDebris(scene, makeRng(runSeed + 122));
const flames = createFlames(scene, makeRng(runSeed + 133));
const vanish = createVanish();

// Collision detection between the taxi and ambient cars. Only fires while boosting — see
// src/sim/collisions.js. On impact *both* cars are wrecked: each detonates where it stands and
// each shell shrinks and fades into its own fireball, debris fires outward in their place, sparks
// burst, a smoke plume rises, the camera shakes and pulls into a close-up, the sim drops into
// slow-mo, boost is released, and the fare system flips into game-over — but the Game Over banner
// is held for CRASH_BANNER_DELAY (wallclock, so the delay is unaffected by the slow-mo).
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
  // Layered detonation: sparks and a first fireball at the point of impact, a big shower of
  // debris in place of the merged taxi shell, and a fat smoke plume climbing out of it. A second
  // fireball fires a beat later so the crash reads as an explosion with a follow-up flare rather
  // than a single one-frame pop — the setTimeout is wallclock so the follow-up lands during the
  // slow-mo ramp and stretches out cinematically.
  sparks.burst(x, z, 96);
  smoke.burst(x, z);
  flames.blast(x, z, 48);
  debris.burst(x, z);
  controller.kickShake(2.4);

  // The car that was hit gets the whole treatment too, fired at its own centre rather than at the
  // shared impact point. The two are only a couple of units apart, but that is enough to spread
  // the blast across both bodies instead of stacking it on the seam between them — and its
  // wreckage comes apart in its own paint, so what lands on the road is visibly two cars.
  //
  // It used to spin out, snap back onto a lane and drive away. A boosting taxi arrives at ~19 u/s
  // and the survivor shrugging that off made the player's own wreck look like a rule rather than
  // a crash.
  const ox = other.x;
  const oz = other.z;
  sparks.burst(ox, oz, 64);
  smoke.burst(ox, oz, 40);
  flames.blast(ox, oz, 40);
  victimDebris.burst(ox, oz, PALETTE.carBody[other.colorIndex]);

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
  setTimeout(() => {
    flames.blast(x, z, 32);
    flames.blast(ox, oz, 24);
    smoke.burst(x, z, 28);
    sparks.burst(x, z, 32);
    controller.kickShake(1.1);
  }, 260);
});

/**
 * Boost past a cop and you're done — reuses the wreck cinematic (zoom, slow-mo, delayed banner)
 * so the beat is the same as a collision, but the taxi stays visible (no debris, no smoke) since
 * nothing hit it. The taxi is flagged crashed so it freezes on the spot for the pull-in, and the
 * fare system's title/reason drive the "Busted" banner.
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
  fares.crash('You were caught by the police for reckless driving.', 'Busted');
}

function checkPoliceBust() {
  if (!boost.isActive()) return;
  if (!police.state.active) return;
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
      flash('Drop off your rider first');
      return;
    }

    if (routeTo(fare.target)) {
      fares.markDirected(fare);
      flash('On the way');
    }
  },
  () => Boolean(pan?.didPan()),
);

// Camera shortcut: frame the waiting rider on demand. At play zoom on a phone the rider is a
// handful of pixels somewhere on a map that no longer fits in one screen, so a button that snaps
// the camera onto them is faster than hunting for their meter by hand.
function snapToRider(fare) {
  if (!fare) return;
  const c = cornerFor(fare.target.i, fare.target.j);
  controller.state.target.set(c.x, 0, c.z);
  controller.update(aspect());
}

// Double-tap the chip to actually dispatch the taxi at that rider — same effect as tapping their
// pin on the map, without having to find it first. A pickup while already carrying someone would
// be refused at the picker; keep the rule consistent here by showing the same toast.
function dispatchToRider(fare) {
  if (!fare || fares.state.gameOver) return;
  if (fares.carrying()) { flash('Drop off your rider first'); return; }
  if (routeTo(fare.target)) {
    fares.markDirected(fare);
    flash('On the way');
  }
}

const riderFinder = createRiderFinder({ onTap: snapToRider, onDoubleTap: dispatchToRider });
const dropoffIndicator = createDropoffIndicator({
  camera,
  // Aim at the kerb corner where the pin actually stands, not the intersection centre — the
  // pointer's job is to show where the marker went off-screen, and the marker isn't at the
  // junction.
  pinLocation: cornerFor,
});

// --- HUD --------------------------------------------------------------------

const hud = {
  money: document.getElementById('money'),
  banner: document.getElementById('run-end'),
  toast: document.getElementById('toast'),
};

// The counter lags the payout on purpose: the flying "$X" rises off the taxi, travels to the HUD,
// and only when it lands does the total tick up — so the payout has a visible path from the world
// into the counter rather than a number silently changing in the corner.
let shownMoney = 0;
let moneyRoll = null;

/** Screen position of the taxi, for anchoring the earnings pop. */
function taxiScreenPos() {
  const v = new THREE.Vector3(traffic.taxi.x, 1.4, traffic.taxi.z).project(camera);
  return {
    x: (v.x * 0.5 + 0.5) * window.innerWidth,
    y: (-v.y * 0.5 + 0.5) * window.innerHeight,
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

let toastTimer = 0;
function flash(text) {
  if (!hud.toast) return;
  hud.toast.textContent = text;
  hud.toast.style.opacity = '1';
  toastTimer = 1.6;
}


function updateHud(dt) {
  const s = fares.state;

  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0 && hud.toast) hud.toast.style.opacity = '0';
  }

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
    // A crash holds the banner for CRASH_BANNER_DELAY so the smoke, sparks and camera pull-in
    // land before the retry screen appears. Timeouts have no such beat — reveal immediately.
    if (crashBannerAt !== null && performance.now() < crashBannerAt) return;
    showRunEnd(hud.banner, {
      title: s.failTitle,
      reason: s.failReason,
      // Four numbers, in the order the run produced them: what you carried, what it paid, what
      // the city made you sit through, and how fast you were going when it went wrong.
      stats: [
        { label: 'Fares', value: s.delivered, format: (n) => `${n}` },
        { label: 'Cash', value: s.money, format: (n) => `$${n}` },
        { label: 'Red Lights', value: traffic.stats.taxiRedLights, format: (n) => `${n}` },
        { label: 'Top Speed', value: speedMph(traffic.stats.taxiTopSpeed),
          format: (n) => `${n} mph` },
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

function updateBoostButton() {
  if (!boostButton) return;
  const mode = boost.state.mode;
  boostButton.classList.toggle('is-active', mode === 'active');
  boostButton.classList.toggle('is-charging', mode === 'recharging');
  boostButton.style.setProperty('--pct', `${(boost.fraction() * 100).toFixed(1)}%`);
  boostButton.disabled = mode === 'recharging';
}

// Hold-to-enable, release-to-pause. Pointer events cover both mouse and touch; capturing the
// pointer on press means dragging off the pill still counts as held, and the matching pointerup
// fires reliably wherever the finger lifts.
function pressBoost(event) {
  if (fares.state.gameOver) return;
  event.preventDefault();
  boostButton.setPointerCapture?.(event.pointerId);
  if (boost.press()) {
    flash('Loco Mode!');
    kickLocoMode();
  }
}

// Fires only on the transition into Loco Mode — not while it's already active — so a re-press
// during a running boost doesn't stack a fresh wheelie on top of one already animating (and
// doesn't double-fire the flame). `boost.press()` returns true only on that transition, which is
// why the whole kick is gated on it above.
function kickLocoMode() {
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
// Green glow on top-up. Removing then re-adding the class restarts the CSS animation, so
// back-to-back deliveries each get their own flash instead of the second one being ignored.
function flashBoostTopUp() {
  if (!boostButton) return;
  boostButton.classList.remove('is-topping-up');
  void boostButton.offsetWidth;
  boostButton.classList.add('is-topping-up');
}
boostButton?.addEventListener('animationend', (e) => {
  if (e.animationName === 'boost-topup') boostButton.classList.remove('is-topping-up');
});

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

const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  let dt = Math.min(clock.getDelta(), 0.05);

  // Time dilation for the crash. Scale the whole frame's dt so debris, smoke, camera pull-in and
  // shake decay all slow together — that's what sells it as a single cinematic beat rather than
  // one element being pushed around while everything else runs normally. Ramps linearly from
  // `slowMoMin` back to 1.0 across SLOW_MO_DURATION ms wallclock; the banner delay is separately
  // wallclock-anchored so this doesn't change when the retry screen appears. The depth is per
  // event — a wreck bottoms out at SLOW_MO_MIN, a bust much shallower so the chase still moves.
  const nowMs = performance.now();
  if (nowMs < slowMoUntil) {
    const t = 1 - (slowMoUntil - nowMs) / SLOW_MO_DURATION;
    dt *= slowMoMin + (1 - slowMoMin) * t;
  }

  boost.update(dt);
  // Never re-arm boost on a wrecked taxi — the flag would flick on the next frame otherwise and
  // the collision detector already only checks `if (taxi.boost)`.
  if (!traffic.taxi.crashed) traffic.taxi.boost = boost.isActive();
  updateBoostButton();
  skids.update(dt);
  dust.update(dt);
  sparks.update(dt);
  smoke.update(dt);
  debris.update(dt);
  victimDebris.update(dt);
  flames.update(dt);
  vanish.update(dt);
  controller.updateShake(dt, aspect());
  daylight.update(dt);

  police.update(dt);   // may flip a whole corridor green before traffic reads the signals
  traffic.update(dt);
  // After traffic has settled positions for the frame — that's what the overlap check reads, and
  // what the two wreck shells are copied out of. A detected impact takes both cars out of the
  // sim from this frame on; the loops in traffic.js already skip a crashed car, so no further
  // plumbing is needed here.
  collisions.update();
  checkPoliceBust();

  // Loco Mode chases the taxi on narrow viewports where the fixed framing has already given up —
  // in portrait the taxi is often off-screen, so the follow is the only way to see the boost. On
  // desktop the whole city is in frame at all times and following would just slide the map under
  // the player for no reason, so we skip it. Follow only while boost is active: no gate on the
  // way out means releasing the button leaves the camera wherever it landed instead of snapping
  // back. A user drag during boost is overridden on the next frame — panning is a planning
  // gesture and boost is the opposite of planning.
  //
  // Wreck focus outranks the boost-follow (and runs on every viewport, not only narrow ones):
  // the camera eases into the crash site so the smoke and sparks fill the frame before the retry
  // screen shows.
  if (wreckSpot) {
    controller.focusOn(wreckSpot.x, wreckSpot.z, WRECK_ZOOM, dt, aspect());
  } else if (boost.isActive() && !fares.state.gameOver && isNarrow()) {
    controller.followXZ(traffic.taxi.x, traffic.taxi.z, dt, 3.2, aspect());
  }

  // More than one thing can land in a frame now — delivering the last fare clears the board and
  // spawns the next one in the same tick — so this is a list rather than a single event.
  for (const { type, fare } of fares.update(dt, traffic.taxi)) {
    if (type === 'pickup') {
      flash('Passenger aboard — tap the destination');
      traffic.taxi.route = [];
      traffic.taxi.pendingTarget = null;
      traffic.taxi.parked = true;   // sit at the kerb until told where to go
      // The taxi now wears this rider's colour, and so does their destination pin.
      traffic.setTaxiFareColor(fare.color);
    } else if (type === 'delivered') {
      popEarning(fare.value);
      // Small pour of boost fuel as a delivery reward — the meter's frame-by-frame update paints
      // the bar visibly *filling*, and the green glow ties the top-up to the same payout the
      // earnings pop is announcing.
      boost.topUp(0.15);
      flashBoostTopUp();
      traffic.taxi.route = [];
      traffic.taxi.pendingTarget = null;
      traffic.setTaxiFareColor(null);
    } else if (type === 'spawned') {
      // A fare that appears while you are already carrying one is the interesting case: it says
      // "there is now a clock you cannot start yet", which is a different message from the idle
      // board filling back up.
      flash(fares.carrying() ? 'Another fare waiting' : 'New fare waiting');
    }
  }

  // The route is a property of the selection, not of the world — deselecting clears it from view
  // even though the taxi keeps driving it.
  if (selected && traffic.taxi.pendingTarget && !fares.state.gameOver) {
    routeLine.update(traffic.taxi, traffic.taxi.route);
  } else {
    routeLine.hide();
  }

  layRubber(dt);
  kickDust();
  policeRubber();
  updateHud(dt);
  riderFinder.update(dt, fares.waitingAll());
  dropoffIndicator.update(fares.carrying());
  renderer.render(scene, camera);
}

if (shot) {
  document.body.classList.add('shot-mode');
  traffic.warmup(shot.warmup ?? 12);
  fares.update(0.016, traffic.taxi);          // spawn the first fare

  // Send the taxi at whichever fare the shot is about, and keep it directed there.
  const send = (fare = fares.focus()) => {
    if (fare && routeTo(fare.target)) fares.markDirected(fare);
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
        traffic.setTaxiFareColor(fare.color);
        send(fare);
        // Let the timer finish flying to the taxi, or the shot catches it mid-transfer.
        for (let settle = 0; settle < 90; settle++) {
          traffic.update(1 / 60);
          fares.update(1 / 60, traffic.taxi);
        }
      }
    }
  }

  // Run forward until the police car is mid-city, so the shot shows a live corridor.
  if (shot.untilPolice) {
    for (let guard = 0; guard < 90 * 60; guard++) {
      police.update(1 / 60);
      traffic.update(1 / 60);
      fares.update(1 / 60, traffic.taxi);
      if (police.state.active && Math.abs(police.state.s) < 30) break;
    }
    // Follow the car rather than hoping it drives through the middle of the frame.
    const pos = police.group.position;
    controller.state.target.set(pos.x, 0, pos.z);
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
    routeLine.update(traffic.taxi, traffic.taxi.route);
  }
  renderer.render(scene, camera);
  document.body.dataset.shotReady = 'true';
} else {
  traffic.warmup(10);
  frame();
}

if (!shot) {
  createDebugPanel({
    sun,
    hemi,
    sky,
    daylight,
    carCount: getCarCount(),
    fares: { getSeconds: getFareSeconds, setSeconds: setFareSeconds },
    routeLine,
  });
}

window.__taxi = {
  traffic,
  daylight,
  boost,
  skids,
  police,
  fares,
  routeTo,
  findRoute,
  camera: controller,
  isSelected: () => selected,
  /** Screen-space helpers so the browser smoke test can click real pixels. */
  taxiScreenPosition: taxiScreenPos,
  /** The pin the player is meant to be driving at — the newest one if two are on the board. */
  targetScreenPosition: (fare = fares.focus()) => {
    if (!fare) return null;
    const c = fares.intersectionCentre(fare.target.i, fare.target.j);
    const v = new THREE.Vector3(c.x, 5, c.z).project(camera);
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight };
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
