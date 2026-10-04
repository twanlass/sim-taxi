import * as THREE from 'three';
import { createTaxiMesh, TAXI_REAR_AXLE_BACK, TAXI_REAR_TRACK, TAXI_TAILPIPE_BACK } from '../geometry/taxi.js';
import { createLocoFlame } from './locoflame.js';
import { createSkidMarks } from './skidmarks.js';
import { DISTANCE } from './camera.js';
import { riverBanks } from '../city/grid.js';
import { ROAD_Y } from '../sim/traffic.js';

// The U-turn, acted out: a short scripted clip for the New Move card (game/newmove.js), filmed **in
// the player's own city**. A real straight street, picked when the card opens, at the game's own
// 3/4 view, with a stand-in taxi driving one loop of the move — it cruises in, floors it, taps the
// brake twice and spins round onto the far lane, then drives back out the way it came. The card's
// pedal row is pressed off **this clip's clock** (`clipKeys`), so the boost key goes down on the frame
// the flame lights and each brake key on the frame the brake lamps do. That is the whole point of the
// clip (Tyler, 2026-10-04): the player sees the buttons and the car do the same thing at once.
//
// **Filmed with the game's own renderer.** It was first a separate little WebGL scene — a strip of
// road and the taxi, lit like the HUD's chips — and it read as a HUD model, not as the game. So now
// the clip is the real frame: `renderFrame` (main.js) with a second camera that is the city camera
// moved over the chosen street — same view direction, same 400-unit standoff (so the haze band lands
// where it always does), zoomed in — and the middle of that frame is copied into the card's canvas.
// Everything the city frame has, the clip has: the buildings, the shadows, the AO, the bloom, the
// weather, the time of day.
//
// **The city under the card is a still.** The world is frozen while the card is up (main.js), so the
// screen behind the dim does not need redrawing. On open the frame is drawn once more and copied to
// `#freeze-frame`, a canvas laid over the game's; from then on the game's canvas is the clip's
// darkroom, drawn each frame with the clip camera and covered by the still. One frame of work per
// frame, the same as a normal frame. On close the still comes down and the next ordinary frame
// paints over whatever the clip left.
//
// **Scripted, not simulated.** The traffic model's spin (`spinTaxi` in sim/traffic.js) needs a live
// taxi on a lane, and a clip that is meant to show the same thing every loop is exactly what a
// simulation is not for. So the stand-in is driven by the timeline below, and the parts that make it
// read as the game's own car are the game's own: `createTaxiMesh`, the Loco Mode flame, the skid
// marks, the brake lamps.

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

// Speeds, world units per second, under the game's (Loco tops out near 20) so the whole move fits
// the frame. The ratios are what read: cruise, half as fast again, a check on the first tap, and a
// standing start back the other way. Distances are along the street from the middle of the lane.
const CRUISE = 8;
const BOOSTED = 12;
const CHECKED = 10;
const RETURN = 12;
const START_X = -17;           // out of frame; boost lands just as the car comes in
const SPIN_SLIDE = 1.5;        // how far the car carries forward while it turns

// The frame. The road runs diagonally under this camera — 0.71 of a unit across the screen and 0.39
// up or down it per unit of street — and the drawn taxi is a lot more car than the sim's CAR_LEN: its
// body measures 4.1 long, 2.4 across the mirrors and 3.1 to the top of the roof sign. Framing that by
// hand off the street's middle was tried twice (a fixed width and a target on the run's midpoint) and
// both times cut the roof off at the top edge on the spin, the one moment the clip exists for. So the
// frame is *measured*: `frameRun` walks the whole loop, projects a box that size round the car into
// the clip camera, and the camera is shifted onto the middle of what it swept and zoomed so it fits
// with FRAME_MARGIN to spare. The loop's seam is a fade (SEAM) rather than a car popping in.
const BODY_HALF_LEN = TAXI_TAILPIPE_BACK;
const BODY_HALF_W = 1.2;
const BODY_TOP = 3.1;
const FRAME_MARGIN = 1.1;
const SEAM = 0.25;

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
 * Where the car is at time t into the loop: {x, side, yaw, pitch} — x along the street from the
 * middle of the lane, side +1 in its own lane and −1 in the far one. Pure, so the probe could walk it.
 * yaw follows the game's convention — forward is (cos yaw, −sin yaw) — so 0 is east and π is west.
 */
export function clipPose(t) {
  if (t < TAP_2) {
    let x = START_X;
    const step = 1 / 600;
    for (let s = 0; s < t; s += step) x += speedAt(s) * step;
    // The nose lifts as Loco Mode bites and settles back as it holds — the HUD's wheelie, small.
    const lift = t > BOOST_ON ? Math.sin(Math.PI * clamp01((t - BOOST_ON) / 0.6)) * 0.07 : 0;
    return { x, side: 1, yaw: 0, pitch: lift };
  }
  if (t < SPIN_END) {
    const u = (t - TAP_2) / SPIN_LEN;
    return {
      x: SPIN_X + SPIN_SLIDE * (1 - (1 - u) * (1 - u)),
      side: 1 - 2 * ease(u),
      // A left-hand spin: yaw climbing turns the nose from +X towards −Z, the far lane.
      yaw: Math.PI * ease(u),
      pitch: 0,
    };
  }
  // Standing start back west, up to RETURN over 0.6s and holding it.
  const s = t - SPIN_END;
  const ramp = 0.6;
  const run = s < ramp ? RETURN * s * s / (2 * ramp) : RETURN * (ramp / 2 + (s - ramp));
  return { x: SPIN_X + SPIN_SLIDE - run, side: -1, yaw: Math.PI, pitch: 0 };
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


// Street choice. The clip's whole run, along the street from the middle of the lane, and how wide a
// corridor it needs kept clear of parked-up traffic either side of the centreline.
const FRAME_ALONG = (START_X + SPIN_X + SPIN_SLIDE) / 2;
const RUN_FROM = START_X - 3;
const RUN_TO = SPIN_X + SPIN_SLIDE + 4;
const CLEAR_LATERAL = 5;

/**
 * Pick the street to film: a straight two-way side street, off the river, with nothing in the way —
 * no car (the taxi included) stopped anywhere along the run, and as much of it as possible in view
 * past the buildings. Of the two lanes, the one that runs left to right on screen, so the move reads
 * in the order the buttons do.
 *
 * @param network   the city's road network (city/roadnet.js `cityNetwork()`)
 * @param cars      every car on the map, taxi included — anything with x and z
 * @param camRight  the city camera's screen-right vector, in world space
 * @param visible   (x, z) => boolean — is this patch of road seen past the buildings
 * @param closed    (laneId) => boolean — roadworks
 * @returns {centre, forward, right, offset} or null when nothing qualifies
 */
export function pickStreet({ network, cars, camRight, visible = () => true, closed = () => false }) {
  const banks = riverBanks();
  let best = null;
  for (const lane of network?.lanes ?? []) {
    if (lane.degenerate || lane.klass !== 'side' || !lane.path || lane.edge.oneway) continue;
    const t0 = lane.path.tangentAt(0);
    const t1 = lane.path.tangentAt(lane.length);
    if (t0.x * t1.x + t0.z * t1.z < 0.9999) continue;          // straight only
    if (t0.x * camRight.x + t0.z * camRight.z <= 0) continue;   // left to right on screen
    const other = lane.edge.lanes.find((l) => l !== lane);
    if (!other || other.degenerate || closed(lane.id) || closed(other.id)) continue;

    const mid = lane.path.at(lane.length / 2);
    const otherMid = other.path.at(other.length / 2);
    const centre = { x: (mid.x + otherMid.x) / 2, z: (mid.z + otherMid.z) / 2 };
    const forward = { x: t0.x, z: t0.z };
    const right = { x: -forward.z, z: forward.x };
    const offset = Math.hypot(mid.x - centre.x, mid.z - centre.z);
    const at = (along, side) => ({
      x: centre.x + forward.x * along + right.x * side,
      z: centre.z + forward.z * along + right.z * side,
    });

    // Off the river and its bridges: the deck arches, and the stand-in drives on flat ground.
    const ends = [at(RUN_FROM, 0), at(RUN_TO, 0)];
    if (banks && ends.some((p) => p.z > banks.z0 - 6 && p.z < banks.z1 + 6)) continue;
    if (banks && (ends[0].z - banks.z0) * (ends[1].z - banks.z0) < 0) continue;

    // Nothing parked in the way. A car is frozen where it stands for as long as the card is up.
    const blocked = cars.some((car) => {
      const dx = car.x - centre.x;
      const dz = car.z - centre.z;
      const along = dx * forward.x + dz * forward.z;
      const side = dx * right.x + dz * right.z;
      return along > RUN_FROM && along < RUN_TO && Math.abs(side) < CLEAR_LATERAL;
    });
    if (blocked) continue;

    let seen = 0;
    let samples = 0;
    for (let along = RUN_FROM + 3; along <= RUN_TO - 3; along += 2) {
      for (const side of [offset, -offset]) {
        const p = at(along, side);
        samples += 1;
        if (visible(p.x, p.z)) seen += 1;
      }
    }
    const score = seen / samples - Math.hypot(centre.x, centre.z) * 1e-4;   // ties go to the middle
    if (!best || score > best.score) best = { score, centre, forward, right, offset };
  }
  return best;
}

/**
 * What the car sweeps over one loop, in the clip camera's own view space: the middle of it (cx, cy)
 * relative to where the camera looks now, and its width and height, in world units.
 */
export function frameRun(cam, street, baseYaw) {
  const inv = cam.matrixWorldInverse;
  const v = new THREE.Vector3();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let t = 0; t <= CLIP_LOOP; t += 0.05) {
    const p = clipPose(t);
    const side = p.side * street.offset;
    const cx = street.centre.x + street.forward.x * p.x + street.right.x * side;
    const cz = street.centre.z + street.forward.z * p.x + street.right.z * side;
    const yaw = baseYaw + p.yaw;
    const fx = Math.cos(yaw), fz = -Math.sin(yaw);
    for (const a of [-BODY_HALF_LEN, BODY_HALF_LEN]) {
      for (const b of [-BODY_HALF_W, BODY_HALF_W]) {
        for (const y of [0, BODY_TOP]) {
          v.set(cx + fx * a - fz * b, y, cz + fz * a + fx * b).applyMatrix4(inv);
          x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
          y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
        }
      }
    }
  }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

/**
 * The clip, filmed in the main scene. Returns null when no street qualifies; the card then shows
 * without a clip.
 *
 * @param scene, camera   the city's scene and camera
 * @param renderFrame     (camera) => void — main.js's whole frame, with the camera to draw it from
 * @param canvas          the game's own canvas (the darkroom)
 * @param freeze          the `#freeze-frame` canvas laid over it
 * @param cardCanvas      the card's canvas, which the middle of each clip frame is copied into
 * @param street          pickStreet's answer
 */
export function createUturnClip({ scene, camera, renderFrame, canvas, freeze, cardCanvas, street }) {
  if (!street) return null;

  // The still, first, while the scene is still exactly the city the player was looking at.
  function snapshot() {
    renderFrame(camera);
    freeze.width = canvas.width;
    freeze.height = canvas.height;
    freeze.style.width = canvas.style.width || `${canvas.clientWidth}px`;
    freeze.style.height = canvas.style.height || `${canvas.clientHeight}px`;
    freeze.getContext('2d').drawImage(canvas, 0, 0);
    freeze.hidden = false;
  }
  snapshot();

  const taxi = createTaxiMesh();
  taxi.setOccupied(true);
  // Yaw on a parent, pitch on the taxi's own group, so the wheelie is about the car's own axle line.
  const pivot = new THREE.Group();
  pivot.add(taxi.group);
  scene.add(pivot);
  const flame = createLocoFlame(scene);
  const skids = createSkidMarks(scene);
  const car = { x: 0, z: 0, yaw: 0, crashed: false };
  const baseYaw = Math.atan2(-street.forward.z, street.forward.x);

  // The clip camera: the city camera's own projection and view direction, centred on the street.
  const clipCam = camera.clone();
  // The framing below is all in world units; whatever push-in the city camera had is not part of it.
  clipCam.zoom = 1;
  clipCam.clearViewOffset();
  const toCamera = camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(-DISTANCE);
  const target = new THREE.Vector3(
    street.centre.x + street.forward.x * FRAME_ALONG, 0, street.centre.z + street.forward.z * FRAME_ALONG);
  clipCam.position.copy(target).add(toCamera);
  clipCam.lookAt(target);
  clipCam.updateMatrixWorld(true);
  const run = frameRun(clipCam, street, baseYaw);
  // Slide the camera across its own image plane onto the middle of the run: same depth, same haze.
  clipCam.position
    .add(new THREE.Vector3().setFromMatrixColumn(clipCam.matrixWorld, 0).multiplyScalar(run.cx))
    .add(new THREE.Vector3().setFromMatrixColumn(clipCam.matrixWorld, 1).multiplyScalar(run.cy));
  clipCam.updateMatrixWorld(true);

  let t = 0;
  let lastSkid = -1;
  let shotW = canvas.width;
  let shotH = canvas.height;

  function frame() {
    // The card's canvas, in device pixels of the game's own canvas, so the copy is 1:1.
    const cssW = cardCanvas.clientWidth;
    const cssH = cardCanvas.clientHeight;
    const viewW = canvas.clientWidth || 1;
    const viewH = canvas.clientHeight || 1;
    if (!cssW || !cssH) return;
    const scale = canvas.width / viewW;
    const sw = Math.round(cssW * scale);
    const sh = Math.round(cssH * scale);
    if (cardCanvas.width !== sw || cardCanvas.height !== sh) { cardCanvas.width = sw; cardCanvas.height = sh; }
    // Zoomed so the middle cssW × cssH of the full frame holds the whole run.
    const ppu = Math.min(cssW / (run.w * FRAME_MARGIN), cssH / (run.h * FRAME_MARGIN));
    clipCam.left = -viewW / 2 / ppu;
    clipCam.right = viewW / 2 / ppu;
    clipCam.top = viewH / 2 / ppu;
    clipCam.bottom = -viewH / 2 / ppu;
    clipCam.updateProjectionMatrix();
    renderFrame(clipCam);
    const ctx = cardCanvas.getContext('2d');
    ctx.clearRect(0, 0, sw, sh);
    ctx.globalAlpha = Math.min(1, t / SEAM, (CLIP_LOOP - t) / SEAM);
    ctx.drawImage(canvas,
      Math.round((canvas.width - sw) / 2), Math.round((canvas.height - sh) / 2), sw, sh, 0, 0, sw, sh);
    ctx.globalAlpha = 1;
  }

  function pose() {
    const p = clipPose(t);
    const side = p.side * street.offset;
    car.x = street.centre.x + street.forward.x * p.x + street.right.x * side;
    car.z = street.centre.z + street.forward.z * p.x + street.right.z * side;
    car.yaw = baseYaw + p.yaw;
    pivot.position.set(car.x, ROAD_Y, car.z);
    pivot.rotation.y = car.yaw;
    taxi.group.rotation.z = p.pitch;
    const spinning = t >= TAP_2 && t < SPIN_END;
    const braking = (t >= TAP_1 && t < TAP_1 + 0.2) || spinning;
    taxi.setLights(braking ? 1 : 0, 0, 0);
    taxi.setSteer(spinning ? 0.5 : 0);
  }

  return {
    get time() { return t; },
    restart() { t = 0; lastSkid = -1; },
    update(dt) {
      // The window was resized under the card: the still is the wrong size, so take it again with
      // the stand-in out of shot.
      if (canvas.width !== shotW || canvas.height !== shotH) {
        pivot.visible = false;
        flame.group.visible = false;
        skids.mesh.visible = false;
        snapshot();
        pivot.visible = true;
        skids.mesh.visible = true;
        shotW = canvas.width;
        shotH = canvas.height;
      }
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
        for (const sgn of [-1, 1]) {
          skids.add(car.x - fx * TAXI_REAR_AXLE_BACK + rx * sgn * TAXI_REAR_TRACK,
            car.z - fz * TAXI_REAR_AXLE_BACK + rz * sgn * TAXI_REAR_TRACK, car.yaw);
        }
      }
      skids.update(t < before ? 0 : dt);
      frame();
    },
    /** Take the stand-in out of the city and the still down. */
    dispose() {
      for (const obj of [pivot, flame.group, skids.mesh]) {
        scene.remove(obj);
        obj.traverse((node) => {
          node.geometry?.dispose();
          for (const m of [node.material].flat()) m?.dispose?.();
        });
      }
      freeze.hidden = true;
    },
  };
}
