import * as THREE from 'three';
import { cityNetwork } from '../city/roadnet.js';
import { findRoute, planOrigin, serviceLaneCost } from './route.js';
import { cloneProp } from '../util/geo.js';
import { warmWreckOf } from './vanish.js';
import { stripGhostOutlines } from '../geometry/ghostoutline.js';
import { markOccluder } from './ssao.js';
import { createPlowMesh, PLOW_LEN, BLADE_W, BLADE_ANGLE } from '../geometry/plow.js';

// The snowplow, on a Snow Day (Tyler, 2026-11-25: "Add a snow plow"). A car in traffic like the
// garbage truck and the fire engine (`enterGuest`, `wearSkin`): it obeys the signals, queues, can
// be bumped and written off. It does not stop for anything or take anybody anywhere; it works the
// main roads, a fresh arterial or ring road each time it runs out of route, and behind its blade
// the snow comes off the lane.
//
// **Its lane is the gameplay.** The blade clears a lane-wide swath into the snow's track map
// (`snow.plow`), which the cover shader draws as the same slush a tread leaves, and main.js gives
// the taxi its grip back on it — no slide on a plowed lane (`plowed`). It fills back in over the
// tracks' own `REFILL`. So a player who reads where the plow has just been has a road that drives
// like a dry one, which is the "traffic behaves consistently and the player uses it" rule: the plow
// never does anything for the taxi, it simply goes where it goes.
//
// Side streets cost it double, so it keeps to the arterials and the ring the way a real one is
// sent out first, but it will cut down one to get where it is going.

const SPAWN_WAIT = [6, 12];    // seconds into the run before it comes on
const RESPAWN_WAIT = 25;       // after the taxi writes it off
const FADE_TIME = 0.8;         // the garbage truck's dissolve
/** The swath the blade clears: its width across the lane (the blade's own, turned), and how far
 * ahead of the truck's middle it rides. */
const SWATH = BLADE_W * Math.cos(BLADE_ANGLE) * 0.92;
const BLADE_AHEAD = PLOW_LEN / 2 + 0.55;
/** The beacon's flash: on for this share of each period, in seconds. */
const BEACON_PERIOD = 0.7;
const BEACON_DUTY = 0.45;
/** What a side street costs it, against a main road. */
const SIDE_COST = 2;

export function createPlow({ rng, scene, traffic, snow, blocked = () => false }) {
  const none = { state: { phase: 'off', truck: null }, emissiveMeshes: [], update: () => {}, spawn: () => false };
  if (!snow) return none;
  const taxi = traffic.taxi;

  const rig = createPlowMesh();
  scene.add(rig.group);
  warmWreckOf(scene, rig.shell, 'garbageTruck');
  markOccluder(rig.group);

  const state = {
    phase: 'off',              // off | working
    wait: rng.range(SPAWN_WAIT[0], SPAWN_WAIT[1]),
    truck: null,
    clock: 0,
    fade: 0,
    fading: 0,
    blade: null,               // where the blade was last frame, to clear the swath between
    cleared: 0,                // units of lane plowed this run, for the tools
  };

  function skin(pos, quat, car) {
    rig.group.position.copy(pos);
    rig.group.quaternion.copy(quat);
    for (const wheel of rig.wheels) wheel.rotation.y = car.wheelAngle;
  }

  function wreck() {
    rig.group.updateMatrixWorld(true);
    const shell = stripGhostOutlines(rig.shell.clone(true));
    shell.traverse((o) => {
      if (o.isMesh) {
        o.material = cloneProp(o.material);
        o.material.alphaHash = false;
        o.material.opacity = 1;
      }
    });
    shell.children[rig.shell.children.indexOf(rig.beacon)].visible = false;
    shell.visible = true;
    rig.group.matrixWorld.decompose(shell.position, shell.quaternion, shell.scale);
    rig.shell.visible = false;
    return shell;
  }

  const cost = (lane) => serviceLaneCost(lane) * (lane.klass === 'side' ? SIDE_COST : 1);

  function spawn() {
    const truck = traffic.enterGuest({ x: taxi.x, z: taxi.z });
    if (!truck) return false;
    traffic.wearSkin(truck, skin, rig.group);
    truck.guestWreck = wreck;
    truck.route = [];
    state.truck = truck;
    state.phase = 'working';
    state.blade = null;
    rig.group.position.set(truck.x, 0, truck.z);
    rig.shell.visible = true;
    state.fade = 0;
    state.fading = 1;
    return true;
  }

  /** Re-plan only once it has run out of route, never per frame (CLAUDE.md): a junction across town. */
  function steer(truck) {
    if (truck.route?.length) return;
    const nodes = cityNetwork().nodes.filter((n) => n.gi != null);
    for (let tries = 0; tries < 4; tries++) {
      const far = rng.pick(nodes);
      if (Math.hypot(far.x - truck.x, far.z - truck.z) < 30) continue;
      const route = findRoute(planOrigin(truck), { i: far.gi, j: far.gj }, cost);
      if (route?.length) { truck.route = route; truck.routeConsumed = false; return; }
    }
  }

  /** Clear the swath from where the blade was to where it is, on the ground only. */
  function clear(truck) {
    const fx = Math.cos(truck.yaw);
    const fz = -Math.sin(truck.yaw);
    const bx = truck.x + fx * BLADE_AHEAD;
    const bz = truck.z + fz * BLADE_AHEAD;
    const last = state.blade;
    // A jump (a respawn, a placeCar) is not a stretch of road it drove.
    if (last && Math.hypot(bx - last.x, bz - last.z) < 3 && !truck.crashed) {
      snow.plow(last.x, last.z, bx, bz, SWATH);
      state.cleared += Math.hypot(bx - last.x, bz - last.z);
    }
    state.blade = { x: bx, z: bz };
  }

  function update(dt) {
    state.clock += dt;
    const truck = state.truck;
    if (truck?.crashed) {
      state.truck = null;
      state.phase = 'off';
      state.wait = RESPAWN_WAIT;
    }
    if (state.phase === 'off') {
      if (!blocked()) {
        state.wait -= dt;
        if (state.wait <= 0 && !spawn()) state.wait = 1;
      }
    } else if (state.truck) {
      steer(state.truck);
      clear(state.truck);
    }
    if (state.fading) {
      state.fade = Math.min(1, Math.max(0, state.fade + state.fading * dt / FADE_TIME));
      if (state.fade === 1) state.fading = 0;
    }
    for (const material of rig.faders) material.opacity = state.fade;
    if (!state.truck && state.phase === 'off') rig.shell.visible = false;
    rig.beacon.visible = Boolean(state.truck) && (state.clock % BEACON_PERIOD) / BEACON_PERIOD < BEACON_DUTY;
  }

  return {
    state,
    truckMesh: rig,
    emissiveMeshes: [rig.beacon],
    update,
    /** Bring it on now, for the tools and `__taxi`. Answers whether it came. */
    spawn: () => (state.truck ? true : spawn()),
  };
}

/**
 * Under the snow tracks map, a texel this cleared or more counts as plowed. main.js samples it at
 * the taxi's middle, which a tread never reaches (the treads are under the wheels, 0.7 either side),
 * so only the blade's swath gives the grip back.
 */
export const PLOWED = 0.5;
