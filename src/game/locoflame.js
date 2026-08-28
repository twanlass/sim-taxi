import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';
import { TAXI_TAILPIPE_BACK, TAXI_TAILPIPE_HEIGHT } from '../geometry/taxi.js';

// The flame that burns out of the tailpipe for as long as Loco Mode is held.
//
// `game/flames.js` is the *bark* on the press — a one-shot cone of motes that is gone in under a
// second. This is the other half of the same idea and it is a different object entirely: a flat
// stylized cutout, three nested tongues of flat colour, riding on the bumper for the whole hold.
// The mode had no continuous read at all before it: a player who pressed and kept holding saw one
// puff at the start and then a car that was merely fast, and the pill draining in the corner was
// the only thing still saying *why*.
//
// **It is a cutout, not a particle system.** Same argument `game/blast.js` makes at length: at a
// fixed 3/4 camera what sells fire is shape and timing, not simulation. A jet is three tongues of
// flat colour — orange-red outside, gold under it, near-white at the pipe — and it *flickers* by
// cycling four hand-shaped silhouettes, which is a flipbook and reads as drawn fire rather than as
// a smooth blob being scaled. Total cost is 12 meshes over 4 geometries and 3 materials, all built
// once at module load; nothing is allocated per frame and nothing is integrated.
//
// **It stands in a vertical plane through the car's own long axis** — it is not a screen-plane
// billboard, and that is a measurement rather than a preference. The billboard was tried first: the
// plume has to point along the car's *backward* direction, which projects into the screen plane at
// (∓0.707, ±0.386) for the four headings, so for two of them it points **down-screen** and a
// 2.7-unit plume sinks 2.7 × 0.386 × 0.838 ≈ 0.87 world units — through a road that is only
// TAXI_TAILPIPE_HEIGHT (0.74) below the pipe. Half the compass drew a flame with its tail cut off
// by the asphalt. A cutout standing on the car's axis cannot do that: the furthest it ever reaches
// downward is its own half-width.
//
// Neither is it edge-on from anywhere, which is the failure the vertical plane could have had: the
// city's roads are axis-aligned and the camera's azimuth is the 45° diagonal, so the flame's plane
// faces the view at the same 53° on every heading and its length foreshortens by the same 0.808.

// How far the plume reaches back from the bumper, and its widest half-width, in world units.
// 3.0 × 0.808 of foreshortening ≈ 2.4 units on screen, which at play zoom (1 unit ≈ 7.7px) is a
// ~19px flame behind a 31px car. Shorter than that and it is a smudge on the bumper (2.7 was the
// first try and rendered as a dart rather than as fire); much longer and the taxi is towing a
// banner.
const LEN = 3.0;
// The half-width is the one number the road sets rather than the eye. The plume hangs off a pipe
// TAXI_TAILPIPE_HEIGHT (0.74) above the tarmac and the widest point of the tongue is the lowest
// thing it draws, so half-width × the ruffle (1.16) × the fattest beat of the pulse (1.15) is what
// has to clear it. At 0.62 — where this started, chosen against the car's 2.0 width — that came to
// 0.735 and the flame grazed the asphalt with 0.002 to spare, which is not a margin, it is a
// coincidence. 0.50 is what the fuller profile below can afford: 0.095 clear at the worst frame of
// the pulse, measured by the probe off the vertices actually drawn rather than off this arithmetic.
const HALF_W = 0.50;

// The tip whips off the axis by this much (as a fraction of HALF_W's own scale, applied along the
// length) and each edge ruffles by this much of its own width. Both are what separate the four
// silhouettes from each other — the shape is otherwise the same tongue four times.
const SWAY = 0.30;
const RUFFLE = 0.16;

// Four frames on a flipbook, and the phases are a full turn divided by four so the cycle closes on
// itself — a flame that visibly snaps back to frame 0 is a flame with a seam in it.
const FRAMES = 4;
// 16fps, which is ~4 display frames of hold each at 60. Faster reads as strobe rather than as fire
// (tried at 30fps: the tongues average out into a static blob); slower and the licking turns into
// four separate poses being shown to you.
const FRAME_TIME = 1 / 16;

// The three tongues, as (length, width) fractions of the outer one. Nested rather than blended:
// each is the same silhouette scaled, so an inner tongue is strictly inside the one behind it and
// the plume reads as a hot core in a cooler sheath without a single translucent pixel.
const LAYERS = [
  { color: PALETTE.locoFlameOuter, scale: [1, 1], order: 6 },
  { color: PALETTE.locoFlameMid, scale: [0.72, 0.64], order: 7 },
  { color: PALETTE.locoFlameCore, scale: [0.50, 0.44], order: 8 },
];

// How fast the plume comes up and how fast it dies. The attack is nearly instant — the flame is the
// answer to a button press and anything slower reads as lag — and the release is long enough to be
// a throttle closing rather than a light switch, while staying well inside BOOST_COOLDOWN (1s) so
// the flame is out before the car has finished coasting back down.
const ATTACK = 0.05;
const RELEASE = 0.16;

// Cross-sections along the tongue. 10 is what it takes for the ruffle to read as an edge that
// wavers rather than as a polygon with a kink in it, at 2 triangles a section.
const SECTIONS = 10;

/**
 * Half-width of the tongue at `u` along its length: widest just off the pipe, a point at the tip.
 *
 * The exponent on the taper is the shape of the whole thing. At 0.85 the tongue has spent 80% of
 * its girth by halfway and the back two-thirds is a spike — rendered, that is a dart stuck in the
 * bumper rather than a flame. 0.55 holds the body out to u = 0.5 (63% of full width there against
 * 48%) and puts the taper where a drawn flame has it, in the last third.
 */
function halfWidth(u) {
  return HALF_W * (1 - u) ** 0.55 * (0.62 + 0.38 * Math.sin(Math.PI * Math.sqrt(u)));
}

/**
 * One silhouette, as a strip of quads rather than a fan.
 *
 * A fan needs the shape to be star-shaped about its centre, which a tongue with a whipped tip is
 * not — and the failure of that is a triangle folded back over its neighbour, which at flat colour
 * is invisible until the thing fades and draws a bright seam across itself. A strip between
 * successive cross-sections is correct for any profile, and its winding is trivially consistent:
 * every quad is walked bottom-edge first, so every triangle comes out counter-clockwise seen from
 * +Z. `tools/probe.mjs` checks the sign rather than taking that on trust.
 */
function tongueGeometry(phase) {
  // Where the centreline of the tongue sits at `u` — zero at the pipe, whipping at the tip.
  const centre = (u) => SWAY * u * Math.sin(u * 2.4 + phase);
  // ...and where each edge sits, ruffled on its own phase so the two sides never mirror.
  const edge = (u, side) => centre(u)
    + side * halfWidth(u) * (1 + RUFFLE * Math.sin(u * 5.5 + phase * 1.7 + side));

  const pos = [];
  const push = (u, side) => pos.push(u * LEN, edge(u, side), 0);

  for (let i = 0; i < SECTIONS; i++) {
    const u0 = i / SECTIONS;
    const u1 = (i + 1) / SECTIONS;
    // The last section closes on the tip, where both edges meet: one triangle, not a quad with a
    // degenerate half.
    if (i === SECTIONS - 1) {
      push(u0, -1); push(u1, -1); push(u0, 1);
      continue;
    }
    push(u0, -1); push(u1, -1); push(u1, 1);
    push(u0, -1); push(u1, 1); push(u0, 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// Built once for every flame on the page — a page has one taxi, and the lab has the other. Node-safe
// for the same reason the outburst bubble's geometry is: arithmetic and buffers, no document.
const TONGUES = Array.from({ length: FRAMES },
  (_, k) => tongueGeometry((k / FRAMES) * Math.PI * 2));

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * The tailpipe flame, as a thing that follows the taxi.
 *
 * `update(dt, car, on)` is the whole interface: `on` is the caller's read of "Loco Mode is being
 * held" (`boost.isActive()` in main.js and in the lab), and everything else — where the pipe is,
 * which way the plume points, whether there is anything to draw at all — comes off the car.
 */
export function createLocoFlame(scene) {
  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  // One material per layer, shared across all four flipbook frames: the frames differ in shape
  // only, and three materials is also three opacity values to animate instead of twelve.
  const materials = LAYERS.map(({ color }) => unlitMaterial({
    color,
    transparent: true,
    // Both sides, because *which* side faces the camera flips with the heading. The plume's plane
    // normal comes out at (−sin yaw, 0, −cos yaw), whose dot with the view direction is
    // −(sin yaw + cos yaw) — positive driving west and north, negative driving east and south. A
    // single-sided cutout would therefore be correct on exactly half the compass and invisible on
    // the other half, and this is unlit flat colour, so a back face is the same colour as a front
    // one and there is nothing to lose by drawing both. (No flatShading here, which is what makes
    // that true — see the back-face note in CLAUDE.md.)
    side: THREE.DoubleSide,
    // Sorted by renderOrder below rather than by depth: the three tongues are coplanar, so with
    // depth writes on they would z-fight, and with them off but no ordering three would sort them
    // by a distance that is identical to six decimal places.
    depthWrite: false,
  }));

  // One group per flipbook frame; exactly one is visible at a time.
  const frames = TONGUES.map((geometry) => {
    const frame = new THREE.Group();
    frame.visible = false;
    LAYERS.forEach(({ scale: [len, wide], order }, k) => {
      const mesh = new THREE.Mesh(geometry, materials[k]);
      mesh.scale.set(len, wide, 1);
      mesh.renderOrder = order;   // above the road decals, same band as the kickoff burst
      // A moving object whose bounding sphere three would latch on its first culled frame — and
      // this one is parked at the origin, invisible, on that frame. Same trap the ambient traffic's
      // InstancedMeshes hit (see CLAUDE.md).
      mesh.frustumCulled = false;
      frame.add(mesh);
    });
    group.add(frame);
    return frame;
  });

  const state = {
    heat: 0,     // 0 out, 1 burning — the attack/release envelope
    frame: 0,    // which silhouette is up
  };

  let clock = 0;

  /**
   * @param dt   sim seconds, so a paused run holds the flame rather than letting it flicker on
   * @param car  the taxi — `x`, `z`, `yaw` and `crashed` are all this reads
   * @param on   is Loco Mode being held right now?
   */
  function update(dt, car, on) {
    const want = on && !car.crashed ? 1 : 0;
    const step = dt / (want > state.heat ? ATTACK : RELEASE);
    state.heat = want > state.heat
      ? Math.min(want, state.heat + step)
      : Math.max(want, state.heat - step);

    if (state.heat <= 0) {
      if (group.visible) {
        group.visible = false;
        frames[state.frame].visible = false;
      }
      // The clock is deliberately *not* reset: a re-press mid-cooldown snaps the car back to full
      // send, and restarting the flipbook from frame 0 each time would make a rapid press-release-
      // press stutter on the same pose.
      return;
    }

    clock += dt;

    const heat = clamp01(state.heat);
    group.visible = true;
    group.position.set(
      car.x - Math.cos(car.yaw) * TAXI_TAILPIPE_BACK,
      TAXI_TAILPIPE_HEIGHT,
      car.z + Math.sin(car.yaw) * TAXI_TAILPIPE_BACK,
    );
    // Local +X is the plume's own length, and it has to lie along the car's backward direction:
    // rotating the group by yaw + π sends local +X to (−cos yaw, 0, sin yaw), which is exactly the
    // (bx, bz) every other effect off the back of this car is written in.
    group.rotation.y = car.yaw + Math.PI;

    // Two beats rather than one. A single sine is a plume *breathing*; the second, faster and
    // shallower, is what stops the length and the flipbook from locking into one visible period.
    const pulse = 1 + 0.10 * Math.sin(clock * 23) + 0.05 * Math.sin(clock * 41);
    group.scale.set(heat * pulse, heat * (2 - pulse), 1);

    const next = Math.floor(clock / FRAME_TIME) % FRAMES;
    if (next !== state.frame) {
      frames[state.frame].visible = false;
      state.frame = next;
    }
    frames[state.frame].visible = true;

    // Fades with the envelope as well as shrinking with it: a plume that only scales pops out of
    // existence at its smallest size instead of going out.
    for (const material of materials) material.opacity = heat;
  }

  return { group, frames, materials, state, update };
}
