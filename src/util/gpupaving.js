/**
 * The paved junction as nodes: the plaza's brick field, soldier course and kerb-stone band from
 * PAINT_FRAGMENT (util/geo.js), where the reasoning for every number lives.
 *
 * That and the asphalt's colour variation (`setRoadTexture`) are the whole of the painterly look
 * that is on by default. Its other parts are all dialled
 * to zero (lawn strokes, the wall-foot fade, the terminator tint) or behind a classic toggle
 * (`?roadstrokes=classic`), and none of those is ported.
 *
 * The GLSL multiplies the finished pixel in display space; `paving(display, world)` takes and
 * answers a display-space colour, and the caller does the encode and decode around it.
 */
import { abs, dot, exp2, float, floor, fract, If, length, min, mix, mod, select, sin, smoothstep, sRGBTransferOETF, step, texture, uniform, vec2, vec3, vec4, diffuseColor } from 'three/tsl';

const LUMA = vec3(0.2126, 0.7152, 0.0722);

const hash = (p) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453));

// paintNoise in the GLSL: one octave of value noise.
const noise = (p) => {
  const i = floor(p).toVar();
  const f0 = fract(p).toVar();
  const f = f0.mul(f0).mul(f0.mul(-2).add(3)).toVar();
  return mix(mix(hash(i), hash(i.add(vec2(1, 0))), f.x), mix(hash(i.add(vec2(0, 1))), hash(i.add(vec2(1, 1))), f.x), f.y);
};

export function createPaving(U) {
  const tex = uniform(U.uRoadTex.value);
  const texGrid = uniform(U.uRoadTexGrid.value);
  const fine = uniform(U.uRoadTexFine.value);
  const pixel = uniform(U.uRoadTexPixel.value);
  const tune = uniform(U.uRoadTexTune.value);
  const detail = uniform(U.uRoadTexDetail.value);
  const roadStain = (p, lane, chew) => {
    const g = p.div(3.2).toVar();
    const h = hash(floor(g).add(tex.w.mul(3.1))).toVar();
    const o = vec2(fract(h.mul(91.7)), fract(h.mul(513.3))).mul(0.4).add(0.3);
    const r = fract(h.mul(7919)).mul(0.13).add(0.07);
    const d = length(fract(g).sub(o)).div(r).add(chew.sub(0.5).mul(0.9));
    return step(float(1).sub(detail.x).sub(lane.mul(0.25)), h).mul(float(1).sub(smoothstep(0.5, 1.0, d)));
  };
  // roadTone in PAINT_COMMON (util/geo.js), where the reasoning is.
  const roadTone = (p) => {
    const q = p.div(tune.x).toVar();
    const a = noise(q.div(31).add(tex.w.mul(1.7)));
    const b = noise(q.div(13).add(tex.w.mul(2.9)).add(40));
    const c = noise(q.div(47).add(tex.w.mul(0.7)).add(90));
    const t = smoothstep(float(0.5).sub(tune.z), float(0.5).add(tune.z), a.mul(0.7).add(b.mul(0.3))).sub(0.5).toVar();
    return vec2(t, t.mul(tune.y).add(c.sub(0.5).mul(0.6)));
  };
  // The hand-painted road (game/roadpaint.js).
  const paintBox = uniform(U.uRoadPaintBox.value);
  const paintAmt = uniform(U.uRoadPaintAmt.value);
  const paintC = [0, 1, 2, 3].map((i) => uniform(U[`uRoadPaintC${i}`].value));
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

  function paving(display, world) {
    const out = display.toVar();
    const plaza = float(0).toVar();
    // Before the plaza multiplies it: the two holds below read the bare road.
    const lum = dot(display, LUMA).toVar();
    const grassy = smoothstep(0.015, 0.06, display.g.sub(display.r.max(display.b))).toVar();
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
        plaza.assign(box.mul(tint.w));
      });
    });
    // The asphalt's colour variation (setRoadTexture in util/geo.js).
    const hold = float(1).sub(grassy).mul(float(1).sub(smoothstep(0.42, 0.7, lum))).mul(float(1).sub(plaza)).toVar();
    // The painted road ignores the brightness hold (PAINT_FRAGMENT says why).
    const pHold = select(dot(paintAmt, vec4(1)).greaterThan(0), float(1).sub(grassy).mul(float(1).sub(plaza)), float(0)).toVar();
    const pMask = float(0).toVar();
    If(tex.x.add(tex.y).add(tex.z).greaterThan(0).or(pHold.greaterThan(0)).and(abs(world.y).lessThan(0.1)).and(hold.max(pHold).greaterThan(0)), () => {
      // The pixel street (setRoadPixels in util/geo.js): every layer read at its texel's centre.
      const pix = step(1e-4, pixel.x).toVar();
      const texel = pixel.x.max(1e-4);
      const wq = mix(world.xz, floor(world.xz.div(texel)).add(0.5).mul(texel), pix).toVar();
      const tp = wq.sub(vec2(0, select(wq.y.greaterThan(riverZ.x), riverZ.y, 0.0))).toVar();
      const tl = floor(tp.add(grid.xy).div(grid.z).add(0.5)).toVar();
      const td = abs(tp.add(grid.xy).sub(tl.mul(grid.z))).toVar();
      const aX = mod(floor(art.x.div(exp2(tl.y))), 2.0).toVar();
      const aZ = mod(floor(art.y.div(exp2(tl.x))), 2.0).toVar();
      const hX = mix(art.z, art.w, aX).toVar();
      const hZ = mix(art.z, art.w, aZ).toVar();
      const realX = step(-0.5, tl.y).mul(step(tl.y, texGrid.y.add(0.5))).toVar();
      const realZ = step(-0.5, tl.x).mul(step(tl.x, texGrid.x.add(0.5))).toVar();
      const inX = smoothstep(-0.12, 0.12, hX.sub(td.y)).mul(realX).toVar();
      const inZ = smoothstep(-0.12, 0.12, hZ.sub(td.x)).mul(realZ).toVar();
      const tn = noise(wq.div(11).add(tex.w)).toVar();
      const run = roadTone(wq).toVar();
      const tv = run.x.add(tune.w).mul(tex.x).add(tn.sub(0.35).mul(tex.y));
      const ratio = tv.add(1).mul(vec3(1, 0.1, -1).mul(run.y.mul(tex.x).mul(0.6)).add(1)).toVar();
      If(fine.x.add(fine.y).greaterThan(0), () => {
        const g1 = noise(wq.div(1.3).add(7)).toVar();
        const sp = hash(wq.mul(7.31).add(3)).toVar();
        const g2 = mix(noise(wq.div(0.45).add(31)), step(float(1).sub(detail.w), sp).sub(step(sp, detail.w)).mul(0.9).add(0.5), pix);
        const lx = float(1).sub(smoothstep(0.2, 0.9, abs(td.y.sub(hX.sub(texGrid.z))))).mul(inX)
          .mul(float(1).sub(smoothstep(1.0, 8.0, mix(9.0, td.x.sub(hZ), realZ))));
        const lz = float(1).sub(smoothstep(0.2, 0.9, abs(td.x.sub(hZ.sub(texGrid.z))))).mul(inZ)
          .mul(float(1).sub(smoothstep(1.0, 8.0, mix(9.0, td.y.sub(hX), realX))));
        const soft = roadStain(wq, lx.max(lz), g1).toVar();
        const stain = mix(soft, step(0.4, soft), pix).mul(inX.max(inZ)).mul(fine.x);
        ratio.mulAssign(g1.sub(0.5).mul(0.6).mul(float(1).sub(pix)).add(g2.sub(0.5).mul(0.4)).mul(fine.y).mul(2).add(1));
        ratio.mulAssign(float(1).sub(stain.mul(vec3(0.9, 1.0, 1.15))));
      });
      ratio.assign(mix(vec3(1), ratio, detail.y));  // the texture opacity (setRoadTextureOpacity)
      // The splat map, as in PAINT_FRAGMENT. An explicit level 0: a plain sample is a derivative,
      // and WGSL refuses one inside this branch (non-uniform control flow).
      If(dot(paintAmt, vec4(1)).greaterThan(0), () => {
        const puv = wq.sub(paintBox.xy).mul(paintBox.zw).toVar();
        const inside = step(0, puv.x).mul(step(0, puv.y)).mul(step(puv.x, 0.9999)).mul(step(puv.y, 0.9999));
        const pm = texture(U.tRoadPaint.value, puv.clamp(0, 1)).level(0).mul(paintAmt).mul(inside).toVar();
        pMask.assign(pm.r.max(pm.g).max(pm.b.max(pm.a)).clamp(0, 1));
        // Toward each channel's colour, as PAINT_FRAGMENT does.
        const alb = sRGBTransferOETF(diffuseColor.rgb).mul(ratio).toVar();
        const painted = mix(mix(mix(mix(alb, paintC[0], pm.r), paintC[1], pm.g), paintC[2], pm.b), paintC[3], pm.a);
        ratio.mulAssign(painted.div(alb.max(vec3(1e-3))));
      });
      If(pix.greaterThan(0.5), () => {
        const lv = ratio.r.add(ratio.g).add(ratio.b).div(3).toVar();
        ratio.mulAssign(floor(lv.div(pixel.y).add(0.5)).mul(pixel.y).div(lv.max(1e-3)));
      });
      out.mulAssign(mix(vec3(1), ratio, hold.max(pMask.mul(pHold))));
    });
    return out;
  }
  // The albedo view (uAlbedoView in util/geo.js), read by the caller before it paves.
  paving.albedo = uniform(0).onRenderUpdate(() => U.uAlbedoView.value);
  return paving;
}
