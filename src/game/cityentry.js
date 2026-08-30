import * as THREE from 'three';
import { KERB_H } from '../city/ground.js';
import { HALF_SPAN_X, HALF_SPAN_Z } from '../city/grid.js';
import { setOccluderDepthMaterial } from './ssao.js';

// The city's entrance: streets and ground are already in place, then the buildings and trees
// grow out of them in a wave — rise from the kerb, fade in, overshoot their full size and settle
// back — with a puff of dust around each building as it breaks ground.
//
// **PROTOTYPE.** The whole animation runs in the vertex shader against the two merged city
// meshes, because the merge is the one thing this must not undo: buildings collapse into a
// single mesh precisely so the city is one draw call, and splitting it back into seventy
// animated objects would trade the game's baseline cost for a two-second flourish. Instead every
// vertex carries its building's ground anchor in an `aEntry` attribute (see `stampEntry` in
// util/geo.js) and one uniform clock drives them all; a vertex scales about its own anchor, so
// whole buildings pop individually out of a mesh that never stops being one mesh.
//
// The one thing that mechanism cannot animate is an object with a transform of its own, because
// the anchor it scales about is a *world* coordinate baked into the vertex — see `objects` below,
// which grows those on the CPU on the same curve.
//
// The per-object timeline, in local t over ENTRY_DUR seconds:
//   - scale runs an easeOutBack from 0: rises out of the ground, overshoots its full size
//     (by OVERSHOOT — the peak's timing and height both follow it), settles at exactly 1 —
//     the "overscale pop" beat in one curve.
//   - XZ runs the same curve mapped onto [XZ_FROM, 1], so a mass swells outward a little as it
//     rises rather than telescoping up at full footprint.
//   - alpha fades in over the first FADE_IN of t, then holds at 1.
//
// Traps this already stepped around, so a future pass doesn't step back in:
//   - `customProgramCacheKey` on every patched material, *composed with* the key already there —
//     propMaterial() may carry the SSAO patch, and two different onBeforeCompiles sharing one
//     cache key silently get one program (the diamond-fill bug, see CLAUDE.md).
//   - *Every* depth pass renders through a depth material, not the lit one, so an unpatched one
//     draws the finished building. That is both the sun's shadow map and the SSAO prepass, and
//     both are patched below. The depth patch also discards unrevealed fragments: a scale-0
//     building is a *flat sheet at kerb height*, not nothing, and it casts a footprint-shaped
//     shadow.
//   - The same discard runs in the lit material, because that flat sheet also writes depth —
//     invisible at alpha 0, but still able to clip pixels out of whatever crosses kerb height.
//   - Shot mode ticks once and freezes, so anything driven off sim time is stuck on its first
//     frame — an entrance that opens at zero would empty every screenshot of its city. `settle()`
//     lands the whole animation instantly; main.js calls it beside `fares.settleMarkers()`.
//
// Known prototype shortcuts: the meshes stay `transparent` only while the entrance runs (flipped
// back on finish — a merged transparent city can't self-sort, but at a fast fade nothing shows);
// and the discard branch stays compiled in afterwards, where its cost is a clamped no-op per
// vertex and a dead branch per fragment.

// The wave: each object's delay is its distance from the wave's origin times WAVE, plus its own
// hashed share of JITTER so a ring of same-radius buildings doesn't land as one stamped rank.
// The origin is the taxi's spawn — the run starts where the player's car is, and the city builds
// itself outward from them — which is why it is a uniform rather than baked into the delay: the
// spawn isn't known when the vertices are stamped.
//
// These four are *defaults*: each backs a live uniform so the ⚙️ panel can scrub them and replay
// (see `tune` below). A value that survives tuning gets promoted back into its constant here —
// which is exactly where this set came from: tuned by hand in the panel, 2026-08-14.
//
// The feel it lands on is quick-and-snappy over slow-and-processional: a brisk sweep (the far
// corner is 90–130 units from a typical spawn, so the wave crosses the city in ~1.4–2s), each
// object popping up in under a third of a second, and ZERO jitter — with a sweep this fast the
// per-object scatter read as noise, where clean distance rings read as one wavefront. The pop is
// the loudest of the four: 3.9 peaks at +37%, well into cartoon territory, and that is the point —
// at 0.3s a subtler overshoot was over before it registered.
const WAVE = 0.015;
const JITTER = 0;
const ENTRY_DUR = 0.3;
// easeOutBack's overshoot parameter — see the note above; peak lands around t = 0.47 of the grow.
const OVERSHOOT = 3.9;
const XZ_FROM = 0.65;
const FADE_IN = 0.3;

// When a building's dust fires, relative to its own delay: just after its roofline clears the
// kerb, which is the frame the ground visibly gives it up.
const DUST_AT = 0.08;
// Small against the pool's biggest bursts — the barricade throws 26 at power 1+, but that is one
// event; this is one burst per building across the whole city, drawn from the same 140-slot ring
// buffer. Seven is up from a first pass at five, which alongside the weaker power below simply
// never registered from a whole-city framing.
const DUST_COUNT = 7;

const f = (n) => Number(n).toFixed(4);

// The tunable levers ride in uniforms (`uEntryWave` and friends below); only the values nobody
// scrubs — the pivot height, the footprint swell, the fade window — are baked as literals.
const ENTRY_VERTEX = `#include <begin_vertex>
	// This vertex's object in its entrance: 0 = still underground, 1 = settled. Mirrors delayOf().
	float eT = clamp((uEntryTime - (distance(aEntry.xy, uEntryFrom) * uEntryWave + aEntry.z * uEntryJitter)) / uEntryDur, 0.0, 1.0);
	// easeOutBack: 0 at 0, peaks past 1 partway through (height and timing set by uEntryOver),
	// exactly 1 at 1.
	float eB = eT - 1.0;
	float eS = 1.0 + (uEntryOver + 1.0) * eB * eB * eB + uEntryOver * eB * eB;
	transformed.y = ${f(KERB_H)} + (transformed.y - ${f(KERB_H)}) * eS;
	float eXZ = mix(${f(XZ_FROM)}, 1.0, eS);
	transformed.x = aEntry.x + (transformed.x - aEntry.x) * eXZ;
	transformed.z = aEntry.y + (transformed.z - aEntry.y) * eXZ;
	vEntryFade = smoothstep(0.0, ${f(FADE_IN)}, eT);`;

export function createCityEntry({
  meshes, objects = [], sites = [], dust = null, from = { x: 0, z: 0 },
} = {}) {
  // One clock, shared by reference into every patched shader — Three reads `.value` at draw time,
  // the same way the AO uniforms fan out from one bag in util/geo.js. The origin travels the same
  // way, so `replay` can re-aim the wave without touching a single compiled program.
  const uEntryTime = { value: 0 };
  const uEntryFrom = { value: new THREE.Vector2(from.x, from.z) };
  // The levers, live. Uniforms rather than baked literals so the ⚙️ panel can scrub them and hit
  // replay without a single shader recompile. `dustBoost` is the odd one out — the dust runs on
  // the CPU, so it is a plain multiplier read at burst time.
  const uEntryWave = { value: WAVE };
  const uEntryJitter = { value: JITTER };
  const uEntryDur = { value: ENTRY_DUR };
  const uEntryOver = { value: OVERSHOOT };
  let dustBoost = 1;

  // The per-object delay, in JS for the dust schedule. The GLSL above computes the *same*
  // formula from the same stamped anchor and uniforms — change one and the dust stops meeting
  // its building.
  const delayOf = (x, z, rand) =>
    Math.hypot(x - uEntryFrom.value.x, z - uEntryFrom.value.y) * uEntryWave.value
    + rand * uEntryJitter.value;

  // Past the furthest corner's delay plus one full grow — every eT clamps to 1 from here on.
  // Measured from the origin, not the centre: a taxi spawned near an edge pushes the far corner
  // out toward 140 units, and an end computed from the centre would cut that corner off mid-pop.
  // A function of the live origin rather than a constant, because `replay` can re-aim the wave.
  const endAt = () => {
    const cornerDist = Math.max(
      ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) =>
        Math.hypot(sx * HALF_SPAN_X - uEntryFrom.value.x, sz * HALF_SPAN_Z - uEntryFrom.value.y)),
    );
    return cornerDist * uEntryWave.value + uEntryJitter.value + uEntryDur.value + 0.1;
  };

  const patchVertex = (shader) => {
    Object.assign(shader.uniforms, { uEntryTime, uEntryFrom, uEntryWave, uEntryJitter, uEntryDur, uEntryOver });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute vec3 aEntry;\nuniform float uEntryTime;\nuniform vec2 uEntryFrom;'
        + '\nuniform float uEntryWave;\nuniform float uEntryJitter;\nuniform float uEntryDur;\nuniform float uEntryOver;'
        + '\nvarying float vEntryFade;')
      .replace('#include <begin_vertex>', ENTRY_VERTEX);
  };

  // The discard is not decoration — see the flat-sheet note in the header. It guards both the
  // shadow pass and the main pass's depth writes while an object hasn't appeared yet.
  const patchFragment = (shader, { alpha }) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vEntryFade;')
      .replace('void main() {', 'void main() {\n\tif (vEntryFade <= 0.004) discard;');
    if (alpha) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <dithering_fragment>',
          '#include <dithering_fragment>\n\tgl_FragColor.a *= vEntryFade;');
    }
  };

  const materials = [];
  for (const mesh of meshes) {
    const material = mesh.material;
    const prevCompile = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey;
    // Composed, not replaced: with AO on this material already carries the 'prop-ssao' key, and
    // colliding with the unpatched flat-shaded Lamberts is exactly the trap the key exists for.
    material.customProgramCacheKey = () => `${prevKey ? prevKey.call(material) : ''}|city-entry`;
    material.onBeforeCompile = (shader) => {
      if (prevCompile) prevCompile(shader);
      patchVertex(shader);
      patchFragment(shader, { alpha: true });
    };
    material.transparent = true;
    materials.push(material);

    // The two depth passes. Both need the same patch for the same reason — a depth pass renders
    // through a depth material, not the lit one, so unpatched it draws the finished building — and
    // both need the discard, because a scale-0 building is a *flat sheet at kerb height* rather
    // than nothing, and a sheet stamps a footprint-shaped hole into whatever reads the buffer.
    //
    // Two instances rather than one shared: three's shadow map assigns `side` on the material it
    // is handed every frame, flipping FrontSide to BackSide, so a shared instance would have the
    // AO prepass stamping the depth of each building's far wall. See `setOccluderDepthMaterial`.
    const makeDepth = () => {
      const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
      depth.customProgramCacheKey = () => 'city-entry-depth';
      depth.onBeforeCompile = (shader) => {
        patchVertex(shader);
        patchFragment(shader, { alpha: false });
      };
      return depth;
    };
    // The sun's pass — without this the whole city's shadows arrive on frame one.
    mesh.customDepthMaterial = makeDepth();
    // The AO prepass — without this the city's *contact shadows* arrive on frame one, drawn
    // around edges and corners that have not risen out of the ground yet. It reads worse than the
    // early shadows would have, because AO is sampled in screen space: the crease lands on
    // whatever is visible at those pixels, which during the wave is bare road.
    setOccluderDepthMaterial(mesh, makeDepth());
  }

  // --- The objects the shader cannot reach ---------------------------------
  //
  // Everything above rides in one merged mesh precisely so the city stays one draw call, and the
  // wave is a vertex shader for exactly that reason. That mechanism has one requirement: the
  // anchor a vertex scales about is stamped in **world** coordinates, so the mesh's own transform
  // has to be the identity. Anything that *moves* is therefore excluded from it by construction —
  // the burger turning over the drive-through (city/burgerjoint.js) is the case that made this
  // list exist, since a rotating object's local space is not world space and the stamped anchor
  // stops meaning anything the moment it turns.
  //
  // So those grow on the CPU instead, on the same easeOutBack over the same delay: one `scale.set`
  // per object per frame, against however many hundred vertices the shader is doing the same
  // arithmetic to. `object.scale` is the whole of what this owns — position, rotation and
  // visibility all stay with whoever built the thing.
  const grown = objects.map((entry) => ({
    ...entry,
    // Whatever the object was authored at, so a sign built at 1.4 comes up to 1.4 and not to 1.
    rest: entry.object.scale.clone(),
  }));

  const easeOutBack = (t) => {
    const b = t - 1;
    return 1 + (uEntryOver.value + 1) * b * b * b + uEntryOver.value * b * b;
  };

  const applyObjects = () => {
    for (const g of grown) {
      const t = THREE.MathUtils.clamp(
        (uEntryTime.value - delayOf(g.x, g.z, g.rand)) / uEntryDur.value, 0, 1,
      );
      const k = easeOutBack(t);
      g.object.scale.set(g.rest.x * k, g.rest.y * k, g.rest.z * k);
      // A scale of exactly 0 leaves a degenerate matrix three still has to draw, and the object is
      // a separate mesh rather than a slice of a merged one — so it can simply be switched off.
      g.object.visible = t > 0;
    }
  };
  applyObjects();

  // Dust fires in delay order, so playback is one pointer walking a sorted list. Rebuilt on every
  // replay, because the delays are a function of the origin and the tunable levers.
  const buildQueue = () => sites
    .map((s) => ({ ...s, at: delayOf(s.x, s.z, s.rand) + DUST_AT }))
    .sort((a, b) => a.at - b.at);
  let queue = buildQueue();
  let head = 0;
  let done = false;

  const finish = () => {
    done = true;
    uEntryTime.value = endAt();
    head = queue.length;
    applyObjects();
    // Back to opaque: alpha is 1 everywhere from here on, and a transparent merged city would
    // keep paying the sorted-pass cost (and self-sort wrong) forever. No recompile — the flag is
    // render state, not a shader define.
    for (const material of materials) material.transparent = false;
  };

  function update(dt) {
    if (done) return;
    uEntryTime.value += dt;
    applyObjects();

    while (head < queue.length && queue[head].at <= uEntryTime.value) {
      const s = queue[head];
      head += 1;
      // The hashed jitter doubles as the burst's yaw — any spread of headings works, it just
      // must not be the same one every time. Ring at half the footprint so the puffs open
      // around the walls rather than inside them. Power runs ~0.9–1.25 with footprint, and they
      // start most of the way up the size curve: the first pass (five puffs at 0.55–0.75,
      // startSize 0.75) never registered at play zoom — a cloud two units wide on a whole-city
      // framing is a couple of pixels of haze.
      const power = Math.min(1.25, 0.72 + s.r * 0.09) * dustBoost;
      if (power > 0.05) {
        dust?.burst(s.x, s.z, s.rand * Math.PI * 2, DUST_COUNT, power, {
          ring: s.r * 0.55, linger: 1.15, startSize: 1.0,
        });
      }
    }

    if (uEntryTime.value >= endAt()) finish();
  }

  /** Land the whole entrance instantly — the shot path calls this beside `settleMarkers()`. */
  function settle() {
    finish();
  }

  /**
   * Run it again from the top, for iterating from the console: `__taxi.cityEntry.replay()`.
   * An optional `{ x, z }` re-aims the wave — `replay(__taxi.traffic.taxi)` sweeps from wherever
   * the car is right now.
   */
  function replay(from2 = null) {
    if (from2) uEntryFrom.value.set(from2.x, from2.z);
    // Always rebuilt, not only on a re-aim: the dust delays bake in the wave/jitter levers, and a
    // replay after a `tune` would otherwise fire every burst on the old schedule.
    queue = buildQueue();
    uEntryTime.value = 0;
    head = 0;
    done = false;
    applyObjects();
    for (const material of materials) material.transparent = true;
  }

  /**
   * Read the levers, for the ⚙️ panel's sliders and its settings-JSON export. `grow` is
   * ENTRY_DUR's public name — "duration" next to "wave" reads as the whole entrance's length,
   * which it is not.
   */
  function tuning() {
    return {
      wave: uEntryWave.value,
      jitter: uEntryJitter.value,
      grow: uEntryDur.value,
      overshoot: uEntryOver.value,
      dust: dustBoost,
    };
  }

  /**
   * Move any subset of the levers. Live — the uniforms feed compiled programs, so a mid-flight
   * change shows on the next frame — but the dust schedule only re-bakes on `replay()`, which is
   * how the panel uses this: scrub, release, replay.
   */
  function tune(next = {}) {
    if (next.wave !== undefined) uEntryWave.value = next.wave;
    if (next.jitter !== undefined) uEntryJitter.value = next.jitter;
    if (next.grow !== undefined) uEntryDur.value = next.grow;
    if (next.overshoot !== undefined) uEntryOver.value = next.overshoot;
    if (next.dust !== undefined) dustBoost = next.dust;
  }

  // `time` is the animation clock, not the wall clock — under a software renderer the two drift
  // apart (dt clamps at 0.05s), so anything that wants to catch a mid-entrance frame polls this.
  return { update, settle, replay, tune, tuning, running: () => !done, time: () => uEntryTime.value };
}
