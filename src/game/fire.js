import * as THREE from 'three';
import { skipWhenEmpty } from '../util/emptypools.js';
import { GRID_I, GRID_J, DIR, lineX, lineZ } from '../city/grid.js';
import { cityNetwork } from '../city/roadnet.js';
import {
  setClosedLanes, isLaneClosed, stopDistance, STOP_SETBACK, SPAWN_CLEARANCE, TRUCK_LEN,
} from '../sim/traffic.js';
import { findRoute, findRouteOnto, planOrigin, setHazardLanes } from './route.js';
import { heightAt, sightlineClear } from './sightline.js';
import { unlitMaterial } from '../util/geo.js';
import { color } from '../palette.js';
import { markEmissive } from './bloom.js';
import { markOccluder } from './ssao.js';
import { createFireTruckMesh } from '../geometry/firetruck.js';
import { sirenOn } from '../geometry/lights.js';

// A building on fire, and the engine that comes to put it out.
//
// Flames break out of the top of a facade and off its roof, with a column of smoke over them. A few
// seconds later a fire engine comes in off the edge of the frame with its bar going, drives through
// traffic to the street in front of the building, **stops in its lane** — and everything behind it
// queues — swings its ladder round, lifts it, and puts a jet of water on the fire. The flames shrink,
// the smoke goes white with steam, and once it is out the ladder comes down, the engine pulls away
// and the street opens again. Nobody hooks up to a hydrant: the engine carries its own water.
//
// **The engine is a car in traffic** (`enterGuest` in sim/traffic.js), not a scripted prop on a rail:
// it is routed to the fire the way a cop is routed to the taxi, obeys the signals, queues, and can be
// bumped. It stops by holding `roadblock` — the pedal a cop's chosen stop holds — so it brakes the way
// any car brakes and the cars behind it follow it down to a standstill on the ordinary rules. Not one
// of the police: the robbery and the patrol both clear and re-route the whole cop fleet.
//
// **What it blocks.** Its own lane, physically: anything already behind it waits. And while it is
// parked the lane is shut to newcomers (`setClosedLanes(…, 'fire')`) so the queue does not grow back
// through the junction behind it, and priced up for the taxi's router (`setHazardLanes`) so a fare
// does not send the player down it when the next street is free. Both are soft for the taxi on
// purpose — it can still queue behind the engine, or boost round it in the oncoming lane.
//
// **Where.** A building on the camera's side of its block (+X or +Z face — the view is down the
// −X−Z diagonal), on a street that is not the ring, with the flames and the engine's stop both in
// clear sight (`sightlineClear`), a couple of blocks from the taxi. The towers are one merged mesh,
// so the facade is found by marching the occluder height field in from the lane (`heightAt`).
//
// Scheduling is off the difficulty curve, like the roadworks and the flatbed: it is something to
// watch, not pressure.

// 70-130 first, and most runs ended without one — the timer only counts while nothing upstages it,
// and a site has to qualify on top. 35-60 lands one inside an ordinary run.
const FIRST_WAIT = [35, 60];    // seconds into the run
const REPEAT_WAIT = [110, 170]; // ...and between fires after that
const SOON_WAIT = 3;            // ?fire=soon
const RETRY_WAIT = 4;           // nothing qualified this time — the taxi moves, ask again shortly

const IGNITE = 2.6;             // seconds for the fire to take hold
const DISPATCH = 2.2;           // ...and for the engine to be called once it is visible
const RESPONSE_MAX = 55;        // an engine that has not got there by now never will; it burns out
const BURN_OUT = 6;             // seconds a fire with nobody on it takes to die back by itself
const RIG = 1.4;                // ladder swinging round and lifting, and back down again
const EXTINGUISH = 7;           // seconds of water on it to put it out
const SMOULDER = 3.2;           // steam after the last flame, before the crew packs up
const EXIT_REACH = 8;           // how close to its exit corner the engine dissolves
const LEAVE_MAX = 30;           // ...and the latest it is taken off the road regardless
const FADE_TIME = 0.8;          // same dissolve as the patrol cruiser (sim/police.js)

// The squall (game/squall.js). A building burning away under a rain cell reads as a mistake, so a
// fire is not started anywhere the cell is or is about to be — `RAIN_LEAD` covers the flames taking
// hold and the engine's median 23s drive — and one the cell reaches anyway (it runs late, or the
// taxi took the fire somewhere the forecast did not cover) is put out by the rain, in steam.
const RAIN_LEAD = 20;           // seconds of the cell's path a new site has to stay clear of
const RAIN_CLEAR = 0.02;        // ...as rain at the site, 0..1 — anything past the cell's ragged edge
const RAIN_DOUSE = 2.5;         // seconds of full rain to put a fire out

// The engine on the way in drives on a share of a chasing cop's kit (`car.chase` in sim/traffic.js):
// its cruise ceiling lifted by that share of CHASE_SPEED, the car in front pulling out of its way,
// and the licence to cross a red on a provably empty junction. A share because it is a fire engine,
// not a pursuit — and because without any of it the wait was the whole vignette: over 12 cities,
// flames up to engine parked took a median 23s and up to 43s at ordinary traffic manners.
// 0.6 of the lift on a truck's 5.5 u/s cruise is 10.6 — a little over a car's 8.5, which is what a
// fire engine on a call looks like next to the traffic it is passing.
const RESPONSE_CHASE = 0.6;

// How far upstream of the fire's lane the engine may come onto the map, in legs, tried nearest
// first. The spawn has to be off screen (SPAWN_CLEARANCE from the taxi), so the nearest few legs
// are often all in frame and the search widens until one is not.
const UPSTREAM_LEGS = [2, 3, 4, 6];

// Where a fire may be, measured off the taxi: near enough to be in the picture on a phone at play
// zoom (about 60 units across), not on top of the car.
const SITE_NEAR = 14;
const SITE_FAR = 46;
const SITE_IDEAL = 28;
const MIN_HEIGHT = 3.6;         // a building shorter than this is a shed, and flames on it read as litter
const SOLID = 2.5;              // what counts as a wall in the height field, rather than a lamp post
const FACADE_REACH = 8.5;       // furthest a facade may stand from the centre of the near lane
const FIRE_W = 3.2;             // how much of the facade burns, along it

// The ladder's working pose, and the jet it throws.
const LADDER_PITCH = 0.5;       // rad, about 29°: tip ~2 units over the turntable
const WATER_G = 14;             // the jet's gravity — a touch light, so it reads as an arc, not a drop
const WATER_RATE = 150;         // motes a second
const AIM_UP = 0.72;            // where on the building the water lands, as a fraction of its height

const MAX_FLAMES = 160;
const MAX_SMOKE = 90;
const MAX_WATER = 220;

const UP = new THREE.Vector3(0, 1, 0);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * Per-instance alpha on an instanced material — the recipe game/flames.js uses. The cache key is the
 * patch's own name: two materials patched this way compile to the same source and should share a
 * program (see the `customProgramCacheKey` traps in CLAUDE.md).
 */
function patchAlpha(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a *= vAlpha;');
  };
  material.customProgramCacheKey = () => 'fire-alpha';
  return material;
}

/**
 * A pool of instanced motes with ballistic motion. `look(slot, t, out)` fills `out.size`,
 * `out.alpha` and `out.color` for a mote `t` of the way through its life; `kind` is a free tag per
 * mote for it to read. Motes are spawned round-robin, so a full pool recycles its oldest.
 */
function createPool(scene, rng, { max, geometry, material, renderOrder, gravity = 0, drag = 0, look }) {
  const alphas = new Float32Array(max);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));
  const mesh = skipWhenEmpty(new THREE.InstancedMesh(geometry, patchAlpha(material), max));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;   // a moving InstancedMesh — see CLAUDE.md
  mesh.renderOrder = renderOrder;
  scene.add(mesh);

  const age = new Float32Array(max);
  const life = new Float32Array(max);
  const px = new Float32Array(max); const py = new Float32Array(max); const pz = new Float32Array(max);
  const vx = new Float32Array(max); const vy = new Float32Array(max); const vz = new Float32Array(max);
  const spin = new Float32Array(max);
  const kind = new Uint8Array(max);
  const dummy = new THREE.Object3D();
  const out = { size: 0, alpha: 0, color: new THREE.Color() };

  dummy.scale.setScalar(0);
  dummy.updateMatrix();
  for (let k = 0; k < max; k++) {
    mesh.setMatrixAt(k, dummy.matrix);
    mesh.setColorAt(k, out.color);
  }
  let next = 0;
  let live = 0;

  function spawn(x, y, z, ux, uy, uz, duration, tag = 0) {
    const k = next;
    next = (next + 1) % max;
    if (life[k] <= 0) live += 1;
    age[k] = 0;
    life[k] = duration;
    px[k] = x; py[k] = y; pz[k] = z;
    vx[k] = ux; vy[k] = uy; vz[k] = uz;
    spin[k] = rng.range(0, Math.PI * 2);
    kind[k] = tag;
    return k;
  }

  /** Step every live mote. `expired(slot)` is told about each one the frame its life runs out. */
  function update(dt, expired = null) {
    if (!live) return;
    const damp = Math.exp(-drag * dt);
    for (let k = 0; k < max; k++) {
      if (life[k] <= 0) continue;
      age[k] += dt;
      if (age[k] >= life[k]) {
        if (expired) expired(k);
        life[k] = 0;
        live -= 1;
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        mesh.setMatrixAt(k, dummy.matrix);
        alphas[k] = 0;
        continue;
      }
      vy[k] -= gravity * dt;
      vx[k] *= damp; vz[k] *= damp;
      // Rising motes are braked on the way up as well; a falling one is left to gravity.
      if (!gravity) vy[k] *= damp;
      px[k] += vx[k] * dt; py[k] += vy[k] * dt; pz[k] += vz[k] * dt;
      look(k, age[k] / life[k], out);
      dummy.position.set(px[k], py[k], pz[k]);
      dummy.rotation.set(spin[k], spin[k] * 0.7 + age[k], 0);
      dummy.scale.setScalar(out.size);
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
      mesh.setColorAt(k, out.color);
      alphas[k] = out.alpha;
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
  }

  return { mesh, spawn, update, kind, px, py, pz, live: () => live };
}

/**
 * @param rng      its own stream: when, where, and the shape of each flame
 * @param scene    where the fire, the smoke, the water and the engine are drawn
 * @param blocks   the layout (`createLayout`), for the blocks a fire can be on
 * @param traffic  the sim — `enterGuest`, `retireGuest`, `taxi`
 * @param blocked  `() => boolean` — true while a fire may not break out (the opening vignette, a
 *                 robbery); the countdown holds rather than firing the moment it lifts
 * @param soon     `?fire=soon` — first fire a few seconds in, for looking at it
 */
export function createFire({
  rng, scene, blocks, traffic, blocked = () => false, soon = false,
  rainAt = () => 0, rainSoon = () => 0,
}) {
  const taxi = traffic.taxi;

  // --- The engine ------------------------------------------------------------
  const engine = createFireTruckMesh();
  scene.add(engine.group);
  markOccluder(engine.group);
  const engineEmissive = engine.pods;

  // --- The motes -------------------------------------------------------------
  const flameCore = color('flameCore');
  const flameTip = color('flameTip');
  const smokeDark = color('smoke');
  const steamPale = color('steam');
  const waterBlue = color('hoseWater');

  // Flames: additive, rising, a tongue that grows, then thins and goes from yellow to orange.
  const flames = createPool(scene, rng, {
    max: MAX_FLAMES,
    geometry: new THREE.IcosahedronGeometry(0.5, 0),
    material: unlitMaterial({
      color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }),
    renderOrder: 6,
    drag: 0.8,
    look: (k, t, out) => {
      out.size = (0.55 + 0.75 * Math.min(1, t * 3)) * (1 - 0.65 * t * t);
      out.alpha = (t < 0.12 ? t / 0.12 : (1 - t) ** 1.3) * 0.95;
      out.color.copy(flameCore).lerp(flameTip, smoothstep(clamp01(t * 1.4)));
    },
  });
  markEmissive(flames.mesh, 'flame');

  // Smoke: lit, soft, growing as it climbs, and paler the more of it is steam (kind 1).
  const smoke = createPool(scene, rng, {
    max: MAX_SMOKE,
    geometry: new THREE.IcosahedronGeometry(0.5, 1),
    material: new THREE.MeshLambertMaterial({ transparent: true, depthWrite: false, flatShading: true }),
    renderOrder: 5,
    drag: 0.35,
    look: (k, t, out) => {
      out.size = 0.8 + 2.4 * Math.sqrt(t);
      out.alpha = (t < 0.15 ? t / 0.15 : (1 - t) ** 1.5) * (smoke.kind[k] ? 0.5 : 0.62);
      out.color.copy(smoke.kind[k] ? steamPale : smokeDark);
    },
  });

  // The jet (kind 0) and the spray it breaks into where it lands (kind 1).
  const water = createPool(scene, rng, {
    max: MAX_WATER,
    geometry: new THREE.IcosahedronGeometry(0.5, 0),
    material: unlitMaterial({ color: '#ffffff', transparent: true, depthWrite: false }),
    renderOrder: 6,
    gravity: WATER_G,
    look: (k, t, out) => {
      if (water.kind[k]) {
        out.size = 0.3 + 0.6 * t;
        out.alpha = 0.75 * (1 - t);
      } else {
        out.size = 0.2 + 0.14 * t;
        out.alpha = 0.9;
      }
      out.color.copy(waterBlue);
    },
  });

  // --- State -----------------------------------------------------------------
  const state = {
    /**
     * waiting   counting down to the next fire
     * burning   flames up; the engine is called DISPATCH in and is driving to it
     * burnout   nobody got there inside RESPONSE_MAX; dying back on its own
     * rigging   parked; the ladder is swinging round and lifting
     * spraying  water on it
     * smoulder  out; steam for a moment
     * stowing   ladder coming down
     * leaving   driving off; dissolved and retired at the map edge
     */
    phase: 'waiting',
    cooldown: soon ? SOON_WAIT : rng.range(FIRST_WAIT[0], FIRST_WAIT[1]),
    site: null,
    /** 0..1, how hard it is burning. */
    heat: 0,
    /** Seconds since it broke out. */
    t: 0,
    /** Seconds in the current phase. */
    phaseT: 0,
    truck: null,
    parked: false,
    /** 0..1, the ladder between stowed and working. */
    rig: 0,
    /** The ladder's working yaw, worked out once on parking. */
    aimYaw: 0,
    fade: 0,
    fading: 0,
    flash: 0,
    /** Tallies, for the tools. */
    fires: 0,
    arrived: 0,
    extinguished: 0,
    /** Fires the squall put out, and how hard it is raining on this one now. */
    rainedOut: 0,
    rained: 0,
    /** Jet motes that reached the building, and the furthest any landed off its facade's plane. */
    landed: 0,
    waterMiss: 0,
  };

  // Emission accumulators, so a rate survives a frame that owes less than one mote.
  const owed = { flame: 0, smoke: 0, water: 0 };
  const nozzleAt = new THREE.Vector3();

  // --- Choosing a site ---------------------------------------------------------

  /**
   * Every street a fire can face this frame. For each built block, its two camera-facing edges (+X
   * and +Z); for each, the lane nearer the block; along it, the first wall in from the kerb and how
   * tall it stands. Kept only where the flames and the engine are both in sight.
   */
  function candidates() {
    const net = cityNetwork();
    const out = [];
    for (const block of blocks) {
      // Towers only. The depot (`garage`) is the one block that must never burn — it is where the
      // taxi starts the run and goes for repairs, and an engine parked across its driveway would
      // block the opening vignette's exit — and the burger joint, the parks and the river are not
      // `built` either.
      if (block.type !== 'built') continue;
      const { bi, bj } = block;
      // +X face: the street along Z on line i = bi + 1. +Z face: along X on line j = bj + 1. Never
      // the ring road, whose corners are curves and whose far side is the edge of the island.
      if (bi + 1 < GRID_I) {
        consider(net, out, block, [DIR.PZ, bi + 1, bj + 1], [DIR.NZ, bi + 1, bj], { x: 1, z: 0 });
      }
      if (bj + 1 < GRID_J) {
        consider(net, out, block, [DIR.PX, bi + 1, bj + 1], [DIR.NX, bi, bj + 1], { x: 0, z: 1 });
      }
    }
    return out;
  }

  function consider(net, out, block, keyA, keyB, n) {
    const lanes = [net.laneByGrid(...keyA), net.laneByGrid(...keyB)].filter((l) => l && !l.degenerate);
    if (lanes.length < 2) return;
    // The lane on the block's side of the road: the one further *against* the face's normal.
    const mid = (l) => l.path.at(l.length / 2);
    const along = (p) => p.x * n.x + p.z * n.z;
    const [lane, other] = along(mid(lanes[0])) < along(mid(lanes[1])) ? lanes : [lanes[1], lanes[0]];
    if (isLaneClosed(lane.id) || isLaneClosed(other.id)) return;
    // Room for the engine between the junction behind it and the hold line ahead, with a margin.
    const lo = TRUCK_LEN / 2 + 1.5;
    const hi = lane.length - STOP_SETBACK - TRUCK_LEN / 2 - 1;
    if (hi <= lo) return;
    const key = lane === net.laneByGrid(...keyA) ? keyA : keyB;
    for (const u of [0.42, 0.55, 0.68]) {
      const s = Math.max(lo, Math.min(hi, lane.length * u));
      const p = lane.path.at(s);
      const wall = facade(p.x, p.z, n);
      if (!wall) continue;
      const fx = p.x - n.x * wall.depth;
      const fz = p.z - n.z * wall.depth;
      const fy = wall.height * AIM_UP;
      // The wall has to belong to the block this face was chosen for. The march reads the height
      // field, which knows nothing about blocks, so this is what makes the type filter above a
      // guarantee rather than a consequence of how far the march happens to reach.
      const { x0, z0, x1, z1 } = block.bounds;
      if (fx < x0 - 0.5 || fx > x1 + 0.5 || fz < z0 - 0.5 || fz > z1 + 0.5) continue;
      if (!sightlineClear(fx + n.x * 0.4, fy, fz + n.z * 0.4)) continue;
      if (!sightlineClear(p.x, 2.2, p.z)) continue;
      out.push({
        lane, laneKey: { d: key[0], i: key[1], j: key[2] }, stopS: s,
        x: fx, z: fz, y: fy, height: wall.height,
        nx: n.x, nz: n.z, ax: n.z, az: n.x,   // along the facade, perpendicular to n
        stopX: p.x, stopZ: p.z,
      });
    }
  }

  /**
   * The first wall in from (x, z) against the normal: how far it is and how tall the building
   * behind it stands. Three samples in a row have to be solid, so a lamp post or a tree on the
   * pavement does not count as a building.
   */
  function facade(x, z, n) {
    const step = 0.25;
    for (let d = 1; d <= FACADE_REACH; d += step) {
      const solid = [0, 0.5, 1].every((e) => heightAt(x - n.x * (d + e), z - n.z * (d + e)) >= SOLID);
      if (!solid) continue;
      let height = 0;
      for (let e = 0; e <= 3; e += 0.5) height = Math.max(height, heightAt(x - n.x * (d + e), z - n.z * (d + e)));
      return height >= MIN_HEIGHT ? { depth: d, height } : null;
    }
    return null;
  }

  /** The candidate to burn: in range of the taxi, nearest the ideal distance, a little shuffled. */
  function chooseSite() {
    const all = candidates().map((c) => ({ c, d: Math.hypot(c.x - taxi.x, c.z - taxi.z) }));
    let pool = all.filter((e) => e.d >= SITE_NEAR && e.d <= SITE_FAR
      && rainSoon(e.c.x, e.c.z, RAIN_LEAD) <= RAIN_CLEAR);
    if (!pool.length) return null;
    pool = pool.sort((a, b) => Math.abs(a.d - SITE_IDEAL) - Math.abs(b.d - SITE_IDEAL)).slice(0, 4);
    return rng.pick(pool).c;
  }

  // --- Life of one fire -------------------------------------------------------

  function setPhase(phase) {
    state.phase = phase;
    state.phaseT = 0;
  }

  /**
   * Start a fire, here and now, if anywhere qualifies. Public so the tools can stage one rather than
   * wait a minute and a half for it. Answers whether one started.
   */
  function ignite() {
    const site = chooseSite();
    if (!site) return false;
    state.site = site;
    state.heat = 0;
    state.t = 0;
    state.truck = null;
    state.dispatched = false;
    state.dispatchRetry = 0;
    state.parked = false;
    state.doused = false;
    state.rained = 0;
    state.rig = 0;
    state.fires += 1;
    setPhase('burning');
    return true;
  }

  /**
   * Every lane within `legs` turns upstream of `goal`, by walking the network backwards. A lane
   * reached at depth k has a route of k legs onto the goal; the goal itself is excluded, since an
   * engine spawned on it is as likely to be past the stop as short of it.
   */
  function upstream(goal, legs) {
    const net = cityNetwork();
    const back = new Map();
    for (const lane of net.lanes) {
      for (const next of lane.onward ?? []) {
        if (!next) continue;
        if (!back.has(next.id)) back.set(next.id, []);
        back.get(next.id).push(lane);
      }
    }
    const seen = new Set([goal.id]);
    let frontier = [goal];
    for (let k = 0; k < legs; k++) {
      const nextFrontier = [];
      for (const lane of frontier) {
        for (const prev of back.get(lane.id) ?? []) {
          if (seen.has(prev.id)) continue;
          seen.add(prev.id);
          nextFrontier.push(prev);
        }
      }
      frontier = nextFrontier;
    }
    seen.delete(goal.id);
    return seen;
  }

  /** Bring the engine on, and point it at the fire. Answers whether it arrived. */
  function dispatch() {
    const site = state.site;
    const near = { x: site.stopX, z: site.stopZ };
    let truck = null;
    for (const legs of UPSTREAM_LEGS) {
      const ids = upstream(site.lane, legs);
      truck = traffic.enterGuest(near, { accept: (lane) => ids.has(lane.id) });
      if (truck) break;
    }
    // Nothing upstream would take it — fall back to anywhere near, and let the router lap it round.
    truck ??= traffic.enterGuest(near);
    if (!truck) return false;
    truck.skin = skin;
    truck.guestWreck = wreck;
    truck.route = [];
    truck.chase = RESPONSE_CHASE;
    state.truck = truck;
    engine.group.position.set(truck.x, 0, truck.z);
    engine.shell.visible = true;
    state.fade = 0;
    state.fading = 1;
    return true;
  }

  /** Re-plan to the stop lane — only when it has run out of route, never per frame (CLAUDE.md). */
  function steerToFire(truck) {
    const site = state.site;
    if (truck.route?.length) return;
    if (truck.lane === site.lane && truck.state === 'drive' && truck.s < site.stopS + 0.5) return;
    const route = findRouteOnto(planOrigin(truck), { i: site.laneKey.i, j: site.laneKey.j }, site.laneKey.d);
    if (route?.length) { truck.route = route; truck.routeConsumed = false; }
  }

  /** On the stop lane and within braking distance of the spot: put the pedal down and hold it. */
  function tryStop(truck) {
    const site = state.site;
    if (truck.lane !== site.lane || truck.state !== 'drive') return false;
    if (truck.s + stopDistance(truck.v) < site.stopS) return false;
    if (truck.s > site.stopS + 0.5) return false;   // overshot — steerToFire laps it round
    truck.roadblock = Infinity;
    return true;
  }

  function park() {
    const site = state.site;
    state.parked = true;
    state.truck.chase = 0;
    state.arrived += 1;
    setClosedLanes([site.lane.id], 'fire');
    setHazardLanes([site.lane.id]);
    // The ladder's yaw, in the engine's own frame: from the turntable to the fire. Off the heading
    // alone, not the drawn pose — the body is still rocking forward off the brakes on the frame it
    // stops, and solving through that pitch put the jet 6° off the fire for the whole spray.
    const truck = state.truck;
    const fx = Math.cos(truck.yaw);
    const fz = -Math.sin(truck.yaw);
    const px = truck.x + fx * engine.ladderYaw.position.x;
    const pz = truck.z + fz * engine.ladderYaw.position.x;
    const along = (site.x - px) * fx + (site.z - pz) * fz;
    const across = (site.x - px) * Math.sin(truck.yaw) + (site.z - pz) * Math.cos(truck.yaw);
    state.aimYaw = Math.atan2(-across, along);
    setPhase('rigging');
  }

  function release() {
    setClosedLanes([], 'fire');
    setHazardLanes([]);
  }

  function leave() {
    const truck = state.truck;
    release();
    setPhase('leaving');
    if (!truck) return;
    truck.roadblock = 0;
    truck.braking = false;
    truck.chase = 0;
    truck.route = [];
    const exit = { i: taxi.i > GRID_I / 2 ? 0 : GRID_I, j: taxi.j > GRID_J / 2 ? 0 : GRID_J };
    state.exit = exit;
    const route = findRoute(planOrigin(truck), exit);
    if (route?.length) { truck.route = route; truck.routeConsumed = false; }
  }

  function retire() {
    if (state.truck) traffic.retireGuest(state.truck);
    state.truck = null;
    engine.shell.visible = false;
    for (const pod of engine.pods) pod.visible = false;
    release();
    state.site = null;
    setPhase('waiting');
    state.cooldown = rng.range(REPEAT_WAIT[0], REPEAT_WAIT[1]);
  }

  // --- Drawing the engine ------------------------------------------------------

  function skin(pos, quat, car) {
    engine.group.position.copy(pos);
    engine.group.quaternion.copy(quat);
    for (const wheel of engine.wheels) wheel.rotation.y = car.wheelAngle;
  }

  /** The engine's body for the wreck effects, if the taxi ever writes it off. */
  function wreck() {
    engine.group.updateMatrixWorld(true);
    const shell = engine.shell.clone(true);
    shell.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.alphaHash = false;
        o.material.opacity = 1;
      }
    });
    for (const pod of shell.children.filter((o) => engine.pods.some((p) => p.geometry === o.geometry))) {
      pod.visible = false;
    }
    shell.visible = true;
    engine.group.matrixWorld.decompose(shell.position, shell.quaternion, shell.scale);
    engine.shell.visible = false;
    return shell;
  }

  // --- Emitters ----------------------------------------------------------------

  function emitFlames(dt) {
    const site = state.site;
    owed.flame += dt * 95 * state.heat;
    while (owed.flame >= 1) {
      owed.flame -= 1;
      const a = rng.range(-FIRE_W / 2, FIRE_W / 2);
      const roof = rng.chance(0.4);
      // Out of the top floors' windows, or off the roof just behind the parapet.
      const y = roof ? site.height + 0.1 : rng.range(site.height * 0.5, site.height);
      const out = roof ? -rng.range(0.2, 1.8) : rng.range(0.1, 0.45);
      flames.spawn(
        site.x + site.ax * a + site.nx * out,
        y,
        site.z + site.az * a + site.nz * out,
        site.nx * rng.range(0.2, 0.7) + rng.jitter(0.3),
        rng.range(2.2, 3.8) * (0.6 + 0.4 * state.heat),
        site.nz * rng.range(0.2, 0.7) + rng.jitter(0.3),
        rng.range(0.5, 0.95),
      );
    }
  }

  function emitSmoke(dt, steam) {
    const site = state.site;
    owed.smoke += dt * (9 * state.heat + 7 * steam);
    while (owed.smoke >= 1) {
      owed.smoke -= 1;
      const a = rng.range(-FIRE_W / 2, FIRE_W / 2);
      const isSteam = rng.range(0, 1) < steam / (steam + state.heat + 1e-6);
      // Drifting away from the camera (−X−Z), so the column leans off the building rather than
      // across the street the player is watching.
      smoke.spawn(
        site.x + site.ax * a - site.nx * rng.range(0, 1.2),
        site.height + rng.range(0.2, 0.8),
        site.z + site.az * a - site.nz * rng.range(0, 1.2),
        -0.5 + rng.jitter(0.3), rng.range(1.5, 2.4), -0.4 + rng.jitter(0.3),
        rng.range(2.4, 3.4), isSteam ? 1 : 0,
      );
    }
  }

  function emitWater(dt) {
    const site = state.site;
    engine.nozzle.getWorldPosition(nozzleAt);
    const tx = site.x + site.nx * 0.2;
    const ty = site.y;
    const tz = site.z + site.nz * 0.2;
    const dist = Math.hypot(tx - nozzleAt.x, tz - nozzleAt.z);
    const flight = Math.max(0.35, Math.min(1.0, dist / 11));
    owed.water += dt * WATER_RATE;
    while (owed.water >= 1) {
      owed.water -= 1;
      // Ballistic: the velocity that lands on the target in `flight` seconds under WATER_G, played
      // across the facade a little so the jet works the fire rather than drilling one point.
      const sweep = Math.sin(state.phaseT * 1.3) * FIRE_W * 0.3;
      const ax = tx + site.ax * sweep + rng.jitter(0.25);
      const ay = ty + rng.jitter(0.3);
      const az = tz + site.az * sweep + rng.jitter(0.25);
      const t = flight * rng.range(0.95, 1.05);
      water.spawn(
        nozzleAt.x, nozzleAt.y, nozzleAt.z,
        (ax - nozzleAt.x) / t, (ay - nozzleAt.y) / t + 0.5 * WATER_G * t, (az - nozzleAt.z) / t,
        t, 0,
      );
    }
  }

  // A jet mote reaching the wall breaks into spray, thrown back off the facade.
  const splashes = [];
  const onWaterExpired = (k) => {
    if (water.kind[k] !== 0) return;
    const site = state.site;
    if (site) {
      state.landed += 1;
      const off = Math.abs((water.px[k] - site.x) * site.nx + (water.pz[k] - site.z) * site.nz);
      state.waterMiss = Math.max(state.waterMiss, off);
    }
    if (splashes.length < 64) splashes.push(water.px[k], water.py[k], water.pz[k]);
  };

  // --- Frame ---------------------------------------------------------------------

  function update(dt) {
    state.flash += dt;
    state.phaseT += dt;

    if (state.phase === 'waiting') {
      if (!blocked()) {
        state.cooldown -= dt;
        if (state.cooldown <= 0 && !ignite()) state.cooldown = RETRY_WAIT;
      }
    } else {
      state.t += dt;
      const truck = state.truck;
      // The taxi wrote it off — the run is ending. Leave the scene as it stands.
      if (truck?.crashed) state.truck = null;

      // Rain on the fire wins whatever phase it is in, and the engine goes home from wherever it
      // got to. Not while spraying: the jet is already winning, and the crew gets the credit.
      state.rained = state.site && state.heat > 0 ? rainAt(state.site.x, state.site.z) : 0;
      const douse = state.rained > RAIN_CLEAR && state.phase !== 'spraying';
      if (douse) state.heat = Math.max(0, state.heat - dt * state.rained / RAIN_DOUSE);

      if (douse && state.heat <= 0) {
        state.rainedOut += 1;
        state.doused = true;
        setPhase('smoulder');
      } else if (state.phase === 'burning') {
        if (!douse) state.heat = Math.min(1, state.heat + dt / IGNITE);
        if (!state.dispatched && state.t >= DISPATCH) {
          state.dispatchRetry -= dt;
          if (state.dispatchRetry <= 0) {
            if (dispatch()) state.dispatched = true;
            else state.dispatchRetry = 1;
          }
        }
        if (state.truck) {
          if (state.truck.roadblock > 0) {
            if (state.truck.v < 0.05) park();
          } else if (!tryStop(state.truck)) {
            steerToFire(state.truck);
          }
        }
        // Nobody got here — a saturated network, an engine wedged in a jam. It burns itself out
        // rather than burning for the rest of the run, and the engine is sent home from wherever it is.
        if (state.t >= RESPONSE_MAX && state.phase === 'burning') setPhase('burnout');
      } else if (state.phase === 'burnout') {
        state.heat = Math.max(0, state.heat - dt / BURN_OUT);
        if (state.heat <= 0) setPhase('smoulder');
      } else if (state.phase === 'rigging') {
        state.rig = Math.min(1, state.rig + dt / RIG);
        if (state.rig >= 1) setPhase('spraying');
      } else if (state.phase === 'spraying') {
        emitWater(dt);
        // The first of the jet takes its flight time to land; after that it is winning.
        if (state.phaseT > 0.6) state.heat = Math.max(0, state.heat - dt / EXTINGUISH);
        if (state.heat <= 0) {
          state.extinguished += 1;
          state.doused = true;
          setPhase('smoulder');
        }
      } else if (state.phase === 'smoulder') {
        if (state.phaseT >= SMOULDER) {
          if (state.truck && state.parked) setPhase('stowing');
          else leave();
        }
      } else if (state.phase === 'stowing') {
        state.rig = Math.max(0, state.rig - dt / RIG);
        if (state.rig <= 0) leave();
      } else if (state.phase === 'leaving') {
        if (!truck) { if (!flames.live() && !smoke.live()) retire(); }
        else {
          const ex = state.exit;
          const near = ex && Math.hypot(truck.x - lineX(ex.i), truck.z - lineZ(ex.j)) < EXIT_REACH;
          const away = Math.hypot(truck.x - taxi.x, truck.z - taxi.z) > SPAWN_CLEARANCE;
          if (state.fading >= 0 && (near || state.phaseT > LEAVE_MAX || (away && state.phaseT > 6))) {
            state.fading = -1;
          }
          if (!truck.route?.length && state.fading >= 0 && ex) {
            const route = findRoute(planOrigin(truck), ex);
            if (route?.length) { truck.route = route; truck.routeConsumed = false; }
          }
          if (state.fading < 0 && state.fade <= 0) retire();
        }
      }
      // Flames, smoke and steam. Steam is the water winning: it comes while the jet is on and a
      // little after, and fades out through the smoulder.
      const steam = state.phase === 'spraying' ? 1
        : state.rained > RAIN_CLEAR ? Math.min(1, state.rained * 1.5)
        : state.phase === 'smoulder' && state.doused ? Math.max(0, 1 - state.phaseT / SMOULDER) : 0;
      if (state.site && state.heat > 0) emitFlames(dt);
      if (state.site && (state.heat > 0 || steam > 0)) emitSmoke(dt, steam);
    }

    // The motes outlive the fire by a second or two, so they step in every phase.
    flames.update(dt);
    smoke.update(dt);
    splashes.length = 0;
    water.update(dt, onWaterExpired);
    for (let k = 0; k < splashes.length && state.site; k += 3) {
      const site = state.site;
      for (let m = 0; m < 2; m++) {
        water.spawn(splashes[k], splashes[k + 1], splashes[k + 2],
          site.nx * rng.range(0.5, 2) + rng.jitter(1.2), rng.range(0, 2), site.nz * rng.range(0.5, 2) + rng.jitter(1.2),
          rng.range(0.3, 0.55), 1);
      }
    }

    // The engine: dissolve, ladder, bar.
    if (state.fading) {
      state.fade = clamp01(state.fade + state.fading * dt / FADE_TIME);
      if (state.fade === 1 && state.fading > 0) state.fading = 0;
    }
    for (const material of engine.faders) material.opacity = state.fade;
    const r = smoothstep(state.rig);
    engine.ladderYaw.rotation.y = state.aimYaw * r;
    engine.ladderPitch.rotation.z = LADDER_PITCH * r;
    const lit = Boolean(state.truck) && state.phase !== 'leaving' && state.fade > 0.5;
    const on = sirenOn(state.flash);
    engine.pods[0].visible = lit && on;
    engine.pods[1].visible = lit && !on;
  }

  return {
    state,
    update,
    ignite,
    /** Every site a fire could break out on right now — for the probe. */
    candidates: () => candidates(),
    /** The engine's lamps, for main.js to put in the bloom. */
    emissiveMeshes: engineEmissive,
    engine,
    flames, smoke, water,
    /** Is anything on: a fire burning, or the engine still about? */
    active: () => state.phase !== 'waiting',
  };
}
