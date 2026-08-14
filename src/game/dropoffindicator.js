import * as THREE from 'three';

// Off-screen drop-off pointer.
//
// When a fare is aboard the drop-off can sit behind the viewport edge — the map is bigger than the
// frame on portrait and the player has been panning. Losing sight of where to drive at costs a
// beat. This arrow rides the viewport edge pointing at the ring the taxi is meant to reach, so the
// direction is always readable from the HUD.
//
// It carries more than it used to. The drop-off was a crystal floating at rooftop height, which
// stayed visible over the skyline for a while after the ring itself had gone behind something; now
// the marker is the ring and nothing else, and this is the only thing that reports it off-frame.
//
// **It wears the ring's colour, which is the rider's clock** (see game/urgency.js) — passed in
// per frame rather than read from a palette, because the thing it stands in for changes colour as
// the clock drains and an arrow left on a fixed hue would be the one mark on the screen disagreeing
// about how much trouble the player is in. It was a fixed teal while the ring was, and two states
// (teal until tapped, yellow after) before that, back when a drop-off was a question rather than an
// instruction.
//
// Set through `style.color` against a `fill: currentColor` polygon: one property write, and the
// SVG's own markup stays a shape with no colour of its own.
//
// The indicator only shows for a *riding* fare, which is also the only fare with a drop-off ring on
// the map: a waiting rider's destination stays hidden until they board. One pointer, aimed at the
// trip actually under way.

const EDGE_MARGIN = 36;   // px kept clear from the viewport edge, so the arrow lives on the HUD
                          // rather than sliced by it

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

export function createDropoffIndicator({ camera, pinLocation, viewport = null }) {
  const el = document.getElementById('dropoff-indicator');
  if (!el) return { update: () => {} };

  readSafeInsets();
  window.addEventListener('resize', readSafeInsets);

  const projected = new THREE.Vector3();
  let visible = false;
  // Last hex written, so a colour that only steps four times over a clock isn't a style write on
  // every frame the arrow is up.
  let painted = null;

  function setVisible(next) {
    if (visible === next) return;
    visible = next;
    el.hidden = !next;
  }
  setVisible(false);

  /**
   * @param fare  the rider aboard, or null
   * @param color what their markers are painted (game/fares.js `colorOf`) — the ring this arrow
   *              stands in for wears the same one
   */
  function update(fare, color = null) {
    // No pointer for a waiting rider: their diamond and their finder chip already handle that job.
    if (!fare || fare.stage !== 'riding') {
      setVisible(false);
      return;
    }

    if (color) {
      const hex = `#${color.getHexString()}`;
      if (hex !== painted) {
        painted = hex;
        el.style.color = hex;
      }
    }

    // The frame the renderer actually draws — `window.inner*` stops short of it on an installed
    // iOS app (see util/viewport.js), and an arrow clamped to the short edge floats mid-screen.
    const w = viewport ? viewport.width() : window.innerWidth;
    const h = viewport ? viewport.height() : window.innerHeight;
    const c = pinLocation(fare.target.i, fare.target.j);
    // Aimed at the ring on the road, which is the whole marker now. It used to aim halfway up the
    // pin's post so the arrow pointed at the crystal rather than at the tarmac under it.
    projected.set(c.x, 0.1, c.z).project(camera);
    const sx = (projected.x * 0.5 + 0.5) * w;
    const sy = (-projected.y * 0.5 + 0.5) * h;

    // The band the arrow may live in: the viewport, less the hardware's corners, less the margin.
    const minX = safe.left + EDGE_MARGIN;
    const maxX = w - safe.right - EDGE_MARGIN;
    const minY = safe.top + EDGE_MARGIN;
    const maxY = h - safe.bottom - EDGE_MARGIN;

    // Fully on-screen with a small margin: the pin itself is visible, no arrow needed.
    if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
      setVisible(false);
      return;
    }

    setVisible(true);

    // Clamp along the line from the viewport centre to the projected point, so the arrow sits
    // where the pin would exit the frame. The distance to each edge is asymmetric now — the safe
    // band is not centred on the viewport — so the reach depends on the direction of travel.
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

    el.style.left = `${px}px`;
    el.style.top = `${py}px`;
    el.style.transform = `translate(-50%, -50%) rotate(${angleDeg.toFixed(2)}deg)`;
  }

  return { update };
}
