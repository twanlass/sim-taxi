import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';
import { nearestJunction } from '../city/grid.js';
import { planOrigin } from './route.js';
import { routePath, nearestOnPath, HEAD_GAP } from './routeline.js';
import { tap as haptic } from '../util/haptics.js';

/**
 * Drag the route band to re-route the taxi.
 *
 * Once a destination is set the route band is the one thing on screen that says what the taxi is
 * about to do — and until now it was the only part of the interface the player could not touch.
 * Tapping a rider says *where*; this says *which way*, which is the question the player is
 * actually asking when they can see a queue building on the road the band is about to take.
 *
 * The gesture is Flight Control's, and the model underneath is a **single waypoint**: press on the
 * band, drag sideways, and the junction under your finger becomes somewhere the route has to pass
 * through. `findRouteVia` plans origin → waypoint → destination in one step and the band redraws
 * on the same frame, so the route is re-planned continuously rather than sketched by hand and
 * fitted to roads on release. Everything else about the trip is untouched: the destination, the
 * fare's clock, `directed`.
 *
 * **Snapping to a junction rather than tracing the finger** is what makes it a routing gesture
 * rather than a drawing one. The player is not laying down a path — there is no freehand line the
 * city could honour — they are naming a corner to go via, and the router still answers with a
 * legal drive: right-hand lanes, no U-turns, arterials preferred, closed streets avoided. A drag
 * of half a block does nothing until it crosses into the next junction's cell, and then the whole
 * detour appears at once, which reads as the route *committing* rather than as paint smearing.
 *
 * Three things are deliberate about the feel:
 *
 * - **It re-plans from where the taxi is now, every frame.** The car does not stop while you drag
 *   — its clock is running — so a waypoint chosen four seconds ago has to be re-stitched onto a
 *   route that starts a block further on. `planOrigin` is what makes that safe mid-turn.
 * - **The waypoint retires when it is reached** rather than at the end of the gesture. Once the
 *   taxi is heading at it there is nothing left to detour around, and re-planning through a
 *   junction the car has driven past would answer with a lap back to it.
 * - **Release commits what is drawn.** There is no confirm and no revert: the band has been
 *   showing the real route the whole way, and a gesture that undid itself on release would make
 *   every frame of that a lie.
 *
 * And on a phone the gesture also answers in the hand. Two haptics, both no-ops on the web (see
 * `util/haptics.js`), and both gated the way every other one in this game is — on the thing they
 * report having actually happened:
 *
 * - **`grab`** the moment a press takes hold. This is the one piece of feedback the gesture could
 *   not previously give a thumb, because the thumb is *on top of* the flourish that announces it:
 *   the handle lands under the fingertip and the band's bloom is centred on the same square
 *   centimetre of glass the finger is covering. A player who cannot see either has no way to tell
 *   a grab from a tap that missed the band by four pixels, and the difference is whether the next
 *   80 pixels of travel re-route the taxi or pan the city.
 * - **`snap`** every time the route re-plans through a junction it wasn't using. The detour appears
 *   all at once when the finger crosses a cell boundary — that is the whole point of snapping to a
 *   junction rather than tracing the finger — so there is a discrete moment to report, and it is
 *   the moment the player is dragging to find. It is deliberately *not* fired per frame, per
 *   pointermove, or per cell crossing: only when a re-plan is accepted **and** comes back with a
 *   different route (`routeSig` below), so a finger sliding across a junction the band already ran
 *   through stays silent rather than buzzing about a band that did not move.
 *
 * There is no rate limit on `snap` and it does not need one. A junction cell is `PITCH` = 20 world
 * units, ~154px at play zoom, so even a fast flick across the screen crosses ~5 of them; the
 * re-plans past `MAX_VIA_DETOUR` are refused and silent; and the fire is once per frame at most,
 * because the decision lives in `update`. Every buzz is one route the player actually caused.
 *
 * ## Double tap to throw the detour away
 *
 * The gesture above has one failure mode, and it is not a bug in it: the band lies across the
 * road, the grab radius is a fingertip wide, and *panning the map is a drag on the same surface*.
 * A player reaching past the taxi to see what is coming up therefore lands on the band about as
 * often as they mean to, and the city pans nowhere while the route quietly grows a loop. The
 * gesture is doing exactly what it says — a press on the band belongs to the band — but the player
 * did not ask for a detour and now has to drag the waypoint back onto a route they can no longer
 * see the shape of.
 *
 * **A double tap on the band re-plans it the shortest way**, with no waypoint at all: the same
 * route the taxi would have been given if nothing had ever been dragged. Same destination, same
 * fare, same clock, same `directed` — this touches only the *way there*, exactly like the drag it
 * undoes.
 *
 * It is an undo without being an undo stack. There is no history here and there should not be: the
 * route has one canonical shape (whatever `findRoute` answers with from where the car is *now*)
 * and every detour is a departure from it, so "put it back" has one meaning however many waypoints
 * the player dragged through on the way. Reaching for a stack instead would have to decide what a
 * step even is on a route being re-planned every frame of a gesture, and would restore a shortest
 * path computed from a junction the taxi drove past ten seconds ago.
 *
 * Three things follow from the second tap being an ordinary press on the band:
 *
 * - **It opens a grab like any other press**, handle and bloom and all, so a reset can be followed
 *   straight into a fresh drag without lifting. That is the recovery the gesture is for: throw the
 *   accident away, then aim properly.
 * - **It answers on the press, not the release.** Everything else here does (the grab, the snap),
 *   and a reset held back until the finger lifts would leave the band sitting in the wrong shape
 *   under a thumb that has already asked twice.
 * - **It swallows the click**, the same way a drag does. Two taps in a third of a second on a band
 *   that runs *into* the drop-off ring would otherwise be a reset and a tap on the pin underneath.
 *
 * The buzz is `pick` rather than a new event: the thing that just happened is a tap that re-aimed
 * the taxi, which is what `pick` has always meant. One buzz per press, though — a reset that fired
 * `grab` for the press *and* `pick` for the re-plan would put two transients 30ms apart, which a
 * thumb reads as one smeared buzz and not as two events. So the second press fires whichever of
 * the two is the truer account of it: `pick` when the route actually changed, and the plain `grab`
 * when it did not, because a double tap on a route that was already the shortest way is a press
 * that took hold of the band and nothing more.
 */

// How close a finger has to land, in world units. The band itself is 1.7 wide, so this is mostly
// slop — deliberately. At play zoom 1 world unit is ~7.7px, so 6 units is a ~46px-wide target
// centred on the paint, which is a fingertip. Any smaller and the gesture is a desktop-only
// feature that mobile players discover by accident.
export const GRAB_RADIUS = 6;

// Pixels of travel before a grab counts as a drag. Matched to camera.js's `PAN_SLOP`, which is
// the same judgement about the same finger: below it, every selection on a phone lands with a few
// pixels of travel and a gesture that answered all of it would twitch the route on every tap.
const GRAB_SLOP = 8;

// How long the second tap has, in milliseconds. 320 rather than something more generous because
// the *first* tap of a double tap is a live gesture in its own right here — it takes hold of the
// band — so a long window would leave a deliberate grab-pause-grab (press, look at the map, press
// again to start dragging) reading as a reset. Comfortably past the ~300ms platforms themselves
// use for a double tap, and well under the time it takes to decide to do anything.
const DOUBLE_TAP_MS = 320;

// And how far apart the two may land, in pixels. Both have to hit the band anyway, so this is not
// about aim — it is about a band that runs the length of the screen: two presses a hundred pixels
// apart on the same route are two grabs at two different places, not one gesture. A fingertip's
// worth of drift, matched to nothing else on purpose (GRAB_SLOP is about a single press moving,
// which is a different question).
const DOUBLE_TAP_SLOP = 32;

// --- The handle -------------------------------------------------------------
//
// A ring on the road under the finger, and the one thing here that is a new object rather than a
// lift of an existing one. The band's own bloom says "held"; the ring says "held *here*, and this
// point is what moves" — which the bloom cannot, being a soft gradient with no edge to aim at.
//
// Sized in world units like everything else that lives on the road: 2.4 is ~18px of radius at play
// zoom, so the ring reads as a grommet punched in the band rather than as a marker standing on it.
const HANDLE_R = 2.4;
// Above the band (0.03) and still under the cars (ROAD_Y = 0.04).
const HANDLE_Y = 0.035;

// Lands oversized and settles, the same shape as the select pop: the overshoot is what makes it
// read as arriving under the finger rather than fading up.
const HANDLE_IN = 0.14;
const HANDLE_IN_SCALE = 1.7;
// Letting go throws it open and fades it — a ring that simply vanished would read as the gesture
// having been dropped rather than taken.
const HANDLE_OUT = 0.22;
const HANDLE_OUT_SCALE = 2.1;

// A slow breathe while held, so the handle is visibly live under a finger that is not moving.
const HANDLE_BREATHE_HZ = 1.6;
const HANDLE_BREATHE = 0.06;

function createHandle(scene) {
  const group = new THREE.Group();
  group.position.y = HANDLE_Y;
  group.renderOrder = 5;                 // over the band (4), under the fare rings (7-9)
  group.visible = false;

  // A dark core with a bright rim, and the dark half is the load-bearing one.
  //
  // The first build was an additive yellow ring and a dot, on the reasoning that everything else
  // lying on this road is additive. It vanished: it sits at the centre of the band's own grab
  // bloom, which is the brightest thing in the frame, and adding light to a blown highlight
  // changes nothing. This is the diamond's black rim again — a marker cannot outline itself in
  // the colour it is standing on.
  //
  // So the handle *subtracts* first. A darkened disc punches a hole in the glow, and the rim
  // reads against that hole rather than against the road. It comes out as a grommet in the paint,
  // which is what the thing actually is.
  const core = unlitMaterial({
    // Black, for the same reason the crystal's rim is: this shape spends its whole life sitting on
    // the band, and the band is painted in the fare's clock — a hue that walks from green to red
    // over a run. No colour survives being drawn on all four of those; an absence of colour does.
    color: new THREE.Color(0x000000),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const rim = unlitMaterial({
    color: new THREE.Color(PALETTE.routeLine),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const flat = (geometry, material) => {
    geometry.rotateX(-Math.PI / 2);
    return new THREE.Mesh(geometry, material);
  };
  const hole = flat(new THREE.CircleGeometry(HANDLE_R * 0.92, 28), core);
  const edge = flat(new THREE.RingGeometry(HANDLE_R * 0.92, HANDLE_R * 1.2, 28), rim);
  const pip = flat(new THREE.CircleGeometry(HANDLE_R * 0.34, 16), rim);
  group.add(hole, edge, pip);
  scene.add(group);

  // The hole is a shade over the road rather than a black disc: at full strength it read as a
  // manhole cover, and the point is to knock the glow back, not to paint on the tarmac.
  const CORE_ALPHA = 0.55;

  let phase = 'off';       // 'off' | 'in' | 'held' | 'out'
  let t = 0;
  let elapsed = 0;

  return {
    group,
    moveTo(x, z) {
      group.position.x = x;
      group.position.z = z;
    },
    grab(x, z) {
      group.position.x = x;
      group.position.z = z;
      group.visible = true;
      phase = 'in';
      t = 0;
    },
    release() {
      if (phase === 'off') return;
      phase = 'out';
      t = 0;
    },
    update(dt) {
      elapsed += dt;
      if (phase === 'off') return;
      t += dt;

      let scale = 1;
      let opacity = 1;
      if (phase === 'in') {
        const k = Math.min(1, t / HANDLE_IN);
        scale = HANDLE_IN_SCALE + (1 - HANDLE_IN_SCALE) * (1 - (1 - k) * (1 - k));
        opacity = k;
        if (k >= 1) phase = 'held';
      } else if (phase === 'out') {
        const k = Math.min(1, t / HANDLE_OUT);
        scale = 1 + (HANDLE_OUT_SCALE - 1) * k;
        opacity = 1 - k;
        if (k >= 1) { phase = 'off'; group.visible = false; }
      }
      if (phase === 'held') {
        scale = 1 + HANDLE_BREATHE * Math.sin(elapsed * HANDLE_BREATHE_HZ * Math.PI * 2);
      }

      group.scale.setScalar(scale);
      rim.opacity = opacity;
      core.opacity = opacity * CORE_ALPHA;
    },
  };
}

/**
 * @param camera      the city camera, for projecting a pointer onto the road
 * @param domElement  the canvas, for its client rect
 * @param scene       where the handle mesh lives
 * @param routeLine   the band, for the grab flourish
 * @param getCar      () => the taxi
 * @param reroute     (via | null) => boolean — re-plan through this junction, false if refused.
 *                    `main.js` implements it as `routeTo(pendingTarget, { via })`, so everything
 *                    about consuming a route (the `routeConsumed` reset, the parked release) is
 *                    handled in exactly one place. **`null` is the shortest way** — no waypoint,
 *                    which is what the double-tap reset asks for; it falls through `routeTo` to a
 *                    plain `findRoute` (or, on a burger run, to the `findRouteOnto` that carries
 *                    the drive-through's lane). One callback, because a reset is a re-plan.
 * @param canGrab     () => boolean — false when there is nothing to drag or nobody to drag it
 */
export function createPathDrag({
  camera, domElement, scene, routeLine, getCar, reroute, canGrab = () => true,
}) {
  const handle = createHandle(scene);
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();

  // { x, y, downX, downY, moved, at: {x, z}, via, snapped, reset }
  let grab = null;
  // True for a gesture the band has already answered by itself — a drag, or a double-tap reset.
  // Read back as `didDrag()`; see `letGo`.
  let answered = false;
  let clearAnswered = null;
  // The last press that took hold of the band and never became a drag, as `{ t, x, y }` — the
  // first half of a double tap, if a second one lands in time. Recorded on release rather than on
  // the press, because a press that turns into a drag is not a tap and must not arm a reset: a
  // player who drags a waypoint, lifts, and presses again to adjust it is mid-gesture, not asking
  // for the thing they just drew to be thrown away.
  let lastTap = null;

  /** Where a pointer is pointing, on the road. */
  function groundAt(clientX, clientY) {
    const rect = domElement.getBoundingClientRect();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(ground, hit) ? { x: hit.x, z: hit.z } : null;
  }

  /**
   * The planned route, as a string to compare against another frame's.
   *
   * `car.route` is a list of directions out of each junction, which is all the `snap` haptic needs:
   * two plans that differ anywhere differ here, and it costs a join rather than a path rebuild.
   *
   * Only ever compared across a single `reroute` call within one frame. Across frames it would
   * shrink on its own as the car consumes legs, which is a change with nothing to do with the
   * waypoint the player is dragging.
   */
  const routeSig = (car) => car.route.join(',');

  /** The band as it stands this frame, or null if there isn't one. */
  function currentPath() {
    const car = getCar();
    if (!car) return null;
    const path = routePath(car, car.route);
    return path.length < 2 ? null : path;
  }

  /**
   * Would a press here take hold of the band? Returns the point it would take hold *of* —
   * `{ dist, along, x, z }` from `nearestOnPath` — or null.
   *
   * Exposed as well as used internally because it is the one question `tools/smoke.mjs` has to be
   * able to ask: the camera-pan checks there need a drag origin that is *not* on the band, and a
   * pan check that quietly started re-routing the taxi instead would go on passing while testing
   * something else entirely.
   */
  function hitTest(clientX, clientY) {
    if (!canGrab()) return null;
    const path = currentPath();
    if (!path) return null;
    const point = groundAt(clientX, clientY);
    if (!point) return null;

    const near = nearestOnPath(path, point.x, point.z);
    if (!near || near.dist > GRAB_RADIUS) return null;
    // Nothing is painted for the first HEAD_GAP units — see routeline.js — and on a short route
    // that gap is squeezed down with the rest of the fades, so the guard has to squeeze too.
    if (near.along < Math.min(HEAD_GAP, near.total * 0.2)) return null;
    return { ...near, world: point };
  }

  function letGo() {
    if (!grab) return;
    routeLine.setGrab(false);
    handle.release();
    // A press that never crossed the slop is a tap, and a tap on the band is half of a reset. Kept
    // from the *down* point rather than from wherever the finger drifted to, so the two halves are
    // measured from the same kind of thing.
    lastTap = grab.moved < GRAB_SLOP && !grab.reset
      ? { t: performance.now(), x: grab.downX, y: grab.downY }
      : null;
    // Same trick as `attachDragPan`'s `didPan`: the browser synthesises a click straight after
    // pointerup, in the same task, and a drag that finished over a rider must not also dispatch
    // the taxi at them. Cleared on the next task so a genuine tap a moment later still lands.
    if (answered) clearAnswered = setTimeout(() => { answered = false; }, 0);
    grab = null;
  }

  // On `window`, in the capture phase, so this runs before the canvas's own pointerdown listeners
  // — `attachDragPan`'s in particular. Listener order within one element is registration order
  // whatever the capture flag says, so being on an ancestor is the only ordering that holds
  // regardless of which module happens to be constructed first. A grab then stops propagation,
  // and the pan never starts: a press that lands on the band belongs to the band.
  window.addEventListener('pointerdown', (event) => {
    // Single finger only, for the same reason panning is: a second touch belongs to a pinch.
    if (!event.isPrimary || grab) return;
    if (event.target !== domElement) return;

    const near = hitTest(event.clientX, event.clientY);
    if (!near) return;

    // Is this the closing half of a double tap? Decided before anything else, because the answer
    // changes what this press *is* — and it is spent either way: a press only ever arms the next
    // reset by going back through `letGo` as a tap of its own.
    const isDouble = Boolean(lastTap)
      && performance.now() - lastTap.t < DOUBLE_TAP_MS
      && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < DOUBLE_TAP_SLOP;
    lastTap = null;

    grab = {
      x: event.clientX, y: event.clientY, downX: event.clientX, downY: event.clientY,
      moved: 0, at: near.world, via: null, snapped: false, reset: isDouble,
    };
    answered = false;
    clearTimeout(clearAnswered);
    routeLine.setGrab(true, near.along);
    handle.grab(near.x, near.z);
    // The press is spoken for. Without this the camera pans out from under the drag on a phone.
    event.stopPropagation();

    // Throw the detour away: re-plan with no waypoint at all, from where the taxi is now. Done
    // here rather than in `update` because a reset is one discrete answer to one press, where the
    // drag's re-plan is a standing instruction that has to be re-stitched every frame — and a
    // standing reset is the exact shape the frame loop must not take (see `main.js`: a diversion
    // re-applied every frame clears `routeConsumed` forever and the taxi sits re-deciding the same
    // junction). Nothing keys off it afterwards; `grab.via` is null, so `update` leaves it alone
    // unless the finger goes on to drag somewhere.
    if (isDouble) {
      const car = getCar();
      const before = routeSig(car);
      // A refusal leaves the route exactly as it was, the same as a refused waypoint does.
      const changed = reroute(null) && routeSig(car) !== before;
      // The destination is unchanged, so `pendingTarget`'s identity is too and the band would
      // redraw in a new shape with no animation at all. Ask for the rollout explicitly.
      if (changed) routeLine.replaySweep();
      // Swallow the click this press is about to synthesise, whether or not the route moved: what
      // the player made was a gesture, and the band runs *through* other people's tap targets on
      // its way into the drop-off ring. A reset that also dispatched the taxi at whatever pin the
      // second press happened to land on would abandon the fare it was trying to help with — and
      // "the route was already the shortest way" is no comfort, because it is exactly the case the
      // player cannot see before they act.
      answered = true;
      // One press, one buzz, naming what this press actually did. Two transients 30ms apart read
      // as one smeared buzz rather than as two events, so the `grab` is the *fallback* here rather
      // than an addition: a double tap on a route that was already direct is a press that took
      // hold of the band and nothing more.
      haptic(changed ? 'pick' : 'grab');
      return;
    }

    // Last, and after `hitTest`, so it fires only on a press the band actually took — and so that
    // nothing about the feedback can come between the grab and the propagation stop that makes it
    // one. A press four pixels off the band falls out above and pans the city in silence, which is
    // exactly the distinction the buzz exists to draw.
    haptic('grab');
  }, { capture: true });

  window.addEventListener('pointermove', (event) => {
    if (!grab || !event.isPrimary) return;
    grab.moved += Math.hypot(event.clientX - grab.x, event.clientY - grab.y);
    grab.x = event.clientX;
    grab.y = event.clientY;
    // Below the slop it is still a tap on the band: the flourish has fired (which is the answer to
    // "can I drag this?"), but the route has not been touched.
    if (grab.moved < GRAB_SLOP) return;
    answered = true;

    const point = groundAt(event.clientX, event.clientY);
    if (!point) return;
    grab.at = point;

    // A waypoint is only news when it crosses into another junction's cell; between those the
    // route is unchanged and only the handle moves. `update` re-plans regardless, since the taxi
    // keeps driving, so this is about not thrashing rather than about correctness.
    const via = nearestJunction(point.x, point.z);
    if (!grab.via || grab.via.i !== via.i || grab.via.j !== via.j) {
      grab.via = via;
      // A fresh waypoint is a fresh haptic decision, taken once in `update` when the re-plan it
      // asks for either lands or doesn't. Cleared here rather than there because this is the only
      // place that knows the waypoint is *new*.
      grab.snapped = false;
    }
  }, { capture: true });

  window.addEventListener('pointerup', letGo, { capture: true });
  window.addEventListener('pointercancel', letGo, { capture: true });

  return {
    /**
     * Runs before `routeLine.update` in the frame loop, so the band drawn this frame is the one
     * the handle and the bloom are placed against.
     */
    update(dt) {
      handle.update(dt);
      if (!grab) return;

      // The run ended, or the fare did, mid-gesture.
      if (!canGrab()) { letGo(); return; }

      if (grab.via) {
        const car = getCar();
        const from = planOrigin(car);
        // Reached: the car is heading at the waypoint, so there is nothing left to route around
        // and the plan from here on is simply the plan. Retiring it here rather than on release is
        // what stops a still-held drag from asking for a lap back to a junction already passed.
        if (from.i === grab.via.i && from.j === grab.via.j) grab.via = null;
        // A refusal — an unroutable waypoint, or a detour past the cap — leaves the route exactly
        // as it was, so the band holds still and the drag simply feels like it hit a wall. It stays
        // silent too, and `snapped` is left false so a waypoint the cap refuses now can still buzz
        // if the car driving on brings it back inside the cap.
        else {
          const before = routeSig(car);
          const taken = reroute(grab.via);
          // Once per waypoint, not once per frame: `reroute` re-plans on every frame of the drag
          // because the taxi keeps driving, and all but the first of those return the same band.
          if (taken && !grab.snapped) {
            grab.snapped = true;
            // And only if the band moved. The first waypoint of a gesture is usually a junction
            // the route already ran through — the finger pressed *on* the band, so the nearest
            // junction to it tends to be one of its own — and a buzz there would announce a detour
            // that isn't on screen, immediately after the `grab` that already fired.
            if (routeSig(car) !== before) haptic('snap');
          }
        }
      }

      // Both the handle and the bloom ride the *new* band rather than the finger, so the gesture
      // reads as pulling a string that is snapping onto roads rather than as dragging a cursor
      // the road happens to follow.
      const path = currentPath();
      if (!path) return;
      const near = nearestOnPath(path, grab.at.x, grab.at.z);
      if (!near) return;
      routeLine.setGrab(true, near.along);
      handle.moveTo(near.x, near.z);
    },

    hitTest,
    /**
     * Put the handle down at a world point with no pointer behind it. **Shot mode only.** The
     * flourish exists only while a finger is on the band and a screenshot has no finger, so
     * without this the one thing the shot is for would be missing from it.
     */
    stage(x, z) { handle.grab(x, z); },
    /**
     * True for the click the browser synthesises after a gesture the band has already answered —
     * a drag, or a double-tap reset. Both mean the same thing to a caller: whatever the finger
     * finished over, it was not being tapped. See `letGo`.
     */
    didDrag: () => answered,
    /** True while a finger is on the band. Used to keep the camera out of the gesture. */
    isGrabbing: () => grab !== null,
    /** The junction the route is currently being forced through, or null. */
    via: () => grab?.via ?? null,
  };
}
