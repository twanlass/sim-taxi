import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';

// A parcel waiting to be couriered: a taped cardboard box on a kerb corner, where a rider would
// otherwise be standing. The same rig serves the copy in the HUD's cargo chip and the one that flies
// between the two (game/parcels.js), scaled down by its caller.
//
// **One of two loads a courier job can be carrying**, the other being the food order in
// geometry/food.js. Neither knows about the other: geometry/cargo.js is the rig that holds both and
// switches between them, and it is also where the shared envelope and the idle spin live.
//
// **Built to read as 📦.** Four parts, and each is doing one job at the ~10px this ends up:
//
//   - a kraft body, and a slightly darker lid slab so the top seam is a plane rather than a stripe;
//   - **one** semi-white tape strip, wrapping over the top and down two opposite faces — the single
//     strip is what says *parcel* rather than *crate*. It was a cross first, which at this size read
//     as a hot cross bun: two strips leave four small squares of card and the silhouette stops being a
//     box with tape on it;
//   - a white shipping label on one face, beside the strip. It is the brightest thing on the box and
//     the part that survives longest as the box shrinks.
//
// Scale is the same deliberate lie geometry/person.js tells. A real parcel beside a 3.4-unit car would
// be about half a unit, which is four pixels at play zoom — invisible. This is a crate two units
// across, which reads as an object on the corner rather than as grit on the screen, and as *not a
// person* at a glance: squat and wide where the figure is tall and thin. Every number below is a
// **proportion**; `CARGO_SCALE` is the one that turns them into a size, and it is where the argument
// about how large a load should read now lives.
//
// One merged mesh with one material, like every other prop here — colour rides in the geometry via
// bakeColor, so the whole box is one draw call however many colours the tape and label add.

// X and Z; a square footprint, so the spin never changes its width.
//
// **It was 2.4 and read about twice too big.** A box is mass in all three dimensions where the rider
// figure is a tall thin sliver, so matching the figure's 3.3-unit *height* matched nothing the eye
// actually measures — a 2.4 crate beside a rider read as a shipping container beside a person. At 1.35
// the box is a shade smaller than the figure on the axis that matters (apparent area) while still
// clearing the ~10px floor a shape needs to be a shape at play zoom rather than a smudge.
//
// It is a proportion now rather than a width: `CARGO_SCALE` multiplies it, and the box is drawn 1.96
// across (2.0 at the lid) — still comfortably under the 2.4 that failed, and the shape is untouched.
const BOX_W = 1.35;
const BOX_H = 1.07;
const LID_H = 0.09;
const TAPE_W = 0.24;
const TAPE_PROUD = 0.024;  // how far the strip stands off the card it is stuck to

/**
 * How much bigger a load is drawn than the numbers above say — **the one knob for how large cargo
 * reads on the board**, applied to the finished mesh here and in geometry/food.js alike.
 *
 * A separate factor rather than new literals because those literals are *proportions*: every
 * comment in this file and in food.js argues one part against another (the label against the strip,
 * the burger against the cup, the straw against the lid), and multiplying twenty tuned numbers by
 * hand would leave every one of those arguments quoting a size that no longer exists. Scaling the
 * merged geometry once keeps the shapes exactly as they were argued and moves only how big they are.
 *
 * **It is set by the food order, not by the box.** At 1.0 a load stands 1.38 across and is about
 * 11px at play zoom — which is the floor a shape needs to be a shape, and the box clears it because
 * it is 1.38 of solid card with a white label on it. The order is the same envelope with most of the
 * air: a burger and a cup share that width between them and neither is more than half of it, and on
 * a phone it reads as a smudge on a 6.4-unit pad rather than as food. Reported as exactly that —
 * "hard to read". 1.45 puts a load at 2.0 across (~15px), which is the burger back over the floor
 * the box was tuned to.
 *
 * **Both kinds move together and that is not a compromise**, it is the envelope (geometry/cargo.js):
 * three things measure a load without asking which kind it is, and they all read numbers derived
 * from this file. A factor on one kind alone would be three bugs.
 *
 * The ceiling is the prior this walks back toward, and it is worth keeping written down: the box was
 * **2.4 across once and read about twice too big** — a shipping container beside a rider. That was
 * measured against the figure on a bare corner, before either load stood on a 6.4-unit pad, but it
 * is still the wall. 1.45 stops a third of the way short of it.
 */
export const CARGO_SCALE = 1.45;

/**
 * Scale a parcel is drawn at when it is riding on the taxi's rear deck.
 *
 * Here rather than at the two call sites that need it (geometry/taxi.js for the deck copy,
 * game/parcels.js for what the incoming flight shrinks *to*), because it is a fact about this mesh:
 * three numbers encoding "the deck parcel is about half a unit wide" is three numbers to remember when
 * the box is resized, and resizing the box is exactly what just happened. Derived from `BOX_W` so it
 * follows automatically.
 */
export const PARCEL_DECK_SCALE = 0.53 / (BOX_W * CARGO_SCALE);

/**
 * Half the box's standing height — the point a picture of it should be centred on.
 *
 * The HUD chip frames the box around this (game/cargochip.js) and the pickup hand-off measures the
 * kerb box's screen position from it (game/parcels.js), which is precisely why it is one number here
 * rather than the same `0.58` typed at both ends: the two have to agree to the pixel or the box
 * *jumps* on the frame the world hands it to the corner, and a box resized on one side of that seam
 * would open a gap nothing asserts.
 */
export const PARCEL_CENTRE_Y = ((BOX_H + LID_H) / 2) * CARGO_SCALE;

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
  box(BOX_W + 0.034, LID_H, BOX_W + 0.034, 0, BOX_H + LID_H / 2, 0, PALETTE.parcelLid);

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
  // the strip in X so the two never fight for the same pixels at this size.
  for (const side of [1, -1]) {
    box(0.48, 0.37, 0.034,
      0.37 * side, 0.60, side * (BOX_W / 2 + TAPE_PROUD + 0.02), PALETTE.parcelLabel);
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  // Every number above is a proportion; this is the only place the box is given a size. See
  // `CARGO_SCALE` — and note it goes on the *geometry* rather than on the group, so everything that
  // measures a load (the probe's envelope check, the HUD chip's framing, the pickup's hand-off point)
  // reads a mesh that is already the size it will be drawn at, with no factor to remember.
  merged.scale(CARGO_SCALE, CARGO_SCALE, CARGO_SCALE);

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  if (pickable) mesh.userData.pickable = pickable;
  group.add(mesh);

  // **The idle spin is not here.** It used to be, and it moved to geometry/cargo.js when the courier
  // gained a second load to carry: a box and a food order turning at two rates would be two answers
  // to "this is a thing to pick up", where the rate is the whole of what that motion says. What the
  // box still contributes to it is the reason it works — a square footprint means the spin never
  // changes the silhouette's width, so it reads as turning rather than as pulsing, and it brings the
  // label and the tape past the camera in turn.

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
  return { group, mesh, setOpacity, rest };
}
