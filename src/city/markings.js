// Street markings, the second pass (Tyler, 2026-11-24): zebra crossings, a stop line and a painted
// STOP on every all-way-stop approach, and a bike lane down one street on each axis. `?markings=
// classic` keeps the first pass — four fat bars per crossing and nothing else (`ground.js`).
//
// Everything here is laid **per lane off the road network**, not off the grid, because each mark
// belongs to a direction of travel: a stop line covers only the inbound half of the road, a STOP
// reads the right way up for the driver approaching it, a bike lane sits on the driver's right.
// The network already knows all three; the grid would have had to be told each one again.
//
// Cost: the whole set is one flat-colour triangle soup merged into the ground mesh, so it adds no
// draw call, no material and no shader work to either renderer — only vertices: 5.1k triangles on
// seed 1, taking the ground mesh from 11.6k to 16.3k (the classic bars it replaces were ~0.4k), and
// ~7ms to build in Node. Nothing here is a texture or a
// fragment-shader pattern: painted streets as a *shader* was once the biggest cost on the phone.
//
// Heights. Every mark lies at `MARK_Y`, and nothing in this file overlaps anything else on that
// plane — the bike lane's red band stops where the zebra's stripes stop, the STOP word stops short
// of the bike lane's edge line — so there is no second level to fight over. `tools/zfight.mjs`
// scans this mesh with the rest of the ground.

import * as THREE from 'three';
import { color } from '../palette.js';
import { cityNetwork } from './roadnet.js';
import { GRID_I, GRID_J, MEDIAN_W, isArterialX, isArterialZ, isRiverGap, riverBanks } from './grid.js';

export const MARKINGS_CLASSIC = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('markings') === 'classic'
  : globalThis.process?.env?.MARKINGS === 'classic';

// --- Measurements, all from the junction box edge (where a lane's path ends) -----------------
//
// A car holds with its centre `STOP_SETBACK` (3.4) back from the box edge, so its nose rests 1.7
// back. The zebra is stopped short of that (0.15..1.45) and the stop line laid under the nose
// (1.55..1.85): the car reads as having pulled up *to* the line rather than over the crossing.
// The first pass's bars ran to 1.65, which put the nose on the crossing's last stripe.
const ZEBRA_NEAR = 0.15;
const ZEBRA_FAR = 1.45;
// Stripes across half a 9-wide street: four at a 1.1 pitch, 0.55 wide, the first a half-stripe off
// the centreline so the two halves meet as one evenly spaced crossing with the gap on the
// centreline. At play zoom (~7.7px a unit) a stripe is ~4px and a gap ~4px: the narrowest that
// still reads as stripes on a phone. The first pass's 0.72 bars at a ~2 pitch read as four tiles.
const STRIPE_W = 0.55;
const STRIPE_PITCH = 1.1;
const STOP_NEAR = 1.55;
const STOP_FAR = 1.85;
// The STOP word: a 3×5 pixel face, each pixel 0.17 across the lane and 0.3 along it. Road
// lettering is stretched along the direction of travel so it reads foreshortened from a driver's
// seat; this camera foreshortens the other way round on half the approaches, and 1.75× is about
// where it stays legible both ways. Laid 0.5 behind the stop line, so a queued car covers it.
const PX_ACROSS = 0.17;
const PX_ALONG = 0.3;
const WORD_GAP = 0.5;
// Lanes too short for a word between the stop line and the crossing at their far end go without.
const WORD_MIN_LANE = 8;
// The bike lane: an edge line 3.2..3.34 off the centreline and the lane beyond it to the kerb. A car
// is 1.7 wide on a lane centre 2.25 off, so its flank is at 3.1 — the line clears every car that
// is keeping to its lane, and anything over it (a pull-over, the taxi's weave) is in the bike lane,
// which is what a real one looks like too.
const BIKE_LINE_IN = 3.2;
const BIKE_LINE_OUT = 3.34;
const BIKE_KERB_GAP = 0.08;
// 0.01 under the paint, still 0.01 over the asphalt: the CLAUDE.md margin for standing a part proud.
const BIKE_FILL_DROP = 0.01;

const FONT = {
  S: ['111', '100', '111', '001', '111'],
  T: ['111', '010', '010', '010', '010'],
  O: ['111', '101', '101', '101', '111'],
  P: ['111', '101', '111', '100', '100'],
};

/** The lines (by grid index) that carry a bike lane: one ordinary street on each axis. */
function pickBikeLines(rng) {
  const zLines = [];
  for (let i = 1; i < GRID_I; i++) if (!isArterialZ(i)) zLines.push(i);
  const xLines = [];
  for (let j = 1; j < GRID_J; j++) if (!isArterialX(j)) xLines.push(j);
  return {
    z: zLines.length ? rng.pick(zLines) : null,
    x: xLines.length ? rng.pick(xLines) : null,
  };
}

/**
 * Builds the markings as one non-indexed geometry with baked colour and up normals, ready to merge
 * into the ground. `y` is the paint height (`MARK_Y`).
 */
export function streetMarkings(rng, y) {
  const net = cityNetwork();
  const positions = [];
  const colors = [];
  const white = new THREE.Color(color('crosswalk'));
  const line = new THREE.Color(color('laneMark'));
  const bikeRed = new THREE.Color(color('bikeLane'));
  const bikeFill = new THREE.Color(color('bikeLaneFill'));

  // One triangle, wound to face up whichever order its corners came in. Computed from the winding,
  // not assumed (CLAUDE.md: an unlit-looking reversed face on the road reads as z-fighting).
  const tri = (a, b, c, col, h = y) => {
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    const [p, q, r] = ny >= 0 ? [a, b, c] : [a, c, b];
    for (const v of [p, q, r]) {
      positions.push(v.x, h, v.z);
      colors.push(col.r, col.g, col.b);
    }
  };

  const banks = riverBanks();
  const overWater = (p) => banks !== null && p.z > banks.z0 - 0.05 && p.z < banks.z1 + 0.05;
  const bikes = pickBikeLines(rng);

  // Grid facts about a lane's edge, read off the node ids' grid indices (`gi`, `gj`). A network
  // whose nodes carry none (`?layout=` non-grid) gets no bike lane and no bridge test, which is
  // what it wants: neither concept is defined there.
  const gridOf = (lane) => {
    const a = net.nodeById.get(lane.edge.a);
    const b = net.nodeById.get(lane.edge.b);
    if (a?.gi === undefined || b?.gi === undefined) return { bike: false, bridge: false };
    const alongZ = a.gi === b.gi;
    const bike = alongZ ? a.gi === bikes.z : a.gj === bikes.x;
    const bridge = alongZ && isRiverGap(Math.min(a.gj, b.gj));
    return { bike, bridge };
  };

  /**
   * A frame on a lane at distance `s` along it: `at(along, across)` maps an offset along the lane
   * (+ = direction of travel) and a distance *from the road centreline* (+ = toward this lane's
   * kerb, which is the driver's right) to a world point.
   */
  const frameAt = (lane, s) => {
    const p = lane.path.at(s);
    const t = lane.path.tangentAt(s);
    let n = { x: -t.z, z: t.x };
    // The kerbward side is the one away from the centreline through the junction the lane enters.
    const node = net.nodeById.get(lane.to);
    if ((p.x - node.x) * n.x + (p.z - node.z) * n.z < 0) n = { x: -n.x, z: -n.z };
    const off = lane.edge.laneOffset;
    const cx = p.x - n.x * off;
    const cz = p.z - n.z * off;
    return (along, across) => ({
      x: cx + t.x * along + n.x * across,
      z: cz + t.z * along + n.z * across,
    });
  };

  /** A rectangle in lane space: `s0..s1` along the lane, `b0..b1` from the centreline. */
  const rect = (lane, s0, s1, b0, b1, col, h = y) => {
    const f = frameAt(lane, (s0 + s1) / 2);
    const hl = (s1 - s0) / 2;
    const a = f(-hl, b0);
    const b = f(hl, b0);
    const c = f(hl, b1);
    const d = f(-hl, b1);
    tri(a, b, c, col, h);
    tri(a, c, d, col, h);
  };

  // A zebra over this lane's half of the road at the box edge `edgeS` (0 or `lane.length`),
  // reaching away from the junction by `dir` (+1 into the lane, −1 back out of its end).
  const zebra = (lane, edgeS, dir, bike) => {
    const s0 = edgeS + dir * ZEBRA_NEAR;
    const s1 = edgeS + dir * ZEBRA_FAR;
    const lo = Math.min(s0, s1);
    const hi = Math.max(s0, s1);
    const half = lane.edge.halfWidth;
    const reach = bike ? BIKE_LINE_IN - 0.15 : half - 0.15;
    for (let b = STRIPE_PITCH / 2; b + STRIPE_W / 2 <= reach; b += STRIPE_PITCH) {
      rect(lane, lo, hi, b - STRIPE_W / 2, b + STRIPE_W / 2, white);
    }
    // The bike lane crosses in red, beside the stripes rather than under them.
    if (bike) rect(lane, lo, hi, BIKE_LINE_IN, half - BIKE_KERB_GAP, bikeRed);
  };

  const word = (lane, sNear, b0, b1, text) => {
    const letters = [...text].map((ch) => FONT[ch]);
    const width = letters.length * 3 + (letters.length - 1);
    const left = (b0 + b1) / 2 - (width * PX_ACROSS) / 2;
    letters.forEach((glyph, li) => {
      glyph.forEach((row, r) => {
        // Row 0 is the top of the letter, which is the end furthest down the road.
        const sHi = sNear + (5 - r) * PX_ALONG;
        const sLo = sHi - PX_ALONG;
        // Runs of lit pixels in a row go down as one rectangle rather than one per pixel.
        let c = 0;
        while (c < 3) {
          if (row[c] !== '1') { c++; continue; }
          let e = c;
          while (e < 3 && row[e] === '1') e++;
          const x0 = left + (li * 4 + c) * PX_ACROSS;
          rect(lane, sLo, sHi, x0, x0 + (e - c) * PX_ACROSS, white);
          c = e;
        }
      });
    });
  };

  // A bicycle in side profile, wheels along the direction of travel, centred `s` along the lane
  // and `b` off the centreline. Built from thin strokes: two wheel rings and the frame triangle.
  const bicycle = (lane, s, b) => {
    const f = frameAt(lane, s);
    const W = 0.07;   // stroke half-width
    const stroke = (a0, c0, a1, c1) => {
      const da = a1 - a0;
      const dc = c1 - c0;
      const len = Math.hypot(da, dc) || 1;
      const pa = (-dc / len) * W;
      const pc = (da / len) * W;
      const p = f(a0 + pa, c0 + pc);
      const q = f(a1 + pa, c1 + pc);
      const r = f(a1 - pa, c1 - pc);
      const u = f(a0 - pa, c0 - pc);
      tri(p, q, r, white);
      tri(p, r, u, white);
    };
    const R = 0.36;
    const SEG = 10;
    for (const wa of [-0.6, 0.6]) {
      for (let k = 0; k < SEG; k++) {
        const t0 = (k / SEG) * Math.PI * 2;
        const t1 = ((k + 1) / SEG) * Math.PI * 2;
        stroke(wa + Math.cos(t0) * R, b + Math.sin(t0) * R, wa + Math.cos(t1) * R, b + Math.sin(t1) * R);
      }
    }
    // "Up" on the bike is toward the centreline (−b): the glyph lies with its wheels on the kerb side.
    const up = -1;
    const rear = [-0.6, b];
    const front = [0.6, b];
    const crank = [-0.1, b];
    const seat = [-0.27, b + up * 0.48];
    const head = [0.38, b + up * 0.48];
    stroke(...rear, ...crank);
    stroke(...rear, ...seat);
    stroke(...crank, ...seat);
    stroke(...seat, ...head);
    stroke(...crank, ...head);
    stroke(...head, ...front);
    stroke(head[0] - 0.1, head[1] + up * 0.1, head[0] + 0.08, head[1] + up * 0.1);
  };

  // Crossings go where the first pass put them: at a junction with traffic control (every
  // non-ring junction, all of them all-way stops now) and across an ordinary street only — a
  // main road isn't halted for a pedestrian.
  const crossingAt = (node, lane) => node.signal && lane.edge.klass === 'side';

  for (const lane of net.lanes) {
    if (lane.degenerate || !lane.path) continue;
    const { bike, bridge } = gridOf(lane);
    if (bridge) continue;
    const L = lane.length;
    const toNode = net.nodeById.get(lane.to);
    const fromNode = net.nodeById.get(lane.from);
    const half = lane.edge.halfWidth;

    // A crossing belongs to a road's whole width; each lane paints its own half, at both ends.
    const nearHere = (s) => overWater(frameAt(lane, s)(0, 0));
    const crossEnd = crossingAt(toNode, lane) && !nearHere(L - ZEBRA_FAR);
    const crossStart = crossingAt(fromNode, lane) && !nearHere(ZEBRA_FAR);
    if (crossEnd) zebra(lane, L, -1, bike);
    if (crossStart) zebra(lane, 0, 1, bike);

    // The approach to an all-way stop: the line, and the word behind it.
    const inner = lane.edge.klass === 'arterial' ? MEDIAN_W / 2 + 0.05 : 0.12;
    const carOuter = bike ? BIKE_LINE_IN - 0.06 : half - 0.15;
    if (toNode.signal && !nearHere(L - STOP_FAR)) {
      rect(lane, L - STOP_FAR, L - STOP_NEAR, inner, half - BIKE_KERB_GAP - 0.07, line);
      const wordFar = L - STOP_FAR - WORD_GAP;
      const wordNear = wordFar - 5 * PX_ALONG;
      if (L >= WORD_MIN_LANE && wordNear > ZEBRA_FAR + 0.5) word(lane, wordNear, inner, carOuter, 'STOP');
    }

    if (bike) {
      // The edge line runs between whatever closes off each end: a crossing, or the stop line.
      const s0 = crossStart ? ZEBRA_FAR + 0.2 : 0.3;
      const s1 = toNode.signal ? L - STOP_FAR - 0.2 : crossEnd ? L - ZEBRA_FAR - 0.2 : L - 0.3;
      if (s1 > s0) {
        rect(lane, s0, s1, BIKE_LINE_IN, BIKE_LINE_OUT, line);
        // The lane itself is surfaced, in a muted version of the crossing's red. This is the one
        // mark that *does* sit under another — the bicycle — so it goes down at `BIKE_FILL_DROP`
        // under the paint plane rather than on it (it overlaps nothing else: it stops at the edge
        // line on one side, the kerb on the other and short of the stop line at the end).
        rect(lane, s0, s1, BIKE_LINE_OUT, half - BIKE_KERB_GAP, bikeFill, y - BIKE_FILL_DROP);
      }
      // One bicycle just past the start of each block, where the lane reads as beginning.
      const glyphS = s0 + 1.6;
      if (glyphS + 1.2 < s1) bicycle(lane, glyphS, half - BIKE_KERB_GAP - 0.45);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}
