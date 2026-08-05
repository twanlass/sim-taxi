import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { ROUTE_OPACITY } from '../game/routeline.js';

// Pickup and drop-off markers.
//
// A marker is two pieces with different jobs:
//   - a tall pin on the pavement corner, for silhouette.
//   - a flat ring on the kerb around that pin's base, so the pin and its "here" ring read as one
//     object rather than a pole with a stray circle drawn on the road beside it.
//
// The ring used to sit at the intersection centre — the idea being that a ring on the carriageway
// would never be occluded — but it left a visible gap between the pole and the ring, and the eye
// couldn't tell they belonged to each other. Sharing the corner fixes that.

const PIN_H = 8.5;

// The head hops rather than the whole pin. Lifting the post too would pull its foot off the
// pavement and leave a visible gap; the head has 0.8 units of overlap with the post top to play
// with, so anything up to about 0.5 stays seated.
const BOUNCE_HEIGHT = 0.45;
const BOUNCE_RATE = 3.4;

/**
 * A black outline, drawn as an inverted hull: the same shape a little larger, with only its back
 * faces rendered. The enlarged back faces sit behind the real surface everywhere except around
 * the silhouette, which is exactly where the rim shows.
 *
 * Cheaper than a post-processing edge pass, and it needs no render targets — this is one small
 * object, not a whole-scene effect.
 */
function outlineHull(geometry, scale) {
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide }),
  );
  mesh.scale.copy(scale);
  return mesh;
}

const RING_R = 3.5;
const RING_TUBE = 0.16;

/**
 * A static target ring with its circle filled in. The countdown itself lives in game/timerring.js
 * and travels with the fare, so this only has to say "here" — it never drains.
 *
 * The fill is at the route band's own opacity (see game/routeline.js): the band on the road and the
 * disc at the end of it are one statement in two places, and at different weights one of them reads
 * as the louder half of it. Depth-tested like the band for the same reason — a car crossing the
 * junction should drive *over* the disc rather than the disc painting across the car.
 *
 * Being translucent puts the disc in three's transparent queue, which draws after every opaque
 * object regardless of order, so the far half of it washes up over the base of the post standing at
 * its centre. That is invisible in practice because the post is the same yellow one shade down.
 */
function targetRing(colorHex) {
  const group = new THREE.Group();
  group.position.y = 0.08;

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(RING_R, RING_TUBE, 6, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex), depthWrite: false }),
  );
  rim.renderOrder = 4;
  group.add(rim);

  // Overlaps into the rim's tube rather than stopping at its inner edge, so no hairline of road
  // shows between the two where the torus tessellates.
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(RING_R - RING_TUBE / 2, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(colorHex),
      transparent: true,
      opacity: ROUTE_OPACITY,
      depthWrite: false,
    }),
  );
  fill.renderOrder = 3;   // under the rim, so the rim still reads as an edge
  group.add(fill);

  // Both layers repaint together — the fill is the rim's own colour at the band's opacity, so a rim
  // that changed on its own would read as a ring with a stale disc sitting inside it.
  const setColor = (hex) => {
    rim.material.color.set(hex);
    fill.material.color.set(hex);
  };

  return { group, setColor };
}

function marker(bodyColor, postColor, kind, buildStanding, ringColor = null) {
  const group = new THREE.Group();
  group.name = kind;

  // Everything that stands up lives in here, so the caller can shift it to a pavement corner
  // as a single unit.
  const postGroup = new THREE.Group();
  group.add(postGroup);

  // The waiting rider gets no ring of its own — the fare's travelling timer sits under them.
  // The destination's ring lives on postGroup so it follows the pole to the kerb corner instead
  // of being stranded at the junction centre. Its own colour rather than the pin's: the disc is
  // road paint, a lightened version of whatever the pin above it is wearing — and once the pin is
  // selected, exactly the paint the route band running into it is drawn in.
  const ring = ringColor ? targetRing(ringColor) : null;
  if (ring) postGroup.add(ring.group);

  // A marker can stand up as a signpost or as a figure; the ring below is identical either way.
  let standing = null;
  if (buildStanding) {
    standing = buildStanding();
    postGroup.add(standing.group);
  }

  // Emissive like the head, at half its strength. Only the drop-off pin ever shows its post — a
  // rider's figure replaces it — and the face the fixed camera sees is the one turned away from
  // the sun, so pure Lambert shaded the gold pole down to rgb(110, 68, 6): a brown stick under a
  // gold head. With the lift it renders at rgb(152, 106, 19), still shaded but still gold.
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.3, PIN_H, 6),
    new THREE.MeshLambertMaterial({
      color: new THREE.Color(postColor),
      emissive: new THREE.Color(postColor),
      emissiveIntensity: 0.18,
      flatShading: true,
    }),
  );
  post.position.y = PIN_H / 2;
  post.visible = !buildStanding;
  postGroup.add(post);

  // Widened but not lengthened — a uniform scale would push the outline's end caps past the
  // post's own, and both ends are meant to stay tucked (one in the ground, one inside the head).
  post.add(outlineHull(post.geometry, new THREE.Vector3(1.6, 1, 1.6)));

  // Octahedron: reads clearly from straight above, unlike a sphere, and matches the crystal
  // vocabulary already used elsewhere in these prototypes.
  const head = new THREE.Mesh(
    new THREE.OctahedronGeometry(1.9, 0),
    new THREE.MeshLambertMaterial({
      color: new THREE.Color(bodyColor),
      emissive: new THREE.Color(bodyColor),
      emissiveIntensity: 0.35,
      flatShading: true,
    }),
  );
  const headBaseY = PIN_H + 1.1;
  head.position.y = headBaseY;
  head.castShadow = true;
  head.visible = !buildStanding;
  postGroup.add(head);

  // Child of the head, so it inherits the bounce for free.
  head.add(outlineHull(head.geometry, new THREE.Vector3(1.12, 1.12, 1.12)));

  for (const part of [post, head]) part.userData.pickable = kind;

  // `Math.abs(sin)` rather than a plain sine: it never dips below the rest position, and the
  // sharp cusp at the bottom of each cycle reads as a landing instead of a float.
  let bounce = 0;
  function update(dt) {
    if (!group.visible || !head.visible) return;
    bounce += dt;
    head.position.y = headBaseY + Math.abs(Math.sin(bounce * BOUNCE_RATE)) * BOUNCE_HEIGHT;
  }

  // Oversized invisible hit volume spanning both pieces — at full zoom-out the visible geometry
  // is only a few pixels across and would be miserable to tap.
  //
  // It has to cover the *junction* and the kerb corner, which are two different places: the box is
  // centred on the junction, and the standing pin is pushed out to a corner a little over 4 units
  // away. The first version was 9 units square, so the rider stood right on its edge and half of
  // every tap aimed at the figure missed. 20 covers the corner with real margin on every side —
  // about 155px across at play zoom, comfortably past the 44px a fingertip needs — while still
  // being well inside the 20-unit block pitch, so two adjacent junctions can never both be hit.
  const HIT = 20;
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(HIT, PIN_H + 6, HIT),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hit.position.y = (PIN_H + 6) / 2;
  hit.userData.pickable = kind;
  group.add(hit);

  /**
   * Repaint the whole marker. Emissive tracks the colour on both meshes — it is a fraction of the
   * base colour on each (see the two material blocks above), so leaving it behind would light a
   * repainted pin in the old hue. The outline hulls are pure black and stay put.
   */
  function setColors({ body, post: postHex, ring: ringHex }) {
    head.material.color.set(body);
    head.material.emissive.set(body);
    post.material.color.set(postHex);
    post.material.emissive.set(postHex);
    if (ring && ringHex) ring.setColor(ringHex);
  }

  return { group, ring, postGroup, head, standing, update, setColors };
}

export const createPassengerPin = (buildStanding) =>
  marker(PALETTE.passenger, PALETTE.passengerPost, 'passenger', buildStanding);

// The two states of a drop-off. See palette.js for why they are these colours: teal is the pin
// asking where to go, yellow is the taxi's own colour once you have answered it.
const DESTINATION_RESTING = {
  body: PALETTE.destination, post: PALETTE.destinationPost, ring: PALETTE.destinationRing,
};
const DESTINATION_SELECTED = {
  body: PALETTE.destinationSelected, post: PALETTE.destinationSelectedPost, ring: PALETTE.routeLine,
};

/**
 * The drop-off pin, which changes colour when the player sends the taxi at it.
 *
 * A drop-off appears the instant a rider boards, and the taxi *parks* until it is tapped — so for
 * that stretch the pin is a question rather than an instruction, and it wears teal. The tap turns
 * it the taxi's yellow, joining the route band that appears on the road in the same frame. The
 * colour change is also the acknowledgement of the tap itself: on a phone the band can be drawn
 * entirely off-screen, and the pin is what the finger was already on.
 *
 * `setSelected` early-outs on no change so the per-frame reconcile in fares.js — which calls it
 * every frame a fare is aboard — isn't touching four materials for nothing.
 */
export function createDestinationPin() {
  const pin = marker(PALETTE.destination, PALETTE.destinationPost, 'destination', null,
    PALETTE.destinationRing);
  let selected = false;

  return {
    ...pin,
    setSelected(next) {
      if (selected === next) return;
      selected = next;
      pin.setColors(next ? DESTINATION_SELECTED : DESTINATION_RESTING);
    },
    isSelected: () => selected,
  };
}
