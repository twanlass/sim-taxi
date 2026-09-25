import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { sirenOn } from '../geometry/lights.js';
import { RADIUS_FRAC, SIREN_DIM } from './sirenglow.js';

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
// warning light, the alternation reads as police.
//
// **Soft, on purpose, and in the siren wash's own terms.** The first cut was an 0.85 band at the
// hunting rate (11Hz) and it was too much: a whole perimeter at that strength is several times the
// light a single cruiser's bloom puts on screen, strobing for the length of a getaway. So it takes
// the wash's falloff (full at the edge, 45% halfway in, nothing at `RADIUS_FRAC`, pulled in by `DEPTH`), its patrol rate
// (`sirenOn(time)`, 6Hz) and a peak well under the wash's own, because it covers four edges and
// the wash covers a spot on one.
//
// Enveloped rather than switched: it rises over `RISE` when the robber gets in and falls over
// `FALL` after the drop-off, so the chase arrives as a moment and leaves as a release rather than
// popping on and off with the event's flag.

/** Seconds to full strength once the event starts. Quick — the robber getting in is the hit. */
export const RISE = 0.8;
/** Seconds back to nothing after it ends. Slower: the cops standing down is a come-down. */
export const FALL = 1.2;
/** Peak alpha of the lit colour at the very edge of the frame — about the siren wash's own floor
 *  (`GLOW_FLOOR` = 0.35), which is how a cruiser on the far side of the city reads. */
export const PEAK = 0.38;
/** How far in the glow reaches: the siren wash's radius less a fifth. At the full `RADIUS_FRAC` it
 *  read well but crept too far into the play view — four edges at that depth leave a phone with
 *  only the middle 16% of its width untinted. At 0.8 that is 33%. */
export const DEPTH = 0.8;

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
  const lit = sirenOn(time);
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
  let paintedA2 = '';
  let paintedB2 = '';
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
  function mix({ red: r, blue: b }, falloff = 1) {
    const alpha = Math.min(1, Math.max(r, b)) * falloff;
    if (alpha <= 0) return 'rgba(0,0,0,0)';
    const k = 255 / alpha;
    const ch = (x, y) => Math.min(255, Math.round((x * r + y * b) * falloff * k));
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
    const band = Math.round(Math.min(w, h) * RADIUS_FRAC * DEPTH);
    if (band !== paintedW) {
      el.style.setProperty('--rob-w', `${band}px`);
      paintedW = band;
    }

    const wash = frameWash(level, time);
    // Each side as two stops, the edge and the 45% shoulder the siren wash's gradient has.
    const a = mix(wash.a);
    const b = mix(wash.b);
    const a2 = mix(wash.a, 0.45);
    const b2 = mix(wash.b, 0.45);
    if (a !== paintedA) { el.style.setProperty('--rob-a', a); paintedA = a; }
    if (b !== paintedB) { el.style.setProperty('--rob-b', b); paintedB = b; }
    if (a2 !== paintedA2) { el.style.setProperty('--rob-a2', a2); paintedA2 = a2; }
    if (b2 !== paintedB2) { el.style.setProperty('--rob-b2', b2); paintedB2 = b2; }
  }

  return { update };
}
