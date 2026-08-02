import * as THREE from 'three';
import { makeRng } from '/Users/tyler/Code/research/city-lab/src/util/rng.js';
import { createTraffic } from '/Users/tyler/Code/research/city-lab/src/sim/traffic.js';
import { isXAxis, dirSign, laneOffsetCoord } from '/Users/tyler/Code/research/city-lab/src/city/grid.js';

const scene = new THREE.Scene();
const traffic = createTraffic(makeRng(71624 + 44), scene, 110);
traffic.warmup(120);

const cars = traffic.cars;
let worst = Infinity, pair = null;
for (let a = 0; a < cars.length; a++) {
  for (let b = a + 1; b < cars.length; b++) {
    const d = Math.hypot(cars[a].x - cars[b].x, cars[a].z - cars[b].z);
    if (d < worst) { worst = d; pair = [cars[a], cars[b], a, b]; }
  }
}
const show = (c, idx) => ({
  idx, d: c.d, i: c.i, j: c.j, s: +c.s.toFixed(2), state: c.state,
  x: +c.x.toFixed(2), z: +c.z.toFixed(2),
  laneKey: c.laneKey,
  lane: +laneOffsetCoord(c.d, c.i, c.j).toFixed(2),
  axis: isXAxis(c.d) ? 'x' : 'z', sign: dirSign(c.d),
});
console.log('closest', worst.toFixed(3));
console.log(JSON.stringify(show(pair[0], pair[2])));
console.log(JSON.stringify(show(pair[1], pair[3])));
