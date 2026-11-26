/**
 * Cloud shadows and the squall cell's shade as nodes: CLOUD_GLSL and CLOUD_LIGHT (util/geo.js),
 * where the reasoning lives, for the WebGPU materials.
 *
 * `cloudLight` answers the two factors CLOUD_LIGHT multiplies into the light at a fragment: the
 * sun's share that gets through, and the sky's.
 *
 * One thing is not carried over. The GLSL rebuilds the world position from the view position
 * through `uCloudViewInv`, because the rain's mirror pass draws through a second camera. That pass
 * is not ported, and a node material has the world position to hand.
 */
import * as THREE from 'three';
import { NodeMaterial, QuadMesh } from 'three/webgpu';
import {
  Fn, dot, float, floor, fract, length, max, mix, positionWorld, select, sin, smoothstep, texture, uniform, uv, vec2, vec4,
} from 'three/tsl';
import { MAX_SPAN } from '../city/grid.js';

const hash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
/** `cloudHash`, for anything that has to draw the same numbers the field does. */
export const cloudHash = hash;
const noise = (p) => {
  const i = floor(p).toVar();
  const f0 = fract(p).toVar();
  const f = f0.mul(f0).mul(float(3).sub(f0.mul(2))).toVar();
  return mix(mix(hash(i), hash(i.add(vec2(1, 0))), f.x),
    mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), f.x), f.y);
};

/**
 * CLOUD_GLSL's functions over nodes, for anything that reads the field outside a lit material (the
 * rain's streaks, splashes, shafts and rays, game/gpurain.js). Arguments as the GLSL has them.
 */
export const cellFront = (xz, cell, t) => length(xz.sub(cell.xy)).sub(cell.z.mul(
  noise(vec2(xz.x.div(16).add(t.mul(0.04)), xz.y.div(16).sub(t.mul(0.03)))).mul(0.36).add(0.82)));
export const cellRain = (xz, cell, edge, t, shape, strength) => {
  const f = cellFront(xz, cell, t).toVar();
  const heavy = float(1).sub(smoothstep(0.0, edge, f));
  const drizzle = shape.y.mul(float(1).sub(smoothstep(0.0, edge.mul(shape.x), f)));
  return select(cell.w.lessThan(0.5), 0.0, strength.mul(max(heavy, drizzle)));
};
export const cellShade = (xz, cell, edge, t, shape, strength) => select(cell.w.lessThan(0.5), 0.0,
  strength.mul(float(1).sub(smoothstep(edge.mul(shape.z), edge.mul(shape.w), cellFront(xz, cell, t)))));
export const cloudSun = (xz, t, cover, scale, drift) => {
  const p = xz.div(scale).add(drift.mul(t)).toVar();
  const field = noise(p).mul(0.68).add(noise(p.mul(2.3).add(vec2(t.mul(0.021), t.mul(-0.017)))).mul(0.32));
  const edge = mix(-0.65, 1.65, cover);
  return smoothstep(edge.sub(0.07), edge.add(0.07), field.sub(0.5).mul(2).add(0.5));
};

/**
 * **The shade is drawn once a frame into a map over the island, and every lit material reads one
 * texel of it.** It used to be computed per fragment inside every lit material: three octaves of
 * value noise (twelve hashes, each a `sin`) for the cloud field and the squall's ragged front.
 * That was ~100 lines of WGSL in each of the city's ~100 lit fragment shaders, and a shader's
 * first-launch Metal compile scales with its length (2026-11-26, M5 MacBook, cold shader cache:
 * a boot without the squall, which drops this and the wet ground, came up 2.1 s sooner). It also
 * re-ran that noise on every lit pixel of every frame. The field is soft — the cloud noise is 30
 * units across, the front's 16 — so a 512² map over twice the island's span (0.5 units a texel,
 * about four phone pixels at play zoom, filtered) carries all of it.
 *
 * `cloudLight()` answers the same `{ sun, sky }` it always did; `update(renderer)` redraws the map
 * and is called at the top of every frame (game/renderpath.js). Outside the map the edge texel
 * stretches on, which is the fog bank. `?cloudmap=classic` computes it per fragment as before.
 */
const MAP_SIZE = 512;
export const CLOUD_MAP_EXTENT = MAX_SPAN * 2;
const CLASSIC = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('cloudmap') === 'classic';

export function createCloudNodes(U) {
  const scalar = (slot) => uniform(slot.value).onRenderUpdate(() => slot.value);
  const cover = scalar(U.uCloudCover);
  const floorLight = scalar(U.uCloudFloor);
  const time = scalar(U.uCloudTime);
  const scale = scalar(U.uCloudScale);
  const drift = uniform(U.uCloudDrift.value);
  const cell = uniform(U.uCell.value);
  const cellEdge = scalar(U.uCellEdge);
  const cellTime = scalar(U.uCellTime);
  const cellShape = uniform(U.uCellShape.value);
  const cellLight = uniform(U.uCellLight.value);

  // The two factors at a world xz, as nodes: what the map stores, or (classic) what each material
  // computed for itself.
  const field = (xz) => {
    // cloudSun
    const p = xz.div(scale).add(drift.mul(time)).toVar();
    const f = noise(p).mul(0.68)
      .add(noise(p.mul(2.3).add(vec2(time.mul(0.021), time.mul(-0.017)))).mul(0.32));
    const edge = mix(-0.65, 1.65, cover);
    const sun = smoothstep(edge.sub(0.07), edge.add(0.07), f.sub(0.5).mul(2).add(0.5));
    // cellShade, off cellFront
    const r = cell.z.mul(noise(vec2(xz.x.div(16).add(cellTime.mul(0.04)), xz.y.div(16).sub(cellTime.mul(0.03))))
      .mul(0.36).add(0.82));
    const front = length(xz.sub(cell.xy)).sub(r);
    const shade = select(cell.w.lessThan(0.5), 0.0, cellLight.w.mul(
      float(1).sub(smoothstep(cellEdge.mul(cellShape.z), cellEdge.mul(cellShape.w), front)))).toVar();
    return {
      sun: mix(floorLight, 1.0, sun).mul(float(1).sub(shade.mul(0.88))),
      sky: float(1).sub(shade.mul(0.3)),
    };
  };

  if (CLASSIC) {
    const cloudLight = () => {
      const { sun, sky } = field(positionWorld.xz);
      return { sun: sun.toVar(), sky: sky.toVar() };
    };
    cloudLight.update = () => {};
    return cloudLight;
  }

  // Half float: the factors multiply the light, and eight bits would step a slow gradient.
  const target = new THREE.RenderTarget(MAP_SIZE, MAP_SIZE, {
    type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  target.texture.name = 'cloudMap';
  const material = new NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;
  material.userData.display = true;   // numbers in, numbers out: no grade, no encode
  // uv (0, 0) is the map's first texel, and the read below samples the same uv back, so which way
  // up the texture sits in memory never enters into it.
  material.fragmentNode = Fn(() => {
    const { sun, sky } = field(uv().sub(0.5).mul(CLOUD_MAP_EXTENT));
    return vec4(sun, sky, 0, 1);
  })();
  const quad = new QuadMesh(material);
  const map = texture(target.texture);

  const cloudLight = () => {
    const at = map.sample(positionWorld.xz.div(CLOUD_MAP_EXTENT).add(0.5)).toVar();
    return { sun: at.r, sky: at.g };
  };
  cloudLight.update = (renderer) => {
    const prevTarget = renderer.getRenderTarget();
    const prevMRT = renderer.getMRT();
    renderer.setMRT(null);
    renderer.setRenderTarget(target);
    quad.render(renderer);
    renderer.setRenderTarget(prevTarget);
    renderer.setMRT(prevMRT);
  };
  return cloudLight;
}
