/**
 * The pixel-art screen's palette: brightness cut to `DITHER_LEVELS` steps with a 4×4 ordered (Bayer)
 * dither across the art pixels where a shade falls between two, and colour (the two chroma axes of
 * YCoCg) rounded to `CHROMA_STEPS` with no dither at all. On with the pixel look
 * (game/pixelart.js), `?dither=classic` for the smooth colours, `?ditherlevels=` for the brightness
 * steps.
 *
 * **Brightness only, because per-channel dither speckles.** The first cut stepped R, G and B each,
 * and a flat colour sits at a different fraction of a step in each channel, so the three round in
 * different directions on different pixels: the dark asphalt came out as a confetti of green,
 * purple and blue dots (6 steps a channel, 2026-11-24). Dithering the luma alone keeps every
 * pixel's hue and gives the monochrome checker the look is after. The chroma is rounded fine (16
 * steps cost the asphalt its green tint and greyed the lawns; 64 keeps them).
 *
 * **Not a fixed palette.** A curated 16- or 32-colour palette needs a nearest-colour search a
 * pixel and rewrites every hue in the game toward it; cutting brightness keeps the colour grade's
 * look and only takes away the in-between shades — the fog's ramp, the AO's soft crease, a lit
 * wall's falloff — which is where the dither shows. Done in display space, on the
 * finished frame, after the occlusion and the bloom, so their gradients are dithered too rather
 * than laid smooth over a dithered city.
 *
 * Runs at art resolution, inside the frame's last pass: on WebGPU the occlusion composite
 * (game/gpuframe.js), on WebGL the CRT's copy-and-triangle (game/crt.js), which runs for the dither
 * alone when the CRT is off. The pattern is fixed to the art pixels of the *screen*, and the camera
 * snap keeps the city fixed to them too, so a static wall's dither holds still while the camera pans.
 */
import { abs, clamp, dot, floor, float, min, mix, mod, screenCoordinate, vec3, vec4 } from 'three/tsl';

/**
 * Brightness steps. 12 puts a fine checker on the asphalt and the walls and a clear ramp in the
 * fog; 8 makes the checker loud across the whole road, 16 is close to no dither on a phone.
 */
export const DITHER_LEVELS = 12;

/**
 * How much of the stepped brightness is kept: the rest is the smooth shade blended back in, which
 * shrinks the checker's contrast without moving its pattern. 1 is the full step between the two
 * levels a pixel dithers across; 0.8 at Tyler's ask (2026-11-24, "a little too contrasted").
 */
export const DITHER_STRENGTH = 0.8;

/** Steps per unit of each chroma axis (YCoCg), rounded with no dither. */
export const CHROMA_STEPS = 64;

/**
 * The GLSL, for a fragment with `col` (display rgb) in scope, a `uDither` uniform (steps, 0 off)
 * and a `uDitherStrength` uniform (`DITHER_STRENGTH`).
 */
export const DITHER_GLSL = /* glsl */ `
  if (uDither > 1.5) {
    vec2 dp = floor(gl_FragCoord.xy);
    vec2 d1 = mod(dp, 2.0);
    vec2 d2 = mod(floor(dp * 0.5), 2.0);
    float dm = 4.0 * (2.0 * abs(d1.x - d1.y) + d1.y) + (2.0 * abs(d2.x - d2.y) + d2.y);
    float dl = uDither - 1.0;
    float dy = dot(col, vec3(0.25, 0.5, 0.25));
    vec2 dc = vec2((col.r - col.b) * 0.5, (2.0 * col.g - col.r - col.b) * 0.25);
    dy = mix(dy, floor(dy * dl + (dm + 0.5) / 16.0) / dl, uDitherStrength);
    dc = floor(dc * CHROMA_STEPS + 0.5) / CHROMA_STEPS;
    col = clamp(vec3(dy + dc.x - dc.y, dy + dc.y, dy - dc.x - dc.y), 0.0, 1.0);
  }
`.replace(/CHROMA_STEPS/g, CHROMA_STEPS.toFixed(1));

/** The same as nodes: `texel` premultiplied display rgba in, dithered out. `levels`, `strength` JS numbers. */
export function ditherNode(texel, levels, strength = DITHER_STRENGTH) {
  const p = floor(screenCoordinate.xy);
  const b2 = (q) => abs(q.x.sub(q.y)).mul(2).add(q.y);
  const m = b2(mod(p, 2)).mul(4).add(b2(mod(floor(p.mul(0.5)), 2)));
  const l = float(levels - 1);
  const c = texel.rgb;
  const smooth = dot(c, vec3(0.25, 0.5, 0.25)).toVar();
  const y = mix(smooth, floor(smooth.mul(l).add(m.add(0.5).div(16))).div(l), strength);
  const co = floor(c.r.sub(c.b).mul(0.5).mul(CHROMA_STEPS).add(0.5)).div(CHROMA_STEPS);
  const cg = floor(c.g.mul(2).sub(c.r).sub(c.b).mul(0.25).mul(CHROMA_STEPS).add(0.5)).div(CHROMA_STEPS);
  const rgb = clamp(vec3(y.add(co).sub(cg), y.add(cg), y.sub(co).sub(cg)), 0, 1);
  return vec4(min(rgb, vec3(texel.a)), texel.a);
}
