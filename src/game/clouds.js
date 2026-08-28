import * as THREE from 'three';
import { RIGHT, VIEW_UP, VIEW_DIR } from './camera.js';
import { SLAB, EDGE_FADE } from '../city/ground.js';
import { HALF_SPAN } from '../city/grid.js';
import { SKYLINE_CEILING } from '../city/buildings.js';
import { PALETTE } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';
import { createCloudGeometry } from '../geometry/cloud.js';

// Weather. A dozen low-poly cumulus drifting past the city on one wind, and the whole of the
// module's difficulty is in one rule: **a cloud must never come over the map you drive on.** The
// camera is fixed and looks down a 33° diagonal, so anything in the air is drawn over whatever
// ground is up-screen of it — a cloud over the middle of the map sits on the taxi, and the taxi is
// the one thing on screen the player is tracking.
//
// So they ride the island's own coastline, which is also where the sky is: at play zoom the island
// is 221 x 120 on screen against a frame 104 tall, so what the player sees of the sky is the wedge
// between the map's edge and the corner of the frame, and 91% of that wedge is within 30 units of
// the edge. They come *in* over it by design (see `OVERLAP`) — a cloud whose lower edge veils the
// outermost ring of asphalt is in the picture rather than beside it — and the line they never cross
// is the ring road, `INNER_KEEP_OUT` below.
//
// It lives in `game/` beside the flyover and the flocks and on the same terms: pure scenery, not
// routed, not collidable, not tappable, and nothing in the fare loop or the difficulty curve knows
// it exists. Like the aeroplane it reads the camera's own basis directly — which here is not a
// convenience but the entire mechanism.
//
// --- Authored on the screen, solved in the world ----------------------------------------------
//
// "Over the city" is a fact about the *picture*, not about the world. Under this orthographic
// camera a world-Y lift buys 0.838 of a unit up the screen (`SCREEN_PER_WORLD_Y`) and nothing else
// — no parallax, no perspective, nothing that moves when the player pans — so a cloud at altitude
// 60 over the middle of the map is *drawn* 50 units up-screen of it, sitting on the far edge's
// skyline. Reasoning about that in world coordinates means carrying a 50-unit shear through every
// comparison and getting it wrong once.
//
// So a cloud is authored by where it sits **on screen** — `RIGHT` and `VIEW_UP` from
// game/camera.js are the camera's own axes and the projection along them is linear — and
// `worldAt()` solves for the world position that draws it there. Altitude falls out as a free
// parameter rather than being an input: see `ALTITUDE`.

const _p = new THREE.Vector3();

/**
 * Where a world point lands on the screen, in world units: `sx` across the frame, `sy` up it.
 * Measured from the world origin rather than the camera's target — the camera pans, and a cloud's
 * only argument is with the city, which does not.
 */
export function screenOf(x, y, z, out = { sx: 0, sy: 0 }) {
  _p.set(x, y, z);
  out.sx = _p.dot(RIGHT);
  out.sy = _p.dot(VIEW_UP);
  return out;
}

/**
 * The inverse. `RIGHT`, `VIEW_UP` and `VIEW_DIR` are an orthonormal basis — the camera's own — so
 * the world point that draws at `(sx, sy)` is just those three axes summed, with `standoff` the
 * third coordinate: how far the point floats **towards the camera** from the plane through the
 * world origin. `screenOf` above is exactly the first two components of the same change of basis.
 *
 * That third axis is invisible under an orthographic projection and is not therefore free — see
 * `standoffFor`.
 */
export function worldAt(sx, sy, standoff, out = new THREE.Vector3()) {
  return out.set(0, 0, 0)
    .addScaledVector(RIGHT, sx)
    .addScaledVector(VIEW_UP, sy)
    .addScaledVector(VIEW_DIR, standoff);
}

/**
 * How far towards the camera a cloud has to float to be flying at `alt` while it is *drawn* at
 * `sy` up the frame — clamped to the band that keeps it in the frustum whatever the camera does.
 *
 * The clamp is not tidiness. View-space depth is measured from the camera's **target**, which
 * follows the taxi, and a target at the map's far corner is 59 units further down the view axis
 * than one at the middle. A cloud drawn below the island has to be a long way towards the camera to
 * be up in the air at all — the island is 120 units tall on screen, and getting under it costs
 * 1.54 units of standoff per unit of drop — so the first version of this put the low ones at 35
 * units of depth with the camera parked at the origin, which is **behind the camera** by the time
 * the player drives to the far corner. They vanished, and only from one end of the map.
 *
 * `STANDOFF_MAX` therefore leaves 60 units of depth in hand after the worst pan, and the price is
 * paid where it cannot be seen: a cloud that wanted to be at 80 and is drawn low ends up flying at
 * 46 instead. `STANDOFF_MIN` of zero keeps every cloud in front of the middle of the city, which is
 * what holds the haze on them down to a few percent.
 */
const STANDOFF_MIN = 0;
const STANDOFF_MAX = 275;

export function standoffFor(sy, alt) {
  const q = (alt - VIEW_UP.y * sy) / VIEW_DIR.y;
  return Math.max(STANDOFF_MIN, Math.min(STANDOFF_MAX, q));
}

// --- The city's silhouette --------------------------------------------------------------------

/**
 * How far the ground reaches from the middle of the map: the asphalt slab's own half-width plus
 * the whole of its fade skirt (city/ground.js). Measured at the skirt's outer ring rather than at
 * the slab — the last of the skirt is alpha 0, but a cloud crossing the last few units of it is
 * still a cloud over the edge of the city.
 */
export const CITY_REACH = SLAB / 2 + EDGE_FADE;

/**
 * And how high. `SKYLINE_CEILING` is the ceiling every tower, water tower and mast in the city is
 * built *under* (city/buildings.js), so this covers the tallest skyline any seed can produce
 * rather than the one this run happens to have generated.
 */
export const CITY_TOP = SKYLINE_CEILING;

/**
 * How far out anything is *built*. Nothing stands outside the ring road, so the tall part of the
 * city stops 28 units short of where the ground does.
 */
export const BUILT_REACH = HALF_SPAN;

/**
 * The city as a screen-space keep-out: the corners of **two** boxes, projected — the ground out to
 * its fade skirt, and the built city standing on the middle of it.
 *
 * Boxes rather than the island's real rounded-square outline, and that is deliberate: a box
 * contains the outline, so clearing it clears the city with a little to spare at the corners the
 * arcs cut off. Corners are enough because the projection is linear — the silhouette of a convex
 * body is the hull of its projected corners.
 *
 * **Two boxes rather than one, because one costs 17 units of sky.** Built as a single box 20.5
 * tall out to the fade skirt, the keep-out claimed a skyline standing on the very edge of the
 * island — where in fact there is nothing but empty asphalt — and pushed the whole band up-screen
 * by `0.838 · 20.5` off ground that is 28 units further out than any building. The clouds sat a
 * long way clear of an edge they were supposed to be hugging, in sky the player mostly cannot see.
 */
export const KEEP_OUT = [];
for (const [reach, y] of [[CITY_REACH, 0], [BUILT_REACH, CITY_TOP]]) {
  for (const x of [-reach, reach]) {
    for (const z of [-reach, reach]) KEEP_OUT.push(screenOf(x, y, z, {}));
  }
}

/**
 * The upper and lower chains of the keep-out's convex hull, left to right — Andrew's monotone
 * chain. The two of them *are* the city's outline as the player sees it: at the shipped constants
 * the upper one runs (-110.3, 0) → (0, 60.2) → (110.3, 0) and the lower one mirrors it, which is
 * the diamond a square island makes when it is viewed down its diagonal. The built city never
 * reaches either — a 20.5-tall tower at the ring road projects to 55.7 at the apex, against the far
 * *ground* corner's 60.2 — which is the two-box keep-out above paying for itself.
 */
function hullChains(points) {
  const pts = [...points].sort((a, b) => a.sx - b.sx || a.sy - b.sy);
  const chain = (turn) => {
    const out = [];
    for (const p of pts) {
      while (out.length > 1) {
        const a = out[out.length - 2];
        const b = out[out.length - 1];
        const cross = (b.sx - a.sx) * (p.sy - a.sy) - (b.sy - a.sy) * (p.sx - a.sx);
        if (turn * cross >= 0) out.pop(); else break;
      }
      out.push(p);
    }
    return out;
  };
  return { upper: chain(1), lower: chain(-1) };
}

const { upper: UPPER, lower: LOWER } = hullChains(KEEP_OUT);

/**
 * Every edge of a chain as an infinite line `sy = m·sx + c`.
 *
 * Vertical edges are dropped rather than carried as an infinite slope. The keep-out stacks points
 * in the same column — a square island viewed down its diagonal puts two of its corners at `sx` 0,
 * and the first version of the keep-out (one box, 20.5 tall, out to the fade skirt) put a *pair* at
 * each side as well, ground and parapet. Whether one survives into a chain is a property of the
 * keep-out, and the keep-out is the part of this most likely to be edited. Left in, `m` is
 * `Infinity`, `c` is `-Infinity`, and every evaluation of the envelope comes back `NaN`: the first
 * run of this printed a silhouette of nothing but NaN and put every cloud at the origin.
 */
const linesOf = (chain) => chain.slice(1).flatMap((b, i) => {
  const a = chain[i];
  if (b.sx === a.sx) return [];
  const m = (b.sy - a.sy) / (b.sx - a.sx);
  return [{ m, c: a.sy - m * a.sx }];
});

const UPPER_LINES = linesOf(UPPER);
const LOWER_LINES = linesOf(LOWER);

// Where the silhouette is at its widest — the height a cloud passing *beside* the island rides at,
// rather than following the outline down to a point. Read off the chains rather than typed: it is
// the end of both of them, being the leftmost and rightmost hull vertex.
const WEDGE_TOP = Math.max(UPPER[0].sy, UPPER[UPPER.length - 1].sy);
const WEDGE_BOTTOM = Math.min(LOWER[0].sy, LOWER[LOWER.length - 1].sy);

/**
 * How hard the corners of that outline are rounded off, in screen units.
 *
 * The outline has three kinks in each chain — the apex over the far corner, and the two shoulders
 * where it stops following the island and carries on out past its side — and a cloud tracking it
 * exactly would change direction at each of them in a single frame. The polynomial smooth-min
 * below spends this many units blending across each, which at the apex works out as a 26-unit arc:
 * the two edges differ in slope by `1.09` per unit of `sx`, so they are within `ROUND` of each
 * other for ±12.8 either side of it.
 *
 * It is also a cost: smoothing a *concave* corner cuts inward, by up to `ROUND * 0.25`, and every
 * unit of that comes out of the gap between the cloud and the city. `height()` hands it straight
 * back, and `tools/probe.mjs` asserts that what it hands back covers the deepest bite.
 */
export const ROUND = 14;

/** The usual polynomial smooth-min: `min(a, b)`, with the corner rounded off over `k`. */
function smin(a, b, k) {
  const h = Math.max(0, k - Math.abs(a - b)) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

const smax = (a, b, k) => -smin(-a, -b, k);

/**
 * The top of the city's silhouette at a given place across the frame, rounded.
 *
 * `smin` over the upper chain's *infinite* lines is exactly the concave envelope those edges make
 * between the hull's ends, and `smax` against `WEDGE_TOP` is what happens beyond them: past the
 * island's left and right corners the outline would dive away to nothing, and what is wanted there
 * is a cloud carrying straight on past the map's side at the height of its widest point. That
 * clamp is the whole reason this is a function of `sx` rather than a straight lane — see the note
 * on `LIMIT`.
 */
export function silhouetteTop(sx) {
  let sy = Infinity;
  for (const line of UPPER_LINES) sy = smin(sy, line.m * sx + line.c, ROUND);
  return smax(sy, WEDGE_TOP, ROUND);
}

export function silhouetteBottom(sx) {
  let sy = -Infinity;
  for (const line of LOWER_LINES) sy = smax(sy, line.m * sx + line.c, ROUND);
  return smin(sy, WEDGE_BOTTOM, ROUND);
}

// --- The band the clouds ride -----------------------------------------------------------------
//
// A cloud holds a fixed height **above the silhouette** rather than a fixed height on screen, and
// tracks it as it drifts across. That is the one decision in here worth arguing about, because the
// obvious design — a straight lane, a wind blowing down it, clouds wrapping round — was built
// first and is wrong in a way that only shows up when you measure it.
//
// A straight lane clears the city only if the *whole line* clears it, and the set of lines that do
// covers exactly half the map's perimeter: with the wind down world +X the lanes hug the two
// z-facing edges, and every line that could reach the sky beside the other two passes over the
// city on its way. So the sky outside the east and west edges was permanently cloudless — measured
// on that build as 0.13 clouds in frame on a portrait phone against 1.04 on a desktop, with 83% of
// portrait frames showing sky and nothing in it. Riding the outline instead puts weather round the whole
// island, and every cloud still travels the same way across the screen, which is what a straight
// lane was bought for in the first place.

/**
 * How far the bottom of a cloud's own box is allowed to sink **below** the city's silhouette,
 * before the band spread pushes it back out.
 *
 * It shipped as a *clearance* — 2 units of sky held between the two — and 91% of the sky the player
 * can see sits within 30 units of the island's edge, so that was already as tight as standing clear
 * can be. Coming in over the coast is the other side of the same argument: a cloud that overlaps the
 * outermost ring of asphalt is a cloud in the *picture* rather than beside it, and what makes it
 * safe is that the box is a long way outside the drawn shape — the fade has dissolved the lower rim
 * long before its bounding box ends, so 20 units of box is about 14 units of visible veil — which
 * at the map's far corner reaches the outer half of the ring road and stops.
 *
 * The ceiling on it is the **inner keep-out** below, not this number: the weather may hang over the
 * coast and it may never come over the middle of the map. `tools/probe.mjs` asserts both ends.
 */
const OVERLAP = 20;

/** How deep the band beyond that is — the spread that stops the clouds reading as a hedge. */
const BAND = 12;

/**
 * The part of the city the weather may never reach, whatever the overlap is set to: **the ground
 * the player drives on**, out to the ring road's own centreline.
 *
 * At ground level and not at skyline height, and that is the distinction the whole overlap rests
 * on. A cloud coming in over the map's far corner covers everything up-screen of its lower edge,
 * and at this camera the *top of a tall tower* on the ring road projects to almost exactly where
 * the island's outer edge does — 55.8 against 60.2 — so any veil over the coast at all is a veil
 * over the roofs behind it. That costs nothing: nothing is played on a roof. Ground is different,
 * and this is the line it draws.
 */
export const INNER_REACH = HALF_SPAN;

export const INNER_KEEP_OUT = [];
for (const x of [-INNER_REACH, INNER_REACH]) {
  for (const z of [-INNER_REACH, INNER_REACH]) INNER_KEEP_OUT.push(screenOf(x, 0, z, {}));
}

/**
 * How far across the frame a cloud travels before it wraps back to the other side, and the fade at
 * each end of that.
 *
 * Same belt-and-braces as the flyover's run margin: the length is what puts the wrap off the edge
 * of any framing the game allows — the camera's target reaches `sx` ±71 at the map's corners and
 * a 16:9 desktop frame is ±83 wide at play zoom, so ±200 clears it — and the fade is what turns a
 * pop into a soft arrival on some viewport shape nobody anticipated. It is also why the silhouette
 * is clamped past the island's shoulders rather than followed down: the last 90 units of the run
 * are out beyond the map's side, and a cloud has to be *somewhere* sensible out there.
 */
const LIMIT = 200;
const FADE_BAND = 40;

/**
 * Drift speed, in screen units a second.
 *
 * A fourteenth of what a car does, and the whole of the reasoning is that a cloud has no scale of
 * its own: the eye reads its speed against the frame it is crossing, and the frame is 140 units
 * wide on a desktop and 48 on a phone. At the 1.5-2.6 this shipped with — already a quarter of
 * ambient traffic — a cloud crossed a phone's frame in under half a minute and read as *scudding*.
 * At 0.7 it takes two minutes to cross a desktop frame and a little over one to cross a phone's,
 * which is weather rather than a vehicle.
 */
const SPEED = [0.5, 0.9];

/**
 * Cruise altitude. **Nothing about the picture moves when this does** — the placement solves for
 * whatever world position draws the cloud where it is wanted — so what it actually sets is the
 * haze: view-space depth stops being a function of screen height the moment something leaves the
 * ground (see the notes on `hazeRange` in game/scene.js), and lifting a cloud brings it *towards*
 * the camera out of the air the far city is sitting behind. Measured over a run at the shipped
 * band: depth 125-375 with the camera at the middle of the map, and never under 66 after the worst
 * pan, against a frame that runs 320 at its bottom edge to 480 at its top — so a cloud wears at most
 * 2.3% of haze where the top of the frame behind it wears 17%. Which is the right way
 * round for something 60 units nearer the camera, and the reason the number is up here rather than
 * at 20.
 */
const ALTITUDE = [76, 102];

/** The long axis of a cloud, how tall it stands relative to that, and how far off the wind it lies. */
const SPAN = [26, 46];
const HEIGHT_RATIO = 0.3;
const YAW_JITTER = 0.22;

/**
 * How many are up at once, and how many exist. See `setCount`.
 *
 * Ten of them put four and a half in frame at a time on a 16:9 desktop once the band came in over
 * the coast — that overlap raised what is *visible* by half again without adding a single cloud,
 * since the band moved from the sky nobody looks at to the sky everybody does. Five is about two in
 * frame there, which is what the sky wants: enough that there is weather, few enough that it is
 * still sky. It reads thinner on a phone by exactly the ratio of the two frames — 0.8 in view,
 * against 2.2 — and that is the right way round, since a phone's frame is mostly city.
 */
const COUNT = 5;
const POOL = 28;

// --- What colour the light is ------------------------------------------------------------------
//
// The clouds' tint is a **function of the sky**, for the reason `hazeColor` is: a colour picked at
// golden hour and left alone is a white cloud hanging in a midnight sky. `game/daylight.js` calls
// this on every keyframe change, so the two can never drift apart.
//
// It is the dome's own gradient sampled between the horizon and the zenith, most of its chroma
// taken out, and its lightness pulled up a gamma curve — which is the whole trick. A cloud is
// brighter than the sky it is in at every hour of the day, and a straight sample of the sky would
// have it exactly as bright. The curve is what keeps the parked afternoon reading as white (the
// sample is already light, so it barely moves: 0.69 lightness to 0.85) while stopping midnight from
// going to black — the night sky samples at 0.014 and the clouds come out at 0.145, which is a
// shape you can still make out against it rather than a hole in the stars.
//
// Sampled lower down the dome than the haze is (0.45 against its 0.73): the haze wants the most
// chromatic part of the sky because it has 17% of a wash to say something with, and this wants the
// *warmth* at the bottom of a sunset sky, because a cloud at dusk is the one thing in the frame
// that is still catching the sun.
const CLOUD_SKY_H = 0.45;
const CLOUD_CHROMA = 0.3;
const CLOUD_GAMMA = 0.45;

const tintHSL = { h: 0, s: 0, l: 0 };

export function cloudTint(top, bottom, out = new THREE.Color()) {
  out.copy(bottom).lerp(top, CLOUD_SKY_H);
  out.getHSL(tintHSL);
  return out.setHSL(tintHSL.h, tintHSL.s * CLOUD_CHROMA, Math.pow(tintHSL.l, CLOUD_GAMMA));
}

export function createClouds(scene, rng, { count = COUNT } = {}) {
  // Seeded from the palette's parked sky, and overwritten by `setLight` on the daylight module's
  // first keyframe — which is every run, but not the headless tools, which build a scene with no
  // clock in it.
  const tint = cloudTint(new THREE.Color(PALETTE.skyTop), new THREE.Color(PALETTE.skyBottom));

  const group = new THREE.Group();
  group.name = 'clouds';
  scene.add(group);

  // Which way the wind blows across the frame. Screen +sx is world (1, 0, -1) — a real horizontal
  // wind, since `RIGHT` lies in the ground plane — and the other sign is the same weather coming
  // the other way. Off the run seed, like the aeroplane's heading: which way the sky is moving is
  // part of the situation, not part of the map.
  const drift = rng.chance(0.5) ? 1 : -1;
  const state = { drift, count, overlap: OVERLAP, band: BAND, speed: 1, over: 0 };

  const clouds = [];
  for (let i = 0; i < POOL; i++) {
    const length = rng.range(SPAN[0], SPAN[1]);
    // The yaw is decided *before* the model is built, because the model bakes two view-dependent
    // things into its vertices — the rim fade and the lobes' draw order — and both need to know
    // which way the cloud will be facing. It is the one number the two modules have to agree on.
    //
    // **+45°, not -45°.** The project's convention is that yaw 0 aims a model down +X and rotation
    // about Y takes +X to `(cos, 0, -sin)` (`dirYaw` in city/grid.js), so `RIGHT` — world (1, 0, -1),
    // which is the direction screen `sx` runs in — is a **positive** quarter turn. The other sign
    // aims the long axis down (1, 0, 1) instead, which is the horizontal part of the *view*
    // direction: the cloud points straight into the screen, projects to nothing across the frame,
    // and every one of them came out as a tall lumpy potato standing on end.
    const yaw = (drift > 0 ? Math.PI / 4 : -3 * Math.PI / 4) + rng.jitter(YAW_JITTER);
    const geometry = createCloudGeometry(rng, { span: length, height: length * HEIGHT_RATIO, yaw });
    // **Unlit, which is the one place this departs from everything else in the sky.** The scene's
    // key is `#FFDEBB` over a warm hemisphere fill, and a white lump under it comes back as a
    // sandstone boulder — see the long note in geometry/cloud.js, which is where the shading it
    // gives up is baked back in. The rule the project's unlit materials carry (`unlitMaterial`:
    // anything that doesn't take the sun doesn't take the air either) costs nothing here: a cloud
    // floats well in front of the ground it is drawn over and measures 2.3% of haze at the very
    // most, against the 17% the top of the frame behind it is wearing.
    //
    // `color` is then a tint over the baked gradient rather than a paint — `cloudTint` below, which
    // `game/daylight.js` drives off the sky the same way it drives the haze.
    const material = unlitMaterial({ vertexColors: true, transparent: true });
    material.color.copy(tint);
    // **No depth write, and that is the rim fade's other half.** Every lobe is translucent around
    // its edge, so a lobe that stamped depth would punch a hole in whatever is drawn behind it —
    // including the rest of its own cloud, whose lobes overlap by design. Blending them in order
    // instead is what makes the overlaps read as one soft body, and the order is baked into the
    // geometry at build time (see geometry/cloud.js).
    material.depthWrite = false;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.y = yaw;
    // **Never a shadow caster.** At this sun — 28.5° up — a cloud at cruise throws its shadow some
    // 170 units downsun, which from an edge lane lands over the city and drifts across it. A moving
    // dark patch over the play area is the exact thing the rule at the top of this file exists to
    // prevent, arriving by the back door.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);

    clouds.push({
      mesh,
      ...screenBox(geometry, yaw),
      // Which side of the island this one rides, and where in the band beyond it.
      side: i % 2 ? 1 : -1,
      depth: rng.next(),
      speed: rng.range(SPEED[0], SPEED[1]),
      altitude: rng.range(ALTITUDE[0], ALTITUDE[1]),
      // Spread across the frame by the golden ratio rather than evenly, so that **any prefix of
      // the pool is still spread out**: `setCount` shows the first N of these and hides the rest,
      // and on an even spacing that would empty one end of the sky and crowd the other.
      sx: (((i * 0.6180339887) % 1) * 2 - 1) * LIMIT,
    });
  }

  /**
   * What a cloud covers on screen, as offsets from its own origin: how far it reaches across the
   * frame, and how far it hangs below and stands above.
   *
   * Off the geometry's bounding box, through the yaw the mesh will wear, because a cloud is not its
   * long axis — it is a third of that tall and about half of it deep across, and under this camera
   * both of those reach up-screen towards the city. The box is conservative, which is the direction
   * to be wrong in. Asymmetric on purpose: the mesh's origin is the middle of its *base*, so what
   * hangs below it and what stands above it are different numbers and the clearance only cares
   * about one of them.
   */
  function screenBox(geometry, yaw) {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    let reach = 0;
    let drop = 0;
    let rise = 0;
    for (const x of [box.min.x, box.max.x]) {
      for (const y of [box.min.y, box.max.y]) {
        for (const z of [box.min.z, box.max.z]) {
          const s = screenOf(x * cos + z * sin, y, -x * sin + z * cos);
          reach = Math.max(reach, Math.abs(s.sx));
          drop = Math.max(drop, -s.sy);
          rise = Math.max(rise, s.sy);
        }
      }
    }
    return { reach, drop, rise };
  }

  /**
   * Where a cloud sits up the frame, given where it is across it.
   *
   * The silhouette is sampled **across the cloud's own width** and the worst of it taken, not just
   * under its middle: the outline is concave over the map's far corner, so a cloud approaching the
   * apex has more city beside it than under it, and a gap paid at its centre is a gap it has already
   * spent. `ROUND * 0.25` is the deepest the smoothing can cut a corner below the true outline,
   * handed back here so the rounding is never paid for out of the overlap the band is aiming at.
   */
  function height(cloud) {
    const gap = ROUND * 0.25 - state.overlap + cloud.depth * state.band;
    if (cloud.side > 0) {
      let top = -Infinity;
      for (let t = -1; t <= 1; t += 0.5) top = Math.max(top, silhouetteTop(cloud.sx + t * cloud.reach));
      return top + gap + cloud.drop;
    }
    let bottom = Infinity;
    for (let t = -1; t <= 1; t += 0.5) bottom = Math.min(bottom, silhouetteBottom(cloud.sx + t * cloud.reach));
    return bottom - gap - cloud.rise;
  }

  /** And where an `over` cloud sits: somewhere across the city itself, which is the other brief. */
  function inside(cloud) {
    const top = silhouetteTop(cloud.sx);
    const bottom = silhouetteBottom(cloud.sx);
    return bottom + (0.15 + 0.7 * cloud.depth) * (top - bottom);
  }

  /** 1 across the middle of the frame, easing to 0 well before either end of the run. */
  const edgeFade = (sx) => Math.max(0, Math.min(1, (LIMIT - Math.abs(sx)) / FADE_BAND));

  function place() {
    for (let i = 0; i < clouds.length; i++) {
      const cloud = clouds[i];
      const fade = edgeFade(cloud.sx);
      cloud.mesh.visible = i < state.count && fade > 0;
      if (!cloud.mesh.visible) continue;
      const sy = i < state.over ? inside(cloud) : height(cloud);
      worldAt(cloud.sx, sy, standoffFor(sy, cloud.altitude), cloud.mesh.position);
      cloud.mesh.material.opacity = fade;
    }
  }

  // Placed at construction rather than grown into: shot mode ticks the world once and freezes, so
  // anything that opens at zero is stuck on its first frame (see the ground discs in
  // game/fares.js). There is nothing here to settle — a cloud's first frame has it already halfway
  // across the sky.
  place();

  function update(dt) {
    for (let i = 0; i < state.count; i++) {
      const cloud = clouds[i];
      cloud.sx += cloud.speed * state.speed * state.drift * dt;
      if (cloud.sx > LIMIT) cloud.sx -= 2 * LIMIT;
      else if (cloud.sx < -LIMIT) cloud.sx += 2 * LIMIT;
    }
    place();
  }

  /** How many of the pool are in the sky. The rest are hidden, not destroyed — see `sx` above. */
  function setCount(n) {
    state.count = Math.max(0, Math.min(POOL, Math.round(n)));
    place();
  }

  /** How far into the city the band reaches, and how deep it is. Both live, for the ⚙️ panel. */
  function setBand(overlap, band) {
    state.overlap = overlap;
    state.band = band;
    place();
  }

  /** A multiplier over every cloud's own speed, so the spread between them survives a retune. */
  function setSpeed(scale) {
    state.speed = scale;
  }

  /**
   * Retint every cloud from the sky as it is now — `game/daylight.js`, on every keyframe change.
   * One colour per material rather than a rewrite of the baked vertex colours, which is the whole
   * reason the gradient is baked and the *light* is a multiplier over it.
   */
  function setLight(top, bottom) {
    cloudTint(top, bottom, tint);
    for (const cloud of clouds) cloud.mesh.material.color.copy(tint);
  }

  /**
   * How many clouds ride **over** the city instead of round it — the other reading of the brief,
   * kept as a knob rather than an argument. Default 0: a cloud over the play area hides the taxi,
   * and the whole of the placement above exists to stop that. Drag the panel's slider up to see
   * what the alternative costs.
   */
  function setOver(n) {
    state.over = Math.max(0, Math.min(POOL, Math.round(n)));
    place();
  }

  return { group, clouds, state, update, setCount, setBand, setSpeed, setOver, setLight, tint, POOL };
}
