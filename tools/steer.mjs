/**
 * Pac-Man steering (src/game/steer.js), headless: what a screenshot cannot say.
 *
 * 1. A swipe means what it looks like: `readSwipe` against the game's own camera axes.
 * 2. A steered taxi arrives: a "player" who queues the next turn of the best route at every corner
 *    — through the real `steerPlan`, the real one-step route and the real traffic model — reaches
 *    every target, with no red run and no route desync.
 * 3. Hands off, it goes straight on wherever it can and never stops at a dead end.
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic, boostCruise, SPEED } from '../src/sim/traffic.js';
import { createLayout } from '../src/city/layout.js';
import { findRoute, planOrigin, allIntersections } from '../src/game/route.js';
import { intersectionCentre, ARRIVE_RADIUS } from '../src/game/fares.js';
import { steerPlan, readSwipe, decisionLane, exitDirs } from '../src/game/steer.js';
import { RIGHT, UP, VIEW_DIR } from '../src/game/camera.js';
import { snapStick } from '../src/game/joystick.js';
import { DIR, leftOf, lineX, lineZ, GRID_I } from '../src/city/grid.js';
import { createFreeDrive, roadCorridors, screenToGround, magnet } from '../src/game/freedrive.js';
import { cityNetwork } from '../src/city/roadnet.js';
import { deadZone, nearestInDirection, STICK_DEAD } from '../src/game/gamepad.js';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// --- 1. Swipes ----------------------------------------------------------------------------------
// The game's projection, up to scale: screen right is RIGHT, and a ground vector's screen-up is
// its UP component foreshortened by the camera's elevation.
const lift = VIEW_DIR.y;
const toScreen = (dx, dz) => {
  const v = new THREE.Vector3(dx, 0, dz);
  return { x: v.dot(RIGHT), y: -v.dot(UP) * lift };
};
// Heading +X runs down-right on screen; its right (+Z) is down-left and its left (-Z) up-right.
check('swipe along the heading is straight on', readSwipe(1, 0.6, DIR.PX, toScreen) === 'straight');
check('swipe against the heading is backwards', readSwipe(-1, -0.6, DIR.PX, toScreen) === 'back');
check('a thumb\'s "up" heading +X turns toward -Z', readSwipe(0, -1, DIR.PX, toScreen) === DIR.NZ);
check('a thumb\'s "down" heading +X turns toward +Z', readSwipe(0, 1, DIR.PX, toScreen) === DIR.PZ);
// Foreshortening lays every street ~29° off the horizontal, so heading -Z (up-right) a sideways
// thumb is nearly along the street, and it is up and down that turn.
check('a thumb\'s "up" heading -Z turns toward -X', readSwipe(0, -1, DIR.NZ, toScreen) === DIR.NX);
check('a thumb\'s "down" heading -Z turns toward +X', readSwipe(0, 1, DIR.NZ, toScreen) === DIR.PX);
check('a thumb\'s "left" heading -Z is backwards', readSwipe(-1, 0, DIR.NZ, toScreen) === 'back');

// The stick snaps absolutely to the street directions as drawn: right-and-up is -Z, right-and-down
// +X, left-and-up -X, left-and-down +Z — whatever the heading.
check('stick up-right is -Z', snapStick(1, -0.5, toScreen) === DIR.NZ);
check('stick down-right is +X', snapStick(1, 0.5, toScreen) === DIR.PX);
check('stick up-left is -X', snapStick(-1, -0.5, toScreen) === DIR.NX);
check('stick down-left is +Z', snapStick(-1, 0.5, toScreen) === DIR.PZ);
// Heading +X (down-right), the way back is -X (up-left). Straight up sits on the border between
// -Z and -X; leaving the way back out makes it the left turn rather than a push that does nothing.
const fromPX = { exclude: DIR.NX };
check('heading +X, stick straight up is the left turn (-Z)', snapStick(0, -1, toScreen, fromPX) === DIR.NZ);
check('heading +X, stick straight left is the right turn (+Z)', snapStick(-1, 0.05, toScreen, fromPX) === DIR.PZ);
check('the way back is never picked', [0, 1, 2, 3, 4, 5, 6, 7].every((k) => {
  const a = (k * Math.PI) / 4 + 0.1;
  return snapStick(Math.cos(a), Math.sin(a), toScreen, fromPX) !== DIR.NX;
}));
// Squarely backwards (up-left, along -X) says nothing rather than handing over a turn.
check('heading +X, stick squarely backwards is nothing', snapStick(-1, -0.55, toScreen, fromPX) === null);
// A held push keeps its direction across a wobble over the border, and lets go of it well past it.
const nearRight = (deg) => [Math.cos((deg * Math.PI) / 180), -Math.sin((deg * Math.PI) / 180)];
check('a hold keeps -Z through a wobble just below the horizontal',
  snapStick(...nearRight(-5), toScreen, { prev: DIR.NZ }) === DIR.NZ);
check('fresh, the same push reads +X', snapStick(...nearRight(-5), toScreen) === DIR.PX);
check('a hold gives -Z up once the push is well past the border',
  snapStick(...nearRight(-20), toScreen, { prev: DIR.NZ }) === DIR.PX);

// --- 2. A steered taxi arrives -------------------------------------------------------------------
const STEP = 1 / 60;
const RUNS = Number(process.argv[2] ?? 20);
createLayout(makeRng(71624));
const traffic = createTraffic(makeRng(71624 + 44), new THREE.Scene(), 7);
const taxi = traffic.taxi;
traffic.warmup(10);

function drive(queueFor) {
  const at = decisionLane(taxi);
  const queued = at ? queueFor(at) : null;
  const plan = steerPlan(taxi, queued);
  taxi.route = plan.route;
  taxi.routeConsumed = false;
  traffic.update(STEP);
}

const rng = makeRng(4242);
const ints = allIntersections();
let arrived = 0;
let total = 0;
for (let run = 0; run < RUNS; run++) {
  const target = ints[rng.int(0, ints.length - 1)];
  const centre = intersectionCentre(target.i, target.j);
  let t = 0;
  let done = false;
  while (t < 120) {
    drive((at) => {
      const route = findRoute(planOrigin(taxi), target);
      const want = route?.[0];
      return want != null && want !== at.d ? want : null;
    });
    t += STEP;
    if (Math.hypot(taxi.x - centre.x, taxi.z - centre.z) < ARRIVE_RADIUS) { done = true; break; }
  }
  if (done) { arrived += 1; total += t; } else {
    console.log(`  miss (${target.i},${target.j}): taxi at (${taxi.x.toFixed(0)},${taxi.z.toFixed(0)})`);
  }
}
check(`steered taxi reaches every target (${arrived}/${RUNS})`, arrived === RUNS);
check('no red run while steering', traffic.stats.violations === 0, `${traffic.stats.violations}`);
check('no route desync while steering', traffic.stats.routeDesync === 0, `${traffic.stats.routeDesync}`);

// --- 2b. A push a beat late still wins the corner ------------------------------------------------
// Committed to a turn at the hold line, the taxi can still be asked for another exit in the run-up
// — straight on, or the other way — and takes it (`retakeCrossing` in sim/traffic.js). Before, a
// turn committed at the line overruled the stick and the car turned against it.
let retakes = 0;
let retaken = 0;
for (let t = 0; t < 240 && retakes < 12; t += STEP) {
  // Steer for turns, so the line commits to plenty of them.
  drive((at) => {
    const ex = exitDirs(at.lane).filter((d) => d !== at.d);
    return ex.length ? ex[0] : null;
  });
  if (taxi.state === 'turn' && taxi.turn.hand !== 'straight' && taxi.turnT * taxi.turnLen < 0.5) {
    const ex = exitDirs(taxi.lane).filter((d) => d !== taxi.dOut);
    if (!ex.length) continue;
    const want = ex[0];
    retakes += 1;
    taxi.lateTurn = Object.assign([want], { force: true });
    traffic.update(STEP);
    t += STEP;
    if (taxi.dOut === want) retaken += 1;
  }
}
// Forced, nothing refuses it — not oncoming traffic, not a full exit lane.
check(`a committed turn can be retaken in the run-up (${retaken}/${retakes})`,
  retakes >= 6 && retaken === retakes);
check('no red run after retakes', traffic.stats.violations === 0, `${traffic.stats.violations}`);

// --- 3. Hands off ------------------------------------------------------------------------
let turnedWithStraight = 0;
let deadEnds = 0;
let emptyRoute = 0;
let stillFor = 0;
let longestStill = 0;
let lastState = taxi.state;
for (let t = 0; t < 240; t += STEP) {
  const at = decisionLane(taxi);
  const straightThere = at ? exitDirs(at.lane).includes(at.d) : true;
  drive(() => null);
  if (taxi.state === 'drive' && !taxi.route.length) emptyRoute += 1;
  if (lastState === 'drive' && taxi.state === 'turn') {
    if (!straightThere) deadEnds += 1;
    if (taxi.turn.hand !== 'straight' && straightThere) turnedWithStraight += 1;
  }
  stillFor = taxi.v < 0.05 ? stillFor + STEP : 0;
  longestStill = Math.max(longestStill, stillFor);
  lastState = taxi.state;
  if (taxi.crashed) break;
}
check('hands off, the taxi goes straight on wherever it can', turnedWithStraight === 0,
  `${turnedWithStraight} turns taken with straight on available`);
check(`hands off, it turns out of a dead end on its own (${deadEnds} met)`, deadEnds > 0 && emptyRoute === 0,
  `${emptyRoute} frames with no route`);
// A red is 30s at most here; anything near a minute standing still is a car waiting on nobody.
check('hands off, it is never parked waiting for input', longestStill < 45, `${longestStill.toFixed(1)}s still`);
check('no red run hands off', traffic.stats.violations === 0, `${traffic.stats.violations}`);

// --- 4. The stick's lane ---------------------------------------------------------------------
// Steered by the stick, `stickLane` is the overtake: out pulls into the oncoming lane with no car
// and no Loco needed, in tucks back. Rams stay the player's (`canPass`).
let outAt = null;
let backAt = null;
taxi.stickLane = 'in';
for (let t = 0, phase = 'wait'; t < 120; t += STEP) {
  drive(() => null);
  const onLane = taxi.state === 'drive' && taxi.s < 2 && taxi.lane.length > 10;
  if (phase === 'wait' && onLane) { taxi.stickLane = 'out'; phase = 'out'; outAt = null; }
  else if (phase === 'out' && taxi.pass >= 0.99) { outAt = t; taxi.stickLane = 'in'; phase = 'in'; }
  else if (phase === 'in' && taxi.pass <= 0.01 && !taxi.passing) { backAt = t; break; }
  // A dead end or a corner while out sends it back in (steer.js) — start over on the next lane.
  if (phase === 'out' && taxi.state === 'turn' && taxi.turn.hand !== 'straight') {
    taxi.stickLane = 'in'; phase = 'wait';
  }
}
check('stick out pulls the taxi fully into the oncoming lane', outAt !== null);
check('stick in tucks it back', backAt !== null);

// Out in the oncoming lane, a left is taken from there (Tyler: "Why not just support turning left
// even when in the oncoming lane?"), and the pass ends on the lane after the corner. The path has to
// stay a path: no frame jumps further than the car can drive, which a frozen offset folding the
// arc over itself would.
let leftsFromOut = 0;
let leftsTried = 0;
let worstJump = 0;
let backAfter = 0;
let crashedOut = false;
let backwards = 0;
for (let t = 0, phase = 'wait', want = null, px = taxi.x, pz = taxi.z; t < 240 && leftsFromOut < 6; t += STEP) {
  drive((at) => (phase === 'turning' ? want : null));
  const step = Math.hypot(taxi.x - px, taxi.z - pz);
  worstJump = Math.max(worstJump, step - taxi.v * STEP);
  // An offset bigger than the arc's radius folds the path back on itself: the car runs backwards.
  if (step > 1e-4 && ((taxi.x - px) * Math.cos(taxi.yaw) - (taxi.z - pz) * Math.sin(taxi.yaw)) < -0.25 * step) backwards += 1;
  px = taxi.x; pz = taxi.z;
  if (taxi.crashed) { crashedOut = true; break; }
  const at = decisionLane(taxi);
  if (phase === 'wait' && taxi.state === 'drive' && taxi.s < 2 && at
    && exitDirs(at.lane).includes(leftOf(at.d))) {
    taxi.stickLane = "out"; want = leftOf(at.d); phase = "turning"; leftsTried += 1;
  } else if (phase === 'turning' && taxi.state === 'turn' && taxi.turn.hand !== 'straight') {
    if (taxi.dOut === want && taxi.pass > 0.9) leftsFromOut += 1;
    taxi.stickLane = 'in'; phase = 'after';
  } else if (phase === 'after' && taxi.state === 'drive') {
    if (taxi.pass <= 0.01) { backAfter += 1; phase = 'wait'; }
  }
}
check(`out in the oncoming lane, the left is taken from there (${leftsFromOut}/${leftsTried})`,
  leftsFromOut >= 4 && leftsFromOut >= leftsTried - 1);
check('and the pass ends on the lane after the corner', backAfter >= leftsFromOut - 1, `${backAfter}`);
check('a corner from the oncoming lane never runs backwards', backwards === 0, `${backwards} frames`);
check('a corner from the oncoming lane never jumps', worstJump < 0.3 && !crashedOut,
  `${worstJump.toFixed(2)} units${crashedOut ? ', crashed' : ''}`);
taxi.stickLane = undefined;

// --- 5. The stick's nudge -----------------------------------------------------------------------
// The thumb's sideways push leans the taxi across its lane, paced by road: full lean within a few
// units, never more than NUDGE_MAX, back to the middle when let go, and no slide while stopped.
let peakNudge = 0;
let leaned = false;
for (let t = 0; t < 30; t += STEP) {
  taxi.stickNudge = t < 4 ? 1 : 0;
  drive(() => null);
  peakNudge = Math.max(peakNudge, Math.abs(taxi.nudge));
  if (t > 1 && t < 4 && taxi.state === 'drive' && taxi.v > 3 && taxi.nudge > 0.5) leaned = true;
}
check('a sideways push leans the taxi across its lane', leaned, `peak ${peakNudge.toFixed(2)}`);
check('the lean never passes NUDGE_MAX', peakNudge <= 0.6 + 1e-6, peakNudge.toFixed(3));
check('let go, it settles back to the middle', Math.abs(taxi.nudge) < 0.05, taxi.nudge.toFixed(3));
taxi.stickNudge = 0;

// --- 6. Free driving (game/freedrive.js) ----------------------------------------------------------
// The stick as a heading, the taxi as a body off the lanes. A screen push comes back as the ground
// direction it was drawn from; the body stays on the island, out of the river and out of anything
// solid, and is free to cross a pavement; a "player" who points the stick at the next junction of
// the best route gets everywhere; hands off it stops against whatever ends the ground; a turn at
// Loco carries on before it bites and then grips; and handed back, the traffic model picks the car
// up on a lane and drives it on.
{
  const back = (dx, dz) => { const v = toScreen(dx, dz); return screenToGround(v.x, v.y, toScreen); };
  const round = [[1, 0], [0, 1], [-1, 0], [0, -1], [0.6, -0.8]].every(([dx, dz]) => {
    const g = back(dx, dz);
    return g && Math.hypot(g.x - dx, g.z - dz) < 1e-6;
  });
  check('a screen push comes back as the ground direction it was drawn from', round);
  check('the magnet takes a heading 10° off a street onto it', Math.abs(magnet(0.17)) < 1e-9);
  check('the magnet leaves a 30° heading alone', Math.abs(magnet(0.52) - 0.52) < 1e-9);

  const net = cityNetwork();
  let aim = null;      // world point the "thumb" is pointing the taxi at, or null for hands off
  let isLive = true;
  let push = null;     // a raw stick vector, for the tests that hold a direction rather than aim
  const free = createFreeDrive({
    taxi,
    toScreen,
    live: () => isLive,
    stick: () => {
      if (push) return push;
      if (!aim) return null;
      const v = toScreen(aim.x - taxi.x, aim.z - taxi.z);
      const l = Math.hypot(v.x, v.y) || 1;
      return { dx: (v.x / l) * 30, dy: (v.y / l) * 30, len: 30 };
    },
  });
  const tick = () => { free.update(STEP); traffic.update(STEP); };
  const roads = { inside: free.drivable };

  let offRoad = 0;
  let freeArrived = 0;
  let freeTime = 0;
  const FREE_RUNS = 10;
  for (let run = 0; run < FREE_RUNS; run++) {
    const target = ints[rng.int(0, ints.length - 1)];
    const centre = intersectionCentre(target.i, target.j);
    for (let t = 0; t < 120; t += STEP) {
      // Aim at the junction the route goes through next — the one ahead, or the target itself.
      const route = findRoute(planOrigin(taxi), target);
      const next = intersectionCentre(taxi.i, taxi.j);
      aim = route && route.length ? next : centre;
      if (Math.hypot(taxi.x - next.x, taxi.z - next.z) < 3 && route?.length) {
        // In the box: point down the street the route leaves by.
        const [vx, vz] = [[1, 0], [0, 1], [-1, 0], [0, -1]][route[0]];
        aim = { x: taxi.x + vx * 10, z: taxi.z + vz * 10 };
      }
      tick();
      if (!roads.inside(taxi.x, taxi.z)) offRoad += 1;
      if (Math.hypot(taxi.x - centre.x, taxi.z - centre.z) < ARRIVE_RADIUS) { freeArrived += 1; freeTime += t; break; }
    }
  }
  check(`free-driven, the taxi reaches every target (${freeArrived}/${FREE_RUNS})`, freeArrived === FREE_RUNS);
  check('free-driven, the body never leaves the island or enters the river', offRoad === 0, `${offRoad} frames`);
  check('free-driven, the taxi is off the traffic model', taxi.free === true);

  // Hands off: it rolls on its heading until the ground runs out, and stops against the edge.
  aim = null;
  taxi.stalled = false;
  let rolled = 0;
  for (let t = 0; t < 40; t += STEP) {
    const px = taxi.x; const pz = taxi.z;
    tick();
    rolled += Math.hypot(taxi.x - px, taxi.z - pz);
    if (!roads.inside(taxi.x, taxi.z)) offRoad += 1;
  }
  check('hands off, it keeps rolling', rolled > 20, `${rolled.toFixed(1)} units`);
  check('hands off, it ends up stopped against the edge of the ground', taxi.v <= 1.01 && offRoad === 0,
    `v ${taxi.v.toFixed(2)}`);

  // Weight and grip. From a straight run at full Loco, snap the stick a quarter turn left. The taxi
  // must carry on a while before its course comes round (momentum), and once the nose is round the
  // velocity must be back on it within half a second (no ice).
  {
    const corridors = roadCorridors(net);
    const lane = net.lanes.filter((l) => l.path && l.length > 12)[0];
    const p0 = lane.path.at(0);
    const p1 = lane.path.at(lane.length);
    const yaw0 = Math.atan2(-(p1.z - p0.z), p1.x - p0.x);
    const open = createFreeDrive({ taxi, toScreen, live: () => true, stick: () => push, net,
      locoSpeed: () => boostCruise() });
    // An open plain: this instance has no `solid`, and the test is over before the island ends.
    open.update(STEP);
    open.place(p0.x, p0.z, yaw0);
    taxi.boost = true;
    taxi.braking = false;
    taxi.stalled = false;
    const hold = (yaw) => { const v = toScreen(Math.cos(yaw), -Math.sin(yaw)); push = { dx: v.x, dy: v.y, len: 30 }; };
    hold(yaw0);
    taxi.v = boostCruise();
    for (let t = 0; t < 0.3; t += STEP) open.update(STEP);
    const topSeen = taxi.v;
    const at = { x: taxi.x, z: taxi.z };
    hold(yaw0 + Math.PI / 2);
    let carried = 0;       // distance along the old heading before the nose is 80° round
    let roundAt = null;
    let settled = null;    // seconds after the nose came round that the course matched it
    let px = taxi.x; let pz = taxi.z;
    for (let t = 0; t < 3; t += STEP) {
      open.update(STEP);
      const course = Math.atan2(-(taxi.z - pz), taxi.x - px);
      px = taxi.x; pz = taxi.z;
      const turned = Math.abs(Math.atan2(Math.sin(taxi.yaw - yaw0), Math.cos(taxi.yaw - yaw0)));
      if (roundAt == null && turned > (80 * Math.PI) / 180) {
        roundAt = t;
        carried = (taxi.x - at.x) * Math.cos(yaw0) - (taxi.z - at.z) * Math.sin(yaw0);
      }
      const off = Math.abs(Math.atan2(Math.sin(course - taxi.yaw), Math.cos(course - taxi.yaw)));
      if (roundAt != null && settled == null && turned > (88 * Math.PI) / 180 && off < (3 * Math.PI) / 180) settled = t - roundAt;
    }
    push = null;
    taxi.boost = false;
    check('free-driven, Loco tops out at the game\'s own Loco speed', Math.abs(topSeen - boostCruise()) < 0.5,
      `${topSeen.toFixed(1)} of ${boostCruise().toFixed(1)}`);
    check('a quarter turn at Loco carries the taxi on before it comes round (weight)',
      roundAt != null && roundAt > 0.5 && carried > 6, `${roundAt?.toFixed(2)}s, ${carried.toFixed(1)} units`);
    check('...and once the nose is round, the course is back on it within half a second (grip)',
      settled != null && settled < 0.5, `${settled?.toFixed(2)}s`);
    // A pavement is open ground and a building is not.
    console.log(`free quarter turn at Loco: nose round in ${roundAt?.toFixed(2)}s, ${carried.toFixed(1)} units carried, course back on the nose ${settled?.toFixed(2)}s later`);
    // The first spot off the side of any lane that is not road and not river or coast.
    let kerb = null;
    for (const l of net.lanes) {
      if (kerb || !l.path) continue;
      const a0 = l.path.at(0);
      const a1 = l.path.at(l.length);
      const mid = l.path.at(l.length / 2);
      const side = { x: -(a1.z - a0.z) / l.length, z: (a1.x - a0.x) / l.length };
      for (let r = 0; r < 12 && !kerb; r += 0.25) {
        const q = { x: mid.x + side.x * r, z: mid.z + side.z * r };
        if (!corridors.onRoad(q.x, q.z)) { if (corridors.inside(q.x, q.z)) kerb = q; break; }
      }
    }
    const walled = roadCorridors(net, (x, z) => kerb && Math.hypot(x - kerb.x, z - kerb.z) < 0.5);
    check('a pavement is open ground', kerb && corridors.inside(kerb.x, kerb.z));
    check('...and a building standing on it is not', kerb && !walled.inside(kerb.x, kerb.z));
    // A wall met at a slant is a scrape along it, not a stop: into the east coast at 45°.
    open.place(lineX(GRID_I) - 1, lineZ(0) + 3, -Math.PI / 4);
    taxi.v = SPEED;
    hold(-Math.PI / 4);
    const z0 = lineZ(0) + 3;
    for (let t = 0; t < 1.5; t += STEP) open.update(STEP);
    push = null;
    check('a wall met at a slant is a scrape along it, not a stop', taxi.v > 0.6 * SPEED && taxi.z - z0 > 6,
      `v ${taxi.v.toFixed(1)}, ${(taxi.z - z0).toFixed(1)} units along`);
    free.place(taxi.x, taxi.z, taxi.yaw);
  }

  // Handed back (a scripted trip takes the wheel): on a lane, in the model, and moving again.
  isLive = false;
  free.update(STEP);
  const handed = taxi.free === false && taxi.lane && taxi.s >= 0 && taxi.s <= taxi.lane.length;
  let moved = 0;
  for (let t = 0; t < 20; t += STEP) {
    const px = taxi.x; const pz = taxi.z;
    drive(() => null);
    moved += Math.hypot(taxi.x - px, taxi.z - pz);
  }
  check('handed back, the traffic model drives it on from a lane', handed && moved > 20, `${moved.toFixed(1)} units`);
  console.log(`free trips: mean ${(freeTime / Math.max(1, freeArrived)).toFixed(1)}s`);
}

// --- The game controller (src/game/gamepad.js) -------------------------------------------------
{
  check('pad: a resting stick says nothing', deadZone(0.1, -0.12) === null);
  const up = deadZone(0, -1);
  check('pad: full up is full length straight up', up && Math.abs(up.mag - 1) < 1e-9 && up.y < -0.99);
  const edge = deadZone(STICK_DEAD + 1e-6, 0);
  check('pad: the push grows from zero at the dead zone', edge && edge.mag < 1e-4);
  // Pad screen-up drives the same ground heading as the touch stick pushed up.
  const g = screenToGround(0, -1, toScreen);
  const back = toScreen(g.x, g.z);
  check('pad: stick up steers screen-up', back.y < 0 && Math.abs(back.x) < 1e-6 * Math.hypot(back.x, back.y) + 1e-6,
    `${back.x.toFixed(3)}, ${back.y.toFixed(3)}`);
  // A menu: Play over Settings over Credits in a column, a Board button off to the right of Play.
  const play = { el: 'play', x: 200, y: 300 };
  const settings = { el: 'settings', x: 200, y: 360 };
  const credits = { el: 'credits', x: 200, y: 420 };
  const board = { el: 'board', x: 330, y: 300 };
  const menu = [play, settings, credits, board];
  check('pad: down from Play is Settings', nearestInDirection(play, menu, [0, 1])?.el === 'settings');
  check('pad: right from Play is the button beside it', nearestInDirection(play, menu, [1, 0])?.el === 'board');
  check('pad: down from the side button lands in the column', nearestInDirection(board, menu, [0, 1])?.el === 'settings');
  check('pad: up from the top stays put', nearestInDirection(play, menu, [0, -1]) === null);
}

console.log(`steered trips: mean ${(total / Math.max(1, arrived)).toFixed(1)}s`);
console.log(`${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
