/**
 * The warped city (city/warp.js) checked as a road network, over many seeds.
 *
 * tools/roadnet.mjs is the control that the network still describes the grid, which the warped city
 * deliberately does not, so it runs on `LAYOUT=classic`. This is the other half: on the default
 * layout, is what the warp built still a city a car can drive?
 *
 *   node tools/warp.mjs [seeds]
 */
import { makeRng } from '../src/util/rng.js';
import { createLayout } from '../src/city/layout.js';
import { cityNetwork } from '../src/city/roadnet.js';
import { isCityConnected, isWarped } from '../src/city/grid.js';
import { HAS_WARP } from '../src/city/square.js';
import { MIN_STREET } from '../src/city/warp.js';
import { blockoutFaces, blockoutMasses } from '../src/city/blockout.js';
import { KERB_H } from '../src/city/ground.js';
import { pickStreet } from '../src/game/uturnclip.js';
import { pickOvertakeStreet } from '../src/game/overtakeclip.js';
import { pickCorner } from '../src/game/driftclip.js';

const SEEDS = Number(process.argv[2] ?? 24);
const results = [];
const failures = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

if (!HAS_WARP) {
  console.log('LAYOUT is not the warped city; nothing to check');
  console.log('0/0 checks passed');
  process.exit(0);
}

const camRight = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
const worst = { lane: Infinity, angle: Infinity, street: Infinity };
const bad = { short: [], fork: [], disconnected: [], unreachable: [], uturn: [], overtake: [], drift: [], avenue: [], faces: [], masses: [] };

for (let seed = 1; seed <= SEEDS; seed++) {
  const layout = createLayout(makeRng(seed));
  const net = cityNetwork();
  if (!isWarped()) { bad.disconnected.push(`${seed}: not warped`); continue; }

  // Every lane long enough to hold a car. The bends' junction boxes once ate whole streets (0–3
  // units on 60 of 60 seeds) — that is what this is watching for.
  for (const lane of net.lanes) {
    if (lane.degenerate) continue;
    worst.lane = Math.min(worst.lane, lane.length);
    if (lane.length < 3) bad.short.push(`${seed}: ${lane.id} ${lane.length.toFixed(2)}`);
  }
  // Every fork at least ~35° (warp.js relaxes to MIN_ANGLE off the chords; the arcs leave a few
  // degrees off those, and an avenue meeting a street can sit at 45°).
  for (const node of net.nodes) {
    const arms = node.arms;
    for (let k = 0; k < arms.length && arms.length > 1; k++) {
      let gap = arms[(k + 1) % arms.length].bearing - arms[k].bearing;
      if (gap <= 0) gap += Math.PI * 2;
      worst.angle = Math.min(worst.angle, gap);
      if (gap < 0.6) bad.fork.push(`${seed}: ${node.id} ${(gap * 180 / Math.PI).toFixed(0)}°`);
    }
  }
  // Junction centres no closer than MIN_STREET along any open street.
  for (const edge of net.edges ?? []) {
    const a = net.nodeById?.get(edge.a) ?? net.nodes.find((n) => n.id === edge.a);
    const b = net.nodeById?.get(edge.b) ?? net.nodes.find((n) => n.id === edge.b);
    if (!a || !b || a.radius === 1 || b.radius === 1) continue;   // an avenue's bend is not a junction
    worst.street = Math.min(worst.street, Math.hypot(b.x - a.x, b.z - a.z));
  }
  if (!isCityConnected()) bad.disconnected.push(`${seed}`);

  // Every lane reaches every other through legal turns, both ways round.
  const lanes = net.lanes.filter((l) => !l.degenerate);
  const reach = (start, step) => {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) for (const next of step(stack.pop())) if (!seen.has(next)) { seen.add(next); stack.push(next); }
    return seen;
  };
  const fwd = (l) => l.exits.map((id) => net.laneById.get(net.turnById.get(id).outLane));
  const into = new Map(lanes.map((l) => [l, []]));
  for (const l of lanes) for (const o of fwd(l)) into.get(o)?.push(l);
  const out = reach(lanes[0], fwd).size;
  const back = reach(lanes[0], (l) => into.get(l) ?? []).size;
  if (out < lanes.length || back < lanes.length) bad.unreachable.push(`${seed}: ${out}/${back} of ${lanes.length}`);

  // The move cards film a straight street (warp.js keeps a main street for them) and a corner.
  const network = net;
  if (!pickStreet({ network, cars: [], camRight })) bad.uturn.push(`${seed}`);
  if (!pickOvertakeStreet({ network, cars: [], camRight })) bad.overtake.push(`${seed}`);
  if (!pickCorner({ network, cars: [], camRight })) bad.drift.push(`${seed}`);

  // At least one avenue, and each is dead straight end to end.
  const avenues = layout.warp.avenues;
  if (!avenues.length) bad.avenue.push(`${seed}: none`);
  for (const path of avenues) {
    const node = (n) => net.nodes.find((m) => m.gi === n.i && m.gj === n.j);
    const ends = [node(path[0]), node(path.at(-1))];
    if (!ends[0] || !ends[1]) continue;
    const [p, q] = ends;
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    for (const n of path) {
      const m = node(n);
      if (!m) continue;
      const off = Math.abs((m.x - p.x) * (q.z - p.z) - (m.z - p.z) * (q.x - p.x)) / len;
      if (off > 1e-6) bad.avenue.push(`${seed}: ${n.i},${n.j} off by ${off.toFixed(3)}`);
    }
  }

  // The blockout: a face for (nearly) every block, and masses that build.
  const faces = blockoutFaces(net);
  if (faces.length < 12) bad.faces.push(`${seed}: ${faces.length}`);
  if (seed <= 6) {
    try {
      const built = blockoutMasses(makeRng(seed), layout, { kerbH: KERB_H });
      if (!(built.pieces.length > 20)) bad.masses.push(`${seed}: ${built.pieces.length} pieces`);
    } catch (error) {
      bad.masses.push(`${seed}: ${error.message}`);
    }
  }
}

const say = (list) => (list.length ? `${list.length} — e.g. ${list.slice(0, 3).join('; ')}` : '');
check(`every lane holds a car (shortest ${worst.lane.toFixed(1)})`, !bad.short.length, say(bad.short));
check(`no fork under 35° (narrowest ${(worst.angle * 180 / Math.PI).toFixed(0)}°)`, !bad.fork.length, say(bad.fork));
check(`no street shorter than ${MIN_STREET} between junctions (shortest ${worst.street.toFixed(1)})`,
  worst.street >= MIN_STREET - 1e-6);
check('every junction reaches every other', !bad.disconnected.length, say(bad.disconnected));
check('every lane reaches and is reached by every other', !bad.unreachable.length, say(bad.unreachable));
check('the U-turn card has a street', !bad.uturn.length, say(bad.uturn));
check('the overtake card has a street', !bad.overtake.length, say(bad.overtake));
check('the drift card has a corner', !bad.drift.length, say(bad.drift));
check('every city has an avenue, and each runs dead straight', !bad.avenue.length, say(bad.avenue));
check('the blockout finds the blocks', !bad.faces.length, say(bad.faces));
check('the blockout builds its masses', !bad.masses.length, say(bad.masses));

const passed = results.filter(Boolean).length;
for (const line of failures.slice(0, 12)) console.log(`  FAIL ${line}`);
console.log(`${passed}/${results.length} checks passed over ${SEEDS} seeds`);
process.exit(failures.length ? 1 : 0);
