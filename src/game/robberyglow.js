import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { sirenOn } from '../geometry/lights.js';
import { SIREN_DIM } from './sirenglow.js';

// The robbery's frame: red and blue burning in round **every** edge of the screen for as long as
// the getaway runs, trading sides on the siren's beat like the two halves of a light bar.
//
// The same light as game/sirenglow.js — the same two colours, the same `screen` blend, the same
// dim floor on the off colour — put to the opposite use. That wash is a *bearing*: one cruiser, one
// edge, "it is coming from over there". During a robbery there are four cop cars hunting the taxi
// from every side, so a bearing would be noise; what the player needs told is *which mode the game
// is in*, and a frame round the whole screen says that without pointing anywhere.
//
// Left and top are one side of the bar, right and bottom the other, so the colours chase round the
// frame diagonally rather than the whole border blinking as one — a single-colour flash reads as a
// warning light, the alternation reads as police. The strobe is `sirenOn(time, true)`, the hunting
// rate the robbery's cop cars run their own bars at (game/coplights.js), off the same sim clock.
//
// Enveloped rather than switched: it rises over `RISE` when the robber gets in and falls over
// `FALL` after the drop-off, so the chase arrives as a moment and leaves as a release rather than
// popping on and off with the event's flag.

/** Seconds to full strength once the event starts. Quick — the robber getting in is the hit. */
export const RISE = 0.35;
/** Seconds back to nothing after it ends. Slower: the cops standing down is a come-down. */
export const FALL = 1.2;
/** Peak alpha of the lit colour at the very edge of the frame. */
export const PEAK = 0.85;
/** How far in the band reaches, as a fraction of the short side of the viewport. */
export const BAND_FRAC = 0.24;

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** The envelope, one step. Pure, for tools/probe.mjs. */
export function stepLevel(level, active, dt) {
  return clamp01(level + (active ? dt / RISE : -dt / FALL));
}

/**
 * The two sides' red and blue alphas for this frame. Pure, for tools/probe.mjs.
 *
 * @param level  the envelope, 0..1
 * @param time   the sim clock the cop cars' bars strobe on (`traffic.stats.time`)
 * @returns {{a: {red, blue}, b: {red, blue}}} — `a` is left + top, `b` right + bottom
 */
export function frameWash(level, time) {
  const s = PEAK * level;
  const lit = sirenOn(time, true);
  const hot = s;
  const dim = s * SIREN_DIM;
  return lit
    ? { a: { red: hot, blue: dim }, b: { red: dim, blue: hot } }
    : { a: { red: dim, blue: hot }, b: { red: hot, blue: dim } };
}

export function createRobberyGlow({ viewport = null } = {}) {
  const el = document.getElementById('robbery-glow');
  if (!el) return { update: () => {} };

  const red = new THREE.Color(PALETTE.lightRed);
  const blue = new THREE.Color(PALETTE.sirenBlue);
  let level = 0;
  let visible = false;
  let paintedA = '';
  let paintedB = '';
  let paintedW = null;

  function setVisible(next) {
    if (visible === next) return;
    visible = next;
    // `hidden` rather than transparent while off, for the reason sirenglow.js gives: a full-frame
    // blend layer costs a compositing pass on every frame it exists.
    el.hidden = !next;
  }
  setVisible(false);

  // The two colours are additive under `screen`, so a side's colour is red and blue summed at
  // their own alphas — one rgba per side, which keeps the CSS to four gradients instead of eight.
  function mix({ red: r, blue: b }) {
    const alpha = Math.min(1, Math.max(r, b));
    if (alpha <= 0) return 'rgba(0,0,0,0)';
    const k = 255 / alpha;
    const ch = (x, y) => Math.min(255, Math.round((x * r + y * b) * k));
    return `rgba(${ch(red.r, blue.r)},${ch(red.g, blue.g)},${ch(red.b, blue.b)},${alpha.toFixed(2)})`;
  }

  /**
   * @param dt      frame seconds, for the envelope
   * @param active  whether the getaway is running
   * @param time    the sim clock the bars strobe on
   */
  function update(dt, active, time) {
    level = stepLevel(level, active, dt);
    if (level <= 0) {
      setVisible(false);
      return;
    }
    setVisible(true);

    const w = viewport ? viewport.width() : window.innerWidth;
    const h = viewport ? viewport.height() : window.innerHeight;
    const band = Math.round(Math.min(w, h) * BAND_FRAC);
    if (band !== paintedW) {
      el.style.setProperty('--rob-w', `${band}px`);
      paintedW = band;
    }

    const wash = frameWash(level, time);
    const a = mix(wash.a);
    const b = mix(wash.b);
    if (a !== paintedA) { el.style.setProperty('--rob-a', a); paintedA = a; }
    if (b !== paintedB) { el.style.setProperty('--rob-b', b); paintedB = b; }
  }

  return { update };
}
