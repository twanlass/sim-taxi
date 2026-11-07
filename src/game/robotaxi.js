import * as THREE from 'three';
import { cityNetwork } from '../city/roadnet.js';
import { KERB_H } from '../city/ground.js';
import { lineX, lineZ } from '../city/grid.js';
import { cloneProp, unlitMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { CAR_LEN, CAR_W, ROBO_SPEED, STOP_SETBACK, stopDistance } from '../sim/traffic.js';
import { createRoboTaxiMesh, ROBO_SCALE, ROBO_BAND_TIME } from '../geometry/robotaxi.js';
import { WHEEL_R } from '../geometry/wheels.js';
import { findRoute, planOrigin } from './route.js';
import { BOARD_SECONDS, kerbFor } from './fares.js';
import { markOccluder } from './ssao.js';

// The robo-taxis: the city council's driverless cabs, arriving in town to take your riders.
//
// Each one is a guest car in traffic (`enterGuest`, sim/traffic.js) wearing the glass-topped pod
// of geometry/robotaxi.js, with `car.robo` set — which is everything the sim knows about it: it
// cruises at ROBO_SPEED, crawls round corners, pulls away gently and sits out the long stop at every
// junction (ROBO_STOP_DWELL). It queues, stops, can be bumped and can be wrecked like any car.
//
// What it does that a car does not is **hunt**. While its seat is empty it picks the waiting rider
// nearest to *itself* — never the one the player is heading for, never reacting to the taxi at all:
// traffic stays predictable and the player is the one who takes the risk — marks that rider with a
// cyan ring, and drives there. If it gets to their junction first it stops, the rider runs over and
// hops in (`fares.steal`), the fare leaves the board with no strike, and the robo-taxi drives off
// with them for BUSY_SECONDS before it starts hunting again. Slow is the player's counterplay: a taxi
// that goes for the marked rider nearly always gets there first. One that ignores them does not.
//
//   off      not on the map yet, or written off and waiting to come back
//   hunt     seat empty: driving at its claimed rider, or wandering while there is none
//   board    stopped at the corner while the rider runs over and gets in
//   busy     carrying them: wandering town with the lamps steady, not hunting

/** How many are about at once. */
export const ROBO_COUNT = 2;

/** Seconds a robo-taxi drives a stolen rider around before it hunts again. */
const BUSY_SECONDS = 20;

/** Seconds between arrivals on the map, so two do not appear together. */
const ENTER_GAP = 8;

/** After a wreck, how long before a replacement turns up. */
const RESPAWN_WAIT = 25;

/** The robo-taxi stops for the rider for the boarding run and a beat after it. */
const BOARD_HOLD = BOARD_SECONDS + 0.4;

/** The claim ring under a marked rider: wider than the kerb disc (3.5 across), thin, pulsing. */
const CLAIM_R = 2.3;
const CLAIM_W = 0.22;
// Over the pavement (KERB_H + 0.01) and over the rider's own disc, clear of both.
const CLAIM_Y = KERB_H + 0.07;

const FADE_TIME = 0.8;

/**
 * @param traffic  the sim — `enterGuest`, `retireGuest`, `wearSkin`, `taxi`
 * @param fares    the fare board — `stealable`, `steal`, `state`
 * @param blocked  () => true while nothing should come on (shot mode, the opening vignette)
 * @param soon     `?robotaxi=soon`: on the map from the start rather than after the first delivery
 */
export function createRoboTaxis({ rng, scene, traffic, fares, blocked = () => false, soon = false, count = ROBO_COUNT }) {
  const taxi = traffic.taxi;
  const ringGeo = new THREE.RingGeometry(CLAIM_R - CLAIM_W, CLAIM_R, 48);
  ringGeo.rotateX(-Math.PI / 2);

  const robos = Array.from({ length: count }, (_, k) => {
    const rig = createRoboTaxiMesh(CAR_LEN, CAR_W);
    scene.add(rig.group);
    markOccluder(rig.group);
    const ringMat = unlitMaterial({
      color: PALETTE.roboGlow, transparent: true, opacity: 0.85, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.visible = false;
    ring.renderOrder = 2;
    scene.add(ring);
    return {
      k, rig, ring, car: null, phase: 'off', t: 0, target: null, arrived: false, fade: 0, fading: 0,
      wait: soon ? 1 + k * 3 : k * ENTER_GAP,
    };
  });
  const state = { robos, stolen: 0, clock: 0 };

  const skinFor = (robo) => (pos, quat, car) => {
    robo.rig.group.position.copy(pos);
    robo.rig.group.quaternion.copy(quat);
    // The balls roll by the ground covered since the last frame (WHEEL_R per radian), forward
    // being +x, which is a turn about -z (the ball is drawn ROBO_SCALE up, so its radius is too). Measured off the pose rather than v·dt so a shove rolls
    // them too, but capped so a re-placement does not spin them into a blur.
    const moved = robo.lastPos ? Math.min(pos.distanceTo(robo.lastPos), 1) : 0;
    robo.lastPos = (robo.lastPos ?? new THREE.Vector3()).copy(pos);
    robo.roll = (robo.roll ?? 0) - Math.sign(car.v || 1) * moved / (WHEEL_R * ROBO_SCALE);
    for (const wheel of robo.rig.wheels) {
      wheel.rotation.z = robo.roll;
      wheel.rotation.y = wheel.userData.steers ? car.wheelAngle : 0;
    }
  };

  /** The body for the wreck effects, if the taxi writes one off. */
  const wreckFor = (robo) => () => {
    const { rig } = robo;
    rig.group.updateMatrixWorld(true);
    const shell = rig.shell.clone(true);
    shell.traverse((o) => {
      if (o.isMesh) {
        // `cloneProp`, not `clone()`: a plain clone drops the paint patch (see util/geo.js).
        o.material = cloneProp(o.material);
        o.material.alphaHash = false;
        o.material.opacity = 1;
      }
    });
    // A wreck's lamps are dark.
    shell.children[rig.shell.children.indexOf(rig.glow)].visible = false;
    shell.traverse((o) => { if (o.userData.roboLamp) o.visible = false; });
    shell.visible = true;
    rig.group.matrixWorld.decompose(shell.position, shell.quaternion, shell.scale);
    rig.shell.visible = false;
    return shell;
  };

  function spawn(robo) {
    // In somewhere near a rider it could take, or anywhere in town if there is none — off screen
    // either way (`enterGuest` keeps SPAWN_CLEARANCE from the taxi).
    const riders = fares.stealable();
    const near = riders.length ? kerbFor(rng.pick(riders)) : randomJunction();
    const car = traffic.enterGuest({ x: near.x, z: near.z }, { isTruck: false });
    if (!car) return false;
    car.robo = true;
    car.v = ROBO_SPEED;
    car.prevV = ROBO_SPEED;
    car.route = [];
    traffic.wearSkin(car, skinFor(robo), robo.rig.group);
    car.guestWreck = wreckFor(robo);
    robo.car = car;
    robo.rig.group.position.set(car.x, 0, car.z);
    robo.rig.shell.visible = true;
    robo.fade = 0;
    robo.fading = 1;
    setPhase(robo, 'hunt');
    return true;
  }

  function randomJunction() {
    const nodes = cityNetwork().nodes.filter((n) => n.gi != null);
    const n = rng.pick(nodes);
    return { x: lineX(n.gi), z: lineZ(n.gj), i: n.gi, j: n.gj };
  }

  function setPhase(robo, phase) {
    robo.phase = phase;
    robo.t = 0;
    robo.target = null;
    robo.arrived = false;
    if (robo.car) {
      robo.car.route = [];
      robo.car.routeConsumed = false;
    }
  }

  /** The nearest rider to this robo-taxi that no other one has claimed. */
  function choose(robo) {
    const car = robo.car;
    const taken = new Set(robos.filter((r) => r !== robo && r.target).map((r) => r.target));
    let best = null;
    let bestD = Infinity;
    for (const fare of fares.stealable()) {
      if (taken.has(fare)) continue;
      const kerb = kerbFor(fare);
      const d = Math.hypot(kerb.x - car.x, kerb.z - car.z);
      if (d < bestD) { bestD = d; best = fare; }
    }
    return best;
  }

  /** Re-plan only once it has run out of route, never per frame (CLAUDE.md). */
  function steer(car, goal) {
    if (car.route?.length) return;
    const route = findRoute(planOrigin(car), goal);
    if (route?.length) { car.route = route; car.routeConsumed = false; }
  }

  function wander(car) {
    if (car.route?.length) return;
    const j = randomJunction();
    steer(car, { i: j.i, j: j.j });
  }

  function hunt(robo, dt) {
    const car = robo.car;
    // A claim lapses when the rider leaves the board any way at all — picked up, given up, taken
    // by the other robo-taxi — and the next one is chosen fresh.
    if (robo.target && !fares.stealable().includes(robo.target)) {
      robo.target = null;
      car.route = [];
      car.routeConsumed = false;
      car.roadblock = 0;
      robo.arrived = false;
    }
    if (!robo.target) robo.target = choose(robo);
    const fare = robo.target;
    if (!fare) { wander(car); return; }
    const { i, j } = fare.pickup;
    // On a lane into the rider's junction, and close enough that braking now stops it at the hold
    // line, where the all-way stop would have stood it anyway. Measured along the lane rather than
    // as a radius from the junction: an arterial's hold line is ~10 units out, past the taxi's own
    // ARRIVE_RADIUS, and a robot that never counted as arrived drove laps round its rider.
    const left = car.lane ? car.lane.length - car.s : Infinity;
    // Latched: once it has braked for the corner it has arrived, even though standing still it is
    // a touch further back than the test reads on the move (the stopping distance it had is gone).
    robo.arrived ||= car.state === 'drive' && car.i === i && car.j === j
      && left - stopDistance(car.v) < STOP_SETBACK + 1;
    if (robo.arrived) {
      // At the corner: brake and hold, and once it is standing the rider is theirs.
      car.roadblock = Infinity;
      if (car.v < 0.1 && fares.steal(fare, car)) {
        robo.target = null;
        robo.arrived = false;
        state.stolen += 1;
        robo.phase = 'board';
        robo.t = 0;
      }
      return;
    }
    steer(car, { i, j });
    robo.t += dt;
  }

  function update(dt) {
    state.clock += dt;
    ROBO_BAND_TIME.value = state.clock;
    for (const robo of robos) {
      const car = robo.car;
      // The taxi wrote it off. The wreck path has the body; another one comes along later.
      if (car?.crashed) {
        robo.car = null;
        robo.target = null;
        robo.phase = 'off';
        robo.wait = RESPAWN_WAIT;
      }
      if (robo.phase === 'off') {
        const ready = soon || fares.state.delivered >= 1;
        if (ready && !blocked() && !fares.state.gameOver) {
          robo.wait -= dt;
          if (robo.wait <= 0 && !spawn(robo)) robo.wait = 1;
        }
      } else if (robo.car) {
        robo.t += robo.phase === 'hunt' ? 0 : dt;
        if (robo.phase === 'hunt') hunt(robo, dt);
        else if (robo.phase === 'board') {
          if (robo.t >= BOARD_HOLD) {
            robo.car.roadblock = 0;
            setPhase(robo, 'busy');
          }
        } else if (robo.phase === 'busy') {
          wander(robo.car);
          if (robo.t >= BUSY_SECONDS) setPhase(robo, 'hunt');
        }
      }

      if (robo.fading) {
        robo.fade = Math.min(1, Math.max(0, robo.fade + robo.fading * dt / FADE_TIME));
        if (robo.fade === 1) robo.fading = 0;
      }
      for (const material of robo.rig.faders) material.opacity = robo.fade;
      if (robo.car) robo.car.skinLamps = robo.fade;
      if (!robo.car && robo.phase === 'off') robo.rig.shell.visible = false;

      // The lamps: a slow breathe while it hunts, steady once it has someone aboard.
      const hunting = robo.phase === 'hunt';
      const breathe = 0.55 + 0.45 * Math.sin(state.clock * 3 + robo.k * 1.7);
      robo.rig.glow.material.color.set(PALETTE.roboGlow).multiplyScalar(hunting ? breathe : 0.85);

      // The ring under the claimed rider, breathing on the same beat.
      const fare = robo.phase === 'hunt' ? robo.target : null;
      robo.ring.visible = Boolean(fare) && !fares.state.gameOver;
      if (fare) {
        const kerb = kerbFor(fare);
        robo.ring.position.set(kerb.x, CLAIM_Y, kerb.z);
        const s = 1 + 0.06 * Math.sin(state.clock * 3 + robo.k * 1.7);
        robo.ring.scale.set(s, 1, s);
        robo.ring.material.opacity = 0.5 + 0.35 * breathe;
      }
    }
  }

  return {
    state,
    update,
    /** The cyan lamps, for main.js to put in the bloom. */
    emissiveMeshes: robos.flatMap((r) => [r.rig.glow, r.rig.band]),
    /** Bring every robo-taxi on now, for the probe and `__taxi`. Answers how many are on. */
    spawnAll: () => robos.filter((r) => r.car || spawn(r)).length,
    /** The traffic cars, for the probe. */
    cars: () => robos.map((r) => r.car).filter(Boolean),
  };
}
