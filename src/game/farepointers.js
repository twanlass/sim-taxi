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
//   - **Every rider still on the kerb — but only while the seat is free.** One arrow each, aimed at
//     the corner they are standing on.
//     This used to be the [rider-finder chips](riderfinder.js)' job, and the chips did it by
//     answering the question outright: a row of portraits with their own clocks, one tap to
//     dispatch, no need to ever find the pin. That made the whole board readable — and pickable —
//     without looking at the city, which is the opposite of the game. The arrow says *which
//     direction* and *how urgent* and stops there; finding the rider and judging whether they are
//     worth the drive is back to being something the player does on the map.
//
// **The two kinds are exclusive, and that is the whole of the rule.** With a rider aboard there is
// exactly one arrow on screen and it is the drop-off's. An arrow is a *go here*, and a kerbside
// rider is the one thing on the board the player is not allowed to go to while carrying one
// (`markDirected` in game/fares.js refuses the tap) — so a ring of them around the frame is three
// or four invitations to do the one thing the game will not accept, which is what the board's
// [step-back](gameplay.md) is already spending a glow and a bounce to say. Enforced here rather
// than by the caller passing an empty list: it is one rule about arrows, and it belongs with them.
//
// What it costs is real and is the reason it took a playtest to settle: a waiting rider off the
// side of the frame has *no* mark while you are carrying, so their clock is only readable by
// panning to them. Their disc is still on the tarmac at their corner, and the arrow is back the
// instant the seat empties — but on a phone, mid-trip, "off frame" and "invisible" are the same
// thing. It is the deliberate price of the frame saying one thing at a time.
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
// ## A tap rides the camera to the mark — on a narrow viewport only
//
// The arrow says *which direction*, and on a phone the only way to act on that was to drag the map
// that way, by hand, guessing when to stop, on a clock that is draining. So a press on one glides
// the camera onto the mark it is pointing at (`onTap`), and the arrow then takes itself down
// because the thing it stood in for is in frame.
//
// **It moves the camera and nothing else.** The chips this replaced dispatched the taxi in the same
// tap, and that is precisely what made the board playable off the HUD without ever looking at the
// city (see above). Snapping the view is not that: the player still has to read the corner, judge
// whether the fare is worth the drive, and tap the pin. What the arrow hands over is the *pan* —
// the part that was never a decision.
//
// It is a deliberate pan, so it keeps the camera (`releaseCameraToPlayer` in main.js) rather than
// peeking and riding home the way a chip tap did: the player asked to look at that corner, and a
// camera that slid back off it a beat later would undo the thing they pressed for. The way home is
// the taxi-finder chip (game/taxifinder.js), which is up 0.4s after the car goes fully off-frame —
// the two affordances are each other's return leg.
//
// Narrow only, for the same reason drag-to-pan and the follow-cams are: above `NARROW_VIEWPORT` the
// whole city is in frame, so nothing is ever off it to point at and there is no pan to save. The
// arrows keep `pointer-events: none` there, which is also what keeps them out of the way of the
// map — an arrow lives at the frame edge, over the canvas, and while it is inert every press on it
// goes to `attachDragPan` and the route band as before.
//
// At z-index 18 it sits *under* the HUD (the pedals and the pause button are 20 and 24), so a thumb
// sliding onto the brake still gets the brake. What it does outrank is the canvas underneath it,
// route band included: a press within ~25px of an arrow belongs to the arrow. That is the cost, and
// it is paid twice — the band is already hardest to grab out at the frame edge, and a *swipe* that
// starts on an arrow does not pan the map either, because a touch pointer is captured to the element
// it landed on and the canvas never sees the rest of the gesture. Four 51px squares against a whole
// frame of map, and the swipe is still there one thumb-width away.
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

// The arrow's art, wrapped so the press dip has something of its own to scale. The wrapper is
// what moves: the arrow div's `transform` is written from JS every frame (the clamp point and the
// rotation), and the individual `scale` property composes *after* that `translate(-50%, -50%)` —
// so scaling the div would scale it about a point half a box away from its centre and the arrow
// would slide as it dipped. The span carries no transform of its own, so its origin is its middle.
// `pointer-events: none` on both, in the stylesheet, so the press has no inner node to hit-test
// onto and `event.target` is the div the listener is on.
const ARROW_SVG = '<span><svg viewBox="-16 -16 32 32"><polygon points="13,0 -9,-10 -4,0 -9,10" /></svg></span>';

// How far a finger may smear and still be a tap, in px. The same 8 as `PAN_SLOP` in game/camera.js
// — every selection on a phone lands with 2-4px of travel — and it is here for a reason that is
// specific to a pointer the element *keeps*: see the press handler below.
const TAP_SLOP = 8;

/**
 * @param onTap     (x, z) => void — a press on an arrow, handed the world point it was aiming at.
 *                  main.js glides the camera there. Omit it and the arrows stay decorative.
 * @param tappable  whether a press does anything *right now* — `isNarrow`, re-read every frame so
 *                  a resize flips it without a reload, the same way every other narrow-only
 *                  affordance is gated. See the header.
 */
export function createFarePointers({ camera, pinLocation, viewport = null, onTap = null,
  tappable = () => false }) {
  const host = document.getElementById('fare-pointers');
  if (!host) return { update: () => {} };

  readSafeInsets();
  window.addEventListener('resize', readSafeInsets);

  const projected = new THREE.Vector3();

  // Whether a press on an arrow does anything, and the single source for it: the same boolean sets
  // the host class the stylesheet reads (which is what actually lets a thumb land on one) and
  // guards the handler below. Two copies of this rule is how one of them ends up stale.
  let interactive = false;

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
    // `atX`/`atZ` rather than the point `pinLocation` handed back: one pooled div answers for a
    // different fare from one frame to the next, so the destination has to be read at press time.
    // A listener closed over whoever held the slot when it was created would ride the camera to a
    // rider who was picked up two blocks ago.
    const arrow = { el, painted: null, dropoff: null, atX: 0, atZ: 0, aimed: false };
    // Not a `<button>`, and the host keeps its `aria-hidden`: a focusable control inside an
    // aria-hidden subtree is one a keyboard can reach and a screen reader cannot describe (the
    // same trap `taxifinder.js` spends a `disabled` on avoiding). This is a redundant affordance —
    // the rider's own pin is still on the map, and the arrow only exists on a viewport where the
    // map can be dragged — so it stays a decoration that happens to answer a thumb.
    //
    // A `pointerdown`/`pointerup` pair rather than `click`, for two reasons that both come back to
    // this being a bare div on an iPhone. WebKit only synthesises a click on a non-interactive
    // element that passes its own "is this clickable" test — a listener plus `cursor: pointer`
    // satisfies it today, but it is a heuristic and this is the one platform the game has to work
    // on. And the pair is explicit about what a press *is*: the pointer is the whole gesture, and
    // nothing here has to guess.
    //
    // The pairing is load-bearing in both directions. A bare `pointerup` would answer a drag that
    // began on the map and happened to finish over an arrow. And the travel test is not belt and
    // braces: a touch pointer is *implicitly captured* to the element its `pointerdown` landed on,
    // so a finger that presses an arrow and then slides away still delivers its `pointerup` here,
    // and without the slop check sliding off an arrow would ride the camera anyway — the one
    // gesture a player makes to mean "no".
    //
    // The dip that reports the press is a class rather than `:active`, and here that is not the
    // usual reason (a press sliding between two controls — see the pedals in index.html) but the
    // same implicit capture: `:active` stays pinned to this element for as long as the finger is
    // down, wherever it has gone, so an arrow abandoned mid-press would sit there looking pressed
    // and then do nothing on release. `hold(false)` on the frame the travel passes the slop makes
    // the dip mean exactly what the release will do.
    let press = null;
    const hold = (on) => el.classList.toggle('is-held', on);
    el.addEventListener('pointerdown', (event) => {
      // Single finger only, the same rule the map's drag and the route band both keep: a second
      // touch belongs to a pinch.
      press = event.isPrimary ? { x: event.clientX, y: event.clientY } : null;
      hold(Boolean(press));
    });
    const travelled = (event) => press
      && Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP;
    el.addEventListener('pointermove', (event) => { if (travelled(event)) hold(false); });
    el.addEventListener('pointerup', (event) => {
      // Read *before* the press is cleared: `travelled` measures against `press`, so nulling it
      // first turns the slop test into a constant false and every abandoned press acts.
      const from = press;
      const slid = travelled(event);
      press = null;
      hold(false);
      if (!from || !event.isPrimary || slid) return;
      if (!interactive || el.hidden || !arrow.aimed || !onTap) return;
      onTap(arrow.atX, arrow.atZ);
    });
    el.addEventListener('pointercancel', () => { press = null; hold(false); });
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
      arrow.aimed = false;
      return false;
    }
    arrow.el.hidden = false;
    arrow.atX = world.x;
    arrow.atZ = world.z;
    arrow.aimed = true;

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
   * Take an arrow down, and with it whatever it was aiming at — a pooled div that kept its last
   * destination could answer a press with a pan to a fare that has expired.
   */
  function hide(arrow) {
    arrow.el.hidden = true;
    arrow.aimed = false;
  }

  /**
   * @param aboard   the fare in the car, or null — its drop-off gets the large arrow, and while it
   *                 is set it gets the *only* arrow (see the header)
   * @param waiting  the fares still on the kerb; one arrow each, at their own corner, and ignored
   *                 entirely while `aboard` is riding
   * @param colorOf  `fares.colorOf`, so every arrow reads its clock off the one urgency scale
   */
  function update(aboard, waiting = [], colorOf = null) {
    let slot = 0;

    // Re-read every frame, not latched at construction: a rotation or a resized window crosses
    // NARROW_VIEWPORT without a reload, and the arrows have to follow it the way the pan and the
    // follow-cams do.
    const canTap = Boolean(onTap) && tappable();
    if (canTap !== interactive) {
      interactive = canTap;
      host.classList.toggle('can-tap', canTap);
    }

    if (aboard && aboard.stage === 'riding') {
      const c = pinLocation(aboard.target.i, aboard.target.j);
      aim(arrowAt(slot), c, colorOf ? colorOf(aboard) : null, true);
      slot += 1;
    }

    // One seat, one arrow: with someone aboard the drop-off above is the whole of it — see the
    // header. `slot` is left at 1, so the sweep at the bottom hides every other arrow in the pool.
    if (aboard && aboard.stage === 'riding') {
      for (let i = slot; i < arrows.length; i++) hide(arrows[i]);
      return;
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

    for (let i = slot; i < arrows.length; i++) hide(arrows[i]);
  }

  return { update };
}
