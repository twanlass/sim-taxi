import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { createTargetRing, RING_Y } from './targetring.js';

// Pickup and drop-off markers.
//
// Both are a kerb-corner placement, a tap target, and what stands on it:
//   - the pickup stands a **figure** there, over a disc in the fare's urgency colour.
//   - the drop-off lays a **teal disc** on the corner and nothing else.
//
// The disc is the same object at both ends (geometry/targetring.js) and the colour is what tells
// them apart: a clock at one end, a destination at the other. The fare's clock itself — the diamond
// that floats over the rider and then flies to the taxi — belongs to the fare rather than to either
// marker, and lives in game/faremarker.js. It has to leave the kerb, so it cannot hang off a marker
// that stays.
//
// The disc used to sit at the intersection centre — the idea being that a disc on the carriageway
// would never be occluded — but it left a visible gap between the marker and it, and the eye
// couldn't tell they belonged to each other. Sharing the corner fixes that.
//
// **The drop-off has lost its floating head.** It was a gold post with a crystal on top, then the
// crystal alone at y = 9.6, then that crystal in teal once the rider's marker became the same
// model. The last step is what made it redundant: two diamonds on the board, one of them saying
// nothing but "this is a place", and the disc underneath was already saying that at ground level
// where the driving happens. The taxi is being driven *to a spot on the road*, and the spot is now
// the whole marker.
//
// The off-screen pointer (game/dropoffindicator.js) covers the one thing the head was still worth:
// a drop-off that has slipped outside the frame.

function marker(kind, { buildStanding = null, ringColor = null } = {}) {
  const group = new THREE.Group();
  group.name = kind;

  // Everything that stands on the corner lives in here, so the caller can shift it to a pavement
  // corner as a single unit.
  const postGroup = new THREE.Group();
  group.add(postGroup);

  // On postGroup, so the disc follows the same kerb corner as whatever stands on it instead of
  // being stranded at the junction centre.
  //
  // The rider's disc is not built here: it is the fare's clock speaking on the ground, it changes
  // colour every few seconds and it has to go dark the moment they board — all of which belongs to
  // game/faremarker.js, which owns the clock. This is the drop-off's, which is one colour forever.
  const ring = ringColor ? createTargetRing(ringColor) : null;
  // place() already lifts postGroup 0.12 above the kerb, so this lands the disc RING_Y over the
  // pavement — the same height the rider's own disc floats at.
  if (ring) {
    ring.group.position.y = RING_Y - 0.12;
    postGroup.add(ring.group);
  }

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
  // Tall enough to clear the tallest thing standing over this corner — the fare's diamond, whose
  // outline tops out a little over 9 — and it starts at the ground so a tap on the disc or on a
  // standing figure lands too.
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
 * a fare marker means urgency now (see game/faremarker.js), and this one has no clock to report.
 */
export const createDestinationPin = () =>
  marker('destination', { ringColor: PALETTE.destination });
