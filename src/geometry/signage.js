import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { KERB_H } from '../city/ground.js';

// How a junction tells you what to do — the overhead signal head and the stop sign, the two
// pieces of street furniture that replace the painted stop bars.
//
// **Why the bars went.** A bar was 0.7 x 3.6 units of saturated red/amber/green paint lying flat
// on the road, one per approach, four per junction, 144 of them across the city. Nothing else in
// the game paints the *ground* in signal colours, so at play zoom the road surface carried more
// chroma than the cars driving on it, and a red bar three blocks away competed with a fare
// marker for the same glance. Legible, and far too loud for what it says.
//
// The replacement puts the signal where a driver actually looks for one: a single four-faced head
// hanging over the middle of the junction, and a stop sign on the kerb where there is no light.
// One object per junction instead of four, and the colour is confined to three lamps of ~5px each
// rather than spread over 2.5 square units of tarmac per approach.
//
// **Two faces of the head are always readable, and that is exactly enough.** The camera never
// rotates (see `VIEW_DIR` in game/camera.js), so of a four-way head's four faces the player sees
// the +X-facing and +Z-facing pair and never the other two. Those two belong to the approaches
// travelling -X and -Z — which are on *different* streets, and a street is the unit a phase is
// built from (see `bakeSignals` in city/roadnet.js). So the two visible faces always report both
// phases of the junction: the hidden pair is the opposite approach of each, which by construction
// says the same thing.
//
// **Nothing hangs it.** No mast arm, no span wire, no pole. That is a deliberate first pass:
// a wire across the junction is four more meshes and a lot more visual noise per junction than
// the head itself, and the whole point of this change is to spend less. The head floats.

// --- The overhead head ------------------------------------------------------

// The body is square so four faces fit it without a seam, and its faces land on the approach
// bearings for free on a grid. Sized against the car it hangs over rather than against life:
// CAR_LEN is 3.4 units, so this body is a little under a car length tall.
export const HEAD_W = 1.2;                       // across one face
export const HEAD_H = 2.9;

// Clearance under the head. Set from what has to pass beneath it (a box truck's cargo box tops
// out around 2.6) plus the parallax cost of every unit above that: this is an orthographic
// camera, so a world height h displaces its object **up-screen by 0.838 h** and nothing else —
// (0, 1, 0) dotted with the screen-up basis vector, which for `VIEW_DIR` (1, 0.92, 1) comes out
// at 0.838. At 3.6 the head centre sits 5.05 up, i.e. 4.2 units up-screen of the junction it
// belongs to, against a junction box 8 units across. It reads as hanging over that junction.
// Much higher and it reads as belonging to the block behind it.
export const HEAD_BOTTOM = 3.6;
export const HEAD_Y = HEAD_BOTTOM + HEAD_H / 2;

// A lamp is stylised roughly 3x life. At 1 world unit ~ 7.7px at play zoom a correctly scaled
// 0.3m lens would be under 2px — present but unreadable, which is the failure the painted bars
// were solving in the first place. 0.36 radius puts a lamp at ~5.5px, which is the same order as
// a car's own brake pod and reads at a glance.
export const LAMP_R = 0.36;
const LAMP_SPACING = 0.95;
const LAMP_DEPTH = 0.12;
// The lens stands proud of the body for the reason `LIGHT_PROUD` (geometry/lights.js) exists:
// flush, its rim is coplanar with the body face and the two z-fight.
const LAMP_PROUD = 0.05;

/** Lamp heights within the head, top-down: red, amber, green — the order everyone already knows. */
export const LAMP_Y = [LAMP_SPACING, 0, -LAMP_SPACING];
export const LAMPS_PER_FACE = LAMP_Y.length;

// The brow over each lens. Thin — at play zoom it is under a pixel — but it is what separates
// three stacked discs into a *traffic light* rather than a domino, and the silhouette is the only
// thing carrying that read when all three lamps happen to be dark on the face you can see.
const HOOD_D = 0.32;
const HOOD_T = 0.11;

/**
 * One face's furniture — three hoods — in head-local space, built facing +X.
 *
 * The lenses are not in here: they have to be a separate InstancedMesh because their colour is
 * written per instance every frame, and an InstancedMesh carries one tint per instance. Same
 * split, for the same reason, as the car body / brake pod pair in geometry/lights.js.
 */
export function signalFaceGeometry() {
  const parts = LAMP_Y.map((y) => {
    const hood = new THREE.BoxGeometry(HOOD_D, HOOD_T, LAMP_R * 2 + 0.16);
    hood.translate(HEAD_W / 2 + HOOD_D / 2 - 0.02, y + LAMP_R + HOOD_T / 2, 0);
    return hood;
  });
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return bakeColor(merged, PALETTE.signalBody);
}

/** The body itself — one per junction, whatever its arms are doing. */
export function signalBodyGeometry() {
  const box = new THREE.BoxGeometry(HEAD_W, HEAD_H, HEAD_W);
  return bakeColor(box, PALETTE.signalBody);
}

/**
 * One lens, built facing +X so it composes with the same yaw its face does.
 *
 * A cylinder rather than a disc: this camera looks down a diagonal, so a face is seen at ~54° off
 * its own normal and a zero-depth circle reads as a flat sticker. The 0.12 of rim is what gives it
 * a lit edge from the side.
 */
export function signalLampGeometry() {
  const lens = new THREE.CylinderGeometry(LAMP_R, LAMP_R, LAMP_DEPTH, 10);
  lens.rotateZ(Math.PI / 2);                       // axis along +X
  lens.translate(HEAD_W / 2 + LAMP_PROUD + LAMP_DEPTH / 2, 0, 0);
  // White, so the per-instance colour that arrives every frame is the whole of what is seen —
  // the same trick the stop bars used, and the reason they had to be baked at all: three only
  // applies `instanceColor` through `vColor`, which is compiled in by `vertexColors`.
  return bakeColor(lens, new THREE.Color(1, 1, 1));
}

// --- The stop sign ----------------------------------------------------------

// Oversized on the same argument as the lamps: a real 750mm plate is 0.58 units here, under 5px.
// 0.62 radius puts the octagon at ~9.5px across, which is where the eight-sided outline starts
// being an outline rather than a blob.
const SIGN_R = 0.62;
const SIGN_T = 0.07;
const SIGN_RIM = 0.09;                             // the white border, showing past the red face
const SIGN_Y = 2.1;                                // plate centre above the kerb
const POST_R = 0.075;

/**
 * Post and plate, built facing +X with its foot at the kerb surface.
 *
 * The plate is an eight-sided prism rather than two back-to-back circles: a sign is read from one
 * side and *seen* from every side, and the back of a single-sided plane is a hole in the world
 * from three of the four camera-facing quadrants. `CircleGeometry`/`CylinderGeometry` with 8
 * segments is already a regular octagon — the quarter-turn is what puts a flat edge on top
 * instead of a vertex, which is the whole silhouette.
 */
export function stopSignGeometry() {
  const parts = [];

  const post = new THREE.CylinderGeometry(POST_R, POST_R, SIGN_Y, 6);
  post.translate(0, KERB_H + SIGN_Y / 2, 0);
  parts.push(bakeColor(post, PALETTE.pole));

  const octagon = (radius, depth, colour) => {
    const plate = new THREE.CylinderGeometry(radius, radius, depth, 8);
    plate.rotateY(Math.PI / 8);                    // flat edge up, not a corner
    plate.rotateZ(Math.PI / 2);                    // face along +X
    plate.translate(0, KERB_H + SIGN_Y, 0);
    return bakeColor(plate, colour);
  };

  // The border is a second, larger octagon behind the face rather than a bevel on one solid: at
  // 9.5px the white is one pixel of edge, and one pixel of edge is exactly what a stop sign is
  // made of. Without it the plate reads as a red dot on a stick.
  parts.push(octagon(SIGN_R + SIGN_RIM, SIGN_T, PALETTE.signWhite));
  const face = octagon(SIGN_R, SIGN_T + 0.02, PALETTE.stopSign);
  parts.push(face);

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * How far the post stands to the right of the lane centre it governs.
 *
 * Right-hand traffic, so the sign is on the driver's own side. `LANE` is 2 and `HALF_ROAD` is 4,
 * which puts the kerb line 2 units right of a lane centre; 2.45 clears it by the post's own radius
 * and change, so the plate overhangs the kerb rather than the carriageway.
 */
export const SIGN_OFFSET = 2.45;

// --- Which look is drawn ----------------------------------------------------

let style = 'heads';

/**
 * `?signals=bars` puts the painted stop bars back, for comparing the two side by side.
 *
 * A module-level setting read at mesh time rather than a per-frame toggle, and set before
 * `createTraffic` runs, on the same argument as `setAmbientOcclusion` (util/geo.js): what it picks
 * decides which meshes get built at all, so switching it live would mean rebuilding the city's
 * street furniture rather than flipping a flag.
 */
export function setSignalStyle(next) {
  style = next === 'bars' ? 'bars' : 'heads';
}

export function signalStyle() {
  return style;
}
