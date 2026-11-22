/**
 * The paved junction as nodes: the plaza's brick field, soldier course and kerb-stone band from
 * PAINT_FRAGMENT (util/geo.js), where the reasoning for every number lives.
 *
 * That is the whole of the painterly look that is on by default. Its other parts are all dialled
 * to zero (lawn strokes, the wall-foot fade, the terminator tint) or behind a classic toggle
 * (`?roadstrokes=classic`), and none of those is ported.
 *
 * The GLSL multiplies the finished pixel in display space; `paving(display, world)` takes and
 * answers a display-space colour, and the caller does the encode and decode around it.
 */
import { abs, dot, exp2, float, floor, fract, If, length, min, mix, mod, select, sin, smoothstep, step, uniform, vec2, vec3 } from 'three/tsl';

const hash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));

export function createPaving(U) {
  const grid = uniform(U.uRoadGrid.value);
  const riverZ = uniform(U.uRiverZ.value);
  const art = uniform(U.uRoadArt.value);
  const tint = uniform(U.uJunctionTint.value);
  const edge = uniform(U.uJunctionEdge.value);
  const band = uniform(U.uJunctionBand.value);
  const style = uniform(1).onRenderUpdate(() => U.uJunctionStyle.value);
  const mortarColor = uniform(U.uJunctionMortar.value);
  const at = uniform(U.uJunctionAt.value);
  const brick = uniform(U.uJunctionBrick.value);

  return function paving(display, world) {
    const out = display.toVar();
    If(tint.w.greaterThan(0).and(world.y.lessThan(0.1)), () => {
      const jp = world.xz.sub(vec2(0, select(world.z.greaterThan(riverZ.x), riverZ.y, 0.0))).toVar();
      const jl = floor(jp.add(grid.xy).div(grid.z).add(0.5)).toVar();
      const jd = abs(jp.add(grid.xy).sub(jl.mul(grid.z)));
      // The box reaches by the crossing road's half-width on each axis.
      const hx = mix(art.z, art.w, mod(floor(art.y.div(exp2(jl.x))), 2.0));
      const hz = mix(art.z, art.w, mod(floor(art.x.div(exp2(jl.y))), 2.0));
      const jin = vec2(hx, hz).sub(jd).toVar();
      const jn = min(jin.x, jin.y).toVar();
      const box = smoothstep(-0.06, 0.06, jn).mul(step(length(jl.sub(at)), 0.5)).toVar();
      If(box.greaterThan(0), () => {
        // Running bond.
        const bp0 = jp.div(brick.xy).toVar();
        const course = floor(bp0.y).toVar();
        const bp = vec2(bp0.x.add(mod(course, 2.0).mul(0.5)), bp0.y).toVar();
        const gap = brick.xy.mul(0.5).sub(abs(fract(bp).sub(0.5)).mul(brick.xy));
        const mortar = float(1).sub(smoothstep(brick.z.mul(0.5), brick.z, min(gap.x, gap.y)));
        const shade = hash(vec2(floor(bp.x), course).add(jl.mul(31))).mul(0.3).add(0.84);
        const field = mix(tint.rgb.mul(shade), mortarColor, mortar).toVar();
        const plain = mix(field, edge.rgb,
          float(1).sub(smoothstep(edge.w.sub(0.05), edge.w.add(0.05), jn)));
        // The frame: kerb stone outside, then a soldier course laid end-on to its edge.
        const alongX = jin.x.lessThan(jin.y);
        const t = select(alongX, jp.y, jp.x).toVar();
        const sn = jn.sub(band.w).toVar();
        const sa = abs(fract(t.div(brick.y)).sub(0.5)).mul(brick.y);
        const sGap = min(brick.y.mul(0.5).sub(sa), min(sn, edge.w.sub(sn)));
        const sMortar = float(1).sub(smoothstep(brick.z.mul(0.5), brick.z, sGap));
        const sShade = hash(vec2(floor(t.div(brick.y)), select(alongX, 1.0, 2.0)).add(jl.mul(31))).mul(0.2).add(0.9);
        const soldier = mix(edge.rgb.mul(sShade), mortarColor, sMortar.mul(0.35));
        const framed = mix(
          mix(soldier, band.rgb, float(1).sub(smoothstep(-0.02, 0.02, sn))),
          field, smoothstep(edge.w.sub(0.02), edge.w.add(0.02), sn));
        // The lift comes off where the asphalt is already bright (wet night reflections).
        const wet = float(1).sub(smoothstep(0.42, 0.7, dot(display, vec3(0.2126, 0.7152, 0.0722))));
        out.mulAssign(mix(vec3(1), select(style.greaterThan(0.5), framed, plain), box.mul(tint.w).mul(wet)));
      });
    });
    return out;
  };
}
