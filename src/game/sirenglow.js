import * as THREE from 'three';
import { sirenOn } from '../sim/police.js';

// Off-screen police warning: red and blue washing in over the viewport edge the cruiser is coming
// from, strobing in step with its own light bar and fading out as it comes into frame.
//
// It exists for the same reason game/dropoffindicator.js does — the map is bigger than the frame on
// a phone, and the player pans — but for the opposite kind of thing. The drop-off is somewhere you
// are trying to get to and the arrow is navigation; the siren is something coming at you and this
// is a threat you cannot see yet. The bust is `POLICE_BUST_RANGE` = one block, so a cruiser that is
// one screen edge away is already close enough to end a run, and until now the only cue that it
// existed was ambient traffic pulling over to a car that was off-frame.
//
// **It is on exactly when the light bar is on**, which is the whole reason it can be trusted:
// `state.lit` gates both, so the wash is the same announcement seen through the frame edge rather
// than a second rule with its own opinion. That includes the run-up — the bar lights as the cruiser
// spawns and the bust only arms a block in (BUST_ARM_INSET in sim/police.js), so the wash covers
// that grace period too. Telegraphing the cop early is the point of it; what it must never do is
// stay quiet about one that is already lethal, and being armed off the earlier of the two flags is
// what rules that out.
//
// The strobe comes off `sirenOn()` rather than a clock of its own, so the wash and the bar are the
// same siren seen from two places and cannot drift apart — including the rate change to 11Hz once
// the cruiser has locked on, which is the only cue that a corridor run has become about you.
//
// Rendered as one fixed full-screen div with two radial gradients on it, centred on the point where
// the cruiser crosses the frame edge, so a corner approach naturally shows a quarter of the bloom
// and a side shows half. Not a three.js light: a real one would mean lighting a city built for a
// single global key off a car that is by definition outside the frustum.

/** How far out the cruiser has to be before any glow shows, as a fraction of the half-frame. */
export const FADE_ON = 0.88;
/** ...and where the wash reaches full strength. Ramped rather than switched at the frame edge:
 *  the cruiser crosses this band in about half a second, so the hand-off from "you can see it" to
 *  "it is behind the edge" is a fade rather than a pop. */
export const FADE_FULL = 1.30;

// Proximity, in world units, so the wash is a distance read and not just a bearing. A block is 20
// and the map is 100 across, so: full strength inside two blocks, easing back to the floor at six.
export const GLOW_NEAR = 40;
export const GLOW_FAR = 120;
// Never all the way down, though — a cruiser on the far side of the city is still one the player
// wants to know about, it just isn't the thing about to happen.
export const GLOW_FLOOR = 0.35;

// The off colour keeps a low glow rather than going dark, for the same reason the lamps do: a hard
// on/off strobe reads as flicker rather than as a siren. 14/90 is the ratio lightBar() runs its two
// point lights at (see `siren()` in sim/police.js).
export const SIREN_DIM = 14 / 90;

// Radius of the bloom, as a fraction of the short side of the viewport. Measured against the
// viewport rather than the world because it is light spilling past the edge of the *frame* — the
// same reason the tutorial spotlight sizes its pools in pixels.
const RADIUS_FRAC = 0.42;

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * Where the wash sits and how hard it burns, from the cruiser's projected screen position.
 *
 * Pure, and exported for `tools/probe.mjs`: the whole point of the feature is a direction and a
 * strength, and both are numbers rather than something a screenshot can answer.
 *
 * @param sx,sy     the cruiser, projected to CSS pixels
 * @param w,h       the frame actually being drawn (util/viewport.js, not `window.inner*`)
 * @param distance  world units from the taxi to the cruiser
 * @returns {{x, y, radius, strength}} or null when there is nothing to draw
 */
export function edgeGlow(sx, sy, w, h, distance) {
  const cx = w / 2;
  const cy = h / 2;
  if (!(cx > 0 && cy > 0)) return null;

  const dx = sx - cx;
  const dy = sy - cy;

  // How far out the cruiser is, as a fraction of the half-frame in whichever axis it leaves by.
  // Taking the max rather than the length is what makes 1.0 mean "on the frame edge" for every
  // bearing: a viewport is a rectangle, and a radial measure would call the corners off-screen
  // while they are still plainly in shot.
  const q = Math.max(Math.abs(dx) / cx, Math.abs(dy) / cy);
  const out = clamp01((q - FADE_ON) / (FADE_FULL - FADE_ON));
  if (out <= 0) return null;

  const near = clamp01((GLOW_FAR - distance) / (GLOW_FAR - GLOW_NEAR));
  const strength = out * (GLOW_FLOOR + (1 - GLOW_FLOOR) * near);
  if (strength <= 0) return null;

  // Walk out from the centre of the frame along the bearing until it meets the frame's edge. Guard
  // the divides: a cruiser projecting exactly onto the centre has no bearing at all, and `out` has
  // already ruled that case out — but only because `q` was large, so at most one of these is zero.
  const scale = Math.min(
    Math.abs(dx) > 1e-6 ? cx / Math.abs(dx) : Infinity,
    Math.abs(dy) > 1e-6 ? cy / Math.abs(dy) : Infinity,
  );

  return {
    x: cx + dx * scale,
    y: cy + dy * scale,
    radius: Math.min(w, h) * RADIUS_FRAC,
    strength,
  };
}

/**
 * The whole rule, and the reason this module is worth having outside the DOM: the light-bar gate, the
 * geometry above, and the strobe, composed into the four numbers the CSS wants.
 *
 * `tools/probe.mjs` drives this against a live corridor run. Splitting the gate out into the caller
 * would have left the one property that matters most — *the wash is up for exactly the frames the
 * light bar is* — asserted nowhere but by reading main.js.
 *
 * @param state     the cruiser's published state (sim/police.js)
 * @returns {{x, y, radius, red, blue}} or null when the wash is off
 */
export function sirenWash(state, sx, sy, w, h, distance) {
  // Unlit is not merely "far away": it is a cruiser between runs, with its own light bar dark.
  // Washing the frame for one would be warning about a car that is not there.
  if (!state || !state.lit) return null;

  const glow = edgeGlow(sx, sy, w, h, distance);
  if (!glow) return null;

  // The rate change is the cruiser's, not this module's — see `siren()` in sim/police.js.
  const lit = sirenOn(state.flash, state.chasing || state.arrived);
  return {
    x: glow.x,
    y: glow.y,
    radius: glow.radius,
    red: glow.strength * (lit ? 1 : SIREN_DIM),
    blue: glow.strength * (lit ? SIREN_DIM : 1),
  };
}

/**
 * @param camera    the play camera, to project the cruiser with
 * @param viewport  util/viewport.js — the frame the renderer is actually drawing, which
 *                  `window.inner*` is short of on an installed iOS app
 */
export function createSirenGlow({ camera, viewport = null }) {
  const el = document.getElementById('siren-glow');
  if (!el) return { update: () => {} };

  const projected = new THREE.Vector3();
  let visible = false;
  // Last values written. The wash blends over the whole frame, so it is `hidden` rather than merely
  // transparent whenever it is off: a full-screen `mix-blend-mode` layer is a compositing pass the
  // GPU pays for on every frame it exists, and a siren is up for a few seconds a minute.
  let paintedX = null;
  let paintedY = null;
  let paintedR = null;
  let paintedRed = null;
  let paintedBlue = null;

  function setVisible(next) {
    if (visible === next) return;
    visible = next;
    el.hidden = !next;
  }
  setVisible(false);

  // One style write per property that actually moved. The strobe holds each colour for ~80ms, so
  // the two alphas are unchanged on most frames even while the wash is up.
  function writeVar(name, value, painted, unit = '') {
    if (painted !== null && Math.abs(value - painted) < 0.01) return painted;
    el.style.setProperty(name, `${value.toFixed(2)}${unit}`);
    return value;
  }

  /**
   * @param police  the cruiser (sim/police.js) — `state.lit` is what arms this, same as the bar
   * @param taxi    the player's car, for the proximity read
   */
  function update(police, taxi) {
    if (!police || !taxi) {
      setVisible(false);
      return;
    }

    const w = viewport ? viewport.width() : window.innerWidth;
    const h = viewport ? viewport.height() : window.innerHeight;
    const car = police.group.position;
    projected.copy(car).project(camera);

    const wash = sirenWash(
      police.state,
      (projected.x * 0.5 + 0.5) * w,
      (-projected.y * 0.5 + 0.5) * h,
      w, h,
      Math.hypot(taxi.x - car.x, taxi.z - car.z),
    );
    if (!wash) {
      setVisible(false);
      return;
    }
    setVisible(true);

    paintedX = writeVar('--siren-x', wash.x, paintedX, 'px');
    paintedY = writeVar('--siren-y', wash.y, paintedY, 'px');
    paintedR = writeVar('--siren-r', wash.radius, paintedR, 'px');
    paintedRed = writeVar('--siren-red', wash.red, paintedRed);
    paintedBlue = writeVar('--siren-blue', wash.blue, paintedBlue);
  }

  return { update };
}
