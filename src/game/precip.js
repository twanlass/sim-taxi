import * as THREE from 'three';
import { PALETTE } from '../palette.js';

/**
 * Rain and snow, as two instanced fields of particles falling through a box around whatever the
 * camera is looking at.
 *
 * **The field is wrapped in world space, not carried by the camera.** A group parented to the
 * camera target would slide the whole downpour sideways every time you panned, which reads as the
 * weather moving rather than the view. Instead each particle keeps a world position and is wrapped
 * modulo the field around the current focus, so panning reveals rain that was already there.
 *
 * Particles are written straight into `instanceMatrix.array`. Every drop shares one rotation (the
 * lean into the wind) and one scale, so the 3×3 part of the matrix is identical across the whole
 * field and only the translation column changes per frame. Composing 1,500 full matrices through
 * `Object3D.updateMatrix()` would redo that same rotation 1,500 times a frame for nothing.
 */

const RAIN_MAX = 1500;
const SNOW_MAX = 700;

/** Horizontal extent of the wrapping volume. Comfortably wider than the ~104-unit tall city view
 *  at play zoom, so a pan never runs off the edge of the weather. */
const FIELD = 170;
/** Ceiling. Well over the tallest tower — a drop has to have somewhere to fall from. */
const TOP = 42;
/** Where a particle wraps back to the top. Below the road, so nothing pops out mid-air. */
const FLOOR = -1.5;

const RAIN_FALL = 34;      // units/s. Fast enough to streak, slow enough to read as rain.
const SNOW_FALL = 3.2;     // an order of magnitude slower, which is most of what says "snow"
const SNOW_SWAY = 1.5;     // units/s of side-to-side drift at the peak of a flake's wander

const UP = new THREE.Vector3(0, 1, 0);
const ORIGIN = new THREE.Vector3();

/**
 * One field of particles. `spec` carries the geometry, the material and the fall behaviour; the
 * bookkeeping — arrays, wrapping, matrix writes — is identical for both and lives here.
 */
function field(scene, rng, { geometry, material, max, name }) {
  const mesh = new THREE.InstancedMesh(geometry, material, max);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.name = name;
  mesh.visible = false;
  // The field is wrapped around a moving focus, so its own bounds are meaningless and a frustum
  // test against them would cull the whole downpour the moment the camera panned.
  mesh.frustumCulled = false;
  scene.add(mesh);

  const x = new Float32Array(max);
  const y = new Float32Array(max);
  const z = new Float32Array(max);
  const phase = new Float32Array(max);
  for (let i = 0; i < max; i++) {
    x[i] = rng.range(-FIELD / 2, FIELD / 2);
    y[i] = rng.range(FLOOR, TOP);
    z[i] = rng.range(-FIELD / 2, FIELD / 2);
    phase[i] = rng.range(0, Math.PI * 2);
  }

  // The shared 3×3. Rewritten only when the lean changes, which is once per weather transition
  // rather than once per frame.
  const basis = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  let writtenTilt = Number.NaN;

  function setTilt(dirX, dirY, dirZ) {
    quat.setFromUnitVectors(UP, new THREE.Vector3(dirX, dirY, dirZ).normalize());
    basis.compose(ORIGIN, quat, scale);
    const arr = mesh.instanceMatrix.array;
    for (let i = 0; i < max; i++) {
      const o = i * 16;
      for (let e = 0; e < 12; e++) arr[o + e] = basis.elements[e];
      arr[o + 15] = 1;
    }
  }

  return { mesh, x, y, z, phase, setTilt, tiltKey: () => writtenTilt, markTilt: (k) => { writtenTilt = k; } };
}

export function createPrecip(scene, rng, focus) {
  // A thin box rather than a billboard. The camera never rotates, so a box that is 0.12 across
  // reads the same from this one angle as a quad would, and it needs no per-particle orientation.
  const rainGeo = new THREE.BoxGeometry(0.12, 1.5, 0.12);
  const rainMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE.rain),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    // Not fogged, and not additive. Additive rain would vanish against a bright overcast sky and
    // blow out against a dark one; a pale grey at partial alpha reads against both. And fog is
    // *why* it is raining — dimming the rain with it would be the wrong way round.
    fog: false,
  });

  // Twenty facets, so a flake catches the light unevenly as it drifts — the same reason the dust
  // puffs are icosahedra rather than billboards.
  const snowGeo = new THREE.IcosahedronGeometry(0.22, 0);
  const snowMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE.snow),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });

  const rain = field(scene, rng, { geometry: rainGeo, material: rainMat, max: RAIN_MAX, name: 'rain' });
  const snow = field(scene, rng, { geometry: snowGeo, material: snowMat, max: SNOW_MAX, name: 'snow' });
  rain.setTilt(0, 1, 0);
  snow.setTilt(0, 1, 0);

  const state = { rain: 0, snow: 0, windX: 0, windZ: 0, t: 0 };

  /** Wrap a coordinate into the FIELD-wide window centred on `c`. */
  const wrap = (v, c) => {
    const half = FIELD / 2;
    let out = v;
    while (out < c - half) out += FIELD;
    while (out > c + half) out -= FIELD;
    return out;
  };

  function step(part, count, dt, fall, sway) {
    const { x, y, z, phase, mesh } = part;
    const arr = mesh.instanceMatrix.array;
    const c = focus();
    for (let i = 0; i < count; i++) {
      y[i] -= fall * dt;
      x[i] += state.windX * dt;
      z[i] += state.windZ * dt;
      if (sway) {
        // Distance-free wander: a flake's drift is a function of the clock and its own phase, so
        // no two fall down the same line and none of them needs its own velocity vector.
        x[i] += Math.sin(state.t * 0.9 + phase[i]) * sway * dt;
        z[i] += Math.cos(state.t * 0.7 + phase[i] * 1.3) * sway * dt;
      }
      if (y[i] < FLOOR) y[i] += TOP - FLOOR;
      x[i] = wrap(x[i], c.x);
      z[i] = wrap(z[i], c.z);

      const o = i * 16;
      arr[o + 12] = x[i];
      arr[o + 13] = y[i];
      arr[o + 14] = z[i];
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * @param dt        seconds
   * @param rainK     0..1 downpour strength
   * @param snowK     0..1 snowfall strength
   * @param windX/Z   world-space drift, units/s
   */
  function update(dt, rainK, snowK, windX, windZ) {
    state.t += dt;
    state.rain = rainK;
    state.snow = snowK;
    state.windX = windX;
    state.windZ = windZ;

    // Count scales with strength, opacity barely does. Thinning the field is what actually reads
    // as "it is easing off"; fading every drop to 10% alpha reads as a rendering bug.
    const rainCount = Math.round(RAIN_MAX * rainK);
    rain.mesh.count = rainCount;
    rain.mesh.visible = rainCount > 0;
    rain.mesh.material.opacity = 0.22 + 0.26 * rainK;

    const snowCount = Math.round(SNOW_MAX * snowK);
    snow.mesh.count = snowCount;
    snow.mesh.visible = snowCount > 0;
    snow.mesh.material.opacity = 0.55 + 0.35 * snowK;

    if (rainCount > 0) {
      // Lean the streak along its own velocity, so a windy shower slants and a still one doesn't.
      const key = Math.round(Math.atan2(Math.hypot(windX, windZ), RAIN_FALL) * 100)
        + Math.round(Math.atan2(windZ, windX) * 20) * 1000;
      if (key !== rain.tiltKey()) {
        rain.setTilt(-windX, RAIN_FALL, -windZ);
        rain.markTilt(key);
      }
      step(rain, rainCount, dt, RAIN_FALL, 0);
    }
    if (snowCount > 0) step(snow, snowCount, dt, SNOW_FALL, SNOW_SWAY);
  }

  return { update, rain: rain.mesh, snow: snow.mesh, state };
}
