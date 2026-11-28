/**
 * The falling snow for the WebGPU renderer: the flakes' hand-written shader in game/snow.js as a
 * node material, with the same uniforms bag (`unlitTwin`, util/gpunodes.js). Everything about what
 * it draws and why is written there; this is the same arithmetic.
 *
 * As with the rain's twins, a flake that is switched off goes outside the clip volume through a
 * `select`, and the material is `display`: unconverted and ungraded, as the GLSL wrote it.
 */
import {
  attribute, cameraProjectionMatrix, cameraViewMatrix, cos, float, fract, length, mod, select, sin,
  smoothstep, varying, vec2, vec3, vec4,
} from 'three/tsl';
import { unlitTwin } from '../util/gpunodes.js';

const OFF = vec4(2, 2, 2, 1);

export function flakeTwin(glsl) {
  return unlitTwin(glsl, (u) => {
    const s = attribute('seed', 'vec4');
    const corner = attribute('corner', 'vec2');
    const speed = s.w.mul(0.6).add(0.7).toVar();
    const raw = s.xyz.mul(u.uBox).add(vec3(u.uWind.x, u.uFall.negate(), u.uWind.y).mul(speed).mul(u.uTime)).toVar();
    const sx = sin(u.uTime.mul(s.w.add(0.9)).add(s.x.mul(40))).mul(0.8);
    const sz = cos(u.uTime.mul(s.z.add(0.7)).add(s.y.mul(40))).mul(0.8);
    const swayed = vec2(raw.x.add(sx), raw.z.add(sz));
    const xz = u.uCentre.xz.add(mod(swayed.sub(u.uCentre.xz).add(u.uBox.xz.mul(0.5)), u.uBox.xz))
      .sub(u.uBox.xz.mul(0.5)).toVar();
    const p = vec3(xz.x, mod(raw.y, u.uBox.y), xz.y).toVar();
    const v = cameraViewMatrix.mul(vec4(p, 1.0)).toVar();
    const size = u.uSize.mul(fract(s.w.mul(13.7)).mul(0.9).add(0.55));
    const placed = cameraProjectionMatrix.mul(vec4(v.xy.add(corner.mul(size)), v.z, v.w));
    const off = fract(s.w.mul(91.7).add(s.x.mul(37.3))).greaterThan(u.uDensity);
    const alpha = varying(s.z.mul(0.4).add(0.6).mul(smoothstep(0.0, 2.5, p.y)));
    const c = varying(corner);
    const a = float(1).sub(smoothstep(0.3, 1.0, length(c))).mul(alpha).mul(u.uOpacity);
    return {
      vertex: select(off, OFF, placed),
      color: u.uColor,
      opacity: a,
    };
  }, { display: true });
}
