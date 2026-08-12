import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';

// A parcel waiting to be couriered: a taped cardboard box on a kerb corner, where a rider would
// otherwise be standing. Same rig serves the small one riding on the taxi's rear deck while the
// package is aboard (see geometry/taxi.js), scaled down by its caller.
//
// Scale is the same deliberate lie geometry/person.js tells. A real parcel beside a 3.4-unit car
// would be about half a unit, which is four pixels at play zoom — invisible. This is a crate a bit
// under 2 units tall, so it lands at ~15px against the rider's ~25px: reads as an object on the
// corner rather than as grit on the screen, and reads as *not a person* at a glance, being squat
// and wide where the figure is tall and thin.
//
// One merged mesh with one material, like every other prop here — colour rides in the geometry via
// bakeColor, so the whole box is one draw call however many colours the tape and lid add.

const BOX_W = 2.4;         // X and Z; a square footprint, so the spin never changes its width
const BOX_H = 1.9;
const LID_H = 0.16;        // a darker slab across the top, so the top edge reads at 15px
const TAPE_W = 0.36;
const TAPE_H = 0.12;

// There is deliberately no `highlight()` here, and person.js's `HIGHLIGHT_EMISSIVE` has no sibling.
// That lift is the colour half of the select pop (game/selectpop.js) — feedback for a tap — and a
// package cannot be tapped: the only way to reach one is to bend the route band through it. A lit
// parcel would be acknowledging a gesture that has no way of happening.

/**
 * @param pickable  the `userData.pickable` kind, or null for a parcel that is scenery. The picker
 *                  works off an explicit target list, so an untagged box is unreachable either way
 *                  — but tagging one that can never be picked (the copy riding on the taxi) is a
 *                  trap laid for whoever next raycasts the scene rather than a list.
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

  box(BOX_W, BOX_H, BOX_W, 0, BOX_H / 2, 0, PALETTE.parcelBox);
  // Very slightly proud of the box on every side, so the lid reads as a separate plane rather than
  // as a stripe painted on one — at this size a flush inset would vanish.
  box(BOX_W + 0.06, LID_H, BOX_W + 0.06, 0, BOX_H + LID_H / 2, 0, PALETTE.parcelLid);

  // The tape cross, on top of the lid. The camera looks down the +X+Z diagonal, so the top face is
  // the largest one on screen — a cross up there is what says "parcel" rather than "crate".
  const tapeY = BOX_H + LID_H + TAPE_H / 2;
  box(BOX_W + 0.08, TAPE_H, TAPE_W, 0, tapeY, 0, PALETTE.parcelTape);
  box(TAPE_W, TAPE_H, BOX_W + 0.08, 0, tapeY, 0, PALETTE.parcelTape);

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  if (pickable) mesh.userData.pickable = pickable;
  group.add(mesh);

  /**
   * Waiting on the corner: a slow spin and a gentle bob.
   *
   * The rider's answer to "come and get me" is a raised, waving arm. A box has no arm, so the
   * motion has to carry the whole of it — a slow turn is the universal "this is a thing to pick
   * up", and it is deliberately slower than the rider's wave: a parcel is not impatient, it has no
   * clock. The square footprint means the spin never changes the silhouette's width, so it reads as
   * turning rather than as pulsing.
   *
   * `t` is sim time, never an accumulated dt — a frozen shot has to render the same frame every
   * time.
   */
  function idle(t) {
    group.rotation.y = t * 0.55;
    group.position.y = Math.sin(t * 1.6) * 0.12;
  }

  /** Back to a plain untouched box. Slot reuse: the last parcel on this rig left a spin behind. */
  function rest() {
    group.position.set(0, 0, 0);
    group.rotation.set(0, 0, 0);
    group.scale.setScalar(1);
    group.visible = true;
  }

  rest();
  return { group, mesh, idle, rest };
}
