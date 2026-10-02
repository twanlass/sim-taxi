import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { KERB_H } from './ground.js';
import { WATER_Y, RAIL_H, RAIL_W, DECK_THICK } from './river.js';

// The river's surface: facets that move, a bed you can see into, and the far wall and the bridges
// mirrored in it.
//
// **Everything here is worked out in the water's own fragment shader, with no extra pass.** Real
// refraction wants a copy of the frame behind the water and real reflection wants the city drawn a
// second time upside down; this game already spends its budget on an AO prepass and a bloom chain,
// and the river is one strip of a scene whose camera never turns. That last fact is what makes the
// cheap version honest rather than a fake: under a fixed orthographic view every ray leaving the
// water heads the same way, so what it can hit is a short list — the far channel wall, three
// bridge decks, the sky — and each of those is a plane the shader can intersect in closed form.
//
// Three things ride on top of `propMaterial`'s own patch (util/geo.js), which still runs first:
//
// - **Ripples** are a low-poly facet field: the surface is cut into a jittered triangle lattice
//   and each triangle takes the flat plane through three points of a sum of travelling waves. A
//   smooth normal map would be the realistic answer and the wrong one for a city that is flat
//   shaded everywhere else; facets that tilt and swap read as this game's water.
// - **Depth and refraction**: the view ray is bent by the facet (Snell, 1.33) and followed down to
//   either the bed or the far wall's submerged face, and what it finds is absorbed by the length
//   of water it crossed, red first. Near the far wall that path is short, so the wall visibly
//   carries on under the surface and fades — the depth cue — and the facets make it wobble.
// - **Reflection** follows the mirrored ray up to the same far wall, the bridges and the sky,
//   weighted by a Fresnel term. The far wall's reflection is a band in front of it exactly as deep
//   as the wall's height allows, and a bridge throws its soffit and fascia onto the water
//   up-screen of it — both bent by the facets.
//
// The mouth is left alone. `waterMesh` (river.js) shoals the strip up to ground level and into
// asphalt's colour so `riverMouthFade` can close the coast over it, and that was measured to within
// 1-2 luma. Every term below is scaled by how deep the water is at that point, so in the shoal it
// all goes to zero and the surface is exactly what it was.

// Below this the channel is opaque: how far down the bed sits under the waterline. Deeper than the
// two units the walls show above the water, so the middle of the river is mostly its own colour and
// only the margins open up.
const BED_DEPTH = 2.6;

// The lattice the ripples are cut on, in world units. One unit is ~7.7px at play zoom, so 1.35 is
// about ten pixels a facet: big enough to read as low-poly from the default zoom, small enough that
// the 9.2-unit channel is six or seven facets across.
const FACET = 1.35;
// How far each lattice point is shaken off the regular grid, as a fraction of a facet. A regular
// lattice reads as tiles; much past 0.3 the triangle a pixel is tested against stops being the one
// it is drawn as.
const FACET_JITTER = 0.28;
// The wave height, in world units. The slope is what matters, and at this height the facets tilt
// by up to ~12 degrees — enough to swing the reflection band's edge by a facet and no further.
const WAVE_AMP = 0.24;

// Fresnel. Water's real F0 is 0.02, which at this camera's 33 degrees comes to under 4% — a
// reflection nobody would see. The floor lifts the whole curve so the sky and the far wall carry at
// play zoom; the facets then spread it either side of that.
const F0 = 0.02;
const REFLECT_FLOOR = 0.07;

// How much each channel is lost per unit of water crossed. Red goes first, which is what turns a
// grey wall and an olive bed green-blue as they go down.
const ABSORB = [1.4, 0.85, 0.7];

// The sun's glint off a facet: Blinn-Phong on the perturbed normal.
const SHINE = 90;
const GLINT = 1.4;
// The bright web light makes on the bed. Scaled by direct sun only, so it goes out with the sun.
const CAUSTIC = 0.9;

// Shared, the way AO_UNIFORMS are: there is one river, and `tickRiverWater` writes these once a
// frame however many programs end up reading them.
const UNIFORMS = {
  uWaterTime: { value: 0 },
  uWaterSky: { value: new THREE.Color(PALETTE.fog) },
  uWaterWall: { value: new THREE.Color(PALETTE.riverWall) },
  uWaterTrim: { value: new THREE.Color(PALETTE.bridgeTrim) },
  uWaterSoffit: { value: new THREE.Color(PALETTE.bridgeSoffit) },
  uWaterBed: { value: new THREE.Color(PALETTE.riverBed) },
  // z of the water's two edges, and of the kerb lines a bridge spans.
  uWaterEdges: { value: new THREE.Vector2() },
  uWaterBanks: { value: new THREE.Vector2() },
  // x0, x1, arch rise, visibility — one per crossing that carries a deck. Visibility is how the
  // drawbridge drops out of the reflection while its leaf is up: a flat deck mirrored under a
  // leaf standing on end is worse than no deck at all.
  uWaterBridges: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
};

let drawLift = () => 0;
let drawSlot = -1;

const num = (v) => v.toFixed(5);

// Built on first use rather than at load: river.js imports this module, so its constants are not
// initialised yet while this one is being evaluated.
const header = () => /* glsl */ `
uniform float uWaterTime;
uniform vec3 uWaterSky;
uniform vec3 uWaterWall;
uniform vec3 uWaterTrim;
uniform vec3 uWaterSoffit;
uniform vec3 uWaterBed;
uniform vec2 uWaterEdges;
uniform vec2 uWaterBanks;
uniform vec4 uWaterBridges[3];
varying vec3 vWaterWorld;

vec3 waterN = vec3(0.0, 1.0, 0.0);
vec3 waterSpec = vec3(0.0);
vec3 waterSun = vec3(0.0);

// A sum of travelling waves, all heading broadly downstream so the facets drift with the river
// rather than boil in place.
float waterWave(vec2 p) {
  float t = uWaterTime;
  return 0.50 * sin(dot(p, vec2(0.78, 0.22)) - t * 1.25)
       + 0.35 * sin(dot(p, vec2(0.52, -0.98)) - t * 1.65)
       + 0.30 * sin(dot(p, vec2(-0.64, 0.92)) + t * 1.05)
       + 0.20 * sin(dot(p, vec2(1.55, 0.58)) - t * 2.2);
}

vec2 waterHash(vec2 c) {
  return fract(sin(vec2(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)))) * 43758.5453);
}

// The world position of lattice point c, unskewed and shaken.
vec2 waterCorner(vec2 c) {
  return (c - (c.x + c.y) * 0.2113248654 + (waterHash(c) - 0.5) * ${num(FACET_JITTER)}) * ${num(FACET)};
}

// The facet under p: which triangle of a skewed (simplex) lattice it is in, and the plane through
// the wave height at that triangle's three corners. One normal per triangle is what makes it flat
// shaded.
vec3 waterFacet(vec2 p, float amp) {
  vec2 q = p / ${num(FACET)};
  vec2 i = floor(q + (q.x + q.y) * 0.3660254038);
  vec2 x0 = q - (i - (i.x + i.y) * 0.2113248654);
  vec2 o = x0.x > x0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec2 w0 = waterCorner(i);
  vec2 w1 = waterCorner(i + o);
  vec2 w2 = waterCorner(i + 1.0);
  vec3 a = vec3(w0.x, amp * waterWave(w0), w0.y);
  vec3 b = vec3(w1.x, amp * waterWave(w1), w1.y);
  vec3 c = vec3(w2.x, amp * waterWave(w2), w2.y);
  vec3 n = normalize(cross(b - a, c - a));
  return n.y < 0.0 ? -n : n;
}

// Light dancing on the bed: two warped sine fields folded into ridges.
float waterCaustic(vec2 p) {
  float t = uWaterTime * 0.7;
  vec2 q = p * 0.95;
  float c = sin(q.x * 2.1 + 1.3 * sin(q.y * 1.7 + t) + t * 0.6)
          + sin(q.y * 2.4 + 1.2 * sin(q.x * 1.9 - t * 1.1) - t * 0.4);
  c = 1.0 - abs(0.5 * c);
  return c * c * c * c * c * c;
}

// What an opaque surface with this albedo and world normal looks like under the scene's lights —
// the same sum Lambert makes, less the shadow, which a reflection can live without.
vec3 waterLit(vec3 albedo, vec3 nW) {
  vec3 nV = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
  vec3 irr = ambientLightColor;
  #if NUM_HEMI_LIGHTS > 0
    irr += getHemisphereLightIrradiance(hemisphereLights[0], nV);
  #endif
  #if NUM_DIR_LIGHTS > 0
    irr += directionalLights[0].color * saturate(dot(nV, directionalLights[0].direction));
  #endif
  return albedo * irr * RECIPROCAL_PI;
}

// The top of a bridge deck at z: the arch profile, sin squared across the kerb lines.
float waterDeck(float z, float rise) {
  float u = clamp((z - uWaterBanks.x) / (uWaterBanks.y - uWaterBanks.x), 0.0, 1.0);
  float s = sin(PI * u);
  return rise * s * s;
}

// Follow the mirrored ray r from p to the first thing it meets. Under this camera r always heads
// toward -x and -z and climbs, so the far wall is the backstop and a bridge can only be met on its
// +x face or its underside.
vec3 waterReflect(vec3 p, vec3 r) {
  float best = (p.z - uWaterEdges.x) / max(-r.z, 1e-3);
  float y = p.y + r.y * best;
  vec3 wall = waterLit(uWaterWall, vec3(0.0, 0.0, 1.0));
  // The wall's top edge, softened over a few hundredths so a facet tipping across it fades rather
  // than flips a whole triangle from concrete to sky.
  vec3 col = mix(wall, uWaterSky, smoothstep(${num(KERB_H - 0.06)}, ${num(KERB_H + 0.06)}, y));
  float up = y - ${num(KERB_H)};
  float rail = step(abs(up - ${num(RAIL_H - RAIL_W / 2)}), ${num(RAIL_W)})
             + step(abs(up - ${num(RAIL_H * 0.5)}), ${num(RAIL_W * 0.7)});
  col = mix(col, wall, 0.6 * clamp(rail, 0.0, 1.0));
  for (int k = 0; k < 3; k++) {
    vec4 b = uWaterBridges[k];
    if (b.w <= 0.0) continue;
    float sIn = max(0.0, (p.x - b.y) / -r.x);
    float sOut = min((p.x - b.x) / -r.x, best);
    if (sOut <= sIn) continue;
    float yIn = p.y + r.y * sIn;
    float top = waterDeck(p.z + r.z * sIn, b.z);
    vec3 hit;
    bool met = false;
    if (yIn >= top - ${num(DECK_THICK)} && yIn <= top + ${num(KERB_H)}) {
      hit = waterLit(uWaterTrim, vec3(1.0, 0.0, 0.0));
      met = true;
    } else if (yIn < top - ${num(DECK_THICK)}) {
      float yOut = p.y + r.y * sOut;
      if (yOut >= waterDeck(p.z + r.z * sOut, b.z) - ${num(DECK_THICK)}) {
        hit = waterLit(uWaterSoffit, vec3(0.0, -1.0, 0.0));
        met = true;
      }
    }
    if (met) {
      col = mix(col, hit, b.w);
      best = sIn;
    }
  }
  return col;
}

// Lambert, plus a glint and a tally of the direct light for the caustics. The light loop is the
// only place a shadowed light colour exists, so both have to be collected here.
void RE_Direct_Water(const in IncidentLight directLight, const in vec3 geometryPosition,
    const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal,
    const in LambertMaterial material, inout ReflectedLight reflectedLight) {
  RE_Direct_Lambert(directLight, geometryPosition, geometryNormal, geometryViewDir,
    geometryClearcoatNormal, material, reflectedLight);
  vec3 h = normalize(directLight.direction + geometryViewDir);
  waterSpec += directLight.color * pow(saturate(dot(geometryNormal, h)), ${num(SHINE)});
  vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
  waterSun += directLight.color * saturate(dot(upV, directLight.direction));
}
#undef RE_Direct
#define RE_Direct RE_Direct_Water
`;

const normalPatch = () => /* glsl */ `
  // How much river there is here: 1 down the channel, 0 once the shoal has reached the ground.
  // Cubed so the whole effect has gone well before the shoal's colour has finished turning into
  // the asphalt the mouth skirt lies over: linear, a half-shoaled stretch under the ring bridge
  // came out teal against the skirt's grey.
  float waterWet = clamp(vWaterWorld.y / ${num(WATER_Y)}, 0.0, 1.0);
  waterWet *= waterWet * waterWet;
  waterN = waterFacet(vWaterWorld.xz, ${num(WAVE_AMP)} * waterWet);
  normal = normalize((viewMatrix * vec4(waterN, 0.0)).xyz);
`;

const compose = () => /* glsl */ `
  {
    // Toward the camera, in world space: the third row of the view rotation.
    vec3 V = normalize(vec3(viewMatrix[0].z, viewMatrix[1].z, viewMatrix[2].z));

    // Down through the surface to the bed or the far wall's submerged face.
    vec3 rd = refract(-V, waterN, 0.7518797);
    float depth = ${num(BED_DEPTH)} * waterWet;
    float sBed = depth / max(-rd.y, 1e-3);
    float sWall = rd.z < 0.0 ? (vWaterWorld.z - uWaterEdges.x) / -rd.z : 1e6;
    float s = min(sBed, sWall);
    vec3 seen = vWaterWorld + rd * s;
    vec3 under;
    if (sWall < sBed) {
      // Pour lines on the wall, so it reads as carrying on rather than as a tint.
      under = uWaterWall * (0.82 + 0.18 * step(0.5, fract(seen.y * 1.6)));
    } else {
      vec2 cell = floor(seen.xz * 1.3);
      under = uWaterBed * (0.75 + 0.5 * waterHash(cell).x);
    }
    // The light reaching down there: what the surface itself received, less its own colour, plus
    // the caustic web on whatever is in direct sun.
    vec3 irr = outgoingLight / max(diffuseColor.rgb, vec3(0.02));
    under *= irr + waterSun * RECIPROCAL_PI * ${num(CAUSTIC)} * waterCaustic(seen.xz);
    vec3 T = exp(-vec3(${ABSORB.map(num).join(', ')}) * s);
    vec3 body = mix(outgoingLight, under, T);

    // And up, off the facet, to the far wall, a bridge or the sky.
    vec3 refl = waterReflect(vWaterWorld, reflect(-V, waterN));
    float cosT = saturate(dot(waterN, V));
    float fres = ${num(F0)} + ${num(1 - F0)} * pow(1.0 - cosT, 5.0);
    fres = ${num(REFLECT_FLOOR)} + ${num(1 - REFLECT_FLOOR)} * fres;

    vec3 water = mix(body, refl, fres) + waterSpec * ${num(GLINT)};
    outgoingLight = mix(outgoingLight, water, waterWet);
  }
`;

/**
 * Layer the river's surface onto a material `propMaterial` has already patched.
 *
 * @param material  the water's material — its existing `onBeforeCompile` runs first.
 * @param edges     `waterEdges()`: z of the water's two edges.
 * @param banks     `riverBanks()`: the kerb lines the bridges span.
 * @param bridges   one `{ x0, x1, rise, draw }` per crossing that carries a deck.
 * @param wall      the channel wall's colour as built, so the mirror image matches the wall.
 */
export function patchRiverWater(material, { edges, banks, bridges, wall }) {
  UNIFORMS.uWaterEdges.value.set(edges.z0, edges.z1);
  UNIFORMS.uWaterBanks.value.set(banks.z0, banks.z1);
  if (wall) UNIFORMS.uWaterWall.value.set(wall);
  drawSlot = -1;
  UNIFORMS.uWaterBridges.value.forEach((v, k) => {
    const b = bridges[k];
    if (!b) { v.set(0, 0, 0, 0); return; }
    v.set(b.x0, b.x1, b.rise, 1);
    if (b.draw) drawSlot = k;
  });

  const inner = material.onBeforeCompile;
  const innerKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () => `${innerKey}-river`;
  material.onBeforeCompile = (shader, renderer) => {
    inner(shader, renderer);
    Object.assign(shader.uniforms, UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWaterWorld;')
      .replace('#include <project_vertex>',
        '#include <project_vertex>\nvWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_lambert_pars_fragment>',
        `#include <lights_lambert_pars_fragment>\n${header()}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${normalPatch()}`)
      .replace('#include <opaque_fragment>', `${compose()}\n#include <opaque_fragment>`);
  };
  return material;
}

/** Where the drawbridge's leaf is, 0 down to 1 up — so its deck can leave the reflection. */
export function bindRiverDrawbridge(getLift) {
  drawLift = getLift;
}

/** Once a simulated frame: the ripples run on game time, so they stop with the pause. */
export function tickRiverWater(dt) {
  UNIFORMS.uWaterTime.value += dt;
}

/**
 * Before every render, including shot mode's, which never reaches the frame loop: the sky the water
 * mirrors is the haze colour (`daylight.js` keeps it at the air near the horizon), and the
 * drawbridge's deck leaves the reflection as soon as the leaf starts to move.
 */
export function syncRiverWater(sky) {
  if (sky) UNIFORMS.uWaterSky.value.copy(sky);
  if (drawSlot >= 0) {
    UNIFORMS.uWaterBridges.value[drawSlot].w = 1 - Math.min(1, drawLift() / 0.08);
  }
}
