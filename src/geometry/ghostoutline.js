import * as THREE from 'three';
import { color } from '../palette.js';

// A ghost outline: the silhouette of a mesh, traced as a rim and drawn ONLY on pixels where the
// mesh is hidden behind other geometry. The taxi wears one so it can never disappear behind a
// tower — and because the test runs per fragment, a half-hidden car gets exactly a half outline.
//
// It is the pin's inverted hull (see geometry/marker.js) turned inside out, in two passes:
//
//   1. A *mask* pass re-draws the mesh's own geometry with `colorWrite: false` and no depth test,
//      stamping ref 1 into the stencil buffer across the mesh's full screen footprint — occluded
//      or not. This is what keeps the interior hollow, so the result is a traced outline rather
//      than a filled ghost.
//   2. A *hull* pass draws the geometry inflated by RIM world units, back faces only, with
//      `depthFunc: GreaterDepth` — the reverse of the usual test, so a fragment renders only where
//      something already in the depth buffer sits *in front of* it — and a stencil test of
//      "not the mask", so the rim never paints over the mesh's own visible pixels.
//
// Where the mesh is visible, the depth buffer behind the rim holds road or far buildings, the
// reversed test fails everywhere, and the hull costs nothing. Where an occluder covers part of
// the car, exactly those rim fragments pass. No render targets, no post pass — but it does need
// the renderer created with `stencil: true` (three r163+ defaults it off), which main.js does.
//
// Both passes are flagged `transparent` purely to land in three's transparent queue, which draws
// after every opaque object regardless of renderOrder — the depth buffer has to be complete
// before pass 1 runs. Within that queue renderOrder sorts first, so these two run dead last.
export const GHOST_MASK_ORDER = 9990;
export const GHOST_RIM_ORDER = 9991;

// Rim thickness in world units, before the taxi group's 1.18 scale. At play zoom 1 world unit
// ≈ 7.7px, so 0.3 renders as a ~2.7px trace — bold enough to find at a glance, thin enough to
// still read as an outline of the car rather than a blob wearing its shape.
const RIM = 0.3;

// The stencil ref shared by mask and rim. Nothing else in the scene touches the stencil buffer.
const GHOST_REF = 1;

/** Ghost meshes are pure paint — the picker must see straight through them. */
const noRaycast = () => {};

// How far the hull's underside is pulled back UP after inflation, above the part's own base.
// Inflating downward as well pushed the hull under the road, and the road then counted as an
// occluder — a permanent yellow smear hugging the bumper of a fully visible car. The bottom edge
// faces away from this camera anyway, and nothing at road level ever hides the taxi.
const FLOOR_MARGIN = 0.15;

/**
 * Inflate a geometry by `rim` world units on every side, scaling about its own bounding-box
 * centre. Scaling about the origin instead would shift a part built off-centre (the taxi body is
 * translated up its own height) and push the hull off the mesh it wraps. The underside is then
 * clamped back up to FLOOR_MARGIN above the part's own base — see above.
 */
function inflatedGeometry(geometry, rim) {
  const inflated = geometry.clone();
  inflated.computeBoundingBox();
  const centre = inflated.boundingBox.getCenter(new THREE.Vector3());
  const size = inflated.boundingBox.getSize(new THREE.Vector3());
  const baseY = inflated.boundingBox.min.y;   // the part's own base, before inflation
  inflated.applyMatrix4(
    new THREE.Matrix4()
      .makeTranslation(centre.x, centre.y, centre.z)
      .multiply(new THREE.Matrix4().makeScale(
        (size.x + 2 * rim) / size.x,
        (size.y + 2 * rim) / size.y,
        (size.z + 2 * rim) / size.z,
      ))
      .multiply(new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z)),
  );

  // applyMatrix4 has recomputed boundingBox to the inflated extents by now, so clamp against the
  // base captured before the scale.
  const floor = baseY + FLOOR_MARGIN;
  const position = inflated.attributes.position;
  for (let v = 0; v < position.count; v++) {
    if (position.getY(v) < floor) position.setY(v, floor);
  }
  position.needsUpdate = true;
  inflated.computeBoundingBox();
  return inflated;
}

/**
 * Hang a ghost outline off a mesh. The two passes are added as children, so they inherit the
 * mesh's transform — steering, bounce, roll — for free, the same way the pin's hull rides its
 * head. Reusable by design: any per-mesh car (the police cruiser, say) can wear one; the ambient
 * traffic would need an instanced variant sharing the body's instanceMatrix, which doesn't exist
 * yet.
 *
 * @param mesh  the mesh to trace
 * @param rim   outline thickness in the mesh's local units — smaller for small parts like the
 *              roof sign, where the default would double the part's size
 */
export function addGhostOutline(mesh, { rim = RIM } = {}) {
  // Pass 1 — stamp the mesh's screen footprint into the stencil. Shares the parent's geometry:
  // the mask must match the silhouette exactly or slivers of rim leak inside it.
  const mask = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    depthTest: false,          // the footprint is stamped whether the mesh is visible or not
    transparent: true,         // queue placement only — nothing is ever blended
    stencilWrite: true,
    stencilRef: GHOST_REF,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
  }));
  mask.name = 'ghostMask';
  mask.renderOrder = GHOST_MASK_ORDER;
  mask.raycast = noRaycast;
  mesh.add(mask);

  // Pass 2 — the rim. Back faces only: a closed hull's back faces cover the whole silhouette on
  // their own, where drawing both sides would run the blend twice and double the opacity.
  const rimMesh = new THREE.Mesh(inflatedGeometry(mesh.geometry, rim), new THREE.MeshBasicMaterial({
    color: color('taxiGhost'),
    side: THREE.BackSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,          // draw only where something is in front of the car
    stencilWrite: true,                     // enables the test; all ops stay Keep, so no writes
    stencilRef: GHOST_REF,
    stencilFunc: THREE.NotEqualStencilFunc, // ...and never inside the car's own footprint
  }));
  rimMesh.name = 'ghostRim';
  rimMesh.renderOrder = GHOST_RIM_ORDER;
  rimMesh.raycast = noRaycast;
  mesh.add(rimMesh);

  return { mask, rim: rimMesh };
}
