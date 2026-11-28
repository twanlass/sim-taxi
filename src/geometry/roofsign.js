// The taxi's roof sign: a topper that pops up out of the roof with a forward flip when it lights,
// bobs and pulses on its mount while it is lit, and fades away when it goes out.
//
// **What it says.** Lit while the taxi is free, the way a real cab's roof light works (the sign is
// the cab advertising itself to the street), and *gone* while a rider is aboard. There is no off
// state to look at. The sign this replaces had one — dark with no rider — and it came off at the
// workshop bench for being a dark lump on the yellow roof for most of every run; a grey and then a
// near-black lens were both tried here (2026-11-27) and both fought the roof's chequer, which reads
// well from the sky and stays. So off is the plain chequered roof. Lit, the lens is the chequer's own
// white (`taxiSign`), so the sign reads as part of the livery standing up off the roof — a warm cream
// and then an orange were tried first and both sat oddly against the yellow — and what says "lamp"
// rather than "paint" is the glow pulsing (`PULSE_*`), bloom and all. `SIGN_LIT_WHEN_FREE` flips the
// meaning back in one line.
//
// **How it moves.** Everything is a transform on two nested groups plus one opacity, so no geometry
// is added and nothing is rebuilt per frame:
//
//   anchor  on the roof, at the sign's footprint centre — never moves
//   pop     the rise off the roof, the lean and the squash/stretch scale
//   parts   the trim base and the lens, centred on the pop's origin
//
// The squash keeps the sign standing on its *base*: the pop's height is recomputed off the current
// Y scale every frame (`HALF_H * sy`) rather than scaled about a pivot.
//
// The two materials are `transparent` for the whole life of the car, at opacity 1 almost all of it,
// rather than flipped on for the fade: three bakes the opaque/transparent choice into the compiled
// program, so a flip links a second program on the first fade, which is a stall at exactly the frame
// the player is watching (the drop-off). One program, always.
//
// **Sized against the camera.** At play zoom a world unit is ~7.7px and the taxi carries
// `TAXI_SCALE` 1.18, so the sign is ~8px long and ~3px tall. That is why the idle bob is in the
// *scale* rather than the height — a 0.03 rise is a fifth of a pixel and reads as nothing, while a
// 5% squash on something this squat reads as the sign breathing — and why the pop-in overshoots as
// far as it does.
import * as THREE from 'three';
import { bakeColor } from '../util/geo.js';
import { color } from '../palette.js';
import { addGhostOutline, addGhostMask } from './ghostoutline.js';

/** `?roofsign=classic` leaves the car without a sign, as it was before this file. */
export const ROOF_SIGN = typeof location === 'undefined'
  || new URLSearchParams(location.search).get('roofsign') !== 'classic';

/** Lit when free (a real cab). False puts back the old reading: lit with a rider aboard. */
export const SIGN_LIT_WHEN_FREE = true;

// The topper, in car-local units before TAXI_SCALE. Long along the car and narrow across it, so it
// runs parallel to the body and the roof's chequer (Tyler, 2026-11-27: across the roof like a real
// cab's, it read as a crossbar).
const SIGN_ALONG = 0.9;
const SIGN_ACROSS = 0.34;
const BASE_H = 0.06;
const LENS_H = 0.24;
const SIGN_H = BASE_H + LENS_H;
const HALF_H = SIGN_H / 2;
// The lens's top is pulled in this much each way across the car: a wedge, not a brick.
const LENS_TAPER = 0.07;
// Stands this clear of the roof (and the chequer plates on it), so the base's underside is not
// coplanar with either.
const ROOF_CLEAR = 0.02;
/** The lens's glow, before the bloom, pulsing between these at PULSE_HZ: never fully off, so it
 *  always reads as lit, and never so hot the bloom turns it into a white blob (the first cut held
 *  0.45 steady and did). The bloom reads emissiveIntensity, so it pulses with the lens. */
const PULSE_LOW = 0.12;
// Raised from 0.5 after Tyler saw it on the phone (2026-11-27): the pulse read as too subtle.
const PULSE_HIGH = 0.85;
const PULSE_HZ = 1.1;

// --- The idle ------------------------------------------------------------------------------------
/** Breathing: Y scale ±this, at BOB_HZ. Volume-preserving, so the sign fattens as it squats. */
const BOB_AMP = 0.05;
const BOB_HZ = 1.5;
/** The jelly spring the pop-in's landing and the car's own speed changes ring. */
const SPRING_K = 260;
const SPRING_DAMP = 11;
/** Squash per (u/s²) of the taxi's acceleration, either sign — a hard brake or a boost both jolt it. */
const ACCEL_SQUASH = 0.0035;
/** Lean per (u/s²): back under acceleration, forward under braking, about the car's lateral axis. */
const ACCEL_LEAN = 0.006;
const LEAN_MAX = 0.2;
const SQUASH_MAX = 0.3;

// --- Lighting up: out of the roof tall and thin, one forward flip in the air, down into a squash ----
const POP_IN = 0.5;
/** How tall and thin it is leaving the roof, and how high the arc peaks (~10px at play zoom). */
const POP_STRETCH = 0.55;
const POP_RISE = 1.1;
/** What the landing hands the spring: a squash that rings out over ~0.4s. */
const LAND_SQUASH = 0.4;

// --- Going out: a puff — it swells a touch, lifts and fades -----------------------------------------
const FADE_OUT = 0.32;
const FADE_SWELL = 0.18;
const FADE_RISE = 0.25;

const easeOut = (u) => 1 - (1 - u) * (1 - u);

function lensGeometry() {
  // A box with its top four corners pulled in across the car (z): the wedge of a topper. Non-indexed
  // through bakeColor, so every face keeps its own flat normal after the taper.
  const g = new THREE.BoxGeometry(SIGN_ALONG, LENS_H, SIGN_ACROSS);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) pos.setZ(i, pos.getZ(i) - Math.sign(pos.getZ(i)) * LENS_TAPER);
  }
  g.computeVertexNormals();
  g.translate(0, -HALF_H + BASE_H + LENS_H / 2, 0);
  return bakeColor(g, color('taxiSign'));
}

function baseGeometry() {
  // The trim the lens sits in, a hair longer each way so it reads as a mount, not a stripe.
  const g = new THREE.BoxGeometry(SIGN_ALONG + 0.04, BASE_H, SIGN_ACROSS + 0.04);
  g.translate(0, -HALF_H + BASE_H / 2, 0);
  return bakeColor(g, color('taxiTrim'));
}

/**
 * Build the sign at `(x, y)` in car-local space — `y` the roof's top face.
 * Returns `{ anchor, parts, lamp, setOccupied, update, settle, douse, state }`.
 */
export function createRoofSign({ x, y }) {
  const anchor = new THREE.Group();
  anchor.name = 'roofSign';
  anchor.position.set(x, y + ROOF_CLEAR, 0);
  const pop = new THREE.Group();
  anchor.add(pop);

  // Plain Lambert rather than `propMaterial()`, for the lens because its bloom copy then shares the
  // one program every other lamp draws with (`signLamp`, marked from main.js), and for the base so the
  // two fade on the same terms.
  const base = new THREE.Mesh(baseGeometry(), new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true, transparent: true,
  }));
  // Lit from inside, so the whole lens glows its own colour rather than catching a white shine.
  const lamp = new THREE.Mesh(lensGeometry(), new THREE.MeshLambertMaterial({
    color: color('taxiSign'), emissive: color('taxiSign'), emissiveIntensity: PULSE_LOW,
    flatShading: true, transparent: true,
  }));
  lamp.userData.bloomKind = 'window';
  const parts = [base, lamp];
  for (const part of parts) {
    part.castShadow = true;
    part.receiveShadow = true;
    pop.add(part);
  }
  // Every opaque part of the taxi is in the ghost mask, or it occludes the shell's rim (taxi.js).
  addGhostMask(base);
  addGhostOutline(lamp, { rim: 0.1 });

  const state = {
    want: SIGN_LIT_WHEN_FREE,  // lit or not, once any transition lands
    phase: null,               // 'in' | 'out' | null
    phaseT: 0,
    t: 0,
    squash: 0, squashV: 0,     // the spring, as Y scale − 1
    lean: 0,
    lastSpeed: null,
  };

  const setOpacity = (a) => { for (const part of parts) part.material.opacity = a; };
  const setShown = (on) => { pop.visible = on; for (const part of parts) part.visible = on; };
  setShown(state.want);

  function begin(phase) {
    state.phase = phase;
    state.phaseT = 0;
    if (phase === 'in') { setShown(true); setOpacity(1); state.squash = state.squashV = 0; }
  }

  function setOccupied(occupied, instant = false) {
    const want = SIGN_LIT_WHEN_FREE ? !occupied : Boolean(occupied);
    const was = state.want;
    state.want = want;
    if (instant) {
      state.phase = null;
      state.squash = state.squashV = 0;
      setOpacity(1);
      setShown(want);
      pose();
      return;
    }
    if (want !== was) begin(want ? 'in' : 'out');
  }

  /** Write the transforms for the current state. */
  function pose() {
    let sy = 1 + state.squash + BOB_AMP * Math.sin(state.t * Math.PI * 2 * BOB_HZ);
    let sxzMul = 1;
    let rise = 0;
    let flip = 0;
    if (state.phase === 'in') {
      const u = Math.min(1, state.phaseT / POP_IN);
      // Full size by a third of the way up, so the flip is of the whole sign, not of a speck.
      const grow = easeOut(Math.min(1, u * 3));
      // Stretched along its travel at both ends of the arc, round at the top.
      const stretch = 1 + POP_STRETCH * Math.abs(1 - 2 * u);
      sy = grow * stretch;
      sxzMul = grow / Math.sqrt(stretch);
      rise = POP_RISE * 4 * u * (1 - u);
      // One forward flip — negative about local Z is nose over, the taxi's own bridge flip's sign —
      // eased so it hangs at the top of the arc.
      flip = -Math.PI * 2 * u * u * (3 - 2 * u);
    } else if (state.phase === 'out') {
      const u = Math.min(1, state.phaseT / FADE_OUT);
      sxzMul = 1 + FADE_SWELL * easeOut(u);
      sy *= 1 + FADE_SWELL * 0.5 * easeOut(u);
      rise = FADE_RISE * easeOut(u);
      setOpacity(1 - u * u);
    }
    sy = Math.max(0.001, sy);
    const sxz = (state.phase === 'in' ? sxzMul : sxzMul / Math.sqrt(Math.max(0.5, sy)));
    pop.scale.set(Math.max(0.001, sxz), sy, Math.max(0.001, sxz));
    pop.position.y = HALF_H * sy + rise;
    pop.rotation.set(0, 0, flip + state.lean);
    lamp.material.emissiveIntensity = PULSE_LOW
      + (PULSE_HIGH - PULSE_LOW) * (0.5 + 0.5 * Math.sin(state.t * Math.PI * 2 * PULSE_HZ));
  }

  function update(dt, speed = 0) {
    if (!(dt > 0)) return;
    state.t += dt;

    // The car's own speed changes ring the spring and lean the sign, so it feels mounted rather
    // than painted on. Clamped: a crash's one-frame stop is hundreds of u/s².
    const accel = state.lastSpeed === null ? 0 : (speed - state.lastSpeed) / dt;
    state.lastSpeed = speed;
    const leanTo = THREE.MathUtils.clamp(accel * ACCEL_LEAN, -LEAN_MAX, LEAN_MAX);
    state.lean += (leanTo - state.lean) * Math.min(1, dt * 8);
    const kick = THREE.MathUtils.clamp(-Math.abs(accel) * ACCEL_SQUASH, -SQUASH_MAX, 0);

    if (state.phase) {
      state.phaseT += dt;
      if (state.phase === 'in' && state.phaseT >= POP_IN) {
        state.phase = null;
        state.squash = -LAND_SQUASH;
        state.squashV = 0;
      } else if (state.phase === 'out' && state.phaseT >= FADE_OUT) {
        state.phase = null;
        setShown(false);
        setOpacity(1);
      }
    }
    if (!state.phase && pop.visible) {
      // Semi-implicit Euler, substepped so a 30fps frame cannot blow the spring up.
      const steps = Math.ceil(dt / (1 / 120));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        state.squashV += (-SPRING_K * (state.squash - kick) - SPRING_DAMP * state.squashV) * h;
        state.squash += state.squashV * h;
      }
    }
    if (pop.visible) pose();
  }

  /** Put it out where it is, mid-pop or not — a wreck (sim/traffic.js, beside its pods). */
  function douse() {
    state.phase = null;
    state.want = false;
    setShown(false);
    setOpacity(1);
  }

  /** Land any transition at once: shot mode ticks the fare loop once and freezes. */
  function settle() {
    state.phase = null;
    state.squash = state.squashV = 0;
    setOpacity(1);
    setShown(state.want);
    pose();
  }

  pose();
  return { anchor, parts, lamp, setOccupied, update, settle, douse, state };
}
