import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial, unlitMaterial, BODY_EULER_ORDER } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import {
  DIR, GRID_I, GRID_J, HALF_SPAN_X, HALF_SPAN_Z, PITCH, dirSign, isXAxis, laneOffX, laneOffZ,
  legalExits, lineX, lineZ,
  isSegmentClosed, nextIntersection, opposite,
} from '../city/grid.js';
import { cityNetwork } from '../city/roadnet.js';
import {
  setPriorityCorridor, setPolicePresence, locoWeave, locoWheelie, isLaneClosed, sirenLaneAhead,
  locoWeaveFade, WHEELIE_DUR, ROAD_Y,
  wheelAnchors, wheelGeometries, wheelGeometry, steerToward, CHASSIS_LIFT,
} from './traffic.js';

// A police car running a priority corridor across the city: every signal on its road goes green,
// every crossing road goes red, and the traffic model reacts on its own because the override lives
// inside lightPhase.
//
// It drives its lane like any other car — right-hand traffic, one lane offset off the centreline in
// the direction of travel. Speed is still 19 (about twice traffic), so it catches up to
// same-direction traffic on the corridor road within a block or two.
//
// There is still no collision *response* — nothing here can be crashed into, and nothing here
// queues — but the lane is no longer shared silently. What used to happen was that the cruiser
// drove through whatever it caught: the corridor holds every downstream light green, so the
// argument went that ambient cars in the lane are already moving by the time it arrives, and at
// 19 against 8.5 that is simply not enough. Now the traffic gets out of the way and the cruiser
// moves over to meet it — see PULLOVER_* in traffic.js for the car's half and DODGE_* below for the
// cruiser's. Between them the two bodies clear each other by about 0.9 units.

const SPEED = 19;
const RUN_MARGIN = 26;          // how far off-map it starts and ends

// --- Squeezing past its own lane ---------------------------------------------
//
// The cruiser's half of the pull-over. Ambient traffic in its lane dives for the kerb (PULLOVER_* in
// traffic.js); this is the cruiser meeting it half way, because 1.5 units of pull-over against two
// 1.7-wide bodies still leaves them overlapping. Toward the road centreline, never across it —
// 1.1 off a lane offset of 2 leaves the cruiser 0.9 from the centreline and wholly on its own
// side, which matters even with the corridor holding the other way stopped, because the corridor
// only covers junctions and not the cars already mid-block on the far side.
// Toward the centreline, so the cruiser and the car diving for the kerb open a gap between them
// from both sides. It is a distance from the lane centre, which is what keeps it safe on a divided
// arterial: the cruiser ends up 2.6 from the yielding car's centre whatever the road's width. The
// ceiling is the median — `laneOff − MEDIAN_W/2 − CAR_W/2` is 1.28 on an arterial, so 1.1 keeps the
// flank off the kerb with 0.18 to spare. Widen the median and this has to come down with it; the
// probe asserts no vehicle but a passing taxi is ever over one.
const DODGE_LATERAL = 1.1;
const DODGE_LOOK = 24;          // how far ahead it starts moving over — ~1s at chase speed
const DODGE_EASE = 3.5;         // per second; ~0.3s to commit, so the swerve reads as a swerve

// --- Chase (the bust) -------------------------------------------------------
//
// The corridor run is scenery: it drives a line across town and never once acknowledges the
// player. So the bust used to land with the cruiser sailing obliviously past, which read as a rule
// firing rather than as a cop catching you. `chase()` breaks the run off the rail it was on and
// hunts the taxi down a junction at a time — see the routing notes on turnAt() below.
//
// It drives the *taxi's* Loco Mode: the same weave (locoWeave, shared out of traffic.js), a top
// speed above the boosting taxi's best day — 34 at the top of its overdrive band, and that only
// on a straightaway — so the gap actually closes, and a hard U-turn when the
// quarry is behind it. The priority corridor follows each leg, which is not a courtesy — the
// cruiser has no collision response at all, so an un-yielded *cross* car is still a car it drives
// straight through at 37 units/s. The corridor is what stops there being one. Traffic in its own
// lane is handled the other way, by the pull-over above.
//
// **This number is not free — it is `OVERDRIVE_SPEED` plus 3.** A chase where the quarry is faster
// than the cruiser is not a hard chase, it is a chase that cannot end, and nothing on screen says
// so: the siren just follows you forever. It was 26 against a 22.95 top; the top went to 34, so
// this went to 37 to keep the same 3 u/s of closing speed. Raising the taxi's ceiling again means
// coming back here, and `tools/probe.mjs` asserts the ordering so that it fails rather than
// quietly turning the bust into an escort.
export const CHASE_SPEED = 37;
// Scaled with CHASE_SPEED (both x37/26), which is not optional: left at 30 the cruiser took
// half again as long to wind up and could not shed 37 into its arrival, so it sailed past the
// taxi and settled 9.4 units off instead of the 5.5 it aims for — the bust reads as the police
// car overshooting and sulking back.
const CHASE_ACCEL = 43;         // reaches chase speed in ~0.25s from corridor cruise
const CHASE_BRAKE = 43;
const CHASE_ARRIVE = 5.5;       // pulls up this far off the taxi and holds there
// How far off the road centreline the quarry can be and still count as "on this road": the road
// is 8 wide, and a taxi stopped at a kerb or slewed across a lane is still on it.
const ON_ROAD = 6;
// Rail position is exact and its corners are square. The drawn car eases toward it at this rate,
// which is what turns each 90° snap into an arc: the steady-state lag is v/rate ≈ 2.2 units at
// chase speed, so the cruiser cuts corners on about a lane radius instead of hinging on the spot.
const CHASE_SMOOTH = 12;
const YAW_EASE = 0.12;          // seconds for the nose to catch up with the direction of travel
// U-turn on lock-on. Left-hand swing (yaw always increases — see dirYaw), crossing the full road
// width from its lane to the opposing one while the nose comes round.
const UTURN_DUR = 0.45;
const UTURN_SPEED = 5;          // it has to scrub off nearly all of 19 to swing this tight
// Brake into the swing, power out of it, rather than holding one speed all the way through. Costs
// nothing in path terms and buys the whole handbrake-turn read, because both ends go through the
// pitch spring: nose dives, car pivots, tail squats, it leaves.
const UTURN_BRAKE = 45;
const UTURN_BEHIND = 6;         // only if the taxi is at least this far back; a near-level target
                                // is caught faster by carrying on to the junction ahead
// Backstop so a chase can never run forever if the greedy router ends up circling a target it
// cannot line up on: give up and hold position. The cinematic is over in ~2s of sim time.
const CHASE_TIMEOUT = 7;

// --- How it carries itself --------------------------------------------------
//
// The routing above is only half of "aggressive". A car that tracks a perfect line at a constant
// speed reads as a machine no matter how fast it is going; what sells Loco Mode on the taxi is the
// body — it squats when it plants the throttle, dives when it stands on the brakes, and leans out
// of every corner. The cruiser now does all three, off the same shapes (`locoWheelie`, and the
// pitch spring's constants below match the taxi's), so the two cars are recognisably driven the
// same way.
const CHASE_KICK = 1.32;        // instant surge on lock-on, the cruiser's BOOST_KICK
// Pitch spring: same constants as the taxi's, and the same reason for them — an underdamped
// spring driven by longitudinal acceleration ends both the dive and the squat on a small bounce,
// which is what reads as suspension travel rather than as the model being rotated.
const PITCH_GAIN = 0.014;
const PITCH_LIMIT = 0.13;
// Roll comes off yaw rate × speed — lateral acceleration, near enough. The taxi derives it from
// which way the Bézier goes, which this car has no equivalent of; going through the motion means
// the weave leans it as well as the corners do, and at the right proportion for free. Gain is set
// so a corner at chase speed lands on ~0.30 rad, matching the lean the taxi holds through one.
const ROLL_GAIN = 0.0026;
const ROLL_LIMIT = 0.34;
const ROLL_EASE = 0.09;         // seconds; the body takes a beat to load up, it doesn't snap over

const smoothstep = (t) => t * t * (3 - 2 * t);

// Boosting inside this radius while the police car is on a run ends the run — reckless driving in
// front of a cop. One block in world units (PITCH = 20 in src/city/grid.js): the taxi and the
// siren have to be sharing a junction for the bust to fire, so it reads as being caught in the
// act rather than pinched from a street over.
export const POLICE_BUST_RANGE = 20;

// How far inside the map edge the cruiser has to be before that radius means anything.
//
// The bust radius is a whole block and FADE_BAND below is 18, so a cruiser arriving on the map was
// **lethal before it was drawn**: for a taxi `e` units in from the edge the bust fired with the
// cruiser at `(e - 2) / 18` opacity — 0.44 half a block in, and a flat **zero** for anything on
// the ring road itself, in either lane, lamps included. Measured over 238 corridor runs, the old
// check was armed while the body was still fading for 28.6% of the frames it could reach the slab
// at all, and while the body was completely invisible for 2.9%. On the ring that was every bust.
//
// One PITCH is the inset at which that opacity reaches 1, so this is the bust radius rather than a
// tuned guess: arm where the cruiser is fully drawn and has had a block of visible approach
// (~0.95s at SPEED, ~0.5s if the taxi is closing on it in Loco Mode).
//
// The light bar does **not** wait for this — see `state.lit`. It runs for the whole of a visible
// run, so the siren is the announcement and this inset is the grace period behind it: about two
// seconds of a cop plainly coming at you (38 units from the first frame the body draws to the
// arming line, at SPEED) before it can take the run off you. The rule the player learns is
// *lights on means a cop is here*, and the beat they get is the difference between seeing one and
// being caught by it.
export const BUST_ARM_INSET = PITCH;

// Bar changes a second: six on a corridor run, eleven once it has locked on. The rate change is the
// only cue the player gets that the run has become about them.
const SIREN_HZ = 6;
const SIREN_HUNT_HZ = 11;

/**
 * Which half of the strobe the bar is in — true for red, false for blue.
 *
 * Exported because `game/sirenglow.js` washes the same alternation over the frame edge while the
 * cruiser is off-screen, and a second clock keeping its own time would drift out of step with the
 * car it is standing in for. One function, two consumers, including the rate change.
 */
export function sirenOn(flash, hunting = false) {
  return Math.floor(flash * (hunting ? SIREN_HUNT_HZ : SIREN_HZ)) % 2 === 0;
}

// The car used to appear and vanish at full opacity out past the edge of the asphalt, against
// bare background — a hard pop at both ends of every run. It now dissolves across this band,
// reaching fully invisible before it hits the turnaround, so the disappearance never lands on a
// single frame.
const FADE_BAND = 18;

// `state.s` is a world coordinate **along the corridor's own axis** — an x while the rail runs
// along X, a z while it runs along Z — so every bound on it is per-axis now that the map is not
// square. Written once here rather than at the five sites that read it: an `s` measured against
// the wrong axis puts the cruiser's turnaround, its fade and its arming line 10 units out, and
// none of the three announces itself.
const halfSpanAlong = (axis) => (axis === 'x' ? HALF_SPAN_X : HALF_SPAN_Z);
/** The line index a corridor on this axis may take: an x-running road sits on a j line. */
const topLineOn = (axis) => (axis === 'x' ? GRID_J : GRID_I);
/** ...and how many junctions it passes on the way, which is the *other* axis's count. */
const junctionsAlong = (axis) => (axis === 'x' ? GRID_I : GRID_J);

/** 1 while over the city, easing to 0 as the car runs off the slab. */
function edgeFade(s, axis) {
  const beyond = Math.abs(s) - halfSpanAlong(axis);
  if (beyond <= 0) return 1;
  return Math.max(0, 1 - beyond / FADE_BAND);
}

// Body dimensions, used three ways: policeGeometry() builds to them, the tilt lift measures the
// sagitta against them, and the wheels come out of traffic.js against them — which reproduces the
// four the cruiser used to place by hand (±0.3·LEN along, ±(WIDTH/2 − 0.02) across) while keeping
// the steering geometry identical in kind to every other car on the road.
const CAR_LEN = 3.6;
const CAR_W = 1.8;
const WHEELBASE = CAR_LEN * 0.6;

function policeGeometry() {
  const parts = [];

  const body = new THREE.BoxGeometry(CAR_LEN, 0.8, CAR_W);
  body.translate(0, 0.78 + CHASSIS_LIFT, 0);
  parts.push(bakeColor(body, color('policeBody')));

  const roof = new THREE.BoxGeometry(1.9, 0.62, 1.6);
  roof.translate(-0.2, 1.46 + CHASSIS_LIFT, 0);
  parts.push(bakeColor(roof, color('policeRoof')));

  const stripe = new THREE.BoxGeometry(3.62, 0.3, 1.82);
  stripe.translate(0, 0.62 + CHASSIS_LIFT, 0);
  parts.push(bakeColor(stripe, color('policeRoof')));

  // Rear pair only; the fronts steer, so they hang off the group as their own meshes.
  parts.push(...wheelGeometries(CAR_LEN, CAR_W));

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * The steered front pair, added to `group` and handed back so the fade can reach their material.
 *
 * The cruiser only earned these once it started chasing. On a corridor run it drives one straight
 * line end to end and is faded out before the turnaround, so its heading never changed while it
 * was on screen and the same rule would have rendered a flat 0° forever. A chase corners, weaves
 * and U-turns.
 */
function steeredWheels(group) {
  const material = propMaterial();
  const wheels = wheelAnchors(CAR_LEN, CAR_W)
    .filter((anchor) => anchor.front)
    .map((anchor) => {
      const wheel = new THREE.Mesh(wheelGeometry(), material);
      wheel.position.set(anchor.x, anchor.y, anchor.z);
      wheel.castShadow = true;
      wheel.receiveShadow = true;
      group.add(wheel);
      return wheel;
    });
  return { wheels, material };
}

function lightBar(group) {
  const make = (hex, z) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, 0.26, 0.5),
      unlitMaterial({ color: new THREE.Color(hex) }),
    );
    mesh.position.set(-0.2, 1.9 + CHASSIS_LIFT, z);
    group.add(mesh);
    return mesh;
  };

  // Actual lights, not just glowing boxes. The bar alone is a couple of pixels; what sells a
  // siren is the colour washing across the tarmac and the fronts of nearby buildings as it goes
  // past. No shadows — these are cheap fill, and shadow-casting point lights are not.
  const lamp = (hex, z) => {
    const light = new THREE.PointLight(new THREE.Color(hex), 0, 34, 1.7);
    light.position.set(-0.2, 2.1 + CHASSIS_LIFT, z);
    group.add(light);
    return light;
  };

  return {
    red: make(PALETTE.lightRed, -0.42),
    blue: make(PALETTE.sirenBlue, 0.42),
    redLamp: lamp(PALETTE.lightRed, -0.42),
    blueLamp: lamp(PALETTE.sirenBlue, 0.42),
  };
}

/**
 * @param cars  the traffic array, so the cruiser can see what is in its lane and move over for it.
 *              Optional: the probe stands police cars up in empty scenes, and a cruiser with
 *              nobody to squeeze past simply never dodges.
 */
export function createPolice(rng, scene, cars = []) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(policeGeometry(), propMaterial());
  body.receiveShadow = true;
  group.add(body);
  const lights = lightBar(group);
  const front = steeredWheels(group);
  group.visible = false;
  // Set once, at construction, rather than only where the body is posed: the corridor run writes
  // `group.rotation.y` on its own (railHeading, below) without going through a full `set`, so an
  // order left on the default there would be waiting for the first frame the chase rolled the car.
  group.rotation.order = BODY_EULER_ORDER;
  scene.add(group);

  // Every material this car owns. `propMaterial()` hands back a fresh instance per call, so
  // making these transparent affects the police car alone and not the merged prop meshes.
  // The wheels are in the list for the same reason the lamps are: leaving them opaque would fade
  // the cruiser out and leave two tyres hanging over the tarmac.
  const skin = [body.material, lights.red.material, lights.blue.material, front.material];
  for (const material of skin) material.transparent = true;

  const state = {
    active: false,
    // Live *and* far enough in to be dangerous — see BUST_ARM_INSET. main.js reads this rather
    // than `active` for the bust.
    armed: false,
    // The light bar, which is a separate question from the bust and deliberately earlier: it runs
    // for the whole of a run, from the frame the cruiser spawns off the edge of the slab. The
    // lamps still scale by `fade`, so nothing shines out of a car that has not drawn yet — but the
    // siren is up and closing for a couple of seconds before `armed` follows it. `game/sirenglow.js`
    // reads this too, so the off-screen wash and the bar are the same announcement.
    lit: false,
    fade: 0,             // the edge dissolve, published so the probe can assert against it
    axis: 'x',
    line: 0,
    dir: 1,
    s: 0,
    cooldown: rng.range(5, 12),
    // Seconds between corridor runs, as a range to draw from. Pushed in by main.js off the
    // difficulty curve — `sim/` must not import from `game/`, so the pressure arrives here the
    // same way `traffic.taxi.boost` does, rather than being read.
    //
    // The *opening* cooldown above is deliberately not on the curve: it is the beat before the
    // first siren of a run, and a run starts at the bottom of the ramp by definition.
    cooldownRange: [16, 30],
    runs: 0,
    flash: 0,
    // --- chase
    chasing: false,
    arrived: false,      // pulled up alongside the bust; parked with the bar still running
    quarry: null,        // the car it locked onto, read live so a moving target still works
    v: SPEED,
    elapsed: 0,
    swerve: 0,           // 0..1 envelope on the weave, faded in over distance like the taxi's
    swervePhase: 0,
    uturn: null,         // 0..1 while swinging round, null otherwise
    uturnYaw0: 0,
    dodge: 0,            // world units moved toward the centreline to pass a yielding car
    dodgeRate: 0,        // units/s of that, which is what tilts the nose into the swerve
    // Front-wheel lock, and the pose it is differenced from. Same rule as every other car, run
    // over the *drawn* position rather than the rail: the rail turns its corners square, and the
    // arc the player sees is the eased one.
    wheelAngle: 0,
    prevYaw: 0,
    prevX: 0,
    prevZ: 0,
    yaw: 0,              // eased heading while chasing; the corridor run takes railYaw() directly
    yawRate: 0,          // rad/s, read for the roll and by main.js to decide when it is laying rubber
    travelled: 0,        // distance driven since lock-on; paces the rubber and the dust
    // Body. Only ever non-zero during a chase — the corridor run is a car driving in a straight
    // line and has nothing to lean into.
    pitch: 0,
    pitchV: 0,
    prevV: SPEED,
    roll: 0,
    wheelieT: null,
  };

  /**
   * Is the lane leaving (i, j) in direction `d` dug up? A roadworks zone closes both lanes of one
   * segment for as long as it stands, and the cruiser has no more business driving through the
   * cones and the hole than an ambient car does.
   *
   * Soft closure, so it is a lane id rather than grid geometry — see the roadworks notes in
   * traffic.js for why the network is never re-baked mid-run.
   */
  const exitDug = (d, i, j) => {
    const lane = cityNetwork().laneOutByGrid(d, i, j);
    return Boolean(lane) && isLaneClosed(lane.id);
  };

  /**
   * A park district builds over the road that used to run between its two blocks, and a roadworks
   * zone digs a hole in one. The police car drives a whole line end to end, so a corridor down a
   * line with either on it sends the cruiser straight through the trees or the barricades.
   *
   * Both are checked here because both are permanent for the length of a run: a park closure is
   * baked into the network, and a zone stands for the best part of a minute — far longer than the
   * ~8s a corridor takes to cross the map. What this cannot catch is a zone rising *during* a run
   * already under way, which is why roadwork.js declines to place one on a live siren's road.
   */
  const lineIsClear = (axis, line) => {
    for (let k = 0; k < junctionsAlong(axis); k++) {
      const closed = axis === 'x' ? isSegmentClosed(k, line, 0) : isSegmentClosed(line, k, 1);
      if (closed) return false;
      const d = axis === 'x' ? DIR.PX : DIR.PZ;
      if (axis === 'x' ? exitDug(d, k, line) : exitDug(d, line, k)) return false;
    }
    return true;
  };

  function start() {
    let axis = null;
    let line = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      const tryAxis = rng.chance(0.5) ? 'x' : 'z';
      const tryLine = rng.int(0, topLineOn(tryAxis));
      if (lineIsClear(tryAxis, tryLine)) { axis = tryAxis; line = tryLine; break; }
    }
    if (axis === null) { state.cooldown = 6; return; }   // nothing clear right now; try later

    state.axis = axis;
    state.line = line;
    state.dir = rng.chance(0.5) ? 1 : -1;
    const half = halfSpanAlong(axis);
    state.s = state.dir > 0 ? -half - RUN_MARGIN : half + RUN_MARGIN;
    state.dodge = 0;
    state.dodgeRate = 0;
    state.active = true;
    state.lit = true;      // siren from the spawn frame; the bust waits for BUST_ARM_INSET
    state.runs += 1;
    group.visible = true;
    place();   // otherwise it is drawn at last run's position for one frame
    // A new run starts somewhere else entirely, facing somewhere else. Re-baseline the steering
    // difference against that pose so the jump across the map isn't read as a manoeuvre, and
    // start the run with the wheels straight.
    state.wheelAngle = 0;
    front.wheels.forEach((wheel) => { wheel.rotation.y = 0; });
    state.prevYaw = group.rotation.y;
    state.prevX = group.position.x;
    state.prevZ = group.position.z;
    setPriorityCorridor({ axis: state.axis, line: state.line });
  }

  /**
   * Where the rail puts the car this frame. Right-hand traffic: the lane sits one lane offset off
   * the road centreline, on the right of travel — read off the corridor's own road rather than
   * taken as LANE, so the cruiser lines up with ambient cars on a divided arterial too (matches
   * laneOffsetCoord() in grid.js). `sign` folds the two axes' opposite conventions into
   * one, so the weave and the U-turn's road crossing are written once.
   *
   * Mid-U-turn the lane term sweeps from −1 to +1 of itself, which is exactly the two lanes of
   * the road: it ends up in the opposing lane, facing back the way it came.
   */
  function railPoint() {
    const c = state.axis === 'x' ? lineZ(state.line) : lineX(state.line);
    const sign = state.axis === 'x' ? state.dir : -state.dir;
    const lane = state.uturn === null ? 1 : smoothstep(state.uturn) * 2 - 1;
    // The dodge comes off the lane term rather than being added to the weave, so it is measured
    // from the lane centre and cannot compound with a weave already leaning that way. Suppressed
    // mid-U-turn, where the lane term is sweeping across the whole road and "toward the
    // centreline" is not a fixed direction.
    const dodge = state.uturn === null ? state.dodge : 0;
    const off = state.axis === 'x' ? laneOffX(state.line) : laneOffZ(state.line);
    const perp = c + sign
      * (off * lane - dodge + state.swerve * locoWeave(state.swervePhase).lateral);
    return state.axis === 'x' ? { x: state.s, z: perp } : { x: perp, z: state.s };
  }

  const railYaw = () => (state.axis === 'x'
    ? (state.dir > 0 ? 0 : Math.PI)
    : (state.dir > 0 ? -Math.PI / 2 : Math.PI / 2));

  /**
   * Where the nose points on the corridor run: down the rail, plus whatever the dodge is adding
   * sideways. Composed out of the velocity rather than added to `railYaw` as an offset, because
   * the sign of "toward the centreline" flips with both the axis and the direction and getting it
   * from atan2 costs nothing. With no dodge running it reduces exactly to railYaw().
   *
   * The chase does not come through here — it takes its heading from the eased drawn position,
   * which already contains the dodge because the dodge is in the rail.
   */
  function railHeading() {
    if (state.uturn !== null || Math.abs(state.dodgeRate) < 1e-6) return railYaw();
    const sign = state.axis === 'x' ? state.dir : -state.dir;
    const fwd = state.dir * SPEED;
    const perp = -sign * state.dodgeRate;     // + dodge moves toward the centreline
    const vx = state.axis === 'x' ? fwd : perp;
    const vz = state.axis === 'x' ? perp : fwd;
    return Math.atan2(-vz, vx);               // forward for yaw θ is (cos θ, −sin θ)
  }

  /**
   * Move over for a car in its own lane, or drift back to the lane centre once past it. Sized and
   * argued at DODGE_LATERAL; the other half of the manoeuvre is the yielding car's, in traffic.js.
   */
  function stepDodge(dt) {
    const ahead = sirenLaneAhead(cars, {
      axis: state.axis, line: state.line, dir: state.dir, s: state.s,
    });
    const want = state.uturn === null && ahead < DODGE_LOOK ? DODGE_LATERAL : 0;
    const prev = state.dodge;
    state.dodge += (want - state.dodge) * Math.min(1, dt * DODGE_EASE);
    state.dodgeRate = dt > 1e-6 ? (state.dodge - prev) / dt : 0;
  }

  function place() {
    const p = railPoint();
    group.position.set(p.x, ROAD_Y, p.z);
    group.rotation.y = railHeading();
  }

  function stop() {
    lights.redLamp.intensity = 0;
    lights.blueLamp.intensity = 0;
    state.active = false;
    state.armed = false;
    state.lit = false;
    group.visible = false;
    setPriorityCorridor(null);
    setPolicePresence(null);
    state.cooldown = rng.range(state.cooldownRange[0], state.cooldownRange[1]);
  }

  // --- Chase ----------------------------------------------------------------

  // Where the car is actually drawn, easing toward the rail. See CHASE_SMOOTH.
  const drawn = { x: 0, z: 0 };

  const railDir = () => (state.axis === 'x'
    ? (state.dir > 0 ? DIR.PX : DIR.NX)
    : (state.dir > 0 ? DIR.PZ : DIR.NZ));

  /** Coordinates of the quarry split into "along this rail" and "across it". */
  function quarryOnRail() {
    const q = state.quarry;
    return state.axis === 'x'
      ? { along: q.x, across: q.z - lineZ(state.line) }
      : { along: q.z, across: q.x - lineX(state.line) };
  }

  /** The junction it is heading toward along its own axis, clamped onto the grid. */
  function junctionAhead() {
    const u = (state.s + halfSpanAlong(state.axis)) / PITCH;
    const raw = state.dir > 0 ? Math.ceil(u - 1e-4) : Math.floor(u + 1e-4);
    const k = Math.max(0, Math.min(junctionsAlong(state.axis), raw));
    return state.axis === 'x' ? { i: k, j: state.line } : { i: state.line, j: k };
  }

  /**
   * Pick the exit at (i, j) and snap the rail onto it. Greedy Manhattan, scored on where each
   * road *goes* — the distance from the far end of the segment to the quarry — rather than on
   * which way the bonnet ends up pointing, so it commits to a road that closes the gap instead of
   * turning toward a target it cannot reach that way. `legalExits` already drops U-turns, park
   * closures and the map edge, so the routing inherits the park fix for free.
   *
   * Roadworks are not in `legalExits` and cannot be — that closure is soft, lives in a lane id set
   * and changes mid-run — so they are filtered here, in a first pass. Only a first pass: a chase
   * that finds every exit dug up drives through the cones rather than turning back, because a
   * cruiser that gave up on the bust to respect a traffic cone is a worse outcome than a cruiser
   * that ignores one.
   *
   * Straight carries a small bonus. Without it two equal-cost exits alternate at every junction
   * and the chase visibly dithers down a road it should just be driving down.
   */
  function turnAt(i, j) {
    const dIn = railDir();
    const all = legalExits(dIn, i, j);
    const clear = all.filter((d) => !exitDug(d, i, j));
    const exits = clear.length ? clear : all;
    let best = opposite(dIn);     // dead end (every exit closed): back the way it came
    let bestScore = Infinity;
    for (const d of exits) {
      const n = nextIntersection(d, i, j);
      if (!n) continue;
      const score = Math.hypot(lineX(n.i) - state.quarry.x, lineZ(n.j) - state.quarry.z)
        - (d === dIn ? 0.6 : 0);
      if (score < bestScore) { bestScore = score; best = d; }
    }

    state.axis = isXAxis(best) ? 'x' : 'z';
    state.dir = dirSign(best);
    state.line = isXAxis(best) ? j : i;
    state.s = isXAxis(best) ? lineX(i) : lineZ(j);
    setPriorityCorridor({ axis: state.axis, line: state.line });
  }

  /** Give up the corridor run and hunt this car down. Called from the bust in main.js. */
  function chase(quarry) {
    if (!state.active || state.chasing || state.arrived) return;
    state.chasing = true;
    state.quarry = quarry;
    state.elapsed = 0;
    state.swerve = 0;
    state.swervePhase = 0;
    state.travelled = 0;
    state.yawRate = 0;
    state.pitch = 0;
    state.pitchV = 0;
    state.roll = 0;
    drawn.x = group.position.x;
    drawn.z = group.position.z;
    state.yaw = group.rotation.y;

    // It plants the throttle the instant it decides — the cruiser's version of BOOST_KICK. The
    // step in v goes through the pitch spring as a one-frame acceleration spike, so the squat is
    // the same impulse the taxi gets off the line, and the wheelie rides on top of it.
    state.v = SPEED * CHASE_KICK;
    state.prevV = SPEED;
    state.wheelieT = 0;

    // Quarry already behind it: swing round on the spot rather than driving on to the next
    // junction and taking three sides of a block to come back. This is the beat that sells the
    // lock-on, so it is worth the special case.
    if (state.dir * (quarryOnRail().along - state.s) < -UTURN_BEHIND) {
      state.uturnYaw0 = railYaw();     // recorded before the flip; the sweep runs from here
      state.uturn = 0;
      state.dir = -state.dir;
    }
    setPriorityCorridor({ axis: state.axis, line: state.line });
  }

  function arrive() {
    state.chasing = false;
    state.arrived = true;
    state.v = 0;
    state.yawRate = 0;
    // A stopped car has no corridor to hold; the lights go back to their cycle. The presence stays
    // published, so ambient traffic keeps giving the parked cruiser a wide berth.
    setPriorityCorridor(null);
  }

  function driveChase(dt) {
    state.elapsed += dt;
    const { along, across } = quarryOnRail();
    const dist = Math.hypot(drawn.x - state.quarry.x, drawn.z - state.quarry.z);
    // Signed distance still to cover along the rail to reach the quarry, negative once passed.
    // `state.s` is what actually advances by v*dt below — braking on the Euclidean `dist` above
    // (measured off the eased/lagged drawn position, and inflated by any lateral `across` offset)
    // fires later than the rail's true position warrants, so the cruiser can already be on top of
    // the taxi, or driven straight through it, before the brake check trips.
    const remaining = state.dir * (along - state.s);

    if (state.uturn !== null) {
      state.uturn = Math.min(1, state.uturn + dt / UTURN_DUR);
      // Hard on the brakes into the swing, hard on the throttle out of it.
      state.v = state.uturn < 0.5
        ? Math.max(UTURN_SPEED, state.v - UTURN_BRAKE * dt)
        : Math.min(CHASE_SPEED, state.v + CHASE_ACCEL * dt);
      if (state.uturn >= 1) state.uturn = null;
    } else {
      // Slow down only once it is on the quarry's own road and pointed at it. Braking on straight
      // -line distance instead made it dawdle a block away on the diagonal and then have to pick
      // the speed back up, which read as losing interest.
      const onRoad = Math.abs(across) < ON_ROAD;
      // Overshot it — pull up anyway rather than driving on to the next junction. Only when it is
      // genuinely alongside: turning onto the quarry's road pointing away from it is a legal move
      // when a park closes the near end, and treating that as an overshoot parks the car a block
      // short with the chase apparently abandoned.
      const passed = remaining < 0 && dist < PITCH;
      const braking = onRoad && (passed || remaining - CHASE_ARRIVE <= (state.v * state.v) / (2 * CHASE_BRAKE));
      state.v = braking
        ? Math.max(0, state.v - CHASE_BRAKE * dt)
        : Math.min(CHASE_SPEED, state.v + CHASE_ACCEL * dt);
      if ((braking && state.v <= 1) || state.elapsed > CHASE_TIMEOUT) { arrive(); return; }
    }

    const target = junctionAhead();
    const c = state.axis === 'x' ? lineX(target.i) : lineZ(target.j);
    state.s += state.dir * state.v * dt;
    if (state.dir > 0 ? state.s >= c : state.s <= c) {
      // Carry the overshoot through the corner. Dropping it stalls the car by up to a frame of
      // travel (0.43 units at chase speed) at every junction.
      const over = Math.abs(state.s - c);
      turnAt(target.i, target.j);
      state.s += state.dir * over;
    }

    // Same weave as the boosting taxi, on the same distance-paced envelope, frozen through the
    // U-turn the way the taxi's freezes mid-corner — a wave that keeps running while the car
    // pivots slides it sideways out of the swing.
    if (state.uturn === null) {
      const ds = state.v * dt;
      state.swervePhase += ds;
      state.swerve = Math.min(1, state.swerve + ds / locoWeaveFade());
    }

    // Ease the drawn car toward the rail: this is what arcs the square corners, and it damps the
    // U-turn's lane flip into a swing instead of a jump.
    const p = railPoint();
    const k = 1 - Math.exp(-dt * CHASE_SMOOTH);
    let stepX = (p.x - drawn.x) * k;
    let stepZ = (p.z - drawn.z) * k;
    // Cap the ease at a speed a car could plausibly be doing. The rail turns corners square, so
    // the frame it snaps the drawn car is chasing a target that jumped ~4.5 units sideways: it
    // covered 0.83 in one frame, 50 units/s, and the apex of every corner read as a skip. Bound
    // it and the same corner comes out as a slightly wider arc taken flat out.
    const step = Math.hypot(stepX, stepZ);
    const cap = CHASE_SPEED * 1.2 * dt;
    if (step > cap) { stepX *= cap / step; stepZ *= cap / step; }
    drawn.x += stepX;
    drawn.z += stepZ;
    state.travelled += Math.abs(state.v) * dt;

    const wasYaw = state.yaw;
    if (state.uturn !== null) {
      // Left-hand swing. dirYaw runs anticlockwise-positive, so a left turn is always +yaw and a
      // U-turn is +π from wherever it started — no shortest-arc case to get wrong.
      state.yaw = state.uturnYaw0 + Math.PI * smoothstep(state.uturn);
    } else {
      // Heading comes from the rail, not from the smoothed step. Reading it off the actual motion
      // was the obvious thing and it was wrong: for the frame after a corner snap the rail can sit
      // *behind* the drawn car, the step points back down the road, and the nose flicks through
      // 160° (22°/frame, on seeds where the chase turns onto a road it has already overrun).
      //
      // The weave's share is the same identity the taxi uses — the offset is a function of
      // distance, so its slope is the tangent of the steering angle directly. Signs work out to a
      // plain subtraction on both axes and in both directions.
      const want = railYaw() - Math.atan(state.swerve * locoWeave(state.swervePhase).slope);
      // Eased, so the 90° the rail turns instantly becomes a nose coming round over ~0.35s while
      // the body swings through the apex on its own smoothing. Assigned raw, the car pivoted.
      const shortest = Math.atan2(Math.sin(want - state.yaw), Math.cos(want - state.yaw));
      state.yaw += shortest * Math.min(1, dt / YAW_EASE);
    }
    const turned = Math.atan2(Math.sin(state.yaw - wasYaw), Math.cos(state.yaw - wasYaw));
    state.yawRate = dt > 1e-6 ? turned / dt : 0;
    bodyStep(dt);
  }

  /**
   * Roll, pitch and the tilt lift, applied to the mesh. Split out because it runs after the car
   * has stopped too: parked at the bust it keeps the spring going, so the arrival dive settles
   * back to level with a bounce instead of freezing the cruiser nose-down.
   */
  function bodyStep(dt) {
    // Lean *outward*, away from the turn centre, because that is what weight transfer does —
    // leaning inward reads as a motorbike. Eased so the body loads up over a beat instead of
    // snapping over the moment the nose starts to move.
    const wantRoll = Math.max(-ROLL_LIMIT, Math.min(ROLL_LIMIT,
      state.yawRate * state.v * ROLL_GAIN));
    state.roll += (wantRoll - state.roll) * Math.min(1, dt / ROLL_EASE);

    // Pitch spring, driven by longitudinal acceleration. The kick on lock-on, the dive into the
    // U-turn and the stand-on-the-brakes arrival all arrive here as Δv and come out as the body
    // rocking on its suspension.
    const accel = dt > 1e-6 ? (state.v - state.prevV) / dt : 0;
    state.prevV = state.v;
    const targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, accel * PITCH_GAIN));
    state.pitchV += ((targetPitch - state.pitch) * 60 - state.pitchV * 6) * dt;
    state.pitch += state.pitchV * dt;

    let shownPitch = state.pitch;
    if (state.wheelieT !== null) {
      state.wheelieT += dt;
      if (state.wheelieT >= WHEELIE_DUR) state.wheelieT = null;
      else shownPitch += locoWheelie(state.wheelieT);
    }

    // Both tilts pivot on the car's origin at road level, so either one on its own drives an edge
    // under the tarmac. Lifting by the sagitta of each keeps the low corner on the road — same
    // correction the ambient cars get, with this body's dimensions.
    const lift = Math.abs(Math.sin(state.roll)) * (CAR_W / 2)
      + Math.abs(Math.sin(shownPitch)) * (CAR_LEN / 2);
    group.position.set(drawn.x, ROAD_Y + lift, drawn.z);
    // 'YXZ', not the default — see the note by the ambient euler in sim/traffic.js. The default
    // 'XYZ' rolls about the world X axis, so a cruiser chasing north or south would show no lean
    // at all and one heading west would lean into its corners instead of out of them.
    group.rotation.set(state.roll, state.yaw, shownPitch, BODY_EULER_ORDER);
  }

  function siren(fade) {
    // Dark only between runs. The bar announces the cruiser rather than gating it: it comes up as
    // the car spawns, a good two seconds before the bust arms (see BUST_ARM_INSET), and stays up
    // until the run ends. `fade` carries the near-edge frames on its own, so the announcement
    // arrives exactly as the body does.
    if (!state.lit) {
      lights.red.visible = false;
      lights.blue.visible = false;
      lights.redLamp.intensity = 0;
      lights.blueLamp.intensity = 0;
      return;
    }

    const hunting = state.chasing || state.arrived;
    const on = sirenOn(state.flash, hunting);
    lights.red.visible = on;
    lights.blue.visible = !on;
    // Never fully dark on either side — a hard on/off strobe reads as flicker rather than a
    // siren, so the off colour keeps a low glow.
    const peak = hunting ? 130 : 90;
    lights.redLamp.intensity = (on ? peak : 14) * fade;
    lights.blueLamp.intensity = (on ? 14 : peak) * fade;
  }

  function update(dt) {
    state.flash += dt;

    // Pulled up at the bust: parked, lights still going, still keeping traffic off it. The body
    // keeps ticking so the dive it stopped on rocks back to level.
    if (state.arrived) {
      bodyStep(dt);
      setPolicePresence({ axis: state.axis, line: state.line, s: state.s, dir: state.dir });
      // Parked at the arrest with the bar still running, wherever on the map that landed. A chase
      // ends where the taxi was, which can be out in the outer band, and switching the lights off
      // on the car that just made the arrest is not a thing the gate is for.
      state.armed = true;
      state.lit = true;
      siren(1);
      return;
    }

    if (!state.active) {
      state.cooldown -= dt;
      if (state.cooldown <= 0) start();
      return;
    }

    // Both branches want this: it feeds the rail, and the chase catches up to lane traffic sooner
    // than the corridor run does because it is 7 u/s quicker.
    stepDodge(dt);

    if (state.chasing) {
      driveChase(dt);
    } else {
      state.s += state.dir * SPEED * dt;
      const half = halfSpanAlong(state.axis);
      const past = state.dir > 0
        ? state.s > half + RUN_MARGIN
        : state.s < -half - RUN_MARGIN;
      if (past) { stop(); return; }
      place();
    }

    // A chase is already past the bust it was armed for, and it can be routed anywhere on the map
    // — including back out through the outer band — so it stays armed rather than re-testing `s`
    // and disarming mid-pursuit.
    state.armed = state.chasing
      || Math.abs(state.s) <= halfSpanAlong(state.axis) - BUST_ARM_INSET;

    // --- Front wheels, off the pose that was just written.
    //
    // Taken here rather than inside either branch so the corridor run and the chase go through
    // one path: the corridor run is dead straight and comes out at a flat 0°, and everything the
    // chase does — the eased 90° at a junction, the weave, the U-turn — falls out of the same
    // difference. Distance is measured on the drawn position, which is the arc the player sees;
    // `state.s` is the rail's, and the rail turns its corners square.
    const ds = Math.hypot(group.position.x - state.prevX, group.position.z - state.prevZ);
    state.wheelAngle = steerToward(
      state.wheelAngle, group.rotation.y, state.prevYaw, ds, WHEELBASE,
    );
    state.prevYaw = group.rotation.y;
    state.prevX = group.position.x;
    state.prevZ = group.position.z;
    front.wheels.forEach((wheel) => { wheel.rotation.y = state.wheelAngle; });

    // Ambient traffic on this road reads the siren's `s` from here and reacts around it. Set
    // every frame rather than on start so cars ahead brake and swerve as the car catches up,
    // rather than reacting only to a snapshot from when the run began.
    setPolicePresence({ axis: state.axis, line: state.line, s: state.s, dir: state.dir });

    // The lamps fade with the bodywork. Leaving them at full strength would keep washing colour
    // across the tarmac from a car that is no longer there.
    const fade = edgeFade(state.s, state.axis);
    state.fade = fade;
    for (const material of skin) material.opacity = fade;
    siren(fade);
  }

  /**
   * How often the corridor runs, as `[min, max]` seconds between them.
   *
   * Takes effect from the *next* draw rather than cutting the current wait short: shortening a
   * cooldown that is already counting down would fire a siren the moment a delivery lands, which
   * reads as the game punishing the drop-off.
   */
  const setCooldownRange = ([min, max]) => { state.cooldownRange = [min, max]; };

  return { state, update, chase, group, setCooldownRange };
}
