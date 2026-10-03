import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { AO_UNIFORMS, CLOUD_UNIFORMS, CLOUD_GLSL } from '../util/geo.js';
import { WET_EXTENT } from './squall.js';

/**
 * Rain Mode — `?rain`. An exploration, off by default: the city on a wet afternoon.
 *
 * Five layers, cheapest-looking first:
 *
 * 1. **The grade** (`grade`). Overcast light laid over whatever hour the day clock is at — hooked
 *    into `daylight.apply` before anything reads the keyframe, so the haze and the clouds follow it
 *    for free.
 * 2. **Wet ground** (`wetGround`). The ground mesh's own material, patched: up-facing surfaces go
 *    darker, the road goes darker still, and a noise field lays puddles on the asphalt. Then every
 *    wet fragment mixes in a *reflection* of the city.
 * 3. **The reflection** (`renderReflection`). The whole scene drawn a second time, at half
 *    resolution, through a mirror of the main camera about y = 0. Under an orthographic camera that
 *    is exact: the reflection of a point is where its mirror image lands through the *same*
 *    projection, so the ground reads it back at its own `gl_FragCoord` — no reflector plane, no
 *    oblique clip. Two details make it work:
 *      - a mirror flips handedness, which turns every front face into a back face. A second flip
 *        in screen x (`FLIP_X` on the projection) turns them back, and the ground samples at
 *        `1 - u` to undo it;
 *      - the ground itself sits *on* the mirror plane and would cover everything, so the pass
 *        clips at `CLIP_Y` with a global clipping plane. The road (y 0) and its paint (0.02) go;
 *        the pavement (0.36) stays and reflects as its own kerb.
 *    The ground blurs it along screen y — the way lights smear on real wet asphalt — and wobbles
 *    it with ripples; a puddle is the same read with the blur taken out.
 * 4. **Rain and splashes**. Instanced streaks and point-sprite crowns, both animated entirely in
 *    the vertex shader off one clock and a box that wraps around the camera's target, so the CPU
 *    does nothing per drop and a pan never runs out of weather.
 * 5. **The lens** (`renderLens`). Drops on the glass: the finished frame copied to a texture and
 *    drawn back through a handful of small inverted lenses. Not a composer — a copy and one
 *    fullscreen triangle — so the main render keeps its MSAA and its stencil.
 *
 * Plus `GRIP`, which `main.js` hands to the traffic model: everything brakes softer in the wet.
 */

/** Everything below this is left out of the mirror pass — the road and its paint. */
const CLIP_Y = 0.03;

/** The mirror target, as a fraction of the drawing buffer. The blur hides the rest. */
const REFLECT_SCALE = 0.5;

/** What braking is worth on a wet road, as a fraction of dry. Traffic plans its stops off the
 *  same number it brakes with, so this lengthens every stop rather than making anyone run a red. */
export const GRIP = 0.6;


/** The streaks: how many, and the box they wrap in around the camera target. */
const DROPS = 14000;
const BOX = new THREE.Vector3(220, 60, 220);
const FALL = new THREE.Vector3(3.5, -34, 2);   // u/s, with a little wind
const STREAK_LEN = 1.9;
const STREAK_W = 0.07;
const STREAK_OPACITY = 0.32;

/** The crowns thrown up where drops land. */
const SPLASHES = 2600;
const SPLASH_BOX = 180;
const SPLASH_Y = 0.38;      // just over the pavement, so it is not buried by the kerb blocks

/** How often each splash slot fires, per second, and what fraction of a cycle it is visible. */
const SPLASH_RATE = 1.4;
const SPLASH_LIFE = 0.16;

/**
 * What the storm looks like at its peak — two moods, picked by the flag (`?storm=night`,
 * `?rain=night`; the shower is the default).
 *
 * - **shower**: a sun shower. The sky goes grey but stays daylight; the sun keeps its strength and
 *   its warmth, and the *clouds* do the dimming — a drifting field (`cover`, see CLOUD_UNIFORMS in
 *   util/geo.js) that leaves most of the city in cloud shade and lets the sun through in patches,
 *   with shafts of light standing in the rain over each gap. The city's lights still come on.
 * - **night**: the first storm this mode had — most of the way to night, the sun all but gone, the
 *   lamps doing the work. Too dark to play in as the default.
 *
 * `sky` scales the sky's colours and `skyMix` is how far they are pulled to the rain palette;
 * `sunMix` how far the sun's colour goes grey; `sun` and `fill` multiply the two lights; `cover` is
 * the cloud cover at the peak; `haze` the haze; `reflectSky` what a puddle shows where nothing
 * stands over it; `shafts` the sun shafts' strength; `glint` how hard wet ground shines where the
 * sun is on it.
 */
export const MOODS = {
  shower: {
    sky: 1.0, skyMix: 0.5, sunMix: 0.15, sun: 1.15, fill: 1.05, cover: 0.46, haze: 0.26,
    reflectSky: PALETTE.rainReflectShower, shafts: 1, glint: 0.9,
  },
  night: {
    sky: 0.6, skyMix: 0.85, sunMix: 0.7, sun: 0.15, fill: 0.72, cover: 1.05, haze: 0.34,
    reflectSky: PALETTE.rainReflectSky, shafts: 0, glint: 0,
  },
};

/** Shafts of sun standing in the rain over the gaps in the cloud. */
const SHAFTS = 40;
const SHAFT_BOX = 170;
const SHAFT_LEN = 85;
const SHAFT_STRENGTH = 0.34;

const Y_MIRROR = new THREE.Matrix4().makeScale(1, -1, 1);
const FLIP_X = new THREE.Matrix4().makeScale(-1, 1, 1);

/** Replace one chunk, loudly: a patch that silently misses is a feature that silently vanishes. */
function inject(source, chunk, replacement, where) {
  if (!source.includes(chunk)) throw new Error(`rain: no ${chunk} in the ${where} shader`);
  return source.replace(chunk, replacement);
}

const inert = {
  enabled: false,
  grade: null,
  wetGround: (mesh) => mesh,
  renderReflection: () => {},
  renderLens: () => {},
  setWeather: () => {},
  setSunDir: () => {},
  attachSquall: () => {},
  update: () => {},
  addTo: () => {},
  hideInMirror: () => {},
};

export function createRain(renderer, { enabled = false, mood: moodName = 'shower' } = {}) {
  if (!enabled) return inert;
  const mood = MOODS[moodName] ?? MOODS.shower;

  const clock = { t: 0 };
  const drawingBuffer = new THREE.Vector2();

  // --- the mirror -------------------------------------------------------------------------------

  // Half float where the GPU can render to it: the mirror holds *linear* colour (three switches the
  // sRGB encode off for any render target), and eight linear bits band badly in the darks.
  const halfFloat = renderer.extensions.has('EXT_color_buffer_half_float')
    || renderer.extensions.has('EXT_color_buffer_float');
  const reflectTarget = new THREE.WebGLRenderTarget(2, 2, {
    type: halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
    stencilBuffer: true,
    depthBuffer: true,
  });
  const mirrorCam = new THREE.OrthographicCamera();
  mirrorCam.matrixAutoUpdate = false;
  mirrorCam.matrixWorldAutoUpdate = false;
  const clipPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -CLIP_Y)];
  // Blank AO for the mirror pass: the real AO buffer is a screen-space map of the *main* view,
  // and sampling it at mirrored fragments stamps the city's creases onto its own reflection.
  const noAO = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  noAO.needsUpdate = true;
  // And the ground still draws in the mirror pass (its pavement survives the clip), so it must not
  // be sampling the target it is being drawn into — that is a feedback loop, and the draw fails.
  const whiteTexel = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  whiteTexel.needsUpdate = true;
  const noReflect = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  noReflect.needsUpdate = true;
  // What the mirror shows where nothing stands: the cloud overhead, but dark. The first cut cleared
  // to the horizon grey and drew the sky dome into the mirror too, and every wet street came out a
  // pale wash with its paint gone — an overcast sky is the brightest thing in the scene, and a
  // puddle is a mirror of it.
  const skyTint = new THREE.Color(mood.reflectSky);
  const hidden = [];

  const groundUniforms = {
    tRainReflect: { value: reflectTarget.texture },
    // Where the ground is wet, as a map over the island — the squall's trail (game/squall.js). A
    // single white texel otherwise, so every other mode reads "wet everywhere" through the same
    // lookup and `uRainWet` stays the one level.
    tWetMap: { value: whiteTexel },
    uWetExtent: { value: WET_EXTENT },
    uRainScreen: { value: new THREE.Vector2(1, 1) },
    uRainTime: { value: 0 },
    uRainWet: { value: 1 },
    uRainSheen: { value: new THREE.Color(PALETTE.rainSheen) },
    // Wet ground in a patch of sun, in the shower: the asphalt the light has found. Not a specular
    // highlight — the sun is behind this camera, so a true one could never face it — but the warm
    // lift a sunlit wet street reads as.
    uRainGlint: { value: mood.glint },
    uRainGlintColor: { value: new THREE.Color(PALETTE.sunShaft) },
  };

  // The mirror is a second full render of the city, so it is skipped outright while the streets
  // are dry — except once, on the first frame, so the clipped variant of every lit program is
  // compiled up front and not in the middle of the run when the first cloud comes over.
  let mirrorWarm = false;

  const viewInv = new THREE.Matrix4();

  function renderReflection(scene, camera) {
    if (weather.wet < 0.002 && mirrorWarm) return;
    mirrorWarm = true;
    renderer.getDrawingBufferSize(drawingBuffer);
    const w = Math.max(2, Math.round(drawingBuffer.x * REFLECT_SCALE));
    const h = Math.max(2, Math.round(drawingBuffer.y * REFLECT_SCALE));
    if (reflectTarget.width !== w || reflectTarget.height !== h) reflectTarget.setSize(w, h);
    groundUniforms.uRainScreen.value.set(1 / drawingBuffer.x, 1 / drawingBuffer.y);

    camera.updateMatrixWorld();
    mirrorCam.matrixWorld.multiplyMatrices(Y_MIRROR, camera.matrixWorld);
    mirrorCam.matrixWorldInverse.copy(mirrorCam.matrixWorld).invert();
    mirrorCam.projectionMatrix.multiplyMatrices(FLIP_X, camera.projectionMatrix);
    mirrorCam.projectionMatrixInverse.copy(mirrorCam.projectionMatrix).invert();

    const prevTarget = renderer.getRenderTarget();
    const prevClip = renderer.clippingPlanes;
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevAO = AO_UNIFORMS.tAmbientOcclusion.value;
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    const wasVisible = hidden.map((o) => o.visible);

    // The frame's shadow map is reused, not redrawn: the sun has not moved since the last one.
    renderer.shadowMap.autoUpdate = false;
    renderer.clippingPlanes = clipPlanes;
    AO_UNIFORMS.tAmbientOcclusion.value = noAO;
    // The cloud field is placed in world space through the camera that is drawing, and this pass
    // is drawing through the mirror.
    const prevViewInv = viewInv.copy(CLOUD_UNIFORMS.uCloudViewInv.value);
    CLOUD_UNIFORMS.uCloudViewInv.value.copy(mirrorCam.matrixWorld);
    hidden.forEach((o) => { o.visible = false; });
    groundUniforms.tRainReflect.value = noReflect;
    const wet = groundUniforms.uRainWet.value;
    groundUniforms.uRainWet.value = 0;

    renderer.setRenderTarget(reflectTarget);
    renderer.setClearColor(skyTint, 1);
    renderer.clear();
    renderer.render(scene, mirrorCam);

    hidden.forEach((o, i) => { o.visible = wasVisible[i]; });
    groundUniforms.tRainReflect.value = reflectTarget.texture;
    groundUniforms.uRainWet.value = wet;
    AO_UNIFORMS.tAmbientOcclusion.value = prevAO;
    CLOUD_UNIFORMS.uCloudViewInv.value.copy(prevViewInv);
    renderer.clippingPlanes = prevClip;
    renderer.shadowMap.autoUpdate = prevShadow;
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.setRenderTarget(prevTarget);
  }

  // --- wet ground -------------------------------------------------------------------------------

  /**
   * Patch the ground mesh's material in place. Chained onto whatever `propMaterial` already
   * installed (AO, the shadow tint, a look mode), and keyed on top of its key so it cannot share
   * a program with the unpatched props.
   */
  function wetGround(mesh) {
    const material = mesh.material;
    const prevCompile = material.onBeforeCompile;
    const prevKey = material.customProgramCacheKey();
    material.customProgramCacheKey = () => `${prevKey}-wet`;
    material.onBeforeCompile = (shader, r) => {
      prevCompile.call(material, shader, r);
      Object.assign(shader.uniforms, groundUniforms);

      shader.vertexShader = inject(shader.vertexShader, '#include <common>', `#include <common>
varying vec3 vRainWorld;`, 'ground vertex');
      shader.vertexShader = inject(shader.vertexShader, '#include <project_vertex>', `#include <project_vertex>
vRainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`, 'ground vertex');

      shader.fragmentShader = inject(shader.fragmentShader, '#include <common>', `#include <common>
${WET_COMMON}`, 'ground fragment');
      shader.fragmentShader = inject(shader.fragmentShader, '#include <color_fragment>', `#include <color_fragment>
${WET_ALBEDO}`, 'ground fragment');
      shader.fragmentShader = inject(shader.fragmentShader, '#include <opaque_fragment>', `${WET_REFLECT}
#include <opaque_fragment>`, 'ground fragment');
    };
    material.needsUpdate = true;
    return mesh;
  }

  // --- the streaks ------------------------------------------------------------------------------

  const centre = new THREE.Vector3();
  // Where the rain and splashes wrap around: the middle of the frame, or the squall's cell while
  // one is crossing — its curtain is all the rain there is, so all of it goes there.
  const rainCentre = new THREE.Vector3();
  let squall = null;
  const pixelRatio = { value: renderer.getPixelRatio() };

  const streakGeo = new THREE.InstancedBufferGeometry();
  streakGeo.setAttribute('corner', new THREE.Float32BufferAttribute(
    [-1, 0, 1, 0, 1, 1, -1, 0, 1, 1, -1, 1], 2));
  // `position` is never read, but three sizes the draw off it.
  streakGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(18), 3));
  const seeds = new Float32Array(DROPS * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  streakGeo.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 4));
  streakGeo.instanceCount = DROPS;

  const streakUniforms = {
    uTime: { value: 0 },
    uCentre: { value: rainCentre },
    uBox: { value: BOX.clone() },
    uFall: { value: FALL },
    uLen: { value: STREAK_LEN },
    uWidth: { value: STREAK_W },
    uColor: { value: new THREE.Color(PALETTE.rainStreak) },
    uOpacity: { value: STREAK_OPACITY },
    uCell: CLOUD_UNIFORMS.uCell,
    uCellEdge: CLOUD_UNIFORMS.uCellEdge,
    uCellTime: CLOUD_UNIFORMS.uCellTime,
  };
  const streaks = new THREE.Mesh(streakGeo, new THREE.ShaderMaterial({
    uniforms: streakUniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uCentre;
      uniform vec3 uBox;
      uniform vec3 uFall;
      uniform float uLen;
      uniform float uWidth;
      uniform vec4 uCell;
      uniform float uCellEdge;
      uniform float uCellTime;
      attribute vec2 corner;
      attribute vec4 seed;
      varying float vAlong;
      varying float vAlpha;
      ${CLOUD_GLSL}
      void main() {
        float speed = 0.8 + 0.4 * seed.w;
        vec3 p = seed.xyz * uBox + uFall * speed * uTime;
        p.xz = uCentre.xz + mod(p.xz - uCentre.xz + 0.5 * uBox.xz, uBox.xz) - 0.5 * uBox.xz;
        p.y = mod(p.y, uBox.y);
        vec3 tail = p - normalize(uFall) * uLen * speed;
        vec4 head = viewMatrix * vec4(p, 1.0);
        vec4 back = viewMatrix * vec4(tail, 1.0);
        vec3 axis = normalize(back.xyz - head.xyz);
        vec3 side = normalize(cross(axis, vec3(0.0, 0.0, 1.0)));
        vec4 v = mix(head, back, corner.y);
        v.xyz += side * corner.x * uWidth;
        gl_Position = projectionMatrix * v;
        vAlong = corner.y;
        vAlpha = 0.45 + 0.55 * seed.w;
        // In a squall, only inside the cell — the curtain of rain is the cell.
        if (uCell.w > 0.5) vAlpha *= cellCore(p.xz, uCell, uCellEdge, uCellTime);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying float vAlong;
      varying float vAlpha;
      void main() {
        float a = uOpacity * vAlpha * (1.0 - vAlong) * smoothstep(0.0, 0.15, vAlong + 0.05);
        gl_FragColor = vec4(uColor, a);
      }
    `,
  }));
  streaks.frustumCulled = false;
  streaks.renderOrder = 2;
  streaks.name = 'rain-streaks';

  // --- the splashes -----------------------------------------------------------------------------

  const splashGeo = new THREE.BufferGeometry();
  const splashSeeds = new Float32Array(SPLASHES * 3);
  for (let i = 0; i < splashSeeds.length; i++) splashSeeds[i] = Math.random();
  splashGeo.setAttribute('position', new THREE.Float32BufferAttribute(splashSeeds, 3));
  const splashUniforms = {
    uTime: { value: 0 },
    uCentre: { value: rainCentre },
    uBox: { value: SPLASH_BOX },
    uY: { value: SPLASH_Y },
    uRate: { value: SPLASH_RATE },
    uLife: { value: SPLASH_LIFE },
    uSize: { value: 9 },
    uPixelRatio: pixelRatio,
    uColor: { value: new THREE.Color(PALETTE.rainSplash) },
    uDensity: { value: 1 },
    uCell: CLOUD_UNIFORMS.uCell,
    uCellEdge: CLOUD_UNIFORMS.uCellEdge,
    uCellTime: CLOUD_UNIFORMS.uCellTime,
  };
  const splashes = new THREE.Points(splashGeo, new THREE.ShaderMaterial({
    uniforms: splashUniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uCentre;
      uniform float uBox;
      uniform float uY;
      uniform float uRate;
      uniform float uLife;
      uniform float uSize;
      uniform float uPixelRatio;
      uniform float uDensity;
      uniform vec4 uCell;
      uniform float uCellEdge;
      uniform float uCellTime;
      varying float vAge;
      ${CLOUD_GLSL}
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        float cycle = uTime * uRate + position.z * 17.0;
        float n = floor(cycle);
        vAge = fract(cycle) / uLife;
        // A fresh spot every cycle, hashed from the slot and the cycle count.
        vec2 r = vec2(hash(position.xy + n * 0.713), hash(position.yx * 1.31 + n * 0.297));
        vec2 xz = uCentre.xz + (r - 0.5) * uBox;
        gl_Position = projectionMatrix * viewMatrix * vec4(xz.x, uY, xz.y, 1.0);
        // A slot fires only if it is inside this moment's share of the rain.
        if (position.x > uDensity) vAge = 1.0;
        if (uCell.w > 0.5 && position.y > cellCore(xz, uCell, uCellEdge, uCellTime)) vAge = 1.0;
        gl_PointSize = vAge < 1.0 ? uSize * uPixelRatio * (0.45 + 0.75 * vAge) : 0.0;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vAge;
      void main() {
        if (vAge >= 1.0) discard;
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        p.y *= 1.9;                     // flattened into the ground plane by the 33 degree view
        float d = length(p);
        float ring = smoothstep(0.55, 0.8, d) * smoothstep(1.0, 0.82, d);
        float crown = smoothstep(0.35, 0.0, length(p - vec2(0.0, -0.6 + 0.9 * vAge))) * (1.0 - vAge);
        float a = max(ring * 0.55, crown) * (1.0 - vAge * vAge);
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a * 0.7);
      }
    `,
  }));
  splashes.frustumCulled = false;
  splashes.renderOrder = 2;
  splashes.name = 'rain-splashes';

  // --- the sun shafts --------------------------------------------------------------------------------

  const shaftGeo = new THREE.InstancedBufferGeometry();
  shaftGeo.setAttribute('corner', new THREE.Float32BufferAttribute(
    [-1, 0, 1, 0, 1, 1, -1, 0, 1, 1, -1, 1], 2));
  shaftGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(18), 3));
  const shaftSeeds = new Float32Array(SHAFTS * 4);
  for (let i = 0; i < shaftSeeds.length; i++) shaftSeeds[i] = Math.random();
  shaftGeo.setAttribute('seed', new THREE.InstancedBufferAttribute(shaftSeeds, 4));
  shaftGeo.instanceCount = SHAFTS;
  const shaftUniforms = {
    uCentre: { value: centre },
    uBox: { value: SHAFT_BOX },
    uLen: { value: SHAFT_LEN },
    uSunDir: { value: new THREE.Vector3(0.5, 0.5, 0.7).normalize() },
    uStrength: { value: SHAFT_STRENGTH * mood.shafts },
    uColor: { value: new THREE.Color(PALETTE.sunShaft) },
    // The field's own uniforms, by reference, so a shaft can only ever stand over a gap.
    uCloudCover: CLOUD_UNIFORMS.uCloudCover,
    uCloudTime: CLOUD_UNIFORMS.uCloudTime,
    uCloudScale: CLOUD_UNIFORMS.uCloudScale,
    uCloudDrift: CLOUD_UNIFORMS.uCloudDrift,
  };
  const shafts = new THREE.Mesh(shaftGeo, new THREE.ShaderMaterial({
    uniforms: shaftUniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform vec3 uCentre;
      uniform float uBox;
      uniform float uLen;
      uniform vec3 uSunDir;
      uniform float uStrength;
      uniform float uCloudCover;
      uniform float uCloudTime;
      uniform float uCloudScale;
      uniform vec2 uCloudDrift;
      attribute vec2 corner;
      attribute vec4 seed;
      varying vec2 vCorner;
      varying float vAlpha;
      ${CLOUD_GLSL}
      void main() {
        // Ride the wind at exactly the rate the field does, so a shaft stays over its gap.
        vec2 wind = -uCloudDrift * uCloudScale;
        vec2 xz = seed.xy * uBox + wind * uCloudTime;
        xz = uCentre.xz + mod(xz - uCentre.xz + 0.5 * uBox, vec2(uBox)) - 0.5 * uBox;
        float sun = cloudSun(xz, uCloudTime, uCloudCover, uCloudScale, uCloudDrift);
        // Only where there is a gap, and only while there is cloud around it to make it a shaft.
        vAlpha = sun * smoothstep(0.08, 0.35, uCloudCover) * uStrength * (0.5 + 0.5 * seed.w);
        vec4 foot = viewMatrix * vec4(xz.x, 0.0, xz.y, 1.0);
        vec4 head = viewMatrix * vec4(vec3(xz.x, 0.0, xz.y) + uSunDir * uLen, 1.0);
        vec3 axis = normalize(head.xyz - foot.xyz);
        vec3 side = normalize(cross(axis, vec3(0.0, 0.0, 1.0)));
        float width = mix(2.5, 7.0, seed.z) * (1.0 + 0.8 * corner.y);
        vec4 v = mix(foot, head, corner.y);
        v.xyz += side * corner.x * width;
        gl_Position = projectionMatrix * v;
        vCorner = corner;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying vec2 vCorner;
      varying float vAlpha;
      void main() {
        float across = 1.0 - abs(vCorner.x);
        across *= across;
        float along = smoothstep(0.0, 0.06, vCorner.y) * pow(1.0 - vCorner.y, 1.4);
        gl_FragColor = vec4(uColor * vAlpha * across * along, 1.0);
      }
    `,
  }));
  shafts.frustumCulled = false;
  shafts.renderOrder = 2;
  shafts.name = 'rain-sunshafts';

  hidden.push(streaks, splashes, shafts);

  // --- the lens ---------------------------------------------------------------------------------

  let frameTex = null;
  const lensUniforms = {
    tFrame: { value: null },
    uAspect: { value: 1 },
    uTime: { value: 0 },
    uAmount: { value: 1 },
  };
  const lensScene = new THREE.Scene();
  const lensCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const lensGeo = new THREE.BufferGeometry();
  lensGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const lens = new THREE.Mesh(lensGeo, new THREE.ShaderMaterial({
    uniforms: lensUniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: LENS_FRAGMENT,
  }));
  lens.frustumCulled = false;
  lensScene.add(lens);

  /** After the main render: copy the frame, draw it back through the drops. */
  function renderLens() {
    // A frame copy and a fullscreen pass for nothing, while the glass is dry.
    if (lensLevel < 0.002) return;
    renderer.getDrawingBufferSize(drawingBuffer);
    if (!frameTex || frameTex.image.width !== drawingBuffer.x || frameTex.image.height !== drawingBuffer.y) {
      frameTex?.dispose();
      frameTex = new THREE.FramebufferTexture(drawingBuffer.x, drawingBuffer.y);
      frameTex.minFilter = THREE.LinearFilter;
      frameTex.magFilter = THREE.LinearFilter;
      lensUniforms.tFrame.value = frameTex;
    }
    lensUniforms.uAspect.value = drawingBuffer.x / drawingBuffer.y;
    renderer.copyFramebufferToTexture(frameTex);
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(lensScene, lensCam);
    renderer.autoClear = prevAuto;
  }

  // --- the grade --------------------------------------------------------------------------------

  const rainTop = new THREE.Color(PALETTE.rainSkyTop);
  const rainBottom = new THREE.Color(PALETTE.rainSkyBottom);
  const rainSun = new THREE.Color(PALETTE.rainSun);
  const rainHemiSky = new THREE.Color(PALETTE.rainHemiSky);
  const rainHemiGround = new THREE.Color(PALETTE.rainHemiGround);

  /**
   * Overcast, over any hour: the day's own colours pulled most of the way to the rain palette, but
   * scaled by the day's own brightness so a rainy night is still night. Mutates the keyframe
   * `daylight.apply` is about to use.
   */
  function grade(look) {
    const w = weather.dark;
    if (w <= 0) return;
    const bright = Math.min(1, look.fill / 1.2);
    // Storm-dark rather than an honest overcast afternoon, and on purpose: the city's lamps
    // (game/citylights.js) are what a wet street is a mirror for, and they only read against a dim
    // frame. The first cut sat at 0.32 of the sun and 1.15 of the fill and the lights looked like
    // paint; `STORM_SKY` and friends push the peak of `?storm` most of the way to night.
    const sky = (0.25 + 0.75 * bright) * mood.sky;
    look.top.lerp(tmp.copy(rainTop).multiplyScalar(sky), mood.skyMix * w);
    look.bottom.lerp(tmp.copy(rainBottom).multiplyScalar(sky), mood.skyMix * w);
    look.sun.lerp(rainSun, mood.sunMix * w);
    look.hemiSky.lerp(tmp.copy(rainHemiSky).multiplyScalar((0.3 + 0.7 * bright) * mood.sky), 0.75 * w);
    look.hemiGround.lerp(rainHemiGround, 0.6 * w);
    // At night the sun goes behind cloud first and fastest: shadows soften and fade well before the
    // sky has finished darkening. In the shower it keeps its strength — the cloud field does the
    // dimming, a patch at a time.
    look.power *= THREE.MathUtils.lerp(1, mood.sun, Math.min(1, w * 1.4));
    look.fill *= THREE.MathUtils.lerp(1, mood.fill, w);
  }

  /**
   * Where the weather is — `{ dark, rain, wet }`, each 0..1 (game/storm.js). Everything above reads
   * it: the grade through `dark`, the streaks, splashes and lens drops through `rain`, and the
   * ground's gloss and the mirror pass through `wet`. Starts at the full storm, which is `?rain`.
   */
  const weather = { dark: 1, rain: 1, wet: 1 };
  const tmp = new THREE.Color();
  let lensLevel = 1;

  function setWeather({
    dark = weather.dark, rain = weather.rain, wet = weather.wet, lens = rain,
  } = {}, dt = 0) {
    weather.dark = dark;
    weather.rain = rain;
    weather.wet = wet;
    groundUniforms.uRainWet.value = wet;
    CLOUD_UNIFORMS.uCloudCover.value = mood.cover * dark;
    streakUniforms.uOpacity.value = STREAK_OPACITY * rain;
    splashUniforms.uDensity.value = rain;
    // Drops land on the glass with the rain and take a while to dry off once it stops.
    lensLevel = dt > 0 && lens < lensLevel ? lensLevel + (lens - lensLevel) * Math.min(1, dt / 12) : lens;
    lensUniforms.uAmount.value = lensLevel;
    // The streaks and splashes are *not* hidden at zero, only faded: a mesh's program compiles on
    // the first frame it is drawn, and that frame would be the one the storm arrives on.
  }

  // --- the loop ---------------------------------------------------------------------------------

  const camDir = new THREE.Vector3();

  function update(dt, camera) {
    clock.t += dt;
    groundUniforms.uRainTime.value = clock.t;
    streakUniforms.uTime.value = clock.t;
    splashUniforms.uTime.value = clock.t;
    lensUniforms.uTime.value = clock.t;
    CLOUD_UNIFORMS.uCloudTime.value = clock.t;
    camera.updateMatrixWorld();
    CLOUD_UNIFORMS.uCloudViewInv.value.copy(camera.matrixWorld);
    pixelRatio.value = renderer.getPixelRatio();
    // Wrap the weather around the point on the ground under the middle of the frame.
    camera.getWorldDirection(camDir);
    if (Math.abs(camDir.y) > 1e-4) {
      const t = -camera.position.y / camDir.y;
      centre.copy(camera.position).addScaledVector(camDir, t);
    }
    rainCentre.copy(centre);
    if (squall) {
      const { cell } = squall;
      CLOUD_UNIFORMS.uCell.value.set(cell.x, cell.z, cell.r, cell.on ? 1 : 0);
      CLOUD_UNIFORMS.uCellTime.value = squall.state.t;
      if (cell.on) rainCentre.set(cell.x, 0, cell.z);
    }
  }

  return {
    enabled: true,
    grade,
    setWeather,
    weather,
    wetGround,
    renderReflection,
    renderLens,
    update,
    /** Put the falling rain in a scene. */
    addTo: (scene) => { scene.add(streaks, splashes, shafts); },
    /** Point the shafts at the sun — `sun.position`, any length. */
    setSunDir: (position) => { shaftUniforms.uSunDir.value.copy(position).normalize(); },
    /** This storm's mood — see MOODS. */
    mood,
    /** The point on the ground under the middle of the frame. */
    centre,
    /**
     * Hand the weather to a squall (game/squall.js): the ground reads its wet map, and the rain
     * and splashes close in around its cell, at the density the whole sky had.
     */
    attachSquall: (s) => {
      squall = s;
      groundUniforms.tWetMap.value = s.texture;
      CLOUD_UNIFORMS.uCellEdge.value = s.edge;
      const span = 2 * (s.cell.r + CLOUD_UNIFORMS.uCellEdge.value) + 20;
      streakUniforms.uBox.value.set(span, BOX.y, span);
      splashUniforms.uBox.value = span;
    },
    /** Anything else that must stay out of the mirror — the bloom and crayon overlays. */
    hideInMirror: (...objects) => { hidden.push(...objects.filter(Boolean)); },
    uniforms: {
      ground: groundUniforms, streaks: streakUniforms, lens: lensUniforms, shafts: shaftUniforms,
      clouds: CLOUD_UNIFORMS,
    },
    reflectTarget,
  };
}

// --- shader bodies -------------------------------------------------------------------------------
// No backticks inside these: they are template literals, and one would end the shader.

const WET_COMMON = /* glsl */ `
uniform sampler2D tRainReflect;
uniform sampler2D tWetMap;
uniform float uWetExtent;
uniform vec2 uRainScreen;
uniform float uRainTime;
uniform float uRainWet;
uniform vec3 uRainSheen;
uniform float uRainGlint;
uniform vec3 uRainGlintColor;
varying vec3 vRainWorld;

float rainHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float rainNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rainHash(i), rainHash(i + vec2(1.0, 0.0)), f.x),
             mix(rainHash(i + vec2(0.0, 1.0)), rainHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// The puddles: at most one ellipse per CELL-unit cell, its centre, size and heading all
// hashed off the cell. Returns roughly the distance in world units outside the nearest one
// (negative inside). Thresholded noise was tried first and twice: two axis-aligned octaves came
// out diamond-faceted (this camera looks down the lattice's diagonal), and three rotated, warped
// octaves fixed the facets but read as coastlines on a map. A puddle in a cartoon city is a
// rounded oblong, so it is drawn as one.
float rainPuddleDist(vec2 p) {
  const float CELL = 7.0;
  vec2 g = p / CELL;
  vec2 cell = floor(g);
  float d = 1e3;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 c = cell + vec2(float(x), float(y));
      if (rainHash(c + 41.7) > 0.55) continue;
      vec2 centre = (c + 0.15 + 0.7 * vec2(rainHash(c), rainHash(c + 7.1))) * CELL;
      float a = rainHash(c + 13.3) * 3.14159;
      vec2 q = p - centre;
      q = vec2(cos(a) * q.x + sin(a) * q.y, -sin(a) * q.x + cos(a) * q.y);
      float sz = 0.7 + 0.6 * rainHash(c + 5.3);
      vec2 r = vec2(1.6 + 1.6 * rainHash(c + 23.9), 0.8 + 0.6 * rainHash(c + 31.1)) * sz;
      // Ellipse distance, scaled back to world units by the short radius: exact on the short
      // axis, a little generous on the long one, which only widens the rim's ramp there.
      float e = (length(q / r) - 1.0) * r.y;
      // About a third get a smaller second lobe off one end, blended in, so not every puddle is
      // the same pill: an all-ellipse first cut read as polka dots.
      if (rainHash(c + 53.9) < 0.35) {
        vec2 r2 = r * vec2(0.6, 0.8);
        vec2 q2 = q - vec2(r.x * 0.9, (rainHash(c + 61.3) - 0.5) * r.y);
        float e2 = (length(q2 / r2) - 1.0) * r2.y;
        float k = 0.4;
        float h = clamp(0.5 + 0.5 * (e2 - e) / k, 0.0, 1.0);
        e = mix(e2, e, h) - k * h * (1.0 - h);
      }
      d = min(d, e);
    }
  }
  return d;
}
// Rings spreading from drops landing on a grid of cells, one drop per cell per cycle. Returns the
// slope of the water surface, which is all a reflection needs to wobble.
vec2 rainRipples(vec2 p, float t) {
  vec2 slope = vec2(0.0);
  vec2 cell = floor(p);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 c = cell + vec2(float(x), float(y));
      float h = rainHash(c);
      float cyc = t * (0.8 + 0.6 * h) + h * 13.0;
      float n = floor(cyc);
      float life = fract(cyc);
      vec2 centre = c + vec2(rainHash(c + n * 0.37), rainHash(c.yx + n * 0.71));
      vec2 d = p - centre;
      float r = length(d) + 1e-4;
      float x0 = r - life * 1.2;
      float env = smoothstep(0.3, 0.0, abs(x0)) * (1.0 - life) * (1.0 - life);
      slope += (d / r) * sin(x0 * 22.0) * env;
    }
  }
  return slope;
}
`;

// Inside main(), straight after the vertex colour lands in diffuseColor. Works out how wet this
// fragment is and darkens it: a wet surface is darker because the water film stops light
// scattering back out of it, and a puddle more so.
const WET_ALBEDO = /* glsl */ `
float rainHere = uRainWet * texture2D(tWetMap, (vRainWorld.xz + 0.5 * uWetExtent) / uWetExtent).r;
// Raining on this spot right now, as against merely still wet from it: only the first ripples.
float rainNow = uCell.w > 0.5 ? cellCore(vRainWorld.xz, uCell, uCellEdge, uCellTime) : 1.0;
vec3 rainDx = dFdx(vRainWorld);
vec3 rainDy = dFdy(vRainWorld);
float rainUp = smoothstep(0.8, 0.95, abs(normalize(cross(rainDx, rainDy)).y));
float rainRoad = 1.0 - smoothstep(0.08, 0.2, vRainWorld.y);
float rainGrass = step(diffuseColor.r * 1.08, diffuseColor.g) * step(diffuseColor.b, diffuseColor.g);
float rainPuddleD = rainPuddleDist(vRainWorld.xz);
// The rim is antialiased off the distance's own screen-space slope, so it is a clean curve at any
// zoom rather than a stair at play zoom or a smear close up.
float rainPuddleAA = max(fwidth(rainPuddleD), 0.01);
float rainPuddle = (1.0 - smoothstep(-rainPuddleAA, rainPuddleAA, rainPuddleD)) * rainRoad * rainUp * rainHere;
// A damp ring just outside each puddle, darker than wet asphalt, so the edge feathers into the
// road rather than being a sticker on it.
float rainDamp = (1.0 - smoothstep(0.0, 0.5, rainPuddleD)) * rainRoad * rainUp * rainHere;
float rainWet = rainHere * mix(0.55, 1.0, rainUp) * mix(0.6, 1.0, rainRoad) * (1.0 - 0.5 * rainGrass);
diffuseColor.rgb *= mix(1.0, 0.58, rainWet);
diffuseColor.rgb *= mix(1.0, 0.82, rainDamp);
diffuseColor.rgb *= mix(1.0, 0.85, rainPuddle);
`;

// Before the colour is written: mix in the mirror. Sampled at 1 - u because the mirror pass was
// flipped in x to keep its faces front-facing (game/rain.js). Blurred along screen y — lights on
// wet asphalt smear towards the viewer — except in a puddle, which is a proper mirror.
const WET_REFLECT = /* glsl */ `
{
  vec2 rainUV = gl_FragCoord.xy * uRainScreen;
  vec2 rainRip = rainRipples(vRainWorld.xz / 1.1, uRainTime) * rainNow;
  vec2 rainWob = vec2(rainNoise(vRainWorld.xz * 1.7 + uRainTime * 0.4),
                      rainNoise(vRainWorld.xz * 1.7 - uRainTime * 0.4 + 5.0)) - 0.5;
  vec2 ruv = vec2(1.0 - rainUV.x, rainUV.y);
  ruv += rainRip * mix(0.003, 0.009, rainPuddle) + rainWob * 0.006 * (1.0 - rainPuddle);
  float spread = mix(0.03, 0.004, rainPuddle);
  vec3 refl = vec3(0.0);
  float wsum = 0.0;
  for (int k = -4; k <= 4; k++) {
    float w = 1.0 - abs(float(k)) / 5.0;
    refl += texture2D(tRainReflect, ruv + vec2(0.0, float(k) * spread / 4.0)).rgb * w;
    wsum += w;
  }
  refl /= wsum;
  float gloss = rainHere * rainUp * mix(mix(0.07, 0.3, rainRoad), 0.72, rainPuddle) * (1.0 - 0.8 * rainGrass);
  outgoingLight = mix(outgoingLight, refl, gloss);
  outgoingLight += uRainSheen * clamp(length(rainRip), 0.0, 1.0) * mix(0.02, 0.1, rainPuddle) * rainUp * rainRoad;
  // Read off the sun this fragment actually got — cloud field and shadow map both already in it —
  // so a building's shadow stays a shadow. The first cut sampled the cloud field instead and lit
  // the wet street straight through every shadow in the patch.
  float rainSun = dot(reflectedLight.directDiffuse, vec3(0.2126, 0.7152, 0.0722));
  outgoingLight += uRainGlintColor * uRainGlint * rainSun * rainHere * rainUp * mix(0.35, 1.0, rainRoad)
    * mix(0.6, 1.0, rainPuddle) * (1.0 - 0.7 * rainGrass);
}
`;

// Drops on the glass. Two layers: small beads that fade in, sit and dry off, and fewer bigger ones
// that creep down the screen. Each is a tiny lens that shows the frame behind it upside down and
// a bit magnified, with a rim and a catch-light. Display space in, display space out — the copied
// frame is already encoded, and a bare ShaderMaterial writes what it is given.
const LENS_FRAGMENT = /* glsl */ `
uniform sampler2D tFrame;
uniform float uAspect;
uniform float uTime;
uniform float uAmount;
varying vec2 vUv;

vec3 lensHash(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.11369, 0.13787));
  p3 += dot(p3, p3.yzx + 19.19);
  return fract(vec3((p3.x + p3.y) * p3.z, (p3.x + p3.z) * p3.y, (p3.y + p3.z) * p3.x));
}

// Returns (offset from the drop centre in cell units, normalised radius, coverage).
vec4 beads(vec2 uv, float scale, float density, float t) {
  vec2 p = uv * vec2(uAspect, 1.0) * scale;
  vec2 id = floor(p);
  vec2 f = fract(p) - 0.5;
  vec3 n = lensHash(id.x * 107.45 + id.y * 3543.654);
  if (n.z > density) return vec4(0.0);
  float life = fract(t * (0.04 + 0.05 * n.y) + n.x);
  float a = smoothstep(0.0, 0.03, life) * smoothstep(1.0, 0.55, life);
  vec2 c = (n.xy - 0.5) * 0.5;
  float r = mix(0.1, 0.24, n.z / density) * mix(0.75, 1.0, a);
  vec2 d = f - c;
  d.y *= 1.12;
  float dist = length(d) / r;
  return vec4(d / r, dist, smoothstep(1.0, 0.82, dist) * a);
}

vec4 sliders(vec2 uv, float t) {
  vec2 p = uv * vec2(uAspect, 1.0) * vec2(5.0, 1.6);
  float col = floor(p.x);
  vec3 n = lensHash(col * 71.3 + 4.1);
  if (n.x > 0.3) return vec4(0.0);
  // Stick, then slip: a drop hangs, lets go, catches again.
  float cyc = t * (0.05 + 0.05 * n.y) + n.z;
  float fall = fract(cyc);
  float y = 1.0 - (fall + 0.06 * sin(fall * 40.0 * n.y));
  float x = col + 0.5 + 0.18 * sin(p.y * 3.0 + n.y * 6.28);
  vec2 d = vec2(p.x - x, (p.y - y * 1.6) * 0.85) / vec2(1.0, 0.25);
  d *= 3.2;
  float r = 0.55 + 0.25 * n.y;
  float dist = length(d) / r;
  return vec4(d / r, dist, smoothstep(1.0, 0.8, dist));
}

void main() {
  vec4 a = beads(vUv, 11.0, 0.12, uTime);
  vec4 b = beads(vUv + 0.37, 6.0, 0.04, uTime * 0.7 + 3.0);
  vec4 s = sliders(vUv, uTime);
  vec4 drop = a;
  if (b.w > drop.w) drop = b;
  if (s.w > drop.w) drop = s;
  float cover = drop.w * uAmount;
  if (cover < 0.01) discard;

  // The lens: inverted and magnified about the drop's own centre, bulging most in the middle.
  vec2 bend = drop.xy * sqrt(max(0.0, 1.0 - drop.z * drop.z));
  vec2 src = vUv - bend * 0.022;
  vec3 col = texture2D(tFrame, src).rgb;
  col *= mix(1.0, 0.72, smoothstep(0.55, 1.0, drop.z));                // the rim darkens
  float catchLight = smoothstep(0.35, 0.0, length(drop.xy - vec2(-0.35, 0.4)));
  col += catchLight * 0.16;
  gl_FragColor = vec4(col, cover);
}
`;
