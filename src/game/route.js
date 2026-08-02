import { legalExits, nextIntersection, GRID } from '../city/grid.js';

/**
 * Routing over the road network.
 *
 * The graph node is *directed* — `(i, j, d)` means "approaching intersection (i, j) travelling
 * direction d". It has to be, because the legal moves out of an intersection depend on how you
 * arrived: `legalExits` forbids U-turns. Treating a plain (i, j) as the node would happily plan
 * routes that flip direction on the spot, and the car would never be able to execute them.
 *
 * At 5x5 that's 6*6*4 = 144 states, so a plain BFS is instant and gives fewest-turns-to-target
 * (equivalently fewest blocks, since every edge is one block long).
 */

const key = (i, j, d) => `${i},${j},${d}`;

/**
 * @param from  {{i, j, d}} the intersection the car is heading toward, and its current heading
 * @param target {{i, j}}   intersection to reach
 * @returns array of directions to take at each successive intersection, or null if unreachable.
 *          An empty array means the car is already heading to the target.
 */
export function findRoute(from, target) {
  if (from.i === target.i && from.j === target.j) return [];

  const start = key(from.i, from.j, from.d);
  const prev = new Map([[start, null]]);
  const queue = [{ i: from.i, j: from.j, d: from.d, k: start }];

  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];

    for (const dOut of legalExits(node.d, node.i, node.j)) {
      const next = nextIntersection(dOut, node.i, node.j);
      if (!next) continue;

      const nk = key(next.i, next.j, dOut);
      if (prev.has(nk)) continue;
      prev.set(nk, { from: node.k, dir: dOut });

      if (next.i === target.i && next.j === target.j) {
        // Walk the parent chain back to the start, collecting the turns taken.
        const out = [];
        for (let cursor = nk; prev.get(cursor); cursor = prev.get(cursor).from) {
          out.unshift(prev.get(cursor).dir);
        }
        return out;
      }

      queue.push({ i: next.i, j: next.j, d: dOut, k: nk });
    }
  }

  return null;
}

/**
 * Where planning must start from for a given car.
 *
 * A car in the middle of a turn has *already* committed its choice at (i, j), so planning from
 * that intersection produces a route whose first step is silently skipped — every subsequent turn
 * then lands one intersection early. Plan from where the turn is about to deposit it instead.
 */
export function planOrigin(car) {
  if (car.state === 'turn') {
    const next = nextIntersection(car.dOut, car.i, car.j);
    if (next) return { i: next.i, j: next.j, d: car.dOut };
  }
  return { i: car.i, j: car.j, d: car.d };
}

/** Every intersection on the grid, as {i, j}. */
export function allIntersections() {
  const out = [];
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) out.push({ i, j });
  }
  return out;
}
