import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColors, propMaterial } from '../util/geo.js';

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

// --- Window frames --------------------------------------------------------------
//
// Every punched window gets a real surround: a head and two jambs standing proud of the wall and
// a deeper sill under them. The point is not the trim's colour but the *shadow* — under this sun
// the head throws a strip across the top of the pane and the jamb on the far side throws one down
// its edge, and that is what turns a dark rectangle painted on a wall into a hole in it. The
// reveals (the trim's inner faces) light differently from the wall too, so even a frame in shadow
// draws its own outline. Curtain-wall ribbons get none: on glass the glass is the wall.
//
// Hand-wound quads, batched one geometry per façade the way `facadeQuads` batches its panes —
// a city carries a few thousand windows, and a few thousand `BoxGeometry`s are what that function
// exists to avoid. Each face is wound from its corners and then *checked* against the outward
// direction it is meant to have, so a slip in the corner order flips itself rather than shipping
// an inside-out frame (the roadworks ramp); `tools/probe.mjs` asserts the result from the winding.
// Measured in units off the wall. Deep enough that the head's shadow is a couple of shadow-map
// texels (0.123 each), shallow enough that the frame never reads as a balcony at play zoom.
const FRAME_W = 0.13;         // width of a jamb or the head
const FRAME_D = 0.2;          // how far the head and jambs stand off the wall
const SILL_H = 0.11;
const SILL_D = 0.28;          // the sill sticks out further: it is what catches the light
const SILL_OVER = 0.1;        // ...and runs past the jambs at each end
// Five faces a bar (no back: it is against the wall), two triangles a face, four bars a window.
export const FRAME_TRIS_PER_WINDOW = 40;

/**
 * The frames for one façade's punched windows, as one geometry. `rects` are the panes, exactly as
 * they go to `facadeQuads`; `side`, `out` and `tan` are that face's outward and along directions.
 */
export function windowFrames(rects, side, cx, cz, hw, hd, col, out, tan) {
  const [nx, nz] = out;
  const [tx, tz] = tan;
  const reach = side % 2 === 0 ? hw : hd;
  const ox = cx + nx * reach;
  const oz = cz + nz * reach;
  const at = (u, y, n) => [ox + tx * u + nx * n, y, oz + tz * u + nz * n];

  const positions = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  // One quad, its corners in order, and the world direction it must face.
  const quad = (p, dir) => {
    a.fromArray(p[0]);
    b.fromArray(p[1]).sub(a);
    c.fromArray(p[2]).sub(a);
    const q = b.cross(c).dot(dir) < 0 ? [p[0], p[3], p[2], p[1]] : p;
    for (const k of [0, 1, 2, 0, 2, 3]) positions.push(...q[k]);
  };
  const OUT = new THREE.Vector3(nx, 0, nz);
  const UP = new THREE.Vector3(0, 1, 0);
  const DOWN = new THREE.Vector3(0, -1, 0);
  const ALONG = new THREE.Vector3(tx, 0, tz);
  const BACK = ALONG.clone().negate();
  // A bar from (u0, y0) to (u1, y1), standing `d` off the wall.
  const bar = (u0, u1, y0, y1, d) => {
    quad([at(u0, y0, d), at(u1, y0, d), at(u1, y1, d), at(u0, y1, d)], OUT);
    quad([at(u0, y1, 0), at(u1, y1, 0), at(u1, y1, d), at(u0, y1, d)], UP);
    quad([at(u0, y0, 0), at(u1, y0, 0), at(u1, y0, d), at(u0, y0, d)], DOWN);
    quad([at(u1, y0, 0), at(u1, y1, 0), at(u1, y1, d), at(u1, y0, d)], ALONG);
    quad([at(u0, y0, 0), at(u0, y1, 0), at(u0, y1, d), at(u0, y0, d)], BACK);
  };

  for (const { u, y, w, h } of rects) {
    const uL = u - w / 2;
    const uR = u + w / 2;
    const yB = y - h / 2;
    const yT = y + h / 2;
    bar(uL - FRAME_W - SILL_OVER, uR + FRAME_W + SILL_OVER, yB - SILL_H, yB, SILL_D);
    bar(uL - FRAME_W, uR + FRAME_W, yT, yT + FRAME_W, FRAME_D);
    bar(uL - FRAME_W, uL, yB, yT, FRAME_D);
    bar(uR, uR + FRAME_W, yB, yT, FRAME_D);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const colors = new Float32Array(positions.length);
  for (let i = 0; i < colors.length; i += 3) colors.set([col.r, col.g, col.b], i);
  const framed = bakeColors(geo, colors);
  framed.userData.frame = true;
  return framed;
}

/**
 * Take the frames out of a generator's parts into a mesh of their own, which neither casts nor
 * receives ambient occlusion. In the merged mesh they were AO occluders, and a 0.2-unit
 * protrusion against the SSAO's one-unit radius put a dark halo on the wall round every window
 * ("these shaded areas behind the windows feel off", Tyler, 2026-10-24). The sun's shadow is the
 * depth they are there for, and it stays. Returns the leftover parts and the mesh (null if none).
 */
export function frameMesh(parts, name) {
  const solid = [];
  const frames = [];
  for (const p of parts) (p.userData.frame ? frames : solid).push(p);
  if (!frames.length) return { solid, frames: null };
  const mesh = new THREE.Mesh(mergeGeometries(frames, false), propMaterial({ ao: false }));
  frames.forEach((p) => p.dispose());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = `${name}-window-frames`;
  return { solid, frames: mesh };
}
