/**
 * Free driving: the taxi as a body with a heading and a speed, steered straight off the stick, with
 * no lane, no queued turn and no hold line (Tyler, 2026-11-24: "what's the maximalist version that
 * just uses real physics down the taxi and no on rails stuff? Like fully responsive to the
 * joystick?"). The default under the stick; `?steer=rails` puts back the Pac-Man queue.
 *
 * **The taxi leaves the traffic model.** `taxi.free` takes it out of every simulation loop on a
 * staged car's terms (sim/traffic.js) and this module owns `x`, `z`, `yaw` and `v`. What it keeps:
 * the render pass (suspension, wheels, the bridge's pitch), the collision detector (which reads
 * exactly those four) and the fare loop (which arrives by position). What it gives up is everything
 * that was lane arithmetic: signals do not bind it, cars behind do not queue for it, and the lane
 * moves — the overtake, the U-turn, the drift, the bridge hop — have nothing to stand on.
 *
 * **The stick is a heading.** Its screen direction is turned back into a ground direction through
 * the live camera, so the taxi goes where the thumb points *on screen*. Hands off, it holds its
 * heading and keeps rolling at cruise; Loco is the fast pedal and the brake is the brake.
 *
 * **It has weight.** The first cut swung the nose as fast as the stick asked and let the direction
 * of travel ease after it, and that read as "ice skating... missing all its weight and momentum"
 * (Tyler): a lag proportional to the error is a car that is *always* sliding a little. Now the body
 * carries a velocity. The tyres hold it sideways up to `LAT_GRIP` and no further, so it tracks its
 * nose until it is asked for more than they have, and only then slides; the swing itself has
 * inertia (`YAW_LAG`) and is capped by what the grip can turn at that speed, so at Loco the car
 * runs wide where at cruise it turns in; and a hard turn above cruise scrubs speed off.
 *
 * **Streets are diagonals, so the heading gets a magnet.** Every street lies ~29° off the
 * horizontal on screen, and a thumb cannot hold that to a degree: without help the taxi ground
 * along a kerb down every straight. A push within `ASSIST` of a street's direction is that street's
 * direction, and a hands-off heading that close settles onto it. Anything wider is the player's own
 * angle. `?freeassist=off` drives it raw.
 *
 * **Buildings, water and the coast stop it; kerbs do not.** The first cut kept the body to the road
 * corridors and it "gets stuck on everything". It drives anywhere on the island a building is not
 * standing — pavements, plazas, parks — up the kerb (`kerbLift`). `drivable` is: on a road (which is
 * what carries it over a bridge), or inside the ring road, off the river, and clear of `solid` (a
 * height field of the buildings, main.js). A move into something slides along it and keeps only
 * the speed that ran along it.
 *
 * **It still tells the city where it is.** Each frame the nearest lane running the taxi's way is
 * written to `taxi.lane`/`s`/`d`/`i`/`j`, which is what the router, the cops and the scripted trips
 * (the garage, the drive-through, the race) plan from — and what the traffic model picks the car up
 * on when one of those takes the wheel back (`taxi.free = false`).
 */
import { cityNetwork } from '../city/roadnet.js';
import { SPEED } from '../sim/traffic.js';
import { GRID_I, GRID_J, lineX, lineZ, riverBanks } from '../city/grid.js';

// Top speed with Loco held, in u/s, when main.js does not pass the game's own (`boostCruise`). The
// first cut ran 15 on the theory that a thumb aims worse than a lane; Tyler: "too slow".
export const FREE_LOCO_SPEED = 18.7;
const ACCEL = 9;
const BRAKE = 24;
// Coasting down from Loco to cruise.
const COAST = 7;
// Sideways grip, in u/s² — the lateral acceleration the tyres can give before the car slides.
// 38 took 0.98s and 15.9 units to bring a quarter turn round at full Loco; 46 takes 0.83s and 13.5.
const LAT_GRIP = 46;
// The fastest the nose can swing, in rad/s, and the share of the grip a steady turn may use: at
// cruise the cap is TURN_MAX (a 2.7-unit circle), at Loco it is grip-limited to ~2.2 rad/s (8.4 units).
const TURN_MAX = 3.2;
const TURN_GRIP_SHARE = 0.9;
// The tightest circle at walking pace, and the speed the turn rate is paid for at when the car is
// slower than that — so a taxi nosed into a wall, or pulling away, can still be pointed somewhere.
const TURN_RADIUS = 2.6;
const TURN_FLOOR_V = 3;
// How hard the swing chases the stick (rad/s per radian of error), and the swing's own inertia: the
// time constant its rate takes to build and to die, in seconds.
const TURN_GAIN = 8;
const YAW_LAG = 0.11;
// Speed a full-rate turn scrubs off above cruise, in u/s².
const TURN_SCRUB = 7;
// The heading magnet: a push this close to a street's direction is that direction, in radians.
const ASSIST = (16 * Math.PI) / 180;
// ...and how fast a hands-off heading that close settles onto it, per second.
const SETTLE = 3;
// How far up the taxi rides on a pavement, and how fast it climbs, per second.
const KERB_H = 0.35;
const KERB_RATE = 12;
// The body's reach for the building test, in units: the centre and four points this far out.
const BODY_R = 0.7;
// Speed kept per second of grinding along a wall.
const SCRAPE_KEEP = 0.5;
// A wall met at a slant turns the taxi along itself, this fast in rad/s — faster than the stick can
// turn it back in (`TURN_MAX`), so a push held into a wall is a scrape along it at nearly full speed.
// The first cut projected the velocity onto the wall and then onto the nose every frame, which at
// 45° halves it twice a frame: measured 8.5 to 1.0 u/s in a second, and Tyler's "stuck on everything".
const WALL_TURN = 7;
// Squarer on than this (the share of the speed that runs along the wall) and it is a stop instead.
const WALL_SQUARE = 0.3;
// The speed held nose-on against a wall.
const WALL_CRAWL = 1;

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Distance from (x, z) to segment a→b, and how far along it the nearest point is (0..1).
 */
function toSegment(x, z, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
  return { dist: Math.hypot(x - (ax + dx * t), z - (az + dz * t)), t };
}

/**
 * Where the taxi can be. `onRoad(x, z)` is the road corridors; `inside(x, z)` adds the open ground
 * of the island — inside the ring road, off the river, and not `solid`.
 *
 * @param solid  `(x, z) => boolean`, a building stands here (main.js: the city's height field)
 */
export function roadCorridors(net = cityNetwork(), solid = () => false) {
  const segs = net.edges.map((e) => {
    const a = net.nodeById.get(e.a);
    const b = net.nodeById.get(e.b);
    return { ax: a.x, az: a.z, bx: b.x, bz: b.z, half: e.halfWidth };
  });
  const x0 = lineX(0);
  const x1 = lineX(GRID_I);
  const z0 = lineZ(0);
  const z1 = lineZ(GRID_J);
  const onRoad = (x, z) => {
    for (const s of segs) {
      if (toSegment(x, z, s.ax, s.az, s.bx, s.bz).dist <= s.half) return true;
    }
    return false;
  };
  const built = (x, z) => solid(x, z) || solid(x + BODY_R, z) || solid(x - BODY_R, z)
    || solid(x, z + BODY_R) || solid(x, z - BODY_R);
  return {
    onRoad,
    inside(x, z) {
      // A road is always open: nothing solid stands on one, and the field rounds walls outward.
      if (onRoad(x, z)) return true;
      if (x < x0 || x > x1 || z < z0 || z > z1) return false;
      const banks = riverBanks();
      if (banks && z > banks.z0 && z < banks.z1) return false;
      return !built(x, z);
    },
  };
}

/**
 * A ground direction for a screen direction: solve `s = wx·a + wz·b` for the two world axes as the
 * camera draws them. Returns a unit `{ x, z }`, or null for a degenerate projection.
 */
export function screenToGround(sx, sy, toScreen) {
  const a = toScreen(1, 0);
  const b = toScreen(0, 1);
  const det = a.x * b.y - a.y * b.x;
  if (Math.abs(det) < 1e-9) return null;
  const wx = (sx * b.y - sy * b.x) / det;
  const wz = (a.x * sy - a.y * sx) / det;
  const l = Math.hypot(wx, wz);
  return l > 1e-9 ? { x: wx / l, z: wz / l } : null;
}

/** Pull a heading onto the nearest street axis if it is within `ASSIST` of one. */
export function magnet(yaw, assist = ASSIST) {
  const quarter = Math.PI / 2;
  const axis = Math.round(yaw / quarter) * quarter;
  return Math.abs(wrap(yaw - axis)) <= assist ? axis : yaw;
}

/**
 * @param taxi      the traffic model's taxi
 * @param stick     () => `{ dx, dy, len }` in CSS px while the stick is pushed past its dead zone, else null
 * @param toScreen  `(dx, dz) => { x, y }`, a world ground vector in screen pixels
 * @param live      () => boolean — the player has the wheel (not a scripted trip, a menu, a wreck)
 * @param assist    the heading magnet; false drives raw
 * @param solid     `(x, z) => boolean`, a building stands here
 * @param locoSpeed () => the top speed with Loco held
 */
export function createFreeDrive({ taxi, stick, toScreen, live, assist = true, net = cityNetwork(),
  solid = () => false, locoSpeed = () => FREE_LOCO_SPEED }) {
  const roads = roadCorridors(net, solid);
  const lanes = net.lanes.filter((l) => l.path).map((lane) => {
    const p0 = lane.path.at(0);
    const p1 = lane.path.at(lane.length);
    const d = net.dirOfLane(lane);
    const node = net.nodeById.get(lane.to);
    const l = Math.hypot(p1.x - p0.x, p1.z - p0.z) || 1;
    return { lane, d, i: node.gi, j: node.gj, ax: p0.x, az: p0.z, bx: p1.x, bz: p1.z,
      tx: (p1.x - p0.x) / l, tz: (p1.z - p0.z) / l };
  });
  let active = false;
  let x = 0;
  let z = 0;
  let yaw = 0;
  // Sideways speed, + to the taxi's left: what the tyres have not yet taken back. And the swing.
  let slip = 0;
  let spin = 0;

  /** The lane the city should think the taxi is on: nearest, among those running its way. */
  function project() {
    const fx = Math.cos(yaw);
    const fz = -Math.sin(yaw);
    let best = null;
    let bestScore = Infinity;
    for (const c of lanes) {
      const along = fx * c.tx + fz * c.tz;
      if (along < 0.25) continue;
      const hit = toSegment(x, z, c.ax, c.az, c.bx, c.bz);
      // A lane running the taxi's way beats a nearer one it is merely crossing.
      const score = hit.dist + (1 - along) * 6;
      if (score < bestScore) { bestScore = score; best = { c, t: hit.t }; }
    }
    if (!best) return;
    taxi.lane = best.c.lane;
    taxi.s = best.t * best.c.lane.length;
    taxi.d = best.c.d;
    taxi.i = best.c.i;
    taxi.j = best.c.j;
  }

  function begin() {
    active = true;
    x = taxi.x;
    z = taxi.z;
    yaw = taxi.yaw;
    slip = 0;
    spin = 0;
    taxi.free = true;
  }

  function end() {
    active = false;
    if (!taxi.free) return;
    project();
    taxi.free = false;
    taxi.kerbLift = 0;
  }

  function update(dt) {
    if (!live() || taxi.crashed || taxi.staged) { if (active) end(); return; }
    if (!active) begin();
    // Everything the rails' moves and offsets left on the car: a free taxi wears none of them.
    taxi.state = 'drive';
    taxi.turn = null;
    taxi.uturn = null;
    taxi.drift = null;
    taxi.lateral = 0;
    taxi.nudge = 0;
    taxi.pass = 0;
    taxi.passing = false;
    taxi.passOffset = 0;
    taxi.passSlope = 0;
    taxi.steer = 0;
    taxi.route = [];
    taxi.parked = false;

    // --- Speed along the nose. `taxi.v` is shared with the collision detector, which scrubs it.
    let v = taxi.v;
    const top = locoSpeed();
    const want = taxi.braking || taxi.stalled || taxi.stun > 0 ? 0 : taxi.boost ? top : SPEED;
    if (v < want) v = Math.min(want, v + ACCEL * dt);
    else v = Math.max(want, v - (want === 0 ? BRAKE : COAST) * dt);

    // --- Heading: the swing the stick asks for, capped by what the tyres can turn at this speed,
    // and reached through the swing's own inertia.
    const push = stick();
    let target = null;
    if (push) {
      const g = screenToGround(push.dx, push.dy, toScreen);
      if (g) target = Math.atan2(-g.z, g.x);
    }
    const rateCap = Math.min(TURN_MAX, Math.max(v, TURN_FLOOR_V) / TURN_RADIUS,
      (LAT_GRIP * TURN_GRIP_SHARE) / Math.max(v, 1));
    let wantSpin = 0;
    if (target != null) {
      if (assist) target = magnet(target);
      wantSpin = Math.max(-rateCap, Math.min(rateCap, wrap(target - yaw) * TURN_GAIN));
    } else if (assist) {
      wantSpin = Math.max(-rateCap, Math.min(rateCap, wrap(magnet(yaw) - yaw) * SETTLE));
    }
    spin += (wantSpin - spin) * Math.min(1, dt / YAW_LAG);
    const turned = spin * dt;
    yaw = wrap(yaw + turned);
    // Turning the nose leaves the velocity where it was: what was forward is now partly sideways.
    // (Left is +yaw; a swing to the left leaves the car sliding to its right.)
    const c = Math.cos(turned);
    const sn = Math.sin(turned);
    [v, slip] = [v * c + slip * sn, slip * c - v * sn];
    // The tyres take the sideways part back, as fast as they grip and no faster.
    slip -= Math.sign(slip) * Math.min(Math.abs(slip), LAT_GRIP * dt);
    // A hard turn above cruise costs speed.
    if (v > SPEED) v = Math.max(SPEED, v - TURN_SCRUB * (spin / rateCap) ** 2 * dt);

    // --- Move, and stay off what is solid: whole step, else whichever axis is still open.
    const fx = Math.cos(yaw);
    const fz = -Math.sin(yaw);
    // The taxi's left on the ground: (-sin yaw, -cos yaw).
    const lx = -Math.sin(yaw);
    const lz = -Math.cos(yaw);
    let wx = fx * v + lx * slip;
    let wz = fz * v + lz * slip;
    const mx = wx * dt;
    const mz = wz * dt;
    let step = Math.hypot(mx, mz);
    if (roads.inside(x + mx, z + mz)) {
      x += mx; z += mz;
    } else {
      // A glancing blow deflects the taxi along the wall and costs a little; square on costs it all.
      // `WALL_CRAWL` is what the engine holds against a wall, so the car can still be steered off it.
      const openX = roads.inside(x + mx, z);
      const openZ = roads.inside(x, z + mz);
      const speed = Math.hypot(wx, wz);
      const keep = Math.pow(SCRAPE_KEEP, dt);
      if (openX && (!openZ || Math.abs(mx) >= Math.abs(mz))) { x += mx; wz = 0; step = Math.abs(mx); }
      else if (openZ) { z += mz; wx = 0; step = Math.abs(mz); }
      else { wx = 0; wz = 0; step = 0; }
      const along = Math.hypot(wx, wz);
      if (along > WALL_SQUARE * speed && along > WALL_CRAWL) {
        // A slanted hit: the wall swings the nose along itself and the taxi keeps what ran that way.
        const wallYaw = Math.atan2(-wz, wx);
        const off = wrap(wallYaw - yaw);
        yaw = wrap(yaw + Math.max(-WALL_TURN * dt, Math.min(WALL_TURN * dt, off)));
        v = along * keep;
        slip = 0;
        spin = 0;
      } else {
        v = Math.min(v, WALL_CRAWL);
        slip = 0;
        spin *= keep;
      }
    }
    // Up the kerb onto anything that is not road.
    const lift = roads.onRoad(x, z) ? 0 : KERB_H;
    taxi.kerbLift += (lift - (taxi.kerbLift ?? 0)) * Math.min(1, KERB_RATE * dt);

    taxi.x = x;
    taxi.z = z;
    taxi.yaw = yaw;
    taxi.v = v;
    taxi.speedFactor = v / SPEED;
    taxi.travelled += step;
    project();
  }

  return {
    update,
    active: () => active,
    /** Put the body somewhere by hand (the tools). */
    place(nx, nz, nyaw) { x = nx; z = nz; yaw = nyaw; slip = 0; spin = 0; },
    drivable: roads.inside,
  };
}
