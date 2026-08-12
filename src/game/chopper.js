import { createHelicopterMesh, HELI_SKID_DROP } from '../geometry/helicopter.js';
import { BODY_EULER_ORDER } from '../util/geo.js';

// A helicopter that visits the city's rooftop helipad every couple of minutes: it comes in over the
// skyline on a curve, banking as it lines up, settles onto the circle in its own dust, sits with the
// rotor idling for a few seconds, then picks up and leaves the way it came. Pure scenery, on exactly
// the terms the aeroplane and the park flocks are: nothing routes it, nothing collides with it,
// nothing can be tapped on it, and neither the fare loop nor the difficulty curve knows it exists.
// The model is in geometry/helicopter.js; this is the visit.
//
// It lives in `game/` beside the flyover, the birds and the dust rather than in `sim/` beside the
// traffic, for the reason those two directories actually split on: `sim/` is the cars, the signals
// and the things the player can hit, and this is an effect. It reads `city/` for the pad and for
// the skyline it has to clear, which is the direction the dependency rule allows.
//
// **The pad is the whole reason `city/buildings.js` now guarantees one.** A helipad used to be a
// coin flip on an eligible roof and 62% of cities had none; a vignette that only happens on a third
// of seeds is not a vignette. See `choosePad` there.

// --- The rhythm ------------------------------------------------------------------
// The same brief as the aeroplane's: often enough that a run gets one or two, rare enough that it
// stays something you notice. A visit is about 25 seconds door to door, against the plane's six, so
// the gaps are longer — two of these overlapping would read as an airport rather than as an event.
// Deliberately not on the difficulty curve: nothing about this is pressure.
const FIRST_WAIT = [26, 48];
const WAIT = [95, 165];

// --- The approach ----------------------------------------------------------------
// Where a leg begins, measured out from the pad. Far enough to be off the edge of the city on any
// framing (the map is 100 units across and the play camera sees about 120), so the machine is
// always seen *arriving*; the fade is then the belt and braces the flyover's RUN_MARGIN is for.
const ENTRY_DIST = 108;
const FADE_IN = [78, 104];       // solid at 78 units out, gone at 104
const FADE_OUT = [58, 92];       // and the reverse, on the way home

const CRUISE = 23;               // units/s — half again the ambient traffic, a third of the plane's
const APPROACH_SPEED = 3;        // what it is down to as it arrives over the circle
const ACCEL = 6;                 // units/s²
// Braking is harder than accelerating, and not only because helicopters are: the approach sheds 20
// units/s over the 43 units of BRAKE_DIST, which at 6 arrives over the circle still doing walking
// pace and needing another second it hasn't got. It then flies *past* the pad, and a pursuit curve
// that overshoots comes round for another go — a helicopter circling its own helipad forever, which
// is what the first pass at these numbers actually did.
const DECEL = 11;
const BRAKE_DIST = 46;           // where it starts winding the speed off

/**
 * How high it transits.
 *
 * Both ends of this are measured rather than picked. `SKYLINE_CEILING` is the line nothing on a
 * roof may reach (20.5), so anything above it clears every tower in every city by construction —
 * and the aeroplane's belly is at 24.9 on the low side of its own jitter, so the top of this
 * machine's rotor disc has to stay under that or the two ambient aircraft will eventually be seen
 * occupying the same piece of sky. 22 leaves 1.5 over the skyline and 1.6 under the plane once the
 * rotor's 1.35 is counted. `tools/probe.mjs` asserts both gaps rather than trusting the sum.
 */
export const CRUISE_ALT = 22;

/**
 * **The transit is level and the descent is vertical, and that is a clearance rule rather than a
 * style.** `CRUISE_ALT` is the one altitude in this city that is safe by construction: every other
 * height has a tower somewhere that reaches it. The first version of this flew a 45-unit glide slope
 * onto the pad — much prettier on paper — and a headless sweep of the flown path against a height
 * field of the city put the machine *through* a neighbouring tower on eleven cities in twenty-four,
 * by as much as seven units. The pad is on a tall roof but it is not on the tallest one, and the
 * block next door is one street away.
 *
 * So it arrives over the circle at cruise and comes down the hole. That is also what a helicopter
 * into a downtown pad actually does, which is the usual way round: the manoeuvre that is safe is
 * the manoeuvre that got invented. `tools/probe.mjs` re-runs that sweep on every check.
 */
const SETTLE_DIST = 3;           // horizontal — inside this it is over the circle and coming down
// Fast down the first of it and slow onto the paint, split at `SLOW_BAND` above the deck. One rate
// for the whole drop is either a machine that falls onto its own helipad or one that takes six
// seconds to cross ten units of empty air.
const DESCENT_FAST = 5;
const DESCENT_SLOW = 1.6;
const SLOW_BAND = 4;
const LIFT_RATE = 3.2;           // and off it — deliberately slower than the fall, as a climb is

// The turn. `TURN_RATE` is a helicopter's, not an aeroplane's, and the pedal turn it makes over the
// pad before leaving is half of what makes it read as a helicopter rather than as a plane with the
// wings left off — so a hover turns about its own mast at `PIVOT_RATE` and does not bank doing it.
// Banking on the spot is the one thing that would give the whole trick away.
const TURN_RATE = 1.05;          // rad/s in forward flight
const PIVOT_RATE = 1.5;          // and in the hover
// Radians of bank per rad/s of turn — a lean into the corner. Both numbers went up once the thing
// was on screen: at 0.75 and 0.34 the turn onto final was a 19° lean that read as a machine sliding
// sideways rather than one *turning*. A helicopter banks harder than an aeroplane for the same
// corner, because the rotor disc is the wing and tipping it is the only way it has to pull.
const ROLL_GAIN = 1.05;
const ROLL_MAX = 0.5;            // 29°, which is a brisk airline turn and a mild one for this
// Nose attitude. Forward flight is nose-down, the flare is nose-up, and the two are the same
// channel driven off speed: `PITCH_CRUISE` at full chat, easing through zero to the flare as it
// slows onto the pad. A helicopter's whole body language is this one angle.
const PITCH_CRUISE = -0.2;
const PITCH_FLARE = 0.26;

/**
 * The wobble every airborne frame carries on top of whatever the flight is doing.
 *
 * Nothing in the flight model is unsteady: the transit is a straight line at a fixed height and the
 * hover is a lerp onto a point, so between the turn onto final and the touchdown the machine held a
 * perfectly rigid attitude for several seconds and read as a model being slid along a wire. A real
 * one is *never* still — it is a platform balanced on a rotor, and the pilot is correcting it
 * continuously.
 *
 * Two sines per channel at rates that don't share a period, so the pattern never visibly repeats,
 * and it is applied at **pose time only**: the attitude jitters, the flight path does not. Yaw is
 * in there as well as roll — a helicopter in the cruise sits very slightly crabbed and hunts about
 * it, which is the part that reads as "flying" rather than "being moved".
 */
const WOBBLE_ROLL = [[0.055, 1.7, 0], [0.028, 2.9, 1.1]];
const WOBBLE_PITCH = [[0.035, 1.3, 0.4], [0.018, 2.3, 2.2]];
const WOBBLE_YAW = [[0.045, 0.9, 2], [0.022, 2.1, 0.6]];
// How far off the deck it takes to reach full strength. Parked, the machine is on its skids with
// the rotor at idle and has to be dead still; the wobble comes in as the weight comes off.
const WOBBLE_LIFT = 1.6;

// How far off the pad's own long axis a leg may come in. The approach is lined up with the *deck*
// rather than aimed from anywhere: these roofs are 3 to 8 units wide and the machine is 6 long, so
// arriving across one leaves the tail hanging over the parapet. Lining up along it also means the
// bank is always the same size on screen, which is the shot this is for.
const APPROACH_SKEW = 0.34;      // radians

/**
 * The curve, which is the whole reason this is not a straight line onto the pad.
 *
 * A leg enters *beside* the final approach line — `CURVE_OFFSET` units to one side of it — and
 * steers at an aim point that slides sideways onto the pad as it closes, so the machine flies a
 * base leg, banks through the turn onto final and rolls level lined up. It is a real approach, and
 * it puts the bank where a bank can be seen.
 *
 * The first version instead entered pointing 40–65° off the pad and let pure pursuit straighten it
 * out. Same manoeuvre on paper; useless in practice. Pursuit converges fastest when the bearing
 * moves fastest, which is when the target is *near* — so the whole turn happened in the first 1.4
 * seconds, 75 units out, with the machine still faded out and off the edge of the map. The bank has
 * to be spent over the city, not on the way to it.
 */
const CURVE_OFFSET = 34;
const TURN_START = 52;           // where the aim point starts sliding onto the pad
const FINAL_DIST = 14;           // and where it gets there, lined up and level

// --- On the deck -----------------------------------------------------------------
const IDLE = [6.5, 11];          // seconds sitting on the pad
// The rotor. Flight rpm is fast enough to blur and idle slow enough to count the blade, and the
// spool between them is what gives the sitting-there half of the vignette something to watch. Two
// blades is 180° of symmetry, so anything under 90° of travel a frame reads as forward rotation —
// at 60fps this is 26.7°, the same margin clear of strobing that the propeller keeps.
export const ROTOR_FLIGHT = 28;  // rad/s
const ROTOR_IDLE = 7;
const SPOOL_DOWN = 2.6;          // s to wind down after touchdown
const SPOOL_UP = 2.2;            // s of winding back up before it lifts
const TAIL_RATIO = 4.6;          // the tail rotor turns this much faster than the main

// The beacon. On for a fifth of a second every 1.4, which is a real anti-collision light's rhythm
// and — more to the point — slow enough that it never competes with the fare markers for the eye.
const BLINK_PERIOD = 1.4;
const BLINK_ON = 0.2;

// --- The rotor wash --------------------------------------------------------------
// Dust off the deck, through the same pool the boost trail and the barricade use (see
// `game/dust.js`). It starts before touchdown, not on it: ground effect is what a helicopter kicks
// up on the way *down*, and dust that appears the instant the skids touch reads as an impact.
const WASH_H = 3.6;              // height above the pad at which the deck starts to lift
const WASH_RATE = 9;             // puffs/s at the bottom of that, tapering off with height
// Against the barricade's 1 — this is a breeze, not a smash. It started at 0.42, which is a puff
// under a unit across at the end of its life, and a rendered close-up settled it: at that size the
// pool's faceted icosahedra are hard little lit lumps and a dozen of them ringing the pad read as
// gravel scattered on the roof rather than as air. Dust has to be *bigger than the thing kicking it
// up* to read as dust at all.
const WASH_POWER = 1;
// And the two bursts that bracket the visit: one as the skids take the weight, one as they leave
// it. Same event twice, because a landing and a lift-off displace the same air. Weaker per puff
// than the trickle, because `burst` multiplies the power up again by 1.9–3.1 on top.
const WASH_BURST = 9;
const BURST_POWER = 0.5;
// And started most of the way up its own size curve, for the reason the wreck's smoke collar is
// (see `startSize` in game/dust.js): a burst that opens at a point spends the half-second the eye
// is on it as a handful of pebbles, and the air a helicopter displaces is already a cloud on the
// frame the skids touch.
const BURST_START_SIZE = 1;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Signed shortest way round from an angle difference. */
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** 0 at `zero`, 1 at `one`, either way round. */
const ramp = (v, one, zero) => clamp((v - zero) / (one - zero), 0, 1);

/** World forward for a heading — the convention `dirYaw` sets: yaw 0 points down +X. */
export const heading = (yaw) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });

/**
 * The visit, as a state machine over one pad.
 *
 * @param pad       `{ x, z, y, r, cw, cd }` from `createBuildings` — where the paint is and how big
 *                  the deck under it is. Null on a city with no roof wide enough, which the
 *                  generator has not actually produced; it returns a stub rather than throwing,
 *                  since nothing here matters to the game.
 * @param onWash    called with `(x, z, y, yaw, power, count)` to kick dust off the deck — a
 *                  callback rather than the dust pool itself, so `game/` keeps the one direction of
 *                  dependency the roadwork's `onSmash` established. `yaw` is the drift heading the
 *                  pool's own `add` takes, resolved at this end because only this end knows which
 *                  way is *outward* from the circle. A `count` above one is a burst, and carries
 *                  a seventh argument: where on the size curve its puffs start.
 */
export function createChopper(scene, rng, pad, { onWash = () => {} } = {}) {
  const state = {
    mode: 'away',                // 'away' | 'in' | 'settle' | 'idle' | 'lift' | 'out'
    visits: 0,
    landings: 0,
    cooldown: rng.range(FIRST_WAIT[0], FIRST_WAIT[1]),
    t: 0,                        // seconds since this visit began
    x: 0, y: 0, z: 0,
    side: 1,                     // which side the base leg is flown on
    yaw: 0, roll: 0, pitch: 0,
    speed: 0,
    rotor: 0,                    // blade angle, radians
    rotorRate: 0,
    inbound: 0,                  // the heading the leg arrived on
    departYaw: 0,
    idleLeft: 0,
    washDebt: 0,                 // fractional puffs owed to the wash, so its rate is dt-independent
    fade: 0,
  };

  if (!pad) {
    return { group: null, state, update: () => {}, visit: () => {}, pad: null };
  }

  const heli = createHelicopterMesh();
  heli.group.visible = false;
  heli.group.rotation.order = BODY_EULER_ORDER;
  scene.add(heli.group);

  const PARKED_Y = pad.y + HELI_SKID_DROP;

  /**
   * Where the *skids* have to end up, which is not where the pad is.
   *
   * The model's origin is the middle of its cabin and its skids run from 0.9 behind that to 2.05 in
   * front, so parking the origin on the circle lands the machine sitting a unit and a half back on
   * its own tail with the toes over the far parapet. A helicopter is centred on the H by the part of
   * it that touches — so the target is the pad slid back along the machine's own heading by half
   * the difference. It puts the tail boom out over the roof edge, which is what they look like.
   */
  const SKID_CENTRE = 0.575;
  const parkTarget = (yaw) => {
    const f = heading(yaw);
    return { x: pad.x - f.x * SKID_CENTRE, z: pad.z - f.z * SKID_CENTRE };
  };

  /** Horizontal distance from the pad's centre. */
  const outFromPad = () => Math.hypot(state.x - pad.x, state.z - pad.z);

  /** The sum of a channel's sines, faded in with height off the deck. See WOBBLE_ROLL. */
  function wobble(waves, lift) {
    let sum = 0;
    for (const [amplitude, rate, phase] of waves) {
      sum += amplitude * Math.sin(state.t * rate + phase);
    }
    return sum * lift;
  }

  function pose() {
    heli.group.position.set(state.x, state.y, state.z);
    const lift = clamp((state.y - PARKED_Y) / WOBBLE_LIFT, 0, 1);
    // 'YXZ', not the default — see the note on BODY_EULER_ORDER in util/geo.js. Three composes
    // 'XYZ' as Rx·Ry·Rz, which puts the roll *outside* the yaw and turns it about the world X axis:
    // a machine banking on an eastbound approach would lean correctly and one arriving from the
    // north would render the same number as pitch and not lean at all.
    heli.group.rotation.set(
      state.roll + wobble(WOBBLE_ROLL, lift),
      state.yaw + wobble(WOBBLE_YAW, lift),
      state.pitch + wobble(WOBBLE_PITCH, lift),
      BODY_EULER_ORDER,
    );
    heli.mainHub.rotation.y = state.rotor;
    heli.tailHub.rotation.z = state.rotor * TAIL_RATIO;
    heli.setRotorBlur(clamp(state.rotorRate / ROTOR_FLIGHT, 0, 1));
    // Off the visit's own clock rather than a free-running one, so a frozen shot renders the same
    // beacon state every time — the same argument the propeller's angle is computed under.
    heli.setBeacon(state.t % BLINK_PERIOD < BLINK_ON);
    heli.setFade(state.fade);
    // Shadows only while it is near the deck it is over. The sun sits 28.5° up, so a shadow thrown
    // from transit altitude lands 40 units from the machine that threw it — a dark blob crossing a
    // street with nothing above it, which is exactly why the aeroplane casts none at all. Close in,
    // the surface catching it *is* the roof it is landing on, and the shadow sliding onto the pad is
    // the best cue in the whole vignette for how far off the deck it still is.
    heli.body.castShadow = state.y - PARKED_Y < WASH_H;
  }

  /**
   * Dust off the deck, at a rate that climbs as the skids get closer to it.
   *
   * Metered through `washDebt` rather than rolled per frame: the rate is per *second*, and a
   * per-frame `rng.chance` would put twice as much dust under a 120Hz display as a 60Hz one.
   */
  function wash(dt) {
    const height = state.y - PARKED_Y;
    if (height > WASH_H) { state.washDebt = 0; return; }

    const strength = 1 - height / WASH_H;
    state.washDebt += WASH_RATE * strength * dt;
    while (state.washDebt >= 1) {
      state.washDebt -= 1;
      // Around the circle rather than under the machine: the wash rolls outward off the pad, and
      // puffs spawned at the centre are hidden by the thing that made them.
      const bearing = rng.range(0, Math.PI * 2);
      const reach = pad.r * rng.range(0.55, 1.15);
      onWash(
        pad.x + Math.cos(bearing) * reach,
        pad.z + Math.sin(bearing) * reach,
        pad.y,
        // The pool drifts a puff *backwards* from the heading it is handed — that is what a wheel
        // throwing dust does — so the heading that carries one outward along its own bearing is
        // the one pointing back at the mast. Handing it the bearing itself blows the whole wash
        // into the middle of the pad, where the machine sitting on it hides every puff.
        Math.PI - bearing,
        WASH_POWER * strength,
        1,
      );
    }
  }

  /** The heavier double-handful, on touchdown and again on lift-off. */
  function washBurst() {
    onWash(pad.x, pad.z, pad.y, state.yaw, BURST_POWER, WASH_BURST, BURST_START_SIZE);
  }

  // --- The legs --------------------------------------------------------------------

  /**
   * Start one. Public so shot mode can stage a visit rather than wait one out — the same reason
   * `flyover.launch()` and `birds.takeOff()` are.
   */
  function visit() {
    // Along the deck's long axis, give or take. See APPROACH_SKEW: these roofs are narrower than
    // the machine is long, so which way it sits on the pad is decided by the building.
    const alongX = pad.cw >= pad.cd;
    const axis = alongX ? 0 : Math.PI / 2;
    const inbound = axis + (rng.chance(0.5) ? 0 : Math.PI) + rng.jitter(APPROACH_SKEW);

    state.inbound = inbound;
    // Which side the base leg is flown on. Left and right are the same manoeuvre mirrored, and
    // alternating them is most of what stops two visits in one run looking like a repeat.
    state.side = rng.chance(0.5) ? 1 : -1;
    // Back down the inbound heading to the far edge of the map, and out to one side of it.
    const f = heading(inbound);
    const p = { x: -f.z, z: f.x };          // perpendicular, in the ground plane
    state.x = pad.x - f.x * ENTRY_DIST + p.x * state.side * CURVE_OFFSET;
    state.z = pad.z - f.z * ENTRY_DIST + p.z * state.side * CURVE_OFFSET;
    state.y = CRUISE_ALT;
    // Pointing down the base leg, i.e. parallel to the line it will end up on. The turn onto final
    // comes from the aim point sliding across, not from an error it starts with.
    state.yaw = inbound;
    state.speed = CRUISE;
    state.roll = 0;
    state.pitch = PITCH_CRUISE;
    state.rotorRate = ROTOR_FLIGHT;
    state.washDebt = 0;
    state.t = 0;
    state.mode = 'in';
    state.visits += 1;
    state.fade = 0;
    heli.group.visible = true;
    pose();                      // or it draws at last visit's position for one frame
  }

  /** Turn toward a heading at the machine's own rate, and bank into the turn. */
  function steer(want, dt) {
    const turn = clamp(wrapAngle(want - state.yaw), -TURN_RATE * dt, TURN_RATE * dt);
    state.yaw += turn;
    const rate = dt > 0 ? turn / dt : 0;
    // Scaled by how fast it is going, because that is what a bank *is*: tipping the disc is how a
    // moving helicopter turns and pedals are how a stationary one does. Without this the departure
    // — which turns hardest in the second it spends going nowhere — rolled 29° on the spot, and a
    // machine leaning over a hover is the one thing that gives the whole trick away.
    const authority = ramp(state.speed, CRUISE * 0.35, 0);
    // Eased rather than snapped: the bank lags the turn, which is what stops a machine rolling
    // level the instant it stops turning.
    const wantRoll = clamp(-rate * ROLL_GAIN, -ROLL_MAX, ROLL_MAX) * authority;
    state.roll += (wantRoll - state.roll) * Math.min(1, dt * 3.5);
    return rate;
  }

  /**
   * Turn on the spot, level. A hovering helicopter yaws on its tail rotor and does not lean doing
   * it — `steer` would roll it, because `steer` reads a turn as a *corner* being taken.
   */
  function pivot(want, dt) {
    state.yaw += clamp(wrapAngle(want - state.yaw), -PIVOT_RATE * dt, PIVOT_RATE * dt);
    state.roll += (0 - state.roll) * Math.min(1, dt * 3.5);
    return Math.abs(wrapAngle(want - state.yaw));
  }

  function updateIn(dt) {
    const dist = outFromPad();

    // Pursuit toward a point that slides onto the pad as the machine closes — see CURVE_OFFSET.
    // Steering at the *pad* the whole way is a straight line with a kink at the start; steering at
    // this is a base leg and a turn onto final, which is the same path a real one flies and the
    // only version of it with the bank in the right place.
    const line = heading(state.inbound);
    const across = CURVE_OFFSET * ramp(dist, TURN_START, FINAL_DIST) * state.side;
    const aimX = pad.x - line.z * across;
    const aimZ = pad.z + line.x * across;
    steer(Math.atan2(-(aimZ - state.z), aimX - state.x), dt);

    // Speed is a function of distance rather than a deceleration schedule, so it arrives over the
    // circle at walking pace however far out the leg started.
    const want = APPROACH_SPEED + (CRUISE - APPROACH_SPEED) * ramp(dist, BRAKE_DIST, SETTLE_DIST);
    state.speed += clamp(want - state.speed, -DECEL * dt, ACCEL * dt);

    const f = heading(state.yaw);
    state.x += f.x * state.speed * dt;
    state.z += f.z * state.speed * dt;
    // Level, all the way in. See the note on SETTLE_DIST: this is the only height in the city that
    // clears every tower, and the descent waits until the machine is over the roof it is landing on.
    state.y = CRUISE_ALT;

    // Nose down at speed, up in the flare. One channel, driven off how fast it is going.
    const fast = ramp(state.speed, CRUISE, APPROACH_SPEED);
    state.pitch = PITCH_FLARE + (PITCH_CRUISE - PITCH_FLARE) * fast;

    state.fade = ramp(dist, FADE_IN[0], FADE_IN[1]);

    if (dist < SETTLE_DIST && state.speed < APPROACH_SPEED * 1.35) {
      state.mode = 'settle';
    }
  }

  /** Over the circle, coming straight down onto it. */
  function updateSettle(dt) {
    // Squared away onto the approach line first. The last fourteen units are flown straight at the
    // pad from wherever the base leg left the machine, so it arrives a few degrees off the line it
    // was lined up on — and a helicopter that lands 20° across a roof three units wide is a
    // helicopter with its tail over the parapet.
    pivot(state.inbound, dt);

    // Then slide the last of the horizontal error out rather than cutting it: at SETTLE_DIST the
    // machine is up to three units off centre, and one that lands on the edge of the H looks like
    // one that missed. Aimed at where its *skids* have to be, not at the paint.
    const park = parkTarget(state.yaw);
    state.x += (park.x - state.x) * Math.min(1, dt * 1.6);
    state.z += (park.z - state.z) * Math.min(1, dt * 1.6);
    state.speed = Math.max(0, state.speed - ACCEL * dt);

    // Down fast through the empty air over the roof and slow onto the paint.
    const height = state.y - PARKED_Y;
    const rate = height > SLOW_BAND
      ? DESCENT_FAST
      : DESCENT_SLOW + (DESCENT_FAST - DESCENT_SLOW) * (height / SLOW_BAND) ** 2;
    state.y = Math.max(PARKED_Y, state.y - rate * dt);

    // Level out onto the deck. It cannot touch down leaning: a skid takes the weight before the
    // other one does and the machine rights itself, which is over long before the eye arrives.
    const level = Math.min(1, dt * 3);
    state.roll += (0 - state.roll) * level;
    state.pitch += (0 - state.pitch) * level;
    state.fade = 1;
    wash(dt);

    if (state.y <= PARKED_Y + 1e-4) {
      state.y = PARKED_Y;
      state.roll = 0;
      state.pitch = 0;
      state.speed = 0;
      state.mode = 'idle';
      state.landings += 1;
      state.idleLeft = rng.range(IDLE[0], IDLE[1]);
      washBurst();
    }
  }

  /** Sitting on the pad: rotor down to idle, and back up before it goes. */
  function updateIdle(dt) {
    state.idleLeft -= dt;
    const spinUp = state.idleLeft < SPOOL_UP;
    const target = spinUp ? ROTOR_FLIGHT : ROTOR_IDLE;
    const per = (ROTOR_FLIGHT - ROTOR_IDLE) / (spinUp ? SPOOL_UP : SPOOL_DOWN);
    state.rotorRate += clamp(target - state.rotorRate, -per * dt, per * dt);
    state.fade = 1;

    if (state.idleLeft <= 0) {
      state.mode = 'lift';
      // Back the way it came. A pedal turn on the way up is what sells it: the machine leaves
      // facing the way it arrived from, having turned about its own mast to do it, which is the one
      // manoeuvre in the vignette no aeroplane could make.
      state.departYaw = state.inbound + Math.PI + rng.jitter(APPROACH_SKEW);
      state.rotorRate = ROTOR_FLIGHT;
      washBurst();
    }
  }

  /**
   * Straight up off the deck, pedal-turning onto the departure heading as it goes.
   *
   * All the way back to `CRUISE_ALT` before a single unit of forward travel, which is the departure
   * half of the clearance rule the descent obeys — see SETTLE_DIST. Climbing out *while*
   * accelerating is what a helicopter with a runway in front of it would do, and it was flying
   * through the block next door on half of all cities.
   *
   * The pedal turn deliberately **stops `LIFT_HANDOVER` short** of the departure heading: the last
   * 50° is flown, banked, once the machine has speed on it. Pivoting the whole 180° on the spot and
   * then setting off in a straight line is two manoeuvres played end to end; handing the rest of the
   * turn to forward flight makes it one, and puts a lean on the way out to match the one on the way
   * in. The pivot is *held* there rather than merely exited early, because the climb takes about
   * four seconds against the turn's two and it would otherwise finish the whole thing while waiting.
   */
  const LIFT_HANDOVER = 1.25;

  function updateLift(dt) {
    state.y = Math.min(CRUISE_ALT, state.y + LIFT_RATE * dt);
    const off = Math.abs(wrapAngle(state.departYaw - state.yaw));
    if (off > LIFT_HANDOVER) pivot(state.departYaw, dt);
    state.fade = 1;
    wash(dt);

    // Both, not either: leaving on the climb alone means accelerating away sideways — a helicopter
    // flying out over the city with its nose still pointing at where it came from.
    if (state.y >= CRUISE_ALT - 1e-4 && off <= LIFT_HANDOVER + 1e-6) state.mode = 'out';
  }

  /** Nose over and away, and fade into the distance. */
  function updateOut(dt) {
    steer(state.departYaw, dt);
    state.speed = Math.min(CRUISE, state.speed + ACCEL * dt);

    const f = heading(state.yaw);
    state.x += f.x * state.speed * dt;
    state.z += f.z * state.speed * dt;
    state.y = CRUISE_ALT;

    const fast = ramp(state.speed, CRUISE, 0);
    state.pitch = PITCH_CRUISE * fast;

    state.fade = ramp(outFromPad(), FADE_OUT[0], FADE_OUT[1]);
    if (state.fade <= 0) {
      state.mode = 'away';
      heli.group.visible = false;
      state.cooldown = rng.range(WAIT[0], WAIT[1]);
    }
  }

  function update(dt) {
    if (state.mode === 'away') {
      state.cooldown -= dt;
      if (state.cooldown <= 0) visit();
      return;
    }

    state.t += dt;
    // Accumulated rather than taken off the clock, because the rate is not constant — the spool up
    // and down are half of what a helicopter sitting on a roof is doing. A shot steps the same
    // fixed dt from `visit()`, so a frozen frame still renders the same blade angle every time.
    state.rotor += state.rotorRate * dt;

    if (state.mode === 'in') updateIn(dt);
    else if (state.mode === 'settle') updateSettle(dt);
    else if (state.mode === 'idle') updateIdle(dt);
    else if (state.mode === 'lift') updateLift(dt);
    else updateOut(dt);

    pose();
  }

  return {
    group: heli.group,
    heli,
    state,
    pad,
    /** Where the machine is right now, for the shot camera. */
    position: () => heli.group.position,
    update,
    visit,
  };
}
