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

/**
 * And Cartoon Mode's. Same contract again — written by `game/cartoon.js`, read by every material
 * `patchProp` touches.
 *
 * `uToonInkColor` is stored **sRGB-encoded**, because the ink is mixed in after three's
 * `<colorspace_fragment>` has run. A `THREE.Color` built from a hex string is in the linear
 * working space; the frame at that point in the shader is not.
 */
export const CARTOON_UNIFORMS = {
  uToonCel: { value: 0 },
  uToonSteps: { value: 3 },
  uToonInk: { value: 0 },
  uToonBite: { value: 0.5 },
  uToonInkColor: { value: new THREE.Color() },
};

/**
 * The shadow tint — the one lighting control in here that is **not** behind a build-time flag.
 *
 * It is part of the shipped look rather than an opt-in mode (`SHADOW_TINT` below), so there is
 * nothing to gate: `propMaterial()` patches unconditionally. It would not deserve a flag either
 * way — unlike AO, the crayon and the cartoon it costs no texture fetch, only a dot product and a
 * mix, and at amount 0 that mix is against 1.0 and the frame comes out bit-identical to an
 * unpatched one.
 *
 * `uShadowColor` is stored **pre-scaled** by `clamp(1 / luminance, 0.5, 3)` — see
 * `setShadowTint()` for why the clamp is load-bearing.
 */
export const SHADOW_UNIFORMS = {
  uShadowColor: { value: new THREE.Color(1, 1, 1) },
  uShadowTint: { value: 0 },
};

/**
 * How far the shade is pushed toward `PALETTE.shadowTint` in the shipped game.
 *
 * 0.65 rather than the full push: at 1.0 the shade takes the tint's hue outright and the city reads
 * as lit by two coloured lamps, which loses the *material* of what is in shadow — a red brick wall
 * and a grey one go the same blue. Two thirds keeps each surface's own hue legible underneath while
 * still opening a clear warm/cool split between what the sun reaches and what it doesn't.
 */
export const SHADOW_TINT = 0.65;

const shadowTintState = { color: PALETTE.shadowTint, amount: SHADOW_TINT };

/**
 * Point the shade at a colour, and say how far to push it.
 *
 * The gain is the whole subtlety. The tint is applied as `uShadowColor * indirectLuminance`, so a
 * colour has to be normalised or a dark pick would double as a brightness cut — and normalising by
 * luminance alone explodes on a saturated one: pure blue has a luminance of 0.0722, so 1/luma is
 * 13.8 and the shade comes back as a blue three times brighter than the sunlit faces beside it.
 * Clamped to 3 it saturates instead of blowing out; clamped at the bottom to 0.5 so a near-white
 * pick cannot silently darken either.
 *
 * @param color   any THREE.Color input — the hex string the panel's colour well produces.
 * @param amount  0 leaves the frame exactly as it was, 1 is the full push.
 */
export function setShadowTint({ color = shadowTintState.color, amount = shadowTintState.amount } = {}) {
  shadowTintState.color = color;
  shadowTintState.amount = amount;
  const picked = new THREE.Color(color);
  const luma = picked.r * 0.2126 + picked.g * 0.7152 + picked.b * 0.0722;
  const gain = THREE.MathUtils.clamp(1 / Math.max(luma, 1e-4), 0.5, 3);
  SHADOW_UNIFORMS.uShadowColor.value.copy(picked).multiplyScalar(gain);
  SHADOW_UNIFORMS.uShadowTint.value = amount;
}

/** What the panel opens on. */
export function shadowTint() {
  return { ...shadowTintState };
}

// Seed the uniforms from those defaults. Needed because the bag above is declared with the neutral
// values — nothing else calls this at boot, so without it the shipped default would be "off" and
// the panel would open reading 0.65 over a frame that had none of it.
setShadowTint();

let aoEnabled = false;
let crayonEnabled = false;
let cartoonEnabled = false;

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

/**
 * Switch Cartoon Mode on for every `propMaterial()` built after this call — `?cartoon`, decided in
 * `main.js` beside the other two and before any geometry is meshed.
 *
 * The hero outlines in `game/cartoon.js` are hulls rather than shader work, but the cel bands and
 * the city's ink are both compiled in here, so the same build-time rule applies.
 */
export function setCartoon(enabled) {
  cartoonEnabled = enabled;
}

export function cartoonEnabledFlag() {
  return cartoonEnabled;
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

// Cartoon Mode's cel bands, spliced in after three's own lights_fragment_end — the first point at
// which reflectedLight.directDiffuse is final, shadow map included.
//
// It is quantised as a **ratio against the albedo**, not as a colour. Dividing the direct term by
// the surface's own luminance recovers roughly the N dot L times the sun, which is the number a
// toon ramp is actually about; banding the colour itself would band a dark brick and a pale
// concrete at different points on their own falloff and put the terminator in a different place on
// each. Scaling rgb back by a scalar leaves every channel ratio — every hue in palette.js —
// exactly where it was.
//
// Flat shading is what makes this cheap and clean: every facet has one normal, so N dot L is
// constant across it and a band edge can never crawl over a surface. The one thing that does vary
// per fragment is the shadow map, so what the bands actually cut into hard steps is PCF's soft
// penumbra — which is the cartoon look, arrived at for free.
const CARTOON_LIGHT = /* glsl */ `
	{
		float tLum = dot(reflectedLight.directDiffuse, vec3(0.2126, 0.7152, 0.0722));
		float tAlbedo = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
		float tRatio = tLum / max(tAlbedo, 0.0001);
		// Band centres rather than band floors, so the lit end keeps its brightness instead of the
		// whole city stepping down by half a band.
		float tBand = (floor(tRatio * uToonSteps) + 0.5) / uToonSteps;
		reflectedLight.directDiffuse *= mix(1.0, tBand / max(tRatio, 0.0001), uToonCel);
	}
`;

// And its ink, spliced in before fog_fragment beside the crayon's — same seam, same reasons: the
// frame is in display space by then, and the haze has not run, so a line at the back of the city
// sits behind the same air as the wall it traces.
//
// The edge arrives already ramped by game/ssao.js, so uToonBite is a *second* threshold on top of
// that one. It is high (0.42 against the crayon taking everything it can find) because the two
// looks want opposite things from the same signal: a drawing is a lot of tentative marks, and a
// cartoon is a few confident ones. There is no tooth and no wander here for the same reason.
const CARTOON_INK = /* glsl */ `
	{
		float tEdge = texture2D(tAmbientOcclusion, gl_FragCoord.xy * uAOTexel).g;
		float tInk = smoothstep(uToonBite, 1.0, tEdge) * uToonInk;
		gl_FragColor.rgb = mix(gl_FragColor.rgb, uToonInkColor, tInk);
	}
`;

// The shadow tint, spliced in after three's lights_fragment_end — and after the cartoon's bands,
// so that with Cartoon Mode on the tint steps with the cel rather than smearing across it.
//
// **The shade factor is a ratio between the two light terms, not a shadow-map lookup.** Three only
// defines getShadowMask() for ShadowMaterial; pulling that chunk into a Lambert would work and
// would cost a second full PCF loop per fragment, on a game that runs on phones. What is already
// in scope at this seam is both halves of the lighting, and their *ratio* answers the question
// directly: fill over total is "how much of the light here is sky rather than sun". A cast shadow
// has no direct term at all and comes out at 1; so does a wall the sun is behind, which is the
// point — a cast shadow tinted blue beside an untinted dark wall reads as a bug, not as art
// direction.
//
// Scale-free by construction, which is what keeps it honest across the day cycle: both terms fall
// together at dusk, so nothing has to be told the sun's current power. At midnight the sun is at 0
// and the whole city reads as shade, which is correct.
//
// The knee is measured off the parked 16:24 lighting: sun 3.55 against fill 1.50 puts a fully lit
// face at 1.50 / (3.55 + 1.50) = 0.30 and anything the sun misses at 1.00. 0.45 sits above the lit
// end with room to spare, so lit faces stay exactly as they were and only the shade travels.
const SHADE_KNEE = 0.45;

const SHADOW_LIGHT = /* glsl */ `
	{
		vec3 sLuma = vec3(0.2126, 0.7152, 0.0722);
		float sDirect = dot(reflectedLight.directDiffuse, sLuma);
		float sIndirect = dot(reflectedLight.indirectDiffuse, sLuma);
		float sShade = smoothstep(${SHADE_KNEE}, 1.0, sIndirect / max(sDirect + sIndirect, 1e-4));
		reflectedLight.indirectDiffuse = mix(
			reflectedLight.indirectDiffuse,
			uShadowColor * sIndirect,
			sShade * uShadowTint
		);
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
  const key = `prop${aoEnabled ? '-ssao' : ''}${crayonEnabled ? '-crayon' : ''}`
    + `${cartoonEnabled ? '-cartoon' : ''}`;
  material.customProgramCacheKey = () => key;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, AO_UNIFORMS, SHADOW_UNIFORMS);
    if (crayonEnabled) Object.assign(shader.uniforms, CRAYON_UNIFORMS);
    if (cartoonEnabled) Object.assign(shader.uniforms, CARTOON_UNIFORMS);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D tAmbientOcclusion;
uniform vec2 uAOTexel;
uniform vec3 uShadowColor;
uniform float uShadowTint;${crayonEnabled ? `
uniform sampler2D tCrayonPaper;
uniform vec2 uCrayonPaperScale;
uniform vec2 uCrayonBoil;
uniform vec3 uCrayonInk;
uniform float uCrayonGrain;
uniform float uCrayonBlotch;
uniform float uCrayonQuantize;
uniform float uCrayonLine;
uniform float uCrayonWobble;
uniform float uCrayonPixelRatio;` : ''}${cartoonEnabled ? `
uniform vec3 uToonInkColor;
uniform float uToonCel;
uniform float uToonSteps;
uniform float uToonInk;
uniform float uToonBite;` : ''}`);

    if (aoEnabled) {
      // Three's own AO hook is the right seam: `reflectedLight` is complete by then and
      // `outgoingLight` has not been summed yet. Screen space, so the lookup is the fragment's
      // own position on screen — no uv, no second set of attributes.
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
	reflectedLight.indirectDiffuse *= texture2D(tAmbientOcclusion, gl_FragCoord.xy * uAOTexel).r;`);
    }

    // Both hook the same seam, and the order is the point: the cartoon bands the direct term, then
    // the tint reads the banded result.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
${cartoonEnabled ? CARTOON_LIGHT : ''}
${SHADOW_LIGHT}`);

    // Both inks share the seam, and they compose in the order the looks would be layered by hand:
    // the cartoon's hard line first, the crayon's broken one over it. Running both is two inks on
    // one frame and nobody should want it, but a flag combination that throws is worse than one
    // that looks odd.
    const beforeFog = `${cartoonEnabled ? CARTOON_INK : ''}${crayonEnabled ? CRAYON_FRAGMENT : ''}`;
    if (beforeFog) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <fog_fragment>', `${beforeFog}
#include <fog_fragment>`);
    }
  };
}

/** The shared material for every merged prop mesh. */
export function propMaterial() {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  // Unconditional now: the shadow tint rides in the same patch and is always available. See
  // SHADOW_UNIFORMS for why it does not need a flag of its own.
  patchProp(material);
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
