import * as THREE from 'three';
import { propMaterial } from '../util/geo.js';
import { PALETTE, color, jitterColor } from '../palette.js';
import { SLAB, slabOutline } from './grid.js';

/**
 * The rock the city is standing on.
 *
 * The asphalt slab used to be a sheet with nothing under it: at this camera angle you saw its
 * far edge as a hairline and the city read as a decal on the sky. Extruding it downwards into a
 * banded chunk of earth gives the same silhouette a *thickness*, and the bands are what say the
 * thickness is ground rather than a grey wall — you are looking at a cut through soil, clay and
 * bedrock, torn out and left floating.
 *
 * Built as rings, not as boxes. Every stratum is a loop of points around `slabOutline()`, scaled
 * in and wobbled outward from the one above it; the wall between two rings is one band. Adjacent
 * bands therefore share their boundary ring by construction and cannot crack apart, which a stack
 * of independently jittered solids does at the first corner.
 */

// Top to bottom. `scale` is the ring the bed *ends* on, as a fraction of the slab footprint;
// `wobble` is the peak radial noise on its rings and `jag` the peak vertical noise, both in world
// units.
//
// Six beds, and the deep ones repeat colours from higher up rather than introducing new ones —
// real bedding alternates, and a sixth distinct hue would be a sixth thing to keep in step with
// the daylight for no gain.
//
// Each bed steps in rather than sloping in; see `SHELF`. Total depth is about 29 units plus the
// keel — deliberately less than it wants to be. The rock looks better the deeper it goes right up
// until it stops fitting on the screen: at play zoom the slab already fills a portrait viewport
// on its own, and every unit of rock below it is a unit of city pushed off the top.
//
// The steps are deliberately uneven — 0.03, 0.04, 0.04, 0.09, 0.10. Even steps down an even stack
// of beds is a wedding cake, and it read as exactly that at play zoom: what saves it is two lazy
// terraces up top and two that fall away underneath.
const STRATA = [
  // No seam on the topsoil: a pale strip immediately under the kerb reads as a lighting bug on the
  // road edge rather than as geology.
  { color: 'crustSoil',  depth: 1.4, scale: 0.990, wobble: 0.45, jag: 0.30, seam: false },
  { color: 'crustEarth', depth: 3.6, scale: 0.958, wobble: 1.00, jag: 0.85 },
  { color: 'crustClay',  depth: 4.4, scale: 0.920, wobble: 1.30, jag: 1.20 },
  { color: 'crustRock',  depth: 5.6, scale: 0.878, wobble: 1.60, jag: 1.40 },
  { color: 'crustDeep',  depth: 6.4, scale: 0.790, wobble: 1.80, jag: 1.50 },
  { color: 'crustRock',  depth: 7.6, scale: 0.690, wobble: 1.90, jag: 1.50 },
];

// Every bed but the first opens with a thin pale strip of its own colour — the weathered top edge
// of the bed, the way a road cutting shows one.
//
// This is doing the work the taper cannot. Bed boundaries on a smoothly sloping wall are invisible:
// neighbouring beds meet at the same angle, so the only thing marking the join is the colour step,
// and on the shaded side that step lands in mud. A seam is a *lighter line* rather than a shading
// change, so it survives being in shadow and it survives the sun moving — with these in, you count
// beds at play zoom instead of seeing one brown cliff.
//
// 0.6 units is about 5px at play zoom: a line, but a line the low-poly facets don't swallow.
const SEAM = 0.6;
const SEAM_LIFT = 0.12;   // lightness added over the bed the seam belongs to

// The bed's inward step, taken as a short near-horizontal shelf at its foot rather than as slope
// spread down the whole bed.
//
// This is the difference between reading seven beds and reading three. A bed that slopes in over
// its full depth has faces tilted well past 45°, and a face tilted that far is lit only by the
// hemisphere fill — whose downward half is one flat warm brown. Measured off a render: the lower
// beds came back at roughly a fifth of their own albedo and every colour difference between them
// was gone. Stepping instead keeps the walls near-vertical, where they still catch sky and sun, and
// spends the taper on a strip the camera can barely see. It also terraces the silhouette, which is
// a second cue for the same layering.
const SHELF = 0.7;
const SHELF_SHADE = 0.09;   // lightness taken off the shelf: it is an underside, in its own shade

// Of a bed's total inward step, the slice its near-vertical parts take. The seam gets a token
// amount so its lower edge doesn't sit proud of the wall below it; the shelf takes the rest.
const SEAM_SHARE = 0.05;
const WALL_SHARE = 0.30;

// Lightness added at the top of a bed and taken off at its foot. Flat on the seams and shelves:
// neither is deep enough for a gradient to be anything but a blunted edge.
const GRADIENT = 0.04;

// How far the bare earth reaches out past the asphalt, in world units. About 14px at play zoom.
//
// It was 2.6 first, and a lip that wide stops reading as ground and starts reading as a frame
// around a picture — the strip faces straight up, so it takes the full sun while every other part
// of the rock is shaded, and the brightest thing in the frame was a tan border. Narrower, and a
// couple of stops darker than the soil bed it belongs to, puts it back under the city.
export const LIP = 1.8;

// How far below the last ring the underside closes to a point. Never visible from the play
// camera — it exists so the rock is a closed solid, and so the silhouette comes to a keel rather
// than a flat disc on the two seeds where the camera swings low during a wreck.
const KEEL = 4;

export const ISLAND_DEPTH = STRATA.reduce((sum, s) => sum + s.depth, 0) + KEEL;

/**
 * Circular box blur, then renormalised to peak 1.
 *
 * Per-point white noise around a 60-gon is static: at one world unit of amplitude and a point
 * every ~3 units it reads as sandpaper, not as rock. Blurring correlates neighbours into features
 * a handful of points wide — lumps the eye can actually see at play zoom — and the renormalise is
 * what stops each pass quietly halving the amplitude the caller asked for.
 */
function smoothLoop(values, passes = 3) {
  const n = values.length;
  let out = values;

  for (let p = 0; p < passes; p++) {
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      next[i] = (out[(i - 1 + n) % n] + out[i] * 2 + out[(i + 1) % n]) / 4;
    }
    out = next;
  }

  const peak = Math.max(...out.map(Math.abs));
  return peak < 1e-6 ? out : out.map((v) => v / peak);
}

/** One loop of points: the slab outline pulled in to `scale` and roughed up. */
function makeRing(outline, y, { scale, wobble, jag }, rng) {
  const n = outline.length;
  const radial = smoothLoop(Array.from({ length: n }, () => rng.jitter(1)));
  const vertical = smoothLoop(Array.from({ length: n }, () => rng.jitter(1)));

  return outline.map((p, i) => {
    // Displace along the ray from the centre, not along x and z independently — the latter drags
    // the corners diagonally and the rounded square stops being one.
    const len = Math.hypot(p.x, p.z) || 1;
    const push = radial[i] * wobble;
    return {
      x: p.x * scale + (p.x / len) * push,
      z: p.z * scale + (p.z / len) * push,
      y: y + vertical[i] * jag,
    };
  });
}

/**
 * A ring parallel to the one above it, `drop` below and scaled in by `ratio`.
 *
 * Seams and shelves are followers rather than fresh `makeRing`s: give a strip this thin its own
 * vertical noise and its two rings cross each other, pinching the strip out to nothing in some
 * places and inverting it in others. Copying the ring above and subtracting a constant keeps the
 * strip an even width the whole way round.
 *
 * `chew` adds radial noise on top of that — for shelves, where a terrace of even width all the way
 * round is the thing that made the first attempt look machined. Left at zero for seams, which are
 * meant to be a parallel line.
 */
function followRing(ring, drop, ratio, rng, chew = 0) {
  const noise = chew ? smoothLoop(ring.map(() => rng.jitter(chew))) : null;

  return ring.map((p, i) => {
    const len = Math.hypot(p.x, p.z) || 1;
    const push = noise ? noise[i] * chew : 0;
    return { x: p.x * ratio + (p.x / len) * push, z: p.z * ratio + (p.z / len) * push, y: p.y - drop };
  });
}

/**
 * Pull any point of `ring` that sticks out past `above` back inside it.
 *
 * The rock narrows all the way down by construction, and this is what construction means: rings
 * carry up to 2.3 units of radial noise while the shallow beds step in by barely 2, so without
 * this a lump on one ring reaches out past the ring above and turns that bed's shelf inside out.
 * Inverted faces caught the sun as bright shards hanging off the near corner — the one thing in
 * any of these renders that read as a bug rather than as rock.
 *
 * Clamping rather than scaling the noise down: an overhang is only wrong where it actually
 * happens, and shaving the whole ring to fit its worst point costs the roughness everywhere else.
 */
function tuck(ring, above, clearance = 0.12) {
  return ring.map((p, i) => {
    const r = Math.hypot(p.x, p.z);
    const limit = Math.hypot(above[i].x, above[i].z) - clearance;
    if (r <= limit || r < 1e-6) return p;
    const k = limit / r;
    return { x: p.x * k, z: p.z * k, y: p.y };
  });
}

/**
 * The banded rock hanging under the asphalt. One non-indexed mesh, ~2500 triangles, built once —
 * nothing about it moves. For scale, the props on the streets above it cost 6200.
 */
export function createIsland(rng) {
  const outline = slabOutline();
  const n = outline.length;

  // The top ring is the slab outline exactly: no scale, no wobble, no jag. It is welded to the
  // edge of the asphalt cap, and a single unit of noise here opens daylight between the road and
  // the ground it is lying on.
  const rings = [outline.map((p) => ({ x: p.x, z: p.z, y: 0 }))];
  // One entry per wall, skinning the gap between `rings[s]` and `rings[s + 1]`.
  const skins = [];
  const add = (ring, col, jitter, grad, grow = false) => {
    rings.push(grow ? ring : tuck(ring, rings[rings.length - 1]));
    skins.push({ color: col, jitter, grad });
  };

  // --- The lip: bare earth ringing the tarmac, flat at road level and *wider* than the slab.
  //
  // Without it the whole change is invisible on a phone. Portrait sizes the frustum by height, so
  // the city fills the frame and the only slab edge on screen is the far one — and a rock hanging
  // *under* the far edge is hidden behind the slab from a 3/4 camera. It was the far edge the idea
  // was about. Widening the top ring puts a strip of ground beyond the asphalt on every side,
  // including the one where the thickness itself can never show.
  //
  // The one ring allowed to grow rather than narrow, hence the flag on `add` — everything below is
  // tucked inside its neighbour above.
  const lipScale = 1 + LIP / (SLAB / 2);
  add(makeRing(outline, 0, { scale: lipScale, wobble: LIP * 0.35, jag: 0 }, rng),
    color(PALETTE.crustSoil).offsetHSL(0, -0.02, -0.04), 0.035, 0, true);

  let scale = lipScale;
  let y = 0;

  for (const bed of STRATA) {
    const base = PALETTE[bed.color];
    const step = bed.scale - scale;         // negative: the whole inward move this bed makes
    const hasSeam = bed.seam !== false;

    if (hasSeam) {
      // A follower rather than a fresh ring, so the strip keeps an even width — see followRing.
      const seamScale = scale + step * SEAM_SHARE;
      add(followRing(rings[rings.length - 1], SEAM, seamScale / scale, rng),
        color(base).offsetHSL(0, 0.01, SEAM_LIFT), 0.02, 0);
      scale = seamScale;
      y -= SEAM;
    }

    // The wall: most of the bed's depth, a fraction of its inward step.
    const wallScale = scale + step * WALL_SHARE;
    y -= bed.depth - (hasSeam ? SEAM : 0) - SHELF;
    add(makeRing(outline, y, { ...bed, scale: wallScale }, rng), color(base), 0.028, GRADIENT);
    scale = wallScale;

    // The shelf: the rest of the step, over almost no depth at all.
    y -= SHELF;
    add(followRing(rings[rings.length - 1], SHELF, bed.scale / scale, rng, bed.wobble * 0.9),
      color(base).offsetHSL(0, 0, -SHELF_SHADE), 0.02, 0);
    scale = bed.scale;
  }

  const triangles = skins.length * n * 2 + n;
  const positions = new Float32Array(triangles * 9);
  const colors = new Float32Array(triangles * 9);
  let v = 0;

  const push = (a, b, c, ca, cb, cc) => {
    positions.set([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], v * 9);
    colors.set([ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b], v * 9);
    v += 1;
  };

  // --- Walls. Wound (top, bottom-next, bottom) and (top, top-next, bottom-next), which faces
  // outward for an outline running counter-clockwise in (x, z).
  for (let s = 0; s < skins.length; s++) {
    const top = rings[s];
    const bottom = rings[s + 1];

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // One colour per quad, not per triangle: a split quad reads as two lit differently and the
      // band dissolves into confetti. Hue is held nearly still — these are beds of the same
      // material, and a hue jitter wide enough to see turns clay into a paint chart. Seams and
      // shelves take less spread than the beds do: both are *lines*, and a line that changes value
      // every three units stops being one.
      const col = jitterColor(skins[s].color, rng, { h: 0.006, s: 0.03, l: skins[s].jitter });
      // Light at the top of the bed, dark at its foot. The one place this project interpolates
      // colour across a face rather than flat-filling it, and it earns the exception: it puts a
      // hard value step at every bed boundary — light meeting dark — which is what the eye counts.
      // Uniform beds separated by a colour change alone lose the boundary the moment the wall
      // turns away from the sun, which is most of the rock at a fixed 3/4 camera.
      const hi = col.clone().offsetHSL(0, 0, skins[s].grad);
      const lo = col.clone().offsetHSL(0, 0, -skins[s].grad);
      push(top[i], bottom[j], bottom[i], hi, lo, lo);
      push(top[i], top[j], bottom[j], hi, hi, lo);
    }
  }

  // --- Underside, closing to a keel below the deepest ring.
  const last = rings[rings.length - 1];
  const lowest = Math.min(...last.map((p) => p.y));
  const keel = { x: 0, y: lowest - KEEL, z: 0 };
  const keelColor = color(STRATA[STRATA.length - 1].color);

  for (let i = 0; i < n; i++) {
    push(keel, last[i], last[(i + 1) % n], keelColor, keelColor, keelColor);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, propMaterial());
  // Receives, but does not cast: there is nothing under it to catch a shadow, and a building on
  // the rim throwing its shadow down over the cliff face is the point of leaving this on.
  mesh.receiveShadow = true;
  mesh.name = 'island';
  return mesh;
}
