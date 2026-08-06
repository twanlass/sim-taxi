import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { VIEW_DIR } from './camera.js';

// Wingtip vapour. Two ribbons streaming off the taxi's rear body corners in Loco Mode, the way
// contrails come off the tips of a wing.
//
// Not a particle pool like the dust — a stream has to be *continuous*. Motes spaced along a path
// read as a dotted line at any emission rate the frame budget can afford, and the thing being sold
// here is an unbroken line the eye can track. So this is a ribbon: a trail of points laid down as
// the car drives, rebuilt into a triangle strip every frame.
//
// The dust already says "wheels are tearing at the road". This says "the air can't get out of the
// way", which is a different claim and reads at a different height — the streams sit at the car's
// shoulder line, well clear of the road plane where the rubber and the puffs live.
//
// Three things do the work:
//
//   - **The head is attached to the car, the body is not.** Every frame the tip position is
//     written as a live head vertex, while the points behind it were committed at fixed intervals
//     of *travel* and then left in world space to age. The ribbon therefore tracks the bumper
//     exactly while its tail hangs in the air where the car used to be.
//   - **Width and alpha run off each point's age**, not its index: a stream laid at 60fps and one
//     laid at 30fps taper identically, and a car that slows down leaves a *shorter* streak rather
//     than the same streak drawn closer together.
//   - **Strength is sampled at emission time** and stored per point, so a section laid down at
//     full chat stays bright while the car is stuck behind a bus, and vice versa.

// Points per ribbon. Points expire by age, not by count, so this only has to clear the longest
// ribbon the sim can produce: LIFE * boost speed / SPACING = 0.68 * 18.7 / 0.55 ≈ 23.
const MAX_POINTS = 32;

// How long a point survives after it is laid down. At the 18.7 u/s of Loco Mode that draws a
// ribbon about 13 units long — roughly 100px at play zoom, most of the way across a block.
//
// Length is doing most of the work of the effect, so this is the knob that matters: a stream that
// dies in half the distance reads as a puff of something rather than as a line being drawn by a
// car going too fast to stop.
const LIFE = 0.68;

// Travel between committed points. Under half a car length, so a junction arc bends the ribbon
// smoothly instead of cutting the corner across three long segments.
const SPACING = 0.55;

// Widths at the two ends of a point's life, in world units. The stream leaves the corner as a
// near-point and diffuses as it falls behind — the reverse of the dust, which starts as a puff.
// The fragment shader's soft edge eats roughly a third of the geometric width, so these are wider
// than the intended read: 0.88 is 6.8px at play zoom (1 unit ≈ 7.7px), landing about 4.5px of
// visible core — a stream, against the ~15px width of the car shedding it.
const HEAD_WIDTH = 0.20;
const TAIL_WIDTH = 0.88;

// Fraction of a point's life over which it reaches full width. Emphatically not 1.
//
// Ramping the width across the whole life put the widest part of the ribbon exactly where the
// alpha ramp had already taken it to nothing, so every pixel bright enough to see was also a
// pixel from the narrow end — the stream read as a wire drawn behind the car, and widening it
// only made the invisible half wider. Front-loading the ramp puts full width under the bright
// two-thirds and lets the fade, rather than the taper, be what ends the stream.
const WIDTH_RAMP = 0.35;

const OPACITY = 0.78;

// Drift while the point ages.
//
// The spread is the important half. The two wingtips are only 2 units apart and the camera looks
// down a diagonal, so on the axis where that gap projects shortest the pair collapses into a
// single stroke — and one stroke off the middle of the roof reads as a rope being dragged, not as
// wingtip vapour. Pushing them apart as they age (half a unit over a life) keeps them legible as
// a *pair* from every heading the grid allows.
//
// The rise is deliberately small. An early version lifted hard enough that the ribbon climbed
// clear of the roofline and the car looked like it was trailing a kite; vapour wants to sit in
// the plane the car is travelling through, with just enough lift to clear its own dust.
const RISE = 0.32;
const SPREAD = 0.75;

const LANES = 2;
const VERTS_PER_SEGMENT = 6;
const MAX_VERTS = LANES * MAX_POINTS * VERTS_PER_SEGMENT;

// Scratch for one ribbon's polyline: the committed points plus the live head. Module-level and
// reused, so a frame of rebuilding allocates nothing.
const sx = new Float32Array(MAX_POINTS + 1);
const sy = new Float32Array(MAX_POINTS + 1);
const sz = new Float32Array(MAX_POINTS + 1);
const sAge = new Float32Array(MAX_POINTS + 1);
const sStr = new Float32Array(MAX_POINTS + 1);

// Half-width offset and alpha per point, resolved for the whole polyline before any triangle is
// written so that a point shared by two segments gets one answer.
const ofx = new Float32Array(MAX_POINTS + 1);
const ofy = new Float32Array(MAX_POINTS + 1);
const ofz = new Float32Array(MAX_POINTS + 1);
const ofFade = new Float32Array(MAX_POINTS + 1);

function createLane() {
  return {
    px: new Float32Array(MAX_POINTS),
    py: new Float32Array(MAX_POINTS),
    pz: new Float32Array(MAX_POINTS),
    ox: new Float32Array(MAX_POINTS),   // outward direction, held per point so the drift keeps
    oz: new Float32Array(MAX_POINTS),   // pushing the way the car was facing when it was laid
    age: new Float32Array(MAX_POINTS),
    str: new Float32Array(MAX_POINTS),
    start: 0,
    count: 0,
    // This frame's tip. Rewritten every frame the taxi is streaming and cleared at the end of
    // update(), so a released button drops the attachment and leaves the rest to age out.
    live: false,
    hx: 0, hy: 0, hz: 0, hs: 0,
  };
}

export function createSpeedLines(scene) {
  const positions = new Float32Array(MAX_VERTS * 3);
  const fades = new Float32Array(MAX_VERTS);
  const cross = new Float32Array(MAX_VERTS);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aFade', new THREE.BufferAttribute(fades, 1));
  geometry.setAttribute('aCross', new THREE.BufferAttribute(cross, 1));

  // Alpha rides in a float attribute rather than a 4-component colour, for the same reason the
  // route band's does: a colour attribute with alpha trips USE_COLOR_ALPHA and a different code
  // path. `aCross` is the position across the ribbon, -1 at one edge to +1 at the other, and the
  // parabolic falloff off it is what makes the strip read as vapour rather than as tape.
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(PALETTE.speedLine) },
    },
    vertexShader: /* glsl */`
      attribute float aFade;
      attribute float aCross;
      varying float vFade;
      varying float vCross;
      void main() {
        vFade = aFade;
        vCross = aCross;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    // `colorspace_fragment` by hand — a ShaderMaterial gets none of the built-in chunks, and
    // without it this renders linear and lands visibly dimmer than the additive flame beside it.
    // It runs *before* the premultiply, because premultiplied colour is no longer in a colour
    // space and converting it is wrong by however much alpha isn't 1.
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying float vFade;
      varying float vCross;
      void main() {
        float a = vFade * max(0.0, 1.0 - vCross * vCross);
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
        gl_FragColor = vec4(gl_FragColor.rgb * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    // Additive, so the streams *brighten* the street behind them instead of painting a white decal
    // across it — the same call the tailpipe flame makes. Premultiplied, so the strength ramp and
    // the tail fade actually attenuate it rather than every fragment blowing out to full white.
    premultipliedAlpha: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // Above the dust (3) and under the flame (6): the vapour is in front of the puffs it is being
  // torn out of, and behind the one genuinely hot thing on screen.
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  const lanes = [];
  for (let k = 0; k < LANES; k++) lanes.push(createLane());

  const at = (lane, k) => (lane.start + k) % MAX_POINTS;

  function commit(lane, x, y, z, ox, oz, strength) {
    // Full is the normal state, not an error: the oldest point falls off the tail to make room,
    // which is the same thing ageing would have done to it a frame or two later.
    if (lane.count === MAX_POINTS) {
      lane.start = (lane.start + 1) % MAX_POINTS;
      lane.count -= 1;
    }
    const i = at(lane, lane.count);
    lane.count += 1;
    lane.px[i] = x;
    lane.py[i] = y;
    lane.pz[i] = z;
    lane.ox[i] = ox;
    lane.oz[i] = oz;
    lane.age[i] = 0;
    lane.str[i] = strength;
  }

  /**
   * Stream from a wingtip. Call every frame the taxi should be shedding vapour, with the tip's
   * world position, the unit direction pointing *outward* from the car's flank, and a 0..1
   * strength.
   *
   * Spacing is decided in here rather than by the caller because the head is a different thing
   * from the body: the tip is recorded live every frame so the ribbon stays welded to the car,
   * while the trail behind it only gains a point every SPACING units of travel. Callers pacing
   * their own emission (as the dust and the rubber do off `car.travelled`) would get the spacing
   * right and the attachment wrong.
   */
  function emit(index, x, y, z, ox, oz, strength = 1) {
    const lane = lanes[index];
    if (!lane || strength <= 0) return;

    lane.live = true;
    lane.hx = x;
    lane.hy = y;
    lane.hz = z;
    lane.hs = strength;

    if (lane.count === 0) {
      commit(lane, x, y, z, ox, oz, strength);
      return;
    }
    const i = at(lane, lane.count - 1);
    const dx = x - lane.px[i];
    const dy = y - lane.py[i];
    const dz = z - lane.pz[i];
    if (dx * dx + dy * dy + dz * dz >= SPACING * SPACING) {
      commit(lane, x, y, z, ox, oz, strength);
    }
  }

  // Offsetting across the ribbon along `cross(alongTheRibbon, VIEW_DIR)` turns its width to face
  // the camera, so a stream is never seen edge-on and never vanishes. The camera is fixed, so the
  // view direction is a module constant and this costs one cross product per point — no per-frame
  // camera read, and no `lookAt` on a mesh that is rebuilt from scratch anyway.
  const dir = new THREE.Vector3();
  const side = new THREE.Vector3();

  function build() {
    let v = 0;
    let n = 0;

    const push = (x, y, z, fade, edge) => {
      positions[v++] = x;
      positions[v++] = y;
      positions[v++] = z;
      fades[n] = fade;
      cross[n] = edge;
      n += 1;
    };

    for (const lane of lanes) {
      // Oldest first, so the ribbon runs tail → head and the live tip closes it off.
      let m = 0;
      for (let k = 0; k < lane.count; k++) {
        const i = at(lane, k);
        sx[m] = lane.px[i];
        sy[m] = lane.py[i];
        sz[m] = lane.pz[i];
        sAge[m] = lane.age[i];
        sStr[m] = lane.str[i];
        m += 1;
      }
      if (lane.live) {
        sx[m] = lane.hx;
        sy[m] = lane.hy;
        sz[m] = lane.hz;
        sAge[m] = 0;
        sStr[m] = lane.hs;
        m += 1;
      }
      if (m < 2) continue;

      // Pass one: the half-width offset and the alpha at every point. Done for the whole polyline
      // before any triangle is written, so a point shared by two segments is measured once and
      // both segments quote the same number — offsetting each segment on its own leaves a wedge
      // of gap on the outside of every bend, the same trap the route band hit.
      for (let p = 0; p < m; p++) {
        // Central difference where there is one, so a point's width axis splits the angle between
        // the segments meeting at it. The two ends fall back to their single neighbour.
        const a = Math.max(0, p - 1);
        const b = Math.min(m - 1, p + 1);
        dir.set(sx[b] - sx[a], sy[b] - sy[a], sz[b] - sz[a]);
        side.crossVectors(dir, VIEW_DIR);
        // A ribbon running straight down the view axis has no width axis to pick. Cars drive the
        // grid axes and the camera looks down the diagonal, so this is unreachable in play — but
        // a zero-length side vector would collapse the ribbon to a line, and the guard is a
        // branch.
        if (side.lengthSq() < 1e-8) side.set(1, 0, 0); else side.normalize();

        const t = Math.min(1, sAge[p] / LIFE);
        const half = (HEAD_WIDTH
          + (TAIL_WIDTH - HEAD_WIDTH) * Math.min(1, t / WIDTH_RAMP)) / 2;
        ofx[p] = side.x * half;
        ofy[p] = side.y * half;
        ofz[p] = side.z * half;
        // Eases out rather than falling linearly: the streak holds its brightness for most of its
        // length and then lets go, which is what keeps it reading as one continuous line rather
        // than a gradient smear.
        ofFade[p] = OPACITY * sStr[p] * (1 - t) ** 1.4;
      }

      // Pass two: two triangles per segment, (aL, bL, bR) (aL, bR, aR).
      for (let p = 0; p < m - 1; p++) {
        const q = p + 1;
        const aL = () => push(sx[p] + ofx[p], sy[p] + ofy[p], sz[p] + ofz[p], ofFade[p], -1);
        const aR = () => push(sx[p] - ofx[p], sy[p] - ofy[p], sz[p] - ofz[p], ofFade[p], 1);
        const bL = () => push(sx[q] + ofx[q], sy[q] + ofy[q], sz[q] + ofz[q], ofFade[q], -1);
        const bR = () => push(sx[q] - ofx[q], sy[q] - ofy[q], sz[q] - ofz[q], ofFade[q], 1);
        aL(); bL(); bR();
        aL(); bR(); aR();
      }
    }

    geometry.setDrawRange(0, n);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aFade.needsUpdate = true;
    geometry.attributes.aCross.needsUpdate = true;
    mesh.visible = n > 0;
  }

  function update(dt) {
    for (const lane of lanes) {
      for (let k = 0; k < lane.count; k++) {
        const i = at(lane, k);
        lane.age[i] += dt;
        lane.py[i] += RISE * dt;
        lane.px[i] += lane.ox[i] * SPREAD * dt;
        lane.pz[i] += lane.oz[i] * SPREAD * dt;
      }
      // Expire from the tail. Points are laid in order, so the oldest is always at `start` and
      // this never has to scan the whole ring.
      while (lane.count > 0 && lane.age[lane.start] >= LIFE) {
        lane.start = (lane.start + 1) % MAX_POINTS;
        lane.count -= 1;
      }
    }

    build();

    // Cleared *after* the rebuild, so a frame that emitted gets its attached head and the next
    // frame without an emit lets the ribbon come off the car.
    for (const lane of lanes) lane.live = false;
  }

  return {
    mesh,
    emit,
    update,
    /** Points currently held per ribbon. For the headless probe. */
    counts: () => lanes.map((lane) => lane.count),
  };
}

export const SPEEDLINE_LIFE = LIFE;
export const SPEEDLINE_LANES = LANES;
