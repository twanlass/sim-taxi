import { createTaxiMesh, TAXI_TAILPIPE_BACK } from '../geometry/taxi.js';
import { PAVEMENT_Y } from '../city/garage.js';
import { ROAD_Y } from '../sim/traffic.js';
import { BODY_EULER_ORDER } from '../util/geo.js';
import { makeRng } from '../util/rng.js';
import { setGhostOutlines } from '../geometry/ghostoutline.js';
import { createTaxiDamage } from './taxidamage.js';
import { unmarkEmissive } from './bloom.js';
import { entryPath, exitPath, VISIT, REPAIR_GAP } from './opening.js';
import { createClipStage, framePoses } from './moveclip.js';

// The depot, acted out: the clip on its tip card (game/newmove.js `REPAIR`), which replaced the
// "Head to the shop for repairs." bubble that used to go up over the garage door (Tyler,
// 2026-10-06: "instead of a tool tip, a tutorial screen like drift and U-turn"). Filmed on the
// player's own depot, through the same darkroom as the move clips (game/moveclip.js
// `createClipStage`): a smoking stand-in taxi comes up the lane, a finger taps the door, the taxi
// turns in, the door comes down to its gap and the shop welds, and the door goes up on a clean car
// that drives back out onto the street.
//
// **The game's own visit, re-acted rather than recorded.** The move clips play back a recording
// because what they show is the traffic model's physics, which is not a function of anything you can
// call. The visit is not physics: from the lane onward it is the opening vignette's script
// (game/opening.js), run off two paths and a handful of speeds. So this runs that script again — the
// same `entryPath` and `exitPath`, the same numbers (`VISIT`) and the same ease on the door — and
// there is nothing to drift from. Two things are deliberately not the game's: the repair is
// CLIP_REPAIR rather than the full REPAIR, and the car does not wait at the kerb for a gap, because
// a loop is watched more than once and the dead time costs on every pass.
//
// **The real depot, borrowed.** The door the clip opens is the city's own (`setDoor`), and so is the
// welding (`workshop`, game/repairfx.js) — the world is frozen while the card is up and the depot is
// always shut then (the card refuses a visit in progress, `newMoveCalm` in main.js), so both are
// put back shut and quiet when it closes. The smoke and the sparks are the city's dust and spark
// pools, which the clip has to tick itself because the frame that normally does is frozen.

/** Seconds of shop work in the clip — REPAIR is 2.4, which is long to sit through on a loop. */
export const CLIP_REPAIR = 1.2;
/** How far down the lane short of the turn-in the clip starts, so there is time to see the tap. */
const LEAD = 4;
/** And how long it runs on up the lane after the car is back on it. */
const TAIL = 0.35;
/** The tap on the door: when, and how long the finger and its ring take. */
export const TAP_AT = 0.15;
const TAP_LEN = 0.75;
/** How hurt the stand-in is: under SMOKE_FRACTION, which is when the card goes up for real. */
const STAND_IN_HP = 0.3;
const STEP = 1 / 60;
// The turn signal, as traffic.js blinks it (TURN_SIGNAL_HZ / TURN_SIGNAL_DUTY there).
const SIGNAL_HZ = 1.1;
const SIGNAL_DUTY = 0.6;

const smoothstep = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));

/**
 * The whole visit as a list of frames, STEP apart: where the car is (x, z, yaw, kerb lift, pitch,
 * speed), its lamps (brake, right signal), the door (0 shut, 1 up), whether the shop is working and
 * whether the car is repaired yet. Pure, so `npm run check` can walk it.
 *
 * @param site  the depot's geometry — `garageSite` in city/garage.js
 */
export function scriptVisit(site) {
  const V = VISIT;
  const inPath = entryPath(site);
  const outPath = exitPath(site);
  const mouth = inPath.mouth;
  // As opening.js holds it: DOOR_CLEAR (0.3) short of the curtain, if the door is not up yet.
  const doorHoldS = inPath.fillet.length + (site.kerbX - (site.curtainX + TAXI_TAILPIPE_BACK + 0.3));
  const frames = [];
  const car = { x: mouth.x, z: mouth.z - LEAD, yaw: -Math.PI / 2, v: V.ENTER_V, pitch: 0, pitchV: 0 };
  let phase = 'lane';
  let clock = 0;
  let sIn = 0;
  let s = 0;
  let opened = 0;
  let door = 0;
  let closing = 0;
  let signalT = 0;
  let mounted = false;
  let climbed = false;
  let dropped = false;
  let landed = false;
  let repaired = false;
  let work = false;
  let lift = 0;
  let brake = 0;

  // Toward a speed at the opening's own rates.
  const toward = (target, dt) => {
    const before = car.v;
    car.v = target < car.v ? Math.max(target, car.v - V.BRAKE * dt) : Math.min(target, car.v + V.ACCEL * dt);
    brake = car.v < before - 1e-6 ? 1 : 0;
  };
  const along = (path, at) => {
    const p = path.at(at);
    const t = path.tangentAt(at);
    car.x = p.x;
    car.z = p.z;
    car.yaw = Math.atan2(-t.z, t.x);
  };

  for (let guard = 0; guard < 60 * 30 && phase !== 'end'; guard++) {
    const dt = STEP;
    clock += dt;
    const v0 = car.v;
    let signal = false;
    if (phase === 'lane') {
      signal = true;
      car.z += car.v * dt;
      if (car.z >= mouth.z) { phase = 'enter'; sIn = car.z - mouth.z; clock = 0; along(inPath, sIn); }
    } else if (phase === 'enter' || (phase === 'shut' && car.v > 0)) {
      if (phase === 'enter') {
        opened = Math.min(1, opened + dt / V.DOOR_TIME);
        door = 1 - (1 - opened) * (1 - opened);
      }
      const stopAt = opened < 1 ? doorHoldS : inPath.total;
      const room = Math.max(0, stopAt - sIn);
      const cruise = sIn < inPath.fillet.length ? V.ENTER_V : V.IN_CREEP;
      toward(Math.min(cruise, Math.sqrt(2 * V.BRAKE * room)), dt);
      sIn = Math.min(sIn + car.v * dt, stopAt);
      along(inPath, sIn);
      signal = sIn < inPath.fillet.length;
      const drop = smoothstep((car.x - (site.kerbX + V.DROP_FROM)) / (V.DROP_TO - V.DROP_FROM));
      lift = PAVEMENT_Y * (1 - drop);
      if (!mounted && drop < 1) { mounted = true; car.pitchV += V.MOUNT_PITCH; }
      if (!climbed && drop <= 0) { climbed = true; car.pitchV -= V.MOUNT_SETTLE; }
      if (sIn >= inPath.total - 1e-6 && car.v < 0.05) car.v = 0;
      // The clip's one cut: the door starts down as soon as the whole car is behind the curtain,
      // rather than once it has crept to the back wall — the rest of that crawl is out of sight.
      if (phase === 'enter' && opened >= 1 && car.x + TAXI_TAILPIPE_BACK < site.curtainX - 0.1) {
        phase = 'shut';
        clock = 0;
      }
    }
    if (phase === 'shut') {
      const k = Math.min(1, clock / (V.DOOR_SHUT * (1 - REPAIR_GAP)));
      door = 1 - k * (1 - REPAIR_GAP);
      if (k >= 1) {
        // Turned round behind the gap, under the first flash, as the game does it.
        phase = 'repair';
        clock = 0;
        repaired = true;
        work = true;
        along(outPath, 0);
        car.v = 0;
        car.pitch = 0;
        car.pitchV = 0;
        lift = PAVEMENT_Y;
      }
    } else if (phase === 'repair') {
      brake = 0;
      if (clock >= CLIP_REPAIR) { phase = 'door'; clock = 0; work = false; }
    } else if (phase === 'door') {
      const k = Math.min(1, clock / (V.DOOR_TIME * (1 - REPAIR_GAP)));
      door = REPAIR_GAP + (1 - REPAIR_GAP) * (1 - (1 - k) * (1 - k));
      if (k >= 1) { phase = 'reveal'; clock = 0; }
    } else if (phase === 'reveal') {
      brake = 1;
      if (clock >= V.REVEAL) { phase = 'roll'; clock = 0; }
    } else if (phase === 'roll') {
      signal = true;
      const target = s < outPath.run.length ? V.CREEP : s < outPath.total - 0.4 ? V.TURN_V : V.MERGE_V;
      toward(target, dt);
      s = Math.min(s + car.v * dt, outPath.total);
      along(outPath, s);
      const drop = smoothstep((car.x - (site.kerbX + V.DROP_FROM)) / (V.DROP_TO - V.DROP_FROM));
      lift = PAVEMENT_Y * (1 - drop);
      if (!dropped && drop > 0) { dropped = true; car.pitchV -= V.DROP_PITCH; }
      if (!landed && drop >= 1) { landed = true; car.pitchV += V.RISE_PITCH; }
      if (s > outPath.run.length) closing = Math.min(1, closing + dt / V.DOOR_CLOSE_TIME);
      door = 1 - closing;
      if (s >= outPath.total) { phase = 'out'; clock = 0; }
    } else if (phase === 'out') {
      toward(V.MERGE_V, dt);
      car.z += car.v * dt;
      car.yaw = -Math.PI / 2;
      lift = 0;
      closing = Math.min(1, closing + dt / V.DOOR_CLOSE_TIME);
      door = 1 - closing;
      if (clock >= TAIL) phase = 'end';
    }
    // traffic.js's pitch spring, which a staged car keeps: the acceleration dip plus the kerb's shoves.
    const accel = (car.v - v0) / dt;
    const target = Math.max(-0.13, Math.min(0.13, accel * 0.014));
    car.pitchV += ((target - car.pitch) * 60 - car.pitchV * 6) * dt;
    car.pitch += car.pitchV * dt;
    signalT = signal ? signalT + dt : 0;
    frames.push({
      x: car.x, z: car.z, yaw: car.yaw, lift, pitch: car.pitch, v: car.v, phase,
      brake: phase === 'shut' || phase === 'repair' ? 0 : brake,
      signal: signal && (signalT * SIGNAL_HZ) % 1 < SIGNAL_DUTY ? 1 : 0,
      door, work, repaired,
    });
  }
  return { frames, step: STEP, loop: frames.length * STEP };
}

/** No pedals on this card — the tap in the clip is the instruction. */
export const clipKeys = () => ({});

/**
 * The finger on the door at time t into the loop: null when it is not there, otherwise how far
 * through the tap it is (0..1). Drawn by the clip over its frame.
 */
export function tapAt(t) {
  const k = (t - TAP_AT) / TAP_LEN;
  return k >= 0 && k < 1 ? k : null;
}

/**
 * The clip, filmed in the main scene. Returns null with no depot; the card then shows without one.
 *
 * @param site       the depot's geometry
 * @param setDoor    the depot's shutter, 0..1 (city/garage.js)
 * @param workshop   game/repairfx.js, or null
 * @param sparks     game/sparks.js's pool
 * @param dust       game/dust.js's pool
 * @param hide       objects taken out of the clip while it films — the player's own taxi, which is
 *                   smoking wherever it was when the card went up and, near the depot, reads as a
 *                   second stand-in. In the still, where the player left it; put back on close.
 * the rest are createClipStage's — see game/moveclip.js
 */
export function createRepairClip({
  scene, camera, renderFrame, canvas, freeze, cardCanvas, site, setDoor, workshop = null, sparks, dust,
  hide = [],
}) {
  if (!site || !setDoor) return null;
  const script = scriptVisit(site);
  const { frames, step, loop } = script;
  const stage = createClipStage({ camera, renderFrame, canvas, freeze, cardCanvas });
  const wasVisible = hide.map((obj) => obj.visible);
  const showHidden = (on) => hide.forEach((obj, n) => { obj.visible = on && wasVisible[n]; });
  showHidden(false);

  const taxi = createTaxiMesh();
  // Its outline is for finding the car behind a building, and half this clip is spent inside one.
  setGhostOutlines(taxi.group, false);
  scene.add(taxi.group);
  // The stand-in wears the real damage rig, driven off a car object of its own.
  const car = { x: 0, z: 0, yaw: 0, v: 0, hp: STAND_IN_HP, crashed: false };
  const damage = createTaxiDamage({
    damage: taxi.damage, group: taxi.group, taxi: car, maxHp: 1, sparks, dust, roadY: ROAD_Y,
    rng: (() => { const r = makeRng(7); return () => r.next(); })(),
  });
  const knock = () => {
    damage.reset();
    const f = frames[0];
    Object.assign(car, { x: f.x, z: f.z, yaw: f.yaw });
    const fx = Math.cos(f.yaw), fz = -Math.sin(f.yaw);
    const rx = Math.sin(f.yaw), rz = Math.cos(f.yaw);
    // A nose into somebody's boot (the bonnet), and the back corner twice (the boot and the bumper).
    damage.hit(f.x + fx * 1.6 - rx * 0.6, f.z + fz * 1.6 - rz * 0.6, { rearEnd: true });
    damage.hit(f.x - fx * 1.6 + rx * 0.7, f.z - fz * 1.6 + rz * 0.7);
    damage.hit(f.x - fx * 1.6 + rx * 0.7, f.z - fz * 1.6 + rz * 0.7);
  };
  knock();

  // Framed on the whole drive plus the top of the door, so the tap lands inside the shot.
  stage.aim(site.focus.x, site.focus.z);
  const top = { x: site.frontX, y: site.doorH + 1, z: site.doorZ };
  const run = framePoses(stage.clipCam, frames.filter((_, n) => n % 3 === 0), [top]);
  stage.centre(run);

  let t = 0;
  let working = false;
  let healed = false;

  function pose(dt) {
    const f = frames[Math.min(frames.length - 1, Math.floor(t / step))];
    if (f.repaired && !healed) { healed = true; damage.reset(); }
    Object.assign(car, { x: f.x, z: f.z, yaw: f.yaw, v: f.v });
    taxi.group.position.set(f.x, ROAD_Y + f.lift, f.z);
    taxi.group.rotation.set(0, f.yaw, f.pitch, BODY_EULER_ORDER);
    taxi.setLights(f.brake, 0, f.signal);
    setDoor(f.door);
    if (workshop && f.work !== working) { working = f.work; if (working) workshop.start(); else workshop.stop(); }
    if (!healed) damage.update(dt);
  }

  // A fingertip pressing the door and a ring going out from it.
  function overlay(ctx, toCard, scale) {
    const k = tapAt(t);
    if (k === null) return;
    const at = toCard(site.focus.x, site.focus.y, site.focus.z);
    const r = 13 * scale;
    const press = k < 0.25 ? 1 - 0.2 * smoothstep(k / 0.25) : 0.8;
    const dot = Math.min(1, k / 0.1) * (1 - smoothstep((k - 0.45) / 0.3));
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 6 * scale;
    if (dot > 0) {
      ctx.globalAlpha = 0.9 * dot;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(at.x, at.y, r * press, 0, Math.PI * 2);
      ctx.fill();
    }
    const ring = (k - 0.2) / 0.8;
    if (ring > 0) {
      ctx.globalAlpha = 0.9 * (1 - ring);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3 * scale;
      ctx.beginPath();
      ctx.arc(at.x, at.y, r * (1 + 1.8 * ring), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  return {
    get time() { return t; },
    restart() { t = 0; healed = false; knock(); },
    update(dt) {
      stage.resized((out) => { taxi.group.visible = !out; showHidden(out); });
      t += dt;
      if (t >= loop) { t %= loop; healed = false; knock(); }
      pose(dt);
      workshop?.update(dt);
      dust.update(dt);
      sparks.update(dt);
      stage.film(run, stage.seam(t, loop), overlay);
    },
    /** Take the stand-in out of the city, the depot back to shut and quiet, and the still down. */
    dispose() {
      workshop?.stop();
      setDoor(0);
      showHidden(true);
      scene.remove(taxi.group);
      unmarkEmissive(taxi.group);
      taxi.group.traverse((node) => {
        node.geometry?.dispose();
        for (const m of [node.material].flat()) m?.dispose?.();
      });
      stage.dispose();
    },
  };
}
