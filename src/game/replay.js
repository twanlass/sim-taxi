// The crash replay: the moment of impact shown three more times, in quick cuts from three angles.
//
// A wreck ends the run with a live beat — the slow-mo pull-in main.js has always done — and then,
// instead of going straight to the retry card, this cuts to the hit from one side of the fixed
// diagonal, cuts to it from the other side, cuts to it again tight on the diagonal, and hands back:
// cut, crash, cut, crash, cut, crash. Each shot is about a second, opening a beat before the hit.
//
// Two halves, both here:
//
//   - **The tape** (`createTape`). Nothing in the sim can run backwards, so the replay is a
//     *recording*, not a re-simulation: every dynamic InstancedMesh in the scene and every node
//     under the taxi's group, sampled at TAPE_HZ of sim time into a ring. That one rule covers far
//     more than the two cars — the traffic, its lamp pods, and every particle pool the wreck draws
//     with (blast.js, dust.js, sparks.js, flames.js are all instanced, `aAlpha` included), so the
//     fireball in the replay *is* the fireball the player saw rather than a second one fired to
//     look like it. Re-firing was the first idea and it would have been a different explosion.
//   - **The director** (`createCrashReplay`). Scrubs the tape, eases the playback rate down into
//     the impact, picks camera swings off the fixed diagonal that can actually see the crash,
//     and owns the cuts.
//
// What it does *not* record is everything else: boats, pedestrians, the sky, the clouds, skid
// marks. The world is frozen for the replay (main.js skips the whole update block), so those stand
// where the live beat left them — a second or two of difference, none of it in the frame.

import * as THREE from 'three';
import { VIEW_DIR } from './camera.js';
import { heightAt } from './sightline.js';
import { SKYLINE_CEILING } from '../city/buildings.js';

// Sampled in sim time, so the live beat's slow-mo writes no more samples than full speed does.
// 30 rather than 60 because the playback interpolates anyway (see `apply`): a sample is ~150KB
// with every particle pool in it, and at 30Hz the whole ring is ~12MB rather than ~24MB.
const TAPE_HZ = 30;
// Longest stretch the replay can ever ask for, plus the live beat recorded after the impact. The
// recorder stops at the replay's start, so nothing ever ages out from under a playback.
const TAPE_SECONDS = 3.2;
// An instance that moved further than this between two samples was reused, not moved — a pool
// slot handed to a new particle, a car recycled at the map edge. Lerping it would fly it across
// the city in one frame, so it snaps to whichever sample is nearer. Nothing honest covers this in
// a 30th of a second: the taxi at the Loco top is 0.6 units, a blast shard about 1.
const SNAP_DIST = 3;
const SNAP_SQ = SNAP_DIST * SNAP_DIST;

const NODE_STRIDE = 11;         // position 3, quaternion 4, scale 3, visible 1

function isZeroScale(m, o) {
  return m[o] * m[o] + m[o + 1] * m[o + 1] + m[o + 2] * m[o + 2] < 1e-10;
}

/**
 * A ring of samples of everything that moves.
 *
 * @param scene    traversed for dynamic InstancedMeshes (and re-traversed now and then, since some
 *                 pools are built lazily)
 * @param roots    Object3Ds whose whole subtree is recorded node by node — the taxi's group, which
 *                 is a tree of ordinary meshes rather than an instance
 * @param exclude  `(mesh) => bool` for instanced meshes that must stay frozen with the world
 *                 around them — a boat's wake animating behind a boat that is standing still
 */
export function createTape(scene, { roots = [], exclude = () => false } = {}) {
  const size = Math.ceil(TAPE_SECONDS * TAPE_HZ) + 4;
  const times = new Float64Array(size).fill(NaN);
  let head = 0;                 // next slot to write
  let filled = 0;
  let lastT = -Infinity;
  let recording = true;
  let rescanIn = 0;

  // Per instanced mesh: per-slot copies of its matrices, its per-instance attributes and its count.
  const tracks = new Map();
  // Per node under a root: one flat array of NODE_STRIDE per slot.
  const nodes = new Map();
  // The slot a capture() writes into: the live frame, put back when the replay hands over.
  const LIVE = size;

  function trackFor(mesh) {
    let track = tracks.get(mesh);
    if (track) return track;
    const extras = [];
    for (const attr of Object.values(mesh.geometry.attributes)) {
      if (attr.isInstancedBufferAttribute) extras.push(attr);
    }
    track = { mesh, extras, slots: new Array(size + 1).fill(null) };
    tracks.set(mesh, track);
    return track;
  }

  function scan() {
    scene.traverse((o) => {
      if (o.isInstancedMesh && o.instanceMatrix.usage === THREE.DynamicDrawUsage && !exclude(o)) {
        trackFor(o);
      }
    });
  }

  function writeSlot(slot) {
    for (const track of tracks.values()) {
      const { mesh, extras } = track;
      let rec = track.slots[slot];
      // Reallocated if the mesh's own buffer has grown since — the ⚙️ panel's car slider rebuilds
      // the traffic at a new size, and a short copy target throws rather than truncating.
      if (!rec || rec.matrix.length < mesh.instanceMatrix.array.length) {
        // Sized to capacity once, so a pool that grows its count never reallocates mid-run.
        rec = {
          count: 0,
          matrix: new Float32Array(mesh.instanceMatrix.array.length),
          color: mesh.instanceColor ? new Float32Array(mesh.instanceColor.array.length) : null,
          extras: extras.map((a) => new Float32Array(a.array.length)),
        };
        track.slots[slot] = rec;
      }
      const n = mesh.count;
      rec.count = n;
      rec.matrix.set(mesh.instanceMatrix.array.subarray(0, n * 16));
      if (rec.color && mesh.instanceColor) rec.color.set(mesh.instanceColor.array.subarray(0, n * 3));
      for (let k = 0; k < extras.length; k++) {
        const a = extras[k];
        rec.extras[k].set(a.array.subarray(0, n * a.itemSize));
      }
      rec.valid = true;
    }
    for (const root of roots) {
      root.traverse((node) => {
        let data = nodes.get(node);
        if (!data) {
          data = { values: new Float32Array((size + 1) * NODE_STRIDE), has: new Uint8Array(size + 1) };
          nodes.set(node, data);
        }
        const o = slot * NODE_STRIDE;
        const v = data.values;
        v[o] = node.position.x; v[o + 1] = node.position.y; v[o + 2] = node.position.z;
        v[o + 3] = node.quaternion.x; v[o + 4] = node.quaternion.y;
        v[o + 5] = node.quaternion.z; v[o + 6] = node.quaternion.w;
        v[o + 7] = node.scale.x; v[o + 8] = node.scale.y; v[o + 9] = node.scale.z;
        v[o + 10] = node.visible ? 1 : 0;
        data.has[slot] = 1;
      });
    }
  }

  /**
   * Called once a frame, after everything has moved and before the render. `force` takes a sample
   * whatever the rate says — main.js forces the impact frame, so the last picture before the
   * wreck and the first one after it are a frame apart rather than up to a 30th of a second.
   */
  function record(t, force = false) {
    if (!recording) return;
    if (!force && t - lastT < 1 / TAPE_HZ - 1e-6) return;
    if (rescanIn <= 0) { scan(); rescanIn = TAPE_HZ; }
    rescanIn--;
    lastT = t;
    times[head] = t;
    // Invalidate before writing: a track seen for the first time has nothing in older slots, and
    // a reused slot must not read as the sample it held a lap ago.
    for (const track of tracks.values()) if (track.slots[head]) track.slots[head].valid = false;
    for (const data of nodes.values()) data.has[head] = 0;
    writeSlot(head);
    head = (head + 1) % size;
    filled = Math.min(filled + 1, size);
  }

  /** The earliest and latest sim times on the tape. */
  function span() {
    if (!filled) return null;
    const newest = (head - 1 + size) % size;
    const oldest = filled < size ? 0 : head;
    return { start: times[oldest], end: times[newest] };
  }

  /** The two slots either side of `t`, and how far between them it is. */
  function bracket(t) {
    let a = -1;
    let b = -1;
    for (let k = 0; k < filled; k++) {
      const slot = (head - filled + k + size) % size;
      const st = times[slot];
      if (st <= t) a = slot;
      if (st >= t) { b = slot; break; }
    }
    if (a < 0) a = b;
    if (b < 0) b = a;
    const ta = times[a];
    const tb = times[b];
    return { a, b, alpha: tb > ta ? (t - ta) / (tb - ta) : 0 };
  }

  function applyTrack(track, A, B, alpha) {
    const { mesh, extras } = track;
    if (!A?.valid) A = B;
    if (!B?.valid) B = A;
    if (!A?.valid) return;      // a mesh the tape never saw in this stretch is left as it stands
    const near = alpha < 0.5 ? A : B;
    const n = near.count;
    mesh.count = n;
    const out = mesh.instanceMatrix.array;
    const ma = A.matrix;
    const mb = B.matrix;
    const blend = A !== B && alpha > 0 && alpha < 1;
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      const both = blend && i < A.count && i < B.count;
      const zeroA = both && isZeroScale(ma, o);
      const zeroB = both && isZeroScale(mb, o);
      let lerp = both && !zeroA && !zeroB;
      // An instance that appears or is retired between two samples holds the *earlier* one until
      // the later lands, rather than going to whichever is nearer. Whatever made the change
      // happened at or before the sample that shows it, and on the one change the replay is
      // about — a struck car collapsed to ZERO_MATRIX by `wreckShell` — that sample is forced on
      // the impact frame, so it sits at exactly `t0`, the age `wreckage.seek` brings the shell in
      // at. Nearest-sample retired the instance half a sample early, up to 1/60 of a sim second
      // with neither the instance nor the shell drawn, and under the replay's 0.5 and 0.25
      // slow-mo that was a 33-67ms blink of the struck car just before every cut's blast.
      const step = zeroA !== zeroB;
      if (lerp) {
        const dx = mb[o + 12] - ma[o + 12];
        const dy = mb[o + 13] - ma[o + 13];
        const dz = mb[o + 14] - ma[o + 14];
        lerp = dx * dx + dy * dy + dz * dz < SNAP_SQ;
      }
      if (lerp) {
        for (let e = 0; e < 16; e++) out[o + e] = ma[o + e] + (mb[o + e] - ma[o + e]) * alpha;
      } else {
        const src = (step ? A : near).matrix;
        for (let e = 0; e < 16; e++) out[o + e] = src[o + e];
      }
      const held = step ? A : near;
      if (held.color && mesh.instanceColor) {
        const c = mesh.instanceColor.array;
        const ca = A.color;
        const cb = B.color;
        for (let e = i * 3; e < i * 3 + 3; e++) c[e] = lerp ? ca[e] + (cb[e] - ca[e]) * alpha : held.color[e];
      }
      for (let k = 0; k < extras.length; k++) {
        const size_ = extras[k].itemSize;
        const dst = extras[k].array;
        const xa = A.extras[k];
        const xb = B.extras[k];
        const xn = held.extras[k];
        for (let e = i * size_; e < (i + 1) * size_; e++) dst[e] = lerp ? xa[e] + (xb[e] - xa[e]) * alpha : xn[e];
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    for (const a of extras) a.needsUpdate = true;
  }

  const qa = new THREE.Quaternion();
  function applyNode(node, data, a, b, alpha) {
    if (!data.has[a]) a = b;
    if (!data.has[b]) b = a;
    if (!data.has[a]) return;
    const v = data.values;
    const oa = a * NODE_STRIDE;
    const ob = b * NODE_STRIDE;
    const lerp = (k) => v[oa + k] + (v[ob + k] - v[oa + k]) * alpha;
    node.position.set(lerp(0), lerp(1), lerp(2));
    qa.set(v[oa + 3], v[oa + 4], v[oa + 5], v[oa + 6]);
    node.quaternion.set(v[ob + 3], v[ob + 4], v[ob + 5], v[ob + 6]);
    node.quaternion.copy(qa.slerp(node.quaternion, alpha));
    node.scale.set(lerp(7), lerp(8), lerp(9));
    node.visible = v[(alpha < 0.5 ? oa : ob) + 10] > 0.5;
  }

  /** Draw the scene as it stood at sim time `t`. */
  function apply(t) {
    const { a, b, alpha } = bracket(t);
    if (a < 0) return;
    for (const track of tracks.values()) applyTrack(track, track.slots[a], track.slots[b], alpha);
    for (const [node, data] of nodes) applyNode(node, data, a, b, alpha);
  }

  /** Where a recorded node stood at sim time `t`, or null. */
  function positionAt(node, t, out = new THREE.Vector3()) {
    const data = nodes.get(node);
    if (!data) return null;
    const { a, b, alpha } = bracket(t);
    if (a < 0 || !data.has[a] || !data.has[b]) return null;
    const v = data.values;
    const oa = a * NODE_STRIDE;
    const ob = b * NODE_STRIDE;
    return out.set(
      v[oa] + (v[ob] - v[oa]) * alpha,
      v[oa + 1] + (v[ob + 1] - v[oa + 1]) * alpha,
      v[oa + 2] + (v[ob + 2] - v[oa + 2]) * alpha,
    );
  }

  /** Stop sampling, and keep what the world looks like right now to hand back to afterwards. */
  function capture() {
    recording = false;
    scan();
    for (const track of tracks.values()) if (track.slots[LIVE]) track.slots[LIVE].valid = false;
    for (const data of nodes.values()) data.has[LIVE] = 0;
    writeSlot(LIVE);
  }

  /** Put back what `capture()` kept. */
  function restore() {
    for (const track of tracks.values()) applyTrack(track, track.slots[LIVE], track.slots[LIVE], 0);
    for (const [node, data] of nodes) applyNode(node, data, LIVE, LIVE, 0);
  }

  return {
    record, span, apply, positionAt, capture, restore,
    /** For the headless check: how many meshes and nodes are being taped. */
    stats: () => ({ tracks: tracks.size, nodes: nodes.size, samples: filled }),
  };
}

// --- The director --------------------------------------------------------------------------------

// The three cuts. Each opens `pre` sim seconds before the impact — just enough to see the two cars
// meet, not the approach — runs `post` past it, and pushes in from `zoomFrom` to `zoomTo` (frustum
// half-heights; the live beat holds at 26). `side` is which way off the diagonal it swings: one
// side, the other, then square on and tightest for the last word. The rhythm is the point — a first
// cut that opened a second early and played the whole approach read as a replay *package*, and the
// three-beat stutter reads as the crash being too big to show once. `hold` is wall seconds the shot
// stays on its last frame before handing back, the camera still drifting round on its orbit: the
// last word wants a beat to land, and it cannot be bought with more `post` — the tape only runs as
// far past the hit as the live beat recorded (see REPLAY_LEAD in main.js). `slow` and `ramp`
// override the playback rate below for one shot: the last word sinks to a quarter speed over a
// longer ease, so the hit lands in real slow motion rather than at the 0.5 the first two cuts
// stutter at. That slow-mo stretches the shot's own 0.45s of blast to 1.8s of wall clock, which
// buys what most of the old 0.7s hold was for, so the hold is shorter.
const SHOTS = [
  { pre: 0.3, post: 0.3, zoomFrom: 17, zoomTo: 14, side: 1 },
  { pre: 0.3, post: 0.3, zoomFrom: 14, zoomTo: 11.5, side: -1 },
  { pre: 0.3, post: 0.45, zoomFrom: 11, zoomTo: 9, side: 0, slow: 0.25, ramp: 0.22, hold: 0.4 },
];
// The furthest past the impact any shot plays, in sim seconds. The tape only holds what the live
// beat recorded after the hit, which is what sets REPLAY_LEAD's floor in main.js.
export const REPLAY_POST = Math.max(...SHOTS.map((s) => s.post));

// Playback rate, as a fraction of real time: near full speed into the hit, dropping over the last
// RAMP seconds before it and holding there through the blast. At these numbers a 0.3 + 0.3 shot is
// ~0.95s of wall clock, and the last (at its own 0.25 over a 0.22 ramp) ~2.4s plus its 0.4s hold —
// about 4.7s for all three.
const FAST = 0.8;
const SLOW = 0.5;
const RAMP = 0.12;

// How far each shot swings off the fixed diagonal, in degrees — tried in this order on each side
// and the first one that can see the crash wins (see `scoreYaw`). Kept within 50° on purpose: the
// city has only ever been looked at from one direction, and the further round the camera goes the
// more of what was built for that one view turns up in frame (see the note on `yaw` in camera.js).
const YAW_CHOICES = [35, 28, 42, 22, 50];
// And a slow orbit on top during the shot, away from the diagonal, so a shot is never a still.
const ORBIT_DEG = 7;
// The shake the replay kicks as it crosses the impact — under the live beat's 2.4 because the
// replay is tighter in, and the same world-unit jitter is a bigger fraction of a smaller frame.
const REPLAY_SHAKE = 1.4;
// The narrowest the frame may be, as a fraction of the zoom. The zooms above are half-*heights*,
// which on a portrait phone (aspect ~0.46) leaves a frame 19 units across at the first shot's 21 —
// and the taxi, ten units off centre on the approach, opened the replay out of shot. Below this
// the shot widens to keep the half-width, rather than cropping the thing it exists to show.
const MIN_HALF_WIDTH = 0.75;
// How long the white flash on each cut takes to clear, in ms.
const FLASH_MS = 260;

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function rate(u, shot) {
  const slow = shot.slow ?? SLOW;
  const ramp = shot.ramp ?? RAMP;
  if (u >= 0) return slow;
  if (u <= -ramp) return FAST;
  const s = 1 + u / ramp;                        // 0 at the start of the ramp, 1 at the impact
  return FAST + (slow - FAST) * s * s * (3 - 2 * s);
}

const viewDir = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Can a camera swung by `yaw` see the point (x, y, z)? A march along the swung view direction
 * through the same height field the fare board's corner test uses (game/sightline.js), which that
 * module cannot do itself: its march is hard-wired to the one view direction it has ever needed.
 */
function clearAlong(x, y, z, yaw) {
  viewDir.copy(VIEW_DIR).applyAxisAngle(Y_AXIS, yaw);
  const step = 0.5;
  for (let d = 0.75; d < 200; d += step) {
    const py = y + viewDir.y * d;
    if (py > SKYLINE_CEILING) return true;
    if (heightAt(x + viewDir.x * d, z + viewDir.z * d) > py) return false;
  }
  return true;
}

/**
 * Score a swing by how much of the crash it can see: the impact point and two points back along
 * the taxi's approach, at bonnet height. A tower between the camera and the wreck is the one way
 * this feature can fail outright, and the city is full of them.
 */
function scoreYaw(points, yaw) {
  let score = 0;
  for (const p of points) if (clearAlong(p.x, p.y, p.z, yaw)) score += p.weight;
  return score;
}

function pickYaw(points, side) {
  if (!side) return 0;
  let best = null;
  let bestScore = -1;
  for (const deg of YAW_CHOICES) {
    const yaw = side * THREE.MathUtils.degToRad(deg);
    const score = scoreYaw(points, yaw);
    if (score > bestScore) { best = yaw; bestScore = score; }
  }
  return best;
}

/**
 * @param tape        from createTape — must have the taxi's group as one of its roots
 * @param controller  the city camera controller (game/camera.js)
 * @param aspect      () => the viewport's aspect ratio
 * @param wreckage    game/wreckage.js — scrubbed alongside the tape with `seek`
 * @param scrub       anything else drawn as a closed form of the impact's age, scrubbed the same
 *                    way (`seek(age)`, then `seek()` to hand it back) — the ejected driver
 *                    (game/ejection.js), whose tumble is too fast to survive the tape's 30Hz
 * @param taxiGroup   the taxi's drawn group, which the camera tracks on the approach
 * @param overlay     the `#replay` element: the flash on each cut, and the tap that skips
 * @param onImpact    called each time a shot crosses the moment of impact — the sound
 * @param hide        objects taken out of the picture for the length of the replay: anything
 *                    placed by where it lands on *screen* rather than in the world, which a swung
 *                    camera puts somewhere it was never meant to be. The clouds are (game/clouds.js
 *                    rings the island in screen space), and the first replay drew one over the road
 *                    beside the wreck. Nothing in here may carry a light — see CLAUDE.md on hidden
 *                    lights recompiling the city.
 */
export function createCrashReplay({
  tape, controller, aspect, wreckage, taxiGroup, overlay, onImpact = () => {}, hide = [], scrub = [],
}) {
  let crash = null;             // { t0, x, z, yaw } — armed at the impact
  let run = null;               // the replay in progress
  const taxiAt = new THREE.Vector3();

  const flash = overlay?.querySelector('.replay-flash');

  function cutFlash() {
    if (!flash) return;
    flash.getAnimations().forEach((a) => a.cancel());
    flash.animate([{ opacity: 0.85 }, { opacity: 0 }], { duration: FLASH_MS, easing: 'ease-out' });
  }

  /** Called on the impact frame: when it was, where, and which way the taxi was heading. */
  function arm({ t0, x, z, yaw }) {
    crash = { t0, x, z, yaw };
  }

  function beginShot(index) {
    const shot = SHOTS[index];
    run.index = index;
    run.shot = shot;
    run.from = Math.max(crash.t0 - shot.pre, run.tapeStart);
    run.to = crash.t0 + Math.max(0, Math.min(shot.post, run.recorded));
    run.t = run.from;
    run.hit = false;
    run.held = 0;
    run.yaw = run.yaws[index];
    controller.state.shake = 0;
    cutFlash();
    frame(0);
  }

  /**
   * Start the replay. Returns false — and the caller falls back to the plain run-end hold — if
   * there is nothing worth showing: no crash armed, or a tape too short to reach back before it.
   */
  function start() {
    if (!crash || run) return false;
    const span = tape.span();
    if (!span || span.start > crash.t0 - 0.2) return false;

    tape.capture();
    const fx = Math.cos(crash.yaw);
    const fz = -Math.sin(crash.yaw);
    const points = [
      { x: crash.x, y: 0.8, z: crash.z, weight: 3 },
      { x: crash.x - fx * 6, y: 0.8, z: crash.z - fz * 6, weight: 1 },
      { x: crash.x - fx * 12, y: 0.8, z: crash.z - fz * 12, weight: 1 },
    ];
    const { target, zoom } = controller.state;
    run = {
      // Where the live beat had the camera, to hand it back to on the way out: the live focus then
      // carries on easing in from exactly where it was, as if the replay had never cut in.
      live: { x: target.x, z: target.z, zoom },
      tapeStart: span.start,
      recorded: span.end - crash.t0,
      yaws: SHOTS.map((s) => pickYaw(points, s.side)),
    };
    run.shown = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    overlay?.removeAttribute('hidden');
    document.body.classList.add('replaying');
    beginShot(0);
    return true;
  }

  /** Lay out the frame at the current playhead and point the camera at it. */
  function frame(wallDt) {
    const u = run.t - crash.t0;
    tape.apply(run.t);
    wreckage.seek(u);
    for (const s of scrub) s.seek(u);

    // Halfway between the taxi and the impact on the approach: the wreck site stays in frame from
    // the first frame and the taxi drives into it, rather than the camera chasing a car to a point
    // it only reveals at the last moment. Converges on the impact point as the taxi arrives.
    const p = tape.positionAt(taxiGroup, run.t, taxiAt) ?? taxiAt.set(crash.x, 0, crash.z);
    const tx = (crash.x + p.x) / 2;
    const tz = (crash.z + p.z) / 2;

    const span = run.to - run.from;
    const k = span > 0 ? THREE.MathUtils.clamp((run.t - run.from) / span, 0, 1) : 1;
    // The hold keeps the orbit going at the rate the shot ended on, so a held frame is never a still.
    const wallSpan = span / (run.shot.slow ?? SLOW);
    const orbitK = k + (wallSpan > 0 ? run.held / wallSpan : 0);
    const ratio = aspect();
    const zoom = (run.shot.zoomFrom + (run.shot.zoomTo - run.shot.zoomFrom) * easeInOut(k))
      * Math.max(1, MIN_HALF_WIDTH / ratio);
    const yaw = run.yaw + Math.sign(run.yaw) * THREE.MathUtils.degToRad(ORBIT_DEG) * orbitK;
    controller.cutTo(tx, tz, zoom, yaw, ratio);
    if (wallDt > 0) controller.updateShake(wallDt, aspect());
  }

  /** Tick on wall time. Returns true while the replay holds the frame. */
  function update(wallDt) {
    if (!run) return false;
    const before = run.t - crash.t0;
    run.t = Math.min(run.to, run.t + wallDt * rate(before, run.shot));
    if (!run.hit && run.t >= crash.t0) {
      run.hit = true;
      controller.kickShake(REPLAY_SHAKE);
      onImpact(run.index);
    }
    if (run.t >= run.to && run.hit) run.held += wallDt;
    frame(wallDt);
    if (run.t >= run.to && run.held >= (run.shot.hold ?? 0)) {
      if (run.index + 1 < SHOTS.length) beginShot(run.index + 1);
      else finish();
    }
    return Boolean(run);
  }

  /** Hand the world back as the live beat left it. Also what a tap does, at any point. */
  function finish() {
    if (!run) return;
    tape.restore();
    wreckage.seek();
    for (const s of scrub) s.seek();
    controller.state.shake = 0;
    controller.cutTo(run.live.x, run.live.z, run.live.zoom, 0, aspect());
    hide.forEach((o, k) => { o.visible = run.shown[k]; });
    overlay?.setAttribute('hidden', '');
    document.body.classList.remove('replaying');
    run = null;
    crash = null;
    cutFlash();
  }

  return {
    arm,
    start,
    update,
    skip: finish,
    armed: () => Boolean(crash),
    active: () => Boolean(run),
    /** For the headless check and `__taxi`: which shot, and where the playhead is against the hit. */
    progress: () => (run ? { shot: run.index, u: run.t - crash.t0, yaw: run.yaw } : null),
  };
}
