import * as THREE from 'three';
import { color } from '../palette.js';
import { BODY_TOP, HOOD_HINGE_X, BOOT_HINGE_X } from './damage.js';

// The taxi's paint, chipped down to the metal (the default; `?taxidamage=classic` for the old
// multiply toward `taxiGrime`). Tyler, 2026-10-21: the tint "is not reading" — a dulled yellow is
// still a yellow car, and with nothing beside it to compare against the eye takes it for the light.
//
// It is a patch on the paint's own shader, not geometry laid over it. The first cut was geometry:
// several hundred little cell boxes merged onto the shell and each lid, hidden by collapsing their
// vertices. It worked, but it was a second skin, and every panel the damage moves needed a copy of
// it (a lid swung up carried its own set). Tyler's read (2026-10-21) was that this is a property of
// the paint, so the paint should say it — and in the shader a lid is chipped because its material
// is, the wreck is chipped because it is the same material, and the crash replay draws it because
// it draws that material.
//
// Each fragment finds the voxel it is in — a CELL grid in the car's own space — and scores that
// voxel: coarse value noise sampled at the voxel's centre, so a whole cell is in or out together
// (the voxel look), plus its distance to the nearest corner, so chips open from the corners and work
// inward. Under the wear threshold it shows bare steel. The wear is one value per corner, blended
// across the car, so the struck corner chips and the far end stays clean.
//
// There was a primer ring round each chip, a band just above the threshold: dark grey first, which
// read as a second copy of the livery's chequer, then red oxide, which Tyler cut (2026-10-21) as
// reading like noise. Bare steel alone is the risk that ring was there for — it is about as light as
// the yellow, so at play zoom it can pass for a glint — and the plain version is the call.
//
// Only paint chips. The test is the vertex colour — the taxi's yellow (high red, almost no blue) —
// so the glass, chrome, chequer cells, tyres and wheel wells that share the shell's material are
// left alone without a flag on any of them.

const CELL = 0.09;
// Off the cell grid by a fraction of a cell, so no panel the car is built from lies exactly on a cell
// boundary — the roof's top (2.07) is 23.0 cells up, and a face on a boundary flickers between two.
const GRID_SHIFT = 0.013;
// The noise's own scale: about one chip across.
const BLOB = 0.22;
// How much of the score is the noise and how much the distance to a corner (normalised so the car's
// middle is about 1). More distance and the chips march in from the corners in a front; more noise
// and they scatter.
const NOISE_SHARE = 0.6;
// A fully worn corner shows steel up to this score. 0.68 rather than 0.64 to give back the footprint
// the primer band used to add round each chip.
const WEAR_REACH = 0.68;

const f = (n) => n.toFixed(3);

const CHIP_DECLS = /* glsl */ `
varying vec3 vChipObj;
uniform vec4 uChipWear;
uniform vec3 uChipMetal;
float chipHash(vec3 p) {
	p = fract(p * vec3(0.1031, 0.1030, 0.0973));
	p += dot(p, p.yxz + 33.33);
	return fract((p.x + p.y) * p.z);
}
float chipNoise(vec3 p) {
	vec3 i = floor(p);
	vec3 w = fract(p);
	w = w * w * (3.0 - 2.0 * w);
	return mix(
		mix(mix(chipHash(i), chipHash(i + vec3(1, 0, 0)), w.x),
			mix(chipHash(i + vec3(0, 1, 0)), chipHash(i + vec3(1, 1, 0)), w.x), w.y),
		mix(mix(chipHash(i + vec3(0, 0, 1)), chipHash(i + vec3(1, 0, 1)), w.x),
			mix(chipHash(i + vec3(0, 1, 1)), chipHash(i + vec3(1, 1, 1)), w.x), w.y), w.z);
}
`;

// After the colour (and, on a glossy material, after its finish is read), before any light. The
// corner term is the distance in plan from the voxel to the car's nearest corner (1.7, 0.85), over
// 1.9 so the middle of the car is about 1.
const CHIP_FRAGMENT = /* glsl */ `
	{
		vec3 cCell = (floor((vChipObj + ${f(GRID_SHIFT)}) / ${f(CELL)}) + 0.5) * ${f(CELL)};
		float cN = chipNoise(cCell / ${f(BLOB)});
		float cCorner = clamp(length(abs(cCell.xz) - vec2(1.7, 0.85)) / 1.9, 0.0, 1.0);
		float cScore = ${f(NOISE_SHARE)} * cN + ${f(1 - NOISE_SHARE)} * cCorner;
		// Wear by corner (x nose right, y nose left, z tail right, w tail left), blended across.
		float cFx = smoothstep(-0.7, 0.7, cCell.x);
		float cFz = smoothstep(-0.45, 0.45, cCell.z);
		float cW = mix(mix(uChipWear.w, uChipWear.z, cFz), mix(uChipWear.y, uChipWear.x, cFz), cFx)
			* ${f(WEAR_REACH)};
		// The taxi's yellow and nothing else: high red, next to no blue.
		float cPaint = step(0.45, vColor.r) * step(vColor.b, 0.25 * vColor.r);
		if (cPaint > 0.5 && cScore < cW) {
			// Times diffuse, so a wreck's scorch (a multiply on the material colour) darkens it too.
			diffuseColor.rgb = uChipMetal * diffuse;
			__CHIP_FINISH__
		}
	}
`;

/**
 * Chip `material` — a `propMaterial()` on the taxi — off the shared `wear` uniform. `offset` takes
 * this mesh's own space to the car's: zero on the shell, the hinge's position on a lid, so a lid
 * wears the chips its panel had when it was shut.
 */
function chip(material, wear, offset) {
  const base = material.onBeforeCompile;
  const baseKey = material.customProgramCacheKey;
  const uniforms = {
    uChipWear: wear,
    uChipOffset: { value: offset },
    uChipMetal: { value: color('taxiBareMetal') },
  };
  material.onBeforeCompile = (shader, renderer) => {
    base.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vChipObj;
uniform vec3 uChipOffset;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
	vChipObj = transformed + uChipOffset;`);
    // On a glossy material a chip is metal, not paint: no clear coat on it.
    const glossy = shader.fragmentShader.includes('float gIsPaint;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
${CHIP_DECLS}`)
      .replace('#include <alphamap_fragment>', `${CHIP_FRAGMENT.replace('__CHIP_FINISH__',
        glossy ? 'gIsPaint = 0.0;' : '')}
#include <alphamap_fragment>`);
    // Never a blind replace (CLAUDE.md): a hook that matched nothing is a clean car and no error.
    if (!shader.vertexShader.includes('vChipObj = transformed')) throw new Error('chips: vertex hook missed');
    if (!shader.fragmentShader.includes('cScore < cW')) throw new Error('chips: fragment hook missed');
  };
  // A promise about source: every chipped material compiles the same patch over its own base.
  material.customProgramCacheKey = () => `${baseKey.call(material)}-chips`;
}

/**
 * Chip the taxi's paint: the shell's material and each lid's, all off one wear uniform, so the wreck
 * and any replay of it draw the same chips. Driven by game/taxidamage.js through `buildDamage`.
 */
export function chipPaint({ shell, hood, boot }) {
  // All four set: a bare `Vector4()` is (0, 0, 0, 1), which is the tail-left corner fully worn on
  // any taxi nothing has called `reset()` on yet — the app icon rendered it as a bare-steel roof.
  const wear = { value: new THREE.Vector4(0, 0, 0, 0) };
  chip(shell, wear, new THREE.Vector3());
  chip(hood, wear, new THREE.Vector3(HOOD_HINGE_X, BODY_TOP, 0));
  chip(boot, wear, new THREE.Vector3(BOOT_HINGE_X, BODY_TOP, 0));
  return {
    /** Wear by corner, a Map of `${end},${side}` → 0..1. */
    setWear(levels) {
      wear.value.set(levels.get('1,1') ?? 0, levels.get('1,-1') ?? 0,
        levels.get('-1,1') ?? 0, levels.get('-1,-1') ?? 0);
    },
    /** For the headless check: the wear at one corner as it stands. */
    wearAt: (end, side) => wear.value.getComponent((end > 0 ? 0 : 2) + (side > 0 ? 0 : 1)),
    materials: [shell, hood, boot],
  };
}
