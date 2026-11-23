/**
 * Wet ground for the WebGPU renderer: WET_COMMON, WET_ALBEDO and WET_REFLECT of game/rain.js as
 * nodes on the prop node material. What each term is for is written there; this is the same
 * arithmetic at the two seams util/gpumaterial.js has for it.
 *
 *  - WET_ALBEDO ran after the colour chunk: a `surfaces` entry, the multiply on the diffuse colour.
 *  - WET_REFLECT ran before the opaque chunk, on the summed light: a lighting model whose `finish`
 *    runs the prop's own first.
 *
 * Differences in mechanics:
 *  - the uniforms are the rain's own bags read each render, because the mirror pass swaps two of
 *    them for the length of one draw (the reflection for a black texel, the wet level for 0);
 *  - the screen position is `screenUV`, which runs down the frame where `gl_FragCoord` ran up it,
 *    so the vertical half of the ripple's offset changes sign and nothing else does: the mirror is
 *    drawn and read the same way up;
 *  - the loops are unrolled in JavaScript.
 */
import {
  abs, attribute, clamp, cross, dFdx, dFdy, diffuseColor, dot, float, floor, fract, length, mix, normalize,
  positionWorld, screenUV, select, sin, smoothstep, sRGBTransferEOTF, step, uniform, varying, vec2, vec3,
} from 'three/tsl';
import { liveTexture } from '../util/gpunodes.js';
import { cellRain } from '../util/gpuclouds.js';

const LUMA = vec3(0.2126, 0.7152, 0.0722);

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
const ripples = (p, t) => {
  const cell = floor(p).toVar();
  const slope = vec2(0).toVar();
  for (let y = -1; y <= 1; y++) {
    for (let x = -1; x <= 1; x++) {
      const c = cell.add(vec2(x, y)).toVar();
      const h = hash(c).toVar();
      const cyc = t.mul(h.mul(0.6).add(0.8)).add(h.mul(13)).toVar();
      const n = floor(cyc);
      const life = fract(cyc).toVar();
      const centre = c.add(vec2(hash(c.add(n.mul(0.37))), hash(c.yx.add(n.mul(0.71)))));
      const d = p.sub(centre).toVar();
      const r = length(d).add(1e-4).toVar();
      const x0 = r.sub(life.mul(1.2)).toVar();
      // `smoothstep(0.3, 0.0, x)` in the GLSL; WGSL leaves reversed edges undefined.
      const env = float(1).sub(smoothstep(0.0, 0.3, abs(x0))).mul(float(1).sub(life)).mul(float(1).sub(life));
      slope.addAssign(d.div(r).mul(sin(x0.mul(22))).mul(env));
    }
  }
  return slope;
};

/**
 * `G` is the rain's ground uniforms, `C` the cloud field's. Answers `wet(material, { deck })`,
 * which patches one prop node material; `deck` says the geometry carries `rainDeck`.
 */
export function createWetNodes(G, C) {
  const scalar = (slot) => uniform(slot.value).onRenderUpdate(() => slot.value);
  const level = scalar(G.uRainWet);
  const time = scalar(G.uRainTime);
  const extent = scalar(G.uWetExtent);
  const glint = scalar(G.uRainGlint);
  const sheen = uniform(G.uRainSheen.value);
  const glintColor = uniform(G.uRainGlintColor.value);
  const cell = uniform(C.uCell.value);
  const cellEdge = scalar(C.uCellEdge);
  const cellTime = scalar(C.uCellTime);
  const cellShape = uniform(C.uCellShape.value);
  const cellLight = uniform(C.uCellLight.value);
  const wetMap = liveTexture(G, 'tWetMap');
  const mirror = liveTexture(G, 'tRainReflect');

  return function wet(material, { deck = false } = {}) {
    // Written by the diffuse-colour seam, read by the lighting one: both are the fragment stage of
    // one build, and the cache key below gives each wet material a build of its own.
    const terms = {};
    const paint = () => {
      const xz = positionWorld.xz;
      const lift = deck ? varying(attribute('rainDeck', 'float')) : float(0);
      terms.here = level.mul(wetMap.sample(xz.add(extent.mul(0.5)).div(extent)).r).toVar();
      terms.up = smoothstep(0.8, 0.95, abs(normalize(cross(dFdx(positionWorld), dFdy(positionWorld))).y)).toVar();
      terms.road = float(1).sub(smoothstep(0.08, 0.2, positionWorld.y.sub(lift))).toVar();
      terms.grass = step(diffuseColor.r.mul(1.08), diffuseColor.g).mul(step(diffuseColor.b, diffuseColor.g)).toVar();
      const puddleN = noise(xz.mul(0.16)).mul(0.7).add(noise(xz.mul(0.9).add(3.0)).mul(0.3));
      terms.puddle = smoothstep(0.62, 0.68, puddleN).mul(terms.road).mul(terms.up).mul(terms.here)
        .mul(float(1).sub(smoothstep(0.1, 0.4, lift))).toVar();
      const wetness = terms.here.mul(mix(0.55, 1.0, terms.up)).mul(mix(0.6, 1.0, terms.road))
        .mul(float(1).sub(terms.grass.mul(0.5)));
      return mix(1.0, 0.58, wetness).mul(mix(1.0, 0.7, terms.puddle));
    };
    material.surfaces = [...(material.surfaces ?? []), { key: `wet${deck ? '-deck' : ''}`, paint }];

    const inner = material.lightingFactory;
    material.lightingFactory = (Base) => class WetLighting extends (inner ? inner(Base) : Base) {
      finish(input) {
        super.finish(input);
        const { outgoingLight } = input.context;
        const { here, up, road, grass, puddle } = terms;
        const xz = positionWorld.xz;
        const now = select(cell.w.greaterThan(0.5),
          cellRain(xz, cell, cellEdge, cellTime, cellShape, cellLight.w), 1.0);
        const rip = ripples(xz.div(1.1), time).mul(now).toVar();
        const wob = vec2(noise(xz.mul(1.7).add(time.mul(0.4))), noise(xz.mul(1.7).sub(time.mul(0.4)).add(5.0))).sub(0.5);
        const offset = rip.mul(mix(0.003, 0.009, puddle)).add(wob.mul(0.006).mul(float(1).sub(puddle)));
        const ruv = vec2(float(1).sub(screenUV.x).add(offset.x), screenUV.y.sub(offset.y)).toVar();
        const spread = mix(0.03, 0.004, puddle).toVar();
        let refl = vec3(0);
        let wsum = 0;
        for (let k = -4; k <= 4; k++) {
          const w = 1 - Math.abs(k) / 5;
          refl = refl.add(sRGBTransferEOTF(mirror.sample(ruv.add(vec2(0, spread.mul(k / 4)))).rgb).mul(w));
          wsum += w;
        }
        const gloss = here.mul(up).mul(mix(mix(0.07, 0.3, road), 0.72, puddle)).mul(float(1).sub(grass.mul(0.8)));
        outgoingLight.assign(mix(outgoingLight, refl.div(wsum), gloss));
        outgoingLight.addAssign(sheen.mul(clamp(length(rip), 0.0, 1.0)).mul(mix(0.02, 0.1, puddle)).mul(up).mul(road));
        // The sun on the surface as the prop model left it, under the cloud's shade.
        outgoingLight.addAssign(glintColor.mul(glint).mul(dot(this.sunlit, LUMA)).mul(here).mul(up)
          .mul(mix(0.35, 1.0, road)).mul(mix(0.6, 1.0, puddle)).mul(float(1).sub(grass.mul(0.7))));
      }
    };
    material.userData.ported = true;
    material.needsUpdate = true;
  };
}
