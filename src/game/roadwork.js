import * as THREE from 'three';
import { LANE, ROAD_W, isRiverGap } from '../city/grid.js';
import { cityNetwork } from '../city/roadnet.js';
import { propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { createPerson } from '../geometry/person.js';
import { markOccluder, unmarkOccluder } from './ssao.js';
import {
  coneGeometry, barricadeParts, spoilParts, pitParts, sawhorseGeometry, rubbleParts, mergeAll,
  splinterGeometry,
  CONE_REST_Y, SPLINTER_REST_Y, SAWHORSE_REST_Y, SAWHORSE_HALF_W,
} from '../geometry/roadworks.js';
import { launchHop, setClosedLanes, HOP_LEN, STOP_SETBACK, CAR_LEN } from '../sim/traffic.js';
import { setRoadworkLanes } from './route.js';

// A street closed for roadworks: a striped trestle across each end, a scatter of cones, a hole
// with a sawhorse barricade at either end of it, rubble in the lanes, and two workers standing over
// it. The taxi barrels through on the road (2026-11-04); `?roadworks=classic` keeps the old ramp
// and hop, and the heap of spoil the sawhorses replaced.
//
// **Ambient traffic routes around it; the taxi has never heard of it.** The closure is two lane
// ids handed to `setClosedLanes` in sim/traffic.js, where they zero the weight of any turn that
// would enter them. The taxi's turn comes from its route, which is planned over the untouched road
// network, so it drives straight in — and since nothing else is in there, the closed street is the
// emptiest road in the city: a fast lane with a barricade at each end of it. Smashing the first is
// the Stuntman combo (main.js, `roadwork.onSmash`): a step on the meter and some Loco back.
//
// Scheduling is modelled on game/flyover.js and is deliberately **off the difficulty curve**, for
// the same reason the flyover is: nothing about this is pressure. One zone per run, one cooldown,
// and then it stays where it is. `place()` is public so shot mode and tools/probe.mjs can stage
// one rather than wait forty seconds for it.

/**
 * `'classic'` is the zone as it was before 2026-11-04 — `?roadworks=classic`, `ROADWORKS=classic`
 * headless: a plywood ramp against the entry trestle that hops the taxi over the works, and a heap
 * of spoil beside the hole. The default is `'barrel'` (Tyler: "cut the ramps now that we have a
 * bunch of other ways … as the car barrels through, it just bounces around as it's hitting piles of
 * debris and smashes through the barricades and knocks over cones"). No ramp and no hop: the taxi
 * stays on the road the whole way, so it smashes the trestle at *both* ends, bounces over the
 * rubble piles in the lanes, and goes through the cones and the two sawhorses round the hole.
 */
export const ROADWORKS_MODE = (typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('roadworks')
  : globalThis.process?.env?.ROADWORKS) === 'classic' ? 'classic' : 'barrel';
const BARREL = ROADWORKS_MODE === 'barrel';

// The bounce. Render-only, on the same three fields game/flatbed.js jolts its truck with
// (`jolt`, `joltRoll`, `joltPitch`, which sim/traffic.js adds into the pose it draws), so the
// taxi's simulated position never leaves the lane. A damped bounce whose height is the absolute
// value of the sine — a car going over rubble is thrown *up* off it, never sunk into the road.
// At play zoom 0.22 is under two pixels of chassis, which is why the pitch and roll carry most of it.
const DEBRIS_Y = 0.22;
const DEBRIS_PITCH = 0.09;
const DEBRIS_ROLL = 0.07;
const DEBRIS_W = 19;            // rad/s
const DEBRIS_DECAY = 5.5;
const DEBRIS_LIFE = 1.1;        // seconds before a bounce is written back to exactly zero
const BUMP_RUBBLE = 1;          // relative sizes of what the taxi hits
const BUMP_TRESTLE = 1.25;
const BUMP_HORSE = 0.55;
// Rubble piles: one per lane in every stretch of the street the works leave free, kept this far
// off the trestles and the hole so a pile never sits inside either.
const RUBBLE_CLEAR = 2.9;
const RUBBLE_HIT_R = 1.3;       // the pile's own reach plus half a car's width

// Clear of the hole's end, so a foot does not stand in it.
const HORSE_GAP = 0.45;
// A sawhorse is long, so the taxi's knock test has to reach its ends and not just its middle — a
// cone's KNOCK_R from the centre would let a wheel run through the last half-unit of plank.
const HORSE_KNOCK_R = 1.2 + SAWHORSE_HALF_W;
// Heavier than a cone, so the same hit throws it less far: two-thirds keeps a smashed one under
// the cones' apex rather than over it.
const HORSE_POWER = 0.65;

const FIRST_WAIT = [40, 75];   // seconds. A three-to-four minute session sees exactly one.
const RETRY_WAIT = 5;          // nothing qualified right now — the city moves, ask again shortly
const FADE_IN = 1.1;
const RISE = 1.1;              // how far under the road the zone starts, so it grows out of it

// Packing up. Once the taxi has been through, the zone sinks back the way it came and the street
// reopens — a wrecked site sitting there for the rest of the run is a stale prop, and the second
// drive through an already-smashed barricade is a no-op that reads as broken.
//
// `LEAVE_DWELL` is measured from the taxi being *clear* **and the crew being gone**, not from the
// smash: the trestle takes TRESTLE_FLIGHT to finish cartwheeling, the cones and the splinters a
// little longer to settle, and the two workers longer still to get off the road. Fading during any
// of that swallows the payoff — and in the crew's case it swallowed the beat entirely. At overdrive
// the taxi crosses a 12-unit block in half a second, so the old rule started the zone's fade at
// about t = 1.35s against a run that ends at 1.15s and a fade that ends at 1.65s: the workers spent
// the back half of their sprint dissolving, which reads as them vanishing *instead of* escaping.
const LEAVE_DWELL = 0.8;
const FADE_OUT = 1.4;
const SINK = 1.1;              // matches RISE, so it leaves the way it arrived
const WORKER_HOLD = 0.45;      // a beat at the kerb, turned round, before they go
const WORKER_FADE = 0.5;       // ...and then they vanish, well ahead of the site itself

// How far the taxi has to be for a zone to appear. Same number and same honest caveat as
// traffic.js's SPAWN_CLEARANCE: on a desktop the whole city is in frame at once, so this cannot
// pretend to be off-camera — what it buys is that the zone is never *near* the car the player is
// watching. The rise-and-fade is what covers the desktop case.
const PLACE_CLEARANCE = 45;

// How far along a closed lane its trestle stands. Far enough that the ramp leaning against it
// clears the junction box behind: the ramp runs RAMP_RUN back from this line, so the toe lands at
// BARRIER_S - RAMP_RUN and that has to stay positive. At 1.7 against the old 3.2-unit ramp it was
// -1.5 — the toe sat in the middle of a live intersection, which is the other half of why the thing
// read as a plate lying near the corner rather than as a ramp up to a barricade.
export const BARRIER_S = 2.1;

// The run the launch chain needs: the trestle stands at BARRIER_S, the hop covers HOP_LEN from
// there, and the taxi has to be back on the tarmac before the hold line STOP_SETBACK short of the
// lane's end — the line where it picks its next turn.
//
// It is a *filter on the site* because it does not close on every street. A side street between
// two ordinary junctions is 12 units of lane and the chain lands 1.0 clear; a side street with an
// arterial at one end is 10.67 — the extra third of the arterial's width comes out of both its
// neighbours' lanes — and the same chain lands 0.33 *past* the line. That is 22 of the 56 side
// lanes on a default city, and it is the arterial trap in CLAUDE.md one more time: BARRIER_S and
// HOP_LEN were measured on a 12-unit lane and nothing re-measured them when the arterials were
// widened. Behaviour is a little better than the arithmetic — the hop fires off the taxi's nose,
// about half a car length before BARRIER_S, so a measured overdrive run lands at 7.13 against a
// line at 7.27 — but 0.14 of slack is one frame at 22 u/s, and one frame is the whole margin.
// Skipping the short lanes keeps the stunt exactly as it is on every site it can appear at.
const RAMP_RUN_NEEDED = BARRIER_S + HOP_LEN + STOP_SETBACK;
const CONES = 12;
const WORKERS = 2;

// Two rows, one either side, this far off the road centreline. Set against the car rather than by
// eye: the taxi drives a lane centre at LANE (2.0) and is CAR_W/2 = 0.85 wide, so its flank sweeps
// to 2.85. At 2.6 the near row is squarely in the way and goes flying, and the far row survives to
// be seen — which is what makes the drive through read as damage rather than as a clean corridor.
export const CONE_ROW = 2.6;
const CONE_SPAN = [0.22, 0.78];   // along the segment, kept between the two barricades
const CONE_JITTER_SIDE = 0.12;    // placed by a crew, not stamped by a machine
const CONE_JITTER_ALONG = 0.15;

const SMASH_SCATTER = 7;       // cones this close to a smashed trestle go with it
const KNOCK_R = 1.7;           // and any cone the taxi drives over, anywhere in the zone
const KNOCK_V = 2;             // ...as long as it is actually moving

const CONE_GRAVITY = 26;
const CONE_SETTLE = 0.3;       // fraction of the first flight spent before it starts easing flat

// What happens after the first touchdown. The cone used to land on a single parabola already eased
// into its resting pose and stop dead on that frame, horizontal speed and all — the throw was fine
// and the ending read as a keyframe. Now each impact hands on a fraction of the vertical (a hollow
// plastic cone is lively: 0.38 turns a 13 m/s launch into a 0.47-unit hop and a 0.07 skip), scrubs
// off horizontal speed and tumble, and the last of the speed goes into a slide on its side that
// decelerates to a stop while the cone rocks nose-up-and-down on its rim.
const CONE_BOUNCE = 0.38;      // vertical restitution per impact
const CONE_SCRUB = 0.5;        // horizontal speed kept through each impact
const CONE_SPIN_KEEP = 0.45;   // tumble rate kept through each impact
const CONE_MIN_HOP = 1.1;      // m/s. A rebound slower than this is 2cm of air: slide instead
const CONE_BOUNCES = 3;        // at most
const CONE_FRICTION = 16;      // u/s² of slide deceleration. Plastic on asphalt, and short
const CONE_ROCK = 0.32;        // radians of nose bob at the start of the slide...
const CONE_ROCK_W = 19;        // ...at this angular frequency...
const CONE_ROCK_DECAY = 6;     // ...dying away at this rate
const CONE_ROCK_TAIL = 0.5;    // seconds the rock outlasts the slide: by then it is under a degree
const CONE_PIVOT = 0.9;        // radians of yaw per unit slid: a cone on its side swings round its tip

// A cone caught by a trestle going over is thrown harder than one the taxi merely clipped: the
// blast is the event, the cone is only reporting it. 1.5 rather than a bigger number because the
// throw is *also* scaled by the taxi's speed, and the two multiply — see `knock`.
const SMASH_POWER = 1.5;
// ...which is why there is a ceiling on the vertical. At the overdrive top the speed term alone is
// 2.15, so 7.6 · 2.15 · 1.5 would launch a cone at 24 m/s: an apex of eleven units, most of a
// second of hang time, and a cone that leaves frame entirely on a close shot. 13 tops out at 3.25
// units — about a car length of air, high enough to read as flipped and low enough to stay in the
// picture with the thing that flipped it.
const CONE_VY_MAX = 13;

const TRESTLE_FLIGHT = 0.85;   // seconds a knocked trestle spends cartwheeling
const TRESTLE_THROW = 4.6;     // and how far downfield it lands

// Splintered plank off a trestle that has just been hit. Thrown from the plank line rather than
// from the road, in a forward fan: a trestle does not disintegrate evenly in all directions, it
// comes apart along the axis of whatever went through it.
// Per trestle, and the pool holds two trestles' worth: since the ramp went, the taxi stays on the
// road and goes through the trestle at the far end too.
const CHIPS_PER = 16;
const CHIPS = CHIPS_PER * 2;
const CHIP_GRAVITY = 30;       // heavier than a cone. Wood this size drops, it does not float down
const CHIP_SETTLE = 0.35;      // fraction of the flight spent easing flat onto the road
const CHIP_PLANK_Y = 0.95;     // roughly the height of the upper plank, where the chips come off

const FLEE_R = 15;             // a worker starts running when the taxi is this close
const FLEE_DUR = 1.15;
const KERB_OUT = ROAD_W / 2 + 1.4;   // where they run to, measured off the road centreline

const UP = new THREE.Vector3(0, 1, 0);
const smoothstep = (t) => t * t * (3 - 2 * t);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * A local frame on a lane: **+X across the road to the *left* of travel, +Y up, +Z the direction of
 * travel**, with the origin on the tarmac at the lane centre.
 *
 * Left, not right, and the two are not interchangeable — a sign here is a whole lane and a half of
 * placement error. `makeBasis(l, up, f)` has to stay right-handed (`l · (up × f)` = `fx² + fz²` = 1)
 * or every stripe on the barricade mirrors and the ramp lands on the wrong side of the road; and
 * with +Y up and +Z *forward* the only axis a right-handed basis leaves for +X is the lane's left.
 * There is no arrangement of this frame in which +X is the driver's right.
 *
 * Which matters to every caller, because traffic here drives on the right: the road centreline is
 * `LANE` to the **left** of the lane, i.e. at local X = `+LANE`. Reading the axis as "right" and
 * writing `-LANE` puts the thing being placed `2 · LANE` off the centre of the road — half on the
 * pavement, and on the street along the riverbank, half over the water. That shipped, and it was
 * reported as the construction site floating over the river.
 */
function laneFrame(lane, s) {
  const p = lane.path.at(s);
  const t = lane.path.tangentAt(s);
  const f = new THREE.Vector3(t.x, 0, t.z).normalize();
  const l = new THREE.Vector3(f.z, 0, -f.x);
  const m = new THREE.Matrix4().makeBasis(l, UP, f);
  m.setPosition(p.x, 0, p.z);
  return { matrix: m, forward: f, across: l, x: p.x, z: p.z };
}

export function createRoadwork(rng, scene, camera = null) {
  const group = new THREE.Group();
  group.name = 'roadwork';
  scene.add(group);
  group.visible = false;

  const smashListeners = [];
  const placeListeners = [];
  const clearListeners = [];
  const emit = (list, event) => { for (const cb of list) cb(event); };

  /** The two junctions a closed segment runs between, in grid coordinates. */
  function endJunctions(edge) {
    const net = cityNetwork();
    return [edge.a, edge.b]
      .map((id) => net.nodeById.get(id))
      .filter(Boolean)
      .map((node) => ({ i: node.gi, j: node.gj }));
  }

  const state = {
    phase: 'waiting',                                   // waiting | fading | live | leaving | gone
    cooldown: rng.range(FIRST_WAIT[0], FIRST_WAIT[1]),
    fade: 0,
    alpha: 0,                                           // what the zone's materials are actually on
    smashed: false,                                     // the taxi has been through at least one
    leaveAt: null,                                      // when to start packing up, once it is clear
    t: 0,                                               // seconds since the zone was placed
    airborne: false,
    lastLaneId: null,                                   // where the taxi was last frame, so a
    lastS: 0,                                           // barricade can test a crossing, not a side
    edge: null,
    closedLaneIds: [],
    occluded: false,
  };

  // Every material the zone owns, collected once at build. Walking `group` for them each frame
  // would be the same list and a traversal; the set is fixed for the zone's lifetime.
  const materials = [];
  const workers = [];
  const barriers = [];
  const cones = [];
  const horses = [];
  const rubble = [];
  const bumpListeners = [];
  const bump = { at: -Infinity, amp: 0, roll: 1, live: false };
  const chips = [];

  let coneMesh = null;
  let horseMesh = null;
  // The knockable pieces, each an InstancedMesh plus the entries it draws. Cones and sawhorses
  // share every line of the flight below; what differs lives on the entry (restY, knockR, power).
  const pools = [];
  let chipMesh = null;
  const dummy = new THREE.Object3D();
  const qTumble = new THREE.Quaternion();
  const qRest = new THREE.Quaternion();
  const restEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  const spinAxis = new THREE.Vector3();

  // --- Choosing a street ------------------------------------------------------

  /**
   * Would closing `ids` leave some approach to `node` with nowhere to go?
   *
   * Asked exactly rather than by a corner heuristic: what strands a car is not the shape of the
   * junction but a single inbound lane whose every onward lane is closed. Because U-turns are
   * illegal, such a car can never leave — it would hold at the line forever with its whole lane
   * queued behind it. The zero-weight fallback in traffic.js means it drives on regardless, but a
   * car visibly driving through a barricade is the one thing this must never produce.
   */
  function strands(node, ids) {
    for (const lane of node.inbound) {
      if (lane.degenerate) continue;
      if (!lane.onward.some((out) => !ids.has(out.id))) return true;
    }
    return false;
  }

  /** True if any car is on, or turning onto, either lane of `edge`. */
  function occupied(edge, cars) {
    const ids = new Set(edge.lanes.map((l) => l.id));
    return cars.some((car) => ids.has(car.lane?.id) || ids.has(car.turn?.outLane));
  }

  function eligible(edge, taxi, cars, busy) {
    // Side streets only. Closing an arterial fights the 64% green share and the platoon offsets the
    // whole city is timed around; the ring is the road everything else escapes onto.
    if (edge.klass !== 'side') return false;
    if (edge.lanes.length !== 2) return false;
    if (edge.lanes.some((l) => l.degenerate)) return false;
    // Long enough to land the stunt in — see RAMP_RUN_NEEDED.
    if (edge.lanes.some((l) => l.length < RAMP_RUN_NEEDED)) return false;

    const net = cityNetwork();
    const ids = new Set(edge.lanes.map((l) => l.id));
    const a = net.nodeById.get(edge.a);
    const b = net.nodeById.get(edge.b);
    if (!a || !b) return false;
    if (strands(a, ids) || strands(b, ids)) return false;

    // **Not on a bridge.** Every road running along Z crosses the river, and the ones that get over
    // it do so on a deck that arches 1.1 units above the road at its crest (`city/river.js`). This
    // whole zone is built at road level — the trestles, the cones, the spoil heap, the hole, the
    // two workers and the ramp the taxi launches off — so a site on a span puts all of it a metre
    // under the tarmac at the middle and sticking out of it at both ends. There is also nothing
    // under a bridge deck to dig a hole *in*.
    if (a.gi === b.gi && isRiverGap(Math.min(a.gj, b.gj))) return false;

    // A rider standing on a kerb corner at either end would be picked up from inside the zone.
    if (busy.some((spot) => (spot.i === a.gi && spot.j === a.gj)
      || (spot.i === b.gi && spot.j === b.gj))) return false;

    if (occupied(edge, cars)) return false;

    const mid = edge.curve.at(edge.curve.length / 2);
    return Math.hypot(mid.x - taxi.x, mid.z - taxi.z) >= PLACE_CLEARANCE;
  }

  /**
   * Is the middle of this segment outside the frame right now?
   *
   * Only a *preference* — on a desktop the whole city is in shot and this finds nothing, which is
   * why the zone rises out of the road rather than simply appearing. Same projection recipe as
   * game/dropoffindicator.js, in clip space rather than pixels because nothing here needs pixels.
   */
  function offScreen(edge) {
    if (!camera) return false;
    const mid = edge.curve.at(edge.curve.length / 2);
    const v = new THREE.Vector3(mid.x, 0.1, mid.z).project(camera);
    return Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
  }

  // --- Building it ------------------------------------------------------------

  /**
   * A point on the **road centreline** `u` of the way along the segment, plus `side` units
   * across it, and the lateral unit vector that came with it.
   *
   * Measured along a *lane* rather than along `edge.curve`, and this is not a detail: an edge runs
   * node centre to node centre, so its first and last four units are inside the junction boxes at
   * either end. Cones strung along it were being laid out across two live intersections, where
   * cross traffic drove over them and the taxi collected them on its way past. A lane is already
   * trimmed to the tarmac between the two.
   *
   * `side` is measured from the middle of the road, which is where a road's furniture is naturally
   * placed — so the lane's own `LANE` of offset has to be taken back out. Traffic drives on the
   * right, so a lane centre is `LANE` to the **right** of the centreline and the axis below points
   * **left** (`(tan.z, -tan.x)` is the tangent turned anticlockwise); the two agree in sign, and the
   * offset is `side + LANE` rather than `side - LANE`. Getting that sign wrong does not shift the
   * zone a little, it shifts it `2 · LANE` — clear of the kerb on one side and off the road
   * altogether on the other. See laneFrame for the same trap in the barricades' frame.
   */
  function roadPoint(edge, u, side) {
    const lane = edge.lanes[0];
    const at = lane.path.at(u * lane.length);
    const tan = lane.path.tangentAt(u * lane.length);
    const ax = tan.z;
    const az = -tan.x;
    const o = side + LANE;
    return { x: at.x + ax * o, z: at.z + az * o, ax, az, u };
  }

  function buildStatic(edge) {
    const parts = [];
    const ramps = [];

    for (const lane of edge.lanes) {
      const frame = laneFrame(lane, BARRIER_S);
      // `+LANE`, because the frame's +X is the lane's *left* and the road centreline is a lane to
      // the left of a lane centre — see laneFrame.
      const { trestle, ramp } = barricadeParts({ width: ROAD_W - 0.4, centreX: LANE });

      // The trestle gets a group of its own so it can be thrown. Its geometry stays in the local
      // frame and the group carries the placement, which is what lets the flight below be written
      // in "across / up / downfield" rather than in world axes.
      const holder = new THREE.Group();
      holder.applyMatrix4(frame.matrix);
      group.add(holder);

      // By default the street is closed by **two** trestles, one per lane, each a little off
      // square (Tyler, 2026-11-05: "we shouldn't have a single barrier covering the entire cross of
      // the street … a slight rotation so that it doesn't look perfectly placed"). One plank the
      // width of the road read as a level crossing gate rather than as a crew's kit. They meet near
      // the centreline with a small gap and are thrown separately, so a smash scatters two things.
      // `?roadworks=classic` keeps the one full-width trestle.
      const pieces = [];
      const addPiece = (geos, x, z, yaw) => {
        const mesh = new THREE.Mesh(mergeAll(geos), propMaterial());
        mesh.castShadow = true;
        mesh.position.set(x, 0, z);
        mesh.rotation.y = yaw;
        holder.add(mesh);
        materials.push(mesh.material);
        pieces.push({ mesh, x, z, yaw, throwX: rng.jitter(0.8), twist: rng.range(-0.9, 0.9) });
      };
      if (BARREL) {
        for (const geo of trestle) geo.dispose();
        const span = ROAD_W - 0.4;
        const gap = rng.range(0.2, 0.45);
        const w = (span - gap) / 2 - 0.15;
        for (const side of [-1, 1]) {
          const { trestle: half, ramp: unused } = barricadeParts({ width: w });
          for (const geo of unused) geo.dispose();
          // Measured from the road centreline (`LANE` across, see above), each half centred on
          // its own lane, nudged along the road and turned a few degrees about its own middle.
          addPiece(half, LANE + side * (gap / 2 + w / 2) + rng.jitter(0.1),
            rng.jitter(0.22), rng.jitter(0.1));
        }
      } else {
        addPiece(trestle, 0, 0, 0);
      }
      // `exitLaneId`/`exitS`: the same trestle met from behind, by a taxi on the *other* lane
      // driving out of the street. The ramp's hop used to carry it over this one; on the road it
      // goes through it, and `dir` flips the throw so the trestle goes the way the taxi was going.
      const other = edge.lanes.find((l) => l !== lane);
      barriers.push({
        pieces, laneId: lane.id, s: BARRIER_S, hit: false, hitAt: 0, dir: 1, exit: false,
        // Tested where the taxi's *nose* meets it, half a car short of the trestle line, and that
        // is not only geometry: the far trestle stands 2.1 from the junction against a hold line
        // 3.4 back, so the taxi's own position never reaches it — the car stops being on the lane
        // at the line, and a test on the centre never fired (0 exits of 2 in the probe).
        exitLaneId: other?.id ?? null,
        exitS: other ? other.length - BARRIER_S - CAR_LEN / 2 : Infinity,
        x: frame.x, z: frame.z,
        // Kept so the splinters can be thrown in the trestle's own frame rather than in world
        // axes — see burstChips. The frame itself is discarded with the matrix it was built for.
        forward: frame.forward.clone(), across: frame.across.clone(),
      });

      // The ramp is bolted to the road, so it joins the static mesh — transformed into world space
      // here because that mesh has no frame of its own.
      if (BARREL) for (const geo of ramp) geo.dispose();
      else for (const geo of ramp) { geo.applyMatrix4(frame.matrix); ramps.push(geo); }
    }

    parts.push(...ramps);

    // The hole, off-centre along the block so the zone isn't symmetrical.
    const site = roadPoint(edge, rng.range(0.35, 0.6), 0);
    let off = rng.range(-1.4, 1.4);
    const hx = () => site.x + site.ax * off;
    const hz = () => site.z + site.az * off;
    let horseSpots = [];
    if (!BARREL) {
      parts.push(...spoilParts(hx(), hz(), rng));
    } else {
      // Pulled in toward the centreline: a sawhorse is 1.7 across, and at the heap's 1.4 its end
      // would stand at 2.25 against a cone row at 2.6 less a 0.31 base — touching. At 0.8 of that
      // the worst case is 1.97, a third of a unit clear.
      off *= 0.8;
      const { parts: pit, halfAlong } = pitParts(hx(), hz(), site.ax, site.az, rng);
      parts.push(...pit);
      // Along the road is the across vector turned clockwise: across = (tan.z, -tan.x).
      const tx = -site.az;
      const tz = site.ax;
      const reach = halfAlong + HORSE_GAP;
      horseSpots = [-1, 1].map((end) => ({
        x: hx() + tx * end * reach + rng.jitter(0.1),
        z: hz() + tz * end * reach + rng.jitter(0.1),
        // Plank across the road, facing the traffic each end, with a crew's worth of skew.
        yaw: Math.atan2(-site.az, site.ax) + rng.jitter(0.12),
      }));
    }

    if (BARREL) {
      for (const spot of rubbleSpots(edge, { ...site, off })) {
        rubble.push(spot);
        parts.push(...rubbleParts(spot.x, spot.z, rng));
      }
    }

    const mesh = new THREE.Mesh(mergeAll(parts), propMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'roadwork-static';
    group.add(mesh);
    materials.push(mesh.material);
    return { mesh, site: { ...site, off }, horseSpots };
  }

  /**
   * Where the rubble goes: the stretches of the street left free between the two trestles and the
   * hole, one pile per lane in each, measured in units along lane 0 so the clearance means the
   * same thing on a long street as on a short one.
   */
  function rubbleSpots(edge, site) {
    const len = edge.lanes[0].length;
    const centre = site.u * len;
    const lo = BARRIER_S + 0.8;
    const hi = len - BARRIER_S - 0.8;
    const spans = [[lo, centre - RUBBLE_CLEAR], [centre + RUBBLE_CLEAR, hi]];
    const spots = [];
    for (const [a, b] of spans) {
      if (b < a) continue;
      for (const side of [-LANE, LANE]) {
        const along = a + (b - a) * rng.range(0.25, 0.75);
        const at = roadPoint(edge, along / len, side + rng.jitter(0.35));
        spots.push({ x: at.x, z: at.z, hit: false });
      }
    }
    return spots;
  }

  function buildCones(edge) {
    const geometry = coneGeometry();
    coneMesh = new THREE.InstancedMesh(geometry, propMaterial(), CONES);
    coneMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Three caches an InstancedMesh's bounding sphere once, and this pool's slots move a long way
    // from where they started when the taxi arrives. Same reason every pool in game/ turns it off.
    coneMesh.frustumCulled = false;
    coneMesh.castShadow = true;
    group.add(coneMesh);
    materials.push(coneMesh.material);

    // Two rows down the sides of the works, six a side, evenly spaced between the barricades.
    //
    // This was a sine zigzag with 0.9 of jitter on top, meant to read as a crew that put them down
    // by hand. It read as neither: a wave that wanders across the centreline has no rule you can
    // see, so it looked like cones dropped at random rather than like a coned-off lane. Real
    // roadworks are laid out in lines, and a line with a hand's worth of slop on it is the thing
    // that reads as placed — the order has to be legible before the imperfection means anything.
    const perRow = CONES / 2;
    const [u0, u1] = CONE_SPAN;
    for (let n = 0; n < CONES; n++) {
      const row = n % 2 === 0 ? 1 : -1;
      const step = Math.floor(n / 2);
      const u = u0 + (u1 - u0) * (perRow === 1 ? 0.5 : step / (perRow - 1));
      const at = roadPoint(
        edge,
        u + rng.jitter(CONE_JITTER_ALONG) / edge.lanes[0].length,
        row * CONE_ROW + rng.jitter(CONE_JITTER_SIDE),
      );
      cones.push({
        x: at.x,
        z: at.z,
        y: 0,
        yaw: rng.range(0, Math.PI * 2),
        restY: CONE_REST_Y, knockR: KNOCK_R, power: 1,
        knocked: false, age: 0, dur: 1,
        x0: 0, z0: 0, vx: 0, vy: 0, vz: 0, quat: null,
      });
    }
    pools.push({ items: cones, mesh: coneMesh });
    writeCones(pools[pools.length - 1]);
  }

  /** The two sawhorses at the ends of the hole. Knocked about exactly like cones. */
  function buildHorses(spots) {
    if (!spots.length) return;
    horseMesh = new THREE.InstancedMesh(sawhorseGeometry(), propMaterial(), spots.length);
    horseMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    horseMesh.frustumCulled = false;   // same reason as the cones
    horseMesh.castShadow = true;
    group.add(horseMesh);
    materials.push(horseMesh.material);
    for (const spot of spots) {
      horses.push({
        x: spot.x, z: spot.z, y: 0, yaw: spot.yaw,
        restY: SAWHORSE_REST_Y, knockR: HORSE_KNOCK_R, power: HORSE_POWER,
        knocked: false, age: 0, dur: 1,
        x0: 0, z0: 0, vx: 0, vy: 0, vz: 0, quat: null,
      });
    }
    pools.push({ items: horses, mesh: horseMesh });
    writeCones(pools[pools.length - 1]);
  }

  /**
   * The pool of plank splinters, dormant until a trestle is hit.
   *
   * Built with the zone rather than on the smash, for the same reason every pool in game/ is: the
   * smash is the one frame in the run where a hitch is unaffordable, and building an InstancedMesh
   * there means compiling a material and uploading a buffer inside it.
   *
   * Slots start scaled to zero. A dormant instance at the origin would otherwise be a small striped
   * chip sitting in the middle of the city — the mesh has no per-instance visibility flag, so
   * "absent" has to be spelled as "zero size".
   */
  function buildChips() {
    chipMesh = new THREE.InstancedMesh(splinterGeometry(), propMaterial(), CHIPS);
    chipMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    chipMesh.frustumCulled = false;   // same reason as the cones: these leave their bounding sphere
    chipMesh.castShadow = true;
    group.add(chipMesh);
    materials.push(chipMesh.material);

    for (let n = 0; n < CHIPS; n++) {
      chips.push({
        live: false, age: 0, dur: 1,
        x: 0, y: 0, z: 0, x0: 0, y0: 0, z0: 0,
        vx: 0, vy: 0, vz: 0,
        spin: 0, axisX: 0, axisY: 0, axisZ: 0,
        long: 1, restYaw: 0,
        quat: new THREE.Quaternion(),
      });
    }
    writeChips();
  }

  function buildWorkers(edge, site) {
    for (let n = 0; n < WORKERS; n++) {
      const person = createPerson({
        body: PALETTE.hiVis, hat: PALETTE.hardHat, pickable: null,
      });
      // Parented so the figure's own animations stay in the local space they are written in —
      // the same arrangement geometry/marker.js uses to stand a rider on a kerb corner.
      const holder = new THREE.Group();

      // One either side of the hole. Both offsets are from the road centreline, which is also what
      // the flee target below is measured in — the two have to be in the same frame or a worker
      // runs to a kerb that is nowhere near the one they are standing beside.
      const side = site.off + (n === 0 ? 1 : -1) * rng.range(1.4, 2.1);
      const spot = roadPoint(edge, site.u + rng.jitter(0.04), side);
      holder.position.set(spot.x, 0, spot.z);
      holder.add(person.group);
      group.add(holder);
      // Every mesh on the figure, not `group.children` — the shins and forearms are nested.
      const mats = person.meshes.map((mesh) => mesh.material);
      materials.push(...mats);

      // Straight out to the kerb on whichever side they are already nearest. Expressed as a delta
      // along the lateral axis, so a diagonal street works with no extra case.
      const outward = Math.sign(side) || 1;
      const travel = KERB_OUT * outward - side;
      workers.push({
        person, holder, mats,
        dx: spot.ax * travel,
        dz: spot.az * travel,
        phase: rng.range(0, Math.PI * 2),
        fleeing: 0,
        held: 0,      // seconds spent standing at the kerb since the run finished
        fade: 1,      // their own, multiplied into the zone's — see setAlpha
      });
    }
  }

  /**
   * Stand a zone on `edge`. Public so shot mode and the probe can stage one instead of waiting out
   * the cooldown — the same reason `flyover.launch()` is public.
   */
  function build(edge) {
    state.edge = edge;
    state.closedLaneIds = edge.lanes.map((l) => l.id);
    const { site, horseSpots } = buildStatic(edge);
    buildCones(edge);
    buildHorses(horseSpots);
    buildChips();
    buildWorkers(edge, site);
    // Published from here rather than polled by main.js: it changes exactly once in a run, and
    // anything that stages a zone directly — shot mode, tools/probe.mjs — gets the closure with it
    // instead of having to remember a second call.
    //
    // The same ids go two ways, and the two say opposite things. `setClosedLanes` tells ambient
    // traffic these turns are forbidden; `setRoadworkLanes` tells the taxi's router they are cheap.
    // That is the whole vignette in two lines: the city empties the street and the fare sends the
    // player down it.
    setClosedLanes(state.closedLaneIds);
    setRoadworkLanes(state.closedLaneIds);

    emit(placeListeners, { edge, ends: endJunctions(edge) });

    state.phase = 'fading';
    state.fade = 0;
    state.t = 0;
    group.visible = true;
    setAlpha(0);
  }

  function place(taxi, cars = [], busy = []) {
    if (state.phase !== 'waiting') return false;
    const net = cityNetwork();
    const open = net.edges.filter((edge) => eligible(edge, taxi, cars, busy));
    if (!open.length) return false;
    const hidden = open.filter(offScreen);
    build(rng.pick(hidden.length ? hidden : open));
    return true;
  }

  // --- Fading in --------------------------------------------------------------

  /**
   * Ramp the whole zone's opacity together.
   *
   * `transparent` and `depthWrite` are shader-define switches in three — setting them at runtime
   * does nothing until `needsUpdate` forces a recompile — so they are flipped only on the
   * transitions, the same guard geometry/person.js and game/vanish.js both carry.
   */
  function setAlpha(a) {
    state.alpha = a;
    // A fading worker forces the whole zone onto the transparent path even at full zone alpha —
    // otherwise `depthWrite` stays on and the worker's own opacity is simply ignored. It costs a
    // recompile at the start and end of the flee, which is two frames in a run.
    const opaque = a >= 1 && workers.every((w) => w.fade >= 1);
    for (const material of materials) {
      if (opaque === material.transparent) {
        material.transparent = !opaque;
        material.depthWrite = opaque;
        material.needsUpdate = true;
      }
      material.opacity = a;
    }
    // Workers second, so their own fade multiplies the zone's rather than being overwritten by it.
    for (const worker of workers) {
      if (worker.fade >= 1) continue;
      for (const material of worker.mats) material.opacity = a * worker.fade;
    }
  }

  // --- Wrecking it ------------------------------------------------------------

  /**
   * Send a cone flying, away from (fromX, fromZ).
   *
   * `power` is the difference between being clipped by a passing wheel and being inside a trestle
   * as it comes apart — see SMASH_POWER.
   */
  function knock(cone, fromX, fromZ, speed, power = 1) {
    if (cone.knocked) return;
    cone.knocked = true;
    cone.age = 0;
    cone.x0 = cone.x;
    cone.z0 = cone.z;

    let dx = cone.x - fromX;
    let dz = cone.z - fromZ;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;

    // Thrown away from whatever hit it, harder the faster that thing was going. The floor on the
    // speed term is what keeps a cone nudged at walking pace from simply falling over in place.
    const kick = 0.55 + Math.min(1.6, speed / 12);
    power *= cone.power;
    cone.vx = dx * rng.range(2.6, 6.4) * kick * power + rng.jitter(1.2 * power);
    cone.vz = dz * rng.range(2.6, 6.4) * kick * power + rng.jitter(1.2 * power);
    cone.vy = Math.min(CONE_VY_MAX, rng.range(4.2, 7.6) * kick * power);
    // Was 7..15, which at a cone's flight time is a turn and a half — enough to see it move, not
    // enough to see it *flip*. At 12..26 a cone thrown by a smash turns three to five times on its
    // way up and over, which is what carries the chaos: the tumble is the thing the eye reads, not
    // the height. Scaled by the same power, so a wheel-clipped cone still just topples.
    cone.spin = rng.range(12, 26) * power * (rng.chance(0.5) ? 1 : -1);
    cone.axisX = rng.range(-1, 1);
    cone.axisZ = rng.range(-1, 1);
    cone.restYaw = rng.range(0, Math.PI * 2);
    cone.restTilt = rng.range(-0.35, 0.35);
    cone.pivot = CONE_PIVOT * (rng.chance(0.5) ? 1 : -1);
    planCone(cone);
  }

  /**
   * Lay out a knocked cone's whole trajectory as a list of hops plus a slide, each a closed form of
   * its own start time — so `updateCones` stays a curve of age like it always was, and nothing
   * integrates. Flight times come from the same 2·vy/g the position uses, which is what keeps every
   * hop ending exactly on the road.
   */
  function planCone(cone) {
    const hops = [];
    let t = 0;
    let x = cone.x0;
    let z = cone.z0;
    let { vx, vz, vy } = cone;
    let angle = 0;
    let spin = cone.spin;

    for (let n = 0; n <= CONE_BOUNCES; n++) {
      if (n > 0) {
        vy *= CONE_BOUNCE;
        vx *= CONE_SCRUB;
        vz *= CONE_SCRUB;
        spin *= CONE_SPIN_KEEP;
        if (vy < CONE_MIN_HOP) break;
      }
      const dur = (2 * vy) / CONE_GRAVITY;
      hops.push({ t0: t, dur, x, z, vx, vz, vy, angle, spin });
      t += dur;
      x += vx * dur;
      z += vz * dur;
      angle += spin * dur;
    }

    const speed = Math.hypot(vx, vz);
    cone.hops = hops;
    cone.flight = hops[0].dur;
    cone.landed = t;
    cone.slide = { x, z, angle, speed, dx: speed ? vx / speed : 0, dz: speed ? vz / speed : 0 };
    cone.slideDur = speed / CONE_FRICTION;
    cone.dur = t + cone.slideDur + CONE_ROCK_TAIL;
  }

  /**
   * Blow the pool of chips off a trestle that has just been hit.
   *
   * Thrown in the local frame the trestle was placed in — across / up / downfield — for the same
   * reason its own flight is written that way: "wood going the way the taxi was going" is the
   * statement, and in world axes that is a different pair of numbers on every street in the city.
   *
   * The `live` guard is what makes a second smash cheap rather than wrong: only one trestle per
   * zone is ever reachable today (see the known issue in docs/traffic.md), but if both became
   * reachable the second would take whatever the first had not, instead of resetting chips that
   * are still in the air.
   */
  function burstChips(barrier, taxi) {
    const speed = Math.max(Math.abs(taxi.v), 6);
    let spawned = 0;

    for (const chip of chips) {
      if (chip.live) continue;
      if (spawned >= CHIPS_PER) break;
      spawned += 1;

      chip.live = true;
      chip.age = 0;
      chip.x0 = barrier.x + barrier.across.x * rng.jitter(2.6);
      chip.z0 = barrier.z + barrier.across.z * rng.jitter(2.6);
      chip.y0 = CHIP_PLANK_Y + rng.jitter(0.35);
      chip.x = chip.x0;
      chip.y = chip.y0;
      chip.z = chip.z0;

      // Mostly downfield, some sideways spray. The forward term carries the taxi's speed and the
      // lateral one does not: a plank pushed out of the way goes out of the way at the speed the
      // crowbar was swung, but what sends it *down the street* is the car.
      const along = rng.range(0.45, 1) * (2.5 + speed * 0.42);
      const spray = rng.range(-4.6, 4.6);
      chip.vx = barrier.forward.x * along * barrier.dir + barrier.across.x * spray;
      chip.vz = barrier.forward.z * along * barrier.dir + barrier.across.z * spray;
      chip.vy = rng.range(3.4, 8.2);

      // Fall time from the plank line to the road, out of the same quadratic the position uses —
      // not the cone's symmetric 2·vy/g, because a chip starts a metre up and lands at zero, so its
      // rise and its fall are different lengths.
      const drop = chip.y0 - SPLINTER_REST_Y;
      chip.dur = (chip.vy + Math.sqrt(chip.vy * chip.vy + 2 * CHIP_GRAVITY * drop)) / CHIP_GRAVITY;

      // Tumbling end over end about a random axis. Faster than a cone: it is a lighter thing hit by
      // the same car, and the flutter is most of what tells wood from plastic at this size.
      chip.spin = rng.range(16, 34) * (rng.chance(0.5) ? 1 : -1);
      chip.axisX = rng.range(-1, 1);
      chip.axisY = rng.range(-0.6, 0.6);
      chip.axisZ = rng.range(-1, 1);
      chip.long = rng.range(0.7, 1.7);      // splinters and stubs off the same plank
      chip.restYaw = rng.range(0, Math.PI * 2);
    }

    if (spawned) writeChips();
    return spawned;
  }

  function smash(barrier, taxi) {
    barrier.hit = true;
    barrier.hitAt = state.t;
    state.smashed = true;
    if (!BARREL) launchHop(taxi);
    else bumpTaxi(BUMP_TRESTLE, false);
    for (const { items } of pools) {
      for (const cone of items) {
        if (Math.hypot(cone.x - barrier.x, cone.z - barrier.z) <= SMASH_SCATTER) {
          knock(cone, barrier.x, barrier.z, taxi.v, SMASH_POWER);
        }
      }
    }
    burstChips(barrier, taxi);
    // **Everyone** goes, not just whoever the taxi got close to. The proximity test below is the
    // right rule for a taxi merely driving down the street; once a barricade is in the air it is
    // the wrong one — a worker calmly holding a shovel eight units from a trestle cartwheeling past
    // reads as a figure that has not been told what scene it is in.
    for (const worker of workers) if (worker.fleeing === 0) worker.fleeing = 1e-6;
    emit(smashListeners, { x: barrier.x, z: barrier.z, v: taxi.v, exit: barrier.exit });
  }

  /**
   * Throw the taxi's body about. `quiet` is for the barricade, which has its own crash and shake
   * from main.js and does not want a bump sound under them.
   */
  function bumpTaxi(amp, quiet = false) {
    // A second hit while the first is still ringing takes over at whichever is bigger, so piles
    // met back to back read as one rough patch rather than resetting to a smaller bounce.
    const left = bump.live ? bump.amp * Math.exp(-DEBRIS_DECAY * (state.t - bump.at)) : 0;
    bump.at = state.t;
    bump.amp = Math.max(amp, left);
    bump.roll = rng.chance(0.5) ? 1 : -1;
    bump.live = true;
    if (!quiet) emit(bumpListeners, { amp });
  }

  function updateBump(taxi) {
    if (!bump.live) return;
    const age = state.t - bump.at;
    if (age >= DEBRIS_LIFE || taxi.crashed) {
      bump.live = false;
      taxi.jolt = 0;
      taxi.joltRoll = 0;
      taxi.joltPitch = 0;
      return;
    }
    const env = bump.amp * Math.exp(-DEBRIS_DECAY * age);
    const wave = Math.sin(DEBRIS_W * age);
    taxi.jolt = DEBRIS_Y * env * Math.abs(wave);
    taxi.joltPitch = DEBRIS_PITCH * env * Math.sin(DEBRIS_W * age + 0.9);
    taxi.joltRoll = DEBRIS_ROLL * env * wave * bump.roll;
  }

  function updateRubble(taxi) {
    // Nothing to hit from the air. The probe still throws the taxi off the barricade to test the
    // hop, and a car over the rubble at two units up has not driven over it.
    if (Math.abs(taxi.v) <= KNOCK_V || taxi.hopFrom != null) return;
    for (const pile of rubble) {
      if (pile.hit) continue;
      if (Math.hypot(pile.x - taxi.x, pile.z - taxi.z) < RUBBLE_HIT_R) {
        pile.hit = true;
        bumpTaxi(BUMP_RUBBLE);
      }
    }
  }

  // --- Per frame --------------------------------------------------------------

  function writeCones({ items, mesh }) {
    for (let n = 0; n < items.length; n++) {
      const cone = items[n];
      dummy.position.set(cone.x, cone.y, cone.z);
      if (cone.quat) dummy.quaternion.copy(cone.quat);
      else dummy.quaternion.setFromAxisAngle(UP, cone.yaw);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(n, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  function writeChips() {
    for (let n = 0; n < chips.length; n++) {
      const chip = chips[n];
      if (!chip.live) {
        dummy.scale.setScalar(0);
        dummy.position.set(0, 0, 0);
        dummy.quaternion.identity();
      } else {
        dummy.position.set(chip.x, chip.y, chip.z);
        dummy.quaternion.copy(chip.quat);
        dummy.scale.set(chip.long, 1, 1);
      }
      dummy.updateMatrix();
      chipMesh.setMatrixAt(n, dummy.matrix);
    }
    chipMesh.instanceMatrix.needsUpdate = true;
  }

  function updateChips(dt) {
    let moving = 0;

    for (const chip of chips) {
      if (!chip.live || chip.age >= chip.dur) continue;
      moving += 1;

      chip.age = Math.min(chip.dur, chip.age + dt);
      const age = chip.age;

      // Closed form, like the cones and the blast's shards: a curve of age rather than an
      // integrated velocity, so slow-mo is the same shape as full speed and nothing accumulates.
      chip.x = chip.x0 + chip.vx * age;
      chip.z = chip.z0 + chip.vz * age;
      chip.y = Math.max(SPLINTER_REST_Y, chip.y0 + chip.vy * age - 0.5 * CHIP_GRAVITY * age * age);

      spinAxis.set(chip.axisX, chip.axisY, chip.axisZ).normalize();
      qTumble.setFromAxisAngle(spinAxis, chip.spin * age);
      const settle = clamp01((age / chip.dur - (1 - CHIP_SETTLE)) / CHIP_SETTLE);
      if (settle > 0) {
        // Flat on the road under a yaw of its own — the chip's thin axis is already y, so the
        // resting pose is a plain heading with a degree or two of lift on one corner. Slerped in
        // for the same reason the cone's is: blending Eulers gimbals and snaps.
        restEuler.set(0, chip.restYaw, 0.06);
        qRest.setFromEuler(restEuler);
        qTumble.slerp(qRest, smoothstep(settle));
      }
      chip.quat.copy(qTumble);
    }

    if (moving) writeChips();
    return moving;
  }

  function updateCones(dt, taxi) {
    let moving = 0;
    for (const pool of pools) {
      const n = updatePool(pool, dt, taxi);
      if (n) writeCones(pool);
      moving += n;
    }
    return moving;
  }

  function updatePool({ items }, dt, taxi) {
    let moving = 0;

    for (const cone of items) {
      if (!cone.knocked) {
        if (Math.abs(taxi.v) > KNOCK_V
          && Math.hypot(cone.x - taxi.x, cone.z - taxi.z) < cone.knockR) {
          knock(cone, taxi.x, taxi.z, taxi.v);
          if (BARREL && cone.restY === SAWHORSE_REST_Y) bumpTaxi(BUMP_HORSE);
        }
        continue;
      }
      if (cone.age >= cone.dur) continue;

      moving += 1;
      cone.age = Math.min(cone.dur, cone.age + dt);
      const age = cone.age;

      // Closed form, like the blast's shards: position is a curve of age rather than an integrated
      // velocity, so nothing accumulates and a slow-motion frame is the same shape as a full-speed
      // one. Unlike the shards these come to rest — the camera is still here afterwards.
      let angle;
      let yawDrift = 0;
      let rock = 0;
      if (age < cone.landed) {
        let hop = cone.hops[0];
        for (const h of cone.hops) if (age >= h.t0) hop = h;
        const t = age - hop.t0;
        cone.x = hop.x + hop.vx * t;
        cone.z = hop.z + hop.vz * t;
        // The first flight leaves from the road, as it always did; a rebound leaves from a cone
        // already lying on its side.
        const base = hop === cone.hops[0] ? 0 : cone.restY;
        cone.y = Math.max(cone.restY, base + hop.vy * t - 0.5 * CONE_GRAVITY * t * t);
        angle = hop.angle + hop.spin * t;
      } else {
        // Sliding to a stop on its side, decelerating at a constant rate, swinging round its own
        // tip as it goes and rocking on its rim. Both start from zero, so the hand-over from the
        // last hop is seamless.
        const sl = cone.slide;
        const t = Math.min(age - cone.landed, cone.slideDur);
        const d = sl.speed * t - 0.5 * CONE_FRICTION * t * t;
        cone.x = sl.x + sl.dx * d;
        cone.z = sl.z + sl.dz * d;
        cone.y = cone.restY;
        angle = sl.angle;
        yawDrift = cone.pivot * d;
        const r = age - cone.landed;
        rock = age >= cone.dur ? 0
          : CONE_ROCK * Math.exp(-CONE_ROCK_DECAY * r) * Math.sin(CONE_ROCK_W * r);
      }

      spinAxis.set(cone.axisX, 0, cone.axisZ).normalize();
      qTumble.setFromAxisAngle(spinAxis, angle);
      // Eased flat from late in the first flight to the end of the last hop, so the bounces still
      // carry some of the tumble and the slide starts from exactly the resting pose.
      const from = cone.flight * (1 - CONE_SETTLE);
      const settle = clamp01((age - from) / Math.max(1e-6, cone.landed - from));
      if (settle > 0) {
        // Lying on its side: a quarter turn about a horizontal axis, under a yaw of its own. Eased
        // in by slerp rather than by blending Eulers, which gimbals through the flat pose and makes
        // a cone snap ninety degrees in the last frame.
        restEuler.set(Math.PI / 2 + cone.restTilt + rock, cone.restYaw + yawDrift, 0);
        qRest.setFromEuler(restEuler);
        qTumble.slerp(qRest, smoothstep(settle));
      }
      cone.quat = (cone.quat ?? new THREE.Quaternion()).copy(qTumble);
    }

    return moving;
  }

  function updateBarriers(taxi) {
    let flying = 0;

    for (const barrier of barriers) {
      if (!barrier.hit) {
        // Bookkeeping, not geometry. A distance test would be tunnelled straight through at the
        // overdrive top, where the taxi covers 0.38 units a frame; a lane id and an arc length
        // cannot be missed.
        //
        // A *crossing*, though, not a comparison. `s >= barrier.s` alone is true for the whole
        // rest of the lane, so a taxi that was already past the line when the zone finished rising
        // would be launched off a barricade it never reached. Placement keeps the zone well clear
        // of the taxi so a live run cannot reach that state, but a staged one can, and a test that
        // has to avoid a state is a test of the harness rather than of the game.
        const crossed = taxi.lane?.id === barrier.laneId
          && state.lastLaneId === barrier.laneId
          && state.lastS < barrier.s && taxi.s >= barrier.s;
        const exited = BARREL && taxi.lane?.id === barrier.exitLaneId
          && state.lastLaneId === barrier.exitLaneId
          && state.lastS < barrier.exitS && taxi.s >= barrier.exitS;
        if (crossed) smash(barrier, taxi);
        else if (exited) {
          barrier.dir = -1;
          barrier.exit = true;
          smash(barrier, taxi);
        }
        continue;
      }

      const u = clamp01((state.t - barrier.hitAt) / TRESTLE_FLIGHT);
      if (u >= 1) continue;
      flying += 1;

      const ease = 1 - (1 - u) ** 2;
      for (const piece of barrier.pieces) {
        piece.mesh.position.set(
          piece.x + piece.throwX * ease,
          Math.sin(Math.PI * u) * 1.25,
          piece.z + TRESTLE_THROW * ease * barrier.dir,
        );
        // Tips away down the road and lands past flat, which reads as slammed rather than as laid
        // down. Negative x swings the top toward +Z, the direction the taxi was going.
        piece.mesh.rotation.set(-1.95 * ease * barrier.dir, piece.yaw + piece.twist * ease, 0);
      }
    }

    return flying;
  }

  function updateWorkers(dt, taxi) {
    const near = state.closedLaneIds.includes(taxi.lane?.id);
    let faded = false;

    for (const worker of workers) {
      // Run finished: they are at the kerb, turned round, looking back at the road. Hold that pose
      // for WORKER_HOLD and then fade them out — a figure standing at a kerb forever beside a
      // wrecked site is the tell that nothing here is going to be cleared up, and a figure that
      // starts dissolving the instant they stop never reads as having got there.
      if (worker.fleeing >= FLEE_DUR) {
        worker.held += dt;
        if (worker.held >= WORKER_HOLD && worker.fade > 0) {
          worker.fade = Math.max(0, worker.fade - dt / WORKER_FADE);
          faded = true;
        }
        continue;
      }

      if (worker.fleeing > 0) {
        worker.fleeing = Math.min(FLEE_DUR, worker.fleeing + dt);
        worker.person.flee(worker.fleeing / FLEE_DUR, worker.dx, worker.dz);
        continue;
      }

      const spooked = near && Math.hypot(
        worker.holder.position.x - taxi.x,
        worker.holder.position.z - taxi.z,
      ) < FLEE_R;
      if (spooked) worker.fleeing = 1e-6;
      else worker.person.idle(state.t, worker.phase);
    }

    if (faded) setAlpha(state.alpha);
  }

  /**
   * Take the zone down and **give the street back**.
   *
   * Reopening is the part that is not cosmetic. `setClosedLanes` is what keeps ambient traffic out
   * and `setRoadworkLanes` is what tempts the taxi in; leaving either set behind would give the
   * city an invisible closure it drives around for the rest of the run, and the router a shortcut
   * down a street with nothing on it — the exact failure the placement rules exist to avoid, only
   * with no barricade to explain it.
   */
  function teardown() {
    state.phase = 'gone';
    setClosedLanes([]);
    setRoadworkLanes([]);

    group.visible = false;
    scene.remove(group);
    // Before the dispose below, not after: the AO prepass holds a hard reference to every occluder
    // and swaps its material each frame, so a freed mesh left enrolled is both a leak and a swap
    // onto disposed geometry.
    unmarkOccluder(group);
    group.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry.dispose();
      object.material.dispose();
    });
    materials.length = 0;
    emit(clearListeners, { edge: state.edge });
  }

  function update(dt, taxi, cars = [], busy = []) {
    if (state.phase === 'gone') return;

    if (state.phase === 'waiting') {
      state.cooldown -= dt;
      if (state.cooldown <= 0) {
        if (!place(taxi, cars, busy)) state.cooldown = RETRY_WAIT;
      }
      return;
    }

    state.t += dt;

    if (state.phase === 'fading') {
      state.fade = Math.min(1, state.fade + dt / FADE_IN);
      const ease = smoothstep(state.fade);
      setAlpha(ease);
      // Grows up out of the road rather than appearing on it. The slab is opaque and drawn first,
      // so the part still below y = 0 fails the depth test and is simply not there yet.
      group.position.y = -RISE * (1 - ease);
      if (state.fade >= 1) {
        state.phase = 'live';
        group.position.y = 0;
      }
      return;
    }

    // Packing up, once the taxi has been through and got clear. Opacity plus a sink back under the
    // road — the mirror of the arrival, and for the same reason it works: the slab is opaque and
    // drawn first, so whatever has gone below y = 0 fails the depth test for free.
    if (state.phase === 'leaving') {
      state.fade = Math.max(0, state.fade - dt / FADE_OUT);
      const ease = smoothstep(state.fade);
      setAlpha(ease);
      group.position.y = -SINK * (1 - ease);
      // Cones and trestles are still finishing their flights underneath this, deliberately: the
      // last thing that happens is not everything stopping, it is everything going.
      updateCones(dt, taxi);
      updateChips(dt);
      updateBarriers(taxi);
      updateWorkers(dt, taxi);
      updateBump(taxi);
      if (state.fade <= 0) teardown();
      return;
    }

    // Occlusion is claimed once the materials are opaque again: markOccluder skips anything
    // transparent, so calling it mid-fade would silently enrol nothing.
    if (!state.occluded) {
      markOccluder(group);
      state.occluded = true;
    }

    if (taxi.crashed) {
      updateBump(taxi);   // writes the bounce back to zero, so a wreck does not freeze mid-jolt
      return;
    }

    updateBarriers(taxi);
    updateCones(dt, taxi);
    updateChips(dt);
    updateWorkers(dt, taxi);
    if (BARREL) {
      updateRubble(taxi);
      updateBump(taxi);
    }

    // Whether the taxi is still in the air off the ramp, which the pack-up below waits on: a site
    // does not start dissolving around a car that is mid-stunt over it.
    //
    // The *landing* is not detected here any more. `hopFrom` is cleared on touchdown, so the only
    // way to see the event from a module ticked afterwards is to hold the previous frame's value —
    // and the taxi is launched off an arched bridge now as well as off a barricade, where there is
    // no roadworks site to be holding anything. `traffic.onTaxiLand` publishes it once, from the
    // frame that clears the flag. See main.js for what hangs off it.
    const airborne = taxi.hopFrom != null;
    state.airborne = airborne;
    state.lastLaneId = taxi.lane?.id ?? null;
    state.lastS = taxi.s;

    // "Through" is *off the closed lanes and back on the ground*, not "has smashed something". The
    // taxi smashes the barricade at the mouth of the street and then has the whole block still to
    // drive; starting the fade at the smash would dissolve the site around it while it is still
    // inside, which is both the wrong beat and the wrong reading — it did not clear the works, it
    // is in them.
    //
    // And the crew has to be gone before the site is, not with it. Every worker flees on the smash,
    // so this is only ever a wait, never a deadlock — but it is a wait the fast case genuinely
    // needs: at overdrive the taxi is clear of the street before the two of them have finished
    // running. Sequencing it here rather than by lengthening LEAVE_DWELL keeps the beat correct at
    // both speeds, where a fixed number is only ever right at one of them.
    const crewGone = workers.every((worker) => worker.fade <= 0);
    if (state.smashed && state.leaveAt === null && crewGone
      && !state.closedLaneIds.includes(taxi.lane?.id) && !airborne) {
      state.leaveAt = state.t + LEAVE_DWELL;
    }
    if (state.leaveAt !== null && state.t >= state.leaveAt) state.phase = 'leaving';
  }

  /** How many pieces are still in the air. Zero once everything has come to rest. */
  function active() {
    let n = 0;
    for (const { items } of pools) {
      for (const cone of items) if (cone.knocked && cone.age < cone.dur) n += 1;
    }
    for (const chip of chips) if (chip.live && chip.age < chip.dur) n += 1;
    for (const barrier of barriers) {
      if (barrier.hit && state.t - barrier.hitAt < TRESTLE_FLIGHT) n += 1;
    }
    return n;
  }

  return {
    group,
    state,
    place,
    update,
    active,
    cones,
    /** The sawhorses at the ends of the hole; empty under `?roadworks=classic`. */
    horses,
    chips,
    barriers,
    /** How many workers are running or have run. For tools/probe.mjs. */
    workersFleeing: () => workers.filter((w) => w.fleeing > 0).length,
    /** ...how many have finished the run and are standing at the kerb. */
    workersClear: () => workers.filter((w) => w.fleeing >= FLEE_DUR).length,
    /** ...and how many have faded out afterwards. The zone waits on this one — see update(). */
    workersGone: () => workers.filter((w) => w.fade <= 0).length,
    get closedLaneIds() { return state.closedLaneIds; },
    onSmash: (cb) => { smashListeners.push(cb); },
    // The taxi going over a rubble pile or a sawhorse, with the bounce's relative size. main.js
    // gives it the `bump` sound and a nudge of shake.
    onBump: (cb) => { bumpListeners.push(cb); },
    /** The rubble piles in the lanes; empty under `?roadworks=classic`. */
    rubble,
    // Fires once, when a zone is stood up, with the two junctions it runs between. main.js uses it
    // to aim one fare's drop-off at the far end of the closed street.
    onPlaced: (cb) => { placeListeners.push(cb); },
    // ...and once when it has been cleared away and the street is open again.
    onCleared: (cb) => { clearListeners.push(cb); },
  };
}
