import * as THREE from 'three';

/**
 * Click picking against tagged objects.
 *
 * Still a plain `click` handler, even now that the camera drag-pans. The disambiguation lives in
 * `attachDragPan`, which only counts a press as a drag once it crosses a few pixels of slop and
 * reports that back through `shouldIgnore` — so a tap stays an ordinary click and only a gesture
 * that actually moved the map gets swallowed. (city-lab's `attachCameraControls` bound pointerdown
 * to dragging unconditionally, which is exactly why it isn't used here.)
 *
 * Objects opt in by setting `userData.pickable` to a string kind. The ray walks up each hit's
 * ancestors, so an invisible oversized hit box can stand in for fiddly visible geometry — which
 * matters a lot when the whole city is on screen and the taxi is a few pixels across.
 *
 * **A stand-in yields to a drawn building behind it.** Those oversized hit boxes are nearest-hit
 * like everything else, and a rider waiting on the kerb in front of the depot puts an 11 x 11
 * screen-unit quad over half the building's front — so a tap on the depot's own wall, a fair way
 * from the rider, answered the rider and the depot could not be reached at all while they stood
 * there. The rule is "what you can see under your finger": when the nearest pickable is an
 * invisible stand-in and the first *drawn* surface along the ray belongs to a kind `claims` accepts,
 * that kind wins. The rider's own figure, crystal and disc are drawn and sit in front of the
 * building, so a tap on them still means the rider; only the empty margin of their box gives way.
 * That depends on the crystal and disc being *in the ray* and tagged as the rider's — they live at
 * scene level, outside the rider's group, and once weren't, which sent a tap on a rider at the
 * burger joint through the drive-through (`stampFareMarker` in game/fares.js).
 * `claims` is asked rather than assumed so a tap the building would refuse — the depot with nothing
 * to repair — keeps the rider's generous margin instead of turning into a tap on nothing.
 *
 * **A finger is answered on `pointerup`, not on the `click` iOS synthesises after it.** WebKit
 * withholds that click whenever something it counts as actionable *appears* while the tap is in
 * progress — its content-change heuristic, built for hover menus, reads the tap as "the user
 * hovered and a menu opened" and swallows the click so they can choose from it. This game puts up
 * buttons on its own schedule, and one of them lands on exactly the tap that matters: an edge
 * arrow's pan disarms the taxi-finder chip (game/taxifinder.js), which then fades in `SHOW_DELAY`
 * after the camera lands — which is when the player, now looking at the rider the arrow found,
 * taps them. Reported as "the first tap on the rider fails, the second works", which is that
 * heuristic's signature (the chip is already up for the second, so nothing new appears) — and it
 * does not reproduce in Chromium, which has no such heuristic. The chip is the prime suspect rather
 * than a measured cause, and the fix does not depend on it: pointer events come straight off the
 * touch stream and no heuristic sits
 * between them and the page, which is why the arrows were built on them too
 * (game/farepointers.js). The click that follows a finger's `pointerup`, when WebKit does send one,
 * is then dropped (`CLICK_ECHO_MS`), so one tap is still one pick. A mouse keeps `click`: nothing
 * withholds it, and it is what the headless suite dispatches.
 *
 * @param getTargets () => Object3D[]  candidate roots, re-evaluated on every click so the set can
 *                                     follow game state
 * @param onPick     (kind, hit, ray) => void  kind is null when nothing pickable was under the
 *                                          cursor, and only then is `ray` passed
 * @param shouldIgnore () => boolean   true for a click that closed out a camera drag
 * @param claims     (kind) => boolean  whether a drawn surface of this kind outranks a stand-in in
 *                                      front of it right now. See above.
 */
export function createPicker(
  camera, domElement, getTargets, onPick, shouldIgnore = () => false, claims = () => false,
) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  // The finger path — see the header. The press is recorded on `window` in the capture phase, not
  // on the canvas: a press on the route band is stopped there by game/pathdrag.js, and a plain tap
  // on the band still has to reach whatever pin it runs through, as its click always did.
  // Propagation stops between nodes, not between listeners on one node, so this sees it either way.
  let press = null;
  let fingerAt = -Infinity;
  const win = domElement.ownerDocument?.defaultView;
  win?.addEventListener('pointerdown', (event) => {
    press = event.target === domElement && event.isPrimary && event.pointerType !== 'mouse'
      ? { id: event.pointerId, x: event.clientX, y: event.clientY }
      : null;
  }, { capture: true });
  domElement.addEventListener('pointercancel', () => { press = null; });
  domElement.addEventListener('pointerup', (event) => {
    const from = press;
    press = null;
    if (!from || event.pointerId !== from.id) return;
    // Spent whether or not it picks: the click after it belongs to this tap, and a tap the guards
    // below refused must not get a second chance through it.
    fingerAt = performance.now();
    // A finger that slid is not a tap. iOS would not have sent a click for it either, and on a wide
    // viewport no drag-pan is attached to say so through `shouldIgnore`.
    if (Math.hypot(event.clientX - from.x, event.clientY - from.y) > TAP_SLOP) return;
    pickAt(event);
  });

  domElement.addEventListener('click', (event) => {
    // One lift, one echo: spent here, so a click that is not this finger's is not caught by it.
    const echo = performance.now() - fingerAt < CLICK_ECHO_MS;
    fingerAt = -Infinity;
    if (!echo) pickAt(event);
  });

  function pickAt(event) {
    if (shouldIgnore()) return;
    const rect = domElement.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);

    const picked = choosePick(raycaster.intersectObjects(getTargets(), true), claims);
    if (picked) onPick(picked.kind, picked.hit);
    // A miss still hands over the ray, for the street tap (game/streettap.js) — the one thing that
    // answers a tap on bare road.
    else onPick(null, null, raycaster.ray);
  }
}

// How far a finger may smear and still be a tap, in px — the same 8 as `PAN_SLOP` in
// game/camera.js and `TAP_SLOP` in game/farepointers.js.
const TAP_SLOP = 8;

// How long after a finger's `pointerup` a `click` is taken to be its echo rather than a tap of its
// own. WebKit sends it within a frame or two of the lift (`touch-action` on the canvas turns off
// the double-tap wait); a genuine second tap inside this window has a `pointerup` of its own and
// is answered there, so the window only has to be longer than the echo, not shorter than a tap.
const CLICK_ECHO_MS = 600;

const kindOf = (object) => {
  for (let node = object; node; node = node.parent) {
    if (node.userData?.pickable) return node.userData.pickable;
  }
  return null;
};

// Raycaster does not consult `visible` at all — an invisible hit box and a hidden robber's mask are
// both hit — so "drawn" is asked here: the mesh and every ancestor shown, and a material that renders.
const drawn = (object) => {
  if (object.material?.visible === false) return false;
  for (let node = object; node; node = node.parent) {
    if (!node.visible) return false;
  }
  return true;
};

/**
 * Which of a ray's hits the tap means, as `{ kind, hit }` or null. Pure, so tools/check.mjs can put a
 * rider in front of the depot without a canvas to click. See the stand-in rule at the top.
 */
export function choosePick(hits, claims = () => false) {
  const first = hits.find((h) => kindOf(h.object));
  if (!first) return null;
  const nearest = { kind: kindOf(first.object), hit: first };
  if (drawn(first.object)) return nearest;
  const seen = hits.find((h) => drawn(h.object));
  const kind = seen && kindOf(seen.object);
  if (kind && kind !== nearest.kind && claims(kind)) return { kind, hit: seen };
  return nearest;
}
