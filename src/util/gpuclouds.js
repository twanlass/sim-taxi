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
import { dot, float, floor, fract, length, mix, positionWorld, select, sin, smoothstep, uniform, vec2 } from 'three/tsl';

const hash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
const noise = (p) => {
  const i = floor(p).toVar();
  const f0 = fract(p).toVar();
  const f = f0.mul(f0).mul(float(3).sub(f0.mul(2))).toVar();
  return mix(mix(hash(i), hash(i.add(vec2(1, 0))), f.x),
    mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), f.x), f.y);
};

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

  return function cloudLight() {
    const xz = positionWorld.xz;
    // cloudSun
    const p = xz.div(scale).add(drift.mul(time)).toVar();
    const field = noise(p).mul(0.68)
      .add(noise(p.mul(2.3).add(vec2(time.mul(0.021), time.mul(-0.017)))).mul(0.32));
    const edge = mix(-0.65, 1.65, cover);
    const sun = smoothstep(edge.sub(0.07), edge.add(0.07), field.sub(0.5).mul(2).add(0.5));
    // cellShade, off cellFront
    const r = cell.z.mul(noise(vec2(xz.x.div(16).add(cellTime.mul(0.04)), xz.y.div(16).sub(cellTime.mul(0.03))))
      .mul(0.36).add(0.82));
    const front = length(xz.sub(cell.xy)).sub(r);
    const shade = select(cell.w.lessThan(0.5), 0.0, cellLight.w.mul(
      float(1).sub(smoothstep(cellEdge.mul(cellShape.z), cellEdge.mul(cellShape.w), front)))).toVar();
    return {
      sun: mix(floorLight, 1.0, sun).mul(float(1).sub(shade.mul(0.88))).toVar(),
      sky: float(1).sub(shade.mul(0.3)).toVar(),
    };
  };
}
