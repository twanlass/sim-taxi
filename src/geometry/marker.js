import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { ROUTE_OPACITY } from '../game/routeline.js';

// Pickup and drop-off markers.
//
// Both are a kerb-corner placement, a tap target, and one thing standing on it:
//   - the pickup stands a **figure** there, with the rider's urgency diamond floating over their
//     head (geometry/riderdiamond.js).
//   - the drop-off lays a **ring** on the kerb and nothing else.
//
// The ring used to sit at the intersection centre — the idea being that a ring on the carriageway
// would never be occluded — but it left a visible gap between the marker and the ring, and the eye
// couldn't tell they belonged to each other. Sharing the corner fixes that.
//
// **The drop-off has lost its floating head.** It was a gold post with a crystal on top, then the
// crystal alone at y = 9.6, then that crystal in teal once the rider's marker became the same
// model. The last step is what made it redundant: two diamonds on the board, one of them saying
// nothing but "this is a place", and the ring underneath was already saying that at ground level
// where the driving happens. What is left is the disc the route band runs into — the taxi is being
// driven *to a spot on the road*, and the spot is now the whole marker.
//
// The off-screen pointer (game/dropoffindicator.js) covers the one thing the head was still worth:
// a drop-off that has slipped outside the frame.

const RING_R = 3.5;
const RING_TUBE = 0.16;

/**
 * A static target ring with its circle filled in. The countdown itself lives in game/timerring.js
 * and travels with the fare, so this only has to say "here" — it never drains.
 *
 * The fill is at the route band's own opacity (see game/routeline.js). The two are no longer the
 * same colour — the band is the taxi's yellow and the disc is the drop-off's teal — but they still
 * meet on the same tarmac, and a disc at a heavier weight than the band running into it reads as
 * the louder half of one mark. Depth-tested like the band for the same reason — a car crossing the
 * junction should drive *over* the disc rather than the disc painting across the car.
 *
 * Being translucent puts the disc in three's transparent queue, which draws after every opaque
 * object regardless of order. That used to wash the far half of it up over the base of the post
 * standing at its centre; nothing stands in the disc any more for it to wash over.
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

  return { group };
}

function marker(kind, { buildStanding = null, ringColor = null } = {}) {
  const group = new THREE.Group();
  group.name = kind;

  // Everything that stands on the corner lives in here, so the caller can shift it to a pavement
  // corner as a single unit.
  const postGroup = new THREE.Group();
  group.add(postGroup);

  // The waiting rider gets no ring of its own — the fare's travelling timer sits under them.
  // The drop-off's ring lives on postGroup so it follows the same kerb corner instead of being
  // stranded at the junction centre.
  const ring = ringColor ? targetRing(ringColor) : null;
  if (ring) postGroup.add(ring.group);

  let standing = null;
  if (buildStanding) {
    standing = buildStanding();
    postGroup.add(standing.group);
  }

  // Oversized invisible hit volume — at play zoom the visible geometry is a few pixels across and
  // would be miserable to tap.
  //
  // It has to cover the *junction* and the kerb corner, which are two different places: the box is
  // centred on the junction, and what stands on it is pushed out to a corner a little over 4 units
  // away. The first version was 9 units square, so the rider stood right on its edge and half of
  // every tap aimed at the figure missed. 20 covers the corner with real margin on every side —
  // about 155px across at play zoom, comfortably past the 44px a fingertip needs — while still
  // being well inside the 20-unit block pitch, so two adjacent junctions can never both be hit.
  const HIT = 20;
  // Tall enough to clear the tallest thing a marker carries — the rider's diamond, whose outline
  // tops out a little over 9 — and it starts at the ground so a tap on the ring or on a standing
  // figure lands too.
  const HIT_H = 14.5;
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(HIT, HIT_H, HIT),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hit.position.y = HIT_H / 2;
  hit.userData.pickable = kind;
  group.add(hit);

  return { group, ring, postGroup, standing };
}

export const createPassengerPin = (buildStanding) =>
  marker('passenger', { buildStanding });

/**
 * The drop-off: a teal disc on the kerb corner, and nothing standing on it.
 *
 * One colour, fixed at build time. There is only ever one drop-off on the board — the rider
 * currently aboard — so there is nothing for a per-fare hue to tell it apart from, and by the time
 * it is drawn the taxi is already driving at it. Teal rather than the taxi's yellow because hue on
 * a fare marker means urgency now (see geometry/riderdiamond.js), and this one has no clock to
 * report.
 */
export const createDestinationPin = () =>
  marker('destination', { ringColor: PALETTE.destination });
