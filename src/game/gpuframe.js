/**
 * Ambient occlusion for the WebGPU renderer, and the place its later passes will go.
 *
 * **Not the WebGL arrangement, on purpose.** There (game/ssao.js) every occluder is drawn twice:
 * once into a depth prepass, then the estimator runs at half resolution, then each lit material
 * fetches the result and multiplies its indirect light by it. The prepass is the expensive part on
 * a phone, where the frame's cost tracks its draw calls, and the port exists to cut those. So here
 * the city is drawn once, into a target with a depth texture and a second colour attachment, and
 * one full-screen triangle does the rest:
 *
 *   - attachment 0 is the frame, finished, in display space (see `installNodeGrade`, gpufog.js);
 *   - attachment 1 is, per pixel, the share of the surface's light that is fill rather than sun
 *     (`aoShare`, written by the prop lighting model). Occlusion is a statement about how much
 *     sky reaches a surface, so it takes that share of the pixel down and leaves the sun's alone:
 *     `lit = albedo * (sun + fill * ao) = frame * (1 - share * (1 - ao))`, which is what the GLSL
 *     computes, moved after the sum;
 *   - the depth texture is the main render's own, so the estimator (the same depth Laplacian, same
 *     rings, same thresholds as ssao.js) sees exactly what was drawn, the entrance wave included,
 *     with no second set of depth materials to keep in step.
 *
 * What differs from WebGL, knowingly: the estimator runs at full resolution on a depth buffer that
 * holds everything that writes depth rather than the enrolled occluders alone; the multiply lands
 * after the haze and the grade rather than before (through the display curve, so a crease is the
 * same depth of shade); and there is no ink channel yet (Crayon and Cartoon are not ported).
 *
 * Off with `?ao=off`, and under MSAA for now (a multisampled depth texture cannot be sampled as it
 * stands): the frame then goes straight to the canvas as it did before this file.
 */
import * as THREE from 'three';
import { NodeMaterial, QuadMesh } from 'three/webgpu';
import {
  Fn, abs, clamp, diffuseColor, float, max, mrt, output, pow, step, texture, uniform, uv, vec2, vec3, vec4,
} from 'three/tsl';
import { aoShare } from '../util/gpumaterial.js';
import { createGlowChain, glowLight, glowState, GLOW_RANGE } from './gpubloom.js';
import { RING_BROAD, RING_TIGHT, FALLOFF, MAX_DEPTH_DIFF } from './ssao.js';

// The estimator's radii are clamped in texels of the WebGL pass's half-resolution buffer; kept in
// those units so a crease is as wide here as there.
const MIN_RADIUS_TEXELS = 1.0;
const MAX_RADIUS_TEXELS = 6.0;

// 0.6 is the WebGL pass's strength. Measured on the overview (`?shot=1&msaa=off`, mean darkening
// by luminance band) the same number here took 2.9/255 off the mid-tones against WebGL's 2.2: the
// depth buffer holds more than the enrolled occluders, and the estimator is not softened by a
// half-resolution upsample. Three quarters of it lands on WebGL's figure.
const STRENGTH = 0.45;

export function createGpuFrame(renderer, { strength = STRENGTH, crt = null } = {}) {
  const depthTexture = new THREE.DepthTexture(1, 1);
  depthTexture.format = THREE.DepthStencilFormat;
  depthTexture.type = THREE.UnsignedInt248Type;
  // A third attachment while the bloom is on: the light each fragment sends it (game/gpubloom.js),
  // blended by the frame's own alpha so a flame's glow fades with the flame.
  const glow = glowState.enabled;
  const target = new THREE.RenderTarget(1, 1, { count: glow ? 3 : 2, depthTexture, stencilBuffer: true });
  target.textures[0].name = 'output';
  target.textures[1].name = 'share';
  if (glow) target.textures[2].name = 'glow';
  const layout = mrt({
    output,
    share: vec4(aoShare, 0, 0, diffuseColor.a),
    ...(glow ? { glow: vec4(glowLight.div(GLOW_RANGE), output.a) } : {}),
  });
  const glowChain = glow ? createGlowChain(renderer, target.textures[2]) : null;

  const tight = uniform(new THREE.Vector2());
  const broad = uniform(new THREE.Vector2());
  const depthScale = uniform(1);
  const amount = uniform(strength);
  // The CRT screen (game/gpucrt.js) wraps this pass; 0 for a frame the wet lens will finish.
  const screenOn = uniform(1);

  const frame = texture(target.textures[0]);
  const share = texture(target.textures[1]);
  const depth = texture(depthTexture);

  const material = new NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  // Finished display values in, finished display values out.
  material.userData.display = true;
  material.fog = false;
  // The finished texel at `at`. `atR` and `atB` are where the screen wants its red and blue read
  // (the aberration): the frame's own, under the occlusion and the spill worked out at `at`.
  const finish = ({ at, atR = at, atB = at }) => {
    const viewDepth = (offset) => depth.sample(at.add(offset)).r.mul(depthScale);
    const z0 = viewDepth(vec2(0, 0)).toVar();
    // One opposed pair of taps: the depth Laplacian, clamped to its concave half (ssao.js).
    const pair = (offset, radius) => {
      const a = z0.sub(viewDepth(offset)).toVar();
      const b = z0.sub(viewDepth(offset.negate())).toVar();
      const valid = step(abs(a), radius * MAX_DEPTH_DIFF).mul(step(abs(b), radius * MAX_DEPTH_DIFF));
      return valid.mul(clamp(a.add(b).mul(0.5 / (radius * FALLOFF)), 0.0, 1.0));
    };
    const either = (a, b) => a.add(b).sub(a.mul(b));
    const d = broad.mul(0.70710678);
    const occluded = either(
      either(pair(vec2(tight.x, 0), RING_TIGHT), pair(vec2(0, tight.y), RING_TIGHT)),
      either(pair(vec2(d.x, d.y), RING_BROAD), pair(vec2(d.x, d.y.negate()), RING_BROAD)),
    );
    const colour = frame.sample(at);
    const split = atR === at ? colour.rgb : vec3(frame.sample(atR).r, colour.g, frame.sample(atB).b);
    // The frame is display-encoded, and the GLSL took the fill down before the encode.
    const keep = float(1).sub(share.sample(at).r.mul(amount).mul(occluded));
    const occludedColour = split.mul(pow(max(keep, 0.05), 1 / 2.2));
    // The spill is light in the picture, added in display space as the WebGL composite adds it.
    return vec4(glowChain ? occludedColour.add(glowChain.composite(at)) : occludedColour, colour.a);
  };
  material.fragmentNode = Fn(() => (crt ? crt.screen(finish, screenOn) : finish({ at: uv() })))();
  const quad = new QuadMesh(material);

  const size = new THREE.Vector2();
  const ring = (camera, radius, out) => {
    const halfW = size.x / 2;
    const halfH = size.y / 2;
    out.set(
      Math.min(Math.max(radius / (camera.right - camera.left), MIN_RADIUS_TEXELS / halfW), MAX_RADIUS_TEXELS / halfW),
      Math.min(Math.max(radius / (camera.top - camera.bottom), MIN_RADIUS_TEXELS / halfH), MAX_RADIUS_TEXELS / halfH),
    );
  };

  // The depth texture carries a stencil too (the ghost outlines stamp their mask into it), and
  // WebGPU will not bind a view of both aspects for sampling: the bind group fails validation and
  // the frame comes out black. three r180 always asks for every aspect, so the view it asks this
  // one texture for, when binding it, is narrowed to depth here. Per GPUTexture, so again after a
  // resize has made a new one.
  const depthOnly = () => {
    const gpu = renderer.backend.get(depthTexture).texture;
    if (!gpu || gpu.depthOnlyViews) return;
    gpu.depthOnlyViews = true;
    const createView = gpu.createView.bind(gpu);
    // The binding's request names a dimension; the render pass's does not, and needs both aspects.
    gpu.createView = (descriptor) => createView(
      descriptor?.dimension ? { ...descriptor, aspect: 'depth-only' } : descriptor);
  };

  return {
    target,
    setStrength(value) { amount.value = value; },
    /** Draw `draw()` (the scene, to whatever target is current) into the frame's own target. */
    begin() {
      renderer.getDrawingBufferSize(size);
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
      glowChain?.resize(size.x, size.y);
      renderer.setMRT(layout);
      renderer.setRenderTarget(target);
    },
    /**
     * Occlude and put the frame on `destination` (null is the canvas). `screen: false` for a frame
     * something else finishes: the CRT screen is then that pass's to draw.
     */
    end(camera, destination = null, { screen = true } = {}) {
      renderer.setMRT(null);
      screenOn.value = screen ? 1 : 0;
      // `zoom` scales the frustum the projection actually uses.
      const view = {
        right: camera.right / camera.zoom, left: camera.left / camera.zoom,
        top: camera.top / camera.zoom, bottom: camera.bottom / camera.zoom,
      };
      ring(view, RING_TIGHT, tight.value);
      ring(view, RING_BROAD, broad.value);
      depthScale.value = camera.far - camera.near;
      depthOnly();
      glowChain?.render(target.width, target.height);
      renderer.setRenderTarget(destination);
      quad.render(renderer);
      renderer.setRenderTarget(null);
    },
  };
}
