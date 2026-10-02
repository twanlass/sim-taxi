// The fuel gauge's shape (#boost-meter): a band hugging the gas pedal's cap, thin at the empty end
// and thicker at the full one. Pure and DOM-free — main.js turns it into two `d` attributes, the
// probe asserts on it — because a stroke cannot taper and so the band is a filled outline, and an
// outline is geometry that can be wrong in ways a screenshot at 95px wide won't show.
//
// Everything is in the pedal's own viewBox (146.266 × 215.545, index.html), so the gauge and the
// pedal share one coordinate system and the gap between them is a number, not a nudge.
//
// The base curve is the pedal's outline pushed out by GAP. The cap is the circle through the face
// path's three extremes — (11.38, 63.95), (76.13, 4), (140.87, 73.93) — centre (76.13, 68.94),
// radius 64.94, and the face's two straight sides are tangent to it at the first and last of
// those. The outline stroke is 4 wide, centred 2 outside the face, so its outer edge sits at
// radius 68.94. The first build had the right tangent point's offset typed as 74.75 instead of
// 64.75, which put the whole right leg 12 units further out than the left, and it read as the arc
// hanging off one side of the pedal.

export const CAP = { x: 76.1263, y: 68.9399, r: 64.9399 };
const OUTLINE_OUT = CAP.r + 4;         // the face's black outline, outer edge
export const GAP = 4;                  // clear air between that outline and the gauge's rim
export const RIM = 2;                  // the dark track shows this much either side of the fuel
export const BASE_R = OUTLINE_OUT + GAP + RIM; // where the fuel's inner edge runs, round the cap
// Fuel width at the empty end and the full end. 8 is what the constant-width arc was.
export const W_EMPTY = 8;
export const W_FULL = 14;
// Both ends stop at this height: a third of the way down the pedal (215.5 tall), so the gauge
// covers the cap and the top of the sides rather than reaching halfway down them.
export const END_Y = 72;

// The pedal's sides lean: the face runs from (11.38, 63.95) down to (5.39, 141.61), and the right
// side is parallel to it. Unit vector pointing down the side.
const SIDE = (() => {
  const dx = 5.39114 - 11.3785, dy = 141.614 - 63.9486, l = Math.hypot(dx, dy);
  return { x: dx / l, y: dy / l };
})();

/**
 * The base curve as a dense polyline, left end to right end, each point carrying its outward unit
 * normal. Left leg (parallel to the pedal's side) → cap arc → right leg, trimmed so both ends land
 * on END_Y. The right tangent point is lower than the left one (the pedal leans), so with END_Y
 * above it the right end is trimmed off the arc itself and there is no right leg at all.
 */
function baseCurve() {
  const R = BASE_R;
  // Angles of the two tangent points, measured y-down: the left at ~184.4°, the right at ~4.4°.
  const aL = Math.atan2(-SIDE.x, SIDE.y) + Math.PI;  // normal of the left side, pointing out-left
  const aR = Math.atan2(SIDE.x, -SIDE.y) + Math.PI;  // ...and of the right side, pointing out-right
  const at = (a) => ({ x: CAP.x + R * Math.cos(a), y: CAP.y + R * Math.sin(a), nx: Math.cos(a), ny: Math.sin(a) });
  const pts = [];
  const tl = at(aL), tr = at(aR);

  // Left leg, from END_Y up to the tangent point (only if the tangent point is above END_Y).
  if (tl.y < END_Y) {
    const len = (END_Y - tl.y) / SIDE.y;
    for (let i = 8; i > 0; i--) {
      const s = (len * i) / 8;
      pts.push({ x: tl.x + SIDE.x * s, y: tl.y + SIDE.y * s, nx: tl.nx, ny: tl.ny });
    }
  }
  // The arc, clockwise on screen (increasing angle, y down) from the left tangent to the right,
  // clipped at END_Y on either end.
  const a0 = tl.y < END_Y ? aL : Math.PI + Math.asin((CAP.y - END_Y) / R);
  const a1 = tr.y < END_Y ? aR + 2 * Math.PI : 2 * Math.PI + Math.asin((END_Y - CAP.y) / R);
  const n = 96;
  for (let i = 0; i <= n; i++) pts.push(at(a0 + ((a1 - a0) * i) / n));
  // Right leg, mirror of the left.
  if (tr.y < END_Y) {
    const len = (END_Y - tr.y) / SIDE.y;
    for (let i = 1; i <= 8; i++) {
      const s = (len * i) / 8;
      pts.push({ x: tr.x + SIDE.x * s, y: tr.y + SIDE.y * s, nx: tr.nx, ny: tr.ny });
    }
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
 * grows away from the pedal rather than into it. Returns '' for an empty span.
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

export const CURVE_POINTS = CURVE;
