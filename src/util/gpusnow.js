/**
 * Snow on the city for the WebGPU renderer: `SNOW_GLSL` in util/geo.js as nodes, run at the prop
 * node material's diffuse-colour seam (util/gpumaterial.js). What each term is for is written
 * there; this is the same arithmetic, line for line.
 */
import {
  abs, cross, dFdx, dFdy, dot, float, floor, fract, mix, normalize, positionWorld, smoothstep, uniform, vec2,
} from 'three/tsl';
import { liveTexture } from './gpunodes.js';

const hash = (p0) => {
  const p = fract(p0.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
};
const noise = (p) => {
  const i = floor(p).toVar();
  const f0 = fract(p).toVar();
  const f = f0.mul(f0).mul(float(3).sub(f0.mul(2))).toVar();
  return mix(mix(hash(i), hash(i.add(vec2(1, 0))), f.x),
    mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), f.x), f.y);
};

/** `U` is SNOW_UNIFORMS. Answers `cover(base)`, the diffuse colour with the snow on it. */
export function createSnowNodes(U) {
  const snow = uniform(U.uSnow.value);
  const color = uniform(U.uSnowColor.value);
  const tracks = liveTexture(U, 'tSnowTracks');

  return function cover(base) {
    const w = positionWorld;
    const up = abs(normalize(cross(dFdx(w), dFdy(w))).y);
    const face = smoothstep(0.5, 0.85, up);
    const n = noise(w.xz.mul(0.21)).mul(0.65).add(noise(w.xz.mul(1.3).add(7.0)).mul(0.35)).toVar();
    const amt = face.mul(smoothstep(0.0, 0.12, snow.x.mul(1.15).sub(n.mul(0.9))));
    const low = float(1).sub(smoothstep(0.3, 0.6, w.y));
    const track = snow.y.mul(low).mul(tracks.sample(w.xz.div(snow.z).add(0.5)).r);
    const road = float(1).sub(smoothstep(0.08, 0.2, w.y));
    const white = color.mul(n.mul(0.07).add(0.93)).mul(float(1).sub(road.mul(n.mul(0.12).add(0.08))));
    const slush = mix(base.mul(0.7), color.mul(0.5), 0.35);
    return mix(base, mix(white, slush, smoothstep(0.05, 0.8, track).mul(0.9)), amt);
  };
}
