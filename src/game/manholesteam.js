import * as THREE from 'three';
import { color } from '../palette.js';
import { RIGHT } from './camera.js';
import { COVER_Y, COVER_R } from '../city/manholes.js';

// Steam out of a few of the manhole covers (city/manholes.js marks which, `spot.steam`): the New York
// street, a white plume curling up out of the road and leaning off downwind (Tyler, 2026-10-24: "a
// few of them actually have some steam coming out of them, so it feels very much like New York").
//
// **One quad per plume, and the plume is all shader** (Tyler prefers an effect drawn in a shader to
// one built out of geometry). Each vent is one quad standing on its cover, and the fragment shader
// draws the steam inside it as one **billowing column**: `BILLOWS` big round lobes on a staggered
// loop, each born on the lid, rising fast and slowing, swelling, scattered a little sideways each
// time round and drifting off downwind, over a two-lobe cushion on the lid. Each lobe has a crisp
// rim roughened by one noise field they all share, and they overlap so heavily that the column
// reads as a single white mass with a lumpy outline, the way a cumulus does. Each is lit a step
// brighter on top than underneath, which is what gives the mass its pillowed relief.
//
// Summing the lobes into one density field and thresholding it (metaballs) was tried on the way
// and was worse: the sum of that many overlapping lobes is one smooth capsule, and it came out a
// flat white sheet ghost with no billow in it at all. The lumps are the lobes' own rims.
//
// Two looks came before it. The first cut was a continuous column of domain-warped fbm, and it did
// not read as steam in this game: the smooth foot looked like a cone of light standing on the lid,
// and the wisps at the top, half transparent over a dark road, came out the grey of smoke. The
// second (#689, `?steam=classic`) was twelve separate soft puffs layered over each other, small and
// far enough apart that at phone play zoom it read as a string of beads (Tyler, 2026-10-25: the
// screenshot with it circled). The billow keeps what the puffs fixed and fixes the beads: its foot
// is lobes, not a smooth taper, so there is no cone; and a lobe leaves by **shrinking** — its weight
// in the field falls until it drops under the threshold — rather than by going see-through, so the
// top of the plume stays white to its last lobe instead of fading to grey over the road.
//
// **The quad stands in the plane of `RIGHT` and world up.** The view never rotates, so the quad is
// fixed rather than turned to face the camera every frame; it is 33° off the screen plane (the
// camera's elevation), which foreshortens it by cos 33° = 0.84 and costs nothing else. It stands on
// the lid's near edge (`TOWARD_CAMERA`), so anything down-screen of the cover hides the plume's foot
// as it hides the lid, and a building up-screen of it is behind the steam.
//
// **The taxi parts it.** Driving through a vent kicks the plume (`aKick`): the foot tears open and
// the column is thrown sideways in the direction the car was going across the screen, then it closes
// back up over a second and a half. Only the taxi: the cars are background, and every car through
// every junction would keep all three permanently broken.
//
// Lit (Lambert) so it dims at dusk with everything else; transparent, so the AO prepass leaves it out
// (`markOccluder` refuses a transparent mesh) and so it casts no shadow. Unmarked for bloom. No
// backticks in the shader literals — see CLAUDE.md.

// World units. 6.5 × 5 read as a wisp at phone play zoom (about 40pt tall, the bright part half
// that); 8.5 tall puts the plume up past the second storey of the building beside it, which is
// what a New York vent looks like. Taller than the L's deck at 6.4, which is why vents avoid it.
export const PLUME_H = 8.5;
// Wide enough for the lean, the widest lobe and the taxi's kick either way: a lobe 2.4 across at
// the top of a 2.4 lean is 4.8 downwind of the cover, and a kick throws the column 1.8 upwind.
export const PLUME_W = 9.5;
const BASE_U = 0.4;           // where across the quad the cover sits; the rest is room for the lean
const LEAN = 2.4;             // units the top drifts downwind
// 18 lobes over 4.2s leave the lid every 0.23s, and at the lid one rises 0.6 units in that time
// against a radius of 1 — so neighbours always overlap and the column never breaks into beads.
const BILLOWS = 18;
const BILLOW_LIFE = 4.2;      // seconds from the lid to gone
const OPACITY = 0.95;
// The classic look (#689): twelve separate puffs in a narrower quad.
const CLASSIC = { width: 7, base: 0.35, puffs: 12, life: 3.6, opacity: 0.92 };
// Steam scatters light rather than being lit like a wall. With Lambert alone a plume out of the sun
// came out the same grey as the road under it and all but vanished in the first render. So it is
// mostly self-lit, at full white — the sun adds a little (`LIT`) — and the glow comes down after
// dark (`update`'s `dark`), or three white plumes would stand in a night street like lamps.
const GLOW = 1.1;
const GLOW_NIGHT = 0.5;
const LIT = 0.5;
// The taxi: how close counts as through the plume, how fast it has to be going, and how long the
// tear takes to close.
const KICK_REACH = 2.6;
const KICK_SPEED = 2;
const KICK_HEAL = 1.5;

// Stood on the cover's centre, the quad's foot cut the lid in half on screen: the near half of the
// disc is down-screen of the line the quad stands on, so nothing on the quad can cover it. Standing
// it on the lid's near edge instead puts the whole lid up-screen of the foot.
const TOWARD_CAMERA = new THREE.Vector3(1, 0, 1).normalize();

/** One quad per venting spot, wound to face the camera. Exported for the probe's winding check. */
export function steamGeometry(spots, wind = 1, { width = PLUME_W, base = BASE_U } = {}) {
  const pos = [], uv = [], seed = [], kick = [];
  const up = new THREE.Vector3(0, 1, 0);
  const corner = new THREE.Vector3();
  spots.forEach((s, n) => {
    const at = (u, v) => {
      corner.set(s.x, COVER_Y + 0.01, s.z)
        .addScaledVector(TOWARD_CAMERA, COVER_R)
        .addScaledVector(RIGHT, wind * (u - base) * width)
        .addScaledVector(up, v * PLUME_H);
      pos.push(corner.x, corner.y, corner.z);
      uv.push(u, v);
      seed.push(n * 1.618 + s.x * 0.013 + s.z * 0.007);
      kick.push(0, 0);
    };
    // bottom-left, bottom-right, top-right; bottom-left, top-right, top-left. RIGHT × up is (1, 0, 1)
    // over √2, which is toward the camera, so this is counter-clockwise from where the camera sits —
    // unless the wind flips RIGHT, in which case the order flips with it.
    const quad = wind > 0
      ? [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]]
      : [[0, 0], [1, 1], [1, 0], [0, 0], [0, 1], [1, 1]];
    for (const [u, v] of quad) at(u, v);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aPlume', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
  geo.setAttribute('aKick', new THREE.Float32BufferAttribute(kick, 2));
  // Lit as if facing half up and half toward the camera, so a plume in the sun reads bright without
  // going flat white, and dims with the sun.
  const normals = [];
  const nrm = new THREE.Vector3(1, 1.4, 1).normalize();
  for (let k = 0; k < pos.length / 3; k++) normals.push(nrm.x, nrm.y, nrm.z);
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return geo;
}

const STEAM_COMMON = /* glsl */ `
varying vec2 vPlume;
varying float vSeed;
varying vec2 vKick;
uniform float uSteamTime;
float steamHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float steamNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(steamHash(i), steamHash(i + vec2(1.0, 0.0)), u.x),
             mix(steamHash(i + vec2(0.0, 1.0)), steamHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float steamShade;
`;

// The plume today: one billowing column of big, overlapping, crisp-rimmed lobes.
function billow() {
  return /* glsl */ `
  float t = uSteamTime + vSeed * 37.0;
  // In world units: x across the quad from the cover's centre (downwind positive), y up.
  vec2 p = vec2((vPlume.x - ${BASE_U.toFixed(3)}) * ${PLUME_W.toFixed(2)}, vPlume.y * ${PLUME_H.toFixed(2)});
  // The vent breathes: a slow swell and a quicker flutter in how hard it pushes.
  float breath = 0.9 + 0.07 * sin(t * 0.55) + 0.03 * sin(t * 1.7 + 1.3);
  // One noise field scrolling up with the steam, shared by every lobe: it roughens each rim, and
  // because neighbouring lobes read the same noise their rims agree where they meet.
  float churn = steamNoise(p * 1.3 + vec2(0.0, -t * 1.1)) * 0.65
    + steamNoise(p * 2.9 + vec2(t * 0.5, -t * 1.9)) * 0.35 - 0.5;
  float cover = 0.0;   // how much of the pixel the plume covers, 0..1
  float shade = 0.0;   // ...and how lit, weighted by that cover
  for (int k = 0; k < ${BILLOWS + 2}; k++) {
    float fk = float(k);
    vec2 c;
    float r, w, f;
    if (k < ${BILLOWS}) {
      float cyc = t * ${(1 / BILLOW_LIFE).toFixed(4)} + fk / ${BILLOWS}.0 + 0.1 * steamHash(vec2(fk, vSeed));
      f = fract(cyc);
      // A fresh scatter every time the slot comes round, so the column is never the same twice.
      float j = steamHash(vec2(fk + floor(cyc) * 17.0, vSeed)) - 0.5;
      float rise = 1.0 - pow(1.0 - f, 1.3);
      float y = 0.8 + rise * ${(PLUME_H * 0.7).toFixed(2)};
      float h = y / ${PLUME_H.toFixed(2)};
      r = mix(0.8, 2.1, pow(f, 0.6)) * (1.0 + 0.3 * vKick.x);
      c = vec2(${LEAN.toFixed(2)} * pow(h, 1.4) + j * r * 0.9 + 0.3 * h * sin(fk * 2.4 + t * 0.7)
        + vKick.x * vKick.y * 1.8 * sqrt(h), y);
      // In fast, and out by shrinking rather than by fading: the weight eats the lobe from its rim
      // inward, so what is left of an old lobe is still white and never a grey veil over the road.
      w = smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.35, 1.0, f));
      // The taxi tears the low lobes away.
      w *= 1.0 - 0.95 * vKick.x * (1.0 - smoothstep(0.15, 0.55, h));
    } else {
      // The thick of it sitting on the lid, which is what says it is coming out of the cover: two
      // lobes side by side, wider than the lid, so the foot is a cushion and never a point. Centred
      // over the lid as the screen sees it: the lid's far edge is 2 COVER_R behind the quad, which
      // climbs to 0.78 of a unit up the quad at this camera's 33 degrees.
      float side = fk - ${BILLOWS}.0 - 0.5;
      f = 0.2;
      r = 0.85;
      c = vec2(side * 1.1 + 0.12 * sin(t * 1.3 + side * 3.0), 0.8);
      w = 1.0 - 0.95 * vKick.x;
    }
    w *= breath;
    vec2 d = (p - c) / vec2(r, r * 0.86);
    // A rounded rim, a fifth of the radius soft, pulled in as the weight falls.
    float edge = 1.0 - length(d) + churn * 0.35 - (1.0 - w) * 0.8;
    float a = smoothstep(0.0, 0.22, edge);
    // Lit from above: the top of each lobe is the bright side, its underside a step greyer, and
    // laid over the lobes behind it — which is what gives the column its pillowed relief.
    float lit = clamp(0.4 + 0.75 * d.y, 0.0, 1.0);
    shade += lit * a * (1.0 - cover);
    cover += a * (1.0 - cover);
  }
  diffuseColor.a *= cover * ${OPACITY.toFixed(2)};
  steamShade = mix(0.55, 1.0, shade / max(cover, 1e-3));
  diffuseColor.rgb *= steamShade;`;
}

// `?steam=classic` (#689): twelve separate puffs layered over each other, and a puff on the lid.
function classicPuffs() {
  return /* glsl */ `
  float t = uSteamTime + vSeed * 37.0;
  // In world units: x across the quad from the cover's centre (downwind positive), y up.
  vec2 p = vec2((vPlume.x - ${CLASSIC.base.toFixed(3)}) * ${CLASSIC.width.toFixed(2)}, vPlume.y * ${PLUME_H.toFixed(2)});
  // The vent breathes: a slow swell and a quicker flutter, never below 0.6.
  float breath = 0.8 + 0.12 * sin(t * 0.55) + 0.08 * sin(t * 1.7 + 1.3);
  float cover = 0.0;   // how much of the pixel the plume covers, 0..1
  float shade = 0.0;   // ...and how lit, weighted by that cover
  // The puffs: each one born on the lid, rising fast and slowing, growing, drifting off downwind
  // and fading, on a loop staggered so one leaves every 1/PUFFS of a cycle.
  for (int k = 0; k < ${CLASSIC.puffs}; k++) {
    float fk = float(k);
    float f = fract(t * ${(1 / CLASSIC.life).toFixed(4)} + fk / ${CLASSIC.puffs}.0 + 0.13 * steamHash(vec2(fk, vSeed)));
    float rise = 1.0 - pow(1.0 - f, 1.7);
    float y = 0.25 + rise * ${(PLUME_H * 0.72).toFixed(2)};
    float h = y / ${PLUME_H.toFixed(2)};
    float x = ${LEAN.toFixed(2)} * pow(h, 1.4)
      + 0.3 * h * sin(fk * 2.4 + t * 0.9)
      + vKick.x * vKick.y * 1.8 * sqrt(h);
    float r = mix(0.6, 2.0, pow(f, 0.7)) * (1.0 + 0.3 * vKick.x);
    vec2 d = (p - vec2(x, y)) / vec2(r, r * 0.85);
    // A ragged rim: noise in the radius, turning with the puff so the edge churns as it climbs.
    float rim = (steamNoise(p * 1.7 + vec2(fk * 7.3, fk * 3.1 - t * 0.8)) - 0.5) * 0.45;
    float a = 1.0 - smoothstep(0.3, 1.0, length(d) + rim);
    a *= smoothstep(0.0, 0.08, f) * (1.0 - smoothstep(0.3, 1.0, f)) * 0.8;
    // The taxi tears the low puffs away.
    a *= 1.0 - 0.9 * vKick.x * (1.0 - smoothstep(0.15, 0.55, h));
    // Lit from above: the top of a puff is the bright side, its underside a step greyer.
    float lit = clamp(0.55 + 0.45 * d.y, 0.0, 1.0);
    shade += lit * a * (1.0 - cover);
    cover += a * (1.0 - cover);
  }
  // The thick of it sitting on the lid, which is what says it is coming out of the cover.
  // Centred over the lid as the screen sees it: the lid's far edge is 2 COVER_R behind the quad,
  // which climbs to 0.78 of a unit up the quad at this camera's 33 degrees.
  vec2 dl = (p - vec2(0.0, 0.45)) / vec2(0.85, 0.55);
  float foot = (1.0 - smoothstep(0.3, 1.0, length(dl))) * 0.65 * (1.0 - 0.9 * vKick.x);
  shade += 0.8 * foot * (1.0 - cover);
  cover += foot * (1.0 - cover);
  diffuseColor.a *= cover * breath * ${CLASSIC.opacity.toFixed(2)};
  steamShade = mix(0.78, 1.0, shade / max(cover, 1e-3));
  diffuseColor.rgb *= steamShade;`;
}

function patchSteam(material, uniforms, classic = false) {
  material.customProgramCacheKey = () => (classic ? 'manhole-steam-classic' : 'manhole-steam');
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    const inject = (source, chunk, replacement) => {
      if (!source.includes(chunk)) throw new Error(`manholesteam: no ${chunk} in the shader`);
      return source.replace(chunk, replacement);
    };
    shader.vertexShader = inject(shader.vertexShader, '#include <common>', `#include <common>
attribute vec2 aPlume;
attribute float aSeed;
attribute vec2 aKick;
varying vec2 vPlume;
varying float vSeed;
varying vec2 vKick;`);
    shader.vertexShader = inject(shader.vertexShader, '#include <begin_vertex>', `#include <begin_vertex>
vPlume = aPlume;
vSeed = aSeed;
vKick = aKick;`);
    shader.fragmentShader = inject(shader.fragmentShader, '#include <common>', `#include <common>
${STEAM_COMMON}`);
    shader.fragmentShader = inject(shader.fragmentShader, '#include <alphamap_fragment>', `#include <alphamap_fragment>
{
${classic ? classicPuffs() : billow()}
}`);
    // The glow is most of the colour, so it takes the shading too.
    shader.fragmentShader = inject(shader.fragmentShader, '#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance *= steamShade;`);
  };
  material.needsUpdate = true;
  return material;
}

/**
 * @param scene  where the plumes go
 * @param spots  the cover plan (`manholes.userData.spots`); only those with `steam` vent
 * @param rng    its own stream: which way the wind leans them
 * @param opts   `classic`: the separate puffs of #689 instead of the billow (`?steam=classic`)
 */
export function createManholeSteam(scene, spots, rng, { classic = false } = {}) {
  const vents = (spots ?? []).filter((s) => s.steam);
  if (vents.length === 0) return { mesh: null, vents, update: () => {} };
  const wind = rng.chance(0.5) ? 1 : -1;
  const uniforms = { uSteamTime: { value: rng.next() * 100 } };
  const geo = steamGeometry(vents, wind, classic ? CLASSIC : undefined);
  const steamColor = color('steam');
  const material = patchSteam(new THREE.MeshLambertMaterial({
    color: color('steam').multiplyScalar(LIT), emissive: color('steam').multiplyScalar(GLOW),
    transparent: true, depthWrite: false,
  }), uniforms, classic);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'manhole-steam';
  mesh.renderOrder = 5;
  // Static quads: the bounding sphere three works out once is the right one.
  scene.add(mesh);

  const kick = vents.map(() => ({ amount: 0, dir: 0 }));
  const kickAttr = geo.attributes.aKick;
  let lastX = null, lastZ = null;

  return {
    mesh,
    vents,
    kick,
    /** Advance the billows, and let the taxi through. `dark` is 0 in daylight and 1 at full night. */
    update(dt, taxi, dark = 0) {
      uniforms.uSteamTime.value += dt;
      material.emissive.copy(steamColor).multiplyScalar(GLOW + (GLOW_NIGHT - GLOW) * dark);
      let vx = 0, vz = 0;
      if (taxi && lastX !== null && dt > 0) { vx = (taxi.x - lastX) / dt; vz = (taxi.z - lastZ) / dt; }
      if (taxi) { lastX = taxi.x; lastZ = taxi.z; }
      const speed = Math.hypot(vx, vz);
      let dirty = false;
      vents.forEach((s, n) => {
        const k = kick[n];
        const near = taxi && Math.hypot(taxi.x - s.x, taxi.z - s.z) < KICK_REACH;
        if (near && speed > KICK_SPEED) {
          k.amount = 1;
          // Across the screen in the quad's own downwind sense.
          k.dir = Math.sign((vx * RIGHT.x + vz * RIGHT.z) * wind) || 1;
          dirty = true;
        } else if (k.amount > 0) {
          k.amount = Math.max(0, k.amount - dt / KICK_HEAL);
          dirty = true;
        }
      });
      if (!dirty) return;
      vents.forEach((_, n) => {
        // Eased, so the plume settles back rather than snapping on the last frame.
        const a = kick[n].amount * kick[n].amount * (3 - 2 * kick[n].amount);
        for (let c = 0; c < 6; c++) kickAttr.setXY(n * 6 + c, a, kick[n].dir);
      });
      kickAttr.needsUpdate = true;
    },
  };
}
