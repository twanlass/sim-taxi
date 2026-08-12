import * as THREE from 'three';
import { ROUTE_OPACITY } from '../game/routeline.js';

// The disc a fare marks its ground with: a filled circle inside a solid rim, lying flat on the
// pavement corner. **One end of a trip wears one** — the drop-off, in the colour of the clock the
// taxi is racing to it (game/urgency.js) — so "a disc on the road means the taxi is being driven
// here" is one rule with one shape behind it.
//
// The rider's kerb has had one three times and given it back three times: a draining countdown
// ring, then nothing while the meter and later the diamond carried the clock overhead, then a
// second body for the crystal's own colour. What finished that last one is what the shape means
// rather than what it was reporting — a rider is somewhere the taxi *may* be sent, and painting
// them with the same mark as the place it *is* being sent made the disc say only "this matters".
//
// It never drains. Time is the colour's job; this only has to say "here".
//
// A third layer — the sweep — rides its outer edge: a bright head with a fading tail, circling at a
// fixed rate. Nothing about the fill or rim's own job changes; it is a quieter "this is a live
// target" cue layered over a mark that already reads on its own in a still frame.

export const RING_R = 3.5;
const RING_TUBE = 0.16;

// How far the disc floats above the surface it marks, so it paints over the pavement rather than
// z-fighting with it. Shared by both ends of the trip, which is what keeps them looking like the
// same object in two colours.
export const RING_Y = 0.2;

// One rim and one fill shape for every disc on the board — only the colour ever differs. The fill
// overlaps into the rim's tube rather than stopping at its inner edge, so no hairline of road shows
// between the two where the torus tessellates.
const RIM_GEO = new THREE.TorusGeometry(RING_R, RING_TUBE, 6, 48).rotateX(-Math.PI / 2);
const FILL_GEO = new THREE.CircleGeometry(RING_R - RING_TUBE / 2, 48).rotateX(-Math.PI / 2);

// The beam that rides the rim: a bright head with a fading tail, circling the outer edge, so the
// disc reads as "a place" at a glance (the flat rim still does that job on its own) and the motion
// is a second, quieter cue riding on top of it.
//
// A little fatter than the rim it sits on so it reads as a highlight glinting along the edge rather
// than a second, thinner ring drawn at the same width.
const TWO_PI = Math.PI * 2;
const SWEEP_TUBE = RING_TUBE * 1.4;
const SWEEP_GEO = new THREE.TorusGeometry(RING_R, SWEEP_TUBE, 6, 64).rotateX(-Math.PI / 2);
{
  // Angle around the ring, taken from the torus's own built-in `uv.x` (three writes
  // `i / tubularSegments` there — see TorusGeometry's source) rather than re-derived with
  // `atan2(z, x)` on the rotated position. atan2 has a branch cut, and that cut lands at the
  // *opposite* side of the ring from the torus's real seam, straight through the middle of an
  // ordinary face — the vertices on either side of it still read as adjacent physical points but
  // report angles π apart, and the fragment shader interpolates that as a false second glow where
  // there is no seam at all. `uv.x` climbs 0→1 monotonically across every face with no such jump,
  // because three never emits a face that wraps its last tubular column back to its first.
  const uv = SWEEP_GEO.attributes.uv;
  const angle = new Float32Array(uv.count);
  for (let v = 0; v < uv.count; v++) angle[v] = uv.getX(v) * TWO_PI;
  SWEEP_GEO.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
}

// One revolution every 3.2s — fast enough to read as motion on a glance down at the road, slow
// enough not to compete with the panic pulse (game/faremarker.js) for the eye's attention.
const SWEEP_SPEED = TWO_PI / 3.2;
// How much of the circle the glow covers, trailing the head. A third of the ring, so most of its
// border still reads as the flat rim colour and the beam is a distinct thing riding over it rather
// than the whole rim simply looking brighter.
const SWEEP_TAIL = TWO_PI * 0.34;

/**
 * The moving highlight, as a `MeshBasicMaterial` patched with a per-vertex angle attribute rather
 * than a bespoke `ShaderMaterial` — it wants everything the base material already does (the same
 * colour as the rim and fill, and three's ordinary `colorspace_fragment` output), only with the
 * alpha of each fragment computed from how far it sits behind a moving head angle.
 *
 * `customProgramCacheKey` is load-bearing: three keys its program cache off a patched material's
 * *parameters*, not the patch, so without it this would collide with the plain rim material the
 * instant they shared a colour and silently draw with whichever material's shader compiled first.
 */
function createSweep(colorHex) {
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(colorHex),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  material.customProgramCacheKey = () => 'ring-sweep';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uHead = { value: 0 };
    shader.uniforms.uTail = { value: SWEEP_TAIL };
    material.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAngle;\nvarying float vAngle;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAngle = aAngle;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform float uHead;\nuniform float uTail;\nvarying float vAngle;')
      .replace('#include <dithering_fragment>',
        'float behind = mod(uHead - vAngle, 6.283185307179586);\n'
        + '\tfloat glow = pow(1.0 - smoothstep(0.0, uTail, behind), 1.6);\n'
        + '\tgl_FragColor.a *= glow;\n'
        + '\t#include <dithering_fragment>');
  };

  const mesh = new THREE.Mesh(SWEEP_GEO, material);
  mesh.renderOrder = 5;   // over the rim (4) and fill (3) — the beam rides on top of both
  mesh.raycast = () => {};

  return {
    mesh,
    material,
    /** Advances the beam. A no-op until the shader has actually compiled once. */
    update(elapsed) {
      const shader = material.userData.shader;
      if (shader) shader.uniforms.uHead.value = (elapsed * SWEEP_SPEED) % TWO_PI;
    },
  };
}

/**
 * A target disc in one colour.
 *
 * The fill is at the route band's own opacity (see game/routeline.js), so a disc and the band
 * running into it read as one weight of paint. Depth-tested — a car crossing the junction should
 * drive *over* a disc rather than the disc painting across the car — and `depthWrite: false`, so
 * the two layers don't fight each other for the same plane.
 *
 * Being translucent puts the fill in three's transparent queue, which draws after every opaque
 * object regardless of order. That is exactly why the depth test has to stay on: under a waiting
 * rider, the far half of a flat circle projects *upward on screen* at this camera angle, and
 * without the test it would paint a band across the figure standing in it. (The old countdown ring
 * drew with the test off for legibility and needed a whole renderOrder convention to survive that.)
 */
export function createTargetRing(colorHex) {
  const group = new THREE.Group();
  const color = new THREE.Color(colorHex);

  const rim = new THREE.Mesh(
    RIM_GEO,
    new THREE.MeshBasicMaterial({ color: color.clone(), depthWrite: false }),
  );
  rim.renderOrder = 4;
  rim.raycast = () => {};
  group.add(rim);

  const fill = new THREE.Mesh(FILL_GEO, new THREE.MeshBasicMaterial({
    color: color.clone(),
    transparent: true,
    opacity: ROUTE_OPACITY,
    depthWrite: false,
  }));
  fill.renderOrder = 3;   // under the rim, so the rim still reads as an edge
  fill.raycast = () => {};
  group.add(fill);

  const sweep = createSweep(colorHex);
  group.add(sweep.mesh);

  return {
    group,
    /** All three layers together — they are one mark at three weights, never different colours. */
    setColor(value) {
      rim.material.color.set(value);
      fill.material.color.set(value);
      sweep.material.color.set(value);
    },
    /** Advances the beam circling the rim. Cheap enough to call every frame the disc is visible. */
    update(elapsed) {
      sweep.update(elapsed);
    },
  };
}
