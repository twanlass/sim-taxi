// The road network: nodes, edges, lanes, turns and the blocks between them.
//
// This replaces the grid as the thing every other system asks about the world. `grid.js` still
// owns the constants — road width, lane offset, block pitch — but it no longer decides what shape
// a city can be. A road here is an edge between two nodes at arbitrary positions, straight or
// curved, and everything a car needs to drive it is *derived* rather than authored:
//
//     nodes + edges  ──▶  lanes ──▶ turns ──▶ conflicts ──▶ signal phases
//            │
//            └──faces──▶ blocks
//
// That derivation is the whole point. A level editor that had to specify lane geometry and signal
// timing per junction would be unusable; one that only has to say where the roads go is not. It
// is also what makes diagonals and roundabouts possible at all — the old model encoded direction
// as `0..3` and a car's position as a world coordinate on an axis, neither of which a diagonal
// has.
//
// Equivalence with the grid is not a nice-to-have. `roadNetFromGrid` reproduces the shipped city
// exactly, and `tools/roadnet.mjs` asserts it against `grid.js` and `lightPhase` numerically, so
// that porting traffic, routing and meshing onto this model is a change with a control.

import {
  GRID, LANE, HALF_ROAD, DIR, lineCoord, isSegmentClosed, isXAxis, dirSign,
} from './grid.js';
import {
  lineCurve, arcFromBulge, bezierCurve, rayIntersect, bearingOf, wrapAngle,
  insetPolygon, signedArea2, polygonBounds,
} from './curves.js';

/**
 * Signal timing. These are the numbers the city was tuned around — see docs/traffic.md — moved
 * here because they are now a property of the network rather than of the traffic module.
 *
 * `cruise` mirrors `SPEED` in sim/traffic.js and exists so the green-wave offsets can be computed
 * without `city/` importing from `sim/`, which the module layering forbids. `tools/roadnet.mjs`
 * asserts the two stay equal; a silent drift would detune every offset in the city.
 */
export const SIGNAL_DEFAULTS = {
  cycle: 16,
  yellow: 1.6,
  arterialShare: 0.64,
  cruise: 8.5,
};

/** Two arms are the same street if their bearings are this close to opposite. */
const OPPOSITE_TOLERANCE = Math.PI / 6;

/** Bearing deltas inside this of 0 are "straight on"; within this of PI, a U-turn. */
const STRAIGHT_TOLERANCE = Math.PI / 8;

/**
 * The order a lane's exits are listed in: straight on, then right, then left.
 *
 * Not cosmetic. It is the order the grid's `legalExits` returned, and the router breaks ties
 * between equal-cost routes by taking the first one it reaches — so this ordering is what decides
 * which of two identical-length routes the taxi actually drives. Fixed here, at bake, rather than
 * sorted inside anyone's inner loop.
 */
const HAND_ORDER = { straight: 0, right: 1, left: 2, uturn: 3 };

const EPS = 1e-9;

// --- Building the network ---------------------------------------------------

/**
 * @param spec {{ nodes: [{id, x, z, kind?, radius?}], edges: [{id, a, b, bulge?, klass?, wave?}] }}
 *   `klass` is 'ring' | 'arterial' | 'side'; `wave` is +1 / -1 / 0, the coordinated direction of
 *   travel for the green wave, expressed as a→b or b→a. `oneway` is 0 for a normal two-way
 *   road, or +1 / -1 to carry traffic only a→b or only b→a.
 * @param config overrides for SIGNAL_DEFAULTS
 */
export function bakeNetwork(spec, config = {}) {
  const signal = { ...SIGNAL_DEFAULTS, ...config };

  const nodes = spec.nodes.map((n) => ({
    kind: 'junction', radius: HALF_ROAD, ...n, arms: [], streets: [], signal: null,
    // No light *and* no yielding — see `bakeSignals`. Declared here so every node carries the
    // field rather than having it appear only on the junctions that earned it.
    uncontrolled: false,
  }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const edges = spec.edges.map((e) => {
    const a = nodeById.get(e.a);
    const b = nodeById.get(e.b);
    if (!a || !b) throw new Error(`edge ${e.id} references a missing node`);
    const curve = arcFromBulge({ x: a.x, z: a.z }, { x: b.x, z: b.z }, e.bulge ?? 0);
    return {
      klass: 'side', wave: 0, bulge: 0, oneway: 0,
      ...e, curve, length: curve.length, lanes: [],
    };
  });

  buildArms(nodes, nodeById, edges);
  const lanes = buildLanes(nodes, nodeById, edges);
  const turns = buildTurns(nodes, lanes);
  const laneById = new Map(lanes.map((l) => [l.id, l]));
  const turnById = new Map(turns.map((t) => [t.id, t]));
  buildStreets(nodes);
  const chains = buildChains(nodes, nodeById, edges);
  bakeSignals(nodes, turns, laneById, chains, signal);
  const blocks = buildBlocks(nodes, edges);

  return {
    nodes, edges, lanes, turns, blocks, chains, signal,
    nodeById, laneById, turnById,
    edgeById: new Map(edges.map((e) => [e.id, e])),
    phaseAt: (node, t) => phaseAt(typeof node === 'string' ? nodeById.get(node) : node, t, signal),
    laneSignal: (lane, t) => laneSignal(
      typeof lane === 'string' ? laneById.get(lane) : lane, t, nodeById, signal,
    ),
    canProceed: (turn, t) => canProceed(
      typeof turn === 'string' ? turnById.get(turn) : turn, t, nodeById, signal,
    ),
  };
}

/**
 * Arms: one per (node, incident edge), carrying the bearing *away* from the node.
 *
 * Sorted by bearing, these replace the `(d + 1) % 4` arithmetic the grid used for left and right.
 * "The next arm clockwise" is a right turn whatever the angles happen to be, which is the single
 * change that lets a three-way or a diagonal junction work without a special case.
 */
function buildArms(nodes, nodeById, edges) {
  for (const edge of edges) {
    const a = nodeById.get(edge.a);
    const b = nodeById.get(edge.b);
    // Tangent at each end, pointing away from that end's node.
    const ta = edge.curve.tangentAt(0);
    const tb = edge.curve.tangentAt(edge.curve.length);
    a.arms.push({ node: a, edge, toward: b, forward: true, bearing: bearingOf(ta.x, ta.z) });
    b.arms.push({ node: b, edge, toward: a, forward: false, bearing: bearingOf(-tb.x, -tb.z) });
  }
  for (const node of nodes) {
    node.arms.sort((p, q) => p.bearing - q.bearing);
    node.arms.forEach((arm, index) => { arm.index = index; });
  }
}

/**
 * Where a lane crosses a junction's stop plane.
 *
 * The junction is not a circle: it reaches `radius` from the node centre along each arm, and the
 * boundary a car crosses is the plane perpendicular to *that arm*. This matters for exactness —
 * `entryPoint` in grid.js puts a car at `HALF_ROAD` along the axis while it sits `LANE` off the
 * centreline, which is 4.47 from the node centre, not 4. A circular boundary would have moved
 * every entry and exit point in the city by half a metre.
 */
function planeCrossing(curve, origin, normal, radius) {
  const depth = (s) => {
    const p = curve.at(s);
    return (p.x - origin.x) * normal.x + (p.z - origin.z) * normal.z;
  };

  // A straight lane runs parallel to its own arm, so depth grows exactly with arc length and the
  // crossing is closed-form. Worth the branch: this is the case the whole grid is made of, and a
  // bisection would leave a rounding tail on every entry point in the city.
  if (curve.kind === 'line') {
    const t = curve.tangentAt(0);
    const rate = t.x * normal.x + t.z * normal.z;
    if (Math.abs(rate) > EPS) return (radius - depth(0)) / rate;
  }

  let lo = 0;
  let hi = curve.length;
  if (depth(hi) < radius) return hi;
  for (let n = 0; n < 80; n++) {
    const mid = (lo + hi) / 2;
    if (depth(mid) < radius) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The two directed lanes of every edge, offset to the right of travel and trimmed at each end. */
function buildLanes(nodes, nodeById, edges) {
  const lanes = [];

  for (const edge of edges) {
    const a = nodeById.get(edge.a);
    const b = nodeById.get(edge.b);

    for (const forward of [true, false]) {
      // One-way roads carry a single lane. Needed before a roundabout is expressible at all: its
      // circulating carriageway is a ring of one-way arcs, and a two-way ring would let cars meet
      // head-on going round it.
      if (edge.oneway && (edge.oneway > 0) !== forward) continue;

      const from = forward ? a : b;
      const to = forward ? b : a;
      // Travelling b→a is the same curve reversed, which for a line and an arc is just a trim
      // with the ends swapped.
      const centre = forward
        ? edge.curve
        : edge.curve.trim(edge.curve.length, 0);
      // A two-way road's lanes sit `LANE` either side of the centreline; a one-way road has only
      // one lane and it runs *down* the centreline. Offsetting it anyway would push a
      // roundabout's circulating lane off its own island by two metres.
      const full = edge.oneway ? centre : centre.offset(LANE);

      const tFrom = centre.tangentAt(0);
      const tTo = centre.tangentAt(centre.length);
      const s0 = planeCrossing(full, from, tFrom, from.radius);
      const s1 = planeCrossing(full, to, { x: -tTo.x, z: -tTo.z }, to.radius);

      const lane = {
        id: `${edge.id}:${forward ? 'f' : 'r'}`,
        edge, forward, from: from.id, to: to.id,
        klass: edge.klass,
        // `withWave` is what route.js's road-hierarchy weighting reads: an arterial traversed
        // along its coordinated direction meets consecutive greens, against it consecutive reds.
        withWave: edge.klass === 'ring' || (edge.wave !== 0 && (edge.wave > 0) === forward),
        path: s1 > s0 ? full.trim(s0, s1) : null,
        exits: [],
      };
      lane.length = lane.path ? lane.path.length : 0;
      // A road shorter than the two junctions at its ends has no drivable lane. The editor has to
      // be able to refuse that rather than emit a lane of negative length.
      lane.degenerate = !lane.path;
      lanes.push(lane);
      edge.lanes.push(lane);
    }
  }

  for (const node of nodes) {
    node.inbound = lanes.filter((l) => l.to === node.id);
    node.outbound = lanes.filter((l) => l.from === node.id);
  }
  return lanes;
}

/**
 * Every legal movement across every junction, as a curve a car can follow.
 *
 * The control point is where the two lane tangents cross — the generalisation of `turnControl`,
 * whose "same axis falls back to the midpoint" special case is just this intersection being
 * parallel. One rule now covers a right turn, a left, a straight-through and a sweep across a
 * diagonal, exactly as the direction arithmetic used to cover the first three.
 */
function buildTurns(nodes, lanes) {
  const turns = [];

  for (const node of nodes) {
    for (const inLane of node.inbound) {
      if (inLane.degenerate) continue;
      const p0 = inLane.path.at(inLane.length);
      const t0 = inLane.path.tangentAt(inLane.length);

      for (const outLane of node.outbound) {
        if (outLane.degenerate) continue;
        const p2 = outLane.path.at(0);
        const t2 = outLane.path.tangentAt(0);
        const delta = wrapAngle(bearingOf(t2.x, t2.z) - bearingOf(t0.x, t0.z));

        const uturn = Math.abs(delta) > Math.PI - STRAIGHT_TOLERANCE;
        // No U-turns, exactly as `legalExits` has always enforced. Kept as a property of the turn
        // rather than dropped, so a roundabout — where doubling back *is* legal, by going round —
        // can opt in without the rule being re-litigated at every call site.
        const hand = Math.abs(delta) < STRAIGHT_TOLERANCE ? 'straight'
          : uturn ? 'uturn' : (delta > 0 ? 'right' : 'left');

        const control = rayIntersect(p0, t0, p2, t2)
          ?? { x: (p0.x + p2.x) / 2, z: (p0.z + p2.z) / 2 };

        const turn = {
          id: `${inLane.id}>${outLane.id}`,
          node: node.id, inLane: inLane.id, outLane: outLane.id,
          hand, delta, control,
          path: bezierCurve(p0, control, p2),
          legal: !uturn && inLane.edge !== outLane.edge,
          phase: -1,
          conflicts: [],
        };
        turn.length = turn.path.length;
        turns.push(turn);
        if (turn.legal) inLane.exits.push(turn.id);
      }
    }
  }

  const byId = new Map(turns.map((t) => [t.id, t]));
  const byLaneId = new Map(lanes.map((l) => [l.id, l]));
  for (const lane of lanes) {
    lane.exits.sort((p, q) => HAND_ORDER[byId.get(p).hand] - HAND_ORDER[byId.get(q).hand]);
    // Where each exit lands, resolved once. The router walks this every expansion, and rebuilding
    // it from turn ids inside Dijkstra's inner loop was most of the cost of planning a route.
    lane.onward = lane.exits.map((id) => byLaneId.get(byId.get(id).outLane));
  }

  buildConflicts(nodes, turns);
  return turns;
}

/**
 * Which turns cannot run at the same time.
 *
 * Two movements conflict if their paths cross, or if they merge into the same lane from different
 * approaches. Movements off the *same* approach never conflict — they share a phase by
 * construction, and a car choosing between them has already picked one.
 *
 * Computed once here rather than reasoned about per junction, which is what lets the phase
 * generator below work on a shape nobody anticipated.
 */
function buildConflicts(nodes, turns) {
  const byNode = new Map();
  for (const turn of turns) {
    if (!turn.legal) continue;
    if (!byNode.has(turn.node)) byNode.set(turn.node, []);
    byNode.get(turn.node).push(turn);
  }

  for (const group of byNode.values()) {
    const samples = new Map();
    for (const turn of group) {
      const pts = [];
      const n = Math.max(4, Math.ceil(turn.length / 1.2));
      for (let k = 0; k <= n; k++) pts.push(turn.path.at((k / n) * turn.length));
      samples.set(turn.id, pts);
    }

    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const p = group[a];
        const q = group[b];
        if (p.inLane === q.inLane) continue;
        const crosses = p.outLane === q.outLane
          || polylinesCross(samples.get(p.id), samples.get(q.id));
        if (crosses) {
          p.conflicts.push(q.id);
          q.conflicts.push(p.id);
        }
      }
    }
  }
}

function segmentsCross(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  const o1 = o(a, b, c);
  const o2 = o(a, b, d);
  const o3 = o(c, d, a);
  const o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

function polylinesCross(p, q) {
  for (let a = 0; a + 1 < p.length; a++) {
    for (let b = 0; b + 1 < q.length; b++) {
      if (segmentsCross(p[a], p[a + 1], q[b], q[b + 1])) return true;
    }
  }
  return false;
}

// --- Streets and phases -----------------------------------------------------

/**
 * Group each node's arms into streets — pairs of arms that carry on through the junction.
 *
 * A street is the unit a signal phase is built from, which is what makes the generated phasing
 * match the hand-written one: on a four-way, pairing opposite arms yields exactly the X street and
 * the Z street that `lightPhase` hard-codes as `axis: 'x'` and `axis: 'z'`. An arm with nothing
 * opposite it — the stem of a T, the fifth road into a five-way — becomes a street of its own and
 * gets its own phase, which is the behaviour you want and the grid model could not express.
 */
function buildStreets(nodes) {
  for (const node of nodes) {
    const taken = new Set();
    const streets = [];

    for (const arm of node.arms) {
      if (taken.has(arm.index)) continue;
      let best = null;
      let bestError = OPPOSITE_TOLERANCE;
      for (const other of node.arms) {
        if (other.index === arm.index || taken.has(other.index)) continue;
        const error = Math.abs(Math.abs(wrapAngle(other.bearing - arm.bearing)) - Math.PI);
        if (error < bestError) { bestError = error; best = other; }
      }
      taken.add(arm.index);
      if (best) taken.add(best.index);
      streets.push({ arms: best ? [arm, best] : [arm] });
    }

    // Ordered by the street's axis, folded into [0, PI) so the two arms of one street agree.
    // On the grid this puts the X street first and the Z street second, which is the order
    // `lightPhase` runs its greens in.
    for (const street of streets) {
      const b = street.arms[0].bearing;
      street.axis = ((b % Math.PI) + Math.PI) % Math.PI;
      street.klass = street.arms.some((a) => a.edge.klass === 'arterial') ? 'arterial'
        : street.arms.every((a) => a.edge.klass === 'ring') ? 'ring' : 'side';
    }
    streets.sort((p, q) => p.axis - q.axis);
    streets.forEach((s, index) => { s.index = index; });
    node.streets = streets;
  }
}

/**
 * Maximal through-routes: follow each street's paired arm from junction to junction.
 *
 * The green wave needs these. A junction's offset is "how long a platoon takes to get here from
 * the top of the street", and that is a distance measured along a chain of edges — on the grid it
 * was `i * PITCH`, readable straight off the index. With arbitrary geometry it has to be walked.
 */
function buildChains(nodes, nodeById, edges) {
  const chains = [];
  const seen = new Set();

  /** The arm a street continues into, arriving at `node` along `edge`. */
  const continuation = (node, edge) => {
    const street = node.streets.find((s) => s.arms.some((a) => a.edge === edge));
    if (!street || street.arms.length < 2) return null;
    return street.arms.find((a) => a.edge !== edge) ?? null;
  };

  for (const start of edges) {
    if (seen.has(start.id)) continue;

    // Walk back to the chain's head, then forward collecting it. Guarded against a ring road
    // closing on itself, which is a chain with no ends at all.
    let head = start;
    let headNode = nodeById.get(start.a);
    for (let guard = 0; guard < edges.length; guard++) {
      const prev = continuation(headNode, head);
      if (!prev || prev.edge === start) break;
      head = prev.edge;
      headNode = prev.toward;
    }

    const chain = { edges: [], nodes: [headNode] };
    let edge = head;
    let node = headNode;
    for (let guard = 0; guard <= edges.length; guard++) {
      chain.edges.push(edge);
      seen.add(edge.id);
      const far = nodeById.get(edge.a) === node ? nodeById.get(edge.b) : nodeById.get(edge.a);
      chain.nodes.push(far);
      const next = continuation(far, edge);
      if (!next || seen.has(next.edge.id)) break;
      edge = next.edge;
      node = far;
    }

    // Cumulative distance from each end, so the offset can be measured from whichever end the
    // wave flows out of.
    chain.distance = new Map();
    let run = 0;
    chain.distance.set(chain.nodes[0].id, 0);
    chain.edges.forEach((e, index) => {
      run += e.length;
      chain.distance.set(chain.nodes[index + 1].id, run);
    });
    chain.total = run;
    // Which way the wave runs, read off the first edge that has an opinion.
    const lead = chain.edges.find((e) => e.wave !== 0);
    chain.wave = lead ? (nodeById.get(lead.a) === chain.nodes[chain.edges.indexOf(lead)]
      ? lead.wave : -lead.wave) : 0;
    chain.klass = chain.edges.some((e) => e.klass === 'arterial') ? 'arterial'
      : chain.edges.every((e) => e.klass === 'ring') ? 'ring' : 'side';

    for (const e of chain.edges) e.chain = chain;
    chains.push(chain);
  }

  return chains;
}

/**
 * Phase plan per node: which turns move together, for how long, and when the cycle starts.
 *
 * One phase per street, in street order, each followed by a yellow. The green split gives an
 * arterial the larger share where it crosses a lesser road — the same 64/36 the city was tuned
 * around — and the offset shifts the whole plan earlier by the platoon's travel time from the top
 * of the coordinated street, which is what makes the wave travel with the traffic.
 */
function bakeSignals(nodes, turns, laneById, chains, signal) {
  const turnsByNode = new Map();
  for (const turn of turns) {
    if (!turn.legal) continue;
    if (!turnsByNode.has(turn.node)) turnsByNode.set(turn.node, []);
    turnsByNode.get(turn.node).push(turn);
  }

  for (const node of nodes) {
    const streets = node.streets;
    const nodeTurns = turnsByNode.get(node.id) ?? [];

    // Each approach belongs to the phase of the street it *arrives* on, and so does every turn
    // taken off it. Putting it on the lane matters as much as putting it on the turn: a car asks
    // "may I enter?" while it is still approaching, before it has chosen which way to go, and all
    // the movements off one approach share a phase by construction — which is exactly why that
    // question is well-posed.
    const streetOfEdge = (edge) => streets.find((s) => s.arms.some((a) => a.edge === edge));
    for (const lane of node.inbound) {
      lane.phase = streetOfEdge(lane.edge)?.index ?? 0;
    }
    for (const turn of nodeTurns) {
      turn.phase = streetOfEdge(laneById.get(turn.inLane)?.edge)?.index ?? 0;
    }

    const ringStreets = streets.filter((s) => s.klass === 'ring');

    // Nothing to arbitrate, so nothing to control: no two movements through here cross. A
    // two-arm pass-through and a dead end are the obvious cases, and the ring's four **corners**
    // are the one that isn't. A corner has two arms meeting at a right angle, so every car
    // through it is turning — but the turn off one arm is a right and the turn off the other is a
    // left, they land in different lanes, and with right-hand traffic they sweep opposite sides
    // of the bend without ever meeting. `buildConflicts` says so directly (both turns come back
    // with an empty `conflicts`), which is why this asks it rather than special-casing (i, j):
    // a closure that leaves an interior junction bent the same way gets the same answer for the
    // same reason.
    //
    // Keyed on conflicts rather than on `streets.length <= 1`, which this subsumes — a single
    // street is two collinear arms, and a straight-through conflicts with nothing either.
    //
    // `uncontrolled` is the half that matters at a corner. Unsignalised alone would leave one
    // street with priority and the other yielding into a `RING_YIELD` gap, which on a ring
    // carrying continuous traffic means cars stopping at a bend for cars that are turning away
    // from them. Nothing conflicts, so nobody yields: every approach simply runs.
    if (!nodeTurns.some((turn) => turn.conflicts.length > 0)) {
      node.signal = null;
      node.uncontrolled = true;
      node.priorityStreet = 0;
      continue;
    }

    // The ring is deliberately signal-free — traffic on it never stops, and traffic joining from
    // a cross street yields into a gap. The corners never reach here: they are two ring streets
    // with nothing between them to arbitrate, and the branch above has already claimed them.
    if (ringStreets.length === 1) {
      node.signal = null;
      node.priorityStreet = ringStreets[0].index;
      continue;
    }

    const arterials = streets.filter((s) => s.klass === 'arterial');
    const totalGreen = signal.cycle - streets.length * signal.yellow;

    let shares;
    if (streets.length === 2 && arterials.length === 1) {
      shares = streets.map((s) => (s.klass === 'arterial' ? signal.arterialShare : 1 - signal.arterialShare));
    } else {
      shares = streets.map(() => 1 / streets.length);
    }
    const greens = shares.map((share) => totalGreen * share);

    // Coordinate along the arterial if exactly one street is one; otherwise along the first,
    // which on a grid of side streets means they all coordinate along X.
    const coord = arterials.length === 1 ? arterials[0] : streets[0];
    let ahead = 0;
    for (let k = 0; k < coord.index; k++) ahead += greens[k] + signal.yellow;

    // Distance a platoon has already covered getting here, measured from the end of the street
    // the wave flows out of.
    const chain = coord.arms[0].edge.chain;
    let travelled = 0;
    if (chain) {
      const along = chain.distance.get(node.id) ?? 0;
      travelled = chain.wave >= 0 ? along : chain.total - along;
    }

    node.signal = {
      phases: streets.map((s, index) => ({
        street: s.index, green: greens[index],
        turns: nodeTurns.filter((t) => t.phase === index).map((t) => t.id),
      })),
      cycle: signal.cycle,
      yellow: signal.yellow,
      offset: ahead - travelled / signal.cruise,
      // What the offset was measured against, kept so the equivalence tool can tell a genuine
      // difference from a bug: a junction whose coordinated street was cut in half by a closure
      // has a shorter chain to measure along than the grid's "distance from the map edge", and
      // that shows up here as a `chainTotal` short of the full span.
      wave: { chainTotal: chain?.total ?? 0, travelled },
    };
    node.priorityStreet = -1;
  }
}

/**
 * Which phase a junction is showing at time t.
 *
 * Returns null for an unsignalised node — the ring, and anything with nothing to arbitrate — so
 * callers distinguish "no light here" from "the light is red", which the old `axis`-shaped return
 * could only do by convention.
 */
export function phaseAt(node, t, signal = SIGNAL_DEFAULTS) {
  if (!node?.signal) return null;
  const { phases, cycle, yellow, offset } = node.signal;
  const local = (((t + offset) % cycle) + cycle) % cycle;

  let run = 0;
  for (let index = 0; index < phases.length; index++) {
    const green = phases[index].green;
    if (local < run + green) return { index, yellow: false, remaining: run + green - local };
    if (local < run + green + yellow) {
      return { index, yellow: true, remaining: run + green + yellow - local };
    }
    run += green + yellow;
  }
  // Rounding at the very end of the cycle; the last phase's yellow is still the truth.
  return { index: phases.length - 1, yellow: true, remaining: 0 };
}

/**
 * What the signal is doing for traffic arriving on one lane.
 *
 * This is the query the sim actually makes, and the reason `phaseAt` alone was not enough to port
 * it: a car asks "may I enter?" while it is still approaching, *before* it has chosen a turn, so a
 * per-turn answer has the wrong arity and a per-node answer has no opinion about which approach is
 * asking. Every movement off one approach shares a phase by construction (see `bakeSignals`), so
 * the per-lane question is exactly as well-posed as the per-turn one.
 *
 * `signalised` is reported separately from `open` because they mean different things to a driver:
 * a red means wait for green, no light at all means yield on a gap. The old model could only tell
 * them apart by convention — `lightPhase` returned an axis with `remaining: Infinity` for both a
 * ring junction and a green.
 */
export function laneSignal(lane, t, nodeById, signal = SIGNAL_DEFAULTS) {
  const node = nodeById.get(lane.to);

  if (!node.signal) {
    // No light here. The priority street runs and everything else yields on a gap — except at an
    // `uncontrolled` junction, where no two movements cross at all and so every street runs. That
    // second case used to be covered by "nothing conflicts means exactly one street, which *is*
    // the priority street"; a ring corner is two streets that still conflict over nothing, so the
    // flag now carries what the arithmetic used to imply.
    return {
      signalised: false,
      open: node.uncontrolled || lane.phase === node.priorityStreet,
      yellow: false,
      remaining: Infinity,
      street: node.priorityStreet,
    };
  }

  const phase = phaseAt(node, t, signal);
  const mine = phase.index === lane.phase;
  return {
    signalised: true,
    open: mine && !phase.yellow,
    yellow: mine && phase.yellow,
    remaining: phase.remaining,
    street: phase.index,
  };
}

/**
 * May this movement be taken right now? Yellow counts as stop, which keeps the question a single
 * boolean everywhere it is asked — the same rule the grid model used.
 */
export function canProceed(turn, t, nodeById, signal = SIGNAL_DEFAULTS) {
  if (!turn?.legal) return false;
  const node = nodeById.get(turn.node);
  if (!node.signal) return true;      // unsignalised: priority and yielding are the sim's problem
  const phase = phaseAt(node, t, signal);
  return phase.index === turn.phase && !phase.yellow;
}

// --- Blocks -----------------------------------------------------------------

/**
 * The buildable land, as the faces of the planar road graph inset by half a road width.
 *
 * This is the observation the whole editor rests on: `ground.js` never draws roads — the slab is
 * asphalt and the *blocks* are raised platforms on top of it, so roads are the negative space.
 * A block therefore doesn't have to be a grid cell. It can be whatever the roads happen to
 * enclose, which means drawing a diagonal across a block splits it into two triangular blocks
 * with no further authoring, and closing a road merges two blocks into one — the park-district
 * behaviour, now falling out of the model instead of being special-cased.
 */
function buildBlocks(nodes, edges) {
  // Half-edge traversal. Arriving at a node, the next half-edge of the face is the arm just
  // *before* the one we came in on, going round by bearing — the standard "next edge clockwise"
  // walk, which visits every face exactly once.
  const key = (edgeId, forward) => `${edgeId}|${forward ? 'f' : 'r'}`;
  const armOf = (node, edge) => node.arms.find((a) => a.edge === edge);
  const visited = new Set();
  const faces = [];

  for (const edge of edges) {
    for (const forward of [true, false]) {
      if (visited.has(key(edge.id, forward))) continue;

      const poly = [];
      let e = edge;
      let f = forward;
      for (let guard = 0; guard <= edges.length * 2 + 2; guard++) {
        visited.add(key(e.id, f));
        const arrive = f ? e.b : e.a;
        const node = nodes.find((n) => n.id === arrive);
        poly.push({ x: node.x, z: node.z });

        const arm = armOf(node, e);
        const prev = node.arms[(arm.index + node.arms.length - 1) % node.arms.length];
        const nextEdge = prev.edge;
        const nextForward = nextEdge.a === node.id;
        if (visited.has(key(nextEdge.id, nextForward))) break;
        e = nextEdge;
        f = nextForward;
      }
      if (poly.length >= 3) faces.push(poly);
    }
  }

  // The outer boundary comes out of the same traversal as a face; it is the one that encloses
  // everything else, so it is simply the largest.
  let outer = -1;
  let outerArea = -Infinity;
  faces.forEach((poly, index) => {
    const area = Math.abs(signedArea2(poly));
    if (area > outerArea) { outerArea = area; outer = index; }
  });

  const blocks = [];
  faces.forEach((poly, index) => {
    if (index === outer) return;
    const inset = insetPolygon(poly, HALF_ROAD);
    if (!inset) return;              // a sliver between two roads: nothing buildable on it
    blocks.push({
      id: `block:${blocks.length}`,
      polygon: inset,
      face: poly,
      // Kept alongside the polygon because buildings.js and props.js scatter within an AABB and
      // reject what falls outside; they never needed more than this.
      bounds: polygonBounds(inset),
      area: Math.abs(signedArea2(inset)) / 2,
      type: 'built',
    });
  });

  return blocks;
}

// --- The grid, as a network -------------------------------------------------

/**
 * The shipped 5×5 city, expressed in the new model.
 *
 * This exists to be *compared*, not just to work: every node position, lane offset, turn arc and
 * signal phase it produces is asserted against `grid.js` and `lightPhase` in `tools/roadnet.mjs`.
 * Porting traffic and routing onto the network is only safe because that equivalence is checked
 * first, so a behaviour change afterwards is unambiguously a porting bug rather than a new city.
 */
/**
 * The network the running city is built on.
 *
 * Held here for the same reason `grid.js` holds the closed segments and `traffic.js` holds the
 * signal config: there is exactly one city at a time, and every system needs to ask it questions
 * without threading it through five constructors that have no other use for it. `createLayout`
 * installs it, which is already where the closures and the arterials are decided.
 */
let city = null;

export function setCityNetwork(net) {
  city = net;
  return net;
}

export const cityNetwork = () => city;

export function roadNetFromGrid(layout, config = {}) {
  const arterialX = layout?.arterials?.x ?? new Set();
  const arterialZ = layout?.arterials?.z ?? new Set();
  const dirX = layout?.arterials?.dirX ?? new Map();
  const dirZ = layout?.arterials?.dirZ ?? new Map();

  const nodes = [];
  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      nodes.push({ id: gridNodeId(i, j), x: lineCoord(i), z: lineCoord(j), gi: i, gj: j });
    }
  }

  const edges = [];
  const addEdge = (i, j, ni, nj, axis, line) => {
    // A road built over by a park district genuinely is not there — same authority as before.
    if (isSegmentClosed(i, j, axis === 'x' ? 0 : 1)) return;

    const outer = line === 0 || line === GRID;
    const arterial = axis === 'x' ? arterialX.has(line) : arterialZ.has(line);
    const klass = outer ? 'ring' : arterial ? 'arterial' : 'side';
    // Edges are always created in the +X / +Z direction, so a coordinated direction of +1 is
    // a→b and -1 is b→a with no further bookkeeping.
    const wave = arterial ? ((axis === 'x' ? dirX.get(line) : dirZ.get(line)) ?? 1) : 0;

    edges.push({
      id: `${gridNodeId(i, j)}-${gridNodeId(ni, nj)}`,
      a: gridNodeId(i, j), b: gridNodeId(ni, nj), klass, wave,
    });
  };

  for (let i = 0; i <= GRID; i++) {
    for (let j = 0; j <= GRID; j++) {
      if (i < GRID) addEdge(i, j, i + 1, j, 'x', j);   // road running along X, at line j
      if (j < GRID) addEdge(i, j, i, j + 1, 'z', i);   // road running along Z, at line i
    }
  }

  const net = bakeNetwork({ nodes, edges }, config);
  const byEnds = new Map(net.lanes.map((l) => [`${l.from}>${l.to}`, l]));
  /** Intersection one step from (i, j) along grid direction `d`, sign `way` (+1 on, -1 back). */
  const step = (d, i, j, way) => (isXAxis(d)
    ? { i: i + way * dirSign(d), j }
    : { i, j: j + way * dirSign(d) });

  net.nodeByGrid = (i, j) => net.nodeById.get(gridNodeId(i, j));
  /**
   * Grid direction a lane travels.
   *
   * The adapter every consumer needs while it still stores `car.d` and plans in `(i, j, d)`.
   * Defined once, here, rather than re-derived in the router and the sim: it is the single point
   * where the network is read back as a grid, and it works precisely as long as the city is one.
   */
  net.dirOfLane = (lane) => {
    const a = net.nodeById.get(lane.from);
    const b = net.nodeById.get(lane.to);
    if (b.gi > a.gi) return DIR.PX;
    if (b.gi < a.gi) return DIR.NX;
    return b.gj > a.gj ? DIR.PZ : DIR.NZ;
  };
  /** The lane a car travelling grid direction `d` toward intersection (i, j) is on. */
  net.laneByGrid = (d, i, j) => {
    const back = step(d, i, j, -1);
    return byEnds.get(`${gridNodeId(back.i, back.j)}>${gridNodeId(i, j)}`) ?? null;
  };
  /** The lane a car leaves intersection (i, j) on, travelling grid direction `d`. */
  net.laneOutByGrid = (d, i, j) => {
    const ahead = step(d, i, j, 1);
    return byEnds.get(`${gridNodeId(i, j)}>${gridNodeId(ahead.i, ahead.j)}`) ?? null;
  };
  return net;
}

export const gridNodeId = (i, j) => `${i},${j}`;
