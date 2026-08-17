import * as THREE from 'three';
import { PALETTE } from '../palette.js';

/**
 * The Euler order every body in the game poses with, and it is not the default.
 *
 * Everything that leans writes `rotation.set(roll, yaw, pitch, BODY_EULER_ORDER)`. Three composes
 * the default 'XYZ' as Rx·Ry·Rz, which puts the roll *outside* the yaw and so turns it about the
 * **world** X axis — which is the body's own long axis only when it happens to be heading east.
 * Drive north or south and the roll renders as pitch and the lean vanishes; drive west and it
 * leans the wrong way. 'YXZ' is Ry·Rx·Rz: yaw first, roll about the body, the same lean at every
 * heading.
 *
 * The two orders agree *exactly* at yaw 0, which is why this survived so long — and why the
 * passing lab, whose road runs due east, showed a lane-change bank that the game did not.
 * `tools/probe.mjs` asserts the constant reaches every body that leans.
 */
export const BODY_EULER_ORDER = 'YXZ';

/**
 * Normalizes a geometry into the form the whole project agrees on:
 *   - non-indexed, so computeVertexNormals() yields genuinely flat facets
 *   - a baked `color` attribute instead of a per-instance material
 *   - no uv/tangent attributes, which merge cleanly only when every input has them
 *
 * Baking colour into vertices is what lets hundreds of props collapse into a single merged
 * mesh sharing one material — the alternative (a material per tree) is both slower and
 * fiddlier to vary.
 */
export function bakeColor(geometry, colorInput) {
  // Converted here rather than left to `bakeColors`, which would otherwise do it a second time and
  // strand the first copy.
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;
  const c = colorInput instanceof THREE.Color ? colorInput : new THREE.Color(colorInput);
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  return bakeColors(geo, colors);
}

/**
 * The same, with a colour already written per vertex — for geometry that wants a *gradient* rather
 * than a flat fill.
 *
 * This works, and is worth writing down because it looks like it shouldn't: every mesh in this
 * project is `flatShading: true`, and the obvious expectation is that a flat-shaded surface takes
 * one colour per face. It does not. `FLAT_SHADED` only reaches the *normal*, which Three derives
 * from a screen-space derivative of the view position; `vColor` stays an ordinary interpolated
 * varying either way. So a gradient across a triangle costs nothing but the numbers — no extra
 * vertices, no second material, no texture. The window reflections in `city/buildings.js` are
 * built entirely out of that.
 */
export function bakeColors(geometry, colors) {
  const geo = geometry.index ? geometry.toNonIndexed() : geometry;

  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  return geo;
}

/**
 * Randomly displace every vertex — turns a regular solid into something hand-chiselled.
 *
 * Displacement is keyed by *position*, not by vertex index. Three's polyhedron geometries
 * (Icosahedron and friends) are non-indexed: every triangle carries its own copy of each corner.
 * Offsetting those copies independently pulls the shared corners apart and tears visible holes in
 * what should be a closed surface — which is exactly what the tree canopies were doing.
 */
export function jitterVertices(geometry, rng, amount) {
  const pos = geometry.attributes.position;
  const offsets = new Map();
  const key = (x, y, z) => `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const id = key(x, y, z);

    let offset = offsets.get(id);
    if (!offset) {
      offset = [rng.jitter(amount), rng.jitter(amount), rng.jitter(amount)];
      offsets.set(id, offset);
    }
    pos.setXYZ(i, x + offset[0], y + offset[1], z + offset[2]);
  }

  pos.needsUpdate = true;
  return geometry;
}

/**
 * Deterministic 0..1 hash of a ground position — the entrance animation's per-object jitter.
 *
 * A hash of the anchor rather than a draw from the generator's rng on purpose: stamping entry
 * anchors must not spend a draw, or adding the animation would reshuffle every building and tree
 * it animates. Same construction as the classic GLSL one-liner, so it needs no state.
 */
export function hash01(x, z) {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Stamp every vertex of a geometry with its object's entrance anchor: `aEntry = (cx, cz, rand)`.
 *
 * This is what lets the city-entrance animation (game/cityentry.js) grow whole buildings and
 * trees out of a single merged mesh: the merge erases object identity, so the identity rides in
 * a vertex attribute instead. `cx/cz` is the point the object scales out of, `rand` its share of
 * the per-object delay jitter. Call it *after* `bakeColor`/`bakeColors` — those strip every
 * attribute they don't know about.
 */
export function stampEntry(geometry, cx, cz, rand) {
  const count = geometry.attributes.position.count;
  const data = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    data[i * 3] = cx;
    data[i * 3 + 1] = cz;
    data[i * 3 + 2] = rand;
  }
  geometry.setAttribute('aEntry', new THREE.BufferAttribute(data, 3));
  return geometry;
}

/**
 * The one shared uniform bag every AO-lit material reads.
 *
 * `game/ssao.js` writes the texture and the texel size into it once, and every patched material
 * is handed these *same uniform objects* rather than copies — so one write reaches all of them.
 * Three reads `.value` at draw time, which is what makes that work.
 */
export const AO_UNIFORMS = {
  tAmbientOcclusion: { value: null },
  uAOTexel: { value: new THREE.Vector2(1, 1) },
};

let aoEnabled = false;

/**
 * Switch screen-space ambient occlusion on for every `propMaterial()` built after this call.
 * `main.js` calls it before any geometry is meshed.
 *
 * A build-time switch rather than a uniform on purpose: with AO off the patch is never installed,
 * so the extra texture fetch is *absent* rather than multiplied by one. Live tuning is the
 * strength uniform in `ssao.js`, which is a debug-panel concern and only exists when AO is on.
 */
export function setAmbientOcclusion(enabled) {
  aoEnabled = enabled;
}

export function ambientOcclusionEnabled() {
  return aoEnabled;
}

/**
 * Multiply the screen-space AO texture into a Lambert material's indirect term.
 *
 * **Indirect only.** Occlusion is a statement about how much of the sky reaches a crease, not
 * about whether the sun does — and this game's whole look is one lit face per building at golden
 * hour. Folding AO into the direct term as well greys those faces off and buys nothing the sun's
 * own shadow map isn't already saying.
 */
function patchAmbientOcclusion(material) {
  // Without this the patch silently does nothing. Three builds the program cache key from the
  // material's *parameters*, before `onBeforeCompile` has touched the source, so a patched
  // flat-shaded Lambert collides with every unpatched one sharing those parameters and
  // `acquireProgram` hands back whichever compiled first. This city is nothing but flat-shaded
  // Lambert — it is the same trap that once drew the diamond's fill with a building's shader.
  material.customProgramCacheKey = () => 'prop-ssao';

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, AO_UNIFORMS);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D tAmbientOcclusion;
uniform vec2 uAOTexel;`)
      // Three's own AO hook is the right seam: `reflectedLight` is complete by then and
      // `outgoingLight` has not been summed yet. Screen space, so the lookup is the fragment's
      // own position on screen — no uv, no second set of attributes.
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
	reflectedLight.indirectDiffuse *= texture2D(tAmbientOcclusion, gl_FragCoord.xy * uAOTexel).r;`);
  };
}

/**
 * A reflection crossing a car's glass as it drives — `propMaterial({ sheen: true })`.
 *
 * The same trick the buildings' windows run (see docs/rendering.md), turned inside out. A façade
 * never moves, so its highlight can be baked into the vertex colours once and read as glass forever
 * on a camera that never moves either. A car does nothing but move, and a highlight baked into its
 * glass travels with it — which is precisely the thing that says *paint* rather than *glass*: a
 * reflection is the one feature of a surface that is supposed to stay behind while the surface
 * slides out from under it.
 *
 * So the streak is a property of the **city**, not of the car. `vSheen` carries each vertex's world
 * position; the band is a function of that position alone, sampled per fragment. A car crossing a
 * junction drives through the field and its roof lights up and goes out again; a car standing at a
 * red holds whatever it stopped in; two cars nose to tail catch it a beat apart. Nothing is being
 * reflected and nothing is animated — there is no clock in here at all, which is also why a frozen
 * screenshot renders the same frame twice.
 *
 * Three details worth keeping:
 *
 * - **Per fragment, not per vertex.** The vertex shader is where this wanted to live: it is a
 *   handful of instructions on a car's dozen corners, and `vColor` is already interpolated. But a
 *   greenhouse is quads and a quad is two triangles, so a weight that varies across *both* axes of
 *   one shows the diagonal seam between them — the trap the curtain-wall bands are cut into
 *   segments to dodge. A cabin roof is one quad and there is nothing to cut it into.
 * - **Two wavelengths, neither a multiple of the other.** One band alone is a metronome: every car
 *   on a street glints at the same interval and the effect reads as a flashing light rather than as
 *   a sky. The second, much longer band crosses the first diagonally and gates it, so a street's
 *   worth of traffic catches it unevenly.
 * - **It multiplies into the diffuse term rather than the emissive**, so glass that catches the sky
 *   at golden hour goes quiet at midnight along with the sky it is catching.
 *
 * `aGloss` is the mask, tagged per vertex by `stampGloss` in geometry/carbody.js. Zero everywhere
 * but the greenhouse, and absent entirely on geometry that has no glass — WebGL hands the shader a
 * constant 0 for an attribute the buffer doesn't carry, so an untagged mesh simply opts out.
 */
const SHEEN_DIR = 'vec2(0.62, 0.78)';       // the band's own axis across the city
const SHEEN_FREQ = 0.34;                    // ~18 world units between bands, about a block
const SHEEN_GATE_DIR = 'vec2(-0.78, 0.62)'; // the long cross-band that breaks up the rhythm
const SHEEN_GATE_FREQ = 0.11;
const SHEEN_AMBIENT = 0.08;                 // the flat sky wash glass carries everywhere
const SHEEN_PEAK = 0.52;                    // and the most a band can add on top of it

function patchGlassSheen(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSheenColor = { value: new THREE.Color(PALETTE.windowSky) };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aGloss;
varying vec3 vSheen;`)
      // After `<project_vertex>`, so both `transformed` and `objectNormal` exist. The world matrix
      // is composed by hand rather than taken from `<worldpos_vertex>`: three only defines that
      // varying under a set of flags this material may or may not have (shadows can be switched
      // off from the URL), and an instanced car needs `instanceMatrix` folded in besides.
      .replace('#include <project_vertex>', `#include <project_vertex>
{
	mat4 sheenModel = modelMatrix;
	#ifdef USE_INSTANCING
		sheenModel = sheenModel * instanceMatrix;
	#endif
	vec3 sheenWorld = (sheenModel * vec4(transformed, 1.0)).xyz;
	vec3 sheenNormal = normalize(mat3(sheenModel) * objectNormal);
	// A pane facing the sky catches the most of it; the two faces this camera can see catch some.
	// Without the second term a car's flanks stayed dead while its roof lit, and the greenhouse
	// read as a lid rather than as glass wrapped round the cabin.
	float sky = max(0.0, sheenNormal.y);
	float toward = max(0.0, dot(sheenNormal, vec3(0.7071, 0.0, 0.7071)));
	vSheen = vec3(sheenWorld.xz, aGloss * (0.30 + 0.70 * max(sky, 0.75 * toward)));
}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uSheenColor;
varying vec3 vSheen;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
	float band = sin(dot(vSheen.xy, ${SHEEN_DIR}) * ${SHEEN_FREQ.toFixed(3)}) * 0.5 + 0.5;
	float gate = sin(dot(vSheen.xy, ${SHEEN_GATE_DIR}) * ${SHEEN_GATE_FREQ.toFixed(3)}) * 0.5 + 0.5;
	// Cubed: a raw sine spends half its length above the midpoint, which is a wash rather than a
	// streak. This leaves most of the field dark and the highlight narrow.
	float sheen = vSheen.z * (${SHEEN_AMBIENT.toFixed(3)}
		+ ${SHEEN_PEAK.toFixed(3)} * pow(band, 3.0) * (0.35 + 0.65 * gate));
	diffuseColor.rgb = mix(diffuseColor.rgb, uSheenColor, sheen);
}`);
  };
}

/**
 * The shared material for every merged prop mesh.
 *
 * `sheen` adds the moving glass reflection above, and is for the vehicles. Both patches compose:
 * they touch different hooks, and the cache key is built from whichever are actually installed —
 * three builds that key from the material's *parameters*, before `onBeforeCompile` runs, so any
 * two patched flat-shaded Lamberts collide unless they say otherwise. This city is nothing but
 * flat-shaded Lambert.
 */
export function propMaterial({ sheen = false } = {}) {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const patches = [];
  if (aoEnabled) patches.push(['ssao', patchAmbientOcclusion]);
  if (sheen) patches.push(['sheen', patchGlassSheen]);
  if (patches.length === 0) return material;

  // One `onBeforeCompile` per material, so a second patch has to chain rather than replace — which
  // is what the first attempt did, silently, leaving every car's AO lookup uninstalled.
  const compilers = patches.map(([, patch]) => { patch(material); return material.onBeforeCompile; });
  material.onBeforeCompile = (shader, renderer) => {
    for (const compile of compilers) compile(shader, renderer);
  };
  material.customProgramCacheKey = () => `prop-${patches.map(([key]) => key).join('-')}`;
  return material;
}

/**
 * The other half of that pair: the recipe for everything **unlit** — every game marker, every
 * effect drawn as flat colour, and the handful of lamps and rotor discs that a light source has no
 * say over.
 *
 * All it does is turn the haze off (`game/scene.js`), and the rule it carries is **anything that
 * doesn't take the sun doesn't take the air either**. It is the same argument that made these
 * materials unlit in the first place. A fare's disc is painted in that fare's clock and a ring at
 * the back of the board is the one the player is furthest from and most needs to read; a wreck is
 * meant to look identical at midnight and at golden hour. Both of those survive the day/night cycle
 * precisely *because* nothing in the lighting reaches them — and fog is lighting. Distance-fogged,
 * a marker across town would report a colour between its own and the sky's, which for a marker
 * whose entire content is its hue means reporting the wrong time remaining.
 *
 * So: if it is `MeshBasicMaterial`, it comes through here. `tools/probe.mjs` scans the source for
 * the ones that don't — the exemption is an invisible raycast box, which draws nothing to fog.
 */
export function unlitMaterial(params = {}) {
  return new THREE.MeshBasicMaterial({ fog: false, ...params });
}
