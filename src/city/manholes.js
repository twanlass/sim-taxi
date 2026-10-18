import * as THREE from 'three';
import { propMaterial } from '../util/geo.js';
import { color } from '../palette.js';
import {
  GRID_I, GRID_J, lineX, lineZ, halfRoadX, halfRoadZ, laneOffX, laneOffZ,
  isSegmentClosed, isRiverGap,
} from './grid.js';
import { MARK_Y } from './ground.js';

// Manhole covers: a handful of cast-iron lids set into the streets, flat, with no say in anything
// the traffic or the taxi does. Purely set dressing — but the city's road surface is otherwise one
// grey from kerb to kerb, and a few dark discs with a bright ring are what tells the eye it is
// looking at a *street* and not a painted slab.
//
// **Where.** In a lane, half way along a block's worth of road. The middle of a gap is the one stretch
// guaranteed clear of everything else painted on the road: crosswalks reach 1.65 past the junction
// box and the stop line sits `STOP_SETBACK` (3.4) back from it, and a gap is a whole block (12) long,
// so `ALONG_MARGIN` from either end still leaves a three-unit window that touches neither. In the lane
// rather than on the centreline because the centreline carries the dashes, and on an arterial the
// planted median. Not on the ring road (half of it is under the edge fog) and never on a bridge: a
// river gap is a deck, not asphalt.
//
// **How many.** Four or five (Tyler: "4-5 max"), spread so no two land within `MIN_SEP` of each
// other. On the 5x5 island the open gaps number ~40, so five at 1.6 blocks apart always fit; the
// greedy pass below just stops early on a city that cannot take the fifth.

export const COVER_R = 0.72;        // world units: a lane is 2.25 wide, a car 3.4 long
export const COVER_Y = MARK_Y;      // the paint's level — nothing else is painted where a cover lands
export const COVER_COUNT = [4, 5];
const ALONG_MARGIN = 4.5;           // from each end of the gap: STOP_SETBACK (3.4) + COVER_R, and a hair
const MIN_SEP_PITCHES = 1.6;
const SEGMENTS = 24;

/**
 * Pick the covers' spots. Pure apart from reading the grid, so the probe can sweep seeds with it.
 * Returns `[{ x, z, axis, line, k }]`, where `axis` is the road's direction ('x' or 'z').
 */
export function planManholes(rng) {
  const candidates = [];
  // Roads running along Z, at x = lineX(i), gaps indexed by j. Inner lines only: 0 and GRID_I are
  // the ring road.
  for (let i = 1; i < GRID_I; i++) {
    for (let k = 0; k < GRID_J; k++) {
      if (isRiverGap(k) || isSegmentClosed(i, k, 1)) continue;
      const from = lineZ(k) + halfRoadX(k);
      const to = lineZ(k + 1) - halfRoadX(k + 1);
      if (to - from < ALONG_MARGIN * 2) continue;
      const side = rng.chance(0.5) ? 1 : -1;
      candidates.push({
        x: lineX(i) + side * laneOffZ(i),
        z: from + ALONG_MARGIN + rng.next() * (to - from - ALONG_MARGIN * 2),
        axis: 'z', line: i, k,
      });
    }
  }
  // Roads running along X, at z = lineZ(j), gaps indexed by i.
  for (let j = 1; j < GRID_J; j++) {
    for (let k = 0; k < GRID_I; k++) {
      if (isSegmentClosed(k, j, 0)) continue;
      const from = lineX(k) + halfRoadZ(k);
      const to = lineX(k + 1) - halfRoadZ(k + 1);
      if (to - from < ALONG_MARGIN * 2) continue;
      const side = rng.chance(0.5) ? 1 : -1;
      candidates.push({
        x: from + ALONG_MARGIN + rng.next() * (to - from - ALONG_MARGIN * 2),
        z: lineZ(j) + side * laneOffX(j),
        axis: 'x', line: j, k,
      });
    }
  }

  // Shuffle, then take greedily whatever keeps its distance.
  for (let n = candidates.length - 1; n > 0; n--) {
    const m = Math.floor(rng.next() * (n + 1));
    [candidates[n], candidates[m]] = [candidates[m], candidates[n]];
  }
  const want = rng.int(COVER_COUNT[0], COVER_COUNT[1]);
  const minSep = MIN_SEP_PITCHES * (lineX(1) - lineX(0));
  const chosen = [];
  for (const c of candidates) {
    if (chosen.length >= want) break;
    if (chosen.every((o) => Math.hypot(o.x - c.x, o.z - c.z) >= minSep)) chosen.push(c);
  }
  return chosen;
}

/** One flat disc per cover, wound to face up, with its local coordinates in `aCover` (unit radius). */
export function manholeGeometry(spots) {
  const positions = [];
  const local = [];
  for (const { x, z } of spots) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a0 = (s / SEGMENTS) * Math.PI * 2;
      const a1 = ((s + 1) / SEGMENTS) * Math.PI * 2;
      // Centre, then a1, then a0: counter-clockwise seen from above (+Y), so the face points up.
      const pts = [[0, 0], [Math.cos(a1), Math.sin(a1)], [Math.cos(a0), Math.sin(a0)]];
      for (const [u, v] of pts) {
        positions.push(x + u * COVER_R, COVER_Y, z + v * COVER_R);
        local.push(u, v);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aCover', new THREE.Float32BufferAttribute(local, 2));
  const lid = color('manholeLid');
  const colors = new Float32Array(positions.length);
  for (let n = 0; n < colors.length; n += 3) { colors[n] = lid.r; colors[n + 1] = lid.g; colors[n + 2] = lid.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  return geo;
}

// --- The metal ----------------------------------------------------------------------------------
//
// Everything below the disc's outline is drawn in the fragment shader off `aCover`, because it is
// far too small for geometry to carry: at play zoom a cover is ~10 pixels across. What has to read
// there is a dark disc with a bright ring, and that is all albedo. What makes it *metal* close up
// is light: the lid's raised tread and the frame's bevel bend the normal, and a Blinn glint off the
// sun on top of the Lambert the rest of the city is lit with puts a highlight on every edge that
// faces it. The glint rides three's own direct-light loop (`RE_Direct` is swapped for a wrapper),
// so it is shadowed exactly like the diffuse — a cover in a building's shadow does not shine — and
// it dims with the sun at night, which is why the frame is lighter than the road in *albedo* too.
//
// The tread fades out by `fwidth`: diamonds 0.1 units across are under a pixel at play zoom and
// would crawl as the camera pans. Far away the lid is its mean shade; close up it is the pattern.
//
// No backticks in the shader literals — see CLAUDE.md.

const COVER_UNIFORMS = {
  uCoverFrame: { value: color('manholeFrame') },
  uCoverGlint: { value: 0.55 },     // strength of the sun's highlight
  uCoverShine: { value: 28 },       // Blinn exponent: broad enough to land on a flat lid at all
};

const COVER_COMMON = /* glsl */ `
varying vec2 vCover;
uniform vec3 uCoverFrame;
uniform float uCoverGlint;
uniform float uCoverShine;
float coverGloss;

// Height of the cast surface at p (unit radius), with the tread scaled by detail (0 far, 1 close).
float coverHeight(vec2 p, float detail) {
  float r = length(p);
  // Frame: a flat ring rolled off at its outer edge into the asphalt.
  float frame = smoothstep(0.80, 0.83, r) * (1.0 - smoothstep(0.93, 1.0, r));
  // The seam between frame and lid sits lowest.
  float seam = smoothstep(0.76, 0.79, r) * (1.0 - smoothstep(0.79, 0.82, r));
  // Lid: diamond tread inside a plain raised band.
  vec2 q = mat2(0.7071, 0.7071, -0.7071, 0.7071) * p / 0.13;
  vec2 f = abs(fract(q) - 0.5);
  float stud = 1.0 - smoothstep(0.22, 0.32, max(f.x, f.y));
  float band = smoothstep(0.42, 0.45, r) * (1.0 - smoothstep(0.52, 0.55, r));
  float lid = (1.0 - smoothstep(0.74, 0.77, r)) * max(band, stud * detail * (1.0 - band) * 0.6 + 0.2 * (1.0 - detail));
  return frame + lid - seam * 0.5;
}
`;

function patchCover(material) {
  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () => `${prevKey}-manhole`;
  material.onBeforeCompile = (shader, r) => {
    prevCompile.call(material, shader, r);
    Object.assign(shader.uniforms, COVER_UNIFORMS);
    const inject = (source, chunk, replacement) => {
      if (!source.includes(chunk)) throw new Error(`manholes: no ${chunk} in the shader`);
      return source.replace(chunk, replacement);
    };
    shader.vertexShader = inject(shader.vertexShader, '#include <common>', `#include <common>
attribute vec2 aCover;
varying vec2 vCover;`);
    shader.vertexShader = inject(shader.vertexShader, '#include <begin_vertex>', `#include <begin_vertex>
vCover = aCover;`);

    shader.fragmentShader = inject(shader.fragmentShader, '#include <common>', `#include <common>
${COVER_COMMON}`);
    // The glint, inside three's light loop so the shadow map has already been applied to the light.
    shader.fragmentShader = inject(shader.fragmentShader, '#include <lights_lambert_pars_fragment>',
      `#include <lights_lambert_pars_fragment>
void RE_Direct_Cover(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight) {
  RE_Direct_Lambert(directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  vec3 h = normalize(directLight.direction + geometryViewDir);
  float s = pow(saturate(dot(geometryNormal, h)), uCoverShine);
  reflectedLight.directSpecular += directLight.color * s * coverGloss;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Cover`);
    shader.fragmentShader = inject(shader.fragmentShader, '#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  vec2 p = vCover;
  float r = length(p);
  // How many cover-units a pixel spans: the tread is gone by the time a diamond is ~2 pixels.
  float px = fwidth(p.x) + fwidth(p.y);
  float detail = 1.0 - smoothstep(0.03, 0.09, px);
  float e = 0.012;
  float h0 = coverHeight(p, detail);
  float hx = coverHeight(p + vec2(e, 0.0), detail);
  float hz = coverHeight(p + vec2(0.0, e), detail);
  // Slope in cover units, softened as the tread fades so a far cover is not all bevel.
  float k = 0.05 * (0.4 + 0.6 * detail);
  vec3 nWorld = normalize(vec3(-(hx - h0) / e * k, 1.0, -(hz - h0) / e * k));
  normal = normalize((viewMatrix * vec4(nWorld, 0.0)).xyz);

  float frame = smoothstep(0.80, 0.83, r);
  float seam = smoothstep(0.76, 0.79, r) * (1.0 - smoothstep(0.79, 0.82, r));
  // Raised iron is worn brighter than the grooves between it.
  float worn = clamp(h0, 0.0, 1.0);
  vec3 lid = diffuseColor.rgb * mix(0.8, 1.25, worn);
  diffuseColor.rgb = mix(lid, uCoverFrame, frame);
  diffuseColor.rgb *= 1.0 - 0.6 * seam;
  coverGloss = uCoverGlint * mix(0.6 + 0.6 * worn, 1.0, frame) * (1.0 - seam);
}`);
    // Lambert never adds the specular it was handed; add it before anything downstream (the shadow
    // tint, the look modes, the wet road) reads the sum.
    shader.fragmentShader = inject(shader.fragmentShader,
      'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
      'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance + reflectedLight.directSpecular;');
  };
  material.needsUpdate = true;
  return material;
}

/**
 * The covers as one mesh, or null under `?manholes=classic`. Not merged into the ground: the ground
 * wears the painterly road strokes (`brush`), and iron under a brush stroke reads as asphalt.
 */
export function createManholes(rng, { enabled = true } = {}) {
  if (!enabled) return null;
  const spots = planManholes(rng);
  if (spots.length === 0) return null;
  const mesh = new THREE.Mesh(manholeGeometry(spots), patchCover(propMaterial()));
  mesh.receiveShadow = true;
  mesh.name = 'manholes';
  mesh.userData.spots = spots;
  return mesh;
}
