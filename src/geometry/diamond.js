import * as THREE from 'three';

// The geodesic diamond — the shape a fare's clock is drawn as, over the rider and then over the
// taxi that collects them. game/faremarker.js is what gives it a life; this is just the model.
//
// It began as the drop-off pin's head, and for a spell both ends of a trip wore one: teal over the
// junction the taxi was driving to, urgency-coloured over a rider on the kerb. The drop-off has
// since gone back to being a ring on the road and nothing else, because a second crystal reporting
// no state was a silhouette the player had to tell apart from the one that did. So a diamond on the
// board now means exactly one thing: a clock is running here.
//
// It stays its own module rather than folding into game/faremarker.js — the shape, its outline and
// its bounce are a vocabulary the next marker should take from here rather than re-derive, and this
// way the model has no idea what a fare is.
//
// Octahedron: it reads clearly from straight above, unlike a sphere, and matches the crystal
// vocabulary used elsewhere in these prototypes.
//
// It is a *vessel*: the clock is the liquid in it, and the level drains. See "the fill" below.

export const DIAMOND_R = 1.9;

// One geometry for every diamond on the board — the shape never varies, only its colour and where
// it floats. The outline hulls share it too; they differ from the surface they wrap only by scale.
const GEO = new THREE.OctahedronGeometry(DIAMOND_R, 0);

// The outline's thickness, as a multiple of the diamond. At play zoom (1 world unit ≈ 7.7px) 1.12
// is about 1.7px of rim, which is the weight the marker pins carried back when they had posts.
export const RIM_SCALE = 1.12;

const BLACK = 0x000000;

// The fixed camera sees the face turned *away* from the sun, and pure Lambert on its own shades
// that face a long way down. The emissive lift keeps the crystal reading as its own hue rather
// than as a dark facet.
const EMISSIVE = 0.35;

// --- The fill -----------------------------------------------------------------------------------
//
// The crystal is drawn as a glass vessel with the fare's clock *inside* it. Below the surface line
// the urgency colour is the liquid — opaque, saturated and self-lit, exactly what the whole diamond
// used to be. Above it the same hue is emptied glass: the city visible straight through it at just
// under half alpha, most of the emissive lift gone, and a sheen on the facets turned edge-on. A
// bright band rides the line between them, which is the part the eye actually reads.
//
// **This is the continuous clock coming back.** The colour still steps in quarters — that is the
// alarm, and it kicks — but between two steps the level now moves every frame, so a fare can be
// read at 40% again rather than at "orange". That precision was the measured cost of retiring the
// timer ring (see docs/gameplay.md, "It used to be a relay"); it returns here without bringing back
// a second object to learn, because it is drawn on the shape that was already carrying the deadline.
//
// One mesh with a per-fragment alpha, not a glass shell around an inner solid: same silhouette, one
// draw call, and the bounce, the kick and the pulse keep animating a single object.
//
// The empty half was opaque at first — the hue at half lightness — and it read as a *dark solid*
// rather than as an empty vessel, which is the whole point of the thing. What stood in the way of
// real transparency is the black inverted hull: it is a larger octahedron drawn back-faces-only, so
// its far faces cover the entire silhouette, and glass over it would show a black void rather than
// the city. The fix is draw order rather than a different outline —
//
//   the crystal draws first (renderOrder 8) and **writes depth**, blending over the finished
//   opaque scene, then the hull draws (9) with the depth test on. Inside the silhouette its back
//   faces are behind the glass and fail the test; the ring between the two silhouettes has nothing
//   in front of it and passes. That ring is exactly the rim.
//
// Both are flagged `transparent` only to land in the same queue, which is the one place renderOrder
// decides anything. They stay well clear of the ghost outlines at 9990+, which run dead last and
// already treated this marker as an occluder back when it was opaque.

// Half-width of the surface band, in local units, so the band itself is twice this — 0.32 units,
// about 2.5px at play zoom against the rim's 1.7. `MENISCUS_CORE` is the fraction of it held at
// full brightness before the falloff starts: a pure smoothstep from the centre out has no crisp
// part at all at this size and the line read as a smudge rather than as a surface.
const MENISCUS = 0.16;
const MENISCUS_CORE = 0.4;

// Where the surface sits at a given fraction, as a multiple of DIAMOND_R. Linear in *height*, not
// in volume: the player reads the line's position, and equal time has to be equal travel. Volume
// would be the physical answer and it is much worse here — an octahedron is widest at its equator,
// so a volume-true drain spends the middle half of the clock inside the middle 20% of the body.
//
// The overshoot is exactly one band, which pushes full and empty far enough past the tips that no
// part of the meniscus still touches the geometry. So a fresh fare is a solid crystal (what the
// marker looked like before any of this) and a dead one is an empty vessel, with no stray highlight
// parked on a vertex. It costs 8% of the range at each end, which no clock is read at.
const FILL_OVERSHOOT = 1 + MENISCUS / DIAMOND_R;

// How much of the empty half survives the blend. This is what makes it read as *empty* rather than
// as a second colour: at a third, two thirds of every pixel up there is the city behind the marker,
// so the vessel thins out over whatever it is floating in front of instead of sitting on it.
const GLASS_ALPHA = 0.45;

// Emptied glass, as a transform of the fare's own hue rather than a colour of its own: nearly the
// same colour as the liquid, only much less of it. Which is what glass and liquid actually are —
// alpha is doing the emptying, so the tint has no reason to drift.
//
// Keeping the saturation is load-bearing. An early opaque version cut it to 0.55 and the empty half
// of a nearly-dead marker came out a dusty rose — the most urgent state on the scale rendering as
// the least red thing on the board. The hue has to carry the alarm across the *whole* silhouette;
// the fill is a second reading laid over it, not a replacement.
const GLASS_SAT = 0.9;
const GLASS_LIGHT = 0.6;

// How much of the emissive lift the empty half keeps, before alpha takes its share — so the light
// actually reaching the frame is nearer 0.6 × 0.34 ≈ 0.2 of the liquid's. Not zero: at midnight the
// sun is under 0.05 and the emissive is nearly all of what the marker is, so a vessel at 0 would
// leave a bright puddle floating in the dark with no shape around it.
const GLASS_EMISSIVE = 0.6;

// The glass sheen: facets at a grazing angle to the camera catch the surface colour. Flat shading
// makes this constant per face, so it lands as a couple of clean steps rather than a gradient — a
// hard-edged highlight is what says "glass" in a faceted city.
//
// The exponent matters more than the strength. At 2.5 it is not a highlight but a wash: an
// octahedron at this camera angle shows almost nothing head-on, so every visible facet picked up
// most of the lift and the vessel went pale all over. At 5 it stays on the one or two facets
// actually turned edge-on, which is where a highlight on glass belongs.
const SHEEN = 0.3;
const SHEEN_POWER = 5;

// The liquid's surface, in the same terms: the hue at half saturation, most of the way to white.
const SURFACE_SAT = 0.5;
const SURFACE_WHITE = 0.82;

const hsl = { h: 0, s: 0, l: 0 };

/** The emptied-glass colour for a fare's hue. */
function glassOf(target, source) {
  source.getHSL(hsl);
  return target.setHSL(hsl.h, hsl.s * GLASS_SAT, hsl.l * GLASS_LIGHT);
}

/** The liquid-surface colour for a fare's hue. */
function surfaceOf(target, source) {
  source.getHSL(hsl);
  return target.setHSL(hsl.h, hsl.s * SURFACE_SAT, THREE.MathUtils.lerp(hsl.l, 1, SURFACE_WHITE));
}

// Constants are inlined into the shader source rather than passed as uniforms — they never change
// at runtime, and a literal lets the compiler fold them. `toFixed` is not cosmetic: a constant that
// happens to be integral would emit `1`, and GLSL will not take an int where a float belongs.
const glsl = (n) => n.toFixed(4);

/**
 * Split a Lambert material's surface at a height, in the geometry's own local Y.
 *
 * Local rather than world, so the fill is immune to the bounce, the kick and the panic pulse — the
 * liquid rides in the vessel instead of sloshing when the marker hops. Returns the uniform the
 * caller moves.
 *
 * `flipped` is for the far-wall pass. Under `flatShading` three takes the normal from the screen-
 * space derivative of the view position, which follows the triangle's *rendered* winding — so on
 * back faces it comes out pointing into the screen and the wall lights as if the sun were behind
 * it. Three's own `FLIP_SIDED` never reaches this path; it only fixes the interpolated-normal one.
 */
function patchFill(material, flipped = false) {
  const uniforms = {
    uFill: { value: DIAMOND_R * FILL_OVERSHOOT },
    uGlass: { value: new THREE.Color() },
    uSurface: { value: new THREE.Color() },
  };

  // Without this the patch silently does nothing. Three computes the program cache key from the
  // material's *parameters* — before `onBeforeCompile` has touched the source — so a patched
  // Lambert material collides with every unpatched one that happens to share those parameters, and
  // `acquireProgram` hands back whichever compiled first. This city is full of flat-shaded Lambert,
  // so the diamond drew with a building's program and the fill went missing with nothing logged.
  material.customProgramCacheKey = () => (flipped ? 'diamond-fill-back' : 'diamond-fill');

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vFillY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvFillY = position.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vFillY;
uniform float uFill;
uniform vec3 uGlass;
uniform vec3 uSurface;`)
      // Before the lighting reads `diffuseColor`, so both halves still take the sun and the facets
      // still shade — this paints the vessel, it does not bypass the model.
      .replace('#include <color_fragment>', `#include <color_fragment>
\tfloat below = step(vFillY, uFill);
\tfloat meniscus = 1.0 - smoothstep(${glsl(MENISCUS * MENISCUS_CORE)}, ${glsl(MENISCUS)}, abs(vFillY - uFill));
\tdiffuseColor.rgb = mix(uGlass, diffuseColor.rgb, below);
\t// The liquid and its surface are solid; only the empty glass thins out.
\tdiffuseColor.a = mix(${glsl(GLASS_ALPHA)}, 1.0, max(below, meniscus));`)
      // After `normal_fragment_begin`, which is where `normal` comes from — and still before
      // `lights_lambert_fragment` hands `diffuseColor` to the lighting.
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
${flipped ? '\tnormal = -normal;\n' : ''}\tfloat sheen = (1.0 - below) * pow(1.0 - abs(dot(normal, normalize(vViewPosition))), ${glsl(SHEEN_POWER)});
\tdiffuseColor.rgb = mix(diffuseColor.rgb, uSurface, sheen * ${glsl(SHEEN)});
\t// A highlight is light bouncing off the glass rather than passing through it, so it thickens the
\t// surface where it lands. Without this the sheen dissolves into whatever is behind the marker.
\tdiffuseColor.a = max(diffuseColor.a, sheen);
\tdiffuseColor.rgb = mix(diffuseColor.rgb, uSurface, meniscus);
\ttotalEmissiveRadiance *= mix(${glsl(GLASS_EMISSIVE)}, 1.0, max(below, meniscus));`);
  };

  return uniforms;
}

// The transparent queue, where the crystal and its outline settle their order. Nothing else in the
// game sits between them; the numbers are small because the ground layers (route band 4, target
// discs 3–4) have to draw first, and the ghost outlines at 9990+ have to draw last.
export const DIAMOND_ORDER = 8;
export const DIAMOND_RIM_ORDER = 9;

/**
 * A black outline, drawn as an inverted hull: the same shape a little larger, with only its back
 * faces rendered. The enlarged back faces sit behind the real surface everywhere except around
 * the silhouette, which is exactly where the rim shows.
 *
 * Cheaper than a post-processing edge pass, and it needs no render targets — these are small
 * objects, not a whole-scene effect.
 *
 * Depth-tested but never depth-*writing*, and flagged transparent so it lands in the same queue as
 * the crystal it wraps. That is what lets the glass be see-through: the crystal draws first and
 * stamps depth, so every hull fragment inside the silhouette fails the test and only the ring
 * around the outside survives. Drawn the other way round, the hull's far faces are what you would
 * see through the empty half of the vessel, and the marker reads as a black void.
 */
export function outlineHull(geometry, scale) {
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: BLACK,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
    }),
  );
  mesh.renderOrder = DIAMOND_RIM_ORDER;
  mesh.scale.setScalar(scale);
  return mesh;
}

/**
 * One diamond: the crystal and the outline that wraps it.
 *
 * The hull is a *child* of the mesh, so it inherits any animation — the bounce below, or a group
 * the caller moves — for free.
 */
export function createDiamond(colorHex) {
  const color = new THREE.Color(colorHex);
  const mesh = new THREE.Mesh(GEO, new THREE.MeshLambertMaterial({
    color: color.clone(),
    emissive: color.clone(),
    emissiveIntensity: EMISSIVE,
    flatShading: true,
    // Per-fragment alpha: solid liquid, thin glass. `depthWrite` stays *on*, against the usual
    // habit for transparent materials — it is what hides the outline hull's far faces inside the
    // silhouette, and see the header for why the alternative is a black void.
    transparent: true,
    depthWrite: true,
  }));
  mesh.renderOrder = DIAMOND_ORDER;
  mesh.castShadow = true;

  // Near wall only. The far one was built and taken out again, and it is worth saying why, because
  // the argument for it is a good one: only the *near* half of the liquid's surface is drawn, and
  // the near half of a horizontal plane projects low, so at half full the level reads closer to a
  // third. Drawing the back faces as a second pass closes that chevron into the rhombus a real
  // meniscus makes, centred on the level the clock actually says.
  //
  // It cost more than it bought. The far wall's liquid is a solid slab filling everything below its
  // own (higher) surface line, so the see-through top — the entire point of the vessel — shrank to
  // the narrow wedge above it, and the two meniscus bands closed into a hard bright rectangle
  // across the middle that read as a label rather than as liquid. More correct, less legible.
  //
  // What is left is a known bias: the surface reads slightly low, by a chevron about 8px deep at
  // play zoom. It is the same shape at every level, so it offsets the reading rather than
  // distorting it, and the chevron's *outer corners* — where it meets the silhouette — sit at the
  // true level anyway. `patchFill`'s `flipped` argument is the useful half of the experiment kept
  // alive, since any back-face pass on this shape needs it.
  const fillUniforms = patchFill(mesh.material);
  let fill = 1;

  /** Restate the current hue as glass and as liquid surface. */
  const shadeVessel = () => {
    glassOf(fillUniforms.uGlass.value, mesh.material.color);
    surfaceOf(fillUniforms.uSurface.value, mesh.material.color);
  };
  shadeVessel();

  const rim = outlineHull(GEO, RIM_SCALE);
  mesh.add(rim);

  return {
    mesh,
    rim,
    /** Colour and emissive move together — they are the same hue at two strengths. */
    setColor(value) {
      mesh.material.color.set(value);
      mesh.material.emissive.set(value);
      // The glass and the surface are the same hue restated, so they follow it to the next level.
      shadeVessel();
    },
    /**
     * How full the vessel is, 0..1. The fine hand of the clock: the colour says which quarter, this
     * says where inside it.
     */
    setFill(fraction) {
      fill = THREE.MathUtils.clamp(fraction, 0, 1);
      fillUniforms.uFill.value = DIAMOND_R * FILL_OVERSHOOT * (fill * 2 - 1);
    },
    /** What the vessel is currently showing — for the headless tools, which have no GL to read. */
    getFill: () => fill,
    /**
     * Re-weight the outline. Used to ink a rider the taxi has been sent at.
     *
     * Weight rather than colour, because the crystal underneath is already using colour to say
     * something: a yellow rim was tried and it disappears into the yellow urgency level, which is
     * the exact half of the clock where "am I already going to this one?" gets asked most.
     */
    setRim(scale) {
      rim.scale.setScalar(scale);
    },
  };
}

// The diamond hops around its rest height. `Math.abs(sin)` rather than a plain sine: it never dips
// below the rest position, and the sharp cusp at the bottom of each cycle reads as a landing
// instead of a float.
export const BOUNCE_HEIGHT = 0.45;
export const BOUNCE_RATE = 3.4;

/** Height above the rest position at time `t` seconds. */
export const bounceOffset = (t) => Math.abs(Math.sin(t * BOUNCE_RATE)) * BOUNCE_HEIGHT;

// A one-shot "something just changed" kick: the diamond swells and hops, then settles.
//
// The colour it snaps to is the news, and a hue change on a 29px shape at the edge of the eye is
// easy to miss entirely — especially the ones that matter, which land while the player is watching
// the road rather than the kerb. Motion is what gets the glance; the colour is what pays it off.
export const KICK_TIME = 0.36;      // long enough to register, short enough not to read as idling
export const KICK_SCALE = 0.1;      // peak swell, so 29px goes to ~32px
export const KICK_HOP = 0.55;       // extra lift at the peak, ~4px on top of the resting bounce

/**
 * Kick envelope for `t` seconds since the change: 0 → 1 → 0 over KICK_TIME, 0 outside it.
 *
 * Asymmetric on purpose — the exponent pushes the peak early, so it snaps up and eases down. A
 * symmetric half-sine swells as slowly as it settles, which reads as a throb rather than a knock.
 */
export function kickEnvelope(t) {
  if (!(t >= 0) || t >= KICK_TIME) return 0;
  return Math.sin(Math.PI * (t / KICK_TIME) ** 0.65);
}
