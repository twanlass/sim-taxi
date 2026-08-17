import * as THREE from 'three';
import { bakeColor } from '../util/geo.js';

// Wheels, and the ride height that follows from them. Every vehicle in the game is built against
// this file: ambient traffic and the taxi in sim/traffic.js and geometry/taxi.js, the cruiser in
// sim/police.js.
//
// It is its own module rather than part of traffic.js because traffic.js and taxi.js already
// import each other — a cycle that was harmless while only functions crossed it, and stopped being
// harmless the moment a constant did. `TAXI_TAILPIPE_HEIGHT` is evaluated when taxi.js loads,
// which is *during* traffic.js's own evaluation, so reading a `const` off traffic.js there is a
// temporal-dead-zone error. Nothing here imports back.
//
// geometry/lights.js (brake and turn-signal pods) sits beside this file for the identical reason.

// Doubled from the 0.32 / 0.26 they shipped at, because at that size the steering was invisible: a
// wheel was about 5px long at play zoom and its whole travel from straight to full lock moved the
// outline by roughly a pixel. Twice the radius is twice the lever arm the eye has to read the
// angle off.
export const WHEEL_R = 0.64;
const WHEEL_W = 0.52;              // tread, kept in proportion — a wide disc on a narrow tread
                                   // reads as a bicycle wheel from this camera
// How far the tread stands out past the flank — **negative now**, i.e. tucked just inside it.
//
// It was +0.11 for as long as a car was two boxes, and had to be: a wheel flush with a flat flank
// is occluded from this camera and shows as a notch in the sill, which is the second of the two
// failed attempts CHASSIS_LIFT exists to record (see below). What changed is that the flank is no
// longer flat — geometry/carbody.js cuts an arch back 0.30 at each axle — so the wheel is visible
// *through the opening* rather than by standing outside the bodywork. The tuck is what makes it
// read as a wheel sitting in a well instead of a wheel bolted to a slab.
//
// Small and negative rather than zero: at exactly zero the tread's outer face and the flank are
// coplanar, and two coplanar faces at the same depth z-fight.
const WHEEL_PROUD = -0.02;
const WHEEL_SEGMENTS = 16;         // doubled from 8 — at WHEEL_R's size the 8-gon's facets read as
                                   // flats, 16 reads round

/**
 * How far the bodywork rides above where it sat on the original 0.32 wheel.
 *
 * Big wheels under an unchanged body is the monster-truck look: the tops cleared the waistline and
 * the car sat sunk between them. Tucking them inside the flank instead fixed the proportions and
 * threw away the point — occluded from this camera a wheel shows as a notch in the sill, and its
 * angle goes straight back to being unreadable. So the body goes up with the wheel and the tread
 * stays proud.
 *
 * Every y in the vehicle geometry is still written as the number it was designed at, plus this.
 * Derived rather than typed so the two can't drift apart the next time a wheel is resized.
 */
export const CHASSIS_LIFT = WHEEL_R - 0.32;

// Baked dark rather than white: the shared material reads vertex colours and instanceColor
// multiplies on top, so a dark base stays dark whatever colour the car is tinted. Darker than the
// 0.16/0.16/0.18 it shipped at — against the '#636972' asphalt (src/palette.js) that read as
// barely darker than the road under the tread's own shadow.
const TYRE = new THREE.Color(0.08, 0.08, 0.09);

/**
 * Where each wheel's hub sits in car-local space. +x is the nose — main.js puts the tailpipe at
 * -x and the cabin is set back the same way.
 */
export function wheelAnchors(len, width) {
  const out = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      out.push({
        front: sx > 0,
        x: sx * (len * 0.3),
        y: WHEEL_R,
        // Positioned by its outer face, not its centre, so the tread stays the same amount proud
        // of the flank whatever WHEEL_W is. Anchoring the centre instead pushed the track out by
        // half of every width increase and the car ended up standing on outriggers.
        z: sz * (width / 2 + WHEEL_PROUD - WHEEL_W / 2),
      });
    }
  }
  return out;
}

/**
 * One wheel, centred on its own hub rather than placed on the car.
 *
 * The front pair steers, so it can't be baked into the body: each one needs a pivot of its own to
 * yaw about. Centring the geometry on the hub is what makes that pivot the axle rather than the
 * car's origin.
 */
export function wheelGeometry() {
  const wheel = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, WHEEL_SEGMENTS);
  wheel.rotateX(Math.PI / 2);   // axle across the car
  return bakeColor(wheel, TYRE);
}

/**
 * The fixed wheels for a vehicle whose origin sits on the road surface — the rear pair only.
 * The front pair is drawn separately so it can be steered; see `wheelGeometry`.
 */
export function wheelGeometries(len, width) {
  return wheelAnchors(len, width)
    .filter((a) => !a.front)
    .map((a) => {
      const wheel = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, WHEEL_SEGMENTS);
      wheel.rotateX(Math.PI / 2);
      wheel.translate(a.x, a.y, a.z);
      return bakeColor(wheel, TYRE);
    });
}
