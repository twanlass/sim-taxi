import * as THREE from 'three';
import { arcCurve, lineCurve } from '../city/curves.js';
import { PAVEMENT_Y } from '../city/garage.js';
import { SPEED, releaseCar, stageCar } from '../sim/traffic.js';
import { setGhostOutlines } from '../geometry/ghostoutline.js';
import { aimAtHeight } from './camera.js';

// The opening vignette: the camera comes down onto the garage door, the door goes up, and the
// player's taxi drives out of it and turns into traffic.
//
// **PROTOTYPE.** It runs once, at the top of a run, after the city's own entrance wave has landed
// (game/cityentry.js) and before the tutorial says anything — main.js chains the three through one
// `isBlocked` guard, so they queue rather than talking over each other.
//
// The taxi is **out of the traffic model** for the whole of it. It has to be: a garage is not
// anywhere on the road network, and a car parked inside one cannot be expressed as a lane
// coordinate. `stageCar` in sim/traffic.js is that split — out of every simulation loop, still in
// the render pass — which is what lets the drive-out keep the car's own suspension. The nose dip
// coming off the kerb is not animated here; it is one impulse into the pitch spring that was
// already there, and the spring does the rest.
//
// The whole sequence is about seven seconds — see the phase table in docs/gameplay.md. Two things
// it deliberately does *not* do, both because neither would read in that time:
//   - it does not steer around traffic. It waits for a gap at the kerb (`mergeClear`) and it gives
//     up waiting after HOLD_MAX, because a run that will not start is worse than a near miss.
//   - it does not brake for the junction it hands off short of. `releaseCar` puts the taxi on the
//     lane with its speed intact and the traffic model takes over from there, red light included.

// --- The camera -------------------------------------------------------------

// Frustum half-height while the shot is on the door. The opening is 5.4 units wide, so at 15 it
// spans about a third of a portrait frame — big enough to be the subject, and no closer, because
// `camera.js`'s own MIN_ZOOM is 14: past that the AO radius clamp starts painting a false crease
// up any wall standing behind a car (see docs/rendering.md).
const DOOR_ZOOM = 15;
// `focusOn` moves the target and the zoom on one exponential rate. 1.7 crosses most of the way in
// about a second and a half, which is a camera *travelling* rather than cutting or creeping.
const APPROACH_RATE = 1.7;
const RELEASE_RATE = 1.5;
// Hard stops on both eased legs. An exponential never technically arrives, and the run must not be
// hostage to the last few percent of a zoom — a resize, a pathological start, a device dropping
// frames all end the same way without these.
const APPROACH_MAX = 2.6;
const RELEASE_MAX = 2.2;
// Zoom left, in world units, when an eased leg is called finished. Under a unit of frustum height
// there is nothing further to watch happen.
const ZOOM_EPSILON = 0.8;

// A beat with the camera parked on a shut door, so the arrival and the door moving read as two
// events rather than as one continuous move.
const SETTLE = 0.3;
const DOOR_TIME = 1.15;
// And a beat on the open door with the car sitting in it. This is the shot the whole vignette is
// for; anything under about a third of a second and the reveal is over before it lands.
const REVEAL = 0.45;

// --- The drive-out ----------------------------------------------------------

const ACCEL = 4.2;               // u/s², out of the bay
const BRAKE = 8.0;               // u/s², holding at the kerb for a gap
const CREEP = 3.4;               // across the forecourt
const TURN_V = 4.6;              // through the fillet onto the lane
const MERGE_V = 8.5;             // by the time the traffic model takes the car back

// The gap the taxi wants before it pulls out, as a box on the lane it is joining rather than a
// radius around the merge point. A radius is the obvious version and it is too strict by half: the
// opposing lane's centre is 2·LANE = 4 units away and the cross street is closer than that at the
// junction, so a radius wide enough to see a car coming up behind also sees every car going the
// other way, and the taxi sat at the kerb through gaps it could have taken.
//
// The exit is a right turn into the near lane, so the only traffic that matters is on that one:
// something coming up behind, or something already stopped just past where the taxi will land.
const MERGE_LATERAL = 2.6;       // half a lane plus a body — this lane and not the opposing one
const MERGE_BEHIND = 9;
const MERGE_AHEAD = 4;
// ...and how long it will wait. Traffic is dense at the top of a run and a gap always comes, but
// "always" is not a guarantee and the whole run is queued behind this.
const HOLD_MAX = 5;

// The dropped kerb, in centre-of-car x relative to the kerb lip: where the front wheels meet the
// ramp, and where the rear ones leave it. Wider than the ramp mesh itself (1.6 units) because it
// is describing a 3.4-unit car crossing it, not the slab.
const DROP_FROM = -1.3;
const DROP_TO = 0.4;
// Into `pitchV`, in rad/s. Two impulses rather than a canned animation: the pitch spring in
// traffic.js is underdamped at ζ ≈ 0.4, so one shove produces a dip, a rebound and a settle for
// free — and it composes with the acceleration dip the car is already running. Sized against
// BOUNCE_PITCH (1.25, a landing off a roadworks ramp): a kerb is a smaller event than that, and
// the second impulse is smaller again because the rear axle drops half the height the nose did.
const DROP_PITCH = 0.95;
const RISE_PITCH = 0.6;

const smoothstep = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));

/**
 * The path out: straight down the driveway, then a quarter circle onto the lane.
 *
 * The fillet's radius is fixed by geometry rather than chosen — see `turnR` in city/garage.js — so
 * the arc is tangent to the driveway at the kerb lip and tangent to the lane where it lands. That
 * is what makes the whole exit one continuous curve with no kink at either end, and it happens to
 * be the same radius every right turn in the city already uses.
 *
 * Exported for `tools/probe.mjs`, which asserts the tangency at both ends and — the one that
 * actually matters — that the point the arc lands on is the same point `placeCar` puts the taxi at
 * when the traffic model takes it back. Those two are computed by completely different arithmetic
 * and a millimetre between them is a car twitching sideways on the handover.
 */
export function exitPath(site) {
  const { startX, exitZ, kerbX, turnR } = site;
  const run = lineCurve({ x: startX, z: exitZ }, { x: kerbX, z: exitZ });
  // Centre one radius to the +Z side of the driveway, so the arc leaves heading +X and arrives
  // heading +Z: a right turn, into the near lane.
  const fillet = arcCurve({ x: kerbX, z: exitZ + turnR }, turnR, -Math.PI / 2, Math.PI / 2);
  return {
    run,
    total: run.length + fillet.length,
    at: (s) => (s <= run.length ? run.at(s) : fillet.at(s - run.length)),
    tangentAt: (s) => (s <= run.length ? run.tangentAt(s) : fillet.tangentAt(s - run.length)),
  };
}

/**
 * @param site        the depot's geometry — see `garageSite` in city/garage.js
 * @param setDoor     (open01) => void, the curtain
 * @param taxi        the player's car, as a traffic-model car
 * @param taxiGroup   its mesh, only so the ghost outline can be switched off — the whole point of
 *                    that outline is to find the car behind a building, and for these few seconds
 *                    the car is *in* one
 * @param cars        every vehicle, for the gap check at the kerb
 * @param controller  the camera controller
 * @param aspect      () => number
 * @param playZoom    the frustum half-height the run plays at
 * @param restFraming () => ({ x, z }) — where the camera should be left. The game's own default
 *                    framing, which is the city's centre on a desktop and the taxi on a phone;
 *                    main.js owns that decision, not this module.
 * @param isBlocked   () => boolean — something in front of this is still holding the run
 * @param onDrop      fires once, on the frame the taxi's rear axle comes off the kerb
 */
export function createOpening({
  site, setDoor, taxi, taxiGroup, cars, controller, aspect, playZoom,
  restFraming, isBlocked = () => false, onDrop = () => {},
}) {
  const path = exitPath(site);
  const merge = path.at(path.total);

  // 'wait' | 'approach' | 'settle' | 'door' | 'reveal' | 'roll' | 'release' | 'done'
  let phase = 'wait';
  let clock = 0;
  let held = 0;               // seconds spent waiting for a gap at the kerb
  let s = 0;                  // arc length along the exit path
  let dropped = false;        // has the nose gone over the lip yet
  let landed = false;
  let released = false;       // is the taxi back in the traffic model

  const startTangent = path.tangentAt(0);
  stageCar(taxi, site.startX, site.exitZ, Math.atan2(-startTangent.z, startTangent.x));
  taxi.kerbLift = PAVEMENT_Y;
  setDoor(0);
  setGhostOutlines(taxiGroup, false);

  const doorAim = aimAtHeight(site.focus.x, site.focus.y, site.focus.z);

  /** How far the camera still has to travel, so an eased leg can retire on arrival. */
  const arrived = (aim, zoom) => Math.abs(controller.state.zoom - zoom) < ZOOM_EPSILON
    && Math.hypot(controller.state.target.x - aim.x, controller.state.target.z - aim.z) < 1.5;

  /** Is there room on the lane the taxi is about to land on? */
  const mergeClear = () => !cars.some((car) => car !== taxi && !car.crashed && !car.staged
    && Math.abs(car.x - merge.x) < MERGE_LATERAL
    && car.z > merge.z - MERGE_BEHIND && car.z < merge.z + MERGE_AHEAD);

  // Where it waits for that gap: the top of the dropped kerb, so a taxi that has to hold is parked
  // squarely on the forecourt rather than balanced half way down the ramp with one axle in the
  // road. `DROP_FROM` is negative, so this is short of the lip by exactly the ramp.
  const holdAt = path.run.length + DROP_FROM;

  function handOff() {
    if (released) return;
    // Speed survives the handover: the taxi is mid-manoeuvre and a car that arrives on the lane at
    // a standstill has visibly been teleported there.
    const v = taxi.v;
    released = releaseCar(taxi, site.merge.d, site.merge.i, site.merge.j, site.merge.back);
    if (released) taxi.v = v;
  }

  /** Drive the taxi one step along the exit path. Returns true once it has reached the lane. */
  function roll(dt) {
    // Braking starts a car-length before the hold line, which at CREEP is comfortably more than
    // the 0.7 units it takes to stop — so the taxi eases up to the kerb rather than standing on
    // the brakes at it. Past the line the question is closed: a car half way round the fillet is
    // committed, exactly as it would be in traffic.
    const blocked = s > holdAt - 3.4 && s <= holdAt && !mergeClear() && held < HOLD_MAX;
    if (blocked) held += dt;

    const target = blocked ? 0
      : s < path.run.length ? CREEP
        : s < path.total - 0.4 ? TURN_V : MERGE_V;
    const rate = target < taxi.v ? BRAKE : ACCEL;
    taxi.v = target < taxi.v
      ? Math.max(target, taxi.v - rate * dt)
      : Math.min(target, taxi.v + rate * dt);

    s += taxi.v * dt;
    // Waiting for a gap: the car may not roll past the hold line however late the gap closed.
    if (blocked) s = Math.min(s, holdAt);
    s = Math.min(s, path.total);

    const p = path.at(s);
    const t = path.tangentAt(s);
    taxi.x = p.x;
    taxi.z = p.z;
    taxi.yaw = Math.atan2(-t.z, t.x);
    taxi.travelled += taxi.v * dt;
    // What the idle bob is scaled by. Written here because the loop that maintains it is one of
    // the ones a staged car skips.
    taxi.speedFactor = taxi.v / SPEED;

    // Down the dropped kerb, and the two shoves that make it a kerb rather than a ramp in the air.
    const drop = smoothstep((taxi.x - (site.kerbX + DROP_FROM)) / (DROP_TO - DROP_FROM));
    taxi.kerbLift = PAVEMENT_Y * (1 - drop);
    if (!dropped && drop > 0) {
      dropped = true;
      taxi.pitchV -= DROP_PITCH;        // front wheels off the lip: nose down
    }
    if (!landed && drop >= 1) {
      landed = true;
      taxi.pitchV += RISE_PITCH;        // rear follows it down, and the nose comes back up
      onDrop();
    }

    return s >= path.total;
  }

  // Every transition lives here and none in `frameCamera`, which only draws. The two eased legs
  // therefore retire against *last* frame's camera — `frameCamera` runs later in the frame than
  // this does — which is one frame of lag on a move that takes a hundred of them.
  function update(dt) {
    if (phase === 'done') return;
    if (phase === 'wait') {
      if (isBlocked()) return;
      phase = 'approach';
      clock = 0;
    }
    clock += dt;

    if (phase === 'approach' && (clock >= APPROACH_MAX || arrived(doorAim, DOOR_ZOOM))) {
      phase = 'settle';
      clock = 0;
    }
    if (phase === 'settle' && clock >= SETTLE) { phase = 'door'; clock = 0; }
    if (phase === 'door') {
      // Ease-out rather than linear: a roller door leaves fast under its own counterweight and
      // creeps the last few inches, and a constant rate reads as a lift rather than a door.
      const k = Math.min(1, clock / DOOR_TIME);
      setDoor(1 - (1 - k) * (1 - k));
      if (k >= 1) { phase = 'reveal'; clock = 0; }
    }
    if (phase === 'reveal' && clock >= REVEAL) {
      phase = 'roll';
      clock = 0;
      // Indicating right before it moves, like anything pulling out of a driveway.
      taxi.stageSignal = 'right';
    }
    if (phase === 'roll' && roll(dt)) {
      handOff();
      phase = 'release';
      clock = 0;
    }
    if (phase === 'release' && (clock >= RELEASE_MAX || arrived(restFraming(), playZoom))) {
      finish();
    }
  }

  /**
   * True while the vignette owns the framing. Sits at the very top of main.js's camera priority
   * list — nothing else can be claiming it this early in a run, and a player swiping through a cut
   * scene should not be able to steer it off its subject.
   */
  const holdsCamera = () => phase !== 'wait' && phase !== 'done';

  /** One frame of camera. Called from main.js's priority list, not from `update`. */
  function frameCamera(dt) {
    if (!holdsCamera()) return;

    if (phase === 'release') {
      const rest = restFraming();
      controller.focusOn(rest.x, rest.z, playZoom, dt, aspect(), RELEASE_RATE);
      return;
    }

    if (phase === 'roll') {
      // Widens as the car clears the door, so the pull-back has already started by the time the
      // taxi is on the road — otherwise the vignette ends with a zoom that the player is waiting
      // through rather than one that happened while something was going on.
      const out = smoothstep((s - path.run.length * 0.5) / (path.total - path.run.length * 0.5));
      const aim = aimAtHeight(taxi.x, 1.0, taxi.z);
      controller.focusOn(aim.x, aim.z, THREE.MathUtils.lerp(DOOR_ZOOM, playZoom, out * 0.55),
        dt, aspect(), APPROACH_RATE);
      return;
    }

    // 'approach', and then 'settle' / 'door' / 'reveal' holding the shot. Still eased every frame
    // through the held beats rather than set once, so the last percent of the approach keeps
    // closing under the door as it opens instead of stopping dead when the phase changes.
    controller.focusOn(doorAim.x, doorAim.z, DOOR_ZOOM, dt, aspect(), APPROACH_RATE);
  }

  function finish() {
    if (phase === 'done') return;
    phase = 'done';
    handOff();
    // `releaseCar` can only fail if the lane it wants is not in the network, which the site filter
    // already rules out — but a staged taxi is a car that never drives, so the run would be over
    // before it started. Unstage it anyway: it still holds the lane position the warm-up left it
    // on, so the worst case is the car appearing somewhere else rather than a dead game.
    if (!released) taxi.staged = false;
    setDoor(1);
    taxi.stageSignal = null;
    setGhostOutlines(taxiGroup, true);
  }

  /**
   * Land the whole thing instantly: door up, taxi in traffic, camera untouched. `?vignette=off`
   * calls it the moment the module is built, which is the skip — deliberately routed through the
   * same handover the real sequence uses, because a skip that reached the game any other way would
   * be a second opening to keep working.
   */
  function settle() {
    // Straight to the end of the path, so the handover lands the car on the lane rather than
    // wherever it had crept to.
    s = path.total;
    taxi.kerbLift = 0;
    taxi.v = MERGE_V;
    finish();
  }

  return { update, frameCamera, holdsCamera, settle, running: () => phase !== 'done',
    phase: () => phase };
}
