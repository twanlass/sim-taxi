/**
 * Does the road network reproduce the grid, exactly?
 *
 * `city/roadnet.js` is meant to replace `city/grid.js` as the thing traffic, routing and meshing
 * ask about the world. That port is only safe if the new model is first shown to describe the
 * *same city* — otherwise a car behaving differently afterwards could be a porting bug or could
 * be a city that quietly moved, and there would be no way to tell which.
 *
 * So this asserts equivalence numerically, before anything consumes the network: node positions,
 * lane centres, junction entry and exit points, turn control points, legal moves, which junctions
 * are signalised, the phase each movement belongs to, and the signal's state sampled right across
 * a cycle. Tolerance is 1e-9 — these are the same numbers computed two ways, not an approximation
 * of them.
 *
 *   node tools/roadnet.mjs [seeds]
 */
import { makeRng } from '../src/util/rng.js';
import { createLayout } from '../src/city/layout.js';
import {
  GRID, PITCH, LANE, HALF_ROAD, DIR, lineCoord, legalExits, entryPoint, exitPoint, turnControl,
  laneOffsetCoord, isXAxis, dirSign, nextIntersection, isSegmentClosed,
} from '../src/city/grid.js';
// Only constants and the pre-port road-class helper. The signal model this tool validates is
// frozen below rather than imported, so that pointing traffic.js at the network cannot turn the
// comparison into the network agreeing with itself.
import { SPEED, signalCycle, edgeClass } from '../src/sim/traffic.js';
import { roadNetFromGrid, bakeNetwork, SIGNAL_DEFAULTS, gridNodeId } from '../src/city/roadnet.js';
import { findRoute } from '../src/game/route.js';

const TOL = 1e-9;
const SEEDS = Number(process.argv[2] ?? 12);
// Route equivalence is every (start, heading, target) triple — 5,184 pairs planned twice per seed,
// which is a second of wall clock. Three seeds is enough to cover the shapes closures produce
// (a cut arterial, a stub, an interior junction down to three arms) without the suite noticing.
const ROUTE_SEEDS = Math.min(3, SEEDS);

const results = [];
const failures = [];

function check(name, ok, detail = '') {
  results.push(ok);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

/** Worst absolute error over a set of samples, reported rather than just thresholded. */
function worst(label, samples) {
  let max = 0;
  let where = '';
  for (const [error, at] of samples) {
    if (error > max) { max = error; where = at; }
  }
  check(label, max <= TOL, `worst ${max.toExponential(2)} at ${where}`);
  return max;
}

const near = (a, b) => Math.abs(a - b);
const apart = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);

// A grid direction's lane offset, as the network reports it: the point the lane actually passes
// through mid-block, on the axis the grid measures.
const laneCoordOf = (lane, d) => {
  const mid = lane.path.at(lane.length / 2);
  return isXAxis(d) ? mid.z : mid.x;
};

let offsetDriftNodes = 0;
let degenerate = 0;

// --- The grid router, as it stood before the port ----------------------------
//
// Kept verbatim so the ported router can be differenced against it rather than against a
// description of it. Deleted once traffic.js drives lanes and there is no `(i, j, d)` left to
// plan in.
const REF_COST = { ring: 0.90, arterial: 0.95, side: 1.00 };

function refCost(i, j, d) {
  const edge = edgeClass(i, j, d);
  if (edge.kind === 'ring') return REF_COST.ring;
  if (edge.kind === 'arterial') return REF_COST.arterial;
  return REF_COST.side;
}

function refRoute(from, target) {
  if (from.i === target.i && from.j === target.j) return [];

  const key = (i, j, d) => `${i},${j},${d}`;
  const start = key(from.i, from.j, from.d);
  const dist = new Map([[start, 0]]);
  const prev = new Map([[start, null]]);
  const open = new Set([start]);

  while (open.size) {
    let cur = null;
    let curDist = Infinity;
    for (const k of open) {
      const d = dist.get(k);
      if (d < curDist) { curDist = d; cur = k; }
    }
    open.delete(cur);

    const [ci, cj, cd] = cur.split(',').map(Number);
    if (ci === target.i && cj === target.j) {
      const out = [];
      for (let cursor = cur; prev.get(cursor); cursor = prev.get(cursor).from) {
        out.unshift(prev.get(cursor).dir);
      }
      return out;
    }

    for (const dOut of legalExits(cd, ci, cj)) {
      const next = nextIntersection(dOut, ci, cj);
      if (!next) continue;
      const nk = key(next.i, next.j, dOut);
      const nd = curDist + refCost(ci, cj, dOut);
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, { from: cur, dir: dOut });
        open.add(nk);
      }
    }
  }

  return null;
}

// --- The analytic signal model, as it stood before the port ------------------
//
// Frozen here for the same reason the grid router above is: `traffic.js`'s `lightPhase` is about
// to become a call *into* the network, and an assertion that compares the network against itself
// is worth nothing. docs/roadnet.md calls the phase comparison "the assertion that actually
// matters", so it has to keep comparing two independently-computed answers.
//
// The constants are written out rather than imported for the same reason. `signalConstantsAgree`
// below is what keeps them honest — if the shipped numbers are retuned, this copy fails loudly
// instead of silently validating the wrong city.
const REF_SIGNAL = { cycle: 16, yellow: 1.6, cruise: 8.5 };

/** `ringAxisAt`, frozen. 'x' or 'z' if the junction sits on the ring, null if interior. */
function refRingAxisAt(i, j) {
  const onX = j === 0 || j === GRID;
  const onZ = i === 0 || i === GRID;
  if (onX && onZ) return null;
  if (onX) return 'x';
  if (onZ) return 'z';
  return null;
}

/**
 * Which axis owns this junction outright, or null if it has to be arbitrated by a light.
 *
 * Two ways to own one, and the ring is checked first because it is checked first in the bake: the
 * outermost roads, and a main street *running through* — an arterial reduced to a stub by a park
 * closure has no through traffic to give the right of way to, so those junctions keep their light.
 * `isSegmentClosed` already answers "off the map" as closed, which is what makes the second test
 * decline the boundary junctions the first one has already claimed.
 */
function refPriorityAxis(layout, i, j) {
  const ring = refRingAxisAt(i, j);
  if (ring) return ring;

  const through = [];
  if (layout.arterials.x.has(j)
      && !isSegmentClosed(i, j, DIR.PX) && !isSegmentClosed(i, j, DIR.NX)) through.push('x');
  if (layout.arterials.z.has(i)
      && !isSegmentClosed(i, j, DIR.PZ) && !isSegmentClosed(i, j, DIR.NZ)) through.push('z');
  return through.length === 1 ? through[0] : null;
}

/** `lightPhase(i, j, t, true)`, frozen — no corridor, no boost hold, as the tool always called it. */
function refLightPhase(layout, i, j, t) {
  const priority = refPriorityAxis(layout, i, j);
  if (priority) return { axis: priority, yellow: false, remaining: Infinity };

  const { cycle, yellow, cruise } = REF_SIGNAL;

  // An even split, always. The junctions that still carry a light are the ones with no street to
  // favour — a ring corner, the one crossing where both arterials meet — so the 64/36 the shipped
  // bake used to hand an arterial has nowhere left to apply.
  const totalGreen = cycle - 2 * yellow;
  const greenX = totalGreen / 2;
  const greenZ = totalGreen - greenX;

  // And they all coordinate along X, for the same reason: the bake takes the first street by axis,
  // which on this grid is the one running along X, and a junction with no X arm at all has one
  // street and no signal.
  const step = PITCH / cruise;
  const blocks = (layout.arterials.dirX.get(j) ?? 1) > 0 ? i : GRID - i;
  const offset = -blocks * step;

  const local = (((t + offset) % cycle) + cycle) % cycle;
  if (local < greenX) return { axis: 'x', yellow: false, remaining: greenX - local };
  if (local < greenX + yellow) return { axis: 'x', yellow: true, remaining: greenX + yellow - local };
  if (local < greenX + yellow + greenZ) {
    return { axis: 'z', yellow: false, remaining: greenX + yellow + greenZ - local };
  }
  return { axis: 'z', yellow: true, remaining: cycle - local };
}

const everyIntersection = [];
for (let i = 0; i <= GRID; i++) {
  for (let j = 0; j <= GRID; j++) everyIntersection.push({ i, j });
}

for (let s = 0; s < SEEDS; s++) {
  const seed = 71624 + s * 7919;
  const layout = createLayout(makeRng(seed));
  const net = roadNetFromGrid(layout);
  const tag = `seed ${seed}`;

  // --- Constants shared across the module boundary --------------------------
  check(`${tag} cruise matches SPEED`, SIGNAL_DEFAULTS.cruise === SPEED,
    `${SIGNAL_DEFAULTS.cruise} vs ${SPEED}`);
  check(`${tag} cycle matches signalCycle`, SIGNAL_DEFAULTS.cycle === signalCycle(),
    `${SIGNAL_DEFAULTS.cycle} vs ${signalCycle()}`);
  // The frozen oracle is only an oracle while its constants are the shipped ones.
  check(`${tag} frozen signal constants agree`,
    REF_SIGNAL.cycle === SIGNAL_DEFAULTS.cycle && REF_SIGNAL.yellow === SIGNAL_DEFAULTS.yellow
    && REF_SIGNAL.cruise === SIGNAL_DEFAULTS.cruise,
    `${JSON.stringify(REF_SIGNAL)} vs ${JSON.stringify(SIGNAL_DEFAULTS)}`);

  // --- Nodes ----------------------------------------------------------------
  {
    const samples = [];
    for (let i = 0; i <= GRID; i++) {
      for (let j = 0; j <= GRID; j++) {
        const node = net.nodeByGrid(i, j);
        samples.push([apart(node, { x: lineCoord(i), z: lineCoord(j) }), `(${i},${j})`]);
      }
    }
    check(`${tag} node count`, net.nodes.length === (GRID + 1) ** 2, `${net.nodes.length}`);
    worst(`${tag} node positions`, samples);
  }

  // --- Legal moves ----------------------------------------------------------
  //
  // `legalExits` is the grid's single authority on where a car may go — no U-turns, no leaving
  // the map, no closed roads. Every one of those has to survive as a legal turn, and nothing
  // else may appear.
  {
    let mismatches = 0;
    let example = '';
    for (let i = 0; i <= GRID; i++) {
      for (let j = 0; j <= GRID; j++) {
        for (let dIn = 0; dIn < 4; dIn++) {
          const inLane = net.laneByGrid(dIn, i, j);
          const expect = new Set(legalExits(dIn, i, j).map(String));
          if (!inLane) {
            // No lane means the road the car would have arrived on doesn't exist, so there is
            // nothing to compare — the grid would never place a car there either.
            continue;
          }
          const got = new Set();
          for (const turnId of inLane.exits) {
            const turn = net.turnById.get(turnId);
            const out = net.laneById.get(turn.outLane);
            const to = net.nodeById.get(out.to);
            for (let d = 0; d < 4; d++) {
              const n = nextIntersection(d, i, j);
              if (n && gridNodeId(n.i, n.j) === to.id) got.add(String(d));
            }
          }
          const same = expect.size === got.size && [...expect].every((d) => got.has(d));
          if (!same) {
            mismatches += 1;
            if (!example) example = `(${i},${j}) d${dIn}: grid [${[...expect]}] net [${[...got]}]`;
          }
        }
      }
    }
    check(`${tag} legal exits`, mismatches === 0, `${mismatches} mismatched, e.g. ${example}`);
  }

  // --- Lane geometry --------------------------------------------------------
  //
  // Three separate things have to line up: the lane sits `LANE` off the centreline on the correct
  // side, it starts where `exitPoint` says the previous junction released the car, and it ends
  // where `entryPoint` says this junction takes it.
  {
    const centres = [];
    const entries = [];
    const exits = [];

    for (let i = 0; i <= GRID; i++) {
      for (let j = 0; j <= GRID; j++) {
        for (let d = 0; d < 4; d++) {
          const lane = net.laneByGrid(d, i, j);
          if (!lane) continue;
          const back = isXAxis(d) ? { i: i - dirSign(d), j } : { i, j: j - dirSign(d) };
          const at = `(${i},${j}) d${d}`;

          centres.push([near(laneCoordOf(lane, d), laneOffsetCoord(d, i, j)), at]);
          entries.push([apart(lane.path.at(lane.length), entryPoint(d, i, j)), at]);
          exits.push([apart(lane.path.at(0), exitPoint(d, back.i, back.j)), at]);
        }
      }
    }
    worst(`${tag} lane centres`, centres);
    worst(`${tag} lane entry points`, entries);
    worst(`${tag} lane exit points`, exits);
  }

  // --- Turn geometry --------------------------------------------------------
  {
    const controls = [];
    for (let i = 0; i <= GRID; i++) {
      for (let j = 0; j <= GRID; j++) {
        for (let dIn = 0; dIn < 4; dIn++) {
          const inLane = net.laneByGrid(dIn, i, j);
          if (!inLane) continue;
          for (const dOut of legalExits(dIn, i, j)) {
            const turn = inLane.exits.map((id) => net.turnById.get(id)).find((t) => {
              const to = net.laneById.get(t.outLane).to;
              const n = nextIntersection(dOut, i, j);
              return n && gridNodeId(n.i, n.j) === to;
            });
            if (!turn) continue;
            controls.push([
              apart(turn.control, turnControl(dIn, dOut, i, j)), `(${i},${j}) d${dIn}->d${dOut}`,
            ]);
          }
        }
      }
    }
    worst(`${tag} turn control points`, controls);
  }

  // --- Which junctions carry lights ----------------------------------------
  {
    let mismatches = 0;
    let example = '';
    for (let i = 0; i <= GRID; i++) {
      for (let j = 0; j <= GRID; j++) {
        const node = net.nodeByGrid(i, j);
        const gridSays = refPriorityAxis(layout, i, j) !== null;
        const netSays = node.signal === null;
        if (gridSays !== netSays) {
          // One difference is intended, and it is the same one in both its forms: the network
          // drops a signal wherever no two movements conflict, which the grid cannot see because
          // it decides signalisation from (i, j) alone.
          //
          //   - A park closure can leave an interior junction with nothing but a straight-through
          //     — two collinear arms, no cross traffic. The grid keeps cycling a light there and
          //     holds cars for a phase nobody can be in.
          //   - A ring corner is two arms at a right angle. Both movements are bends, they land
          //     in different lanes, and with right-hand traffic they sweep opposite sides without
          //     meeting.
          //
          // Verified here rather than taken on trust: this recomputes the conflict count from the
          // turns themselves, so the tool still reaches its own verdict instead of repeating the
          // network's. Anything else is a bug.
          const conflicted = net.turns
            .some((t) => t.node === node.id && t.legal && t.conflicts.length > 0);
          if (!gridSays && netSays && !conflicted) {
            degenerate += 1;
            continue;
          }
          mismatches += 1;
          if (!example) example = `(${i},${j}) grid ${gridSays} net ${netSays}`;
        } else if (gridSays) {
          // And the priority street must be the one that owns the junction — the ring's axis or
          // the arterial's — not the cross street's.
          const axis = node.streets[node.priorityStreet]?.axis ?? 0;
          const want = refPriorityAxis(layout, i, j);
          const got = axis < 0.1 ? 'x' : 'z';
          if (want && want !== got) {
            mismatches += 1;
            if (!example) example = `(${i},${j}) priority ${got} want ${want}`;
          }
        }
      }
    }
    check(`${tag} signalised junctions`, mismatches === 0, `${mismatches}, e.g. ${example}`);
  }

  // --- Signal state, sampled across a cycle ---------------------------------
  //
  // The assertion that actually matters. A phase plan that merely *looks* like two phases is
  // worth nothing if it shows green at a different moment; this walks the whole cycle at 0.1s and
  // compares the axis moving and whether it is yellow, for every signalised junction.
  {
    const axisOf = (node, index) => (node.streets[index].axis < 0.1 ? 'x' : 'z');
    const FULL_SPAN = GRID * PITCH;   // a street that still runs the whole map
    let unexplained = 0;
    let example = '';
    let drifted = 0;

    for (let i = 0; i <= GRID; i++) {
      for (let j = 0; j <= GRID; j++) {
        const node = net.nodeByGrid(i, j);
        if (!node.signal) continue;

        let matches = true;
        let nodeWorst = 0;
        let first = '';
        for (let t = 0; t < REF_SIGNAL.cycle; t += 0.1) {
          const want = refLightPhase(layout, i, j, t);
          const got = net.phaseAt(node, t);
          const gotAxis = axisOf(node, got.index);
          if (gotAxis !== want.axis || got.yellow !== want.yellow) {
            matches = false;
            if (!first) {
              first = `(${i},${j}) t=${t.toFixed(1)} grid ${want.axis}${want.yellow ? '/y' : ''}`
                + ` net ${gotAxis}${got.yellow ? '/y' : ''}`;
            }
          }
          nodeWorst = Math.max(nodeWorst, near(got.remaining, want.remaining));
        }

        if (matches && nodeWorst <= TOL) continue;

        // Not identical — so it had better be a junction whose coordinated street was cut in half
        // by a park closure. There the grid measures the platoon's travel from the map edge along
        // the whole line, while the network measures it along the chain that still exists, which
        // is the more defensible of the two: a wave cannot propagate across a road that isn't
        // there. Anything drifting *without* that explanation is a bug in the phase bake.
        const truncated = node.signal.wave.chainTotal < FULL_SPAN - TOL;
        if (truncated) {
          drifted += 1;
        } else {
          unexplained += 1;
          if (!example) example = first || `(${i},${j}) countdown off by ${nodeWorst.toFixed(3)}`;
        }
      }
    }

    offsetDriftNodes += drifted;
    check(`${tag} signal phase matches the analytic model`, unexplained === 0,
      `${unexplained} junction(s) differ with an intact coordinated street, e.g. ${example}`);
  }

  // --- Blocks ---------------------------------------------------------------
  //
  // Faces of the road graph, inset by half a road, must land exactly on `blockBounds` — and where
  // a park district closed a road, on the merged bounds `layout.js` computed for it.
  {
    const wanted = [];
    for (const block of layout) {
      if (block.districtId !== null && block.districtId !== undefined) continue;
      wanted.push(block.bounds);
    }
    for (const district of layout.districts) wanted.push(district.bounds);

    check(`${tag} block count`, net.blocks.length === wanted.length,
      `net ${net.blocks.length} vs layout ${wanted.length}`);

    let unmatched = 0;
    let example = '';
    for (const want of wanted) {
      const hit = net.blocks.find((b) => near(b.bounds.x0, want.x0) <= TOL
        && near(b.bounds.x1, want.x1) <= TOL
        && near(b.bounds.z0, want.z0) <= TOL
        && near(b.bounds.z1, want.z1) <= TOL);
      if (!hit) {
        unmatched += 1;
        if (!example) example = `[${want.x0},${want.z0}]-[${want.x1},${want.z1}]`;
      }
    }
    check(`${tag} block bounds`, unmatched === 0, `${unmatched} unmatched, e.g. ${example}`);
  }

  // --- Sanity properties the grid can't express ----------------------------
  {
    check(`${tag} no degenerate lanes`, net.lanes.every((l) => !l.degenerate),
      `${net.lanes.filter((l) => l.degenerate).length} degenerate`);
    check(`${tag} lanes span a block`,
      net.lanes.every((l) => near(l.length, PITCH - 2 * HALF_ROAD) <= TOL),
      `lengths ${[...new Set(net.lanes.map((l) => l.length.toFixed(6)))].join(',')}`);
    check(`${tag} every legal turn has a path`,
      net.turns.filter((t) => t.legal).every((t) => t.length > 0));
    // Right turns are tighter than lefts under right-hand traffic — the sign the lane offset is
    // on the correct side. Backwards, and every car in the city would be driving on the left.
    const rights = net.turns.filter((t) => t.legal && t.hand === 'right');
    const lefts = net.turns.filter((t) => t.legal && t.hand === 'left');
    const mean = (xs) => xs.reduce((a, b) => a + b.length, 0) / Math.max(1, xs.length);
    check(`${tag} right turns tighter than left`, mean(rights) < mean(lefts),
      `right ${mean(rights).toFixed(2)} left ${mean(lefts).toFixed(2)}`);
    check(`${tag} lane offset is LANE`,
      net.lanes.every((l) => {
        const mid = l.path.at(l.length / 2);
        const c = l.edge.curve;
        const cm = c.at(c.length / 2);
        return near(Math.hypot(mid.x - cm.x, mid.z - cm.z), LANE) <= TOL;
      }));
  }

  // --- Routing --------------------------------------------------------------
  //
  // `game/route.js` now plans over lanes instead of over `(i, j, d)`. Comparing the *route* and
  // not merely "a route exists" is the assertion that matters: an equal-cost alternative would
  // pass a reachability check and still send the taxi down a different street on a large share of
  // fares, quietly moving every arrival time and fare count downstream of it. So the reference
  // Dijkstra below is the one route.js used to run, kept here to be differenced against — its
  // successor order (straight, right, left) is the tie-break the ported router preserves.
  if (s < ROUTE_SEEDS) {
    let mismatched = 0;
    let example = '';
    let compared = 0;
    for (const from of everyIntersection) {
      for (let d = 0; d < 4; d++) {
        for (const to of everyIntersection) {
          const mine = findRoute({ i: from.i, j: from.j, d }, to);
          const reference = refRoute({ i: from.i, j: from.j, d }, to);
          compared += 1;
          if (JSON.stringify(mine) === JSON.stringify(reference)) continue;
          mismatched += 1;
          if (!example) example = `(${from.i},${from.j},d${d})→(${to.i},${to.j}): `
            + `${JSON.stringify(mine)} vs ${JSON.stringify(reference)}`;
        }
      }
    }
    check(`${tag} routes match the grid router`, mismatched === 0,
      `${mismatched}/${compared} differ, e.g. ${example}`);
  }
}

// --- Shapes the grid could not express --------------------------------------
//
// Equivalence above proves the model has not lost anything. These prove it has gained the thing
// it was built for. None of these networks can be written down in `(i, j, d)` at all.

/** A diagonal cutting across a square block: the block becomes two triangles, automatically. */
{
  const nodes = [
    { id: 'sw', x: 0, z: 0 }, { id: 'se', x: 40, z: 0 },
    { id: 'ne', x: 40, z: 40 }, { id: 'nw', x: 0, z: 40 },
  ];
  const edges = [
    { id: 's', a: 'sw', b: 'se' }, { id: 'e', a: 'se', b: 'ne' },
    { id: 'n', a: 'ne', b: 'nw' }, { id: 'w', a: 'nw', b: 'sw' },
    { id: 'diag', a: 'sw', b: 'ne' },
  ];
  const net = bakeNetwork({ nodes, edges });

  check('diagonal: two triangular blocks', net.blocks.length === 2, `${net.blocks.length}`);
  check('diagonal: no degenerate lanes', net.lanes.every((l) => !l.degenerate));
  check('diagonal: every legal turn has a path',
    net.turns.filter((t) => t.legal).every((t) => t.length > 0));

  // The junction at 'sw' has three arms — east, north, and the diagonal at 45°. Nothing opposes
  // anything, so each gets a phase of its own. The grid had exactly two phases and no way to
  // describe a third.
  const sw = net.nodeById.get('sw');
  check('diagonal: 45° arm is its own street', sw.streets.length === 3,
    `${sw.streets.length} streets`);
  check('diagonal: three-phase signal', sw.signal?.phases.length === 3,
    `${sw.signal?.phases.length}`);
  check('diagonal: phases sum to the cycle',
    Math.abs(sw.signal.phases.reduce((a, p) => a + p.green + sw.signal.yellow, 0)
      - sw.signal.cycle) <= TOL);

  // Turn handedness has to come out of the geometry, not a lookup table.
  // Arriving from the east, both exits bear left — one onto the north road, one onto the
  // diagonal. Two lefts off one approach is exactly the case a `(d + 3) % 4` lookup could not
  // represent; what has to distinguish them is the angle, not the label.
  const fromEast = net.lanes.find((l) => l.from === 'se' && l.to === 'sw');
  const deltas = fromEast.exits.map((id) => net.turnById.get(id).delta);
  check('diagonal: two distinct left turns off one approach',
    deltas.length === 2 && deltas.every((d) => d < 0)
      && Math.abs(deltas[0] - deltas[1]) > 0.1,
    `${deltas.map((d) => (d * 180 / Math.PI).toFixed(0)).join('°, ')}°`);
}

/** A roundabout: a ring of one-way arcs with four approaches. */
{
  const R = 14;
  const nodes = [];
  const edges = [];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    nodes.push({ id: `r${k}`, x: Math.cos(a) * R, z: Math.sin(a) * R, kind: 'roundabout' });
    // Approach roads, radiating out from each entry point.
    nodes.push({ id: `a${k}`, x: Math.cos(a) * (R + 30), z: Math.sin(a) * (R + 30) });
    edges.push({ id: `spur${k}`, a: `a${k}`, b: `r${k}` });
  }
  for (let k = 0; k < 4; k++) {
    // Quarter-circle arcs, one-way, all running the same way round. A quarter turn is
    // bulge = tan(PI / 8); positive is a right-hand bend, so this circulates clockwise on screen.
    // A quarter turn is bulge = tan(PI / 8). Positive bends right, which for this node order is
    // the arc concentric with the island — get the sign wrong and each quarter curves around its
    // own centre instead, so consecutive arcs meet at an angle and the circulation breaks.
    edges.push({
      id: `ring${k}`, a: `r${k}`, b: `r${(k + 1) % 4}`,
      bulge: Math.tan(Math.PI / 8), oneway: 1, klass: 'ring',
    });
  }
  const net = bakeNetwork({ nodes, edges });

  check('roundabout: ring edges are one-way',
    net.lanes.filter((l) => l.edge.id.startsWith('ring')).length === 4,
    `${net.lanes.filter((l) => l.edge.id.startsWith('ring')).length} lanes on 4 ring edges`);
  check('roundabout: spurs stay two-way',
    net.lanes.filter((l) => l.edge.id.startsWith('spur')).length === 8);
  check('roundabout: no degenerate lanes', net.lanes.every((l) => !l.degenerate),
    `${net.lanes.filter((l) => l.degenerate).map((l) => l.id)}`);

  // Circulating lanes are arcs, and they sit inside the centreline circle: a car goes round on
  // the right-hand side of a clockwise ring, which is the inside.
  const ring = net.lanes.find((l) => l.edge.id === 'ring0');
  check('roundabout: circulating lane is an arc', ring.path.kind === 'arc', ring.path.kind);
  check('roundabout: circulating lane is concentric with the island',
    Math.abs(ring.path.radius - R) <= TOL && Math.hypot(ring.path.centre.x, ring.path.centre.z) <= 1e-9,
    `r=${ring.path.radius.toFixed(3)} about `
      + `(${ring.path.centre.x.toFixed(3)}, ${ring.path.centre.z.toFixed(3)})`);

  // A car can get all the way round, and can leave at every spur.
  const reachable = new Set();
  let lane = ring;
  for (let step = 0; step < 12 && lane; step++) {
    reachable.add(lane.to);
    const onward = lane.exits.map((id) => net.turnById.get(id))
      .find((t) => net.laneById.get(t.outLane).edge.id.startsWith('ring'));
    lane = onward ? net.laneById.get(onward.outLane) : null;
  }
  check('roundabout: circulates all the way round', reachable.size === 4, `${reachable.size}/4`);

  const exits = net.lanes.filter((l) => l.edge.id.startsWith('ring'))
    .flatMap((l) => l.exits.map((id) => net.turnById.get(id)))
    .filter((t) => net.laneById.get(t.outLane).edge.id.startsWith('spur'));
  check('roundabout: every spur is an exit', new Set(exits.map((t) => t.outLane)).size === 4,
    `${new Set(exits.map((t) => t.outLane)).size}/4`);

  // Entries are yield-controlled, not signalised: each ring node has one ring street and a spur.
  check('roundabout: entries are unsignalised',
    net.nodes.filter((n) => n.id.startsWith('r')).every((n) => n.signal === null));
}

/** A curved road between two ordinary junctions still produces a drivable lane. */
{
  const net = bakeNetwork({
    nodes: [{ id: 'a', x: 0, z: 0 }, { id: 'b', x: 60, z: 0 }, { id: 'c', x: 60, z: 60 }],
    edges: [
      { id: 'bend', a: 'a', b: 'b', bulge: 0.35 },
      { id: 'straight', a: 'b', b: 'c' },
    ],
  });
  const bend = net.lanes.filter((l) => l.edge.id === 'bend');
  check('curve: both directions drivable', bend.length === 2 && bend.every((l) => l.length > 0));
  check('curve: lanes are arcs', bend.every((l) => l.path.kind === 'arc'));
  // The two directions sit either side of the centreline, LANE apart from it on opposite sides.
  // Measured as a difference of radii, not between the two midpoints: the inner and outer lanes
  // cross their junction stop planes at different arc lengths, so their midpoints are not at the
  // same angle and the straight-line distance between them is not the road's width.
  const [f, r] = bend;
  check('curve: opposing lanes are concentric', f.path.kind === 'arc' && r.path.kind === 'arc'
    && Math.hypot(f.path.centre.x - r.path.centre.x, f.path.centre.z - r.path.centre.z) <= 1e-6);
  check('curve: opposing lanes are 2 x LANE apart',
    Math.abs(Math.abs(f.path.radius - r.path.radius) - 2 * LANE) <= 1e-6,
    `${Math.abs(f.path.radius - r.path.radius).toFixed(4)}`);
}

const passed = results.filter(Boolean).length;
for (const line of failures.slice(0, 12)) console.log(`  FAIL ${line}`);
if (offsetDriftNodes) {
  console.log(`  note: ${offsetDriftNodes} junction(s) across ${SEEDS} seeds sit on a coordinated`
    + ' street cut by a park closure, where the network measures the green wave from the surviving'
    + ' chain rather than the map edge');
}
if (degenerate) {
  console.log(`  note: ${degenerate} junction(s) across ${SEEDS} seeds have no conflicting`
    + ' movement — the ring\'s four corners, plus any junction a closure left a straight-through;'
    + ' the network drops their signal, the grid keeps cycling one');
}
console.log(`${passed}/${results.length} checks passed`);
process.exit(failures.length ? 1 : 0);
