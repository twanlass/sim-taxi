import * as THREE from 'three';
import {
  abs, dot, float, floor, fract, mix, mod, normalGeometry, positionGeometry, select, sin, step, uniform, varying, vec2, vec3,
} from 'three/tsl';

// The pixel grain on the buildings (Tyler, 2026-11-24: "could we add a similar pixel noise effect
// to buildings to give them some texture too?"). The pixel street's idea (`setRoadPixels` in
// util/geo.js) carried onto every wall and roof of the towers' merged mesh: a grid of world texels
// at the street's own 0.25, so the whole city reads at one pixel resolution, and each texel takes
// one value from
//
// - a **tone drift**, value noise at 2.5 and 0.7 units, so a wall is a little lighter in one
//   patch and darker in the next, and clumps of texels break up the flat colour;
// - **speckle**, single light and dark texels, about one in 22 of each;
//
// rounded to a short ramp, with a 2x2 ordered dither where the ramp steps, so a tone change is a
// checker of pixels rather than a smooth edge. A multiply on the diffuse colour (the facade courses'
// seam, city/facade.js), so shadow, AO and the courses all land on it unchanged. No stains, no
// strokes, no colour: painted walls and colour blotches were both tried and dropped.
//
// The grid is laid in the face's own plane (x/z and y on a wall, x and z on a roof), and the
// coordinate across the face plus which way it faces salt the hash, so two walls of one block, or
// a wall and its parapet, do not wear the same pattern. Read off the geometry's own position, like
// the courses, so it rides up with a wall through the city's entrance instead of sliding over it.
//
// `?bldgtex=classic` compiles none of it; `?bldgtexamt=` scales it; `?bldgpx=` is the texel.
//
// Cost, tools/gpucost.mjs at 780x1688 on SwiftShader's WebGL against `?bldgtex=classic`: +2.0% and
// +3.2% a frame over two interleaved pairs (1538 to 1568 ms, 1465 to 1512). Two noise octaves and
// one hash, no texture read. Not measured on a phone.
//
// First pass at drift 0.16 / speck 0.1 / a single 2.5-unit octave was invisible at play zoom; a
// 0.7-unit second octave and roughly double the swing is what makes the pixels read.

export const WALL_GRAIN = { drift: 0.36, speck: 0.16, step: 0.06 };
export const WALL_TEXEL = 0.25;

// x the drift, y the speckle, z the ramp's step, w the texel. Shared by every program.
export const WALL_GRAIN_UNIFORMS = { uWallGrain: { value: new THREE.Vector4(0, 0, WALL_GRAIN.step, WALL_TEXEL) } };
let enabled = false;

/** Decided before the city's materials compile (game/renderpath.js). `amount` 0 compiles nothing. */
export function setWallGrain(amount = 1, texel = WALL_TEXEL) {
  const a = Math.max(0, amount);
  const t = texel > 0 ? texel : WALL_TEXEL;
  enabled = a > 0;
  WALL_GRAIN_UNIFORMS.uWallGrain.value.set(WALL_GRAIN.drift * a, WALL_GRAIN.speck * a, WALL_GRAIN.step, t);
}
export const wallGrainOn = () => enabled;

const GLSL_COMMON = /* glsl */ `
uniform vec4 uWallGrain;
varying vec3 vGrainPos;
varying vec3 vGrainN;
float grainHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float grainNoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	return mix(mix(grainHash(i), grainHash(i + vec2(1.0, 0.0)), f.x),
		mix(grainHash(i + vec2(0.0, 1.0)), grainHash(i + vec2(1.0, 1.0)), f.x), f.y);
}`;

const GLSL_FRAGMENT = /* glsl */ `
	{
		vec3 gn = abs(vGrainN);
		bool roof = gn.y > 0.5;
		bool alongZ = gn.x > gn.z;
		vec2 gp = roof ? vGrainPos.xz : vec2(alongZ ? vGrainPos.z : vGrainPos.x, vGrainPos.y);
		float across = roof ? vGrainPos.y : (alongZ ? vGrainPos.x : vGrainPos.z);
		float facing = roof ? 0.0 : (alongZ ? 1.0 : 3.0) + step(0.0, alongZ ? vGrainN.x : vGrainN.z);
		float salt = fract(floor(across * 2.0 + 0.5) * 0.1373 + facing * 0.291) * 97.0;
		vec2 gc = floor(gp / uWallGrain.w);
		vec2 gq = (gc + 0.5) * uWallGrain.w;
		float drift = grainNoise(gq / 2.5 + salt) * 0.6 + grainNoise(gq / 0.7 + salt + 11.0) * 0.4 - 0.5;
		float sp = grainHash(gc + salt * 1.7);
		float speck = step(0.955, sp) - step(sp, 0.045);
		float gv = 1.0 + drift * 2.0 * uWallGrain.x + speck * uWallGrain.y;
		vec2 bm = mod(gc, 2.0);
		float bayer = (bm.x * 2.0 + abs(bm.x - bm.y)) * 0.25 + 0.125;
		diffuseColor.rgb *= floor(gv / uWallGrain.z + bayer) * uWallGrain.z;
	}`;

const hash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
const noise = (p) => {
  const i = floor(p).toVar();
  const f0 = fract(p).toVar();
  const f = f0.mul(f0).mul(f0.mul(-2).add(3)).toVar();
  return mix(mix(hash(i), hash(i.add(vec2(1, 0))), f.x), mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), f.x), f.y);
};

/** The GLSL above as nodes: one factor on the diffuse colour. */
function grainNode() {
  const U = uniform(WALL_GRAIN_UNIFORMS.uWallGrain.value);
  const pos = varying(positionGeometry);
  const n = varying(normalGeometry);
  const gn = abs(n);
  const roof = gn.y.greaterThan(0.5);
  const alongZ = gn.x.greaterThan(gn.z);
  const gp = select(roof, pos.xz, vec2(select(alongZ, pos.z, pos.x), pos.y)).toVar();
  const across = select(roof, pos.y, select(alongZ, pos.x, pos.z));
  const facing = select(roof, float(0), select(alongZ, float(1), float(3)).add(step(0.0, select(alongZ, n.x, n.z))));
  const salt = fract(floor(across.mul(2).add(0.5)).mul(0.1373).add(facing.mul(0.291))).mul(97).toVar();
  const gc = floor(gp.div(U.w)).toVar();
  const gq = gc.add(0.5).mul(U.w);
  const drift = noise(gq.div(2.5).add(salt)).mul(0.6).add(noise(gq.div(0.7).add(salt).add(11)).mul(0.4)).sub(0.5);
  const sp = hash(gc.add(salt.mul(1.7))).toVar();
  const speck = step(0.955, sp).sub(step(sp, 0.045));
  const gv = drift.mul(2).mul(U.x).add(speck.mul(U.y)).add(1);
  const bm = mod(gc, 2.0).toVar();
  const bayer = bm.x.mul(2).add(abs(bm.x.sub(bm.y))).mul(0.25).add(0.125);
  return vec3(floor(gv.div(U.z).add(bayer)).mul(U.z));
}

/**
 * Compose the grain onto a building material, after whatever it already carries (the courses).
 * A no-op while the grain is off, so `?bldgtex=classic` compiles exactly the old program.
 */
export function patchWallGrain(material) {
  if (!enabled) return material;
  if (material.isNodeMaterial) {
    material.surfaces = [...(material.surfaces ?? []), { key: 'grain', paint: grainNode }];
    return material;
  }
  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${prevKey ? prevKey.call(material) : ''}|grain`;
  material.onBeforeCompile = (shader, renderer) => {
    if (prevCompile) prevCompile(shader, renderer);
    Object.assign(shader.uniforms, WALL_GRAIN_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vGrainPos;
varying vec3 vGrainN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
	vGrainPos = position;
	vGrainN = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${GLSL_COMMON}`)
      .replace('#include <color_fragment>', `#include <color_fragment>${GLSL_FRAGMENT}`);
    if (!shader.vertexShader.includes('vGrainN = normal;')) throw new Error('wall grain: vertex hook missed');
    if (!shader.fragmentShader.includes('diffuseColor.rgb *= floor(gv')) throw new Error('wall grain: fragment hook missed');
  };
  return material;
}
