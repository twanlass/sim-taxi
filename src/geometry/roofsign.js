// The taxi's roof sign: a lit topper that bobs on its mount, and hops off the roof with a flip to
// change state.
//
// **What it says.** Lit while the taxi is free, off while a rider is aboard, the way a real cab's
// roof light works (the sign is the cab advertising itself to the street). The sign this replaces
// ran the other way round — lit with a rider aboard — and it came off at the workshop bench for being
// a dark lump on the yellow roof for most of every run. Two things are different now: off is a
// grey lens (`taxiSignDark`) rather than a near-black one, and the change between the two is an
// event the player sees, which is what earns the part its place on the car. `SIGN_LIT_WHEN_FREE`
// flips the meaning back in one line if the old reading plays better.
//
// **How it moves.** Everything is a transform on three nested groups, so no geometry is added and
// nothing is rebuilt per frame:
//
//   anchor  on the roof, at the sign's footprint centre — never moves
//   hop     carries the height off the roof, the flip, and the squash/stretch scale
//   parts   the trim base and the two lenses, centred on the hop's origin
//
// The flip turns about the sign's *middle* (a box somersaulting about its base swings through the
// roof), and the squash has to keep the sign standing on its *base* — so the hop's height is
// recomputed off the current Y scale every frame (`HALF_H * sy`) rather than scaled about a pivot.
//
// **Sized against the camera.** At play zoom a world unit is ~7.7px and the taxi carries
// `TAXI_SCALE` 1.18, so the sign is ~8px across and ~3px tall. That is why the idle bob is in the
// *scale* rather than the height — a 0.03 rise is a fifth of a pixel and reads as nothing, while a
// 5% squash on something this squat reads as the sign breathing — and why the hop goes as high as
// it does: `HOP_H` 1.1 is ~10px of air, enough to see the sign leave the car at play zoom without it
// crossing the yellow taxi marker overhead.
import * as THREE from 'three';
import { bakeColor, propMaterial } from '../util/geo.js';
import { color } from '../palette.js';
import { addGhostOutline, addGhostMask } from './ghostoutline.js';

/** `?roofsign=classic` leaves the car without a sign, as it was before this file. */
export const ROOF_SIGN = typeof location === 'undefined'
  || new URLSearchParams(location.search).get('roofsign') !== 'classic';

/** Lit when free (a real cab). False puts back the old reading: lit with a rider aboard. */
export const SIGN_LIT_WHEN_FREE = true;

// The topper, in car-local units before TAXI_SCALE. Wide across the car and short along it, like a
// real one — side-on from this camera the long face is what shows.
export const SIGN_ACROSS = 0.9;
export const SIGN_ALONG = 0.34;
const BASE_H = 0.06;
const LENS_H = 0.24;
export const SIGN_H = BASE_H + LENS_H;
const HALF_H = SIGN_H / 2;
// The lens's top is pulled in this much each way along the car: a wedge, not a brick.
const LENS_TAPER = 0.07;
// Stands this clear of the roof, so the base's underside is not coplanar with the roof's top.
const ROOF_CLEAR = 0.01;
/** The lit lens's own glow, before the bloom: enough to read as a lamp in the sun, not a white blob. */
const SIGN_GLOW = 0.45;

// --- The idle ------------------------------------------------------------------------------------
/** Breathing: Y scale ±this, at BOB_HZ. Volume-preserving, so the sign fattens as it squats. */
const BOB_AMP = 0.05;
const BOB_HZ = 1.5;
/** The jelly spring the hop's landing and the car's own speed changes ring. */
const SPRING_K = 260;
const SPRING_DAMP = 11;
/** Squash per (u/s²) of the taxi's acceleration, either sign — a hard brake or a boost both jolt it. */
const ACCEL_SQUASH = 0.0035;
/** Lean per (u/s²): back under acceleration, forward under braking, about the car's lateral axis. */
const ACCEL_LEAN = 0.006;
const LEAN_MAX = 0.2;
const SQUASH_MAX = 0.3;

// --- The hop -------------------------------------------------------------------------------------
/** Crouch before take-off. */
const HOP_CROUCH = 0.09;
/** In the air: up, one full forward flip, down. */
const HOP_AIR = 0.46;
const HOP_H = 1.1;
/** The crouch's depth, and the stretch at take-off and touchdown. */
const CROUCH_SQUASH = 0.32;
const AIR_STRETCH = 0.28;
/** What the landing hands the spring: a squash that rings out over ~0.4s. */
const LAND_SQUASH = 0.38;

const easeInOut = (u) => u * u * (3 - 2 * u);

function lensGeometry(paint) {
  // A box with its top four corners pulled in along x: the wedge of a topper. Non-indexed through
  // bakeColor, so every face keeps its own flat normal after the taper.
  const g = new THREE.BoxGeometry(SIGN_ALONG, LENS_H, SIGN_ACROSS);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) > 0) pos.setX(i, pos.getX(i) - Math.sign(pos.getX(i)) * LENS_TAPER);
  }
  g.computeVertexNormals();
  g.translate(0, -HALF_H + BASE_H + LENS_H / 2, 0);
  return bakeColor(g, color(paint));
}

function baseGeometry() {
  // The trim the lens sits in, a hair longer each way so it reads as a mount, not a stripe.
  const g = new THREE.BoxGeometry(SIGN_ALONG + 0.04, BASE_H, SIGN_ACROSS + 0.04);
  g.translate(0, -HALF_H + BASE_H / 2, 0);
  return bakeColor(g, color('taxiTrim'));
}

/**
 * Build the sign at `(x, y)` in car-local space — `y` the roof's top face.
 * Returns `{ anchor, parts, lamp, setOccupied, update, settle, state }`.
 */
export function createRoofSign({ x, y }) {
  const anchor = new THREE.Group();
  anchor.name = 'roofSign';
  anchor.position.set(x, y + ROOF_CLEAR, 0);
  const hop = new THREE.Group();
  anchor.add(hop);

  const base = new THREE.Mesh(baseGeometry(), propMaterial());
  // Lit from inside, so the whole lens glows its own colour rather than catching a white shine —
  // the same plain emissive Lambert the brake pods are (geometry/lights.js), unpatched, so its bloom
  // copy shares the one program every other lamp draws with (`signLamp`, marked from main.js).
  const litMaterial = new THREE.MeshLambertMaterial({
    color: color('taxiSign'), emissive: color('taxiSign'), emissiveIntensity: SIGN_GLOW, flatShading: true,
  });
  const lamp = new THREE.Mesh(lensGeometry('taxiSign'), litMaterial);
  lamp.userData.bloomKind = 'window';
  const dark = new THREE.Mesh(lensGeometry('taxiSignDark'), propMaterial());
  const parts = [base, lamp, dark];
  for (const part of parts) {
    part.castShadow = true;
    part.receiveShadow = true;
    hop.add(part);
  }
  // Every opaque part of the taxi is in the ghost mask, or it occludes the shell's rim (taxi.js).
  addGhostMask(base);
  addGhostOutline(lamp, { rim: 0.1 });
  addGhostOutline(dark, { rim: 0.1 });

  const state = {
    lit: SIGN_LIT_WHEN_FREE,   // what the lens shows now
    want: SIGN_LIT_WHEN_FREE,  // what it should show once any hop lands
    hopT: null,                // seconds into the hop, or null on the roof
    swapped: false,
    t: 0,
    squash: 0, squashV: 0,     // the spring, as Y scale − 1
    lean: 0,
    lastSpeed: null,
  };

  const show = (lit) => {
    state.lit = lit;
    lamp.visible = lit;
    dark.visible = !lit;
  };
  show(state.lit);

  const startHop = () => {
    state.hopT = 0;
    state.swapped = false;
  };

  function setOccupied(occupied, instant = false) {
    state.want = SIGN_LIT_WHEN_FREE ? !occupied : Boolean(occupied);
    if (instant) {
      state.hopT = null;
      state.squash = state.squashV = 0;
      show(state.want);
      return;
    }
    // Mid-hop, the lens takes whatever `want` says at the top of the flip; if `want` changes again
    // after that, the landing starts the next hop.
    if (state.hopT === null && state.want !== state.lit) startHop();
  }

  /** Write the transforms for the current state. */
  function pose() {
    let sy = 1 + state.squash + BOB_AMP * Math.sin(state.t * Math.PI * 2 * BOB_HZ);
    let air = 0;
    let flip = 0;
    if (state.hopT !== null) {
      const h = state.hopT;
      if (h < HOP_CROUCH) {
        sy = 1 - CROUCH_SQUASH * Math.sin((h / HOP_CROUCH) * Math.PI / 2);
      } else {
        const u = Math.min(1, (h - HOP_CROUCH) / HOP_AIR);
        air = HOP_H * 4 * u * (1 - u);
        // Negative about local Z is nose over — the taxi's own bridge flip uses the same sign.
        flip = -Math.PI * 2 * easeInOut(u);
        // Stretched along its travel at both ends of the arc, round at the top.
        sy = 1 + AIR_STRETCH * Math.abs(1 - 2 * u);
      }
    }
    sy = Math.max(0.5, sy);
    const sxz = 1 / Math.sqrt(sy);
    hop.scale.set(sxz, sy, sxz);
    hop.position.y = HALF_H * sy + air;
    hop.rotation.set(0, 0, flip + state.lean);
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

    if (state.hopT !== null) {
      state.hopT += dt;
      const u = (state.hopT - HOP_CROUCH) / HOP_AIR;
      // Swap at the top of the flip, upside down and as far off the roof as it gets.
      if (!state.swapped && u >= 0.5) {
        state.swapped = true;
        show(state.want);
      }
      if (u >= 1) {
        state.hopT = null;
        state.squash = -LAND_SQUASH;
        state.squashV = 0;
        if (state.want !== state.lit) startHop();
      }
    } else {
      // Semi-implicit Euler, substepped so a 30fps frame cannot blow the spring up.
      const steps = Math.ceil(dt / (1 / 120));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        state.squashV += (-SPRING_K * (state.squash - kick) - SPRING_DAMP * state.squashV) * h;
        state.squash += state.squashV * h;
      }
    }
    pose();
  }

  /** Put the lamp out where it is, mid-hop or not — a wreck (sim/traffic.js, beside its pods). */
  function douse() {
    state.hopT = null;
    state.want = false;
    show(false);
    pose();
  }

  /** Finish any hop at once: shot mode ticks the fare loop once and freezes. */
  function settle() {
    state.hopT = null;
    state.squash = state.squashV = 0;
    show(state.want);
    pose();
  }

  pose();
  return { anchor, parts, lamp, setOccupied, update, settle, douse, state };
}

/** Exposed for the probe: the hop's length in seconds, crouch to touchdown. */
export const SIGN_HOP_SECONDS = HOP_CROUCH + HOP_AIR;
