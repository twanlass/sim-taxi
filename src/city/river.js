import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import {
  GRID_I, GRID_J, lineX, lineZ, halfRoadZ, riverBanks, riverRow, segmentKey,
} from './grid.js';
import { SLAB_X, KERB_H, PAVE_INSET } from './ground.js';

// A river running east-west through the city, and the four crossings that get over it.
//
// **The city is a block row taller than it is wide so that the water costs it nothing.** One of
// the six rows is the channel; the other five carry the same 25 buildable blocks a 5x5 city had,
// and every street survives — there is one *more* east-west street than there used to be. That is
// the whole reason `GRID` had to come apart into `GRID_I` and `GRID_J` (see grid.js), and it is
// the alternative to the obvious version of this feature, which is to flood a row and lose five
// blocks plus whichever one-per-city landmark happened to be standing on one of them.
//
// The row *is* the river, which is what makes the rest cheap: `blockBounds` already describes the
// channel, `layout.js` types those blocks `'river'` and every generator that walks `'built'`
// blocks skips them without being told, and the two crossings with no bridge are ordinary closed
// segments — the same mechanism a park district uses when it builds over a road.
//
// What this module owns: where the river goes and which crossings bridge it (`planRiver`), the
// channel's own geometry, and the deck profile the fixed spans arch on (`deckHeightAt`). The
// bridges themselves are `geometry/bridge.js`; the one that lifts is `game/drawbridge.js`.

// --- Depth ------------------------------------------------------------------
//
// **A camera number, not a taste one.** This view looks down at 33 degrees, so anything of height
// `h` hides the ground within `1.54h` behind it — and a channel wall hides the water in front of
// it by exactly the same arithmetic. At 2.0 deep the near wall covers 3.1 of the channel's 12
// units, which is enough to read as a cutting and leaves most of the water in shot; at 3.5 it
// would be 5.4 of 12 and the river would be a trench with a stripe of blue in it.
//
// It is also the boat clearance under a flat span, which is the other half of why the fixed
// bridges arch — see `ARCH_RISE`.
export const WATER_Y = -2.0;

// How far the channel wall carries on below the waterline. Nothing is ever seen down there; this
// only stops a seam showing at the water's edge if the two ever disagree by a rounding error.
const WALL_FOOT = 0.6;

// --- The embankment ---------------------------------------------------------
//
// A riverside street presents a pavement to the water exactly as every other street in this city
// presents one to its buildings, and the first cut of this had none: the road's kerb *was* the
// bank, with a wall standing on it. That reads as a canal cut through the tarmac rather than as a
// city built along a river, and it left the two junction rows on the banks with nowhere to put a
// rider's feet.
//
// **The 1.4 comes out of the water, and there is nowhere else for it to come from.** The row is
// `BLOCK` = 12 units between kerbs and the grid's pitch is uniform, so a walk on each bank takes
// the channel to 9.2 — a shade over one road width rather than the one and a half it was. Widening
// the row instead would mean a non-uniform `lineZ`, which is a second refactor the size of the
// first one.
//
// 1.4 rather than the 1.0 a park's frontage gets (`PARK_WALK` in ground.js): this one has to hold
// a fare marker's pin, which `cornerFor` stakes 0.5 past the kerb, and it has a railing standing on
// its far edge.
export const EMBANK_WALK = 1.4;

// --- Railings ---------------------------------------------------------------
//
// Along the water and across every span, in place of the solid parapet this opened with. A wall is
// the honest thing for a river to have and it is the wrong thing for *this* camera: at 0.75 tall it
// hid `1.087h` = 0.8 units of whatever lay behind it, which on the south bank is the near lane of
// the road below — a car's far flank clears it by 0.33 units and no more. A railing hides nothing,
// because you can see through it.
//
// Sized to survive play zoom rather than to be correct: 1 world unit is 7.7px, so a 0.14 section is
// about a pixel and the posts are what carry the rhythm. Under about 1.5 units of pitch they merge
// into a grey band; much over 2 and the rail reads as floating.
export const RAIL_H = 0.62;
export const RAIL_W = 0.14;
export const RAIL_POST_PITCH = 1.7;

// --- The arch ---------------------------------------------------------------
//
// The three fixed spans hump. It buys two things, and the second is what makes the feature hang
// together: cars get a little elevation and pitch going over, and boats get somewhere to go.
//
// A bascule leaf has to be flat to lie down and to hinge, so the drawbridge is the one span at
// plain road level — and the arch is what lets a boat clear the other three. **The bridge that
// lifts is the bridge that could not arch**, which is a better reason than "this one is special".
//
// Measured to the deck's soffit, since that is what a boat hits:
//
//     flat span, deck 0.35 thick     soffit -0.35    clearance 1.65
//     arched span at the crest       soffit +0.75    clearance 2.75
//     barge, air draught 1.4                         clears both
//     tug, air draught 2.4                           clears the arches by 0.35,
//                                                    0.75 short of the flat one
//
// **The rise is a camera number too.** A world-Y lift of `h` moves `6.45h` px up the screen at
// play zoom (SCREEN_PER_WORLD_Y 0.838 x 7.7 px per unit), so 1.1 is about 7px. That is
// deliberately under the roadworks hop's apex, which was *raised* to 2.75 because 12px read as a
// lift rather than a jump: a hump wants to be short of the number a jump starts at. The arch
// occludes 1.7 units of the 12-unit channel behind it, so it never hides the water on its far side.
export const ARCH_RISE = 1.1;
export const DECK_THICK = 0.35;
/** Soffit of a flat span, and of an arched one at its crest. What a boat has to fit under. */
export const FLAT_SOFFIT = -DECK_THICK;
export const ARCH_SOFFIT = ARCH_RISE - DECK_THICK;

/** Air draughts, exported so `tools/probe.mjs` can assert the chain above rather than the outcome. */
export const BARGE_AIR = 1.4;
export const TUG_AIR = 2.4;

// How far a bridge deck reaches beyond the road it carries: its footway, and the edge beam under
// it. **The same 1.4 the embankment walk is**, deliberately — a pavement that narrowed as it
// crossed the river would be the one place in the city where the footway is worth noticing, and it
// is the wrong place. It opened at 0.4, which left 0.12 of shoulder inside the railing: under a
// pixel at play zoom, so the railing looked like it was standing in the road.
export const DECK_OVERHANG = EMBANK_WALK;

// --- Where the river goes ----------------------------------------------------

/**
 * **The middle two rows only, so the river splits the city roughly in half.**
 *
 * With six rows and one of them water, the land either side comes out 2 and 3 — which is as near
 * to half as an odd number of land rows gets, and it is the whole point of the feature: a river
 * that runs down one edge of the map is a moat, and what makes this worth having is that every
 * trip across town has to pick a crossing.
 *
 * The outer rows are excluded for a second reason as well. A river against the ring road would put
 * the outermost street — the one that never stops for a signal, and the one the police corridor
 * drives end to end — on an embankment with water down one side.
 */
const middleRow = (rng) => rng.int(Math.floor((GRID_J - 1) / 2), Math.ceil((GRID_J - 1) / 2));

/**
 * Which crossings carry a bridge, and what kind. **Three of the six.**
 *
 * **The two ring roads always bridge.** The outermost roads are the signal-free ring (grid.js), the
 * police corridor drives one end to end, and ambient traffic yields into it rather than stopping —
 * breaking either one would need a fallback in all three. Exactly **one** interior crossing bridges,
 * and it is the drawbridge; the other three are open water.
 *
 * It opened with four — the two ring roads and two interior spans — and four is too many ways over.
 * With that many, a lift was an inconvenience routed round without the player ever noticing which
 * bridge had closed or why. One interior crossing makes the drawbridge **the** way through the
 * middle of the city, so raising it is the difference between driving across town and driving round
 * it.
 *
 * That still leaves **two ways across while the leaf is up**, which is the guarantee this rests on:
 * the span may close a route, but it may never cut the city in half. `tools/probe.mjs` asserts it
 * over all 7,056 (origin, heading, destination) triples with the lanes blocked rather than trusting
 * the sentence.
 */
export function planRiver(rng) {
  const row = middleRow(rng);

  const crossings = new Map();
  for (let i = 0; i <= GRID_I; i++) crossings.set(i, 'water');
  crossings.set(0, 'fixed');
  crossings.set(GRID_I, 'fixed');

  // One interior line, and it is the one that lifts. Never a ring road: the ring is the way round
  // everything else in this game, and a lift that closed it would take the escape route away at the
  // same moment it takes the direct one.
  const interior = [];
  for (let i = 1; i < GRID_I; i++) interior.push(i);
  const draw = interior.length ? interior[rng.int(0, interior.length - 1)] : null;
  if (draw !== null) crossings.set(draw, 'draw');

  // The crossings with no bridge are closed roads in the ordinary sense — `legalExits` drops them,
  // the network never bakes an edge, ambient traffic and the router both plan around them for free.
  const closed = [];
  for (const [i, kind] of crossings) {
    if (kind === 'water') closed.push(segmentKey(i, row, i, row + 1));
  }

  return { row, crossings, draw, closed };
}

// --- The registry ------------------------------------------------------------
//
// `grid.js` holds the row, because the median islands and the road markings need it and grid.js is
// what they read. The crossings live here, because what needs them is the geometry, the roadworks
// site filter and the drawbridge.

let crossingKinds = new Map();

export function setRiverCrossings(crossings) {
  crossingKinds = new Map(crossings ?? []);
}

/** 'fixed', 'draw' or 'water' for the road running along Z at line i — null if there is no river. */
export const riverCrossing = (i) => (riverRow() === null ? null : crossingKinds.get(i) ?? 'water');

/** Every line index that carries a bridge deck, fixed or lifting. */
export const bridgeLines = () => [...crossingKinds.keys()]
  .filter((i) => crossingKinds.get(i) !== 'water')
  .sort((a, b) => a - b);

/** The line the drawbridge is on, or null. */
export const drawbridgeLine = () => {
  for (const [i, kind] of crossingKinds) if (kind === 'draw') return i;
  return null;
};

/**
 * The water's own two edges: the channel less the embankment walk on each bank.
 *
 * `riverBanks` in grid.js gives the *road* kerb lines, which is what the bridges span and what the
 * block model calls the row. The water is narrower than that by a walk on each side, and the two
 * are easy to confuse — anything asking "where does the wet bit start" wants this one.
 */
export function waterEdges() {
  const banks = riverBanks();
  if (!banks) return null;
  return { z0: banks.z0 + EMBANK_WALK, z1: banks.z1 - EMBANK_WALK };
}

/**
 * A straight run of railing along x, standing on whatever is at `y`.
 *
 * Posts on a fixed pitch with a top and a mid rail. The pitch is walked from the *centre* of the
 * run rather than from one end, so a railing either side of a bridge keeps its rhythm across the
 * gap instead of restarting at each abutment — which at 1.7 units is the difference between a fence
 * and a row of fences.
 */
function straightRailing(x0, x1, z, y, col) {
  const parts = [];
  const len = x1 - x0;
  if (len < RAIL_W) return parts;

  for (const [h, thick] of [[RAIL_H - RAIL_W / 2, RAIL_W], [RAIL_H * 0.5, RAIL_W * 0.7]]) {
    const rail = new THREE.BoxGeometry(len, thick, thick);
    rail.translate((x0 + x1) / 2, y + h, z);
    parts.push(bakeColor(rail, col));
  }

  const first = Math.ceil((x0 - 0) / RAIL_POST_PITCH) * RAIL_POST_PITCH;
  for (let x = first; x <= x1 - RAIL_W / 2; x += RAIL_POST_PITCH) {
    if (x < x0 + RAIL_W / 2) continue;
    const post = new THREE.BoxGeometry(RAIL_W, RAIL_H, RAIL_W);
    post.translate(x, y + RAIL_H / 2, z);
    parts.push(bakeColor(post, col));
  }
  return parts;
}

/**
 * A bridge's footprint: the deck's span in z and its half-width in x.
 *
 * The deck runs **exactly bank to bank**. It does not overlap the asphalt at either end, and that
 * is not tidiness: the slab is a flat surface at y = 0 and so is the deck at its abutments, so an
 * overlap would be two coplanar opaque polygons — the shimmer that cost the burger joint's
 * forecourt a rebuild. Meeting edge to edge is also what a bridge actually does.
 */
export function bridgeSpan(i) {
  const banks = riverBanks();
  if (!banks) return null;
  return {
    line: i,
    kind: riverCrossing(i),
    // The two junctions the crossing runs between, so a caller can name its lanes without
    // re-deriving which row the river is in.
    row: riverRow(),
    z0: banks.z0,
    z1: banks.z1,
    cx: lineX(i),
    half: halfRoadZ(i),
    outer: halfRoadZ(i) + DECK_OVERHANG,
  };
}

// --- The deck profile ---------------------------------------------------------

/**
 * The arch, as a height above road level and its slope, at a fraction `u` along the span.
 *
 * `sin^2` rather than any other hump. **Zero slope at both ends is the whole of the choice**: a
 * curve that arrives at the abutment with slope left in it kinks visibly where the deck meets the
 * road, and no amount of tuning the rise hides a kink. The peak grade is `rise * PI / span`, which
 * over a 12-unit channel is 16 degrees — steep for a road and exactly right for a humpback.
 */
export function archAt(u, span, rise = ARCH_RISE) {
  const s = Math.sin(Math.PI * u);
  return { y: rise * s * s, slope: (rise * Math.PI / span) * Math.sin(2 * Math.PI * u) };
}

/**
 * Height and slope of the road surface at a world point: 0 everywhere except on an arched span.
 *
 * **World-space rather than keyed by lane id**, because that is the shape both callers already
 * have in hand — `sim/traffic.js` poses a car from `car.x`/`car.z` and `sim/police.js` puts its
 * cruiser on a rail that answers in world coordinates. A lane-keyed lookup would make both of them
 * convert, and the police car has no lane at all.
 *
 * At most four rectangles, scanned linearly. Called twice per car per frame (nose and tail — see
 * the pose step in traffic.js) which at 30 cars is 240 rectangle tests, and a rectangle test is
 * four comparisons.
 *
 * Returns `dydz` only: every bridge in this city carries a road running along Z, so the deck has no
 * cross-fall and `dydx` is zero by construction. Stated rather than computed so that a bridge on an
 * x-running road, if there is ever one, fails to compile rather than silently driving flat.
 */
export function deckHeightAt(x, z) {
  const banks = riverBanks();
  if (!banks || z < banks.z0 || z > banks.z1) return FLAT;

  const span = banks.z1 - banks.z0;
  for (const i of bridgeLines()) {
    if (crossingKinds.get(i) !== 'fixed') continue;    // the drawbridge is flat, by definition
    const half = halfRoadZ(i) + DECK_OVERHANG;
    const cx = lineX(i);
    if (x < cx - half || x > cx + half) continue;
    const { y, slope } = archAt((z - banks.z0) / span, span);
    return { y, dydz: slope };
  }
  return FLAT;
}

const FLAT = Object.freeze({ y: 0, dydz: 0 });

// --- Geometry -----------------------------------------------------------------

/**
 * The coast: where the asphalt slab stops being solid, and where the river's banks stop with it.
 *
 * A wall is a thing that holds land back, and past the slab's own edge there is no land to hold —
 * carried out to the water's full reach the two walls and their parapets were four beams hanging
 * in the sky off each end of the island, which is exactly what the first build looked like. What
 * runs out past the coast is the river alone, tucked under the skirt that closes each mouth.
 */
const BANK_REACH = () => SLAB_X / 2;

/**
 * The channel: two walls, two parapets, and the water between them.
 *
 * The water is a **separate mesh** from the walls for the reason the asphalt's fade skirt is
 * separate from the ground: its alpha rides in a 4-component vertex colour, and the merged city
 * mesh's colour attribute has three.
 */
export function createRiver(rng, layout) {
  const banks = riverBanks();
  if (!banks) return null;

  const group = new THREE.Group();
  group.name = 'river';

  const solid = [];
  const wallCol = jitterColor(PALETTE.riverWall, rng, { l: 0.02 });
  const bank = BANK_REACH();

  const kerbCol = jitterColor(PALETTE.kerb, rng, { l: 0.02 });
  const walkCol = jitterColor(PALETTE.sidewalk, rng, { l: 0.03 });
  const edges = waterEdges();

  // --- The two channel walls, from the top of the embankment down past the waterline.
  //
  // Both, although only one is ever seen from the play camera: the view looks down the -x-z
  // diagonal, so the south wall shows its +Z face and the north wall is looked *over*. The unseen
  // one still has to exist, because the sun moves all day and the shadow pass is rendered from
  // wherever it happens to be.
  for (const [z, facing] of [[edges.z0, 1], [edges.z1, -1]]) {
    const wall = new THREE.PlaneGeometry(bank * 2, KERB_H - WATER_Y + WALL_FOOT);
    wall.translate(0, KERB_H - (KERB_H - WATER_Y + WALL_FOOT) / 2, 0);
    if (facing < 0) wall.rotateY(Math.PI);
    wall.translate(0, 0, z);
    solid.push(bakeColor(wall, wallCol));
  }

  // --- The embankment: a raised walk down each bank, and a railing on the water's edge.
  //
  // Built exactly the way a block's platform is (`createGround`) — a kerb box with a pavement
  // surface inset on top of it — because that is what it is: a raised kerb with somewhere to stand.
  // Interrupted where a bridge crosses, since the road cuts straight through at grade.
  const gaps = bridgeLines().map((i) => {
    const span = bridgeSpan(i);
    return [span.cx - span.outer, span.cx + span.outer];
  });
  for (const [kerbZ, waterZ] of [[banks.z0, edges.z0], [banks.z1, edges.z1]]) {
    const mid = (kerbZ + waterZ) / 2;
    for (const [x0, x1] of runsBetween(-bank, bank, gaps)) {
      const w = x1 - x0;
      if (w < 0.05) continue;
      const platform = new THREE.BoxGeometry(w, KERB_H, EMBANK_WALK);
      platform.translate((x0 + x1) / 2, KERB_H / 2, mid);
      solid.push(bakeColor(platform, kerbCol));

      const walk = new THREE.PlaneGeometry(w, EMBANK_WALK - PAVE_INSET * 2);
      walk.rotateX(-Math.PI / 2);
      walk.translate((x0 + x1) / 2, KERB_H + 0.01, mid);
      solid.push(bakeColor(walk, walkCol));

      solid.push(...straightRailing(x0, x1, waterZ, KERB_H, wallCol));
    }
  }

  const merged = mergeGeometries(solid, false);
  solid.forEach((part) => part.dispose());
  const shell = new THREE.Mesh(merged, propMaterial());
  shell.castShadow = true;
  shell.receiveShadow = true;
  shell.name = 'river-shell';

  const water = waterMesh(rng, edges);
  group.add(shell);
  group.add(water);

  return { group, shell, water, banks };
}

// --- How the water dissolves at the two ends of the channel ------------------
//
// The first cut ran the same 16-unit band the asphalt's own skirt uses (`EDGE_FADE` in ground.js)
// on the same smoothstep, on the reasoning that the two edges are a few units apart on screen and
// ought to match. **Measured against each other they do not**, and the mismatch is the whole
// problem: sampled every two units out from the coast, the two fades ramp from luma 85 to the
// sky's 210 over the same distance, but the water is 20-25 luma ahead of the asphalt the whole
// way. Against a dark island that reads as a pale wedge shooting out of each river mouth — a light
// leak rather than a river running off into the haze, and the straight bank line between the two
// fades gives it a hard edge to boot.
//
// How far the water tucks under the skirt that closes each mouth. A couple of units, so the
// strip's hard end is comfortably inside the alpha-1 start of `riverMouthFade` rather than
// landing on the same line as it and leaving a hairline of sky at the join.
const MOUTH_TUCK = 2;

// **The water does not dissolve itself.** Three versions of it tried to, and all three left a pale
// blade lying in the coastline — because at the mouth the island is *gone* while the rim either
// side of it is still dark, so anything drawn in that notch is the brightest thing in the frame.
// Measured every two units out from the coast: the asphalt skirt runs 85 -> 210 luma over its
// sixteen units, and water on the same band and the same smoothstep still ran 24 luma ahead of it
// the whole way, whether it faded from `riverWater`, from `riverDeep`, or eased into the asphalt's
// own colour on the way. Shortening the band only swapped the blade for a hard-edged notch of sky.
//
// What closes it is not doing it here at all: `riverMouthFade` in ground.js carries the island's
// **own** rim straight across the channel, on the skirt's colour and the skirt's curve, and the
// river simply ends underneath it. See the note there.

/**
 * The water: one flat strip at `WATER_Y`, running the length of the channel and out past the
 * island at both ends.
 *
 * Alpha rides in a **4-component vertex colour**, the trick the asphalt skirt and the skid marks
 * both use, so the fade needs no shader — and the material is `propMaterial`'s own recipe, so a
 * surface at the same height with the same normal is lit identically to the solid part of the
 * river beside it.
 *
 * Across the channel it carries a **depth gradient**: `riverDeep` at both walls, `riverWater` down
 * the middle. That is the pond's centre-vertex trick at map scale (`pondParts` in pond.js) and it
 * costs one extra row of vertices — without it the river is a flat blue stripe, and with it the
 * walls read as holding something in.
 */
function waterMesh(rng, edges) {
  const deep = new THREE.Color(jitterColor(PALETTE.riverDeep, rng, { l: 0.02 }));
  const open = new THREE.Color(jitterColor(PALETTE.riverWater, rng, { l: 0.02 }));

  // Two columns and three rows: the water is one flat opaque strip from coast to coast, and what
  // dissolves it at each end is the island's own rim carried across the mouth (`riverMouthFade` in
  // ground.js), not anything this mesh does. The strip runs a little past the coast so that its
  // hard end sits under the alpha-1 start of that skirt rather than beside it.
  const solid = BANK_REACH() + MOUTH_TUCK;
  const columns = [{ x: -solid, a: 1 }, { x: solid, a: 1 }];
  const rows = [
    { z: edges.z0, deep: true },
    { z: (edges.z0 + edges.z1) / 2, deep: false },
    { z: edges.z1, deep: true },
  ];

  const pos = [];
  const col = [];
  const vertex = (ci, ri) => {
    const c = rows[ri].deep ? deep : open;
    pos.push(columns[ci].x, WATER_Y, rows[ri].z);
    col.push(c.r, c.g, c.b, columns[ci].a);
  };
  // Wound to face **up**. Taken in increasing (x, z) order a quad faces down, and
  // `computeVertexNormals` would launder that into a surface lit from underneath rather than into
  // an error — so the winding is the thing `tools/probe.mjs` checks, not the look.
  for (let ci = 0; ci < columns.length - 1; ci++) {
    for (let ri = 0; ri < rows.length - 1; ri++) {
      vertex(ci, ri); vertex(ci, ri + 1); vertex(ci + 1, ri + 1);
      vertex(ci, ri); vertex(ci + 1, ri + 1); vertex(ci + 1, ri);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 4));
  geo.computeVertexNormals();

  // **Out of the AO lookup.** `markOccluder` will not put a transparent mesh in the depth prepass,
  // so a transparent mesh that *receives* AO reads the occlusion of whatever is behind it — see the
  // note on `propMaterial`. On this surface that is not a subtlety: the water inside the channel
  // sampled the walls' crease and went nearly black, while the stretch past the island had an empty
  // buffer behind it and came out at full brightness, which put a pale wedge in the sky off each
  // river mouth with the seam landing exactly on the coast.
  const material = propMaterial({ ao: false });
  material.transparent = true;
  // A surface you can see through has no business hiding what is drawn behind it — the same rule
  // the asphalt skirt and every other bit of translucent paint in this game follows. It also keeps
  // the water out of the way of the boats floating on it: those are opaque, so they are drawn and
  // depth-written first, and the water then fails its own depth test exactly where a hull is.
  material.depthWrite = false;

  const mesh = new THREE.Mesh(geo, material);
  mesh.receiveShadow = true;
  // Ahead of the asphalt's own skirt, which sits at -1. Everything else translucent in this game is
  // *on* the road; the water is two units under it and must never sort in front of a mark up there.
  mesh.renderOrder = -2;
  mesh.name = 'river-water';
  return mesh;
}

/** The stretches of [from, to] left over once every gap has been cut out of it. */
function runsBetween(from, to, gaps) {
  const sorted = [...gaps].sort((a, b) => a[0] - b[0]);
  const runs = [];
  let at = from;
  for (const [g0, g1] of sorted) {
    if (g0 > at) runs.push([at, g0]);
    at = Math.max(at, g1);
  }
  if (at < to) runs.push([at, to]);
  return runs;
}
