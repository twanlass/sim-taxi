/**
 * Procedural road wear (Tyler, 2026-11-27: "can we use the road paint tech to procedurally add
 * some detail?"). The dirt a real street collects, stamped into the same splat map the road paint
 * brush draws in (game/roadpaint.js), so it comes out in the pixel street's own texels and greys
 * and recolours with the channel colours in the ⚙️ panel:
 *
 * - **Kerbs** — a brown band in the gutter of every block, patchy along the edge.
 * - **Medians** — the same band round every planted island.
 * - **Manholes** — a soft dark ring round each cover, the stain a cast-iron lid leaves.
 * - **Bridges** — dirt where each deck lands on the road, heaviest at the joint.
 *
 * Generated at boot from the city, never baked: it is a function of the layout, so a city it has
 * never seen gets it for free, and the hand-painted bake stays the brush's alone. The two meet in
 * `upload` (roadpaint.js) as a per-byte max, so a stroke can only add to the wear.
 *
 * Only the road takes paint — the shader skips anything off the ground plane — so every band here
 * is drawn as a plain distance from an outline without masking the kerb top: the pavement at
 * KERB_H (0.35) is past the shader's 0.1 test and the band simply stops at the kerb face.
 */
import { MEDIAN_W, medianRuns } from '../city/grid.js';
import { bridgeLines, bridgeSpan } from '../city/river.js';
import { makeRng } from '../util/rng.js';

/** Channels, by index into the paint map: 0 is grime (dark), 2 is rust (brown). */
const DARK = 0;
const DIRT = 2;

/** `ground.js`'s kerb corner radius, so the band follows the kerb round its corners. */
const CURB_RADIUS = 0.6;
/** `manholes.js`'s cover radius. */
const COVER_R = 0.72;

/**
 * Peak strength of each feature, 0..1 of a full stroke (before the channel's own amount). The
 * first cut aimed at Tyler's hand-painted trials (a kerb brushed at 0.03 under a 0.42 amount) with
 * peaks of 0.35-0.45, and a diff of shot 38 against `?roadwear=classic` found it only at 12x gain:
 * the band's falloff, patchiness and grain average a third of the peak, and the pixel street's
 * grey ramp rounds a small change in value away. These are Tyler's panel tuning (2026-11-27).
 */
export const WEAR_DEFAULTS = Object.freeze({
  kerb: 1,        // the gutter band
  kerbWidth: 2.65, // how far out from the kerb face it reaches
  kerbShare: 1,    // fraction of blocks that have it at all
  patchy: 0.62,    // 0: an unbroken band; 1: long stretches of kerb and median left clean
  patchScale: 2.6, // world units across one patch
  median: 0.8,
  medianWidth: 1,
  manhole: 0.5,
  manholeWidth: 1.8, // past the cover's rim
  bridge: 0.69,
  bridgeLength: 5.6, // how far onto the road from the joint
});

// --- Noise --------------------------------------------------------------------------------------

function hash2(ix, iz, s) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(s, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in 0..1, period 1 world-unit-per-`scale`. */
function noise(x, z, s) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, s), b = hash2(ix + 1, iz, s);
  const c = hash2(ix, iz + 1, s), d = hash2(ix + 1, iz + 1, s);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

const smooth = (e0, e1, v) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Signed distance from a rounded rectangle (negative inside). */
function sdRoundRect(px, pz, cx, cz, hw, hd, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qz = Math.abs(pz - cz) - (hd - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - r;
}

// --- Outlines -----------------------------------------------------------------------------------

/**
 * Every raised kerb platform the ground lays (`createGround` in city/ground.js), as bounds: the
 * park districts and the double graveyard as one platform each, then every block that is not
 * the river or already inside one of those.
 */
function kerbOutlines(blocks) {
  const out = [];
  for (const district of blocks.districts ?? []) out.push(district.bounds);
  const graveLot = blocks.graveyardBlock?.double ? blocks.graveyardBlock : null;
  if (graveLot) out.push(graveLot.bounds);
  for (const block of blocks) {
    if (block.type === 'river') continue;
    if (block.districtId !== null && block.districtId !== undefined) continue;
    if (graveLot && block.type === 'graveyard') continue;
    out.push(block.bounds);
  }
  return out;
}

// --- The stamp ----------------------------------------------------------------------------------

/**
 * Fill `out` (RGBA bytes, `width` × `height` texels of `texel` units from `minX`, `minZ`) with
 * the wear for this city. `out` is cleared first. `seed` is the city's.
 */
export function buildRoadWear(out, { width, height, minX, minZ, texel }, { blocks, manholes = [], seed = 0, params = WEAR_DEFAULTS }) {
  out.fill(0);
  const p = { ...WEAR_DEFAULTS, ...params };
  const rng = makeRng(seed + 307);
  const s = (seed >>> 0) % 100003;

  // Visit every texel whose centre is within the box, handing `fn` its world centre; `fn` answers
  // a strength 0..1 for `channel`, written as a max so overlapping features don't stack.
  const stamp = (x0, z0, x1, z1, channel, fn) => {
    const ix0 = Math.max(0, Math.floor((x0 - minX) / texel));
    const ix1 = Math.min(width - 1, Math.ceil((x1 - minX) / texel));
    const iz0 = Math.max(0, Math.floor((z0 - minZ) / texel));
    const iz1 = Math.min(height - 1, Math.ceil((z1 - minZ) / texel));
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = minZ + (iz + 0.5) * texel;
      for (let ix = ix0; ix <= ix1; ix++) {
        const v = fn(minX + (ix + 0.5) * texel, z);
        if (!(v > 0)) continue;
        const i = (iz * width + ix) * 4 + channel;
        const b = Math.min(255, Math.round(v * 255));
        if (b > out[i]) out[i] = b;
      }
    }
  };

  // A band out from an outline: strongest at the face, gone by `w`, its edge wobbled and its
  // strength broken up along its length so it reads as dirt that collected rather than a stroke.
  const band = (b, r, w, peak, salt) => {
    const hw = (b.x1 - b.x0) / 2, hd = (b.z1 - b.z0) / 2;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    stamp(b.x0 - w, b.z0 - w, b.x1 + w, b.z1 + w, DIRT, (x, z) => {
      const d = sdRoundRect(x, z, cx, cz, hw, hd, r);
      if (d < 0 || d > w * 1.3) return 0;
      const wob = (noise(x / 0.9, z / 0.9, s + salt) - 0.5) * 0.5 * w;
      const t = 1 - (d + wob) / w;
      if (t <= 0) return 0;
      // Long patches: whole stretches of gutter clean, others caked.
      const patch = 1 - p.patchy * (1 - smooth(0.22, 0.55, noise(x / p.patchScale, z / p.patchScale, s + salt + 1)));
      const grain = 0.7 + 0.3 * noise(x / 0.45, z / 0.45, s + salt + 2);
      return peak * Math.pow(t, 1.5) * patch * grain;
    });
  };

  // 1. Kerbs, on some blocks.
  if (p.kerb > 0) {
    kerbOutlines(blocks).forEach((b, k) => {
      if (!rng.chance(p.kerbShare)) return;
      band(b, CURB_RADIUS, p.kerbWidth * rng.range(0.8, 1.15), p.kerb * rng.range(0.6, 1), 11 + k * 7);
    });
  }

  // 2. Medians: a stadium, so the band is a rounded rectangle at half the island's width.
  if (p.median > 0) {
    medianRuns().forEach((run, k) => {
      band(run, MEDIAN_W / 2, p.medianWidth, p.median * rng.range(0.7, 1), 503 + k * 7);
    });
  }

  // 3. Manholes: dark round the rim, gone `manholeWidth` out, a little lopsided.
  if (p.manhole > 0) {
    manholes.forEach(({ x: mx, z: mz }, k) => {
      const reach = COVER_R + p.manholeWidth * 1.3;
      const peak = p.manhole * rng.range(0.75, 1);
      stamp(mx - reach, mz - reach, mx + reach, mz + reach, DARK, (x, z) => {
        const d = Math.hypot(x - mx, z - mz) - COVER_R * 0.85;
        const wob = (noise(x / 0.5, z / 0.5, s + 900 + k) - 0.5) * 0.45 * p.manholeWidth;
        const t = 1 - Math.max(0, d + wob) / p.manholeWidth;
        if (t <= 0) return 0;
        return peak * t * t * (0.75 + 0.25 * noise(x / 0.3, z / 0.3, s + 950 + k));
      });
    });
  }

  // 4. Bridges: onto the road off each end of the deck, across its full width. The deck itself
  // is not ground and takes no paint, so this is the road half of the joint only.
  if (p.bridge > 0) {
    for (const line of bridgeLines()) {
      const span = bridgeSpan(line);
      if (!span) continue;
      for (const [edge, sign] of [[span.z0, -1], [span.z1, 1]]) {
        const L = p.bridgeLength;
        const peak = p.bridge * rng.range(0.8, 1);
        const salt = 1300 + line * 13 + (sign > 0 ? 5 : 0);
        const x0 = span.cx - span.half, x1 = span.cx + span.half;
        const zA = sign < 0 ? edge - L * 1.3 : edge;
        const zB = sign < 0 ? edge : edge + L * 1.3;
        const at = (x, z) => {
          const t = (z - edge) * sign;
          if (t < 0) return 0;
          const wob = (noise(x / 0.8, z / 0.8, s + salt) - 0.5) * 0.6 * L;
          const f = 1 - (t + wob) / L;
          if (f <= 0) return 0;
          // Heavier toward the kerbs, where the grit washes off the deck.
          const side = 0.7 + 0.3 * smooth(span.half * 0.4, span.half, Math.abs(x - span.cx));
          return peak * f * f * side * (0.6 + 0.4 * noise(x / 0.5, z / 0.5, s + salt + 1));
        };
        stamp(x0, zA, x1, zB, DIRT, at);
        stamp(x0, zA, x1, zB, DARK, (x, z) => 0.45 * at(x, z));
      }
    }
  }
}
