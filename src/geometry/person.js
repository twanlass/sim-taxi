import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';

// A blocky rider hailing a cab.
//
// Scale is a deliberate lie: a person next to a 3.4-unit car should be about 1.3 units tall,
// which is two pixels at play zoom. This is a bit over 3, so the figure reads as a person.
//
// The right arm is a separate mesh rather than part of the merged body, because it needs its own
// pivot at the shoulder. Everything else is one merged geometry sharing a single material.

const SKIN = '#E8B78C';
const HAIR = '#4A3A2E';
const SHOULDER_Y = 2.25;

export function createPerson() {
  const group = new THREE.Group();
  const parts = [];

  const box = (w, h, d, x, y, z, col) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(x, y, z);
    parts.push(bakeColor(geo, new THREE.Color(col)));
  };

  const body = PALETTE.passenger;

  box(0.34, 1.15, 0.34, -0.26, 0.575, 0, '#3C3A45');   // legs
  box(0.34, 1.15, 0.34, 0.26, 0.575, 0, '#3C3A45');
  box(0.26, 1.0, 0.26, -0.72, 1.75, 0, body);          // left arm, at rest
  box(1.0, 1.3, 0.6, 0, 1.8, 0, body);                 // torso
  box(0.62, 0.62, 0.62, 0, 2.75, 0, SKIN);             // head
  box(0.68, 0.2, 0.68, 0, 3.14, 0, HAIR);              // hair

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  mesh.userData.pickable = 'passenger';
  group.add(mesh);

  // Right arm: geometry hangs *below* its own origin so the group pivots at the shoulder.
  const armGeo = new THREE.BoxGeometry(0.26, 1.0, 0.26);
  armGeo.translate(0, -0.5, 0);
  const arm = new THREE.Mesh(bakeColor(armGeo, new THREE.Color(body)), propMaterial());
  arm.castShadow = true;
  arm.userData.pickable = 'passenger';
  arm.position.set(0.72, SHOULDER_Y, 0);
  group.add(arm);

  /**
   * Hailing: arm up and swinging, feet planted.
   *
   * Replaces an earlier hop-in-place. Bouncing read as impatience or idling; a raised, waving arm
   * says specifically "I want that taxi", which is the one thing the figure exists to communicate.
   */
  const wave = (t) => {
    arm.rotation.z = 2.15 + Math.sin(t * 7) * 0.3;
    group.rotation.y = Math.sin(t * 0.9) * 0.25;   // slight turn, as if scanning for a cab
  };

  wave(0);
  return { group, wave };
}
