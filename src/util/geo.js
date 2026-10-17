import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

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
 * Put a light on every layer, so every pass that renders the city counts it.
 *
 * **This is a performance call, and a large one.** Three collects a render's lights during the
 * same layer-tested walk that collects its meshes, so the AO prepass (`camera.layers.set(AO_LAYER)`)
 * and the bloom pass (`BLOOM_LAYER`) each saw *no* lights at all, and the main render then saw the
 * sun, the fill and the siren lamps again. All three share one render state, and its light setup
 * bumps a version number whenever the set of lights differs from the last render's — so the
 * version moved twice a frame, and every lit material in the main render failed its
 * `lightsStateVersion` check and went back through `getProgram`: rebuild the parameters, build the
 * cache-key string, look it up, find the program it already had. About **100 of those a frame**,
 * measured, and ~2.6 ms of JS on a desktop core (~45% of setProgram time) for no change at all.
 *
 * Nothing in either prepass is lit (depth materials and `unlitMaterial` copies), so counting the
 * lights there changes no pixel; both passes hold `shadowMap.autoUpdate` off, so the sun's
 * shadow map is not drawn twice either. Any new light in the main scene wants this call, or the
 * churn comes back — silently, since the picture is identical either way.
 */
export function countInEveryPass(light) {
  light.layers.enableAll();
  return light;
}

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
let cloudsEnabled = false;

/**
 * Cloud shadows — the storm's (game/rain.js). A moving field of cloud dims the **sun's direct light
 * only**, so where it is covered a surface is lit by the sky alone and where there is a gap the sun
 * breaks through in a patch that drifts across the city with the wind. Applied before the shadow
 * tint, so a covered patch goes cool the way a real shadow does.
 *
 * `uCloudCover` 0 is a clear sky (the field reads 1 everywhere, the frame is unchanged) and 1 is a
 * lid of cloud with no gaps at all. `uCloudViewInv` is the camera's world matrix, there to turn
 * `vViewPosition` back into a world position: the rain's mirror pass draws through a *different*
 * camera, and sets this to that one's for the length of its render.
 */
export const CLOUD_UNIFORMS = {
  uCloudCover: { value: 0 },
  uCloudFloor: { value: 0.3 },
  uCloudTime: { value: 0 },
  uCloudScale: { value: 30 },
  uCloudDrift: { value: new THREE.Vector2(-0.1, -0.06) },
  uCloudViewInv: { value: new THREE.Matrix4() },
  // The squall's rain cell (game/squall.js): x, z, core radius, and 1 while it is on. Its own clock,
  // because the footprint has to agree with the CPU copy in `cellMask` that the grip and the
  // headlights read.
  uCell: { value: new THREE.Vector4(0, 0, 30, 0) },
  uCellEdge: { value: 14 },
  uCellTime: { value: 0 },
  // How the front falls off past the core's edge, in edges (`RAMP` in game/squall.js): the
  // drizzle's reach and share, then where the shade starts and ends.
  uCellShape: { value: new THREE.Vector4(1, 0, 0, 1.6) },
  // The lights against the shade (from, over), whether the drizzle thins the drops rather than
  // fading them, and the cell's strength as it comes up and dies away.
  uCellLight: { value: new THREE.Vector4(0, 1, 0, 1) },
};

/**
 * The field itself, shared with anything that has to agree with it — the sun shafts in
 * game/rain.js stand exactly where this says there is a gap. Two octaves of value noise: the first
 * drifts with the wind (`uCloudDrift`, in noise units a second), the second creeps across it more
 * slowly so the gaps open and close rather than only sliding. Returns 1 for sun, 0 for cloud.
 */
export const CLOUD_GLSL = /* glsl */ `
float cloudHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cloudNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(cloudHash(i), cloudHash(i + vec2(1.0, 0.0)), f.x),
             mix(cloudHash(i + vec2(0.0, 1.0)), cloudHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// How far past the ragged edge of the squall's core a point is, negative inside it. The same
// footprint as cellFront in game/squall.js; keep the two in step.
float cellFront(vec2 xz, vec4 cell, float t) {
  float r = cell.z * (0.82 + 0.36 * cloudNoise(vec2(xz.x / 16.0 + t * 0.04, xz.y / 16.0 - t * 0.03)));
  return length(xz - cell.xy) - r;
}
// How hard it is raining at a point: the downpour over one edge, and the drizzle's share out across
// its wider band ahead of it. cellMask in game/squall.js.
float cellRain(vec2 xz, vec4 cell, float edge, float t, vec4 shape, float strength) {
  if (cell.w < 0.5) return 0.0;
  float f = cellFront(xz, cell, t);
  float heavy = 1.0 - smoothstep(0.0, edge, f);
  float drizzle = shape.y * (1.0 - smoothstep(0.0, edge * shape.x, f));
  return strength * max(heavy, drizzle);
}
// How far into the cell's shade a point is — wider than the rain, and ahead of it. cellShade there.
float cellShade(vec2 xz, vec4 cell, float edge, float t, vec4 shape, float strength) {
  if (cell.w < 0.5) return 0.0;
  float f = cellFront(xz, cell, t);
  return strength * (1.0 - smoothstep(edge * shape.z, edge * shape.w, f));
}
float cloudSun(vec2 xz, float t, float cover, float scale, vec2 drift) {
  vec2 p = xz / scale + drift * t;
  float f = 0.68 * cloudNoise(p) + 0.32 * cloudNoise(p * 2.3 + vec2(t * 0.021, -t * 0.017));
  // Stretched about its middle: two octaves of value noise bunch tightly around 0.5, and unstretched
  // a cover of 0.56 left about a tenth of the city in sun rather than the third it reads as.
  f = 0.5 + (f - 0.5) * 2.0;
  // ...which also spreads it past 0..1, so the threshold has to span the stretched range for a cover
  // of 0 to be a clear sky and 1 a closed one.
  float edge = mix(-0.65, 1.65, cover);
  return smoothstep(edge - 0.07, edge + 0.07, f);
}
`;

const CLOUD_LIGHT = /* glsl */ `
	{
		vec3 cWorld = (uCloudViewInv * vec4(-vViewPosition, 1.0)).xyz;
		float cSun = cloudSun(cWorld.xz, uCloudTime, uCloudCover, uCloudScale, uCloudDrift);
		reflectedLight.directDiffuse *= mix(uCloudFloor, 1.0, cSun);
		// Under the squall's cell: the sun all but gone and the sky dimmer too, so the cell reads as
		// a dark patch of weather moving over a sunny city. Reaches well past the rain itself — the
		// cloud is wider than what falls out of it, and it is what arrives first.
		float cCell = cellShade(cWorld.xz, uCell, uCellEdge, uCellTime, uCellShape, uCellLight.w);
		reflectedLight.directDiffuse *= 1.0 - 0.88 * cCell;
		reflectedLight.indirectDiffuse *= 1.0 - 0.3 * cCell;
	}
`;

/**
 * Switch cloud shadows on for every `propMaterial()` built after this call — `?storm`/`?rain`,
 * decided in `main.js` beside the look modes and for the same reason: it is compiled in, so a city
 * without weather carries none of it.
 */
export function setCloudShadows(enabled) {
  cloudsEnabled = enabled;
}

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
 * Vehicle finishes — the uniforms every glossy material reads. Same contract as `AO_UNIFORMS`: one
 * shared bag, so a write from the tuning panel reaches every car in the city on the next frame
 * without a recompile.
 *
 * - `tGlossCity` / `uGlossCityBox` / `uGlossCeiling` are the city's **height field**, the same one
 *   `game/sightline.js` rasterises for the fare board, uploaded once as a texture by
 *   `setGlossCity()`. The reflection marches it, which is what makes the skyline slide across a
 *   body as the car drives: a cubemap would hand a car driving straight the same picture on every
 *   frame, because under this camera the only thing that changes the reflected ray is the car
 *   *turning*. What changes as it drives is where it is, so the reflection has to know where the
 *   buildings are.
 * - `uGlossTop` / `uGlossHorizon` follow the sky dome, written by `game/daylight.js` through
 *   `setGlossSky()`.
 * - `uFinishA/B/C/D` are the four finishes' own numbers, one vec4 of each per finish, indexed by the
 *   geometry's `aFinish`. See `FINISH_DEFAULTS` for what each slot is.
 */
export const GLOSS_UNIFORMS = {
  tGlossCity: { value: null },
  uGlossCityOn: { value: 0 },
  // x0, z0, then 1/extent along x and z, so a world xz is one multiply-add from a uv.
  uGlossCityBox: { value: new THREE.Vector4(0, 0, 1, 1) },
  uGlossCeiling: { value: 1 },
  uGlossTop: { value: new THREE.Color(PALETTE.skyTop).convertSRGBToLinear() },
  uGlossHorizon: { value: new THREE.Color(PALETTE.skyBottom).convertSRGBToLinear() },
  uFinishA: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector4()) },
  uFinishB: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector4()) },
  uFinishC: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector4()) },
  uFinishD: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector4()) },
  // x: flake cells per unit, y: façade darkness, z: false-colour finish view (0/1).
  uGlossGlobal: { value: new THREE.Vector4() },
  // The rim look's backlight (`setRim`): rgb in linear, a = strength.
  uRim: { value: new THREE.Vector4() },
  // The rim's depth edge test: the AO prepass's packed depth (`setRimDepth`), one step in that
  // texture's uv, the depth range in world units, and x = the depth gap (world units) that starts
  // the rim, y = the sky rim's share, z = the step in texels.
  tRimDepth: { value: null },
  uRimStep: { value: new THREE.Vector2() },
  uRimDepthScale: { value: 1 },
  uRimShape: { value: new THREE.Vector4(0.4, 0.6, 4, 0) },
  // Where the toon and rim looks' glint (x) and sheen (y) snap on, as cos(half-angle): higher is
  // a smaller shape. Were 0.982 and 0.86, which drew a sun-sized oval across the windscreen and
  // a broad lobe over the roof (Tyler, 2026-10-17: "crazy big highlights").
  uToonCut: { value: new THREE.Vector2(0.996, 0.975) },
  // The flip colour: x how far the paint turns toward a deeper shade of itself at a grazing angle,
  // y the falloff's power. Per look (`PAINT_LOOK_FLIP`), `?flip=` overrides.
  uFlip: { value: new THREE.Vector2(0, 1.6) },
  // Painted reflection streaks (STREAKS): x strength, per look (`PAINT_LOOK_STREAKS`).
  uStreak: { value: new THREE.Vector4(0, 0, 0, 0) },
};

// `?rim=<name>`: one tint for every car's rim. Without one, each car's rim takes its own paint's
// hue at full strength (Tyler, 2026-10-16: gold on the taxi), times the colour of the light.
export const RIM_COLORS = { magenta: '#ff3df0', cyan: '#00e5ff', gold: '#ffb347', white: '#ffffff' };
const RIM_STRENGTH = 3;
let rimLine = true;

/**
 * The rim line, which every look but classic wears: `paint` (the default) takes each car's own
 * hue, a `RIM_COLORS` name tints it, `off` drops it. Build-time for `off`, like the looks.
 */
export function setRim(name) {
  rimLine = name !== 'off';
  const c = new THREE.Color(RIM_COLORS[name] ?? RIM_COLORS.white).convertSRGBToLinear();
  GLOSS_UNIFORMS.uRim.value.set(c.r, c.g, c.b, RIM_STRENGTH);
  GLOSS_UNIFORMS.uRimShape.value.w = name in RIM_COLORS ? 0 : 1;
}
setRim();

// The ⚙️ panel's Rim rows (game/debugpanel.js): name -> [uniform, component].
const RIM_TUNING = {
  width: ['uRimShape', 'z'],
  strength: ['uRim', 'w'],
  sky: ['uRimShape', 'y'],
  gap: ['uRimShape', 'x'],
  carColour: ['uRimShape', 'w'],
  glintCut: ['uToonCut', 'x'],
  sheenCut: ['uToonCut', 'y'],
  flip: ['uFlip', 'x'],
  streaks: ['uStreak', 'x'],
  flipPower: ['uFlip', 'y'],
};
/** The rim's live numbers, for the ⚙️ panel. `width` is in half-res texels, `gap` in world units. */
export const rimTuning = () => Object.fromEntries(Object.entries(RIM_TUNING)
  .map(([key, [u, c]]) => [key, GLOSS_UNIFORMS[u].value[c]]));
/** Set one of them live (`setRimTuning('width', 6)`); width lands on the next frame's step. */
export function setRimTuning(key, value) {
  const [u, c] = RIM_TUNING[key];
  GLOSS_UNIFORMS[u].value[c] = value;
}

/**
 * Hand the rim the AO prepass's depth, every frame before the main render — its size moves with
 * the drawing buffer and its depth scale with the camera.
 */
export function setRimDepth(texture, size, camera) {
  GLOSS_UNIFORMS.tRimDepth.value = texture;
  if (size) GLOSS_UNIFORMS.uRimStep.value.set(GLOSS_UNIFORMS.uRimShape.value.z / size.width, GLOSS_UNIFORMS.uRimShape.value.z / size.height);
  GLOSS_UNIFORMS.uRimDepthScale.value = camera.far - camera.near;
}

/**
 * Follow the sky. The dome's `ShaderMaterial` writes its uniforms straight to the canvas with no
 * colour-space step, so those numbers are *display* values; the paint mixes in the linear working
 * space and has to decode them first, or every reflection comes out washed pale.
 */
export function setGlossSky(top, bottom) {
  GLOSS_UNIFORMS.uGlossTop.value.copy(top).convertSRGBToLinear();
  GLOSS_UNIFORMS.uGlossHorizon.value.copy(bottom).convertSRGBToLinear();
}

/**
 * Hand the paint the city to reflect: the field `setCityOccluders` (game/sightline.js) returns.
 * Packed to a byte per cell against the skyline ceiling — the reflection only asks "is the ray
 * below the roof here", and 1/255 of the ceiling is a few centimetres — and filtered linearly so a
 * roofline slides through a panel rather than stepping across it a half-unit cell at a time.
 */
export function setGlossCity(field, ceiling) {
  GLOSS_UNIFORMS.tGlossCity.value?.dispose();
  if (!field) {
    GLOSS_UNIFORMS.tGlossCity.value = null;
    GLOSS_UNIFORMS.uGlossCityOn.value = 0;
    return;
  }
  const { x0, z0, nx, nz, cell, heights } = field;
  const bytes = new Uint8Array(nx * nz);
  for (let k = 0; k < bytes.length; k++) {
    bytes[k] = Math.round(THREE.MathUtils.clamp(heights[k] / ceiling, 0, 1) * 255);
  }
  // `heights` is `ci * nz + cj` — rows along x, columns along z — so the texture is nz wide.
  const texture = new THREE.DataTexture(bytes, nz, nx, THREE.RedFormat, THREE.UnsignedByteType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  GLOSS_UNIFORMS.tGlossCity.value = texture;
  GLOSS_UNIFORMS.uGlossCityOn.value = 1;
  GLOSS_UNIFORMS.uGlossCityBox.value.set(x0, z0, 1 / (nx * cell), 1 / (nz * cell));
  GLOSS_UNIFORMS.uGlossCeiling.value = ceiling;
}

// What each part of a vehicle is made of, baked per vertex as `aFinish` by `setFinish()` below.
// Each finish has its own full set of numbers (`FINISH_DEFAULTS`), so glass, paint, metal and
// rubber are four materials that happen to share one program. Without it glass and paint came out
// the same material, and the only way to keep the tyres matte was to guess them from height and
// width — which a tread standing proud of the flank, with its top above the sill, kept slipping past.
//
// A geometry with no `aFinish` at all reads 0 — WebGL hands a disabled attribute its default — so
// anything untagged is tyre: matte rather than mirrored. `tools/probe.mjs` asserts the vehicles
// carry it.
//
// MATTE is the one finish that is not a vehicle part: what a vehicle *carries* — the barge's heap,
// a ship's containers, the gulls on the barge — on the same mesh as its paint. Every number zero
// and a diffuse of 1, so it draws exactly as a plain prop would. TYRE is no answer to "not
// shiny": its diffuse of 0.64 took the barge's green wheelhouse to black once already.
export const FINISH = { TYRE: 0, PAINT: 1, GLASS: 2, METAL: 3, MATTE: 4 };
export const FINISH_NAMES = ['tyre', 'paint', 'glass', 'metal', 'matte'];

// `?carbody=smooth`: the cars' bodies with rounded edges and soft normals, so a reflection has a
// curve to slide across instead of one flat colour per panel (2026-10-17, an experiment beside the
// realistic paint). Read at import like `?taxiroof=classic`, because the geometry modules build
// their bodies before main.js has run a line of its own.
export const SMOOTH_BODY = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('carbody') === 'smooth';
/** How round a smooth body's edges are, in car-local units. */
export const BODY_ROUND = 0.14;

/**
 * Soft normals on a non-indexed geometry: each corner takes the area-weighted mean of the faces
 * meeting at its position that lie within `creaseDeg` of its own face, so a bevel's segments blend
 * into one curve and a box's 90 degree edges stay hard. Run after `bakeColor`, which flattens.
 */
export function softenNormals(geometry, creaseDeg = 40) {
  const pos = geometry.attributes.position;
  const n = pos.count;
  const face = new Float32Array(n);
  const faceN = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, i); b.fromBufferAttribute(pos, i + 1); c.fromBufferAttribute(pos, i + 2);
    const fn = new THREE.Vector3().crossVectors(b.sub(a), c.sub(a)); // length = 2 x area
    faceN.push(fn);
  }
  const key = (i) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const at = new Map();
  for (let i = 0; i < n; i++) {
    const k = key(i);
    if (!at.has(k)) at.set(k, []);
    at.get(k).push(i);
  }
  const cos = Math.cos((creaseDeg * Math.PI) / 180);
  const out = new Float32Array(n * 3);
  const sum = new THREE.Vector3(), own = new THREE.Vector3(), other = new THREE.Vector3();
  for (const list of at.values()) {
    for (const i of list) {
      own.copy(faceN[(i / 3) | 0]).normalize();
      sum.set(0, 0, 0);
      for (const j of list) {
        const f = faceN[(j / 3) | 0];
        other.copy(f).normalize();
        if (other.dot(own) >= cos) sum.add(f);
      }
      if (sum.lengthSq() < 1e-12) sum.copy(own);
      sum.normalize();
      out[i * 3] = sum.x; out[i * 3 + 1] = sum.y; out[i * 3 + 2] = sum.z;
    }
  }
  geometry.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return geometry;
}

/** A box for a smooth body, edges rounded by `radius` (clamped to the box); a plain box otherwise. */
export function bodyBox(w, h, d, radius = BODY_ROUND) {
  if (!SMOOTH_BODY) return new THREE.BoxGeometry(w, h, d);
  const r = Math.min(radius, 0.45 * Math.min(w, h, d));
  const box = new RoundedBoxGeometry(w, h, d, 3, r);
  box.deleteAttribute('uv');
  return box;
}

/** Tag every vertex of a geometry with one finish. Returns the geometry, like `bakeColor`. */
export function setFinish(geometry, finish) {
  const count = geometry.attributes.position.count;
  geometry.setAttribute('aFinish', new THREE.BufferAttribute(new Float32Array(count).fill(finish), 1));
  return geometry;
}

// Every other vehicle on the cars' paint: the plane, both helicopters, the barge, the sailboat,
// the container ships and the L train (Tyler, 2026-10-14: "the same metal shader we're using for
// the cars ... all vehicles"). `?vehiclepaint=classic` puts them back on the plain flat material
// they wore before. Their geometry carries `aFinish` either way — a plain material ignores it —
// so the flag only decides which material each one is handed. Set by `main.js` before anything is
// meshed, like `setClassicPaint`.
let vehiclePaint = true;
export function setVehiclePaint(enabled) {
  vehiclePaint = enabled;
}
export const vehiclePaintOn = () => vehiclePaint;

/**
 * Every number a finish has, and where it lands in the shader.
 *
 * | key | slot | what it does |
 * |---|---|---|
 * | `glint` | A.x | strength of the tight sun highlight |
 * | `glintSharp` | A.y | its Blinn-Phong exponent: 400 is a half-width of ~3.4°, 1000 about 2.1° |
 * | `glintBend` | A.z | how far the glint's normal bends at a panel's corner — 1.0 is 45° |
 * | `sheen` | A.w | strength of the broad lobe |
 * | `sheenSharp` | B.x | its exponent |
 * | `flake` | B.y | strength of the metal flake: a lobe of its own, sparkle up close, a soft glow far off |
 * | `reflect` | B.z | how much of the city the finish shows facing the camera |
 * | `reflectEdge` | B.w | how much more it shows at a grazing angle (Fresnel) |
 * | `reflectBend` | C.x | how far the *reflection's* normal bends — slides the skyline across a panel |
 * | `diffuse` | C.y | multiplies the base colour: below 1 darkens it, which is what makes metal |
 * | `flakeTilt` | C.z | how far each flake leans off the panel — the spread of the sparkle |
 * | `flakeSharp` | C.w | each flake's own exponent: how pinpoint one sparkle is |
 * | `coat` | D.x | the clear coat: a Fresnel-weighted mirror of the city over everything else |
 * | `tint` | D.y | how much the sheen and flake take the paint's own hue — 0 plastic, 1 metallic |
 * | `flop` | D.z | how much the base colour darkens toward a grazing angle |
 *
 * D.w is not a setting: it is the flakes' mean lobe, derived from `flakeTilt` and `flakeSharp`
 * (`flakeMeanSharp`), which is what they average into once a flake is smaller than a pixel.
 *
 * **Why two bends.** The panels are flat boxes, and under an orthographic camera with a
 * directional sun a flat face has one normal, one view direction and one light — one highlight and
 * one reflected colour edge to edge. Bending a normal outward by how far the fragment sits from
 * the body's centre gives the glint and the reflection a curve to slide across. The glint's has to
 * bend a long way: the sun's half-vector sits about 45° round from both axes the traffic drives on,
 * so a panel bent less never lines up with it. The diffuse never sees either — the first cut bent
 * three's own `normal`, and every car went soft and bubbly.
 */
//
// Tuned by eye in `?debug`'s inspect mode, which is what the shape of these says: glass is
// near-black with a hard glint and a faint reflection; tyres are darkened rubber; metal is a
// darkened mirror. Only paint uses the last five — the rest leave them at zero and come out exactly
// as they did before paint learned them.
//
// Paint is built the way a real one is layered, base coat up (see "Car paint" in
// docs/rendering.md for the measurements behind each number):
//
// - a **base** whose colour falls off toward the edges (`flop`), the darkening that gives a box
//   panel its curve;
// - a **metallic sheen** in the paint's own hue (`tint`) rather than a white one — a white broad
//   lobe over a coloured base is exactly what plastic looks like;
// - **flake**: aluminium chips in the base coat, each its own little mirror tilted off the panel,
//   which sparkle up close and average into a soft glow where a chip is smaller than a pixel;
// - a **clear coat** over the lot: Schlick's Fresnel off the bent normal at glass's 4%, so the
//   city sits faintly in the middle of a panel and strongly at its rolled edges.
export const FINISH_DEFAULTS = {
  tyre: {
    glint: 0, glintSharp: 20, glintBend: 0.3, sheen: 0.02, sheenSharp: 6, flake: 0,
    reflect: 0, reflectEdge: 0, reflectBend: 0, diffuse: 0.64,
    flakeTilt: 0, flakeSharp: 1, coat: 0, tint: 0, flop: 0,
  },
  paint: {
    glint: 0.19, glintSharp: 1000, glintBend: 1.02, sheen: 0.6, sheenSharp: 6, flake: 0.9,
    reflect: 0, reflectEdge: 0, reflectBend: 1.27, diffuse: 1.36,
    flakeTilt: 0.35, flakeSharp: 250, coat: 0.75, tint: 0.8, flop: 0.35,
  },
  glass: {
    glint: 0.42, glintSharp: 795, glintBend: 1.06, sheen: 0, sheenSharp: 1, flake: 0,
    reflect: 0.03, reflectEdge: 0.05, reflectBend: 1.14, diffuse: 0.12,
    flakeTilt: 0, flakeSharp: 1, coat: 0, tint: 0, flop: 0,
  },
  metal: {
    glint: 1, glintSharp: 120, glintBend: 1, sheen: 0.25, sheenSharp: 30, flake: 0,
    reflect: 0.3, reflectEdge: 0.2, reflectBend: 0.6, diffuse: 0.7,
    flakeTilt: 0, flakeSharp: 1, coat: 0, tint: 0, flop: 0,
  },
  matte: {
    glint: 0, glintSharp: 1, glintBend: 0, sheen: 0, sheenSharp: 1, flake: 0,
    reflect: 0, reflectEdge: 0, reflectBend: 0, diffuse: 1,
    flakeTilt: 0, flakeSharp: 1, coat: 0, tint: 0, flop: 0,
  },
};

// `?paint=classic`: the paint before the layers above — a white flaked sheen with a square,
// two-level flake and almost no mirror ("paint at 0.02 barely carries it"). Its own GLSL too
// (`GLOSS_NORMAL_CLASSIC`, `GLOSS_SPECULAR_CLASSIC`), so it is the old frame and not an
// approximation of it.
const PAINT_CLASSIC = {
  glint: 0.19, glintSharp: 1000, glintBend: 1.02, sheen: 1, sheenSharp: 6, flake: 1,
  reflect: 0.02, reflectEdge: 0, reflectBend: 1.27, diffuse: 1.36,
  flakeTilt: 0, flakeSharp: 1, coat: 0, tint: 0, flop: 0,
};

// Three divergent looks on the layered paint's source. `toon` ships as the default; the layered
// paint and the other two are behind `?paint=<name>`. Each is the
// layered paint's numbers with these over the top, plus its own GLSL (`PAINT_LOOKS` below).
//
// - `chameleon`: colour-shift paint. The base hue rotates as a panel turns away from the camera,
//   so every car flips to a second colour at its edges — a red car goes purple, a teal one gold.
// - `satin`: a wrap, not a lacquer. No clear coat to speak of, a broad soft sheen, and a velvet
//   rim that lifts the paint at grazing angles instead of mirroring the street there.
// - `toon`: cel paint. The glint and the sheen are hard-edged shapes rather than lobes, and the
//   clear coat is one hard band of sky along the bent edges.
// - `rim` (the default): toon's shapes with the sheen in the paint's full hue — toon's half-white
//   one is what washed the taxi to a pale blue-grey — and a coloured backlight on the body's
//   up-screen edges instead of the sky band.
const PAINT_LOOK_NUMBERS = {
  chameleon: { coat: 1, tint: 1, flop: 0.1, sheen: 0.7, flake: 0.9 },
  satin: {
    glint: 0.04, glintSharp: 60, sheen: 0.9, sheenSharp: 3, flake: 0.15, coat: 0.1, tint: 0.6,
    flop: 0, diffuse: 1.3,
  },
  toon: { glint: 1, sheen: 0.45, flake: 0, coat: 0, tint: 0.5, flop: 0 },
  rim: { glint: 1, sheen: 0.45, flake: 0, coat: 0, tint: 1, flop: 0 },
  // `real` (2026-10-17, from Tyler's car-paint brief): a sharp clear-coat glint over a soft
  // base sheen, flakes, the full Fresnel coat and the flip colour, with the bends cut to a
  // quarter, since they are what smeared the layered look's reflection across a box. Meant
  // for `?carbody=smooth`, whose own curves stand in for the bend.
  real: {
    glint: 0.5, glintSharp: 2000, glintBend: 0.25, sheen: 0.35, sheenSharp: 12, flake: 0.6,
    reflectBend: 0.3, coat: 0, tint: 0.8, flop: 0,
  },
};
// The flip colour each look wears (`uFlip.x`); `?flip=<amount>` overrides, `?flip=off` drops it.
const PAINT_LOOK_FLIP = { rim: 0.7, real: 0.8 };
// The streaks each look wears (`uStreak.x`), and its rim's width in half-res texels (Tyler,
// 2026-10-17: double the rim on realistic).
const PAINT_LOOK_STREAKS = { real: 0.6 }; // Tyler, 2026-10-17: "0.6 looks rad"
const PAINT_LOOK_RIM_WIDTH = { real: 8 };
let flipOverride = null;
/** `?flip=`: a number, or `off`. Null keeps each look's own. */
export function setFlip(value) {
  flipOverride = value === 'off' ? 0 : value == null || value === '' ? null : Number(value);
  GLOSS_UNIFORMS.uFlip.value.x = flipOverride ?? PAINT_LOOK_FLIP[paintLook] ?? 0;
}

let classicPaint = false;
// Rim is the default (Tyler, 2026-10-16), toon before it (2026-10-13); the rest stay one
// `?paint=` away.
const PAINT_LOOK_DEFAULT = 'rim';
let paintLook = PAINT_LOOK_DEFAULT;
const finishDefaults = () => {
  const finishes = structuredClone(FINISH_DEFAULTS);
  if (classicPaint) finishes.paint = { ...PAINT_CLASSIC };
  else Object.assign(finishes.paint, PAINT_LOOK_NUMBERS[paintLook] ?? {});
  return finishes;
};

/**
 * The flakes' mean lobe: what a field of flakes tilted by `tilt`, each with exponent `sharp`,
 * averages into once they are too small to see one at a time. Blinn-Phong's exponent n is a
 * Beckmann roughness of m² ≈ 2/(n+2), and a spread of tilts adds its own variance to that, so
 * the two widths add in quadrature. Both lobes are normalised (three's `D_BlinnPhong`), so the
 * mean carries the same energy as the sparkle it stands in for — fading one into the other moves
 * where the light is, not how much of it there is.
 */
export function flakeMeanSharp(tilt, sharp) {
  const m2 = tilt * tilt + 2 / (sharp + 2);
  return Math.max(1, 2 / m2 - 2);
}

export const GLOSS_GLOBAL_DEFAULTS = {
  // Flake cells per world unit of the body's own space. ~1.1 phone pixels at play zoom, where the
  // filter has handed the sparkle over to its mean lobe; ~4 at the closest pinch, where it sparkles.
  flakeSize: 14.5,
  // How dark a building reads in a reflection, as a fraction of the horizon behind it. Near black,
  // as tuned: with the reflections this faint, a dark silhouette against the sky is the only part
  // of them that still reads.
  facade: 0.08,
  // Paints each finish a flat false colour, to check what the geometry tagged as what.
  showFinishes: false,
};

const glossState = {
  finishes: finishDefaults(),
  global: { ...GLOSS_GLOBAL_DEFAULTS },
};

function writeFinish(name) {
  const f = glossState.finishes[name];
  const k = FINISH[name.toUpperCase()];
  GLOSS_UNIFORMS.uFinishA.value[k].set(f.glint, f.glintSharp, f.glintBend, f.sheen);
  GLOSS_UNIFORMS.uFinishB.value[k].set(f.sheenSharp, f.flake, f.reflect, f.reflectEdge);
  GLOSS_UNIFORMS.uFinishC.value[k].set(f.reflectBend, f.diffuse, f.flakeTilt, f.flakeSharp);
  GLOSS_UNIFORMS.uFinishD.value[k].set(f.coat, f.tint, f.flop, flakeMeanSharp(f.flakeTilt, f.flakeSharp));
}

function writeGlobal() {
  const g = glossState.global;
  GLOSS_UNIFORMS.uGlossGlobal.value.set(g.flakeSize, g.facade, g.showFinishes ? 1 : 0, 0);
}

for (const name of FINISH_NAMES) writeFinish(name);
writeGlobal();

/**
 * `?paint=classic` for every glossy material built after this call — `main.js` calls it beside
 * `setCrayon`, before any vehicle is meshed. Build-time because the two paints are different
 * source, not different numbers.
 */
export function setClassicPaint(enabled) {
  classicPaint = enabled;
  resetGlossTuning();
}

/** `?paint=layered|chameleon|satin|toon|rim` — anything else (no param) is rim, the default. */
export function setPaintLook(look) {
  paintLook = look === 'layered' || look in PAINT_LOOK_NUMBERS ? look : PAINT_LOOK_DEFAULT;
  resetGlossTuning();
  setFlip(flipOverride);
  GLOSS_UNIFORMS.uStreak.value.x = PAINT_LOOK_STREAKS[paintLook] ?? 0;
  GLOSS_UNIFORMS.uRimShape.value.z = PAINT_LOOK_RIM_WIDTH[paintLook] ?? 4;
}

/** Whether the cars wear the rim look, which reads the AO prepass's depth. */
export const rimPaintOn = () => !classicPaint && rimLine;

/** A copy of the live finish tuning — what the `?debug` panel reads and exports. */
export const glossTuning = () => structuredClone(glossState);

/** Set one finish's number (`setGlossFinish('glass', 'reflect', 0.3)`), live. */
export function setGlossFinish(name, key, value) {
  if (!(name in glossState.finishes) || !(key in glossState.finishes[name])) {
    throw new Error(`no finish setting ${name}.${key}`);
  }
  glossState.finishes[name][key] = value;
  writeFinish(name);
}

/** Set one of the finish-wide numbers (`flakeSize`, `facade`, `showFinishes`), live. */
export function setGlossGlobal(key, value) {
  if (!(key in glossState.global)) throw new Error(`no finish setting ${key}`);
  glossState.global[key] = value;
  writeGlobal();
}

/** Put every finish back to `FINISH_DEFAULTS` (or the classic paint, under `?paint=classic`). */
export function resetGlossTuning() {
  glossState.finishes = finishDefaults();
  glossState.global = { ...GLOSS_GLOBAL_DEFAULTS };
  for (const name of FINISH_NAMES) writeFinish(name);
  writeGlobal();
}

const GLOSS_VERTEX = /* glsl */ `
	{
		vec4 gWorld = vec4(transformed, 1.0);
		vec3 gBulge = (transformed - uGlossCentre) * uGlossInvHalf;
		#ifdef USE_INSTANCING
			gWorld = instanceMatrix * gWorld;
			gBulge = mat3(instanceMatrix) * gBulge;
		#endif
		vGlossWorld = (modelMatrix * gWorld).xyz;
		vGlossBulge = mat3(modelViewMatrix) * gBulge;
		vGlossObj = transformed;
		vGlossFinish = aFinish;
	}
`;

// Three's own colour chunk, with the instance tint kept off metal. The fleet is one InstancedMesh
// painted per car through `instanceColor`, which multiplies every vertex — so a chrome bumper
// (geometry/bumpers.js) came out red on a red car, and the hubcaps had always been steel dipped in
// the car's paint. Metal is the one finish that is never paint. `> 2.5` rather than `== 3.0` for
// the same rounding reason GLOSS_COLOR uses `int(x + 0.5)`; the upper bound keeps MATTE, the one
// finish above it, taking a tint like any other.
const GLOSS_COLOR_VERTEX = THREE.ShaderChunk.color_vertex.replace(
  'vColor.xyz *= instanceColor.xyz;',
  'vColor.xyz *= aFinish > 2.5 && aFinish < 3.5 ? vec3(1.0) : instanceColor.xyz;',
);
if (GLOSS_COLOR_VERTEX === THREE.ShaderChunk.color_vertex) throw new Error('gloss: color_vertex hook missed');

// Read the finish's numbers once, at the top, and darken the base colour by its `diffuse` before
// any light touches it. `int(x + 0.5)` because a varying that is 2.0 at every vertex can still
// arrive as 1.9999 — the triangle never mixes finishes, but interpolation does not know that.
const GLOSS_COLOR = /* glsl */ `
	{
		int gK = clamp(int(vGlossFinish + 0.5), 0, 4);
		gFinA = uFinishA[gK];
		gFinB = uFinishB[gK];
		gFinC = uFinishC[gK];
		gFinD = uFinishD[gK];
		gIsPaint = gK == 1 ? 1.0 : 0.0;
		gFinishColor = gK == 0 ? vec3(0.15) : gK == 1 ? vec3(0.9, 0.2, 0.15)
			: gK == 2 ? vec3(0.1, 0.7, 0.9) : gK == 3 ? vec3(0.95, 0.8, 0.2) : vec3(0.6, 0.45, 0.85);
		diffuseColor.rgb *= gFinC.y;
	}
`;

// The two bent normals (see FINISH_DEFAULTS). Three's own `normal` is left flat, so the diffuse
// keeps the facets.
const GLOSS_BEND = /* glsl */ `
		vec3 gb = vGlossBulge - normal * dot(vGlossBulge, normal);
		gSpecN = normalize(normal + gFinA.z * gb);
		gReflN = normalize(normal + gFinC.x * gb);
`;

// `?paint=classic`'s flake: a square cell over the body's own space, either 3x bright or 0.6x,
// multiplied into the sheen. Up close it reads as a mosaic of square pixels; at play zoom a cell
// is ~1.1 phone pixels, so a moving car flickers.
const GLOSS_NORMAL_CLASSIC = /* glsl */ `
	{
${GLOSS_BEND}
		vec3 gCell = floor(vGlossObj * uGlossGlobal.x);
		float gHash = fract(sin(dot(gCell, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
		gFlake = mix(1.0, gHash > 0.88 ? 3.0 : 0.6, gFinB.y);
	}
`;

// The layered paint's setup, once per fragment before the light loop: the flop, the sheen's hue,
// and the flake under this fragment.
//
// **Flop.** Under the orthographic camera the view direction is +Z in view space, so the bent
// normal's z *is* N·V. Applied to `diffuseColor` here rather than in the colour chunk because it
// needs the bent normal, and three only reads `diffuseColor` into the material in
// `lights_phong_fragment`, which runs after this.
//
// **The sheen's hue** is the base colour scaled to a peak of 1, so a dark red car still gets a
// full-strength red highlight rather than a dim one.
//
// **Flake.** One flake per cell of the body's own space — so the flakes ride the car — sat at a
// random point in its cell with a random radius, which makes them round chips of varying size
// rather than the classic flake's square mosaic. Each leans off the bent normal by up to
// `flakeTilt` in a random direction, which is what makes a few of them catch the sun at a time.
//
// **The filter is the whole point.** `gFoot` is how many flake cells one pixel spans, from the
// screen-space derivative of the very coordinate the cells are cut from. Where a cell is bigger
// than a pixel the sparkle draws; where it is smaller, any one pixel's answer depends on which
// cell its centre happens to land in, and that changes every frame a car moves a fraction of a
// pixel — shimmer. So `gFlakeVis` fades the sparkle out across 0.4–0.85 cells a pixel and the
// light loop hands its energy to the flakes' mean lobe instead (see `flakeMeanSharp`). A phone at
// play zoom sits at ~0.9 (16 px a unit at DPR 2 against 14.5 cells a unit), on the far side of
// the fade, so in play the flake is the glow and the sparkle is for close-ups.
//
// The hash is Dave Hoskins' hash33 rather than the classic fract(sin(x) * 43758): sin of a large
// argument is where mobile GPUs part ways, and the cells here are indices, not small numbers.
const GLOSS_NORMAL = /* glsl */ `
	{
${GLOSS_BEND}
		float gNV = clamp(gReflN.z, 0.0, 1.0);
		diffuseColor.rgb *= 1.0 - gFinD.z * (1.0 - gNV) * (1.0 - gNV);
		diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * diffuseColor.rgb * 0.85,
			gIsPaint * uFlip.x * pow(1.0 - gNV, uFlip.y));
__LOOK_BASE__
		float gPeak = max(max(diffuseColor.r, diffuseColor.g), max(diffuseColor.b, 1e-3));
		gTint = mix(vec3(1.0), diffuseColor.rgb / gPeak, gFinD.y);
		gRimHue = diffuseColor.rgb / gPeak;

		vec3 gF = vGlossObj * uGlossGlobal.x + 0.37;
		vec3 gId = floor(gF);
		vec3 gRnd = gHash3(gId);
		float gFoot = max(length(dFdx(gF)), length(dFdy(gF)));
		float gD = length(fract(gF) - (0.25 + 0.5 * gRnd));
		float gRad = 0.22 + 0.2 * gRnd.z;
		gFlakeVis = 1.0 - smoothstep(0.4, 0.85, gFoot);
		gFlakeDisc = 1.0 - smoothstep(gRad - gFoot, gRad + gFoot, gD);
		vec3 gT = normalize(cross(normal, abs(normal.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
		vec2 gLean = (gHash3(gId + 17.17).xy * 2.0 - 1.0) * gFinC.z;
		gFlakeN = normalize(gReflN + gT * gLean.x + cross(normal, gT) * gLean.y);
	}
`;

// Phong's specular line, swapped for two lobes: the glint on the glint normal, the sheen on the
// reflection's. Still inside three's light loop, so `directLight.color` has the shadow map
// already folded in: a car in a tower's shadow has no sun to glint with, and a cop's lamps glint
// off the cars beside it.
const GLOSS_SPECULAR_FROM = 'reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularShininess ) * material.specularStrength;';
const GLOSS_SPECULAR_CLASSIC = /* glsl */ `{
		vec3 gGlintIrr = saturate( dot( gSpecN, directLight.direction ) ) * directLight.color;
		reflectedLight.directSpecular += gGlintIrr * gFinA.x
			* BRDF_BlinnPhong( directLight.direction, geometryViewDir, gSpecN, vec3( 1.0 ), gFinA.y );
		vec3 gSheenIrr = saturate( dot( gReflN, directLight.direction ) ) * directLight.color;
		reflectedLight.directSpecular += gSheenIrr * gFinA.w * gFlake
			* BRDF_BlinnPhong( directLight.direction, geometryViewDir, gReflN, vec3( 1.0 ), gFinB.x );
	}`;

// The layered paint's lobes. The glint is unchanged — it is the clear coat's own reflection of the
// sun, and a coat is clear, so it stays white. The sheen and the flake are the base coat's, so they
// take the paint's hue (`gTint`). The flake is the sparkle where one can be seen and its mean lobe
// where it cannot, the sparkle weighted by the disc so a fragment between chips is just paint and
// the mean by the chips' share of a cell (~0.17 for these radii), so the two carry the same light.
// The sparkle is skipped outright where it is faded out — every fragment of a car at play zoom —
// which is a branch the whole car takes the same way.
// Every other finish has `flake` 0 and `tint` 0, which leaves exactly the classic's two lobes.
const GLOSS_SPECULAR_TO = /* glsl */ `{
		vec3 gGlintIrr = saturate( dot( gSpecN, directLight.direction ) ) * directLight.color;
		reflectedLight.directSpecular += gGlintIrr * gFinA.x
			* BRDF_BlinnPhong( directLight.direction, geometryViewDir, gSpecN, vec3( 1.0 ), gFinA.y );
		vec3 gSheenIrr = saturate( dot( gReflN, directLight.direction ) ) * directLight.color * gTint;
		vec3 gFlakeLight = BRDF_BlinnPhong( directLight.direction, geometryViewDir, gReflN, vec3( 1.0 ), gFinD.w ) * 0.17;
		if ( gFlakeVis > 0.0 ) {
			vec3 gSpark = BRDF_BlinnPhong( directLight.direction, geometryViewDir, gFlakeN, vec3( 1.0 ), gFinC.w ) * gFlakeDisc;
			gFlakeLight = mix( gFlakeLight, gSpark, gFlakeVis );
		}
		reflectedLight.directSpecular += gSheenIrr * ( gFinA.w
			* BRDF_BlinnPhong( directLight.direction, geometryViewDir, gReflN, vec3( 1.0 ), gFinB.x )
			+ gFinB.y * gFlakeLight );
	}`;

// What the layered paint adds to the fragment's globals, and the hash its flakes are cut with.
const GLOSS_PAINT_DECLS = /* glsl */ `vec3 gTint;
vec3 gRimHue;
vec3 gFlakeN;
float gFlakeVis;
float gFlakeDisc;
vec3 gHash3(vec3 p) {
	p = fract(p * vec3(0.1031, 0.1030, 0.0973));
	p += dot(p, p.yxz + 33.33);
	return fract((p.xxy + p.yxx) * p.zyx);
}`;

// Mixed into `outgoingLight` after three has summed it, so the glint is already in and the
// reflection sits over the lit surface the way a clear coat does.
//
// The clear coat (`coat`) is Schlick's Fresnel at 4%, capped at about half: its grazing angles
// come off the *bent* normal, so every corner of a box body is "grazing", and at the full 100% a
// corner turned into a slab of façade-black or sky-white. Capped, a corner still shows the street
// in it at nearly ten times the strength of the middle of a panel, which is the curve the eye reads.
//
// The reflected ray off a side panel heads *down* — the camera looks down at 33 degrees — and
// would honestly reflect the asphalt a metre away. That is physically right and reads as nothing,
// so the ray is folded back up off the road: a side panel then sees the street wall opposite,
// which is what a viewer expects a car to be reflecting. A roof sees what is up-screen of it.
//
// Paint's share is scaled per material by `uGloss` (the taxi a touch more, a cargo box less), and
// every other finish's by `uGlossMirror` — 1 on every vehicle, turned down on the depot's wrench,
// where a thin turning slab bends almost every fragment to a grazing angle and came out sky-blue.
// How a step of the march below a roofline turns into façade. The classic paint's is a hard hit:
// the first sample under a roof is façade, full strength. Its streaks were already on the glass,
// but under a clear coat they reached the paint too, and on a white panel a ragged black claw
// mark from 14 coarse steps reads as a scratch rather than a building. The layered paint's is
// soft — a sample counts by how far under the roof it is, against a depth that grows with the
// ray's length — which is what a rough reflection does anyway: the further the thing reflected,
// the blurrier its edge.
const GLOSS_HIT_CLASSIC = /* glsl */ `
				if (texture2D(tGlossCity, gUV).r * uGlossCeiling > gQ.y) {
					gEnv = uGlossHorizon * uGlossGlobal.y * (0.7 + 0.6 * gQ.y / uGlossCeiling);
					break;
				}
`;
const GLOSS_HIT_SOFT = /* glsl */ `
				float gO = clamp((texture2D(tGlossCity, gUV).r * uGlossCeiling - gQ.y) / (0.4 + 0.12 * gT), 0.0, 1.0);
				if (gO > gOcc) { gOcc = gO; gHitY = gQ.y; }
				if (gOcc >= 1.0) break;
`;

const glossFragment = (classic) => /* glsl */ `
	{
		vec3 gN = inverseTransformDirection(gReflN, viewMatrix);
		vec3 gEye = inverseTransformDirection(vec3(0.0, 0.0, 1.0), viewMatrix);
		vec3 gR = reflect(-gEye, gN);
		gR.y = max(abs(gR.y), 0.12);
		gR = normalize(gR);
		vec3 gEnv = mix(uGlossHorizon, uGlossTop, __LOOK_SKY__);
		float gGraze = 1.0 - clamp(gReflN.z, 0.0, 1.0);
		float gMirror = (gFinB.z + gFinB.w * gGraze * gGraze * gGraze
			+ gFinD.x * (0.04 + 0.96 * pow(min(gGraze, 0.88), 5.0)))
			* mix(uGlossMirror, uGloss, gIsPaint);
__LOOK_MIRROR__
		if (uGlossCityOn > 0.5 && gMirror > 0.0) {
			float gT = 0.6;
			float gOcc = 0.0;
			float gHitY = 0.0;
			for (int k = 0; k < 14; k++) {
				vec3 gQ = vGlossWorld + gR * gT;
				if (gQ.y > uGlossCeiling) break;
				vec2 gUV = vec2((gQ.z - uGlossCityBox.y) * uGlossCityBox.w, (gQ.x - uGlossCityBox.x) * uGlossCityBox.z);
${classic ? GLOSS_HIT_CLASSIC : GLOSS_HIT_SOFT}
				gT *= 1.3;
			}
			gEnv = mix(gEnv, uGlossHorizon * uGlossGlobal.y * (0.7 + 0.6 * gHitY / uGlossCeiling), gOcc);
		}
__LOOK_FINAL__
		outgoingLight = mix(outgoingLight, gEnv, clamp(gMirror, 0.0, 1.0));
		if (uGlossGlobal.z > 0.5) outgoingLight = gFinishColor;
	}
`;

// The explored looks' GLSL, dropped into four slots of the layered paint's source. Anything a look
// leaves out keeps the layered paint's line.
//
// **Chameleon** rotates the base colour about the grey axis (Rodrigues), by up to `CHAMELEON_TURN`
// radians as N·V falls from 0.6 — the face-on middle of a roof or flank sits around 0.55 under
// this camera, so the middle of a panel keeps its own colour and only its rolled edges flip.
//
// **Satin** adds a velvet rim, the lift a brushed or fibrous surface gets at grazing angles,
// scaled off the lit colour so it never brightens a panel in shadow.
//
// **Toon** thresholds the glint and the sheen into shapes, quantises the sky into two bands, and
// replaces the clear coat's curve with one hard band past 0.6 graze.
//
// **Rim** is toon with the sheen in the paint's full hue. The rim line (`RIM_LIGHT`, `RIM_SKY`,
// appended to every look but classic unless `?rim=off`) is a hairline of light along the body's silhouette, on the
// edges that face a light and nowhere else. The panels are flat boxes, so nothing in a fragment's
// own normal says it is at an edge; the screen does. Each light steps the fragment a few texels
// toward itself across the AO prepass's depth (`gRimEdge`): if the step lands on something more
// than 0.4 units further back — the road behind the car, or nothing — this fragment is on the
// car's lit edge, and it gets the light's own colour, shadow included, since three has already
// folded the shadow map into `directLight.color`. So the sun lights the edges toward the sun, a
// cop's bar lights the edges toward the bar, a car under a tower's shadow has none, and turning
// a corner moves the line to other edges. A second step straight up-screen adds the sky's colour
// at a fraction of that, the reflection of the sky behind the car.
//
// The first build was a Fresnel on the ellipsoid that fits the body (`vGlossBulge` as a normal):
// on boxes it painted coloured patches over whole corners, and the facets showed through it.
// The step is in texels, not world units, so it is a pen width: 4 half-res texels, ~8 device
// pixels on a phone, which is visible at play zoom and still a line in a close-up.
const CHAMELEON_TURN = 2.3;
const LOOK_DEFAULT_SKY = 'pow(gR.y, 0.6)';
const TOON_SKY = 'step(0.45, gR.y)';
const TOON_SPECULAR = /* glsl */ `{
		vec3 gH = normalize( directLight.direction + geometryViewDir );
		float gLit = step( 0.0, dot( gReflN, directLight.direction ) );
		float gGlintIrr = smoothstep( uToonCut.x, uToonCut.x + 0.004, dot( gSpecN, gH ) ) * gFinA.x;
		float gSh = smoothstep( uToonCut.y, uToonCut.y + 0.01, dot( gReflN, gH ) ) * gFinA.w;
		reflectedLight.directSpecular += directLight.color * gLit * ( gGlintIrr * 1.6 + gSh * gTint );
	}`;
// The rim line, appended to whichever look's specular is in the light loop.
const RIM_LIGHT = /* glsl */ `
	{
		vec2 gRimD = directLight.direction.xy;
		if ( gIsPaint > 0.5 && dot( gRimD, gRimD ) > 1e-6 ) {
			reflectedLight.directSpecular += directLight.color * gRimColor() * uRim.a
				* gRimEdge( normalize( gRimD ) );
		}
	}`;
// ...and the sky's share, appended to the look's final slot.
// **Streaks.** A box panel reflects one point of the sky edge to edge, so no environment can
// slide across it (Tyler, 2026-10-17: the reflection washed the taxi out). These are painted on
// instead, the way a toy car or an illustration fakes chrome: on each flank and end a horizon
// line, sky above it and a little ground below; across every panel two diagonal light bands, one
// broad and one thin. Keyed to the body's own box, so they ride the car, and slid along the panel
// by the flank's facing, so they move as the car turns. Additive in the sky's colour, off the sun.
const STREAKS = /* glsl */ `
	if (gIsPaint > 0.5 && uStreak.x > 0.0) {
		vec3 sP = (vGlossObj - uGlossCentre) * uGlossInvHalf;
		vec3 sN = abs(normalize(cross(dFdx(vGlossObj), dFdy(vGlossObj))));
		bool sTop = sN.y > 0.7;
		vec2 sUV = sTop ? sP.xz : sN.z > sN.x ? sP.xy : sP.zy;
		float sShift = sTop ? 0.0 : 0.6 * normal.x;
		float sS = sUV.x + 0.7 * sUV.y + sShift;
		float sW = fwidth(sS) + 1e-4;
		float sBand = smoothstep(0.16 + sW, 0.16 - sW, abs(sS + 0.35))
			+ 0.8 * smoothstep(0.05 + sW, 0.05 - sW, abs(sS - 0.2));
		float sH = sTop ? 0.0 : sUV.y + 0.45;
		float sHW = fwidth(sH) + 1e-4;
		float sSky = sTop ? 0.0 : smoothstep(-sHW, sHW, sH);
		float sLine = sTop ? 0.0 : smoothstep(0.06 + sHW, 0.0, abs(sH - 0.03));
		// The sky's own colour lifted toward its own brightness in white, so the bands are pale by
		// day and fade with the sky at night instead of staying white.
		vec3 sCol = uGlossTop + 0.8 * vec3(dot(uGlossTop, vec3(0.2126, 0.7152, 0.0722)));
		outgoingLight *= 1.0 - uStreak.x * 0.18 * (sTop ? 0.0 : 1.0 - sSky);
		outgoingLight += uStreak.x * sCol * (0.45 * sBand + 0.06 * sSky + 0.4 * sLine);
	}`;
const RIM_SKY = /* glsl */ `
		outgoingLight += uGlossTop * gRimColor() * uRimShape.y * gIsPaint * gRimEdge(vec2(0.0, 1.0));`;
// After <packing>, which the gloss uniforms are not: hung on the light chunk's include instead.
const RIM_EDGE_FN = /* glsl */ `
// How far the scene behind this fragment drops away one step along dir: 1 where the step lands
// off the body (on the road, or on nothing), 0 where it lands on the body itself.
float gRimEdge(vec2 dir) {
	vec2 uv = gl_FragCoord.xy * uAOTexel + dir * uRimStep;
	float gap = (unpackRGBAToDepth(texture2D(tRimDepth, uv)) - gl_FragCoord.z) * uRimDepthScale;
	return smoothstep(uRimShape.x, uRimShape.x + 0.3, gap);
}
// The tint, or the paint's own hue at full strength (uRimShape.w = 1, ?rim=paint).
vec3 gRimColor() {
	return mix(uRim.rgb, gRimHue, uRimShape.w);
}
`;
const PAINT_LOOKS = {
  chameleon: {
    base: `
		{
			float gTurn = ${CHAMELEON_TURN.toFixed(2)} * gIsPaint * smoothstep(0.6, 0.0, gNV);
			const vec3 gK = vec3(0.57735);
			diffuseColor.rgb = max(diffuseColor.rgb * cos(gTurn) + cross(gK, diffuseColor.rgb) * sin(gTurn)
				+ gK * dot(gK, diffuseColor.rgb) * (1.0 - cos(gTurn)), 0.0);
		}`,
  },
  satin: {
    final: `
		outgoingLight += outgoingLight * gIsPaint * 1.1 * gGraze * gGraze * gGraze;`,
  },
  toon: {
    sky: TOON_SKY,
    mirror: `
		gMirror += gIsPaint * 0.5 * step(0.6, gGraze) * uGloss;`,
    specular: TOON_SPECULAR,
  },
  rim: {
    sky: TOON_SKY,
    specular: TOON_SPECULAR,
  },
  real: {},
};

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
function patchProp(material, { ao = true, gloss = null } = {}) {
  // Without this the patch silently does nothing. Three builds the program cache key from the
  // material's *parameters*, before `onBeforeCompile` has touched the source, so a patched
  // flat-shaded Lambert collides with every unpatched one sharing those parameters and
  // `acquireProgram` hands back whichever compiled first. This city is nothing but flat-shaded
  // Lambert — it is the same trap that once drew the diamond's fill with a building's shader.
  //
  // Composed out of both flags rather than one string, because the two are independent: with
  // `?crayon&ao=off` a crayoned material and a bare one would otherwise share a key.
  const useAO = aoEnabled && ao;
  const key = `prop${useAO ? '-ssao' : ''}${crayonEnabled ? '-crayon' : ''}`
    + `${cartoonEnabled ? '-cartoon' : ''}${gloss ? `-gloss${classicPaint ? '-classic' : paintLook === 'layered' ? '' : `-${paintLook}`}${rimPaintOn() ? '-rim' : ''}` : ''}`
    + `${cloudsEnabled ? '-clouds' : ''}`;
  material.customProgramCacheKey = () => key;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, AO_UNIFORMS, SHADOW_UNIFORMS);
    if (crayonEnabled) Object.assign(shader.uniforms, CRAYON_UNIFORMS);
    if (cartoonEnabled) Object.assign(shader.uniforms, CARTOON_UNIFORMS);
    if (cloudsEnabled) Object.assign(shader.uniforms, CLOUD_UNIFORMS);
    if (gloss) {
      // The shared bag plus this body's own shape and paint share, which differ between a car, a
      // truck's cab and the taxi while the source does not — so per material, under one cache key.
      const look = classicPaint ? {} : PAINT_LOOKS[paintLook] ?? {};
      const rim = rimPaintOn();
      Object.assign(shader.uniforms, GLOSS_UNIFORMS, {
        uGloss: { value: gloss.amount },
        uGlossMirror: { value: gloss.mirror },
        uGlossCentre: { value: gloss.centre },
        uGlossInvHalf: { value: gloss.invHalf },
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aFinish;
uniform vec3 uGlossCentre;
uniform vec3 uGlossInvHalf;
varying vec3 vGlossWorld;
varying vec3 vGlossBulge;
varying vec3 vGlossObj;
varying float vGlossFinish;`)
        .replace('#include <project_vertex>', `#include <project_vertex>
${GLOSS_VERTEX}`)
        .replace('#include <color_vertex>', GLOSS_COLOR_VERTEX);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D tGlossCity;
uniform float uGlossCityOn;
uniform vec4 uGlossCityBox;
uniform float uGlossCeiling;
uniform vec3 uGlossTop;
uniform vec3 uGlossHorizon;
uniform vec4 uFinishA[5];
uniform vec4 uFinishB[5];
uniform vec4 uFinishC[5];
uniform vec4 uFinishD[5];
uniform vec4 uGlossGlobal;
uniform float uGloss;
uniform float uGlossMirror;
uniform vec4 uRim;
uniform sampler2D tRimDepth;
uniform vec2 uRimStep;
uniform float uRimDepthScale;
uniform vec4 uRimShape;
uniform vec2 uToonCut;
uniform vec2 uFlip;
uniform vec4 uStreak;
uniform vec3 uGlossCentre;
uniform vec3 uGlossInvHalf;
varying vec3 vGlossWorld;
varying vec3 vGlossBulge;
varying vec3 vGlossObj;
varying float vGlossFinish;
vec4 gFinA;
vec4 gFinB;
vec4 gFinC;
vec4 gFinD;
float gIsPaint;
vec3 gFinishColor;
vec3 gSpecN;
vec3 gReflN;
${classicPaint ? 'float gFlake;' : GLOSS_PAINT_DECLS}`)
        .replace('#include <lights_phong_pars_fragment>', (rim ? RIM_EDGE_FN : '') +
          THREE.ShaderChunk.lights_phong_pars_fragment.replace(GLOSS_SPECULAR_FROM,
            classicPaint ? GLOSS_SPECULAR_CLASSIC
              : (look.specular ?? GLOSS_SPECULAR_TO) + (rim ? RIM_LIGHT : '')))
        .replace('#include <color_fragment>', `#include <color_fragment>
${GLOSS_COLOR}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
${classicPaint ? GLOSS_NORMAL_CLASSIC : GLOSS_NORMAL.replace('__LOOK_BASE__', look.base ?? '')}`)
        .replace('#include <envmap_fragment>', `#include <envmap_fragment>
${glossFragment(classicPaint || paintLook === 'toon' || paintLook === 'rim')
  .replace('__LOOK_SKY__', look.sky ?? LOOK_DEFAULT_SKY)
  .replace('__LOOK_MIRROR__', look.mirror ?? '')
  .replace('__LOOK_FINAL__', (look.final ?? '') + (rim ? RIM_SKY : '') + STREAKS)}`);
      // Never a blind replace (CLAUDE.md): a hook that matched nothing is a matte car and no error.
      for (const marker of ['attribute float aFinish', 'vGlossFinish = aFinish', 'aFinish > 2.5 && aFinish < 3.5']) {
        if (!shader.vertexShader.includes(marker)) throw new Error(`gloss: vertex hook missed (${marker})`);
      }
      for (const marker of ['uniform float uGloss;', 'gFinA = uFinishA', 'gSpecN = normalize',
        'gGlintIrr', 'gMirror']) {
        if (!shader.fragmentShader.includes(marker)) throw new Error(`gloss: fragment hook missed (${marker})`);
      }
    }

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
uniform float uToonBite;` : ''}${cloudsEnabled ? `
uniform float uCloudCover;
uniform float uCloudFloor;
uniform float uCloudTime;
uniform float uCloudScale;
uniform vec2 uCloudDrift;
uniform mat4 uCloudViewInv;
uniform vec4 uCell;
uniform float uCellEdge;
uniform float uCellTime;
uniform vec4 uCellShape;
uniform vec4 uCellLight;
${CLOUD_GLSL}` : ''}`);

    if (useAO) {
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
${cloudsEnabled ? CLOUD_LIGHT : ''}
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
/**
 * @param ao  false to leave this material out of the screen-space AO lookup.
 *
 * **A transparent surface has to opt out, and the reason is the rule in `markOccluder`.** That
 * function refuses to put a transparent mesh in the AO depth prepass — quite rightly, since a
 * surface you can see through has no business writing depth. But receiving is the default here, so
 * a translucent prop lit by this material samples the occlusion of *whatever is behind it*, which
 * is the exact failure `main.js` warns about beside `markOccluder` and is invisible until the
 * thing behind it is interesting.
 *
 * The river is where it stopped being invisible. Its water sits at the bottom of a two-unit
 * channel, so inside the city it sampled the walls' own crease and went nearly black, while the
 * stretch running off the end of the island had an empty AO buffer behind it and came out at full
 * brightness — a pale wedge shooting out of the river mouth, with the discontinuity landing
 * exactly on the coast. Nothing about the water changed across that line except what it was
 * reading out of a buffer it is not in.
 *
 * The asphalt's own fade skirt (`asphaltFade` in city/ground.js) is the other transparent
 * `propMaterial` in the project and has the same hole in it. It gets away with it because it lives
 * out past the ring road where the AO buffer is empty anyway, so its lookup is uniformly 1 — left
 * alone here rather than changed on spec.
 */
export function propMaterial({ ao = true, gloss = null, cutout = null, smooth = false } = {}) {
  // Crayon and Cartoon are both paint-on-paper looks, and a skyline in a crayon drawing's bodywork
  // is a photograph stuck to it — so under either one a glossy car is an ordinary prop.
  const paint = gloss && !crayonEnabled && !cartoonEnabled ? glossShape(gloss) : null;
  // Phong for the light loop its specular term sits in (see GLOSS_SPECULAR_TO), not for its own
  // specular, which the patch replaces outright.
  const material = paint
    ? new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: true })
    : new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  // Unconditional now: the shadow tint rides in the same patch and is always available. See
  // SHADOW_UNIFORMS for why it does not need a flag of its own.
  // `cutout`: an alpha map, cut at half rather than blended, so the surface still writes depth and
  // needs no sorting. Smooth-shaded so the geometry's own normals are the ones lit — the parks'
  // grass cards carry the ground's normal, and a flat-shaded card would light as its own face
  // (city/grass.js).
  if (cutout && !paint) {
    material.alphaMap = cutout;
    material.alphaTest = 0.5;
    material.flatShading = false;
  }
  // `smooth`: light from the geometry's own normals instead of the screen-space derivative. Facets
  // survive it — `bakeColors` hands every non-indexed face its own normal — so the only surfaces
  // that come out soft are the ones that were given soft normals on purpose: the tree crowns
  // (`treeParts`, city/props.js).
  if (smooth && !paint) material.flatShading = false;
  // A smooth body's normals are the point of it (see SMOOTH_BODY); everything else a vehicle
  // carries comes out of `bakeColor` with flat ones and so draws as it did.
  if (paint && SMOOTH_BODY) material.flatShading = false;
  patchProp(material, { ao, gloss: paint });
  return material;
}

/**
 * Vehicle finishes for `propMaterial({ gloss })`. What is paint, glass, metal or tyre comes from
 * the geometry's `aFinish` (`setFinish`) and how each behaves from `FINISH_DEFAULTS`; this only
 * says where the bent normals' curve is centred.
 *
 * @param gloss.geometry  the part, whose bounding box the curve is centred on.
 * @param gloss.floor     ignore everything below this y when centring — on a body, the sill, so
 *                        the wheels hanging below it don't pull the crown down toward the road.
 * @param gloss.amount    this material's multiplier on paint's reflection: the taxi a touch more
 *                        than the fleet, a cargo box less.
 * @param gloss.mirror    the same for every other finish — glass, metal, tyre. 1 on every vehicle.
 */
function glossShape({ geometry, floor = -Infinity, amount = 1, mirror = 1 }) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const lo = Math.max(box.min.y, floor);
  const centre = new THREE.Vector3((box.min.x + box.max.x) / 2, (lo + box.max.y) / 2,
    (box.min.z + box.max.z) / 2);
  const invHalf = new THREE.Vector3(
    2 / Math.max(box.max.x - box.min.x, 1e-3),
    2 / Math.max(box.max.y - lo, 1e-3),
    2 / Math.max(box.max.z - box.min.z, 1e-3),
  );
  return { amount, mirror, centre, invHalf };
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
