import * as THREE from 'three';
import { unlitMaterial } from '../util/geo.js';
import { DIAMOND_HALF_H, DIAMOND_RIM_ORDER, EMISSIVE, HIGHLIGHT_EMISSIVE } from './diamond.js';

// The VIP's marker: a chunky extruded question mark where every other fare wears a plumbob.
//
// The plumbob is a *clock* — it drains, it steps through the urgency scale, and its whole content is
// how long you have. A VIP's clock is deliberately hidden (docs/gameplay.md, "VIP pickups"), so its
// crystal was a plumbob that had been told not to do the one thing a plumbob does: a solid purple
// gem, never draining. The hue said "different" and the shape still said "timer". A question mark
// says the thing that is actually true — you do not know how long this one gives you — and it says
// it with the silhouette, which carries further across the board than a hue does.
//
// It stands in the plumbob's slot rather than beside it: same headroom over the rider (its bottom
// sits at `-DIAMOND_HALF_H`, so `LIFT` and `CRYSTAL_TOP` in game/faremarker.js hold unchanged), same
// bounce, kick, pulse, pop and shake, all driven by game/faremarker.js on the marker's pose.
//
// **Authored flat against the screen.** The glyph is drawn in its local XY and extruded along Z,
// and the marker turns it to `BILLBOARD` (game/camera.js), so it always reads upright at the fixed
// camera. A slow rock about world Y is what shows the extrusion off — a question mark held dead
// face-on is a flat sticker, and the depth is what makes it the same kind of object as the gem it
// replaces.

// The glyph's centreline, in pre-scale units: a hook of radius HOOK_R about (0, HOOK_Y) swept
// clockwise from the upper left, round over the top and down to the bottom of its own circle, then
// a straight stem. The stroke is STROKE wide and the dot is an octagon under the stem.
const HOOK_R = 0.85;
const HOOK_Y = 1.05;
const HOOK_FROM = THREE.MathUtils.degToRad(165);
const HOOK_TO = THREE.MathUtils.degToRad(-90);
const HOOK_SEGMENTS = 10;      // low-poly: facets on the curve rather than a smooth arc
const STEM_BOTTOM = -0.55;
const STROKE = 0.55;
const DOT_R = 0.38;
const DOT_Y = -1.25;
const DEPTH = 0.7;

// Scaled so the glyph is as tall as the plumbob it stands in for (4.5 world units), which lands it
// about 2.65 wide — a little narrower than the gem's 2.8, which the open hook makes up for.
const GLYPH_H = (HOOK_Y + HOOK_R + STROKE / 2) - (DOT_Y - DOT_R);
const SCALE = (2 * DIAMOND_HALF_H) / GLYPH_H;
// Shift so the glyph is centred on its origin, like the plumbob — the bounce and the pulse scale
// about the origin, and the headroom maths reads the bottom off `DIAMOND_HALF_H`.
const MID_Y = ((HOOK_Y + HOOK_R + STROKE / 2) + (DOT_Y - DOT_R)) / 2;

// The rim, in world units. Grown in the 2D outline (see `glyphShapes`) rather than by scaling a
// copy: a scale about the origin pushes the dot and the top of the hook out by different amounts
// and moves the dot off its own centre, where an offset of the outline is even everywhere by
// construction.
//
// Thinner than the plumbob's `RIM_OFFSET` (0.22) on purpose, to *look* the same weight. That one is
// a 3D offset off faces that are mostly turned away from the camera, so it projects to well under
// its own number on screen; this one lies in the screen plane and shows in full. At 0.22 the
// question mark wore about twice the crystal's line beside it; 0.14 matches by eye.
const RIM = 0.14 / SCALE;

/**
 * The two pieces of the glyph as shapes, grown outward by `grow` (pre-scale units).
 *
 * The stroke is the centreline offset to both sides with mitred corners — the one sharp corner is
 * where the hook meets the stem — and square ends extended by `grow`, so the outline's ends are as
 * thick as its sides.
 */
function glyphShapes(grow) {
  const half = STROKE / 2 + grow;
  const line = [];
  for (let i = 0; i <= HOOK_SEGMENTS; i++) {
    const a = THREE.MathUtils.lerp(HOOK_FROM, HOOK_TO, i / HOOK_SEGMENTS);
    line.push(new THREE.Vector2(Math.cos(a) * HOOK_R, HOOK_Y + Math.sin(a) * HOOK_R));
  }
  line.push(new THREE.Vector2(0, STEM_BOTTOM));

  // Square ends, pushed out along the line by `grow`.
  const head = line[0].clone().sub(line[1]).normalize().multiplyScalar(grow);
  line[0].add(head);
  const last = line.length - 1;
  const tail = line[last].clone().sub(line[last - 1]).normalize().multiplyScalar(grow);
  line[last].add(tail);

  // Left-hand normals of each segment, then mitred at every interior point.
  const segNormal = (i) => {
    const d = line[i + 1].clone().sub(line[i]).normalize();
    return new THREE.Vector2(-d.y, d.x);
  };
  const offsets = line.map((_, i) => {
    if (i === 0) return segNormal(0).multiplyScalar(half);
    if (i === last) return segNormal(last - 1).multiplyScalar(half);
    const n1 = segNormal(i - 1);
    const n = n1.clone().add(segNormal(i)).normalize();
    return n.multiplyScalar(half / n.dot(n1));
  });

  const left = line.map((p, i) => p.clone().add(offsets[i]));
  const right = line.map((p, i) => p.clone().sub(offsets[i])).reverse();
  const stroke = new THREE.Shape([...left, ...right]);

  // An octagon turned half a step, so a flat rather than a point sits under the stem.
  const dot = new THREE.Shape();
  const r = (DOT_R + grow) / Math.cos(Math.PI / 8);
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + (i / 8) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = DOT_Y + Math.sin(a) * r;
    if (i === 0) dot.moveTo(x, y); else dot.lineTo(x, y);
  }
  dot.closePath();
  return [stroke, dot];
}

/**
 * The glyph as a solid, grown by `grow` in the plane, centred and scaled.
 *
 * The depth grows by a fraction of that, not the full `2 * grow` a true offset surface would take.
 * The camera looks down the diagonal, so any extra depth on the outline shows beside the glyph as
 * a second, thicker rim — the first cut grew it in full and the question mark wore about twice the
 * crystal's line weight next to it. A sliver is enough to keep the hull's back cap off the glyph's.
 */
function glyphGeometry(grow) {
  const depth = DEPTH + 0.4 * grow;
  // No bevel: flat caps and straight walls are the city's facet language, and `ExtrudeGeometry`
  // winds both caps outward itself whichever way round the shape was drawn.
  const geo = new THREE.ExtrudeGeometry(glyphShapes(grow), {
    depth, bevelEnabled: false, curveSegments: 1,
  });
  geo.translate(0, -MID_Y, -depth / 2);
  geo.scale(SCALE, SCALE, SCALE);
  geo.computeVertexNormals();
  return geo;
}

const GEO = glyphGeometry(0);
const RIM_GEO = glyphGeometry(RIM);

/** The glyph's geometry, for `tools/probe.mjs` to check the winding of. */
export const QUESTION_GEO = GEO;

/**
 * One question mark and its black outline. The same interface as `createDiamond` where the two
 * overlap — `mesh`, `rim`, `setColor`, `setHighlight` — so the marker can drive either.
 */
export function createQuestionMark(colorHex) {
  const color = new THREE.Color(colorHex);
  const mesh = new THREE.Mesh(GEO, new THREE.MeshLambertMaterial({
    color: color.clone(),
    emissive: color.clone(),
    emissiveIntensity: EMISSIVE,
    flatShading: true,
    // Refuses the haze for the same reason the plumbob does: this is a marker, not scenery.
    fog: false,
  }));
  mesh.castShadow = true;

  // Opaque, so the ordinary inverted hull works as-is: the glyph writes depth in the opaque pass,
  // and the hull's back faces fail the test everywhere but the ring around the silhouette.
  const rim = new THREE.Mesh(RIM_GEO, unlitMaterial({ color: 0x000000, side: THREE.BackSide }));
  rim.renderOrder = DIAMOND_RIM_ORDER;
  mesh.add(rim);

  return {
    mesh,
    rim,
    setColor(value) {
      mesh.material.color.set(value);
      mesh.material.emissive.set(value);
    },
    setHighlight(amount) {
      mesh.material.emissiveIntensity = THREE.MathUtils.lerp(EMISSIVE, HIGHLIGHT_EMISSIVE, amount);
    },
  };
}

// The rock that shows the extrusion: a slow swing about world Y, either side of face-on. Slow
// enough to read as the object turning rather than wobbling, wide enough that the side walls show.
export const ROCK_ANGLE = 0.45;   // radians either side, ~26°
export const ROCK_RATE = 1.6;     // radians of phase per second, ~4s a full swing
