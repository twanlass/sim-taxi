import * as THREE from 'three';
import { makeRng } from './util/rng.js';
import { createScene } from './game/scene.js';
import { createCityCamera, attachDragPan } from './game/camera.js';
import { createLayout } from './city/layout.js';
import { createGround } from './city/ground.js';
import { createBuildings } from './city/buildings.js';
import { createProps } from './city/props.js';
import { createTraffic } from './sim/traffic.js';
import { createPolice } from './sim/police.js';
import { createFareSystem, cornerFor, setFareSeconds, getFareSeconds } from './game/fares.js';
import { createDebugPanel } from './game/debugpanel.js';
import { createBoost } from './game/boost.js';
import { createSkidMarks } from './game/skidmarks.js';
import { createDust } from './game/dust.js';
import { createDaylight, DAY_SECONDS } from './game/daylight.js';
import { createPicker } from './game/pick.js';
import { createRiderFinder } from './game/riderfinder.js';
import { createDropoffIndicator } from './game/dropoffindicator.js';
import { createRouteLine } from './game/routeline.js';
import { findRoute, planOrigin } from './game/route.js';
import { getActiveShot, getSeed, getRunSeed, getCarCount } from './util/shot.js';

const seed = getSeed();                             // the city itself — stable, so it's learnable
const shot = getActiveShot();
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
// others — editing building code shouldn't move the parks.
const layout = createLayout(makeRng(seed));
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

// Orthographic camera: the vertical world span is exactly 2 * zoom, so world-units-per-pixel
// falls straight out of the frustum height.
const boost = createBoost();
const skids = createSkidMarks(scene);

const routeLine = createRouteLine(
  scene,
  () => (2 * controller.state.zoom) / renderer.domElement.clientHeight,
);

// --- Selection and routing --------------------------------------------------

// The taxi is permanently selected. There is only ever one, so a selection step was pure
// ceremony: every tap on it was either a no-op or an accidental deselect that made the next tap
// on a fare do nothing.
const selected = true;
traffic.taxiSelection.visible = true;

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
    if (kind === 'passenger' && fares.carrying()) {
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
// the camera onto them is faster than hunting for the light shaft by hand.
function snapToRider(fare) {
  if (!fare) return;
  const c = cornerFor(fare.target.i, fare.target.j);
  controller.state.target.set(c.x, 0, c.z);
  controller.update(aspect());
}

const riderFinder = createRiderFinder({ onTap: snapToRider });
const dropoffIndicator = createDropoffIndicator({
  camera,
  intersectionCentre: fares.intersectionCentre,
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

  if (s.gameOver && hud.banner && hud.banner.hidden) {
    hud.banner.hidden = false;
    hud.banner.innerHTML = `<strong>Game Over</strong><span>${s.failReason}</span>`
      + `<span>${s.delivered} fares · $${s.money}</span>`
      + '<button type="button" class="retry">Retry</button>';
    hud.banner.querySelector('.retry')?.addEventListener('click', () => location.reload());
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
  if (boost.press()) flash('Loco Mode!');
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

// Rubber gets laid from the rear wheels while boosting through a corner, spaced by distance so
// the trail is even regardless of frame rate.
let lastSkidAt = 0;
function layRubber() {
  const car = traffic.taxi;

  // `state === 'turn'` covers every junction crossing, including going straight on — which is why
  // rubber was appearing on the straights. An actual turn means the exit direction differs from
  // the entry one, and only after the straight run-up to the junction is done.
  const cornering = car.boost
    && car.state === 'turn'
    && car.dOut !== car.d
    && Math.min(car.turnT, 1) * car.turnLen > car.leadIn;

  if (!cornering) { lastSkidAt = car.travelled; return; }
  // Closer than one mark length, so consecutive stamps overlap into a continuous streak.
  if (car.travelled - lastSkidAt < 0.42) return;
  lastSkidAt = car.travelled;

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

const clock = new THREE.Clock();

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);

  boost.update(dt);
  traffic.taxi.boost = boost.isActive();
  updateBoostButton();
  skids.update(dt);
  dust.update(dt);
  daylight.update(dt);

  police.update(dt);   // may flip a whole corridor green before traffic reads the signals
  traffic.update(dt);

  // Loco Mode chases the taxi on narrow viewports where the fixed framing has already given up —
  // in portrait the taxi is often off-screen, so the follow is the only way to see the boost. On
  // desktop the whole city is in frame at all times and following would just slide the map under
  // the player for no reason, so we skip it. Follow only while boost is active: no gate on the
  // way out means releasing the button leaves the camera wherever it landed instead of snapping
  // back. A user drag during boost is overridden on the next frame — panning is a planning
  // gesture and boost is the opposite of planning.
  if (boost.isActive() && !fares.state.gameOver && isNarrow()) {
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

  layRubber();
  kickDust();
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

console.log('[taxi] ready', { seed, runSeed, shot: shot?.name ?? 'interactive', cars: traffic.cars.length });
window.__taxi.runSeed = runSeed;   // reproduce a run with ?run=<this>
