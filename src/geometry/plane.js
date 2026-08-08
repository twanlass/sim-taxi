import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor } from '../util/geo.js';
import { color } from '../palette.js';

// A little high-wing single — a Cessna, in the sense that everything about the silhouette that
// says "small plane" is here and nothing else is. It crosses the sky occasionally and is not part
// of the game: nothing collides with it, nothing can be tapped on it. See game/flyover.js for the
// flight itself.
//
// Nose points +X, the same convention every vehicle model in the project uses (`dirYaw` in
// city/grid.js turns a direction into the yaw that aims a +X model down it), so the flight code
// can compute a heading the same way the traffic does.

// True to scale a Cessna 172 is ~10 units of span here (the taxi is 4 units for a 4.5m car, so
// one unit ≈ 1.1m). It is drawn a touch under that on purpose: an orthographic camera gives no
// size cue for altitude, so a full-scale plane 30 units up reads as an airliner parked on the
// rooftops rather than as a light aircraft passing over.
export const PLANE_SPAN = 9;
const WING_CHORD = 1.35;
const WING_Y = 0.68;             // high wing: it sits *on* the cabin roof, which is the whole read
const PROP_X = 3.2;
const PROP_R = 1.05;

// How far the model hangs below its own origin — the bottom of the propeller arc, which reaches
// further down than the fuselage does and reaches it at every blade angle. Measured off the built
// geometry rather than guessed: `tools/probe.mjs` asserts it against the bounding box, and the
// flyover's clearance over the skyline is computed from it.
export const PLANE_UNDERSIDE = 1.05;

// The wingtip streamers. Not vapour in any physical sense: two tapered ribbons that say the thing
// is moving fast, at a camera where a plane in level flight otherwise slides across the sky with
// nothing on it changing.
const TRAIL_LEN = 6.5;
const TRAIL_SEGMENTS = 12;
const TRAIL_HEAD_W = 0.26;       // half-width; 0.52 wide is ~4px at play zoom
const TRAIL_TAIL_W = 0.09;
const TRAIL_ALPHA = 0.5;
// The streamer starts *behind* the tip rather than welded to it — a ribbon at full strength
// touching the wing reads as part of the aeroplane instead of as something coming off it.
const TRAIL_RISE = 0.1;          // fraction of the length spent ramping up to full alpha
const TRAIL_X = -0.15;           // wing trailing edge, in model space
const TRAIL_DECAY = 1.8;

const DISC_ALPHA = 0.11;
const PROP_BLADE = 2.1;

/** One axis-aligned box, coloured and placed. Every part of the plane is one of these. */
function box(w, h, d, x, y, z, name) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  return bakeColor(geometry, color(name));
}

/** Position along a streamer, and how wide and how strong it is there. */
function trailAt(t) {
  return {
    x: TRAIL_X - t * TRAIL_LEN,
    w: TRAIL_HEAD_W + (TRAIL_TAIL_W - TRAIL_HEAD_W) * t,
    a: TRAIL_ALPHA * Math.min(1, t / TRAIL_RISE) * (1 - t) ** TRAIL_DECAY,
  };
}

/**
 * Both streamers, as one non-indexed strip of quads, rolled about their own long axes by `roll`.
 *
 * The roll is what turns them from a pair of flat ribbons lying in the wing plane — invisible
 * edge-on, which is roughly how this camera sees that plane — into ribbons facing the viewer. The
 * camera never rotates, so the angle is a constant per heading rather than a per-frame billboard;
 * `trailRoll()` in game/flyover.js is where it comes from.
 *
 * Positions are rewritten in place on every launch. Alpha is baked once: it is a function of
 * distance along the streamer and nothing about the flight changes it.
 */
function writeTrails(geometry, roll) {
  const position = geometry.attributes.position.array;
  // The ribbon widens along this axis: local +Y rotated about local X.
  const uy = Math.cos(roll);
  const uz = Math.sin(roll);

  let p = 0;
  for (const side of [-1, 1]) {
    // Tucked a hair inboard of the tip. Exactly at the tip and the ribbon's own width hangs off
    // the end of the wing.
    const z0 = side * (PLANE_SPAN / 2 - 0.05);
    for (let k = 0; k < TRAIL_SEGMENTS; k++) {
      const a = trailAt(k / TRAIL_SEGMENTS);
      const b = trailAt((k + 1) / TRAIL_SEGMENTS);
      const corner = (seg, s) => [
        seg.x,
        WING_Y + s * seg.w * uy,
        z0 + s * seg.w * uz,
      ];
      const quad = [
        corner(a, -1), corner(b, -1), corner(b, 1),
        corner(a, -1), corner(b, 1), corner(a, 1),
      ];
      for (const [x, y, z] of quad) {
        position[p++] = x;
        position[p++] = y;
        position[p++] = z;
      }
    }
  }
  geometry.attributes.position.needsUpdate = true;
  // The streamers reach six units behind the group's origin, so the bounds have to be recomputed
  // or the mesh is culled against a sphere fitted to whatever roll was written last.
  geometry.computeBoundingSphere();
}

/** The static half of the streamers: white, with alpha rising off the tip and decaying out. */
function writeTrailColors(geometry) {
  const colors = geometry.attributes.color.array;
  let c = 0;
  for (let side = 0; side < 2; side++) {
    for (let k = 0; k < TRAIL_SEGMENTS; k++) {
      const a = trailAt(k / TRAIL_SEGMENTS).a;
      const b = trailAt((k + 1) / TRAIL_SEGMENTS).a;
      for (const alpha of [a, b, b, a, b, a]) {
        colors[c] = 1; colors[c + 1] = 1; colors[c + 2] = 1; colors[c + 3] = alpha;
        c += 4;
      }
    }
  }
}

function airframe() {
  const parts = [
    // Cowling, cabin, tail boom. Three boxes stepping down in section is the whole fuselage.
    box(1.1, 0.85, 0.85, 2.55, 0.02, 0, 'planeBody'),
    box(2.4, 1.05, 0.95, 0.85, 0.05, 0, 'planeBody'),
    box(3.0, 0.72, 0.62, -1.9, 0.02, 0, 'planeBody'),

    // Glazing, proud of the fuselage sides so it reads as a wrapped window band rather than as a
    // stripe painted on. Same trick the taxi's chequer uses.
    box(1.5, 0.5, 1.0, 1.05, 0.36, 0, 'carGlass'),

    // The cheatline down the flank — the one piece of colour on the thing, and what stops a white
    // aeroplane against a pale sky from being a blank shape.
    box(4.6, 0.16, 1.0, 0.4, -0.2, 0, 'planeStripe'),

    // High wing, sitting on the cabin roof.
    box(WING_CHORD, 0.16, PLANE_SPAN, 0.55, WING_Y, 0, 'planeBody'),

    // Tail feathers.
    box(1.1, 1.15, 0.14, -3.05, 0.75, 0, 'planeBody'),
    box(0.85, 0.13, 3.2, -3.1, 0.2, 0, 'planeBody'),
    box(0.9, 0.13, 0.16, -3.05, 1.1, 0, 'planeStripe'),
  ];

  // Lift struts, the other half of the high-wing read. A box along +Z, rolled onto the line from
  // the fuselage bottom out to the wing underside — rotating about X takes +Z toward -Y, hence
  // the negative angle.
  const dz = 2.6 - 0.45;
  const dy = (WING_Y - 0.08) - -0.35;
  const len = Math.hypot(dz, dy);
  for (const side of [-1, 1]) {
    const strut = new THREE.BoxGeometry(0.13, 0.13, len);
    strut.rotateX(-side * Math.asin(dy / len));
    strut.translate(0.45, -0.35 + dy / 2, side * (0.45 + dz / 2));
    parts.push(bakeColor(strut, color('planeBody')));
  }

  // No landing gear. At a 33° camera looking down on something 30 units up, the underside is
  // never in frame — the gear would be geometry nobody can see.

  const merged = mergeGeometries(parts, false);
  parts.forEach((part) => part.dispose());
  return merged;
}

/**
 * The model, as a group whose origin is the aircraft's own centre of mass — the flight code moves
 * and tilts this and nothing else.
 *
 * Deliberately **not** `propMaterial()`. That recipe carries the screen-space AO lookup, and a
 * mesh that receives occlusion without being in the depth prepass wears the occlusion of whatever
 * stands behind it (see the occluder rule in docs/rendering.md). Behind this one is the entire
 * skyline, so it would fly across the city collecting every building's contact line. It cannot go
 * in the prepass either — it is transparent, for the fade at both ends of a run. With AO off the
 * two materials are the same material anyway.
 */
export function createPlaneMesh() {
  const group = new THREE.Group();
  group.name = 'plane';
  group.rotation.order = 'YXZ';    // roll about the fuselage axis, as on the cars

  const body = new THREE.Mesh(
    airframe(),
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent: true }),
  );
  group.add(body);

  // The propeller, as its own mesh so it can spin about the fuselage axis. One bar rather than a
  // cross: a Cessna has two blades, and two blades is also 180° of symmetry — at the spin rate in
  // flyover.js that is what keeps it reading as rotation instead of strobing backwards.
  const blade = new THREE.Mesh(
    box(0.09, PROP_BLADE, 0.24, 0, 0, 0, 'planeProp'),
    new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent: true }),
  );
  blade.position.x = PROP_X;
  group.add(blade);

  // The blur the blade sweeps out. A spinning bar on its own reads as a bar being rotated; the
  // faint disc behind it is what says propeller. It does not turn — a disc has nothing to turn.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(PROP_R, 16),
    new THREE.MeshBasicMaterial({
      color: '#FFFFFF',
      transparent: true,
      opacity: DISC_ALPHA,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  disc.rotation.y = Math.PI / 2;   // CircleGeometry faces +Z; the prop disc faces the nose
  disc.position.x = PROP_X - 0.03;
  group.add(disc);

  // Wingtip streamers. Alpha rides in a four-component vertex colour, the same recipe the skid
  // marks and the island's fade skirt use — three switches the shader to USE_COLOR_ALPHA off the
  // attribute's itemSize, so this needs no shader of its own.
  const quads = TRAIL_SEGMENTS * 2;
  const trailGeometry = new THREE.BufferGeometry();
  trailGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(quads * 6 * 3), 3));
  trailGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(quads * 6 * 4), 4));
  writeTrailColors(trailGeometry);
  writeTrails(trailGeometry, 0);

  const trails = new THREE.Mesh(
    trailGeometry,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  group.add(trails);

  // Nothing here casts a shadow. The sun is 28.5° up, so a shadow from 30 units of altitude lands
  // some 55 units from the aeroplane that threw it — a dark blob crossing a street with nothing
  // visibly above it, on a shadow map sized for the whole city and with a few texels to spare for
  // a wing.

  const skin = [body.material, blade.material, trails.material];

  return {
    group,
    blade,
    trails,
    /** Turn the streamers about their own long axes so they face the camera. */
    setTrailRoll: (roll) => writeTrails(trailGeometry, roll),
    /** One opacity for the whole aircraft — the fade in and out at the ends of a run. */
    setFade: (fade) => {
      for (const material of skin) material.opacity = fade;
      disc.material.opacity = DISC_ALPHA * fade;
    },
  };
}
