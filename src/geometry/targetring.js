import * as THREE from 'three';
import { ROUTE_OPACITY } from '../game/routeline.js';

// The disc a fare marks its ground with: a filled circle inside a solid rim, lying flat on the
// pavement corner. Both ends of a trip wear one — under the waiting rider in their urgency colour,
// on the drop-off corner in teal — so "a disc means a place the taxi has to reach" is one rule with
// one shape behind it.
//
// The rider's has come and gone twice. It was a draining countdown ring first, then nothing at all
// while the meter (and later the diamond) carried the clock overhead, and it is back now as a
// second body for the same colour: the diamond says the urgency at eye level and the disc says it
// on the ground, where the driving is actually aimed. Two surfaces, one hue, no extra thing to
// learn — and a rider whose crystal is behind a tower still has a mark on the road.
//
// It never drains. Time is the colour's job; this only has to say "here".

export const RING_R = 3.5;
const RING_TUBE = 0.16;

// How far the disc floats above the surface it marks, so it paints over the pavement rather than
// z-fighting with it. Shared by both ends of the trip, which is what keeps them looking like the
// same object in two colours.
export const RING_Y = 0.2;

// One rim and one fill shape for every disc on the board — only the colour ever differs. The fill
// overlaps into the rim's tube rather than stopping at its inner edge, so no hairline of road shows
// between the two where the torus tessellates.
const RIM_GEO = new THREE.TorusGeometry(RING_R, RING_TUBE, 6, 48).rotateX(-Math.PI / 2);
const FILL_GEO = new THREE.CircleGeometry(RING_R - RING_TUBE / 2, 48).rotateX(-Math.PI / 2);

/**
 * A target disc in one colour.
 *
 * The fill is at the route band's own opacity (see game/routeline.js), so a disc and the band
 * running into it read as one weight of paint. Depth-tested — a car crossing the junction should
 * drive *over* a disc rather than the disc painting across the car — and `depthWrite: false`, so
 * the two layers don't fight each other for the same plane.
 *
 * Being translucent puts the fill in three's transparent queue, which draws after every opaque
 * object regardless of order. That is exactly why the depth test has to stay on: under a waiting
 * rider, the far half of a flat circle projects *upward on screen* at this camera angle, and
 * without the test it would paint a band across the figure standing in it. (The old countdown ring
 * drew with the test off for legibility and needed a whole renderOrder convention to survive that.)
 */
export function createTargetRing(colorHex) {
  const group = new THREE.Group();
  const color = new THREE.Color(colorHex);

  const rim = new THREE.Mesh(
    RIM_GEO,
    new THREE.MeshBasicMaterial({ color: color.clone(), depthWrite: false }),
  );
  rim.renderOrder = 4;
  rim.raycast = () => {};
  group.add(rim);

  const fill = new THREE.Mesh(FILL_GEO, new THREE.MeshBasicMaterial({
    color: color.clone(),
    transparent: true,
    opacity: ROUTE_OPACITY,
    depthWrite: false,
  }));
  fill.renderOrder = 3;   // under the rim, so the rim still reads as an edge
  fill.raycast = () => {};
  group.add(fill);

  return {
    group,
    /** Both layers together — they are one mark at two weights, never two colours. */
    setColor(value) {
      rim.material.color.set(value);
      fill.material.color.set(value);
    },
  };
}
