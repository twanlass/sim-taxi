import { PALETTE } from '../palette.js';

// "Which one is me?" — a yellow down-pointing triangle hovering over the taxi while it is empty.
//
// Playtests (2026-11-23) kept turning up players who could not say which car was theirs. The opening
// vignette was meant to answer that — their own garage door, their own car driving out of it — and
// it is why the tutorial's taxi beat is switched off (`TAXI_BEAT` in game/tutorial.js). It does not
// answer it: the car is shown big at door zoom, then the camera pulls back to play zoom, where a
// 4-unit taxi is ~30px among a city's worth of traffic, and the tutorial pans away to the first rider.
//
// So the taxi wears a marker, Tyler's spec: a simple yellow upside-down triangle above the car,
// shown while **no rider is aboard**. Aboard, the route band and the drop-off pin already say where
// the car is going and the camera is following it there; empty is when the player is looking around
// the map for the next fare and has to find their way back.
//
// **A DOM element, not a mesh.** Three reasons. It must read over a tower standing between the taxi
// and the camera — the ghost outline is how the car shows through, and a marker that went behind
// the same building would be hidden exactly when it is needed. It is the same size in pixels at
// every zoom, so it is never a speck on a pulled-back desktop frame nor a blob in a crash close-up.
// And it costs no shader on either renderer (the WebGPU port would need the same thing written
// twice). The arrows at the frame edge are DOM for the same reasons (game/farepointers.js).
//
// Flat: one fill and a dark outline, no gloss (Tyler's UI rule). The yellow is the taxi's own
// `taxiBody`, which is reserved for the taxi in palette.js — a yellow triangle can only mean one car.

// Where the point sits, in world units up from the road: the roof is ~2.0 on the drawn taxi
// (TAXI_SCALE included), and the triangle stands clear of it by a pixel gap rather than a world one
// (GAP_PX), so the car never looks capped at any zoom.
const ROOF_Y = 2.2;
// Pixels between the roof and the triangle's point, before the bob.
const GAP_PX = 10;
// The triangle, in CSS px. The taxi is ~30px long at phone play zoom (1 unit ≈ 8.1px, 4 units long
// drawn), so 18 across is about half the car — big enough to find at a glance, small enough not to
// be the biggest thing on the road.
const W = 18;
const H = 15;
// Outline width in px. The fill alone vanishes against the yellow garage and the pale pavement; the
// dark rim is what holds it on every ground.
const STROKE = 2.5;

/**
 * @param root     the element to put the marker in (the page body, or a test stub)
 * @param project  (x, y, z) => {x, y} — world to viewport pixels
 * @param taxi     the live taxi car object, read for its position each frame
 */
export function createTaxiMarker({ root, project, taxi }) {
  if (!root || typeof document === 'undefined') return { update: () => {}, el: null };
  const el = document.createElement('div');
  el.id = 'taxi-marker';
  el.setAttribute('aria-hidden', 'true');
  const pad = STROKE;
  const vw = W + pad * 2;
  const vh = H + pad * 2;
  el.innerHTML = `<svg width="${vw}" height="${vh}" viewBox="0 0 ${vw} ${vh}">`
    + `<polygon points="${pad},${pad} ${pad + W},${pad} ${pad + W / 2},${pad + H}" `
    + `fill="${PALETTE.taxiBody}" stroke="${PALETTE.taxiTrim}" stroke-width="${STROKE}" `
    + 'stroke-linejoin="round"/></svg>';
  root.appendChild(el);

  let on = false;

  /**
   * @param show  whether the marker should be up this frame — the caller owns every reason it
   *              should not be (a rider aboard, the taxi in the garage, a run that has ended)
   */
  function update(show) {
    if (show !== on) {
      on = show;
      el.classList.toggle('is-on', show);
    }
    // Tracked while fading out too, or it would slide off the car it is leaving.
    const p = project(taxi.x, ROOF_Y, taxi.z);
    // Anchored on the point: the element's bottom centre sits GAP_PX above the roof.
    const x = p.x - vw / 2;
    const y = p.y - GAP_PX - vh;
    el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }

  return { update, el };
}
