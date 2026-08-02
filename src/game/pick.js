import * as THREE from 'three';

/**
 * Click picking against tagged objects.
 *
 * The camera is fixed, so there is no drag gesture to disambiguate from a tap — a plain click
 * handler is enough. (city-lab's `attachCameraControls` bound pointerdown to drag-panning, which
 * is exactly why it isn't used here.)
 *
 * Objects opt in by setting `userData.pickable` to a string kind. The ray walks up each hit's
 * ancestors, so an invisible oversized hit box can stand in for fiddly visible geometry — which
 * matters a lot when the whole city is on screen and the taxi is a few pixels across.
 *
 * @param getTargets () => Object3D[]  candidate roots, re-evaluated on every click so the set can
 *                                     follow game state
 * @param onPick     (kind, hit) => void  kind is null when nothing pickable was under the cursor
 */
export function createPicker(camera, domElement, getTargets, onPick) {
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const kindOf = (object) => {
    for (let node = object; node; node = node.parent) {
      if (node.userData?.pickable) return node.userData.pickable;
    }
    return null;
  };

  domElement.addEventListener('click', (event) => {
    const rect = domElement.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);

    for (const hit of raycaster.intersectObjects(getTargets(), true)) {
      const kind = kindOf(hit.object);
      if (kind) {
        onPick(kind, hit);
        return;
      }
    }
    onPick(null, null);
  });
}
