import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, bakeColors } from '../util/geo.js';
import { color } from '../palette.js';

// The two pieces of street furniture the taxi can swipe off the kerb (game/streetprops.js): a blue
// post box and a hot dog cart under a striped umbrella, plus the things each one sprays when it
// goes — letters and hot dogs.
//
// Every model is built facing **+X**: local +X is the road, local Z runs along the kerb, and y = 0
// is the pavement it stands on. The game turns them to their kerb.
//
// Sizes are the city's toy scale rather than real ones. A real collection box is 1.2m, which at
// the taxi's 3.4 units to 4.5m would be 0.9 — and a 0.9-unit box at play zoom is seven pixels of
// blue, which is a smudge. 1.15 to the top of the dome reads as a post box beside a 1.2-tall taxi
// without competing with it.

const box = (parts, w, h, d, x, y, z, col) => {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y, z);
  parts.push(bakeColor(geo, color(col)));
};

const merged = (parts) => {
  const geo = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return geo;
};

export const MAILBOX = { w: 0.5, d: 0.56, legs: 0.16, body: 0.62 };
/** Half its footprint across the kerb (x) and along it (z) — what the swipe aims at. */
export const MAILBOX_HALF = { x: MAILBOX.w / 2, z: MAILBOX.d / 2 };

/** The blue post box: four stubby legs, a box, a round top, and a pull-down slot facing the road. */
export function mailboxGeometry() {
  const { w, d, legs, body } = MAILBOX;
  const parts = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      box(parts, 0.07, legs, 0.07, sx * (w / 2 - 0.05), legs / 2, sz * (d / 2 - 0.05), 'mailboxTrim');
    }
  }
  box(parts, w, body, d, 0, legs + body / 2, 0, 'mailboxBlue');
  // The dome: a half-cylinder running along the kerb, as wide as the box. Eight sides is enough
  // to read as round at this size and still facet like everything else in the city.
  const dome = new THREE.CylinderGeometry(w / 2, w / 2, d, 8, 1, false, 0, Math.PI);
  // Its axis laid along z, then the x >= 0 half three builds turned up to y >= 0.
  dome.rotateX(Math.PI / 2);
  dome.rotateZ(Math.PI / 2);
  dome.translate(0, legs + body, 0);
  parts.push(bakeColor(dome, color('mailboxBlue')));
  // The slot's pull-down flap, the darker band under it, and the white label below — all on the
  // road face, which is one of the two faces this camera ever sees.
  const fx = w / 2;
  box(parts, 0.04, 0.12, d * 0.62, fx + 0.02, legs + body - 0.04, 0, 'mailboxTrim');
  box(parts, 0.02, 0.05, d * 0.5, fx + 0.04, legs + body - 0.04, 0, 'mailboxSlot');
  box(parts, 0.02, 0.16, d * 0.42, fx + 0.01, legs + body * 0.42, 0, 'mailboxLabel');
  // The same label on the face that looks along the kerb toward +Z, the camera's other side.
  box(parts, w * 0.42, 0.16, 0.02, 0, legs + body * 0.42, d / 2 + 0.01, 'mailboxLabel');
  return merged(parts);
}

export const CART = { len: 1.3, d: 0.62, wheelR: 0.2, deck: 0.3, box: 0.62, pole: 1.95, canopyR: 0.9, canopyH: 0.36 };
export const CART_HALF = { x: CART.d / 2, z: CART.len / 2 };

/**
 * The hot dog cart: a steel box on two wheels with a red-and-yellow skirt, a handle at one end,
 * condiment bottles on the counter, and a pole carrying a striped umbrella. The pole stands at the
 * road edge of the cart so the canopy overhangs the street rather than the façade behind it.
 */
export function hotDogCartGeometry() {
  const { len, d, wheelR, deck, box: h, pole, canopyR, canopyH } = CART;
  const parts = [];
  const top = deck + h;
  box(parts, d, h, len, 0, deck + h / 2, 0, 'cartSteel');
  // A coloured band round the box, proud of it by a hair on the two seen faces.
  box(parts, d + 0.02, 0.16, len + 0.02, 0, deck + h * 0.45, 0, 'cartBand');
  box(parts, d + 0.06, 0.04, len + 0.06, 0, top + 0.02, 0, 'cartTrim');
  // Two big wheels on the long sides, near one end, and a prop leg at the other.
  for (const sx of [-1, 1]) {
    const wheel = new THREE.CylinderGeometry(wheelR, wheelR, 0.06, 10);
    wheel.rotateZ(Math.PI / 2);
    wheel.translate(sx * (d / 2 + 0.04), wheelR, -len / 2 + 0.3);
    parts.push(bakeColor(wheel, color('cartTyre')));
  }
  box(parts, 0.06, deck, 0.06, 0, deck / 2, len / 2 - 0.12, 'cartTrim');
  // The push handle off the end the leg is at.
  box(parts, 0.05, 0.05, 0.28, 0, top - 0.08, len / 2 + 0.14, 'cartTrim');
  // Steam lids and two squeeze bottles on the counter.
  box(parts, d * 0.7, 0.05, len * 0.36, 0, top + 0.06, -len * 0.18, 'cartSteelDark');
  box(parts, 0.08, 0.16, 0.08, -0.12, top + 0.1, len * 0.22, 'ketchup');
  box(parts, 0.08, 0.16, 0.08, 0.04, top + 0.1, len * 0.3, 'mustard');
  // The pole, off the road-side edge of the counter, and the umbrella on it.
  const poleX = d / 2 - 0.1;
  box(parts, 0.05, pole - top, 0.05, poleX, top + (pole - top) / 2, 0, 'cartTrim');
  parts.push(umbrellaCanopy(canopyR, canopyH, poleX, pole));
  box(parts, 0.06, 0.12, 0.06, poleX, pole + canopyH + 0.04, 0, 'cartTrim');
  return merged(parts);
}

/**
 * The umbrella: an open cone, eight gores alternating red and yellow, lit from above. Coloured by
 * the angle of each triangle's centroid rather than by index, so it does not depend on how three
 * orders the cone's faces.
 */
function umbrellaCanopy(r, h, x, y) {
  const GORES = 8;
  const cone = new THREE.ConeGeometry(r, h, GORES, 1, true);
  cone.translate(0, h / 2, 0);
  const geo = cone.toNonIndexed();
  cone.dispose();
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const a = color('umbrellaA');
  const b = color('umbrellaB');
  for (let t = 0; t < pos.count; t += 3) {
    let cx = 0;
    let cz = 0;
    for (let k = 0; k < 3; k++) { cx += pos.getX(t + k); cz += pos.getZ(t + k); }
    const angle = Math.atan2(cz, cx) + Math.PI;
    const c = Math.floor((angle / (Math.PI * 2)) * GORES) % 2 ? a : b;
    for (let k = 0; k < 3; k++) colors.set([c.r, c.g, c.b], (t + k) * 3);
  }
  const out = bakeColors(geo, colors);
  out.translate(x, y, 0);
  return out;
}

/** A letter: a flat envelope with a stamp in one corner. */
export function letterGeometry() {
  const parts = [];
  box(parts, 0.3, 0.015, 0.2, 0, 0, 0, 'envelope');
  box(parts, 0.06, 0.02, 0.06, 0.1, 0.002, -0.05, 'umbrellaA');
  return merged(parts);
}

/** A hot dog: a sausage poking out of both ends of a bun, with a squiggle of mustard on top. */
export function hotDogGeometry() {
  const parts = [];
  box(parts, 0.3, 0.07, 0.13, 0, 0, 0, 'bun');
  box(parts, 0.38, 0.07, 0.07, 0, 0.03, 0, 'sausage');
  box(parts, 0.24, 0.02, 0.03, 0, 0.075, 0, 'mustard');
  return merged(parts);
}
