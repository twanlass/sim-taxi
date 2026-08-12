import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';

// A parcel waiting to be couriered: a taped cardboard box on a kerb corner, where a rider would
// otherwise be standing. The same rig serves the small one riding on the taxi's rear deck and the
// one that flies between the two (game/parcels.js), scaled down by its caller.
//
// **Built to read as 📦.** Four parts, and each is doing one job at ~15px:
//
//   - a kraft body, and a slightly darker lid slab so the top seam is a plane rather than a stripe;
//   - **one** semi-white tape strip, wrapping over the top and down two opposite faces — the single
//     strip is what says *parcel* rather than *crate*. It was a cross first, which at this size read
//     as a hot cross bun: two strips on a 2.4-unit box leave four small squares of card and the
//     silhouette stops being a box with tape on it;
//   - a white shipping label on one face, beside the strip. It is the brightest thing on the box and
//     the part that survives longest as the box shrinks.
//
// Scale is the same deliberate lie geometry/person.js tells. A real parcel beside a 3.4-unit car
// would be about half a unit, which is four pixels at play zoom — invisible. This is a crate a bit
// under 2 units tall, so it lands at ~15px against the rider's ~25px: an object on the corner rather
// than grit on the screen, and *not a person* at a glance, being squat and wide where the figure is
// tall and thin.
//
// One merged mesh with one material, like every other prop here — colour rides in the geometry via
// bakeColor, so the whole box is one draw call however many colours the tape and label add.

const BOX_W = 2.4;         // X and Z; a square footprint, so the spin never changes its width
const BOX_H = 1.9;
const LID_H = 0.16;
const TAPE_W = 0.42;
const TAPE_PROUD = 0.04;   // how far the strip stands off the card it is stuck to

/**
 * @param pickable  the `userData.pickable` kind, or null for a parcel that is scenery. The picker
 *                  works off an explicit target list, so an untagged box is unreachable either way
 *                  — but tagging one that can never be picked (the copies on the taxi and in flight)
 *                  is a trap laid for whoever next raycasts the scene rather than a list.
 */
export function createParcel({ pickable = 'parcel' } = {}) {
  const group = new THREE.Group();
  group.name = 'parcel';

  const parts = [];
  const box = (w, h, d, x, y, z, col) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(x, y, z);
    parts.push(bakeColor(geo, new THREE.Color(col)));
  };

  const TOP = BOX_H + LID_H;

  box(BOX_W, BOX_H, BOX_W, 0, BOX_H / 2, 0, PALETTE.parcelBox);
  // Very slightly proud of the body on every side, so the lid reads as a separate plane rather than
  // as a stripe painted on one — at this size a flush inset vanishes.
  box(BOX_W + 0.06, LID_H, BOX_W + 0.06, 0, BOX_H + LID_H / 2, 0, PALETTE.parcelLid);

  // The tape strip: one slab, narrow in X and proud in Z and in Y, which puts it across the top and
  // straight down both Z faces in a single part. The camera looks down the +X+Z diagonal, so one
  // visible face carries the strip and the other carries the label — which is the pair of faces 📦
  // shows.
  box(TAPE_W, TOP + TAPE_PROUD, BOX_W + TAPE_PROUD * 2,
    0, (TOP + TAPE_PROUD) / 2, 0, PALETTE.parcelTape);

  // The label, beside the strip — and on **both** Z faces, which is not decoration.
  //
  // The camera sees exactly two faces of a box at this angle, and they are always one X face and one
  // Z face. The strip lives on the Z faces, so putting the label there too means the visible Z face
  // always carries both — which is the pair 📦 shows — and the spin can never turn the label away.
  // One label read at only half the rotation, and the half where it was edge-on was a white sliver
  // that looked like a lighting artefact rather than a label.
  //
  // Proud of the *tape*, not just the card, or it would be buried where the two meet. Kept clear of
  // the strip in X so the two never fight for the same pixels at 15px.
  for (const side of [1, -1]) {
    box(0.86, 0.66, 0.06,
      0.66 * side, 1.06, side * (BOX_W / 2 + TAPE_PROUD + 0.03), PALETTE.parcelLabel);
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  if (pickable) mesh.userData.pickable = pickable;
  group.add(mesh);

  /**
   * Waiting on the corner: a slow spin and a gentle bob.
   *
   * The rider's answer to "come and get me" is a raised, waving arm. A box has no arm, so the motion
   * carries the whole of it — a slow turn is the universal "this is a thing to pick up", and it is
   * deliberately slower than the rider's wave: a parcel is not impatient, it has no clock. The square
   * footprint means the spin never changes the silhouette's width, so it reads as turning rather than
   * as pulsing, and it brings the label and the tape past the camera in turn.
   *
   * `t` is sim time, never an accumulated dt — a frozen shot has to render the same frame every time.
   */
  function idle(t) {
    group.rotation.y = t * 0.55;
    group.position.y = Math.sin(t * 1.6) * 0.12;
  }

  /**
   * Set the box's opacity, 0..1 — the fade on the flight to and from the taxi.
   *
   * `material.transparent` and `depthWrite` are shader-define switches: flipping them at runtime does
   * nothing until `needsUpdate` forces a recompile, so the old rider figure changed `opacity` and
   * stayed stubbornly opaque until `visible` flipped and it popped. Track the last state and only
   * invalidate on a transition — this runs every frame of a flight, and recompiling a program per
   * frame would be a stall rather than a fade.
   */
  let transparent = false;
  function setOpacity(a) {
    const opaque = a >= 1;
    if (opaque === transparent) {
      transparent = !opaque;
      mesh.material.transparent = transparent;
      mesh.material.depthWrite = opaque;
      mesh.material.needsUpdate = true;
    }
    mesh.material.opacity = a;
  }

  /** Back to a plain untouched box. Slot reuse: the last parcel on this rig left a spin and a fade. */
  function rest() {
    group.position.set(0, 0, 0);
    group.rotation.set(0, 0, 0);
    group.scale.setScalar(1);
    group.visible = true;
    setOpacity(1);
  }

  rest();
  return { group, mesh, idle, setOpacity, rest };
}
