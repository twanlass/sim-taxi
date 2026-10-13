import * as THREE from 'three';
import { ISLAND, peak } from '../city/coast.js';
import { unlitMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { createCloudGeometry } from '../geometry/cloud.js';
import { cloudTint } from './clouds.js';

// A ring of cloud round the mountain's top (the island only), from Tyler's reference: the peak
// stands out of a collar of mist just under its snow.
//
// The same clouds the weather flies (geometry/cloud.js), parked rather than flown: each is laid
// along the ring with its long axis on the tangent, so the collar reads as one band broken into
// puffs. Nothing hides the back half of the ring — the mountain does, because the clouds test depth
// against it and only skip *writing* it — so the band wraps round the peak instead of crossing in
// front of it. They bob a little out of step with each other, and that is all they do: the cloud's
// rim fade and its lobes' draw order are baked for the yaw it was built at (geometry/cloud.js), so
// a cloud that turned would come apart.

// How many puffs, and how far round the peak's spread they sit. 1.15 put them where the flank is
// at their own height, which is inside the mountain for every one with a ridge under it: the first
// render showed four puffs of nine. Out at 1.45 the ground is ten to fifteen units under them.
const PUFFS = 14;
const RING = 1.45;
// How high, as a share of the peak's top: under the snow line, which the terrain draws at about
// 44 of its 67.
const ALTITUDE = 0.62;
const SPAN = [24, 34];
const BOB = 0.6;

export function createPeakMist(scene, rng) {
  if (!ISLAND) return null;
  const top = peak();
  const group = new THREE.Group();
  group.name = 'peak-mist';
  const tint = cloudTint(new THREE.Color(PALETTE.skyTop), new THREE.Color(PALETTE.skyBottom));
  const puffs = [];
  for (let k = 0; k < PUFFS; k++) {
    const a = (k / PUFFS) * Math.PI * 2 + rng.jitter(0.18);
    const x = top.x + Math.cos(a) * top.sx * RING * rng.range(0.92, 1.08);
    const z = top.z + Math.sin(a) * top.sz * RING * rng.range(0.92, 1.08);
    // Along the ring: the tangent of the ellipse at `a`. Yaw takes +X to (cos, 0, -sin).
    const tx = -Math.sin(a) * top.sx;
    const tz = Math.cos(a) * top.sz;
    const yaw = Math.atan2(-tz, tx);
    const span = rng.range(SPAN[0], SPAN[1]);
    const material = unlitMaterial({ vertexColors: true, transparent: true });
    material.color.copy(tint);
    material.depthWrite = false;
    const mesh = new THREE.Mesh(createCloudGeometry(rng, { span, height: span * 0.32, yaw }), material);
    mesh.rotation.y = yaw;
    const y = top.h * ALTITUDE + rng.jitter(2);
    mesh.position.set(x, y, z);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    puffs.push({ mesh, y, phase: rng.range(0, Math.PI * 2), rate: rng.range(0.15, 0.3) });
  }
  scene.add(group);

  let t = 0;
  return {
    group,
    update(dt) {
      t += dt;
      for (const puff of puffs) puff.mesh.position.y = puff.y + Math.sin(t * puff.rate + puff.phase) * BOB;
    },
    /** Retint with the sky, the way the weather is (game/daylight.js). */
    setLight(skyTop, skyBottom) {
      cloudTint(skyTop, skyBottom, tint);
      for (const puff of puffs) puff.mesh.material.color.copy(tint);
    },
  };
}
