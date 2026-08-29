import { DIR } from '../city/grid.js';
import { APRON_Y } from '../city/burgerjoint.js';
import { CAR_LEN, SPEED, releaseCar, stageCar } from '../sim/traffic.js';

// The drive-through: which ambient cars pull into the burger joint, what they do while they are in
// there, and how they get back onto the road.
//
// The building and the lane it runs on are `city/burgerjoint.js`; this is only the behaviour. The
// split is the same one `city/garage.js` and `game/opening.js` have, and so is the mechanism —
// **a car in the lot is out of the traffic model entirely**. It has to be: a drive-through lane is
// not anywhere on the road network and a car sitting at a window cannot be expressed as a lane
// coordinate. `stageCar` in sim/traffic.js is that split (out of every simulation loop, still in
// the render pass), which is what lets a car in here keep its own suspension, its brake lights and
// its indicators while something else decides where it is.
//
// Two consequences of that worth knowing before changing anything here:
//
//   - A staged car is invisible to the lane bookkeeping the *instant* it is staged, so the traffic
//     behind it stops seeing it while it is still physically swinging off the carriageway. That is
//     safe only because the turn-in is quick: the entry arc is 3.1 units and a car takes it at
//     about 5 u/s, so it is off the road inside 0.4s, and a follower held at `MIN_GAP` (5.3) cannot
//     close that in the time available. Slowing a car down *before* it turns in — which is what a
//     real driver does — would need a hook inside the traffic model, not a module out here.
//   - Nothing in here can crash into anything. `sim/collisions.js` only ever tests the *taxi*, and
//     only while it is boosting, so a car crossing the kerb is not checked against ambient traffic
//     at all. The gap check before the exit (`mergeClear`) is therefore what stops a car pulling
//     out through another one, and not a safety net under it.
//
// **PROTOTYPE.** Cars only — see `eligible`. A box truck at a drive-through is a good joke and a
// bad fit: it is 5.6 long against a 2-unit turn radius, and it would ride the kerb through both
// arcs.

/**
 * Share of the cars passing the mouth of the lane that pull into it.
 *
 * High for a restaurant and about right for a *toy* one: the lane is scenery, and scenery nobody
 * ever catches running is scenery that may as well not be there. What it is actually tuned against
 * is how much of the time there is a car in the lot at all, measured over 24 minutes of traffic per
 * density — a run plays between 12 and 22 cars (`carsStart`/`carsEnd` in game/difficulty.js):
 *
 *     12 cars   1.3 pull in/min   a car in the lot 28% of the time
 *     18 cars   1.5 pull in/min                    34%
 *     24 cars   2.2 pull in/min                    46%
 *
 * So a player who drives past sees it running about a third of the time early and about half of it
 * late, and never sees a queue standing out into the road.
 */
const ENTER_CHANCE = 0.4;
/**
 * How long a car that has just been served will drive past without stopping again.
 *
 * Not politeness — geometry. The lane goes out onto the road that runs down the joint's *other*
 * side, which meets the road the mouth is on at the block's own corner: a car that leaves and turns
 * left is back at the driveway one junction later. Measured over thirty minutes of traffic, the
 * median gap between a car leaving the lot and pulling into it again was **3.1 seconds**, and 64 of
 * 71 repeat visits were inside half a minute. That is one car doing laps of a burger joint, in
 * front of a player who can see the whole block at once.
 *
 * Forty seconds is enough road to break the loop and nothing like enough to be a rule about
 * appetite. Blocking those laps also removes the passes they were making, so `ENTER_CHANCE` above
 * carries the rate instead — see the note there.
 */
const FED_COOLDOWN = 40;
/**
 * How many cars fit in the lot at once, and how close they stand.
 *
 * Tighter than the road's own `MIN_GAP` (5.3) on purpose: that number is a *following* distance,
 * chosen so a car at cruise can stop behind the one in front. A drive-through queue is stationary
 * or crawling, and a real one is nose to tail. 4.2 leaves 0.8 of a unit of daylight between two
 * 3.4-long cars.
 *
 * Three is what the lane holds between the two kerbs at that spacing — 15.4 units of path from the
 * mouth to the exit against 8.4 of queue — and the ceiling matters rather more here than it looks:
 * a fourth car would be held at the *mouth*, which is on the carriageway, and a stationary staged
 * car on a road is invisible to every other car on it (see the note at the top).
 */
const CAPACITY = 3;
const GAP = CAR_LEN + 0.8;

// The approach window, as x on the lane the mouth is on. A car is rolled for once, when it first
// comes inside `DECIDE_AHEAD` of the driveway, and taken on the frame it reaches it — one roll per
// approach rather than one per frame, which is the whole reason `decided` exists.
const DECIDE_AHEAD = 6;
const CATCH = 1.0;
/** How far off the lane centre a car may be and still count as on it — the weave, mostly. */
const LANE_TOL = 1.3;

// Speeds through the lot, in u/s.
const ENTRY_V = 4.6;      // round the turn in off the road
const LANE_V = 3.0;       // between the windows: a crawl, which is what a queue moves at
const EXIT_V = 6.0;       // pulling out, so the car arrives on the lane at something like traffic speed
const ACCEL = 4.5;
const BRAKE = 7.0;
/**
 * The speed a car is allowed to enter the lot at.
 *
 * It arrives at whatever the road was doing — up to `SPEED`, 8.5 — and a 2-unit radius is not a
 * corner you take at 8.5. There is no way to shed it beforehand (see the note at the top about the
 * lane bookkeeping), so it comes off in one step at the driveway, which the pitch spring and the
 * brake lights both pick up on their own: a car braking hard to make a turn-in it left slightly
 * late, which is exactly what it is.
 */
const ENTRY_CAP = 5.2;

// How long a car sits at each stop, before jitter. The board is the shorter of the two because a
// queue that stalls at the *front* moves; one that stalls at the back is a car parked in a lane.
const ORDER_DWELL = 2.6;
const PICKUP_DWELL = 3.8;
const DWELL_JITTER = 1.1;

// The gap a car wants on the road before it pulls out, as a box on the lane it is joining rather
// than a radius around the merge point — see `mergeClear` in game/opening.js, which is the same
// check for the same manoeuvre (a right turn into the near lane) and carries the reasoning. The
// numbers are that one's, less a little behind: a car leaving a lot accelerates from a standstill
// where the taxi leaving the garage is already rolling.
const MERGE_LATERAL = 2.6;
const MERGE_BEHIND = 10;
const MERGE_AHEAD = 4;
/** ...and how long it will wait for one. Traffic is not obliged to leave a gap. */
const HOLD_MAX = 8;

// The two kerb crossings, as a window of arc length either side of the lip. Wider than the ramp
// mesh (1.6 units) because it is describing a 3.4-unit car crossing it, not the slab — the same
// argument `DROP_FROM`/`DROP_TO` make in game/opening.js.
const KERB_BEFORE = 0.4;
const KERB_AFTER = 1.3;
// Into `pitchV`, in rad/s. Two impulses rather than a canned animation: the pitch spring in
// traffic.js is underdamped, so one shove buys a dip, a rebound and a settle. Half of what the
// taxi gets coming out of the garage, because these are dropped kerbs taken at half the speed.
const KERB_PITCH = 0.45;

const smoothstep = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));

/**
 * @param site  the joint's geometry — see `burgerSite` in city/burgerjoint.js
 * @param cars  every vehicle, for the roll at the mouth and the gap check at the exit
 * @param rng   the run's generator: who pulls in and how long they sit is part of the situation,
 *              not part of the map
 */
export function createDriveThru({ site, cars, rng }) {
  const { path, enterS, exitS, holdS, orderS, pickupS, merge } = site;
  const stops = [orderS, pickupS];

  /** Cars in the lot, front of the queue first. */
  const queue = [];
  /** One roll per approach: car -> did it want a burger. Pruned as cars leave the window. */
  const decided = new Map();
  /** ...and car -> the clock reading it last left the lot at. See `FED_COOLDOWN`. */
  const fed = new Map();
  let served = 0;
  let clock = 0;

  const eligible = (car) => !car.isTaxi && !car.isTruck && !car.crashed && !car.staged
    && car.state === 'drive' && car.d === DIR.NX
    && Math.abs(car.z - site.entry.z) < LANE_TOL;

  /** Has this one just been through? */
  const fedRecently = (car) => clock - (fed.get(car) ?? -Infinity) < FED_COOLDOWN;

  /** Is there room on the lane the car is about to land on? */
  const mergeClear = () => !cars.some((car) => !car.crashed && !car.staged
    && Math.abs(car.x - merge.point.x) < MERGE_LATERAL
    && car.z > merge.point.z - MERGE_BEHIND && car.z < merge.point.z + MERGE_AHEAD);

  const dwellFor = (index) => (index === 0 ? ORDER_DWELL : PICKUP_DWELL)
    + rng.range(0, DWELL_JITTER);

  /**
   * How high the body rides at this point on the path: up on the lot's asphalt between the two
   * kerbs, down on the road either side of them. `APRON_Y` is the joint's own surface height, taken
   * from the module that lays it rather than recomputed here — the two have to be the same number
   * or the cars float over their own lane.
   */
  function liftAt(s) {
    const up = smoothstep((s - (enterS - KERB_BEFORE)) / (KERB_BEFORE + KERB_AFTER));
    const down = smoothstep((s - (exitS - KERB_AFTER)) / (KERB_BEFORE + KERB_AFTER));
    return APRON_Y * (up - down);
  }

  /** Cruise speed for this part of the path — the arcs are corners and the lot is a car park. */
  const cruiseAt = (s) => {
    if (s < enterS) return ENTRY_V;
    if (s < holdS) return LANE_V;
    return EXIT_V;
  };

  /** Where on the path a car standing at `s` is, and which way it is pointing. */
  const poseAt = (s) => {
    const p = path.at(s);
    const t = path.tangentAt(s);
    return { x: p.x, z: p.z, yaw: Math.atan2(-t.z, t.x) };
  };

  function take(car, s0) {
    const v = Math.min(car.v, ENTRY_CAP);
    const pose = poseAt(s0);
    // Staged *at* its pose rather than at the origin: `stageCar` primes the steering and wheel
    // differencers off the yaw it is handed, and a car staged pointing east and then placed
    // pointing north slams its front wheels lock to lock on the frame it turns in.
    stageCar(car, pose.x, pose.z, pose.yaw);
    // `stageCar` zeroes the speed and its differencer both. Restore them together: left at 0,
    // the next render frame reads a whole entry speed's worth of acceleration out of one frame
    // and stands the car on its back bumper.
    car.v = v;
    car.prevV = v;
    car.stageSignal = 'right';
    queue.push({ car, s: s0, v, next: 0, wait: 0, dwell: dwellFor(0), held: 0, mounted: false, dropped: false });
  }

  /** Everything a staged car needs written for it, since it is out of every loop that would. */
  function place(entry, dt) {
    const { car } = entry;
    const p = path.at(entry.s);
    const t = path.tangentAt(entry.s);
    car.x = p.x;
    car.z = p.z;
    car.yaw = Math.atan2(-t.z, t.x);
    car.v = entry.v;
    car.travelled += entry.v * dt;
    // What the idle bob is scaled by. Written here because the loop that maintains it is one of
    // the ones a staged car skips.
    car.speedFactor = entry.v / SPEED;
    car.kerbLift = liftAt(entry.s);
    // Indicating on the way in and on the way out, and nothing in between: a car crossing a lot is
    // not signalling a turn, and a blinker held for the whole visit reads as a fault.
    car.stageSignal = entry.s < enterS || entry.s >= holdS ? 'right' : null;

    // Up the dropped kerb on the way in and down the other on the way out, with the shove into the
    // pitch spring that makes each of them a kerb rather than a ramp in the air.
    if (!entry.mounted && entry.s > enterS) {
      entry.mounted = true;
      car.pitchV += KERB_PITCH;
    }
    if (!entry.dropped && entry.s > exitS) {
      entry.dropped = true;
      car.pitchV -= KERB_PITCH;
    }
  }

  function update(dt) {
    clock += dt;

    // --- Take on whoever wants a burger -------------------------------------
    for (const car of cars) {
      if (!eligible(car)) { decided.delete(car); continue; }
      // The lane the mouth is on runs −X, so a car short of the driveway is at a *greater* x.
      const ahead = car.x - site.entry.x;
      if (ahead > DECIDE_AHEAD || ahead < -CATCH) { decided.delete(car); continue; }
      if (!decided.has(car)) decided.set(car, !fedRecently(car) && rng.chance(ENTER_CHANCE));
      if (ahead > 0) continue;

      const wants = decided.get(car);
      decided.delete(car);
      if (!wants) continue;
      if (queue.length >= CAPACITY) continue;
      // ...and only if the back of the queue has cleared the mouth, or the car turns in on top of
      // one that has not moved up yet.
      if (queue.length && queue[queue.length - 1].s < GAP) continue;
      // `ahead` is negative here: how far past the driveway the car got this frame. The entry arc
      // leaves tangent to the lane, so that overshoot is the same distance along the path.
      take(car, -ahead);
    }

    // --- Drive the lot ------------------------------------------------------
    // Front of the queue first, so each car has its leader's settled position to measure against.
    for (let index = 0; index < queue.length; index++) {
      const entry = queue[index];

      // How far this car may get this frame, from whichever of the three things is nearest: the
      // stop it has not finished with, the kerb it is waiting to cross, or the car in front.
      let limit = path.total;
      if (entry.next < stops.length) {
        limit = stops[entry.next];
      } else if (entry.s < holdS) {
        // Past the last window and up to the kerb. The question closes at the line, exactly as it
        // would in traffic: a car half way round the last arc is committed.
        if (!mergeClear() && entry.held < HOLD_MAX) {
          entry.held += dt;
          limit = holdS;
        }
      }
      const leader = queue[index - 1];
      if (leader) limit = Math.min(limit, leader.s - GAP);

      // Brake to a stop *on* the limit rather than at it: the speed a car may be doing with `room`
      // left is the speed it can still shed in that distance. Which is also what makes a queue
      // shuffle forward the way one does — each car's cap is set by where the car ahead of it got
      // to, so the whole line eases rather than lurching.
      const room = Math.max(0, limit - entry.s);
      const cap = Math.min(cruiseAt(entry.s), Math.sqrt(2 * BRAKE * room));
      entry.v = cap < entry.v
        ? Math.max(cap, entry.v - BRAKE * dt)
        : Math.min(cap, entry.v + ACCEL * dt);
      entry.s = Math.min(limit, entry.s + entry.v * dt);

      // Sitting at a window. Keyed on being *at* the stop and stopped, not on the clock, so a car
      // held back by the one in front does not serve its own dwell from the middle of the lane.
      if (entry.next < stops.length && entry.s >= stops[entry.next] - 0.06 && entry.v < 0.25) {
        entry.wait += dt;
        if (entry.wait >= entry.dwell) {
          entry.next += 1;
          entry.wait = 0;
          entry.dwell = entry.next < stops.length ? dwellFor(entry.next) : 0;
          if (entry.next >= stops.length) served += 1;
        }
      }

      place(entry, dt);
    }

    // --- Hand the front of the queue back to traffic -------------------------
    // Only ever the front car, and only once it has run out of path. `releaseCar` fails when the
    // lane it wants is not in the network, which the site filter rules out — but if it ever does,
    // the car simply stays at the merge point and tries again next frame rather than being dropped
    // on nothing.
    while (queue.length && queue[0].s >= path.total) {
      const entry = queue[0];
      const v = entry.v;
      if (!releaseCar(entry.car, merge.d, merge.i, merge.j, merge.back)) break;
      // Speed survives the handover: a car that arrives on the lane at a standstill has visibly
      // been teleported there.
      entry.car.v = v;
      entry.car.prevV = v;
      fed.set(entry.car, clock);
      queue.shift();
    }
  }

  /**
   * Fill the lot, for the review framings.
   *
   * Shot mode ticks the world once and freezes it, so a drive-through left to fill itself is a
   * drive-through photographed empty — the same problem the helicopter, the flock and the roadworks
   * all have, and the same answer they use. Cars are taken from wherever they happen to be, which
   * is what "staged" means: the point of the shot is the lot, not the road the car came off.
   *
   * Places them at the window, at the board, and one behind, and sets each one's clocks so a
   * screenshot catches a queue rather than three cars that have all just arrived.
   */
  function settle() {
    // One pulling out, one at the window and one queued behind it — rather than one at each stop,
    // which does not fit: on the narrowest block the board and the window are 3.2 apart and two
    // cars need 4.2. That is a fact about the lot rather than about the shot, and the live queue
    // meets it the same way, by waiting short of the board until the window clears.
    const at = [
      { s: holdS - 1.2, next: 2 },
      { s: pickupS, next: 1 },
      { s: pickupS - GAP, next: 0 },
    ];
    for (const spot of at) {
      // Never behind the mouth: the entry arc is on the carriageway, and a car parked there for a
      // screenshot is a car parked in the road.
      if (spot.s < enterS || queue.length >= CAPACITY) break;
      // Any car that is on a road and not the player's. Unlike the live path this does not care
      // which road or which way — a still has no continuity to keep.
      const car = cars.find((c) => !c.isTaxi && !c.isTruck && !c.crashed && !c.staged
        && c.state === 'drive');
      if (!car) break;
      const pose = poseAt(spot.s);
      stageCar(car, pose.x, pose.z, pose.yaw);
      queue.push({ car, s: spot.s, v: 0, next: spot.next, wait: 0, dwell: dwellFor(spot.next),
        held: 0, mounted: true, dropped: false });
    }
    // One frame's worth of placement, with no time passing: enough to write every transform.
    for (const entry of queue) place(entry, 0);
  }

  return {
    update,
    settle,
    /**
     * For the ⚙️ panel and the probe: who is in the lot, how many have been through it, and the
     * module's own clock — which is the cheapest way to tell from a live page that this is being
     * ticked at all, given the lot is empty most of the time by design.
     */
    state: { queue, served: () => served, clock: () => clock },
  };
}
