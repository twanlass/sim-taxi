import * as THREE from 'three';
import { createTaxiMesh, TAXI_REAR_AXLE_BACK, TAXI_REAR_TRACK } from '../geometry/taxi.js';
import { mirrorSceneLights } from './avatarlights.js';
import { createLocoFlame } from './locoflame.js';
import { createSkidMarks } from './skidmarks.js';
import { VIEW_DIR } from './camera.js';
import { HALF_ROAD, LANE } from '../city/grid.js';
import { PALETTE } from '../palette.js';
import { getMsaa, getPixelRatioCap } from '../util/shot.js';
import { propMaterial } from '../util/geo.js';

// The U-turn, acted out: a short scripted clip for the New Move card (game/newmove.js). A straight
// street, the real taxi, and one loop of the move — it cruises in, floors it, taps the brake twice
// and spins round onto the far lane, then drives back out the way it came. The card's pedal row is
// driven off **this clip's clock** (`keys(t)`), so the boost key goes down on the frame the flame
// lights and each brake key on the frame the brake lamps do. That is the whole point of the clip
// (Tyler, 2026-10-04): the player sees the buttons and the car do the same thing at the same time.
//
// **Scripted, not simulated.** The traffic model's spin (`spinTaxi` in sim/traffic.js) needs a road
// network and a live taxi under it, and a clip that is meant to show the same thing every loop is
// exactly what a simulation is not for. So the car is driven by a timeline below — speeds integrated
// to a position, a spin eased over the same ~0.45s the real one takes — and the parts that make it
// read as the game's own car are the game's own: `createTaxiMesh`, the Loco Mode flame, the skid
// marks, the brake lamps, lit by the city's sun through `mirrorSceneLights` like the HUD's chips.
//
// One more WebGL context while the card is up, built on open and released on close — the card shows
// once ever, so there is nothing to keep it around for.

/** The loop, in seconds. Long enough for the car to leave frame before it comes round again. */
export const CLIP_LOOP = 4.6;

// The timeline, in seconds into the loop. Boost goes down at BOOST_ON and comes up just before the
// first brake tap — "last pedal pressed wins" (bootleg.js), so the real gesture releases it too. The
// two taps are 0.3s apart, inside bootleg.js's 350ms COMBO_GAP_MS; the second is the spin.
const BOOST_ON = 0.5;
const BOOST_OFF = 1.5;
const TAP_1 = 1.6;
const TAP_2 = 1.9;
const TAP_LEN = 0.13;          // how long a key reads as pressed
const SPIN_LEN = 0.45;         // the real spin's ~0.4s at the Loco top, with a hair for the eye
const SPIN_END = TAP_2 + SPIN_LEN;
const KEYS_OFF = 4.2;          // the row dims for the last beat, then the loop starts again

// Speeds, world units per second, scaled down from the game's (Loco tops out near 20) so the whole
// move fits a frame 20 units wide. The ratios are what read: cruise, double it, a check on the first
// tap, and a standing start back the other way.
const CRUISE = 5;
const BOOSTED = 10;
const CHECKED = 7;
const RETURN = 12;
const START_X = -11;          // nose just in frame at the start; boost lands 2.5 units in
const SPIN_SLIDE = 1.5;        // how far the car carries forward while it turns

// The frame. Orthographic, at the city camera's own 33° elevation with the azimuth squared up so the
// street runs straight across (the chips' construction, game/taxifinder.js). The car drives east in
// the near lane and comes back west in the far one: facing +X with +Y up, the driver's right is +Z,
// which is towards this camera.
const VIEW = new THREE.Vector3(0, VIEW_DIR.y, Math.hypot(VIEW_DIR.x, VIEW_DIR.z)).normalize();
const HALF_H = 4.2;
const CENTRE = new THREE.Vector3(0, 0.6, 0);

const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const clamp01 = (t) => Math.min(1, Math.max(0, t));

/** Forward speed at time t, before the spin. */
function speedAt(t) {
  if (t < BOOST_ON) return CRUISE;
  if (t < BOOST_ON + 0.3) return CRUISE + (BOOSTED - CRUISE) * ease((t - BOOST_ON) / 0.3);
  if (t < TAP_1) return BOOSTED;
  return BOOSTED + (CHECKED - BOOSTED) * ease((t - TAP_1) / (TAP_2 - TAP_1));
}

// The car's distance travelled at the spin, integrated once.
const SPIN_X = (() => {
  let x = START_X;
  const step = 1 / 600;
  for (let t = 0; t < TAP_2; t += step) x += speedAt(t) * step;
  return x;
})();

/**
 * Where the car is at time t into the loop: {x, z, yaw, pitch}. Pure, so the probe could walk it.
 * yaw follows the game's convention — forward is (cos yaw, −sin yaw) — so 0 is east and π is west.
 */
export function clipPose(t) {
  if (t < TAP_2) {
    let x = START_X;
    const step = 1 / 600;
    for (let s = 0; s < t; s += step) x += speedAt(s) * step;
    // The nose lifts as Loco Mode bites and settles back as it holds — the HUD's wheelie, small.
    const lift = t > BOOST_ON ? Math.sin(Math.PI * clamp01((t - BOOST_ON) / 0.6)) * 0.07 : 0;
    return { x, z: LANE, yaw: 0, pitch: lift };
  }
  if (t < SPIN_END) {
    const u = (t - TAP_2) / SPIN_LEN;
    return {
      x: SPIN_X + SPIN_SLIDE * (1 - (1 - u) * (1 - u)),
      z: LANE - 2 * LANE * ease(u),
      // A left-hand spin: yaw climbing turns the nose from +X towards −Z, the far lane.
      yaw: Math.PI * ease(u),
      pitch: 0,
    };
  }
  // Standing start back west, up to RETURN over 0.6s and holding it.
  const s = t - SPIN_END;
  const ramp = 0.6;
  const run = s < ramp ? RETURN * s * s / (2 * ramp) : RETURN * (ramp / 2 + (s - ramp));
  return { x: SPIN_X + SPIN_SLIDE - run, z: -LANE, yaw: Math.PI, pitch: 0 };
}

/**
 * The pedal row at time t: for each key, whether it is lit (pressed at some point this loop) and
 * whether it is down right now. Read by newmove.js every frame.
 */
export function clipKeys(t) {
  const on = t < KEYS_OFF;
  return {
    boost: { lit: on && t >= BOOST_ON, down: t >= BOOST_ON && t < BOOST_OFF },
    brake1: { lit: on && t >= TAP_1, down: t >= TAP_1 && t < TAP_1 + TAP_LEN },
    brake2: { lit: on && t >= TAP_2, down: t >= TAP_2 && t < TAP_2 + TAP_LEN },
  };
}

/** Flat, non-indexed quad on the ground, wound to face up (tools/check.mjs asserts it). */
export function groundQuad(x0, x1, z0, z1, y, colour) {
  const g = new THREE.BufferGeometry();
  // (x0,z1) → (x1,z1) → (x1,z0): with +Z towards the camera, that runs anticlockwise seen from above.
  const p = [x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z1, x1, y, z0, x0, y, z0];
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  const c = new THREE.Color(colour);
  g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: 6 }, () => [c.r, c.g, c.b]).flat(), 3));
  g.computeVertexNormals();
  return g;
}

/**
 * @param canvas   the card's <canvas>
 * @param sun/hemi the city's own lights, mirrored
 */
export function createUturnClip({ canvas, sun, hemi }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: getMsaa(), alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, getPixelRatioCap()));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const syncLights = mirrorSceneLights(scene, sun, hemi);

  // The street: asphalt, a pavement each side and grass beyond. Laid edge to edge rather than one
  // on top of another — the coplanar-shimmer rule — with the paint lifted clear of the asphalt.
  const SPAN = 30;
  const PAVE = 2.2;
  const material = propMaterial();
  const parts = [
    groundQuad(-SPAN, SPAN, -HALF_ROAD, HALF_ROAD, 0, PALETTE.asphalt),
    groundQuad(-SPAN, SPAN, HALF_ROAD, HALF_ROAD + PAVE, 0, PALETTE.sidewalk),
    groundQuad(-SPAN, SPAN, -HALF_ROAD - PAVE, -HALF_ROAD, 0, PALETTE.sidewalk),
    groundQuad(-SPAN, SPAN, HALF_ROAD + PAVE, HALF_ROAD + PAVE + 6, 0, PALETTE.park),
    groundQuad(-SPAN, SPAN, -HALF_ROAD - PAVE - 6, -HALF_ROAD - PAVE, 0, PALETTE.park),
  ];
  for (let x = -SPAN; x < SPAN; x += 4) parts.push(groundQuad(x, x + 2, -0.09, 0.09, 0.02, PALETTE.laneMark));
  for (const g of parts) scene.add(new THREE.Mesh(g, material));

  const taxi = createTaxiMesh();
  taxi.group.traverse((node) => {
    // No stencil buffer on this context — see the same line in game/taxifinder.js.
    if (node.name === 'ghostMask' || node.name === 'ghostRim') node.visible = false;
  });
  taxi.setOccupied(true);
  // Yaw on a parent, pitch on the taxi's own group, so the wheelie is about the car's own axle line
  // whichever way it is facing.
  const pivot = new THREE.Group();
  pivot.add(taxi.group);
  scene.add(pivot);

  const flame = createLocoFlame(scene);
  const skids = createSkidMarks(scene);
  const car = { x: START_X, z: LANE, yaw: 0, crashed: false };

  const camera = new THREE.OrthographicCamera(-1, 1, HALF_H, -HALF_H, 0.1, 80);
  camera.position.copy(CENTRE).addScaledVector(VIEW, 30);
  camera.lookAt(CENTRE);

  let size = { w: 0, h: 0 };
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h || (w === size.w && h === size.h)) return;
    size = { w, h };
    renderer.setSize(w, h, false);
    const halfW = HALF_H * (w / h);
    camera.left = -halfW;
    camera.right = halfW;
    camera.updateProjectionMatrix();
  }

  let t = 0;
  let lastSkid = -1;

  function pose() {
    const p = clipPose(t);
    car.x = p.x;
    car.z = p.z;
    car.yaw = p.yaw;
    pivot.position.set(p.x, 0, p.z);
    pivot.rotation.y = p.yaw;
    taxi.group.rotation.z = p.pitch;
    const spinning = t >= TAP_2 && t < SPIN_END;
    const braking = (t >= TAP_1 && t < TAP_1 + 0.2) || spinning;
    taxi.setLights(braking ? 1 : 0, 0, 0);
    taxi.setSteer(spinning ? 0.5 : 0);
  }

  return {
    get time() { return t; },
    /** Back to the top of the loop. */
    restart() { t = 0; lastSkid = -1; },
    update(dt) {
      resize();
      const before = t;
      t += dt;
      if (t >= CLIP_LOOP) { t -= CLIP_LOOP; lastSkid = -1; }
      pose();
      flame.update(dt, car, t >= BOOST_ON && t < BOOST_OFF);
      // Rubber off both rear tyres through the spin and the first bite of the getaway.
      if (t >= TAP_2 && t < SPIN_END + 0.25 && t - lastSkid >= 0.035) {
        lastSkid = t;
        const fx = Math.cos(car.yaw);
        const fz = -Math.sin(car.yaw);
        const rx = Math.sin(car.yaw);
        const rz = Math.cos(car.yaw);
        for (const side of [-1, 1]) {
          skids.add(car.x - fx * TAXI_REAR_AXLE_BACK + rx * side * TAXI_REAR_TRACK,
            car.z - fz * TAXI_REAR_AXLE_BACK + rz * side * TAXI_REAR_TRACK, car.yaw);
        }
      }
      skids.update(t < before ? 0 : dt);
      syncLights();
      renderer.render(scene, camera);
    },
    dispose() {
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
