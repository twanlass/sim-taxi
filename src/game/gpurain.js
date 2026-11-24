/**
 * The falling rain for the WebGPU renderer: the four hand-written shaders of game/rain.js (the
 * streaks, the splashes, the storm's sun shafts and the squall's sun rays) as node materials.
 * Everything about what they draw and why is in rain.js; this is the same arithmetic.
 *
 * Each twin keeps its GLSL material's `uniforms` bag (`unlitTwin`, util/gpunodes.js), so
 * `setWeather`, `update` and `attachSquall` go on writing the slots they always wrote.
 *
 * Three differences in mechanics:
 *  - a quad that is switched off is sent outside the clip volume through a `select`, not an early
 *    return;
 *  - WebGPU has no point size, so a splash is an instanced quad sized in device pixels off the
 *    drawing buffer, where the GLSL drew a point sprite (`splashGeometry`);
 *  - all four wrote bare numbers to the canvas with no colour-space chunk, so the twins are
 *    `display` materials: unconverted and ungraded, as they were.
 */
import * as THREE from 'three';
import {
  abs, atan, attribute, cameraProjectionMatrix, cameraViewMatrix, cos, cross, dot, float, floor, fract,
  length, max, mix, mod, normalize, pow, screenSize, select, sin, smoothstep, step, varying, vec2, vec3, vec4,
} from 'three/tsl';
import { liveTexture, unlitTwin } from '../util/gpunodes.js';
import { cellRain, cellShade, cloudSun } from '../util/gpuclouds.js';

const OFF = vec4(2, 2, 2, 1);
const corner = () => attribute('corner', 'vec2');
const seed = () => attribute('seed', 'vec4');
const view = (p) => cameraViewMatrix.mul(vec4(p, 1.0));

/** A ribbon between two view-space points, `width` either side, facing the camera. */
const ribbon = (from, to, width) => {
  const axis = normalize(to.xyz.sub(from.xyz));
  const side = normalize(cross(axis, vec3(0, 0, 1)));
  const v = mix(from, to, corner().y).toVar();
  return cameraProjectionMatrix.mul(vec4(v.xyz.add(side.mul(corner().x).mul(width)), v.w));
};

export function streakTwin(glsl) {
  return unlitTwin(glsl, (u) => {
    const s = seed();
    const speed = s.w.mul(0.4).add(0.8).toVar();
    const raw = s.xyz.mul(u.uBox).add(u.uFall.mul(speed).mul(u.uTime)).toVar();
    const xz = u.uCentre.xz.add(mod(raw.xz.sub(u.uCentre.xz).add(u.uBox.xz.mul(0.5)), u.uBox.xz))
      .sub(u.uBox.xz.mul(0.5)).toVar();
    const p = vec3(xz.x, mod(raw.y, u.uBox.y), xz.y).toVar();
    const tail = p.sub(normalize(u.uFall).mul(u.uLen).mul(speed));
    const wet = cellRain(xz, u.uCell, u.uCellEdge, u.uCellTime, u.uCellShape, u.uCellLight.w).toVar();
    const share = fract(s.w.mul(91.7).add(s.x.mul(37.3))).mul(0.85);
    const base = s.w.mul(0.55).add(0.45);
    const alpha = select(u.uCell.w.greaterThan(0.5),
      base.mul(mix(wet, smoothstep(share, share.add(0.15), wet), u.uCellLight.z)), base).toVar();
    const along = varying(corner().y);
    return {
      vertex: select(alpha.lessThanEqual(0.0), OFF, ribbon(view(p), view(tail), u.uWidth)),
      color: u.uColor,
      opacity: u.uOpacity.mul(varying(alpha)).mul(float(1).sub(along)).mul(smoothstep(0.0, 0.15, along.add(0.05))),
    };
  }, { display: true });
}

/**
 * The splashes' geometry under WebGPU: one quad, instanced, with the slot's three random numbers
 * (the GLSL's `position`) per instance.
 */
export function splashGeometry(slots) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('corner', new THREE.Float32BufferAttribute([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1], 2));
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(18), 3));
  geo.setAttribute('slot', new THREE.InstancedBufferAttribute(slots, 3));
  geo.instanceCount = slots.length / 3;
  return geo;
}

export function splashTwin(glsl) {
  const hash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));
  return unlitTwin(glsl, (u) => {
    const slot = attribute('slot', 'vec3');
    const cycle = u.uTime.mul(u.uRate).add(slot.z.mul(17)).toVar();
    const n = floor(cycle);
    const r = vec2(hash(slot.xy.add(n.mul(0.713))), hash(slot.yx.mul(1.31).add(n.mul(0.297))));
    const xz = u.uCentre.xz.add(r.sub(0.5).mul(u.uBox)).toVar();
    const dry = slot.x.greaterThan(u.uDensity).or(u.uCell.w.greaterThan(0.5).and(
      slot.y.greaterThan(cellRain(xz, u.uCell, u.uCellEdge, u.uCellTime, u.uCellShape, u.uCellLight.w))));
    const age = select(dry, 1.0, fract(cycle).div(u.uLife)).toVar();
    const size = u.uSize.mul(u.uPixelRatio).mul(age.mul(0.75).add(0.45));
    const centre = cameraProjectionMatrix.mul(view(vec3(xz.x, u.uY, xz.y))).toVar();
    // gl_PointCoord runs down the screen; the quad's corner runs up it.
    const p = varying(vec2(corner().x, corner().y.negate().mul(1.9)));
    const vAge = varying(age);
    const d = length(p);
    // `smoothstep` with its edges reversed is undefined in WGSL: 1 - smoothstep the right way round.
    const ring = smoothstep(0.55, 0.8, d).mul(float(1).sub(smoothstep(0.82, 1.0, d)));
    const crown = float(1).sub(smoothstep(0.0, 0.35, length(p.sub(vec2(0.0, vAge.mul(0.9).sub(0.6))))))
      .mul(float(1).sub(vAge));
    const a = max(ring.mul(0.55), crown).mul(float(1).sub(vAge.mul(vAge)));
    return {
      vertex: select(age.greaterThanEqual(1.0), OFF,
        vec4(centre.xy.add(corner().mul(size).div(screenSize)), centre.zw)),
      color: u.uColor,
      opacity: a.mul(0.7).mul(step(0.01, a)).mul(step(vAge, 0.9999)),
    };
  }, { display: true });
}

const beam = (alpha, footFade) => {
  const c = varying(corner());
  const across = float(1).sub(abs(c.x));
  const along = smoothstep(0.0, footFade, c.y).mul(pow(max(float(1).sub(c.y), 0.0), 1.4));
  return varying(alpha).mul(across).mul(across).mul(along);
};

export function shaftTwin(glsl) {
  return unlitTwin(glsl, (u) => {
    const s = seed();
    const wind = u.uCloudDrift.negate().mul(u.uCloudScale);
    const raw = s.xy.mul(u.uBox).add(wind.mul(u.uCloudTime));
    const xz = u.uCentre.xz.add(mod(raw.sub(u.uCentre.xz).add(u.uBox.mul(0.5)), vec2(u.uBox)))
      .sub(u.uBox.mul(0.5)).toVar();
    const sun = cloudSun(xz, u.uCloudTime, u.uCloudCover, u.uCloudScale, u.uCloudDrift);
    const alpha = sun.mul(smoothstep(0.08, 0.35, u.uCloudCover)).mul(u.uStrength).mul(s.w.mul(0.5).add(0.5));
    const foot = vec3(xz.x, 0.0, xz.y);
    const width = mix(2.5, 7.0, s.z).mul(corner().y.mul(0.8).add(1));
    return {
      vertex: ribbon(view(foot), view(foot.add(u.uSunDir.mul(u.uLen))), width),
      color: u.uColor.mul(beam(alpha, 0.06)),
    };
  }, { display: true });
}

export function sunRayTwin(glsl) {
  const wetMap = liveTexture(glsl.uniforms, 'tWetMap');
  return unlitTwin(glsl, (u) => {
    const s = seed();
    const a = atan(u.uCellDir.y.negate(), u.uCellDir.x.negate()).add(s.x.sub(0.5).mul(2.1))
      .add(sin(u.uCellTime.mul(0.07).add(s.w.mul(6.283))).mul(0.12));
    const d = u.uCell.z.add(u.uCellEdge.mul(mix(0.3, 2.6, s.y)));
    const xz = u.uCell.xy.add(vec2(cos(a), sin(a)).mul(d)).toVar();
    const shade = cellShade(xz, u.uCell, u.uCellEdge, u.uCellTime, u.uCellShape, u.uCellLight.w).toVar();
    const wet = wetMap.sample(xz.add(u.uWetExtent.mul(0.5)).div(u.uWetExtent)).level(0).r;
    const gap = smoothstep(0.08, 0.3, shade).mul(float(1).sub(smoothstep(0.7, 0.95, shade)));
    const passed = smoothstep(0.4, 0.75, wet);
    const breathe = smoothstep(0.1, 0.6,
      sin(u.uCellTime.mul(s.w.mul(0.2).add(0.22)).add(s.w.mul(40))).mul(0.5).add(0.5));
    const out = abs(xz).sub(u.uHalfSpan);
    const island = float(1).sub(smoothstep(-8.0, 0.0, max(out.x, out.y)));
    const alpha = u.uStrength.mul(gap).mul(passed).mul(breathe).mul(island).mul(s.z.mul(0.4).add(0.6)).toVar();
    const foot = vec3(xz.x, 0.0, xz.y);
    const width = mix(3.0, 8.0, s.z).mul(corner().y.mul(0.8).add(1));
    return {
      vertex: select(alpha.lessThan(0.003).or(u.uCell.w.lessThan(0.5)), OFF,
        ribbon(view(foot), view(foot.add(u.uSunDir.mul(u.uLen))), width)),
      color: u.uColor.mul(beam(alpha, 0.35)),
    };
  }, { display: true });
}
