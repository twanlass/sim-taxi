// Seeded randomness. Every bit of procedural variation in the project draws from here so that
// a given seed always rebuilds the exact same world — which is what makes screenshot-to-screenshot
// comparison meaningful while iterating on the art.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small helper wrapper with the sampling shapes we reach for constantly. */
export function makeRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    /** Uniform in [min, max). */
    range: (min, max) => min + next() * (max - min),
    /** Integer in [min, max]. */
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    /** Roughly gaussian via averaging — keeps variation clustered around the middle. */
    gauss: () => (next() + next() + next()) / 3,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** true with probability p. */
    chance: (p) => next() < p,
    /** Symmetric jitter around 0. */
    jitter: (amount) => (next() * 2 - 1) * amount,
  };
}

// ---------------------------------------------------------------------------
// Value noise + fbm, seeded. Enough for rolling terrain; not worth pulling in
// a simplex implementation for hills this gentle.
// ---------------------------------------------------------------------------

function hash2(x, y, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/**
 * Wrap a lattice coordinate into [0, period) so the field repeats exactly.
 *
 * `period = 0` is the default and means "don't", which is every caller but the crayon paper tile
 * (game/crayon.js). That tile is sampled with `RepeatWrapping` in screen space, so a field that
 * doesn't close on itself puts a hard seam every 256 pixels across the picture — visible as a grid
 * over the whole city, which is the one thing a paper texture must not have.
 */
function wrap(v, period) {
  if (!period) return v;
  return ((v % period) + period) % period;
}

export function valueNoise2D(x, y, seed, period = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const x0 = wrap(xi, period);
  const y0 = wrap(yi, period);
  const x1 = wrap(xi + 1, period);
  const y1 = wrap(yi + 1, period);

  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);

  const u = smooth(xf);
  const v = smooth(yf);

  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/**
 * Fractal brownian motion — layered noise, output normalized to roughly [0,1].
 *
 * `period` is the lattice period of the *first* octave, in the same units as `x`/`y`; each octave
 * wraps at its own frequency so the sum repeats at `period` as a whole. Integer periods and an
 * integer lacunarity keep every octave's period integral, which is what the wrap needs.
 */
export function fbm(x, y, seed, { octaves = 4, lacunarity = 2, gain = 0.5, period = 0 } = {}) {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i++) {
    sum += amplitude * valueNoise2D(
      x * frequency, y * frequency, seed + i * 1013, period ? period * frequency : 0);
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return sum / norm;
}
