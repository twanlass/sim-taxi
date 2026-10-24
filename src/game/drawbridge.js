import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial, unlitMaterial } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { cityNetwork } from '../city/roadnet.js';
import { bridgeSpan, drawbridgeLine, WATER_Y, RAIL_W } from '../city/river.js';
import { DIR } from '../city/grid.js';
import { KERB_H } from '../city/ground.js';
import { createBridge, abutmentParts } from '../geometry/bridge.js';
import { setClosedLanes } from '../sim/traffic.js';
import { setBlockedLanes, setStuntLanes } from './route.js';
import { sinkShadowCaster } from './scene.js';
import { markEmissive, setEmissiveScale } from './bloom.js';

// The one span that lifts.
//
// **It is the only thing in this game that changes the road network while the player is driving
// it.** A park district closes a road before the run starts and a roadworks zone only ever makes
// one cheaper; this takes a route that was valid ten seconds ago and stops it existing, with a
// clock running in the back seat. That is the whole point of it, and it is also why every part of
// this module is more careful than a piece of scenery would need to be.
//
// Which span lifts is `planRiver`'s draw, and it is always an interior one — the ring road is what
// everything else in this game escapes onto, and a lift that closed it would take the way round
// away at the same moment it takes the way through.
//
// **The leaf is deliberately not in the city's entrance wave**, and it is worth saying why rather
// than leaving it to look like an oversight. `createCityEntry` grows its meshes in a vertex shader
// that scales every vertex about an anchor stamped into the geometry in *world* coordinates, and a
// world coordinate in a rotating object's local space is not a coordinate — the same reason the
// burger on its pole had to become an `objects` entry. This span is road rather than building, so
// it belongs with the ground either way: the city rises out of a river that is already there,
// bridges and all.

// --- The lift ---------------------------------------------------------------
//
// **70 degrees, and the ceiling is what the leaf hides rather than what a bascule does.** A real one
// opens to about 80; at this camera anything of height `h` hides `1.54h` of ground behind it, and a
// leaf spanning the channel is ~10.7 units long, so its raised tip stands 10.0 units up at 70
// degrees and casts a 15-unit blind spot over the far bank. Past that it starts hiding the road
// beyond, and a marker the player cannot find is exactly what `cornerSeen` exists to prevent —
// except that this one comes and goes, so no static filter can catch it. It is a landmark event
// lasting a dozen seconds, and this is as tall as it gets to stay one.
const LIFT_ANGLE = THREE.MathUtils.degToRad(70);

// **Twice as slow as this shipped at, and the first numbers were the mistake.** 3.4s to raise a
// hundred-odd tonnes of deck is not a bascule, it is a boom gate: the leaf snapped up faster than
// the eye tracks it, which made the one genuinely mechanical thing in the city read as a UI state
// change. Machinery is heavy and the whole point of this is that the player watches it.
//
// The cycle is now ~24 seconds end to end against ~12. That is deliberately a long time to close a
// route for — it is the event, and a route that reopens before you have finished going round is not
// one you had to plan against.
const LIFT_SECONDS = 6.8;
const LOWER_SECONDS = 6.0;    // gravity is on its side going down, and the beat wants to end sooner

// The barriers across each approach, and the beat they take. Down before anything moves, up only
// once the leaf is home — and back up on the same curve, which is the half this originally missed.
const BARRIER_SECONDS = 2.2;
const BARRIER_DROP = THREE.MathUtils.degToRad(88);
const BARRIER_R = 0.16;
const BARRIER_POST_H = 1.5;
// How far back from the abutment the barrier stands. Clear of the deck itself, so a car stopped at
// it is on the road rather than on the bridge, and clear of the footway so it does not fence the
// pavement off with the carriageway.
const BARRIER_SETBACK = 1.6;
// The arms' stripes: how wide each one is along the arm, and the slope of its edge. 0.7 is about
// five pixels at play zoom, the narrowest a stripe stays a stripe rather than a grey blur.
const STRIPE_W = 0.7;
const STRIPE_SLANT = 1;

// The warning lamps: two on each arm, one near either end, flashing alternately the way a level
// crossing's do. They run for the whole time the span is anything but open — from the first frame
// of `clearing`, so they are the warning for however long the deck takes to empty, then through
// the `BARRIER_SECONDS` of the arms coming down and the whole lift — and carry on for `LAMP_TAIL` after the arms are back up, so the last thing
// the player sees of the cycle is the warning going out rather than the gate arriving.
//
// One flash a second per lamp, which is a real crossing's rate (45-65 a minute) at the top end:
// slower than that and at play zoom a lamp spends long enough dark to read as switched off.
const LAMP_PERIOD = 1.0;
const LAMP_TAIL = 1.0;
// Where along the arm the two sit, as fractions of its length: in from each end by enough that the
// lamp's own width stays on the bar.
const LAMP_AT = [0.1, 0.9];
// Sized against the camera rather than the bar: at play zoom one unit is ~7.7px, so this is a
// three-pixel lamp before the bloom spreads it, which is about what a brake pod is.
const LAMP_R = 0.24;
const LAMP_H = 0.2;

/**
 * A backstop, not a hold. Whatever asked for the lift is what puts it down again — `release()` —
 * and this only exists so that a caller which forgets can never shut a route for the rest of the
 * run.
 *
 * **It has to be longer than the thing it is backing up, or it becomes the thing.** A tug asks 30
 * units out and lets go `TUG_LEN + 4` past the span, which at 3.4 u/s is 11.3 seconds of request —
 * about 6.8 of it after the leaf is fully up, and more when the deck took a while to clear. At 4.5
 * this fired first and started lowering the leaf onto a boat that was still four seconds short of
 * it, which looked exactly like the bridge closing early because that is what it was.
 */
const HOLD_SECONDS = 20;

// --- The jump ------------------------------------------------------------------
//
// Tyler, 2026-10-24: "what if our drawbridge split in the middle and opened up from both sides,
// kind of creating a ramp, and then that turned into a stunt route ... super max air". So the span
// is a **double-leaf** bascule now, each half hinged at its own bank, and while the two halves are
// on their way up the near one is a ramp: the taxi waits at the gate, Loco sends it up the leaf, over
// the gap and the far junction, and down in the street beyond (`hopKind: 'bridge'`, sim/traffic.js).
// `?bridgejump=classic` keeps the single leaf and the old re-route.
//
// **The window is a slice of the lift, not the leaf fully up.** At 70 degrees each half is a wall.
// Below `STUNT_FROM` it is barely off the seat and the takeoff reads as a car leaving a flat road;
// past `STUNT_TO` the ramp is steeper than anything a car could drive up. On the smoothstepped lift
// those are 1.4s and 4.1s into it: about 2.7 seconds of jump per cycle, which is the whole skill.
const STUNT_FROM = THREE.MathUtils.degToRad(8);
const STUNT_TO = THREE.MathUtils.degToRad(45);
// How long a gate arm the taxi went through stays knocked up before it drops back.
const ARM_KNOCK_SECONDS = 1.6;

/**
 * The cycle.
 *
 *   open -> clearing -> closing -> lifting -> up -> lowering -> raising -> open
 *
 * `clearing` is what makes this safe, and it has **no timeout**. The lamps are flashing and the
 * lanes already shut, so nothing new can get onto the deck; what is on it drives off, and only
 * then do the arms come down. If the deck will not clear — a car queued behind a red at the far
 * junction, or a player sitting on the crest with the brake held — the boat waits. A lift that
 * fired anyway would be the one event in this game that can throw a car into the river, and "it
 * hardly ever happens" is not a property worth having.
 *
 * **It clears *before* the arms drop, not after.** It used to run closing -> clearing: arms down
 * first, then wait for the deck. Both arms span the whole carriageway, so every car still on the
 * span drove out through the far arm, and one that had committed to the turn onto it drove in
 * under the near one — reported as "cars drive through the arms / are on the bridge when both arms
 * come down". Measured over 20 cities, 300s each with a lift every 30s: 141 of 200 cycles dropped
 * the arms on an occupied deck, and 204 cars crossed an arm line with the arm more than a quarter
 * down. Clearing with the arms up and the lamps already going is how a level crossing does it
 * anyway: the warning comes first, the boom only once the box is empty.
 */
const PHASES = ['open', 'clearing', 'closing', 'lifting', 'up', 'lowering', 'raising'];

/**
 * The phases in which nothing may cross.
 *
 * `raising` is not one of them, and that is the point of it existing. The deck is down and the road
 * is a road again; the gates are still on their way up, and traffic starts moving under them
 * exactly as it does at a level crossing. Reopening only once the arms were vertical would hold the
 * span shut for two seconds after there was anything to hold it shut for.
 */
const SHUT = new Set(['clearing', 'closing', 'lifting', 'up', 'lowering']);

/**
 * A gate arm in diagonal black and white, built rather than painted.
 *
 * Each stripe is its own box **sheared** along the arm by `x += k(y + z)`, so its edges run at 45
 * degrees across both the top face and the side face — the two this camera sees. A shear has a
 * determinant of 1, so it cannot reverse a triangle's winding (see the trap list in CLAUDE.md about
 * hand-built faces). The two end stripes are then clamped back to the arm's ends, so the tip is
 * square rather than a parallelogram. That clamp is only safe while a stripe is wider than the
 * shear's whole reach (`2·k·R` either way), or a clamped corner would cross its neighbour and turn
 * a face inside out — `STRIPE_W` is 0.7 against a reach of 0.32.
 */
function stripedBar(len, dark, light) {
  const n = Math.max(2, Math.round(len / STRIPE_W));
  const w = len / n;
  const parts = [];
  for (let i = 0; i < n; i++) {
    const box = new THREE.BoxGeometry(w, BARRIER_R * 2, BARRIER_R * 2);
    box.translate(w * (i + 0.5), 0, 0);
    const pos = box.attributes.position;
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v) + STRIPE_SLANT * (pos.getY(v) + pos.getZ(v));
      pos.setX(v, Math.min(len, Math.max(0, x)));
    }
    parts.push(bakeColor(box, i % 2 === 0 ? dark : light));
  }
  const bar = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  bar.computeVertexNormals();
  return bar;
}

export function createDrawbridge(scene, rng, { replan = null, onLand = null, wet = (mesh) => mesh, stunt = true } = {}) {
  const line = drawbridgeLine();
  if (line === null) return null;
  const span = bridgeSpan(line);
  if (!span) return null;

  const net = cityNetwork();
  // Both directions of the crossing. `laneByGrid` names a lane by the junction it runs *to*, so the
  // northbound one arrives at the far side of the row and the southbound one at the near side.
  const laneIds = [
    net.laneByGrid(DIR.PZ, line, span.row + 1)?.id,
    net.laneByGrid(DIR.NZ, line, span.row)?.id,
  ].filter(Boolean);
  if (laneIds.length !== 2) return null;

  const group = new THREE.Group();
  group.name = 'drawbridge';

  // --- The deck.
  //
  // Classic: one leaf hinged on the near bank, so it covers the whole channel and rises away from
  // the camera — this view looks down the -x-z diagonal, so a leaf hinged at the *far* bank would
  // come up between the player and the water it is opening, and hide the boat it opened for.
  //
  // Split (the default since the jump): two half-leaves meeting in the middle, each hinged at its
  // own bank. The camera-side one does now stand between the player and the channel, but at half
  // the length it stands half as tall (~7 against 10 at 70 degrees), so it hides less of the water
  // than the one long leaf hid of the far bank — and the boat goes through the gap between them.
  const length = span.z1 - span.z0;
  const split = stunt;
  const leaves = [];
  const pivots = [];
  const halves = split ? [[0, 0.5, 0, span.z0], [0.5, 1, length, span.z1]] : [[0, 1, 0, span.z0]];
  for (const [from, to, pivotZ, hingeZ] of halves) {
    // Split, each leaf's tip is a free end and gets a cap like the span's ends (geometry/bridge.js).
    const geo = createBridge(span, rng, { range: [from, to], abutments: false, pivotZ, capCut: split });
    const leaf = new THREE.Mesh(geo, propMaterial());
    leaf.castShadow = true;
    leaf.receiveShadow = true;
    // Same shell as a fixed span — flat rather than arched, and it self-shadowed just the same, in
    // a band down the carriageway. See `sinkShadowCaster` (game/scene.js).
    sinkShadowCaster(leaf);
    // Wet in the rain like the road it carries (`wetGround` in game/rain.js). Flat, so it needs no
    // deck profile: lowered, its carriageway is at road level; raised, it is a wall, and the
    // shader's own slope test dries it.
    wet(leaf);
    leaf.name = 'drawbridge-leaf';
    // The pivot carries the leaf; the leaf's own geometry is built with its hinge on the origin.
    const pivot = new THREE.Group();
    pivot.position.set(span.cx, 0, hingeZ);
    pivot.add(leaf);
    group.add(pivot);
    leaves.push(leaf);
    pivots.push(pivot);
  }
  const leaf = leaves[0];
  // How far each leaf reaches from its hinge: the ramp the taxi drives up.
  const leafLen = length / leaves.length;

  // The abutments and the machinery house stay where they are, whatever the leaf is doing.
  const staticParts = [];
  const trimCol = jitterColor(PALETTE.bridgeTrim, rng, { l: 0.02 });
  const houseCol = jitterColor(PALETTE.riverWall, rng, { l: 0.02 });
  // The abutments straight from the bridge kit rather than through a hair-thin `range`, which would
  // hand back a fan of degenerate triangles rather than the two blocks that were wanted.
  for (const end of [0, 1]) {
    for (const part of abutmentParts(span, rng, end)) {
      part.translate(span.cx, 0, span.z0);
      staticParts.push(part);
    }
  }

  // The counterweight house on the hinge bank: the thing a bascule needs, and the thing that says
  // *this* span is the one that moves before it has ever moved. One either side of the deck, clear
  // of the leaf's swing.
  // Split, each bank hinges a leaf and gets a pair of its own.
  const houseAt = split ? [[span.z0, -0.4], [span.z1, 0.4]] : [[span.z0, -0.4]];
  for (const [hz, off] of houseAt) {
    for (const sign of [-1, 1]) {
      const house = new THREE.BoxGeometry(1.6, 2.6, 2.2);
      house.translate(span.cx + sign * (span.outer + 0.8), 1.3, hz + off);
      staticParts.push(bakeColor(house, houseCol));
      const cap = new THREE.BoxGeometry(1.9, 0.24, 2.5);
      cap.translate(span.cx + sign * (span.outer + 0.8), 2.6 + 0.12, hz + off);
      staticParts.push(bakeColor(cap, trimCol));
    }
  }

  const shell = new THREE.Mesh(mergeGeometries(staticParts, false), propMaterial());
  staticParts.forEach((p) => p.dispose());
  shell.castShadow = true;
  shell.receiveShadow = true;
  shell.name = 'drawbridge-shell';
  group.add(shell);

  // --- The barriers, one across each approach.
  const barriers = [];
  const lamps = [];
  // A short octagonal drum standing on the bar: its top is the face this camera looks at, and in
  // rain or at night it is the brightest thing on the bridge. Three's own primitive, so its winding
  // is three's and not ours.
  const lampGeo = new THREE.CylinderGeometry(LAMP_R, LAMP_R, LAMP_H, 8);
  const lampOn = new THREE.Color(PALETTE.lightYellow);
  const lampOff = new THREE.Color(PALETTE.gateLampOff);
  for (const end of [0, 1]) {
    const z = end === 0 ? span.z0 - BARRIER_SETBACK : span.z1 + BARRIER_SETBACK;
    const arm = new THREE.Group();
    arm.position.set(span.cx - span.half, BARRIER_POST_H * 0.72, z);
    // Across the whole carriageway rather than one lane of it. A barrier that covered only the
    // approach would be the truthful thing and the unreadable one: at play zoom the road is 62px
    // and half of it is a dash.
    const len = span.half * 2 * 0.92;
    // The one draw this used to take for the arm's orange is kept, on the dark stripe, so every
    // `rng` draw after it lands where it did before the arms were repainted.
    const dark = jitterColor(PALETTE.gateStripeDark, rng, { l: 0.02 });
    const bar = stripedBar(len, dark, new THREE.Color(PALETTE.gateStripeLight));
    const barMesh = new THREE.Mesh(bar, propMaterial());
    barMesh.name = 'drawbridge-arm';
    barMesh.castShadow = true;
    arm.add(barMesh);
    // The lamps ride the arm, so they go down and up with it. Each one its own mesh and its own
    // material — they are switched on the colour, out of step with each other, and a merged pair
    // could only ever be one colour at a time.
    for (const at of LAMP_AT) {
      const lamp = new THREE.Mesh(lampGeo, unlitMaterial({ color: lampOff.clone() }));
      lamp.position.set(len * at, BARRIER_R + LAMP_H / 2, 0);
      lamp.name = 'drawbridge-lamp';
      arm.add(lamp);
      lamps.push(lamp);
    }
    // Raised is out of the way: the arm stands vertical and drops to horizontal across the road.
    arm.rotation.z = BARRIER_DROP;
    group.add(arm);

    const post = new THREE.BoxGeometry(0.28, BARRIER_POST_H, 0.28);
    post.translate(span.cx - span.half, BARRIER_POST_H / 2, z);
    const postMesh = new THREE.Mesh(bakeColor(post, trimCol), propMaterial());
    postMesh.castShadow = true;
    group.add(postMesh);

    barriers.push(arm);
  }

  // Glow in the bloom like every other lamp in the city. Switched off through the per-mesh scale
  // rather than unmarked, because they flash dozens of times a cycle — see `setEmissiveScale`.
  for (const lamp of lamps) markEmissive(lamp, 'pod');

  scene.add(group);

  const state = {
    phase: 'open',
    t: 0,
    lift: 0,        // 0 down, 1 fully raised
    barrier: 0,     // 0 up (out of the way), 1 down across the road
    requested: false,
    flash: -1,      // seconds the warning lamps have been running, or -1 while they are dark
    cycle: 0,       // counts lifts, so a jump the gate let through belongs to one cycle only
    knocked: [-1, -1], // seconds since the taxi went through each arm, or -1
  };

  const smooth = (t) => t * t * (3 - 2 * t);

  /** Is anything at all standing on either lane of the span? The taxi counts. */
  function deckClear(cars) {
    const ids = new Set(laneIds);
    return !cars.some((car) => ids.has(car.lane?.id) || ids.has(car.turn?.outLane));
  }

  const angle = () => state.lift * LIFT_ANGLE;

  /**
   * Can the taxi's router still plan over the span? From the lamps starting until the leaves pass
   * `STUNT_TO`: a route across the river runs on to the gate, and the taxi waits there for the jump.
   */
  const plannable = () => stunt && (state.phase === 'clearing' || state.phase === 'closing'
    || (state.phase === 'lifting' && angle() <= STUNT_TO));
  let wasPlannable = false;

  function publish() {
    // Shut to ambient traffic and impassable to the router the moment the lamps start — before the
    // barriers start down, and well before the leaf moves. `clearing` comes first, and its whole job
    // is to empty a deck that nothing new can enter while the arms are still out of the way.
    const shut = SHUT.has(state.phase);
    setClosedLanes(shut ? laneIds : [], 'drawbridge');
    setBlockedLanes(shut ? laneIds : []);
    wasPlannable = plannable();
    setStuntLanes(wasPlannable ? laneIds : []);
  }

  /**
   * The gate's answer to a taxi whose route goes onto the shut span, asked at its hold line (and on
   * the approach, so it brakes for a hold rather than stopping dead): sim/traffic.js `stuntVerdict`.
   *
   *   'pass'   the lamps are going but the arms are up: cross like a road, the deck waits for you
   *   'hold'   wait at the line: the arms are down, the leaves not up yet, or Loco is not held
   *   'go'     up the near leaf and over
   *   'refuse' too late — the leaves are past a ramp. The route is dropped and re-planned round.
   */
  function gate(car) {
    if (!stunt) return 'refuse';
    switch (state.phase) {
      case 'clearing': return 'pass';
      case 'closing': return 'hold';
      case 'lifting': {
        const a = angle();
        if (a > STUNT_TO) return 'refuse';
        return a >= STUNT_FROM && car.boost ? 'go' : 'hold';
      }
      default: return 'refuse';
    }
  }

  /** Where the leaf the taxi drives up is hinged, for a car on `laneId`. */
  function hingeFor(laneId) {
    const end = laneIds.indexOf(laneId);
    if (end < 0) return null;
    // laneIds[0] runs +z, so it climbs the leaf hinged on the z0 bank.
    return { end, z: end === 0 ? span.z0 : span.z1, dir: end === 0 ? 1 : -1 };
  }

  function enter(phase) {
    state.phase = phase;
    state.t = 0;
    publish();
    // Re-plan on the way in, not on the way out. A taxi whose route crosses this span has to be
    // given a new one while it still has road to turn off on.
    if (phase === 'clearing') {
      state.cycle += 1;
      replan?.();
    }
  }

  function pose() {
    // The near leaf turns about -x to rise toward +z; the far one, hinged at z1, the other way.
    leaves.forEach((one, k) => { one.rotation.x = (k === 0 ? -1 : 1) * state.lift * LIFT_ANGLE; });
    barriers.forEach((arm, k) => {
      // An arm the taxi went through is flung up and comes back down after ARM_KNOCK_SECONDS — the
      // barricade smash, minus the barricade.
      const t = state.knocked[k];
      const knock = t < 0 ? 0 : t < 0.12 ? t / 0.12 : Math.max(0, 1 - (t - ARM_KNOCK_SECONDS) / 0.5);
      arm.rotation.z = BARRIER_DROP * (1 - state.barrier * (1 - knock));
    });
    // Alternating: the first lamp on each arm lights on the first half of the period and the second
    // on the other half, and both arms flash in step so the pair across the road read as one signal.
    // A hard switch rather than a fade, because a fade at this rate spends most of its time at
    // half brightness and reads as a dim lamp rather than a flashing one.
    const phase = state.flash < 0 ? -1 : (state.flash / LAMP_PERIOD) % 1;
    lamps.forEach((lamp, i) => {
      const lit = phase >= 0 && (phase < 0.5) === (i % 2 === 0);
      lamp.material.color.copy(lit ? lampOn : lampOff);
      setEmissiveScale(lamp, lit ? 1 : 0);
    });
  }

  /**
   * The lamps run whenever the span is not plainly open, and for `LAMP_TAIL` after it is. The tail
   * only counts while they are already running, or a fresh city — which starts `open` at t = 0 —
   * would open on a second of warning for a bridge that has never moved.
   */
  function flashing() {
    return state.phase !== 'open' || (state.flash >= 0 && state.t < LAMP_TAIL);
  }

  function update(dt, cars = []) {
    state.t += dt;
    state.knocked = state.knocked.map((t) => (t < 0 || t > ARM_KNOCK_SECONDS + 0.5 ? -1 : t + dt));
    // Counted from the moment they come on, so the first lamp always lights first rather than
    // whichever one the clock happens to land on.
    state.flash = flashing() ? (state.flash < 0 ? 0 : state.flash + dt) : -1;
    switch (state.phase) {
      case 'open':
        state.barrier = 0;
        // No police hold on this any more. It used to wait out a siren running down the line —
        // the patrol cruiser was a scripted car that could not stop for a barrier — and the
        // cruiser is an ordinary car in traffic now (game/patrol.js), which stops for one like
        // anybody else.
        if (state.requested) enter('clearing');
        break;
      case 'clearing':
        state.barrier = 0;
        if (deckClear(cars)) enter('closing');
        break;
      case 'closing':
        state.barrier = Math.min(1, state.t / BARRIER_SECONDS);
        // The deck is checked again before the leaf moves rather than trusted. Nothing should be
        // able to reach it with the lanes shut, but "should" is not what stands between a car and
        // the river.
        if (state.t >= BARRIER_SECONDS && deckClear(cars)) enter('lifting');
        break;
      case 'lifting':
        state.lift = smooth(Math.min(1, state.t / LIFT_SECONDS));
        // The jump window closing is a change to the network as far as the taxi's router is
        // concerned: the span stops being plannable, so a taxi still routed over it — waiting at
        // the gate, or on its way — is given the way round now rather than at the gate.
        if (wasPlannable && !plannable()) {
          publish();
          replan?.();
        }
        if (state.t >= LIFT_SECONDS) enter('up');
        break;
      case 'up':
        state.lift = 1;
        // Down as soon as whatever asked for the lift says it is through, and after `HOLD_SECONDS`
        // regardless — nothing may leave a route shut indefinitely because it forgot to `release`.
        if (!state.requested || state.t >= HOLD_SECONDS) {
          state.requested = false;
          enter('lowering');
        }
        break;
      case 'lowering':
        state.lift = 1 - smooth(Math.min(1, state.t / LOWER_SECONDS));
        if (state.t >= LOWER_SECONDS) {
          state.lift = 0;
          enter('raising');
          // The leaf is home. A hundred tonnes of deck meeting its abutment is the one moment in
          // the cycle with an impact in it, and it was landing in silence — `onLand` is what puts a
          // puff of dust at each end of it (main.js hands it `dust.burst`).
          onLand?.([
            { x: span.cx, z: span.z0 },
            { x: span.cx, z: span.z1 },
          ]);
        }
        break;
      case 'raising':
        // **The gates come back up on their own curve.** They used to snap: `open` set `barrier = 0`
        // on the frame it was entered, so after a full slow lower the arms jumped from flat across
        // the road to vertical in one frame — which at this camera reads as them vanishing and
        // popping back rather than as a gate rising.
        state.barrier = Math.max(0, 1 - state.t / BARRIER_SECONDS);
        if (state.t >= BARRIER_SECONDS) enter('open');
        break;
      default:
        break;
    }
    pose();
  }

  publish();
  pose();

  return {
    group,
    leaf,
    leaves,
    /** The gates' warning lamps, two per arm in arm order. Exposed for tools/probe.mjs. */
    lamps,
    state,
    line,
    span,
    laneIds,
    /**
     * The jump, for sim/traffic.js (`setBridgeStunt`), or null with `?bridgejump=classic`.
     * `angle` is live: the leaf keeps rising under a taxi riding up it.
     */
    stunt: stunt ? {
      laneIds: new Set(laneIds),
      leafLen,
      gate,
      angle,
      hingeFor,
      cycle: () => state.cycle,
      /** The taxi went through the arm at the bank it entered from. */
      knock(laneId) {
        const h = hingeFor(laneId);
        if (h) state.knocked[h.end] = 0;
      },
    } : null,
    /** Ask for the leaf. Idempotent while a cycle is already running. */
    request() { state.requested = true; },
    /** The boat is through; come back down. */
    release() { state.requested = false; },
    /** True while nothing may cross — the router's answer, not the leaf's angle. */
    get closed() { return SHUT.has(state.phase); },
    update,
    /** Shot mode ticks the world once and freezes it. See `settle` in game/fares.js. */
    settle() { pose(); },
    dispose() {
      setClosedLanes([], 'drawbridge');
      setBlockedLanes([]);
      setStuntLanes([]);
    },
  };
}

/**
 * How long from `request()` to a fully raised leaf, with an empty deck.
 *
 * Exported so `game/boats.js` can work out how far out a tug has to ask rather than carrying a
 * number copied from here — the two are one decision, and halving the lift speed without moving the
 * asking distance is exactly how a tug ends up nosing into a bridge that is still grinding upward.
 */
export const OPEN_SECONDS = BARRIER_SECONDS + LIFT_SECONDS;

export { PHASES, LIFT_ANGLE, STUNT_FROM, STUNT_TO, WATER_Y, KERB_H, RAIL_W };
