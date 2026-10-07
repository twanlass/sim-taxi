import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, setFinish, FINISH } from '../util/geo.js';
import { color } from '../palette.js';

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
export const WHEEL_W = 0.52;              // tread, kept in proportion — a wide disc on a narrow tread
                                   // reads as a bicycle wheel from this camera
const WHEEL_PROUD = 0.11;          // how far the tread stands out past the flank, as it always did
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

// The underside of every body — car, truck chassis and taxi alike (`0.78 + CHASSIS_LIFT`, less half
// the 0.8 body). The glossy paint centres its curve above this, so the wheels below it don't drag
// the crown down toward the road (`propMaterial({ gloss })`, util/geo.js).
export const SILL_Y = 0.38 + CHASSIS_LIFT;

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
  return tyreWithHubs();
}

// The hubcap: a steel disc on each face of the tyre, the metal finish (`FINISH.METAL`). Both faces,
// because the steered pair is one geometry used on both sides of the car; the inboard one is behind
// the body. Stands HUB_PROUD clear of the sidewall rather than on it — two flat surfaces at the
// same depth is a shimmer (CLAUDE.md) — and its inner face is buried against the sidewall facing
// inward, where it is culled before it can fight anything.
const HUB_R = WHEEL_R * 0.55;
const HUB_PROUD = 0.04;

/** A tyre with a hubcap either side, centred on its own hub with the axle along z. */
function tyreWithHubs() {
  // `bakeColor` hands back a new, de-indexed geometry, so it is the return value that goes in.
  const tyre = setFinish(bakeColor(
    new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, WHEEL_SEGMENTS), TYRE), FINISH.TYRE);
  const parts = [tyre];
  for (const side of [-1, 1]) {
    const hub = new THREE.CylinderGeometry(HUB_R, HUB_R, HUB_PROUD, WHEEL_SEGMENTS);
    hub.translate(0, side * (WHEEL_W + HUB_PROUD) / 2, 0);
    parts.push(setFinish(bakeColor(hub, color('hubcap')), FINISH.METAL));
  }
  const wheel = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  wheel.rotateX(Math.PI / 2);   // axle across the car
  return wheel;
}

/**
 * The fixed wheels for a vehicle whose origin sits on the road surface — the rear pair only.
 * The front pair is drawn separately so it can be steered; see `wheelGeometry`.
 */
export function wheelGeometries(len, width) {
  return wheelAnchors(len, width)
    .filter((a) => !a.front)
    .map((a) => {
      const wheel = tyreWithHubs();
      wheel.translate(a.x, a.y, a.z);
      return wheel;
    });
}

// --- Wheel wells -----------------------------------------------------------------------------
//
// The body used to be one box, and the wheels stood WHEEL_PROUD out of its flank with the inner
// 0.41 of every tread buried in it. Straight ahead that read as a wheel; steered, the flank cut the
// front pair on a slant — the trailing half of a tyre at full lock (STEER_MAX, 0.6 rad) swung into
// the panel and vanished, the leading half swung out, and the flank's edge drew a diagonal across
// the rubber. So the body has arches now: an opening in each flank around each axle, and a dark
// liner across the middle of the car that is the well's inner wall.
//
// Sized off the swept tyre rather than the still one. A wheel turned by θ reaches
// `WHEEL_R cos θ + WHEEL_W/2 sin θ` fore and aft of its hub — 0.675 at full lock against 0.64
// straight — and its top stays at WHEEL_R whatever the lock, since the steer is a yaw. ARCH_GAP
// clears both: 0.025 fore and aft at full lock, 0.06 over the top. The arch top then sits at 1.34
// against a body top of 1.50, which leaves the panel over the wheel 0.16 deep.
//
// The wheels are big for the camera (see WHEEL_R), so on a car the arch runs off the end of the body:
// a front hub at 0.3 · CAR_LEN with this radius reaches 0.02 past the nose. The end face is simply cut
// where it is crossed — the corners of the car are open below 0.81, the way a car with its wheels at
// the corners looks — rather than the arch being squeezed to fit, which would put the panel back into
// the swept tyre.
export const ARCH_GAP = 0.06;
export const ARCH_R = WHEEL_R + ARCH_GAP;
const ARCH_STEPS = 16;               // facets across a half-circle — 11° each, round at this size
// How far inboard of a tread's inner face the well's back wall stands. At full lock the trailing
// corner of a tyre reaches further in than this (to 0.12 off the centreline on a car); that part is
// behind the tyre, seen from outside, and the wall hides the rest.
const WELL_BACK = 0.12;

/** Each axle's hub, fore-aft, for a body `len` long. */
function archCentres(len) {
  return [...new Set(wheelAnchors(len, 1).map((a) => a.x))].sort((a, b) => a - b);
}

/**
 * Height of the arch over car-local `x`, or -Infinity where there is no arch — the underside the
 * body has there. `gap` widens the arch, for trim that wants to stand off the lip.
 */
export function archCeiling(len, x, gap = 0) {
  const r = ARCH_R + gap;
  let top = -Infinity;
  for (const ax of archCentres(len)) {
    const dx = x - ax;
    if (Math.abs(dx) < r) top = Math.max(top, WHEEL_R + Math.sqrt(r * r - dx * dx));
  }
  return top;
}

// The x positions an outline is sampled at: the ends, the facets of each arch, and the exact points
// where an arch crosses the band's top and bottom, so a run of panel starts and stops on the curve
// rather than a facet short of it.
function archSamples(len, x0, x1, y0, y1, gap) {
  const r = ARCH_R + gap;
  const xs = [x0, x1];
  for (const ax of archCentres(len)) {
    for (let k = 0; k <= ARCH_STEPS; k++) xs.push(ax + r * Math.cos((Math.PI * k) / ARCH_STEPS));
    for (const y of [y0, y1]) {
      const h = y - WHEEL_R;
      if (Math.abs(h) < r) {
        const dx = Math.sqrt(r * r - h * h);
        xs.push(ax - dx, ax + dx);
      }
    }
  }
  const sorted = xs.filter((x) => x >= x0 && x <= x1).sort((a, b) => a - b);
  return sorted.filter((x, i) => i === 0 || x - sorted[i - 1] > 1e-6);
}

/**
 * The band `x0..x1` × `y0..y1` of a flank, in car-local x/y, split into the outlines that remain
 * once the arches are cut out of it (`below: false`) — or the outlines of what was cut
 * (`below: true`). Each outline is a list of Vector2, one per run between arches. The two answers
 * share their sample points exactly, so a panel and the liner under it meet on one curve.
 */
export function archOutlines(len, x0, x1, y0, y1, { gap = 0, below = false } = {}) {
  const xs = archSamples(len, x0, x1, y0, y1, gap);
  const lip = (x) => Math.min(y1, Math.max(y0, archCeiling(len, x, gap)));
  const runs = [];
  let run = null;
  for (let i = 0; i < xs.length - 1; i++) {
    const mid = lip((xs[i] + xs[i + 1]) / 2);
    const open = below ? mid > y0 + 1e-6 : mid < y1 - 1e-6;
    if (open && !run) runs.push(run = [i]);
    if (open) run[1] = i + 1;
    else run = null;
  }
  return runs.map(([a, b]) => {
    const edge = xs.slice(a, b + 1).map((x) => new THREE.Vector2(x, lip(x)));
    // Panel: along the arch-cut underside left to right, then back across the flat top. Liner: along
    // the flat sill left to right, then back over the arch.
    const flat = below ? y0 : y1;
    const outline = below
      ? [new THREE.Vector2(edge[0].x, flat), new THREE.Vector2(edge.at(-1).x, flat), ...edge.reverse()]
      : [...edge, new THREE.Vector2(edge.at(-1).x, flat), new THREE.Vector2(edge[0].x, flat)];
    return outline.filter((p, i) => p.distanceTo(outline[(i + 1) % outline.length]) > 1e-6);
  });
}

/** Outlines from `archOutlines`, each extruded across car-local `z0..z1`, merged. Non-indexed. */
export function extrudeOutlines(outlines, z0, z1) {
  const parts = outlines.map((outline) => {
    const solid = new THREE.ExtrudeGeometry(new THREE.Shape(outline), { depth: z1 - z0, bevelEnabled: false });
    solid.translate(0, 0, z0);
    solid.deleteAttribute('uv');
    solid.clearGroups();
    return solid;
  });
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * A vehicle's lower body — the slab every car, truck chassis and the taxi rides on — `len` × `width`,
 * centred at `centreY` and `height` tall, with a wheel arch cut over each axle and the well's liner
 * behind it. Baked: the panel in `paint` on the paint finish, the liner `wheelWell` on the tyre's
 * matte one, which is dark enough that the fleet's instance tint leaves it dark.
 */
export function archedBodyGeometries(len, width, centreY, height, paint) {
  const y0 = centreY - height / 2;
  const y1 = centreY + height / 2;
  const panel = extrudeOutlines(archOutlines(len, -len / 2, len / 2, y0, y1), -width / 2, width / 2);
  const back = Math.abs(wheelAnchors(len, width)[0].z) - WHEEL_W / 2 - WELL_BACK;
  const liner = extrudeOutlines(archOutlines(len, -len / 2, len / 2, y0, y1, { below: true }), -back, back);
  return [
    setFinish(bakeColor(panel, paint), FINISH.PAINT),
    setFinish(bakeColor(liner, color('wheelWell')), FINISH.TYRE),
  ];
}
