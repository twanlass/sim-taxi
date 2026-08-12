import * as THREE from 'three';
import { URGENCY_SEGMENTS, fareColor, PARCEL_COLOR } from '../game/urgency.js';
import { createTargetRing, RING_Y } from './targetring.js';
import { createParcelPad } from './parcelpad.js';

// Pickup and drop-off markers.
//
// Both are a kerb-corner placement, a tap target, and what stands on it:
//   - the pickup stands a **figure** there, over a disc in the fare's urgency colour.
//   - the drop-off lays the same **disc** on the corner, in the same colour, and nothing else.
//
// **A disc marks the end of a trip that a clock is attached to, and one fare owns one at a time.**
// It is under the rider while they wait and on their destination once they are aboard — the same
// hand-off the crystal makes when it flies from the kerb to the taxi roof, made on the ground. What
// tells the two ends apart is not the hue (both are that fare's clock, see game/urgency.js) but
// whether anybody is standing in it: a disc with a figure in it is somewhere to collect, an empty
// one is somewhere to deliver. Which is also the difference the player is acting on.
//
// The fare's clock itself — the crystal that floats over the rider and then flies to the taxi —
// belongs to the fare rather than to either marker, and lives in game/faremarker.js. It has to
// leave the kerb, so it cannot hang off a marker that stays. The rider's disc lives there too, for
// the same reason inverted: it has to go dark on a frame this marker knows nothing about.
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

/**
 * @param buildStanding  factory for whatever stands on the corner (a figure, a parcel), or null
 * @param ringColor      colour for the ground mark, or null for a marker with no mark
 * @param buildRing      the ground-mark factory. Defaults to the fare disc; the courier markers
 *                       pass `createParcelPad` so a package's ends are a rounded square instead —
 *                       shape is what tells a courier job from a fare on this board.
 * @param pickable       the `userData.pickable` kind for the oversized hit box, or **null for no
 *                       hit box at all**. A courier marker is never tapped (the only way to reach a
 *                       package is to bend the route through it), so it builds none — an untappable
 *                       marker carrying a hit box tagged as pickable is a trap laid for whoever next
 *                       raycasts the scene rather than an explicit target list.
 */
function marker(kind, {
  buildStanding = null, ringColor = null, buildRing = createTargetRing, pickable = kind,
} = {}) {
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
  // game/faremarker.js, which owns the clock. This is the drop-off's.
  const ring = ringColor ? buildRing(ringColor) : null;
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
  // Tall enough to clear the tallest thing standing over this corner — the fare's crystal, whose
  // outline tops out a little over 9.5 — and it starts at the ground so a tap on the disc or on a
  // standing figure lands too.
  const HIT_H = 14.5;
  if (pickable) {
    const hit = new THREE.Mesh(
      new THREE.BoxGeometry(HIT, HIT_H, HIT),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    hit.position.y = HIT_H / 2;
    hit.userData.pickable = pickable;
    group.add(hit);
  }

  return { group, ring, postGroup, standing };
}

export const createPassengerPin = (buildStanding) =>
  marker('passenger', { buildStanding });

/**
 * The drop-off: a disc on the kerb corner, and nothing standing on it.
 *
 * **It wears the clock of the rider in the car.** It has no clock of its own — that was the whole
 * argument for the fixed teal it used to be painted, back when hue on a fare marker meant urgency
 * and this marker had nothing to report. But the rider aboard is *why* the taxi is driving here,
 * their deadline is the only one the drive is spending, and the crystal saying so is a small shape
 * over a moving roof. Painting the destination in that colour puts the seconds on the tarmac at the
 * far end of the trip, which is where the player is already looking.
 *
 * Opens on the top of the scale and is repainted per fare by `game/fares.js`, which owns the clock;
 * a VIP's stays its fixed purple, the same exception the crystal makes.
 */
export const createDestinationPin = () =>
  marker('destination', { ringColor: fareColor(URGENCY_SEGMENTS) });

/**
 * A package waiting to be couriered, and the pad it is going to. See game/parcels.js.
 *
 * Three things separate these from the fare markers above, and each one is deliberate:
 *
 * - **A rounded square, not a disc** (`createParcelPad`). A courier job is not a fare and is not
 *   reached the way a fare is, so it gets a silhouette of its own. Two hues on one shape would ask
 *   the player to tell a package from a rider by colour at 50px; two shapes are read at a glance.
 * - **Fixed cyan, never repainted.** A package has no clock, so there is no level for a hue to step
 *   through — which is why `parcels.js` needs no equivalent of `paintDropoff`'s level gate.
 * - **No hit box.** A package cannot be tapped. The only way to reach one is to drag the route band
 *   through its corner, so there is nothing here for a raycast to find.
 *
 * What still reads exactly as the fare pair does: same shape both ends, and what tells them apart is
 * whether something is standing in the mark. A pad with a box on it is somewhere to collect; an
 * empty one is somewhere to deliver.
 */
export const createParcelPin = (buildParcel) => marker('parcel', {
  buildStanding: buildParcel, ringColor: PARCEL_COLOR, buildRing: createParcelPad, pickable: null,
});

export const createParcelDropPin = () => marker('parcel-dropoff', {
  ringColor: PARCEL_COLOR, buildRing: createParcelPad, pickable: null,
});
