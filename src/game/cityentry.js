import * as THREE from 'three';
import { KERB_H } from '../city/ground.js';
import { HALF_SPAN } from '../city/grid.js';

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
// The per-object timeline, in local t over ENTRY_DUR seconds:
//   - scale runs an easeOutBack from 0: rises out of the ground, overshoots to ~1.09 around
//     t = 0.7, settles at exactly 1 — the "overscale pop" beat in one curve.
//   - XZ runs the same curve mapped onto [XZ_FROM, 1], so a mass swells outward a little as it
//     rises rather than telescoping up at full footprint.
//   - alpha fades in over the first FADE_IN of t, then holds at 1.
//
// Traps this already stepped around, so a future pass doesn't step back in:
//   - `customProgramCacheKey` on every patched material, *composed with* the key already there —
//     propMaterial() may carry the SSAO patch, and two different onBeforeCompiles sharing one
//     cache key silently get one program (the diamond-fill bug, see CLAUDE.md).
//   - A shadow map renders through a depth material, not the lit one, so without a patched
//     `customDepthMaterial` every building's shadow stands at full size before the building
//     exists. The depth patch also discards unrevealed fragments: a scale-0 building is a *flat
//     sheet at kerb height*, not nothing, and it casts a footprint-shaped shadow.
//   - The same discard runs in the lit material, because that flat sheet also writes depth —
//     invisible at alpha 0, but still able to clip pixels out of whatever crosses kerb height.
//   - Shot mode ticks once and freezes, so anything driven off sim time is stuck on its first
//     frame — an entrance that opens at zero would empty every screenshot of its city. `settle()`
//     lands the whole animation instantly; main.js calls it beside `fares.settleMarkers()`.
//
// Known prototype shortcuts: the meshes stay `transparent` only while the entrance runs (flipped
// back on finish — a merged transparent city can't self-sort, but at a fast fade nothing shows);
// the SSAO prepass still sees full-size buildings during the grow (its depth pass isn't patched —
// a contact shadow arriving a beat early reads fine); and the discard branch stays compiled in
// afterwards, where its cost is a clamped no-op per vertex and a dead branch per fragment.

// The wave: each object's delay is its distance from the wave's origin times WAVE, plus its own
// hashed share of JITTER so a ring of same-radius buildings doesn't land as one stamped rank.
// The origin is the taxi's spawn — the run starts where the player's car is, and the city builds
// itself outward from them — which is why it is a uniform rather than baked into the delay: the
// spawn isn't known when the vertices are stamped.
//
// WAVE started at 0.016 (whole entrance ~2s from the centre) and the stagger read as a single
// city-wide pop; at 0.03 a block visibly waits for the block before it. The far corner is 90–130
// units from a typical spawn, so the sweep runs ~2.7–4s plus one grow.
const WAVE = 0.03;
const JITTER = 0.35;
const ENTRY_DUR = 0.65;
// easeOutBack's overshoot parameter — 1.7 peaks the curve at ~1.09, a visible pop that stays
// short of cartoon rubber.
const OVERSHOOT = 1.7;
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

// The per-object delay, in JS for the dust schedule. The GLSL below computes the *same* formula
// from the same stamped anchor and origin — change one and the dust stops meeting its building.
const delayOf = (x, z, from, rand) => Math.hypot(x - from.x, z - from.z) * WAVE + rand * JITTER;

const ENTRY_VERTEX = `#include <begin_vertex>
	// This vertex's object in its entrance: 0 = still underground, 1 = settled. Mirrors delayOf().
	float eT = clamp((uEntryTime - (distance(aEntry.xy, uEntryFrom) * ${f(WAVE)} + aEntry.z * ${f(JITTER)})) / ${f(ENTRY_DUR)}, 0.0, 1.0);
	// easeOutBack: 0 at 0, ~1.09 around 0.7, exactly 1 at 1.
	float eB = eT - 1.0;
	float eS = 1.0 + ${f(OVERSHOOT + 1)} * eB * eB * eB + ${f(OVERSHOOT)} * eB * eB;
	transformed.y = ${f(KERB_H)} + (transformed.y - ${f(KERB_H)}) * eS;
	float eXZ = mix(${f(XZ_FROM)}, 1.0, eS);
	transformed.x = aEntry.x + (transformed.x - aEntry.x) * eXZ;
	transformed.z = aEntry.y + (transformed.z - aEntry.y) * eXZ;
	vEntryFade = smoothstep(0.0, ${f(FADE_IN)}, eT);`;

export function createCityEntry({ meshes, sites = [], dust = null, from = { x: 0, z: 0 } } = {}) {
  // One clock, shared by reference into every patched shader — Three reads `.value` at draw time,
  // the same way the AO uniforms fan out from one bag in util/geo.js. The origin travels the same
  // way, so `replay` can re-aim the wave without touching a single compiled program.
  const uEntryTime = { value: 0 };
  const uEntryFrom = { value: new THREE.Vector2(from.x, from.z) };

  // Past the furthest corner's delay plus one full grow — every eT clamps to 1 from here on.
  // Measured from the origin, not the centre: a taxi spawned near an edge pushes the far corner
  // out toward 140 units, and an end computed from the centre would cut that corner off mid-pop.
  // A function of the live origin rather than a constant, because `replay` can re-aim the wave.
  const endAt = () => {
    const cornerDist = Math.max(
      ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) =>
        Math.hypot(sx * HALF_SPAN - uEntryFrom.value.x, sz * HALF_SPAN - uEntryFrom.value.y)),
    );
    return cornerDist * WAVE + JITTER + ENTRY_DUR + 0.1;
  };

  const patchVertex = (shader) => {
    shader.uniforms.uEntryTime = uEntryTime;
    shader.uniforms.uEntryFrom = uEntryFrom;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute vec3 aEntry;\nuniform float uEntryTime;\nuniform vec2 uEntryFrom;\nvarying float vEntryFade;')
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

    // The sun's pass — without this the whole city's shadows arrive on frame one.
    const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    depth.customProgramCacheKey = () => 'city-entry-depth';
    depth.onBeforeCompile = (shader) => {
      patchVertex(shader);
      patchFragment(shader, { alpha: false });
    };
    mesh.customDepthMaterial = depth;
  }

  // Dust fires in delay order, so playback is one pointer walking a sorted list. Rebuilt on a
  // re-aimed replay, because the delays are a function of the origin.
  const buildQueue = () => sites
    .map((s) => ({ ...s, at: delayOf(s.x, s.z, { x: uEntryFrom.value.x, z: uEntryFrom.value.y }, s.rand) + DUST_AT }))
    .sort((a, b) => a.at - b.at);
  let queue = buildQueue();
  let head = 0;
  let done = false;

  const finish = () => {
    done = true;
    uEntryTime.value = endAt();
    head = queue.length;
    // Back to opaque: alpha is 1 everywhere from here on, and a transparent merged city would
    // keep paying the sorted-pass cost (and self-sort wrong) forever. No recompile — the flag is
    // render state, not a shader define.
    for (const material of materials) material.transparent = false;
  };

  function update(dt) {
    if (done) return;
    uEntryTime.value += dt;

    while (head < queue.length && queue[head].at <= uEntryTime.value) {
      const s = queue[head];
      head += 1;
      // The hashed jitter doubles as the burst's yaw — any spread of headings works, it just
      // must not be the same one every time. Ring at half the footprint so the puffs open
      // around the walls rather than inside them. Power runs ~0.9–1.25 with footprint, and they
      // start most of the way up the size curve: the first pass (five puffs at 0.55–0.75,
      // startSize 0.75) never registered at play zoom — a cloud two units wide on a whole-city
      // framing is a couple of pixels of haze.
      dust?.burst(s.x, s.z, s.rand * Math.PI * 2, DUST_COUNT, Math.min(1.25, 0.72 + s.r * 0.09), {
        ring: s.r * 0.55, linger: 1.15, startSize: 1.0,
      });
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
    if (from2) {
      uEntryFrom.value.set(from2.x, from2.z);
      queue = buildQueue();
    }
    uEntryTime.value = 0;
    head = 0;
    done = false;
    for (const material of materials) material.transparent = true;
  }

  // `time` is the animation clock, not the wall clock — under a software renderer the two drift
  // apart (dt clamps at 0.05s), so anything that wants to catch a mid-entrance frame polls this.
  return { update, settle, replay, running: () => !done, time: () => uEntryTime.value };
}
