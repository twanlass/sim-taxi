import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { burgerGeometry } from '../city/burgerjoint.js';
import { PALETTE } from '../palette.js';

// A food order waiting to be couriered: a burger and a soda cup, both several sizes too big, sitting
// on a kerb corner where a rider would otherwise be standing. The courier layer's second load
// (geometry/cargo.js switches between them), and the only thing that separates it from the box is
// what it *is* — same pad, same cyan, same errand, same money. See docs/gameplay.md.
//
// **Two objects and no container, and that is the whole design.** The first cut put both of them in a
// takeaway bag, which is what a real order comes in and which cost the order the only thing it had:
// the bag is a squat tapered block, it took two thirds of the envelope, and it left the burger and
// the cup as trinkets balanced on the top of something that reads, at ten pixels, as *another box*.
// Cargo on this board is already a box. What is worth having here is the pair of shapes nothing else
// in the game has, at the size they can be recognised at.
//
// So both are scaled to the same deliberate lie geometry/person.js and geometry/parcel.js tell. A
// burger beside a 3.4-unit car is a crumb; this one is 1.24 across, which is nearly the parcel's
// width, and the cup beside it stands as tall as the box does. It reads as an object on the corner
// instead of grit on the screen, and it is unmistakably not a person: round and squat where the
// figure is tall and thin.
//
// **The burger is the drive-through's own** (`burgerGeometry` in city/burgerjoint.js), the real mesh
// shrunk rather than a second recipe for one. That sign is fourteen pixels on a pole and had to solve
// this exact problem once already — which slices read at that size, how much of each has to stand out
// past the crown, why the cheese is a square turned 45 degrees. Rebuilding it here would mean two
// burgers in one city, tuned twice and drifting apart on the first change to either.

// --- The cargo envelope ---------------------------------------------------------------------------
//
// This has to stand in the *same space* the parcel does, and that is a hard constraint rather than a
// tidy one. Three separate things measure a load without asking which kind it is: the HUD chip frames
// one square frustum around whatever is aboard (game/cargochip.js), the pickup hands the chip a point
// on the load's own middle (game/parcels.js), and the outbound flight opens at "a load, at the scale
// this car handles loads at". A taller second cargo would overflow the first, sit off-centre in the
// second and open at the wrong size in the third — three bugs from one dimension.
//
// So the straw's tip lands on `PARCEL_CENTRE_Y * 2`, the box's own standing height, and the pair
// stays inside the box's own sweep — measured as the furthest vertex from the spin axis, because a
// burger and a cup on a diagonal have nothing at the corners of their bounding box.
// `tools/probe.mjs` asserts both against the mesh that actually gets built rather than against these
// numbers, and `tools/smoke.mjs` asserts the HUD chip draws the whole of it with nothing on the rim.
const TOTAL_H = 1.16;      // = BOX_H + LID_H in geometry/parcel.js

/**
 * How wide the burger is drawn, and **the only size it has** — everything else in that stack is a
 * fraction of it (see `burgerGeometry`), so this scales the whole thing rather than flattening it.
 *
 * 1.24 across against the parcel's 1.35, which is as large as it can be and still leave the cup its
 * half of the plan. Under this camera the pair is read as one object with a tall half and a round
 * half, and a burger any wider starts eating the cup rather than standing beside it.
 */
const BURGER_W = 1.24;

// The cup: tall, and tapered the *other way* from anything else on this board. A fountain cup is wide
// at the lid and narrow at the base, which is a slope leaning against the burger's stack of discs,
// and it is the half of the order that reaches the top of the envelope.
//
// **The body stops well short of the envelope, and the straw gets the rest.** A cup drawn up to the
// lid line leaves the straw a tenth of a unit of air, which is a nub — and the straw is the only part
// of any load in this game that breaks the outline at the top. At 0.78 the body is still half again
// as tall as it is wide, which is all a cup needs to be a cup, and the straw gets a third of a unit
// to stand up in.
const CUP_H = 0.78;
const CUP_R_TOP = 0.30;
const CUP_R_BASE = 0.23;
const LID_R = 0.33;
const LID_H = 0.06;

// Where the two stand in the plan.
//
// **The tall one goes up-screen.** The camera looks down the +X+Z diagonal at 33 degrees, so −X−Z is
// away from the eye and up the frame: the cup behind and the burger in front means the burger can
// never cover the cup's body, which is the one occlusion a pair like this can suffer. Set on the
// diagonal rather than side by side for a second reason — two objects strung out along one axis swing
// between their full width and nothing as the order spins, and the same pair placed on the diagonal
// keeps a compact plan whichever way it is turned.
//
// The offsets are symmetric about the origin on purpose: the idle spin is about this mesh's own Y
// axis, so a pair whose extents are lopsided *orbits* instead of turning.
const CUP_X = -0.38;
const CUP_Z = -0.38;
const BURGER_X = 0.12;
const BURGER_Z = 0.12;

/**
 * Half the order's standing height — the point a picture of it should be centred on, and the same
 * number `PARCEL_CENTRE_Y` reports for the box. Exported separately rather than imported from
 * parcel.js so that the two are asserted equal instead of assumed so: they are two meshes built by
 * two files, and the day one of them is restyled is the day the assumption would go quiet.
 */
export const FOOD_CENTRE_Y = TOTAL_H / 2;

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

  // --- The burger ---------------------------------------------------------------------------------
  //
  // Scaled and stood on the ground **by its own bounding box**, not by arithmetic off `BURGER_R`: the
  // sign is built centred on its middle (it turns on a pole), its proportions are five slice
  // thicknesses deep, and the crown has already been re-tuned once. Measuring the mesh that actually
  // arrives means this follows any change to it instead of quietly going out of step with the thing
  // it is supposed to be a copy of.
  const burger = burgerGeometry();
  burger.computeBoundingBox();
  // Copied out, not held by reference: `scale` goes through `applyMatrix4`, which **recomputes** a
  // bounding box that already exists — so a reading taken before the scale and read after it has
  // silently had the scale applied to it, and using it to stand the mesh on the ground applies the
  // scale twice. It sank the burger a quarter of a unit into the pavement.
  const signBox = burger.boundingBox.clone();
  const burgerScale = BURGER_W / (signBox.max.x - signBox.min.x);
  burger.scale(burgerScale, burgerScale, burgerScale);
  burger.translate(BURGER_X, -signBox.min.y * burgerScale, BURGER_Z);
  // Already coloured slice by slice by `burgerGeometry`, so it goes in as it is rather than through
  // `add` — one `bakeColor` over the whole stack would paint the patty like the bun.
  parts.push(burger);

  // --- The soda -----------------------------------------------------------------------------------
  const disc = (rTop, rBottom, h, x, y, z, col, segments = 12) => {
    const geo = new THREE.CylinderGeometry(rTop, rBottom, h, segments);
    geo.translate(x, y + h / 2, z);
    add(geo, col);
  };
  disc(CUP_R_TOP, CUP_R_BASE, CUP_H, CUP_X, 0, CUP_Z, PALETTE.foodCup);
  // The lid, standing proud of the cup all the way round — the parcel's lid slab doing the parcel's
  // job, which is to make the top of a thing a *plane* rather than a stripe painted across one face.
  //
  // Red, and that is the working half of the cup. An off-white cap on an off-white cup under this sun
  // is one shade of one colour, and the drink only became legible at ten pixels once the thing capping
  // it was the one part of the order that is neither bun nor paper.
  disc(LID_R, LID_R, LID_H, CUP_X, CUP_H, CUP_Z, PALETTE.foodCupLid);

  // The straw — the part that breaks the outline, and the only piece of any cargo in this game that
  // reaches the top of the envelope. It is what tells a turning order from a turning box the moment
  // neither is more than a smudge, the same job the tape strip does for the parcel.
  //
  // **Nearly upright.** Its whole read is the length of it that is in the *air above the lid*, and the
  // envelope caps that — so leaning it to buy length, which is the obvious move, spends the height it
  // had: at 35 degrees the tip came down level with the lid and the thing photographed as a white
  // streak lying across it. The 0.2 of tilt left is a straw somebody pushed through at an angle rather
  // than a mast, and the small X lean is so the spin has something to sweep from both of the faces
  // this camera can see.
  //
  // Placed **by its tip**, from its own bounding box after the lean rather than from the arithmetic of
  // a lean and a half-length: that tip is the top of the cargo envelope (see TOTAL_H), so it is the
  // one measurement in this file another module depends on, and a straw re-angled by eye would
  // quietly move it. Long enough that its lower end is inside the lid it came through.
  //
  // Off-white rather than the red the lid wears: it comes out of that lid, and a red straw on one is a
  // straw nobody can see.
  const straw = new THREE.BoxGeometry(0.08, 0.34, 0.08);
  straw.rotateX(-0.12);
  straw.rotateZ(0.20);
  straw.computeBoundingBox();
  straw.translate(CUP_X + 0.06, TOTAL_H - straw.boundingBox.max.y, CUP_Z + 0.04);
  add(straw, PALETTE.foodCup);

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  // Centre the pair on its own plan extents. The offsets above are chosen to balance, but the burger
  // carries a scatter of sesame seeds that is deliberately *not* symmetric (see `burgerGeometry`), so
  // the pair as built leans a few hundredths one way — and the idle spin is about this mesh's Y axis,
  // where a lopsided plan reads as an orbit rather than a turn. Measured rather than nudged, so it
  // stays true if either half is resized.
  merged.computeBoundingBox();
  const plan = merged.boundingBox;
  merged.translate(-(plan.min.x + plan.max.x) / 2, 0, -(plan.min.z + plan.max.z) / 2);

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
