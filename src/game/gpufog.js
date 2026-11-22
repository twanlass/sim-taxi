/**
 * The air, for the WebGPU renderer: the distance haze and the fog of war as one `scene.fogNode`.
 *
 * On WebGL these are three's own linear fog plus a term appended to its fog chunk
 * (game/edgefog.js, which is also where every number here is explained). A node scene has one fog
 * node and it returns the finished colour, so the two are composed here: haze first, the bank over
 * it, exactly the order the chunk ran them in.
 *
 * **Mixed in display space, on purpose.** three's WebGL fog chunk runs after the colour-space
 * chunk, so the game has always mixed its fog into sRGB-encoded pixels, and every fog colour in
 * the project was chosen by eye against that. A node material fogs in linear space and encodes at
 * the end, which with the same numbers gives a visibly heavier, greyer haze. So: encode, mix,
 * decode. The output pass's encode then cancels the decode and the pixel is the one WebGL drew.
 */
import * as THREE from 'three';
import {
  Fn, abs, dot, float, floor, fract, length, max, min, mix, output, positionWorld, rangeFogFactor,
  reference, sRGBTransferEOTF, sRGBTransferOETF, select, sin, smoothstep, texture3D, uniform, vec2, vec3,
  vec4, clamp,
} from 'three/tsl';
import { GRADE_UNIFORMS, gradeUniform, LUT_SIZE } from './colorgrade.js';
import {
  EDGE_FOG, FOG_HALF_X, FOG_HALF_Z, FOG_RADIUS, FOG_START, FOG_END, FOG_BILLOW, FOG_SLOPE, FOG_DRIFT,
  FOG_DRIFT_FINE, FOG_WARP, FOG_WARP_SPEED, FLOOR_Y, edgeFogUniform,
} from './edgefog.js';

const hash = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));
const noise = Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(
    mix(hash(i), hash(i.add(vec2(1, 0))), u.x),
    mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), u.x),
    u.y,
  );
});

// The colour grade (game/colorgrade.js): one shared uniform and the one LUT, as the GLSL has.
const grade = uniform(new THREE.Vector4()).onRenderUpdate((_, self) => {
  self.value.set(gradeUniform.x, gradeUniform.y, gradeUniform.z, gradeUniform.w);
});

/**
 * The grade, on a display-space colour: `colorgrade_fragment` as a node. On WebGL it is appended
 * to the fog chunk, outside the fog's own `#ifdef`, so it runs last on everything three draws with
 * a built-in material, fogged or not. Here it rides the fog node, which only fogged materials run;
 * an unfogged material has to call this itself (the sky does) until the grade moves to one pass
 * over the frame.
 *
 * The shipped default is not neutral: `GRADE_DEFAULTS` carries about half a stop of exposure, and
 * leaving it out is what made the first WebGPU frames 1.7 times darker than the game.
 */
export function gradeDisplay(display) {
  const n = LUT_SIZE;
  const c = clamp(display, 0, 1);
  const looked = mix(c, texture3D(GRADE_UNIFORMS.colorGradeLut.value, c.mul((n - 1) / n).add(0.5 / n)).rgb, grade.y);
  const graded = max(mix(vec3(dot(looked, vec3(0.2126, 0.7152, 0.0722))), looked, grade.x), 0);
  return select(grade.w.greaterThan(0.5), graded, display);
}

export function createFogNode(fog) {
  const hazeColor = reference('color', 'color', fog);
  const near = reference('near', 'float', fog);
  const far = reference('far', 'float', fog);
  // `edgeFogUniform` is a plain { x, y, z, w } that the WebGL path hands three as a vec4; copied
  // into a real one each frame so `setEdgeFogSky` and `tickEdgeFog` keep working untouched.
  const edge = uniform(new THREE.Vector4()).onRenderUpdate((_, self) => {
    self.value.set(edgeFogUniform.x, edgeFogUniform.y, edgeFogUniform.z, edgeFogUniform.w);
  });

  return Fn(() => {
    const display = sRGBTransferOETF(output.rgb).toVar();
    display.assign(mix(display, hazeColor, rangeFogFactor(near, far)));

    if (EDGE_FOG) {
      const p = positionWorld.xz;
      const t = edge.w;
      const q = abs(p).sub(vec2(FOG_HALF_X - FOG_RADIUS, FOG_HALF_Z - FOG_RADIUS));
      const d = length(max(q, 0)).add(min(max(q.x, q.y), 0)).sub(FOG_RADIUS);
      const s = p.mul(0.022).add(vec2(0, FOG_WARP_SPEED * 0.022).mul(t));
      const w = p.add(vec2(noise(s), noise(s.yx.add(4.7))).sub(0.5).mul(2 * FOG_WARP));
      const n = noise(w.sub(vec2(...FOG_DRIFT).mul(t)).mul(0.06)).mul(0.65)
        .add(noise(w.sub(vec2(...FOG_DRIFT_FINE).mul(t)).mul(0.17).add(7.3)).mul(0.35)).toVar();
      const h = max(positionWorld.y, 0).mul(FOG_SLOPE);
      const rising = smoothstep(FOG_START, FOG_END, d.sub(n.mul(FOG_BILLOW)).sub(h));
      // Below the floor plane is the bank itself, wherever it is on the map.
      const a = select(positionWorld.y.lessThan(FLOOR_Y + 1), float(1), rising);
      const eased = float(1).sub(float(1).sub(a).pow(3));
      // All-zero colour is the fog switched off (`?edgefog` tuning, the workshop's bench).
      const on = edge.x.add(edge.y).add(edge.z).greaterThan(0);
      display.assign(mix(display, edge.xyz.mul(n.mul(0.2).add(0.86)), select(on, eased, float(0))));
    }

    return vec4(sRGBTransferEOTF(gradeDisplay(display)), output.a);
  })();
}

/** A display-space colour, as a linear node: what a WebGL `ShaderMaterial` wrote raw to the canvas. */
export const displayColor = (node) => sRGBTransferEOTF(gradeDisplay(vec3(node)));
