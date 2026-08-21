import * as THREE from 'three';
import { unlitMaterial } from '../util/geo.js';
import { BILLBOARD } from '../game/camera.js';
import { PALETTE } from '../palette.js';

// The outburst a VIP leaves behind when their clock runs out: a jagged comic bubble with a grawlix
// in it — `%#&@!!` — floating over the rider as they bail out of the cab and run off (see
// `beginBail` in game/fares.js).
//
// It exists because the miss had no *moment*. A VIP timing out is the one clock in the game that
// does not end the run, so it used to clear off the board exactly as a delivery does, and the only
// difference the player could see was a payout that never arrived. The cost is real — the streak
// goes with it — and a cost that isn't shown is a cost the player learns by inference. So the rider
// gets out and says something about it.
//
// **Every mark is geometry, not text.** There is no font in this project and no texture loader; a
// canvas-drawn label would also be the one thing on the board that is a picture of writing rather
// than a built object. Six little strokes-and-dots glyphs merge into one mesh, which at play zoom
// (1 world unit ≈ 7.7px) is a ~7px-per-glyph texture that reads as swearing rather than as any
// particular swear — which is what a grawlix is for.
//
// **It is drawn in the screen plane.** The camera never rotates (game/camera.js), so facing it is a
// constant orientation baked once rather than a per-frame billboard — the same property
// `geometry/plane.js` uses for its streamers. Everything below is authored in that plane: local +X
// is screen right, +Y is screen up, +Z is straight at the viewer.

// `BILLBOARD` and `SCREEN_PER_WORLD_Y` are the screen plane itself, and they live in
// game/camera.js beside the view direction they are derived from — the tap targets on the fare
// markers are authored in the same plane (geometry/marker.js), and two copies of this basis is one
// too many.

// The bubble's half-extents in the screen plane, and the tail's reach below it. 7.4 × 4.2 units is
// about 57 × 32px at play zoom — a little wider than the rider is tall, which is the proportion a
// comic outburst wants. Smaller and the glyphs stop being marks and become noise; larger and it
// covers the junction the player is trying to read.
const RX = 3.7;
const RY = 2.1;
const TAIL = 2.4;         // how far past the rim the spike reaches, in screen units

/**
 * How far the tail's point hangs below the bubble's own origin, in screen units.
 *
 * Exported because whoever *places* one of these is aiming that point at somebody's head, and the
 * arithmetic that does it (`CURSE_LIFT` in game/fares.js) is in world units — two different spaces
 * for one measurement is exactly the kind of seam a number gets copied across and then drifts.
 */
export const TAIL_DROP = RY + TAIL;

// The ragged rim. Ten spikes at 55px is a ~6px tooth — coarse enough to read as a shout rather than
// as a lumpy circle, fine enough that the shape underneath is still an oval.
const SPIKES = 10;
const NOTCH = 0.82;       // how far in the valleys between the spikes cut

// The dark outline around the fill, in **world units** rather than as a scale factor, for the reason
// `RIM_OFFSET` gives in geometry/diamond.js: this shape is nearly twice as wide as it is tall, so
// one multiplier would draw a border half as thick at the top as at the sides.
const RIM = 0.26;

// The grawlix. Six glyphs on a 1.02-unit advance — 6.1 units wide inside a 7.4-unit bubble, which
// leaves the outburst's own spikes clear of the ink.
const ADVANCE = 1.02;
// Pen width, ~1.8px at play zoom. It was 0.2 while the glyphs were dark on white paper; light marks
// on a saturated fill need more body than dark ones on a pale one to read as the same weight, and
// 1.5px of white on purple came out spidery.
const STROKE = 0.24;
const CAP = 0.62;         // half the glyph height

// Depth between the three layers, along the view direction. It only has to beat the depth-test
// tolerance — they are all drawn back-to-front by renderOrder anyway.
const LAYER = 0.05;

// Above the fare crystal's own pair (8 and 9 — see DIAMOND_ORDER). Nothing else in the game draws
// in this band, and the crystal is hidden for the whole life of a bubble regardless: the clock this
// rider was carrying is exactly what has just stopped mattering.
const ORDER = 10;

/**
 * The silhouette: a closed polygon of a spiky oval with one long spike pointing down.
 *
 * The tail is a rim point rather than a triangle stuck on afterwards, which is what keeps the whole
 * shape a single non-overlapping fan. Two overlapping translucent triangles are invisible at full
 * opacity and then draw a bright seam across the shape as it fades out, which is precisely when
 * anyone is looking at it.
 */
function silhouette() {
  const points = [];
  const n = SPIKES * 2;
  // Half a step of phase so a *spike* lands at the bottom of the oval rather than a valley — that
  // spike is the one that becomes the tail.
  const phase = Math.PI / n;
  for (let k = 0; k < n; k++) {
    const a = -Math.PI / 2 + phase + (k / n) * Math.PI * 2;
    const spike = k % 2 === 0;
    // Counted from the bottom, so index 0 is the tail.
    const reach = k === 0 ? (RY + TAIL) / RY : (spike ? 1 : NOTCH);
    points.push([Math.cos(a) * RX * reach, Math.sin(a) * RY * reach]);
  }
  // The tail is narrow: pull its two neighbours in toward it so the spike is a point rather than a
  // third of the bubble's underside.
  for (const k of [1, n - 1]) {
    points[k][0] *= 0.55;
    points[k][1] *= 0.92;
  }
  return points;
}

/**
 * A triangle fan around the origin, in the XY plane at `z`.
 *
 * Wound counter-clockwise seen from +Z — which is the camera, since the group this ends up in is
 * turned to face it — so every face points at the viewer. `tools/probe.mjs` checks the sign of the
 * normal computed from that winding rather than eyeballing it, for the reason the roadworks ramp
 * taught: a reversed hand-written triangle renders exactly like a z-fighting artefact.
 */
function fanGeometry(points, z) {
  const pos = [];
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[(i + 1) % points.length];
    pos.push(0, 0, z, ax, ay, z, bx, by, z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/** One pen stroke: a rectangle of length `len` and width `thick`, centred and rotated by `angle`. */
function stroke(pos, cx, cy, len, thick, angle, z) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const hx = len / 2;
  const hy = thick / 2;
  // Counter-clockwise in local space, and rotation preserves that.
  const corners = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]
    .map(([x, y]) => [cx + x * cos - y * sin, cy + x * sin + y * cos]);
  const [p0, p1, p2, p3] = corners;
  pos.push(p0[0], p0[1], z, p1[0], p1[1], z, p2[0], p2[1], z);
  pos.push(p0[0], p0[1], z, p2[0], p2[1], z, p3[0], p3[1], z);
}

/** A square blob — the dot on an exclamation mark, the two on a percent sign. */
const dot = (pos, cx, cy, size, z) => stroke(pos, cx, cy, size, size, 0, z);

/** A ring, as a fan of quads. Counter-clockwise, same as everything else here. */
function annulus(pos, cx, cy, radius, thick, segments, z) {
  const ri = radius - thick / 2;
  const ro = radius + thick / 2;
  for (let k = 0; k < segments; k++) {
    const a0 = (k / segments) * Math.PI * 2;
    const a1 = ((k + 1) / segments) * Math.PI * 2;
    const at = (r, a) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    const [i0x, i0y] = at(ri, a0);
    const [o0x, o0y] = at(ro, a0);
    const [o1x, o1y] = at(ro, a1);
    const [i1x, i1y] = at(ri, a1);
    pos.push(i0x, i0y, z, o0x, o0y, z, o1x, o1y, z);
    pos.push(i0x, i0y, z, o1x, o1y, z, i1x, i1y, z);
  }
}

/**
 * `%#&@!!`, in strokes.
 *
 * The `&` is drawn as a five-pointed asterisk and the `@` as a ring with a pip in it — both are how
 * a grawlix is *lettered* rather than typeset, and both survive being 7px wide, which an ampersand's
 * loops would not. Nothing here is trying to be a font: the sequence has to read as a censored word
 * at a glance and as individual marks never.
 */
function grawlixGeometry(z) {
  const pos = [];
  const at = (k) => (k - 2.5) * ADVANCE;

  // `%` — two pips and the slash between them.
  const pc = at(0);
  dot(pos, pc - 0.24, CAP * 0.55, 0.3, z);
  dot(pos, pc + 0.24, -CAP * 0.55, 0.3, z);
  stroke(pos, pc, 0, Math.hypot(0.62, CAP * 1.7), STROKE, Math.atan2(CAP * 1.7, 0.62), z);

  // `#` — two leaning uprights crossed by two rails.
  const hc = at(1);
  stroke(pos, hc - 0.16, 0, CAP * 1.9, STROKE, Math.PI / 2 - 0.14, z);
  stroke(pos, hc + 0.16, 0, CAP * 1.9, STROKE, Math.PI / 2 - 0.14, z);
  stroke(pos, hc, CAP * 0.34, 0.78, STROKE, 0, z);
  stroke(pos, hc, -CAP * 0.34, 0.78, STROKE, 0, z);

  // `&` — an asterisk. Five arms rather than three, so it is plainly a *mark* and not a plus sign.
  const ac = at(2);
  for (let k = 0; k < 5; k++) {
    stroke(pos, ac, 0, CAP * 1.7, STROKE, (k / 5) * Math.PI, z);
  }

  // `@` — a ring around a pip.
  const oc = at(3);
  annulus(pos, oc, 0, CAP * 0.72, STROKE, 12, z);
  dot(pos, oc, 0, 0.22, z);

  // `!!` — the only two glyphs anyone actually reads, which is why there are two of them.
  for (const bc of [at(4), at(5)]) {
    stroke(pos, bc, CAP * 0.26, CAP * 1.25, STROKE * 1.25, Math.PI / 2, z);
    dot(pos, bc, -CAP * 0.72, 0.26, z);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

// One set of geometry for every bubble on the board — a slot's rider is the only thing that varies,
// and none of them vary it. Built at module load beside the diamond's, and node-safe for the same
// reason: it is arithmetic and buffers, with no canvas and no document anywhere in it.
const RIM_POINTS = silhouette().map(([x, y]) => [x * (1 + RIM / RX), y * (1 + RIM / RY)]);
const BODY_GEO = fanGeometry(silhouette(), 0);
const RIM_GEO = fanGeometry(RIM_POINTS, -LAYER);
const INK_GEO = grawlixGeometry(LAYER);

// The entrance, the hold and the exit, as fractions of the bail this bubble is riding on (see
// BAIL_SECONDS in game/fares.js). It has to be up and readable before the rider has finished
// getting out, and gone before they are — a bubble outliving the person it came from reads as a
// second event.
const POP_IN = 0.14;
const FADE_FROM = 0.72;

// The shout's wobble: a few degrees of rock, fast. It is what keeps a static shape from reading as
// a sign someone is holding up, and it costs one sine per frame.
const SHAKE_HZ = 5.5;
const SHAKE = 0.055;

/** Overshoot easing, 0 → ~1.1 → 1. The bubble arrives like a shout, not like a fade-in. */
function popIn(u) {
  const k = u - 1;
  return 1 + 2.7 * k ** 3 + 1.7 * k ** 2;
}

/**
 * One outburst bubble, hidden until someone needs it.
 *
 * Built per fare slot and reused, exactly as the slot's rider and markers are — a bail is a rare
 * event, but building four of these once is cheaper than building one at the moment a run is
 * already busy failing.
 */
export function createCurseBubble() {
  const group = new THREE.Group();
  group.visible = false;
  // The whole point of the module: face the camera, once, forever.
  group.quaternion.copy(BILLBOARD);

  const layer = (geo, color, order) => {
    const mesh = new THREE.Mesh(geo, unlitMaterial({
      color: new THREE.Color(color),
      transparent: true,
      // The three layers are ordered by `renderOrder` and separated in depth already; writing depth
      // would only let them cut holes in each other's fades.
      depthWrite: false,
      side: THREE.DoubleSide,
    }));
    mesh.renderOrder = order;
    // The rider under it is the tap target, and their hit box already covers this airspace — see
    // the same line on the crystal in game/faremarker.js.
    mesh.raycast = () => {};
    group.add(mesh);
    return mesh;
  };

  // Back to front: the dark outline, the VIP's own purple filling the whole shape, then the grawlix
  // in white on top of it. The purple is the mass rather than the border — see `curseText` in
  // palette.js for why that way round.
  const meshes = [
    layer(RIM_GEO, PALETTE.curseRim, ORDER),
    layer(BODY_GEO, PALETTE.vip, ORDER + 1),
    layer(INK_GEO, PALETTE.curseText, ORDER + 2),
  ];

  const setOpacity = (a) => { for (const m of meshes) m.material.opacity = a; };

  return {
    group,
    /** Whether anything is being said right now — for the headless tools. */
    isShowing: () => group.visible,

    show() {
      group.visible = true;
      group.scale.setScalar(0);
      setOpacity(1);
    },

    /**
     * Advance to `t`, the bail's own progress from 0 to 1 (see BAIL_SECONDS in game/fares.js).
     *
     * Driven off the caller's clock rather than a private one for the reason every animation here
     * is: sim time is what a screenshot can be frozen at, and a bubble with its own `performance.now`
     * would render a different frame every time the same shot was taken.
     */
    update(t) {
      if (!group.visible) return;
      const swell = t < POP_IN ? popIn(Math.max(0, t) / POP_IN) : 1;
      group.scale.setScalar(Math.max(0, swell));
      // Rocking about the view axis — the bubble's own +Z, which is the one rotation that keeps it
      // flat to the screen.
      group.quaternion.copy(BILLBOARD);
      group.rotateZ(Math.sin(t * SHAKE_HZ * Math.PI * 2) * SHAKE);
      setOpacity(t < FADE_FROM ? 1 : Math.max(0, 1 - (t - FADE_FROM) / (1 - FADE_FROM)));
    },

    hide() {
      group.visible = false;
    },
  };
}
