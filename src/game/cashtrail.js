import * as THREE from 'three';
import { skipWhenEmpty } from '../util/emptypools.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { color } from '../palette.js';
import { propMaterial, bakeColor } from '../util/geo.js';
import { carrySpeed } from '../util/carry.js';
import { TAXI_TAILPIPE_BACK, TAXI_TAILPIPE_HEIGHT } from '../geometry/taxi.js';
import { ROAD_Y } from '../sim/traffic.js';

// Banknotes fluttering out of the back of the taxi while it boosts with a robber aboard — see
// [the bank robbery](../../docs/gameplay.md#the-bank-robbery).
//
// **It is the one thing in the event that rewards the player for the risk in the moment.** The
// bonus a getaway pays is real (`ROBBER_BONUS` in game/fares.js) and the player does not see a
// penny of it until the drop-off resolves; everything in between is a tight clock and four cop
// cars to hit. A stream of cash off the back while the pill is held is the payoff arriving at the
// time it is being earned, which is the whole of what it is for.
//
// Two pools, because cash comes in two weights and the contrast between them is most of the read:
//
//   - **Loose notes**, a flutter pool. Low gravity, heavy drag on *both* axes, and a **falling-leaf
//     swing** rather than a tumble: the note is flipped once or twice by the throw, then rocks side
//     to side as it sinks, tilting up at each end of the swing. That motion is what says "paper"
//     — the random-axis spin it replaced said "flake", and spent a third of its frames edge-on.
//   - **Wrapped bundles**, a handful per press: a brick of notes with a paper band round the
//     middle, thrown heavier, tumbling, bouncing once and flopping flat. A single note at 7px can
//     only be a green fleck; a bundle reads as money at any zoom, and it gives the stream a beat.
//
// **Both pools are lit, and the notes were not at first.** Money is paper reflecting a light, not a
// light source, and an unlit note is drawn at its full palette value whatever the sun is doing:
// fine at noon, and at golden hour — with the road and every building around it gone dark and
// warm — a shower of full-bright green, which reads as emissive. Reported as exactly that. The
// notes are a Lambert like dust.js's puffs, and stay out of the bloom's draw list (a glowing
// banknote is a firefly); the bundles are solid props and take `propMaterial`, like the roadworks
// cones.

/**
 * The note pool.
 *
 * The gust clock averages about 44 notes a second (see GUST), which over a `LIFE` of 2.4s is ~105
 * live at the top of a sustained hold — and a gust's own peak runs well over that average while it
 * lasts. The `KICK` burst can put 24 more on top in one frame. 160 covers both with room for the
 * frame a second robbery's first notes overlap the tail of the last one's; a wrapped slot silently
 * truncates the stream rather than failing.
 *
 * **It is a big pool on purpose.** The first cut ran 14 a second into 48 slots, which is 22 notes
 * in the air — and 22 four-pixel rectangles spread over thirty units of road is a scattering you
 * have to go looking for. The whole of this effect is that it should be impossible to miss.
 */
const MAX_NOTES = 160;

/**
 * The burst the press itself throws.
 *
 * An effect that ramps up has nothing to say on the frame the player actually pressed the button,
 * and that frame is the one they are looking at. Fired from the same `kickLocoMode` in main.js
 * that throws the tailpipe flame and stamps the launch rubber, so the three land together as one
 * event. The hold's own rate is the gust clock below.
 */
// Halved from 24 with the gust rates below — Tyler found the full shower too much once the trail
// started staying on the road (see GROUND_STAY).
const KICK = 12;

/**
 * The gust, which is what turns a stream into a shower.
 *
 * At a flat `RATE` the trail is a rope: a constant-density ribbon paid out of the back of the car,
 * and a constant anything reads as a machine rather than as money coming loose. What it should
 * look like is a bag that keeps catching — a fistful, a gap, another fistful — so the stream is
 * **modulated** rather than emitted.
 *
 * Not a sine, which was the first thing tried and is still a rope, just a lumpy one: the gaps have
 * to be gaps. It is a two-state clock. A gust runs for `GUST` seconds at `GUST_RATE` and a lull
 * for `LULL` at `LULL_RATE`, each drawn fresh, so no two bursts are the same length and the
 * pattern never lands on a beat.
 *
 * The lull is not silent. A trickle carries the trail across the gap — at zero the stream visibly
 * *stops*, which reads as the effect being switched off rather than as the flow being uneven, and
 * the player is only ever looking at this out of the corner of an eye.
 *
 * The rates are set so the average over a full cycle is about the old flat 40: a mean gust of 0.3s
 * at 78 and a mean lull of 0.28s at 7 averages 44. The density is unchanged and its *distribution*
 * is the whole change.
 */
const GUST = [0.16, 0.44];
const LULL = [0.14, 0.42];
// Half what they were (78 and 7, averaging 44 a second): the shower read as too thick once a
// share of it started staying on the road behind the car — see GROUND_STAY.
const GUST_RATE = 39;
const LULL_RATE = 3.5;

/**
 * Seconds a note is in the air.
 *
 * Long, and longer than it was: the point is that money *hangs*, and then that it is still lying
 * there when the player looks back. At 1.6s the road behind a getaway was clean again almost as
 * fast as it dirtied.
 */
const LIFE = 2.4;
/**
 * The last fraction of that spent fading, so a note thins out rather than blinking off.
 *
 * Late — a note is solid for nearly three quarters of its life. Fading earlier spends most of the
 * effect at a low alpha, which is the other half of why the first cut was hard to see: the notes
 * were not only small, most of them were half transparent.
 */
const FADE_FROM = 0.74;

/**
 * **A trail on the road.** A share of the notes that come down stay down — `GROUND_STAY` of them,
 * lying where they landed for `GROUND_LINGER` seconds and fading over the last `GROUND_FADE` — so a
 * getaway leaves a line of cash behind it across town rather than a cloud that follows the car.
 * The rest finish their ordinary life and go. Sized against the pool: ~22 notes a second, about
 * half of them staying ~7s, is ~75 on the road on top of ~50 in the air, inside MAX_NOTES.
 */
const GROUND_STAY = 0.5;
const GROUND_LINGER = 7;
const GROUND_FADE = 1.5;

// Paper physics. Gravity well under the sparks' exaggerated 26 and under a real 9.8, drag well
// over: a note launched at 9 u/s covers 9/3.4 = 2.6 units before it stops, which is most of a car
// length behind the bumper and no further.
const GRAVITY = 7.0;
const DRAG = 3.4;
// ...and the same drag on the fall, which is what makes it flutter instead of drop. Without it the
// notes reached terminal speed and rained; with it they sink about a unit a second.
const FALL_DRAG = 2.6;

/**
 * The throw's flip: a note leaves the bumper turning over about its own long axis, a whole number
 * of **half** turns in `FLIP_T` seconds, easing out.
 *
 * A whole number of halves so it always comes out of the flip lying flat — face up on an even
 * count, the pale back up on an odd one. The random-axis tumble this replaced wound down to
 * wherever it happened to stop, which was edge-on a fair share of the time: a 0.02 plate edge-on is
 * nothing at all, and the shower strobed. This spends the edge-on frames in the first half second,
 * while the note is still fast and small against the plume, and none after.
 */
const FLIP_T = 0.5;
const FLIP_HALVES = [1, 3];

/**
 * The falling-leaf swing, which is the whole of what says "paper".
 *
 * Once the flip is done the note rocks side to side across its own width: displaced by
 * `SWING_AMP · sin φ`, tilted so its leading edge lifts at each end of the swing (`SWING_TILT`
 * radians at the extremes), and raised a touch at the ends and dropped through the middle
 * (`SWING_BOB`), which is the scoop a real leaf falls in. `SWING_IN` eases it in after the flip so
 * nothing jumps sideways on the frame the flip ends.
 *
 * About one rock a second. Faster reads as a vibrating card; much slower and the note is on the
 * road before it has swung twice.
 */
const SWING_HZ = [0.8, 1.3];
const SWING_AMP = [0.22, 0.45];
const SWING_TILT = 0.7;
const SWING_BOB = 0.12;
const SWING_IN = 0.3;
/** A slow turn about the vertical while it falls, so the stream is not every note square to the road. */
const YAW_DRIFT = 1.4;
const YAW_DRAG = 0.8;

// How the note is thrown: back out of the tailpipe, a little sideways, a little up. Up *least*,
// for the reason the sparks are: thrown up as hard as they go back, the shower arcs over the roof
// and reads as confetti being fired rather than cash being lost.
//
// The sideways throw is wider than it was (2.4), because the stream is now dense enough that a
// narrow one stacked the notes into a single line down the middle of the lane. At 4.2 the trail is
// about a lane wide, which is what makes it read as a mess being left behind rather than as a rope
// being paid out.
const BACK = [5.5, 11.5];
const SIDE = 4.2;
const UP = [1.6, 4.8];

/**
 * How much of the taxi's own speed a note keeps.
 *
 * Under the sparks' 0.45, and for the same reason turned up a notch: a note is separating from the
 * car, and the whole effect is the car driving out from under what it is dropping. At 0.3 a note
 * drifts forward for about a tenth of a second and is then left behind, which at boost speed puts
 * the whole stream visibly *trailing*.
 */
const NOTE_CARRY = 0.3;

/**
 * A note, in world units. At 7.7px per unit that is a 6.8 x 3.7px rectangle.
 *
 * It has been both too small and too big now, and this is the third setting. It started at 0.62 x
 * 0.34 — 4.8 x 2.6px, about the size of a lane dash, on a road already painted with lane dashes —
 * and went to 1.15 x 0.62 to fix that, which is a *third of the drawn taxi's length*: at that size
 * the notes stop reading as a shower of small things and start reading as a few large ones, and
 * the pale back of one is a bigger bright shape than anything else on the tarmac.
 *
 * What made the bigger size necessary was never the size. It was the density and the alpha (see
 * `GUST` and `FADE_FROM`), and with those fixed the note can come back down to something that
 * looks like paper. Still nowhere near to scale, which is right for this game — the burger on the
 * drive-through sign is 14px across and reads as a burger, and nothing in the city is built to
 * scale either.
 */
const NOTE_L = 0.88;
const NOTE_W = 0.48;

/**
 * How far each half of a note rises off its centre crease, in world units.
 *
 * A note is a shallow **V** rather than a flat card: two quads meeting along the long axis. A flat
 * rectangle has one silhouette — a rectangle — at every angle but edge-on; a folded one changes
 * shape as it rocks, catching one wing and then the other, and that uneven outline is most of what
 * separates "paper" from "confetti" at this size. 0.09 over a half-width of 0.24 is about 20°:
 * enough to see, not so much it reads as a tent.
 */
export const NOTE_FOLD = 0.09;

/**
 * How much of the way to `cashBack` the back of a note is painted.
 *
 * The note is two-sided — `DoubleSide`, with the back picked out by `gl_FrontFacing` — so the back
 * is a real back rather than a colour rolled per instance to fake one. It was 0.7, chosen while the
 * notes were unlit; lit, a near-white card square to the sun is the brightest thing on the road
 * and the shower read as emissive again. At 0.35 the back is a lighter green, not paper-white: the
 * turn still shows, and it no longer flashes.
 */
const BACK_FLIP = 0.35;

/**
 * The spread of the note's own **face**, from `cashNote` *down* to `cashShade`.
 *
 * So that 160 notes are 160 slightly different notes rather than 160 copies of one swatch. It used
 * to run *up*, toward the pale `cashPale`, which was right for an unlit note fighting to be seen on
 * the asphalt and wrong once the notes took the sun: a flat card faces the light square-on, so a
 * lit note already comes out brighter than the bundle beside it in the same green, and a spread
 * toward white on top of that put the whole shower above everything around it. Rolled darker, the
 * brightest note is `cashNote` — the bundles' own green — and the rest sit under it.
 */
const FACE_SPREAD = 1;

/** How far above the tailpipe the stream starts, so it leaves the boot rather than the road. */
const LIFT = 0.15;

/**
 * How far above the road surface a settled note or bundle lies.
 *
 * The floor used to be the *tailpipe* height less `LIFT` — 0.59 above the road — so every note
 * "lying on the road" behind a getaway was hovering at about bumper height. It was invisible while
 * the notes were flat flecks; a bundle landing with a thud half a unit up in the air is not.
 */
const SETTLE = 0.02;

/**
 * How far behind the car's own origin a note appears.
 *
 * `TAXI_TAILPIPE_BACK` is the **drawn** half-length — `createTaxiMesh` puts `TAXI_SCALE` = 1.18 on
 * the group, so the body on screen is 4.01 units where the simulation's `CAR_LEN` says 3.4, and
 * anything placing an effect against the bodywork has to use the drawn one. Emitted at the origin
 * instead, a note starts inside the car and is only carried clear by its own velocity: fine at the
 * Loco top, and at the bottom of a hold it pops out through the roof. game/locoflame.js hangs its
 * plume off the same constant for the same reason.
 */
const TAIL_BACK = TAXI_TAILPIPE_BACK;

// --- The bundles -------------------------------------------------------------------------------

/** Enough for a press's `KICK_BUNDLES` and a stray per gust, twice over, before a slot wraps. */
const MAX_BUNDLES = 16;
/** Thrown by the press alongside the note burst. Three is a handful; more reads as a delivery. */
const KICK_BUNDLES = 2;
/** The chance a gust opens with a bundle of its own, so a long hold keeps dropping the odd brick. */
const GUST_BUNDLE = 0.15;
/** Seconds on the road before it shrinks away, and how long the shrink takes. Long enough to be
 * part of the trail the notes leave — see GROUND_STAY. */
const BUNDLE_LIFE = 7;
const BUNDLE_SHRINK = 0.3;

/**
 * A bundle, in world units: the note's footprint, a stack deep, with a band a quarter of its length
 * round the middle. Slightly bigger than a note so a brick among the loose notes reads as more of
 * the same thing rather than as something else.
 */
export const BRICK_L = 0.92;
export const BRICK_W = 0.5;
export const BRICK_H = 0.26;
const BAND_L = 0.24;
/**
 * How far the band stands proud of the brick. Two coplanar faces shimmer (CLAUDE.md); a band that
 * encloses the brick by this much on the four faces it wraps never shares a plane with it, and its
 * two end faces are buried inside the brick where nothing can see them.
 */
const BAND_PROUD = 0.015;

// Brick physics: heavy, which is the point of having them. Real gravity and then some, little drag,
// and a bounce — the one thing in either pool that is allowed to bounce, because the thud is the
// read. One bounce at `RESTITUTION`, then it lies down.
const B_GRAVITY = 24;
const B_DRAG = 0.9;
const B_BACK = [3.5, 7.5];
const B_SIDE = 2.6;
const B_UP = [3.5, 6];
const B_SPIN = [6, 11];
const RESTITUTION = 0.32;
/** A landing slower than this does not bounce, it stops. */
const BOUNCE_MIN = 2.2;
/** How quickly a landed brick flops flat and how quickly it stops sliding, both per second. */
const FLOP = 16;
const SLIDE = 5;

/**
 * A folded note: two quads meeting along the long (x) axis at y = 0, each wing rising `NOTE_FOLD`
 * to its outer edge, in a unit footprint the instance matrix scales to size.
 *
 * Wound so **+y is the front** — the green face — and `tools/probe.mjs` asserts it from the
 * winding. With `DoubleSide` a reversed triangle would not vanish, it would silently swap which
 * side is green, so a note face-up on the road would show its back.
 */
export function noteGeometry() {
  const F = NOTE_FOLD;
  const a0 = [-0.5, 0, 0];
  const a1 = [0.5, 0, 0];
  const n0 = [-0.5, F, 0.5];
  const n1 = [0.5, F, 0.5];
  const s0 = [-0.5, F, -0.5];
  const s1 = [0.5, F, -0.5];
  const tris = [
    a0, n0, a1, a1, n0, n1,      // the +z wing
    s0, a0, s1, s1, a0, a1,      // the -z wing
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  // Non-indexed, so this is one normal per face — the wing's own — and not a laundering average.
  geometry.computeVertexNormals();
  return geometry;
}

/** A brick of notes with a paper band round its middle, vertex-coloured for `propMaterial`. */
export function bundleGeometry() {
  const brick = bakeColor(new THREE.BoxGeometry(BRICK_L, BRICK_H, BRICK_W), color('cashNote'));
  const band = bakeColor(
    new THREE.BoxGeometry(BAND_L, BRICK_H + 2 * BAND_PROUD, BRICK_W + 2 * BAND_PROUD),
    color('cashBand'),
  );
  return mergeGeometries([brick, band], false);
}

export function createCashTrail(scene, rng) {
  const geometry = noteGeometry();

  const alphas = new Float32Array(MAX_NOTES);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));

  // White, so `instanceColor` multiplies cleanly onto it — the same identity dust.js and sparks.js
  // rely on. **Not** additive: additive blending is for things that emit, and a banknote reflects.
  // Over dark asphalt an additive note came out as a glowing sliver.
  //
  // Lit, and **not** `flatShading` the way dust.js is. A note is two-sided, and a flat-shaded
  // normal comes from a screen-space derivative that points into the screen on a back face, so
  // every note showing its back would light as if the sun were behind it (CLAUDE.md). With real
  // per-face normals Three flips them for the back face itself.
  const material = new THREE.MeshLambertMaterial({
    color: '#FFFFFF',
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  // The back, in the same linear working space `diffuseColor` is in by the time it is mixed.
  const BACK_COL = color('cashBack');
  const back = `vec3(${BACK_COL.r.toFixed(4)}, ${BACK_COL.g.toFixed(4)}, ${BACK_COL.b.toFixed(4)})`;
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <color_fragment>',
        `#include <color_fragment>\n\tif (!gl_FrontFacing) diffuseColor.rgb = mix(diffuseColor.rgb, ${back}, ${BACK_FLIP.toFixed(2)});`)
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a *= vAlpha;');
  };
  // The back colour is baked into the source as a literal, so the default cache key — the patch
  // function's own text — would not change if the palette did. Key off the literal as well.
  material.customProgramCacheKey = () => `cashnote:${back}:${BACK_FLIP}`;

  const mesh = skipWhenEmpty(new THREE.InstancedMesh(geometry, material, MAX_NOTES));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Under the flames and sparks (6) and over the road: a note passes *through* the Loco plume it is
  // being thrown out beside, and the plume is the brighter thing.
  mesh.renderOrder = 5;
  // The pool moves, and three latches an InstancedMesh's bounding sphere on the first frame it
  // culls one — from the matrices as they stood then. A pool that is empty at that moment (which
  // this one always is at boot: no robbery has happened) latches a radius of -1 at the origin and
  // never draws again.
  mesh.frustumCulled = false;
  scene.add(mesh);

  const life = new Float32Array(MAX_NOTES);
  const age = new Float32Array(MAX_NOTES);
  const px = new Float32Array(MAX_NOTES);
  const py = new Float32Array(MAX_NOTES);
  const pz = new Float32Array(MAX_NOTES);
  const vx = new Float32Array(MAX_NOTES);
  const vy = new Float32Array(MAX_NOTES);
  const vz = new Float32Array(MAX_NOTES);
  // Orientation, as a heading about the vertical and a roll about the note's own long axis. The
  // roll is the flip plus the swing's tilt; nothing else about a falling leaf needs a third angle.
  const yaw = new Float32Array(MAX_NOTES);
  const yawRate = new Float32Array(MAX_NOTES);
  const flip = new Float32Array(MAX_NOTES);         // total roll the throw's flip lands on, k·π
  const phase = new Float32Array(MAX_NOTES);
  const freq = new Float32Array(MAX_NOTES);         // rad/s
  const amp = new Float32Array(MAX_NOTES);          // 0 once landed: the swing is baked into px/pz
  const stays = new Uint8Array(MAX_NOTES);          // 1 for a note lying on as part of the trail
  // The surface this note settles onto, so a getaway over a bridge lands on the deck rather than
  // on the road two units under it. Same reason sparks.js carries one.
  const floor = new Float32Array(MAX_NOTES);

  const dummy = new THREE.Object3D();
  dummy.rotation.order = 'YXZ';                     // heading first, then the roll about the note's own axis
  const tint = new THREE.Color();
  const FACE = color('cashNote');
  const SHADE = color('cashShade');

  // Collapsed and painted up front: `setColorAt` allocates `instanceColor` on its first call and
  // recompiles the material, and doing that lazily would put a shader compile on the first frame
  // of a getaway — which is the one frame in this event that cannot afford one.
  for (let slot = 0; slot < MAX_NOTES; slot++) {
    dummy.scale.setScalar(0);
    dummy.updateMatrix();
    mesh.setMatrixAt(slot, dummy.matrix);
    mesh.setColorAt(slot, FACE);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);

  // --- The bundle pool ---
  const bundleMesh = skipWhenEmpty(new THREE.InstancedMesh(bundleGeometry(), propMaterial({ ao: false }), MAX_BUNDLES));
  bundleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  bundleMesh.frustumCulled = false;                 // same reason as the notes
  // **No shadow**, and that was tried. A brick is 0.26 tall, so at golden hour its shadow lands
  // most of two units off its own base, detached by the sun's `normalBias`: a dark smudge on the
  // road with nothing visibly above it, which reads as a rendering fault rather than as weight.
  scene.add(bundleMesh);

  const bLife = new Float32Array(MAX_BUNDLES);
  const bx = new Float32Array(MAX_BUNDLES);
  const by = new Float32Array(MAX_BUNDLES);
  const bz = new Float32Array(MAX_BUNDLES);
  const bvx = new Float32Array(MAX_BUNDLES);
  const bvy = new Float32Array(MAX_BUNDLES);
  const bvz = new Float32Array(MAX_BUNDLES);
  const bSpin = new Float32Array(MAX_BUNDLES);
  const bBounces = new Uint8Array(MAX_BUNDLES);
  const bLanded = new Uint8Array(MAX_BUNDLES);
  const bFloor = new Float32Array(MAX_BUNDLES);
  const bAxis = Array.from({ length: MAX_BUNDLES }, () => new THREE.Vector3());
  const bQuat = Array.from({ length: MAX_BUNDLES }, () => new THREE.Quaternion());
  const bFlat = Array.from({ length: MAX_BUNDLES }, () => new THREE.Quaternion());
  const bDummy = new THREE.Object3D();
  const step = new THREE.Quaternion();
  const longAxis = new THREE.Vector3();
  const UP_AXIS = new THREE.Vector3(0, 1, 0);

  for (let slot = 0; slot < MAX_BUNDLES; slot++) {
    bDummy.scale.setScalar(0);
    bDummy.updateMatrix();
    bundleMesh.setMatrixAt(slot, bDummy.matrix);
  }
  bundleMesh.instanceMatrix.needsUpdate = true;

  let next = 0;
  let nextBundle = 0;
  let pending = 0;      // fractional notes owed, so the rate survives a variable frame length
  // The gust clock — see GUST. `left` counts the current phase down; a hold that ends resets both,
  // so the next press opens on a gust rather than half way through whatever the last one was in.
  let gusting = true;
  let left = 0;
  // Set by `turnover` when a gust opens with a bundle; paid by `feed`, which has the car.
  let bundleOwed = false;

  /** Start the next phase, and answer the rate it runs at. */
  function turnover() {
    gusting = !gusting;
    const span = gusting ? GUST : LULL;
    left = rng.range(span[0], span[1]);
    if (gusting && rng.chance(GUST_BUNDLE)) bundleOwed = true;
    return gusting ? GUST_RATE : LULL_RATE;
  }

  /**
   * Where a throw leaves from, and the car's frame. `yaw` is a sim heading, so forward is
   * (cos yaw, -sin yaw) and right is (sin yaw, cos yaw).
   *
   * `y` is what main.js passes — the tailpipe height over the surface the car is on — and the floor
   * is recovered from it here rather than changing both call sites' contract.
   */
  function frame(carYaw) {
    return { fx: Math.cos(carYaw), fz: -Math.sin(carYaw), rx: Math.sin(carYaw), rz: Math.cos(carYaw) };
  }
  const floorFrom = (y) => y - TAXI_TAILPIPE_HEIGHT + ROAD_Y + SETTLE;

  /** One note, thrown out of the back of a car at (x, y, z) heading `carYaw` at `speed` u/s. */
  function emit(x, y, z, carYaw, speed) {
    const slot = next;
    next = (next + 1) % MAX_NOTES;

    const { fx, fz, rx, rz } = frame(carYaw);
    const carry = carrySpeed(speed) * NOTE_CARRY;

    const backV = rng.range(BACK[0], BACK[1]);
    const side = rng.jitter(SIDE);
    const up = rng.range(UP[0], UP[1]);

    life[slot] = LIFE * rng.range(0.8, 1.2);
    age[slot] = 0;
    px[slot] = x - fx * TAIL_BACK + rng.jitter(0.18);
    py[slot] = y + LIFT;
    pz[slot] = z - fz * TAIL_BACK + rng.jitter(0.18);
    vx[slot] = -fx * backV + rx * side + fx * carry;
    vy[slot] = up;
    vz[slot] = -fz * backV + rz * side + fz * carry;
    floor[slot] = floorFrom(y);

    yaw[slot] = rng.range(0, Math.PI * 2);
    yawRate[slot] = rng.jitter(YAW_DRIFT);
    flip[slot] = Math.PI * rng.int(FLIP_HALVES[0], FLIP_HALVES[1]) * (rng.chance(0.5) ? 1 : -1);
    phase[slot] = rng.range(0, Math.PI * 2);
    freq[slot] = Math.PI * 2 * rng.range(SWING_HZ[0], SWING_HZ[1]);
    amp[slot] = rng.range(SWING_AMP[0], SWING_AMP[1]);
    stays[slot] = 0;

    // Along the greens, down from `cashNote` toward `cashShade` — see FACE_SPREAD.
    const t = rng.next();
    mesh.setColorAt(slot, tint.copy(FACE).lerp(SHADE, t * FACE_SPREAD));
    alphas[slot] = 1;
  }

  /** One wrapped bundle, thrown heavier and lower than a note. */
  function emitBundle(x, y, z, carYaw, speed) {
    const slot = nextBundle;
    nextBundle = (nextBundle + 1) % MAX_BUNDLES;

    const { fx, fz, rx, rz } = frame(carYaw);
    const carry = carrySpeed(speed) * NOTE_CARRY;
    const backV = rng.range(B_BACK[0], B_BACK[1]);
    const side = rng.jitter(B_SIDE);

    bLife[slot] = BUNDLE_LIFE * rng.range(0.85, 1.15);
    bx[slot] = x - fx * TAIL_BACK;
    by[slot] = y + LIFT;
    bz[slot] = z - fz * TAIL_BACK;
    bvx[slot] = -fx * backV + rx * side + fx * carry;
    bvy[slot] = rng.range(B_UP[0], B_UP[1]);
    bvz[slot] = -fz * backV + rz * side + fz * carry;
    bFloor[slot] = floorFrom(y) + BRICK_H / 2;
    bBounces[slot] = 1;
    bLanded[slot] = 0;

    const axis = bAxis[slot].set(rng.jitter(1), rng.jitter(1), rng.jitter(1));
    if (axis.lengthSq() < 1e-6) axis.set(0, 0, 1);
    axis.normalize();
    bSpin[slot] = rng.range(B_SPIN[0], B_SPIN[1]) * (rng.chance(0.5) ? 1 : -1);
    bQuat[slot].setFromAxisAngle(UP_AXIS, rng.range(0, Math.PI * 2));
  }

  /**
   * The burst the press throws, on top of whatever the hold goes on to feed.
   *
   * Fired from `kickLocoMode` in main.js alongside the tailpipe flame and the launch rubber, so the
   * three are one event on one frame. A stream that only ramps up has nothing to say on the frame
   * the button actually went down, and that is the frame the player is looking at.
   */
  function kick(car, y) {
    if (!car || car.crashed) return;
    for (let k = 0; k < KICK; k++) emit(car.x, y, car.z, car.yaw, car.v);
    for (let k = 0; k < KICK_BUNDLES; k++) emitBundle(car.x, y, car.z, car.yaw, car.v);
  }

  /**
   * Feed the stream for one frame.
   *
   * `on` is the whole gate — the caller decides what it means, and `main.js` reads it as "the pill
   * is held and there is a robber in the back". Rate-limited on a fractional accumulator rather
   * than a per-frame count, so the stream is the same density at 30fps as at 120.
   *
   * @param car the taxi, for `x`/`z`/`yaw`/`v`
   * @param y   the tailpipe's height over the surface it is driving on
   */
  function feed(dt, on, car, y) {
    if (!on || !car || car.crashed) {
      // Reset the clock as well as the accumulator. A hold that ends mid-lull and is pressed again
      // a moment later would otherwise open on the quiet half, and the frame the button goes down
      // is the one frame this effect cannot be quiet on. (The `KICK` covers that frame regardless,
      // but a kick followed by nothing is worse than no kick at all.)
      pending = 0;
      gusting = false;
      left = 0;
      bundleOwed = false;
      return;
    }
    // Note the order this is called in relative to `update`: **feed first**. A note's instance
    // matrix is only written by the update pass, so a stream fed after it would put every note on
    // screen one frame late — which at the Loco top is 0.57 units of road, and reads as the trail
    // starting a car length back from the bumper.
    //
    // The frame is spent phase by phase rather than at one rate, so a gust that ends mid-frame is
    // paid at its own rate for the part of the frame it covered. At 60fps a frame is 16ms against
    // a phase of 140ms and up, so this loop runs once nearly every time — it is there so that a
    // long stalled frame does not silently swallow a whole gust.
    let rest = dt;
    while (rest > 0) {
      if (left <= 0) turnover();
      const slice = Math.min(rest, left);
      pending += (gusting ? GUST_RATE : LULL_RATE) * slice;
      left -= slice;
      rest -= slice;
    }
    // Capped at the pool, so a long stalled frame cannot spend every slot on one tick and leave
    // the stream empty for the whole of the next second.
    const count = Math.min(MAX_NOTES, Math.floor(pending));
    pending -= count;
    for (let k = 0; k < count; k++) emit(car.x, y, car.z, car.yaw, car.v);
    if (bundleOwed) {
      bundleOwed = false;
      emitBundle(car.x, y, car.z, car.yaw, car.v);
    }
  }

  function updateNotes(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_NOTES; slot++) {
      if (life[slot] <= 0) continue;
      touched = true;

      life[slot] -= dt;
      age[slot] += dt;
      const spent = 1 - Math.max(0, life[slot]) / LIFE;    // 0 fresh, 1 spent

      // Exponential rather than subtractive on both axes, so a long frame cannot push a note
      // backwards through zero — and on the vertical too, which is what makes this a flutter
      // rather than a fall.
      const keep = Math.exp(-DRAG * dt);
      vx[slot] *= keep;
      vz[slot] *= keep;
      vy[slot] = (vy[slot] - GRAVITY * dt) * Math.exp(-FALL_DRAG * dt);

      px[slot] += vx[slot] * dt;
      py[slot] += vy[slot] * dt;
      pz[slot] += vz[slot] * dt;

      yawRate[slot] *= Math.exp(-YAW_DRAG * dt);
      yaw[slot] += yawRate[slot] * dt;

      // The flip, easing out onto a whole number of half turns — see FLIP_T.
      const f = Math.min(1, age[slot] / FLIP_T);
      let roll = flip[slot] * (1 - (1 - f) ** 3);
      // ...and the swing, easing in behind it — see SWING_*. The swing axis is the note's own
      // width: (sin yaw, cos yaw) is where local +z lands after the heading.
      const env = amp[slot] > 0
        ? Math.min(1, Math.max(0, (age[slot] - FLIP_T) / SWING_IN))
        : 0;
      const s = Math.sin(phase[slot] + freq[slot] * age[slot]);
      const sway = amp[slot] * s * env;
      const dx = Math.sin(yaw[slot]) * sway;
      const dz = Math.cos(yaw[slot]) * sway;
      // A positive roll about +x drops the +z edge, so the tilt runs against the displacement: at
      // the +z end of the swing the +z edge is the leading one, and it lifts.
      roll -= SWING_TILT * s * env;
      const bob = SWING_BOB * s * s * env;

      // Settles rather than bounces. A banknote that hit the road and came back up would be the
      // one thing in this pool that reads as rubber. The swing is baked into the position and
      // switched off, and the note lies down on whichever side the flip left up.
      if (py[slot] <= floor[slot] && amp[slot] > 0) {
        py[slot] = floor[slot];
        px[slot] += dx;
        pz[slot] += dz;
        vx[slot] = 0;
        vy[slot] = 0;
        vz[slot] = 0;
        yawRate[slot] = 0;
        amp[slot] = 0;
        age[slot] = Math.max(age[slot], FLIP_T);
        // Part of the trail now, or not — see GROUND_STAY.
        if (rng.chance(GROUND_STAY)) {
          stays[slot] = 1;
          life[slot] = GROUND_LINGER * rng.range(0.8, 1.2);
        }
      }
      const landed = amp[slot] === 0;
      // Back-up, the wings point *down*, so the crease has to sit a fold's height up or the tips go
      // through the road.
      const backUp = Math.round(Math.abs(flip[slot]) / Math.PI) % 2 === 1;

      // Held at full until FADE_FROM, so a note is solid for most of its flight and only thins as
      // it reaches the ground. Fading from birth makes the whole stream look like smoke.
      alphas[slot] = stays[slot]
        ? Math.min(1, Math.max(0, life[slot]) / GROUND_FADE)
        : spent < FADE_FROM ? 1 : 1 - (spent - FADE_FROM) / (1 - FADE_FROM);

      if (life[slot] <= 0) {
        alphas[slot] = 0;
        dummy.scale.setScalar(0);
      } else {
        dummy.position.set(
          px[slot] + (landed ? 0 : dx),
          py[slot] + (landed ? (backUp ? NOTE_FOLD : 0) : bob),
          pz[slot] + (landed ? 0 : dz),
        );
        dummy.rotation.set(landed ? flip[slot] : roll, yaw[slot], 0);
        dummy.scale.set(NOTE_L, 1, NOTE_W);
      }
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);
    }

    if (touched) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      geometry.getAttribute('aAlpha').needsUpdate = true;
    }
  }

  function updateBundles(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_BUNDLES; slot++) {
      if (bLife[slot] <= 0) continue;
      touched = true;

      if (!bLanded[slot]) {
        const keep = Math.exp(-B_DRAG * dt);
        bvx[slot] *= keep;
        bvz[slot] *= keep;
        bvy[slot] -= B_GRAVITY * dt;
        step.setFromAxisAngle(bAxis[slot], bSpin[slot] * dt);
        bQuat[slot].premultiply(step);
      } else {
        // Lying down: slide to a stop and flop flat onto its broad face.
        const keep = Math.exp(-SLIDE * dt);
        bvx[slot] *= keep;
        bvz[slot] *= keep;
        bQuat[slot].slerp(bFlat[slot], 1 - Math.exp(-FLOP * dt));
        bLife[slot] -= dt;                            // the clock only runs once it is on the road
      }

      bx[slot] += bvx[slot] * dt;
      by[slot] += bvy[slot] * dt;
      bz[slot] += bvz[slot] * dt;

      if (by[slot] <= bFloor[slot] && !bLanded[slot]) {
        by[slot] = bFloor[slot];
        if (bBounces[slot] > 0 && -bvy[slot] > BOUNCE_MIN) {
          // The thud: one bounce, most of the energy gone, and it comes off turning slower.
          bBounces[slot] -= 1;
          bvy[slot] = -bvy[slot] * RESTITUTION;
          bvx[slot] *= 0.6;
          bvz[slot] *= 0.6;
          bSpin[slot] *= 0.5;
        } else {
          bvy[slot] = 0;
          bLanded[slot] = 1;
          // Flat on its broad face, keeping whatever heading its long axis had when it landed.
          longAxis.set(1, 0, 0).applyQuaternion(bQuat[slot]);
          bFlat[slot].setFromAxisAngle(UP_AXIS, Math.atan2(-longAxis.z, longAxis.x));
        }
      }

      // Shrinks away rather than fading: the material is a solid prop, and a brick going
      // translucent would be the one see-through thing on the road.
      const k = bLife[slot] <= 0 ? 0 : Math.min(1, bLife[slot] / BUNDLE_SHRINK);
      bDummy.position.set(bx[slot], by[slot], bz[slot]);
      bDummy.quaternion.copy(bQuat[slot]);
      bDummy.scale.setScalar(k);
      bDummy.updateMatrix();
      bundleMesh.setMatrixAt(slot, bDummy.matrix);
    }
    if (touched) bundleMesh.instanceMatrix.needsUpdate = true;
  }

  function update(dt) {
    updateNotes(dt);
    updateBundles(dt);
  }

  /** How many notes are in the air, for the tools. */
  const live = () => {
    let n = 0;
    for (let slot = 0; slot < MAX_NOTES; slot++) if (life[slot] > 0) n += 1;
    return n;
  };
  /** How many bundles are out, for the tools. */
  const bundles = () => {
    let n = 0;
    for (let slot = 0; slot < MAX_BUNDLES; slot++) if (bLife[slot] > 0) n += 1;
    return n;
  };
  /** Where each live bundle is, and whether it has come to rest — for the tools. */
  const bundleState = () => {
    const out = [];
    for (let slot = 0; slot < MAX_BUNDLES; slot++) {
      if (bLife[slot] > 0) out.push({ y: by[slot], floor: bFloor[slot], landed: !!bLanded[slot] });
    }
    return out;
  };
  /** Where each live note is resting, for the tools: `null` while it is still in the air. */
  const noteRest = () => {
    const out = [];
    for (let slot = 0; slot < MAX_NOTES; slot++) {
      if (life[slot] > 0 && amp[slot] === 0) out.push(py[slot]);
    }
    return out;
  };

  return { mesh, bundleMesh, feed, kick, update, live, bundles, bundleState, noteRest };
}
