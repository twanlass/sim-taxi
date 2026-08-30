import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import {
  archAt, ARCH_RISE, DECK_THICK, DECK_OVERHANG, WATER_Y, RAIL_H, RAIL_W, RAIL_POST_PITCH,
} from '../city/river.js';
import { KERB_H } from '../city/ground.js';

// A bridge across the river: deck, edge beams, parapets, abutments and the paint down the middle.
//
// **The fixed spans arch and the drawbridge does not.** A bascule leaf has to be flat to lie down
// and to hinge, so the one that lifts is the one span at plain road level — and the hump on the
// other three is what lets a boat clear them without anything having to move. See the clearance
// chain in `city/river.js`.
//
// Everything here is built along a span's own axis: **+Z across the river, +X across the road**,
// origin on the centreline at the south bank. `createBridge` places the group.

/**
 * Segments along the span. Ten is a hump you cannot see the facets of at play zoom.
 *
 * Exported because the route band subdivides itself on the same count: a ribbon laid over the deck
 * with facet boundaries that do not line up with the deck's own beats against it as the camera
 * moves.
 */
export const DECK_SEGMENTS = 10;


/** How far the abutment carries down past the waterline. Nothing is seen below it. */
const ABUT_FOOT = 1.0;
const ABUT_DEPTH = 0.9;          // how far the abutment reaches back under the bank

// How far the abutment stands **proud of** the channel wall — see `abutmentParts`.
//
// **Sized against a depth buffer, not against the eye.** The camera's frustum is 1 to 1400
// (`createCityCamera`), so a 16-bit depth buffer — which is what a phone may hand back — quantises
// it at 0.021 units a step. 0.1 is five of those and 1200 steps of a 24-bit one, so the abutment
// wins this plane on every GPU rather than on most of them. In the other direction it is 0.77px at
// play zoom: an abutment standing a fraction proud of the wall either side of it is what an
// abutment does, and at this size it is read as a hard edge rather than as a ledge.
//
// **Proud rather than recessed, and that is a choice about what you see, not a sign.** Both break
// the tie. Recessing it hands the plane to the wall, and the wall runs *past* the bridge — so the
// arch would frame an unbroken bank with no visible abutment in it at all, which is the one thing
// the geometry under there is for. Standing it proud keeps what the desktop happened to draw while
// the tie stood, and closes the plane completely instead of leaving a slot behind it.
const ABUT_WALL_CLEAR = 0.1;

// The dashes down the middle, matched to `markRoad`'s own so a bridge reads as the road carrying
// on. They ride the deck rather than the ground, which is the whole reason they are here: a flat
// quad at y = 0.02 would sink into an arch.
const DASH = 1.6;
const DASH_GAP = 1.4;
const DASH_W = 0.18;
const PAINT_LIFT = 0.02;

/**
 * Height and slope of a deck at a fraction along its span.
 *
 * One function for both kinds, with the arch's rise set to zero on a flat one, so a caller cannot
 * accidentally build a lifting leaf with a curve in it.
 */
const profileAt = (u, span, rise) => archAt(u, span, rise);

/**
 * A strip lofted along the span: a quad per segment, at `x0..x1` across and `lift` above the
 * deck surface.
 *
 * Hand-wound, so the winding is asserted rather than eyeballed — this is exactly the shape the
 * roadworks ramp shipped inside out, and `computeVertexNormals` would launder a reversed triangle
 * into whatever its neighbours claimed. Taken in increasing (x, z) a quad faces **down**, so the
 * order below is the one that faces up.
 */
function loftedStrip(x0, x1, span, rise, lift, from = 0, to = 1) {
  const pos = [];
  // **Sorted, not taken as given.** Half the callers below build a pair of strips off a `sign`, so
  // one of the two arrives with its ends the other way round — and a quad wound from x1 to x0
  // faces *down*. That is the roadworks ramp's bug exactly: the surface still lights, because
  // `flatShading` takes its normal from a screen-space derivative, so it reads as z-fighting rather
  // than as a reversed face. `tools/probe.mjs` computes the normal from this winding.
  const [xa, xb] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const at = (u) => profileAt(u, span, rise).y + lift;
  for (let s = 0; s < DECK_SEGMENTS; s++) {
    const ua = from + ((to - from) * s) / DECK_SEGMENTS;
    const ub = from + ((to - from) * (s + 1)) / DECK_SEGMENTS;
    const za = ua * span;
    const zb = ub * span;
    const ya = at(ua);
    const yb = at(ub);
    pos.push(
      xa, ya, za, xa, yb, zb, xb, yb, zb,
      xa, ya, za, xb, yb, zb, xb, ya, za,
    );
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  return geo;
}

/** The same strip's underside: the soffit, wound the other way so it faces down. */
function soffitStrip(x0, x1, span, rise, drop, from = 0, to = 1) {
  const pos = [];
  const [xa, xb] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const at = (u) => profileAt(u, span, rise).y - drop;
  for (let s = 0; s < DECK_SEGMENTS; s++) {
    const ua = from + ((to - from) * s) / DECK_SEGMENTS;
    const ub = from + ((to - from) * (s + 1)) / DECK_SEGMENTS;
    const za = ua * span;
    const zb = ub * span;
    const ya = at(ua);
    const yb = at(ub);
    pos.push(
      xa, ya, za, xb, yb, zb, xa, yb, zb,
      xa, ya, za, xb, ya, za, xb, yb, zb,
    );
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  return geo;
}

/** The deck's outer flank: a vertical band following the profile, facing `sign` in x. */
function flankStrip(x, span, rise, top, bottom, sign, from = 0, to = 1) {
  const pos = [];
  for (let s = 0; s < DECK_SEGMENTS; s++) {
    const ua = from + ((to - from) * s) / DECK_SEGMENTS;
    const ub = from + ((to - from) * (s + 1)) / DECK_SEGMENTS;
    const za = ua * span;
    const zb = ub * span;
    const ya = profileAt(ua, span, rise).y;
    const yb = profileAt(ub, span, rise).y;
    const quad = sign > 0
      ? [x, ya + top, za, x, ya - bottom, za, x, yb - bottom, zb,
         x, ya + top, za, x, yb - bottom, zb, x, yb + top, zb]
      : [x, ya + top, za, x, yb - bottom, zb, x, ya - bottom, za,
         x, ya + top, za, x, yb + top, zb, x, yb - bottom, zb];
    pos.push(...quad);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * A railing following the deck's own profile, at `x` across, standing `lift` above it.
 *
 * Posts on `RAIL_POST_PITCH`, and the two rails between them built as **short boxes pitched to the
 * chord** rather than as lofted ribbons. At a 16-degree peak grade and a 0.14 section a rail is
 * about a pixel wide at play zoom, so what has to be right is that it *follows* the hump — a
 * lofted quad would be flat-on to the camera from one side and invisible from the other, and four
 * of them per rail to make a bar is more geometry than the whole bridge deck.
 *
 * Segments are walked between consecutive post positions, so a rail always lands on a post at both
 * ends and there is no dangling stub at the crest.
 */
function archRailing(x, span, rise, lift, col, from, to) {
  const parts = [];
  const at = (u) => profileAt(u, span, rise);
  const step = RAIL_POST_PITCH / span;

  const posts = [];
  for (let u = from + step / 2; u <= to - step / 4; u += step) posts.push(u);
  if (posts.length < 2) posts.push(from + (to - from) / 2);

  for (const u of posts) {
    const post = new THREE.BoxGeometry(RAIL_W, RAIL_H, RAIL_W);
    post.translate(x, at(u).y + lift + RAIL_H / 2, u * span);
    parts.push(bakeColor(post, col));
  }

  for (const [h, thick] of [[RAIL_H - RAIL_W / 2, RAIL_W], [RAIL_H * 0.5, RAIL_W * 0.7]]) {
    for (let k = 0; k < posts.length - 1; k++) {
      const ua = posts[k];
      const ub = posts[k + 1];
      const za = ua * span;
      const zb = ub * span;
      const ya = at(ua).y + lift + h;
      const yb = at(ub).y + lift + h;
      const len = Math.hypot(zb - za, yb - ya);
      const rail = new THREE.BoxGeometry(thick, thick, len);
      // Pitched to the chord. A rotation about +X tips +Z toward -Y, so the sign is negative for a
      // rail that is climbing.
      rail.rotateX(-Math.atan2(yb - ya, zb - za));
      rail.translate(x, (ya + yb) / 2, (za + zb) / 2);
      parts.push(bakeColor(rail, col));
    }
  }

  return parts;
}

/**
 * The parts of one span.
 *
 * @param span   from `bridgeSpan` in city/river.js
 * @param rng    for the colour jitter every merged city mesh wears
 * @param range  [from, to] as fractions of the span — the drawbridge builds its fixed approach and
 *               its leaf as two calls over two ranges of the same profile, so that a leaf lowered
 *               back down sits exactly on the road it came out of.
 */
export function bridgeParts(span, rng, range = [0, 1]) {
  const length = span.z1 - span.z0;
  const rise = span.kind === 'fixed' ? ARCH_RISE : 0;
  const [from, to] = range;
  const parts = [];

  // The lifting span is steel plate rather than asphalt — see `drawbridgeDeck`. Keyed off the
  // span's own kind so the leaf and its abutments cannot disagree about what they are made of.
  const deckCol = jitterColor(
    span.kind === 'draw' ? PALETTE.drawbridgeDeck : PALETTE.bridgeDeck, rng, { l: 0.02 },
  );
  const trimCol = jitterColor(PALETTE.bridgeTrim, rng, { l: 0.02 });
  const kerbCol = jitterColor(PALETTE.kerb, rng, { l: 0.02 });
  const walkCol = jitterColor(PALETTE.sidewalk, rng, { l: 0.03 });
  const markCol = color('laneMark');

  const soffitCol = jitterColor(PALETTE.bridgeSoffit, rng, { l: 0.02 });

  // Running surface, and the soffit under the whole deck.
  parts.push(bakeColor(loftedStrip(-span.half, span.half, length, rise, 0, from, to), deckCol));
  parts.push(bakeColor(
    soffitStrip(-span.outer, span.outer, length, rise, DECK_THICK, from, to), soffitCol,
  ));

  for (const sign of [-1, 1]) {
    // **A raised footway, not a shoulder.** The deck carries a pavement across at the same
    // `KERB_H` every block in the city stands its own at, so the walk running down the embankment
    // arrives at the bridge at the height it left — and a car on the deck has a kerb beside it
    // rather than a painted line.
    parts.push(bakeColor(
      loftedStrip(sign * span.half, sign * span.outer, length, rise, KERB_H, from, to), walkCol,
    ));
    // Its kerb face, turned in toward the carriageway where the driver sees it.
    parts.push(bakeColor(
      flankStrip(sign * span.half, length, rise, KERB_H, 0, -sign, from, to), kerbCol,
    ));
    // The edge beam: one face from the top of the footway all the way down to the soffit.
    parts.push(bakeColor(
      flankStrip(sign * span.outer, length, rise, KERB_H, DECK_THICK, sign, from, to), trimCol,
    ));
    // ...and the railing standing on the footway, set in by half its own section so the posts sit
    // on the deck rather than overhanging the beam.
    parts.push(...archRailing(
      sign * (span.outer - RAIL_W), length, rise, KERB_H, trimCol, from, to,
    ));
  }

  // Centre-line dashes, walked in arc length rather than in z so the spacing does not stretch over
  // the crest. Only on the stretch this call covers.
  for (let s = DASH_GAP; s + DASH < length; s += DASH + DASH_GAP) {
    const u0 = s / length;
    const u1 = (s + DASH) / length;
    if (u0 < from || u1 > to) continue;
    parts.push(bakeColor(
      loftedStrip(-DASH_W / 2, DASH_W / 2, length, rise, PAINT_LIFT, u0, u1), markCol,
    ));
  }

  return parts;
}

/** The abutment under one end of a span: a block from the deck down past the waterline. */
export function abutmentParts(span, rng, end) {
  const trimCol = jitterColor(PALETTE.bridgeTrim, rng, { l: 0.02 });
  const height = -WATER_Y + ABUT_FOOT;
  // **Forward to the water's edge, not just back under the bank.** The embankment strip either side
  // of the channel — a walk's width, `DECK_OVERHANG` — is interrupted for the bridge, and the slab
  // is cut bank to bank, so under the deck's two ends there was simply nothing: a void a walk wide,
  // roofed by the deck and open from the side. Over the city that is invisible, because what shows
  // through it is dark ground. At the mouth what shows through it is **sky**, and it was the last
  // bright speck left at the coast once the water had been shoaled out.
  //
  // **It goes `ABUT_WALL_CLEAR` past the wall, and that clearance is the whole point.** This used
  // to reach exactly to `DECK_OVERHANG`, on the reasoning that the two faces land on the same plane
  // but face opposite ways, so one of the pair is always back-facing and culled. That is not what
  // they do. The channel wall at `edges.z0` faces **into** the channel, and so does this face — it
  // is the +z end of a box sitting behind it — so at the far bank both are front-facing at once,
  // over the deck's full width and the 2.25 units of height the two share. And they were coplanar
  // to the last bit of a float32: the wall reaches its plane as `banks.z0 + EMBANK_WALK` and the
  // abutment reached it as `span.z0 + (ABUT_DEPTH + DECK_OVERHANG) - ABUT_DEPTH`, both rounding to
  // 6.733333110809326.
  //
  // Two exactly-tied surfaces do not shimmer. They hand the plane to whichever one the rasteriser
  // rounds in front, and it rounds a map-wide quad and a 10.8-unit box face differently — so this
  // read as a hard-edged patchwork that changed when the camera moved, and as one flat surface in
  // any given headless still — which is how it survived a first pass over the bridges. Headless it
  // came out wholly the abutment's; on the phone it was reported from, the same face came back cut
  // in two.
  //
  // The far bank is the one you see through the arch; the near bank's pair has the identical fault
  // and is back-facing under this camera. One line fixes both, and the invisible one is fixed too,
  // because "you cannot see it from here" is not a reason for two surfaces to share a plane.
  const depth = ABUT_DEPTH + DECK_OVERHANG + ABUT_WALL_CLEAR;
  const box = new THREE.BoxGeometry(span.outer * 2, height, depth);
  const mid = depth / 2 - ABUT_DEPTH;
  const z = end === 0 ? mid : (span.z1 - span.z0) - mid;
  box.translate(0, -DECK_THICK - height / 2, z);
  return [bakeColor(box, trimCol)];
}

/**
 * One span's geometry, merged.
 *
 * @param range   [from, to] as fractions of the span. The drawbridge builds its fixed approach and
 *                its leaf as two calls over two ranges of the same profile, so a leaf lowered back
 *                down sits exactly on the road it came out of rather than nearly on it.
 * @param pivotZ  z, in span-local units from the near bank, to put the geometry's origin on. The
 *                leaf needs its hinge at the origin so a group can turn it; everything else wants
 *                world coordinates and gets `null`.
 */
export function createBridge(span, rng, { range = [0, 1], abutments = true, pivotZ = null } = {}) {
  const parts = bridgeParts(span, rng, range);
  if (abutments) {
    if (range[0] <= 1e-9) parts.push(...abutmentParts(span, rng, 0));
    if (range[1] >= 1 - 1e-9) parts.push(...abutmentParts(span, rng, 1));
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((part) => part.dispose());
  if (pivotZ === null) merged.translate(span.cx, 0, span.z0);
  else merged.translate(0, 0, -pivotZ);
  return merged;
}
