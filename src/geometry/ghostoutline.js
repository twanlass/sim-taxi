import * as THREE from 'three';
import { color } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';

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
//
// FOUR tiers, not two, because the nearby ambient cars wear this outline as well — see
// game/carghosts.js. The stencil buffer is never cleared mid-frame, so a mask stamped in an
// earlier tier still hollows a rim resolved in a later one, and the order decides who may take a
// bite out of whom:
//
//   9990  taxi masks stamp
//   9991  taxi rim resolves    — against the taxi's own mask, and nothing else
//   9992  traffic masks stamp
//   9993  traffic rims resolve — against the taxi's mask AND every traffic mask
//
// So a car sliding past the taxi is hollowed by the taxi (it really is behind it), while the
// player's own outline can never be eaten by traffic. Squeezed into two tiers instead, an ambient
// car passing within a couple of units would bite a chunk out of the player's ghost on exactly the
// frame the player most needs it — a 33° camera means two cars at road level only overlap on
// screen during a near miss.
//
// One shared stencil ref across all of them (see GHOST_REF) is load-bearing rather than a
// shortcut: within a tier, one traced car's mask is what stops another's rim painting over its
// visible bodywork.
//
// Trap: three sorts the transparent queue by `groupOrder` *before* `renderOrder`, and groupOrder
// comes from an ancestor Group's own renderOrder. The taxi's ghosts hang under `taxiGroup`;
// nothing sets renderOrder on any Group today, so every groupOrder is 0 and these four sort
// against each other cleanly. Setting `taxiGroup.renderOrder` would silently break that.
export const GHOST_MASK_ORDER = 9990;
export const GHOST_RIM_ORDER = 9991;
export const CAR_GHOST_MASK_ORDER = 9992;
export const CAR_GHOST_RIM_ORDER = 9993;

// Rim thickness in world units, before the taxi group's 1.18 scale. At play zoom 1 world unit
// ≈ 7.7px, so 0.3 renders as a ~2.7px trace — bold enough to find at a glance, thin enough to
// still read as an outline of the car rather than a blob wearing its shape.
const RIM = 0.3;

// The same trace on a vehicle with no group scale (every `outlineVehicle` car): the taxi's 0.3 and
// its wheels' 0.12 *as drawn*, under TAXI_SCALE = 1.18. game/carghosts.js's 0.35 is the same number.
export const VEHICLE_RIM = 0.35;
export const WHEEL_RIM = 0.14;

// The stencil ref shared by mask and rim — and by every ghost in the scene. The only other writer
// is stampGhostMask, which stamps this same ref for the things that fly.
//
// One ref across all of them, deliberately. A rim's rule is "draw where something in the depth
// buffer sits in front of me", so where traced car B stands behind traced car A, B's rim passes
// that test right across A's visible bodywork — and the only thing suppressing it is A's mask
// having stamped this ref there. Per-car refs would put a coloured streak across a fully visible
// car, which is the same failure the taxi's skipped wheels produced. Per-object refs are only
// recoverable with per-bit stencil masks, and stencil state is per-material, so that would mean
// one draw call per ghost — which is the whole thing instancing is here to avoid.
export const GHOST_REF = 1;

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
export function inflatedGeometry(geometry, rim) {
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
 * Pass 1's material — stamps a screen footprint into the stencil and writes nothing else. Split
 * out of addGhostOutline so the instanced variant in geometry/carghosts.js runs the *same* effect
 * rather than a copy of it that can drift out of step.
 */
export function ghostMaskMaterial() {
  return unlitMaterial({
    colorWrite: false,
    depthWrite: false,
    depthTest: false,          // the footprint is stamped whether the mesh is visible or not
    transparent: true,         // queue placement only — nothing is ever blended
    stencilWrite: true,
    stencilRef: GHOST_REF,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
  });
}

/**
 * Pass 2's material — the rim itself. Back faces only: a closed hull's back faces cover the whole
 * silhouette on their own, where drawing both sides would run the blend twice and double the
 * opacity.
 *
 * @param tint      rim colour. The taxi's own yellow by default; the traffic ghosts pass each
 *                  car's own lightened paint, since yellow is reserved for the player.
 * @param opacity   base opacity. The instanced variant leaves this at 1 and carries the real
 *                  alpha per instance instead — see carghosts.js.
 */
export function ghostRimMaterial({ tint = color('taxiGhost'), opacity = 0.85 } = {}) {
  return unlitMaterial({
    color: tint,
    side: THREE.BackSide,
    transparent: true,
    opacity,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,          // draw only where something is in front of the car
    stencilWrite: true,                     // enables the test; all ops stay Keep, so no writes
    stencilRef: GHOST_REF,
    stencilFunc: THREE.NotEqualStencilFunc, // ...and never inside the car's own footprint
  });
}

/**
 * Hang a ghost outline off a mesh. The two passes are added as children, so they inherit the
 * mesh's transform — steering, bounce, roll — for free, the same way the pin's hull rides its
 * head. Reusable by design: any per-mesh car (the police cruiser, say) can wear one. The ambient
 * traffic is instanced and takes the variant in geometry/carghosts.js, which shares this file's
 * geometry inflation and both material recipes.
 *
 * @param mesh  the mesh to trace
 * @param rim   outline thickness in the mesh's local units — smaller for small parts like the
 *              roof sign, where the default would double the part's size
 * @param tint  rim colour; the taxi's yellow when left out (see ghostRimMaterial)
 */
export function addGhostOutline(mesh, { rim = RIM, tint } = {}) {
  // Pass 1 — stamp the mesh's screen footprint into the stencil. Shares the parent's geometry:
  // the mask must match the silhouette exactly or slivers of rim leak inside it.
  const mask = new THREE.Mesh(mesh.geometry, ghostMaskMaterial());
  mask.name = 'ghostMask';
  mask.renderOrder = GHOST_MASK_ORDER;
  mask.raycast = noRaycast;
  mesh.add(mask);

  // Pass 2 — the rim.
  const rimMesh = new THREE.Mesh(inflatedGeometry(mesh.geometry, rim), ghostRimMaterial({ tint }));
  rimMesh.name = 'ghostRim';
  rimMesh.renderOrder = GHOST_RIM_ORDER;
  rimMesh.raycast = noRaycast;
  mesh.add(rimMesh);

  return { mask, rim: rimMesh };
}

/**
 * Put a mesh in the ghost stencil mask without giving it a rim of its own — pass 1 of
 * addGhostOutline alone.
 *
 * For a part that has to stop *another* part's rim painting across it but cannot carry a hull of
 * its own. The taxi's damage pieces are the case: a boot lid or bonnet swung up off the body sits
 * inside the shell's 0.3-unit hull, so while it is left out of the mask the reversed depth test
 * reads it as an occluder and traces the shell's yellow rim straight across the panel. A hull
 * would not work on them either — a 0.06-thick lid is well under FLOOR_MARGIN, so
 * inflatedGeometry's floor clamp flattens its whole hull above the part.
 */
export function addGhostMask(mesh) {
  const mask = new THREE.Mesh(mesh.geometry, ghostMaskMaterial());
  mask.name = 'ghostMask';
  mask.renderOrder = GHOST_MASK_ORDER;
  mask.raycast = noRaycast;
  mesh.add(mask);
  return mask;
}

/**
 * Make a material's *visible* pixels part of the ghost mask, so no ghost rim — the taxi's, the
 * traffic's — paints over them.
 *
 * For things that fly. A rim's rule is "draw where something in the depth buffer sits in front of
 * me", and that is meant to mean a tower. A bird, the aeroplane or the helicopter passing between
 * the camera and the taxi satisfies it just as well, and the rim then traces *their* silhouette in
 * yellow across the hull's ring. Stamping the stencil where the flyer actually draws (the stamp
 * rides its own depth test, so only where it is in front) knocks the rim out exactly there: what
 * is left is a gap in the outline under the flyer, which is what an object in front should leave.
 *
 * Deliberately a stencil stamp and not a later renderOrder. Moving a flyer after the ghost tiers
 * (9990+) keeps it out of the depth buffer they read. Stencil state is GL state rather than shader
 * source, so this costs no program link.
 *
 * Only for a material that writes depth: one that doesn't was never an occluder.
 */
export function stampGhostMask(material) {
  material.stencilWrite = true;
  material.stencilRef = GHOST_REF;
  material.stencilFunc = THREE.AlwaysStencilFunc;
  material.stencilZPass = THREE.ReplaceStencilOp;
  return material;
}

/**
 * Show or hide every ghost outline hanging off `root`, wherever in the hierarchy it landed.
 *
 * The taxi wears seven of these — shell, four wheels, roof sign, lights — added at whatever depth
 * each part sits at, so this is a traverse rather than a list. The opening vignette is the caller:
 * the taxi spends that shot *inside a building*, which is the one occluder the outline is not
 * meant to see through. "Where is my car" is answered by the camera being pointed at the door.
 */
export function setGhostOutlines(root, visible) {
  root.traverse((child) => {
    if (isGhostPart(child)) child.visible = visible;
  });
}

/**
 * Outline a vehicle drawn as ordinary meshes — every `skin` in sim/traffic.js: the racer, the
 * patrol cruiser, the fire engine, the garbage truck, the robo-taxis. The instanced pool in
 * game/carghosts.js reads instances, and a skinned car has none (a guest never had one; the
 * cruiser's is collapsed under it), so each of these went behind a building and vanished.
 *
 * `rims` are the parts that get a hull — the body, the wheels, anything that swings out past the
 * body (a ladder, a lid). Every *other* opaque, depth-writing mesh under `root` gets a mask only,
 * found by walking the tree rather than listed by hand: the taxi's rule is that any part left out
 * of the mask is an occluder of its own car's rim, and a hand-written list goes stale the day a
 * part is added. Lamps switched by `visible` are walked too; their masks ride their visibility.
 *
 * Starts **off**. game/carghosts.js drives `set(alpha)` every frame with the same rules as the
 * street traffic — near the taxi, faded by distance — and off means the mask is hidden too, since
 * a mask stamps the stencil whether its rim shows or not (see the strength floor there).
 *
 * @param root    the group the skin draws into (what `wearSkin` is handed)
 * @param rims    `[mesh, thickness]` pairs, in the mesh's local units
 * @param tint    rim colour — the vehicle's paint, lifted the way PALETTE.carBodyGhost is
 */
export function outlineVehicle(root, { rims, tint }) {
  const hulled = new Set(rims.map(([mesh]) => mesh));
  const solid = [];
  root.traverse((object) => {
    if (!object.isMesh || hulled.has(object) || isGhostPart(object)) return;
    const m = object.material;
    if (!m || Array.isArray(m) || m.visible === false || m.transparent) return;
    if (m.colorWrite === false || m.depthWrite === false) return;
    solid.push(object);
  });
  const parts = [];
  const rimMeshes = [];
  for (const [mesh, rim] of rims) {
    const pair = addGhostOutline(mesh, { rim, tint });
    parts.push(pair.mask, pair.rim);
    rimMeshes.push(pair.rim);
  }
  for (const mesh of solid) parts.push(addGhostMask(mesh));
  let shown = null;
  const handle = {
    /** 0 hides the outline outright; anything above it is the rim's opacity. */
    set(alpha) {
      const on = alpha > 0.002;
      if (on !== shown) {
        for (const part of parts) part.visible = on;
        shown = on;
      }
      if (on) for (const rim of rimMeshes) rim.material.opacity = alpha;
    },
  };
  handle.set(0);
  root.userData.ghost = handle;
  return handle;
}

/** Is `object` one of the two passes addGhostOutline / addGhostMask hang off a mesh? */
export function isGhostPart(object) {
  return object.name === 'ghostMask' || object.name === 'ghostRim';
}

/**
 * Take every ghost outline off a *copy* of a traced group — a wreck cloned from a live car. A
 * wreck is scenery: it should not keep tracing itself through the building it came to rest
 * behind, and the clone's material pass (`cloneProp`, opacity forced to 1) would turn the rim
 * from an outline into a solid hull. Clones only: the live group keeps its outline.
 */
export function stripGhostOutlines(root) {
  const parts = [];
  root.traverse((child) => { if (isGhostPart(child)) parts.push(child); });
  for (const part of parts) part.removeFromParent();
  return root;
}
