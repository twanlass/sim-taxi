// Street markings, the second pass (Tyler, 2026-11-24/25). `?markings=classic` keeps the first pass —
// four fat bars at every signalised crossing and nothing else (`ground.js`).
//
// Round two of the review set the rule for all of it: **a few of each, and none of it fresh.**
// The first cut painted a zebra, a stop line and a STOP at every all-way stop, and at the city's
// framing that is a wallpaper of white, not a street. So:
//
//   - zebra crossings at `CROSSING_JUNCTIONS` junctions, with stop lines on their approaches;
//   - STOP on `STOP_WORDS` approaches elsewhere, each with its own line;
//   - a bike lane down one ordinary street per axis (the part that was liked, unchanged in count);
//   - and one each of three one-offs: an amber hatched box junction on a main road, a TAXI rank on
//     the kerb outside the garage, and a green bike box ahead of the stop line on the bike street.
//
// And every mark is **worn** (`WEAR`): laid as a grid of quarter-unit cells — the same 0.25 texel the
// road's pixel texture (PR #798) and the pixel-art pass use — each cell its own shade of the paint
// mixed toward the asphalt, with some cells gone altogether, and each mark faded by its own amount.
// That is vertex colour, not a shader: the road-texture shader lives on an unmerged branch, and baking
// the wear into the geometry keeps it identical on WebGL and WebGPU at no fragment cost.
//
// Everything is laid **per lane off the road network**, because each mark belongs to a direction of
// travel: a stop line covers the inbound half, a STOP reads the right way up for the driver
// approaching it, a bike lane is on the driver's right. The network already knows all three.
//
// Cost: one flat-colour triangle soup merged into the ground mesh — no draw call, material or shader.
// Ground mesh 11.6k → 20.1k triangles on seed 1 (the wear cells and the worn centre dashes are most
// of it), ~9ms to build in Node.
//
// Heights. Paint lies at `MARK_Y` (0.02) and overlaps nothing else on that plane. The two *fills* —
// the bike lane's dull red and the box junction's amber hatch — lie at `FILL_Y` (0.015), because
// other things sit on them (the bicycle; a manhole cover, which is at `MARK_Y` in a junction box) and
// because 0.01 is taken: the asphalt patches (`PATCH_Y` in city/asphaltpatch.js) are there, and a
// patch landing on a bike lane at the same height was the z-fight this level is chosen to avoid.

import * as THREE from 'three';
import { color } from '../palette.js';
import { cityNetwork } from './roadnet.js';
import {
  GRID_I, GRID_J, MEDIAN_W, lineX, lineZ, halfRoadX, halfRoadZ,
  isArterialX, isArterialZ, isRiverGap, riverBanks,
} from './grid.js';

export const MARKINGS_CLASSIC = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('markings') === 'classic'
  : globalThis.process?.env?.MARKINGS === 'classic';

// --- How many (Tyler, 2026-11-25: "1 or 2, maybe 3") --------------------------------------
const CROSSING_JUNCTIONS = 3;
const STOP_WORDS = 2;

// --- Measurements, all from the junction box edge (where a lane's path ends) -----------------
//
// A car holds with its centre `STOP_SETBACK` (3.4) back from the box edge, so its nose rests 1.7
// back. The zebra stops short of that (0.15..1.45) and the stop line is laid under the nose
// (1.55..1.85): the car reads as having pulled up *to* the line rather than over the crossing.
const ZEBRA_NEAR = 0.15;
const ZEBRA_FAR = 1.45;
// Four stripes across half a 9-wide street at a 1.1 pitch, the first half a pitch off the
// centreline so the two halves meet as one evenly spaced crossing. ~4px a stripe at play zoom.
const STRIPE_W = 0.55;
const STRIPE_PITCH = 1.1;
const STOP_NEAR = 1.55;
const STOP_FAR = 1.85;
// Pixel lettering: 3×5 glyphs, 0.17 across the lane and 0.3 along it — stretched along the
// direction of travel like real road lettering.
const PX_ACROSS = 0.17;
const PX_ALONG = 0.3;
const WORD_GAP = 0.5;
const WORD_MIN_LANE = 8;
// The bike lane: an edge line 3.2..3.34 off the centreline (a car in its lane has its flank at 3.1),
// and the lane beyond it to the kerb.
const BIKE_LINE_IN = 3.2;
const BIKE_LINE_OUT = 3.34;
const BIKE_KERB_GAP = 0.08;
// The green bike box: the stretch of the car lane between the stop line and the crossing's red band,
// pushed back so a car stops behind it. Real ones are ~4m deep; this is the scale the lane allows.
const BIKE_BOX_DEPTH = 2.2;

const FILL_DROP = 0.005;

// --- Wear ----------------------------------------------------------------------------------
const WEAR = {
  cell: 0.25,          // world units — the road texture's texel, and an art pixel under ?pixel
  fade: [0.12, 0.38],  // per mark: how far the whole thing has gone toward the asphalt
  speckle: 0.1,        // per cell: ± extra fade, so a mark is mottled rather than evenly dull
  gone: 0.07,          // per cell: chance the paint has worn through to the road altogether
};
const NARROW = 0.6;

const FONT = {
  S: ['111', '100', '111', '001', '111'],
  T: ['111', '010', '010', '010', '010'],
  O: ['111', '101', '101', '101', '111'],
  P: ['111', '101', '111', '100', '100'],
  A: ['111', '101', '111', '101', '101'],
  X: ['101', '101', '010', '101', '101'],
  I: ['111', '010', '010', '010', '111'],
};

/** A deterministic 0..1 hash of a world point, so wear doesn't move when an unrelated draw changes. */
function hash2(x, z, salt = 0) {
  const s = Math.sin(x * 127.1 + z * 311.7 + salt * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** The lines that carry a bike lane: one ordinary street on each axis, never the garage's. */
function pickBikeLines(rng, garageLine) {
  const zLines = [];
  for (let i = 1; i < GRID_I; i++) if (!isArterialZ(i) && i !== garageLine) zLines.push(i);
  const xLines = [];
  for (let j = 1; j < GRID_J; j++) if (!isArterialX(j)) xLines.push(j);
  return {
    z: zLines.length ? rng.pick(zLines) : null,
    x: xLines.length ? rng.pick(xLines) : null,
  };
}

/** Up to `n` picks from `pool`, each at least `minSep` (world units) from the ones before it. */
function spreadPick(rng, pool, n, minSep, pos) {
  const left = [...pool];
  const out = [];
  while (out.length < n && left.length) {
    const k = Math.floor(rng.next() * left.length);
    const c = left.splice(k, 1)[0];
    const p = pos(c);
    if (out.every((o) => Math.hypot(pos(o).x - p.x, pos(o).z - p.z) >= minSep)) out.push(c);
  }
  return out;
}

/**
 * Builds the markings as one non-indexed geometry with baked colour, ready to merge into the ground.
 * `y` is the paint height (`MARK_Y`); `blocks` is the layout (for the garage).
 */
export function streetMarkings(rng, y, blocks = null) {
  const net = cityNetwork();
  const FILL_Y = y - FILL_DROP;
  const positions = [];
  const colors = [];
  const white = new THREE.Color(color('crosswalk'));
  const line = new THREE.Color(color('laneMark'));
  const bikeRed = new THREE.Color(color('bikeLane'));
  const bikeFill = new THREE.Color(color('bikeLaneFill'));
  const bikeBox = new THREE.Color(color('bikeBox'));
  const amber = new THREE.Color(color('cautionHatch'));
  const taxiYellow = new THREE.Color(color('taxiRank'));
  const asphalt = new THREE.Color(color('asphalt'));
  const scratch = new THREE.Color();

  // One triangle, wound to face up whichever order its corners came in. Computed from the winding,
  // not assumed (CLAUDE.md: a reversed face on the road reads as z-fighting).
  const tri = (a, b, c, col, h) => {
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    const [p, q, r] = ny >= 0 ? [a, b, c] : [a, c, b];
    for (const v of [p, q, r]) {
      positions.push(v.x, h, v.z);
      colors.push(col.r, col.g, col.b);
    }
  };

  /**
   * A worn parallelogram: `f(u, v)` maps 0..1 × 0..1 onto the world, `lenU`/`lenV` are its sides
   * in world units. Cut into ~`WEAR.cell` cells, each shaded on its own.
   */
  const wornPatch = (f, lenU, lenV, col, h, wear = 1) => {
    // A fill (lower wear) takes double cells: it is a broad area at a quiet fade, the grain reads
    // as well at 0.5, and the bike lane alone was 7.7k triangles at 0.25.
    const cell = wear <= 0.5 ? WEAR.cell * 2 : WEAR.cell;
    // A narrow mark (a zebra stripe, a dash, a line) is one cell across: worn along its length only.
    // Cut across as well, a lost cell halves a 0.55 stripe's width and the crossing reads as
    // scattered blocks — which is what the first worn cut looked like.
    const nu = lenU <= NARROW ? 1 : Math.max(1, Math.round(lenU / cell));
    const nv = lenV <= NARROW ? 1 : Math.max(1, Math.round(lenV / cell));
    const mid = f(0.5, 0.5);
    const [f0, f1] = WEAR.fade;
    const fade = (f0 + (f1 - f0) * hash2(mid.x, mid.z, 1)) * wear;
    for (let a = 0; a < nu; a++) {
      for (let b = 0; b < nv; b++) {
        const c = f((a + 0.5) / nu, (b + 0.5) / nv);
        // Hashed on the cell's *quantised* world position, so neighbouring marks share a grain.
        const qx = Math.round(c.x / WEAR.cell);
        const qz = Math.round(c.z / WEAR.cell);
        if (hash2(qx, qz, 2) < WEAR.gone * wear) continue;
        const t = Math.min(0.85, Math.max(0, fade + (hash2(qx, qz, 3) - 0.5) * 2 * WEAR.speckle * wear));
        scratch.copy(col).lerp(asphalt, t);
        const p0 = f(a / nu, b / nv);
        const p1 = f((a + 1) / nu, b / nv);
        const p2 = f((a + 1) / nu, (b + 1) / nv);
        const p3 = f(a / nu, (b + 1) / nv);
        tri(p0, p1, p2, scratch, h);
        tri(p0, p2, p3, scratch, h);
      }
    }
  };

  const banks = riverBanks();
  const overWater = (p) => banks !== null && p.z > banks.z0 - 0.05 && p.z < banks.z1 + 0.05;
  const garage = blocks?.garageBlock ?? null;
  const bikes = pickBikeLines(rng, garage ? garage.bi + 1 : null);

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
   * kerb, the driver's right) to a world point.
   */
  const frameAt = (lane, s) => {
    const p = lane.path.at(s);
    const t = lane.path.tangentAt(s);
    let n = { x: -t.z, z: t.x };
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

  /** A worn rectangle in lane space: `s0..s1` along the lane, `b0..b1` from the centreline. */
  const rect = (lane, s0, s1, b0, b1, col, h = y, wear = 1) => {
    const f = frameAt(lane, (s0 + s1) / 2);
    const hl = (s1 - s0) / 2;
    wornPatch((u, v) => f(-hl + u * 2 * hl, b0 + v * (b1 - b0)), s1 - s0, b1 - b0, col, h, wear);
  };

  /** A worn axis-aligned rectangle in world space. */
  const worldRect = (x0, x1, z0, z1, col, h = y) => {
    wornPatch((u, v) => ({ x: x0 + u * (x1 - x0), z: z0 + v * (z1 - z0) }), x1 - x0, z1 - z0, col, h);
  };

  const zebra = (lane, edgeS, dir, bike) => {
    const s0 = edgeS + dir * ZEBRA_NEAR;
    const s1 = edgeS + dir * ZEBRA_FAR;
    const lo = Math.min(s0, s1);
    const hi = Math.max(s0, s1);
    const reach = bike ? BIKE_LINE_IN - 0.15 : lane.edge.halfWidth - 0.15;
    for (let b = STRIPE_PITCH / 2; b + STRIPE_W / 2 <= reach; b += STRIPE_PITCH) {
      rect(lane, lo, hi, b - STRIPE_W / 2, b + STRIPE_W / 2, white);
    }
  };

  // The red band where the bike lane crosses a junction mouth — at every junction on the bike street,
  // crossing or not: it is the bike lane's own marking, and the part Tyler liked.
  const bikeBand = (lane, edgeS, dir) => {
    const s0 = edgeS + dir * ZEBRA_NEAR;
    const s1 = edgeS + dir * ZEBRA_FAR;
    rect(lane, Math.min(s0, s1), Math.max(s0, s1), BIKE_LINE_IN, lane.edge.halfWidth - BIKE_KERB_GAP,
      bikeRed, y, 0.7);
  };

  /**
   * Pixel lettering. `place(px, py)` maps glyph space — px across the word left to right, py up the
   * letters, both in pixels from the word's bottom-left — to a world rectangle builder.
   */
  const lettering = (text, cellRect) => {
    [...text].forEach((ch, li) => {
      FONT[ch].forEach((row, r) => {
        let c = 0;
        while (c < 3) {
          if (row[c] !== '1') { c++; continue; }
          let e = c;
          while (e < 3 && row[e] === '1') e++;
          cellRect(li * 4 + c, li * 4 + e, 4 - r, 5 - r);
          c = e;
        }
      });
    });
  };

  const stopWord = (lane, sNear, b0, b1) => {
    const width = 15;
    const left = (b0 + b1) / 2 - (width * PX_ACROSS) / 2;
    lettering('STOP', (x0, x1, yb, yt) => rect(lane, sNear + yb * PX_ALONG, sNear + yt * PX_ALONG,
      left + x0 * PX_ACROSS, left + x1 * PX_ACROSS, white));
  };

  // A bicycle in side profile, wheels along the direction of travel. Strokes are thin enough that
  // wearing them by the cell would eat them, so they go down at a light, even fade.
  const bicycle = (lane, s, b) => {
    const f = frameAt(lane, s);
    const W = 0.07;
    const tone = new THREE.Color().copy(white).lerp(asphalt, 0.22 + 0.15 * hash2(s, b, 5));
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
      tri(p, q, r, tone, y);
      tri(p, r, u, tone, y);
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
    const up = -1;   // the frame rises toward the centreline; the wheels sit on the kerb side
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

  // --- Choosing where the few go ------------------------------------------------------------
  const live = net.lanes.filter((l) => !l.degenerate && l.path && !gridOf(l).bridge);
  const nodePos = (n) => ({ x: n.x, z: n.z });
  // Crossings: at a controlled junction with at least two ordinary-street arms to lay them on.
  const crossPool = net.nodes.filter((n) => n.signal
    && live.filter((l) => l.to === n.id && l.edge.klass === 'side').length >= 2);
  const crossNodes = new Set(spreadPick(rng, crossPool, CROSSING_JUNCTIONS, 30, nodePos).map((n) => n.id));

  // STOP: on an ordinary street, long enough, at a junction that isn't one of the crossings, and
  // reading the right way up from this camera — up-screen is away from it, toward −x and −z
  // (`VIEW_DIR` in game/camera.js is (1, 0.92, 1)) — since with only two there is no reason to spend
  // one on a word the player has to read upside down.
  const stopPool = live.filter((l) => {
    const to = net.nodeById.get(l.to);
    if (!to.signal || crossNodes.has(to.id) || l.edge.klass !== 'side' || l.length < WORD_MIN_LANE) return false;
    const t = l.path.tangentAt(l.length - 3);
    return t.x + t.z < -0.5;
  });
  const lanePos = (l) => l.path.at(l.length);
  const stopLanes = new Set(spreadPick(rng, stopPool, STOP_WORDS, 30, lanePos));

  // The bike box: on the bike street's approach to one controlled junction, where it gets a stop line.
  const boxPool = live.filter((l) => gridOf(l).bike && net.nodeById.get(l.to).signal
    && !stopLanes.has(l) && l.length >= WORD_MIN_LANE);
  const bikeBoxLane = boxPool.length ? rng.pick(boxPool) : null;

  // --- Laying them --------------------------------------------------------------------------
  for (const lane of live) {
    const { bike } = gridOf(lane);
    const L = lane.length;
    const toNode = net.nodeById.get(lane.to);
    const fromNode = net.nodeById.get(lane.from);
    const half = lane.edge.halfWidth;
    const nearHere = (s) => overWater(frameAt(lane, s)(0, 0));

    const crossEnd = crossNodes.has(toNode.id) && lane.edge.klass === 'side' && !nearHere(L - ZEBRA_FAR);
    const crossStart = crossNodes.has(fromNode.id) && lane.edge.klass === 'side' && !nearHere(ZEBRA_FAR);
    if (crossEnd) zebra(lane, L, -1, bike);
    if (crossStart) zebra(lane, 0, 1, bike);
    if (bike && !nearHere(L - ZEBRA_FAR)) bikeBand(lane, L, -1);
    if (bike && !nearHere(ZEBRA_FAR)) bikeBand(lane, 0, 1);

    // The approach: a line where there's a crossing, a STOP or the bike box; the word on two of them.
    const inner = lane.edge.klass === 'arterial' ? MEDIAN_W / 2 + 0.05 : 0.12;
    const carOuter = bike ? BIKE_LINE_IN - 0.06 : half - 0.15;
    const boxed = lane === bikeBoxLane;
    const stopped = toNode.signal && (crossNodes.has(toNode.id) || stopLanes.has(lane) || boxed)
      && !nearHere(L - STOP_FAR);
    // The bike box takes the space just behind the crossing, so its car line moves back by its depth.
    const lineAt = boxed ? STOP_FAR + BIKE_BOX_DEPTH : STOP_FAR;
    if (stopped) {
      rect(lane, L - lineAt, L - lineAt + (STOP_FAR - STOP_NEAR), inner, carOuter, line);
      if (boxed) {
        rect(lane, L - lineAt + (STOP_FAR - STOP_NEAR), L - STOP_NEAR, inner, carOuter, bikeBox, FILL_Y, 0.5);
        bicycle(lane, L - STOP_NEAR - BIKE_BOX_DEPTH / 2, (inner + carOuter) / 2 + 0.25);
      }
      if (stopLanes.has(lane)) {
        const wordFar = L - lineAt - WORD_GAP;
        stopWord(lane, wordFar - 5 * PX_ALONG, inner, carOuter);
      }
    }

    if (bike) {
      const s0 = ZEBRA_FAR + 0.2;
      const s1 = stopped ? L - lineAt - 0.2 : L - ZEBRA_FAR - 0.2;
      if (s1 > s0) {
        rect(lane, s0, s1, BIKE_LINE_IN, BIKE_LINE_OUT, line);
        rect(lane, s0, s1, BIKE_LINE_OUT, half - BIKE_KERB_GAP, bikeFill, FILL_Y, 0.5);
      }
      const glyphS = s0 + 1.6;
      if (glyphS + 1.2 < s1) bicycle(lane, glyphS, half - BIKE_KERB_GAP - 0.45);
    }
  }

  // --- The amber box junction ---------------------------------------------------------------
  // On a main road, where real ones go, and away from the plaza (which is only ever on a side-street
  // four-way, `plazaJunctions` in util/geo.js) and from the crossings. Diagonal stripes one way only:
  // a cross-hatch overlaps itself, and with each cell its own shade two overlapping cells on one
  // plane are a z-fight. Below the paint (`FILL_Y`) so a manhole cover, at `MARK_Y`, lies on top.
  const boxPoolJ = net.nodes.filter((n) => n.signal && n.gi !== undefined && !crossNodes.has(n.id)
    && (isArterialX(n.gj) || isArterialZ(n.gi)) && n.gi > 0 && n.gi < GRID_I && n.gj > 0 && n.gj < GRID_J);
  if (boxPoolJ.length) {
    const n = rng.pick(boxPoolJ);
    const cx = lineX(n.gi);
    const cz = lineZ(n.gj);
    const hx = halfRoadZ(n.gi) - 0.35;
    const hz = halfRoadX(n.gj) - 0.35;
    const B = 0.2;
    // The border, as four strips that meet without overlapping.
    worldRect(cx - hx, cx + hx, cz - hz, cz - hz + B, amber, FILL_Y);
    worldRect(cx - hx, cx + hx, cz + hz - B, cz + hz, amber, FILL_Y);
    worldRect(cx - hx, cx - hx + B, cz - hz + B, cz + hz - B, amber, FILL_Y);
    worldRect(cx + hx - B, cx + hx, cz - hz + B, cz + hz - B, amber, FILL_Y);
    // Stripes along x + z = k, clipped to the inside of the border with a little air.
    const ix0 = cx - hx + B + 0.15;
    const ix1 = cx + hx - B - 0.15;
    const iz0 = cz - hz + B + 0.15;
    const iz1 = cz + hz - B - 0.15;
    const PITCH = 1.15;
    const HW = 0.2;   // half the stripe's width measured along x
    for (let k = ix0 + iz0 + 0.4; k < ix1 + iz1 - 0.4; k += PITCH) {
      // Walk the stripe in z, clipping each quarter-unit slab to the box: simple, and it keeps every
      // cell inside the border without polygon clipping.
      for (let z = iz0; z < iz1 - 1e-6; z += WEAR.cell) {
        const z1 = Math.min(iz1, z + WEAR.cell);
        const zm = (z + z1) / 2;
        const xa = Math.max(ix0, k - zm - HW);
        const xb = Math.min(ix1, k - zm + HW);
        if (xb - xa < 0.04) continue;
        const sh = (z1 - z) / 2;
        // A parallelogram slab: the stripe's edges are 45°, so each side shifts by the slab's depth.
        const f = (u, v) => {
          const zz = z + v * (z1 - z);
          const dx = -(zz - zm);
          return {
            x: Math.min(ix1, Math.max(ix0, xa + dx)) + u * (Math.min(ix1, Math.max(ix0, xb + dx))
              - Math.min(ix1, Math.max(ix0, xa + dx))),
            z: zz,
          };
        };
        wornPatch(f, xb - xa, sh * 2, amber, FILL_Y);
      }
    }
  }

  // --- The TAXI rank outside the garage -----------------------------------------------------
  // On the kerb the garage door opens onto, on the far side of the door from the driveway (the
  // driveway itself stays bare: NO PARKING there was turned down). Yellow box, lettering along it,
  // reading from the pavement.
  if (garage) {
    const { z0, z1, x1 } = garage.bounds;
    const rx0 = x1 + 0.12;
    const rx1 = x1 + 1.32;
    const rz0 = z0 + 7.9;   // the door is 5.4 wide centred 4.5 in: it ends at 7.2
    const rz1 = z1 - 0.4;
    if (rz1 - rz0 > 3) {
      const B = 0.13;
      worldRect(rx0, rx1, rz0, rz0 + B, taxiYellow);
      worldRect(rx0, rx1, rz1 - B, rz1, taxiYellow);
      worldRect(rx1 - B, rx1, rz0 + B, rz1 - B, taxiYellow);
      // Letters advance along −z with their tops toward −x: that is screen right and screen up from
      // this camera (`VIEW_DIR` (1, 0.92, 1)), so the word reads for the player rather than for
      // someone on the pavement — the first cut read from the kerb and came out as IXAT.
      const pz = (rz1 - rz0 - 2 * B - 0.3) / 15;
      const px = 0.17;
      const wz1 = rz1 - B - 0.15;
      const base = rx1 - B - 0.12;
      lettering('TAXI', (a0, a1, yb, yt) => worldRect(base - yt * px, base - yb * px,
        wz1 - a1 * pz, wz1 - a0 * pz, taxiYellow));
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

/**
 * The centre dashes and double lines, worn the same way — an axis-aligned rectangle of paint, the
 * drop-in for `paint()` in ground.js when the markings aren't classic.
 */
export function wornPaint(w, d, x, z, col, y) {
  const out = [];
  const cols = [];
  const asphalt = new THREE.Color(color('asphalt'));
  const base = new THREE.Color(col);
  const scratch = new THREE.Color();
  const nu = Math.max(1, Math.round(w / WEAR.cell));
  const nv = Math.max(1, Math.round(d / WEAR.cell));
  const x0 = x - w / 2;
  const z0 = z - d / 2;
  const [f0, f1] = WEAR.fade;
  const fade = f0 + (f1 - f0) * hash2(x, z, 1);
  for (let a = 0; a < nu; a++) {
    for (let b = 0; b < nv; b++) {
      const cxp = x0 + ((a + 0.5) / nu) * w;
      const czp = z0 + ((b + 0.5) / nv) * d;
      const qx = Math.round(cxp / WEAR.cell);
      const qz = Math.round(czp / WEAR.cell);
      if (hash2(qx, qz, 2) < WEAR.gone) continue;
      const t = Math.min(0.85, Math.max(0, fade + (hash2(qx, qz, 3) - 0.5) * 2 * WEAR.speckle));
      scratch.copy(base).lerp(asphalt, t);
      const xa = x0 + (a / nu) * w;
      const xb = x0 + ((a + 1) / nu) * w;
      const za = z0 + (b / nv) * d;
      const zb = z0 + ((b + 1) / nv) * d;
      // Wound counter-clockwise seen from +y: (xa,za) → (xa,zb) → (xb,zb) faces up.
      out.push(xa, y, za, xa, y, zb, xb, y, zb, xa, y, za, xb, y, zb, xb, y, za);
      for (let k = 0; k < 6; k++) cols.push(scratch.r, scratch.g, scratch.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  geo.computeVertexNormals();
  return geo;
}
