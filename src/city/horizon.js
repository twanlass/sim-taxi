import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { color, jitterColor } from '../palette.js';
import {
  WEST_CORNER, WEST_COLUMNS, GRID_J, HALF_ROAD, lineX, lineZ, halfRoadX, isRiverBlock, coastWest, coastSouth,
} from './grid.js';
import { KERB_H } from './ground.js';
import { northParkBounds } from './northpark.js';
import { splitLot } from './buildings.js';
import { WEST_SKYLINE } from './westedge.js';
import { SKY_RADIUS, SKY_DROP } from '../game/scene.js';

// The city past the edge of the map (`?horizon=classic` for the bare edge).
//
// Tyler, 2026-10-14, circling the empty band past the west towers where the asphalt fades out against
// the sky: "Can we fill in with some more buildings then some fog to obscure the edge? Wanna create
// the illusion that the world goes on forever". So the grid carries on past the west edge and past
// the north park, block after block on the city's own pitch, and the further out a block stands the
// more of it is the sky behind it, until there is nothing left of it but sky.
//
// **Why the haze is its own and not the scene's fog.** The scene's fog is a function of screen
// height alone under this camera (see `hazeRange` in game/scene.js), so it cannot thicken *past the
// coast* without thickening over the top of the playable city by the same amount. This one is a
// function of where a fragment stands on the ground: nothing on the island wears it, and out here it
// runs all the way to opaque.
//
// **Why it fades to the sky and not to the fog colour.** What the edge used to dissolve into was the
// sky dome, and the haze colour is deliberately *not* the sky (it is the dome sampled high and
// saturated — see `hazeColor`). A fade to it would leave a band of a different blue standing over
// the horizon. So each fragment works out which point of the dome sits behind it — the camera is
// orthographic, so that is one ray along its own view axis to the dome's sphere — and runs the
// dome's own gradient there. It reads the dome's own uniform objects, so the day cycle, the rain's
// mood and the ⚙️ panel's sky sliders all move it with no wiring. Where it is fully hazed it is not
// "close to" the sky, it is the sky's exact pixel.
//
// Scenery and cheap on purpose: one mesh, one draw, plain boxes with no windows (by the time a block
// is far enough out to need filling it is a third haze), no shadow cast, no AO, no entrance wave.
// It sits at the edge of the shadow frustum and past it, so it receives shadows where the sun's map
// reaches and is plainly lit beyond. Its own rng stream.
//
// **Every street stays open.** Blocks go down on the grid's own pitch, so every street of the city
// carries on out through the haze as a clear corridor — which is also the corridor the L train's
// westward line needs.

export const HORIZON = WEST_CORNER && (typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('horizon') !== 'classic'
  : globalThis.process?.env?.HORIZON !== 'classic');

// --- Where the haze is measured from ------------------------------------------------------------
//
// From the last *street* on each side rather than from the coast, so the first ring of filler is
// already wearing a little air and does not stand beside the island's own high rises reading as the
// same city with its windows missing. The island's transparent fade skirt runs over the near edge of
// the ground below, so the two hand over on the skirt's own curve.

/** How far out past the start line the haze takes everything. Tuned on a phone-shaped frame. */
export const HORIZON_GONE = 92;
// The curve: a little under linear near the island, so the first two rings of towers still read as
// towers, then the smoothstep's shoulder lays the rest into the sky.
const HAZE_BIAS = 0.82;
// The two ends the filler does not run on into a horizon of its own: the south shore (sea) and the
// north park's east end (the park shore's rocks and the sea). It feathers into the sky there over
// this much ground rather than stopping on a line.
const SIDE_FEATHER = 14;

// The towers. West carries on the skyline, under `WEST_SKYLINE` (the aeroplane's floor); north of the
// park stays under the city's own ceiling, because the helicopters transit at 22 and nothing
// keeps them out of the north the way `WEST_CLEAR_X` keeps them out of the west.
const WEST_H = [12, 34];
const NORTH_H = [8, 19];
// Bigger than the city's lots: a far skyline is a few broad masses, not a crowd.
const LOT_DEPTH = 1;
// A share of the taller towers carry a set-back crown: the one detail that survives the haze.
const CROWN_CHANCE = 0.45;
const CROWN_FROM = 20;
const FAMILIES = ['concrete', 'pale', 'tan', 'brick', 'glass', 'slate', 'glass', 'slate'];

// The painted windows (see the patch): a storey, a bay, the share of each that is frame, and how
// dark the glass is against the wall. The city's own towers run about this rhythm.
const WINDOW_STOREY = 2.3;
const WINDOW_BAY = 2.0;
const WINDOW_FRAME = 0.22;
const WINDOW_SILL = 0.3;
const WINDOW_HEAD = 0.78;
const WINDOW_DARK = 0.6;
const WINDOW_FROM = 1.6;

// Under the island's slab (y 0) and the corner patch (-0.03), so where the three overlap the island
// wins the depth test and this only ever shows where the island has stopped.
const GROUND_Y = -0.06;

/** The outline the haze is measured from, and the two side cut-offs. Exported for the probe. */
export function horizonEdges() {
  const park = northParkBounds();
  return {
    // The haze's start lines: the last street to the west and the corner's last street to the north.
    west: lineX(-WEST_COLUMNS),
    north: lineZ(-2),
    // Where the filler starts to stop on the two sides that face the sea: gone into the sky by the
    // south coast, so the ground never lies over the sea beyond it, and east of the north park.
    south: coastSouth() - SIDE_FEATHER,
    east: park.x1,
    // Where the island's own land stops, which nothing here may stand inside: the west towers'
    // last kerb, the corner's north kerb, and the park's north edge.
    landW: lineX(-WEST_COLUMNS) - HALF_ROAD,
    landNCorner: lineZ(-2) - HALF_ROAD,
    landNPark: park.z0,
    parkX0: park.x0,
  };
}

/** The haze fraction at a point on the ground, 0 on the island to 1 at the sky. JS twin of the GLSL. */
export function hazeAt(x, z, e = horizonEdges()) {
  const dx = Math.max(e.west - x, 0);
  const dz = Math.max(e.north - z, 0);
  const t = Math.min(1, Math.hypot(dx, dz) / HORIZON_GONE);
  const s = Math.pow(t, HAZE_BIAS);
  const out = s * s * (3 - 2 * s);
  const side = Math.max(smooth01((z - e.south) / SIDE_FEATHER), smooth01((x - e.east) / SIDE_FEATHER));
  return Math.max(out, side);
}

const smooth01 = (t) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/** The blocks out here, on the grid's own pitch: bounds and which band. */
export function horizonBlocks(e = horizonEdges()) {
  const out = [];
  const reach = HORIZON_GONE + 4;
  const biMin = Math.floor((e.west - reach - lineX(0)) / (lineX(1) - lineX(0)));
  const bjMin = Math.floor((e.north - reach - lineZ(0)) / (lineZ(1) - lineZ(0)));
  for (let bi = biMin; ; bi++) {
    const x0 = lineX(bi) + HALF_ROAD;
    const x1 = lineX(bi + 1) - HALF_ROAD;
    if (x1 > e.east) break;
    for (let bj = bjMin; bj < GRID_J; bj++) {
      const z0 = lineZ(bj) + halfRoadX(bj);
      const z1 = lineZ(bj + 1) - halfRoadX(bj + 1);
      if (isRiverBlock(-1, bj)) continue;
      const west = x1 <= e.landW + 1e-6;
      // North of the corner's last street west of the park, north of the park's own edge over it.
      const landN = x1 <= e.parkX0 ? e.landNCorner : e.landNPark;
      const north = z1 <= landN + 1e-6;
      if (!west && !north) continue;
      const bounds = { x0, x1, z0, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
      // Nothing that would be all sky anyway.
      if (hazeAt(bounds.cx, bounds.cz, e) > 0.97) continue;
      out.push({ bi, bj, band: west ? 'west' : 'north', bounds });
    }
  }
  return out;
}

/**
 * @param sky  the dome's uniforms (`createScene().sky.uniforms`): read live, never copied, so the
 *             haze is always this frame's sky.
 */
export function createHorizon(rng, sky) {
  if (!HORIZON) return null;
  const e = horizonEdges();
  const parts = [];

  // --- The ground: one L of asphalt outside the island, from just under its edge to past the point
  // where the haze has taken everything. Two rects that meet without overlapping.
  const far = HORIZON_GONE + 30;
  const xF = e.west - far;
  const zF = e.north - far;
  const xW = coastWest() + 1;
  const zN = e.landNPark + 1;
  const zS = e.south + SIDE_FEATHER;
  const xE = e.east + SIDE_FEATHER + 2;
  const asphalt = color('asphalt');
  const rect = (x0, x1, z0, z1) => {
    const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    g.rotateX(-Math.PI / 2);
    g.translate((x0 + x1) / 2, GROUND_Y, (z0 + z1) / 2);
    parts.push(bakeColor(g, asphalt));
  };
  rect(xF, xW, zF, zS);
  rect(xW, xE, zF, zN);

  // --- The blocks: a kerb-high pavement box each, and the towers on it.
  const walk = () => jitterColor(color('sidewalk'), rng, { l: 0.03 });
  for (const block of horizonBlocks(e)) {
    const { x0, x1, z0, z1, cx, cz } = block.bounds;
    // A plain box rather than the city's rounded kerb: the rounding is 200 triangles a block, and
    // out here it is a pixel or two of corner under the haze.
    const kerb = new THREE.BoxGeometry(x1 - x0, KERB_H, z1 - z0);
    kerb.translate(cx, KERB_H / 2, cz);
    parts.push(bakeColor(kerb, walk()));
    const [lo, hi] = block.band === 'west' ? WEST_H : NORTH_H;
    for (const lot of splitLot(x0, z0, x1, z1, LOT_DEPTH, rng)) {
      const inset = 1.1;
      const w = lot.x1 - lot.x0 - inset * 2;
      const d = lot.z1 - lot.z0 - inset * 2;
      if (w < 3 || d < 3) continue;
      const h = Math.min(rng.range(lo, hi), WEST_SKYLINE - 6);
      const lx = (lot.x0 + lot.x1) / 2;
      const lz = (lot.z0 + lot.z1) / 2;
      const body = jitterColor(color(rng.pick(FAMILIES)), rng, { l: 0.05 });
      const box = new THREE.BoxGeometry(w, h, d);
      box.translate(lx, KERB_H + h / 2, lz);
      parts.push(bakeColor(box, body));
      if (h > CROWN_FROM && rng.chance(CROWN_CHANCE)) {
        const k = rng.range(0.55, 0.75);
        const ch = Math.min(h * rng.range(0.12, 0.22), WEST_SKYLINE - KERB_H - h);
        const crown = new THREE.BoxGeometry(w * k, ch, d * k);
        crown.translate(lx, KERB_H + h + ch / 2, lz);
        parts.push(bakeColor(crown, body.clone().multiplyScalar(0.92)));
      }
    }
  }

  const geometry = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  const material = hazeMaterial(propMaterial({ ao: false }), sky, e);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'horizon';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return { mesh, edges: e };
}

/** The anchor the haze goes in after: three's fog, so the scene's own haze has had its say first. */
export const HORIZON_ANCHOR = '#include <fog_fragment>';

/**
 * Patch a material so it fades into the sky dome behind it, by where each fragment stands. Composed
 * onto whatever patch the material already carries, and keyed off that patch's own key (CLAUDE.md:
 * the key is a promise about source).
 *
 * No backticks in the GLSL comments below: a backtick ends the template literal (CLAUDE.md).
 */
export function hazeMaterial(material, sky, e = horizonEdges()) {
  const base = material.onBeforeCompile;
  const baseKey = material.customProgramCacheKey();
  material.customProgramCacheKey = () => `${baseKey}-horizon`;
  const uniforms = {
    uHzSkyTop: sky.topColor,
    uHzSkyBottom: sky.bottomColor,
    uHzSkyExp: sky.exponent,
    uHzEdge: { value: new THREE.Vector4(e.west, e.north, e.south, e.east) },
    uHzBand: { value: new THREE.Vector3(HORIZON_GONE, HAZE_BIAS, SIDE_FEATHER) },
  };
  material.onBeforeCompile = (shader, renderer) => {
    base.call(material, shader, renderer);
    if (!shader.vertexShader.includes('#include <project_vertex>') || !shader.fragmentShader.includes(HORIZON_ANCHOR)) {
      throw new Error('horizon: haze patch found no anchor in the shader');
    }
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying vec3 vHzWorld;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vHzWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uHzSkyTop;
uniform vec3 uHzSkyBottom;
uniform float uHzSkyExp;
uniform vec4 uHzEdge;
uniform vec3 uHzBand;
varying vec3 vHzWorld;`)
      .replace(HORIZON_ANCHOR, `${HORIZON_ANCHOR}
{
  // How far out past the island this fragment stands, on the ground.
  vec2 hzOut = max(vec2(uHzEdge.x - vHzWorld.x, uHzEdge.y - vHzWorld.z), 0.0);
  float hzT = pow(clamp(length(hzOut) / uHzBand.x, 0.0, 1.0), uHzBand.y);
  float hzF = hzT * hzT * (3.0 - 2.0 * hzT);
  hzF = max(hzF, smoothstep(0.0, 1.0, (vHzWorld.z - uHzEdge.z) / uHzBand.z));
  hzF = max(hzF, smoothstep(0.0, 1.0, (vHzWorld.x - uHzEdge.w) / uHzBand.z));
  // The dome behind it: the camera is orthographic, so the ray on through this fragment runs
  // along the view axis, and the dome is a sphere about the origin (SKY_RADIUS in game/scene.js).
  vec3 hzDir = -normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  float hzB = dot(vHzWorld, hzDir);
  float hzC = dot(vHzWorld, vHzWorld) - ${(SKY_RADIUS * SKY_RADIUS).toFixed(1)};
  vec3 hzSky = vHzWorld + hzDir * (-hzB + sqrt(max(hzB * hzB - hzC, 0.0)));
  float hzH = normalize(hzSky + vec3(0.0, ${SKY_DROP.toFixed(1)}, 0.0)).y;
  vec3 hzCol = mix(uHzSkyBottom, uHzSkyTop, pow(max(hzH, 0.0), uHzSkyExp));
  // Windows, drawn rather than built: a box this far out is a plain box, and a grid of darker
  // cells on its walls is the one detail that still says building through the haze. A wall is
  // whatever the screen-space normal says is vertical; a cell is a storey tall and a bay wide,
  // measured along whichever horizontal axis the wall runs on.
  vec3 hzN = normalize(cross(dFdx(vHzWorld), dFdy(vHzWorld)));
  if (abs(hzN.y) < 0.5 && vHzWorld.y > ${WINDOW_FROM.toFixed(2)}) {
    float hzAlong = abs(hzN.x) > abs(hzN.z) ? vHzWorld.z : vHzWorld.x;
    vec2 hzCell = fract(vec2(hzAlong / ${WINDOW_BAY.toFixed(2)}, vHzWorld.y / ${WINDOW_STOREY.toFixed(2)}));
    float hzWin = step(${WINDOW_FRAME.toFixed(2)}, hzCell.x) * step(hzCell.x, ${(1 - WINDOW_FRAME).toFixed(2)})
      * step(${WINDOW_SILL.toFixed(2)}, hzCell.y) * step(hzCell.y, ${WINDOW_HEAD.toFixed(2)});
    gl_FragColor.rgb *= mix(1.0, ${WINDOW_DARK.toFixed(2)}, hzWin);
  }
  gl_FragColor.rgb = mix(gl_FragColor.rgb, hzCol, hzF);
}`);
  };
  return material;
}
