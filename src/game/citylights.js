import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { color } from '../palette.js';
import {
  bakeColor, hash01, propMaterial, stampEntry, unlitMaterial, CLOUD_UNIFORMS, CLOUD_GLSL,
} from '../util/geo.js';
import { facadeQuads, setPaneSink } from '../city/buildings.js';
import { KERB_H } from '../city/ground.js';
import { CAR_LEN, CAR_W } from '../sim/traffic.js';
import {
  headlightGeometry, headlightAnchors, headlightMaterial, coneGeometry, coneMaterial, coneQuat,
} from '../geometry/lights.js';

/**
 * The city with its lights on — Rain Mode (`?rain`, game/rain.js). A wet street is mostly a
 * mirror for *lamps*, and a daytime city has almost none, so the first rain build reflected grey
 * buildings into grey asphalt. This gives it something to reflect:
 *
 * - **Lit windows.** `collectPanes()` installs a sink in `city/buildings.js` for the length of one
 *   `createBuildings` call and keeps every façade's openings; `litWindows()` then lays a glowing
 *   quad over a random share of them, stood `LIT_OUT` proud of the glass (and still behind a
 *   shopfront's door and its surround, which sit at two and three times the glass's 0.03).
 * - **Street lamps.** A post on the pavement edge, an arm reaching out over the kerb, a head that
 *   glows, and a pool of light on the road under it.
 *
 * The car headlights are the third part, and live beside the brake pods in sim/traffic.js.
 */

/**
 * How far the storm has switched the city on, 0..1 — `setCityLights`, from `main.js`. Every pane and
 * every lamp carries its own threshold (`aLitAt`) and comes on when this passes it, so the lights go
 * on one at a time as the sky darkens and off one at a time as it clears. One uniform, shared by
 * reference into every material that reads it, the bloom's copies included.
 */
const LIT_LEVEL = { value: 1 };
/** Seconds of weather, for the flicker. Advanced by `dt` rather than read off a clock so shot mode,
 * which passes 0, freezes it on the same frame every time. */
const LIT_TIME = { value: 0 };
export function setCityLights(level, dt = 0) {
  LIT_LEVEL.value = level;
  LIT_TIME.value += dt;
}

/**
 * How long a light takes to come up once its threshold is passed, in units of `LIT_LEVEL`. Under a
 * squall the level at a point climbs 0..1 in about 6s (a 22-unit edge at ~3.6 u/s), so this is
 * roughly half a second of fade. It was 0.035 — a fifth of a second, which read as a switch.
 */
const LIT_RAMP = 0.08;

/** Share of lights that sputter on (and off) instead of fading cleanly, and how long they sputter
 * for, in units of `LIT_LEVEL` past their threshold — about the first second of a squall's edge. */
const FLICKER_SHARE = 0.25;
const FLICKER_SPAN = 0.14;

/** Replace one chunk, loudly. */
function inject(source, chunk, replacement) {
  if (!source.includes(chunk)) throw new Error(`citylights: no ${chunk} in the shader`);
  return source.replace(chunk, replacement);
}

/**
 * The cell's reach for the lights, as a multiple of its soft edge — a little past the rain, the way
 * the cloud's shade is (CLOUD_LIGHT in util/geo.js), so the windows are already on as it arrives.
 */
const CELL_LIGHT_REACH = 1.6;

/**
 * The level a light at `xz` sees: the city-wide one, or — in a squall — however far under the
 * cell it stands, whichever is higher. One GLSL expression for every lit thing here, so a window
 * and the street lamp outside it can never disagree about whether the storm has reached them.
 */
const LOCAL_LEVEL = /* glsl */ `
float litLevelAt(vec2 xz) {
  return max(uLitLevel, cellCore(xz, uCell, uCellEdge * ${CELL_LIGHT_REACH.toFixed(2)}, uCellTime));
}
`;
const LIT_UNIFORMS = /* glsl */ `
uniform float uLitLevel;
uniform vec4 uCell;
uniform float uCellEdge;
uniform float uCellTime;
uniform float uLitTime;
`;

/**
 * How far on a light is, 0..1: a short fade past its threshold and, for a share of them picked off
 * their seed, a sputter while the fade is young. The sputter's odds of being dark start high and fall
 * to nothing across the window, so a flickering light settles on rather than stopping mid-blink.
 */
const LIT_ON = /* glsl */ `
float litOn(float at, float level, float seed) {
  float on = smoothstep(at, at + ${LIT_RAMP.toFixed(3)}, level);
  if (seed < ${FLICKER_SHARE.toFixed(3)}) {
    float w = clamp((level - at) / ${FLICKER_SPAN.toFixed(3)}, 0.0, 1.0);
    float n = cloudHash(vec2(floor(uLitTime * 13.0 + seed * 40.0), seed * 97.0));
    on *= step(0.7 * (1.0 - w), n);
  }
  return on;
}
`;
const litUniforms = () => ({
  uLitLevel: LIT_LEVEL,
  uLitTime: LIT_TIME,
  uCell: CLOUD_UNIFORMS.uCell,
  uCellEdge: CLOUD_UNIFORMS.uCellEdge,
  uCellTime: CLOUD_UNIFORMS.uCellTime,
});

/** Switch an unlit material's fragments on by their `aLitAt` against the level where they stand. */
function litSwitch(material) {
  material.customProgramCacheKey = () => 'lit-switch';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, litUniforms());
    // Read at the light's own anchor (aLitXZ), never at the vertex: the squall's level climbs
    // across its 22-unit edge, and sampled per corner it differed across a single pane by more
    // than the ramp — so each window wiped on from one side as the edge went over it.
    shader.vertexShader = inject(shader.vertexShader, '#include <begin_vertex>', `#include <begin_vertex>
vec2 litXZ = (modelMatrix * vec4(aLitXZ.x, 0.0, aLitXZ.y, 1.0)).xz;
vLitOn = litOn(aLitAt, litLevelAt(litXZ), cloudHash(litXZ * 0.731 + aLitAt * 13.7));`);
    shader.vertexShader = `attribute float aLitAt;\nattribute vec2 aLitXZ;\nvarying float vLitOn;\n${LIT_UNIFORMS}${CLOUD_GLSL}${LOCAL_LEVEL}${LIT_ON}${shader.vertexShader}`;
    shader.fragmentShader = `varying float vLitOn;\n${shader.fragmentShader}`;
    shader.fragmentShader = inject(shader.fragmentShader, '#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
if (vLitOn <= 0.0) discard;`);
    shader.fragmentShader = inject(shader.fragmentShader, '#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb *= vLitOn;`);
  };
  return material;
}

/** Give every vertex of `geo` the same threshold, and the same anchor to read the level at. */
function stampLitAt(geo, at, x, z) {
  const n = geo.attributes.position.count;
  geo.setAttribute('aLitAt', new THREE.BufferAttribute(new Float32Array(n).fill(at), 1));
  const xz = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { xz[i * 2] = x; xz[i * 2 + 1] = z; }
  geo.setAttribute('aLitXZ', new THREE.BufferAttribute(xz, 2));
  return geo;
}

/** When a pane of each kind may come on: shops first, homes and offices through the storm. */
const LIT_AT = { punched: [0.2, 0.92], ribbon: [0.25, 0.95], shop: [0.08, 0.5] };

/** How far a lit pane stands off the façade — past the glass (0.03), short of the door (0.09). */
const LIT_OUT = 0.045;

/** Share of each kind of opening that has a light on behind it. */
const LIT_SHARE = { punched: 0.3, ribbon: 0.34, shop: 0.75 };

/** Where the colours come from, and how often: mostly warm rooms, a few cool screens. */
const LIT_COLORS = [['litWarm', 0.55], ['litPale', 0.3], ['litCool', 0.15]];

/** Lamps per city block, and their proportions. */
const LAMPS_PER_BLOCK = 2;
const POST_H = 4.2;
const POST_W = 0.16;
const ARM_REACH = 1.5;       // out over the road, from the post
const POST_BACK = 0.45;      // in from the kerb edge onto the pavement
const HEAD = new THREE.Vector3(0.7, 0.14, 0.34);  // along the arm, tall, across
const POOL_R = 3.4;
const POOL_Y = 0.026;        // on the road, under the rain's mirror clip

/**
 * Start listening to the building generator. Call immediately before `createBuildings`, and call
 * the returned function immediately after: the sink is module state, and anything else that
 * builds a city — a probe sweeping seeds — must not have its panes kept.
 */
export function collectPanes() {
  const faces = [];
  setPaneSink((face) => { faces.push(face); });
  return () => {
    setPaneSink(null);
    return faces;
  };
}

function pickColor(rng) {
  let r = rng.next();
  for (const [name, share] of LIT_COLORS) {
    if ((r -= share) <= 0) return name;
  }
  return LIT_COLORS[0][0];
}

/** One merged mesh of lit panes, or null when nothing is lit. */
export function litWindows(rng, faces) {
  const parts = [];
  for (const { rects, side, cx, cz, hw, hd, kind } of faces) {
    const byColor = new Map();
    const [lo, hi] = LIT_AT[kind] ?? [0.3, 0.9];
    for (const rect of rects) {
      if (!rng.chance(LIT_SHARE[kind] ?? 0)) continue;
      const name = pickColor(rng);
      if (!byColor.has(name)) byColor.set(name, []);
      byColor.get(name).push({
        u: rect.u, y: rect.y, w: rect.w * 0.92, h: rect.h * 0.9, at: rng.range(lo, hi),
      });
    }
    for (const [name, lit] of byColor) {
      const geo = facadeQuads(lit, side, cx, cz, hw, hd, color(name), LIT_OUT);
      // facadeQuads writes six vertices per rect, in order. Each pane's anchor is its own centre.
      const at = new Float32Array(lit.length * 6);
      const xz = new Float32Array(lit.length * 12);
      const pos = geo.attributes.position.array;
      lit.forEach((rect, i) => {
        at.fill(rect.at, i * 6, i * 6 + 6);
        let x = 0;
        let z = 0;
        for (let v = i * 6; v < i * 6 + 6; v++) { x += pos[v * 3]; z += pos[v * 3 + 2]; }
        for (let v = i * 6; v < i * 6 + 6; v++) { xz[v * 2] = x / 6; xz[v * 2 + 1] = z / 6; }
      });
      geo.setAttribute('aLitAt', new THREE.BufferAttribute(at, 1));
      geo.setAttribute('aLitXZ', new THREE.BufferAttribute(xz, 2));
      parts.push(geo);
    }
  }
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  const mesh = new THREE.Mesh(merged, litSwitch(unlitMaterial({ vertexColors: true })));
  mesh.name = 'litWindows';
  return mesh;
}

/**
 * Street lamps on the city's blocks. Returns `{ posts, heads, pools }`: the posts are lit props
 * (so they go in the AO prepass — `markOccluder`), the heads are lamps (the bloom — `markEmissive`),
 * and the pools are additive light on the road. Posts and heads are stamped for the entrance wave
 * and belong in `createCityEntry`'s `meshes`; the pools, like the lit windows, should stay dark
 * until the wave is over — they are the city switching its lights on once it has arrived.
 */
export function streetLamps(rng, blocks) {
  const posts = [];
  const heads = [];
  const spots = [];
  const postCol = color('lampPost');
  const headCol = color('lampHead');

  for (const block of blocks) {
    if (block.type !== 'built' && block.type !== 'park') continue;
    const { x0, z0, x1, z1 } = block.bounds;
    // Four edges as (a point on the edge, the direction along it, the outward normal).
    const edges = [
      { ax: x0, az: z0, tx: 1, tz: 0, nx: 0, nz: -1, len: x1 - x0 },
      { ax: x0, az: z1, tx: 1, tz: 0, nx: 0, nz: 1, len: x1 - x0 },
      { ax: x0, az: z0, tx: 0, tz: 1, nx: -1, nz: 0, len: z1 - z0 },
      { ax: x1, az: z0, tx: 0, tz: 1, nx: 1, nz: 0, len: z1 - z0 },
    ];
    const chosen = new Set();
    while (chosen.size < LAMPS_PER_BLOCK) chosen.add(rng.int(0, 3));
    for (const e of chosen) {
      const edge = edges[e];
      // Clear of the rounded corners and the crossings beside them.
      const along = edge.len * rng.range(0.25, 0.75);
      const px = edge.ax + edge.tx * along - edge.nx * POST_BACK;
      const pz = edge.az + edge.tz * along - edge.nz * POST_BACK;
      const yaw = Math.atan2(-edge.nz, edge.nx);   // local +X points out over the road

      const post = new THREE.BoxGeometry(POST_W, POST_H, POST_W);
      post.translate(0, KERB_H + POST_H / 2, 0);
      const arm = new THREE.BoxGeometry(ARM_REACH + POST_W, 0.1, 0.1);
      arm.translate(ARM_REACH / 2, KERB_H + POST_H - 0.05, 0);
      const hood = new THREE.BoxGeometry(HEAD.x + 0.1, 0.1, HEAD.z + 0.08);
      hood.translate(ARM_REACH, KERB_H + POST_H - 0.05, 0);
      const head = new THREE.BoxGeometry(HEAD.x, HEAD.y, HEAD.z);
      head.translate(ARM_REACH, KERB_H + POST_H - 0.1 - HEAD.y / 2, 0);

      const place = new THREE.Matrix4().compose(
        new THREE.Vector3(px, 0, pz),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw),
        new THREE.Vector3(1, 1, 1),
      );
      // Stamped for the city's entrance wave (game/cityentry.js), so a lamp rises out of the
      // pavement with the block it stands on instead of hanging over an empty lot.
      const rand = hash01(px, pz);
      for (const g of [post, arm, hood]) {
        posts.push(stampEntry(bakeColor(g.applyMatrix4(place), postCol), px, pz, rand));
      }
      // Street lamps come on early and close together, the way a city's do on a photocell.
      const at = rng.range(0.28, 0.5);
      heads.push(stampLitAt(stampEntry(bakeColor(head.applyMatrix4(place), headCol), px, pz, rand), at, px, pz));
      spots.push(Object.assign(
        new THREE.Vector4(px + edge.nx * ARM_REACH, POOL_Y, pz + edge.nz * ARM_REACH, at), { px, pz }));
    }
  }
  if (!spots.length) return null;

  const postMesh = new THREE.Mesh(mergeGeometries(posts, false), propMaterial());
  postMesh.castShadow = true;
  postMesh.receiveShadow = true;
  postMesh.name = 'lampPosts';
  const headMesh = new THREE.Mesh(mergeGeometries(heads, false),
    litSwitch(unlitMaterial({ vertexColors: true })));
  headMesh.name = 'lampHeads';
  posts.forEach((p) => p.dispose());
  heads.forEach((p) => p.dispose());

  const pools = new THREE.InstancedMesh(poolGeometry(), poolMaterial(), spots.length);
  const m = new THREE.Matrix4();
  spots.forEach((p, i) => pools.setMatrixAt(i, m.makeTranslation(p.x, p.y, p.z)));
  pools.geometry.setAttribute('aLitAt', new THREE.InstancedBufferAttribute(
    new Float32Array(spots.map((p) => p.w)), 1));
  // The head's anchor, so a pool reads the same level and the same flicker as the lamp over it.
  pools.geometry.setAttribute('aLitXZ', new THREE.InstancedBufferAttribute(
    new Float32Array(spots.flatMap((p) => [p.px, p.pz])), 2));
  pools.renderOrder = 1;
  pools.name = 'lampPools';

  return { posts: postMesh, heads: headMesh, pools, spots };
}

/** A flat disc facing up, `uv` running 0..1 across it. */
function poolGeometry() {
  const geo = new THREE.PlaneGeometry(POOL_R * 2, POOL_R * 2);
  geo.rotateX(-Math.PI / 2);   // PlaneGeometry faces +Z; this turns it to face +Y
  return geo;
}

function poolMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: color('lampPool') }, uStrength: { value: 0.45 }, ...litUniforms(),
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      #include <common>
      attribute float aLitAt;
      attribute vec2 aLitXZ;
      ${LIT_UNIFORMS}
      varying vec2 vUv;
      varying float vOn;
      ${CLOUD_GLSL}
      ${LOCAL_LEVEL}
      ${LIT_ON}
      void main() {
        vUv = uv;
        vec2 litXZ = (modelMatrix * vec4(aLitXZ.x, 0.0, aLitXZ.y, 1.0)).xz;
        vOn = litOn(aLitAt, litLevelAt(litXZ), cloudHash(litXZ * 0.731 + aLitAt * 13.7));
        vec4 mvPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec2 vUv;
      varying float vOn;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float a = pow(max(0.0, 1.0 - d), 2.2) * vOn;
        gl_FragColor = vec4(uColor * a * uStrength, 1.0);
      }
    `,
  });
}

/**
 * The taxi's headlights: the same pods and light cones the fleet wears (geometry/lights.js), as
 * ordinary meshes to hang on `taxiGroup` — which is scaled by `TAXI_SCALE`, and both follow for
 * free. The cones hang on the body on purpose: they say where the light comes from, so they leave
 * the lamp wherever it is, and the road's depth cuts them where they meet it.
 *
 * There used to be a flat pool on the road under each one as well. Parented to the body it rose off
 * a ramp as a slab and cut into the asphalt on the way down; laid on the road instead, it read as a
 * second set of lights next to the cones. The cones carry the beam on their own.
 */
export function createTaxiHeadlights() {
  const group = new THREE.Group();
  group.name = 'taxiHeadlights';
  const podMaterial = headlightMaterial();
  const pods = new THREE.Group();
  const coneMaterial_ = coneMaterial();
  for (const anchor of headlightAnchors(CAR_LEN, CAR_W)) {
    const pod = new THREE.Mesh(headlightGeometry(), podMaterial);
    pod.position.copy(anchor);
    pods.add(pod);
    const cone = new THREE.Mesh(coneGeometry(), coneMaterial_);
    cone.name = 'taxiHeadlightCone';
    cone.position.copy(anchor);
    cone.quaternion.copy(coneQuat(anchor.z));
    cone.renderOrder = 1;
    group.add(cone);
  }
  group.add(pods);
  /**
   * 0..1, the same running-light level the fleet reads (`setRunningLights` in sim/traffic.js): off
   * in the sun, on once the storm is properly gloomy. A scale about each part's own origin — the
   * lamp — as the fleet's are, rather than `visible`, so switching on is not the frame a program
   * compiles.
   */
  const setLevel = (level) => { for (const part of group.children) part.scale.setScalar(level); };
  setLevel(0);
  return { group, pods, setLevel };
}
