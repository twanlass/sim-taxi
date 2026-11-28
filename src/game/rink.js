import * as THREE from 'three';
import { hash01 } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { createPerson } from '../geometry/person.js';
import { POND_WATER_Y, rinkSurface } from '../city/pond.js';

// The skaters on the frozen pond (city/pond.js, the holidays only): a handful of people going round
// the rink the way people go round a rink — all one way, each on a lane of their own a little in
// from the boards, at their own pace, leaning into the ends.
//
// Scenery on the ducks' and the hoopers' terms: nothing collides with them, nothing in the fare loop
// knows about them, and a run seed rather than the city's, because who is out skating is the
// situation and not the map. Each lane is the rink's own rounded rectangle pulled in, so a skater
// never meets the boards; lanes are spaced so two skaters can share a straight side by side, and
// one passing another on the same lane is a rink with people on it.
//
// Each figure is the ordinary person (`createPerson`), posed by `iceSkate`; a few are drawn at
// three-quarter size, the children out with their parents.

/** How many, from the rink's own size: one per this many square units of ice, within the range. */
const AREA_PER = 12;
// 8 first: people are drawn at the game's 3-unit scale, and eight on a 15-unit rink was a crowd.
const COUNT = [4, 6];
/** Skating speed range in world units a second, and strokes per unit travelled. */
const SPEED = [1.5, 2.6];
const STRIDE = 1.15;
/** The lanes: in from the boards by at least this, and lanes at least this far apart. */
const LANE_IN = 0.75;
// 0.55 first, and side by side on two such lanes is two bodies a unit wide sharing a shoulder.
const LANE_GAP = 1.1;
/** The tightest corner a lane turns, whatever the rink's own radius pulled in comes to. */
const MIN_TURN = 0.9;
/** Lean per unit of lateral acceleration, and its cap. */
const LEAN_GAIN = 0.07;
const LEAN_MAX = 0.4;
/** Room kept behind the skater ahead on the same lane: closer than this and they ease to its pace. */
const FOLLOW = 2.2;
/** The share of skaters who are children. */
const KIDS = 0.3;
const KID_SCALE = 0.72;

const COATS = ['skaterCoatA', 'skaterCoatB', 'skaterCoatC', 'skaterCoatD', 'skaterCoatE'];
const HAIR = ['#2E2520', '#6B4A33', '#B8863B', '#1C1A1A', '#8C5A3C'];

/**
 * A point on a rounded rectangle about the origin, at arclength `s` round it from the middle of
 * the +x side, travelling toward +z: `{ x, z, dx, dz, k }`, `k` being the curvature (0 on a straight).
 */
export function lanePoint(lane, s) {
  const { hx, hz, r } = lane;
  const sx = 2 * (hz - r);       // the straight along the x sides (runs in z)
  const sz = 2 * (hx - r);       // the straight along the z sides (runs in x)
  const arc = (Math.PI / 2) * r;
  const legs = [sx / 2, arc, sz, arc, sx, arc, sz, arc, sx / 2];
  const P = 2 * sx + 2 * sz + 4 * arc;
  let u = ((s % P) + P) % P;
  // Corner centres, in the order the arcs are met.
  const centres = [[hx - r, hz - r], [-(hx - r), hz - r], [-(hx - r), -(hz - r)], [hx - r, -(hz - r)]];
  let leg = 0;
  while (leg < legs.length - 1 && u > legs[leg]) { u -= legs[leg]; leg += 1; }
  switch (leg) {
    case 0: return { x: hx, z: u, dx: 0, dz: 1, k: 0 };
    case 2: return { x: hx - r - u, z: hz, dx: -1, dz: 0, k: 0 };
    case 4: return { x: -hx, z: hz - r - u, dx: 0, dz: -1, k: 0 };
    case 6: return { x: -(hx - r) + u, z: -hz, dx: 1, dz: 0, k: 0 };
    case 8: return { x: hx, z: -(hz - r) + u, dx: 0, dz: 1, k: 0 };
    default: {
      const c = centres[(leg - 1) / 2];
      const a = ((leg - 1) / 2) * (Math.PI / 2) + u / r;
      return { x: c[0] + Math.cos(a) * r, z: c[1] + Math.sin(a) * r, dx: -Math.sin(a), dz: Math.cos(a), k: 1 / r };
    }
  }
}

/** A lane's length all the way round. */
export function laneLength(lane) {
  return 4 * (lane.hx - lane.r) + 4 * (lane.hz - lane.r) + 2 * Math.PI * lane.r;
}

/**
 * @param pond  the pond from city/pond.js, frozen — or null, or not the rink shape, in which case
 *              this is a quiet no-op the way the ducks are on a city with no pond.
 */
export function createRink(scene, rng, pond) {
  const group = new THREE.Group();
  group.name = 'rink-skaters';
  if (!pond || pond.shape !== 'rink') return { group, skaters: [], entryObjects: [], update: () => {} };
  scene.add(group);

  const ice = rinkSurface(pond);
  const area = 4 * ice.hx * ice.hz;
  const count = Math.max(COUNT[0], Math.min(COUNT[1], Math.round(area / AREA_PER)));
  const deepest = Math.min(ice.hx, ice.hz) - MIN_TURN - 0.1;
  const lanes = [];
  for (let d = LANE_IN; d <= deepest; d += LANE_GAP) {
    const hx = ice.hx - d;
    const hz = ice.hz - d;
    lanes.push({ hx, hz, r: Math.min(Math.max(ice.rc - d, MIN_TURN), hx, hz) });
  }
  if (!lanes.length) return { group, skaters: [], entryObjects: [], update: () => {} };

  const skaters = [];
  for (let i = 0; i < count; i++) {
    const kid = rng.chance(KIDS);
    const person = createPerson({
      body: PALETTE[COATS[i % COATS.length]], legs: PALETTE.skaterTrousers, hair: rng.pick(HAIR), pickable: null,
    });
    const holder = new THREE.Group();
    holder.add(person.group);
    if (kid) holder.scale.setScalar(KID_SCALE);
    group.add(holder);
    // Dealt round the lanes and spread evenly round each, so nobody starts on top of anybody.
    const lane = lanes[i % lanes.length];
    const onLane = Math.ceil((count - (i % lanes.length)) / lanes.length);
    const slot = Math.floor(i / lanes.length);
    const speed = rng.range(SPEED[0], SPEED[1]) * (kid ? 0.8 : 1);
    skaters.push({
      person, holder, lane,
      s: laneLength(lane) * ((slot + rng.range(0.1, 0.4)) / Math.max(1, onLane)),
      speed, pace: speed,
      phase: rng.range(0, Math.PI * 2),
      lean: 0,
    });
  }

  function update(dt) {
    for (const sk of skaters) {
      // Catching someone on the same lane: ease to their pace rather than skate through them, and
      // back up to your own once they pull away.
      const L = laneLength(sk.lane);
      let ahead = null;
      let gap = Infinity;
      for (const other of skaters) {
        if (other === sk || other.lane !== sk.lane) continue;
        const d = (((other.s - sk.s) % L) + L) % L;
        if (d < gap) { gap = d; ahead = other; }
      }
      const want = ahead && gap < FOLLOW ? Math.min(sk.pace, ahead.speed * (gap / FOLLOW)) : sk.pace;
      sk.speed += (want - sk.speed) * Math.min(1, dt * 2);
      sk.s += sk.speed * dt;
      sk.phase += sk.speed * dt * STRIDE * Math.PI;
      const p = lanePoint(sk.lane, sk.s);
      // Into the turn: the lateral acceleration v²k, eased so the lean comes on through the entry
      // to a corner rather than snapping at the tangent point.
      const tilt = Math.min(LEAN_MAX, LEAN_GAIN * sk.speed * sk.speed * p.k * 4);
      sk.lean += (tilt - sk.lean) * Math.min(1, dt * 4);
      sk.holder.position.set(pond.x + p.x, POND_WATER_Y, pond.z + p.z);
      sk.holder.rotation.y = Math.atan2(p.dx, p.dz);
      // Every lane runs anticlockwise in plan from above (toward +z on the +x side), so the inside
      // of every turn is the skater's left: lean is a roll toward −X in the figure's frame.
      sk.person.iceSkate(sk.phase, -sk.lean);
    }
  }
  update(0);

  const entryObjects = skaters.map((sk) => ({
    object: sk.holder, x: pond.x, z: pond.z, rand: hash01(pond.x, pond.z),
  }));

  return { group, skaters, entryObjects, pond, update };
}
