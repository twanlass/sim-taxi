// Planar curves on the ground plane, arc-length parameterised.
//
// The road network needs exactly three operations on a centreline: offset it sideways to get a
// lane, trim its ends where it enters a junction, and sample a point and heading part-way along.
// Straight lines and circular arcs are closed under all three — a line offset is a line, an arc
// offset is a concentric arc — which is why those are the only two kinds. Anything a road can be
// drawn as in the editor reduces to a chain of them.
//
// Everything is parameterised by arc length `s` in world units rather than by a normalised t, so
// a car's position along a lane is a distance it can integrate speed into directly. That is the
// property the old `car.s` had for free by being a world coordinate on an axis, and the one thing
// that had to survive generalisation.

const EPS = 1e-9;

/**
 * Right-hand normal of a heading, for right-hand traffic.
 *
 * With Y up, `forward × up` is `(-fz, 0, fx)`. Worth writing down because it is the sign that
 * decides which side of the road every car in the game drives on: heading +X gives +Z, which is
 * what `laneOffsetCoord` in grid.js hard-codes for the axis-aligned case.
 */
export const rightNormal = (fx, fz) => ({ x: -fz, z: fx });

/** Bearing of a heading. +X is 0, +Z is +PI/2 — so a right turn is a *positive* bearing delta. */
export const bearingOf = (fx, fz) => Math.atan2(fz, fx);

/** Normalise to (-PI, PI]. */
export function wrapAngle(a) {
  const w = ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  // The modulo above lands exactly -PI where PI is wanted, which would classify a U-turn as a
  // left turn on one side of a rounding error and a right turn on the other.
  return w === -Math.PI ? Math.PI : w;
}

export const dist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

// --- Straight ---------------------------------------------------------------

export function lineCurve(p0, p1) {
  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;
  const length = Math.hypot(dx, dz);
  const ux = length > EPS ? dx / length : 1;
  const uz = length > EPS ? dz / length : 0;

  return {
    kind: 'line',
    length,
    at: (s) => ({ x: p0.x + ux * s, z: p0.z + uz * s }),
    tangentAt: () => ({ x: ux, z: uz }),
    /** Parallel line `d` to the right of travel. Negative `d` offsets left. */
    offset(d) {
      const n = rightNormal(ux, uz);
      return lineCurve(
        { x: p0.x + n.x * d, z: p0.z + n.z * d },
        { x: p1.x + n.x * d, z: p1.z + n.z * d },
      );
    },
    trim(s0, s1) {
      return lineCurve(this.at(s0), this.at(s1));
    },
  };
}

// --- Circular arc -----------------------------------------------------------

/**
 * Arc through p0 and p1 with the given bulge, the DXF convention: `bulge = tan(theta / 4)`, where
 * theta is the included angle. Positive bulges curve to the *right* of travel, matching the sign
 * of a bearing delta everywhere else in the codebase. Zero degenerates to a straight line, which
 * is what lets the editor treat "drag a road's midpoint" as one continuous gesture.
 */
export function arcFromBulge(p0, p1, bulge) {
  if (Math.abs(bulge) < 1e-6) return lineCurve(p0, p1);

  const chord = dist(p0, p1);
  if (chord < EPS) return lineCurve(p0, p1);

  const theta = 4 * Math.atan(bulge);          // signed included angle
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));

  // Centre sits off the chord midpoint along the chord's normal, on the side the bulge names.
  //
  // The apothem has to come from the bulge rather than from `radius * cos(theta / 2)`: the latter
  // has the right magnitude but is even in theta, so a negative bulge put the centre on the wrong
  // side of the chord and the arc ended nowhere near p1. `(1 - b²) / 2b` is `cot(theta / 2)`, the
  // same value, correctly signed — and it still flips for a major arc, which is what keeps
  // |theta| > PI working.
  const mx = (p0.x + p1.x) / 2;
  const mz = (p0.z + p1.z) / 2;
  const ux = (p1.x - p0.x) / chord;
  const uz = (p1.z - p0.z) / chord;
  const apothem = (chord / 2) * ((1 - bulge * bulge) / (2 * bulge));
  const n = rightNormal(ux, uz);

  const centre = { x: mx + n.x * apothem, z: mz + n.z * apothem };
  return arcCurve(centre, radius, Math.atan2(p0.z - centre.z, p0.x - centre.x), theta);
}

/**
 * Arc by centre, radius, start angle and signed sweep. `sweep > 0` runs counter-clockwise in
 * (x, z), which — given `bearingOf` — is a curve bending to the *right* of travel.
 */
export function arcCurve(centre, radius, startAngle, sweep) {
  const length = Math.abs(sweep) * radius;
  const sign = Math.sign(sweep) || 1;
  const angleAt = (s) => startAngle + (length > EPS ? (s / length) * sweep : 0);

  return {
    kind: 'arc',
    length,
    centre,
    radius,
    startAngle,
    sweep,
    at(s) {
      const a = angleAt(s);
      return { x: centre.x + Math.cos(a) * radius, z: centre.z + Math.sin(a) * radius };
    },
    tangentAt(s) {
      const a = angleAt(s);
      // d/da of (cos a, sin a) is (-sin a, cos a); the sweep sign picks the travel direction.
      return { x: -Math.sin(a) * sign, z: Math.cos(a) * sign };
    },
    /**
     * Concentric arc `d` to the right of travel.
     *
     * The tangent is `sign * (-sin a, cos a)`, so its right normal is `-sign * (cos a, sin a)` —
     * the *inward* radial for a positive sweep. Offsetting right therefore shrinks the radius on
     * a right-bending arc and grows it on a left-bending one. A lane offset that would invert the
     * radius is clamped to a hair above zero rather than folding the curve inside out; a
     * roundabout tight enough to do that is a level-design problem, not something to let produce
     * a lane running backwards.
     */
    offset(d) {
      const r = Math.max(0.01, radius - sign * d);
      return arcCurve(centre, r, startAngle, sweep);
    },
    trim(s0, s1) {
      const a0 = angleAt(s0);
      const a1 = angleAt(s1);
      return arcCurve(centre, radius, a0, a1 - a0);
    },
  };
}

// --- Turn geometry ----------------------------------------------------------

/**
 * Where two rays cross, or null if they are parallel.
 *
 * This is the whole of turn-arc construction: a car leaves its inbound lane on one tangent and
 * joins its outbound lane on another, and the point where those two tangents meet is the control
 * point of the quadratic that connects them. `turnControl` in grid.js special-cased "same axis"
 * to the midpoint; that case is just this returning null.
 */
export function rayIntersect(p, dp, q, dq) {
  const denom = dp.x * dq.z - dp.z * dq.x;
  if (Math.abs(denom) < 1e-7) return null;
  const t = ((q.x - p.x) * dq.z - (q.z - p.z) * dq.x) / denom;
  return { x: p.x + dp.x * t, z: p.z + dp.z * t };
}

/** Quadratic Bezier — the curve cars have always followed through a junction. */
export function bezier(p0, p1, p2, t) {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x,
    z: mt * mt * p0.z + 2 * mt * t * p1.z + t * t * p2.z,
  };
}

/**
 * A quadratic Bezier wrapped as an arc-length-parameterised curve.
 *
 * The length is measured by sampling rather than solved: the closed form for a quadratic's arc
 * length exists but is fiddly enough to get subtly wrong, and these curves are a junction wide.
 * 24 samples holds the error under a millimetre at the sizes a junction actually produces, and
 * the table is built once at bake rather than per frame.
 */
export function bezierCurve(p0, p1, p2, samples = 24) {
  const pts = [];
  const cum = [0];
  for (let n = 0; n <= samples; n++) {
    const pt = bezier(p0, p1, p2, n / samples);
    pts.push(pt);
    if (n > 0) cum.push(cum[n - 1] + dist(pts[n - 1], pt));
  }
  const length = cum[samples];

  /** Bezier parameter at arc length s, by binary search on the cumulative table. */
  const paramAt = (s) => {
    if (length < EPS) return 0;
    const target = Math.min(Math.max(s, 0), length);
    let lo = 0;
    let hi = samples;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid; else hi = mid;
    }
    const span = cum[hi] - cum[lo];
    const frac = span > EPS ? (target - cum[lo]) / span : 0;
    return (lo + frac) / samples;
  };

  return {
    kind: 'bezier',
    length,
    p0,
    p1,
    p2,
    at: (s) => bezier(p0, p1, p2, paramAt(s)),
    tangentAt(s) {
      const t = paramAt(s);
      const dx = 2 * (1 - t) * (p1.x - p0.x) + 2 * t * (p2.x - p1.x);
      const dz = 2 * (1 - t) * (p1.z - p0.z) + 2 * t * (p2.z - p1.z);
      const len = Math.hypot(dx, dz);
      return len > EPS ? { x: dx / len, z: dz / len } : { x: 1, z: 0 };
    },
  };
}

// --- Polygons ---------------------------------------------------------------

/** Twice the signed area. Positive means counter-clockwise in (x, z). */
export function signedArea2(poly) {
  let sum = 0;
  for (let n = 0; n < poly.length; n++) {
    const a = poly[n];
    const b = poly[(n + 1) % poly.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum;
}

export function polygonBounds(poly) {
  let x0 = Infinity; let x1 = -Infinity; let z0 = Infinity; let z1 = -Infinity;
  for (const p of poly) {
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.z < z0) z0 = p.z;
    if (p.z > z1) z1 = p.z;
  }
  return { x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}

export function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let n = 0, m = poly.length - 1; n < poly.length; m = n++) {
    const a = poly[n];
    const b = poly[m];
    if ((a.z > z) !== (b.z > z)
        && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Shrink a polygon by `d`, by pushing every edge inward along its own normal and re-intersecting
 * consecutive edge lines.
 *
 * This is what turns a face of the road graph into a buildable block: the face runs down the
 * centrelines of the roads around it, and the block is that face pulled back by half a road width
 * on every side. On the axis-aligned grid it reproduces `blockBounds` exactly.
 *
 * It is a straight offset, not a straight skeleton, so it degenerates on a face narrower than 2d
 * — the "inset" polygon turns itself inside out. Callers get null for that rather than a folded
 * polygon, because a sliver between two roads genuinely has nothing buildable on it.
 */
/**
 * Drop consecutive duplicate and collinear vertices.
 *
 * Face traversal produces both routinely: closing a road merges two blocks into one face, and the
 * closed road's two end nodes survive as points sitting mid-way along the merged face's sides.
 * They are harmless as geometry and fatal to `insetPolygon`, whose whole method is intersecting
 * consecutive edge lines — two collinear edges have no intersection to take.
 */
export function simplifyRing(poly, tol = 1e-9) {
  const out = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > tol) out.push(p);
  }
  while (out.length > 1 && dist(out[0], out[out.length - 1]) <= tol) out.pop();

  // Two passes would be needed for three collinear points in a row; walking with a re-check is
  // simpler and the rings here are a few dozen points at most.
  let n = 0;
  while (out.length > 3 && n < out.length) {
    const a = out[(n + out.length - 1) % out.length];
    const b = out[n];
    const c = out[(n + 1) % out.length];
    const cross = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
    const scale = dist(a, b) * dist(b, c);
    if (scale > tol && Math.abs(cross) / scale < 1e-9) {
      out.splice(n, 1);
      n = 0;                        // removing one can expose another
    } else {
      n += 1;
    }
  }
  return out;
}

/**
 * @param d how far to pull each side in. A number applies to the whole ring; a function
 *   `(a, b) => number` is asked per side, which is what lets a face bounded by roads of different
 *   widths inset by the right amount on each of them. Taken as a callback rather than as an array
 *   because `simplifyRing` below drops vertices, and a parallel array would silently fall out of
 *   step with the ring it indexes.
 */
export function insetPolygon(input, d) {
  const poly = simplifyRing(input);
  if (poly.length < 3) return null;
  const distFor = typeof d === 'function' ? d : () => d;
  // Walking a counter-clockwise ring keeps the interior on your right, so `rightNormal` already
  // points inward and the offset is +d. It is -d for a clockwise ring, which is why this reads
  // the winding rather than assuming one: face traversal hands back both.
  const sense = signedArea2(poly) > 0 ? 1 : -1;
  const lines = [];

  for (let n = 0; n < poly.length; n++) {
    const a = poly[n];
    const b = poly[(n + 1) % poly.length];
    const len = dist(a, b);
    if (len < EPS) continue;
    const inward = sense * distFor(a, b);
    const u = { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
    const nrm = rightNormal(u.x, u.z);
    lines.push({ p: { x: a.x + nrm.x * inward, z: a.z + nrm.z * inward }, u });
  }
  if (lines.length < 3) return null;

  const out = [];
  for (let n = 0; n < lines.length; n++) {
    const prev = lines[(n + lines.length - 1) % lines.length];
    const hit = rayIntersect(prev.p, prev.u, lines[n].p, lines[n].u);
    if (!hit) return null;          // two collinear edges — nothing sensible to intersect
    out.push(hit);
  }

  // Has the face folded through itself? Pulling a square in by more than half its width turns it
  // inside out, and — this is the trap — the *winding does not change* when it does, so a signed
  // area test reports the fold as a perfectly good polygon. What actually reverses is each edge:
  // once the offset lines have crossed, an inset edge runs opposite to the original it came from.
  // That is the thing to test.
  for (let n = 0; n < lines.length; n++) {
    const a = out[n];
    const b = out[(n + 1) % lines.length];
    if ((b.x - a.x) * lines[n].u.x + (b.z - a.z) * lines[n].u.z <= 0) return null;
  }
  return out;
}
