import * as THREE from 'three';
import { bakeColor, hash01, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import {
  createPerson, dribbleBall, handAt, shotPose, SHOT_RELEASE,
} from '../geometry/person.js';
import { COURT_TOP_Y, RIM_R, RIM_Y } from '../city/blacktop.js';

// The players on the basketball court (city/blacktop.js): one or two people shooting around, not a
// game. Each has a ball and a hoop of their own and stays on their own half — dribble out to a
// spot, pull up, shoot, watch it, go and get it, again.
//
// Scenery on the ducks' terms: no collisions with anything, nothing the fare loop knows about, and
// a run seed rather than the city's, because who is out on the court is the situation and not the
// map. Everything is worked in the court's own frame — `u` along its length, `v` across — and
// mapped to the world by `court.toWorld` only when it is posed.

// One player most of the time, two now and then. Two is a court with something going on; one is a
// court with someone on it, and both are what the brief asked for.
const TWO_PLAYERS = 0.6;

/** The ball. A real one is 0.24 m across; this is drawn at the people's own two-and-a-half times. */
const BALL_R = 0.3;
// Gravity in world units. Steeper than 9.8 because the world is drawn large: at true gravity a shot
// from five units out hangs in the air for two seconds and reads as slow motion.
const G = 16;
const BOUNCE = 0.62;     // vertical speed kept off the floor
const SKID = 0.85;       // horizontal speed kept through each bounce
const ROLL_DRAG = 1.6;   // u/s² once it has stopped bouncing

const DRIBBLE_PERIOD = 0.5;   // seconds per bounce
const JOG = 1.7;              // dribbling speed
const RUN = 3.4;              // chasing a loose ball
const SHOT_TIME = 1.0;        // the whole jump shot, gather to landing
/** How long the shooter watches before going after it, counted from release. */
const WATCH = 0.9;

/** How far out from the rim a player pulls up to shoot, and how far round from straight on. */
const RANGE = [1.5, 3.2];
const ANGLE = 1.25;
/** How far in from the slab's edge a player stands at the closest — about the dribble's reach. */
const EDGE_ROOM = 0.9;
/** Pauses on the spot before the shot. */
const SETTLE = [0.5, 1.6];

/** The share of shots that drop. Better from close in — and never certain, or nobody chases. */
const MAKE_NEAR = 0.75;
const MAKE_FAR = 0.4;

const TAU = Math.PI * 2;

/**
 * @param court  the plan from city/blacktop.js, or null — in which case this is a quiet no-op,
 *               the way the ducks are on a city with no pond.
 */
export function createHoopers(scene, rng, court) {
  const group = new THREE.Group();
  group.name = 'hoopers';
  if (!court) return { group, players: [], entryObjects: [], update: () => {} };
  scene.add(group);

  const count = rng.chance(TWO_PLAYERS) ? 2 : 1;
  // The first player takes the hoop at the far end, whose board faces the camera — a lone player
  // shooting at the back of a backboard is a player half hidden by it.
  const ends = [-1, 1].slice(0, count);
  const looks = [
    { body: PALETTE.hooperA, legs: PALETTE.hooperShorts, hair: '#2E2520' },
    { body: PALETTE.hooperB, legs: PALETTE.hooperShorts, hair: '#5A4334' },
  ];

  const ballGeometry = bakeColor(new THREE.IcosahedronGeometry(BALL_R, 1), new THREE.Color(PALETTE.basketball));
  const ballMaterial = propMaterial();

  const players = ends.map((s, i) => {
    const person = createPerson({ ...looks[i], pickable: null });
    const holder = new THREE.Group();
    holder.add(person.group);
    group.add(holder);

    const ball = new THREE.Mesh(ballGeometry, ballMaterial);
    ball.castShadow = true;
    group.add(ball);

    const hoop = court.hoops.find((h) => h.s === s);
    const player = {
      s, person, holder, ballMesh: ball, hoop,
      // Where they are on the court, and which way they face (a world yaw, +Z forward).
      u: s * court.rimU * 0.4, v: rng.jitter(1.5), yaw: 0,
      state: 'dribble',
      t: 0,               // seconds in the current state
      bounce: rng.next(), // the dribble's phase
      cadence: 0,
      target: null,
      settle: 0,
      ball: { mode: 'held', u: 0, v: 0, y: 0, vu: 0, vv: 0, vy: 0, t: 0, flight: null },
    };
    pickSpot(player);
    return player;
  });

  // --- Where things are --------------------------------------------------------

  /** The hoop's rim in court terms. A declaration, so the players built above can use it. */
  function rimOf(player) {
    return { u: player.s * court.rimU, v: 0 };
  }

  /** A spot to pull up at: somewhere round the rim in range, inside the lines, on their own half. */
  function pickSpot(player) {
    const rim = rimOf(player);
    for (let attempt = 0; attempt < 8; attempt++) {
      const d = rng.range(RANGE[0], RANGE[1]);
      const a = rng.jitter(ANGLE);
      const u = rim.u - player.s * Math.cos(a) * d;
      const v = Math.sin(a) * d;
      if (Math.abs(v) > court.halfV - 0.6) continue;
      if (player.s * u < 0.8) continue;
      player.target = { u, v };
      player.settle = rng.range(SETTLE[0], SETTLE[1]);
      return;
    }
    player.target = { u: rim.u - player.s * RANGE[0], v: 0 };
    player.settle = SETTLE[0];
  }

  /** World yaw that points a figure's +Z from (u, v) along the court-frame direction (du, dv). */
  function yawToward(du, dv) {
    const a = court.toWorld(du, dv);
    const o = court.toWorld(0, 0);
    return Math.atan2(a.x - o.x, a.z - o.z);
  }

  const HAND_R = { x: 0, y: 0, z: 0 };
  const HAND_L = { x: 0, y: 0, z: 0 };
  const LOCAL = { x: 0, y: 0, z: 0 };

  /** A point in the figure's own frame, in court terms — the inverse of how `holder` places it. */
  function bodyToCourt(player, local, lift = 0) {
    // The figure's +Z is world (sin yaw, cos yaw), +X is world (cos yaw, −sin yaw). Mapped back
    // through `toWorld`, which is its own inverse whichever axis the court lies along.
    const sin = Math.sin(player.yaw);
    const cos = Math.cos(player.yaw);
    const wx = local.x * cos + local.z * sin;
    const wz = -local.x * sin + local.z * cos;
    const d = court.axis === 'x' ? { u: wx, v: wz } : { u: wz, v: wx };
    return { u: player.u + d.u, v: player.v + d.v, y: local.y + lift };
  }

  /** The ball between both hands, for a jump shot at `k`. */
  function ballInShot(player, k) {
    const pose = shotPose(k);
    handAt(pose.rx, pose.rz, 1, HAND_R);
    handAt(pose.rx, pose.rz, -1, HAND_L);
    LOCAL.x = (HAND_R.x + HAND_L.x) / 2;
    LOCAL.y = (HAND_R.y + HAND_L.y) / 2 + BALL_R * 0.6;
    LOCAL.z = (HAND_R.z + HAND_L.z) / 2 + BALL_R * 0.5;
    return bodyToCourt(player, LOCAL, pose.lift);
  }

  // --- The ball ------------------------------------------------------------

  /**
   * Put the ball up. The arc is solved for a flight time rather than a launch angle — longer from
   * further out — so it always arrives where it was aimed, and whether it drops is decided here, at
   * the release, as an aim point: dead centre for a make, onto the rim for a miss.
   */
  function release(player, from) {
    const rim = rimOf(player);
    const dist = Math.hypot(rim.u - from.u, rim.v - from.v);
    const near = (dist - RANGE[0]) / (RANGE[1] - RANGE[0]);
    const make = rng.chance(MAKE_NEAR + (MAKE_FAR - MAKE_NEAR) * Math.min(1, Math.max(0, near)));
    let aimU = rim.u;
    let aimV = rim.v;
    if (!make) {
      // Front rim, back rim, or off to one side: a point on the ring itself.
      const a = rng.range(0, TAU);
      aimU += Math.cos(a) * RIM_R;
      aimV += Math.sin(a) * RIM_R;
    }
    const aimY = RIM_Y + 0.12 - COURT_TOP_Y;
    const T = 0.85 + 0.06 * dist;
    const b = player.ball;
    b.mode = 'flight';
    b.t = 0;
    b.flight = {
      make, T, aimU, aimV,
      u0: from.u, v0: from.v, y0: from.y,
      vu: (aimU - from.u) / T,
      vv: (aimV - from.v) / T,
      vy: (aimY - from.y + 0.5 * G * T * T) / T,
    };
  }

  function stepBall(player, dt) {
    const b = player.ball;
    if (b.mode === 'flight') {
      const f = b.flight;
      b.t = Math.min(b.t + dt, f.T);
      b.u = f.u0 + f.vu * b.t;
      b.v = f.v0 + f.vv * b.t;
      b.y = f.y0 + f.vy * b.t - 0.5 * G * b.t * b.t;
      if (b.t < f.T) return;
      b.mode = 'loose';
      if (f.make) {
        // Through the net: straight down from the middle of the rim, with a little of the arc's
        // forward speed kept so it does not land exactly where it was released from overhead.
        b.vu = f.vu * 0.12;
        b.vv = f.vv * 0.12;
        b.vy = -1.5;
      } else {
        // Off the iron: up and away from where it struck, back out toward the court.
        const rim = rimOf(player);
        let du = b.u - rim.u;
        let dv = b.v - rim.v;
        const l = Math.hypot(du, dv) || 1;
        du /= l;
        dv /= l;
        // Never back through the board: whatever side it hit, the bounce comes out court-side.
        if (du * player.s > 0) du = -du;
        const speed = rng.range(2.0, 3.6);
        b.vu = du * speed + rng.jitter(0.6);
        b.vv = dv * speed + rng.jitter(0.6);
        b.vy = rng.range(2.5, 4.2);
      }
      return;
    }
    if (b.mode !== 'loose') return;

    b.t += dt;
    b.vy -= G * dt;
    b.u += b.vu * dt;
    b.v += b.vv * dt;
    b.y += b.vy * dt;
    if (b.y <= BALL_R) {
      b.y = BALL_R;
      if (b.vy < -1.0) {
        b.vy = -b.vy * BOUNCE;
        b.vu *= SKID;
        b.vv *= SKID;
      } else {
        b.vy = 0;
        const speed = Math.hypot(b.vu, b.vv);
        const slowed = Math.max(0, speed - ROLL_DRAG * dt);
        const k = speed > 1e-6 ? slowed / speed : 0;
        b.vu *= k;
        b.vv *= k;
      }
    }
    // Kept on the blacktop — off the far sides by the fence, off the near ones because a ball that
    // rolls into the grass takes its player out of the court to fetch it — and, with two players
    // out, on its own half so the two never share a ball.
    const maxU = court.len / 2 - BALL_R - 0.1;
    const maxV = court.wid / 2 - BALL_R - 0.1;
    const minU = count > 1 ? 0.6 : -maxU;
    const su = b.u * player.s;
    if (su > maxU || su < minU) {
      b.u = player.s * Math.min(maxU, Math.max(minU, su));
      b.vu = -b.vu * 0.5;
    }
    if (Math.abs(b.v) > maxV) {
      b.v = Math.sign(b.v) * maxV;
      b.vv = -b.vv * 0.5;
    }
  }

  // --- The players -------------------------------------------------------------

  function stepPlayer(player, dt) {
    player.t += dt;
    const b = player.ball;

    if (player.state === 'dribble') {
      player.bounce = (player.bounce + dt / DRIBBLE_PERIOD) % 1;
      const du = player.target.u - player.u;
      const dv = player.target.v - player.v;
      const d = Math.hypot(du, dv);
      if (d > 0.05) {
        const step = Math.min(d, JOG * dt);
        player.u += (du / d) * step;
        player.v += (dv / d) * step;
        player.yaw = yawToward(du, dv);
        player.cadence += dt * 11;
        player.moving = true;
      } else {
        const rim = rimOf(player);
        player.yaw = yawToward(rim.u - player.u, rim.v - player.v);
        player.moving = false;
        player.settle -= dt;
        // Pull up only with the ball in hand — at the top of a bounce — so it never leaves the floor
        // straight into the shooter's hands from somewhere else.
        if (player.settle <= 0 && player.bounce < 0.08) {
          player.state = 'shoot';
          player.t = 0;
        }
      }
      return;
    }

    if (player.state === 'shoot') {
      const k = Math.min(1, player.t / SHOT_TIME);
      if (b.mode === 'held' && k >= SHOT_RELEASE) release(player, ballInShot(player, SHOT_RELEASE));
      if (k >= 1) {
        player.state = 'watch';
        player.t = 0;
      }
      return;
    }

    if (player.state === 'watch') {
      if (player.t > WATCH - SHOT_TIME * (1 - SHOT_RELEASE) && b.mode === 'loose') {
        player.state = 'chase';
        player.t = 0;
      }
      return;
    }

    if (player.state === 'chase') {
      const du = b.u - player.u;
      const dv = b.v - player.v;
      const d = Math.hypot(du, dv);
      // Reached it once it is within an arm and low enough to scoop up off a bounce. An arm and a
      // bit: the chaser is held back from the slab's edge (below) and the ball is not, so a ball
      // run into a corner sits 0.7 from the nearest a player can stand.
      if (d < 0.8 && b.y < 1.4) {
        b.mode = 'held';
        player.state = 'dribble';
        player.t = 0;
        player.bounce = 0.5;            // scooped off the floor, on its way back up
        pickSpot(player);
        // Turned to where they are headed on the frame they pick it up, which is back in toward
        // the hoop: the dribble hangs the ball off the right hand a unit out in front, so a player
        // left facing the fence they fetched it from would bounce it on the lawn.
        player.yaw = yawToward(player.target.u - player.u, player.target.v - player.v);
        return;
      }
      // Run to where the ball is going to be in a moment, not where it is, or a rolling ball is
      // followed round in a tail-chase.
      const lead = Math.min(0.5, d / RUN);
      const tu = b.u + b.vu * lead - player.u;
      const tv = b.v + b.vv * lead - player.v;
      const td = Math.hypot(tu, tv);
      if (td > 0.3) {
        const step = Math.min(td - 0.3, RUN * dt);
        player.u += (tu / td) * step;
        player.v += (tv / td) * step;
        player.yaw = yawToward(tu, tv);
      }
      // Never closer to the slab's edge than the ball they will be dribbling hangs off them.
      const edgeU = court.len / 2 - EDGE_ROOM;
      const edgeV = court.wid / 2 - EDGE_ROOM;
      player.u = Math.min(edgeU, Math.max(-edgeU, player.u));
      player.v = Math.min(edgeV, Math.max(-edgeV, player.v));
      player.cadence += dt * 20;
    }
  }

  // --- Posing ----------------------------------------------------------------

  function pose(player) {
    const at = court.toWorld(player.u, player.v);
    player.holder.position.set(at.x, COURT_TOP_Y, at.z);
    player.holder.rotation.y = player.yaw;

    const b = player.ball;
    if (player.state === 'dribble') {
      player.person.dribble(player.bounce, player.moving ? player.cadence : null);
    } else if (player.state === 'shoot') {
      player.person.shoot(Math.min(1, player.t / SHOT_TIME));
    } else if (player.state === 'watch') {
      player.person.watch(player.t);
    } else {
      player.person.chase(player.cadence);
    }

    if (b.mode === 'held') {
      const p = player.state === 'shoot'
        ? ballInShot(player, Math.min(1, player.t / SHOT_TIME))
        : bodyToCourt(player, dribbleBall(player.bounce, BALL_R, LOCAL));
      b.u = p.u;
      b.v = p.v;
      b.y = p.y;
    }
    const w = court.toWorld(b.u, b.v);
    player.ballMesh.position.set(w.x, COURT_TOP_Y + b.y, w.z);
  }

  function update(dt) {
    // A long frame (a tab coming back from the background) is spent as several short ones, so the
    // ball cannot step through the floor or the rim in one go.
    const steps = Math.min(8, Math.ceil(dt / 0.05));
    const h = dt / Math.max(1, steps);
    for (let n = 0; n < steps; n++) {
      for (const player of players) {
        stepPlayer(player, h);
        stepBall(player, h);
      }
    }
    for (const player of players) pose(player);
  }

  // Posed at construction, not on the first frame — shot mode ticks once and freezes, and a
  // screenshot of the park should have players on the court with a ball in hand.
  for (const player of players) pose(player);

  // Grown in the city's entrance wave with the court they stand on, on the court's own anchor.
  const entryObjects = players.flatMap((player) => [player.holder, player.ballMesh]).map((object) => ({
    object, x: court.x, z: court.z, rand: hash01(court.x, court.z),
  }));

  return { group, players, entryObjects, court, update };
}
