import * as THREE from 'three';
import { cityNetwork } from '../city/roadnet.js';
import { KERB_H } from '../city/ground.js';
import { hash01, propMaterial } from '../util/geo.js';
import { sightlineClear } from './sightline.js';
import {
  mailboxGeometry, hotDogCartGeometry, letterGeometry, hotDogGeometry, MAILBOX_HALF, CART_HALF,
} from '../geometry/streetprops.js';

// Street furniture the taxi can take out: a blue post box and a hot dog cart under a striped
// umbrella, standing on the kerb near a corner (Tyler, 2026-10-23: "a blue post mailbox ... if the
// taxi hits either of these things, dust, and shoot mail everywhere or hot dogs everywhere").
//
// **The taxi has to be steered into them, because it never gets there on its own.** Its lane
// centre is LANE_TO_KERB (2.25) off the kerb and its drawn half-width is 1.0, so there is 1.25 of
// road between the taxi's flank and the kerb on every street, at every speed, and a prop standing
// on the pavement can never be touched by anything the traffic model does. A hit radius that
// reached across that gap would explode a post box the car visibly missed. So under Loco Mode the
// taxi *swipes*: on the lane that passes a prop, it veers onto the kerb at the prop and back off
// it, the way the weave already says "maniac" — `swipeOffset` in sim/traffic.js, render-only like
// the weave and the overtake, so the simulation's lane bookkeeping never knows. Off Loco Mode it
// drives past like a citizen.
//
// **Where.** The cart on a park's walk, the post boxes on built blocks. Only on the +X face, on
// the lane running +Z past it, `SWIPE_S` along that lane. Both halves of that are forced. The camera sits off +X+Z, so a prop on a block's
// −X or −Z side has the block's own building between it and the viewer. And of the two seen faces,
// only on the +X one is the lane's *start* at the corner the rider pins don't use — on the +Z face
// the passing lane runs −X and starts at the block's +X+Z corner, which is exactly where
// `cornerFor` (game/fares.js) stands every rider. Near a lane's start rather than its middle
// because the swipe needs road to come back off the kerb before the hold line, where the taxi
// stops driving the lane and starts the turn — see SWIPE_OUT.

/** `'classic'` puts nothing on the kerb: `?streetprops=classic`, `STREETPROPS=classic` headless. */
export const STREETPROPS_MODE = (typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('streetprops')
  : globalThis.process?.env?.STREETPROPS) === 'classic' ? 'classic' : 'on';

const COUNTS = { mailbox: 2, cart: 1 };
// Drawn a quarter bigger than modelled. At 1 the cart's umbrella was a dozen pixels on a phone at
// play zoom and read as a smudge against the façade behind it.
const PROP_SCALE = 1.25;
const SWIPE_S = 4.2;          // along the lane, from its start
const PAVE_IN = 0.5;          // the prop's centre, in from the kerb line onto the pavement
const MIN_LANE = 11.5;        // the lane beside an arterial (10.67) is too short to come back off
const MIN_SEP = 30;           // between any two props, so they spread over the map
// The swipe, in units of lane measured from the prop: in from SWIPE_IN before it to full depth at
// SWIPE_PEAK before it — so the flank is already at the kerb when the nose arrives, rather than
// still swinging in — held to SWIPE_HOLD past it, then back out over SWIPE_OUT. SWIPE_S +
// SWIPE_HOLD + SWIPE_OUT = 7.9 against a hold line at 12 − 3.4 = 8.6 on the shortest lane allowed,
// so the car is back on its lane centre before the turn takes it over.
const SWIPE_IN = 4.4;
const SWIPE_PEAK = 1.2;
const SWIPE_HOLD = 0.3;
const SWIPE_OUT = 3.4;
const ARM_BEFORE = 2.6;       // arm only with at least this much of the run-in still ahead
// How far toward the kerb at the peak. The prop's centre is LANE_TO_KERB + PAVE_IN = 2.75 off
// the lane centre and the drawn taxi is 1.0 across from its own, so 1.75 puts the flank on the
// prop's centre line — a hit you can see, not a near miss with an explosion.
const SWIPE_DEPTH = 1.75;
// The drawn taxi's nose (2.0 ahead of its centre) reaching the prop's near side. The first cut hit
// at 2.0 on a ramp that peaked level with the prop, and the probe measured the car's centre 2.0
// across from the prop's at the moment it went: half a car's width of air between them.
const HIT_ALONG = 2.0;

const FALL = 0.55;            // seconds the prop spends going over
const LIE = 7;                // seconds it lies there before it goes
const SINK = 0.8;
const RESPAWN = 35;           // seconds after the hit before a new one may come up
const RESPAWN_CLEAR = 28;     // ...and only with the taxi at least this far off
const RISE = 0.6;
const BURY = 1.6;

// The spray. Letters flutter — paper has a terminal velocity — and hot dogs drop and bounce.
const SPRAY = {
  mailbox: { count: 22, gravity: 11, terminal: 2.6, up: [4.5, 8], out: 3.2, carry: 0.35, spin: 9, bounce: 0 },
  cart: { count: 16, gravity: 26, terminal: 99, up: [5, 9], out: 2.6, carry: 0.4, spin: 14, bounce: 0.35 },
};
const PIECE_LIE = 4;          // seconds a piece lies on the ground
const PIECE_FADE = 0.5;

/**
 * Pick the props' spots. Returns `[{ kind, x, z, lane, s, block }]`, or [] under `?streetprops=classic`.
 * Needs the sightline field (`setCityOccluders`) and the city network to be the one in play.
 * `keepOut` is points nothing may stand within `KEEP_R` of — the street lamps.
 */
export function planStreetProps(rng, blocks, keepOut = []) {
  if (STREETPROPS_MODE === 'classic') return [];
  const KEEP_R = 1.6;
  const net = cityNetwork();
  const candidates = [];
  for (const lane of net.lanes) {
    if (!lane.path || lane.path.kind !== 'line' || lane.edge.oneway) continue;
    if (lane.length < MIN_LANE) continue;
    const t = lane.path.tangentAt(0);
    // Running +Z, so its kerb — on its right — is the +X face of the block to its west.
    if (t.z < 0.999) continue;
    const kerb = lane.edge.halfWidth - lane.edge.laneOffset;
    const p = lane.path.at(SWIPE_S);
    const x = p.x - (kerb + PAVE_IN);   // right of +Z is −X
    const z = p.z;
    const block = [...blocks].find((b) => b.bounds
      && x > b.bounds.x0 && x < b.bounds.x1 && z > b.bounds.z0 && z < b.bounds.z1);
    if (!block || (block.type !== 'built' && block.type !== 'park')) continue;
    // The kerb line is the block's edge; anything else means this lane is not the one beside it.
    if (Math.abs(block.bounds.x1 - (x + PAVE_IN)) > 0.05) continue;
    if (!sightlineClear(x, 0.8, z)) continue;
    if (keepOut.some((k) => Math.hypot(k.x - x, k.z - z) < KEEP_R)) continue;
    candidates.push({ x, z, lane, s: SWIPE_S, block, kerb });
  }
  for (let n = candidates.length - 1; n > 0; n--) {
    const k = rng.int(0, n);
    [candidates[n], candidates[k]] = [candidates[k], candidates[n]];
  }
  // The cart works a park's walk (Tyler, 2026-10-23: "place the hot dog cart around a park, and
  // then the mailbox can be near anywhere") and goes first, since parks are few; the post boxes
  // take built blocks. A city with no park spot that qualifies puts its cart on a built block
  // rather than going without.
  const out = [];
  const take = (kind, pool) => {
    const c = pool.find((p) => !out.some((o) => Math.hypot(o.x - p.x, o.z - p.z) < MIN_SEP));
    if (c) out.push({ ...c, kind });
    return !!c;
  };
  const park = candidates.filter((c) => c.block.type === 'park');
  const built = candidates.filter((c) => c.block.type === 'built');
  for (let n = 0; n < COUNTS.cart; n++) if (!take('cart', park)) take('cart', built);
  for (let n = 0; n < COUNTS.mailbox; n++) take('mailbox', built);
  return out;
}

const smoothstep = (t) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/**
 * How far toward the kerb the swiping taxi is at `d` units past the prop (negative before it), as a
 * fraction of SWIPE_DEPTH, and its slope per unit of road.
 */
export function swipeShape(d) {
  const eps = 0.01;
  const f = (u) => (u < -SWIPE_PEAK ? smoothstep((u + SWIPE_IN) / (SWIPE_IN - SWIPE_PEAK))
    : u < SWIPE_HOLD ? 1 : 1 - smoothstep((u - SWIPE_HOLD) / SWIPE_OUT));
  return { k: f(d), slope: (f(d + eps) - f(d - eps)) / (2 * eps) };
}

/**
 * Build the props and their spray. `update(dt, taxi)` must run **before** `traffic.update`, which is
 * what draws the taxi at the offset this sets.
 */
export function createStreetProps(scene, plan, { dust = null, rng } = {}) {
  const group = new THREE.Group();
  group.name = 'streetProps';
  const none = { props: [], entryObjects: [], update: () => {}, onSmash: () => {}, smash: () => {}, settle: () => {} };
  if (!plan.length) return none;
  scene.add(group);

  const material = propMaterial();
  const geos = { mailbox: mailboxGeometry(), cart: hotDogCartGeometry() };
  const halves = { mailbox: MAILBOX_HALF, cart: CART_HALF };
  const props = plan.map((p) => {
    // `holder` is where it stands and is what the city's entrance wave scales; `body` is what
    // falls over inside it.
    const holder = new THREE.Group();
    holder.position.set(p.x, KERB_H + 0.01, p.z);
    const body = new THREE.Mesh(geos[p.kind], material);
    body.scale.setScalar(PROP_SCALE);
    body.castShadow = true;
    body.receiveShadow = true;
    holder.add(body);
    group.add(holder);
    return {
      ...p, holder, body, half: halves[p.kind],
      state: 'standing', t: 0, hit: null,
      entry: { object: holder, x: p.x, z: p.z, rand: hash01(p.x, p.z) },
    };
  });

  // --- The spray: one instanced pool per kind ------------------------------
  const pools = {};
  for (const [kind, geo] of [['mailbox', letterGeometry()], ['cart', hotDogGeometry()]]) {
    const max = SPRAY[kind].count * COUNTS[kind];
    const mesh = new THREE.InstancedMesh(geo, material, max);
    // Moving instances: the bounding sphere three latches on the first cull would be wrong by the
    // next frame (CLAUDE.md, the box trucks).
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.count = 0;
    group.add(mesh);
    pools[kind] = { mesh, pieces: [], max };
  }
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const v = new THREE.Vector3();
  const one = new THREE.Vector3();

  function spray(prop, taxi) {
    const cfg = SPRAY[prop.kind];
    const pool = pools[prop.kind];
    const fx = Math.cos(taxi.yaw);
    const fz = -Math.sin(taxi.yaw);
    const speed = Math.min(taxi.v ?? 0, 20);
    for (let n = 0; n < cfg.count; n++) {
      const a = rng.range(-Math.PI, Math.PI);
      const out = cfg.out * rng.range(0.4, 1);
      const piece = {
        x: prop.x + rng.range(-0.2, 0.2), y: KERB_H + 0.6 + rng.range(0, 0.4), z: prop.z + rng.range(-0.3, 0.3),
        // The car's momentum, a burst in every direction, and a push out over the road (+X): the
        // first cut pushed it onto the pavement and half of it flew into the façade behind.
        vx: fx * speed * cfg.carry + Math.cos(a) * out + 1.4,
        vz: fz * speed * cfg.carry + Math.sin(a) * out,
        vy: rng.range(cfg.up[0], cfg.up[1]),
        rx: rng.range(0, 6), ry: rng.range(0, 6), rz: rng.range(0, 6),
        wx: rng.range(-cfg.spin, cfg.spin), wy: rng.range(-cfg.spin, cfg.spin), wz: rng.range(-cfg.spin, cfg.spin),
        age: 0, rest: null, bounced: false, phase: rng.range(0, 6),
      };
      if (pool.pieces.length >= pool.max) pool.pieces.shift();
      pool.pieces.push(piece);
    }
  }

  // The ground under a piece: the pavement over the prop's block, the road everywhere else.
  const groundAt = (prop, x, z) => {
    const b = prop.block.bounds;
    return (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1 ? KERB_H + 0.01 : 0) + 0.02;
  };

  function stepPieces(dt) {
    for (const kind of Object.keys(pools)) {
      const pool = pools[kind];
      const cfg = SPRAY[kind];
      pool.pieces = pool.pieces.filter((p) => p.age < PIECE_LIE + PIECE_FADE + 3);
      pool.pieces.forEach((p, i) => {
        p.age += dt;
        if (!p.rest) {
          p.vy = Math.max(p.vy - cfg.gravity * dt, -cfg.terminal);
          // Paper drifts side to side on the way down once it has stopped climbing.
          const flutter = cfg.terminal < 10 && p.vy < 0 ? Math.sin(p.age * 7 + p.phase) * 1.6 : 0;
          const drag = cfg.terminal < 10 ? Math.exp(-1.8 * dt) : 1;
          p.vx *= drag;
          p.vz *= drag;
          p.x += (p.vx + flutter) * dt;
          p.z += p.vz * dt;
          p.y += p.vy * dt;
          p.rx += p.wx * dt;
          p.ry += p.wy * dt;
          p.rz += p.wz * dt;
          const g = groundAt(prop0(kind), p.x, p.z);
          if (p.y <= g) {
            p.y = g;
            if (!p.bounced && cfg.bounce > 0 && p.vy < -3) {
              p.bounced = true;
              p.vy = -p.vy * cfg.bounce;
              p.vx *= 0.5;
              p.vz *= 0.5;
              p.wx *= 0.5;
              p.wz *= 0.5;
            } else {
              // Down flat, keeping only its heading.
              p.rest = p.age;
              p.rx = 0;
              p.rz = 0;
            }
          }
        }
        const left = p.rest == null ? 1 : 1 - Math.max(0, (p.age - p.rest - PIECE_LIE) / PIECE_FADE);
        if (left <= 0) {
          pool.mesh.setMatrixAt(i, zero);
          return;
        }
        q.setFromEuler(e.set(p.rx, p.ry, p.rz));
        m.compose(v.set(p.x, p.y, p.z), q, one.setScalar(left));
        pool.mesh.setMatrixAt(i, m);
      });
      pool.mesh.count = pool.pieces.length;
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }
  // Which prop a pool's pieces belong to, for the ground under them. A pool only ever holds one
  // kind, and two props of a kind are MIN_SEP apart, so the last one smashed is the right block
  // for nearly every piece; one still in the air from the first smash falls to road height.
  const lastOfKind = {};
  const prop0 = (kind) => lastOfKind[kind];

  const listeners = [];
  function smash(prop, taxi) {
    prop.state = 'falling';
    prop.t = 0;
    const fx = Math.cos(taxi.yaw);
    const fz = -Math.sin(taxi.yaw);
    // Over into the road behind the car, on its side and a little the way the car was going. Away
    // from the road would be the physical answer and was the first cut, but the façade is only
    // 0.35 behind a prop, so a box tipped that way lay half inside the building; and end over end
    // along the kerb stands a cart, twice as long as it is deep, on its end.
    const tx = 1 + 0.6 * fx;
    const tz = 0.6 * fz;
    const tl = Math.hypot(tx, tz);
    prop.hit = { fx, fz, tx: tx / tl, tz: tz / tl, slide: Math.min(taxi.v ?? 0, 20) * 0.12 };
    lastOfKind[prop.kind] = prop;
    spray(prop, taxi);
    // Smaller than the barricade's 26: at that size the cloud covered the whole thing going over.
    dust?.burst(prop.x, prop.z, taxi.yaw, 10, 0.55);
    for (const fn of listeners) fn({ kind: prop.kind, x: prop.x, z: prop.z });
  }

  function stepProp(prop, dt, taxi) {
    prop.t += dt;
    const { holder, body } = prop;
    if (prop.state === 'falling' || prop.state === 'lying' || prop.state === 'sinking') {
      const k = Math.min(1, prop.t / FALL);
      const { fx, fz, tx, tz, slide } = prop.hit;
      // Tip about the horizontal axis square to the push (up × t), so the top goes over toward t.
      const ease = 1 - (1 - k) * (1 - k);
      q.setFromAxisAngle(v.set(tz, 0, -tx).normalize(), ease * Math.PI / 2);
      body.quaternion.copy(q);
      // Lifted by half its thickness as it goes over, since it pivots on the middle of its base.
      body.position.set(fx * slide * ease + tx * 0.25 * ease,
        Math.sin(k * Math.PI) * 0.35 + prop.half.x * PROP_SCALE * ease, fz * slide * ease);
      if (prop.state === 'falling' && k >= 1) { prop.state = 'lying'; prop.t = 0; }
      if (prop.state === 'lying' && prop.t > LIE) { prop.state = 'sinking'; prop.t = 0; }
      if (prop.state === 'sinking') {
        holder.position.y = KERB_H + 0.01 - BURY * Math.min(1, prop.t / SINK);
        if (prop.t >= SINK) { prop.state = 'gone'; prop.t = 0; body.visible = false; }
      }
    } else if (prop.state === 'gone') {
      const far = !taxi || Math.hypot(taxi.x - prop.x, taxi.z - prop.z) > RESPAWN_CLEAR;
      if (prop.t > RESPAWN && far) {
        prop.state = 'rising';
        prop.t = 0;
        body.quaternion.identity();
        body.position.set(0, 0, 0);
        body.visible = true;
      }
    } else if (prop.state === 'rising') {
      const k = Math.min(1, prop.t / RISE);
      holder.position.y = KERB_H + 0.01 - BURY * (1 - smoothstep(k));
      if (k >= 1) { prop.state = 'standing'; prop.t = 0; }
    }
  }

  // --- The swipe ------------------------------------------------------------
  let target = null;

  function steer(taxi) {
    if (!taxi) return;
    const active = !taxi.crashed && !taxi.staged && taxi.state === 'drive';
    if (target && (!active || taxi.lane !== target.lane)) target = null;
    if (!target && active && taxi.boost && !taxi.passing && taxi.dodgeLateral == null
      && taxi.hopFrom == null) {
      target = props.find((p) => p.state === 'standing' && p.lane === taxi.lane
        && taxi.s <= p.s - ARM_BEFORE) ?? null;
    }
    if (!target) {
      taxi.swipeOffset = 0;
      taxi.swipeSlope = 0;
      return;
    }
    const d = taxi.s - target.s;
    const { k, slope } = swipeShape(d);
    // Negative is toward the kerb: `lateral` is + toward the road centreline.
    taxi.swipeOffset = -SWIPE_DEPTH * k;
    taxi.swipeSlope = -SWIPE_DEPTH * slope;
    if (target.state === 'standing' && d >= -HIT_ALONG) smash(target, taxi);
    if (d >= SWIPE_HOLD + SWIPE_OUT) target = null;
  }

  return {
    group,
    props,
    entryObjects: props.map((p) => p.entry),
    /** Before `traffic.update`. */
    update(dt, taxi) {
      steer(taxi);
      for (const p of props) stepProp(p, dt, taxi);
      stepPieces(dt);
    },
    onSmash(fn) { listeners.push(fn); },
    /** Knock one over by hand, for shot mode and the probe: as if `taxi` had just swiped it. */
    smash: (prop, taxi) => smash(prop, taxi),
    /** Advance just the spray and the fall, `seconds` of it, for a still. */
    settle(seconds) {
      for (let t = 0; t < seconds; t += 1 / 60) {
        for (const p of props) stepProp(p, 1 / 60, null);
        stepPieces(1 / 60);
      }
    },
  };
}
