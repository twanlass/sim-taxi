/**
 * The car paint and the building glass under WebGPURenderer: `propMaterial({ gloss })`'s node twin.
 *
 * The reasoning for every term lives beside the GLSL it was ported from (GLOSS_* in util/geo.js);
 * this file is the same arithmetic at the node material's seams, and says only where the two
 * differ:
 *
 * - `setupDiffuseColor` is `<color_fragment>` plus `<normal_fragment_maps>`: the finish's numbers,
 *   the two bent normals, the flop, the flip colour and the flake under the fragment.
 * - the lighting model's `direct` is the swapped Phong specular line (GLOSS_SPECULAR_TO).
 * - its `finish` is `<envmap_fragment>`: the streaks, the march through the city's height field,
 *   the mirror mix and the window streaks.
 *
 * Only the default look (`real`) is here. Not ported: `?paint=<other look>` and the false-colour
 * finish view.
 *
 * **The rim line is not drawn here.** The GLSL steps each fragment across the AO prepass's depth
 * to find the body's silhouette, and there is no prepass: a fragment cannot read the depth buffer
 * it is being drawn into. So the paint only says where the line may go and how much sun is on it
 * (`rimShare`), and the frame's last pass, which has the finished depth, draws it
 * (game/gpuframe.js).
 *
 * Two things WGSL makes different. A derivative or an implicit-lod texture read may not sit in a
 * branch, so the `if (gIsPaint > 0.5)` blocks are multiplies by a mask and the march reads the
 * height field at level 0. And `smoothstep` with its edges reversed is undefined there (the GLSL
 * leans on it throughout), so `sstep` spells the polynomial out.
 */
import { DataTexture, InstancedInterleavedBuffer, DynamicDrawUsage, RedFormat, UnsignedByteType } from 'three';
import {
  abs, attribute, Break, buffer, cameraPosition, cameraWorldMatrix, clamp, cross, dFdx, dFdy,
  diffuseColor, dot, float, floor, fract, fwidth, If, instancedBufferAttribute,
  instancedDynamicBufferAttribute, instanceIndex, length, Loop, mat4, max, min, mix,
  modelViewMatrix, normalize, normalView, positionGeometry, positionViewDirection, positionWorld,
  pow, property, reflect, select, step, texture, transformDirection, uniform, uniformArray, varying,
  varyingProperty, vec2, vec3, vec4,
} from 'three/tsl';
import { PropPhongNodeMaterial, rimShare, rimSunLuma } from './gpumaterial.js';

// Bound by util/geo.js, which owns GLOSS_UNIFORMS and the window constants and imports this file.
let U = null;
let K = null;
export function bindPaint(uniforms, constants) {
  U = uniforms;
  K = constants;
}

const LUMA = vec3(0.2126, 0.7152, 0.0722);
// The direct light that reached this fragment, summed over the lights as they are added.
const rimLit = property('float', 'rimLit');
const BLANK = new DataTexture(new Uint8Array([0]), 1, 1, RedFormat, UnsignedByteType);
BLANK.needsUpdate = true;

let nodes = null;
function shared() {
  if (nodes) return nodes;
  const city = texture(BLANK);
  nodes = {
    city,
    // `setGlossCity` swaps the texture object, so the node is re-pointed as this is read.
    cityOn: uniform(0).onRenderUpdate(() => {
      city.value = U.tGlossCity.value ?? BLANK;
      return U.uGlossCityOn.value;
    }),
    cityBox: uniform(U.uGlossCityBox.value),
    ceiling: uniform(1).onRenderUpdate(() => U.uGlossCeiling.value),
    top: uniform(U.uGlossTop.value),
    horizon: uniform(U.uGlossHorizon.value),
    global: uniform(U.uGlossGlobal.value),
    flip: uniform(U.uFlip.value),
    streak: uniform(U.uStreak.value),
  };
  return nodes;
}

const sstep = (a, b, x) => {
  const t = clamp(x.sub(a).div(float(b).sub(a)), 0, 1).toVar();
  return t.mul(t).mul(float(3).sub(t.mul(2)));
};

// Dave Hoskins' hash33 (see GLOSS_PAINT_DECLS).
const hash3 = (p) => {
  const a = fract(p.mul(vec3(0.1031, 0.1030, 0.0973))).toVar();
  a.addAssign(dot(a, a.yxz.add(33.33)));
  return fract(a.xxy.add(a.yxx).mul(a.zyx));
};

// The instance's matrix, built the way three's own InstanceNode builds it. That node keeps its
// matrix to itself and has already applied it by the time anything here runs, and the bulge needs
// the matrix on a second vector.
function instanceMatrixNode({ instanceMatrix }) {
  if (instanceMatrix.count <= 1000) {
    return buffer(instanceMatrix.array, 'mat4', Math.max(instanceMatrix.count, 1)).element(instanceIndex);
  }
  const data = new InstancedInterleavedBuffer(instanceMatrix.array, 16, 1);
  const at = instanceMatrix.usage === DynamicDrawUsage ? instancedDynamicBufferAttribute : instancedBufferAttribute;
  return mat4(at(data, 'vec4', 16, 0), at(data, 'vec4', 16, 4), at(data, 'vec4', 16, 8), at(data, 'vec4', 16, 12));
}

const paintLighting = (Base, p) => class PaintLighting extends Base {
  constructor() {
    super(false); // Phong's own specular line is the one the paint replaces
  }

  direct(input, builder) {
    super.direct(input, builder);
    const { lightDirection, lightColor, reflectedLight } = input;
    const h = normalize(lightDirection.add(positionViewDirection)).toVar();
    // BRDF_BlinnPhong at a specular colour of 1: Schlick is 1, the implicit G is a quarter.
    // The floor under the base is for the finishes whose sharpness is 0 (a window's): 0 to the
    // power 0 is NaN in WGSL, and a NaN times that finish's zero strength is still NaN, which
    // drew every pane black.
    const lobe = (n, sharp) => sharp.mul(0.5).add(1).mul(0.25 / Math.PI)
      .mul(pow(clamp(dot(n, h), 1e-6, 1), sharp));
    const glint = clamp(dot(p.specN, lightDirection), 0, 1).mul(lightColor)
      .mul(p.finA.x).mul(lobe(p.specN, p.finA.y));
    const sheenIrr = clamp(dot(p.reflN, lightDirection), 0, 1).mul(lightColor).mul(p.tint);
    const flake = mix(lobe(p.reflN, p.finD.w).mul(0.17), lobe(p.flakeN, p.finC.w).mul(p.flakeDisc), p.flakeVis);
    reflectedLight.directSpecular.addAssign(glint.add(
      sheenIrr.mul(p.finA.w.mul(lobe(p.reflN, p.finB.x)).add(p.finB.y.mul(flake)))));
    // RIM_LIGHT's `directLight.color`: the light on this fragment, shadow folded in.
    if (K.rimOn()) rimLit.addAssign(dot(lightColor, LUMA));
  }

  finish(input, builder) {
    super.finish(input, builder);
    const { outgoingLight, reflectedLight } = input.context;
    const S = shared();
    // Paint on a body up to a truck's size (the ships wear this paint too), and its share of sun.
    if (K.rimOn()) {
      rimShare.assign(p.isPaint.mul(step(0.5, p.carSized))
        .mul(clamp(rimLit.div(rimSunLuma), 0, 1).mul(0.5).add(0.5)));
    }
    const { obj, world } = p;

    const r0 = reflect(transformDirection(vec3(0, 0, 1), cameraWorldMatrix).negate(),
      transformDirection(p.reflN, cameraWorldMatrix));
    const R = normalize(vec3(r0.x, max(abs(r0.y), 0.12), r0.z)).toVar();
    const env = mix(S.horizon, S.top, pow(R.y, 0.6)).toVar();
    const graze = float(1).sub(clamp(p.reflN.z, 0, 1)).toVar();
    const mirror = p.finB.z.add(p.finB.w.mul(graze).mul(graze).mul(graze))
      .add(p.finD.x.mul(pow(min(graze, 0.88), 5).mul(0.96).add(0.04)))
      .mul(mix(p.mirror, p.amount, p.isPaint)).toVar();

    // STREAKS, on paint only and only on a body up to a truck's size.
    const on = S.streak.x.mul(p.carSized).mul(p.isPaint);
    const sP = obj.sub(p.centre).mul(p.invHalf);
    const sN = abs(normalize(cross(dFdx(obj), dFdy(obj)))).toVar();
    const top = sN.y.greaterThan(0.7);
    const side = select(top, 0.0, 1.0).toVar();
    const sUV = select(top, sP.xz, select(sN.z.greaterThan(sN.x), sP.xy, sP.zy)).toVar();
    const s = sUV.x.add(sUV.y.mul(0.7)).add(side.mul(0.6).mul(normalView.x)).toVar();
    const sW = fwidth(s).add(1e-4).toVar();
    const band = sstep(sW.add(0.16), sW.negate().add(0.16), abs(s.add(0.35)))
      .add(sstep(sW.add(0.05), sW.negate().add(0.05), abs(s.sub(0.2))).mul(0.8));
    const sH = sUV.y.add(0.45).toVar();
    const sHW = fwidth(sH).add(1e-4).toVar();
    const sky = side.mul(sstep(sHW.negate(), sHW, sH)).toVar();
    const line = side.mul(sstep(sHW.add(0.06), 0, abs(sH.sub(0.03))));
    const sCol = S.top.add(dot(S.top, LUMA).mul(0.8));
    outgoingLight.mulAssign(float(1).sub(on.mul(0.18).mul(side).mul(float(1).sub(sky))));
    outgoingLight.assign(mix(outgoingLight, sCol,
      clamp(on.mul(band.mul(0.45).add(sky.mul(0.06)).add(line.mul(0.4))), 0, 1)));

    // The march up the reflected ray through the city's roof heights (GLOSS_HIT_SOFT).
    If(S.cityOn.greaterThan(0.5).and(mirror.greaterThan(0)), () => {
      const t = float(0.6).toVar();
      const occ = float(0).toVar();
      const hitY = float(0).toVar();
      Loop(14, () => {
        const q = world.add(R.mul(t)).toVar();
        If(q.y.greaterThan(S.ceiling), () => { Break(); });
        const uv = vec2(q.z.sub(S.cityBox.y).mul(S.cityBox.w), q.x.sub(S.cityBox.x).mul(S.cityBox.z));
        const o = clamp(S.city.sample(uv).level(0).r.mul(S.ceiling).sub(q.y)
          .div(t.mul(0.12).add(0.4)), 0, 1).toVar();
        If(o.greaterThan(occ), () => { occ.assign(o); hitY.assign(q.y); });
        If(occ.greaterThanEqual(1), () => { Break(); });
        t.mulAssign(1.3);
      });
      env.assign(mix(env, S.horizon.mul(S.global.y).mul(hitY.div(S.ceiling).mul(0.6).add(0.7)), occ));
    });
    env.assign(mix(env, vec3(dot(env, LUMA)), p.isChrome.mul(0.8)));
    outgoingLight.assign(mix(outgoingLight, env, clamp(mirror, 0, 1)));

    // WINDOW_STREAKS. `this.fill` is the fill light after the shadow tint (PropLightingModel).
    const wN = normalize(cross(dFdx(obj), dFdy(obj)));
    const wT = normalize(vec2(wN.z.negate(), wN.x).add(1e-5));
    const wD = dot(world.xz.sub(cameraPosition.xz.mul(K.WINDOW_PAN)), wT).add(world.y)
      .div(K.WINDOW_STREAK_PITCH).toVar();
    const wF = fract(wD);
    const wB = fwidth(wD).add(1e-4 + K.WINDOW_STREAK_BLUR).toVar();
    const wBand = sstep(wB.add(0.12), wB.negate().add(0.12), abs(wF.sub(0.4)))
      .add(sstep(wB.mul(0.5).add(0.03), max(wB.mul(-0.5).add(0.03), 0), abs(wF.sub(0.6))).mul(0.8));
    const wIrr = this.sunlit.add(this.fill).div(max(diffuseColor.rgb, vec3(1e-3))).toVar();
    outgoingLight.addAssign(p.isWindow.mul(p.mirror).mul(
      vec3(0.55, 0.72, 0.95).mul(dot(wIrr, LUMA)).mul(K.WINDOW_SHEEN)
        .add(vec3(0.9, 0.95, 1.0).mul(wIrr).mul(clamp(wBand, 0, 1)).mul(K.WINDOW_STREAK_GAIN))));
  }
};

/**
 * `gloss` is `glossShape()`'s answer (util/geo.js): where the bent normals' curve is centred and
 * this material's share of the reflection.
 *
 * Measured, not assumed: every material still compiles a pipeline of its own. three numbers a
 * build's uniforms as it goes, so two paint materials' WGSL differs by those names even when the
 * arithmetic is identical (five paint fragment shaders at the parked shot, 1,880 lines each).
 */
export class PaintNodeMaterial extends PropPhongNodeMaterial {
  static get type() { return 'PaintNodeMaterial'; }

  constructor(params, gloss) {
    super(params);
    this.gloss = gloss;
  }

  setupDiffuseColor(builder) {
    const { object, geometry } = builder;
    const S = shared();
    const g = this.gloss;
    // Read from the material being drawn, not captured: three hands one build of the nodes to
    // every material with the same cache key (see `customProgramCacheKey` in gpumaterial.js), and
    // a captured number would be the first material's for all of them.
    const own = (start, read) => uniform(start).onObjectUpdate(({ material }) => read(material.gloss));
    const centre = own(g.centre, (o) => o.centre);
    const invHalf = own(g.invHalf, (o) => o.invHalf);

    // The instance tint is kept off metal (GLOSS_COLOR_VERTEX), so three is shown an object with
    // no instance colour and the tint is multiplied in below, finish in hand.
    const tinted = Boolean(object.instanceColor);
    super.setupDiffuseColor(tinted
      ? { object: Object.create(object, { instanceColor: { value: null } }), geometry }
      : builder);

    // A geometry with no `aFinish` is tyre: WebGL reads a missing attribute as 0, WebGPU refuses it.
    const finish = geometry.hasAttribute('aFinish') ? varying(attribute('aFinish', 'float')) : float(0);
    const k = clamp(finish.add(0.5), 0, 7.4).toInt().toVar();
    // The finish tables are array nodes made here, per build, not shared the way the plain
    // uniforms above are. One array node shared by every paint material reached only some of the
    // meshes drawing with it: the punched windows read a `diffuse` of 0 out of a table whose every
    // row is above 0.1, and drew black.
    const row = (table) => uniformArray(table.value).element(k).toVar();
    const finA = row(U.uFinishA);
    const finB = row(U.uFinishB);
    const finC = row(U.uFinishC);
    const finD = row(U.uFinishD);
    const is = (n) => select(k.equal(n), 1.0, 0.0).toVar();
    if (tinted) {
      diffuseColor.rgb.mulAssign(select(k.equal(3), vec3(1), varyingProperty('vec3', 'vInstanceColor')));
    }
    diffuseColor.rgb.mulAssign(finC.y);

    // GLOSS_VERTEX: the body's own space, and the bulge carried to view space.
    const obj = varying(positionGeometry);
    const local = positionGeometry.sub(centre).mul(invHalf);
    const placed = object.isInstancedMesh
      ? instanceMatrixNode(object).mul(vec4(local, 0)).xyz : local;
    const bulge = varying(modelViewMatrix.mul(vec4(placed, 0)).xyz);

    // GLOSS_BEND, then GLOSS_NORMAL.
    const n = normalView;
    const gb = bulge.sub(n.mul(dot(bulge, n))).toVar();
    const specN = normalize(n.add(gb.mul(finA.z))).toVar();
    const reflN = normalize(n.add(gb.mul(finC.x))).toVar();
    const away = float(1).sub(clamp(reflN.z, 0, 1)).toVar();
    const isPaint = is(1);
    // Through a variable of its own. Written as one assignment that reads `diffuseColor` on its
    // right-hand side, the flip came out as black on some meshes (the punched windows) and not
    // others; the snapshot pins what is read to what was there before the write.
    const flopped = diffuseColor.rgb.mul(float(1).sub(finD.z.mul(away).mul(away))).toVar();
    diffuseColor.rgb.assign(mix(flopped, flopped.mul(flopped).mul(0.85),
      isPaint.mul(S.flip.x).mul(pow(away, S.flip.y))));
    const peak = max(max(diffuseColor.r, diffuseColor.g), max(diffuseColor.b, 1e-3));
    const tint = mix(vec3(1), diffuseColor.rgb.div(peak), finD.y).toVar();

    const cell = obj.mul(S.global.x).add(0.37).toVar();
    const id = floor(cell).toVar();
    const rnd = hash3(id).toVar();
    const foot = max(length(dFdx(cell)), length(dFdy(cell))).toVar();
    const rad = rnd.z.mul(0.2).add(0.22);
    const flakeVis = float(1).sub(sstep(0.4, 0.85, foot)).toVar();
    const flakeDisc = float(1).sub(sstep(rad.sub(foot).sub(1e-4), rad.add(foot),
      length(fract(cell).sub(rnd.mul(0.5).add(0.25))))).toVar();
    const t = normalize(cross(n, select(abs(n.y).lessThan(0.9), vec3(0, 1, 0), vec3(1, 0, 0)))).toVar();
    const lean = hash3(id.add(17.17)).xy.mul(2).sub(1).mul(finC.z).toVar();
    const flakeN = normalize(reflN.add(t.mul(lean.x)).add(cross(n, t).mul(lean.y))).toVar();

    this.paintNodes = {
      finA, finB, finC, finD, isPaint, isWindow: is(6), isChrome: is(7),
      specN, reflN, tint, flakeVis, flakeDisc, flakeN, obj, world: positionWorld, centre, invHalf,
      amount: own(g.amount, (o) => o.amount), mirror: own(g.mirror, (o) => o.mirror),
      // gCarSized, which is a fact about the material and needs no fragment.
      carSized: own(1, (o) => {
        const t = Math.min(Math.max(1 / Math.min(o.invHalf.x, o.invHalf.z) - 3, 0), 1);
        return 1 - t * t * (3 - 2 * t);
      }),
    };
  }

  setupLightingModel(builder) {
    const Base = super.setupLightingModel(builder).constructor;
    return new (paintLighting(Base, this.paintNodes))();
  }

  copy(source) {
    super.copy(source);
    this.gloss = source.gloss;
    return this;
  }
}
