import * as THREE from 'three';
import { bakeColor, bakeColors } from '../util/geo.js';
import { PALETTE, jitterColor } from '../palette.js';
import { KERB_H, PARK_EDGE } from './ground.js';

// One duck pond, in one park, in one city.
//
// It is the only water in the game and it is scenery on the same terms as the statue: nothing
// routes around it, nothing can be tapped on it, and the fare loop has never heard of it. What it
// buys is that a park stops being a lawn with trees on it — a pond reads as a *place* from a fixed
// camera in a way that more planting cannot, because it is the one thing in a park that isn't green.
//
// **Never the statue's park.** Those are the two things a city puts in the middle of a green and
// standing them in the same one leaves every other park with nothing — the same argument that keeps
// the two flocks off one lawn (game/birds.js). It is also why both are "exactly one a city": a
// second pond is municipal habit rather than a landmark.
//
// The ducks floating on it are in `game/ducks.js`; this is the water they sit on.
//
// Split into a plan and a build the way `planParkFurniture` and `planMedianBeds` are, and for the
// same reason: where the water goes is the part with rules in it — inside the lawn, clear of the
// benches, out of the statue's park — and `tools/probe.mjs` sweeps those over seeds rather than
// looking at them on the one city it happened to build.

/** What ground.js lays a park's lawn at. */
const GRASS_Y = KERB_H + 0.01;
/**
 * The bank sits on the grass, the water sits in the hole the bank leaves. Both above the lawn, and
 * the bank above the water — a shore stands proud of what it holds in, and 0.003 is nothing to see
 * at 7.7px per unit but it is the right way round for free.
 */
export const POND_BANK_Y = GRASS_Y + 0.010;
export const POND_WATER_Y = GRASS_Y + 0.007;

// How far the pond's own circle stays inside the block's bounds. `PARK_EDGE` is where the grass
// starts; the rest clears the bench band, which stands centred at `PARK_EDGE + 0.55` and is 0.645
// deep, so its front legs reach `PARK_EDGE + 0.87`. What is left over is a quarter-unit of lawn
// between the front of a bench and the pond's own circle, and rather more than that to the water
// itself — the outline wobbles inward off that circle everywhere except its two widest points.
//
// It was 0.5 of lawn, and the 0.25 it gave back is the difference between a pond in three cities
// out of four and one in every city that has a park at all: a block with an arterial down one side
// is 10.67 across, and at the wider setback it could not hold the smallest pond the ducks will fit
// in. A bench a step from the water is what a municipal pond looks like anyway.
export const POND_SET = PARK_EDGE + 1.15;

// The size range, before the plot it lands on has its say.
//
// **The floor is set by the birds on it, not by what reads as water.** A duck is a scaled-up model
// for the same reason every person in this game is (see BIRD_SCALE) — 1.1 units drawn against the
// 0.25 a real one would be — and what a pond has to be is several of those across. The water's own
// radius comes out at `r · 0.85` less the shore band, and the ducks are then held a bird's length
// inside that, so 2.9 of pond leaves them a disc a bird and a half across to paddle in. Anything
// smaller is three of them jammed shoulder to shoulder in a puddle: a bigger pond and a smaller
// duck were the two ways out of that, and the pond is the one with room to give — the flock is
// standing on the same lawn at full size, so a shrunken duck simply reads as a different animal.
//
// It costs a park type. A block with an arterial down either side is 9.33 across and cannot hold
// this after the setbacks, so those plots are passed over — and a city whose every park is one of
// them gets no pond at all, the way a city with nowhere to put a depot gets no vignette.
const POND_R_LOW = 2.9;
const POND_R_HIGH = 3.5;

// The shore band, water's edge to the grass. Constant per pond — the outline wobble below is what
// keeps it from reading as a ring, and a second varying number on top of it bought nothing.
const BANK_LOW = 0.30;
const BANK_HIGH = 0.50;

// The outline: a circle bent by two low-frequency lobes rather than jittered per point. A per-point
// draw is the obvious thing and it is wrong — 20 independent radii make a star, not a pond, and
// smoothing them costs more code than not making the mistake. Two sinusoids at 2 and 3 cycles round
// give a kidney or a teardrop, which is what a small ornamental pond actually looks like in plan.
//
// Their amplitudes are what the water radius is guaranteed against: the outline never comes in by
// more than their sum, so `water` below is a number the ducks can be bounded by without anyone
// evaluating the outline again.
const LOBE_2 = [0.05, 0.11];
const LOBE_3 = [0.03, 0.07];

/** Points round the rim. At a 2.5-unit pond that is a segment every 0.8 units — 6px. */
const RIM = 20;

const TAU = Math.PI * 2;

/** The outline's radius at an angle, as a fraction of the pond's nominal one. */
export function pondRadiusAt(pond, angle) {
  let f = 1;
  for (const lobe of pond.lobes) f -= lobe.amp * (1 + Math.sin(lobe.freq * angle + lobe.phase)) / 2;
  return pond.r * f;
}

/**
 * Where the pond goes, and what shape it is. `null` on a city with no park that can hold one, which
 * is a state the whole chain handles rather than one to guard against: no pond, no ducks.
 *
 * @param plots   the park plots, as `parkPlots` returns them
 * @param statue  the statue from `planParkFurniture`, whose plot this must not use
 */
export function planPond(rng, plots, statue) {
  // Room is always the *short* side: a district is two blocks plus the road between them, so it is
  // 32 by 12 and the 12 is what decides whether a pond fits in it.
  const roomFor = (plot) => Math.min(
    plot.bounds.x1 - plot.bounds.x0, plot.bounds.z1 - plot.bounds.z0,
  ) / 2 - POND_SET;

  const eligible = plots.filter((p) => p !== statue?.plot && roomFor(p) >= POND_R_LOW);
  if (!eligible.length) return null;

  // Picked flat rather than preferring a district the way the statue does. A statue wants the one
  // spot in a park that was never anything else — the closed road down a district's middle — and a
  // pond wants nothing in particular, so the only thing weighting the draw would buy is a bigger
  // pond in the cities that happen to have a district free. The plot caps the radius anyway.
  const plot = rng.pick(eligible);
  const r = Math.min(rng.range(POND_R_LOW, POND_R_HIGH), roomFor(plot));

  // Anywhere on the lawn that holds the whole circle. A district gets ten units of wander along its
  // long axis, which is the point: the water lands somewhere in the park rather than at the dead
  // centre of it, where every other one-per-city thing in this game stands.
  const { x0, x1, z0, z1 } = plot.bounds;
  const roomX = (x1 - x0) / 2 - POND_SET - r;
  const roomZ = (z1 - z0) / 2 - POND_SET - r;
  const x = (x0 + x1) / 2 + rng.jitter(Math.max(0, roomX));
  const z = (z0 + z1) / 2 + rng.jitter(Math.max(0, roomZ));

  const lobes = [
    { freq: 2, amp: rng.range(LOBE_2[0], LOBE_2[1]), phase: rng.range(0, TAU) },
    { freq: 3, amp: rng.range(LOBE_3[0], LOBE_3[1]), phase: rng.range(0, TAU) },
  ];
  const bank = rng.range(BANK_LOW, BANK_HIGH);

  return {
    x, z, r, bank, lobes, plot,
    // The radius the water is guaranteed to cover: the outline at its tightest, less the shore.
    // Exported as a number rather than as "evaluate the outline yourself" because what reads it is
    // `game/ducks.js`, which has no business knowing the pond is made of sinusoids.
    water: r * (1 - lobes.reduce((sum, l) => sum + l.amp, 0)) - bank,
  };
}

/**
 * The pond as geometry: a shore ring with the water sitting in the hole it leaves.
 *
 * The hole is the same construction `parkSurface` uses for the walk round a park, and for the same
 * reason — two coplanar opaque surfaces would pay for the overlap twice — but here it also removes
 * the seam: both rims come off the same point list, so there is no pair of outlines to disagree.
 */
export function pondParts(pond, rng) {
  const parts = [];

  const outer = [];
  const inner = [];
  for (let i = 0; i < RIM; i++) {
    const a = (i / RIM) * TAU;
    const radius = pondRadiusAt(pond, a);
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    outer.push({ x: dx * radius, z: dz * radius });
    inner.push({ x: dx * (radius - pond.bank), z: dz * (radius - pond.bank) });
  }

  // The shore. Built as a Shape in the XY plane and laid flat with the same `rotateX(-π/2)` every
  // other paved surface in the city is laid with, which maps shape-space y onto world **−z** — so
  // the points go in negated, and what comes out lands exactly where `inner`/`outer` say.
  const ring = new THREE.Shape();
  outer.forEach((p, i) => (i ? ring.lineTo(p.x, -p.z) : ring.moveTo(p.x, -p.z)));
  const hole = new THREE.Path();
  inner.forEach((p, i) => (i ? hole.lineTo(p.x, -p.z) : hole.moveTo(p.x, -p.z)));
  ring.holes.push(hole);

  const bank = new THREE.ShapeGeometry(ring);
  bank.rotateX(-Math.PI / 2);
  bank.translate(pond.x, POND_BANK_Y, pond.z);
  parts.push(bakeColor(bank, jitterColor(PALETTE.pondBank, rng, { l: 0.03 })));

  // The water, as a fan about its own centre — hand-wound rather than a second `ShapeGeometry`,
  // because the fan is what gives it a **centre vertex**, and the centre vertex is the whole of the
  // depth read: open water in the middle, the shallows darker round the rim. Earcut would hand back
  // a rim-only triangulation with nowhere to put the gradient.
  //
  // A gradient across a flat-shaded triangle costs nothing but the numbers — see `bakeColors`.
  //
  // Wound `(centre, p[i+1], p[i])`, which is the order that faces **up**. Taking the points in
  // their own increasing-angle order gives a fan pointing at the ground, lit from underneath, and
  // `computeVertexNormals` would launder it into looking deliberate. `tools/probe.mjs` computes the
  // normal from this winding rather than trusting the sentence.
  const open = jitterColor(PALETTE.pondWater, rng, { l: 0.02 });
  const shallow = jitterColor(PALETTE.pondShallow, rng, { l: 0.02 });
  const pos = [];
  const col = [];
  const vertex = (p, c) => {
    pos.push(pond.x + p.x, POND_WATER_Y, pond.z + p.z);
    col.push(c.r, c.g, c.b);
  };
  const centre = { x: 0, z: 0 };
  for (let i = 0; i < RIM; i++) {
    vertex(centre, open);
    vertex(inner[(i + 1) % RIM], shallow);
    vertex(inner[i], shallow);
  }

  const water = new THREE.BufferGeometry();
  water.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  parts.push(bakeColors(water, new Float32Array(col)));

  return parts;
}

export { POND_R_LOW, POND_R_HIGH };
