import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';

// A food order waiting to be couriered: a takeaway bag with a burger and a soda cup standing out of
// the top of it. The courier layer's second load (game/geometry/cargo.js switches between them), and
// the only thing that separates it from the box is what it *is* — same pad, same cyan, same errand,
// same money. See docs/gameplay.md.
//
// **Built to be a different silhouette, not a different colour.** The board's vocabulary is already
// spent: shape says what a thing is and hue says whose clock is paying for it (game/urgency.js), and
// a courier job has no clock — so a second cargo that arrived as a *second cyan* would be saying
// something the board cannot mean. What is left is the outline, and at the ~10px this ends up that
// has to be worked at rather than assumed:
//
//   - the box is a **squat square**; this is a **taper with things standing out of the top of it**,
//     which is a different shape at any size that resolves at all;
//   - the **straw** is the whole of the read at play zoom. It is the one part that leaves the
//     envelope's shoulder — two pixels of red against sky or road where the box has nothing — and it
//     is what makes the spin legible, the way the tape strip is for the box: a bag alone is close
//     enough to rotationally symmetric that turning it says nothing;
//   - the **burger** carries the close-up, and it is the city's own burger (city/burgerjoint.js) in
//     miniature — same slices in the same order out of the same four palette entries. The joint's
//     sign is fourteen pixels on a pole and had to solve exactly this problem once already; nothing
//     here is a second opinion about what a burger looks like at that size.
//
// Everything is a cylinder, a box or a squashed hemisphere, merged into one mesh with the colour
// baked into the geometry — the same one-draw-call rig every prop here uses.

// --- The cargo envelope ---------------------------------------------------------------------------
//
// This has to stand in the *same space* the parcel does, and that is a hard constraint rather than a
// tidy one. Three separate things measure a load without asking which kind it is: the HUD chip frames
// one square frustum around whatever is aboard (game/cargochip.js), the pickup hands the chip a point
// on the box's own middle (game/parcels.js), and the outbound flight opens at "a load, at the scale
// this car handles loads at". A taller second cargo would overflow the first, sit off-centre in the
// second and open at the wrong size in the third — three bugs from one dimension.
//
// So the whole order — bag, cup, lid, and the straw's tip — lands on `PARCEL_CENTRE_Y * 2`, the box's
// own standing height, and inside its half-diagonal. `tools/probe.mjs` asserts both against the mesh
// that actually gets built rather than against these numbers.
const TOTAL_H = 1.16;      // = BOX_H + LID_H in geometry/parcel.js
// **Tall and steeply tapered, and both of those are corrections.** The first cut was 0.70 high on a
// 0.92 base with a 1.10 mouth, which photographed as a *tub*: at a 0.8 aspect with that little flare
// there is nothing in the outline that a bucket does not also have, and the wide flat rim on top read
// as the lip of one. A bag is the other proportion — narrow at the base, open at the top, and taller
// than it is wide — so the base came in by a quarter and the walls went up.
const BAG_H = 0.74;
const BAG_HALF_BOTTOM = 0.34;
const BAG_HALF_TOP = 0.47;  // the flare: a paper bag is open at the top and tucked at the bottom
const CUFF_H = 0.06;
const CUFF_OUT = 0.028;     // how far the rolled mouth stands proud of the bag's own top

/** Where the bag stands in the plan, so the two things poking out of it never fight for one spot. */
const CUP_X = -0.19;
const CUP_Z = -0.05;
const BURGER_X = 0.21;
const BURGER_Z = 0.08;

/**
 * Half the order's standing height — the point a picture of it should be centred on, and the same
 * number `PARCEL_CENTRE_Y` reports for the box. Exported separately rather than imported from
 * parcel.js so that the two are asserted equal instead of assumed so: they are two meshes built by
 * two files, and the day one of them is restyled is the day the assumption would go quiet.
 */
export const FOOD_CENTRE_Y = TOTAL_H / 2;

/** What the order is drawn at when it is scaled down to a load riding on the car. See parcel.js. */
export const FOOD_DECK_SCALE = 0.53 / (BAG_HALF_TOP * 2);

/**
 * @param pickable  the `userData.pickable` kind, or null for an order that is scenery. Same rule as
 *                  `createParcel`: the picker works off an explicit target list, so tagging a mesh
 *                  that can never be picked is a trap for whoever next raycasts the scene.
 */
export function createFoodOrder({ pickable = 'parcel' } = {}) {
  const group = new THREE.Group();
  group.name = 'food-order';

  const parts = [];
  const add = (geo, col) => parts.push(bakeColor(geo, new THREE.Color(col)));

  /**
   * A disc of the burger stack, or the cup — a cylinder standing on `y`, so every piece is placed by
   * the height of the thing under it rather than by a centre that has to be re-derived by hand each
   * time a slice changes thickness.
   */
  const disc = (rTop, rBottom, h, x, y, z, col, segments = 10) => {
    const geo = new THREE.CylinderGeometry(rTop, rBottom, h, segments);
    geo.translate(x, y + h / 2, z);
    add(geo, col);
  };
  const slab = (w, h, d, x, y, z, col) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(x, y + h / 2, z);
    add(geo, col);
  };

  // --- The bag ------------------------------------------------------------------------------------
  //
  // A four-sided cylinder rather than a box, which is the one primitive here that is doing something a
  // box cannot: it **tapers**. A paper bag standing on a kerb is narrow at the base and open at the
  // top, and that flare is most of what separates this silhouette from the parcel's — an untapered bag
  // is a box with a burger balanced on it.
  //
  // Turned 45 degrees so its flats face the axes, exactly as the parcel's do. Three's cylinder puts a
  // vertex at +Z and works round, so an unturned 4-gon presents its *corners* to a camera that looks
  // down the +X+Z diagonal — an edge-on bag with two faces sliding away from the eye, where what is
  // wanted is the same three-quarter pair of faces the box shows.
  const bagGeo = new THREE.CylinderGeometry(
    BAG_HALF_TOP * Math.SQRT2, BAG_HALF_BOTTOM * Math.SQRT2, BAG_H, 4,
  );
  bagGeo.rotateY(Math.PI / 4);
  bagGeo.translate(0, BAG_H / 2, 0);
  add(bagGeo, PALETTE.foodBag);

  // The rolled mouth, proud on every side — the parcel's lid slab doing the parcel's job, which is to
  // make the top of the thing a *plane* rather than a stripe painted across one face. At this size a
  // flush fold vanishes and the bag reads as an open-topped tube.
  slab((BAG_HALF_TOP + CUFF_OUT) * 2, CUFF_H, (BAG_HALF_TOP + CUFF_OUT) * 2,
    0, BAG_H - CUFF_H, 0, PALETTE.foodBagFold);

  // The band across the bag, on **both** Z faces, for the reason the parcel's label is on both of
  // its: this camera sees exactly one X face and one Z face, and a mark on a single face is turned
  // away for half of every spin. It is the joint's own red (`burgerBand`) rather than a colour of its
  // own — the order came from the city's one burger joint, and one brand that reads at 14px on a
  // building is not worth having a second opinion about at 10px on a kerb.
  //
  // Sized and placed against the bag's *taper*: the face it sits on leans out, so the band stands a
  // little further out at the top than the bottom and the slab has to clear the widest of it.
  const bandY = BAG_H * 0.26;
  const bandHalf = BAG_HALF_BOTTOM + (BAG_HALF_TOP - BAG_HALF_BOTTOM) * 0.62;
  for (const side of [1, -1]) {
    slab(0.50, 0.25, 0.036, 0, bandY, side * (bandHalf + 0.018), PALETTE.burgerBand);
  }

  // --- The soda ----------------------------------------------------------------------------------
  //
  // Standing *in* the bag, and tapered the other way from it — a fountain cup is wide at the lid —
  // which is a second slope leaning against the first, and most of why the two shapes do not merge
  // into one blob at play zoom.
  //
  // **Narrow, and bedded deep.** Both are bought with the same currency and spent on the straw. This
  // camera looks down 33 degrees, so the bag's near rim eats whatever is standing in it, and the first
  // cut answered that by sitting the cup high — which read as a cup because it *was* mostly visible,
  // and left the straw above it no air at all (see below). Sunk a fifth of a unit instead, only the
  // top third of the body shows, and what carries the read is the **lid**: kraft, card and an
  // off-white cap are three shades of one tan under this sun, so the first cup dissolved into the bag
  // it was standing in, and a red one is legible with most of the cup hidden. Narrow for the other
  // half of it — a cup has to be taller than it is wide to be a cup at all, and inside this envelope
  // the only place that height can come from is the width.
  const CUP_BASE_Y = BAG_H - 0.21;
  const CUP_H = 0.36;
  disc(0.17, 0.13, CUP_H, CUP_X, CUP_BASE_Y, CUP_Z, PALETTE.foodCup);
  const lidY = CUP_BASE_Y + CUP_H;
  disc(0.19, 0.19, 0.045, CUP_X, lidY, CUP_Z, PALETTE.foodCupLid);

  // The straw — the part that breaks the outline, and the only piece of any cargo in this game that
  // reaches the top of the envelope. It is what tells a turning order from a turning box the moment
  // neither is more than a smudge, the same job the tape strip does for the parcel.
  //
  // **Nearly upright.** Its whole read is the length of it that is in the *air above the lid*, and
  // this envelope caps that — so leaning it to buy length, which is the obvious move, spends the
  // height it had: at 35 degrees the tip came down level with the lid and the thing photographed as a
  // white streak lying across it. The 0.2 of tilt left is a straw somebody pushed through at an angle
  // rather than a mast, and the small X lean is so the spin has something to sweep from both of the
  // faces this camera can see.
  //
  // Placed **by its tip**, from its own bounding box after the lean rather than from the arithmetic of
  // a lean and a half-length: that tip is the top of the cargo envelope (see TOTAL_H), so it is the one
  // measurement in this file another module depends on, and a straw re-angled by eye would quietly
  // move it. Long enough that its lower end is inside the lid it came through.
  //
  // Off-white rather than the band's red: it comes out of a red lid, and a red straw on one is a straw
  // nobody can see.
  const straw = new THREE.BoxGeometry(0.07, 0.32, 0.07);
  straw.rotateX(-0.12);
  straw.rotateZ(0.20);
  straw.computeBoundingBox();
  straw.translate(CUP_X + 0.055, TOTAL_H - straw.boundingBox.max.y, CUP_Z + 0.04);
  add(straw, PALETTE.foodCup);

  // --- The burger ---------------------------------------------------------------------------------
  //
  // The city's sign in miniature, slice for slice: bun, patty, a square of cheese turned 45 degrees so
  // its corners come out past the patty, and a squashed dome on top. The lettuce is the one slice that
  // did not survive the trip down — the sign is fourteen pixels across and this is nearer six, and a
  // 0.02-unit green ring at that size is a smudge on the patty rather than a slice of anything. What
  // it costs is exactly the thing the cheese is already saying, in a colour that separates less well.
  //
  // Bedded a little *into* the mouth of the bag for the same reason the cup is: the bag is holding
  // the order, not carrying it on its head.
  let y = BAG_H - 0.09;
  disc(0.24, 0.205, 0.09, BURGER_X, y, BURGER_Z, PALETTE.bunBase);
  y += 0.09;
  disc(0.275, 0.275, 0.065, BURGER_X, y, BURGER_Z, PALETTE.patty);
  y += 0.065;
  const cheese = new THREE.BoxGeometry(0.48, 0.026, 0.48);
  cheese.rotateY(Math.PI / 4);
  cheese.translate(BURGER_X, y + 0.013, BURGER_Z);
  add(cheese, PALETTE.cheese);
  y += 0.026;
  // Squashed to 0.8 of its radius, the value city/burgerjoint.js measured: a full hemisphere reads as
  // a ball balanced on a stack, and the silhouette has to stay wider than it is tall to be a burger.
  const dome = new THREE.SphereGeometry(0.23, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.scale(1, 0.8, 1);
  dome.translate(BURGER_X, y, BURGER_Z);
  add(dome, PALETTE.bunTop);

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  if (pickable) mesh.userData.pickable = pickable;
  group.add(mesh);

  /** See `createParcel`'s own: a shader-define switch, so only flip `needsUpdate` on a transition. */
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

  /** Back to an untouched order. Slot reuse: the last load on this rig left a fade behind it. */
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
