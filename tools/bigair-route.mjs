/**
 * How often a route over an arched span leaves room for Big Air — straight on at the far bank —
 * and what the router's tilt toward it (`setBigAirTilt`, game/route.js) buys.
 *
 * Every (origin, heading, destination) on each city, the same population tools/probe.mjs walks.
 * Only routes that drive an arched deck count, and of those only the ones that go on past the far
 * bank: a route that *ends* there has nothing to choose.
 *
 *   node tools/bigair-route.mjs [numSeeds]
 */
import { makeRng } from '../src/util/rng.js';
import { createLayout } from '../src/city/layout.js';
import { cityNetwork } from '../src/city/roadnet.js';
import { findRoute, allIntersections, isArchedDeck, setBigAirTilt, countTurns } from '../src/game/route.js';
import { DIR } from '../src/city/grid.js';

const SEEDS = Number(process.argv[2] ?? 12);
const TILTS = [0, 0.06, 0.11, 0.21, 0.4, 0.85];
const DIRS = Object.values(DIR);

const rows = TILTS.map((tilt) => ({ tilt, over: 0, straight: 0, legs: 0, turns: 0, trips: 0, overAny: 0 }));

for (let s = 0; s < SEEDS; s++) {
  createLayout(makeRng(10000 + s * 1237));
  const net = cityNetwork();
  const ints = allIntersections();
  for (const row of rows) {
    setBigAirTilt(row.tilt);
    for (const o of ints) {
      for (const d of DIRS) {
        let lane = net.laneByGrid(d, o.i, o.j);
        if (!lane) continue;
        for (const t of ints) {
          const route = findRoute({ i: o.i, j: o.j, d }, t);
          if (!route) continue;
          row.trips += 1;
          row.legs += route.length;
          row.turns += countTurns(route, d);
          let at = { i: o.i, j: o.j };
          let cur = lane;
          let crossed = false;
          for (let k = 0; k <= route.length; k++) {
            if (isArchedDeck(cur)) {
              crossed = true;
              if (k < route.length) {
                row.over += 1;
                if (route[k] === net.dirOfLane(cur)) row.straight += 1;
              }
            }
            if (k === route.length) break;
            cur = net.laneOutByGrid(route[k], at.i, at.j);
            const n = net.nodeById.get(cur.to);
            at = { i: n.gi, j: n.gj };
          }
          if (crossed) row.overAny += 1;
        }
      }
    }
  }
}
setBigAirTilt(0);

const pct = (a, b) => `${((100 * a) / b).toFixed(0)}%`.padStart(5);
console.log(`${SEEDS} cities\n tilt  over-arch  straight-on  legs/trip  turns/trip`);
for (const r of rows) {
  console.log(`${r.tilt.toFixed(2).padStart(5)}  ${pct(r.overAny, r.trips)}      ${pct(r.straight, r.over)}`
    + `       ${(r.legs / r.trips).toFixed(3)}      ${(r.turns / r.trips).toFixed(3)}`);
}
