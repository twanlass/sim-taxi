// The fuel gauge's shape (#boost-meter): a band hugging the round Loco Mode button, thin at the
// empty end and thicker at the full one. Pure and DOM-free — main.js turns it into two `d`
// attributes, the probe asserts on it — because a stroke cannot taper and so the band is a filled
// outline, and an outline is geometry that can be wrong in ways a screenshot at 100px wide won't
// show.
//
// Everything is in the button's own viewBox (150 × 150, index.html), so the gauge and the button
// share one coordinate system and the gap between them is a number, not a nudge.
//
// The button is a circle: the face is radius 69 about the box's centre, and the outline stroke is
// 4 wide centred 2 outside the face, so its outer edge sits at radius 73. The gauge used to hug a
// pedal (two straight leaning sides under a round cap), which needed a leg either side and a
// tangent point that was once typed 10 units wrong; a circle has neither.

export const CAP = { x: 75, y: 75, r: 69 };
const OUTLINE_OUT = CAP.r + 4;         // the face's black outline, outer edge
export const GAP = 4;                  // clear air between that outline and the gauge's rim
export const RIM = 2;                  // the dark track shows this much either side of the fuel
export const BASE_R = OUTLINE_OUT + GAP + RIM; // where the fuel's inner edge runs
// Fuel width at the empty end and the full end. Thickened from 8 → 14 on the pedal, which read as
// a hairline once the button went round and the arc had to carry the whole read-out on its own.
export const W_EMPTY = 12;
export const W_FULL = 20;
// Both ends stop at this height: a little under the button's centre (~8.5° below the horizontal),
// so the gauge reads as a dial over the top of the button rather than a ring round it. Not lower:
// the brake sits off the left end, and the further down the band reaches the more room it needs.
export const END_Y = CAP.y + 12;

/**
 * The base curve as a dense polyline, left end to right end, each point carrying its outward unit
 * normal: an arc of BASE_R clockwise on screen (y down) over the top, trimmed to END_Y both ends.
 */
function baseCurve() {
  const R = BASE_R;
  const drop = Math.asin((END_Y - CAP.y) / R);
  const a0 = Math.PI - drop, a1 = 2 * Math.PI + drop;
  const pts = [];
  const n = 128;
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push({ x: CAP.x + R * Math.cos(a), y: CAP.y + R * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
  }
  // Cumulative length, normalised to 0..1.
  let acc = 0;
  pts[0].t = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    pts[i].t = acc;
  }
  for (const p of pts) p.t /= acc;
  return pts;
}

const CURVE = baseCurve();

/** Fuel width at a fraction t (0 = empty end, 1 = full end) along the gauge. */
export const widthAt = (t) => W_EMPTY + (W_FULL - W_EMPTY) * t;

/** The base-curve point at fraction t, interpolated. */
export function pointAt(t) {
  t = Math.min(1, Math.max(0, t));
  let i = 1;
  while (i < CURVE.length - 1 && CURVE[i].t < t) i++;
  const a = CURVE[i - 1], b = CURVE[i], u = (t - a.t) / (b.t - a.t || 1);
  const nx = a.nx + (b.nx - a.nx) * u, ny = a.ny + (b.ny - a.ny) * u, nl = Math.hypot(nx, ny);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, nx: nx / nl, ny: ny / nl };
}

/**
 * The band between fractions t0 and t1 as an SVG path `d`, round-capped at both ends. `pad` widens
 * it by that much on either side — the dark track is the whole band padded by RIM. The inner edge
 * stays on the base curve (less `pad`) and the width all goes outward, so the thicker full end
 * grows away from the button rather than into it. Returns '' for an empty span.
 */
export function bandPath(t0, t1, pad = 0) {
  if (t1 - t0 < 1e-4) return '';
  const inner = [], outer = [];
  const push = (t) => {
    const p = pointAt(t), w = widthAt(t);
    inner.push([p.x - p.nx * pad, p.y - p.ny * pad]);
    outer.push([p.x + p.nx * (w + pad), p.y + p.ny * (w + pad)]);
  };
  push(t0);
  for (const c of CURVE) if (c.t > t0 && c.t < t1) push(c.t);
  push(t1);
  const f = (v) => v.toFixed(2);
  const capR = (t) => widthAt(t) / 2 + pad;
  const [ox0, oy0] = outer[0];
  let d = `M${f(ox0)} ${f(oy0)}`;
  for (let i = 1; i < outer.length; i++) d += `L${f(outer[i][0])} ${f(outer[i][1])}`;
  // Round cap at the far end: a half-circle from the outer edge to the inner edge.
  const e = inner[inner.length - 1], r1 = capR(t1);
  d += `A${f(r1)} ${f(r1)} 0 0 1 ${f(e[0])} ${f(e[1])}`;
  for (let i = inner.length - 2; i >= 0; i--) d += `L${f(inner[i][0])} ${f(inner[i][1])}`;
  const r0 = capR(t0);
  d += `A${f(r0)} ${f(r0)} 0 0 1 ${f(ox0)} ${f(oy0)}Z`;
  return d;
}

/** Where the fuel's front sits at level t — the centre of the band there, for the leading edge. */
export function frontAt(t) {
  const p = pointAt(t), h = widthAt(t) / 2;
  return { x: p.x + p.nx * h, y: p.y + p.ny * h, w: widthAt(t) };
}

// How far the glint stops short of the band's two edges, so it reads as a highlight on the fuel
// rather than a tick mark across the track.
const GLINT_INSET = 2.5;

/**
 * The glint: a short white line straight across the band at level t, from the inner edge to the
 * outer. It sits where the round cap starts, so it marks the front of the fuel rather than poking
 * out of the end of it.
 */
export function glintAt(t) {
  const p = pointAt(t), w = widthAt(t);
  return {
    x1: p.x + p.nx * GLINT_INSET, y1: p.y + p.ny * GLINT_INSET,
    x2: p.x + p.nx * (w - GLINT_INSET), y2: p.y + p.ny * (w - GLINT_INSET),
  };
}

export const CURVE_POINTS = CURVE;
