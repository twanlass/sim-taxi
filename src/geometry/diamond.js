import * as THREE from 'three';
import { unlitMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';

// The crystal a fare's clock is drawn as, over the rider and then over the taxi that collects
// them. game/faremarker.js is what gives it a life; this is just the model.
//
// It began as the drop-off pin's head, and for a spell both ends of a trip wore one: teal over the
// junction the taxi was driving to, urgency-coloured over a rider on the kerb. The drop-off has
// since gone back to being a ring on the road and nothing else, because a second crystal reporting
// no state was a silhouette the player had to tell apart from the one that did. So a diamond on the
// board means exactly one thing: a clock is running here — and a ring on the road means exactly one
// other, that the taxi is being driven there. The two share a colour now (that ring wears the clock
// of whoever is in the car) but never a shape.
//
// It stays its own module rather than folding into game/faremarker.js — the shape, its outline and
// its bounce are a vocabulary the next marker should take from here rather than re-derive, and this
// way the model has no idea what a fare is.
//
// **It is a plumbob** — the crystal that hangs over a Sim: a square bipyramid with a short cap and
// a long taper below it, floating point-down over whoever it belongs to. The name is the shape's
// own argument. A plumb bob is a pointed weight on a line, and what it does is *indicate a spot on
// the ground* — which is exactly this marker's job, and exactly what the octahedron it replaces did
// worst. A regular octahedron is symmetric top to bottom, so it has no more claim on the pavement
// under it than on the sky above it, and at a 3/4 camera it reads as a floating lozenge that
// happens to be near a rider. A long lower point has a direction, and it points at the person.
//
// It borrows a shape players already know, which is worth something on its own for a marker whose
// whole job is "this one, here". Nothing about what it *says* is borrowed: the hue is the fare's
// clock, not the Sims' mood, and it never goes green-to-red for the same reason.
//
// **A vertex faces the camera, not an edge.** The equator is turned 45° so the near corner runs a
// ridge straight down the silhouette, splitting the front into two facets the sun lights
// differently. Edge-on instead — which is what the octahedron did, since its vertices sat on the
// axes and `VIEW_DIR` looks down the diagonal — gives a flat hexagon and a shape with no spine. The
// camera never rotates (see game/camera.js), so this is a constant baked into the geometry rather
// than anything maintained per frame.
//
// It is a *vessel*: the clock is the liquid in it, and the level drains. See "the fill" below.
//
// **By default it is an hourglass** (Tyler, 2026-10-18: "what if we made the plumbob an hour
// glass?"), and the plumbob above is `?plumbob=classic` (`PLUMBOB=classic` headless). The plumbob
// was already a draining vessel, so the hourglass is the same clock in the one shape everybody
// already reads as a clock: the hue fills the top bulb on spawn, drains out of it through the neck
// and piles up in the bottom one. Everything else — the hue, the kick, the pulse, the black rim,
// the glass treatment and the meniscus — is shared, and so is every name exported here, which is
// why they still say "diamond". See "the hourglass" below.
//
// **And by default now it is a pie** (Tyler, 2026-10-18: "a circle with some 3d thickness and pie
// slices for segments of urgency"): a thick disc standing face-on to the camera, cut into one
// slice per urgency level. The clock eats it clockwise from twelve o'clock, so each slice that goes
// is one quarter gone — the same moment the hue steps — and the slice being eaten shows where
// inside that quarter the fare is. The hourglass is `?plumbob=hourglass`. See "the pie" below.
const SHAPE_PARAM = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('plumbob')
  : globalThis.process?.env?.PLUMBOB;
/** Which vessel the marker is: 'pie' (default), 'hourglass' or 'plumbob' (`=classic`). */
export const MARKER_SHAPE = SHAPE_PARAM === 'classic' ? 'plumbob' : SHAPE_PARAM === 'hourglass' ? 'hourglass' : 'pie';
export const PLUMBOB_CLASSIC = MARKER_SHAPE === 'plumbob';
const HOURGLASS = MARKER_SHAPE === 'hourglass';
const PIE = MARKER_SHAPE === 'pie';

// Half-width at the equator, and the two pyramid heights that meet there. The equator sits two
// thirds of the way up, which is what makes the silhouette a plumbob rather than a stretched
// octahedron: a stubby cap over a point long enough to aim.
//
// 2.8 × 4.5 world units — at play zoom (1 unit ≈ 7.7px) about 22px wide, and 29px tall on screen
// once the camera's 33° elevation foreshortens the height by 0.84. The octahedron before it was
// 3.8 units across and read 29 × 24px, so this is the same amount of marker stood up on its end.
const PLUMB_W = 1.4;
const PLUMB_TOP = 1.5;
const PLUMB_BOT = 3.0;

// The origin is the *middle* of the plumbob rather than its equator — see DIAMOND_HALF_H.
const PLUMB_HALF_H = (PLUMB_TOP + PLUMB_BOT) / 2;

// --- The hourglass ------------------------------------------------------------------------------
//
// A lathe of six sides with a corner turned down the camera's diagonal, for the plumbob's reason:
// a ridge down the middle of the silhouette and two flanks the sun lights differently. Six rather
// than the plumbob's four because a square hourglass reads as two plumbob tips kissing, and round
// is what says "glass".
//
// The profile, as [radius, y] from the neck up; the bottom half is its mirror. The bulb is widest a
// third of the way up rather than at the plates, so each half reads as a bulb and not a funnel, and
// the neck is narrow enough to pinch but wide enough (2 × 0.16 ≈ 2.5px at play zoom) that the rim
// doesn't close over it. The plates overhang the glass by a quarter of a unit, which is the part
// of the silhouette that turns "two cones" into "an hourglass" at 22px.
//
// 2.6 units across the plates and 4.3 tall: about the plumbob's 2.8 × 4.5, so it costs the board
// the same room.
//
// The plates are only a little wider than the bulbs because the camera looks *down* on them. The
// first build had 1.45-unit plates, and at 33° the top plate's lid projected as a brown hexagon
// covering most of the top bulb — which is where a fresh fare's sand is.
const NECK_R = 0.16;
const GLASS_H = 1.9;               // neck to plate, each half
const PLATE_R = 1.32;
const PLATE_T = 0.26;
const GLASS_PROFILE = [[NECK_R, 0], [0.82, 0.62], [1.2, 1.3], [1.0, GLASS_H]];
const HOURGLASS_HALF_H = GLASS_H + PLATE_T;
const HOURGLASS_SIDES = 6;

// **Tipped 20° toward the camera**, about the horizontal axis across the view. Stood upright, the
// 33° view looks down into it: the lid is the biggest face on screen and the top bulb's sand hides
// under it. Tipped, the glass is seen nearly side-on, like the icon it is, while a sliver of the
// lid still shows that it is a solid thing. Baked into the geometry so the marker's own transform
// stays what game/faremarker.js animates; the fill reads the *untipped* height (the `fillY`
// attribute), so the sand still divides the bulbs where the profile says.
export const HOURGLASS_TILT = new THREE.Quaternion().setFromAxisAngle(
  // The sign is easy to get backwards and was, once: (−1, 0, 1) is the axis that swings +Y toward
  // the camera at +X+Z. The other one tips the lid *up* to the camera and doubles the problem.
  new THREE.Vector3(-1, 0, 1).normalize(), THREE.MathUtils.degToRad(20),
);

/** Every ring of the lathe, bottom to top, as [radius, y]; a radius of 0 closes the end. */
function hourglassProfile() {
  const top = [...GLASS_PROFILE, [PLATE_R, GLASS_H], [PLATE_R, HOURGLASS_HALF_H], [0, HOURGLASS_HALF_H]];
  const bottom = top.slice(1).reverse().map(([r, y]) => [r, -y]);
  return [...bottom, ...top];
}


/**
 * The profile pushed out by `offset` along its own outward normal, for the outline hull.
 *
 * Not a scale. The plumbob's hull is the body scaled per axis, which works because that shape is
 * convex; an hourglass is not, and a scale about the origin moves the neck out by its own tiny
 * radius times the factor — about a hundredth of a unit, so the rim pinched to nothing exactly at
 * the waist. Offsetting the profile puts the same weight everywhere. The radial half is divided
 * by cos(30°) because a ring's radius is to its corners and the facets sit at the apothem.
 */
function offsetProfile(profile, offset) {
  const apothem = Math.cos(Math.PI / HOURGLASS_SIDES);
  const edgeNormal = (a, b) => {
    // Outward for a profile that runs bottom to top on the right of the axis: (dy, -dr).
    const dr = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dr, dy);
    return [dy / len, -dr / len];
  };
  return profile.map(([r, y], i) => {
    if (r === 0) return [0, y + Math.sign(y) * offset];
    // The glass's corner tucked under a plate is concave, and a mitre there drops the hull's
    // underside a rim's width *into the bulb* — where, seen from above through the glass, it drew
    // as a black line across a full top bulb. Pushed straight out instead, it stays hidden under the
    // plate it belongs to.
    if (Math.abs(y) === GLASS_H && r < PLATE_R) return [r + offset / apothem, y];
    const n0 = edgeNormal(profile[i - 1], profile[i]);
    const n1 = edgeNormal(profile[i], profile[i + 1]);
    // Mitred: the bisector, lengthened so both neighbouring edges move by exactly `offset`.
    const bx = n0[0] + n1[0];
    const by = n0[1] + n1[1];
    const len = Math.hypot(bx, by);
    const miter = offset / ((bx / len) * n0[0] + (by / len) * n0[1]);
    return [r + ((bx / len) * miter) / apothem, y + (by / len) * miter];
  });
}

/**
 * Revolve a profile into a flat-shaded solid of `HOURGLASS_SIDES` facets.
 *
 * Non-indexed, wound counter-clockwise from outside, and asserted from the winding in
 * tools/probe.mjs for the plumbob's reasons (see `plumbobGeometry`).
 */
function latheGeometry(profile) {
  // A corner at 45°, down the camera's diagonal.
  const ring = Array.from({ length: HOURGLASS_SIDES }, (_, i) => {
    const a = Math.PI / 4 + (i * 2 * Math.PI) / HOURGLASS_SIDES;
    return [Math.cos(a), Math.sin(a)];
  });
  const pos = [];
  const vertex = (r, y, [cx, cz]) => pos.push(r * cx, y, r * cz);
  for (let k = 0; k + 1 < profile.length; k++) {
    const [r0, y0] = profile[k];
    const [r1, y1] = profile[k + 1];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      // Ring order runs clockwise seen from above, so b before a turns the face outwards.
      if (r0 > 0) { vertex(r0, y0, b); vertex(r0, y0, a); vertex(r1, y1, a); }
      if (r1 > 0) { vertex(r0, y0, b); vertex(r1, y1, a); vertex(r1, y1, b); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('fillY', new THREE.Float32BufferAttribute(pos.filter((_, i) => i % 3 === 1), 1));
  geo.applyQuaternion(HOURGLASS_TILT);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Whether a point in the *untipped* frame is inside the hourglass — for the probe, which checks every facet's winding
 * by stepping off it both ways. The plumbob's test (a normal points away from the origin) needs a
 * convex shape, and the waist is not.
 */
export function insideHourglass(x, y, z) {
  const profile = hourglassProfile();
  const ay = Math.abs(y);
  if (ay > HOURGLASS_HALF_H) return false;
  // The radius of the ring through this height, to its corners.
  const top = profile.slice(Math.floor(profile.length / 2));
  let radius = PLATE_R;
  for (let k = 0; k + 1 < top.length; k++) {
    const [r0, y0] = top[k];
    const [r1, y1] = top[k + 1];
    if (y1 > y0 && ay >= y0 && ay <= y1) {
      radius = THREE.MathUtils.lerp(r0, r1, (ay - y0) / (y1 - y0));
      break;
    }
  }
  // Inside a regular polygon with that circumradius: within the apothem along every facet normal.
  const apothem = radius * Math.cos(Math.PI / HOURGLASS_SIDES);
  for (let i = 0; i < HOURGLASS_SIDES; i++) {
    const a = Math.PI / 4 + ((i + 0.5) * 2 * Math.PI) / HOURGLASS_SIDES;
    if (x * Math.cos(a) + z * Math.sin(a) > apothem) return false;
  }
  return true;
}

// --- The pie --------------------------------------------------------------------------------------
//
// A disc 2.4 across and 0.55 thick, cut into eight slices, two per urgency level, the whole pie in
// the one colour of the level the fare is at — it steps when the clock crosses into the next tier,
// with the kick, like every other shape here. (A build that painted each slice its own level's
// colour showed all four colours on a fresh rider, and was turned down: Tyler, 2026-10-18, "keep it
// a single color until it reaches the next tier".) Every slice is the same shade ("keep slices the
// same color shade family") and solid, so the eight are a step of the clock rather than something
// drawn: two to a tier, which is where the colour steps. The clock takes a whole slice at a time,
// so the cut always lands on a slice's own wall and a drained pie shows a solid face where the
// missing slices were (Tyler, 2026-10-18: "solid, no opacity. Bring back the internal walls so it
// looks 3d in its drained states").
//
// Built in its own frame — the face in XY looking down +Z, twelve o'clock at +Y — and then turned
// (`PIE_TURN`) to face the camera and **tilted back** past face-on, so the face reads as a disc in
// perspective and the near edge shows its thickness. Face-on exactly it is a flat badge.
//
// 2.4 across is ~18px at play zoom, smaller than the plumbob's 22px: the 3.1 first build was called
// too big.
const PIE_R = 1.2;
const PIE_T = 0.55;
export const PIE_SLICES = 8;
const PIE_ARC_STEPS = 4;
// The pie's outline is lighter than the other shapes' RIM_OFFSET: 0.14 (~1.1px at play zoom). At
// the full 0.22 the hull's drum, thickened by the disc's own tilted edge, came out as a black ring
// a fifth of the marker's width and was the loudest thing on it.
export const PIE_RIM = 0.14;

/**
 * Extra air between a rider's head and the bottom of the marker, on top of game/faremarker.js's
 * `LIFT`. The pie is a third the height of the plumbob, so it ends up hanging lower over the head
 * than the taller shapes' centres do, and it read as sitting on the rider's hair. 0.8 is ~6px at
 * play zoom.
 */
export const MARKER_CLEARANCE = PIE ? 0.8 : 0;
// The camera looks down at 33°, so a face-on disc's normal is raised 33°; 60° tips the top a
// further 27° away, which keeps the face 0.89 of its height and shows 0.25 of edge below it.
export const PIE_TURN = new THREE.Quaternion()
  .setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4)
  // About the screen's right, (1, 0, -1): a negative angle swings the face's normal upward.
  .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, -1).normalize(), THREE.MathUtils.degToRad(-60)));

/** Faces per slice, for the probe's winding check: two caps, the arc wall and two radial walls. */
export const PIE_FACES_PER_WEDGE = PIE_ARC_STEPS * 4 + 4;
const PIE_WALL_FACES = 4;

/** Which slice a face of the pie belongs to: every slice's walls first, then every slice's caps. */
export function pieWedgeOf(face) {
  const walls = PIE_SLICES * PIE_WALL_FACES;
  return face < walls
    ? Math.floor(face / PIE_WALL_FACES)
    : Math.floor((face - walls) / (PIE_FACES_PER_WEDGE - PIE_WALL_FACES));
}

/**
 * The slices, as non-indexed triangles wound outward, with a `fillXY` attribute carrying each
 * vertex's position on the face before the turn — the shader cuts and colours by its angle. The
 * slices touch, so their radial walls are hidden inside the disc until the one beside them has
 * been eaten. A wall's `fillXY` is its own slice's middle rather than its position: the wall lies
 * exactly on the cut, where the angle alone cannot say which side it belongs to. `pieWall` marks
 * the walls so the shader can drop an eaten slice's, which would otherwise draw spokes in the glass.
 *
 * Every wall comes **before** every cap. The disc is one mesh drawn in buffer order with depth
 * written, and the wall a drained pie is meant to show sits behind the eaten slice's glass face —
 * drawn after it, the wall failed the depth test against glass at 0.15 alpha and the cut drew flat.
 * Drawn first, the glass blends over it.
 */
function pieGeometry() {
  const pos = [];
  const push = (...v) => { for (const p of v) pos.push(p[0], p[1], p[2]); };
  const xy = [];
  const wall = [];
  const z = PIE_T / 2;
  // Clockwise from twelve: angle measured from +Y toward +X.
  const at = (a, r, zz) => [Math.sin(a) * r, Math.cos(a) * r, zz];
  const span = (w) => [(w / PIE_SLICES) * 2 * Math.PI, ((w + 1) / PIE_SLICES) * 2 * Math.PI];
  for (let w = 0; w < PIE_SLICES; w++) {
    const [a0, a1] = span(w);
    // The two radial walls, at a0 and a1, carrying the slice's middle as their fillXY.
    push(at(0, 0, z), at(a0, PIE_R, z), at(a0, PIE_R, -z));
    push(at(0, 0, z), at(a0, PIE_R, -z), at(0, 0, -z));
    push(at(0, 0, z), at(a1, PIE_R, -z), at(a1, PIE_R, z));
    push(at(0, 0, z), at(0, 0, -z), at(a1, PIE_R, -z));
    const mid = at((a0 + a1) / 2, PIE_R / 2, 0);
    for (let k = 0; k < PIE_WALL_FACES * 3; k++) { xy.push(mid[0], mid[1]); wall.push(1); }
  }
  for (let w = 0; w < PIE_SLICES; w++) {
    const [a0, a1] = span(w);
    for (let k = 0; k < PIE_ARC_STEPS; k++) {
      const p = a0 + ((a1 - a0) * k) / PIE_ARC_STEPS;
      const q = a0 + ((a1 - a0) * (k + 1)) / PIE_ARC_STEPS;
      // Front (+Z): the arc runs clockwise seen from the front, so q before p turns it outward.
      push(at(0, 0, z), at(q, PIE_R, z), at(p, PIE_R, z));
      push(at(0, 0, -z), at(p, PIE_R, -z), at(q, PIE_R, -z));
      // The arc wall.
      push(at(p, PIE_R, z), at(q, PIE_R, z), at(q, PIE_R, -z));
      push(at(p, PIE_R, z), at(q, PIE_R, -z), at(p, PIE_R, -z));
    }
  }
  // The caps and the arc wall carry their own position.
  while (xy.length / 2 < pos.length / 3) {
    const v = xy.length / 2;
    xy.push(pos[v * 3], pos[v * 3 + 1]);
    wall.push(0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('fillXY', new THREE.Float32BufferAttribute(xy, 2));
  geo.setAttribute('pieWall', new THREE.Float32BufferAttribute(wall, 1));
  geo.applyQuaternion(PIE_TURN);
  geo.computeVertexNormals();
  return geo;
}

/** The pie's outline hull: one solid drum a rim's weight bigger all round. */
function pieHullGeometry(offset) {
  const sides = 32;
  const geo = new THREE.CylinderGeometry(
    (PIE_R + offset) / Math.cos(Math.PI / sides),
    (PIE_R + offset) / Math.cos(Math.PI / sides),
    PIE_T + 2 * offset, sides,
  );
  geo.rotateX(Math.PI / 2);
  geo.applyQuaternion(PIE_TURN);
  return geo;
}

/**
 * Half the vessel's height, and so how far its bottom hangs below the marker's origin.
 *
 * The origin is the *middle* of the shape, which matters twice: the plumbob's outline hull is a
 * scale about the origin and would otherwise grow a spike on whichever end is longer, and `LIFT` in
 * game/faremarker.js measures a rider's headroom from this number.
 */
export const DIAMOND_HALF_H = PLUMBOB_CLASSIC ? PLUMB_HALF_H : tippedHalfHeight();

/** How far the turned pie or the tipped hourglass reaches above and below its origin. */
function tippedHalfHeight() {
  const geo = PIE ? pieGeometry() : latheGeometry(hourglassProfile());
  geo.computeBoundingBox();
  return geo.boundingBox.max.y;
}

const TOP_Y = PLUMB_HALF_H;
const BOT_Y = -PLUMB_HALF_H;
const EQUATOR_Y = TOP_Y - PLUMB_TOP;

/**
 * A square bipyramid: four facets up to the top point, four down to the bottom one.
 *
 * Non-indexed and wound counter-clockwise seen from outside. Both halves of that matter — the
 * material is `flatShading`, which takes its normal from a screen-space derivative and so from the
 * *rendered* winding, and the outline hull draws this same geometry back-faces-only. A reversed
 * triangle would light as if the sun were behind it and punch a hole in the rim. `tools/probe.mjs`
 * checks the sign of every face normal computed from the winding, rather than trusting
 * `computeVertexNormals`, which launders a flipped triangle into whatever its neighbours say.
 */
function plumbobGeometry(w, topY, equatorY, botY) {
  // Turned 45°, so a corner rather than a face points down the camera's diagonal — see the header.
  const k = w / Math.SQRT2;
  const ring = [[k, k], [-k, k], [-k, -k], [k, -k]];

  const pos = [];
  const vertex = (x, y, z) => pos.push(x, y, z);
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    // Up: b then a, so the winding runs anticlockwise from outside. Taking them in ring order
    // instead points the normal back into the crystal.
    vertex(bx, equatorY, bz); vertex(ax, equatorY, az); vertex(0, topY, 0);
    // Down: the same pair the other way round, for the same reason.
    vertex(ax, equatorY, az); vertex(bx, equatorY, bz); vertex(0, botY, 0);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

// The stream's column: a unit-tall square prism hanging from y = 0, so its scale.y is its length.
// 0.2 across is ~1.5px at play zoom, which is the thinnest thing that survives the glass over it.
// A box rather than a lathe of its own, turned 45° so a corner faces the camera like everything
// else here.
const STREAM_W = 0.2;
const STREAM_GEO = new THREE.BoxGeometry(STREAM_W, 1, STREAM_W).translate(0, -0.5, 0).rotateY(Math.PI / 4);
// How close to either end of the clock the stream switches off: the pour is a running clock's, and
// a full top bulb on spawn has not started yet.
const STREAM_FROM = 0.01;

// One geometry for every crystal on the board — the shape never varies, only its colour and where
// it floats. The outline hulls share it too; they differ from the surface they wrap only by scale.
const GEO = PLUMBOB_CLASSIC ? plumbobGeometry(PLUMB_W, TOP_Y, EQUATOR_Y, BOT_Y)
  : PIE ? pieGeometry()
    : latheGeometry(hourglassProfile());

// The outline's thickness, in **world units** rather than as a scale factor: at play zoom (1 world
// unit ≈ 7.7px) 0.22 is about 1.7px of rim, which is the weight the marker pins carried back when
// they had posts.
//
// A scalar multiplier is what this used to be, and on a regular octahedron the two are the same
// thing. On a shape three times longer below the equator than it is wide, they are not: one factor
// pushes the bottom point out by three times what it gives the flanks, which reads as a black
// needle hanging off the tip. The rim is a *weight*, so the number that stays fixed has to be the
// distance — hence a per-axis scale below, chosen so every extreme of the crystal moves out by the
// same amount.
//
// **One weight, for every state the marker is in.** It used to double as the "the taxi has been
// sent at this rider" mark, re-weighted to ≈5px while a fare was directed and dropped back on
// pickup — so the same crystal wore two different outlines on its way across the board. The heavy
// one read as a thick black border rather than as a rim, and the difference registered as the
// marker changing shape mid-trip rather than as a state. The route band already says which rider
// the car is on its way to, and it says it along the whole road rather than on one corner.
export const RIM_OFFSET = 0.22;

// Equal offsets at the tips and at the flanks — see RIM_OFFSET. The mid-facet rim comes out
// slightly thinner than at the corners, which is true of any inverted hull and was true of the
// octahedron's too.
//
// The hourglass takes none of this: its hull is its own geometry, the profile pushed out by
// RIM_OFFSET (see `offsetProfile`), at a scale of 1.
export const RIM_SCALE = PLUMBOB_CLASSIC
  ? new THREE.Vector3(1 + RIM_OFFSET / PLUMB_W, 1 + RIM_OFFSET / PLUMB_HALF_H, 1 + RIM_OFFSET / PLUMB_W)
  : new THREE.Vector3(1, 1, 1);

const RIM_GEO = PLUMBOB_CLASSIC ? GEO
  : PIE ? pieHullGeometry(PIE_RIM)
    : latheGeometry(offsetProfile(hourglassProfile(), RIM_OFFSET));

const BLACK = 0x000000;

// The fixed camera sees the face turned *away* from the sun, and pure Lambert on its own shades
// that face a long way down. The emissive lift keeps the crystal reading as its own hue rather
// than as a dark facet.
export const EMISSIVE = 0.35;

// Where that lift goes at the peak of a select pop (game/selectpop.js) — three times the resting
// value, which lands the crystal at the saturated end of its own hue rather than washing it out to
// white. Emissive rather than a colour swap for exactly that reason: the hue is the clock, and a
// tap may not appear to answer a question about the clock. Turning the light up under the same
// colour is the one thing that reads as "you touched this" and nothing else.
//
// It clips, deliberately: at the peak the emissive term alone is at or past 1 in the hue's strongest
// channel, so the crystal goes to a flat saturated red/orange/green for a couple of frames and comes
// back. That is the flash. Captured against a rest frame it is the clearest half of the whole
// gesture — a crystal that is plainly *lit* rather than merely a little larger — and unlike the
// rider's figure (see geometry/person.js) it has room to take it: the hue saturates rather than
// washing out, because the emissive colour is the hue itself and not white.
export const HIGHLIGHT_EMISSIVE = 1.05;

// --- The fill -----------------------------------------------------------------------------------
//
// The crystal is drawn as a glass vessel with the fare's clock *inside* it. Below the surface line
// the urgency colour is the liquid — opaque, saturated and self-lit, exactly what the whole diamond
// used to be. Above it the same hue is emptied glass: the city visible straight through it at just
// under half alpha, most of the emissive lift gone, and a sheen on the facets turned edge-on. A
// bright band rides the line between them, which is the part the eye actually reads.
//
// **This is the continuous clock coming back.** The colour still steps in quarters — that is the
// alarm, and it kicks — but between two steps the level now moves every frame, so a fare can be
// read at 40% again rather than at "orange". That precision was the measured cost of retiring the
// timer ring (see docs/gameplay.md, "It used to be a relay"); it returns here without bringing back
// a second object to learn, because it is drawn on the shape that was already carrying the deadline.
//
// One mesh with a per-fragment alpha, not a glass shell around an inner solid: same silhouette, one
// draw call, and the bounce, the kick and the pulse keep animating a single object.
//
// The empty half was opaque at first — the hue at half lightness — and it read as a *dark solid*
// rather than as an empty vessel, which is the whole point of the thing. What stood in the way of
// real transparency is the black inverted hull: it is a larger copy of the crystal drawn
// back-faces-only, so its far faces cover the entire silhouette, and glass over it would show a
// black void rather than the city. The fix is draw order rather than a different outline —
//
//   the crystal draws first (renderOrder 8) and **writes depth**, blending over the finished
//   opaque scene, then the hull draws (9) with the depth test on. Inside the silhouette its back
//   faces are behind the glass and fail the test; the ring between the two silhouettes has nothing
//   in front of it and passes. That ring is exactly the rim.
//
// Both are flagged `transparent` only to land in the same queue, which is the one place renderOrder
// decides anything. They stay well clear of the ghost outlines at 9990+, which run dead last and
// already treated this marker as an occluder back when it was opaque.

// Half-width of the surface band, in local units, so the band itself is twice this — 0.40 units,
// about 3.1px at play zoom against the rim's 1.7. `MENISCUS_CORE` is the fraction of it held at
// full brightness before the falloff starts: a pure smoothstep from the centre out has no crisp
// part at all at this size and the line read as a smudge rather than as a surface.
//
// It was 0.16 (2.5px) and the band is the thing the eye actually lands on, so the extra half-pixel
// buys more legibility than anything else here does — but it is not free, and the price is paid at
// the *ends* of the clock rather than in the middle, because the overshoot below is one band at
// each tip. See FILL_BOTTOM. Past about 0.22 the band starts reading as a stripe across the
// crystal rather than as a surface in it, and the overshoot eats a fifth of the travel.
//
// Which is why the second pass at legibility spent the **core** rather than the width: 0.4 → 0.65
// hands two thirds of the band to the flat part and leaves a third to feather, so the line arrives
// as an edge with a soft shoulder instead of a gradient with a bright middle. At three pixels that
// is the difference between a waterline and a smudge, and unlike the width it costs nothing at the
// ends of the clock.
const MENISCUS = 0.2;
const MENISCUS_CORE = 0.65;

// Where the surface sits at a given fraction, in the geometry's own local Y. Linear in *height*,
// not in volume: the player reads the line's position, and equal time has to be equal travel.
// Volume would be the physical answer and it is much worse here — the crystal is widest a third of
// the way down from its top, so a volume-true drain would spend most of the clock in a narrow band
// up there and then fall through the whole taper in the last few seconds. On the plumbob that
// mistake is worse than it was on the octahedron, which at least drained symmetrically.
//
// The overshoot is exactly one band past each tip, so no part of the meniscus still touches the
// geometry at either extreme. A fresh fare is a solid crystal (what the marker looked like before
// any of this) and a dead one is an empty vessel, with no stray highlight parked on a vertex. It
// costs about 8% of the range at each end, which no clock is read at.
const FILL_BOTTOM = BOT_Y - MENISCUS;
const FILL_TOP = TOP_Y + MENISCUS;

// The hourglass splits the same idea in two. The top bulb's sand sits on the neck and its surface
// falls from the plate to the neck as the clock runs; the bottom bulb's rises from its plate to the
// neck over the same span. Both linear in height, for the plumbob's reason above, and both
// overshooting by a band at either end so a fresh fare has a full top and a spotless bottom. The
// fragment picks whichever of the two levels belongs to the half it is in.
//
// The bottom pile stops a band short of the neck rather than running up to it: at zero the top is
// empty and the bottom is full to the waist, and a meniscus parked on the neck would light the
// pinch as a bright bead in the one place the silhouette is thinnest.
// The pie's sweep line, half-width in local units: narrower than the hourglass's surface band
// because it runs across a face 3 units wide rather than along a rim, and at 0.2 it read as a
// spoke of its own rather than as the edge of what is left.
const PIE_SWEEP = 0.12;

const SAND_TOP = [-MENISCUS, GLASS_H + MENISCUS];
const SAND_BOTTOM = [-GLASS_H - MENISCUS, -MENISCUS];

// How much of the empty half survives the blend. This is what makes it read as *empty* rather than
// as a second colour: at under a third, more than two thirds of every pixel up there is the city
// behind the marker, so the vessel thins out over whatever it is floating in front of instead of
// sitting on it.
//
// **This number is the level's contrast, and it is the only part of it that does not depend on the
// backdrop.** Everything else here separates the two halves by *value* or by *tint*, and either can
// be swallowed whole by what the marker happens to be floating over. Alpha cannot: whatever is
// behind the crystal is by definition not the liquid's colour, so lowering it always widens the
// gap, in whichever direction the backdrop happens to lie.
//
// It has been cut twice. At 0.45 an amber crystal in front of a tan roof read as one solid amber
// shape at play zoom; 0.28 fixed the tan roof and was still called too subtle on a phone, which is
// what took it to 0.15. That is low enough that the empty half is **mostly the city** — what holds
// the silhouette up there is the black rim and the emissive below, not the glass itself, which is
// the whole intent: a fare's level should read as *how much of the diamond is solid colour*, the
// crudest and fastest comparison a shape this size can offer.
const GLASS_ALPHA = 0.15;
// The pie's eaten slices: black at this alpha rather than pale glass of the hue (Tyler, 2026-10-18:
// "give the bg a black tint (15% opacity) instead of the main color to help with contrast"). The
// pale glass disappeared into the road at play zoom, so a half-eaten pie read as a semicircle; a
// dark tint keeps the whole disc's shape and makes the hue that is left stand off it. 15% was
// still faint on light pavement; 45% and up read as a hole. Tyler picked 30 from a 15/30/45/60 sweep.
const PIE_EATEN_ALPHA = 0.3;

// Emptied glass, as a transform of the fare's own hue rather than a colour of its own: much less of
// it, and — now — mostly drained of its hue as well.
//
// **The saturation is where this stopped being a transparency trick and became a colour one.** The
// long-standing rule was that the alarm hue has to carry across the whole silhouette, and it was
// written after an early *opaque* build at `s × 0.55` came out a dusty rose: the most urgent state
// on the scale rendering as the least red thing on the board. That measurement was sound and the
// conclusion drawn from it no longer is, because it was taken at three times this alpha. At 0.15
// the empty half has almost no ink in it to be rose-coloured with — so what a saturation cut buys
// is not a second hue but a clean *segmentation*: the crystal splits into a saturated part and a
// glassy grey part, which is a categorical difference the eye makes at a glance, where a value
// difference has to be judged. Value comparisons are what kept failing at 22px.
//
// The alarm still carries. It carries on the liquid, which is the dominant mass for three quarters
// of every clock, on the disc on the kerb under the rider, and on the route band — all three at
// full hue. What it no longer has to do is carry on the part of the marker whose entire job is to
// look empty.
//
// The lightness is the smaller half of the same argument: what alpha lets through is the city, and
// what it holds back is this, so keeping it under the liquid gives the level a direction as well as
// a gap. 0.6 → 0.42 → 0.38 across the two passes.
const GLASS_SAT = 0.3;
const GLASS_LIGHT = 0.38;

// How much of the emissive lift the empty half keeps, before alpha takes its share — so the light
// actually reaching the frame is nearer 0.8 × 0.15 ≈ 0.12 of the liquid's. Not zero: at midnight
// the sun is under 0.05 and the emissive is nearly all of what the marker is, so a vessel at 0
// would leave a bright puddle floating in the dark with no shape around it.
//
// It moves **against** GLASS_ALPHA rather than with it, and that is the correction, not an
// inconsistency. What reaches the frame is the product of the two, and the product is what has to
// stay put: alpha does the separating by day, when there is a lit city behind the glass to be
// separated against, and after dark there is no city — the black rim is invisible on a black road
// and the emissive is the only thing drawing the empty half at all. So each cut to the alpha has to
// be paid back here or the night marker loses its top half entirely, which is a worse bug than the
// one this whole change is fixing. 0.6 at α 0.45, 0.45 at α 0.28, 0.8 at α 0.15 — all three land
// within a couple of hundredths of the same 0.12.
const GLASS_EMISSIVE = 0.8;

// The glass sheen: facets at a grazing angle to the camera catch the surface colour. Flat shading
// makes this constant per face, so it lands as a couple of clean steps rather than a gradient — a
// hard-edged highlight is what says "glass" in a faceted city.
//
// The exponent matters more than the strength. At 2.5 it is not a highlight but a wash: at this
// camera angle very little of the crystal is truly head-on, so every visible facet picked up most
// of the lift and the vessel went pale all over. At 5 it stays on the one or two facets actually
// turned edge-on, which is where a highlight on glass belongs — and on the plumbob those are the
// two flanks either side of the front ridge, which is a better place for it than the octahedron's
// wandering pair.
const SHEEN = 0.3;
const SHEEN_POWER = 5;

// The liquid's surface, in the same terms: the hue at a third saturation, nearly all the way to
// white. It is the brightest thing on the marker and it is meant to be — the band *is* the reading,
// and the two halves either side of it are only the context that tells you which way up it is.
const SURFACE_SAT = 0.35;
const SURFACE_WHITE = 0.9;

const hsl = { h: 0, s: 0, l: 0 };

/** The emptied-glass colour for a fare's hue. */
function glassOf(target, source) {
  source.getHSL(hsl);
  return target.setHSL(hsl.h, hsl.s * GLASS_SAT, hsl.l * GLASS_LIGHT);
}

/** The liquid-surface colour for a fare's hue. */
function surfaceOf(target, source) {
  source.getHSL(hsl);
  return target.setHSL(hsl.h, hsl.s * SURFACE_SAT, THREE.MathUtils.lerp(hsl.l, 1, SURFACE_WHITE));
}

// The plates' own glow, as a fraction of their colour: enough that the frame is still there after
// dark, when the hue's emissive is most of what the marker is, and nowhere near enough to compete
// with it.
const FRAME_EMISSIVE = 0.3;

// Constants are inlined into the shader source rather than passed as uniforms — they never change
// at runtime, and a literal lets the compiler fold them. `toFixed` is not cosmetic: a constant that
// happens to be integral would emit `1`, and GLSL will not take an int where a float belongs.
const glsl = (n) => n.toFixed(4);

/**
 * Split a Lambert material's surface at a height, in the geometry's own local Y.
 *
 * Local rather than world, so the fill is immune to the bounce, the kick and the panic pulse — the
 * liquid rides in the vessel instead of sloshing when the marker hops. Returns the uniform the
 * caller moves.
 *
 * `flipped` is for the far-wall pass. Under `flatShading` three takes the normal from the screen-
 * space derivative of the view position, which follows the triangle's *rendered* winding — so on
 * back faces it comes out pointing into the screen and the wall lights as if the sun were behind
 * it. Three's own `FLIP_SIDED` never reaches this path; it only fixes the interpolated-normal one.
 */
function patchFill(material, flipped = false) {
  const uniforms = {
    uFill: { value: FILL_TOP },
    uGlass: { value: new THREE.Color() },
    uSurface: { value: new THREE.Color() },
  };

  // Without this the patch silently does nothing. Three computes the program cache key from the
  // material's *parameters* — before `onBeforeCompile` has touched the source — so a patched
  // Lambert material collides with every unpatched one that happens to share those parameters, and
  // `acquireProgram` hands back whichever compiled first. This city is full of flat-shaded Lambert,
  // so the diamond drew with a building's program and the fill went missing with nothing logged.
  material.customProgramCacheKey = () => `${MARKER_SHAPE}-fill${flipped ? '-back' : ''}`;
  uniforms.uFillLow = { value: SAND_BOTTOM[0] };

  uniforms.uFrame = { value: new THREE.Color(PALETTE.hourglassFrame) };

  // The plumbob has one level. The hourglass has one per bulb, and its plates are frame rather
  // than vessel: opaque, walnut, and lit by a little of their own colour instead of the hue's.
  const level = PLUMBOB_CLASSIC ? 'uFill' : `(vFillY > 0.0 ? uFill : uFillLow)`;
  const plate = HOURGLASS ? `step(${glsl(GLASS_H - 1e-3)}, abs(vFillY))` : '0.0';
  const split = PIE
    // The pie cuts by angle rather than height: `uFill` is how far round from twelve o'clock the
    // clock has eaten, and `uFillLow` is borrowed as the switch for the sweep line, which only
    // exists while the clock is running. The line is measured *across* the sweep ray rather than
    // in angle, so it is the same width at the rim as near the middle.
    ? `\tfloat pieAngle = atan(vFillXY.x, vFillXY.y);
\tif (pieAngle < 0.0) pieAngle += ${glsl(2 * Math.PI)};
\tfloat below = step(uFill, pieAngle);

\tvec2 sweep = vec2(sin(uFill), cos(uFill));
\tfloat meniscus = uFillLow * step(0.0, dot(vFillXY, sweep))
\t\t* (1.0 - smoothstep(${glsl(PIE_SWEEP * MENISCUS_CORE)}, ${glsl(PIE_SWEEP)}, abs(vFillXY.x * sweep.y - vFillXY.y * sweep.x)));`
    : `\tfloat below = max(step(vFillY, ${level}), plate);
\tfloat meniscus = (1.0 - plate) * (1.0 - smoothstep(${glsl(MENISCUS * MENISCUS_CORE)}, ${glsl(MENISCUS)}, abs(vFillY - ${level})));`;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying float vFillY;\nvarying vec2 vFillXY;\nvarying float vPieWall;${PLUMBOB_CLASSIC ? '' : PIE ? '\nattribute vec2 fillXY;\nattribute float pieWall;' : '\nattribute float fillY;'}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n\tvFillY = ${PLUMBOB_CLASSIC ? 'position.y' : PIE ? 'fillXY.y' : 'fillY'};\n\tvFillXY = ${PIE ? 'fillXY' : 'position.xy'};\n\tvPieWall = ${PIE ? 'pieWall' : '0.0'};`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vFillY;
varying vec2 vFillXY;
varying float vPieWall;
uniform float uFill;
uniform float uFillLow;
uniform vec3 uFrame;
uniform vec3 uGlass;
uniform vec3 uSurface;`)
      // Before the lighting reads `diffuseColor`, so both halves still take the sun and the facets
      // still shade — this paints the vessel, it does not bypass the model.
      .replace('#include <color_fragment>', `#include <color_fragment>
\tfloat plate = ${plate};
${split}
\t// An eaten slice's walls would stand in the glass as spokes.
\tif (vPieWall > 0.5 && below < 0.5) discard;
\tdiffuseColor.rgb = mix(uGlass, diffuseColor.rgb, below);
\t// The liquid and its surface are solid; only the empty glass thins out.
\tdiffuseColor.a = mix(${glsl(GLASS_ALPHA)}, 1.0, max(below, meniscus));`)
      // After `normal_fragment_begin`, which is where `normal` comes from — and still before
      // `lights_lambert_fragment` hands `diffuseColor` to the lighting.
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
${flipped ? '\tnormal = -normal;\n' : ''}\tfloat sheen = (1.0 - below) * pow(1.0 - abs(dot(normal, normalize(vViewPosition))), ${glsl(SHEEN_POWER)});
\tdiffuseColor.rgb = mix(diffuseColor.rgb, uSurface, sheen * ${glsl(SHEEN)});
\t// A highlight is light bouncing off the glass rather than passing through it, so it thickens the
\t// surface where it lands. Without this the sheen dissolves into whatever is behind the marker.
\tdiffuseColor.a = max(diffuseColor.a, sheen);
\tdiffuseColor.rgb = mix(diffuseColor.rgb, uSurface, meniscus);
\ttotalEmissiveRadiance *= mix(${glsl(GLASS_EMISSIVE)}, 1.0, max(below, meniscus));
\tdiffuseColor.rgb = mix(diffuseColor.rgb, uFrame, plate);
\ttotalEmissiveRadiance = mix(totalEmissiveRadiance, uFrame * ${glsl(FRAME_EMISSIVE)}, plate);
${PIE ? `\t// The pie's eaten slices are a flat black tint, not glass of the hue: no sheen, no glow.
\tdiffuseColor = mix(vec4(0.0, 0.0, 0.0, ${glsl(PIE_EATEN_ALPHA)}), diffuseColor, below);
\ttotalEmissiveRadiance *= below;
` : ''}`);
  };

  return uniforms;
}

// The transparent queue, where the crystal and its outline settle their order. Nothing else in the
// game sits between them; the numbers are small because the ground layers (route band 4, target
// discs 3–4) have to draw first, and the ghost outlines at 9990+ have to draw last.
export const DIAMOND_ORDER = 8;
export const DIAMOND_RIM_ORDER = 9;

/**
 * A black outline, drawn as an inverted hull: the same shape a little larger, with only its back
 * faces rendered. The enlarged back faces sit behind the real surface everywhere except around
 * the silhouette, which is exactly where the rim shows.
 *
 * Cheaper than a post-processing edge pass, and it needs no render targets — these are small
 * objects, not a whole-scene effect.
 *
 * Depth-tested but never depth-*writing*, and flagged transparent so it lands in the same queue as
 * the crystal it wraps. That is what lets the glass be see-through: the crystal draws first and
 * stamps depth, so every hull fragment inside the silhouette fails the test and only the ring
 * around the outside survives. Drawn the other way round, the hull's far faces are what you would
 * see through the empty half of the vessel, and the marker reads as a black void.
 *
 * `scale` is a Vector3 rather than a number: an even rim on a shape that is not the same size in
 * every direction needs a different factor per axis. See RIM_OFFSET.
 */
export function outlineHull(geometry, scale) {
  const mesh = new THREE.Mesh(
    geometry,
    unlitMaterial({
      color: BLACK,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
    }),
  );
  mesh.renderOrder = DIAMOND_RIM_ORDER;
  mesh.scale.copy(scale);
  return mesh;
}

/**
 * One diamond: the crystal and the outline that wraps it.
 *
 * The hull is a *child* of the mesh, so it inherits any animation — the bounce below, or a group
 * the caller moves — for free.
 */
export function createDiamond(colorHex) {
  const color = new THREE.Color(colorHex);
  const mesh = new THREE.Mesh(GEO, new THREE.MeshLambertMaterial({
    color: color.clone(),
    emissive: color.clone(),
    emissiveIntensity: EMISSIVE,
    flatShading: true,
    // The one **lit** thing in the game that still refuses the haze (`game/scene.js`), and it is
    // the same exception the emissive above is: this crystal's whole content is its hue, because
    // the hue is how much of the fare's clock is left. It already carries a light of its own so a
    // night city can't take that reading away; a marker at the back of the board mixing its urgency
    // colour with the sky would give the same wrong answer by daylight. The rider it floats over is
    // hazed like every other figure on a kerb — a person is scenery, the clock is not.
    fog: false,
    // Per-fragment alpha: solid liquid, thin glass. `depthWrite` stays *on*, against the usual
    // habit for transparent materials — it is what hides the outline hull's far faces inside the
    // silhouette, and see the header for why the alternative is a black void.
    transparent: true,
    depthWrite: true,
  }));
  mesh.renderOrder = DIAMOND_ORDER;
  mesh.castShadow = true;

  // Near wall only. The far one was built and taken out again, and it is worth saying why, because
  // the argument for it is a good one: only the *near* half of the liquid's surface is drawn, and
  // the near half of a horizontal plane projects low, so at half full the level reads closer to a
  // third. Drawing the back faces as a second pass closes that chevron into the rhombus a real
  // meniscus makes, centred on the level the clock actually says.
  //
  // It cost more than it bought. The far wall's liquid is a solid slab filling everything below its
  // own (higher) surface line, so the see-through top — the entire point of the vessel — shrank to
  // the narrow wedge above it, and the two meniscus bands closed into a hard bright rectangle
  // across the middle that read as a label rather than as liquid. More correct, less legible.
  //
  // What is left is a known bias: the surface reads slightly low, by a chevron about 8px deep at
  // play zoom. It is the same shape at every level, so it offsets the reading rather than
  // distorting it, and the chevron's *outer corners* — where it meets the silhouette — sit at the
  // true level anyway. `patchFill`'s `flipped` argument is the useful half of the experiment kept
  // alive, since any back-face pass on this shape needs it.
  const fillUniforms = patchFill(mesh.material);
  let fill = 1;

  /** Restate the current hue as glass and as liquid surface. */
  const shadeVessel = () => {
    glassOf(fillUniforms.uGlass.value, mesh.material.color);
    surfaceOf(fillUniforms.uSurface.value, mesh.material.color);
  };
  shadeVessel();

  const rim = outlineHull(RIM_GEO, RIM_SCALE);
  // The pie goes without one (Tyler, 2026-10-18: "try without the black outline"): solid, tilted
  // and lit, its own edge already separates it from the city. The hull is still built and hidden
  // rather than dropped, so everything that reads `rim` keeps working and the old look is one flag.
  rim.visible = !PIE;
  mesh.add(rim);

  // The falling stream, from the neck to the top of the pile. A thin column of the hue inside the
  // glass: the glass blends over it at GLASS_ALPHA, so it reads as sand seen through the vessel.
  // Hidden whenever there is nothing to pour (a full or an empty top bulb), which is also the
  // VIP's resting state — their clock never drains, so their hourglass never runs.
  const stream = !HOURGLASS ? null : new THREE.Mesh(STREAM_GEO, new THREE.MeshLambertMaterial({
    color: color.clone(),
    emissive: color.clone(),
    emissiveIntensity: EMISSIVE,
    flatShading: true,
    fog: false,
  }));
  if (stream) {
    stream.visible = false;
    stream.quaternion.copy(HOURGLASS_TILT);
    mesh.add(stream);
  }

  return {
    mesh,
    rim,
    /** Colour and emissive move together — they are the same hue at two strengths. */
    setColor(value) {
      mesh.material.color.set(value);
      mesh.material.emissive.set(value);
      stream?.material.color.set(value);
      stream?.material.emissive.set(value);
      // The glass and the surface are the same hue restated, so they follow it to the next level.
      shadeVessel();
    },
    /**
     * Light the crystal up, 0..1 — the colour half of the select pop.
     *
     * `emissiveIntensity` rather than the material's colour: the hue is the clock and nothing else
     * may write it, and this way the highlight cannot outlive a level change or fight `setColor`
     * over the same channel. It rides the fill too, since the shader scales
     * `totalEmissiveRadiance` by how full the vessel is — so an almost-spent crystal flashes on the
     * liquid it has left rather than lighting up the empty glass above it, which is right: the
     * highlight is a tap being acknowledged, not a clock being topped up.
     */
    setHighlight(amount) {
      mesh.material.emissiveIntensity = THREE.MathUtils.lerp(EMISSIVE, HIGHLIGHT_EMISSIVE, amount);
    },
    /**
     * How full the vessel is, 0..1. The fine hand of the clock: the colour says which quarter, this
     * says where inside it.
     */
    setFill(fraction) {
      fill = THREE.MathUtils.clamp(fraction, 0, 1);
      if (PLUMBOB_CLASSIC) {
        fillUniforms.uFill.value = THREE.MathUtils.lerp(FILL_BOTTOM, FILL_TOP, fill);
        return;
      }
      if (PIE) {
        // Eaten clockwise from twelve, a whole slice at a time: a full clock has eaten nothing, and
        // a slice goes the moment its share of the clock has started to run. A cut through the
        // middle of a slice would open it with no wall to show for it.
        const left = Math.ceil(fill * PIE_SLICES - 1e-6) / PIE_SLICES;
        fillUniforms.uFill.value = (1 - left) * 2 * Math.PI;
        // No sweep line on the eight-slice pie: the cut edge and the wall of the next slice already
        // draw it, and a bright line on top ran down the disc's edge and read as a stick.
        fillUniforms.uFillLow.value = 0;
        return;
      }
      fillUniforms.uFill.value = THREE.MathUtils.lerp(SAND_TOP[0], SAND_TOP[1], fill);
      fillUniforms.uFillLow.value = THREE.MathUtils.lerp(SAND_BOTTOM[1], SAND_BOTTOM[0], fill);
      // The column runs from the neck down to the pile; with the pile's surface at y, its height is
      // -y and it hangs from the neck.
      const pile = Math.min(0, fillUniforms.uFillLow.value);
      stream.visible = fill > STREAM_FROM && fill < 1 - STREAM_FROM;
      stream.scale.y = Math.max(1e-3, -pile);
    },
    /** What the vessel is currently showing — for the headless tools, which have no GL to read. */
    getFill: () => fill,
  };
}

// The diamond hops around its rest height. `Math.abs(sin)` rather than a plain sine: it never dips
// below the rest position, and the sharp cusp at the bottom of each cycle reads as a landing
// instead of a float.
export const BOUNCE_HEIGHT = 0.45;
export const BOUNCE_RATE = 3.4;

/** Height above the rest position at time `t` seconds. */
export const bounceOffset = (t) => Math.abs(Math.sin(t * BOUNCE_RATE)) * BOUNCE_HEIGHT;

// A one-shot "something just changed" kick: the diamond swells and hops, then settles.
//
// The colour it snaps to is the news, and a hue change on a 29px shape at the edge of the eye is
// easy to miss entirely — especially the ones that matter, which land while the player is watching
// the road rather than the kerb. Motion is what gets the glance; the colour is what pays it off.
export const KICK_TIME = 0.36;      // long enough to register, short enough not to read as idling
export const KICK_SCALE = 0.1;      // peak swell, so 29px goes to ~32px
export const KICK_HOP = 0.55;       // extra lift at the peak, ~4px on top of the resting bounce

/**
 * Kick envelope for `t` seconds since the change: 0 → 1 → 0 over KICK_TIME, 0 outside it.
 *
 * Asymmetric on purpose — the exponent pushes the peak early, so it snaps up and eases down. A
 * symmetric half-sine swells as slowly as it settles, which reads as a throb rather than a knock.
 */
export function kickEnvelope(t) {
  if (!(t >= 0) || t >= KICK_TIME) return 0;
  return Math.sin(Math.PI * (t / KICK_TIME) ** 0.65);
}
