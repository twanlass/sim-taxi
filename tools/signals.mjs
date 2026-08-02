/** Diagnoses how the signal network actually behaves, so "feels rigid" becomes numbers. */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic, lightPhase, signalCycle } from '../src/sim/traffic.js';
import { createLayout } from '../src/city/layout.js';
import { GRID, PITCH } from '../src/city/grid.js';

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

// --- 3. Green-wave quality: drive a phantom car straight down a road at cruising speed and
// --- count how often it meets a green. This is what "the city flows" actually means.
// A wave only helps a platoon *released by a green*, which is how traffic actually arrives.
// Measuring from arbitrary departure times just samples the split and always returns ~50%.
const SPEED = 8.5;
let hits = 0;
let tests = 0;
for (let j = 0; j <= GRID; j++) {
  // Find when the first junction on this road turns green, and set off then.
  let t = 0;
  for (let probe = 0; probe < signalCycle() * 10; probe += 0.05) {
    const now = lightPhase(0, j, probe);
    const before = lightPhase(0, j, probe - 0.05);
    if (now.axis === 'x' && !now.yellow && !(before.axis === 'x' && !before.yellow)) { t = probe; break; }
  }
  for (let i = 0; i < GRID; i++) {
    t += PITCH / SPEED;
    tests += 1;
    const p = lightPhase(i + 1, j, t);
    if (p.axis === 'x' && !p.yellow) hits += 1;
  }
}
console.log(`platoon meets green    : ${((hits / tests) * 100).toFixed(1)}% (a coordinated wave approaches 100%)`);

// --- 4. What fraction of the time is any traffic actually moving?
traffic.warmup(240);
const s = traffic.stats;
console.log(`throughput             : ${(s.distance / s.time / traffic.cars.length).toFixed(2)} of ${SPEED} units/s per car`);
console.log(`  -> cars are stationary ${(100 - (s.distance / s.time / traffic.cars.length / SPEED) * 100).toFixed(0)}% of the time`);
