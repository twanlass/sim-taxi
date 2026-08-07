/** Diagnoses how the signal network actually behaves, so "feels rigid" becomes numbers. */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic, lightPhase, signalCycle } from '../src/sim/traffic.js';
import { createLayout } from '../src/city/layout.js';
import { GRID } from '../src/city/grid.js';
import { cityNetwork } from '../src/city/roadnet.js';

createLayout(makeRng(71624));
const traffic = createTraffic(makeRng(71624 + 44), new THREE.Scene(), 24);

// --- 1. How many genuinely distinct signal timings exist?
// Sample each junction's state across the cycle; identical signatures mean identical timing.
const signatures = new Set();
for (let i = 0; i <= GRID; i++) {
  for (let j = 0; j <= GRID; j++) {
    let sig = '';
    for (let t = 0; t < signalCycle(); t += 0.5) {
      const p = lightPhase(i, j, t);
      sig += p.yellow ? 'y' : p.axis;
    }
    signatures.add(sig);
  }
}
console.log(`distinct signal timings: ${signatures.size} across ${(GRID + 1) ** 2} intersections`);
console.log(`  -> ${(((GRID + 1) ** 2) / signatures.size).toFixed(1)} intersections share each timing exactly`);

// --- 2. Simultaneity: how many junctions flip within the same half-second?
let prev = null;
const flipsPerTick = [];
for (let t = 0; t < 60; t += 0.5) {
  const states = [];
  for (let i = 0; i <= GRID; i++) for (let j = 0; j <= GRID; j++) states.push(lightPhase(i, j, t).axis);
  if (prev) flipsPerTick.push(states.filter((s, k) => s !== prev[k]).length);
  prev = states;
}
const peak = Math.max(...flipsPerTick);
console.log(`peak junctions flipping together: ${peak} of ${(GRID + 1) ** 2}`);

// --- 3. Green-wave quality: drive a phantom platoon down a road at cruising speed and count how
// --- often it meets a green. This is what "the city flows" actually means.
//
// A wave only helps a platoon *released by a green*, which is how traffic actually arrives.
// Measuring from arbitrary departure times just samples the split and always returns ~50%.
//
// Two things this used to get wrong, both invisible in the printed number:
//   - It walked `i = 0..GRID` along row `j` whether or not those roads exist, so on a seed where a
//     park district closed a segment it drove a phantom platoon straight through the park and
//     scored the junctions beyond it against a wave that cannot reach them. It now walks a *chain*
//     — the network's maximal through-route — which stops where the road does.
//   - It looked for the release green at `(0, j)`, which is on the ring for every interior `j`, so
//     `axis === 'x'` never became true and every platoon in fact departed at t = 0. It now releases
//     at the first *signalised* junction the platoon meets, which is well defined wherever the
//     chain happens to start.
const SPEED = 8.5;
const net = cityNetwork();
let hits = 0;
let tests = 0;

/** The lanes a platoon drives, following one chain from `nodes[0]` onward. */
const laneRun = (chain, forward) => {
  const nodes = forward ? chain.nodes : [...chain.nodes].reverse();
  const run = [];
  for (let k = 0; k + 1 < nodes.length; k++) {
    const lane = net.lanes.find((l) => l.from === nodes[k].id && l.to === nodes[k + 1].id);
    if (!lane) break;
    run.push(lane);
  }
  return run;
};

for (const chain of net.chains) {
  for (const forward of [true, false]) {
    const run = laneRun(chain, forward);
    // Release at the first signalised junction, then score every junction after it.
    const start = run.findIndex((lane) => net.nodeById.get(lane.to).signal);
    if (start < 0 || run.length - start < 2) continue;

    let t = 0;
    for (let probe = 0; probe < signalCycle() * 10; probe += 0.05) {
      const now = net.laneSignal(run[start], probe).open;
      const before = net.laneSignal(run[start], probe - 0.05).open;
      if (now && !before) { t = probe; break; }
    }

    for (let k = start + 1; k < run.length; k++) {
      t += run[k - 1].edge.length / SPEED;
      const node = net.nodeById.get(run[k].to);
      if (!node.signal) continue;          // nothing to meet: the ring never stops the platoon
      tests += 1;
      if (net.laneSignal(run[k], t).open) hits += 1;
    }
  }
}
console.log(`platoon meets green    : ${tests ? ((hits / tests) * 100).toFixed(1) : 'n/a'}%`
  + ` of ${tests} junctions (a coordinated wave approaches 100%)`);

// --- 4. What fraction of the time is any traffic actually moving?
traffic.warmup(240);
const s = traffic.stats;
console.log(`throughput             : ${(s.distance / s.time / traffic.cars.length).toFixed(2)} of ${SPEED} units/s per car`);
console.log(`  -> cars are stationary ${(100 - (s.distance / s.time / traffic.cars.length / SPEED) * 100).toFixed(0)}% of the time`);
