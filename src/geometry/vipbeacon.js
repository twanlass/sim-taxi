import * as THREE from 'three';
import { outlineHull } from './diamond.js';
import { PALETTE } from '../palette.js';

// The VIP badge: a small purple geodesic sphere that floats above a fare's ordinary urgency
// diamond (game/faremarker.js). It carries no state of its own — colour, quarters and the panic
// pulse all stay the diamond's job — so it never changes hue. Its only message is "this one is a
// VIP", which is why it's a sphere rather than the diamond's octahedron: the two shapes must never
// be mistaken for one another at a glance, on a board where the diamond alone already means
// "a clock is running here".

export const VIP_BEACON_R = 1.1;
const GEO = new THREE.IcosahedronGeometry(VIP_BEACON_R, 1);
const RIM_SCALE = 1.16;
const EMISSIVE = 0.45;

export function createVipBeacon() {
  const color = new THREE.Color(PALETTE.vip);
  const mesh = new THREE.Mesh(GEO, new THREE.MeshLambertMaterial({
    color: color.clone(),
    emissive: color.clone(),
    emissiveIntensity: EMISSIVE,
    flatShading: true,
  }));
  mesh.castShadow = true;
  mesh.add(outlineHull(GEO, RIM_SCALE));
  return mesh;
}

// A lazy turn rather than a bounce of its own — the diamond underneath already owns the bob, and a
// second object bouncing out of phase with it would read as jitter rather than as two markers
// agreeing on one rider.
export const VIP_SPIN_RATE = 1.4;
