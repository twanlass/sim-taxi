/**
 * Drops on the lens for the WebGPU renderer: LENS_FRAGMENT of game/rain.js as nodes. What a bead
 * and a slider are, and every number in them, is written there; this is the same arithmetic.
 *
 * Differences in mechanics:
 *  - the GLSL's early `return vec4(0.0)` is a result variable that an `If` fills in, and each of
 *    the four layers is a real function (`Fn`), so nothing declared in one branch is read in
 *    another (see the `select` note in game/gpulit.js);
 *  - every `smoothstep` with its edges reversed is `1 - smoothstep` the right way round;
 *  - no copy and no blend: the pass reads the frame from a target and writes all of it, drop or no
 *    drop (`lensSource` in game/rain.js says why);
 *  - the maths runs in the GLSL's coordinates (v up the screen); a render target's rows run down
 *    it under WebGPU, so the read flips v.
 */
import {
  abs, dot, float, floor, Fn, fract, If, length, max, mix, positionGeometry, screenUV, sin, smoothstep, sqrt, step,
  vec2, vec3, vec4,
} from 'three/tsl';
import { liveTexture, unlitTwin } from '../util/gpunodes.js';

const falling = (a, b, x) => float(1).sub(smoothstep(b, a, x));   // smoothstep(a, b, x) with a > b

const lensHash = (p) => {
  const p3 = fract(vec3(p).mul(vec3(0.1031, 0.11369, 0.13787))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(19.19)));
  return fract(vec3(p3.x.add(p3.y).mul(p3.z), p3.x.add(p3.z).mul(p3.y), p3.y.add(p3.z).mul(p3.x)));
};

export function lensTwin(glsl) {
  const frame = liveTexture(glsl.uniforms, 'tFrame');
  const material = unlitTwin(glsl, (u) => {
    const beads = Fn(([at, scale, density, t]) => {
      const out = vec4(0).toVar();
      const p = at.mul(vec2(u.uAspect, 1.0)).mul(scale).toVar();
      const id = floor(p).toVar();
      const n = lensHash(id.x.mul(107.45).add(id.y.mul(3543.654))).toVar();
      If(n.z.lessThanEqual(density), () => {
        const life = fract(t.mul(n.y.mul(0.05).add(0.04)).add(n.x)).toVar();
        const a = smoothstep(0.0, 0.03, life).mul(falling(1.0, 0.55, life)).toVar();
        const r = mix(0.1, 0.24, n.z.div(density)).mul(mix(0.75, 1.0, a)).toVar();
        const d = fract(p).sub(0.5).sub(n.xy.sub(0.5).mul(0.5)).mul(vec2(1.0, 1.12)).toVar();
        const dist = length(d).div(r).toVar();
        out.assign(vec4(d.div(r), dist, falling(1.0, 0.82, dist).mul(a)));
      });
      return out;
    });

    const sliders = Fn(([at, t, cols, live, rMin, rMax, speed, seed]) => {
      const out = vec4(0).toVar();
      const p = vec2(at.x.mul(u.uAspect).mul(cols), at.y).toVar();
      const col = floor(p.x).toVar();
      const n = lensHash(col.mul(71.3).add(seed)).toVar();
      If(n.x.lessThanEqual(live), () => {
        const fall = fract(t.mul(speed).mul(n.y.mul(0.8).add(0.6)).div(1.6).add(n.z)).toVar();
        const slip = fall.add(sin(fall.mul(6.2832).mul(n.y.mul(5.0).add(3.0))).mul(0.02));
        const headY = float(1.1).sub(slip.mul(1.6));
        const x = col.add(0.5).add(n.y.sub(0.5).mul(0.3)).add(sin(p.y.mul(9.0).add(n.z.mul(6.2832))).mul(0.08));
        const dx = p.x.sub(x).div(cols).toVar();
        const dy = p.y.sub(headY).toVar();
        const r = mix(rMin, rMax, fract(n.y.mul(7.31))).toVar();

        const hd = vec2(dx, dy.mul(0.8)).div(r).toVar();
        const hdist = length(hd).toVar();
        const head = vec4(hd, hdist, falling(1.0, 0.8, hdist)).toVar();

        const trail = n.z.mul(0.2).add(0.22);
        const along = dy.div(trail).toVar();
        const track = vec4(0).toVar();
        If(along.greaterThan(0.0).and(along.lessThan(1.0)), () => {
          const w = max(r.mul(0.42).mul(float(1).sub(along)), 1e-4).toVar();
          const tdist = abs(dx).div(w).toVar();
          track.assign(vec4(dx.div(w), 0.0, tdist, falling(1.0, 0.5, tdist).mul(float(1).sub(along)).mul(0.7)));
          const k = floor(dy.div(r.mul(2.4))).toVar();
          const m = lensHash(k.mul(13.7).add(col.mul(5.1)).add(seed)).toVar();
          If(m.x.lessThan(0.45), () => {
            const br = r.mul(mix(0.25, 0.45, m.y)).mul(float(1).sub(along.mul(0.5))).toVar();
            const bd = vec2(dx.sub(m.z.sub(0.5).mul(r).mul(0.3)), dy.sub(k.add(0.5).mul(r).mul(2.4))).div(br).toVar();
            const bdist = length(bd).toVar();
            const bc = falling(1.0, 0.8, bdist).mul(float(1).sub(along.mul(along))).toVar();
            If(bc.greaterThan(track.w), () => { track.assign(vec4(bd, bdist, bc)); });
          });
        });
        out.assign(head);
        If(track.w.greaterThan(head.w), () => { out.assign(track); });
      });
      return out;
    });

    // The nearest of the four layers. A function of its own because an `If` needs a stack to be
    // written into, and there is none while a material is being described.
    const nearest = Fn(([at]) => {
      const drop = beads(at, float(11.0), float(0.08), u.uTime).toVar();
      for (const layer of [
        beads(at.add(0.37), float(6.0), float(0.02), u.uTime.mul(0.7).add(3.0)),
        sliders(at, u.uTime, float(14.0), float(0.5), float(0.015), float(0.024), float(0.5), float(4.1)),
        sliders(at, u.uTime, float(26.0), float(0.35), float(0.008), float(0.012), float(0.3), float(19.7)),
      ]) {
        const next = layer.toVar();
        If(next.w.greaterThan(drop.w), () => { drop.assign(next); });
      }
      return drop;
    });
    const at = vec2(screenUV.x, float(1).sub(screenUV.y)).toVar();
    const drop = nearest(at).toVar();
    const cover = drop.w.mul(u.uAmount).toVar();
    const bend = drop.xy.mul(sqrt(max(float(1).sub(drop.z.mul(drop.z)), 0.0)));
    const src = at.sub(bend.mul(0.022));
    const seen = frame.sample(vec2(src.x, float(1).sub(src.y))).level(0).rgb
      .mul(mix(1.0, 0.72, smoothstep(0.55, 1.0, drop.z)));
    const catchLight = falling(0.35, 0.0, length(drop.xy.sub(vec2(-0.35, 0.4))));
    // Where the GLSL discarded (`cover < 0.01`) and left the frame under it showing, this pass is
    // the frame: it writes what is there.
    const plain = frame.sample(screenUV).level(0).rgb;
    return {
      vertex: vec4(positionGeometry.xy, 0.0, 1.0),
      color: mix(plain, seen.add(catchLight.mul(0.16)), cover.mul(step(0.01, cover))),
    };
  }, { display: true });
  // Opaque: it replaces the destination rather than blending onto a copy of it.
  material.transparent = false;
  return material;
}
