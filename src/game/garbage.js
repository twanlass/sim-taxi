import * as THREE from 'three';
import { cityNetwork } from '../city/roadnet.js';
import { KERB_H } from '../city/ground.js';
import {
  setClosedLanes, isLaneClosed, placeCar, stopDistance, STOP_SETBACK, TRUCK_LEN,
} from '../sim/traffic.js';
import { findRoute, findRouteOnto, planOrigin, setHazardLanes, serviceLaneCost } from './route.js';
import { sightlineClear } from './sightline.js';
import { cornerFor } from './fares.js';
import { GRID_I, GRID_J } from '../city/grid.js';
import { cloneProp, hash01, propMaterial } from '../util/geo.js';
import { markOccluder } from './ssao.js';
import {
  createGarbageTruckMesh, bagGeometry, HOPPER_MOUTH, LID_OPEN, BAG_R,
} from '../geometry/garbage.js';

// Black bags piled on the kerb at street corners, and a garbage truck that drives round town
// collecting them (Tyler, 2026-10-24: "black trash bags piled on corners around the city, and then
// we've got a big trash truck that's kind of cruising around and picking up trash").
//
// **The truck is a car in traffic**, built exactly as the fire engine is (`enterGuest`, `wearSkin`
// and the `roadblock` pedal — see game/fire.js): it obeys the signals, queues, can be bumped, and
// when it stops at a pile everything behind it stops too. That is the whole of its gameplay. It is
// a slow thing that parks in a lane for a few seconds, which the player learns to read and either
// waits behind or goes round in Loco Mode. While it is parked the lane is shut to newcomers and
// priced up for the taxi's router, the way the fire engine's is, so a fare does not send the player
// down a street with a garbage truck across it when the next one is free.
//
// **It drives from pile to pile, never at random.** A truck rolling the ambient dice almost never
// ends up on the one lane beside a pile, so it is routed onto that lane (`findRouteOnto`) and
// stopped with the hopper level with the bags. Which pile next is the nearest full one, weighted
// toward the taxi so the player sees it work.
//
// **The bags are scenery.** The taxi never touches them: they stand on the pavement, and nothing in
// the traffic model drives onto it. (The post box and the hot dog cart are smashed by a swipe that
// is rare on purpose — game/streetprops.js — and bags on every few blocks that burst when clipped
// would undo that.)
//
// **Where.** Only on a block's +X kerb, at the −Z end of it, beside the lane running +Z. The camera
// sits off +X+Z, so of a block's four kerbs only +X and +Z are seen at all; and on the +Z kerb the
// lane that passes runs −X, which would park the truck's hopper — at its tail — on the block's
// +X+Z corner, where `cornerFor` (game/fares.js) stands every rider. The −Z end of the +X kerb is
// the corner no rider uses, and the lane beside it has the truck's whole length of road in front
// of the pile before its hold line.

/** `'classic'` has no bags and no truck: `?garbage=classic`, `GARBAGE=classic` headless. */
const GARBAGE_PARAM = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('garbage')
  : globalThis.process?.env?.GARBAGE;
export const GARBAGE_MODE = GARBAGE_PARAM === 'classic' ? 'classic' : 'on';

const PILES = 5;
const MIN_SEP = 18;            // between any two piles
const PAVE_IN = 0.4;           // the pile's centre, in from the kerb line (the façade is 0.85 in)
const KEEP_R = 6;              // clear of the post boxes and the cart, and their swipe
const LAMP_R = 1.6;            // clear of the street lamps
// Clear of every rider pin. The −Z end of a +X kerb is not a rider corner anywhere but the map's
// first row, where `cornerFor` flips its pin inward onto exactly this corner (the probe caught one).
const RIDER_R = 4.5;

// Where the truck stops, measured along the lane: its centre with a truck's length of road behind
// it inside the lane and a metre of slack before its hold line — the fire engine's window (`lo` and
// `hi` in game/fire.js). The pile is then laid HOPPER_BACK behind that, so the hopper stops level
// with it. 4.5 against the window's floor of 4.3 needs a lane of 11.7; an ordinary street's is 12,
// and the lane beside an arterial (10.67) cannot take it.
const STOP_S = TRUCK_LEN / 2 + 1.7;
const HOPPER_BACK = -HOPPER_MOUTH.x;
const PILE_S = STOP_S - HOPPER_BACK;

const BAGS = [4, 6];           // per pile
const MAX_BAGS = 6;
// The pile, in its own frame (x across the pavement, +X the road; z along the kerb), largest first.
// The sixth is the one on top.
const SLOTS = [
  { x: -0.04, z: -0.55, y: 0, s: 1.05, yaw: 0.3, tilt: 0 },
  { x: 0.04, z: 0.25, s: 1.1, y: 0, yaw: 2.1, tilt: 0.12 },
  { x: -0.06, z: 1.0, s: 0.9, y: 0, yaw: 4.0, tilt: -0.1 },
  { x: 0.12, z: -1.3, s: 0.85, y: 0, yaw: 1.2, tilt: 0.45 },
  { x: 0.14, z: 1.65, s: 0.78, y: 0, yaw: 5.2, tilt: -0.4 },
  { x: -0.04, z: -0.15, s: 0.88, y: 0.5, yaw: 2.8, tilt: 0.25 },
];

const SPAWN_WAIT = [8, 16];    // seconds into the run before the truck comes on
const SOON_WAIT = 1;           // ?garbage=soon
const RESPAWN_WAIT = 30;       // after the taxi writes it off
const FADE_TIME = 0.8;         // same dissolve as the fire engine and the cruiser
const GIVE_UP = 70;            // seconds on the way to one pile before it tries another
const WANDER_RETRY = 3;        // no full pile anywhere — drive somewhere and ask again

// Collecting, in seconds: the lid swings up, a bag goes every TOSS_GAP and takes FLIGHT to land, and
// the lid slams once the last one is in. Five bags is about three seconds parked — long enough to
// see, short enough that a taxi stuck behind it is waiting rather than stuck.
const LID_UP = 0.45;
const TOSS_GAP = 0.3;
const FLIGHT = 0.55;
const LID_SLAM = 0.16;
const SETTLE = 0.35;
const ARC = 1.2;               // how far over the higher end of its flight a bag peaks

// The slam's jolt on the chassis, a damped bounce like the flatbed's (game/flatbed.js).
const JOLT_Y = 0.09;
const JOLT_W = 24;
const JOLT_DECAY = 7;

// Refilling a cleared corner: some while later and only with the taxi away, the bags plop down one
// at a time — out of sight on a phone, and a little flourish where a desktop sees it.
const REFILL = [35, 70];
const REFILL_CLEAR = 26;
const PLOP = 0.35;
const PLOP_GAP = 0.22;

const smoothstep = (t) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};
const easeOutBack = (t) => {
  const b = Math.min(1, Math.max(0, t)) - 1;
  return 1 + 2.4 * b * b * b + 1.4 * b * b;
};

/**
 * Pick the piles' spots. Returns `[{ x, z, lane, s, stopS, laneKey, block }]`, or [] under
 * `?garbage=classic`. Needs the sightline field (`setCityOccluders`) and the city network to be the
 * one in play. `keepOut` is `{ x, z, r }` points nothing may stand within `r` of.
 */
export function planTrashPiles(rng, blocks, keepOut = []) {
  if (GARBAGE_MODE === 'classic') return [];
  const net = cityNetwork();
  const riders = [];
  for (let i = 0; i <= GRID_I; i++) for (let j = 0; j <= GRID_J; j++) riders.push(cornerFor(i, j));
  const candidates = [];
  for (const lane of net.lanes) {
    if (!lane.path || lane.path.kind !== 'line' || lane.degenerate) continue;
    if (lane.length - STOP_SETBACK - TRUCK_LEN / 2 - 1 < STOP_S) continue;
    const t = lane.path.tangentAt(0);
    // Running +Z, so its kerb — on its right — is the +X face of the block to its west.
    if (t.z < 0.999) continue;
    const kerb = lane.edge.halfWidth - lane.edge.laneOffset;
    const p = lane.path.at(PILE_S);
    const x = p.x - (kerb + PAVE_IN);
    const z = p.z;
    const block = [...blocks].find((b) => b.bounds
      && x > b.bounds.x0 && x < b.bounds.x1 && z > b.bounds.z0 && z < b.bounds.z1);
    if (!block || block.type !== 'built') continue;
    // The kerb line is the block's edge; anything else means this lane is not the one beside it.
    if (Math.abs(block.bounds.x1 - (x + PAVE_IN)) > 0.05) continue;
    // All of the pile along the kerb inside the block, not round its corner.
    if (z - 2 < block.bounds.z0) continue;
    if (!sightlineClear(x, 0.4, z - 0.6) || !sightlineClear(x, 0.4, z + 0.6)) continue;
    // ...and the truck, parked, in sight too — it is the half of this that moves.
    const stop = lane.path.at(STOP_S);
    if (!sightlineClear(stop.x, 2.2, stop.z)) continue;
    if (keepOut.some((k) => Math.hypot(k.x - x, k.z - z) < (k.r ?? LAMP_R))) continue;
    if (riders.some((c) => Math.hypot(c.x - x, c.z - z) < RIDER_R)) continue;
    const to = net.nodeById.get(lane.to);
    candidates.push({
      x, z, lane, s: PILE_S, stopS: STOP_S, block,
      laneKey: { d: net.dirOfLane(lane), i: to.gi, j: to.gj },
    });
  }
  for (let n = candidates.length - 1; n > 0; n--) {
    const k = rng.int(0, n);
    [candidates[n], candidates[k]] = [candidates[k], candidates[n]];
  }
  const out = [];
  for (const c of candidates) {
    if (out.length >= PILES) break;
    if (out.some((o) => Math.hypot(o.x - c.x, o.z - c.z) < MIN_SEP)) continue;
    out.push(c);
  }
  return out;
}

/** The keep-out radius planTrashPiles gives a street prop. */
export const PROP_KEEP_OUT = KEEP_R;

/**
 * @param rng      its own stream: how many bags, which pile next, when a corner refills
 * @param scene    where the piles and the truck are drawn
 * @param traffic  the sim — `enterGuest`, `wearSkin`, `taxi`
 * @param plan     planTrashPiles' answer
 * @param blocked  `() => boolean` — true while the truck may not come on (shot mode, the opening
 *                 vignette); the countdown holds rather than firing the moment it lifts
 * @param soon     `?garbage=soon` — the truck on a second in, headed for the pile nearest the taxi
 */
export function createGarbage({ rng, scene, traffic, plan, blocked = () => false, soon = false }) {
  const group = new THREE.Group();
  group.name = 'garbage';
  scene.add(group);
  const none = {
    piles: [], entryObjects: [], state: { phase: 'off' }, update: () => {}, spawn: () => false,
  };
  if (!plan.length) return none;
  const taxi = traffic.taxi;

  // --- The piles: one instanced mesh each, so the city's entrance wave can grow each as an object.
  const bagGeo = bagGeometry();
  const bagMaterial = propMaterial();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const sc = new THREE.Vector3();

  const piles = plan.map((p) => {
    const mesh = new THREE.InstancedMesh(bagGeo, bagMaterial, MAX_BAGS);
    mesh.name = 'trash-pile';
    mesh.position.set(p.x, KERB_H + 0.01, p.z);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Bags fly out of the pile's bounds and into the truck (CLAUDE.md, the box trucks).
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    const count = rng.int(BAGS[0], BAGS[1]);
    // The top bag only once there are bags to stand it on.
    const slots = SLOTS.slice(0, Math.min(count, 5)).concat(count >= 6 ? [SLOTS[5]] : []);
    const bags = slots.map((slot) => ({
      slot,
      yaw: slot.yaw + rng.jitter(0.4),
      scale: slot.s * rng.range(0.92, 1.08),
      state: 'rest',          // rest | flying | gone | plop
      t: 0,
      from: new THREE.Vector3(), to: new THREE.Vector3(), spin: new THREE.Vector3(),
    }));
    return {
      ...p, mesh, bags,
      state: 'full',          // full | taking | empty | refilling
      refillAt: 0,
      entry: { object: mesh, x: p.x, z: p.z, rand: hash01(p.x, p.z) },
    };
  });
  markOccluder(group);

  const restMatrix = (bag) => {
    const { slot } = bag;
    q.setFromEuler(e.set(slot.tilt, bag.yaw, slot.tilt * 0.5));
    return m.compose(v.set(slot.x, slot.y, slot.z), q, sc.setScalar(bag.scale));
  };

  function drawPile(pile) {
    pile.bags.forEach((bag, k) => {
      if (bag.state === 'gone') {
        pile.mesh.setMatrixAt(k, zero);
      } else if (bag.state === 'rest') {
        pile.mesh.setMatrixAt(k, restMatrix(bag));
      } else if (bag.state === 'plop') {
        // Dropped in from a little way up, landing with a squash.
        const u = Math.min(1, bag.t / PLOP);
        restMatrix(bag);
        const fall = (1 - smoothstep(u * 1.6)) * 0.8;
        const squash = u < 1 ? 1 + 0.25 * Math.sin(u * Math.PI) : 1;
        m.compose(v.set(bag.slot.x, bag.slot.y + fall, bag.slot.z), q,
          sc.set(bag.scale * easeOutBack(u * 1.4), bag.scale / squash, bag.scale * easeOutBack(u * 1.4)));
        pile.mesh.setMatrixAt(k, bag.t <= 0 ? zero : m);
      } else {
        const u = Math.min(1, bag.t / FLIGHT);
        // A lob: the straight line from the kerb to the hopper, plus a hump over it that peaks ARC
        // over the higher end.
        const rise = Math.abs(bag.to.y - bag.from.y) / 2 + ARC;
        const y = bag.from.y + (bag.to.y - bag.from.y) * u + 4 * rise * u * (1 - u);
        q.setFromEuler(e.set(bag.spin.x * u, bag.yaw + bag.spin.y * u, bag.spin.z * u));
        m.compose(v.set(bag.from.x + (bag.to.x - bag.from.x) * u, y, bag.from.z + (bag.to.z - bag.from.z) * u),
          q, sc.setScalar(bag.scale * (1 - 0.25 * u)));
        pile.mesh.setMatrixAt(k, m);
      }
    });
    pile.mesh.instanceMatrix.needsUpdate = true;
  }
  for (const pile of piles) drawPile(pile);

  // --- The truck -------------------------------------------------------------
  const rig = createGarbageTruckMesh();
  scene.add(rig.group);
  markOccluder(rig.group);
  const mouth = new THREE.Vector3();

  const state = {
    phase: 'off',             // off | driving | stopping | collecting
    t: 0,                     // seconds in the current phase
    wait: soon ? SOON_WAIT : rng.range(SPAWN_WAIT[0], SPAWN_WAIT[1]),
    truck: null,
    target: null,
    lid: 0,                   // 0 shut .. 1 open
    slamAt: -Infinity,        // when the lid comes down on this stop's bags
    joltAt: -Infinity,
    clock: 0,
    fade: 0,
    fading: 0,
    tossed: 0,
    landed: 0,
    collected: 0,             // piles cleared this run
    bagsIn: 0,
  };

  function skin(pos, quat, car) {
    rig.group.position.copy(pos);
    rig.group.quaternion.copy(quat);
    for (const wheel of rig.wheels) wheel.rotation.y = car.wheelAngle;
  }

  /** The truck's body for the wreck effects, if the taxi ever writes it off. */
  function wreck() {
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
    shell.visible = true;
    rig.group.matrixWorld.decompose(shell.position, shell.quaternion, shell.scale);
    rig.shell.visible = false;
    return shell;
  }

  /** The next pile: the nearest full one, weighted toward the taxi so the player sees it work. */
  function choose(truck, not = null) {
    const full = piles.filter((p) => p.state === 'full' && p !== not && !isLaneClosed(p.lane.id));
    if (!full.length) return null;
    const score = (p) => Math.hypot(p.x - truck.x, p.z - truck.z)
      + 0.6 * Math.hypot(p.x - taxi.x, p.z - taxi.z);
    return full.reduce((a, b) => (score(b) < score(a) ? b : a));
  }

  function spawn() {
    // Come on near the pile nearest the taxi, so the first thing the player sees it do is work.
    const first = choose(taxi) ?? piles[0];
    const stop = first.lane.path.at(first.stopS);
    const truck = traffic.enterGuest({ x: stop.x, z: stop.z });
    if (!truck) return false;
    traffic.wearSkin(truck, skin, rig.group);
    truck.guestWreck = wreck;
    truck.route = [];
    state.truck = truck;
    rig.group.position.set(truck.x, 0, truck.z);
    rig.shell.visible = true;
    state.fade = 0;
    state.fading = 1;
    head(first);
    return true;
  }

  function head(pile) {
    state.target = pile;
    state.phase = 'driving';
    state.t = 0;
    if (state.truck) {
      state.truck.route = [];
      state.truck.routeConsumed = false;
    }
  }

  /** Re-plan only once it has run out of route, never per frame (CLAUDE.md). */
  function steer(truck) {
    if (truck.route?.length) return;
    const pile = state.target;
    if (!pile) {
      // Nothing to collect: drive to a junction across town and ask again on the way.
      const net = cityNetwork();
      const nodes = net.nodes.filter((n) => n.gi != null);
      const far = rng.pick(nodes);
      const route = findRoute(planOrigin(truck), { i: far.gi, j: far.gj }, serviceLaneCost);
      if (route?.length) { truck.route = route; truck.routeConsumed = false; }
      return;
    }
    if (truck.lane === pile.lane && truck.state === 'drive' && truck.s < pile.stopS + 0.5) return;
    const { i, j, d } = pile.laneKey;
    const route = findRouteOnto(planOrigin(truck), { i, j }, d, serviceLaneCost);
    if (route?.length) { truck.route = route; truck.routeConsumed = false; } else head(choose(truck, pile));
  }

  /** On the pile's lane and inside braking distance of the stop: put the pedal down and hold it. */
  function tryStop(truck) {
    const pile = state.target;
    if (!pile || truck.lane !== pile.lane || truck.state !== 'drive') return false;
    if (truck.s + stopDistance(truck.v) < pile.stopS) return false;
    if (truck.s > pile.stopS + 0.5) return false;   // overshot — steer laps it round
    truck.roadblock = Infinity;
    return true;
  }

  function park() {
    const pile = state.target;
    state.phase = 'collecting';
    state.t = 0;
    state.tossed = 0;
    state.landed = 0;
    pile.state = 'taking';
    setClosedLanes([pile.lane.id], 'garbage');
    setHazardLanes([pile.lane.id], 'garbage');
  }

  function release() {
    setClosedLanes([], 'garbage');
    setHazardLanes([], 'garbage');
  }

  function drive(truck) {
    truck.roadblock = 0;
    truck.braking = false;
    const pile = state.target;
    if (pile) {
      pile.state = 'empty';
      pile.refillAt = state.clock + rng.range(REFILL[0], REFILL[1]);
      state.collected += 1;
    }
    release();
    head(choose(truck, pile));
  }

  function toss(pile) {
    // Top of the pile first, then whatever is nearest the road.
    const order = pile.bags.map((b, k) => k).sort((a, b) => pile.bags[b].slot.y - pile.bags[a].slot.y
      || pile.bags[b].slot.x - pile.bags[a].slot.x);
    const bag = pile.bags[order.find((k) => pile.bags[k].state === 'rest')];
    if (!bag) return false;
    bag.state = 'flying';
    bag.t = 0;
    bag.from.set(bag.slot.x, bag.slot.y + 0.1, bag.slot.z);
    rig.group.updateMatrixWorld(true);
    mouth.copy(HOPPER_MOUTH);
    // Spread along the hopper, so the bags do not all land on one point.
    mouth.x += rng.range(-0.3, 0.3);
    rig.group.localToWorld(mouth);
    bag.to.set(mouth.x - pile.mesh.position.x, mouth.y - pile.mesh.position.y, mouth.z - pile.mesh.position.z);
    bag.spin.set(rng.range(-4, 4), rng.range(-3, 3), rng.range(-4, 4));
    return true;
  }

  function stepCollect(dt, truck) {
    const pile = state.target;
    if (state.t >= LID_UP) {
      const due = Math.floor((state.t - LID_UP) / TOSS_GAP) + 1;
      while (state.tossed < due && toss(pile)) state.tossed += 1;
    }
    for (const bag of pile.bags) {
      if (bag.state !== 'flying') continue;
      bag.t += dt;
      if (bag.t >= FLIGHT) {
        bag.state = 'gone';
        state.bagsIn += 1;
        state.landed += 1;
      }
    }
    if (!pile.bags.every((b) => b.state === 'gone')) return;
    // A beat after the last one lands, the lid comes down on them.
    if (state.slamAt === -Infinity) state.slamAt = state.clock + 0.2;
    if (state.clock > state.slamAt + LID_SLAM + SETTLE) {
      state.slamAt = -Infinity;
      drive(truck);
    }
  }

  function refill(dt) {
    for (const pile of piles) {
      if (pile.state === 'empty' && state.clock >= pile.refillAt
        && Math.hypot(taxi.x - pile.x, taxi.z - pile.z) > REFILL_CLEAR) {
        pile.state = 'refilling';
        pile.bags.forEach((bag, k) => { bag.state = 'plop'; bag.t = -k * PLOP_GAP; });
      }
      if (pile.state === 'refilling') {
        let done = true;
        for (const bag of pile.bags) {
          bag.t += dt;
          if (bag.t < PLOP) done = false;
        }
        if (done) {
          for (const bag of pile.bags) bag.state = 'rest';
          pile.state = 'full';
        }
      }
    }
  }

  function lidAndJolt(dt, truck) {
    // Open while collecting until the slam; shut otherwise — the slam is fast, the opening is not.
    const want = state.phase === 'collecting' && (state.slamAt === -Infinity || state.clock < state.slamAt);
    const rate = want ? dt / LID_UP : dt / LID_SLAM;
    const before = state.lid;
    state.lid = Math.max(0, Math.min(1, state.lid + (want ? rate : -rate)));
    if (before > 0 && state.lid === 0 && !want) state.joltAt = state.clock;
    rig.hinge.rotation.z = -LID_OPEN * smoothstep(state.lid);
    if (truck) {
      const age = state.clock - state.joltAt;
      // Down first (the lid's weight landing), then the springs answering.
      truck.jolt = age < 1 ? -JOLT_Y * Math.exp(-JOLT_DECAY * age) * Math.sin(JOLT_W * age) : 0;
    }
  }

  function update(dt) {
    state.clock += dt;
    state.t += dt;
    const truck = state.truck;
    // The taxi wrote it off. Leave the wreck to the wreck path, and send another one later.
    if (truck?.crashed) {
      if (state.phase === 'collecting' && state.target) {
        state.target.state = 'full';
        for (const bag of state.target.bags) if (bag.state === 'flying') bag.state = 'gone';
      }
      release();
      state.truck = null;
      state.target = null;
      state.phase = 'off';
      state.wait = RESPAWN_WAIT;
    }

    if (state.phase === 'off') {
      if (!blocked()) {
        state.wait -= dt;
        if (state.wait <= 0 && !spawn()) state.wait = 1;
      }
    } else if (state.truck) {
      const tr = state.truck;
      if (state.phase === 'driving') {
        if (state.target && (state.target.state !== 'full' || state.t > GIVE_UP)) head(choose(tr, state.target));
        if (state.target && tryStop(tr)) state.phase = 'stopping';
        else if (!state.target && state.t > WANDER_RETRY) head(choose(tr));
        else steer(tr);
      } else if (state.phase === 'stopping') {
        if (tr.v < 0.05) park();
      } else if (state.phase === 'collecting') {
        stepCollect(dt, tr);
      }
    }

    refill(dt);
    for (const pile of piles) drawPile(pile);

    if (state.fading) {
      state.fade = Math.min(1, Math.max(0, state.fade + state.fading * dt / FADE_TIME));
      if (state.fade === 1) state.fading = 0;
    }
    for (const material of rig.faders) material.opacity = state.fade;
    if (!state.truck && state.phase === 'off') rig.shell.visible = false;
    lidAndJolt(dt, state.truck);
  }

  /**
   * Shot mode: the truck parked at `pile` and `seconds` into taking it, for a still. Nothing in a
   * frozen frame drives there, so it is put there — `placeCar` on the pile's lane at its stop, the
   * pedal held — and only this module is stepped on; `draw` is the traffic model's render pass,
   * which is what poses the truck the bags are aimed at.
   */
  function stage(pile, seconds, draw) {
    if (!pile || (!state.truck && !spawn())) return false;
    const truck = state.truck;
    const { i, j, d } = pile.laneKey;
    placeCar(truck, d, i, j, pile.lane.length - pile.stopS);
    truck.v = 0;
    truck.route = [];
    truck.roadblock = Infinity;
    state.fade = 1;
    state.fading = 0;
    state.target = pile;
    park();
    draw();
    for (let t = 0; t < seconds; t += 1 / 60) {
      state.clock += 1 / 60;
      state.t += 1 / 60;
      if (state.phase === 'collecting') stepCollect(1 / 60, truck);
      lidAndJolt(1 / 60, truck);
    }
    for (const p of piles) drawPile(p);
    for (const material of rig.faders) material.opacity = state.fade;
    return true;
  }

  return {
    group,
    piles,
    state,
    stage,
    truckMesh: rig,
    entryObjects: piles.map((p) => p.entry),
    update,
    /** Bring the truck on now, for the probe and `__taxi`. Answers whether it came. */
    spawn: () => (state.truck ? true : spawn()),
    /** The bags that are on the kerb right now. */
    bagsOnKerb: () => piles.reduce((n, p) => n + p.bags.filter((b) => b.state === 'rest').length, 0),
  };
}

/** The pile radius, for anything that wants to keep clear of one. */
export const PILE_R = 1.6 + BAG_R;
