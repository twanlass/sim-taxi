import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { ROUTE_OPACITY } from '../game/routeline.js';

// Pickup and drop-off markers.
//
// A marker is two pieces with different jobs:
//   - a head floating over the pavement corner, for silhouette.
//   - a flat ring on the kerb below it, so the head and its "here" ring read as one object rather
//     than a crystal with a stray circle drawn on the road beneath it.
//
// The ring used to sit at the intersection centre — the idea being that a ring on the carriageway
// would never be occluded — but it left a visible gap between the marker and the ring, and the eye
// couldn't tell they belonged to each other. Sharing the corner fixes that.
//
// The head used to sit on top of a gold post planted on the pavement. The post is gone: the head
// alone is the cleaner read, and it is what the eye was tracking anyway. Its height is unchanged,
// so the marker still occupies the same slot in the skyline and nothing about the framing moves.

const HEAD_Y = 9.6;

// The head hops around its rest height. `Math.abs(sin)` never dips below it, so the marker only
// ever floats *up* from the height the ring below it implies.
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
    new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, fog: false }),
  );
  mesh.scale.copy(scale);
  return mesh;
}

// Every material here sets `fog: false`. The pin, its ring and its outline are markers the player
// has to find, so they are exempt from the weather the same way the rider's meter and the fare
// clock are — see game/weather.js for what fog is otherwise allowed to do to the far edge of the city.
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
 * object regardless of order. That used to wash the far half of it up over the base of the post
 * standing at its centre; with the post gone nothing stands in the disc for it to wash over.
 */
function targetRing(colorHex) {
  const group = new THREE.Group();
  group.position.y = 0.08;

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(RING_R, RING_TUBE, 6, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(colorHex), depthWrite: false, fog: false }),
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
      fog: false,
    }),
  );
  fill.renderOrder = 3;   // under the rim, so the rim still reads as an edge
  group.add(fill);

  return { group };
}

function marker(bodyColor, kind, buildStanding, ringColor = null) {
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

  // A marker can stand up as a floating head or as a figure; the ring below is identical either way.
  let standing = null;
  if (buildStanding) {
    standing = buildStanding();
    postGroup.add(standing.group);
  }

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
  const headBaseY = HEAD_Y;
  head.position.y = headBaseY;
  head.castShadow = true;
  head.visible = !buildStanding;
  postGroup.add(head);

  // Child of the head, so it inherits the bounce for free.
  head.add(outlineHull(head.geometry, new THREE.Vector3(1.12, 1.12, 1.12)));

  head.userData.pickable = kind;

  // `Math.abs(sin)` rather than a plain sine: it never dips below the rest position, and the
  // sharp cusp at the bottom of each cycle reads as a landing instead of a float.
  let bounce = 0;
  function update(dt) {
    if (!group.visible || !head.visible) return;
    bounce += dt;
    head.position.y = headBaseY + Math.abs(Math.sin(bounce * BOUNCE_RATE)) * BOUNCE_HEIGHT;
  }

  // Oversized invisible hit volume spanning head and ring — at full zoom-out the visible geometry
  // is only a few pixels across and would be miserable to tap.
  //
  // It has to cover the *junction* and the kerb corner, which are two different places: the box is
  // centred on the junction, and the standing pin is pushed out to a corner a little over 4 units
  // away. The first version was 9 units square, so the rider stood right on its edge and half of
  // every tap aimed at the figure missed. 20 covers the corner with real margin on every side —
  // about 155px across at play zoom, comfortably past the 44px a fingertip needs — while still
  // being well inside the 20-unit block pitch, so two adjacent junctions can never both be hit.
  const HIT = 20;
  // Tall enough to clear the head's top (9.6 + 1.9 radius + bounce) with room to spare, and it
  // starts at the ground so a tap on the ring or on a standing figure lands too.
  const HIT_H = 14.5;
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(HIT, HIT_H, HIT),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hit.position.y = HIT_H / 2;
  hit.userData.pickable = kind;
  group.add(hit);

  return { group, ring, postGroup, head, standing, update };
}

export const createPassengerPin = (buildStanding) =>
  marker(PALETTE.passenger, 'passenger', buildStanding);

/**
 * The drop-off pin: the taxi's yellow, fixed at build time.
 *
 * It briefly changed colour when the player tapped it — teal while the taxi was parked at the kerb
 * asking where to go, yellow once told. The taxi dispatches itself at pickup now, so a drop-off is
 * an instruction from the frame it appears and there is no unanswered state left to draw. The ring
 * on the tarmac is `routeLine`, the same paint as the band running into it, so the band and the
 * disc it lands in read as one mark.
 */
export const createDestinationPin = () =>
  marker(PALETTE.destination, 'destination', null, PALETTE.routeLine);
