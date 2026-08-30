import * as THREE from 'three';
import { color } from '../palette.js';
import { CHASSIS_LIFT } from './wheels.js';

// Brake and turn-signal light pods — the geometry and material both the ambient fleet
// (sim/traffic.js, as an InstancedMesh) and the player's taxi (geometry/taxi.js, as an ordinary
// Mesh) build from, so a light looks the same whichever vehicle is wearing it. Lives outside both
// for the same reason geometry/wheels.js does: traffic.js and taxi.js already import each other,
// and a constant crossing that cycle at module-evaluation time is a temporal-dead-zone error.
//
// Neither light can be a coloured facet baked into a body mesh: an ambient car's vertex colour is
// baked once and only ever multiplied by the instance's paint tint (see the note by carGeometry()
// in sim/traffic.js), so there is nowhere in that buffer for a colour that has to flip on and off,
// frame to frame, independently per instance — instanceColor is RGB paint and nothing else. So each
// kind of light wears one fixed, always-emissive material, and "on"/"off" is the mesh's own scale
// rather than a colour write — the ambient fleet collapses an instance's matrix to a precomputed
// zero-scale one, the taxi (ordinary Meshes, not instances) just scales them.
//
// Which makes **what each pod is scaled about** load-bearing rather than incidental, and is why a
// pod's offset lives on its transform and not in its vertices. See lightPodGeometry().

// Brake and turn-signal pods share one size — colour (see LIGHT_EMISSIVE and the two materials
// below) is what tells them apart, not geometry.
export const LIGHT_D = 0.272;                // fore-aft
export const LIGHT_H = 0.544;
export const LIGHT_W = 0.544;                // across the car
export const LIGHT_Y = 0.55 + CHASSIS_LIFT;  // bumper height

// How far a pod's outer faces stand proud of the body's own — the same fix `WHEEL_PROUD`
// (geometry/wheels.js) already applies to a wheel against the flank. Flush (proud = 0) put a pod's
// outer face exactly on the same plane as the body's own flank and end-cap faces, and two coplanar
// faces at the same depth z-fight.
export const LIGHT_PROUD = 0.03;

// Emissive intensity for both kinds of light — high enough to read as self-lit day or night, the
// same job EMISSIVE does for the fare diamond (geometry/diamond.js), just without a resting/peak
// pair since these have nothing to peak from: they are either present or not.
export const LIGHT_EMISSIVE = 1.4;

/**
 * One light pod, centred on its own origin.
 *
 * **Centred, and a pod's offset travels on its transform rather than in its vertices. That split is
 * the whole of this shape and it is not a style choice.** On/off here is a *scale* (see the note
 * above), and a scale is about the origin of whatever carries it — so a pod holding its own offset
 * in its vertices does not dim as the level falls, it **moves**: down the body toward the car's
 * own centre, and down toward the road, arriving at both when the lamp reaches zero.
 *
 * It shipped that way and it was the bloom that made it visible rather than the mesh. At play zoom
 * a pod is a handful of pixels and its slide reads as nothing much; the spill around it is a soft
 * blob an order of magnitude wider, and *that* was plainly detaching from the tail and crawling up
 * the flank. Only the brake lamp shows it, because only the brake level is eased
 * (`BRAKE_LIGHT_FALL` in sim/traffic.js, ~0.75s to dark) — a turn signal steps between 0 and 1 and
 * is never caught in between. Measured travel from lit to dark, on the geometry below: **1.59
 * units forward and 0.87 down on a car (1.88 / 1.03 on the taxi, which wears TAXI_SCALE), 2.69 and
 * 0.87 on a truck** — where a truck is 5.6 long, so the lamp finished up level with the middle of
 * the cargo box, which is exactly where it was reported.
 *
 * So the pair is two pods and not one merged geometry: the anchor is a *pivot*, and a pivot has to
 * be per pod. One merged pair can only ever be scaled about a point both pods share, and the two
 * kinds disagree about which point that is — a brake pair shares its x and y and differs across the
 * car, a turn-signal pair shares its y and z and differs along it. Two transforms sidestep the
 * question. sim/traffic.js indexes two instances per vehicle (the stride its steered wheels already
 * use); geometry/taxi.js hangs two ordinary Meshes.
 */
export function lightPodGeometry() {
  return new THREE.BoxGeometry(LIGHT_D, LIGHT_H, LIGHT_W);
}

/**
 * Where one pod sits, in car-local space. `sx` picks the front (+1) or rear (-1) bumper; `sz` picks
 * a side — `+1` is the car's own right, `-1` its left, in the same local +Z-is-right frame the wheel
 * anchors use (see `wheelAnchors` — a car built at yaw 0 drives down +X, and rightOf/leftOf on that
 * heading resolve to world +Z/-Z, which at yaw 0 *is* local Z).
 *
 * The pod is `LIGHT_D`/`LIGHT_H`/`LIGHT_W` and always has been — the sizes were parameters back
 * when this returned geometry, and every caller passed the same three constants. What genuinely
 * varies per vehicle is `len`/`width`, i.e. the bumper this pod is pinned to.
 */
export function lightPodAnchor(sx, sz, len, width) {
  return new THREE.Vector3(
    sx * (len / 2 + LIGHT_PROUD - LIGHT_D / 2),
    LIGHT_Y,
    sz * (width / 2 + LIGHT_PROUD - LIGHT_W / 2),
  );
}

/**
 * How many pods one light is made of. Both kinds are a pair, and a pair is the unit that switches
 * together — which is also the instance stride sim/traffic.js indexes its light meshes by, the way
 * `FRONT.length` is the stride for the steered wheels.
 */
export const LIGHT_PODS = 2;

/** Both rear corners — the two brake lights only ever switch together. */
export function brakeLightAnchors(len, width) {
  return [
    lightPodAnchor(-1, -1, len, width),
    lightPodAnchor(-1, 1, len, width),
  ];
}

/** The front and rear pod on one side — a side's pair blinks together. */
export function turnSignalAnchors(len, width, side) {
  return [
    lightPodAnchor(1, side, len, width),
    lightPodAnchor(-1, side, len, width),
  ];
}

/** Fresh material per mesh, matching `propMaterial()`'s (util/geo.js) own one-material-per-mesh habit. */
export function brakeLightMaterial() {
  return new THREE.MeshLambertMaterial({
    color: color('lightRed'),
    emissive: color('lightRed'),
    emissiveIntensity: LIGHT_EMISSIVE,
    flatShading: true,
  });
}

export function turnSignalMaterial() {
  return new THREE.MeshLambertMaterial({
    color: color('turnSignal'),
    emissive: color('turnSignal'),
    emissiveIntensity: LIGHT_EMISSIVE,
    flatShading: true,
  });
}
