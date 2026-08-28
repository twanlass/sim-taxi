import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  bakeColor, propMaterial, jitterVertices, BODY_EULER_ORDER,
} from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { SLAB, SLAB_RADIUS, EDGE_FADE, slabShape } from './ground.js';
import { UP } from '../game/camera.js';

// --- What is outside the city ----------------------------------------------------------------
//
// The asphalt slab is an island: `city/ground.js` feathers its last 16 units into nothing so the
// city dissolves rather than being cut out with scissors. Until now what it dissolved into was the
// sky, and the map read as a slab floating in blue. This module is what it dissolves into instead
// — sea on two of the map's borders and open country on the other two, so the city sits *somewhere*
// rather than nowhere.
//
// **Which two sides is a camera decision, not a coin toss.** The view never rotates: screen up is
// world (−X, −Z) and screen right is (+X, −Z) (`game/camera.js`). So the map's −X and −Z borders
// are the two that face *up-screen*, into the half of the frame the haze is thickest in and the
// half the player is looking across rather than driving through. Water goes there: it is the
// element that wants distance, it takes the haze better than anything solid, and boats moored in
// it are scenery you glance at. The +X and +Z borders come *toward* the camera and end up at the
// bottom of the frame, a few units from the taxi — so they get ground you could plausibly drive
// on if the road went that far: meadow, scrub and a forest thickening as it goes out.
//
// Everything here is scenery in the strict sense. Nothing in it is tappable, nothing collides,
// nothing casts a shadow (see FOREST below) and nothing is in the AO prepass — the surrounds are
// never marked as occluders, which is deliberate: `markOccluder` buys contact creases on things
// the player is inches from, and the nearest of these is 20 units past the last road.

/** The land surface, a hair under the asphalt slab so the two never fight for the same depth. */
export const LAND_Y = -0.05;

/**
 * The sea surface. A **shallow** step down rather than a cliff, and the number is a screen
 * measurement: at this camera a drop of `h` pushes the water it reveals `1.537 * h` units further
 * up-screen (`DEPTH_PER_SCREEN_UNIT`), so 0.37 of a unit hides 0.57 of ground — about four pixels
 * at play zoom, which is a shoreline. A first pass at −1.2 opened a ten-pixel band of nothing
 * between the sand and the water, and the beach read as a shelf with the sea sliding under it.
 */
export const WATER_Y = -0.42;

// --- Where the coast runs --------------------------------------------------------------------
//
// Water is `x < −SHORE` or `z < −SHORE`: an L wrapping the two up-screen borders, with the right
// angle between them knocked off by `SHORE_CORNER_R` so the map ends on a headland rather than on
// a surveyor's peg. Sampled into a polyline for the meshes and available as a closed-form signed
// distance for everything that has to ask "is this in the sea" — see `coastDistance`.
//
// **`SHORE_BASE − SHORE_WOBBLE` is the constraint that sets both numbers, and it is measured off
// the fade rather than off the slab.** The asphalt skirt reaches `SLAB / 2 + EDGE_FADE` = 78 units
// down the axes; put the waterline inside that and the city's last translucent ring of tarmac is
// laid over the sea, which reads as an oil slick. Beyond it there has to be enough dry land to say
// "coast" — a beach plus a few units of grass. 85 is the closest the shoreline ever comes, which
// leaves 2.6 of sand and 4.4 of green at the tightest point on the map.
export const SHORE_BASE = 96;
export const SHORE_WOBBLE = 11;
export const SHORE_CORNER_R = 26;

/** Centre of the headland's arc, on both axes — the corner the two straights are tangent to. */
const CORNER_C = -(SHORE_BASE - SHORE_CORNER_R);

/**
 * How far the land and the sea run before we stop drawing them. Neither edge is ever in frame:
 * panning is clamped to `HALF_SPAN` (50) and the frustum reaches `PLAY_ZOOM / VIEW_DIR.y` = 95
 * units up-screen of its target, so the furthest ground the camera can reach is about 227 units
 * out on a wide viewport. `tools/probe.mjs` re-derives that bound from the real camera constants
 * rather than trusting this comment.
 *
 * The land is drawn *further* than the sea on purpose. Beyond `SEA_HALF` there is no water mesh,
 * so if the land stopped first there would be a band of sky along the bottom of the world where
 * the sea has no business being anyway.
 */
export const SEA_HALF = 340;
export const LAND_FAR = 360;

/** The band of sand between the grass and the water. */
export const BEACH_W = 2.6;

// The coastline is walked by arc length, so a wobble measured in units of shore is the same size
// on the straights and round the headland.
const LEG = LAND_FAR - CORNER_C;
const ARC = SHORE_CORNER_R * Math.PI / 2;
const COAST_LEN = LEG * 2 + ARC;
// Three units a sample. Five left the shortest harmonic (29 units) showing its corners — the coast
// is the one line in this whole scene the eye follows along its length rather than glancing at.
const COAST_STEP = 3;

/**
 * The base coastline at arc length `s`: the point on the un-wobbled L, plus the unit normal
 * pointing **into the water**.
 *
 * `s` runs from the +Z end of the −X shore, round the headland, to the +X end of the −Z shore.
 */
function coastBase(s) {
  if (s <= LEG) return { x: -SHORE_BASE, z: LAND_FAR - s, nx: -1, nz: 0 };
  if (s <= LEG + ARC) {
    const theta = (s - LEG) / SHORE_CORNER_R;      // 0 at the −X shore, π/2 at the −Z shore
    const nx = -Math.cos(theta);
    const nz = -Math.sin(theta);
    return { x: CORNER_C + nx * SHORE_CORNER_R, z: CORNER_C + nz * SHORE_CORNER_R, nx, nz };
  }
  return { x: CORNER_C + (s - LEG - ARC), z: -SHORE_BASE, nx: 0, nz: -1 };
}

/**
 * Arc length of the base point nearest `(x, z)`. The inverse of `coastBase`, and the reason the
 * wobble can be applied to a *query* as well as to the samples: any point in the world can be told
 * which stretch of shore it is off.
 */
function coastParam(x, z) {
  const u = CORNER_C - x;    // > 0 once past the headland's centre on the −X side
  const v = CORNER_C - z;
  if (v <= 0) return LAND_FAR - z;
  if (u <= 0) return LEG + ARC + (x - CORNER_C);
  return LEG + Math.atan2(v, u) * SHORE_CORNER_R;
}

/**
 * Signed distance to the *base* L, positive in the water. The rounded-box SDF with two of its four
 * sides sent to infinity — `length(max(d, 0)) + min(max(d.x, d.y), 0)`, which is exact on the
 * straights, exact round the arc, and exact in the quadrant behind the headland.
 */
function shoreBaseDistance(x, z) {
  const u = CORNER_C - x;
  const v = CORNER_C - z;
  return Math.hypot(Math.max(u, 0), Math.max(v, 0)) - SHORE_CORNER_R
    + Math.min(Math.max(u, v), 0);
}

/**
 * Signed distance to the *slab's* outline, positive outside the city — the same rounded-square
 * measurement `tools/probe.mjs` makes against the fade skirt. Exported because the forest and the
 * meadow both have to keep their distance from the city's edge and neither has any business
 * re-deriving it.
 */
export function slabEdgeDistance(x, z) {
  const inset = SLAB / 2 - SLAB_RADIUS;
  return Math.hypot(Math.max(Math.abs(x) - inset, 0), Math.max(Math.abs(z) - inset, 0))
    - SLAB_RADIUS;
}

/**
 * The wobble: three harmonics of shore, seeded per city.
 *
 * Wavelengths are fixed and the phases are drawn, which is what makes every city's coast a
 * different coast while none of them can come out as a wave train — the longest carries more than
 * half the amplitude, so the shape is a couple of broad bays with detail on them rather than
 * corrugation. Weights sum to 1, so the offset is bounded by `SHORE_WOBBLE` exactly and the
 * clearance argument on `SHORE_BASE` holds for every seed.
 */
function makeWobble(rng) {
  const harmonics = [
    { k: (Math.PI * 2) / 168, weight: 0.46 },
    { k: (Math.PI * 2) / 71, weight: 0.32 },
    { k: (Math.PI * 2) / 29, weight: 0.22 },
  ].map((h) => ({ ...h, phase: rng.range(0, Math.PI * 2) }));

  return (s) => harmonics.reduce(
    (sum, h) => sum + h.weight * Math.sin(s * h.k + h.phase), 0,
  ) * SHORE_WOBBLE;
}

// --- The sea's surface -------------------------------------------------------------------------
//
// A sum of three travelling sines, and it exists **twice**: once here for the boats, which have to
// sit in the water rather than near it, and once as GLSL for the water mesh, which is displaced in
// its vertex shader so the whole sea costs nothing per frame but a uniform write. The two are
// generated from this one table, so they cannot drift apart — the only thing written twice is the
// summation itself.
//
// **What has to be tuned here is the slope, not the height.** The sea is lit by the same Lambert
// term as everything else, so what a wave is *worth* on screen is `amp * 2π / len` — how far it
// tips a facet — and nothing at all to do with how tall it is. The first pass ran a 55-unit swell
// 0.22 high, which is a 1.4° tilt and photographed as a flat wash of blue: the wave was there and
// perfectly correct and completely invisible.
//
// These three total 0.29 of slope — about 16°, swinging the sun's own term (sin 28.5° = 0.48) by
// roughly a quarter either way. Which is more than the arithmetic said was needed, and the
// arithmetic was wrong about the *frame* rather than about the light: the sea is the calmest,
// emptiest, most hazed surface in the picture, so a variation that would be loud on a building
// is the least you can put on it and still see anything. Found by taking it to 5× the first
// number, where it reads as corrugated foil, and coming back down.
//
// Wavelengths are floored at three cells of the sea grid (`SEA_CELL` below); the shortest is
// deliberately near that floor, because a wave sampled at four points per cycle is what puts a
// different tilt on every facet, and a different tilt on every facet is what water looks like from
// here. Below three it stops being chop and starts being moiré.
//
// **And a wave direction is a screen direction.** The chop shipped at (0.66, −0.75), which is
// `RIGHT` almost exactly (game/camera.js) — so its crests ran straight up the screen and the beat
// against the grid photographed as vertical banding on the water rather than as anything wet. The
// grid is axis-aligned in world space, the eye reads it in screen space, and a wave wants to be
// square to neither.
const WAVES = [
  { dirX: 0.94, dirZ: 0.34, len: 58, amp: 0.75, speed: 0.55 },
  { dirX: -0.42, dirZ: 0.91, len: 27, amp: 0.42, speed: 1.00 },
  { dirX: 0.22, dirZ: -0.98, len: 17, amp: 0.24, speed: 1.90 },
];

/** Sea surface height above `WATER_Y` at `(x, z)`, before the shore/​distance weighting. */
function waveHeight(x, z, t) {
  let h = 0;
  for (const w of WAVES) {
    h += w.amp * Math.sin(((x * w.dirX + z * w.dirZ) * Math.PI * 2) / w.len + t * w.speed);
  }
  return h;
}

/** The same sum, as a GLSL function body. Generated so the numbers have exactly one home. */
function waveGLSL() {
  const terms = WAVES.map((w) => `${w.amp.toFixed(4)} * sin((p.x * ${w.dirX.toFixed(4)} `
    + `+ p.y * ${w.dirZ.toFixed(4)}) * ${((Math.PI * 2) / w.len).toFixed(6)} `
    + `+ t * ${w.speed.toFixed(4)})`);
  return `float surroundsWave(vec2 p, float t) {\n  return ${terms.join('\n    + ')};\n}`;
}

// How the swell builds off the beach. Zero in the surf and full by 18 units out, for two reasons
// that happen to want the same ramp: a wave crest near the shore would poke up through the sand
// (the land is only 0.37 above the water), and the foam ribbon below is a *static* strip laid on
// the surface, so the water under it has to be flat or the foam floats.
//
// The ceiling is what the beach can take. At full strength the crests are 0.64 above the mean, and
// the sand is 0.37 above it — so the swell has to still be under 58% of full at the last point that
// is close enough to the shore for a crest to appear *behind* the beach. 18 units is well past
// that (the ramp is at 0.4 by ten units out, which is a crest at −0.16, a quarter of a unit under
// the sand) and it was 28 first, which held the water glassy for four blocks of open sea.
const SWELL_NEAR = 3;
const SWELL_FAR = 18;
// And how it dies away again out past the last thing the camera can reach, so the coarse cells at
// the edge of the sea grid — which are far too big to sample a 21-unit wave — stay flat.
// Out where the sea grid goes coarse (`SEA_FINE`), the swell is already off — a 17-unit cell
// cannot carry a 17-unit wave, and at 5× amplitude the attempt photographed as blocks.
const SWELL_EDGE_IN = 118;
const SWELL_EDGE_OUT = 150;

const swellWeight = (coastDist, x, z) => THREE.MathUtils.smoothstep(coastDist, SWELL_NEAR, SWELL_FAR)
  * (1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(x), Math.abs(z)), SWELL_EDGE_IN, SWELL_EDGE_OUT));

// --- Grid of the sea mesh ----------------------------------------------------------------------
//
// Three bands. Fine cells over everything the camera can reach and the swell is running in,
// medium ones out past that, and one long jump to the edge — the far water is flat (see
// `SWELL_EDGE_IN`), and a flat plane needs no vertices in the middle of it.
//
// Cells whose whole footprint is well inside the land are dropped: the land is opaque and 0.37
// above, so a third of the sheet was being drawn to be hidden. The underlap that *is* kept is what
// stops the sliver of ground the shore step reveals from showing sky.
const SEA_CELL = 4.4;
const SEA_FINE = 154;
const SEA_MID = 240;
const SEA_MID_CELL = 17.2;
const SEA_UNDERLAP = 12;

/** The grid lines on one axis, from the middle out. */
function seaAxis() {
  const fine = [];
  for (let v = -SEA_FINE; v <= SEA_FINE + 1e-9; v += SEA_CELL) fine.push(v);
  const mid = [];
  for (let v = SEA_FINE + SEA_MID_CELL; v <= SEA_MID + 1e-9; v += SEA_MID_CELL) mid.push(v);
  return [-SEA_HALF, ...mid.map((v) => -v).reverse(), ...fine, ...mid, SEA_HALF];
}

/**
 * The sea: one mesh, one draw call, no shadows, and no CPU cost per frame beyond a uniform.
 *
 * Colour is baked per vertex — shallow at the shore, deep off it — because the alternative is a
 * flat sheet of one blue, and depth is the only thing that says where the water goes. The swell
 * weight rides in a custom attribute rather than being recomputed in GLSL: the shore it is measured
 * from is a wobbled polyline, and shipping *that* to the shader to save one float per vertex would
 * be a poor trade.
 */
function seaMesh(coastDistance) {
  const lines = seaAxis();
  const pos = [];
  const col = [];
  const wave = [];

  const deep = new THREE.Color(PALETTE.sea);
  const shallow = new THREE.Color(PALETTE.seaShallow);
  const tint = new THREE.Color();

  const push = (x, z) => {
    const d = coastDistance(x, z);
    tint.copy(shallow).lerp(deep, THREE.MathUtils.smoothstep(d, 0, 76));
    pos.push(x, WATER_Y, z);
    col.push(tint.r, tint.g, tint.b);
    wave.push(swellWeight(d, x, z));
  };

  for (let i = 0; i < lines.length - 1; i++) {
    for (let j = 0; j < lines.length - 1; j++) {
      const x0 = lines[i];
      const x1 = lines[i + 1];
      const z0 = lines[j];
      const z1 = lines[j + 1];
      // The corner nearest the water decides: a cell is kept unless every one of its corners is
      // buried under the land by more than the underlap.
      const nearest = Math.max(
        coastDistance(x0, z0), coastDistance(x1, z0),
        coastDistance(x0, z1), coastDistance(x1, z1),
      );
      if (nearest < -SEA_UNDERLAP) continue;
      // Wound counter-clockwise seen from above, which is +Y — the same way every other ground
      // surface in the city is wound.
      push(x0, z0); push(x0, z1); push(x1, z1);
      push(x0, z0); push(x1, z1); push(x1, z0);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  geo.setAttribute('aSwell', new THREE.BufferAttribute(new Float32Array(wave), 1));
  geo.computeVertexNormals();

  const uniforms = { uTime: { value: 0 } };

  // `propMaterial()`'s recipe **wrapped, not replaced**. It carries AO, the shadow tint, Crayon
  // Mode and Cartoon Mode, all in one `onBeforeCompile` on the fragment shader; the sea needs every
  // one of them and adds a displacement to the *vertex* shader, so it chains onto that patch rather
  // than assigning over it. Building a bare Lambert here instead — which is what this did first —
  // leaves the one surface covering a quarter of the frame as the only thing in the world with no
  // ink on it under `?cartoon`, and no paper under `?crayon`.
  const material = propMaterial();
  const patchedFragment = material.onBeforeCompile;
  // Three builds the program cache key from the material's *parameters*, before `onBeforeCompile`
  // runs — so without a key of its own the sea shares a program with every other flat-shaded
  // vertex-coloured Lambert in the city (which is all of them) and gets handed whichever compiled
  // first. Suffixed onto `propMaterial`'s rather than replacing it, so the mode flags baked into
  // that key still separate the variants. Same trap that once drew the plumbob's fill with a
  // building's shader.
  const propKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () => `${propKey}-sea`;
  material.onBeforeCompile = (shader) => {
    patchedFragment(shader);
    // Cel banding off for the water, and only for the water (`?cartoon`). A cel band is a
    // statement about a lit **form** — it puts a terminator where a surface turns away from the
    // sun. A sea is a flat plane whose facets vary by a few degrees, so there is no terminator to
    // draw: what the band finds instead is the half-percent of facets that happen to straddle its
    // threshold, and that photographs as a scatter of pale triangles floating in the bay. Swapping
    // the uniform on this one material leaves everything else the patch carries in place — the
    // cartoon's ink, the crayon's paper, and the shadow tint, which is not a mode at all but part
    // of the shipped look. See CARTOON_UNIFORMS in util/geo.js: `uToonCel` is a plain mix amount.
    shader.uniforms.uToonCel = { value: 0 };
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
attribute float aSwell;
${waveGLSL()}`)
      // `begin_vertex` is where `transformed` is born and `project_vertex` is what turns it into
      // `mvPosition` — and `vViewPosition` comes off that, which is the whole reason this works
      // with `flatShading`: the facet normals are screen-space derivatives of the *displaced*
      // position, so the sea lights itself with no normal maths of ours at all.
      .replace('#include <begin_vertex>', `#include <begin_vertex>
	transformed.y += aSwell * surroundsWave(transformed.xz, uTime);`);
  };

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'surrounds-sea';
  return { mesh, uniforms };
}

// --- The foam at the waterline -----------------------------------------------------------------
//
// A ribbon of pale water hugging the coast, alpha 0.7 at the sand falling to nothing three units
// out. Built exactly like the asphalt fade — alpha in a 4-component vertex colour, `propMaterial`'s
// own recipe so it takes the sun and the day cycle the way the sea beside it does, `depthWrite`
// off and `renderOrder` −1 for the reason every other bit of translucent ground paint in this game
// has them.
const FOAM_W = 4;
const FOAM_ALPHA = 0.85;

function foamMesh(samples) {
  const c = new THREE.Color(PALETTE.foam);
  const pos = [];
  const col = [];

  // Modulated along the shore rather than laid at one strength. An even ribbon round the whole
  // coast reads as an *outline* — the map looked stickered — where surf comes and goes with what
  // the bottom is doing under it. Two slow harmonics of arc length, held off zero so no stretch of
  // coast is ever completely dry.
  const strength = (p) => FOAM_ALPHA * (0.55
    + 0.3 * Math.sin(p.s * 0.055) + 0.15 * Math.sin(p.s * 0.19 + 1.7));

  const vertex = (p, out) => {
    pos.push(p.x + p.nx * FOAM_W * out, WATER_Y + 0.06, p.z + p.nz * FOAM_W * out);
    col.push(c.r, c.g, c.b, out === 0 ? strength(p) : 0);
  };

  // Wound to face the sky. **Not the same order as the asphalt fade's rings**, which is the trap
  // this walked into first: that skirt is assembled in Shape space and laid down with a rotateX
  // that flips the handedness, and this one is assembled in world space where it does not. Copied
  // across unchanged it came out pointing at the sea floor, was culled, and photographed as a
  // shoreline with no surf on it — a bug that looks exactly like having forgotten to add the mesh.
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    vertex(a, 0); vertex(b, 1); vertex(a, 1);
    vertex(a, 0); vertex(b, 0); vertex(b, 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 4));
  geo.computeVertexNormals();

  const material = propMaterial();
  material.transparent = true;
  material.depthWrite = false;

  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = -1;
  mesh.name = 'surrounds-foam';
  return mesh;
}

// --- The land ----------------------------------------------------------------------------------

/** The land's outline as a Shape. `inset` pulls the coast back into the land — that's the beach. */
function landShape(samples, inset = 0) {
  // Shapes are built in (x, y) and laid down with `rotateX(-π / 2)`, which maps y to **−z**. Every
  // other shape in the city is symmetric so it never mattered there; this one is a coast and it
  // does, so the flip is spelt out here rather than discovered at the far end.
  const pts = samples.map((p) => new THREE.Vector2(
    p.x - p.nx * inset, -(p.z - p.nz * inset),
  ));
  // Closed round the two borders the sea never reaches.
  pts.push(new THREE.Vector2(LAND_FAR, -LAND_FAR));

  // Earcut takes the ring's own winding, so a polygon assembled the other way round comes out
  // wound away from the sky and lights as if the sun were underneath it. Measured rather than
  // assumed: the shoelace decides.
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  if (area < 0) pts.reverse();

  return new THREE.Shape(pts);
}

/** That outline, lying flat at `y`. */
function landSurface(shape, y) {
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  return geo;
}

/**
 * The lip between the land and the water: a strip hanging off the coastline down past the sea.
 *
 * Most of it is never seen — the shore faces up-screen on both borders, so the camera is looking
 * at its back and it is culled — but a bay that happens to turn its mouth toward the camera shows
 * this instead of showing the sea through the gap, and wet sand is what should be there.
 */
function shoreLip(samples) {
  const pos = [];
  const bottom = WATER_Y - 0.6;

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    // Wound so the face looks out to sea, along the coast normal — asserted in tools/probe.mjs
    // against the normal each triangle's own winding gives, not against this comment.
    pos.push(a.x, LAND_Y, a.z, b.x, bottom, b.z, a.x, bottom, a.z);
    pos.push(a.x, LAND_Y, a.z, b.x, LAND_Y, b.z, b.x, bottom, b.z);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  return geo;
}

/** A ragged disc — one patch of a different green lying in the meadow. */
function patchGeometry(x, z, radius, rng) {
  const sides = rng.int(7, 10);
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    const r = radius * rng.range(0.62, 1);
    pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  const geo = new THREE.ShapeGeometry(new THREE.Shape(pts));
  geo.rotateX(-Math.PI / 2);
  geo.translate(x, LAND_Y + 0.02, z);
  return geo;
}

// --- The verge ------------------------------------------------------------------------------------
//
// A ring of bare earth round the city, laid **under** the asphalt's fade skirt.
//
// The skirt was written to dissolve tarmac into sky. Dissolved into grass instead it mixes to a
// desaturated olive, and sixteen units of that round the whole map photographed as a bruise — the
// one thing about the surrounds that had to be answered in the city's own ground rather than out
// here. An earth ring underneath turns the mix into a sequence: tarmac, dust, grass.
//
// It holds full strength over the inner third of the skirt and is gone a few units past the end of
// it, so its own outer edge is never a line. **Narrow**, and that took two passes: the first ran
// 34 units wide in a frank tan, which stopped the city looking bruised and started it looking like
// it had its own private desert. The band only has to cover where the asphalt is *half* there. Cut from `slabShape` — the same Shape the slab and the
// skirt come from — a unit **inside** the outline, which is what guarantees it tucks under the
// opaque slab instead of racing it for the same pixels at the corner arcs.
const VERGE_HOLD = 6;
const VERGE_W = 22;
const VERGE_RINGS = 5;
const VERGE_TUCK = 1;

function vergeMesh() {
  const outline = slabShape(SLAB - VERGE_TUCK * 2, SLAB_RADIUS - VERGE_TUCK).extractPoints(14).shape;
  if (outline[outline.length - 1].distanceTo(outline[0]) < 1e-9) outline.pop();

  // Outward normal of a rounded rectangle in one expression — clamp into the box the corner arcs
  // are centred on and the direction back out to the point is the normal. Same trick as the
  // asphalt fade this sits under.
  const radius = SLAB_RADIUS - VERGE_TUCK;
  const inset = SLAB / 2 - SLAB_RADIUS;
  const normals = outline.map((p) => new THREE.Vector2(
    p.x - THREE.MathUtils.clamp(p.x, -inset, inset),
    p.y - THREE.MathUtils.clamp(p.y, -inset, inset),
  ).divideScalar(radius));

  const alphaAt = (d) => 1 - THREE.MathUtils.smoothstep(d, VERGE_HOLD, VERGE_W);
  const c = new THREE.Color(PALETTE.verge);
  const pos = [];
  const col = [];

  const vertex = (i, ring) => {
    const d = (ring / VERGE_RINGS) * VERGE_W;
    pos.push(outline[i].x + normals[i].x * d, outline[i].y + normals[i].y * d, 0);
    col.push(c.r, c.g, c.b, alphaAt(d));
  };

  for (let ring = 0; ring < VERGE_RINGS; ring++) {
    for (let i = 0; i < outline.length; i++) {
      const j = (i + 1) % outline.length;
      // Wound to match ShapeGeometry's own front face, so it survives the same rotateX below.
      vertex(i, ring); vertex(i, ring + 1); vertex(j, ring + 1);
      vertex(i, ring); vertex(j, ring + 1); vertex(j, ring);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 4));
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, LAND_Y + 0.03, 0);
  geo.computeVertexNormals();

  const material = propMaterial();
  material.transparent = true;
  material.depthWrite = false;

  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  // Under the asphalt fade, which is −1. Both are translucent ground with depth writing off, so
  // the queue order is the only thing deciding which is on top of which.
  mesh.renderOrder = -2;
  mesh.name = 'surrounds-verge';
  return mesh;
}

// --- The forest ---------------------------------------------------------------------------------
//
// Deliberately **not** `treeParts` from city/props.js, which is the one place in this project a
// tree is generated twice. That one is a park tree seen from two blocks away and costs about 130
// triangles: a subdivided icosahedron for the crown, another for each lobe, a capped trunk. There
// are 140 trees out here against a park's dozen, and they stand between 20 and 180 units past the
// last road — so the crown drops to a bare icosahedron, the trunk loses its caps (both ends are
// buried) and half of them are cones. 36 triangles a tree on average, which is what makes a forest
// affordable at all.
//
// **Nothing out here casts a shadow.** The sun's shadow camera covers `SPAN * 1.05` = 105 units
// (game/scene.js), so a forest running to 180 would have some trees casting and some not, split on
// a line across the middle of the wood — which reads as a bug rather than as distance. Turning it
// off for all of them is the consistent answer, and at this scale a flat-shaded conifer keeps its
// form from the shading alone.
const FOREST_MIN_H = 3.6;
const FOREST_MAX_H = 7.4;

/** How far out the wood is planted. Past this it is smaller than the haze can be bothered with. */
const FOREST_REACH = 220;

/**
 * How far a thing of height `h` reaches up-screen: the sightline off this camera climbs 0.92 for
 * every unit it travels in x *and* z, so anything standing on the ground hides `1.54 * h` of the
 * ground behind it.
 */
export const OCCLUSION_REACH = 1.54;

/**
 * Whether a tree of this height, standing here, would hide part of the city.
 *
 * **Up-screen, not inward.** What a tree occludes is the ground behind it *in the frame*, and the
 * frame's up is world `UP` = (−1, 0, −1)/√2 — so this is a question about a direction, and the
 * first pass got it wrong by asking a question about a radius instead. A radial keep-out clears the
 * city, but it clears it on all four sides: on the −X and −Z borders up-screen points out to sea,
 * nothing there can occlude anything, and a 27-unit ring round the whole map shaved the entire
 * foreshore bald for no reason at all.
 *
 * The bar is the slab's own outline rather than the fade's. The skirt is translucent tarmac with
 * nothing drawn on it, so a crown leaning over its outer half costs nothing; standing *in* it is
 * a separate rule, applied by the caller.
 */
function shadesTheCity(x, z, height) {
  const reach = OCCLUSION_REACH * height;
  // Six samples is a step of a fifth of the longest reach a tree here can have — under 2.3 units
  // against a city edge whose radius changes by that only across a whole corner arc.
  for (let n = 1; n <= 6; n++) {
    const t = (n / 6) * reach;
    if (slabEdgeDistance(x + UP.x * t, z + UP.z * t) < 0) return true;
  }
  return false;
}

function wildTree(x, z, rng, species) {
  const parts = [];
  const height = rng.range(FOREST_MIN_H, FOREST_MAX_H);
  const conifer = species ?? rng.chance(0.5);
  const trunkH = height * (conifer ? 0.26 : 0.44);

  // Open-ended: the bottom is in the ground and the top is inside the crown.
  const trunk = new THREE.CylinderGeometry(height * 0.028, height * 0.05, trunkH, 5, 1, true);
  trunk.translate(x, LAND_Y + trunkH / 2, z);
  parts.push(bakeColor(trunk, jitterColor(PALETTE.trunk, rng, { l: 0.06 })));

  if (conifer) {
    const tint = jitterColor(PALETTE.conifer, rng, { h: 0.02, l: 0.07 });
    const crown = height - trunkH;
    // Two skirts rather than one cone: a single cone is a party hat, and the step between them is
    // the whole of what says "spruce" at eight pixels wide.
    for (const [at, r, h] of [[0, height * 0.19, crown * 0.62], [0.42, height * 0.13, crown * 0.66]]) {
      const cone = new THREE.ConeGeometry(r, h, 6, 1, true);
      cone.translate(x, LAND_Y + trunkH + at * crown + h / 2, z);
      parts.push(bakeColor(cone, tint));
    }
  } else {
    const tint = jitterColor(PALETTE.wildFoliage, rng, { h: 0.025, l: 0.08 });
    const r = height * 0.3;
    const blob = new THREE.IcosahedronGeometry(r, 0);
    jitterVertices(blob, rng, r * 0.16);
    blob.scale(1.08, 0.86, 1.08);
    blob.translate(x, LAND_Y + trunkH + r * 0.7, z);
    parts.push(bakeColor(blob, tint));
    if (rng.chance(0.55)) {
      const angle = rng.range(0, Math.PI * 2);
      const reach = r * rng.range(0.35, 0.55);
      const lobe = new THREE.IcosahedronGeometry(r * rng.range(0.5, 0.7), 0);
      lobe.translate(x + Math.cos(angle) * reach, LAND_Y + trunkH + r * rng.range(0.9, 1.3),
        z + Math.sin(angle) * reach);
      parts.push(bakeColor(lobe, jitterColor(tint, rng, { l: 0.06 })));
    }
  }

  return { parts, height };
}

function shrub(x, z, rng) {
  const r = rng.range(0.55, 1.15);
  const geo = new THREE.IcosahedronGeometry(r, 0);
  jitterVertices(geo, rng, r * 0.22);
  geo.scale(1.2, 0.68, 1.2);
  geo.translate(x, LAND_Y + r * 0.4, z);
  return bakeColor(geo, jitterColor(PALETTE.wildFoliage, rng, { h: 0.03, l: 0.1 }));
}

function boulder(x, z, rng) {
  const r = rng.range(0.6, 1.5);
  const geo = new THREE.IcosahedronGeometry(r, 0);
  jitterVertices(geo, rng, r * 0.3);
  geo.scale(1.15, 0.7, 1);
  geo.rotateY(rng.range(0, Math.PI * 2));
  geo.translate(x, LAND_Y + r * 0.3, z);
  return bakeColor(geo, jitterColor(PALETTE.boulder, rng, { l: 0.07 }));
}

// --- Boats ---------------------------------------------------------------------------------------
//
// Each one is its own object because each one moves, and they share a single material so the extra
// draw calls cost state changes and nothing else.
//
// Hull colours are muted on purpose. The palette's flower-bed note sets out how little of the hue
// wheel is unspoken for once the urgency ramp, the taxi, the route band and the courier's cyan
// have taken theirs — but that argument is about *saturation as much as hue*, and a boat is a
// four-unit shape 60 units off the map rather than a mark on the board. Keeping them chalky is
// what stops one reading as something to tap.

/** Plan outline of a hull: square-ish stern, straight run, pointed bow. */
function hullShape(len, beam) {
  const hl = len / 2;
  const hw = beam / 2;
  const s = new THREE.Shape();
  s.moveTo(hl, 0);
  s.lineTo(hl * 0.5, hw);
  s.lineTo(-hl * 0.78, hw);
  s.lineTo(-hl, hw * 0.7);
  s.lineTo(-hl, -hw * 0.7);
  s.lineTo(-hl * 0.78, -hw);
  s.lineTo(hl * 0.5, -hw);
  return s;
}

/** A box, in the local frame every boat part is built in: x along the hull, y up, z across. */
function boatBox(w, h, d, x, y, z, col) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y, z);
  return bakeColor(geo, col);
}

function boatParts(rng) {
  const kind = rng.pick(['fishing', 'sail', 'barge']);
  const parts = [];

  const len = kind === 'barge' ? rng.range(10, 12.5)
    : kind === 'sail' ? rng.range(6.4, 8) : rng.range(6.8, 8.6);
  const beam = len * (kind === 'sail' ? 0.26 : kind === 'barge' ? 0.34 : 0.31);
  const depth = len * 0.115;

  const hullCol = jitterColor(rng.pick(PALETTE.boatHull), rng, { l: 0.05 });
  const trim = jitterColor(PALETTE.boatTrim, rng, { l: 0.05 });

  // Extruded along +z, then laid down: `rotateX(-π / 2)` maps z to +y, so the depth becomes the
  // freeboard and the hull stands from y = 0 up.
  const hull = new THREE.ExtrudeGeometry(hullShape(len, beam), {
    depth, bevelEnabled: false,
  });
  hull.rotateX(-Math.PI / 2);
  parts.push(bakeColor(hull, hullCol));

  // A deck, so the camera does not look down into an open box.
  const deck = new THREE.ShapeGeometry(hullShape(len * 0.985, beam * 0.96));
  deck.rotateX(-Math.PI / 2);
  deck.translate(0, depth + 0.01, 0);
  parts.push(bakeColor(deck, trim));

  if (kind === 'fishing') {
    parts.push(boatBox(len * 0.26, depth * 1.5, beam * 0.62, -len * 0.14, depth + depth * 0.75, 0,
      jitterColor(PALETTE.boatCabin, rng, { l: 0.05 })));
    const mast = new THREE.CylinderGeometry(0.06, 0.08, len * 0.42, 5, 1, true);
    mast.translate(-len * 0.14, depth + len * 0.28, 0);
    parts.push(bakeColor(mast, trim));
  } else if (kind === 'sail') {
    const mastH = len * 1.15;
    const mast = new THREE.CylinderGeometry(0.05, 0.07, mastH, 5, 1, true);
    mast.translate(len * 0.04, depth + mastH / 2, 0);
    parts.push(bakeColor(mast, trim));
    // The sail is an extruded triangle rather than a plane: a single-sided triangle takes its
    // flat-shaded normal from a screen-space derivative, so from behind it lights as though the
    // sun were on the far side of the world. Eight hundredths of a unit of thickness costs four
    // triangles and removes the question.
    const sail = new THREE.Shape();
    sail.moveTo(0, 0);
    sail.lineTo(0, mastH * 0.86);
    sail.lineTo(-len * 0.5, 0);
    const cloth = new THREE.ExtrudeGeometry(sail, { depth: 0.08, bevelEnabled: false });
    cloth.translate(len * 0.04, depth + 0.18, -0.04);
    parts.push(bakeColor(cloth, jitterColor(PALETTE.sail, rng, { l: 0.04 })));
  } else {
    parts.push(boatBox(len * 0.2, depth * 1.7, beam * 0.66, -len * 0.32, depth + depth * 0.85, 0,
      jitterColor(PALETTE.boatCabin, rng, { l: 0.05 })));
    // Deck cargo — the one thing that makes a barge read as a working boat from above, which is
    // the only angle anyone ever sees it from.
    for (let i = 0; i < rng.int(2, 3); i++) {
      const w = len * rng.range(0.13, 0.2);
      parts.push(boatBox(w, w * 0.72, beam * rng.range(0.4, 0.6),
        len * rng.range(-0.05, 0.34), depth + w * 0.36, beam * rng.range(-0.16, 0.16),
        jitterColor(rng.pick(PALETTE.boatHull), rng, { l: 0.07 })));
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  // How deep she floats: the waterline is a fraction of the freeboard up from the keel.
  return { geometry: merged, draft: depth * 0.42 };
}

/**
 * Everything outside the city: the sea, its foam and its boats on the −X and −Z borders, and the
 * meadow, forest and scrub on the other two.
 *
 * Takes the **city** rng, not the run's: what is over the border is a fact about this map, not
 * about this shift, and pinning `?seed=` has to pin the coastline with everything else.
 */
export function createSurrounds(rng) {
  const group = new THREE.Group();
  group.name = 'surrounds';

  const wobble = makeWobble(rng);

  /** Signed distance to the coast, positive in the water. The one answer everything else asks. */
  const coastDistance = (x, z) => shoreBaseDistance(x, z) - wobble(coastParam(x, z));

  // The coastline as a polyline, walked by arc length so the last sample lands exactly on the end
  // rather than a step short of it.
  const samples = [];
  for (let s = 0; s < COAST_LEN; s += COAST_STEP) samples.push(coastAt(s, wobble));
  samples.push(coastAt(COAST_LEN, wobble));

  // --- Ground: sand to the waterline, grass inside it, patches on top of that.
  const land = [];
  land.push(bakeColor(landSurface(landShape(samples), LAND_Y),
    jitterColor(PALETTE.sand, rng, { l: 0.02 })));
  land.push(bakeColor(landSurface(landShape(samples, BEACH_W), LAND_Y + 0.01),
    jitterColor(PALETTE.meadow, rng, { l: 0.02 })));
  land.push(bakeColor(shoreLip(samples), jitterColor(PALETTE.wetSand, rng, { l: 0.03 })));

  // Meadow patches. Allowed under the asphalt skirt on purpose — the fade is translucent tarmac,
  // so a patch showing through it is the city dissolving into varied ground rather than into one
  // flat green, which is the whole reason the skirt fades into something at all.
  for (let n = 0; n < 220; n++) {
    const x = rng.range(-235, 235);
    const z = rng.range(-235, 235);
    if (slabEdgeDistance(x, z) < 0.5) continue;
    if (coastDistance(x, z) > -(BEACH_W + 0.5)) continue;
    // Three tones either side of the base green rather than one pale one. A single lighter green
    // drawn at 40% turned the field into a scatter of flat yellow lozenges — what wanted fixing
    // was not the count but the *contrast*, and a patch that also comes in darker reads as ground
    // rather than as something spilt on it.
    const tone = rng.chance(0.4) ? PALETTE.meadowPale : rng.chance(0.5) ? PALETTE.meadowDeep : PALETTE.meadow;
    land.push(bakeColor(patchGeometry(x, z, rng.range(4, 15), rng),
      jitterColor(tone, rng, { h: 0.02, l: 0.04 })));
  }

  // --- The forest. Clusters first, then singles thinning out between them, which is what makes a
  // wood look planted by weather rather than by a loop.
  const planted = [];
  const room = (x, z, height) => {
    // Clear of the water and its beach…
    if (coastDistance(x, z) > -(BEACH_W + 3)) return false;
    // …never standing in the asphalt's fade, which is tarmac however transparent…
    if (slabEdgeDistance(x, z) < EDGE_FADE) return false;
    // …and never in front of the city, which is a question about the screen. See above.
    if (shadesTheCity(x, z, height)) return false;
    return !planted.some((p) => Math.hypot(p.x - x, p.z - z) < 2.2);
  };

  const plant = (x, z, conifer) => {
    const tree = wildTree(x, z, rng, conifer);
    if (!room(x, z, tree.height)) {
      tree.parts.forEach((p) => p.dispose());
      return false;
    }
    planted.push({ x, z, height: tree.height });
    land.push(...tree.parts);
    return true;
  };

  // Half of the box these are drawn from is sea and a good part of the rest is city, so a plain
  // loop plants a third of what it asks for. Rejection-sample instead, and let the caller ask for
  // a *count* rather than for a number of attempts.
  const plantable = (height) => {
    for (let tries = 0; tries < 24; tries++) {
      const x = rng.range(-FOREST_REACH, FOREST_REACH);
      const z = rng.range(-FOREST_REACH, FOREST_REACH);
      if (room(x, z, height)) return { x, z };
    }
    return null;
  };

  // Clusters carry most of the wood and they are *tight*: at a 9-16 unit spread with a dozen or
  // more trees in each, the crowns touch and the clump reads as one canopy. Spread evenly over the
  // same area instead and the same number of trees photographed as scrub — a wood is a mass, and
  // the thing that makes a mass is trees standing closer together than they look like they should.
  for (let c = 0; c < 22; c++) {
    const centre = plantable(FOREST_MAX_H);
    if (!centre) continue;
    const spread = rng.range(9, 16);
    // One species per clump, mostly. Mixed at random every clump comes out the same average green.
    const conifer = rng.chance(0.5) ? rng.chance(0.85) : rng.chance(0.15);
    for (let n = 0; n < rng.int(12, 20); n++) {
      const a = rng.range(0, Math.PI * 2);
      const r = spread * Math.sqrt(rng.next());
      plant(centre.x + Math.cos(a) * r, centre.z + Math.sin(a) * r, conifer);
    }
  }
  // A few singles between the clumps, so the wood has an edge that frays rather than one that
  // stops. Deliberately a *few*: the same tree budget spent evenly instead of in clumps is what
  // made the first pass photograph as scrub, and singles are how that failure gets back in.
  for (let n = 0; n < 25; n++) {
    const spot = plantable(FOREST_MAX_H);
    if (spot) plant(spot.x, spot.z);
  }

  // Scrub. Held to a 1.5-unit height when it asks for room, which lets it come 10 units closer to
  // the city than a tree can — so the apron between the last road and the first wood is field
  // rather than lawn.
  for (let n = 0; n < 110; n++) {
    const spot = plantable(1.5);
    if (!spot) continue;
    land.push(rng.chance(0.88) ? shrub(spot.x, spot.z, rng) : boulder(spot.x, spot.z, rng));
  }

  const landMesh = new THREE.Mesh(mergeGeometries(land, false), propMaterial());
  land.forEach((p) => p.dispose());
  // The city's own shadows fall up-screen, which is straight out onto the coastal strip — the one
  // place out here anything the sun can reach is standing.
  landMesh.receiveShadow = true;
  landMesh.name = 'surrounds-land';
  group.add(landMesh);

  group.add(vergeMesh());

  const sea = seaMesh(coastDistance);
  group.add(sea.mesh);
  group.add(foamMesh(samples));

  // --- Boats. Moored in the open water off both shores, far enough out that the swell they ride
  // is at full strength and near enough in that the camera can reach them.
  const boatMaterial = propMaterial();
  const boats = [];
  for (let n = 0; n < 8; n++) {
    let spot = null;
    for (let tries = 0; tries < 40 && !spot; tries++) {
      const x = rng.range(-165, 145);
      const z = rng.range(-165, 145);
      const d = coastDistance(x, z);
      if (d < 24 || d > 92) continue;
      if (boats.some((b) => Math.hypot(b.x - x, b.z - z) < 24)) continue;
      spot = { x, z };
    }
    if (!spot) continue;

    const { geometry, draft } = boatParts(rng);
    const mesh = new THREE.Mesh(geometry, boatMaterial);
    const boat = {
      mesh,
      x: spot.x,
      z: spot.z,
      draft,
      yaw: rng.range(0, Math.PI * 2),
      // Not moored to a buoy — she works the anchor chain. A slow reach along her own heading and
      // an even slower swing on it, both long enough that nothing about the motion reads as a lap.
      drift: rng.range(2.5, 6),
      driftRate: rng.range(0.055, 0.1),
      swing: rng.range(0.05, 0.13),
      swingRate: rng.range(0.07, 0.13),
      phase: rng.range(0, Math.PI * 2),
      swell: swellWeight(coastDistance(spot.x, spot.z), spot.x, spot.z),
    };
    mesh.rotation.order = BODY_EULER_ORDER;
    mesh.name = 'boat';
    boats.push(boat);
    group.add(mesh);
  }

  let time = 0;

  /**
   * Sit every boat in the water she is actually floating in.
   *
   * Heave is the wave height under her; the trim is the wave's *slope*, read as a finite difference
   * along her own two axes. That is what makes a boat look moored rather than animated: the swell
   * is one field, and the hull and the facets around it are answering the same sum of sines.
   *
   * `rotation.set(roll, yaw, pitch)` on the default Euler order would roll about the *world* X
   * axis, which coincides with a hull's long axis only when she happens to be pointing east — the
   * same trap the cars' lean fell into. `BODY_EULER_ORDER` puts the roll inside the yaw.
   */
  function place(boat) {
    const yaw = boat.yaw + Math.sin(time * boat.swingRate + boat.phase) * boat.swing;
    const reach = Math.sin(time * boat.driftRate + boat.phase * 1.7) * boat.drift;
    const bow = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const side = { x: Math.sin(yaw), z: Math.cos(yaw) };

    const x = boat.x + bow.x * reach;
    const z = boat.z + bow.z * reach;
    const at = (dx, dz) => waveHeight(x + dx, z + dz, time) * boat.swell;

    const e = 0.9;
    const alongBow = (at(bow.x * e, bow.z * e) - at(-bow.x * e, -bow.z * e)) / (2 * e);
    const alongSide = (at(side.x * e, side.z * e) - at(-side.x * e, -side.z * e)) / (2 * e);

    boat.mesh.position.set(x, WATER_Y + at(0, 0) - boat.draft, z);
    // Positive rotation about the hull's own x tips her +z side down, so the roll that follows the
    // water is the negative of the slope across her.
    boat.mesh.rotation.set(-Math.atan(alongSide), yaw, Math.atan(alongBow), BODY_EULER_ORDER);
  }

  boats.forEach(place);

  return {
    group,
    boats,
    // Where every tree went and how tall it came out. Exported for `tools/probe.mjs`, which walks
    // the up-screen sightline off each one against the real city edge rather than re-stating the
    // rule that planted it.
    trees: planted,
    coastDistance,
    samples,
    update(dt) {
      time += dt;
      sea.uniforms.uTime.value = time;
      boats.forEach(place);
    },
  };
}

/** One coast sample: the wobbled point and the normal it was pushed along. */
function coastAt(s, wobble) {
  const base = coastBase(s);
  const off = wobble(s);
  return { x: base.x + base.nx * off, z: base.z + base.nz * off, nx: base.nx, nz: base.nz, s };
}
