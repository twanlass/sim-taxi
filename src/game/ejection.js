// The driver, thrown out through the windscreen.
//
// A wreck hard enough — EJECT_CLOSING — launches a cabbie out of the front of the taxi on the
// impact frame: up and over whatever it hit, windmilling, a bounce or two down the road, and a
// short slide to a sprawl. It is the comic half of the crash. Nothing about the taxi's interior is
// modelled (there is no driver to be seen through the glass at play zoom), so the figure only
// exists from the moment it leaves.
//
// Same rules as game/wreckage.js, and for the same reasons: it is a **closed form** of its own
// age. `fire()` precomputes the whole flight as a short table of ballistic arcs plus one drag
// slide, and `pose()` evaluates it from scratch, so a frame under the crash slow-mo is the same
// shape as a full-speed one, and the replay (game/replay.js) can `seek` it to any moment of the
// impact without having stepped through the ones before. The figure is not on the tape for that
// reason: a node on the tape is interpolated between 30Hz samples, which would cut the tumble's
// corners — at 11 rad/s a sample apart is a third of a turn.
//
// Sized against the wreck camera rather than against physics. The first cut kept the flight to ~8
// units so it fitted a portrait phone's ~14 either side of the impact; that read as a hop, and the
// ask was for more drama. It now goes ~16 at a boost-cruise T-bone, and main.js frames the beat on
// the point halfway between the wreck and `landing()` instead of on the wreck, which keeps both
// within ~8 of the middle of the shot.
//
// **It never lands in a building.** The throw follows the taxi's heading, which mid-turn or beside
// a corner points straight into a block, and the longer throw made that the common case rather
// than the odd one. `fire()` walks the ground track the flight is going to take and, if it meets a
// block (or the edge of the map) before the figure comes to rest, scales every horizontal speed in
// the flight down so that it stops CLEAR short of it. Heights and timings are untouched, so a
// short throw is the same tumble at the same height, just steeper. The track is checked rather
// than only the landing spot because a bounce skids along the ground, and a figure that skids
// through a wall to land in the street beyond is the same bug.

import * as THREE from 'three';
import { createPerson } from '../geometry/person.js';
import { PALETTE } from '../palette.js';
import { TAXI_SCALE } from '../geometry/taxi.js';
import { CAR_LEN } from '../sim/traffic.js';
import {
  GRID_I, GRID_J, HALF_SPAN_X, HALF_SPAN_Z, HALF_ARTERIAL, PITCH, DIR, blockBounds, lineX,
  riverBanks, riverRow, isSegmentClosed,
} from '../city/grid.js';
import { markOccluder } from './ssao.js';

// u/s of closing speed at the wreck. The bands sim/collisions.js prices bumps in: rear-ending a
// car at boost cruise closes at ~10.5, T-boning cross traffic at ~21, a head-on at ~27, anything in
// overdrive 25+. 18 is between the first and the rest, so a rear-end into moving traffic keeps its
// driver and a T-bone, a head-on, a full-boost rear-end into a stopped queue or an overdrive hit
// throws them.
export const EJECT_CLOSING = 18;

// The figure is the riders' rig at this fraction of their size. Riders are deliberately oversized
// (see geometry/person.js) and full size looked like a second passenger rather than the driver;
// at 0.8 it is ~2.7 tall against the drawn taxi's 4.01 length, which still reads as a person.
const SCALE = 0.8;
// Where the middle of the figure sits in its own frame, before SCALE — between the hips (1.15)
// and the shoulders (2.25). The tumble pivots here, not at the feet.
const CENTRE = 1.7;

// Launch. From the windscreen — the front of the cabin, a bit above the roof line — forward at a
// share of the closing speed, and up.
export const START_FWD = (CAR_LEN / 2) * TAXI_SCALE * 0.45;
const START_Y = 2.1;
const FWD_PER_CLOSING = 0.7;
const FWD_MIN = 10;
const FWD_MAX = 18;
const UP = 9;
// Sideways, away from the side the struck car was on, so the figure does not land in its fireball.
const SIDE = 1.1;
// Floatier than real gravity (which at this scale would be ~25 for a 2.7-unit person): the arc is
// the gag, and under the crash slow-mo a real one is over before it reads.
const GRAVITY = 30;

// The ground, as heights of the figure's middle above the road. While tumbling it bounces off
// CONTACT (somewhere between lying and standing — the figure clips a little at a bounce, which at
// this size is a few pixels for a frame); once it has stopped bouncing it settles to LIE.
const CONTACT = 0.55;
const LIE = 0.3;
// Each bounce keeps this much of its vertical and horizontal speed, and of its spin.
const BOUNCE_KEEP = 0.35;
const SKID_KEEP = 0.6;
const SPIN_KEEP = 0.5;
// A bounce slower than this is a landing.
const MIN_BOUNCE = 2.5;
const MAX_BOUNCES = 3;

// Head over heels, rad/s. 11 is a turn and a bit on the first arc.
const SPIN = 11;
// And a little yaw, signed with the sideways throw, over the time in the air.
const TWIST = 1.4;
// The slide: exponential drag, 1/s, and how long it takes to roll flat once it starts.
const SLIDE_DRAG = 5;
// How far short of a block's edge (or the map's) the figure has to come to rest. Lying down it
// reaches ~1.3 from its middle along the heading, and the pavement is part of the block. 1.2 was
// the first number and looked at once: thrown square at the river, the figure's middle stopped in
// the gutter and its head lay across the kerb on the embankment walk. 1.8 keeps all of it in the road.
const CLEAR = 1.8;
const TRACK_STEP = 0.2;
const SETTLE = 0.3;
const HALF_PI = Math.PI / 2;

/**
 * @param scene   the figure is added here once, hidden, so the first ejection has nothing to build
 * @param roadY   road surface height
 * @param onLand  (x, z, hardness 0..1) — each time the figure hits the road: a puff, a thud
 */
export function createEjection(scene, { roadY = 0, onLand = null } = {}) {
  const person = createPerson({
    body: PALETTE.driverShirt, hat: PALETTE.driverCap, pickable: null,
  });
  // root: position on the road and facing. pivot: the tumble, about the middle of the body.
  const root = new THREE.Group();
  const pivot = new THREE.Group();
  root.scale.setScalar(SCALE);
  const holder = new THREE.Group();
  holder.position.y = -CENTRE;
  holder.add(person.group);
  pivot.add(holder);
  root.add(pivot);
  root.visible = false;
  scene.add(root);
  markOccluder(root);

  // The flight. Null until `fire()`.
  let flight = null;
  let age = 0;
  let landed = 0;   // how many of the landings `update` has already announced

  /**
   * Throw the driver. `yaw` is the taxi's sim heading (forward is (cos, −sin)); `side` is ±1, the
   * side of the taxi's line the struck car was on — the figure goes the other way.
   */
  function fire({ x, z, yaw, closing, side = 1 }) {
    const fx = Math.cos(yaw);
    const fz = -Math.sin(yaw);
    // Right-hand side of the heading, on the ground plane.
    const rx = -fz;
    const rz = fx;
    const fwd = Math.min(FWD_MAX, Math.max(FWD_MIN, closing * FWD_PER_CLOSING));
    const x0 = x + fx * START_FWD;
    const z0 = z + fz * START_FWD;
    const lateral = -side * SIDE / fwd;    // sideways units per unit travelled forward

    // The flight at full strength, then again at whatever share of it the street has room for.
    // Every horizontal distance in it is linear in `fwd`, so one rescale moves the whole thing.
    const full = plan(fwd);
    const room = roomAlong(x0, z0, fx, fz, rx, rz, lateral, full.reach);
    const scale = room < full.reach ? room / full.reach : 1;
    const { arcs, t, s, vh, theta } = scale < 1 ? plan(fwd * scale) : full;
    // Lands on its front or its back, whichever the tumble is nearer: π/2 is face down for a
    // figure facing +Z, and every half turn past it alternates.
    const rest = HALF_PI + Math.round((theta - HALF_PI) / Math.PI) * Math.PI;
    flight = {
      x: x0, z: z0,
      fx, fz, rx, rz, lateral,
      face: Math.atan2(fx, fz),
      twist: -side * TWIST,
      arcs,
      air: t,
      slide: { s0: s, vh, theta0: theta, rest },
      scale,
    };
    age = 0;
    landed = 0;
    root.visible = true;
    pose(0);
  }

  /** The ballistic arcs and the slide, for a throw at `fwd` u/s; `reach` is where it comes to rest. */
  function plan(fwd) {
    const arcs = [];
    let t = 0;
    let s = 0;
    let y = START_Y;
    let vy = UP;
    let vh = fwd;
    let spin = SPIN;
    let theta = 0;
    for (let n = 0; n <= MAX_BOUNCES; n++) {
      // Time to come down to CONTACT from `y` at `vy`: the later root of y + vy·τ − g/2·τ² = CONTACT.
      const dur = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * (y - CONTACT))) / GRAVITY;
      arcs.push({ t0: t, s0: s, y0: y, vy, vh, theta0: theta, spin, dur });
      t += dur;
      s += vh * dur;
      theta += spin * dur;
      vy = (GRAVITY * dur - vy) * BOUNCE_KEEP;
      vh *= SKID_KEEP;
      spin *= SPIN_KEEP;
      y = CONTACT;
      if (vy < MIN_BOUNCE) break;
    }
    return { arcs, t, s, vh, theta, reach: s + vh / SLIDE_DRAG };
  }

  /**
   * How far along the ground track the figure can go before it meets a block or the map's edge,
   * less CLEAR — capped at `reach`, and never negative (a throw that starts against a wall drops on
   * the spot). Blocks are read at fire time rather than built once, because their edges depend on
   * which lines are arterials and the layout installs those after this module is constructed.
   */
  function roomAlong(x0, z0, fx, fz, rx, rz, lateral, reach) {
    const blocks = [];
    for (let bi = 0; bi < GRID_I; bi++) {
      for (let bj = 0; bj < GRID_J; bj++) blocks.push(blockBounds(bi, bj));
    }
    const edgeX = HALF_SPAN_X + HALF_ARTERIAL;
    const edgeZ = HALF_SPAN_Z + HALF_ARTERIAL;
    // The river row's blocks are water and are in `blocks` already. What is left of the row is the
    // gap at each street line, and only some of those carry a bridge: the rest are open channel.
    const banks = riverBanks();
    const overWater = (px, pz) => {
      if (!banks || pz <= banks.z0 || pz >= banks.z1) return false;
      const i = Math.round((px + HALF_SPAN_X) / PITCH);
      return isSegmentClosed(i, riverRow(), DIR.PZ) || Math.abs(px - lineX(i)) > HALF_ARTERIAL;
    };
    const blocked = (px, pz) => Math.abs(px) > edgeX || Math.abs(pz) > edgeZ
      || blocks.some((b) => px > b.x0 && px < b.x1 && pz > b.z0 && pz < b.z1)
      || overWater(px, pz);
    for (let s = 0; s <= reach + CLEAR; s += TRACK_STEP) {
      const side = s * lateral;
      if (blocked(x0 + fx * s + rx * side, z0 + fz * s + rz * side)) return Math.max(0, s - CLEAR);
    }
    return reach;
  }

  function pose(at) {
    const f = flight;
    let s;
    let y;
    let theta;
    let limp = 0;
    let arc = null;
    for (const a of f.arcs) if (at >= a.t0) arc = a;
    if (at < f.air) {
      const u = at - arc.t0;
      s = arc.s0 + arc.vh * u;
      y = arc.y0 + arc.vy * u - 0.5 * GRAVITY * u * u;
      theta = arc.theta0 + arc.spin * u;
    } else {
      const u = at - f.air;
      const k = Math.min(1, u / SETTLE);
      const ease = 1 - (1 - k) ** 3;
      s = f.slide.s0 + (f.slide.vh / SLIDE_DRAG) * (1 - Math.exp(-SLIDE_DRAG * u));
      y = CONTACT + (LIE - CONTACT) * ease;
      theta = f.slide.theta0 + (f.slide.rest - f.slide.theta0) * ease;
      limp = ease;
    }
    const side = s * f.lateral;
    root.position.set(
      f.x + f.fx * s + f.rx * side,
      roadY + y,
      f.z + f.fz * s + f.rz * side,
    );
    root.rotation.set(0, f.face + f.twist * Math.min(at, f.air), 0);
    pivot.rotation.set(theta, 0, 0);
    person.tumble(at, limp);
  }

  function update(dt) {
    if (!flight) return;
    age += dt;
    pose(age);
    // Every bounce, and the final landing, once each — off the arc table rather than off the pose,
    // so a frame that steps over a short bounce still announces it.
    const hits = flight.arcs.length;
    while (landed < hits && age >= flight.arcs[landed].t0 + flight.arcs[landed].dur) {
      const a = flight.arcs[landed];
      landed += 1;
      onLand?.(root.position.x, root.position.z, Math.min(1, Math.abs(a.vy - GRAVITY * a.dur) / 12));
    }
  }

  /**
   * The figure as it stood `at` sim seconds after the impact, or at its own age when null — the
   * crash replay scrubs it alongside game/wreckage.js. Before the impact it is hidden. No landing
   * puffs: the dust pool is replayed off its own recording.
   */
  function seek(at = null) {
    if (!flight) return;
    const when = at ?? age;
    root.visible = when >= 0;
    if (when >= 0) pose(when);
  }

  return {
    fire, update, seek,
    active: () => flight !== null,
    /** Where the figure comes to rest, for framing the end of the beat. Null until `fire()`. */
    landing: () => {
      if (!flight) return null;
      const s = flight.slide.s0 + flight.slide.vh / SLIDE_DRAG;
      const side = s * flight.lateral;
      return {
        x: flight.x + flight.fx * s + flight.rx * side,
        z: flight.z + flight.fz * s + flight.rz * side,
      };
    },
    group: root,
    /**
     * The share of a full-strength throw the street had room for (1 down an open road) — so the
     * windscreen's glass (game/windshield.js) is cut short by the same wall the driver was.
     */
    throwScale: () => flight?.scale ?? 1,
    /** For the headless check: the whole flight, from launch to the start of the slide. */
    airTime: () => flight?.air ?? 0,
  };
}
