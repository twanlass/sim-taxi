import * as THREE from 'three';
import { CHASSIS_LIFT } from './wheels.js';
import { BUMPER_D, BUMPER_H, BUMPER_Y, bumperLength } from './bumpers.js';

// The bodywork damage parts, sized once for both of the cars that wear them: the taxi
// (buildDamage in geometry/taxi.js, driven by game/taxidamage.js) and any ambient car the taxi has
// hit (game/cardamage.js). The two bodies are the same box — the taxi is a car under TAXI_SCALE,
// with its cabin at the same CABIN_X — so one set of numbers puts a lid on either. See buildDamage
// for why these are the pieces: at play zoom only a change of *silhouette* reads.

// sim/traffic.js's CAR_LEN, restated for the import-cycle reason geometry/taxi.js restates it.
const CAR_LEN = 3.4;

// Where the boot lid hinges: the rear edge of the cabin, which sits at −0.2 ± CAR_LEN/4. The bonnet
// hinges on the front edge, at the foot of the windscreen, the way a real one does.
export const BOOT_HINGE_X = -0.2 - CAR_LEN * 0.25;
export const HOOD_HINGE_X = -0.2 + CAR_LEN * 0.25;
export const HOOD_LEN = CAR_LEN / 2 - HOOD_HINGE_X - 0.02;
export const BODY_TOP = 1.18 + CHASSIS_LIFT;
export const BOOT_LEN = CAR_LEN / 2 + BOOT_HINGE_X - 0.02;

// A lamp shaken loose hangs on its wire below the socket it came out of. The housing is a little
// smaller than a lit pod, so a lamp that is on wraps it in its glow and a lamp that is off shows the
// bare lens: the pods themselves are only ever there while lit (their on/off is a scale to zero), so
// without a housing a loose indicator would be invisible for every frame it is not blinking.
// 0.6 because 0.42 hung the lamp's centre only 0.19 below where it used to sit — its top was still
// level with the socket — which read as a lamp slightly out of place rather than as one hanging.
export const LAMP_WIRE = 0.6;     // socket to the centre of the housing
export const LAMP_OUT = 0.06;     // the socket sits this far proud of the bumper face
export const LAMP_SIZE = [0.24, 0.46, 0.46];

/** The socket a loose lamp hangs from, for a pod whose home is `home` at end `sx`. */
export function lampSocket(home, sx, target = new THREE.Vector3()) {
  return target.set(home.x + sx * LAMP_OUT, home.y + LAMP_SIZE[1] / 2, home.z);
}

/** Where the lamp's centre hangs off `socket` at `angle` (+ swings it toward the nose). */
export function lampHang(socket, angle, target = new THREE.Vector3()) {
  return target.set(socket.x + Math.sin(angle) * LAMP_WIRE, socket.y - Math.cos(angle) * LAMP_WIRE, socket.z);
}

/**
 * A bumper knocked loose hangs by its corner on `side` (+1 right) at `end` (+1 the nose), its free
 * end across the car and down on the road, `lift` radians short of resting there. Answers the
 * hinge's position and rotation, car-local; the bar runs from the hinge along the hinge's −z.
 * `len`/`width` are the vehicle's, so a truck's bar hangs off a truck's corner.
 */
export function bumperHinge(len, width, side, end, lift, position, rotation) {
  const bar = bumperLength(width);
  // Angle that puts the free end's underside on the road: the hinge is BUMPER_Y up.
  const droopToRoad = Math.asin(Math.min(1, (BUMPER_Y - BUMPER_H / 2) / bar));
  position.set(end * (len / 2 + BUMPER_D / 2), BUMPER_Y, side * (width / 2 - 0.05));
  rotation.set(-(droopToRoad - lift), side > 0 ? 0 : Math.PI, 0, 'YXZ');
}
