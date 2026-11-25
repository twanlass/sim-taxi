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
 * the live camera, so the taxi goes where the thumb points *on screen*. The car swings toward it at
 * a rate its speed can pay for (a minimum turning circle), and the velocity trails the nose a
 * little (`GRIP`), which is the slide. Hands off, it holds its heading and keeps rolling at cruise;
 * Loco is the fast pedal and the brake is the brake.
 *
 * **Streets are diagonals, so the heading gets a magnet.** Every street lies ~29° off the
 * horizontal on screen, and a thumb cannot hold that to a degree: without help the taxi ground
 * along a kerb down every straight. A push within `ASSIST` of a street's direction is that street's
 * direction, and a hands-off heading that close settles onto it. Anything wider is the player's own
 * angle. `?freeassist=off` drives it raw.
 *
 * **The road is where it can be.** The body stays inside the road corridors (each network edge's
 * half-width, plus `KERB_GIVE` onto the pavement); a move that would leave them slides along the
 * wall on whichever axis is still open and scrubs speed. Buildings, the river and the island's edge
 * are all just "not road".
 *
 * **It still tells the city where it is.** Each frame the nearest lane running the taxi's way is
 * written to `taxi.lane`/`s`/`d`/`i`/`j`, which is what the router, the cops and the scripted trips
 * (the garage, the drive-through, the race) plan from — and what the traffic model picks the car up
 * on when one of those takes the wheel back (`taxi.free = false`).
 */
import { cityNetwork } from '../city/roadnet.js';
import { SPEED } from '../sim/traffic.js';

// Top speed with Loco held, in u/s. Under the rails' 18.7 on purpose: there the lane did the
// aiming, and here a 9-unit street goes by in half a second of thumb.
export const FREE_LOCO_SPEED = 15;
const ACCEL = 12;
const BRAKE = 26;
// Coasting down from Loco to cruise.
const COAST = 9;
// The tightest circle the taxi can turn, in units, and the fastest it can swing, in rad/s. A
// 9-unit street takes a U-turn at this radius with a little kerb to spare.
const TURN_RADIUS = 3.2;
const TURN_MAX = 3.4;
// The speed the turn rate is paid for at when the car is slower than that — so a taxi nosed into
// a wall, or pulling away from a stop, can still be pointed somewhere.
const TURN_FLOOR_V = 3.5;
// How hard the swing chases the stick: rad/s of turn per radian of error.
const TURN_GAIN = 9;
// How fast the direction of travel catches the nose, per second. Lower is more slide.
const GRIP = 9;
const GRIP_LOCO = 5.5;
// The heading magnet: a push this close to a street's direction is that direction, in radians.
const ASSIST = (16 * Math.PI) / 180;
// ...and how fast a hands-off heading that close settles onto it, per second.
const SETTLE = 3;
// Added to a road's half-width for the body's *centre*: negative keeps it this far inside the kerb
// line, which with a 0.85 half-width body is a wheel on the pavement, not a car.
const KERB_GIVE = -0.55;
// Speed kept per second of grinding along a wall.
const SCRAPE_KEEP = 0.25;

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

/** The road corridors of a network: `inside(x, z)` is whether a body centre may be there. */
export function roadCorridors(net = cityNetwork(), give = KERB_GIVE) {
  const segs = net.edges.map((e) => {
    const a = net.nodeById.get(e.a);
    const b = net.nodeById.get(e.b);
    return { ax: a.x, az: a.z, bx: b.x, bz: b.z, half: e.halfWidth + give };
  });
  return {
    inside(x, z) {
      for (const s of segs) {
        if (toSegment(x, z, s.ax, s.az, s.bx, s.bz).dist <= s.half) return true;
      }
      return false;
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
 */
export function createFreeDrive({ taxi, stick, toScreen, live, assist = true, net = cityNetwork() }) {
  const roads = roadCorridors(net);
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
  // Direction of travel, as a yaw. Trails `yaw` under GRIP.
  let course = 0;

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
    course = yaw;
    taxi.free = true;
  }

  function end() {
    active = false;
    if (!taxi.free) return;
    project();
    taxi.free = false;
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

    // --- Speed. `taxi.v` is shared with the collision detector, which scrubs it on a hit.
    let v = taxi.v;
    const want = taxi.braking || taxi.stalled || taxi.stun > 0 ? 0
      : taxi.boost ? FREE_LOCO_SPEED : SPEED;
    if (v < want) v = Math.min(want, v + ACCEL * dt);
    else v = Math.max(want, v - (want === 0 ? BRAKE : COAST) * dt);

    // --- Heading.
    const push = stick();
    let target = null;
    if (push) {
      const g = screenToGround(push.dx, push.dy, toScreen);
      if (g) target = Math.atan2(-g.z, g.x);
    }
    if (target != null) {
      if (assist) target = magnet(target);
      const err = wrap(target - yaw);
      const rate = Math.min(TURN_MAX, Math.max(v, TURN_FLOOR_V) / TURN_RADIUS);
      yaw = wrap(yaw + Math.max(-rate, Math.min(rate, err * TURN_GAIN)) * dt);
    } else if (assist) {
      const settle = magnet(yaw);
      yaw = wrap(yaw + wrap(settle - yaw) * Math.min(1, SETTLE * dt));
    }
    course = wrap(course + wrap(yaw - course) * Math.min(1, (taxi.boost ? GRIP_LOCO : GRIP) * dt));

    // --- Move, and keep to the road: whole step, else whichever axis is still open.
    const step = v * dt;
    const mx = Math.cos(course) * step;
    const mz = -Math.sin(course) * step;
    if (roads.inside(x + mx, z + mz)) {
      x += mx; z += mz;
    } else {
      const openX = roads.inside(x + mx, z);
      const openZ = roads.inside(x, z + mz);
      // What is left of the speed is the part that ran along the wall: a glancing kerb costs a
      // little, square on costs it all. `WALL_CRAWL` is what the engine holds against a wall, so
      // the car can still be steered off it.
      let kept = 0;
      if (openX && (!openZ || Math.abs(mx) >= Math.abs(mz))) { x += mx; kept = Math.abs(mx); }
      else if (openZ) { z += mz; kept = Math.abs(mz); }
      v = Math.max(Math.min(v, WALL_CRAWL), (dt > 0 ? kept / dt : 0) * Math.pow(SCRAPE_KEEP, dt));
    }

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
    place(nx, nz, nyaw) { x = nx; z = nz; yaw = nyaw; course = nyaw; },
  };
}
