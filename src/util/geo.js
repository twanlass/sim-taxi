import * as THREE from 'three';

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

/**
 * The matching bag for Crayon Mode — same contract as `AO_UNIFORMS` above, written by
 * `game/crayon.js` and read by every material `patchProp` touches.
 *
 * `uCrayonPaperScale` turns a `gl_FragCoord` into tile uv and `uCrayonPixelRatio` converts a
 * distance stated in CSS pixels into the device pixels `gl_FragCoord` is measured in. Both carry
 * the pixel ratio for the same reason: a tooth or a wobble stated in device pixels halves on a
 * DPR-2 phone and stops reading at all.
 */
export const CRAYON_UNIFORMS = {
  tCrayonPaper: { value: null },
  uCrayonPaperScale: { value: new THREE.Vector2(1, 1) },
  uCrayonBoil: { value: new THREE.Vector2() },
  uCrayonInk: { value: new THREE.Color() },
  uCrayonGrain: { value: 0 },
  uCrayonBlotch: { value: 0 },
  uCrayonQuantize: { value: 0 },
  uCrayonLine: { value: 0 },
  uCrayonWobble: { value: 0 },
  uCrayonPixelRatio: { value: 1 },
};

let aoEnabled = false;
let crayonEnabled = false;

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
 * Switch Crayon Mode on for every `propMaterial()` built after this call — `?crayon`, and
 * `main.js` calls it in the same breath as `setAmbientOcclusion`, before any geometry is meshed.
 *
 * Build-time for exactly the reason AO is: with it off, not one material carries the paper fetch.
 * Everything a player would want to move afterwards is a uniform on the ⚙️ panel instead.
 */
export function setCrayon(enabled) {
  crayonEnabled = enabled;
}

export function crayonEnabledFlag() {
  return crayonEnabled;
}

// The crayon body, spliced in **before `#include <fog_fragment>`** — see `patchProp` for why that
// seam and not an earlier one.
//
// Everything here is keyed off `gl_FragCoord`. That is not a shortcut: `bakeColor()` strips every
// attribute but position and normal, so there is no uv to reach for — and a drawing wants screen
// space anyway. The page does not slide when the camera pans, because a page doesn't.
const CRAYON_FRAGMENT = /* glsl */ `
	{
		vec2 cPx = gl_FragCoord.xy;
		vec2 cUv = cPx * uCrayonPaperScale + uCrayonBoil;
		// Two fetches. The fine one is the tooth; the coarse one is the same tile read a fifth as
		// often, and its blue channel — an uncorrelated per-texel draw, smoothed by the sampler at
		// this scale — is the wander that bends the ink line off straight.
		vec4 cFine = texture2D(tCrayonPaper, cUv);
		vec4 cCoarse = texture2D(tCrayonPaper, cUv * 0.19 + 0.37);

		float cLum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));

		// The tooth, weighted to the mid-tones by 4*l*(1-l). Wax is patchy where it is thin and
		// solid where it is piled up, so a flat amplitude both dirties the highlights and lifts
		// speckle out of the shadows — the two places a drawing has none.
		float cWeight = 4.0 * cLum * (1.0 - cLum);
		float cGrain = 1.0
			+ uCrayonGrain * cWeight * (cFine.r - 0.5) * 2.0
			+ uCrayonBlotch * (cCoarse.g - 0.5);
		gl_FragColor.rgb *= cGrain;

		// Quantisation, and it is **luminance only**. Hue is content in this game — a fare's ring
		// is its clock, yellow is the player's car, cyan is a parcel — and tools/probe.mjs
		// asserts measured hue separations between them. Scaling rgb to hit a stepped luminance
		// leaves every one of those ratios exactly where it was.
		if (uCrayonQuantize > 0.0) {
			float cSteps = 4.0;
			float cQ = floor(cLum * cSteps + 0.5) / cSteps;
			gl_FragColor.rgb *= mix(1.0, cQ / max(cLum, 0.0001), uCrayonQuantize);
		}

		// The ink. .g of the AO texture is the edge term game/ssao.js takes at one texel —
		// silhouettes saturate it, creases leave it partial, and a flat receding plane cancels it
		// exactly. The lookup wanders by up to uCrayonWobble CSS pixels, and the paper breaks the
		// stroke up so it skips rather than ruling solid.
		//
		// Broken by the **coarse** fetch, not the fine one. The tooth is 2px, so modulating the
		// line with it dithers the stroke pixel by pixel and the whole thing reads as noise along
		// an edge rather than as a mark. At a fifth of that frequency the skips run eight or ten
		// pixels, which is a crayon lifting off the page. And the floor is 0.72 rather than 0.5:
		// under about two thirds the gaps stop being skips and start being a dashed line.
		if (uCrayonLine > 0.0) {
			vec2 cWander = vec2(cCoarse.b, cCoarse.a) - 0.5;
			vec2 cInkUv = (cPx + cWander * uCrayonWobble * uCrayonPixelRatio) * uAOTexel;
			float cEdge = texture2D(tAmbientOcclusion, cInkUv).g;
			float cInk = clamp(uCrayonLine * cEdge * mix(0.72, 1.0, cCoarse.r), 0.0, 1.0);
			gl_FragColor.rgb = mix(gl_FragColor.rgb, uCrayonInk, cInk);
		}
	}
`;

/**
 * The one patch every lit prop material carries — screen-space AO, Crayon Mode, or both.
 *
 * **AO: indirect only.** Occlusion is a statement about how much of the sky reaches a crease, not
 * about whether the sun does — and this game's whole look is one lit face per building at golden
 * hour. Folding AO into the direct term as well greys those faces off and buys nothing the sun's
 * own shadow map isn't already saying.
 *
 * **Crayon: after the colour space, before the haze.** By `<fog_fragment>` three has already run
 * `<opaque_fragment>`, `<tonemapping_fragment>` and `<colorspace_fragment>`, so `gl_FragColor` is
 * in display space — which is where a paint-like multiply belongs, and where "mid-tone" means what
 * an eye means by it. And the haze has *not* run, so a stroke at the back of the city fades into
 * the air exactly as the façade under it does. Hooking `<dithering_fragment>` instead would ink
 * lines at full strength across a hazed skyline.
 */
function patchProp(material) {
  // Without this the patch silently does nothing. Three builds the program cache key from the
  // material's *parameters*, before `onBeforeCompile` has touched the source, so a patched
  // flat-shaded Lambert collides with every unpatched one sharing those parameters and
  // `acquireProgram` hands back whichever compiled first. This city is nothing but flat-shaded
  // Lambert — it is the same trap that once drew the diamond's fill with a building's shader.
  //
  // Composed out of both flags rather than one string, because the two are independent: with
  // `?crayon&ao=off` a crayoned material and a bare one would otherwise share a key.
  const key = `prop${aoEnabled ? '-ssao' : ''}${crayonEnabled ? '-crayon' : ''}`;
  material.customProgramCacheKey = () => key;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, AO_UNIFORMS);
    if (crayonEnabled) Object.assign(shader.uniforms, CRAYON_UNIFORMS);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D tAmbientOcclusion;
uniform vec2 uAOTexel;${crayonEnabled ? `
uniform sampler2D tCrayonPaper;
uniform vec2 uCrayonPaperScale;
uniform vec2 uCrayonBoil;
uniform vec3 uCrayonInk;
uniform float uCrayonGrain;
uniform float uCrayonBlotch;
uniform float uCrayonQuantize;
uniform float uCrayonLine;
uniform float uCrayonWobble;
uniform float uCrayonPixelRatio;` : ''}`);

    if (aoEnabled) {
      // Three's own AO hook is the right seam: `reflectedLight` is complete by then and
      // `outgoingLight` has not been summed yet. Screen space, so the lookup is the fragment's
      // own position on screen — no uv, no second set of attributes.
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
	reflectedLight.indirectDiffuse *= texture2D(tAmbientOcclusion, gl_FragCoord.xy * uAOTexel).r;`);
    }

    if (crayonEnabled) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <fog_fragment>', `${CRAYON_FRAGMENT}
#include <fog_fragment>`);
    }
  };
}

/** The shared material for every merged prop mesh. */
export function propMaterial() {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  if (aoEnabled || crayonEnabled) patchProp(material);
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
