import * as THREE from 'three';
import { createTaxiMesh, TAXI_TAILPIPE_BACK, TAXI_TAILPIPE_HEIGHT, TAXI_FRONT_AXLE_FWD, TAXI_FRONT_TRACK } from '../geometry/taxi.js';
import { createLocoFlame } from './locoflame.js';
import { createFlames } from './flames.js';
import { createSkidMarks } from './skidmarks.js';
import { unmarkEmissive } from './bloom.js';
import { DISTANCE } from './camera.js';
import { BODY_EULER_ORDER } from '../util/geo.js';
import { makeRng } from '../util/rng.js';
import { propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { carGeometry, CAR_LEN, CAR_W, ROAD_Y } from '../sim/traffic.js';
import { wheelAnchors, wheelGeometry } from '../geometry/wheels.js';

// A move, acted out: the short clip on a New Move card (game/newmove.js), filmed **in the player's
// own city**. A real stretch of road, picked when the card opens, at the game's own 3/4 view, with a
// stand-in taxi playing back a recording of the shipped sim doing the move — the U-turn
// (game/uturnclip.js) or the drift (game/driftclip.js). Each of those owns its timeline, its reel
// and where in the city it can be filmed; this is the part they share: the camera, the stand-in,
// its flame and rubber, and the still laid over the game while the card is up.
//
// **Filmed with the game's own renderer.** It was first a separate little WebGL scene — a strip of
// road and the taxi, lit like the HUD's chips — and it read as a HUD model, not as the game. So now
// the clip is the real frame: `renderFrame` (main.js) with a second camera that is the city camera
// moved over the chosen road — same view direction, same 400-unit standoff (so the haze band lands
// where it always does) — and the middle of that frame is copied into the card's canvas. Everything
// the city frame has, the clip has: the buildings, the shadows, the AO, the bloom, the weather, the
// time of day.
//
// **The city under the card is a still.** The world is frozen while the card is up (main.js), so the
// screen behind the dim does not need redrawing. On open the frame is drawn once more and copied to
// `#freeze-frame`, a canvas laid over the game's; from then on the game's canvas is the clip's
// darkroom, drawn each frame with the clip camera and covered by the still. One frame of work per
// frame, the same as a normal frame. On close the still comes down and the next ordinary frame
// paints over whatever the clip left.
//
// **The game's own move, played back.** Not the sim running live, because the card freezes the
// world and a second traffic instance would write over the real one's module state; and not a
// hand-written timeline, which was tried first for the U-turn and read as fake — quicker than the
// real spin and rocking where the real car does not (Tyler, 2026-10-04). Each reel is checked
// against a fresh take on every `npm run check`, so it cannot drift from the game.

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
const FRAME_MARGIN = 1.15;
const SEAM = 0.25;

/**
 * A reel (game/uturnreel.js, game/driftreel.js) as something to play: `at(t)` is the car at time t
 * into the loop, interpolated — along and lateral in the reel's own frame (+ the driver's right),
 * y, roll, yaw (from the frame's heading, unwrapped), pitch, the wheel lock, the brake lamp and the
 * flame (0 out, 1 lit, 2 the drift kick's twin plume). `alongShift` is taken off every along, so a
 * reel can be centred on whatever point its placement names.
 */
export function reelPlayer(reel, { alongShift = 0, track = null } = {}) {
  const { frames, step } = reel;
  const index = (t) => {
    const u = Math.min(frames.length - 1, Math.max(0, t / step));
    const i = Math.min(frames.length - 2, Math.floor(u));
    return [i, u - i];
  };
  return {
    reel,
    alongShift,
    loop: frames.length * step,
    /**
     * Where along the street the camera is at time t, from where it starts — 0 throughout unless the
     * clip asks to `track` something. A move that covers more road than one frame can hold at a
     * readable size (the overtake: ~80 units) follows it instead, and the city slides by under it.
     */
    track: (t) => (track ? track(t) - track(0) : 0),
    /** The car being passed, at time t, when the reel has one: {along, lateral, yaw, brake}. */
    lead(t) {
      if (!reel.lead) return null;
      const [i, k] = index(t);
      const a = reel.lead[i];
      const b = reel.lead[i + 1];
      const at = (n) => a[n] + (b[n] - a[n]) * k;
      return { along: at(0) - alongShift, lateral: at(1), yaw: at(2), brake: at(3) };
    },
    at(t) {
      const u = Math.min(frames.length - 1, Math.max(0, t / step));
      const i = Math.min(frames.length - 2, Math.floor(u));
      const k = u - i;
      const a = frames[i];
      const b = frames[i + 1];
      const at = (n) => a[n] + (b[n] - a[n]) * k;
      return {
        along: at(0) - alongShift, lateral: at(1), y: at(2),
        roll: at(3), yaw: at(4), pitch: at(5), wheel: at(6), brake: at(7), flame: a[8],
      };
    },
  };
}

/** A point in a placement's frame: `along` its forward from its centre, `lateral` to its right. */
export function onStreet(place, along, lateral) {
  return {
    x: place.centre.x + place.forward.x * along + place.right.x * lateral,
    z: place.centre.z + place.forward.z * along + place.right.z * lateral,
  };
}

/**
 * What the car sweeps over one loop, in the clip camera's own view space: the middle of it (cx, cy)
 * relative to where the camera looks now, and its width and height, in world units.
 */
export function frameRun(cam, place, baseYaw, player) {
  const inv = cam.matrixWorldInverse;
  const v = new THREE.Vector3();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  // Measured relative to the camera's track, so a tracking clip is framed on what it holds at once
  // rather than on everything it passes.
  const sweep = (along, lateral, yaw) => {
    const { x: cx, z: cz } = onStreet(place, along, lateral);
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
  };
  for (let t = 0; t <= player.loop; t += 0.05) {
    const p = player.at(t);
    const track = player.track(t);
    sweep(p.along - track, p.lateral, baseYaw + p.yaw);
    const lead = player.lead(t);
    if (lead) sweep(lead.along - track, lead.lateral, baseYaw + lead.yaw);
  }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

/**
 * The same measurement off a list of car poses ({x, z, yaw}) rather than a reel, plus any `extra`
 * world points ({x, y, z}) the frame has to hold as well — game/repairclip.js's depot door.
 */
export function framePoses(cam, poses, extra = []) {
  const inv = cam.matrixWorldInverse;
  const v = new THREE.Vector3();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const take = () => {
    v.applyMatrix4(inv);
    x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
    y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
  };
  for (const { x: cx, z: cz, yaw } of poses) {
    const fx = Math.cos(yaw), fz = -Math.sin(yaw);
    for (const a of [-BODY_HALF_LEN, BODY_HALF_LEN]) {
      for (const b of [-BODY_HALF_W, BODY_HALF_W]) {
        for (const y of [0, BODY_TOP]) {
          v.set(cx + fx * a - fz * b, y, cz + fz * a + fx * b);
          take();
        }
      }
    }
  }
  for (const p of extra) { v.set(p.x, p.y, p.z); take(); }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

/**
 * The darkroom every clip shares: the still laid over the game, a clip camera that is the city
 * camera's own projection and view direction, and the copy of the middle of each frame into the
 * card. The depot's clip (game/repairclip.js) uses it: it is not a reel and frames itself off a
 * scripted drive rather than a recording, so it shares this part and not createMoveClip.
 *
 * `film(run, alpha)` draws one frame zoomed so `run` — frameRun's shape, in the clip camera's view
 * space after `centre` — fits with FRAME_MARGIN to spare.
 */
export function createClipStage({ camera, renderFrame, canvas, freeze, cardCanvas }) {
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

  const clipCam = camera.clone();
  // The framing below is all in world units; whatever push-in the city camera had is not part of it.
  clipCam.zoom = 1;
  clipCam.clearViewOffset();
  const toCamera = camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(-DISTANCE);

  let shotW = canvas.width;
  let shotH = canvas.height;

  return {
    clipCam,
    snapshot,
    /** Point the clip camera at a spot on the ground, from the city camera's standoff. */
    aim(x, z) {
      const target = new THREE.Vector3(x, 0, z);
      clipCam.position.copy(target).add(toCamera);
      clipCam.lookAt(target);
      clipCam.updateMatrixWorld(true);
    },
    /** Slide the camera across its own image plane onto the middle of `run`: same depth, same haze. */
    centre(run) {
      clipCam.position
        .add(new THREE.Vector3().setFromMatrixColumn(clipCam.matrixWorld, 0).multiplyScalar(run.cx))
        .add(new THREE.Vector3().setFromMatrixColumn(clipCam.matrixWorld, 1).multiplyScalar(run.cy));
      clipCam.updateMatrixWorld(true);
    },
    /** The window was resized under the card: the still is the wrong size. `hide(bool)` takes the
     * clip's own props out of shot while it is taken again. */
    resized(hide) {
      if (canvas.width === shotW && canvas.height === shotH) return;
      hide(true);
      snapshot();
      hide(false);
      shotW = canvas.width;
      shotH = canvas.height;
    },
    film(run, alpha) {
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
      const sx = Math.round((canvas.width - sw) / 2);
      const sy = Math.round((canvas.height - sh) / 2);
      const ctx = cardCanvas.getContext('2d');
      ctx.clearRect(0, 0, sw, sh);
      ctx.globalAlpha = alpha;
      ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      ctx.globalAlpha = 1;
    },
    /** Fade a loop in and out at its seam. */
    seam: (t, loop) => Math.min(1, t / SEAM, (loop - t) / SEAM),
    dispose() { freeze.hidden = true; },
  };
}

/**
 * The clip, filmed in the main scene. Returns null with no placement; the card then shows without
 * a clip.
 *
 * @param scene, camera   the city's scene and camera
 * @param renderFrame     (camera) => void — main.js's whole frame, with the camera to draw it from
 * @param canvas          the game's own canvas (the darkroom)
 * @param freeze          the `#freeze-frame` canvas laid over it
 * @param cardCanvas      the card's canvas, which the middle of each clip frame is copied into
 * @param place           where to film: {centre, forward, right} — the reel's frame in the city
 * @param player          reelPlayer's answer
 */
export function createMoveClip({ scene, camera, renderFrame, canvas, freeze, cardCanvas, place, player }) {
  if (!place) return null;
  const { reel } = player;

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
  scene.add(taxi.group);
  const flame = createLocoFlame(scene);
  // The bark out of the pipe on a launch and on the drift's kick (main.js's `flames`), when the
  // reel has any.
  const flames = reel.bursts?.length ? createFlames(scene, makeRng(1)) : null;
  const skids = createSkidMarks(scene);
  const car = { x: 0, z: 0, yaw: 0, crashed: false };
  const baseYaw = Math.atan2(-place.forward.z, place.forward.x);
  // The car being passed, when the reel has one: an ambient car built the way the fleet's wreck
  // shells are — its body (rear wheels baked in) and the front pair, in one paint.
  const leadCar = reel.lead ? (() => {
    const group = new THREE.Group();
    const material = propMaterial();
    material.color.set(PALETTE.carBody[1]);
    const body = new THREE.Mesh(carGeometry(), material);
    group.add(body);
    const wheel = wheelGeometry();
    for (const anchor of wheelAnchors(CAR_LEN, CAR_W).filter((a) => a.front)) {
      const mesh = new THREE.Mesh(wheel, material);
      mesh.position.set(anchor.x, anchor.y, anchor.z);
      group.add(mesh);
    }
    group.traverse((node) => { node.castShadow = true; node.receiveShadow = true; });
    scene.add(group);
    return group;
  })() : null;

  // The clip camera: the city camera's own projection and view direction, centred on the road.
  const clipCam = camera.clone();
  // The framing below is all in world units; whatever push-in the city camera had is not part of it.
  clipCam.zoom = 1;
  clipCam.clearViewOffset();
  const toCamera = camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(-DISTANCE);
  const target = new THREE.Vector3(place.centre.x, 0, place.centre.z);
  clipCam.position.copy(target).add(toCamera);
  clipCam.lookAt(target);
  clipCam.updateMatrixWorld(true);
  const run = frameRun(clipCam, place, baseYaw, player);
  // Slide the camera across its own image plane onto the middle of the run: same depth, same haze.
  clipCam.position
    .add(new THREE.Vector3().setFromMatrixColumn(clipCam.matrixWorld, 0).multiplyScalar(run.cx))
    .add(new THREE.Vector3().setFromMatrixColumn(clipCam.matrixWorld, 1).multiplyScalar(run.cy));
  clipCam.updateMatrixWorld(true);
  const camBase = clipCam.position.clone();

  let t = 0;
  let stamped = -1;      // the last reel frame whose rubber and bursts are down
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
    const track = player.track(t);
    clipCam.position.set(
      camBase.x + place.forward.x * track, camBase.y, camBase.z + place.forward.z * track,
    );
    clipCam.updateMatrixWorld(true);
    renderFrame(clipCam);
    const ctx = cardCanvas.getContext('2d');
    ctx.clearRect(0, 0, sw, sh);
    ctx.globalAlpha = Math.min(1, t / SEAM, (player.loop - t) / SEAM);
    ctx.drawImage(canvas,
      Math.round((canvas.width - sw) / 2), Math.round((canvas.height - sh) / 2), sw, sh, 0, 0, sw, sh);
    ctx.globalAlpha = 1;
  }

  // The reel's transform, laid on the road: what traffic.js's render pass writes on the taxi group.
  function pose() {
    const p = player.at(t);
    const at = onStreet(place, p.along, p.lateral);
    car.x = at.x;
    car.z = at.z;
    car.yaw = baseYaw + p.yaw;
    taxi.group.position.set(car.x, p.y, car.z);
    taxi.group.rotation.set(p.roll, car.yaw, p.pitch, BODY_EULER_ORDER);
    taxi.setSteer(p.wheel);
    taxi.setLights(p.brake, 0, 0);
    const lead = player.lead(t);
    if (lead) {
      const at2 = onStreet(place, lead.along, lead.lateral);
      leadCar.position.set(at2.x, ROAD_Y, at2.z);
      leadCar.rotation.set(0, baseYaw + lead.yaw, 0);
    }
    return p;
  }

  // The rubber the game laid on the take, stamped as main.js stamps it: the rear pair
  // (`stampRearRubber`, its own hand-typed 1.2 back and 1.04 out) or all four (`stampAllRubber`).
  // And the bursts, out of the pipe as `kickLocoMode` fires them.
  function layRubber(upTo) {
    for (const [n, along, lateral, yaw, kind, strength] of reel.rubber) {
      if (n <= stamped || n > upTo) continue;
      const at = onStreet(place, along - player.alongShift, lateral);
      const y = baseYaw + yaw;
      // The spin's own trail: one mark, already at its tyre (createTyreTrail).
      if (kind === 3) { skids.add(at.x, at.z, y, strength); continue; }
      const fx = Math.cos(y), fz = -Math.sin(y);
      const rx = Math.sin(y), rz = Math.cos(y);
      for (const side of [-1, 1]) {
        skids.add(at.x - fx * 1.2 + rx * side * 1.04, at.z - fz * 1.2 + rz * side * 1.04, y);
        if (kind === 2) {
          skids.add(at.x + fx * TAXI_FRONT_AXLE_FWD + rx * side * TAXI_FRONT_TRACK,
            at.z + fz * TAXI_FRONT_AXLE_FWD + rz * side * TAXI_FRONT_TRACK, y);
        }
      }
    }
    for (const [n, along, lateral, yaw] of reel.bursts ?? []) {
      if (n <= stamped || n > upTo) continue;
      const at = onStreet(place, along - player.alongShift, lateral);
      const y = baseYaw + yaw;
      flames.burst(at.x - Math.cos(y) * TAXI_TAILPIPE_BACK, TAXI_TAILPIPE_HEIGHT,
        at.z + Math.sin(y) * TAXI_TAILPIPE_BACK, y);
    }
    stamped = upTo;
  }

  return {
    get time() { return t; },
    restart() { t = 0; stamped = -1; },
    update(dt) {
      // The window was resized under the card: the still is the wrong size, so take it again with
      // the stand-in out of shot.
      if (canvas.width !== shotW || canvas.height !== shotH) {
        taxi.group.visible = false;
        if (leadCar) leadCar.visible = false;
        flame.group.visible = false;
        skids.mesh.visible = false;
        if (flames) flames.mesh.visible = false;
        snapshot();
        taxi.group.visible = true;
        if (leadCar) leadCar.visible = true;
        skids.mesh.visible = true;
        if (flames) flames.mesh.visible = true;
        shotW = canvas.width;
        shotH = canvas.height;
      }
      const before = t;
      t += dt;
      if (t >= player.loop) { t -= player.loop; stamped = -1; }
      const p = pose();
      flame.update(dt, car, p.flame > 0, p.flame === 2);
      layRubber(Math.floor(t / reel.step));
      skids.update(t < before ? 0 : dt);
      flames?.update(dt);
      frame();
    },
    /** Take the stand-in out of the city and the still down. */
    dispose() {
      for (const obj of [taxi.group, leadCar, flame.group, skids.mesh, flames?.mesh].filter(Boolean)) {
        scene.remove(obj);
        unmarkEmissive(obj);
        obj.traverse((node) => {
          node.geometry?.dispose();
          for (const m of [node.material].flat()) m?.dispose?.();
        });
      }
      freeze.hidden = true;
    },
  };
}
