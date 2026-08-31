import * as THREE from 'three';

// Off-screen fare pointers.
//
// Arrows that ride the viewport edge, each rotated to point at a fare that has slipped off the
// frame — the map is bigger than the frame on portrait and the player has been panning, so losing
// sight of where to drive costs a beat.
//
// There are two kinds and they are the same arrow:
//
//   - **The drop-off**, while a fare is aboard. One arrow, aimed at the ring the taxi is meant to
//     reach. The drop-off no longer floats a marker above the rooftops, so this is the only thing
//     that reports it off-frame.
//   - **Every rider still on the kerb.** One arrow each, aimed at the corner they are standing on.
//     This used to be the [rider-finder chips](riderfinder.js)' job, and the chips did it by
//     answering the question outright: a row of portraits with their own clocks, one tap to
//     dispatch, no need to ever find the pin. That made the whole board readable — and pickable —
//     without looking at the city, which is the opposite of the game. The arrow says *which
//     direction* and *how urgent* and stops there; finding the rider and judging whether they are
//     worth the drive is back to being something the player does on the map.
//
// **They wear the fare's colour, which is that rider's clock** (see game/urgency.js) — passed in
// per frame rather than read from a palette, because the thing each one stands in for changes
// colour as the clock drains and an arrow left on a fixed hue would be the one mark on the screen
// disagreeing about how much trouble the player is in. Set through `style.color` against a
// `fill: currentColor` polygon: one property write, and the SVG's own markup stays a shape with no
// colour of its own.
//
// The drop-off's arrow is drawn a little larger than a waiting rider's (`.is-dropoff`). The two
// are otherwise identical, and they have to be told apart: while carrying, three or four arrows can
// be up at once and only one of them is the trip actually under way. Colour cannot carry that —
// colour is already spoken for by the clocks.
//
// The pool grows on demand and is never shrunk: at most MAX_FARES riders plus one drop-off, so it
// tops out at a handful of 42px divs.

const EDGE_MARGIN = 36;   // px kept clear from the viewport edge, so an arrow lives on the HUD
                          // rather than sliced by it. An arrow is centred on its clamp point, so
                          // this has to stay above half the largest arrow — 21px, the drop-off's
                          // 42 — or the edge cuts the one mark that says where the trip is.

// The viewport's edges are no longer the *usable* edges: with `viewport-fit=cover` the page runs
// under the status bar and the home indicator, and an arrow clamped 36px from the raw edge parks
// itself beneath either one. `env()` is CSS-only, so the values come off the `--safe-*` custom
// properties index.html sets on :root — computed values, so `env()` has already been substituted
// and they read back as plain px. Re-read on resize because rotating the phone moves the notch
// to a side.
const safe = { top: 0, right: 0, bottom: 0, left: 0 };
function readSafeInsets() {
  const style = getComputedStyle(document.documentElement);
  for (const side of Object.keys(safe)) {
    safe[side] = parseFloat(style.getPropertyValue(`--safe-${side}`)) || 0;
  }
}

const ARROW_SVG = '<svg viewBox="-16 -16 32 32"><polygon points="13,0 -9,-10 -4,0 -9,10" /></svg>';

export function createFarePointers({ camera, pinLocation, viewport = null }) {
  const host = document.getElementById('fare-pointers');
  if (!host) return { update: () => {} };

  readSafeInsets();
  window.addEventListener('resize', readSafeInsets);

  const projected = new THREE.Vector3();

  // One arrow per pool slot, each remembering the last hex written to it: a colour that only steps
  // four times over a clock shouldn't be a style write on every frame the arrow is up.
  const arrows = [];
  function arrowAt(index) {
    if (arrows[index]) return arrows[index];
    const el = document.createElement('div');
    el.className = 'fare-pointer';
    el.hidden = true;
    el.innerHTML = ARROW_SVG;
    host.appendChild(el);
    const arrow = { el, painted: null, dropoff: null };
    arrows[index] = arrow;
    return arrow;
  }

  /**
   * Aim one arrow at a world point, or hide it if that point is comfortably in frame.
   *
   * @returns true if the arrow ended up on screen
   */
  function aim(arrow, world, color, isDropoff) {
    // The frame the renderer actually draws — `window.inner*` stops short of it on an installed
    // iOS app (see util/viewport.js), and an arrow clamped to the short edge floats mid-screen.
    const w = viewport ? viewport.width() : window.innerWidth;
    const h = viewport ? viewport.height() : window.innerHeight;
    // Aimed at the mark on the road — the drop-off ring, or the disc under the rider's feet. Both
    // sit on the tarmac; the crystal over a rider's head is not what the arrow stands in for.
    projected.set(world.x, 0.1, world.z).project(camera);
    const sx = (projected.x * 0.5 + 0.5) * w;
    const sy = (-projected.y * 0.5 + 0.5) * h;

    // The band the arrow may live in: the viewport, less the hardware's corners, less the margin.
    const minX = safe.left + EDGE_MARGIN;
    const maxX = w - safe.right - EDGE_MARGIN;
    const minY = safe.top + EDGE_MARGIN;
    const maxY = h - safe.bottom - EDGE_MARGIN;

    // Fully on-screen with a small margin: the marker itself is visible, no arrow needed.
    if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
      arrow.el.hidden = true;
      return false;
    }
    arrow.el.hidden = false;

    if (arrow.dropoff !== isDropoff) {
      arrow.dropoff = isDropoff;
      arrow.el.classList.toggle('is-dropoff', isDropoff);
    }
    if (color) {
      const hex = `#${color.getHexString()}`;
      if (hex !== arrow.painted) {
        arrow.painted = hex;
        arrow.el.style.color = hex;
      }
    }

    // Clamp along the line from the viewport centre to the projected point, so the arrow sits
    // where the marker would exit the frame. The distance to each edge is asymmetric now — the
    // safe band is not centred on the viewport — so the reach depends on the direction of travel.
    const cx = w / 2;
    const cy = h / 2;
    const dx = sx - cx;
    const dy = sy - cy;
    const reachX = dx > 0 ? maxX - cx : cx - minX;
    const reachY = dy > 0 ? maxY - cy : cy - minY;
    // Guard the divide when the projected point coincides with the centre.
    const scale = Math.min(
      Math.abs(dx) > 0.001 ? reachX / Math.abs(dx) : Infinity,
      Math.abs(dy) > 0.001 ? reachY / Math.abs(dy) : Infinity,
    );
    const px = cx + dx * scale;
    const py = cy + dy * scale;
    const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;

    arrow.el.style.left = `${px}px`;
    arrow.el.style.top = `${py}px`;
    arrow.el.style.transform = `translate(-50%, -50%) rotate(${angleDeg.toFixed(2)}deg)`;
    return true;
  }

  /**
   * @param aboard   the fare in the car, or null — its drop-off gets the large arrow
   * @param waiting  the fares still on the kerb; one arrow each, at their own corner
   * @param colorOf  `fares.colorOf`, so every arrow reads its clock off the one urgency scale
   */
  function update(aboard, waiting = [], colorOf = null) {
    let slot = 0;

    if (aboard && aboard.stage === 'riding') {
      const c = pinLocation(aboard.target.i, aboard.target.j);
      aim(arrowAt(slot), c, colorOf ? colorOf(aboard) : null, true);
      slot += 1;
    }

    // Sorted by slot index rather than by time left, the same way the chips were: an arrow that
    // swapped which rider it belonged to whenever two clocks crossed would move for a reason
    // nothing on screen explains. Their positions are set by where the riders are anyway — the
    // ordering only decides which pooled div ends up where.
    const kerb = waiting.slice().sort((a, b) => a.slot.index - b.slot.index);
    for (const fare of kerb) {
      if (fare.stage !== 'waiting') continue;
      const c = pinLocation(fare.target.i, fare.target.j);
      aim(arrowAt(slot), c, colorOf ? colorOf(fare) : null, false);
      slot += 1;
    }

    for (let i = slot; i < arrows.length; i++) arrows[i].el.hidden = true;
  }

  return { update };
}
