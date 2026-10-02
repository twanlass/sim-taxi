import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';
import { markEmissive } from './bloom.js';
import { BILLBOARD } from './camera.js';
import {
  DIR, GRID_I, GRID_J, halfRoadX, halfRoadZ, isRiverGap, isSegmentClosed, lineX, lineZ,
} from '../city/grid.js';

// Boost orbs: glowing yellow balls hovering over the road that pour a slice of Loco Mode fuel into
// the tank when the taxi drives through one. A prototype — see docs/gameplay.md#boost-orbs.
//
// **Fixed spots, not random ones.** The point is something to *route* for, Mario Kart item-box
// style: a player who has seen the orb on the bridge approach can bend a trip through it on purpose.
// A random spawn is only ever found by accident, and one pinned beside the next rider is a free
// bonus rather than a decision. So the slots are chosen once per city, off the *city* seed, and an
// orb that has been taken comes back to the same slot after `ORB_RESPAWN` seconds.
//
// **On the centreline, taken from either lane.** A segment is a two-way road and a router hands the
// taxi whichever direction it likes, so an orb that only paid out to one lane would be missed by
// half the routes through it with nothing on screen to say why. The catch is the whole width of the
// road (`halfRoadX/Z` — an arterial is a third wider) by `ORB_CATCH_ALONG` either side of the
// midpoint, and the orb is pulled *into* the car on the way out so a pass beside it still reads as
// collecting it rather than as the orb vanishing.

/** How many slots a city gets. A couple, per the brief — enough to be a choice, few enough to learn. */
export const ORB_SLOTS = 3;
/** Seconds before a taken orb reappears in its slot. Long enough that circling one is not a strategy. */
export const ORB_RESPAWN = 25;
/** Fraction of a full tank one orb pours in. The parcel's sixth: the smallest pour that reads as filling. */
export const ORB_REWARD = 1 / 6;
/** Half the along-road extent of the catch box, in world units, either side of the segment midpoint. */
export const ORB_CATCH_ALONG = 2.4;

// About half the size of the car, as asked: the drawn taxi is ~4 units long (TAXI_SCALE on
// CAR_LEN), and a 1.8-unit ball beside it reads as half. Floated clear of the roof line so it
// is never hidden behind the taxi it is being collected by.
const RADIUS = 0.9;
const HOVER = 1.6;
const BOB = 0.22;          // world units either side of HOVER
const BOB_HZ = 0.55;
const PULSE_HZ = 1.3;
const COLLECT_TIME = 0.22; // seconds the pull into the car takes
const APPEAR_TIME = 0.45;
// The tap's answer: a swell for a route taken through the orb, a shiver for one refused — the same
// two replies a package's corner gives (`acknowledge` in game/parcels.js).
const ACK_TIME = 0.35;

// The tap target: a square in the screen plane over the orb (see the long note on BILLBOARD in
// geometry/marker.js for why never a box). 6 screen units is ~46px at play zoom, a fingertip with
// margin, and well under the 14.1 that separates two junctions' targets — an orb is mid-segment,
// half that from either end, so a rider's 11-wide target can still meet it at the edge. The nearer
// hit wins there, same as between any two markers.
const HIT_SIZE = 6;
const hitGeo = new THREE.PlaneGeometry(HIT_SIZE, HIT_SIZE);

/**
 * Every open road segment that could hold an orb: interior roads only (the ring road is where the
 * city fades to sky, and an orb out there is off to the side of every trip), no river crossing (the
 * drawbridge lifts, and an orb over open water is unreachable for as long as it is up), and nothing
 * a roadworks closure has shut.
 */
function candidateSegments() {
  const out = [];
  for (let j = 1; j < GRID_J; j++) {
    for (let i = 0; i < GRID_I; i++) {
      if (isSegmentClosed(i, j, DIR.PX)) continue;
      out.push({
        axis: 'x', x: (lineX(i) + lineX(i + 1)) / 2, z: lineZ(j), half: halfRoadX(j),
        ends: [{ i: i + 1, j, d: DIR.PX }, { i, j, d: DIR.NX }],
      });
    }
  }
  for (let i = 1; i < GRID_I; i++) {
    for (let j = 0; j < GRID_J; j++) {
      if (isRiverGap(j) || isSegmentClosed(i, j, DIR.PZ)) continue;
      out.push({
        axis: 'z', x: lineX(i), z: (lineZ(j) + lineZ(j + 1)) / 2, half: halfRoadZ(i),
        ends: [{ i, j: j + 1, d: DIR.PZ }, { i, j, d: DIR.NZ }],
      });
    }
  }
  return out;
}

/**
 * Pick `count` slots spread across the map: the first at random, each after it the candidate
 * furthest from every slot already taken. Spread rather than scattered, so the orbs pull the taxi
 * to different parts of the city instead of clustering where a lucky draw put them.
 */
export function chooseOrbSlots(rng, count = ORB_SLOTS) {
  const pool = candidateSegments();
  if (!pool.length) return [];
  const slots = [pool.splice(rng.int(0, pool.length - 1), 1)[0]];
  while (slots.length < count && pool.length) {
    let best = 0;
    let bestD = -1;
    for (let k = 0; k < pool.length; k++) {
      const d = Math.min(...slots.map((s) => Math.hypot(s.x - pool[k].x, s.z - pool[k].z)));
      if (d > bestD) { bestD = d; best = k; }
    }
    slots.push(pool.splice(best, 1)[0]);
  }
  return slots;
}

/** Does a car at (x, z) sit inside this slot's catch box? */
export function inCatch(slot, x, z) {
  const along = slot.axis === 'x' ? Math.abs(x - slot.x) : Math.abs(z - slot.z);
  const across = slot.axis === 'x' ? Math.abs(z - slot.z) : Math.abs(x - slot.x);
  return along <= ORB_CATCH_ALONG && across <= slot.half;
}

// Shared across every orb: the geometry never changes and the materials are one colour each.
const coreGeo = new THREE.IcosahedronGeometry(RADIUS, 2);
const haloGeo = new THREE.IcosahedronGeometry(RADIUS * 1.45, 2);

function buildOrb() {
  const group = new THREE.Group();
  group.name = 'boost-orb';
  const core = new THREE.Mesh(coreGeo, unlitMaterial({ color: PALETTE.boostOrb, transparent: true }));
  core.castShadow = true;
  const halo = new THREE.Mesh(haloGeo, unlitMaterial({
    color: PALETTE.boostOrbHalo,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  group.add(core, halo);
  markEmissive(group, 'orb');
  // After the bloom marks the group, so the invisible target is not handed a lamp of its own.
  // DoubleSide for the reason marker.js gives: a quad facing the camera exactly is one rounding
  // away from being culled out of the raycast.
  const hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
  hit.quaternion.copy(BILLBOARD);
  hit.userData.pickable = 'orb';
  group.add(hit);
  return { group, core, halo };
}

/**
 * @param rng    a city-seeded stream — the slots are a fact about the map, not the run
 * @param scene  where the orbs are drawn
 */
export function createBoostOrbs(rng, scene, { count = ORB_SLOTS } = {}) {
  const slots = chooseOrbSlots(rng, count);
  // Each orb carries its own phase so a pair in frame together do not bob in lockstep.
  const orbs = slots.map((slot, k) => {
    const mesh = buildOrb();
    mesh.group.position.set(slot.x, HOVER, slot.z);
    scene.add(mesh.group);
    return {
      slot, mesh,
      phase: k * 2.1,
      state: 'live',       // 'live' | 'collecting' | 'gone'
      t: APPEAR_TIME,      // seconds since the current state began
      from: new THREE.Vector3(),
      ack: null,           // { taken, t } while a tap's answer is playing
    };
  });
  let clock = 0;

  function pose(orb, taxi) {
    const { group, core, halo } = orb.mesh;
    const bob = Math.sin((clock * BOB_HZ + orb.phase) * Math.PI * 2) * BOB;
    const pulse = 0.5 + 0.5 * Math.sin((clock * PULSE_HZ + orb.phase) * Math.PI * 2);
    if (orb.state === 'gone') { group.visible = false; return; }
    group.visible = true;
    if (orb.state === 'collecting') {
      // Pulled into the car and shrunk to nothing, chasing where the taxi is *now* rather than
      // where it was when it touched — at 34 u/s the car covers 7 units in the pull.
      const u = Math.min(1, orb.t / COLLECT_TIME);
      const e = u * u;
      group.position.set(
        orb.from.x + (taxi.x - orb.from.x) * e,
        orb.from.y + (1.0 - orb.from.y) * e,
        orb.from.z + (taxi.z - orb.from.z) * e,
      );
      group.scale.setScalar(1 + 0.35 * Math.sin(u * Math.PI) - u * 0.9);
      core.material.opacity = 1 - u * 0.6;
      halo.material.opacity = 0.3 * (1 - u);
      return;
    }
    // Live: bob, breathe, and grow in if it has just come back.
    const grow = Math.min(1, orb.t / APPEAR_TIME);
    const pop = grow < 1 ? 1 - (1 - grow) ** 3 : 1;
    let kick = 1;
    let shiver = 0;
    if (orb.ack) {
      const u = orb.ack.t / ACK_TIME;
      if (u >= 1) orb.ack = null;
      else if (orb.ack.taken) kick = 1 + 0.45 * Math.sin(u * Math.PI);
      else shiver = Math.sin(u * Math.PI * 6) * (1 - u) * 0.35;
    }
    group.position.set(orb.slot.x + shiver, HOVER + bob, orb.slot.z - shiver);
    group.scale.setScalar(pop * kick);
    core.material.opacity = 1;
    halo.scale.setScalar(1 + 0.12 * pulse);
    halo.material.opacity = 0.22 + 0.16 * pulse;
  }

  return {
    orbs,
    slots,

    /**
     * Advance the orbs and test the taxi against every live one. Returns the orbs collected on
     * this frame (usually none) so the caller can pay out — this module stays out of the economy,
     * the same division game/parcels.js keeps.
     *
     * `enabled` false holds pickups (a vignette, a finished run) while the orbs keep bobbing.
     */
    update(dt, taxi, { enabled = true } = {}) {
      clock += dt;
      const taken = [];
      for (const orb of orbs) {
        orb.t += dt;
        if (orb.ack) orb.ack.t += dt;
        if (orb.state === 'live' && enabled && taxi && !taxi.crashed
          && inCatch(orb.slot, taxi.x, taxi.z)) {
          orb.state = 'collecting';
          orb.t = 0;
          orb.from.copy(orb.mesh.group.position);
          taken.push(orb);
        } else if (orb.state === 'collecting' && orb.t >= COLLECT_TIME) {
          orb.state = 'gone';
          orb.t = 0;
        } else if (orb.state === 'gone' && orb.t >= ORB_RESPAWN) {
          orb.state = 'live';
          orb.t = 0;
        }
        pose(orb, taxi ?? orb.slot);
      }
      return taken;
    },

    /** The tap targets of every orb that can still be collected. A taken one answers nothing. */
    pickables() {
      return orbs.filter((o) => o.state === 'live').map((o) => o.mesh.group);
    },

    /** The orb a picked mesh belongs to, or null. */
    orbFor(object) {
      for (let node = object; node; node = node.parent) {
        const orb = orbs.find((o) => o.mesh.group === node);
        if (orb) return orb;
      }
      return null;
    },

    /** Answer a tap: swell if the taxi is now routed through it, shiver if the router refused. */
    acknowledge(orb, taken) {
      orb.ack = { taken, t: 0 };
    },

    /** Land every orb in its finished pose — shot mode ticks the world once. */
    settle() {
      for (const orb of orbs) {
        if (orb.state === 'live') orb.t = APPEAR_TIME;
        pose(orb, orb.slot);
      }
    },
  };
}
