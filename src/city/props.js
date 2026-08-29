import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, jitterVertices, propMaterial, stampEntry } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { KERB_H, MEDIAN_EDGE, PARK_EDGE, PAVE_INSET, roundedRectShape } from './ground.js';
import { MEDIAN_W, medianRuns } from './grid.js';
import { plusXFaceSeen } from './garage.js';
import { planPond, pondParts } from './pond.js';

/**
 * Park tree — same construction as the terrain prototype's broadleaf, scaled for a city block.
 *
 * Exported because `city/buildings.js` plants the same tree in a courtyard, and a courtyard tree
 * that came out of a second generator would be a different tree: the whole point of it is that the
 * green rising out of a hollow block is the same green as the park two streets over. It takes a
 * height range rather than a scale because the courtyard has a hard floor on it — a tree that
 * doesn't clear the wings around it is a tree nobody ever sees.
 */
export function treeParts(x, z, rng, { low = 3.4, high = 5.6 } = {}) {
  const parts = [];
  const height = rng.range(low, high);
  const trunkH = height * 0.42;

  const trunk = new THREE.CylinderGeometry(height * 0.035, height * 0.055, trunkH, 6);
  trunk.translate(x, KERB_H + trunkH / 2, z);
  parts.push(bakeColor(trunk, jitterColor(PALETTE.trunk, rng, { l: 0.05 })));

  // Canopy: a main blob plus a couple of smaller ones pushed into it. Overlapping solids read as
  // a fuller crown than a single sphere and hide the seams where they meet.
  const r = height * 0.32;
  const base = KERB_H + trunkH + r * 0.75;

  // Per-tree canopy tint, wider than the per-blob jitter below so the variation reads
  // tree-to-tree while the blobs of one crown stay siblings. Hashed from the trunk position
  // rather than drawn, same reason as the entry stamp (util/geo.js hash01): spending a draw
  // here would reshuffle every tree planted after this one.
  const canopy = new THREE.Color(PALETTE.foliage);
  const hsl = { h: 0, s: 0, l: 0 };
  canopy.getHSL(hsl);
  canopy.setHSL(
    (hsl.h + (hash01(x, z) - 0.5) * 0.07 + 1) % 1,
    THREE.MathUtils.clamp(hsl.s + (hash01(z, x) - 0.5) * 0.14, 0, 1),
    THREE.MathUtils.clamp(hsl.l + (hash01(x + z, x - z) - 0.5) * 0.10, 0.05, 0.95),
  );

  const blob = (radius, ox, oy, oz, detail) => {
    const geo = new THREE.IcosahedronGeometry(radius, detail);
    jitterVertices(geo, rng, radius * 0.1);
    geo.scale(1.05, 0.9, 1.05);
    geo.translate(x + ox, base + oy, z + oz);
    parts.push(bakeColor(geo, jitterColor(canopy, rng, { h: 0.02, l: 0.07 })));
  };

  blob(r, 0, 0, 0, 1);
  const lobes = rng.int(1, 2);
  for (let n = 0; n < lobes; n++) {
    const angle = rng.range(0, Math.PI * 2);
    const reach = r * rng.range(0.32, 0.5);   // less than r, so they always intersect the core
    blob(r * rng.range(0.55, 0.72), Math.cos(angle) * reach, rng.range(-0.1, 0.45) * r,
      Math.sin(angle) * reach, 0);
  }

  return parts;
}

// --- Flower beds --------------------------------------------------------------
//
// What grows on an arterial's median. Trees were tried there first and the camera is why they are
// not: it looks down at 33°, so anything of height h hides the ground within 1.54h behind it, and
// what sits behind a median is the far carriageway of the road the player is most likely to be
// driving down. That lane centre is 3.33 across — 4.71 along the view diagonal — which even a
// stunted 2.9-unit tree reaches past. A bed tops out at 0.36 above the island and casts 0.55 of
// occlusion, so the question stops being "how often does this hide a car" and simply goes away.
//
// It also suits the strip better. A median is a planter, not a verge, and a row of bedding is what
// a city puts in one.

/** Bed proportions. Flat and wide: it is read from above, and only ever from above. */
const BED_SQUASH = 0.42;         // dome height as a fraction of its radius
const BLOOM_R = 0.16;
// How far `jitterVertices` can throw a mound's corners past its nominal radius. Placement has to
// budget for it: at 0.62 of radius that is 0.09 of extra reach, which is most of the 0.15 of kerb
// an island leaves showing — a bed placed on its nominal radius alone spills into the road.
const BED_SPREAD = 0.14;
/** How far out on its mound a bloom may sit, and the top of its own size jitter. */
const BLOOM_REACH = 0.82;
const BLOOM_R_MAX = 1.2;

/**
 * One bed: a low foliage mound with blooms sitting in it.
 *
 * **A single flower is not a thing this game can draw.** At play zoom 1 world unit is 7.7px, so a
 * bloom is under two pixels and a stem is nothing at all. What has to read is the *bed* — a
 * 1.0–1.3 unit patch, 8–10px of colour against the median's grass — so the geometry spends itself
 * on a mound wide enough to see and dots the blooms over it, rather than on stems nobody resolves.
 */
export function flowerBedParts(x, z, rng, { radius }) {
  const parts = [];

  // The foliage under the flowers, in the same green the trees wear rather than the grass's own —
  // a mound in `park` would be a bump in the lawn instead of something planted in it.
  //
  // Centred **on** the island's surface rather than above it, so the bottom half is buried and what
  // shows is a dome of height `radius · BED_SQUASH`. Half a sphere of geometry goes to waste and
  // that is the cheaper mistake: a squashed ball resting on the grass has a visible underside seam
  // at this camera angle, and nudging it down by hand is one more number to keep in step with the
  // bloom heights below.
  const mound = new THREE.IcosahedronGeometry(radius, 0);
  jitterVertices(mound, rng, radius * BED_SPREAD);
  mound.scale(1, BED_SQUASH, 1);
  mound.translate(x, KERB_H, z);
  parts.push(bakeColor(mound, jitterColor(PALETTE.foliage, rng, { l: 0.05 })));

  // Blooms sitting *on* that dome. Its surface height falls off as `sqrt(1 - (d/r)²)`, and getting
  // this wrong is invisible in the code and total on screen: the first version placed them at the
  // dome's *centre* height, which is below its own surface everywhere, so every bloom in the city
  // was inside the mound and the beds rendered as plain green lumps.
  //
  // `sqrt` on the radial draw spreads them by *area* — without it a uniform draw crowds them into
  // the middle and leaves the rim, which is the part that gives the bed its size, bare.
  // Densely enough that the blooms, not the mound, are what the bed *is*: 20–30 heads of radius
  // 0.16 over a disc of ~0.55 come to twice the disc's own area, so they pile over each other and
  // the green survives only where the mound shows past them. Sparser reads as a shrub with dots
  // on it, which is what the first pass at half this size and count looked like at play zoom.
  const count = rng.int(20, 30);
  for (let n = 0; n < count; n++) {
    const angle = rng.range(0, Math.PI * 2);
    const reach = radius * Math.sqrt(rng.next()) * BLOOM_REACH;
    const r = BLOOM_R * rng.range(0.85, BLOOM_R_MAX);
    const dome = radius * BED_SQUASH * Math.sqrt(1 - (reach / radius) ** 2);

    // An octahedron, not the icosahedron the mound uses: 8 triangles against 20, and at the three
    // or four pixels a bloom occupies the two are indistinguishable. The city carries ~1,300 of
    // these, so the choice is most of the props mesh: measured at this density, 118ms and 16.4k
    // triangles against 166ms and 31.8k for the icosahedron.
    const head = new THREE.OctahedronGeometry(r, 0);
    head.scale(1, 0.62, 1);
    head.translate(
      x + Math.cos(angle) * reach,
      KERB_H + dome + r * 0.45,
      z + Math.sin(angle) * reach,
    );
    // Drawn per bloom rather than per bed. A bed used to be one species, which is the tidier
    // thing for a city to plant and the duller thing to look at — at this size the whole payload
    // of a flower bed is that it is *many colours at once*, and a monochrome one is a coloured
    // lump. Seven to draw from and twenty draws puts four or five in every bed.
    const bloom = rng.pick(PALETTE.bloom);
    parts.push(bakeColor(head, jitterColor(bloom, rng, { h: 0.015, l: 0.06 })));
  }

  return parts;
}

// Where the grass on an island stops. Derived off the ground mesh's own inset, not copied.
const BED_ROOM = MEDIAN_W / 2 - MEDIAN_EDGE;
const BED_R_LOW = 0.55;
const BED_R_HIGH = 0.80;
// Beds are spaced along the island rather than scattered, for the reason the park benches are: a
// pair of random draws puts them at the same end about as often as it spaces them. A 1.0 pitch
// against beds 1.1–1.6 across means every one of them overlaps its neighbours, which is the point
// — at six on an 8.4-unit island and four on a 7.07 the "bed" stops being a discrete object and
// the island simply reads as planted end to end. Overlapping mounds get that with no second kind
// of geometry, and the wasted interior faces are a one-off merge cost, not a per-frame one.
const BED_PITCH = 1.0;
// Clear of the island's stadium caps, so a bed's own circle is measured against the straight part.
const BED_END_GAP = MEDIAN_W / 2 + 0.1;
/** Where the grass on an island stops — see `BED_ROOM` above. Exported for the probe. */
export const MEDIAN_BED_ROOM = BED_ROOM;

/**
 * Where the beds go on every median in the city.
 *
 * Split out and exported for the same reason `planParkFurniture` is: placement is the part with a
 * rule in it, and `tools/probe.mjs` asserts the rule — no bed may overhang its island's kerb into
 * the carriageway, which is a thing you cannot see in a merged mesh.
 */
export function planMedianBeds(rng, runs) {
  const beds = [];

  for (const run of runs) {
    const usable = (run.to - run.from) - BED_END_GAP * 2;
    if (usable <= 0) continue;

    const count = Math.max(2, Math.round(usable / BED_PITCH));
    const centre = run.axis === 'x' ? (run.z0 + run.z1) / 2 : (run.x0 + run.x1) / 2;

    for (let n = 0; n < count; n++) {
      const radius = rng.range(BED_R_LOW, BED_R_HIGH);
      // What the bed actually occupies — the number placement is bounded by, and the one the probe
      // measures against.
      //
      // Two things can be the outermost, and which one wins changes with the bed's size. The mound
      // reaches `radius · (1 + BED_SPREAD)` once `jitterVertices` has thrown its corners about; the
      // rim blooms reach `0.82 · radius + BLOOM_R`. The mound is wider on a big bed and the blooms
      // are wider on a small one — at the bottom of the range they now stick out 0.016 past it —
      // so taking the mound alone would let a small bed's flowers hang over the kerb, which is the
      // exact thing this bound exists to prevent.
      const footprint = Math.max(
        radius * (1 + BED_SPREAD),
        radius * BLOOM_REACH + BLOOM_R * BLOOM_R_MAX,
      );
      const even = run.from + BED_END_GAP + usable * ((n + 0.5) / count);
      const along = THREE.MathUtils.clamp(even + rng.range(-0.25, 0.25),
        run.from + BED_END_GAP, run.to - BED_END_GAP);
      // A bed narrower than the strip may sit a little off the centreline, which stops a row of
      // them reading as a dotted line painted down the middle. Bounded by its own radius, so the
      // widest bed simply gets no room to wander.
      const across = centre + rng.range(-1, 1) * Math.max(0, BED_ROOM - footprint);

      beds.push(run.axis === 'x'
        ? { x: along, z: across, radius, footprint }
        : { x: across, z: along, radius, footprint });
    }
  }

  return beds;
}

// --- Park furniture ---------------------------------------------------------
//
// A bench, in world units rather than at the figures' scale. The people in this game are a
// deliberate lie — a rider is 3.3 units tall next to a 3.4-unit car, because a person at true
// scale is two pixels at play zoom (geometry/person.js) — but everything they are not is built
// honestly, and a bench sized off a rider would be four units of park furniture as long as a taxi.
// So it is sized off the things around it instead: 1.9 long against a 5-unit tree, and 0.645 deep
// against the 1.0-unit walk it sits beside — see `benchSet` for where on the lawn that puts it.
export const BENCH_LEN = 1.9;
const BENCH_SEAT_Y = 0.44;
const BENCH_BACK_Z = -0.30;
const BENCH_END_X = BENCH_LEN / 2 - 0.09;

/**
 * One bench, built lying along local X with its back at −Z, then turned to `yaw` and set down at
 * `(x, z)` on a surface at `y`. Facing is the whole point of a bench: one turned the wrong way
 * round is a bench looking into a hedge, so callers pass the direction the seat looks in.
 */
function benchParts(x, z, y, yaw, rng) {
  const parts = [];
  const slat = jitterColor(PALETTE.benchSlat, rng, { l: 0.04 });
  const frame = jitterColor(PALETTE.pole, rng, { l: 0.03 });

  const box = (w, h, d, ox, oy, oz, col) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(ox, oy, oz);
    parts.push(bakeColor(geo, col));
  };

  // Two seat slats with daylight between them, and two more in the back. A single solid seat
  // reads as a low wall at any zoom the bench is legible at; the gap is what says "bench".
  box(BENCH_LEN, 0.07, 0.28, 0, BENCH_SEAT_Y, -0.17, slat);
  box(BENCH_LEN, 0.07, 0.28, 0, BENCH_SEAT_Y, 0.17, slat);
  box(BENCH_LEN, 0.20, 0.07, 0, BENCH_SEAT_Y + 0.24, BENCH_BACK_Z, slat);
  box(BENCH_LEN, 0.20, 0.07, 0, BENCH_SEAT_Y + 0.50, BENCH_BACK_Z, slat);

  // End frames, and the posts the back is bolted to.
  for (const side of [-1, 1]) {
    box(0.09, BENCH_SEAT_Y, 0.62, side * BENCH_END_X, BENCH_SEAT_Y / 2, 0, frame);
    box(0.09, 0.62, 0.08, side * BENCH_END_X, BENCH_SEAT_Y + 0.31, BENCH_BACK_Z, frame);
  }

  for (const part of parts) {
    part.rotateY(yaw);
    part.translate(x, y, z);
  }
  return parts;
}

/**
 * The statue: a figure on a stepped plinth, standing on a square of paving.
 *
 * The paving is part of the statue rather than part of the ground mesh, and that is a dependency
 * decision rather than a rendering one — `city/ground.js` is built before anything has decided
 * where the statue goes, and a plaza that has to be planned in one file and drawn in another is
 * two things to keep in step. It is laid 0.01 above the grass, the same clearance the grass itself
 * has over the kerb it sits on.
 *
 * The figure is hand-built rather than taken from `createPerson`: that one is a rig — a Group of
 * separately-pivoting limbs with materials of their own, so a running cycle can move them — and
 * what is needed here is geometry that merges into the city's one props mesh and never moves
 * again. It keeps the rig's proportions and one raised arm, which is all the silhouette needs.
 */
function statueParts(x, z, y, rng) {
  const parts = [];
  const stone = jitterColor(PALETTE.statueStone, rng, { l: 0.02 });
  const plinth = jitterColor(PALETTE.statuePlinth, rng, { l: 0.02 });

  const box = (w, h, d, ox, oy, oz, col, roll = 0) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (roll) geo.rotateZ(roll);
    geo.translate(x + ox, y + oy, z + oz);
    parts.push(bakeColor(geo, col));
  };

  // The plaza. Rounded to the same vocabulary every other paved surface in the city is cut to.
  const pad = new THREE.ShapeGeometry(roundedRectShape(STATUE_PLAZA, STATUE_PLAZA, 0.9), 8);
  pad.rotateX(-Math.PI / 2);
  pad.translate(x, y + 0.01, z);
  parts.push(bakeColor(pad, jitterColor(PALETTE.sidewalk, rng, { l: 0.02 })));

  // Base, die, cap — a plinth is three boxes or it is a crate with a person on it.
  box(1.50, 0.26, 1.50, 0, 0.14, 0, plinth);
  box(1.05, 1.05, 1.05, 0, 0.79, 0, plinth);
  box(1.25, 0.14, 1.25, 0, 1.38, 0, plinth);

  // The figure, from the plinth's cap up: legs, torso, head, and an arm thrown up. Whoever they
  // were, they are pleased about it.
  box(0.46, 0.78, 0.30, 0, 1.84, 0, stone);
  box(0.58, 0.66, 0.36, 0, 2.56, 0, stone);
  box(0.32, 0.32, 0.32, 0, 3.05, 0, stone);
  box(0.13, 0.68, 0.14, 0.40, 2.86, 0, stone, -0.45);
  // The other arm, at rest against the body, so the raised one reads as a gesture rather than as
  // the only limb the figure has.
  box(0.13, 0.60, 0.14, -0.34, 2.54, 0, stone, 0.10);

  return parts;
}

// The paved square under the statue. 3.6 units holds the 1.5-unit plinth with a pace of paving
// round it, and stays comfortably inside the 9.7 of lawn a pocket park has to offer.
export const STATUE_PLAZA = 3.6;

/**
 * Where the benches and the statue go, decided before any of it is built.
 *
 * Split out and exported because the placement is the part with rules in it — a bench belongs on
 * the walk facing the lawn, and there is **exactly one statue in a city** — and rules are worth
 * asserting over a sweep of seeds rather than looking at on one. tools/probe.mjs plans cities this
 * never built and checks every bench landed on paving.
 *
 * @param areas  the park plots, biggest first is not assumed — each `{ bounds, district }`
 */
export function planParkFurniture(rng, areas) {
  const benches = [];

  // How far in from the block's own edge a bench sits. It stands **on the grass, just off the
  // walk**, rather than on the paving: benches were laid on the walk's centreline first, which is
  // where a bench in the street goes, but a park's walk is a thing you go round the park on and
  // furniture parked in the middle of it reads as an obstacle rather than as somewhere to sit.
  //
  // `PARK_EDGE` is where the grass starts and the bench is 0.645 deep, so this leaves 0.22 of lawn
  // behind the backrest and puts the front legs 0.86 in — off the paving with daylight to spare,
  // still close enough to the walk to be a thing you sit down on while walking past it.
  const benchSet = PARK_EDGE + 0.55;

  for (const area of areas) {
    const { x0, x1, z0, z1 } = area.bounds;

    // Bench slots are spread evenly along each side rather than dropped at random points on it.
    // Random positions on a 32-unit district side put two benches back to back about as often as
    // they put them anywhere useful, and a park is a designed thing — the one place in this city
    // where evenly spaced furniture is more truthful than scattered furniture.
    const slots = [];
    const run = (len, place) => {
      const usable = len - STATUE_PLAZA;                       // keep the ends clear of the corners
      const n = Math.max(1, Math.round(usable / BENCH_PITCH));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        slots.push(place(len / 2 - usable / 2 + usable * t));
      }
    };
    const w = x1 - x0;
    const d = z1 - z0;
    // Each side's benches look *into* the park: south edge faces +Z, north faces −Z, and so on.
    run(w, (s) => ({ x: x0 + s, z: z0 + benchSet, yaw: 0 }));
    run(w, (s) => ({ x: x0 + s, z: z1 - benchSet, yaw: Math.PI }));
    run(d, (s) => ({ x: x0 + benchSet, z: z0 + s, yaw: Math.PI / 2 }));
    run(d, (s) => ({ x: x1 - benchSet, z: z0 + s, yaw: -Math.PI / 2 }));

    // Some of the slots, not all of them: a bench on every one rings the park in furniture and
    // turns the walk into a waiting room. Two or three on a pocket park (4 slots), five or six
    // round a district (10) — one bench per 15 units of frontage at the top end.
    const want = Math.min(slots.length, Math.round(slots.length * 0.45) + rng.int(0, 1));
    for (let n = 0; n < want; n++) benches.push({ ...slots.splice(rng.int(0, slots.length - 1), 1)[0], area });
  }

  // **Exactly one statue in a city**, the same shape of decision as the courtyard block and the
  // helipad, and taken here for the same reason: rolled per park it came out two or three times
  // on most seeds, and the third statue in a five-block city is not a landmark, it is a municipal
  // habit. Districts are preferred because a district's centre is the road that used to run
  // between its two blocks — so the statue stands in the middle of the closed street, which is
  // the one spot in a park that was never anything else.
  const plots = areas.filter((a) => a.district);
  const pool = plots.length ? plots : areas;
  // The plot rides along with the position: `planPond` has to keep the water out of the statue's
  // park, and identity says that where comparing two centres for equality is a float comparison
  // against a number that has been through a Vector3 and back.
  const chosen = pool.length ? rng.pick(pool) : null;
  const statue = chosen ? { ...centreOf(chosen), plot: chosen } : null;

  return { benches, statue };
}

// How much walk a bench gets to itself before the next slot starts. A bench is 1.9 long, so this
// is a bench and about three of its own lengths of empty paving — spacing measured off a district
// side (32 units, 5 slots) rather than off a pocket park, since that is where two benches sharing
// a sightline would show.
const BENCH_PITCH = 7.2;

const centreOf = (area) => ({
  x: (area.bounds.x0 + area.bounds.x1) / 2,
  z: (area.bounds.z0 + area.bounds.z1) / 2,
});

/** The park plots of a city: the merged districts, then whatever lone pocket parks are left. */
export function parkPlots(blocks) {
  const plots = (blocks.districts ?? []).map((d) => ({ bounds: d.bounds, district: true }));
  for (const block of blocks) {
    if (block.type !== 'park') continue;
    if (block.districtId !== null && block.districtId !== undefined) continue;
    plots.push({ bounds: block.bounds, district: false });
  }
  return plots;
}

// --- Fire hydrants ------------------------------------------------------------
//
// Three to five in a city, standing on the pavement. The whole of the brief is that you can *see*
// one, and at this camera that is two separate problems — how big it is drawn, and which frontage
// it stands on — so both are answered here rather than left to luck.
//
// **The size is a lie, and a measured one.** This city's scale is a 4.5m car drawn `CAR_LEN` 3.4
// units long, so 1 unit ≈ 1.3m and an honest hydrant — they are about 0.75m tall — is 0.57 units:
// four pixels at play zoom, which is a speck rather than an object. Drawn at double, 1.14 tall and
// 0.58 across the outlets, or nine pixels by four. That is the same lie geometry/person.js tells
// about a rider (3.3 units against a 3.4-unit car) and told for the same reason, but told much
// more quietly. The bench above is the honest yardstick: this stands 2.6 times its seat height
// where a real hydrant stands 1.7 times, which is an exaggeration you would have to go and measure
// — and the two are never in one frame, since benches are in parks and hydrants are on streets.
export const HYDRANT_H = 1.14;
// The base flange, which is the widest part of the barrel and so the one placement has to budget
// for. The outlets reach further — 0.29 — but only on two of the four sides.
const HYDRANT_BASE_R = 0.27;
export const HYDRANT_REACH = 0.29;
const HYDRANT_SIDES = 8;

// How far in from the block's own edge one stands: the middle of the pavement band, which runs
// from the 0.15 of kerb a block platform leaves showing (`PAVE_INSET`) to the 0.85 a façade sets
// back (`INSET` in buildings.js). Centred rather than nudged toward the kerb, because the band is
// only 0.7 across and the hydrant reaches 0.29 — there is 0.06 of daylight either side and no
// room to spend it on taste.
const HYDRANT_SET = (PAVE_INSET + 0.85) / 2;

/**
 * One hydrant, built facing +X and then turned to `yaw` and set down at (x, z) on a surface at `y`.
 *
 * Five stacked drums and three outlets. There is no barrel taper worth resolving at nine pixels
 * and no chain on the caps at all; what has to read is a bright vertical thing with a bulge at
 * shoulder height, and the two side outlets are the bulge.
 */
function hydrantParts(x, z, y, yaw, rng) {
  const parts = [];
  const body = jitterColor(PALETTE.hydrant, rng, { l: 0.03 });
  const cap = jitterColor(PALETTE.hydrantCap, rng, { l: 0.03 });

  const drum = (rTop, rBot, h, oy, col) => {
    const geo = new THREE.CylinderGeometry(rTop, rBot, h, HYDRANT_SIDES);
    geo.translate(0, oy, 0);
    parts.push(bakeColor(geo, col));
  };
  // An outlet lies on its side: `spin` turns the cylinder's own Y axis onto X or Z.
  const outlet = (radius, len, oy, ox, oz, spin) => {
    const geo = new THREE.CylinderGeometry(radius, radius, len, HYDRANT_SIDES);
    if (spin === 'x') geo.rotateZ(Math.PI / 2);
    else geo.rotateX(Math.PI / 2);
    geo.translate(ox, oy, oz);
    parts.push(bakeColor(geo, body));
  };

  drum(HYDRANT_BASE_R, HYDRANT_BASE_R, 0.10, 0.05, body);        // flange, 0 → 0.10
  drum(0.185, 0.215, 0.60, 0.40, body);                          // barrel, 0.10 → 0.70
  drum(0.235, 0.235, 0.09, 0.745, body);                         // shoulder, 0.70 → 0.79

  // The dome. A hemisphere rather than a cone: a cone at eight sides reads as a spike.
  const dome = new THREE.SphereGeometry(0.20, HYDRANT_SIDES, 3, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.translate(0, 0.79, 0);                                    // 0.79 → 0.99
  parts.push(bakeColor(dome, body));

  drum(0.075, 0.105, 0.15, 1.065, cap);                          // bonnet, 0.99 → HYDRANT_H

  // Two hose outlets across the frontage and the big steamer facing the road. The steamer is what
  // gives the silhouette a front, so it goes on the side the camera is looking at.
  outlet(0.095, 0.16, 0.50, 0, 0.21, 'z');
  outlet(0.095, 0.16, 0.50, 0, -0.21, 'z');
  outlet(0.115, 0.14, 0.56, 0.215, 0, 'x');

  for (const part of parts) {
    part.rotateY(yaw);
    part.translate(x, y, z);
  }
  return parts;
}

// How many. Three is enough to stop one reading as a mistake, five is where the eye starts
// counting them rather than noticing them.
const HYDRANT_MIN = 3;
const HYDRANT_MAX = 5;
// How far back from the far end of a frontage one stands, and how much of the near end stays
// clear. See `planHydrants` for what sets 8.6 — it is not a taste number, it is the width of the
// road the sightline has to leave over.
const HYDRANT_BACK = 8.6;
const HYDRANT_END = 1.4;

/**
 * Where the fire hydrants go, decided before any of them is built.
 *
 * Split out and exported like `planParkFurniture` above, and for a stronger version of the same
 * reason: every rule here is about **being seen**, all of it is invisible once the props are one
 * merged mesh, and the failure mode is silence — a hydrant behind a tower is not a wrong hydrant,
 * it is no hydrant, with nothing logged.
 *
 * Three rules:
 *
 *   1. **Built blocks only, and none on the two origin-edge rows.** A park has a walk but no
 *      frontage to speak of, a district's walk is not where its block bounds say it is, and the
 *      depot's street face is a forecourt with a dropped kerb. The `bi > 0 && bj > 0` is a
 *      different kind of exclusion and worth naming: every other block in the city carries exactly
 *      one fare-marker corner, on its +X+Z corner, which both placements below stand seven units
 *      clear of — but `cornerFor` in game/fares.js flips its pin *inward* at i === 0 and j === 0
 *      rather than off the map, so the blocks on those two edges carry a second one, and a hydrant
 *      landed inside a rider's disc on about a third of them. Restating that flip here would be
 *      copying a rule with exactly one owner, and city/ has no business importing game/ anyway, so
 *      those nine blocks are simply not hydranted. Sixteen is plenty of city for five.
 *   2. **A frontage the camera can see.** The view is a fixed +X+Z diagonal that never rotates, so
 *      only a block's +X and +Z faces are ever visible at all, and even those can be lost behind
 *      the tower on the diagonal neighbour. That is exactly the ray `plusXFaceSeen` in garage.js
 *      works out for the depot's door, so it is asked rather than restated.
 *   3. **Well back from the far end of that frontage.** This is the part that is easy to get
 *      wrong. From a hydrant on the +X face the sightline runs +X+Z, and it has to leave the
 *      block's own z band *before* it reaches the façade across the road — 8.85 units of x out
 *      (8 of road plus the 0.85 a building sets back), against the 0.5 of pavement it starts
 *      with, so it has 9.35 of z to spend and it spends `HYDRANT_BACK` of it. Bigger is better
 *      for the diagonal block beyond and worse for the near one, and 8.6 leaves 0.75 of margin on
 *      the near side while putting the ray 0.92 × (8.6 + 8.85) = 16.05 units up by the diagonal's
 *      façade — clear of `buildTower`'s 16-unit ceiling on its own, before rule 2 knocks that
 *      ceiling down to 13.25. (Rooftop clutter can stand higher than 16; so can the depot's door
 *      sightline, and this lives with it for the same reason.)
 *
 * The +Z face is the mirror of all of it — the view is symmetric about its own diagonal, and the
 * block that can occlude is the same diagonal neighbour either way — so which of the two a hydrant
 * takes is variety and nothing else.
 */
export function planHydrants(rng, blocks) {
  const want = rng.int(HYDRANT_MIN, HYDRANT_MAX);

  const place = (block) => {
    const { x0, x1, z0, z1 } = block.bounds;
    const onX = rng.chance(0.5);
    // A block beside an arterial is up to 2.67 narrower, and on those `HYDRANT_BACK` would put the
    // hydrant off the end of its own frontage. Giving up the margin is the right trade: a shorter
    // block puts the far kerb *closer*, so the near-side leg has room to spare, and the diagonal
    // leg still comes out at 0.92 × (7.93 + 8.85) = 15.4 against a 13.25 ceiling.
    const back = Math.min(HYDRANT_BACK, (onX ? z1 - z0 : x1 - x0) - HYDRANT_END);
    return onX
      ? { x: x1 - HYDRANT_SET, z: z1 - back, yaw: 0, block }
      : { x: x1 - back, z: z1 - HYDRANT_SET, yaw: -Math.PI / 2, block };
  };

  const pool = blocks.filter((b) => b.type === 'built' && b.bi > 0 && b.bj > 0
    && plusXFaceSeen(blocks, b.bi, b.bj));
  // Fisher-Yates rather than a per-block `chance`: the pass below breaks its ties on this order,
  // and a filtered roll would hand it the same low-index blocks on every seed.
  for (let n = pool.length - 1; n > 0; n--) {
    const m = rng.int(0, n);
    [pool[n], pool[m]] = [pool[m], pool[n]];
  }

  // "Throughout the city" is the ask, so spread is a rule and not a hope: two hydrants on blocks
  // that touch are one hydrant as far as the eye is concerned. Farthest-point rather than a
  // minimum separation with a fallback — a hard floor has to be relaxed on the cities that cannot
  // meet it, and the step below the floor is no constraint at all, which is exactly the seed where
  // the spread mattered. This always fills the board and always takes the most spread out block
  // still going, on every city.
  const chosen = [];
  const taken = new Set();
  const apart = (a, b) => Math.max(Math.abs(a.bi - b.bi), Math.abs(a.bj - b.bj));
  while (chosen.length < want && taken.size < pool.length) {
    let best = null;
    let bestGap = -1;
    for (const block of pool) {
      if (taken.has(block)) continue;
      // The first pick has nothing to be far from, so every candidate scores Infinity and the
      // strict `>` leaves the shuffle above to decide it.
      const gap = chosen.reduce((least, c) => Math.min(least, apart(c.block, block)), Infinity);
      if (gap > bestGap) { bestGap = gap; best = block; }
    }
    taken.add(best);
    chosen.push(place(best));
  }
  return chosen;
}

export function createProps(rng, blocks) {
  const parts = [];

  // Every tree stamped with its own trunk position, so the entrance animation (game/cityentry.js)
  // can pop each one individually out of the merged mesh. The x/z draws stay in the same order the
  // bare `treeParts` calls made them, and the jitter is a hash rather than a draw — see the note
  // in createBuildings — so the planting a seed produces is untouched.
  const plant = (x, z, size) => {
    const tree = treeParts(x, z, rng, size);
    const rand = hash01(x, z);
    for (const part of tree) stampEntry(part, x, z, rand);
    parts.push(...tree);
  };

  // Trees stand on the grass, not on the walk that rings it: `PARK_EDGE` is where the green
  // starts, and the rest is a trunk's own radius (~0.2 at the thick end) plus room for the
  // planting to look intentional. Derived from the ground's own number so the two can't drift —
  // this was a bare 1.8 while the green ran to the kerb, which is a trunk on the paving now.
  const TREE_MARGIN = PARK_EDGE + 0.6;

  // The furniture is placed before the planting, because the planting has to keep out of its way:
  // a tree growing through the statue is the one arrangement a park cannot have.
  const plots = parkPlots(blocks);
  const { benches, statue } = planParkFurniture(rng, plots);
  // And the pond with the furniture, for the same reason — a tree standing in the water is the
  // other one. This does mean a seed's trees are planted in different spots than they were before
  // there were ponds: two draws land in this stream ahead of them now. Everything *outside*
  // `createProps` runs on its own offset and has not moved, which is the separation that matters
  // (see the seeding note in docs/architecture.md).
  const pond = planPond(rng, plots, statue);

  const SURFACE_Y = KERB_H + 0.01;
  for (const bench of benches) {
    const built = benchParts(bench.x, bench.z, SURFACE_Y, bench.yaw, rng);
    for (const part of built) stampEntry(part, bench.x, bench.z, hash01(bench.x, bench.z));
    parts.push(...built);
  }
  if (statue) {
    const built = statueParts(statue.x, statue.z, SURFACE_Y, rng);
    for (const part of built) stampEntry(part, statue.x, statue.z, hash01(statue.x, statue.z));
    parts.push(...built);
  }
  if (pond) {
    // Stamped on its own centre like everything else in this mesh, so the pond rises out of the
    // park in the city's entrance wave rather than being the one thing already there. The bank and
    // the water share one anchor: they are two halves of a single object, and given separate ones
    // they would arrive on separate frames with the shore ring briefly hanging round nothing.
    const built = pondParts(pond, rng);
    for (const part of built) stampEntry(part, pond.x, pond.z, hash01(pond.x, pond.z));
    parts.push(...built);
  }

  // The plaza's own square, plus a pace: a trunk right on the paving's edge leans its crown over
  // the figure, and the whole point of standing a statue in a clearing is that it is in a clearing.
  const CLEAR = STATUE_PLAZA / 2 + 0.7;
  const clearOfStatue = (x, z) => !statue
    || Math.abs(x - statue.x) > CLEAR || Math.abs(z - statue.z) > CLEAR;

  // And clear of the benches, which now stand on the grass the trees are planted in rather than on
  // the walk beside it — so the two genuinely compete for ground. The test is in each bench's own
  // frame rather than a radius, because a bench is 1.9 by 0.65 and a circle big enough to cover its
  // ends clears half the lawn behind it. Only the **trunk** has to miss: a crown leaning over a
  // bench is shade, which is what a bench under a tree is for.
  const BENCH_CLEAR_X = BENCH_LEN / 2 + 0.4;
  const BENCH_CLEAR_Z = 0.34 + 0.4;
  const clearOfBenches = (x, z) => benches.every((bench) => {
    const cos = Math.cos(bench.yaw);
    const sin = Math.sin(bench.yaw);
    const dx = x - bench.x;
    const dz = z - bench.z;
    return Math.abs(dx * cos - dz * sin) > BENCH_CLEAR_X
      || Math.abs(dx * sin + dz * cos) > BENCH_CLEAR_Z;
  });

  // And clear of the water. A radius, not a frame: the pond genuinely is round-ish, and it is the
  // one thing here where the *crown* has to miss as well as the trunk — a tree leaning over a bench
  // is shade and a tree leaning over a pond is a tree growing out of it. Hence the pond's nominal
  // radius (which its wobbled outline never exceeds) plus a crown's own reach, ~1.8 at the top of
  // `treeParts`' height range.
  const clearOfPond = (x, z) => !pond || Math.hypot(x - pond.x, z - pond.z) > pond.r + 1.8;

  const clearOfFurniture = (x, z) => clearOfStatue(x, z) && clearOfBenches(x, z) && clearOfPond(x, z);

  // Districts are planted as one area so trees fall across the old road line too — nothing
  // gives away a merged park faster than a treeless stripe down the middle of it.
  for (const plot of plots) {
    const { x0, z0, x1, z1 } = plot.bounds;
    const count = plot.district ? rng.int(11, 16) : rng.int(5, 9);
    for (let i = 0; i < count; i++) {
      // Rejection rather than a reshaped sampling region: what the planting has to miss is a
      // square hole in the middle of the plot and a handful of boxes round its edge, and a bounded
      // retry says that in one line where a sampling region would have to be built out of both.
      // A tree that cannot find a spot in six is dropped rather than forced — a park one tree
      // short of its count is cheaper than a trunk through a bench, and either way this loop ends.
      let x = 0;
      let z = 0;
      for (let attempt = 0; attempt < 6; attempt++) {
        x = rng.range(x0 + TREE_MARGIN, x1 - TREE_MARGIN);
        z = rng.range(z0 + TREE_MARGIN, z1 - TREE_MARGIN);
        if (clearOfFurniture(x, z)) break;
      }
      if (clearOfFurniture(x, z)) plant(x, z);
    }
  }

  // --- The arterials' medians -------------------------------------------------
  //
  // Flower beds down the middle of every main street. Planted last so the park draws above keep
  // the stream they have always had — a seed's parks look the same as they did before medians
  // existed. See `flowerBedParts` for why these are beds and not trees.
  for (const bed of planMedianBeds(rng, medianRuns())) {
    const built = flowerBedParts(bed.x, bed.z, rng, bed);
    const rand = hash01(bed.x, bed.z);
    for (const part of built) stampEntry(part, bed.x, bed.z, rand);
    parts.push(...built);
  }

  // --- The fire hydrants ------------------------------------------------------
  //
  // Last for the same reason the beds are: a seed's parks and its medians came through this
  // change untouched because nothing above here reads `rng` after them. See `planHydrants` for
  // where they go and why it is not a free choice.
  for (const hydrant of planHydrants(rng, blocks)) {
    const built = hydrantParts(hydrant.x, hydrant.z, SURFACE_Y, hydrant.yaw, rng);
    const rand = hash01(hydrant.x, hydrant.z);
    for (const part of built) stampEntry(part, hydrant.x, hydrant.z, rand);
    parts.push(...built);
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'props';
  // `{ mesh, pond }` rather than the bare mesh, the same shape `createBuildings` hands back its
  // `pad` in: exactly one park in the city has water in it, and `game/ducks.js` has to be told
  // which one. Null on a city with no park big enough — no pond, no ducks.
  return { mesh, pond };
}
