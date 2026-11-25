import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { SNOW_UNIFORMS } from '../util/geo.js';
import { MAX_SPAN } from '../city/grid.js';
import { gpuMaterials } from '../util/gpu.js';
import { flakeTwin } from './gpusnowfall.js';

/**
 * A snowstorm — the holiday weather (`getSnow` in util/shot.js). It stands in for the squall for
 * the whole of a run: the sky goes to a flat pale overcast, snow falls, the city whitens, and every
 * car carves tracks through it that the snow slowly fills back in.
 *
 * Three parts, and none of them is geometry on the city:
 *
 * 1. **The cover** (`SNOW_UNIFORMS`, util/geo.js). One mix on the diffuse colour of every lit
 *    `propMaterial()`, by how far a face points up: roofs, pavements, lawns, crowns and streets all
 *    go white off the same few lines. `state.level` is how deep it is: patchy noise at half, solid
 *    past one. It builds while it is snowing (`BUILD`) from the dusting the run opens on (`START`).
 * 2. **The tracks** (`stamp`, `tracks`). A `TRACK_RES`² byte map over `TRACK_EXTENT` units of
 *    ground, painted **on the CPU** where every car's four tyres have rolled, and uploaded a few
 *    times a second (`UPLOAD`). The ground reads it at street level and turns the snow back into
 *    dark slush there. A CPU map rather than a GPU render target because it is one code path for
 *    both renderers, costs no render pass (the phone's budget is draw calls), and can be asked on
 *    the CPU what it holds — which is what tools/snow.mjs does. Snowfall fills a track back in
 *    over `REFILL` seconds, so the lanes the traffic keeps using stay carved and a street nobody
 *    drove down goes white again.
 * 3. **The fall** (`flakes`). Soft round flakes, instanced quads animated wholly in the vertex
 *    shader in a box that wraps round the middle of the frame (the rain's arrangement), drifting
 *    on the wind and swaying as they go; `state.fall` thins them to a flurry between gusts.
 *
 * Plus `GRIP`, which main.js hands the traffic model the way the rain does: every car brakes a
 * little softer on snow, and plans its stops against the softer brake, so nobody runs a red.
 */

/**
 * What braking is worth on full snow cover, as a fraction of dry — a little less than the wet's 0.6.
 * The rest of the slippery is the taxi's own: its tail steps out through corners (`setSlip` in
 * sim/traffic.js), which main.js drives off the same cover.
 */
export const GRIP = 0.55;

/** The cover the run opens on (it snowed overnight), and the seconds of snowfall to add one more. */
const START = 0.6;
const BUILD = 150;
const LEVEL_MAX = 1.1;

/**
 * The track map: resolution and extent (the island and its ring road, with room to spare). 512
 * over ~139 units is 0.27 a texel, so a 0.5-wide tread is nearly two texels and the pair of
 * tracks under one car (1.4 apart) stays two tracks at play zoom, where a unit is ~7.7 px.
 */
export const TRACK_RES = 512;
export const TRACK_EXTENT = MAX_SPAN + 10;
const TEXEL = TRACK_EXTENT / TRACK_RES;
const TREAD = 0.5;
/** Seconds of steady snowfall to fill a fresh track back in, and how often the map is uploaded. */
export const REFILL = 60;
const UPLOAD = 1 / 12;
/** A wheel that moved further than this in a frame was teleported (a respawn), not driven. */
const JUMP = 4;
/** Where the wheels sit on a car, as fractions of its length and its half-width (CAR_W 1.7). */
const AXLE = 0.31;
const HALF_TRACK = 0.7;

/** The flakes: how many, the box they wrap in, how fast they fall and drift. */
const FLAKES = 9000;
const BOX = new THREE.Vector3(140, 45, 140);
const FALL = 3.4;
const WIND = new THREE.Vector2(2.6, 1.3);
const FLAKE_SIZE = 0.24;
const FLAKE_OPACITY = 0.9;

/** How dark the city reads to its lights: most windows and every headlight on, the sky still day. */
export const SNOW_DARK = 0.42;
/**
 * The route band over snow: painted rather than added (white plus anything is white), at more than
 * the dry road's ROUTE_OPACITY 0.38 so the clock's colour survives the pale ground.
 */
export const SNOW_ROUTE_OPACITY = 0.62;
/** The haze under falling snow (HAZE_TOP is the clear afternoon's). */
export const SNOW_HAZE = 0.3;

const tmp = new THREE.Color();

export function createSnow({ pin = null } = {}) {
  const state = {
    t: 0,
    level: pin ?? START,
    fall: 1,
    pinned: pin !== null,
    stamps: 0,
  };

  // --- the track map ----------------------------------------------------------------------------

  const data = new Uint8Array(TRACK_RES * TRACK_RES);
  const texture = new THREE.DataTexture(data, TRACK_RES, TRACK_RES, THREE.RedFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  SNOW_UNIFORMS.tSnowTracks.value = texture;
  SNOW_UNIFORMS.uSnow.value.set(state.level, 1, TRACK_EXTENT, 0);
  let dirty = false;
  let sinceUpload = 0;
  let refillDebt = 0;

  /** The texel a world point falls in, as fractional texel coordinates. */
  const toTexel = (w) => (w / TRACK_EXTENT + 0.5) * TRACK_RES - 0.5;

  /**
   * A tread from (ax, az) to (bx, bz): every texel within `TREAD / 2` of the segment goes to full,
   * with a one-texel soft edge so the linear filter has something to blend. Max, never add: a
   * track driven twice is no deeper than one driven once.
   */
  function tread(ax, az, bx, bz) {
    const r = TREAD / 2 / TEXEL;
    const x0 = toTexel(ax), z0 = toTexel(az), x1 = toTexel(bx), z1 = toTexel(bz);
    const lo = (a, b) => Math.max(0, Math.floor(Math.min(a, b) - r - 1));
    const hi = (a, b) => Math.min(TRACK_RES - 1, Math.ceil(Math.max(a, b) + r + 1));
    const dx = x1 - x0, dz = z1 - z0;
    const len2 = dx * dx + dz * dz;
    for (let j = lo(z0, z1); j <= hi(z0, z1); j++) {
      for (let i = lo(x0, x1); i <= hi(x0, x1); i++) {
        const u = len2 > 0 ? Math.min(1, Math.max(0, ((i - x0) * dx + (j - z0) * dz) / len2)) : 0;
        const d = Math.hypot(i - (x0 + u * dx), j - (z0 + u * dz));
        const v = Math.min(1, Math.max(0, r + 0.5 - d));
        if (v <= 0) continue;
        const k = j * TRACK_RES + i;
        const byte = Math.round(255 * v);
        if (byte > data[k]) { data[k] = byte; dirty = true; }
      }
    }
  }

  // Each car's wheels where they were last frame, to draw the tread between.
  const last = new WeakMap();
  const wheels = new Float32Array(8);

  /**
   * Press every car's tyres into the snow. `cars` is anything with `x`, `z`, `yaw`, `isTruck`; a
   * car `crashed`, `parked` or `airborne(car)` leaves nothing, and neither does one that jumped.
   */
  function stamp(cars, { airborne = () => 0, lift = () => 0 } = {}) {
    for (const car of cars) {
      if (!car || car.crashed || car.parked || airborne(car) > 0.1 || lift(car) > 0.3) {
        if (car) last.delete(car);
        continue;
      }
      const half = (car.isTruck ? 5.6 : 3.4) * AXLE;
      const fx = Math.cos(car.yaw), fz = -Math.sin(car.yaw);
      const rx = Math.sin(car.yaw), rz = Math.cos(car.yaw);
      let n = 0;
      for (const along of [half, -half]) {
        for (const side of [HALF_TRACK, -HALF_TRACK]) {
          wheels[n++] = car.x + fx * along + rx * side;
          wheels[n++] = car.z + fz * along + rz * side;
        }
      }
      const prev = last.get(car);
      if (prev && Math.hypot(prev[0] - wheels[0], prev[1] - wheels[1]) < JUMP) {
        for (let w = 0; w < 8; w += 2) tread(prev[w], prev[w + 1], wheels[w], wheels[w + 1]);
        state.stamps++;
      }
      if (prev) prev.set(wheels);
      else last.set(car, Float32Array.from(wheels));
    }
  }

  /** How carved the snow is at a world point, 0 untouched to 1 a fresh track. For tools. */
  function trackAt(x, z) {
    const i = Math.round(toTexel(x)), j = Math.round(toTexel(z));
    if (i < 0 || j < 0 || i >= TRACK_RES || j >= TRACK_RES) return 0;
    return data[j * TRACK_RES + i] / 255;
  }

  /** Snowfall filling the tracks back in: a linear fill over `REFILL` seconds at full fall. */
  function refill(dt) {
    refillDebt += (255 * dt * state.fall) / REFILL;
    if (refillDebt < 1) return;
    const step = Math.floor(refillDebt);
    refillDebt -= step;
    let changed = false;
    for (let k = 0; k < data.length; k++) {
      const v = data[k];
      if (v) { data[k] = v > step ? v - step : 0; changed = true; }
    }
    if (changed) dirty = true;
  }

  // --- the flakes -------------------------------------------------------------------------------

  const centre = new THREE.Vector3();
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1], 2));
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(18), 3));
  const seeds = new Float32Array(FLAKES * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  geo.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 4));
  geo.instanceCount = FLAKES;
  const uniforms = {
    uTime: { value: 0 },
    uCentre: { value: centre },
    uBox: { value: BOX.clone() },
    uFall: { value: FALL },
    uWind: { value: WIND.clone() },
    uSize: { value: FLAKE_SIZE },
    uDensity: { value: 1 },
    uOpacity: { value: FLAKE_OPACITY },
    uColor: { value: new THREE.Color(PALETTE.snowFlake) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uCentre;
      uniform vec3 uBox;
      uniform float uFall;
      uniform vec2 uWind;
      uniform float uSize;
      uniform float uDensity;
      attribute vec2 corner;
      attribute vec4 seed;
      varying vec2 vCorner;
      varying float vAlpha;
      void main() {
        float speed = 0.7 + 0.6 * seed.w;
        vec3 raw = seed.xyz * uBox + vec3(uWind.x, -uFall, uWind.y) * speed * uTime;
        // Each flake sways on its own slow cycle, so the fall reads as snow and not as rain slowed.
        raw.x += sin(uTime * (0.9 + seed.w) + seed.x * 40.0) * 0.8;
        raw.z += cos(uTime * (0.7 + seed.z) + seed.y * 40.0) * 0.8;
        vec2 xz = uCentre.xz + mod(raw.xz - uCentre.xz + 0.5 * uBox.xz, uBox.xz) - 0.5 * uBox.xz;
        vec3 p = vec3(xz.x, mod(raw.y, uBox.y), xz.y);
        vec4 v = viewMatrix * vec4(p, 1.0);
        v.xy += corner * uSize * (0.55 + 0.9 * fract(seed.w * 13.7));
        gl_Position = projectionMatrix * v;
        vCorner = corner;
        // Thinned to the moment's share between gusts; faded into the ground rather than cut off.
        vAlpha = (0.6 + 0.4 * seed.z) * smoothstep(0.0, 2.5, p.y);
        if (fract(seed.w * 91.7 + seed.x * 37.3) > uDensity) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vCorner;
      varying float vAlpha;
      void main() {
        float a = (1.0 - smoothstep(0.3, 1.0, length(vCorner))) * vAlpha * uOpacity;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
  const flakes = new THREE.Mesh(geo, gpuMaterials() ? flakeTwin(material) : material);
  flakes.frustumCulled = false;
  flakes.renderOrder = 2;
  flakes.name = 'snow-flakes';

  // --- the grade --------------------------------------------------------------------------------

  const top = new THREE.Color(PALETTE.snowSkyTop);
  const bottom = new THREE.Color(PALETTE.snowSkyBottom);
  const sun = new THREE.Color(PALETTE.snowSun);
  const hemiSky = new THREE.Color(PALETTE.snowHemiSky);
  const hemiGround = new THREE.Color(PALETTE.snowHemiGround);

  /**
   * A flat, pale overcast over any hour, scaled by the day's own brightness so a snowy night is
   * still night. Lighter than the rain's lid: snow light is soft and bright, the shadows go faint
   * rather than the whole frame going dark, and the ground throws light back up.
   */
  function grade(look) {
    const bright = Math.min(1, look.fill / 1.2);
    const sky = (0.3 + 0.7 * bright) * 0.85;
    look.top.lerp(tmp.copy(top).multiplyScalar(sky), 0.7);
    look.bottom.lerp(tmp.copy(bottom).multiplyScalar(sky), 0.7);
    look.sun.lerp(sun, 0.5);
    look.hemiSky.lerp(tmp.copy(hemiSky).multiplyScalar(sky), 0.65);
    look.hemiGround.lerp(tmp.copy(hemiGround).multiplyScalar(sky), 0.7);
    // Dimmed past the first cut (0.55 and 1.15, Tyler: "dim the light a lil"): a snowstorm afternoon
    // is a low, grey one, and the holiday lights want a frame they can glow against.
    look.power *= 0.42;
    look.fill *= 0.95;
  }

  // --- the loop ---------------------------------------------------------------------------------

  const camDir = new THREE.Vector3();

  /** Gusts: the fall swells and thins on two slow, unrelated cycles, never quite stopping. */
  const gust = (t) => THREE.MathUtils.clamp(0.62 + 0.38 * Math.sin(t * 0.09) * Math.sin(t * 0.037 + 1.3), 0.3, 1);

  function update(dt, camera = null, light = 1) {
    state.t += dt;
    state.fall = state.pinned ? 1 : gust(state.t);
    if (!state.pinned) state.level = Math.min(LEVEL_MAX, state.level + (dt * state.fall) / BUILD);
    SNOW_UNIFORMS.uSnow.value.x = state.level;
    refill(dt);
    sinceUpload += dt;
    if (dirty && sinceUpload >= UPLOAD) {
      texture.needsUpdate = true;
      dirty = false;
      sinceUpload = 0;
    }
    uniforms.uTime.value = state.t;
    uniforms.uDensity.value = state.fall;
    // Display values (no colour-space chunk, like the rain): dimmed with the light so a flake at
    // dusk is not a white dot on a dark street.
    uniforms.uColor.value.set(PALETTE.snowFlake).convertLinearToSRGB().multiplyScalar(light);
    if (camera) {
      camera.updateMatrixWorld();
      camera.getWorldDirection(camDir);
      if (Math.abs(camDir.y) > 1e-4) centre.copy(camera.position).addScaledVector(camDir, -camera.position.y / camDir.y);
    }
  }

  return {
    state,
    flakes,
    grade,
    stamp,
    update,
    trackAt,
    texture,
    centre,
    /** Hold the cover at `v` (null to let it build again). */
    pin(v) {
      state.pinned = v !== null;
      if (v !== null) state.level = v;
      SNOW_UNIFORMS.uSnow.value.x = state.level;
    },
    /** Fill every track in at once. */
    clearTracks() {
      data.fill(0);
      dirty = true;
    },
  };
}
