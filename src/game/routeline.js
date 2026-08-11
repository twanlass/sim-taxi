import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import {
  ROAD_W, isXAxis, dirSign, lineCoord, laneOffsetCoord, entryPoint, exitPoint, turnControl,
  nextIntersection,
} from '../city/grid.js';

/**
 * Draws the taxi's planned route as a band of paint laid down the lane it will drive.
 *
 * Without it the player has no way to tell whether their tap registered or which way the taxi
 * intends to go — the car just keeps driving and you find out at the next junction. Flight Control
 * makes the drawn path the entire interface, and the same reasoning applies here.
 *
 * It was a 2px hairline down the road *centreline* first, and that was wrong twice over. A route
 * on the centreline sits between the two lanes, so it never says which side of the road the taxi
 * is on — and the line was filleted against the taxi's own position, so the corner radius at the
 * next junction shrank as the car closed on it and the path visibly re-shaped every few metres.
 *
 * Now it follows the same lane centreline and the same junction arcs the car itself drives, at
 * lane width. Nothing ahead of the car depends on where the car is, so the band only ever gets
 * *shorter* from behind — it never re-shapes.
 *
 * A soft pulse of brightness rolls along the band toward the destination, so a glance tells you
 * which way the taxi is about to go without reading the road layout — a stationary wash of colour
 * reads as "a route exists", not "this is the direction of it". It rides the same `vDist`/`uLength`
 * fade already computed for the head and tail, so it never brightens past either end of the band.
 */

// The taxi drives one lane, so the band covers one lane: ROAD_W is both lanes.
//
// Not the full 4 units, though. A right turn's lane-to-lane arc has a radius of HALF_ROAD − LANE =
// 2, so at half-width 2 the inside edge of the band collapses to a point at every right turn and
// folds over itself — a translucent band folded on itself paints a visibly darker wedge. 0.85 of a
// lane leaves 0.3 units of inner radius, and reads as "in the lane" rather than "the whole lane".
const WIDTH = (ROAD_W / 2) * 0.85;
const HALF_WIDTH = WIDTH / 2;

// Both ends fade rather than stopping at an edge. A hard end at the taxi reads as a second object
// butted against the car; a hard end at the destination reads as a wall across the road.
//
// The head end holds off entirely first. The band is what the taxi is about to drive over, not
// something it is dragging, and paint emerging from under the bumper reads as the latter — so
// nothing is drawn for the first HEAD_GAP units. The taxi's nose is (CAR_LEN / 2) * TAXI_SCALE ≈
// 2.0 units ahead of its centre, which the path measures from, so 4 leaves a clear couple of units
// of bare road in front of the car before the fade even starts.
const HEAD_GAP = 4;
const FADE_HEAD = 6;
const FADE_TAIL = 10;

// Above the road paint (MARK_Y = 0.02) and below the cars (ROAD_Y = 0.04). Unlike the fare rings
// this is depth-tested, so traffic drives *over* the band instead of the band painting across
// every car it passes under — at 2px that didn't matter, at lane width it does.
const Y = 0.03;
// Exported because the drop-off's filled circle matches it: the band and the disc are the same
// statement ("this is the job") in two places, and they have to sit at the same weight over the
// road or one of them reads as louder than the other.
export const ROUTE_OPACITY = 0.38;

/**
 * How the band combines with the road under it. `additive` is the default: the road is dark and a
 * flat `normal` wash over it flattens the markings and kerbs the band crosses, where adding light
 * keeps them showing through. The rest stay switchable because which one reads best is a judgement
 * call about the whole frame — the ⚙️ panel switches between them live.
 *
 * The shader writes premultiplied colour, so `screen` and `additive` are alpha-weighted rather
 * than blowing out at full strength. `multiply` is the exception and shapes its own output: it
 * needs `mix(white, colour, alpha)` against a `dst * src` blend, since premultiplied black at low
 * alpha would just paint a hole.
 */
export const ROUTE_BLENDS = {
  normal: { blending: THREE.NormalBlending },
  additive: { blending: THREE.AdditiveBlending },
  screen: {
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcColorFactor,
  },
  multiply: {
    blending: THREE.CustomBlending,
    blendSrc: THREE.ZeroFactor,
    blendDst: THREE.SrcColorFactor,
  },
};
export const ROUTE_BLEND_DEFAULT = 'additive';

// Junction arcs are sampled, straights are not — the fade is computed per fragment from a
// distance-along-the-path varying, so a 20-unit straight needs no interior vertices at all.
const TURN_STEPS = 10;
const MAX_STEPS = 32;      // routed junctions; the longest route across a 5×5 is well under this
const MAX_POINTS = MAX_STEPS * (TURN_STEPS + 1) + TURN_STEPS + 4;

const along = (d, p) => (isXAxis(d) ? p.x : p.z);

/** Point on the lane for direction d past junction (i, j), at travel-axis coordinate s. */
function lanePoint(d, i, j, s) {
  const lane = laneOffsetCoord(d, i, j);
  return isXAxis(d) ? { x: s, z: lane } : { x: lane, z: s };
}

const bezier = (a, c, b, t) => {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    z: u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  };
};

/**
 * The lane centreline the taxi will actually drive, from where it is now to its destination.
 *
 * Exported for `tools/probe.mjs`: "does the drawn path stay in the lane" and "does the part ahead
 * of the car stay put as the car advances" are both plain assertions on this array.
 */
export function routePath(car, route) {
  const pts = [];
  const push = (p) => {
    const last = pts[pts.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-4 && Math.abs(last.z - p.z) < 1e-4) return;
    pts.push({ x: p.x, z: p.z });
  };
  // Straight-run points only: never step backwards along the direction of travel. A car can sit
  // fractionally past the entry point of the junction it is heading for (the same case that has
  // no `distToLine > 0` guard on the stop decision), and pushing the entry point then would kink
  // the band back through the car.
  const pushAhead = (p, d) => {
    const last = pts[pts.length - 1];
    if (last && (along(d, p) - along(d, last)) * dirSign(d) < 0.01) return;
    push(p);
  };

  let i = car.i;
  let j = car.j;
  let d = car.d;

  if (car.state === 'turn' && car.entry && car.control && car.exit) {
    // Mid-junction: pick the arc up where the car is on it. `car.i/j` still name the junction it
    // is turning *at*, and its routed step is already consumed, so the remaining route applies
    // from the junction after this one.
    //
    // `car.turnT` is a fraction of `car.turnLen`, which is the hold line's straight run-up
    // (`car.leadIn`, the crosswalk clearance `STOP_SETBACK` sits back from the junction boundary)
    // *plus* the arc — not a fraction of the arc alone. The render transform below in traffic.js
    // splits on that; this used to skip straight to `bezier(..., car.turnT)`, which treated the
    // run-up as already-curved distance and jumped the drawn band forward by a whole `STOP_SETBACK`
    // (~3.4 units) the instant a car committed to a turn. Invisible on the old static band, it
    // showed up as a pop once the pulse animation rode on top of it.
    const travelled = Math.min(car.turnT, 1) * car.turnLen;
    if (travelled < car.leadIn) {
      const t = travelled / car.leadIn;
      push({
        x: car.hold.x + (car.entry.x - car.hold.x) * t,
        z: car.hold.z + (car.entry.z - car.hold.z) * t,
      });
      push(car.entry);
      for (let s = 0; s <= TURN_STEPS; s++) push(bezier(car.entry, car.control, car.exit, s / TURN_STEPS));
    } else {
      const t0 = (travelled - car.leadIn) / (car.turnLen - car.leadIn);
      for (let s = 0; s <= TURN_STEPS; s++) {
        const t = t0 + (1 - t0) * (s / TURN_STEPS);
        push(bezier(car.entry, car.control, car.exit, t));
      }
    }
    const after = nextIntersection(car.dOut, i, j);
    if (!after) return pts;
    d = car.dOut;
    i = after.i;
    j = after.j;
  } else {
    // The lane point, not `car.x/car.z`: the taxi weaves inside its lane in Loco Mode, and the
    // band belongs to the lane rather than to that manoeuvre.
    // Straight off the lane the car is on. `car.s` is arc length along that lane now, not a
    // world coordinate, so it can only be resolved by the lane that owns it.
    push(car.lane.path.at(car.s));
  }

  const steps = route ?? [];
  for (let k = 0; k < steps.length && k < MAX_STEPS; k++) {
    const dOut = steps[k];
    const entry = entryPoint(d, i, j);
    const exit = exitPoint(dOut, i, j);

    pushAhead(entry, d);
    if (dOut === d) {
      push(exit);
    } else {
      // The same quadratic the car drives: control point where the two lane centrelines cross,
      // so the band leaves and rejoins each lane exactly tangent to it.
      const control = turnControl(d, dOut, i, j);
      for (let s = 1; s <= TURN_STEPS; s++) push(bezier(entry, control, exit, s / TURN_STEPS));
    }

    const next = nextIntersection(dOut, i, j);
    if (!next) return pts;
    d = dOut;
    i = next.i;
    j = next.j;
  }

  // The destination. Stop in the middle of the junction, still in lane — that is where the taxi
  // comes to rest, and running the band out to the far side would point past the pin.
  pushAhead(entryPoint(d, i, j), d);
  pushAhead(lanePoint(d, i, j, isXAxis(d) ? lineCoord(i) : lineCoord(j)), d);
  return pts;
}

/**
 * Half-width offset at each path point, along the mitre of its two adjacent segments, so the
 * band keeps a constant width around a bend instead of gapping on the outside of every join.
 */
function mitreOffsets(path, halfWidth) {
  const dirs = [];
  for (let k = 0; k < path.length - 1; k++) {
    const dx = path[k + 1].x - path[k].x;
    const dz = path[k + 1].z - path[k].z;
    const len = Math.hypot(dx, dz) || 1;
    dirs.push({ x: dx / len, z: dz / len });
  }
  if (!dirs.length) dirs.push({ x: 1, z: 0 });

  const offsets = [];
  for (let k = 0; k < path.length; k++) {
    const into = dirs[Math.min(Math.max(k - 1, 0), dirs.length - 1)];
    const outOf = dirs[Math.min(k, dirs.length - 1)];

    const nx = -outOf.z;                 // normal of the outgoing segment
    const nz = outOf.x;

    let tx = into.x + outOf.x;
    let tz = into.z + outOf.z;
    const tLen = Math.hypot(tx, tz);
    if (tLen < 1e-4) {                   // doubled back on itself; there is no meaningful mitre
      offsets.push({ x: nx * halfWidth, z: nz * halfWidth });
      continue;
    }
    tx /= tLen;
    tz /= tLen;

    const mx = -tz;
    const mz = tx;
    const denom = mx * nx + mz * nz;
    // A near-zero denominator is an almost-reversed join, where the true mitre runs to infinity.
    // Fall back to a butt join rather than firing a spike across the map.
    const scale = Math.abs(denom) > 0.25 ? halfWidth / denom : halfWidth;
    offsets.push({ x: mx * scale, z: mz * scale });
  }

  return offsets;
}

// The pulse rolls from the car toward the destination — the direction of travel — one crest every
// PULSE_PERIOD units, at PULSE_SPEED units per second. PULSE_SHARPNESS narrows the crest: 1 is a
// full sine wave (no dark trough between crests at this spacing), higher values pinch it into a
// soft travelling glow with real road between crests. PULSE_BOOST caps how much brighter the crest
// gets over the plain band — kept well under the chevrons' old 0.9 so the motion reads as ambient
// rather than as a marker in its own right.
const PULSE_PERIOD = 10;
const PULSE_SPEED = 3;
const PULSE_SHARPNESS = 4;
const PULSE_BOOST = 0.5;

// A freshly routed band sweeps in from the car rather than appearing whole — the same reasoning
// as the pulse: a static object popping into existence reads as "the UI updated", not "the taxi is
// headed there now". ROLLOUT_DURATION is fixed rather than scaled by route length, so picking a
// fare across the map doesn't read as sluggish next to one next door — both sweep in at the same
// pace, just covering more ground per second on the long one.
const ROLLOUT_DURATION = 0.35;
const easeOutCubic = (t) => 1 - (1 - t) ** 3;

export function createRouteLine(scene) {
  // Two triangles per segment of the path.
  const positions = new Float32Array(MAX_POINTS * 6 * 3);
  const dists = new Float32Array(MAX_POINTS * 6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aDist', new THREE.BufferAttribute(dists, 1));

  // The fade is per-fragment off a distance-along-the-path varying rather than per-vertex alpha:
  // vertex alpha would need the path re-tessellated at both fade boundaries every frame (and
  // `instanceColor`-style, a 4-component colour attribute takes a different code path anyway),
  // whereas one float per vertex interpolates the length of a 20-unit straight for free.
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(PALETTE.routeLine) },
      uOpacity: { value: ROUTE_OPACITY },
      uLength: { value: 1 },
      uHeadGap: { value: HEAD_GAP },
      uFadeHead: { value: FADE_HEAD },
      uFadeTail: { value: FADE_TAIL },
      uMultiply: { value: 0 },
      uTime: { value: 0 },
      uReveal: { value: 0 },
    },
    vertexShader: /* glsl */`
      attribute float aDist;
      varying float vDist;
      void main() {
        vDist = aDist;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    // `colorspace_fragment` is not optional: a ShaderMaterial gets none of the built-in chunks,
    // and without it this yellow renders linear — visibly darker than every MeshBasicMaterial
    // marker beside it. It runs *before* the premultiply, because premultiplied colour is not in
    // a colour space any more and converting it is wrong by however much alpha isn't 1.
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uLength;
      uniform float uHeadGap;
      uniform float uFadeHead;
      uniform float uFadeTail;
      uniform float uMultiply;
      uniform float uTime;
      uniform float uReveal;
      varying float vDist;
      const float PULSE_PERIOD = ${PULSE_PERIOD.toFixed(4)};
      const float PULSE_SPEED = ${PULSE_SPEED.toFixed(4)};
      const float PULSE_SHARPNESS = ${PULSE_SHARPNESS.toFixed(4)};
      const float PULSE_BOOST = ${PULSE_BOOST.toFixed(4)};
      const float TAU = 6.2831853;
      void main() {
        float head = smoothstep(uHeadGap, uHeadGap + uFadeHead, vDist);
        float tail = smoothstep(0.0, uFadeTail, uLength - vDist);
        // The rollout sweep: a second, animated tail-style edge that grows from the car out to the
        // destination when a route is freshly picked, using the same fade width as the real tail so
        // the leading edge of the sweep looks exactly like the trailing edge it will settle into.
        // Once uReveal passes uLength this is 1 everywhere and has no effect on the steady state.
        float reveal = smoothstep(0.0, uFadeTail, uReveal - vDist);
        float envelope = uOpacity * head * tail * reveal;

        // Position relative to the *destination* end, not the car end. vDist is measured from the
        // car, so it (and uLength) both shrink every frame the taxi drives — using it directly
        // would make the pulse appear to roll faster or slower with the taxi's own speed. The
        // destination end of the path doesn't move, so anchoring the phase there decouples the
        // animation from the taxi entirely; only uTime drives it.
        float travel = vDist - uLength;

        // A raised cosine rather than a hard-edged band: a soft crest that rises and falls reads as
        // a pulse of motion, where a sharp line reads as a marker sitting still and blinking.
        float theta = TAU * fract((travel - uTime * PULSE_SPEED) / PULSE_PERIOD);
        float pulse = pow(max(0.0, 0.5 + 0.5 * cos(theta)), PULSE_SHARPNESS);
        // The pulse only brightens the band, never darkens it or exceeds full alpha, and fades out
        // with the same head/tail envelope as the band itself so none rolls past its ends.
        float boost = pulse * envelope * PULSE_BOOST;

        float a = envelope + boost;
        vec3 rgb = mix(uColor, vec3(1.0), boost);
        gl_FragColor = vec4(rgb, a);
        #include <colorspace_fragment>
        gl_FragColor = uMultiply > 0.5
          ? vec4(mix(vec3(1.0), gl_FragColor.rgb, a), 1.0)
          : vec4(gl_FragColor.rgb * a, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    premultipliedAlpha: true,
    side: THREE.DoubleSide,
  });

  let blendName = ROUTE_BLEND_DEFAULT;

  /** Switch how the band combines with the road. Unknown names fall back to `normal`. */
  function setBlend(name) {
    blendName = ROUTE_BLENDS[name] ? name : ROUTE_BLEND_DEFAULT;
    const mode = ROUTE_BLENDS[blendName];
    // Reset every factor first: three only reads blendSrc/blendDst under CustomBlending, but a
    // leftover pair would apply again the moment another custom mode is picked.
    material.blending = mode.blending;
    material.blendSrc = mode.blendSrc ?? THREE.SrcAlphaFactor;
    material.blendDst = mode.blendDst ?? THREE.OneMinusSrcAlphaFactor;
    material.uniforms.uMultiply.value = blendName === 'multiply' ? 1 : 0;
    material.needsUpdate = true;
  }
  setBlend(ROUTE_BLEND_DEFAULT);

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 4;   // under the fare rings (7-9)
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);

  // Identity of the route currently sweeping in, so a route that is merely being redrawn this
  // frame (the common case — every frame, as the car advances) doesn't replay the rollout, while
  // a genuinely new one (the player tapped a fare, or a pickup redirected to the drop-off) does.
  // `pendingTarget` is a fresh object every time `routeTo()` runs and stable between those calls,
  // so identity is all this needs — no route contents to compare.
  let revealTarget = null;
  let revealElapsed = 0;

  function update(car, route, dt = 0) {
    material.uniforms.uTime.value += dt;

    if (car.pendingTarget !== revealTarget) {
      revealTarget = car.pendingTarget;
      revealElapsed = 0;
    }
    // Always folded in, including the frame a new target starts on — a shot mode frame is a
    // single call with dt=999 standing in for "let it settle", and that dt has to count even
    // though this is also the frame the target just changed on, or the sweep never advances.
    revealElapsed += dt;

    const path = routePath(car, route);
    if (path.length < 2) { mesh.visible = false; return; }

    // Arc length at each point, so the shader can fade against real distance rather than against
    // vertex index — an eight-step arc and a 20-unit straight are one vertex step apart either way.
    const s = [0];
    for (let k = 1; k < path.length; k++) {
      s.push(s[k - 1] + Math.hypot(path[k].x - path[k - 1].x, path[k].z - path[k - 1].z));
    }
    const total = s[s.length - 1];
    if (total < 0.01) { mesh.visible = false; return; }

    // A one-block hop (PITCH is 20) is barely longer than the gap and the two fades put together.
    // Scale all three down in proportion rather than letting them overlap into a band that never
    // reaches full opacity anywhere — or, worse, one the head gap swallows whole.
    const squeeze = Math.min(1, (total * 0.9) / (HEAD_GAP + FADE_HEAD + FADE_TAIL));
    material.uniforms.uLength.value = total;
    material.uniforms.uHeadGap.value = HEAD_GAP * squeeze;
    material.uniforms.uFadeHead.value = FADE_HEAD * squeeze;
    material.uniforms.uFadeTail.value = FADE_TAIL * squeeze;

    // Sweeps out past the far end (by the tail's own fade width) rather than stopping exactly at
    // `total`, so the reveal edge fully clears the destination and leaves no soft seam sitting
    // partway down the band once the animation settles.
    const rolloutT = Math.min(1, revealElapsed / ROLLOUT_DURATION);
    material.uniforms.uReveal.value = (total + FADE_TAIL * squeeze) * easeOutCubic(rolloutT);

    // Offset each point along its mitre rather than offsetting each segment independently.
    // Independent segments leave a wedge of empty road on the outside of every join — invisible
    // at 90° corners because the corner was the notch, but obvious across a ten-step arc.
    const offsets = mitreOffsets(path, HALF_WIDTH);

    let v = 0;
    let n = 0;
    const push = (p, o, dist) => {
      positions[v++] = p.x + o.x;
      positions[v++] = Y;
      positions[v++] = p.z + o.z;
      dists[n++] = dist;
    };

    for (let k = 0; k < path.length - 1; k++) {
      const a = path[k];
      const b = path[k + 1];
      const oa = offsets[k];
      const ob = offsets[k + 1];
      const neg = (o) => ({ x: -o.x, z: -o.z });

      push(a, oa, s[k]);      push(b, ob, s[k + 1]);      push(b, neg(ob), s[k + 1]);
      push(a, oa, s[k]);      push(b, neg(ob), s[k + 1]); push(a, neg(oa), s[k]);
    }

    geometry.setDrawRange(0, n);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aDist.needsUpdate = true;
    geometry.computeBoundingSphere();
    mesh.visible = n > 0;
  }

  return { mesh, update, setBlend, blend: () => blendName, hide: () => { mesh.visible = false; } };
}
