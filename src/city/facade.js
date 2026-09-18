import * as THREE from 'three';
import { bakeColor, bakeColors } from '../util/geo.js';
import { color } from '../palette.js';
import { valueNoise2D } from '../util/rng.js';

// The façade kit: the pieces every building in the city cuts its elevations from.
//
// This was all inside `buildings.js` until there was a second kind of building to draw. The row
// houses in `rowhome.js` lay their own openings out — a stoop, a door one storey up and a garden
// window under it is not a grid of bays — but they want the *same* window colour, the same faux
// reflection and the same hand-wound quads as the towers beside them, because a row of houses
// whose glass catches the light differently from the block behind it reads as a different game.
//
// So the split is: what a face is made of lives here, and what a *building* is lives in the module
// that draws it. Nothing in this file knows what a lot is.

export const FLOOR_H = 2.6;
// The ground floor is its own storey height. A shopfront is taller than the flats above it, and
// the difference is most of what makes a building read as having a *base* rather than as a box
// with windows starting at the pavement.
export const GROUND_H = 2.4;

// Façade rhythm. At play zoom one world unit is about 7.7px (see docs/rendering.md), so a window
// this size is 8×11 pixels — the smallest thing that still reads as a window rather than as
// dirt on the wall. Below about 0.8 units they stop separating from each other and the whole
// façade goes grey.
const BAY = 2.3;                 // horizontal pitch between window centres
export const WIN_W = 1.05;
export const WIN_H = 1.4;
export const SILL = 0.55;        // sill height above the floor line
// How far an opening stands off the wall it is punched into. Small enough not to read as a
// pilaster from any angle, large enough to beat depth precision at DISTANCE = 400.
export const EPS = 0.03;

// Sides are the city's own direction encoding — 0..3 meaning +X, +Z, -X, -Z (see docs/city.md), so
// a façade index is the same number the traffic model uses for the road it faces.
export const SIDE_OUT = [[1, 0], [0, 1], [-1, 0], [0, -1]];
// The tangent that runs along each face, chosen so that `tangent × up` is the outward normal.
// That is what winds the quads below the right way round, and it is asserted rather than
// eyeballed — see "a façade faces out of its wall" in tools/probe.mjs.
export const SIDE_TAN = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/**
 * A stop darker than the colour handed in.
 *
 * Cornices and ledges are cut from the building's own envelope rather than from a shared grey.
 * A flat `roof` grey on top of every mass was tried first and it drained the city: at play zoom a
 * building is forty pixels tall, a third of which is then the same dark cap as its neighbour's,
 * and the tan/brick/concrete families stop telling each other apart. Darkening the body keeps the
 * colour and still reads as a ledge, because the sun is low enough that the underside of one is
 * in shadow anyway.
 */
export function shade(col, amount = 0.78) {
  return col.clone().multiplyScalar(amount);
}

export function box(w, h, d, x, base, z, col) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, base + h / 2, z);
  return bakeColor(geo, col);
}

/**
 * Every opening on one façade, written into a single geometry.
 *
 * A window is two triangles and a mid-rise carries forty of them, so the city is a few thousand
 * openings. Emitted one `PlaneGeometry` at a time they are a few thousand objects for
 * `mergeGeometries` to walk and dispose, which costs several times the rest of the city put
 * together; a face's openings go straight into one position array instead.
 *
 * `rects` are `{ u, y, w, h }` in face-local terms: `u` along the face from its centre, `y` the
 * world height of the rect's centre. A rect may also carry `g`, four weights in corner order
 * `[BL, BR, TR, TL]`, which lerp that corner from `col` toward `sky` — the faux reflection. It
 * costs nothing but the arithmetic: `vColor` interpolates across a triangle even on a flat-shaded
 * mesh (see `bakeColors` in util/geo.js), so a gradient needs no extra vertices.
 *
 * Keep a quad's gradient axis-aligned — BL=BR with TL=TR, or BL=TL with BR=TR. The quad is two
 * triangles, so interpolation is only exactly linear when the weights vary along one axis; a
 * twisted set of four corners shows the diagonal seam between them. Diagonal streaks come from
 * varying the weights *between* panes instead.
 *
 * Exported for the winding assertion in `tools/probe.mjs`. Hand-wound triangles get their normals
 * from `computeVertexNormals`, which launders a reversed triangle into whatever its neighbours
 * say — so the sign has to be checked from the winding rather than looked at. The roadworks ramp
 * shipped inside out for exactly this reason.
 */
export function facadeQuads(rects, side, cx, cz, hw, hd, col, out = EPS, sky = null) {
  const [nx, nz] = SIDE_OUT[side];
  const [tx, tz] = SIDE_TAN[side];
  const reach = (side % 2 === 0 ? hw : hd) + out;
  const ox = cx + nx * reach;
  const oz = cz + nz * reach;

  const base = col instanceof THREE.Color ? col : new THREE.Color(col);
  const positions = new Float32Array(rects.length * 18);
  const colors = new Float32Array(rects.length * 18);
  // Vertex order within a quad, as indices into a rect's four corner weights.
  const WIND = [0, 1, 2, 0, 2, 3];
  let p = 0;

  for (const { u, y, w, h, g } of rects) {
    const uL = u - w / 2;
    const uR = u + w / 2;
    const yB = y - h / 2;
    const yT = y + h / 2;

    // A (left, bottom), B (right, bottom), E (right, top), D (left, top).
    const corner = (uu, yy) => [ox + tx * uu, yy, oz + tz * uu];
    const quad = [corner(uL, yB), corner(uR, yB), corner(uR, yT), corner(uL, yT)];

    for (const k of WIND) {
      const v = quad[k];
      positions[p] = v[0];
      positions[p + 1] = v[1];
      positions[p + 2] = v[2];

      if (sky && g) {
        const t = g[k];
        colors[p] = base.r + (sky.r - base.r) * t;
        colors[p + 1] = base.g + (sky.g - base.g) * t;
        colors[p + 2] = base.b + (sky.b - base.b) * t;
      } else {
        colors[p] = base.r;
        colors[p + 1] = base.g;
        colors[p + 2] = base.b;
      }
      p += 3;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return bakeColors(geo, colors);
}

// --- Faux reflections -------------------------------------------------------
//
// Glass is lerped from `window` toward `windowSky` by a weight computed per corner of every pane.
// There is no reflection being calculated — it is two numbers and an exponential — but it lands
// close enough because the camera never moves. A real reflection changes when you walk past a
// building; this one never has to.
//
// Three things go into the weight, and they do different jobs:
//
//   - **Height.** Higher panes catch more sky, lower ones more of the street and the buildings
//     opposite. This is the part that reads at play zoom, where a whole façade is forty pixels and
//     an individual pane is eight: it gives a mass a soft vertical falloff instead of a flat patch.
//   - **A diagonal streak.** A soft band running across the façade, at a position drawn per
//     building, which is what actually says *glass* rather than *dark paint*. It is placed in a
//     diagonal coordinate rather than aimed at anything: a raking band across a curtain wall is
//     what a low sun does to a tower, and the eye reads the diagonal, not the geometry behind it.
//   - **Which way the face points.** The +X and +Z faces are the two the camera sees and the two
//     the sun lights (azimuth 56° — see game/scene.js), so they get the reflection at full
//     strength; the pair behind get a third of it. Without this the backs of buildings glowed as
//     brightly as their fronts and the city lost its light direction.
const STREAK_WIDTH = 0.36;    // in diagonal units, where a whole façade spans 2
const STREAK_GAIN = 0.68;
const SKY_FLOOR = 0.10;       // what even a ground-floor pane on a dark side catches
const SKY_RISE = 0.24;        // added by the time a pane is at the top of its tier
// How much of the reflection each face gets, indexed the same way everything else here is.
//
// A back face still reflects: a pane at zero is flat paint and reads as one, which is what the
// whole city looked like before this. A third is enough to keep it glass without lighting it.
//
// The two *front* faces differ from each other on purpose, and +X is the stronger one even though
// the sun favours +Z (azimuth 56° — see game/scene.js). Matching the reflection to the light would
// make the two faces the same statement said twice, and a building's corner would read as one
// surface wrapped round it. Opposing them puts a value break on the corner instead, so a tower
// reads as two glazed elevations meeting.
export const FACING = [1, 0.82, 0.34, 0.34];
// A curtain wall's band is one quad per floor per face, and a quad can only hold a ramp end to
// end — never a band with a middle. Four segments is what it takes for the streak to have a peak
// to sit on. Punched windows need none of this: they are already a grid of separate panes.
const RIBBON_SEGMENTS = 4;

// Where a building's streak crosses, in the 0..2 diagonal coordinate `skyWeight` reads.
//
// Taken from a noise field over the city rather than from the building's own rng, and both halves
// of that matter.
//
// *Field*, because the streak is a reflection of one sky. Rolled per building, neighbours on the
// same block caught the light at unrelated places and a street read as a row of independently lit
// objects; sampled from a field at 26 units — about a block and a half — a run of buildings shows
// one sweep passing across them, which is what a low sun actually does to a street.
//
// *Fixed seed*, because the sky does not reseed with the city. It also means this whole feature
// costs no draws from the building stream, so it is provably geometry-neutral: the city it lands
// on is the same city, and a before/after screenshot differs only by the colour under review.
// How bright a *punched* window may get, as a fraction of the wall it is cut into.
//
// `windowSky` is more luminous than two of the six envelopes — brick (0.25 against 0.18) and slate
// (0.20) — so a pane at full streak on a brick building comes out brighter than the brick. On a
// curtain wall that is correct and wanted: the glass *is* the wall there, and a tower lit brighter
// than its own frame is what a glass tower looks like. On masonry it inverts the figure and the
// ground — dark holes in a light wall become light patches on a dark one — and takes the scale cue
// the palette note on `window` is about with it. So the punched path carries a ceiling and the
// curtain-wall path does not.
const WALL_HEADROOM = 0.85;
const STREAK_SCALE = 26;
const STREAK_FIELD = 7717;
export const streakPeak = (cx, cz) => 0.45
  + 1.1 * valueNoise2D(cx / STREAK_SCALE, cz / STREAK_SCALE, STREAK_FIELD);

/**
 * How much sky a pane catches, given where it sits on its face.
 *
 * `un` runs 0..1 across the face and `yn` 0..1 up the tier. `peak` is where this building's streak
 * crosses, in the diagonal coordinate `un + (1 - yn)`, so 0 is the top-left corner of a face and 2
 * the bottom-right.
 */
export function skyWeight(un, yn, side, peak, ceiling = 1) {
  const facing = FACING[side];
  const streak = Math.exp(-(((un + 1 - yn - peak) / STREAK_WIDTH) ** 2));
  return THREE.MathUtils.clamp(
    (SKY_FLOOR + SKY_RISE * yn + STREAK_GAIN * streak) * facing, 0, ceiling,
  );
}

/** Relative luminance, for deciding how far a pane may lerp before it outshines its wall. */
const luminance = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/**
 * The largest lerp toward `windowSky` that keeps a pane under `WALL_HEADROOM` of its wall.
 *
 * Returns 1 for the pale envelopes, which are bright enough that the question never arises, and
 * around 0.5 for brick.
 */
export function wallCeiling(body, base = color('window'), sky = color('windowSky')) {
  const lo = luminance(base);
  const hi = luminance(sky);
  if (hi <= lo) return 1;
  return THREE.MathUtils.clamp((luminance(body) * WALL_HEADROOM - lo) / (hi - lo), 0, 1);
}

/** How many window bays fit across a face, and how far apart their centres sit. */
export function bayLayout(faceW) {
  const bays = Math.max(1, Math.min(6, Math.round(faceW / BAY)));
  // 0.88 of the face, so the outermost window keeps a pier of masonry between it and the corner.
  // Without it the windows run off the edge of narrow lots and the building loses its corners.
  return { bays, pitch: (faceW * 0.88) / bays };
}

/**
 * Floor lines above the ground storey of a tier, as world heights.
 *
 * `floorH` is the storey height, and it is a parameter rather than `FLOOR_H` because a *house* has
 * a shorter storey than a block of flats does — see `ROW_FLOOR_H` in rowhome.js. A row house lays
 * its own front elevation out and would not care, except that its back and its two end walls come
 * through here: left on the tower's 2.6 they were a grid of windows at heights no floor of that
 * building has.
 */
function floorLines(base, h, firstFloorH, floorH = FLOOR_H) {
  const lines = [];
  let y = base + firstFloorH;
  while (y + floorH <= base + h - 0.35) {
    lines.push(y);
    y += floorH;
  }
  return lines;
}

/**
 * How much of each side of a `w × d` box is glazable, indexed by side (+X, +Z, -X, -Z).
 *
 * The default is the whole face. A courtyard wing overrides it: two of its four sides are buried
 * inside the wings beside it, and a third is only exposed across its middle. Windows drawn into
 * those would be invisible geometry at best and two coplanar grids fighting over the same depth
 * at worst — which is exactly what the first version of the courtyard did at all four corners.
 * A row house overrides it for the same reason: a terrace is party walls, and only the two ends
 * of the run have a side elevation at all.
 */
export function fullFaces(w, d) {
  return [d, w, d, w];
}

/**
 * Punched openings: a grid of individual windows, one per bay per floor.
 *
 * This is the masonry half of the façade rule. It is worth the triangles that a continuous band
 * isn't: a band gives a mass *scale* and nothing else, where a grid gives it a grain — and grain
 * is what tells the eye that the row of five boxes down one street are five separate buildings
 * rather than one long one that happens to change colour.
 */
export function punchedWindows(parts, cx, base, cz, w, d, h, firstFloorH, windowColor, peak, body,
  faces = fullFaces(w, d), floorH = FLOOR_H) {
  const lines = floorLines(base, h, firstFloorH, floorH);
  if (!lines.length) return;
  const sky = color('windowSky');
  const ceiling = wallCeiling(body, windowColor, sky);

  for (let side = 0; side < 4; side++) {
    const faceW = faces[side];
    if (faceW < 1.6) continue;
    const { bays, pitch } = bayLayout(faceW);
    const winW = Math.min(WIN_W, pitch * 0.62);

    const rects = [];
    for (const y of lines) {
      for (let b = 0; b < bays; b++) {
        const u = (b + 0.5 - bays / 2) * pitch;
        const cy = y + SILL + WIN_H / 2;
        const un = u / faceW + 0.5;
        // Sampled at the pane's own top and bottom, so a tall window carries its own falloff on
        // top of the one across the façade. Flat across the pane's width: the streak is a
        // *between*-panes effect, and putting it inside one as well shows the quad's diagonal.
        const yb = skyWeight(un, (cy - WIN_H / 2 - base) / h, side, peak, ceiling);
        const yt = skyWeight(un, (cy + WIN_H / 2 - base) / h, side, peak, ceiling);
        rects.push({ u, y: cy, w: winW, h: WIN_H, g: [yb, yb, yt, yt] });
      }
    }
    parts.push(facadeQuads(rects, side, cx, cz, w / 2, d / 2, windowColor, EPS, sky));
  }
}

/**
 * Curtain wall: one horizontal ribbon per floor, inset a hair from each face.
 *
 * The original façade treatment, and still the right one for a glass envelope — the glass on a
 * tower like this genuinely is continuous, and a ribbon is one quad per face where a grid is a
 * dozen.
 */
export function ribbonWindows(parts, cx, base, cz, w, d, h, firstFloorH, windowColor, peak,
  faces = fullFaces(w, d)) {
  const lines = floorLines(base, h, firstFloorH);
  if (!lines.length) return;
  const sky = color('windowSky');

  const bandH = Math.min(1.5, FLOOR_H - 0.9);
  for (let side = 0; side < 4; side++) {
    const faceW = faces[side];
    if (faceW < 1.6) continue;
    const span = faceW * 0.84;

    const rects = [];
    for (const y of lines) {
      const cy = y + 0.5 + bandH / 2;
      // Cut into segments purely so the streak has somewhere to peak. A band is one quad and a
      // quad has two ends, so left-to-right is the only gradient it can hold — which gives a ramp
      // across the whole façade, never the band the streak is supposed to be. Segments share their
      // edge weights, so the result is still continuous.
      // One height for the whole band, so each segment's gradient runs on a single axis. A band is
      // 1.5 units tall against a tier ten times that, so the falloff worth having is the one
      // *between* bands, and taking it inside one as well only buys the diagonal seam.
      const yn = (cy - base) / h;
      for (let k = 0; k < RIBBON_SEGMENTS; k++) {
        const uL = (k / RIBBON_SEGMENTS - 0.5) * span;
        const uR = ((k + 1) / RIBBON_SEGMENTS - 0.5) * span;
        const wL = skyWeight(uL / faceW + 0.5, yn, side, peak);
        const wR = skyWeight(uR / faceW + 0.5, yn, side, peak);
        rects.push({ u: (uL + uR) / 2, y: cy, w: uR - uL, h: bandH, g: [wL, wR, wR, wL] });
      }
    }
    parts.push(facadeQuads(rects, side, cx, cz, w / 2, d / 2, windowColor, EPS, sky));
  }
}
