import * as THREE from 'three';

// Dust kicked up behind the taxi in crazy mode.
//
// Squashed low-poly spheres rather than camera-facing quads. A billboard is cheaper, but the puffs
// sat in the same plane as the road and read as flat stickers next to the faceted cars; a lit
// icosahedron picks up the same sun and shows the same hard facets as everything else in the city.
//
// One InstancedMesh, one draw call, a ring buffer of slots. Per-puff alpha needs a custom
// attribute — `instanceColor` is RGB only — so a small shader patch multiplies it in at the end.

const MAX_PUFFS = 90;
const LIFE = 1.05;
const START_ALPHA = 0.62;
const START_SIZE = 0.5;
const END_SIZE = 2.3;
const SQUASH = 0.55;         // flattened, so a puff spreads over the road rather than balling up

export function createDust(scene, camera, rng) {
  // Detail 0: twenty faces. Enough to read as round at play zoom, few enough that the facets show.
  const geometry = new THREE.IcosahedronGeometry(0.5, 0);

  const alphas = new Float32Array(MAX_PUFFS);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  const material = new THREE.MeshLambertMaterial({
    // Pure white. The off-white it started as was already being warmed by the golden-hour sun,
    // which landed it close enough to the road's own tan that the puffs stopped reading as dust.
    color: '#FFFFFF',
    flatShading: true,
    transparent: true,
    depthWrite: false,
  });

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a *= vAlpha;');
  };

  const mesh = new THREE.InstancedMesh(geometry, material, MAX_PUFFS);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = 3;      // above the rubber, below the cars and the game markers
  mesh.frustumCulled = false;
  scene.add(mesh);

  const life = new Float32Array(MAX_PUFFS);
  // How long this puff was *given*, so `t` can be normalised against its own span. A burst lives
  // longer than a trail puff, and normalising both against the LIFE constant put the long ones at a
  // negative age: they started at a sixteenth of their size and above full opacity, then grew.
  const span = new Float32Array(MAX_PUFFS);
  const px = new Float32Array(MAX_PUFFS);
  const py = new Float32Array(MAX_PUFFS);
  const pz = new Float32Array(MAX_PUFFS);
  const vx = new Float32Array(MAX_PUFFS);
  const vy = new Float32Array(MAX_PUFFS);
  const vz = new Float32Array(MAX_PUFFS);
  const spin = new Float32Array(MAX_PUFFS);
  const tilt = new Float32Array(MAX_PUFFS);
  const wide = new Float32Array(MAX_PUFFS);   // per-puff aspect, so they aren't obvious clones

  const dummy = new THREE.Object3D();

  // Everything starts collapsed to nothing rather than sitting at the origin as a visible blob.
  for (let slot = 0; slot < MAX_PUFFS; slot++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;

  let next = 0;

  /**
   * Puff up from a point, with a bit of scatter so the trail isn't a straight line of clones.
   *
   * `scale` multiplies the puff's size and how hard it is thrown, and `spread` how far from the
   * point it starts. Both default to the boost trail's own values, which is what every caller
   * outside the barricade wants.
   */
  function add(x, z, yaw, scale = 1, spread = 0.35) {
    const slot = next;
    next = (next + 1) % MAX_PUFFS;

    span[slot] = LIFE * (scale > 1 ? 1.3 : 1);
    life[slot] = span[slot];
    px[slot] = x + rng.jitter(spread);
    py[slot] = 0.3;
    pz[slot] = z + rng.jitter(spread);

    // Drifts backwards from the car and rises.
    vx[slot] = (-Math.cos(yaw) * rng.range(0.6, 1.6) + rng.jitter(0.7)) * scale;
    vy[slot] = rng.range(0.7, 1.5) * scale;
    vz[slot] = (Math.sin(yaw) * rng.range(0.6, 1.6) + rng.jitter(0.7)) * scale;

    spin[slot] = rng.range(0, Math.PI * 2);
    tilt[slot] = rng.range(-1, 1);
    wide[slot] = rng.range(0.85, 1.3) * scale;
    alphas[slot] = START_ALPHA;
  }

  /**
   * A wall of it, for going through a barricade.
   *
   * The smash used to be two ordinary trail puffs, which is what the taxi lays down every frame of
   * a boost — so the one moment in the run that is meant to read as an impact produced two frames'
   * worth of ordinary exhaust. This is the same dust, thrown wider and harder and thirteen puffs at
   * once: the pool is 90 slots, so a burst costs about a seventh of it and still leaves the boost
   * trail behind the taxi intact.
   *
   * Scattered around the point rather than trailing from it, because the barricade is a thing the
   * taxi hit rather than a surface it is spinning its wheels on.
   */
  function burst(x, z, yaw, count = 13) {
    for (let n = 0; n < count; n++) add(x, z, yaw + rng.jitter(1.4), rng.range(1.7, 2.6), 1.15);
  }

  function update(dt) {
    for (let slot = 0; slot < MAX_PUFFS; slot++) {
      if (life[slot] <= 0) continue;

      life[slot] -= dt;
      const t = 1 - Math.max(0, life[slot]) / span[slot];   // 0 fresh, 1 spent

      px[slot] += vx[slot] * dt;
      py[slot] += vy[slot] * dt;
      pz[slot] += vz[slot] * dt;
      vy[slot] -= 0.6 * dt;                            // settles back down as it spreads
      spin[slot] += tilt[slot] * dt;

      const size = START_SIZE + (END_SIZE - START_SIZE) * t;

      dummy.position.set(px[slot], py[slot], pz[slot]);
      dummy.rotation.set(tilt[slot] * 0.4, spin[slot], 0);
      dummy.scale.set(size * wide[slot], size * SQUASH, size);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);

      alphas[slot] = Math.max(0, 1 - t) ** 1.6 * START_ALPHA;

      if (life[slot] <= 0) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        mesh.setMatrixAt(slot, dummy.matrix);
        alphas[slot] = 0;
      }
    }

    mesh.instanceMatrix.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
  }

  return { mesh, add, burst, update };
}
