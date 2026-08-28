import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { jitterVertices } from '../util/geo.js';
import { color, jitterColor } from '../palette.js';
import { SUN } from '../game/scene.js';
import { VIEW_DIR } from '../game/camera.js';

// One cloud: a row of jittered icosahedra sitting on a common base plane, merged into a single
// geometry. The same construction as a tree canopy in city/props.js — overlapping solids read as
// one fuller shape than any single blob does, and the seams where they meet disappear inside the
// silhouette — at four times the size and with the lobes laid out along a line rather than
// clustered on a trunk.
//
// The flight that carries these round the city is in game/clouds.js; this is only the model.
//
// **The long axis is local +X**, the same convention every other body in the project uses
// (`dirYaw` in city/grid.js turns a direction into the yaw that aims a +X model down it), so the
// field can point a cloud down the wind with a single yaw.
//
// --- Soft, out of hard geometry ----------------------------------------------------------------
//
// Everything else in this game wants its facets: `flatShading` and a hard silhouette are the whole
// look. A cloud is the exception — it has no surface, and a cumulus with visible polygons reads as
// a rock — so this model is the one place in the project that goes the other way, and it does it
// three times over:
//
//   - **Smooth normals.** The shading normal is the direction from the lobe's own centre to the
//     vertex (as an ellipsoid, so the vertical squash is accounted for) rather than the triangle's
//     winding, so the light runs *across* each face instead of stepping at every edge. Nothing is
//     welded and no vertices are shared: the normal is computed, used, and thrown away, because the
//     material is unlit and the shading it produces is already in the colour.
//   - **An edge fade.** Alpha falls to zero as the surface turns away from the camera, so the
//     silhouette — the one place a polygon can still be *seen* as a polygon — dissolves into the
//     sky instead of ending on an edge. This is what "low poly" actually costs you on a cloud, and
//     fading it is what buys back the softness without a single extra triangle. See `FEATHER`, and
//     `BURY` for the exemption that keeps the lobes from fading against *each other*.
//   - **A draw order settled at build time.** Translucent lobes have to be blended back to front,
//     which is normally a per-frame sort of everything on screen.
//
// All three are baked in here, and **all three only work because the camera never rotates**: a fade
// like this is usually a shader running `dot(normal, viewDir)` per fragment against a view that
// moves, and here the view direction is a constant this module can import.

/**
 * How much each lobe is squashed vertically. A sphere of fluff reads as a boulder; a cumulus is
 * wider than it is tall, and this is the whole of the difference.
 *
 * It also fixes where a lobe sits: with the squash applied, a lobe of radius r has its underside
 * FLATTEN·r below its centre, so putting every centre at exactly that height lands every lobe's
 * bottom on y = 0 whatever its size. That is what gives the heap **one flat base** rather than a
 * row of balls of assorted heights — the shape a cartoon cloud is drawn with, and the half of the
 * silhouette the eye actually reads, since the top is broken up by the lobes themselves.
 */
const FLATTEN = 0.8;

/**
 * Per-lobe vertex jitter, as a fraction of that lobe's radius.
 *
 * Half what the tree canopies use. A jittered vertex moves off the ellipsoid the smooth normal is
 * computed against, so every unit of jitter is a unit of disagreement between the shading and the
 * shape — which on a flat-shaded canopy is free, and here shows up as a mottle. Enough to stop the
 * lobes reading as billiard balls, not enough to fight the smoothing.
 */
const LOBE_JITTER = 0.05;

/**
 * Where the gradient's two colours land, as a fraction of the cloud's height. The lit white is not
 * reached until 0.8 and the shadow bottoms out at 0.1, so the ramp spends itself across the whole
 * body rather than banding in the middle of it.
 */
const SHADE_LOW = 0.1;
const SHADE_HIGH = 0.8;

// --- The light, baked in ----------------------------------------------------------------------
//
// **A cloud is the one thing in this game that is not lit by the scene's lights**, and the reason
// is what happened when it was: at this sun a white lump came back as a *sandstone boulder*. The
// key is `#FFDEBB` and the hemisphere fill is warm at both ends — `hemiSky` a peach, `hemiGround` a
// brown — so every upward face went cream, every downward face went the colour of the sidewalk, and
// the cool underside the palette asks for was multiplied straight out of existence. That lighting
// is right for a city at golden hour and wrong for the only white object in the sky, and no choice
// of base colour can undo it: a warm key cannot be cancelled by a base colour without going past
// white in the blue channel.
//
// So the material is unlit (game/clouds.js) and the light is baked here, off the same sun direction
// the scene uses, leaving the colour exactly as authored. What it gives up is the shading turning
// with the day; the *tint* still does, through `cloudTint` in game/clouds.js, which is the half of
// it the eye actually tracks.
const LIGHT = new THREE.Vector3(
  Math.cos(SUN.azimuth) * Math.cos(SUN.elevation),
  Math.sin(SUN.elevation),
  Math.sin(SUN.azimuth) * Math.cos(SUN.elevation),
).normalize();

/**
 * How much of the brightness is ambient rather than the sun's.
 *
 * High, and deliberately: a cloud in its own shadow is still one of the brightest things in the
 * sky, and dropping the unlit side much below this reads as a rock. What is left is a wash across
 * the body rather than a light with a dark side — which is the whole of what a smooth normal buys,
 * since the same number over a face normal was drawing hard-edged facets.
 */
const AMBIENT = 0.88;

/**
 * How far the sunlit side of a cloud goes toward the sun's **own colour**, at full facing.
 *
 * The shading above is a scalar, and a scalar can only ever make a white cloud a darker white: it
 * carries no hue at all, which is why the first soft build read as a paper cut-out. This is the
 * other half of what a light does — and it has to be *this* strong because of where the sun is:
 * `LIGHT · VIEW_DIR` is 0.98, so the sun sits almost directly behind the camera and nearly every
 * face the player can see is a lit one. There is no warm side and cool side to be had; what the
 * warmth actually does here is put a cast over the whole drawn surface, against the cool underside
 * the vertical gradient is already painting — and it is a *lerp toward* the sun's hue rather than a multiply
 * by its colour, so it shifts where the cloud sits on the wheel without dimming it. The lit face
 * lands on #F4EED9 against the shaded side's #A9C0DA, which is a warm cloud with a cool
 * underside: the oldest reading in the book, and the one thing that says the light in this scene
 * and the light on this cloud are the same light.
 *
 * `SUN_HUE` is `PALETTE.sun` scaled so its brightest channel is 1, for the same reason — the sun's
 * value is the scene's business and only its colour is wanted here. It is the *parked* sun rather
 * than the hour's, since this is baked; the day cycle reaches these through `cloudTint` instead.
 */
const SUN_WARMTH = 0.5;

const SUN_HUE = (() => {
  const c = color('sun');
  return c.multiplyScalar(1 / Math.max(c.r, c.g, c.b));
})();

/**
 * Where the fade starts, as a fraction of a lobe's radius **on the screen**.
 *
 * Measured across the drawn disc rather than off `dot(normal, VIEW_DIR)` directly, and that is the
 * difference between a soft cloud and a cloud with a slightly blurred edge. The dot product is
 * `cos` of the angle off the view axis, which stays near 1 across most of a sphere's disc and then
 * collapses: fading on it linearly spends the *whole* ramp in the last tenth of the radius — about
 * four pixels at play zoom — and the first build of this did exactly that and still read as an
 * edge. `sin` of the same angle is the screen radius, and fading on that puts the ramp where it can
 * be seen.
 *
 * It trades softness against body, and both ends of that were visible on the way to 0.38. Alone, at
 * 0.3, the clouds came out as pale ghosts with every lobe showing through every other one: a cloud
 * is opaque by *stacking* translucent lobes, and a third of a disc is not enough to stack with. It
 * took 0.52 to carry the body — until `BURY` below took the interior out of the fade's hands
 * entirely, which is what let this come back down to a third of the disc solid and two thirds
 * dissolving. It still costs size, and `EDGE_GAIN` is what pays for that.
 */
const FEATHER = 0.38;

/**
 * How deep inside a *neighbouring* lobe a vertex has to sit, as a fraction of that lobe's radius,
 * before the fade lets go of it entirely.
 *
 * The fade is a statement about the outside of the cloud, and a lobe buried in the middle of one
 * has no outside. Applied blindly it fades every lobe's rim against its own neighbours, and the
 * cloud comes back as a row of overlapping *discs*: each intersection curve draws an arc, because
 * that is exactly where one lobe's surface is turning away from the camera while the next one's is
 * still solid. Lifting the alpha back to 1 wherever another lobe is standing behind this surface is
 * what turns the heap into one body — and it is the same test that would let those triangles be
 * deleted outright, if the count were ever worth the trouble.
 */
const BURY = 0.12;

/**
 * What the lobes are grown by to pay for that. The fade eats the outside of every lobe, so a cloud
 * built to the size it should *look* comes out small and thin; this puts it back. Applied to the
 * radii and not to the span, so the lobes overlap harder and the cloud closes up rather than
 * getting longer.
 */
const EDGE_GAIN = 1.28;

const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * A cloud, as one merged non-indexed geometry with colour **and alpha** baked per vertex.
 *
 * `span` is the long axis and `height` the top of the tallest lobe above the base plane — the
 * geometry is built with its base on y = 0 and its middle at x = z = 0, so the field can place it
 * by its underside and turn it about its own centre.
 *
 * `yaw` is the rotation the mesh will be given, and it is a *parameter* rather than something to be
 * applied afterwards because two of the things baked in here are view-dependent: the rim fade needs
 * the surface's angle to the camera, and the draw order below needs each lobe's depth. Both are
 * computed in the model's own space, against a light and a view direction turned backwards through
 * the yaw, which is the same arithmetic and one rotation instead of thousands.
 */
export function createCloudGeometry(rng, { span = 32, height = 11, yaw = 0 } = {}) {
  // The biggest lobe is the one that sets the height: `height = (1 + FLATTEN) · r` for a lobe
  // whose base is on y = 0, since its centre stands FLATTEN·r up and its cap reaches FLATTEN·r
  // above that.
  const rMax = height / (1 + FLATTEN);
  const lobes = [];

  /** A lobe: radius r, centred `x` along the long axis and `z` across it, base on y = 0. */
  const lobe = (r, x, z, lift = 0) => {
    const grown = r * EDGE_GAIN;
    // Detail 1 throughout, where the flat-shaded build used 0 for the small ones. A 20-face
    // icosahedron is a crystal, and smoothing its normals only turns it into a crystal with a
    // gradient painted on: the silhouette is still a decagon, and the silhouette is the half of it
    // the rim fade cannot fully hide on a lobe this size.
    const geo = new THREE.IcosahedronGeometry(grown, 1);
    jitterVertices(geo, rng, grown * LOBE_JITTER);
    geo.scale(1, FLATTEN, 1);
    // Not needed and not carried: the material is unlit, so three never reads a normal, and every
    // lobe has to present the same attributes for `mergeGeometries` to accept them.
    geo.deleteAttribute('normal');
    geo.deleteAttribute('uv');
    const centre = new THREE.Vector3(x, FLATTEN * r + lift, z);
    geo.translate(centre.x, centre.y, centre.z);
    lobes.push({ geo, centre, radius: grown });
  };

  // The main row, spread along the long axis with the fat lobes in the middle. The sine profile is
  // what tapers the ends: a row of equal lobes reads as a caterpillar, and the taper is what makes
  // one end of the cloud thin out the way weather does.
  //
  // **How many is derived from the span, not drawn.** A cloud is as long as it is and as tall as
  // the ratio says, so the lobes have a size already; asking the generator for "four to six" of
  // them then decides whether they overlap by luck. At four lobes over a 46-unit span the spacing
  // came out at 11.5 against a radius of 7.7 and the cloud arrived as a *string of separate balls*.
  // This spaces them at 1.15 radii, which always closes.
  const count = Math.max(4, Math.round(span / (rMax * 0.82)));
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const r = rMax * (0.44 + 0.56 * Math.sin(Math.PI * t)) * rng.range(0.86, 1.06);
    lobe(r, (t - 0.5) * (span - 2 * r), rng.jitter(rMax * 0.22));
  }

  // Puffs riding on the shoulders of the row — what turns a sausage into a cauliflower. Kept over
  // the middle 60% of the span, where the row underneath them is fat enough to carry one, and their
  // lift is deliberately less than the lobe they sit on is tall so they always break its surface
  // rather than floating clear of it — the rule the tree canopy's `reach` follows.
  for (let n = 0, puffs = Math.max(2, count - 2); n < puffs; n++) {
    const r = rMax * rng.range(0.34, 0.58);
    lobe(r, rng.jitter(span * 0.34), rng.jitter(rMax * 0.3), rMax * rng.range(0.35, 0.75));
  }

  // The light and the camera, turned backwards through the yaw so both can be used against the
  // model's own coordinates. `n_world · v` is `(Ry(yaw) · n) · v`, which is `n · (Ry(-yaw) · v)`.
  const axis = new THREE.Vector3(0, 1, 0);
  const light = LIGHT.clone().applyAxisAngle(axis, -yaw);
  const view = VIEW_DIR.clone().applyAxisAngle(axis, -yaw);

  // **Back to front, and it holds for the life of the cloud.** The rim fade makes every lobe
  // translucent at its edges, so the lobes have to be blended in depth order or a far one paints
  // over a near one's core — and with `depthWrite` off (game/clouds.js) nothing else is going to
  // stop it. Sorting per *frame* is what an engine normally has to do here; this camera never
  // rotates, so the order is a property of the model and is settled once, at build time. Per lobe
  // is enough because a lobe is convex: its own front faces cannot overlap each other on screen.
  lobes.sort((a, b) => a.centre.dot(view) - b.centre.dot(view));

  const geometry = mergeGeometries(lobes.map((l) => l.geo));

  // Per-cloud tint, on top of the gradient: a sky of identically white clouds reads as a texture
  // rather than as weather. Narrow — this is one hue with a couple of points of lightness in it.
  const lit = jitterColor(color('cloudLit'), rng, { h: 0.004, s: 0.03, l: 0.035 });
  const shade = jitterColor(color('cloudShade'), rng, { h: 0.004, s: 0.03, l: 0.035 });

  const pos = geometry.attributes.position;
  // Four components: rgb and the rim fade. The same trick the island's own edge fade uses
  // (city/ground.js) — three reads an itemSize of 4 as `USE_COLOR_ALPHA` and multiplies it into the
  // material's opacity, so a per-vertex fade needs no shader of its own.
  const colors = new Float32Array(pos.count * 4);
  const mix = new THREE.Color();
  const warm = new THREE.Color();
  const normal = new THREE.Vector3();

  let at = 0;
  const inside = new THREE.Vector3();
  for (const lobe of lobes) {
    const { geo, centre } = lobe;
    const lobePos = geo.attributes.position;
    for (let i = 0; i < lobePos.count; i++) {
      // How far into its deepest neighbour this vertex sits, as a fraction of that lobe's radius.
      // Measured in the *sphere's* space — the y undone by FLATTEN — since that is the shape a lobe
      // was before it was squashed, and the only space its radius means anything in.
      let buried = 0;
      for (const other of lobes) {
        if (other === lobe) continue;
        inside.set(lobePos.getX(i), lobePos.getY(i), lobePos.getZ(i)).sub(other.centre);
        inside.y /= FLATTEN;
        buried = Math.max(buried, 1 - inside.length() / other.radius);
      }

      normal.set(lobePos.getX(i), lobePos.getY(i), lobePos.getZ(i)).sub(centre);
      // The ellipsoid's normal, not the sphere's: with the body squashed by FLATTEN the outward
      // normal at a point is `(x, y / FLATTEN², z)`. Left as `p - centre` the top of every lobe
      // reports itself as more upright than it is, and the shading rolls off in the wrong place.
      normal.y /= FLATTEN * FLATTEN;
      normal.normalize();

      const sunlit = Math.max(0, normal.dot(light));
      const t = (lobePos.getY(i) / height - SHADE_LOW) / (SHADE_HIGH - SHADE_LOW);
      mix.copy(shade).lerp(lit, smoothstep(THREE.MathUtils.clamp(t, 0, 1)))
        .multiplyScalar(AMBIENT + (1 - AMBIENT) * sunlit);
      // And the sun's colour on top of the sun's brightness, strongest where it is square on.
      warm.copy(mix).multiply(SUN_HUE);
      mix.lerp(warm, SUN_WARMTH * sunlit);

      colors[at] = mix.r;
      colors[at + 1] = mix.g;
      colors[at + 2] = mix.b;
      // Where this vertex lands on the lobe's drawn disc: 0 at the point aimed straight at the
      // camera, 1 at the silhouette — `sin` of the angle off the view axis, which for a sphere is
      // exactly the screen radius. Anything facing away is zero outright: those faces are culled,
      // but `edge` alone cannot tell the near side of a lobe from the far one.
      const facing = normal.dot(view);
      const edge = Math.sqrt(Math.max(0, 1 - facing * facing));
      const fade = facing <= 0
        ? 0
        : 1 - smoothstep(THREE.MathUtils.clamp((edge - FEATHER) / (1 - FEATHER), 0, 1));
      colors[at + 3] = Math.max(fade, smoothstep(THREE.MathUtils.clamp(buried / BURY, 0, 1)));
      at += 4;
    }
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  return geometry;
}
