import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColors, jitterVertices } from '../util/geo.js';
import { color, jitterColor } from '../palette.js';
import { SUN } from '../game/scene.js';

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

/** Per-lobe vertex jitter, as a fraction of that lobe's radius — matches the tree canopies' 0.1. */
const LOBE_JITTER = 0.1;

/**
 * Where the gradient's two colours land, as a fraction of the cloud's height. The lit white is not
 * reached until 0.75 and the shadow bottoms out at 0.15, so the ramp spends itself across the
 * middle of the shape instead of across all of it: a gradient run corner to corner is a *tint*,
 * and what this wants is a lit cap and a cool underside with the change happening somewhere you
 * can point at.
 */
const SHADE_LOW = 0.15;
const SHADE_HIGH = 0.75;

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
// So the material is unlit (game/clouds.js) and the shading is baked here, per face, off the same
// sun direction the scene uses. That buys back the thing the switch would otherwise have cost —
// **an unlit cloud with only a vertical gradient has no facets at all**, and the facets are the
// whole low-poly read — while leaving the colour exactly as authored. What it gives up is the
// shading turning with the day; the *tint* still does, through `cloudTint` in game/clouds.js,
// which is the half of it the eye actually tracks.
const LIGHT = new THREE.Vector3(
  Math.cos(SUN.azimuth) * Math.cos(SUN.elevation),
  Math.sin(SUN.elevation),
  Math.sin(SUN.azimuth) * Math.cos(SUN.elevation),
).normalize();

/**
 * How much of a face's brightness is ambient rather than the sun's.
 *
 * High, and deliberately: a cloud in its own shadow is still one of the brightest things in the
 * sky, and dropping the unlit side much below this reads as a rock. The remaining third is what
 * separates one facet from the next.
 */
const AMBIENT = 0.68;

const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * A cloud, as one merged non-indexed geometry with its colour baked per vertex.
 *
 * `span` is the long axis and `height` the top of the tallest lobe above the base plane — the
 * geometry is built with its base on y = 0 and its middle at x = z = 0, so the field can place it
 * by its underside and turn it about its own centre.
 *
 * The gradient is the lighting that a directional sun cannot give a white lump: at this sun's
 * elevation the top of a cloud is lit and its flanks are lit very nearly as much, so the shape
 * comes back as a flat white blob with facets. Baking the sky's own shadow into the vertices —
 * cool and blue underneath, white on top — is what puts a body back into it, and it costs nothing:
 * `bakeColors` writes a colour per vertex and `vColor` interpolates across a flat-shaded triangle
 * exactly as it would across a smooth one (see util/geo.js).
 */
export function createCloudGeometry(rng, { span = 32, height = 11 } = {}) {
  // The biggest lobe is the one that sets the height: `height = (1 + FLATTEN) · r` for a lobe
  // whose base is on y = 0, since its centre stands FLATTEN·r up and its cap reaches FLATTEN·r
  // above that.
  const rMax = height / (1 + FLATTEN);
  const parts = [];

  /** A lobe: radius r, centred `x` along the long axis and `z` across it, base on y = 0. */
  const lobe = (r, x, z, lift = 0) => {
    // Detail 1 for the lobes that carry the silhouette, 0 for the small ones riding on top — the
    // split the tree canopies make, for the same reason: a 20-face icosahedron at 7 units across
    // is a crystal, and at 3 units across it is a puff.
    const geo = new THREE.IcosahedronGeometry(r, r > rMax * 0.62 ? 1 : 0);
    jitterVertices(geo, rng, r * LOBE_JITTER);
    geo.scale(1, FLATTEN, 1);
    geo.translate(x, FLATTEN * r + lift, z);
    parts.push(geo);
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
  const count = Math.max(3, Math.round(span / (rMax * 1.15)));
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const r = rMax * (0.44 + 0.56 * Math.sin(Math.PI * t)) * rng.range(0.86, 1.06);
    lobe(r, (t - 0.5) * (span - 2 * r), rng.jitter(rMax * 0.22));
  }

  // Puffs riding on the shoulders of the row — what turns a sausage into a cauliflower. Kept over
  // the middle 60% of the span, where the row underneath them is fat enough to carry one, and their
  // lift is deliberately less than the lobe they sit on is tall so they always break its surface
  // rather than floating clear of it — the rule the tree canopy's `reach` follows.
  for (let n = 0, puffs = Math.max(1, count - 2); n < puffs; n++) {
    const r = rMax * rng.range(0.34, 0.52);
    lobe(r, rng.jitter(span * 0.3), rng.jitter(rMax * 0.25), rMax * rng.range(0.4, 0.7));
  }

  // `mergeGeometries` keeps non-indexed inputs non-indexed, which is what lets the colours below be
  // written straight against the merged position attribute. Handing `bakeColors` an indexed
  // geometry would have it un-index first and strand an array of the wrong length.
  const geometry = mergeGeometries(parts);

  // Per-cloud tint, on top of the gradient: a sky of identically white clouds reads as a texture
  // rather than as weather. Narrow — this is one hue with a couple of points of lightness in it.
  const lit = jitterColor(color('cloudLit'), rng, { h: 0.004, s: 0.03, l: 0.035 });
  const shade = jitterColor(color('cloudShade'), rng, { h: 0.004, s: 0.03, l: 0.035 });

  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const mix = new THREE.Color();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();

  // Walked a triangle at a time, and the normal comes off the **winding** rather than off the
  // normal attribute: `mergeGeometries` carries the icosahedra's own normals through, but a
  // geometry this module has scaled and translated is exactly the kind whose stored normals are
  // one edit away from being stale, and a reversed face here reads as a hole rather than as an
  // error. Every input is non-indexed, so three positions in a row really are a triangle — which
  // is not true in general (see the courier pad's winding check in tools/probe.mjs).
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    normal.copy(b).sub(a).cross(c.sub(a)).normalize();
    const key = AMBIENT + (1 - AMBIENT) * Math.max(0, normal.dot(LIGHT));

    for (let v = i; v < i + 3; v++) {
      const t = (pos.getY(v) / height - SHADE_LOW) / (SHADE_HIGH - SHADE_LOW);
      mix.copy(shade).lerp(lit, smoothstep(THREE.MathUtils.clamp(t, 0, 1))).multiplyScalar(key);
      colors[v * 3] = mix.r;
      colors[v * 3 + 1] = mix.g;
      colors[v * 3 + 2] = mix.b;
    }
  }

  return bakeColors(geometry, colors);
}
