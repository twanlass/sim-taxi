import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, jitterVertices, propMaterial, stampEntry } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { KERB_H, MEDIAN_EDGE, PARK_EDGE, roundedRectShape } from './ground.js';
import { MEDIAN_W, medianRuns } from './grid.js';

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
  const statue = pool.length ? { ...centreOf(rng.pick(pool)) } : null;

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

  const clearOfFurniture = (x, z) => clearOfStatue(x, z) && clearOfBenches(x, z);

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

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'props';
  return mesh;
}
