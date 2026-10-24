import * as THREE from 'three';

// Wall detail on the towers: a darker plinth under a string course, a lit ledge with its shadow
// under every row of sills, a cornice at the top of each tier, and — on half the masonry — a
// lighter pilaster between each pair of window bays. All of it is a fragment patch on the merged
// building mesh, keyed off one attribute stamped on each tier's box. No geometry, no rng draw, no
// new colour: every term is a multiplier on the envelope's own vertex colour.
//
// Why structure rather than texture: at play zoom one unit is ~7.7px, so anything with a period
// under a unit (brick coursing, stucco noise) is a shimmer rather than a surface. What reads is a
// handful of value changes a building actually has — a base, a top, a line per storey — and each
// of those is at least a pixel or two tall on a phone. The first thing they fix is that every
// wall was one colour from kerb to parapet, which is what made a building read as a printed box.
//
// `?walls=classic` (headless: `WALLS=classic`) leaves the walls flat.
export const WALLS_CLASSIC = typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('walls') === 'classic'
  : globalThis.process?.env?.WALLS === 'classic';

/** What a wall gets. 0 is nothing (roofs, caps, every part that is not a tower's wall). */
export const WALL_STYLE = { NONE: 0, LEDGES: 1, PILASTERS: 2 };

// Every term, as a multiplier on the wall's own colour. Measured against the five envelope
// families at play zoom on a 390-wide phone: below ~8% a line stops separating from the wall,
// and the plinth past ~18% reads as a different building standing in front of this one.
const PLINTH = 0.78;          // the ground storey, under the string course
const COURSE_LIT = 1.24;      // the string course, a lit band along the top of the ground storey
const LEDGE_LIT = 1.22;       // a sill ledge's top, catching the sun
const LEDGE_SHADE = 0.74;     // ...and the strip of shadow it throws on the wall under it
const CORNICE_LIT = 1.18;     // a tier's top band
const PILASTER_LIT = 1.12;    // a pier between two bays
const SPANDREL = 0.93;        // the wall between piers, on a pilastered building
const QUOIN_LIT = 1.06;       // the last quarter-unit at each corner of every wall

/**
 * Stamp `aWall` on a tier's box: per vertex, (style, first floor line, u along its face, face
 * width), and `aWallTop`, the tier's top. Roof and floor faces get style 0. `u` is measured from
 * the face's centre the way `facadeQuads` measures it, so the pilasters land between the windows
 * that face's `bayLayout` put there. Linear across a face on one axis, so a quad interpolates it
 * exactly.
 */
export function stampWall(geo, { style, origin, top, cx, cz, w, d, tangents }) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const data = new Float32Array(pos.count * 4);
  const tops = new Float32Array(pos.count).fill(top);
  for (let i = 0; i < pos.count; i++) {
    const nx = nrm.getX(i);
    const ny = nrm.getY(i);
    const nz = nrm.getZ(i);
    if (Math.abs(ny) > 0.5) continue;
    const side = Math.abs(nx) > 0.5 ? (nx > 0 ? 0 : 2) : (nz > 0 ? 1 : 3);
    const [tx, tz] = tangents[side];
    data[i * 4] = style;
    data[i * 4 + 1] = origin;
    data[i * 4 + 2] = (pos.getX(i) - cx) * tx + (pos.getZ(i) - cz) * tz;
    data[i * 4 + 3] = side % 2 === 0 ? d : w;
  }
  geo.setAttribute('aWall', new THREE.BufferAttribute(data, 4));
  geo.setAttribute('aWallTop', new THREE.BufferAttribute(tops, 1));
  return geo;
}

/** `mergeGeometries` wants every part to carry the same attributes: zeros on the rest. */
export function fillWalls(parts) {
  for (const p of parts) {
    if (p.attributes.aWall) continue;
    const n = p.attributes.position.count;
    p.setAttribute('aWall', new THREE.BufferAttribute(new Float32Array(n * 4), 4));
    p.setAttribute('aWallTop', new THREE.BufferAttribute(new Float32Array(n), 1));
  }
  return parts;
}

const f = (x) => x.toFixed(4);

/**
 * The fragment patch, composed onto whatever the material already carries (the `cityentry`
 * pattern): its key is appended to the existing one, never replacing it. A no-op under
 * `?walls=classic`. The pattern reads the geometry's own `position`, not the animated one, so
 * during the entrance it rides up with the wall instead of sliding over it.
 */
export function patchWalls(material, { floorH, sill, bay, groundTop }) {
  if (WALLS_CLASSIC) return material;
  const prevCompile = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = () => `${prevKey ? prevKey.call(material) : ''}|walls`;
  material.onBeforeCompile = (shader, renderer) => {
    if (prevCompile) prevCompile(shader, renderer);
    const vs = shader.vertexShader;
    const fs = shader.fragmentShader;
    shader.vertexShader = vs
      .replace('#include <common>', `#include <common>
attribute vec4 aWall;
attribute float aWallTop;
varying vec4 vWall;
varying float vWallTop;
varying float vWallY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
	vWall = aWall;
	vWallTop = aWallTop;
	vWallY = position.y;`);
    shader.fragmentShader = fs
      .replace('#include <common>', `#include <common>
varying vec4 vWall;
varying float vWallTop;
varying float vWallY;
float wallBand(float x, float a, float b, float aa) {
	return smoothstep(a - aa, a + aa, x) - smoothstep(b - aa, b + aa, x);
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
	if (vWall.x > 0.5) {
		float wy = vWallY;
		float origin = vWall.y;
		float u = vWall.z;
		float fw = vWall.w;
		float top = vWallTop;
		// Half a pixel either side, so a quarter-unit line stays a line at any zoom without crawling.
		float ay = 0.5 * fwidth(wy) + 1e-4;
		float au = 0.5 * fwidth(u) + 1e-4;
		float m = 1.0;

		// The ground storey: only on a tier whose first line is the ground storey's top.
		float ground = step(abs(origin - ${f(groundTop)}), 0.01);
		m *= mix(1.0, ${f(PLINTH)}, ground * (1.0 - smoothstep(origin - ay, origin + ay, wy)));
		m *= mix(1.0, ${f(COURSE_LIT)}, ground * wallBand(wy, origin - 0.06, origin + 0.16, ay));

		// A ledge under every row of sills, on exactly the floor lines floorLines drew windows on.
		float k = floor((wy - origin) / ${f(floorH)});
		float ph = wy - origin - k * ${f(floorH)};
		float row = step(0.0, k) * step(origin + (k + 1.0) * ${f(floorH)}, top - 0.35 + 1e-3);
		m *= mix(1.0, ${f(LEDGE_LIT)}, row * wallBand(ph, ${f(sill - 0.22)}, ${f(sill - 0.04)}, ay));
		m *= mix(1.0, ${f(LEDGE_SHADE)}, row * wallBand(ph, ${f(sill - 0.38)}, ${f(sill - 0.22)}, ay));

		// The cornice: a lit band at the top of the tier, its shadow under it.
		m *= mix(1.0, ${f(CORNICE_LIT)}, wallBand(wy, top - 0.4, top + 1.0, ay));
		m *= mix(1.0, ${f(LEDGE_SHADE)}, wallBand(wy, top - 0.56, top - 0.4, ay));

		// Quoins: the corners, lighter, so a mass reads as built out to its edges.
		m *= mix(1.0, ${f(QUOIN_LIT)}, smoothstep(fw * 0.5 - 0.26 - au, fw * 0.5 - 0.26 + au, abs(u)));

		// Pilasters between bays, above the ground storey. Pitch from bayLayout.
		if (vWall.x > 1.5) {
			float bays = clamp(floor(fw / ${f(bay)} + 0.5), 1.0, 6.0);
			float pitch = fw * 0.88 / bays;
			float um = u / pitch + bays * 0.5;
			float dp = abs(um - floor(um + 0.5)) * pitch;
			float pier = 1.0 - smoothstep(0.2 - au, 0.2 + au, dp);
			float above = smoothstep(origin + 0.16 - ay, origin + 0.16 + ay, wy) * (1.0 - step(top - 0.56, wy));
			m *= mix(1.0, mix(${f(SPANDREL)}, ${f(PILASTER_LIT)}, pier), above);
		}
		diffuseColor.rgb *= m;
	}`);
    for (const marker of ['attribute vec4 aWall', 'vWallY = position.y']) {
      if (!shader.vertexShader.includes(marker)) throw new Error(`walls: vertex hook missed (${marker})`);
    }
    if (!shader.fragmentShader.includes('diffuseColor.rgb *= m;')) throw new Error('walls: fragment hook missed');
  };
  return material;
}
