import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { donutGeometry } from '../city/donutshop.js';
import { CARGO_SCALE } from './parcel.js';
import { PALETTE } from '../palette.js';
import { alsoWarmAs } from '../util/warmvariants.js';

let warmedFade = false;

// A donut order waiting to be couriered: the donut shop's own pink cake donut and a coffee, both
// several sizes too big, on the shop's corner. The courier layer's third load (geometry/cargo.js
// switches between them), and the food order's twin — same pad, same cyan, same errand, same money;
// it differs from the burger only in *where it comes from* (the donut shop, game/parcels.js) and in
// what it is. See docs/gameplay.md.
//
// Built on the burger order's design (geometry/food.js) and for its reasons: two objects and no
// container, scaled to the same deliberate lie, set on the diagonal with the tall one up-screen so
// the round one can never cover it, and stood inside the box's envelope because three things measure
// a load without asking which kind it is. `tools/probe.mjs` asserts that envelope against this mesh.
//
// **The donut is the roof's own** (`donutGeometry` in city/donutshop.js), the real mesh shrunk —
// frosting, fried band and sprinkles — rather than a second recipe for one, for the burger's reason:
// two donuts in one city tuned twice drift apart on the first change to either.
//
// **Propped against the cup, frosting out.** Lying flat it is a pink ellipse a quarter of a unit
// tall beside a cup four times its height, and the cup is all that reads. Leaned back on the cup it
// stands half the envelope's height, shows the camera its frosted face and its hole at once, and the
// spin swings it past side-on for a beat each turn, which is a donut's tube rather than a disc.

const TOTAL_H = 1.16;      // = BOX_H + LID_H in geometry/parcel.js — and the lid's top lands on it

/** How wide the donut is drawn — the burger's width, so the two orders weigh the same on a corner. */
const DONUT_W = 1.12;
/** How far it leans back off upright, towards the cup behind it (radians from vertical). */
const DONUT_LEAN = 0.62;

// The coffee: a straight-sided cup that reaches the top of the envelope *itself*, because it has no
// straw to do it for it. Narrower at the base like the soda's, a kraft sleeve round its middle — the
// sleeve is what says hot drink rather than another soda — and a dark lid with a raised rim.
const CUP_R_TOP = 0.29;
const CUP_R_BASE = 0.23;
const LID_R = 0.32;
const LID_H = 0.07;
const RIM_R = 0.25;
const RIM_H = 0.05;
const CUP_H = TOTAL_H - LID_H - RIM_H;
const SLEEVE_FROM = 0.32;
const SLEEVE_TO = 0.66;
const SLEEVE_PROUD = 0.02;

// Where the two stand in the plan: cup up-screen (−X−Z, away from the eye), donut in front, leaning
// back towards it. Symmetric-ish about the origin, and re-centred on the built plan below anyway.
const CUP_X = -0.36;
const CUP_Z = -0.36;
const DONUT_X = 0.16;
const DONUT_Z = 0.16;

/** Half the order's standing height — `PARCEL_CENTRE_Y`'s number, asserted rather than assumed. */
export const DONUT_ORDER_CENTRE_Y = (TOTAL_H / 2) * CARGO_SCALE;

/** Cup radius at height y, so the sleeve hugs the taper rather than floating off it. */
const cupR = (y) => CUP_R_BASE + (CUP_R_TOP - CUP_R_BASE) * (y / CUP_H);

/**
 * @param pickable  the `userData.pickable` kind, or null for an order that is scenery — as
 *                  `createFoodOrder`'s.
 */
export function createDonutOrder({ pickable = 'parcel' } = {}) {
  const group = new THREE.Group();
  group.name = 'donut-order';

  const parts = [];
  const add = (geo, col) => parts.push(bakeColor(geo, new THREE.Color(col)));

  // --- The donut ----------------------------------------------------------------------------------
  //
  // Built frosted face to +Z, ring in the XY plane. Scaled by its own measured width, then tipped
  // back about X by (π/2 − lean) so the face looks up and out, turned to face down the +X+Z diagonal
  // (the camera's side) and stood on the ground by its own bounding box after the turn.
  const donut = donutGeometry();
  donut.computeBoundingBox();
  const raw = donut.boundingBox.clone();
  const s = DONUT_W / (raw.max.x - raw.min.x);
  donut.scale(s, s, s);
  donut.rotateX(-DONUT_LEAN);
  donut.rotateY(Math.PI / 4);
  donut.computeBoundingBox();
  const leaned = donut.boundingBox.clone();
  donut.translate(DONUT_X, -leaned.min.y, DONUT_Z);
  // Already painted face by face by `donutGeometry`, so it goes in as it is.
  parts.push(donut);

  // --- The coffee ---------------------------------------------------------------------------------
  const disc = (rTop, rBottom, h, x, y, z, col, segments = 14) => {
    const geo = new THREE.CylinderGeometry(rTop, rBottom, h, segments);
    geo.translate(x, y + h / 2, z);
    add(geo, col);
  };
  disc(CUP_R_TOP, CUP_R_BASE, CUP_H, CUP_X, 0, CUP_Z, PALETTE.foodCup);
  disc(cupR(SLEEVE_TO) + SLEEVE_PROUD, cupR(SLEEVE_FROM) + SLEEVE_PROUD, SLEEVE_TO - SLEEVE_FROM,
    CUP_X, SLEEVE_FROM, CUP_Z, PALETTE.coffeeSleeve);
  disc(LID_R, LID_R, LID_H, CUP_X, CUP_H, CUP_Z, PALETTE.coffeeLid);
  disc(RIM_R * 0.9, RIM_R, RIM_H, CUP_X, CUP_H + LID_H, CUP_Z, PALETTE.coffeeLid);

  for (const g of parts) {
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'color') g.deleteAttribute(name);
    }
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  // Centred on its own plan extents, so the idle spin turns it rather than orbiting it.
  merged.computeBoundingBox();
  const plan = merged.boundingBox;
  merged.translate(-(plan.min.x + plan.max.x) / 2, 0, -(plan.min.z + plan.max.z) / 2);
  merged.scale(CARGO_SCALE, CARGO_SCALE, CARGO_SCALE);

  // Smooth, for the donut's rounded tube (the roof's sign is drawn the same way); the cup's faces
  // came through `bakeColor` with face normals and light flat either way.
  const mesh = new THREE.Mesh(merged, propMaterial({ smooth: true }));
  mesh.castShadow = true;
  if (pickable) mesh.userData.pickable = pickable;
  group.add(mesh);

  if (!warmedFade) {
    warmedFade = true;
    alsoWarmAs(mesh.material, { transparent: true, depthWrite: false });
  }
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
