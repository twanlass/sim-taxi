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
import { NodeMaterial } from 'three/webgpu';
import {
  Fn, abs, dot, float, floor, fract, length, max, min, mix, output, positionWorld, rangeFogFactor,
  reference, sRGBTransferEOTF, sRGBTransferOETF, select, sin, smoothstep, texture3D, uniform, vec2, vec3,
  vec4, clamp,
} from 'three/tsl';
import { GRADE_UNIFORMS, gradeUniform, LUT_SIZE } from './colorgrade.js';
import { writeGlow } from './gpubloom.js';
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
    // The haze colour is encoded too. three's WebGL renderer hands `fogColor` over in the *output*
    // colour space when it draws to the screen (`getUnlitUniformColorSpace`), so the GLSL mixed
    // display into display. Mixing the linear colour instead left the red of #77CFFF at 0.19 for
    // 0.47, and the whole city 6/255 short of red and 4 of green: the "lit faces 3% low" that was
    // chased through the lights first. With it, the frame is within 0.5/255 of WebGL's.
    display.assign(mix(display, sRGBTransferOETF(hazeColor), rangeFogFactor(near, far)));

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

    return vec4(gradeDisplay(display), output.a);
  })();
}

/**
 * Grade everything the haze does not reach. On WebGL the grade rides the end of three's fog chunk
 * (`installColorGrade`), outside its `USE_FOG` test, so a material with `fog: false` — every
 * marker and every unlit effect, through `unlitMaterial()` — is graded too. A node material only
 * runs `scene.fogNode` when its own `fog` is on, so those came out ungraded: with the shipped
 * grade that is every marker about half a stop dark.
 *
 * Patched onto the base class, once, because three converts built-in materials to node materials
 * out of sight and there is no instance to set an `outputNode` on. Before the premultiply, as the
 * GLSL chunk order has it.
 *
 * **Every node material ends in display space, and the renderer is told the frame is linear**
 * (`outputColorSpace` in main.js), which is a deliberate lie with two payoffs. Blending happens on
 * display values, as it does on WebGL, where every material encodes in its own shader: blended
 * in linear the route band came out a third more opaque and visibly more yellow. And three draws
 * straight to the canvas: asked to convert the colour space itself it renders the scene to a
 * target and copies that to the canvas through a full-screen pass, every frame.
 *
 * So the tail of every material is: the haze, fog of war and grade (`scene.fogNode`, for the lit
 * ones), or the encode and the grade (here, for the rest). A material that writes finished
 * display values itself (the sky; a glow that is light and not paint, see game/colorgrade.js)
 * sets `userData.display` and is left alone.
 */
let gradeInstalled = false;
export function installNodeGrade() {
  if (gradeInstalled) return;
  gradeInstalled = true;
  // three's own `setupOutput`, restated (fog, then the premultiply) so there is a place between
  // the two: `userData.finish(rgba, builder)` runs where a patch after `<dithering_fragment>` did,
  // on the finished display colour with its alpha still straight. Not part of three's cache key,
  // so a material that sets one also needs a key of its own; one that keeps its `onBeforeCompile`
  // has it, three's default key being that function's text.
  NodeMaterial.prototype.setupOutput = function setupOutput(builder, outputNode) {
    // The bloom's share of this fragment, before the haze and the grade (game/gpubloom.js).
    writeGlow(this.userData.display ? sRGBTransferEOTF(outputNode.rgb) : outputNode.rgb, gradeDisplay);
    let node = this.fog === true || this.userData.display
      ? outputNode
      : vec4(gradeDisplay(sRGBTransferOETF(outputNode.rgb)), outputNode.a);
    if (this.fog === true) node = this.setupFog(builder, node);
    if (this.userData.finish) node = this.userData.finish(node, builder);
    if (this.premultipliedAlpha === true) node = this.setupPremultipliedAlpha(builder, node);
    return node;
  };
}

/** A display-space colour, graded: what a WebGL `ShaderMaterial` wrote raw to the canvas. For a `userData.display` material. */
export const displayColor = (node) => gradeDisplay(vec3(node));
