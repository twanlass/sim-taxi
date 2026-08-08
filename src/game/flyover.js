import { createPlaneMesh } from '../geometry/plane.js';
import { VIEW_DIR } from './camera.js';

// A light aircraft crossing the city every so often. Pure scenery: it is not routed, not
// collidable, not tappable, and nothing in the fare loop or the difficulty curve knows it exists.
// The model is in geometry/plane.js; this is the flight.
//
// It lives in `game/` beside dust, flames and the blast rather than in `sim/` beside the traffic,
// because that is the line those two directories actually draw — `sim/` is the cars, the signals
// and the things the player can hit, and this is an effect. It is also what lets it read VIEW_DIR
// straight out of the camera, which the streamers need.

const SPEED = 38;                // units/s — about four times ambient traffic, which is roughly
                                 // the ratio a light aircraft holds over city driving
const CRUISE_ALT = 30;           // clears the tallest tower (16) with room for the bob and bank
const ALT_JITTER = [-4, 6];

// How far either side of the middle of the flight line a run reaches. It has to put both ends of
// the run off the edge of every framing the game allows — an ultrawide desktop at play zoom, from
// a camera panned into a corner — so the aeroplane always *enters* the frame rather than appearing
// inside it. `tools/probe.mjs` projects both ends through real cameras rather than trusting this.
//
// The fade is then belt and braces: the run margin is what stops a pop, and this is what turns one
// into a soft arrival if some viewport shape nobody anticipated (a 4:1 window) reaches past it.
const RUN_MARGIN = 190;
const FADE_BAND = 45;

// How long between flights. "Every once in a while" is the whole brief: often enough that a run
// gets one or two, rare enough that it stays a thing you notice rather than traffic in the sky.
// The first is sooner than the rest so a short run isn't guaranteed to miss it. Deliberately not
// on the difficulty curve — nothing about this is pressure.
const FIRST_WAIT = [18, 34];
const WAIT = [45, 90];

// The heading. Screen right is world (1, 0, -1) at this camera, so a plane flying down a world
// axis already crosses the screen on a 45° diagonal — the same diagonal every car and every
// street is on. The skew is what lifts it off that: 15-35° away from the axis puts the flight
// path at a slant that matches nothing on the ground, which is what makes it read as passing
// *over* the city rather than as traffic on an invisible road.
const SKEW = [0.26, 0.61];       // radians, ~15° to ~35°
// How far the line is pushed sideways off the middle of the map, so consecutive flights don't all
// bisect it — some cross the centre, some clip a corner.
const OFFSET_SPREAD = 30;

// The bob and the bank. Two different rates rather than one, so the motion never settles into an
// obvious loop over the six seconds it is on screen; small enough that it reads as air rather than
// as a manoeuvre. Pitch is derived from the climb rate instead of being its own wave — the nose
// comes up as the aeroplane rises, which is the half of the motion that sells it as flying.
const BOB_AMP = 0.34;
const BOB_RATE = 1.15;
const ROLL_AMP = 0.085;
const ROLL_RATE = 0.62;
const PITCH_GAIN = 0.22;         // radians per unit/s of climb

// Two blades is 180° of symmetry, so anything under 90° of travel per frame reads as forward
// rotation. At 60fps this is 12.4°, which is fast enough to look like a running engine and a long
// way clear of the rate where a prop strobes backwards or stands still.
export const PROP_SPIN = 13;

/** World forward for a heading — the same convention `dirYaw` uses: yaw 0 points down +X. */
export const heading = (yaw) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });

/**
 * How far to roll the wingtip streamers about their own long axes so they face the camera.
 *
 * A ribbon is invisible edge-on, and a streamer lying in the wing plane is very nearly edge-on to
 * a camera 33° above the horizon. The camera never rotates, so this is a constant per heading
 * computed once at launch rather than a per-frame billboard — the same property `VIEW_DIR` is
 * exported for.
 *
 * The ribbon can only turn about the fuselage axis, so the best it can do is line its **normal**
 * up with the part of `VIEW_DIR` perpendicular to that axis. It widens along local (0, cos, sin),
 * which puts its normal at (0, −sin, cos) — so the angle wanted is that of the view's YZ component
 * turned a quarter turn, and pointing the *width* at the camera instead is exactly the way to get
 * a ribbon you cannot see. The body's own bank and pitch are ignored: at ±0.085 rad they move the
 * ribbon by under half a degree.
 */
export function trailRoll(yaw) {
  const y = VIEW_DIR.y;
  const z = VIEW_DIR.x * Math.sin(yaw) + VIEW_DIR.z * Math.cos(yaw);
  return Math.atan2(-y, z);
}

export function createFlyover(scene, rng) {
  const plane = createPlaneMesh();
  plane.group.visible = false;
  scene.add(plane.group);

  const state = {
    active: false,
    cooldown: rng.range(FIRST_WAIT[0], FIRST_WAIT[1]),
    flights: 0,
    t: 0,                        // seconds since this flight began
    s: 0,                        // distance along the flight line, -RUN_MARGIN to +RUN_MARGIN
    yaw: 0,
    alt: CRUISE_ALT,
    offset: 0,
    bobPhase: 0,
    rollPhase: 0,
    fade: 0,
  };

  /** 1 over the city, easing to 0 well before either end of the run. */
  function edgeFade(s) {
    return Math.max(0, Math.min(1, (RUN_MARGIN - Math.abs(s)) / FADE_BAND));
  }

  function place() {
    const f = heading(state.yaw);
    // The flight line, pushed `offset` sideways. Perpendicular to `f` in the ground plane.
    const px = Math.sin(state.yaw);
    const pz = Math.cos(state.yaw);

    const bob = BOB_AMP * Math.sin(state.t * BOB_RATE + state.bobPhase);
    const climb = BOB_AMP * BOB_RATE * Math.cos(state.t * BOB_RATE + state.bobPhase);
    const roll = ROLL_AMP * Math.sin(state.t * ROLL_RATE + state.rollPhase);

    plane.group.position.set(
      f.x * state.s + px * state.offset,
      state.alt + bob,
      f.z * state.s + pz * state.offset,
    );
    plane.group.rotation.set(roll, state.yaw, climb * PITCH_GAIN);
    // Off sim time rather than accumulated, like every other animation in the project, so a frozen
    // shot renders the same blade angle every time.
    plane.blade.rotation.x = state.t * PROP_SPIN;

    state.fade = edgeFade(state.s);
    plane.setFade(state.fade);
  }

  /** Send one across. Public so shot mode can stage a flight rather than wait one out. */
  function launch() {
    state.yaw = rng.int(0, 3) * (Math.PI / 2)
      + (rng.chance(0.5) ? 1 : -1) * rng.range(SKEW[0], SKEW[1]);
    state.offset = rng.jitter(OFFSET_SPREAD);
    state.alt = CRUISE_ALT + rng.range(ALT_JITTER[0], ALT_JITTER[1]);
    state.bobPhase = rng.range(0, Math.PI * 2);
    state.rollPhase = rng.range(0, Math.PI * 2);
    state.s = -RUN_MARGIN;
    state.t = 0;
    state.active = true;
    state.flights += 1;
    plane.group.visible = true;
    // The streamers face the camera, and which way that is depends on the heading — so it is
    // resolved here, once, rather than every frame.
    plane.setTrailRoll(trailRoll(state.yaw));
    place();                     // or it is drawn at last flight's position for one frame
  }

  function update(dt) {
    if (!state.active) {
      state.cooldown -= dt;
      if (state.cooldown <= 0) launch();
      return;
    }

    state.t += dt;
    state.s += SPEED * dt;
    if (state.s >= RUN_MARGIN) {
      state.active = false;
      state.fade = 0;
      plane.group.visible = false;
      state.cooldown = rng.range(WAIT[0], WAIT[1]);
      return;
    }
    place();
  }

  return { group: plane.group, state, update, launch };
}
