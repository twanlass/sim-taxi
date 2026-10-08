// The windscreen, coming out with the driver.
//
// When game/ejection.js throws the cabbie, the glass they went through goes too: a spray of flat
// shards out of the front of the cabin along the taxi's heading, tumbling and glinting in the air,
// skittering to a stop on the road and left lying there as a scatter that catches the light now
// and then for as long as the run-end card is up.
//
// Same rules as the driver, for the same reasons: a **closed form** of the impact's age. `fire()`
// draws every shard's launch once, and `pose()` evaluates the whole spray from scratch, so the
// crash slow-mo and the replay's `seek` both land on exactly the frame a full-speed step would have
// — the replay cuts round the wreck three times and the glass has to be the same glass each time.
//
// Sized against the wreck camera. At WRECK_ZOOM a unit is ~13.6px, so the shards are 0.22-0.42
// long: three to six pixels, about the smallest thing that still has a shape rather than being a
// speck. One InstancedMesh, one draw call, unlit, no shadow — a shadow under a four-pixel plate is
// a pixel, and the shadow pass would pay for all of them.
//
// **The glint is a colour, not a light.** An unlit material cannot catch the sun, and a lit one
// would need a specular term for a flash anyway. Each shard carries a phase and a rate and goes
// white over a narrow peak of `sin` — fast while it is tumbling in the air, slow and sparse once
// it is lying down, so the scatter on the road twinkles rather than strobes.
//
// It is cut short by the same wall as the driver. `scale` is ejection.js's `throwScale()`, the
// share of a full throw the street had room for, and every horizontal speed here is multiplied by
// it — so a throw that stops short of a building does not send its glass on through the building.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { color } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';
import { skipWhenEmpty } from '../util/emptypools.js';
import { START_FWD } from './ejection.js';

const COUNT = 44;
// Where the screen is: at the front of the cabin, just under the driver's launch (START_Y 2.1 is
// a bit above the roof line, which is where the *figure's middle* clears it; the glass starts
// lower, across the screen's own height).
const Y_LO = 1.25;
const Y_HI = 1.85;
// Most of the glass goes forward with the driver, in a cone about the heading; the rest is the
// part of the screen that just falls out of its frame onto the bonnet and the road in front.
const DROP_SHARE = 0.25;
const FWD_LO = 5;
const FWD_HI = 15;
const DROP_FWD_LO = 0.5;
const DROP_FWD_HI = 3;
const CONE = 0.55;             // radians either side of the heading
const UP_LO = 1;
const UP_HI = 6.5;
// The driver's floaty 30, so the glass and the figure fall on the same clock.
const GRAVITY = 30;
// On the road, just over the skid marks and puddles (rubber and decals sit within 0.03).
const FLOOR = 0.045;
// A shard keeps this much of its speed through the landing and then drags to a stop.
const SKID_KEEP = 0.35;
const DRAG = 7;
const SIZE_LO = 0.22;
const SIZE_HI = 0.42;
// Tumble, rad/s per axis.
const SPIN = 22;
// Glint: sin^POWER over the phase, so the share of time white is small. Rates in rad/s.
const GLINT_POWER_AIR = 6;
const GLINT_POWER_REST = 24;
const GLINT_AIR_LO = 14;
const GLINT_AIR_HI = 30;
const GLINT_REST_LO = 1.2;
const GLINT_REST_HI = 3.2;

// The flash: a starburst of light where the screen was, on the frame it goes. The spray on its own is
// lost in the fireball for the first few frames — they start in the same place on the same frame —
// so the moment needs one thing bigger and brighter than the fire to say *glass*. Spikes rather
// than a disc so it reads as a burst from whichever side the crash cam is looking.
//
// A glint, not a sticker. The first cut was solid white at full opacity, 2.6 long and 0.26 thick,
// and it read as a flat white star cut out and pasted over the cab — "too stark". It is now added
// light in the glass's own pale blue: over the fire it brightens what is there rather than covering
// it, it is thinner and shorter, and it peaks at FLASH_PEAK rather than 1.
const FLASH_LIFE = 0.13;
const FLASH_SPIKES = 7;
const FLASH_REACH = 1.9;       // spike length at full size
const FLASH_CORE = 0.4;
const FLASH_THICK = 0.13;
const FLASH_PEAK = 0.6;

/**
 * @param scene  the pool is added here once, parked at zero scale
 * @param rng    util/rng.js — the spray's own stream, so drawing it reshuffles nothing else
 * @param roadY  road surface height
 */
export function createWindshield(scene, { rng, roadY = 0 } = {}) {
  // A tetrahedron squashed flat is a triangular plate that has a face from every side, so there
  // is no winding to get wrong and a shard turning edge-on thins out instead of vanishing.
  const geo = new THREE.TetrahedronGeometry(1, 0);
  const mat = unlitMaterial({ transparent: true, opacity: 0.92, depthWrite: false });
  const mesh = skipWhenEmpty(new THREE.InstancedMesh(geo, mat, COUNT));
  mesh.name = 'windscreen-glass';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  // Over the fireball (blast.js draws it at 6, without depth): the spray leaves the cab inside the
  // flame, and drawn under it — 5, level with blast.js's own shards — the first look had every
  // shard in the air swallowed by orange and the glass only turning up once it was on the road.
  mesh.renderOrder = 7;
  const glass = new THREE.Color(color('windscreenGlass'));
  const glint = new THREE.Color(color('glassGlint'));
  const tint = new THREE.Color();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let k = 0; k < COUNT; k++) {
    mesh.setMatrixAt(k, zero);
    mesh.setColorAt(k, glass);
  }
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  scene.add(mesh);

  const random = () => (rng ? rng.next() : Math.random());
  const between = (lo, hi) => lo + (hi - lo) * random();

  // Built once at construction from its own fixed directions (golden-angle spiral, not the rng) so
  // the burst costs nothing at fire time and the rng stream is the spray's alone. Every piece is an
  // octahedron, non-indexed, so they merge into one mesh with three's winding throughout.
  const flashParts = [new THREE.OctahedronGeometry(FLASH_CORE, 0)];
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < FLASH_SPIKES; k++) {
    const y = 0.75 - (1.4 * k) / (FLASH_SPIKES - 1);
    const r = Math.sqrt(1 - y * y);
    const a = k * 2.39996;
    const dir = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
    const spike = new THREE.OctahedronGeometry(1, 0);
    spike.scale(FLASH_THICK, FLASH_REACH * (k % 2 ? 0.6 : 1) / 2, FLASH_THICK);
    spike.translate(0, FLASH_REACH * (k % 2 ? 0.6 : 1) / 2, 0);
    spike.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
    flashParts.push(spike);
  }
  const flash = new THREE.Mesh(
    mergeGeometries(flashParts),
    // No depth test: it is centred on the windscreen, so with one the cab hid its core and the
    // smoke collar (lit, opaque, thrown on the same frame) hid most of the spikes — measured in a
    // wreck still, a burst 1.4 across showed as one white sliver. It is a flash of light for a
    // tenth of a second; drawing over the cab it came out of is the point.
    unlitMaterial({
      color: color('windscreenGlass'),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
    }),
  );
  flash.name = 'windscreen-flash';
  // Parked at zero scale rather than hidden, so its program links with the first frame rather than
  // on the crash's (CLAUDE.md, tools/links.mjs).
  flash.scale.setScalar(0);
  flash.frustumCulled = false;
  flash.renderOrder = 7;
  scene.add(flash);

  // Per shard, drawn at fire time.
  const sh = Array.from({ length: COUNT }, () => ({
    x0: 0, y0: 0, z0: 0, vx: 0, vz: 0, vy: 0, air: 0,
    wx: 0, wy: 0, wz: 0, ax: 0, ay: 0, az: 0, rest: 0,
    size: 0, phase: 0, rateAir: 0, rateRest: 0,
  }));
  let fired = false;
  let age = 0;

  const dummy = new THREE.Object3D();

  /** Throw the glass. `yaw` is the taxi's sim heading; `scale` is the driver's `throwScale()`. */
  function fire({ x, z, yaw, scale = 1 }) {
    const fx = Math.cos(yaw);
    const fz = -Math.sin(yaw);
    const rx = -fz;
    const rz = fx;
    for (const s of sh) {
      const drop = random() < DROP_SHARE;
      const across = between(-1, 1);
      // Across the screen's width (~1.6 drawn) and up its height.
      s.x0 = x + fx * START_FWD + rx * across * 0.8;
      s.z0 = z + fz * START_FWD + rz * across * 0.8;
      s.y0 = roadY + between(Y_LO, Y_HI);
      const speed = (drop ? between(DROP_FWD_LO, DROP_FWD_HI) : between(FWD_LO, FWD_HI)) * scale;
      // Off the side of the screen it came from, a little: the spray fans rather than lines up.
      const a = (across * 0.5 + between(-0.5, 0.5)) * CONE;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      s.vx = (fx * ca + rx * sa) * speed;
      s.vz = (fz * ca + rz * sa) * speed;
      s.vy = drop ? between(0, UP_LO) : between(UP_LO, UP_HI);
      // Later root of y0 + vy·t − g/2·t² = roadY + FLOOR.
      const h = s.y0 - roadY - FLOOR;
      s.air = (s.vy + Math.sqrt(s.vy * s.vy + 2 * GRAVITY * h)) / GRAVITY;
      s.wx = between(-SPIN, SPIN);
      s.wy = between(-SPIN, SPIN);
      s.wz = between(-SPIN, SPIN);
      s.ax = between(0, Math.PI * 2);
      s.ay = between(0, Math.PI * 2);
      s.az = between(0, Math.PI * 2);
      s.rest = between(0, Math.PI * 2);
      s.size = between(SIZE_LO, SIZE_HI);
      s.phase = between(0, Math.PI * 2);
      s.rateAir = between(GLINT_AIR_LO, GLINT_AIR_HI);
      s.rateRest = between(GLINT_REST_LO, GLINT_REST_HI);
    }
    flash.position.set(x + fx * START_FWD, roadY + (Y_LO + Y_HI) / 2, z + fz * START_FWD);
    fired = true;
    age = 0;
    pose(0);
  }

  function pose(at) {
    // Out to full size fast and fading as it goes: most of its size in the first third of its life,
    // so on the impact frame itself it is already a burst rather than a dot.
    const f = at >= 0 && at < FLASH_LIFE ? at / FLASH_LIFE : 1;
    flash.scale.setScalar(f < 1 ? 0.45 + 0.75 * (1 - (1 - f) ** 3) : 0);
    flash.material.opacity = FLASH_PEAK * (1 - f) ** 2;
    if (at < 0) {
      for (let k = 0; k < COUNT; k++) mesh.setMatrixAt(k, zero);
      mesh.instanceMatrix.needsUpdate = true;
      return;
    }
    for (let k = 0; k < COUNT; k++) {
      const s = sh[k];
      let g;
      if (at < s.air) {
        const t = at;
        dummy.position.set(s.x0 + s.vx * t, s.y0 + s.vy * t - 0.5 * GRAVITY * t * t, s.z0 + s.vz * t);
        dummy.rotation.set(s.ax + s.wx * t, s.ay + s.wy * t, s.az + s.wz * t);
        g = Math.abs(Math.sin(s.phase + s.rateAir * t)) ** GLINT_POWER_AIR;
      } else {
        // Skid: what is left of the horizontal speed, dragged down exponentially, lying flat at a
        // yaw of its own.
        const u = at - s.air;
        const slide = SKID_KEEP * (1 - Math.exp(-DRAG * u)) / DRAG;
        dummy.position.set(
          s.x0 + s.vx * (s.air + slide),
          roadY + FLOOR,
          s.z0 + s.vz * (s.air + slide),
        );
        dummy.rotation.set(0, s.rest, 0);
        g = Math.abs(Math.sin(s.phase + s.rateRest * u)) ** GLINT_POWER_REST;
      }
      // Flat in the shard's own y, so lying down is a plate face up.
      dummy.scale.set(s.size, s.size * 0.06, s.size * 0.7);
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
      mesh.setColorAt(k, tint.copy(glass).lerp(glint, g));
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
  }

  function update(dt) {
    if (!fired) return;
    age += dt;
    pose(age);
  }

  /** As ejection.js: the spray `at` sim seconds after the impact, or at its own age when null. */
  function seek(at = null) {
    if (!fired) return;
    pose(at ?? age);
  }

  return {
    fire, update, seek,
    active: () => fired,
    mesh,
    flash,
    /** For the headless check: the last shard down. */
    airTime: () => (fired ? Math.max(...sh.map((s) => s.air)) : 0),
  };
}
