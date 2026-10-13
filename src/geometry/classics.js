import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, setFinish, FINISH } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import {
  CHASSIS_LIFT, archedBodyGeometries, wheelGeometries, extrudeOutlines,
} from './wheels.js';
import { LIGHT_Y } from './lights.js';

// The two rare classics in the ambient fleet: an open-top convertible and a 1980s VW T3 Westfalia
// camper. Both are body geometries and nothing else — they drive, queue, signal, crash and get
// arrested as the ordinary car they are in the sim (`car.model` in sim/traffic.js only decides which
// instanced mesh draws them). So both are built on the ordinary car's footprint, `len` × `width`,
// with its wheels, its arches and its sill, and every lamp pod, bumper and steered front wheel the
// fleet hangs off the body still lands where it does on a sedan.
//
// Car-local, like carGeometry(): +x is the nose, y is up, z is across. Taking `len`/`width` as
// arguments rather than importing CAR_LEN/CAR_W because sim/traffic.js imports this file — see the
// note at the top of geometry/wheels.js for why a constant cannot cross that cycle.

// The ordinary car's lower body: `0.78 + CHASSIS_LIFT` centre, 0.8 tall, so 0.70 .. 1.50.
const BODY_CENTRE = 0.78 + CHASSIS_LIFT;
const BODY_H = 0.8;
const BODY_TOP = BODY_CENTRE + BODY_H / 2;
// Trim that sits on a face stands this far proud of it, so no two faces share a plane (CLAUDE.md).
const PROUD = 0.015;

const box = (sx, sy, sz, x, y, z) => {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(x, y, z);
  return g;
};
const paint = (g, name, finish = FINISH.PAINT) => setFinish(bakeColor(g, color(name)), finish);

function merge(parts) {
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * A long, low open two-seater-plus-two: the sedan's lower body with no cabin on it, a raked
 * windscreen in a chrome frame, the cockpit as a dark tub inside a raised beltline, two buckets and
 * a bench, and the soft top folded down behind them. White where it is paint, so the fleet's
 * instance colour tints it exactly as it does a sedan.
 *
 * At play zoom (1 unit ≈ 7.7px) the read is the *absence* of the dark glass box every other car
 * has: a bright car with a dark hollow in it and two pale seats.
 */
export function convertibleGeometry(len, width) {
  const white = new THREE.Color(1, 1, 1);
  const parts = [...archedBodyGeometries(len, width, BODY_CENTRE, BODY_H, white)];

  // The cockpit runs from just behind the windscreen to just ahead of the folded hood.
  const cockpitFront = len * 0.1;
  const cockpitBack = -len * 0.36;
  const cockpitW = width * 0.78;
  const cockpitMid = (cockpitFront + cockpitBack) / 2;
  const cockpitLen = cockpitFront - cockpitBack;

  // The beltline: a raised lip of door tops and rear deck round the cockpit, so the tub reads as
  // a hollow rather than as paint on a flat lid. Its bottom is buried 0.01 in the body.
  const LIP_H = 0.12;
  const lipY = BODY_TOP - 0.01 + LIP_H / 2;
  const side = (width - cockpitW) / 2;
  for (const sz of [-1, 1]) {
    parts.push(setFinish(bakeColor(
      box(cockpitLen + 0.3, LIP_H, side, cockpitMid, lipY, sz * (width - side) / 2), white), FINISH.PAINT));
  }
  // The tub: dark, a hair above the body top and below the lip, so it is a floor seen over a sill.
  // 0.02 narrower than the gap between the lips, so its sides do not lie on their inner faces.
  parts.push(paint(box(cockpitLen, 0.04, cockpitW - 0.02, cockpitMid, BODY_TOP + 0.01, 0),
    'convertibleTub', FINISH.TYRE));

  // Seats. Fronts are two buckets with backs; the rear is one bench. Cushion tops at BODY_TOP + 0.12
  // and backs to + 0.42 — high enough to clear the lip by a pixel or two from this camera.
  const seatW = cockpitW * 0.4;
  for (const sz of [-1, 1]) {
    const z = sz * cockpitW * 0.25;
    parts.push(paint(box(0.42, 0.12, seatW, len * -0.02, BODY_TOP + 0.07, z), 'convertibleSeat'));
    parts.push(paint(box(0.12, 0.34, seatW, len * -0.02 - 0.24, BODY_TOP + 0.24, z), 'convertibleSeat'));
  }
  parts.push(paint(box(0.38, 0.12, cockpitW * 0.9, len * -0.24, BODY_TOP + 0.07, 0), 'convertibleSeat'));
  parts.push(paint(box(0.12, 0.28, cockpitW * 0.9, len * -0.24 - 0.22, BODY_TOP + 0.2, 0), 'convertibleSeat'));
  // A steering wheel, as a dark plate tilted toward the driver. Left-hand drive, like the traffic —
  // and with +x forward and +y up the driver's left is -z (up × forward).
  const wheel = new THREE.BoxGeometry(0.04, 0.24, 0.26);
  wheel.rotateZ(0.5);
  wheel.translate(cockpitFront - 0.14, BODY_TOP + 0.24, -cockpitW * 0.25);
  parts.push(paint(wheel, 'convertibleTub', FINISH.TYRE));

  // The folded soft top: a canvas roll on the rear deck behind the bench, its underside 0.01 into
  // the deck.
  const hood = new THREE.BoxGeometry(0.34, 0.2, cockpitW * 1.04);
  hood.translate(cockpitBack - 0.12, BODY_TOP + 0.09, 0);
  parts.push(paint(hood, 'convertibleHood', FINISH.TYRE));

  // The windscreen, raked 35° back, with a chrome top rail. Built upright at the origin, tipped
  // about its own foot (positive rotateZ takes +y toward -x, i.e. leans it back), then stood on
  // the cowl at the front of the cockpit.
  const RAKE = 0.62;
  const SCREEN_H = 0.5;
  const screenW = width * 0.84;
  const screen = new THREE.BoxGeometry(0.05, SCREEN_H, screenW);
  screen.translate(0, SCREEN_H / 2, 0);
  const rail = new THREE.BoxGeometry(0.08, 0.06, screenW + 0.04);
  rail.translate(0, SCREEN_H, 0);
  for (const g of [screen, rail]) {
    g.rotateZ(RAKE);
    g.translate(cockpitFront + 0.18, BODY_TOP - 0.02, 0);
  }
  parts.push(paint(screen, 'carGlass', FINISH.GLASS));
  parts.push(paint(rail, 'hubcap', FINISH.METAL));

  parts.push(...wheelGeometries(len, width));
  return merge(parts);
}

/**
 * The convertible's driver, sat in the left front bucket with both hands on the wheel, in the same
 * car-local frame as `convertibleGeometry`. Without a roof the empty seat is in plain view, and a
 * car visibly driving itself reads as a bug (Tyler, 2026-10-13).
 *
 * Its own geometry rather than part of the body because the body is tinted per car by the fleet's
 * instance colour, which would turn a red car's driver red. sim/traffic.js draws this as a second,
 * untinted instanced mesh riding the body's matrix.
 *
 * The figure is geometry/person.js's at about 0.5 scale — torso, head, hair — seated, so the
 * shoulders and head stand clear of the beltline lip (BODY_TOP + 0.11) and the head tops out at
 * 2.68, 0.6 above a sedan's roof: at play zoom it is a pale shirt and a head, which is the read.
 * Sunglasses, because it is a convertible.
 */
export function convertibleDriverGeometry(len, width) {
  const cockpitW = width * 0.78;
  const seatZ = -cockpitW * 0.25;           // the left bucket — see the steering wheel above
  const seatTop = BODY_TOP + 0.13;          // the cushion's top
  const torsoX = len * -0.02 - 0.1;         // sat back against the seat back
  const TORSO_H = 0.62;
  const HEAD = 0.31;
  const parts = [];
  const bake = (g, hex) => bakeColor(g, new THREE.Color(hex));
  parts.push(bake(box(0.3, TORSO_H, 0.48, torsoX, seatTop + TORSO_H / 2, seatZ), PALETTE.convertibleShirt));
  const headY = seatTop + TORSO_H + HEAD / 2;
  parts.push(bake(box(HEAD, HEAD, HEAD, torsoX, headY, seatZ), PALETTE.convertibleSkin));
  parts.push(bake(box(HEAD + 0.03, 0.1, HEAD + 0.03, torsoX, headY + HEAD / 2, seatZ), PALETTE.convertibleHair));
  // The sunglasses: a band across the front of the face, proud of it.
  parts.push(bake(box(0.04, 0.07, HEAD + 0.02, torsoX + HEAD / 2 + 0.01, headY + 0.03, seatZ), PALETTE.convertibleShades));
  // Arms, shoulder to the wheel's rim (`cockpitFront - 0.14`, BODY_TOP + 0.24 in convertibleGeometry),
  // each a box laid along the line between the two and the shirt's colour.
  const shoulder = new THREE.Vector3(torsoX + 0.05, seatTop + TORSO_H - 0.1, 0);
  const hand = new THREE.Vector3(len * 0.1 - 0.2, BODY_TOP + 0.3, 0);
  const reach = hand.clone().sub(shoulder);
  for (const side of [-1, 1]) {
    const arm = new THREE.BoxGeometry(reach.length(), 0.11, 0.11);
    arm.rotateZ(Math.atan2(reach.y, reach.x));
    const mid = shoulder.clone().add(hand).multiplyScalar(0.5);
    arm.translate(mid.x, mid.y, seatZ + side * 0.17);
    parts.push(bake(arm, PALETTE.convertibleShirt));
  }
  return merge(parts);
}

/**
 * The 1980s VW T3 (Vanagon) Westfalia camper, after its silhouette: a tall flat-sided box with the
 * wheels at its corners, a near-vertical nose with a big windscreen set high and a black grille band
 * with the roundel in it down low, three long side windows, and the closed pop-top cap sitting on a
 * flat roof. Two-tone, ivory over a coloured lower with a black rub strip on the split, baked —
 * the instance colour for this one is white (see `paint` in sim/traffic.js).
 *
 * Proportions off the real van (4.57 long, 1.85 wide, 1.96 tall) scaled into the fleet's chunky
 * footprint: the sedan is 2.07 tall on 3.4, against a real car's ~1.45 on 4.5, so the van gets the
 * same stretch — 0.70 sill to 2.55 roof, which keeps the T3's near-square cross-section on 1.7 of
 * width, plus 0.17 of pop-top.
 */
export const WESTFALIA_ROOF = 2.55;
export function westfaliaGeometry(len, width) {
  const nose = len / 2;
  const tail = -len / 2;
  // The two-tone split, at the bottom of the windows. The lower colour is the arched body grown up
  // to it, so the arches and their liners come for free.
  const SPLIT = 1.62;
  const lowerH = SPLIT - (BODY_CENTRE - BODY_H / 2);
  const parts = [...archedBodyGeometries(len, width, SPLIT - lowerH / 2, lowerH, color('westfaliaLower'))];

  // The upper body, as a side profile extruded across the van: the nose rakes back 0.18 over its
  // height (the T3's front is ~12° off vertical) and the roof edges are chamfered.
  const ROOF = WESTFALIA_ROOF;
  const SCREEN_TOP_X = nose - 0.18;
  const profile = [
    new THREE.Vector2(tail, SPLIT),
    new THREE.Vector2(nose, SPLIT),
    new THREE.Vector2(SCREEN_TOP_X, ROOF - 0.06),
    new THREE.Vector2(SCREEN_TOP_X - 0.1, ROOF),
    new THREE.Vector2(tail + 0.08, ROOF),
    new THREE.Vector2(tail, ROOF - 0.08),
  ];
  parts.push(paint(extrudeOutlines([profile], -width / 2, width / 2), 'westfaliaUpper'));

  // The rub strip, black, on the split all the way round — it also covers the seam between the two
  // paints. Proud of every face it wraps.
  parts.push(paint(box(len + 2 * PROUD, 0.08, width + 2 * PROUD, 0, SPLIT, 0), 'westfaliaTrim', FINISH.TYRE));

  // Side windows: three long panes, proud of both flanks (one box straight through the van, whose
  // two side faces are the panes and whose ends are buried).
  const WIN_Y0 = 1.84;
  const WIN_Y1 = 2.38;
  const winY = (WIN_Y0 + WIN_Y1) / 2;
  const winH = WIN_Y1 - WIN_Y0;
  for (const [x0, x1] of [[nose - 0.62, nose - 0.24], [-0.42, nose - 0.74], [tail + 0.16, -0.54]]) {
    parts.push(paint(box(x1 - x0, winH, width + 2 * PROUD, (x0 + x1) / 2, winY, 0), 'carGlass', FINISH.GLASS));
  }

  // The windscreen, laid on the raked nose. The nose face runs from (nose, SPLIT) to
  // (SCREEN_TOP_X, ROOF - 0.06); the pane is centred on it between WIN_Y0 and its top, tilted to
  // match and standing half its own thickness proud.
  const faceRise = ROOF - 0.06 - SPLIT;
  const faceTilt = Math.atan2(nose - SCREEN_TOP_X, faceRise);
  const xOnFace = (y) => nose - ((y - SPLIT) / faceRise) * (nose - SCREEN_TOP_X);
  const screenY0 = WIN_Y0 - 0.06;
  const screenY1 = ROOF - 0.14;
  const screenLen = (screenY1 - screenY0) / Math.cos(faceTilt);
  const screen = new THREE.BoxGeometry(2 * PROUD, screenLen, width * 0.88);
  screen.rotateZ(faceTilt);
  const sy = (screenY0 + screenY1) / 2;
  screen.translate(xOnFace(sy), sy, 0);
  parts.push(paint(screen, 'carGlass', FINISH.GLASS));
  // The back window, on the flat tail.
  parts.push(paint(box(2 * PROUD, winH, width * 0.78, tail, winY, 0), 'carGlass', FINISH.GLASS));

  // The front: the black grille band between the headlights at lamp height, and the VW roundel
  // in the middle of it, chrome, standing proud of the band.
  const grilleH = 0.26;
  parts.push(paint(box(2 * PROUD, grilleH, width * 0.42, nose, LIGHT_Y + 0.05, 0), 'westfaliaTrim', FINISH.TYRE));
  const roundel = new THREE.CylinderGeometry(0.15, 0.15, 4 * PROUD, 16);
  roundel.rotateZ(Math.PI / 2);
  roundel.translate(nose, LIGHT_Y + 0.4, 0);
  parts.push(paint(roundel, 'hubcap', FINISH.METAL));

  // The pop-top, closed: a white fibreglass cap a little narrower than the roof, sloped at the
  // front, flat at the back where the Westfalia's hinge-up end is. Its underside is buried 0.01.
  const CAP_H = 0.17;
  const cap = [
    new THREE.Vector2(tail + 0.2, ROOF - 0.01),
    new THREE.Vector2(SCREEN_TOP_X - 0.2, ROOF - 0.01),
    new THREE.Vector2(SCREEN_TOP_X - 0.45, ROOF + CAP_H),
    new THREE.Vector2(tail + 0.2, ROOF + CAP_H),
  ];
  const capW = width * 0.86;
  parts.push(paint(extrudeOutlines([cap], -capW / 2, capW / 2), 'westfaliaRoof'));

  parts.push(...wheelGeometries(len, width));
  return merge(parts);
}
