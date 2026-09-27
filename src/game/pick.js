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
 * `claims` is asked rather than assumed so a tap the building would refuse — the depot with nothing
 * to repair — keeps the rider's generous margin instead of turning into a tap on nothing.
 *
 * @param getTargets () => Object3D[]  candidate roots, re-evaluated on every click so the set can
 *                                     follow game state
 * @param onPick     (kind, hit) => void  kind is null when nothing pickable was under the cursor
 * @param shouldIgnore () => boolean   true for a click that closed out a camera drag
 * @param claims     (kind) => boolean  whether a drawn surface of this kind outranks a stand-in in
 *                                      front of it right now. See above.
 */
export function createPicker(
  camera, domElement, getTargets, onPick, shouldIgnore = () => false, claims = () => false,
) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  domElement.addEventListener('click', (event) => {
    if (shouldIgnore()) return;
    const rect = domElement.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);

    const picked = choosePick(raycaster.intersectObjects(getTargets(), true), claims);
    if (picked) onPick(picked.kind, picked.hit);
    else onPick(null, null);
  });
}

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
