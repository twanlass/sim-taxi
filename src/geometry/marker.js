import * as THREE from 'three';
import { URGENCY_SEGMENTS, fareColor, PARCEL_COLOR } from '../game/urgency.js';
import { createTargetRing, RING_R, RING_Y } from './targetring.js';
import { createParcelPad } from './parcelpad.js';
import { BILLBOARD, VIEW_UP, SCREEN_PER_WORLD_Y } from '../game/camera.js';
import { CRYSTAL_TOP } from '../game/faremarker.js';

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

// --- The tap target ------------------------------------------------------------------------------
//
// **A quad in the screen plane, over the kerb corner.** It used to be a 20 x 14.5 x 20 box centred
// on the *junction*, and both of those were wrong in a way that only showed up with two markers
// close together: a tap on one rider selected another one entirely.
//
// Two separate faults, and it is worth keeping them apart because fixing either alone leaves the
// bug standing:
//
//  - **Centred on the wrong point.** What the player aims at is the figure on the kerb, which
//    `cornerFor` pushes 4.5 units off the junction on *both* axes — up and to the left on screen.
//    So the region was already offset from its own marker by 6.4 units of ground, in the direction
//    of nothing.
//  - **Height reaches up the screen.** The camera looks down a 33 degree diagonal, so a box 14.5
//    tall projects its top face 11.1 units of ground up-screen of its base: its silhouette covers
//    a strip of ground well past the junction it belongs to. The picker takes the *nearest* hit,
//    and a box down-screen is nearer the camera, so it wins that strip. Measured on a full 3x3 of
//    markers before the change: a tap dead on a rider's own disc was answered by the marker one
//    junction down-screen, and the rider's own region did not extend more than about 20px below
//    their feet.
//
// A quad drawn flat against the screen has neither problem. Its coverage is exactly the rectangle
// you see, `BILLBOARD` keeps it facing a camera that never rotates, and offsetting it along
// `VIEW_UP` moves it up the frame without moving it a millimetre in depth — so the whole target
// sits at its own corner's distance and ordering between two of them is never a surprise.
//
// **And now nothing overlaps.** One junction along a road is 14.1 screen units *sideways* (and 7.7
// down); one straight down the screen diagonal is 15.4 *down* and nothing sideways. Every other
// pair is one of those or further, so a target under 14.1 wide and under 15.4 tall can never share
// a pixel with another one, whatever junctions the two markers sit on. At 11 wide and 11.1 tall for
// a rider — 8 for a bare mark — there is room to spare. Ambiguity is gone rather than resolved.

// Half the width, in screen units. The widest thing under a marker is the disc at RING_R, so this
// is that plus 2 units of margin — about 89px across at play zoom, twice the 44px a fingertip
// needs. The ceiling is 14.1, where the targets on two junctions along one road would touch.
const HIT_HALF_W = RING_R + 2;

// How far below the corner the target reaches: the near edge of the disc is RING_R foreshortened to
// 1.91 screen units, and a unit past that keeps a thumb aimed at the front of the disc on target.
const HIT_BOTTOM = -3;

// And how far above it, for a marker that is nothing but a mark on the ground. Not derived from the
// disc: at 1.91 up the target would be 4.9 units tall, under the 5.4 (44px) a fingertip needs, so
// this is the fingertip's number rather than the geometry's.
const HIT_TOP_BARE = 5;

// A rider's reaches to the top of their crystal instead — a tap on the diamond has always selected
// the fare under it, and this is what keeps that true now that the target is the marker's own
// silhouette rather than a column over the junction. 8.1 screen units.
const HIT_TOP_CRYSTAL = CRYSTAL_TOP * SCREEN_PER_WORLD_Y;

/**
 * @param buildStanding  factory for whatever stands on the corner (a figure, a parcel), or null
 * @param ringColor      colour for the ground mark, or null for a marker with no mark
 * @param buildRing      the ground-mark factory. Defaults to the fare disc; the courier markers
 *                       pass `createParcelPad` so a package's ends are a rounded square instead —
 *                       shape is what tells a courier job from a fare on this board.
 * @param hitTop         how far up the screen the tap target reaches, in screen units above the
 *                       kerb corner. Defaults to the bare mark's reach; the rider passes their
 *                       crystal's. See the block above.
 * @param pickable       the `userData.pickable` kind for the tap target, or **null for no target at
 *                       all**. Every marker on the board carries one today — a tap on a courier
 *                       marker bends the current route through it rather than dispatching the taxi
 *                       at it (game/parcels.js), but it is still a tap. The null option stays
 *                       because a marker carrying a hit box nothing answers is a trap laid for
 *                       whoever next raycasts the scene rather than an explicit target list.
 */
function marker(kind, {
  buildStanding = null, ringColor = null, buildRing = createTargetRing,
  hitTop = HIT_TOP_BARE, pickable = kind,
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

  // The invisible tap target — at play zoom the visible geometry is a few pixels across and would be
  // miserable to tap. On `postGroup` rather than on the root, so it inherits the kerb-corner
  // placement `place()` gives everything else instead of being left behind at the junction; see the
  // block above for why that is the whole bug and not a tidy-up.
  //
  // DoubleSide because a quad that faces the camera exactly is one bad sign away from being culled
  // out of the raycast, and there is nothing to gain from finding out which way that rounds.
  if (pickable) {
    const hit = new THREE.Mesh(
      new THREE.PlaneGeometry(HIT_HALF_W * 2, hitTop - HIT_BOTTOM),
      new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    );
    hit.quaternion.copy(BILLBOARD);
    // Straight up the frame. `VIEW_UP` is perpendicular to the view direction, so this is the one
    // offset that raises the target without changing how far away it is.
    hit.position.copy(VIEW_UP).multiplyScalar((hitTop + HIT_BOTTOM) / 2);
    hit.userData.pickable = pickable;
    postGroup.add(hit);
  }

  return { group, ring, postGroup, standing };
}

export const createPassengerPin = (buildStanding) =>
  marker('passenger', { buildStanding, hitTop: HIT_TOP_CRYSTAL });

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
 * - **A hit box that means something else.** These carried none for a long time, on the argument
 *   that the only way to reach a package was to drag the route band through its corner. A tap on one
 *   now asks for exactly that bend — the taxi is never *dispatched* at a package, it is routed at
 *   whatever it was already going to through the box. See game/parcels.js.
 *
 * What still reads exactly as the fare pair does: same shape both ends, and what tells them apart is
 * whether something is standing in the mark. A pad with a box on it is somewhere to collect; an
 * empty one is somewhere to deliver.
 */
export const createParcelPin = (buildParcel) => marker('parcel', {
  buildStanding: buildParcel, ringColor: PARCEL_COLOR, buildRing: createParcelPad,
});

export const createParcelDropPin = () => marker('parcel-dropoff', {
  ringColor: PARCEL_COLOR, buildRing: createParcelPad,
});
