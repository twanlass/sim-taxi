import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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
// zero-scale one, the taxi (a single ordinary Mesh, not an instance) just scales itself.

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
 * One light pod, in car-local space. `sx` picks the front (+1) or rear (-1) bumper; `sz` picks a
 * side — `+1` is the car's own right, `-1` its left, in the same local +Z-is-right frame the wheel
 * anchors use (see `wheelAnchors` — a car built at yaw 0 drives down +X, and rightOf/leftOf on that
 * heading resolve to world +Z/-Z, which at yaw 0 *is* local Z). `d`/`h`/`w` size it, taken from the
 * caller rather than fixed here even though brake and turn-signal pods share one size today.
 */
export function lightPod(sx, sz, len, width, d, h, w) {
  const box = new THREE.BoxGeometry(d, h, w);
  const at = lightPodAnchor(sx, sz, len, width, POD_AT, d, w);
  box.translate(at.x, at.y, at.z);
  return box;
}

// Scratch for the call above. `lightPodAnchor` is on the per-frame path for every lit pod in the
// city (see `emitVehicleGlow` in geometry/glow.js), so it writes into a caller's vector rather
// than minting one — at six pods a vehicle and forty vehicles that is 240 Vector3s a frame.
const POD_AT = new THREE.Vector3();

/**
 * Where a pod's centre sits in car-local space — the same arithmetic `lightPod` translates its box
 * by, factored out so anything that has to *stand something on* a light can ask for the position
 * instead of re-deriving it. `geometry/glow.js` hangs each pod's halo off this.
 *
 * Takes the destination vector, and `d`/`w` only because `lightPod` does; every caller in the game
 * uses the one shared pod size.
 */
export function lightPodAnchor(sx, sz, len, width, out, d = LIGHT_D, w = LIGHT_W) {
  return out.set(
    sx * (len / 2 + LIGHT_PROUD - d / 2),
    LIGHT_Y,
    sz * (width / 2 + LIGHT_PROUD - w / 2),
  );
}

/** Both rear corners in one geometry — the two brake lights only ever switch together. */
export function brakeLightGeometry(len, width) {
  const parts = [
    lightPod(-1, -1, len, width, LIGHT_D, LIGHT_H, LIGHT_W),
    lightPod(-1, 1, len, width, LIGHT_D, LIGHT_H, LIGHT_W),
  ];
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/** The front and rear pod on one side, in one geometry — a side's pair blinks together. */
export function turnSignalGeometry(len, width, side) {
  const parts = [
    lightPod(1, side, len, width, LIGHT_D, LIGHT_H, LIGHT_W),
    lightPod(-1, side, len, width, LIGHT_D, LIGHT_H, LIGHT_W),
  ];
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
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
