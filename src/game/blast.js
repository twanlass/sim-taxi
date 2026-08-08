import * as THREE from 'three';
import { color } from '../palette.js';

// The crash detonation, whole. One call — `fire(x, z, tint)` — puts a shockwave ring, a fireball
// and a handful of shards on the road, and a crash makes exactly two of those calls, one per car.
//
// It replaces a stack of four: sparks.js, smoke.js, debris.js and the `blast()` half of flames.js,
// each fired twice at two points plus a third wave on a setTimeout. That was ~60 draw calls and
// four separate physics packets — gravity, drag, restitution, friction, angular damping — to say
// one thing. Simulating a crash properly is not what makes a crash read at a fixed 3/4 camera;
// **shape and timing** are, and both were buried under the sum of four tunings.
//
// So the vocabulary here is graphic rather than physical:
//
//   - **Unlit flat colour, not Lambert.** A faceted sphere needs a light to show its facets, and
//     the sun is behind the camera. These carry no shading at all and read as silhouettes — which
//     is also what keeps a night-time wreck as bright as a golden-hour one.
//   - **Colour is the animation.** Each puff walks one ramp over its own life, hot core → flame →
//     smoke, and the puffs are staggered, so at any instant the cluster holds all three stops at
//     once. That internal structure is what the flat fill would otherwise cost, and it retires the
//     separate grey smoke plume: the fireball *becomes* the smoke.
//   - **Position is a curve, not an integration.** Puffs and rings are `origin + direction × ease(t)`
//     evaluated from scratch every frame; only the shards carry a ballistic arc, and that one is
//     closed-form too. Nothing accumulates, so nothing has a drag constant to tune, and a slow-mo
//     frame is exactly the same shape as a full-speed one.
//
// Three instanced meshes, ~40 live instances at the peak of a two-car wreck.

const PUFFS_PER_BLAST = 12;
const SHARDS_PER_BLAST = 7;

// Two blast sites per crash and a crash ends the run, so these only ever need to hold two of each.
// Doubled anyway — the pools are ring buffers, and a wrapped slot silently truncates a burst.
const MAX_PUFFS = 48;
const MAX_SHARDS = 28;
const MAX_RINGS = 4;

// Fireball. REACH is how far a puff drifts from the origin over its whole life: a two-car wreck
// spans about 4 units, and at 3.4 the two clusters overlap into one blast rather than reading as
// two bangs that happen to be adjacent.
const PUFF_LIFE = 0.95;
const PUFF_REACH = 2.8;
const PUFF_RISE = 2.6;
const PUFF_SIZE = 3.2;

// Shards. Short-lived and gone in the air — no ground bounce, no friction, no settling. Wreckage
// coming to rest on the tarmac is a detail for a camera that stays; this one pulls into a close-up
// and then cuts to the retry screen, so the pieces only ever have to sell the moment of coming
// apart.
const SHARD_LIFE = 1.25;
const SHARD_GRAVITY = 22;
const SHARD_SIZE = 0.34;
const SHARD_FLOOR = 0.2;

// Shockwave. The one mark that reads instantly at this camera angle: a flat ring on the road
// projects as an ellipse spreading out from under the wreck, so the blast has a size before the
// fireball has grown into one.
const RING_LIFE = 0.45;
const RING_START = 1.2;
const RING_END = 5.5;
const RING_Y = 0.06;      // above the road paint at 0.02 and the route band at 0.03

/**
 * Per-instance alpha. `instanceColor` is RGB only and a 4-component colour attribute takes a
 * different code path in three, so opacity has to ride its own attribute and be multiplied in by
 * hand — same recipe as dust.js and flames.js, factored to one helper because this module wants it
 * three times.
 */
function withInstanceAlpha(geometry, material, capacity) {
  const alphas = new Float32Array(capacity);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a *= vAlpha;');
  };
  return alphas;
}

/** An InstancedMesh parked at zero scale, so an untouched slot draws nothing. */
function makePool(scene, geometry, material, capacity, renderOrder) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false;
  const dummy = new THREE.Object3D();
  dummy.scale.setScalar(0);
  dummy.updateMatrix();
  for (let slot = 0; slot < capacity; slot++) mesh.setMatrixAt(slot, dummy.matrix);
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  return mesh;
}

export function createBlast(scene, rng) {
  // --- Shockwave ring -------------------------------------------------------
  // Fourteen segments, not a smooth circle: at the wreck zoom the flat sides are visible and the
  // ring belongs to the same faceted city as everything else.
  const ringGeo = new THREE.RingGeometry(0.8, 1, 14);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: color('blastRing'),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ringAlpha = withInstanceAlpha(ringGeo, ringMat, MAX_RINGS);
  // Render orders 4/5/6 — the band the four retired effects occupied, so the crash still sits
  // above the road decals (rubber 2, dust 3) and tops out level with the tailpipe flame.
  const ringMesh = makePool(scene, ringGeo, ringMat, MAX_RINGS, 4);

  // --- Shards ---------------------------------------------------------------
  // One tetrahedron, squashed per instance into plates and chunks. Four geometries' worth of
  // variety out of one, which is what lets the whole shower be a single draw call.
  const shardGeo = new THREE.TetrahedronGeometry(1, 0);
  const shardMat = new THREE.MeshLambertMaterial({
    flatShading: true,
    transparent: true,
    depthWrite: false,
  });
  const shardAlpha = withInstanceAlpha(shardGeo, shardMat, MAX_SHARDS);
  const shardMesh = makePool(scene, shardGeo, shardMat, MAX_SHARDS, 5);
  shardMesh.castShadow = true;

  // --- Fireball -------------------------------------------------------------
  // Above the shards, so the core of the blast covers the pieces still inside it.
  const puffGeo = new THREE.IcosahedronGeometry(0.5, 0);
  const puffMat = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
  });
  const puffAlpha = withInstanceAlpha(puffGeo, puffMat, MAX_PUFFS);
  const puffMesh = makePool(scene, puffGeo, puffMat, MAX_PUFFS, 6);

  // The one ramp every puff walks, keyed on its own fraction of life. Flat stops rather than a
  // formula for the same reason the daylight keyframes are: the interesting part is the shape of
  // the hold in the middle — flash, burn, die back, grey out — and a curve smooth enough to
  // express it would spend most of its range somewhere uninteresting.
  const RAMP = [
    { at: 0.00, c: color('blastCore') },
    { at: 0.14, c: color('blastFlame') },
    { at: 0.50, c: color('blastFlame') },   // the hold: this is what the blast is *seen* as
    { at: 0.78, c: color('blastEmber') },
    { at: 1.00, c: color('blastSmoke') },
  ];

  function rampColor(out, t) {
    for (let i = 1; i < RAMP.length; i++) {
      if (t > RAMP[i].at && i < RAMP.length - 1) continue;
      const span = RAMP[i].at - RAMP[i - 1].at;
      return out.lerpColors(RAMP[i - 1].c, RAMP[i].c, Math.min(1, (t - RAMP[i - 1].at) / span));
    }
    return out.copy(RAMP[RAMP.length - 1].c);
  }

  // Ring buffers of plain state. Everything below is read straight back into a closed-form
  // position, so a slot holds where it started and how it was thrown — never where it got to.
  const puff = {
    life: new Float32Array(MAX_PUFFS),
    life0: new Float32Array(MAX_PUFFS),
    ox: new Float32Array(MAX_PUFFS),
    oy: new Float32Array(MAX_PUFFS),
    oz: new Float32Array(MAX_PUFFS),
    dx: new Float32Array(MAX_PUFFS),
    dz: new Float32Array(MAX_PUFFS),
    reach: new Float32Array(MAX_PUFFS),
    rise: new Float32Array(MAX_PUFFS),
    size: new Float32Array(MAX_PUFFS),
    spin: new Float32Array(MAX_PUFFS),
    tilt: new Float32Array(MAX_PUFFS),
  };
  const shard = {
    life: new Float32Array(MAX_SHARDS),
    life0: new Float32Array(MAX_SHARDS),
    ox: new Float32Array(MAX_SHARDS),
    oy: new Float32Array(MAX_SHARDS),
    oz: new Float32Array(MAX_SHARDS),
    vx: new Float32Array(MAX_SHARDS),
    vy: new Float32Array(MAX_SHARDS),
    vz: new Float32Array(MAX_SHARDS),
    wx: new Float32Array(MAX_SHARDS),
    wy: new Float32Array(MAX_SHARDS),
    wz: new Float32Array(MAX_SHARDS),
    long: new Float32Array(MAX_SHARDS),
    flat: new Float32Array(MAX_SHARDS),
    size: new Float32Array(MAX_SHARDS),
  };
  const ring = {
    life: new Float32Array(MAX_RINGS),
    ox: new Float32Array(MAX_RINGS),
    oz: new Float32Array(MAX_RINGS),
  };

  let nextPuff = 0;
  let nextShard = 0;
  let nextRing = 0;

  const dummy = new THREE.Object3D();
  const tintColor = new THREE.Color();
  const scratch = new THREE.Color();

  /**
   * One detonation at (x, z). `tint` paints that car's shards in its own paint, so a two-car wreck
   * throws two colours of wreckage and what lands is visibly two cars — the one thing the old
   * per-car debris pools were carrying that a shared pool could not.
   */
  function fire(x, z, tint = null) {
    ring.life[nextRing] = RING_LIFE;
    ring.ox[nextRing] = x;
    ring.oz[nextRing] = z;
    nextRing = (nextRing + 1) % MAX_RINGS;

    for (let k = 0; k < PUFFS_PER_BLAST; k++) {
      const slot = nextPuff;
      nextPuff = (nextPuff + 1) % MAX_PUFFS;

      // An even fan with a little jitter, rather than a free random angle. Random angles clump,
      // and a cluster with a bald side reads as a mistake at exactly the moment the camera pushes
      // in on it.
      const angle = (k / PUFFS_PER_BLAST) * Math.PI * 2 + rng.jitter(0.35);
      // The first puff is the core: it barely travels, so the middle of the fireball stays filled
      // while the rest of the cluster opens out around it.
      const spread = k === 0 ? 0.12 : rng.range(0.55, 1.15);

      // A wide spread on the life, which is what staggers the colour ramp: puffs that all reach
      // the flame stop together read as one flat orange silhouette with no depth in it.
      puff.life[slot] = PUFF_LIFE * rng.range(0.6, 1.4);
      puff.life0[slot] = puff.life[slot];
      puff.ox[slot] = x + rng.jitter(0.3);
      puff.oy[slot] = 0.7 + rng.range(0, 0.8);
      puff.oz[slot] = z + rng.jitter(0.3);
      puff.dx[slot] = Math.cos(angle);
      puff.dz[slot] = Math.sin(angle);
      puff.reach[slot] = PUFF_REACH * spread;
      puff.rise[slot] = PUFF_RISE * rng.range(0.6, 1.3);
      puff.size[slot] = PUFF_SIZE * (k === 0 ? 1.35 : rng.range(0.7, 1.15));
      puff.spin[slot] = rng.range(0, Math.PI * 2);
      puff.tilt[slot] = rng.range(-1.6, 1.6);
      puffAlpha[slot] = 1;
    }

    for (let k = 0; k < SHARDS_PER_BLAST; k++) {
      const slot = nextShard;
      nextShard = (nextShard + 1) % MAX_SHARDS;

      const angle = (k / SHARDS_PER_BLAST) * Math.PI * 2 + rng.jitter(0.5);
      const out = rng.range(5, 10);

      shard.life[slot] = SHARD_LIFE * rng.range(0.8, 1.15);
      shard.life0[slot] = shard.life[slot];
      shard.ox[slot] = x + rng.jitter(0.3);
      shard.oy[slot] = 0.9 + rng.range(0, 0.5);
      shard.oz[slot] = z + rng.jitter(0.3);
      shard.vx[slot] = Math.cos(angle) * out;
      shard.vy[slot] = rng.range(5, 9.5);
      shard.vz[slot] = Math.sin(angle) * out;
      shard.wx[slot] = rng.range(-9, 9);
      shard.wy[slot] = rng.range(-9, 9);
      shard.wz[slot] = rng.range(-9, 9);
      shard.long[slot] = rng.range(0.7, 1.9);
      shard.flat[slot] = rng.range(0.35, 1);
      shard.size[slot] = SHARD_SIZE * rng.range(0.7, 1.3);
      shardAlpha[slot] = 1;
      shardMesh.setColorAt(slot, tint ? tintColor.set(tint) : tintColor.set('#FFFFFF'));
    }
    if (shardMesh.instanceColor) shardMesh.instanceColor.needsUpdate = true;
  }

  function updatePuffs(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_PUFFS; slot++) {
      if (puff.life[slot] <= 0) continue;
      touched = true;
      puff.life[slot] -= dt;
      const t = Math.min(1, 1 - Math.max(0, puff.life[slot]) / puff.life0[slot]);

      // Punches out and eases to a stop. This is the whole of the motion — the old fireball
      // integrated a velocity against an exponential drag to arrive at the same shape.
      const ease = 1 - (1 - t) ** 2.2;
      dummy.position.set(
        puff.ox[slot] + puff.dx[slot] * puff.reach[slot] * ease,
        puff.oy[slot] + puff.rise[slot] * ease,
        puff.oz[slot] + puff.dz[slot] * puff.reach[slot] * ease,
      );

      // Pop, hold, collapse. A fireball that only faded left a full-size ghost hanging over the
      // road; collapsing it is what makes the blast look like it is being drawn back in.
      const env = Math.min(1, t / 0.18) * Math.min(1, (1 - t) / 0.42) ** 0.8;
      dummy.rotation.set(puff.tilt[slot] * 0.3, puff.spin[slot] + puff.tilt[slot] * t, 0);
      dummy.scale.setScalar(puff.size[slot] * env);
      dummy.updateMatrix();
      puffMesh.setMatrixAt(slot, dummy.matrix);

      // Puffs are staggered by their own life, so the cluster shows several stops of the ramp at
      // once — which is where a flat unlit fill gets its internal structure from.
      puffMesh.setColorAt(slot, rampColor(scratch, t));

      // Full opacity almost the whole way, so the tail *darkens* rather than thinning out. Fading
      // a still-orange puff over its last quarter turned the end of the blast into translucent
      // pink hexagons hanging over the road; the ramp above has to be allowed to reach smoke
      // before anything is taken off the alpha.
      puffAlpha[slot] = Math.min(1, (1 - t) / 0.15);

      if (puff.life[slot] <= 0) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        puffMesh.setMatrixAt(slot, dummy.matrix);
        puffAlpha[slot] = 0;
      }
    }
    if (touched) {
      puffMesh.instanceMatrix.needsUpdate = true;
      if (puffMesh.instanceColor) puffMesh.instanceColor.needsUpdate = true;
      puffGeo.attributes.aAlpha.needsUpdate = true;
    }
  }

  function updateShards(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_SHARDS; slot++) {
      if (shard.life[slot] <= 0) continue;
      touched = true;
      shard.life[slot] -= dt;
      const age = shard.life0[slot] - Math.max(0, shard.life[slot]);
      const t = Math.min(1, age / shard.life0[slot]);

      // Closed-form ballistics, floored at the tarmac rather than bounced off it. A shard that
      // reaches the floor stays there for the last of its life and shrinks out where it landed.
      dummy.position.set(
        shard.ox[slot] + shard.vx[slot] * age,
        Math.max(SHARD_FLOOR, shard.oy[slot] + shard.vy[slot] * age - 0.5 * SHARD_GRAVITY * age * age),
        shard.oz[slot] + shard.vz[slot] * age,
      );
      dummy.rotation.set(shard.wx[slot] * age, shard.wy[slot] * age, shard.wz[slot] * age);

      const env = Math.min(1, (1 - t) / 0.25);
      const s = shard.size[slot] * env;
      dummy.scale.set(s * shard.long[slot], s * shard.flat[slot], s);
      dummy.updateMatrix();
      shardMesh.setMatrixAt(slot, dummy.matrix);
      shardAlpha[slot] = env;

      if (shard.life[slot] <= 0) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        shardMesh.setMatrixAt(slot, dummy.matrix);
        shardAlpha[slot] = 0;
      }
    }
    if (touched) {
      shardMesh.instanceMatrix.needsUpdate = true;
      shardGeo.attributes.aAlpha.needsUpdate = true;
    }
  }

  function updateRings(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_RINGS; slot++) {
      if (ring.life[slot] <= 0) continue;
      touched = true;
      ring.life[slot] -= dt;
      const t = Math.min(1, 1 - Math.max(0, ring.life[slot]) / RING_LIFE);

      // Snaps out and decelerates hard — the ring is the leading edge of the bang, so all of its
      // travel belongs at the front of its life.
      const spread = RING_START + (RING_END - RING_START) * (1 - (1 - t) ** 2.6);
      dummy.position.set(ring.ox[slot], RING_Y, ring.oz[slot]);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(spread, 1, spread);
      dummy.updateMatrix();
      ringMesh.setMatrixAt(slot, dummy.matrix);
      ringAlpha[slot] = (1 - t) ** 1.1;

      if (ring.life[slot] <= 0) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        ringMesh.setMatrixAt(slot, dummy.matrix);
        ringAlpha[slot] = 0;
      }
    }
    if (touched) {
      ringMesh.instanceMatrix.needsUpdate = true;
      ringGeo.attributes.aAlpha.needsUpdate = true;
    }
  }

  function update(dt) {
    updatePuffs(dt);
    updateShards(dt);
    updateRings(dt);
  }

  /** For the headless checks — how many instances are still alive, so a wreck can be shown to end. */
  function active() {
    let live = 0;
    for (let slot = 0; slot < MAX_PUFFS; slot++) if (puff.life[slot] > 0) live += 1;
    for (let slot = 0; slot < MAX_SHARDS; slot++) if (shard.life[slot] > 0) live += 1;
    for (let slot = 0; slot < MAX_RINGS; slot++) if (ring.life[slot] > 0) live += 1;
    return live;
  }

  return { fire, update, active, puffMesh, shardMesh, ringMesh };
}
