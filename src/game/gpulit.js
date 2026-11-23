/**
 * The city's switched lights for the WebGPU renderer: `litSwitch` and the lamp pools of
 * game/citylights.js as nodes. When a light comes on, and why it is read at the light's own anchor
 * rather than at the vertex, is written there.
 */
import {
  attribute, clamp, float, floor, length, materialColor, max, modelWorldMatrix, pow, smoothstep, step, uniform,
  uv, varying, vec2, vec4,
} from 'three/tsl';
import { unlitTwin } from '../util/gpunodes.js';
import { cellShade, cloudHash } from '../util/gpuclouds.js';

/**
 * `litOn` at this vertex's anchor, as a varying. `U` is the bag `litUniforms()` answers; `tune`
 * the three constants the GLSL bakes in.
 */
export function createLitOn(U, { ramp, flickerShare, flickerSpan }) {
  const scalar = (slot) => uniform(slot.value).onRenderUpdate(() => slot.value);
  const level = scalar(U.uLitLevel);
  const time = scalar(U.uLitTime);
  const cell = uniform(U.uCell.value);
  const cellEdge = scalar(U.uCellEdge);
  const cellTime = scalar(U.uCellTime);
  const cellShape = uniform(U.uCellShape.value);
  const cellLight = uniform(U.uCellLight.value);

  return () => {
    const at = attribute('aLitAt', 'float');
    const anchor = attribute('aLitXZ', 'vec2');
    const xz = modelWorldMatrix.mul(vec4(anchor.x, 0.0, anchor.y, 1.0)).xz.toVar();
    const shade = cellShade(xz, cell, cellEdge, cellTime, cellShape, cellLight.w);
    // Every `toVar()` here is load-bearing, and so is there being no `select` below. three writes
    // a `select` as an if/else, and a temporary shared by both arms (the noise inside `cellShade`
    // has three) is assigned in the first arm only: the other arm reads it unset. Written as
    // `select(seed < share, on * flicker, on)` this lit the quarter of the city that flickers and
    // left the rest dark, at zero, with nothing logged. So: the level into a variable before
    // anything branches, and the flicker as a multiply that is 1 for a light that has none.
    const here = max(level, clamp(shade.sub(cellLight.x).div(cellLight.y), 0.0, 1.0)).toVar();
    const seed = cloudHash(xz.mul(0.731).add(at.mul(13.7))).toVar();
    const on = smoothstep(at, at.add(ramp), here);
    const w = clamp(here.sub(at).div(flickerSpan), 0.0, 1.0);
    const n = cloudHash(vec2(floor(time.mul(13.0).add(seed.mul(40.0))), seed.mul(97.0)));
    const flicker = max(step(float(0.7).mul(float(1).sub(w)), n), step(flickerShare, seed));
    return varying(on.mul(flicker));
  };
}

/** `litSwitch` on a built-in unlit material: scaled by the light's level, gone while it is off. */
export function litSwitchNodes(material, litOn) {
  const on = litOn();
  material.colorNode = materialColor.mul(on);
  material.maskNode = on.greaterThan(0.0);
  material.userData.ported = true;
  return material;
}

/** The lamp pools' twin: an additive disc that wrote its own numbers, so a `display` material. */
export function poolTwin(glsl, litOn) {
  return unlitTwin(glsl, (u) => {
    const d = length(uv().sub(0.5)).mul(2.0);
    const a = pow(max(float(1).sub(d), 0.0), 2.2).mul(litOn());
    return { color: u.uColor.mul(a).mul(u.uStrength) };
  }, { display: true });
}
