import * as THREE from 'three';
import { PALETTE } from '../palette.js';
import { VIEW_DIR } from '../game/camera.js';
import { URGENCY_SEGMENTS, urgencyColor } from '../game/urgency.js';
import { DISTANCE_TIERS } from '../game/triptier.js';

// The meter floating over a waiting rider: an urgency bar above a distance bar.
//
// It answers the only two questions the player has about someone on the kerb — how long have I got,
// and is this worth taking — in one glance, without reading anything. Urgency drains as a count of
// lit segments with the colour tied to that count; distance is three fixed tiers rather than a
// block figure, because "short / medium / long" is the whole decision and an exact number was more
// precision than it was worth.
//
// It replaces two things at once: the ring that used to sit on the kerb under the rider, and the
// digits that used to float over them. Both said less than this does and took two reads to say it.
//
// Geometry rather than a canvas texture, like everything else here — and because the module has to
// construct under `node` for the headless tools, which have no DOM to draw into.

// The spec for this is written in pixels, so the layout is too, converted once here. 1 world unit
// is about 7.7px at play zoom (the orthographic frustum's height is exactly 2 * zoom), which makes
// the whole meter 84 x 34px, which SCALE below takes to 67 x 27px — still bigger than the ~25px
// ring it replaces, and it needs to be: it's now the only thing marking a rider at range.
const PX = 1 / 7.7;

const BAR_W = 70 * PX;          // both bars, so they align stacked

const URG_W = 16 * PX;
const URG_H = 12 * PX;
const URG_GAP = 2 * PX;

const DIST_H = 6 * PX;
const DIST_GAP = 3 * PX;
const DIST_W = (70 - (DISTANCE_TIERS - 1) * 3) / DISTANCE_TIERS * PX;

const STACK_GAP = 8 * PX;       // urgency bar on top, distance bar below
const PAD_X = 7 * PX;
const PAD_Y = 4 * PX;

const SEG_RADIUS = 2 * PX;
const BOX_RADIUS = 8 * PX;

const BOX_W = BAR_W + PAD_X * 2;
const BOX_H = URG_H + STACK_GAP + DIST_H + PAD_Y * 2;

// Clear of the rider's head (the figure tops out a little over 3.3), with enough air under it that
// it reads as floating above them rather than worn as a hat. 1.3 units is 10px at play zoom.
const LIFT = 7.3;

// Drawn to the spec's pixel figures above, then taken down a fifth. Full size was accurate to the
// sheet and too loud on the map: three of them is three 84 x 34px slabs over a city whose blocks
// are only ~92px across. Applied as a group scale rather than folded into PX so the geometry still
// matches the spec one-to-one and this stays a single knob to turn.
const SCALE = 0.8;

// The backing is genuinely translucent, so it lands in three's transparent queue whatever we do —
// and the queue draws after every opaque object regardless of renderOrder. The segments follow it
// there so the two sort against each other rather than the segments being buried by their own
// plate. Above ABOVE_RING (12) either way, so the travelling timer ring can't paint over it.
const BOX_ORDER = 13;
const SEG_ORDER = 14;

/**
 * A rounded rectangle centred on the origin, in the XY plane.
 *
 * Built per size rather than scaled from one unit shape: scaling a rounded rect stretches its
 * corners, and at a 2px radius on a 16px segment a stretched corner is the difference between a
 * soft edge and a visibly lopsided one.
 */
function roundedRect(w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  const x = w / 2;
  const y = h / 2;
  const shape = new THREE.Shape();
  shape.moveTo(-x + r, -y);
  shape.lineTo(x - r, -y);
  shape.quadraticCurveTo(x, -y, x, -y + r);
  shape.lineTo(x, y - r);
  shape.quadraticCurveTo(x, y, x - r, y);
  shape.lineTo(-x + r, y);
  shape.quadraticCurveTo(-x, y, -x, y - r);
  shape.lineTo(-x, -y + r);
  shape.quadraticCurveTo(-x, -y, -x + r, -y);
  // Four segments per corner. These are 2-3px arcs on screen; anything finer is subdivision nobody
  // can see, paid for on every rider on the board.
  return new THREE.ShapeGeometry(shape, 4);
}

// Three shapes for the whole meter, shared by every rider — the layout never changes size, only
// the colours in it do.
const BOX_GEO = roundedRect(BOX_W, BOX_H, BOX_RADIUS);
const URG_GEO = roundedRect(URG_W, URG_H, SEG_RADIUS);
const DIST_GEO = roundedRect(DIST_W, DIST_H, SEG_RADIUS);

// The meter faces the camera, and the camera never turns — so this is a constant, resolved once
// here rather than a lookAt every frame on three floating plates.
const FACING = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().lookAt(VIEW_DIR, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)),
);

const EMPTY = new THREE.Color(PALETTE.meterEmpty);
const DISTANCE_LIT = new THREE.Color(PALETTE.meterDistance);

/** Evenly spaced segment centres across BAR_W, left to right. */
function centres(count, width, gap) {
  const step = width + gap;
  const start = -(count - 1) * step / 2;
  return Array.from({ length: count }, (_, i) => start + i * step);
}

function segment(geometry, x, y) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
    color: EMPTY.clone(),
    // Legibility beats depth correctness, the same bargain the timer ring makes: at this camera
    // angle a tower stands in front of a kerb constantly, and a clock you cannot see is worthless.
    transparent: true,
    depthTest: false,
    depthWrite: false,
  }));
  mesh.position.set(x, y, 0.01);
  mesh.renderOrder = SEG_ORDER;
  mesh.raycast = () => {};   // never a click target; the rider underneath is
  return mesh;
}

/**
 * One rider's meter. Built once per fare slot and re-set on every spawn, the same way the rest of
 * the slot's meshes are reused.
 */
export function createRiderMeter() {
  const group = new THREE.Group();
  group.quaternion.copy(FACING);
  group.scale.setScalar(SCALE);
  group.position.y = LIFT;
  group.visible = false;

  const box = new THREE.Mesh(BOX_GEO, new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTE.meterBack),
    transparent: true,
    opacity: 0.75,
    depthTest: false,
    depthWrite: false,
  }));
  box.renderOrder = BOX_ORDER;
  box.raycast = () => {};
  group.add(box);

  // Content is centred in the box: the urgency bar's top edge and the distance bar's bottom edge
  // sit one PAD_Y inside it.
  const contentTop = (URG_H + STACK_GAP + DIST_H) / 2;
  const urgY = contentTop - URG_H / 2;
  const distY = -contentTop + DIST_H / 2;

  const urgency = centres(URGENCY_SEGMENTS, URG_W, URG_GAP)
    .map((x) => segment(URG_GEO, x, urgY));
  const distance = centres(DISTANCE_TIERS, DIST_W, DIST_GAP)
    .map((x) => segment(DIST_GEO, x, distY));
  group.add(...urgency, ...distance);

  /**
   * Light the first `level` urgency segments in that level's colour.
   *
   * Lit segments run from the left, which is what the spec sheet renders; the bar therefore empties
   * from the right. Called every frame while the rider waits, so it does the cheap thing — the
   * colour objects are shared and only the material's copy changes.
   */
  function setUrgency(level) {
    const lit = urgencyColor(level);
    for (let i = 0; i < urgency.length; i++) {
      urgency[i].material.color.copy(i < level ? lit : EMPTY);
    }
  }

  /** Light the first `tier` distance segments. Fixed once at spawn — a trip's length can't change. */
  function setDistance(tier) {
    for (let i = 0; i < distance.length; i++) {
      distance[i].material.color.copy(i < tier ? DISTANCE_LIT : EMPTY);
    }
  }

  return {
    group,
    setUrgency,
    /** Show the meter for a fare that has just appeared. */
    show(level, tier) {
      setUrgency(level);
      setDistance(tier);
      group.visible = true;
    },
    hide() { group.visible = false; },
  };
}
