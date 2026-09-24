import * as THREE from 'three';
import { arcCurve, lineCurve } from '../city/curves.js';
import { PAVEMENT_Y } from '../city/garage.js';
import { SPEED, releaseCar, stageCar } from '../sim/traffic.js';
import { TAXI_TAILPIPE_BACK } from '../geometry/taxi.js';
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
// The whole sequence is about seven seconds — see the phase table in docs/gameplay.md — and a tap
// on the city gets out of it: `skip()` below, which main.js runs behind the cut to black in
// game/wipe.js. Two things it deliberately does *not* do, both because neither would read in that
// time:
//   - it does not steer around traffic. It waits for a gap at the kerb (`mergeClear`) and it gives
//     up waiting after HOLD_MAX, because a run that will not start is worse than a near miss.
//   - it does not brake for the junction it hands off short of. `releaseCar` puts the taxi on the
//     lane with its speed intact and the traffic model takes over from there, red light included.
//
// **And it plays backwards for repairs.** `enter()` runs the same shot the other way round: the
// camera comes down onto the door as the taxi turns in off the lane, the door rolls up, the car
// drives into the bay and the door comes down behind it — and then, from behind the shut door, the
// opening itself plays forward from `door`, with the damage gone. game/depotrun.js is what gets the
// car to the driveway; everything from the lane onward is here, because it is this shot.
//
// It drives in **nose first**, not in reverse. Backing in means stopping on the live lane past the
// driveway, and a staged car is invisible to the lane bookkeeping (see the note at the top of
// game/drivethru.js): anything behind the taxi would drive straight through it while it stood
// there. Turning in off the lane clears the carriageway in about half a second, the same trade the
// drive-through's entry arc makes. The car is then turned round on the spot while the door is
// shut, which nobody can see — and the curtain is what the whole opening already hid it behind.

// --- The camera -------------------------------------------------------------

// Frustum half-height while the shot is on the door. The opening is 5.4 units wide, so at 15 it
// spans about a third of a portrait frame — big enough to be the subject, and no closer, because
// `camera.js`'s own MIN_ZOOM is 14: past that the AO radius clamp starts painting a false crease
// up any wall standing behind a car (see docs/rendering.md).
const DOOR_ZOOM = 15;
// `focusOn` moves the target and the zoom on one exponential rate. 2.4 crosses most of the way in
// about a second, which is a camera *travelling* rather than cutting or creeping. It came up from
// 1.7 because the tail of an exponential is the part nobody is watching: at 1.7 the last third of a
// second was the frame creeping the final 2% of a zoom while the door sat there shut.
const APPROACH_RATE = 2.4;
const RELEASE_RATE = 1.6;
// Hard stops on both eased legs. An exponential never technically arrives, and the run must not be
// hostage to the last few percent of a zoom — a resize, a pathological start, a device dropping
// frames all end the same way without these. Both sit just past where `arrived` normally fires, so
// they are a backstop rather than the thing that sets the pace.
const APPROACH_MAX = 1.9;
const RELEASE_MAX = 2.0;
// Zoom left, in world units, when an eased leg is called finished. A unit of frustum height out of
// fifteen is under 2% of the frame and there is nothing left to watch happen.
const ZOOM_EPSILON = 1.0;

// A beat with the camera parked on a shut door, so the arrival and the door moving read as two
// events rather than as one continuous move. It only has to be *perceptible* — a tenth of a second
// separates them, and any more is dead air with the whole run queued behind it.
const SETTLE = 0.12;
const DOOR_TIME = 0.95;
// And the door shutting again behind the car, which starts the moment the taxi reaches the kerb and
// commits to the turn. Slower than the way up, because that is what a roller door does — it leaves
// under its counterweight and comes back down under a motor — and because this one is scenery
// rather than the subject: the camera is pulling out and following the car, and the door closing
// somewhere behind it is a thing noticed rather than watched.
const DOOR_CLOSE_TIME = 1.4;
// And a beat on the open door with the car sitting in it. This is the shot the whole vignette is
// for; much under a third of a second and the reveal is over before it lands.
const REVEAL = 0.35;

// --- The drive-out ----------------------------------------------------------

const ACCEL = 5.0;               // u/s², out of the bay
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

// How far behind the shut curtain the taxi's nose parks.
//
// **Measured off the drawn car, not the simulated one**, which is the whole point of the constant.
// The taxi group wears `TAXI_SCALE` = 1.18, so the body on screen is 4.01 units long where
// `CAR_LEN` says 3.4 — and parking it by half of CAR_LEN put the nose a third of a unit *through* a
// closed door: a yellow rectangle stamped across the middle of the shutter, and the first thing
// anyone looking at the shot saw. `TAXI_TAILPIPE_BACK` is that half-length, already exported from
// geometry/taxi.js for the exhaust. The clearance on top of it covers the curtain's own 0.08.
const NOSE_BEHIND = 0.25;
const parkedX = (site) => site.curtainX - TAXI_TAILPIPE_BACK - NOSE_BEHIND;

// --- The way back in (see `enter`) --------------------------------------------

// Speeds on the way in, u/s. The fillet is the same 2-unit radius the exit takes, at the same speed
// the drive-through takes its own, and a car arriving faster than `ENTRY_CAP` sheds the difference
// in one step at the driveway — see the note on `ENTRY_CAP` in game/drivethru.js, which is the same
// constraint: nothing out here can slow a car down while it is still in the traffic model.
const ENTRY_CAP = 5.2;
const ENTER_V = 4.6;
// Across the forecourt and into the bay: the crawl it comes back out at.
const IN_CREEP = CREEP;
// How far short of the curtain the nose waits if the door is not up yet. The door starts moving on
// the frame the car turns in and is normally open well before it gets here; this is for the car
// that arrived fast.
const DOOR_CLEAR = 0.3;
// And the kerb going up, mirrored: the front wheels climb first and put the nose up, the rear
// follows and brings it down. Smaller than the drop off it, because climbing a kerb is slower.
const MOUNT_PITCH = 0.6;
const MOUNT_SETTLE = 0.4;
// The door coming back down behind the car. Quicker than DOOR_CLOSE_TIME on the way out: there it
// is scenery behind a camera that has moved on, and here it is the beat the camera is waiting on.
const DOOR_SHUT = 0.9;
// Held on the shut door while the car is put right behind it. Only long enough to be a pause
// between the door landing and going back up — the repair is what the door coming down *means*.
const REPAIR = 0.45;

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
  const { exitZ, kerbX, turnR } = site;
  const run = lineCurve({ x: parkedX(site), z: exitZ }, { x: kerbX, z: exitZ });
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
 * The path in: a quarter circle off the lane onto the driveway, then straight into the bay.
 *
 * The exit's fillet mirrored about the driveway — same radius, same tangency argument — so it
 * leaves the near lane `turnR` short of the driveway heading +Z and arrives on it heading −X. It
 * ends on the very point the exit path starts from, facing the other way: the taxi is parked
 * nose-in, and turned round behind the shut door (see the header note).
 *
 * `mouth` is where the car leaves the lane, which is where game/depotrun.js catches it.
 */
export function entryPath(site) {
  const { exitZ, kerbX, turnR } = site;
  const fillet = arcCurve({ x: kerbX, z: exitZ - turnR }, turnR, 0, Math.PI / 2);
  const run = lineCurve({ x: kerbX, z: exitZ }, { x: parkedX(site), z: exitZ });
  return {
    fillet,
    run,
    mouth: fillet.at(0),
    total: fillet.length + run.length,
    at: (s) => (s <= fillet.length ? fillet.at(s) : run.at(s - fillet.length)),
    tangentAt: (s) => (s <= fillet.length ? fillet.tangentAt(s) : run.tangentAt(s - fillet.length)),
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
 *
 * The returned `enter()` replays the whole thing for a repair — see the header note.
 */
export function createOpening({
  site, setDoor, taxi, taxiGroup, cars, controller, aspect, playZoom,
  restFraming, isBlocked = () => false, onDrop = () => {},
}) {
  const path = exitPath(site);
  const merge = path.at(path.total);
  const inPath = entryPath(site);
  // The nose's hold point on the way in, if the door is still coming up: DOOR_CLEAR short of the
  // curtain, as arc length along the entry path.
  const doorHoldS = inPath.fillet.length
    + (site.kerbX - (site.curtainX + TAXI_TAILPIPE_BACK + DOOR_CLEAR));

  // 'opening' is the run's first seven seconds; 'visit' is a trip back in for repairs, which runs
  // 'enter' → 'shut' → 'repair' and then the opening's own phases from 'door' on.
  let mode = 'opening';
  // 'wait' | 'approach' | 'settle' | 'door' | 'reveal' | 'roll' | 'release' | 'done', plus the
  // visit's 'enter' | 'shut' | 'repair'
  let phase = 'wait';
  let clock = 0;
  let held = 0;               // seconds spent waiting for a gap at the kerb
  let s = 0;                  // arc length along the exit path
  let dropped = false;        // has the nose gone over the lip yet
  let landed = false;
  let closing = 0;            // 0 = still up, 1 = shut again behind the car
  let released = false;       // is the taxi back in the traffic model
  // The visit's own: arc length along the entry path, how far the door has got, the kerb going up,
  // and the two callbacks `enter` was handed.
  let sIn = 0;
  let opened = 0;
  let mounted = false;
  let climbed = false;
  let repaired = false;
  let visit = null;

  const parked = path.at(0);
  const startTangent = path.tangentAt(0);
  stageCar(taxi, parked.x, parked.z, Math.atan2(-startTangent.z, startTangent.x));
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
    // A repaired taxi is on the road again, and the job it left needs putting back under it *now*:
    // the handover lands it 5.5 units short of a junction, and a car with no route there turns at
    // random.
    if (released && mode === 'visit') visit.onRelease();
  }

  /** Write a staged car's pose and the per-frame bookkeeping the loops it is out of would do. */
  function place(p, t, dt) {
    taxi.x = p.x;
    taxi.z = p.z;
    taxi.yaw = Math.atan2(-t.z, t.x);
    taxi.travelled += taxi.v * dt;
    taxi.speedFactor = taxi.v / SPEED;
  }

  /** Ease the speed toward `target` at the opening's own rates. */
  function drive(target, dt) {
    taxi.v = target < taxi.v
      ? Math.max(target, taxi.v - BRAKE * dt)
      : Math.min(target, taxi.v + ACCEL * dt);
  }

  /**
   * One step in off the lane and into the bay. Returns true once the car is parked.
   *
   * Every target speed is capped by the speed it can still stop from before wherever it has to
   * stop — the curtain if the door is not up yet, otherwise the end of the path — so it rolls up to
   * both rather than arriving and standing on the brakes.
   */
  function rollIn(dt) {
    const stopAt = opened < 1 ? doorHoldS : inPath.total;
    const room = Math.max(0, stopAt - sIn);
    const cruise = sIn < inPath.fillet.length ? ENTER_V : IN_CREEP;
    drive(Math.min(cruise, Math.sqrt(2 * BRAKE * room)), dt);
    sIn = Math.min(sIn + taxi.v * dt, stopAt);
    place(inPath.at(sIn), inPath.tangentAt(sIn), dt);
    // Indicating off the road, and not once it is on the forecourt.
    taxi.stageSignal = sIn < inPath.fillet.length ? 'right' : null;

    // Up the dropped kerb: the same band the drop off it is measured on, read the other way.
    const drop = smoothstep((taxi.x - (site.kerbX + DROP_FROM)) / (DROP_TO - DROP_FROM));
    taxi.kerbLift = PAVEMENT_Y * (1 - drop);
    if (!mounted && drop < 1) {
      mounted = true;
      taxi.pitchV += MOUNT_PITCH;       // front wheels onto the ramp: nose up
    }
    if (!climbed && drop <= 0) {
      climbed = true;
      taxi.pitchV -= MOUNT_SETTLE;      // rear follows it up, and the nose comes back down
    }
    return sIn >= inPath.total - 1e-6 && taxi.v < 0.05;
  }

  /**
   * Behind the shut door: the car is put right and turned round to face out, which is the pose the
   * opening starts from. Written by hand rather than through `stageCar`, which would also clear a
   * route the player may have planned while the car was in here.
   */
  function repair() {
    if (repaired) return;
    repaired = true;
    const t = path.tangentAt(0);
    taxi.x = parked.x;
    taxi.z = parked.z;
    taxi.yaw = Math.atan2(-t.z, t.x);
    // Primed with the yaw, or the steering differencer reads a half turn out of one frame and
    // slams the front wheels lock to lock.
    taxi.prevSteerYaw = taxi.yaw;
    taxi.v = 0;
    taxi.prevV = 0;
    taxi.pitch = 0;
    taxi.pitchV = 0;
    taxi.kerbLift = PAVEMENT_Y;
    taxi.stageSignal = null;
    visit.onRepair();
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

    // The door comes down behind it, starting on the frame the taxi reaches the kerb and commits
    // to the turn. It carries on through `release` — `roll` stops being called there — which is why
    // `finish` lands it at 0 rather than leaving it wherever it got to.
    if (s > path.run.length) {
      closing = Math.min(1, closing + dt / DOOR_CLOSE_TIME);
      setDoor(1 - closing);
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

    // --- The visit's half, which ends by handing over to 'door' below.
    if (phase === 'enter') {
      // The door is already going up — it starts on the frame the car turns in, on the opening's
      // own ease, and is normally open before the car reaches it.
      opened = Math.min(1, opened + dt / DOOR_TIME);
      setDoor(1 - (1 - opened) * (1 - opened));
      if (rollIn(dt)) { phase = 'shut'; clock = 0; }
    }
    if (phase === 'shut') {
      const k = Math.min(1, clock / DOOR_SHUT);
      setDoor(1 - k);
      if (k >= 1) { phase = 'repair'; clock = 0; repair(); }
    }
    if (phase === 'repair' && clock >= REPAIR) { phase = 'door'; clock = 0; }
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
    // The shutter keeps coming down through the pull-back, on its own clock rather than the phase's
    // — `roll` is no longer being called, and a door that froze half way the instant the car
    // reached the lane would be the one thing in the shot that stopped for no reason.
    if (phase === 'release' && closing < 1) {
      closing = Math.min(1, closing + dt / DOOR_CLOSE_TIME);
      setDoor(1 - closing);
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
    // A visit landed early (`settle`) still has to have fixed the car.
    if (mode === 'visit') repair();
    phase = 'done';
    handOff();
    // Shut, not open. The car is out and the door came down behind it — that is the state a run is
    // actually played in, and the same one shot mode puts the depot in.
    closing = 1;
    // `releaseCar` can only fail if the lane it wants is not in the network, which the site filter
    // already rules out — but a staged taxi is a car that never drives, so the run would be over
    // before it started. Unstage it anyway: it still holds the lane position the warm-up left it
    // on, so the worst case is the car appearing somewhere else rather than a dead game.
    if (!released) taxi.staged = false;
    setDoor(0);
    taxi.stageSignal = null;
    setGhostOutlines(taxiGroup, true);
    if (mode === 'visit') visit.onDone();
  }

  /**
   * Take the taxi off the lane and into the depot for repairs, then send it back out.
   *
   * `s0` is how far past the mouth the car got on the frame it was caught — the fillet leaves
   * tangent to the lane, so that overshoot is the same distance along the path, exactly as the
   * drive-through takes its cars.
   *
   * @param onRepair   fires once, behind the shut door: the moment to put the car right
   * @param onRelease  fires once, on the frame the car is back in the traffic model
   * @param onDone     fires once, when the camera has been handed back
   * Returns false, and does nothing, if the depot is already busy.
   */
  function enter(s0, { onRepair = () => {}, onRelease = () => {}, onDone = () => {} } = {}) {
    if (phase !== 'done') return false;
    mode = 'visit';
    visit = { onRepair, onRelease, onDone };
    phase = 'enter';
    clock = 0;
    sIn = Math.min(Math.max(0, s0), inPath.fillet.length);
    opened = 0;
    mounted = false;
    climbed = false;
    repaired = false;
    // ...and the exit's own state, which the forward half runs on exactly as the opening did.
    s = 0;
    held = 0;
    dropped = false;
    landed = false;
    closing = 0;
    released = false;

    const v = Math.min(taxi.v, ENTRY_CAP);
    const p = inPath.at(sIn);
    const t = inPath.tangentAt(sIn);
    // Staged at its pose, and the speed and its differencer restored together — the reasons are
    // the ones on `take` in game/drivethru.js.
    stageCar(taxi, p.x, p.z, Math.atan2(-t.z, t.x));
    taxi.v = v;
    taxi.prevV = v;
    taxi.kerbLift = 0;
    taxi.stageSignal = 'right';
    setGhostOutlines(taxiGroup, false);
    return true;
  }

  /**
   * Land the whole thing instantly: door up, taxi in traffic, camera untouched. `?vignette=off`
   * calls it the moment the module is built, which is the skip — deliberately routed through the
   * same handover the real sequence uses, because a skip that reached the game any other way would
   * be a second opening to keep working.
   */
  function settle() {
    if (phase === 'done') return;
    // Straight to the end of the path, so the handover lands the car on the lane rather than
    // wherever it had crept to.
    s = path.total;
    taxi.kerbLift = 0;
    taxi.v = MERGE_V;
    finish();          // which shuts the door: the car is out, so the depot is shut up behind it
  }

  /**
   * The player's skip — a tap during the sequence, from behind a black screen (see game/wipe.js).
   *
   * `settle` plus the camera, and the camera is the whole of the difference. `?vignette=off` lands
   * the module before the shot has moved anywhere, so there is nothing to put back; a tap lands it
   * from wherever the sequence had got to, which is fifteen units off a garage door. Left alone,
   * the frame after the skip is a close-up of a shut shutter with the taxi already two blocks away,
   * and whatever picks the framing up next spends a second easing out of it — the wait the player
   * just asked to be let out of.
   *
   * So the framing is *snapped*, not eased: `focusOn` with a dt large enough to close the ease
   * exactly, the same 999 the route band settles itself with. It is only legitimate because it
   * happens under the black — this is a cut, and a cut is allowed to move the camera anywhere.
   *
   * `restFraming()` is read *after* the handover, since on a phone it is the taxi's own position
   * and the settle above is what puts the car on the road.
   */
  function skip() {
    if (phase === 'done' || mode !== 'opening') return;
    settle();
    const rest = restFraming();
    controller.focusOn(rest.x, rest.z, playZoom, 999, aspect());
  }

  return {
    update, frameCamera, holdsCamera, settle, skip, enter,
    /** The run's own opening is still playing. A repair visit is not this — see `visiting`. */
    running: () => mode === 'opening' && phase !== 'done',
    /** A repair visit is in progress, from the turn in off the lane to the camera handed back. */
    visiting: () => mode === 'visit' && phase !== 'done',
    phase: () => phase,
    /** Where a visit takes the car off the lane — game/depotrun.js catches the taxi here. */
    mouth: inPath.mouth,
  };
}
