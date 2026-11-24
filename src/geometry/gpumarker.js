/**
 * The fare marker's two shader patches for the WebGPU renderer: the vessel's fill
 * (geometry/diamond.js `patchFill`) and the ground disc's sweeping beam (geometry/targetring.js
 * `createSweepFor`). What each draws and why is beside the GLSL; this is the same arithmetic.
 *
 * Set on the built-in materials themselves, as `instanceAlpha` is (util/gpunodes.js): three copies
 * a material's node properties across when it converts it, and they are part of the cache key.
 * So **the nodes are made once and every marker is handed the same ones.** Markers are pooled; a
 * set of nodes per marker would be a shader per marker, compiled as each one first appears, which
 * is the stall CLAUDE.md records under "unique per material". What differs between two markers is
 * read off the mesh being drawn, from the bag its material carries in `userData`.
 */
import * as THREE from 'three';
import {
  Fn, abs, atan, attribute, cos, dot, float, materialColor, materialEmissive, materialOpacity,
  max, mix, mod, normalFlat, positionGeometry, positionViewDirection, sin, smoothstep, step,
  uniform, varying, vec2, vec3, vec4,
} from 'three/tsl';

const TWO_PI = Math.PI * 2;
/** A slot of the bag on the material of the mesh being drawn. */
const slot = (bag, name, first) => uniform(first)
  .onObjectUpdate(({ object }) => object.material.userData[bag][name].value);

// --- The fill -------------------------------------------------------------------------------

const fills = new Map();

function fillNodes(K, flipped) {
  const uFill = slot('fill', 'uFill', 0);
  const uFillLow = slot('fill', 'uFillLow', 0);
  const uGlass = slot('fill', 'uGlass', new THREE.Color());
  const uSurface = slot('fill', 'uSurface', new THREE.Color());
  const uFrame = uniform(new THREE.Color(K.frame));

  const pie = K.shape === 'pie';
  const classic = K.shape === 'plumbob';
  const fillXY = pie ? varying(attribute('fillXY', 'vec2')) : varying(positionGeometry.xy);
  const fillY = classic || pie ? fillXY.y : varying(attribute('fillY', 'float'));
  const wall = pie ? varying(attribute('pieWall', 'float')) : float(-1);

  // Every term both the colour and the light need, from one place.
  const parts = () => {
    const plate = K.shape === 'hourglass' ? step(K.glassH - 1e-3, abs(fillY)) : float(0);
    if (pie) {
      const angle = atan(fillXY.x, fillXY.y);
      const round = angle.add(float(1).sub(step(0, angle)).mul(TWO_PI));   // `if (a < 0) a += 2pi`
      const below = step(uFill, round);
      const ray = vec2(sin(uFill), cos(uFill));
      const across = abs(fillXY.x.mul(ray.y).sub(fillXY.y.mul(ray.x)));
      const meniscus = uFillLow.mul(step(0, dot(fillXY, ray)))
        .mul(float(1).sub(smoothstep(K.pieSweep * K.meniscusCore, K.pieSweep, across)));
      return { plate, below, meniscus };
    }
    const level = classic ? uFill : mix(uFill, uFillLow, step(fillY, 0));
    const below = max(step(fillY, level), plate);
    const meniscus = float(1).sub(plate)
      .mul(float(1).sub(smoothstep(K.meniscus * K.meniscusCore, K.meniscus, abs(fillY.sub(level)))));
    return { plate, below, meniscus };
  };

  const color = Fn(() => {
    const { plate, below, meniscus } = parts();
    const solid = max(below, meniscus);
    // `abs`, so the flipped pass needs nothing here: the sheen is the same on either side.
    const sheen = float(1).sub(below)
      .mul(float(1).sub(abs(dot(normalFlat, positionViewDirection))).pow(K.sheenPower));
    let rgb = mix(uGlass, materialColor, below);
    let alpha = max(mix(K.glassAlpha, 1, solid), sheen);
    rgb = mix(rgb, uSurface, sheen.mul(K.sheen));
    rgb = mix(rgb, uSurface, meniscus);
    rgb = mix(rgb, uFrame, plate);
    let out = vec4(rgb, alpha);
    // The pie's eaten slices are a flat black tint, not glass of the hue.
    if (pie) out = mix(vec4(0, 0, 0, K.pieEatenAlpha), out, below);
    return out;
  })();

  const emissive = Fn(() => {
    const { plate, below, meniscus } = parts();
    let light = materialEmissive.mul(mix(K.glassEmissive, 1, max(below, meniscus)));
    light = mix(light, vec3(uFrame).mul(K.frameEmissive), plate);
    return pie ? light.mul(below) : light;
  })();

  // A wall draws only on the cut: its own slice left, the one across from it eaten.
  const mask = pie
    ? Fn(() => {
      const { below } = parts();
      const cut = below.lessThan(0.5).or(step(uFill, wall).greaterThan(0.5));
      return wall.greaterThanEqual(0).and(cut).not();
    })()
    : null;

  return { color, emissive, mask, normal: flipped ? normalFlat.negate() : null };
}

/**
 * `uniforms` is the bag `patchFill` returns and its caller moves. `K`: the shape and the constants
 * the GLSL inlines.
 */
export function fillNodesOn(material, uniforms, K, flipped = false) {
  const key = `${K.shape}${flipped ? '-back' : ''}`;
  if (!fills.has(key)) fills.set(key, fillNodes(K, flipped));
  const nodes = fills.get(key);
  material.userData.fill = uniforms;
  material.colorNode = nodes.color;
  // The GLSL writes the alpha outright; three would multiply the colour's by the material's.
  material.opacityNode = float(1);
  material.emissiveNode = nodes.emissive;
  if (nodes.mask) material.maskNode = nodes.mask;
  if (nodes.normal) material.normalNode = nodes.normal;
  material.userData.ported = true;
}

// --- The sweep ------------------------------------------------------------------------------

let sweep = null;

/** `bag`: `{ uHead, uTail }`, which `update(elapsed)` moves. */
export function sweepNodesOn(material, bag) {
  if (!sweep) {
    const behind = mod(slot('sweep', 'uHead', 0).sub(varying(attribute('aAngle', 'float'))), TWO_PI);
    const glow = float(1).sub(smoothstep(0, slot('sweep', 'uTail', 1), behind)).pow(1.6);
    sweep = materialOpacity.mul(glow);
  }
  material.userData.sweep = bag;
  material.opacityNode = sweep;
  material.userData.ported = true;
}
