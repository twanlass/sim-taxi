import * as THREE from 'three';
import { color } from '../palette.js';
import { CHASSIS_LIFT } from './wheels.js';

// Brake and turn-signal light pods — the geometry and material both the ambient fleet
// (sim/traffic.js, as an InstancedMesh) and the player's taxi (geometry/taxi.js, as an ordinary
// Mesh) build from, so a light looks the same whichever vehicle is wearing it. Lives outside both
// for the same reason geometry/wheels.js does: traffic.js and taxi.js already import each other,
// and a constant crossing that cycle at module-evaluation time is a temporal-dead-zone error.
//
// Neither light can be a coloured facet baked into a body mesh: an ambient car's vertex colour is
// baked once and only ever multiplied by the instance's paint tint (see the note by carGeometry()
// in sim/traffic.js), so there is nowhere in that buffer for a colour that has to flip on and off,
// frame to frame, independently per instance — instanceColor is RGB paint and nothing else. So each
// kind of light wears one fixed, always-emissive material, and "on"/"off" is the mesh's own scale
// rather than a colour write — the ambient fleet collapses an instance's matrix to a precomputed
// zero-scale one, the taxi (ordinary Meshes, not instances) just scales them.
//
// Which makes **what each pod is scaled about** load-bearing rather than incidental, and is why a
// pod's offset lives on its transform and not in its vertices. See lightPodGeometry().

// Brake and turn-signal pods share one size — colour (see LIGHT_EMISSIVE and the two materials
// below) is what tells them apart, not geometry.
export const LIGHT_D = 0.272;                // fore-aft
export const LIGHT_H = 0.544;
export const LIGHT_W = 0.544;                // across the car
export const LIGHT_Y = 0.55 + CHASSIS_LIFT;  // bumper height

// How far a pod's outer faces stand proud of the body's own — the same fix `WHEEL_PROUD`
// (geometry/wheels.js) already applies to a wheel against the flank. Flush (proud = 0) put a pod's
// outer face exactly on the same plane as the body's own flank and end-cap faces, and two coplanar
// faces at the same depth z-fight.
export const LIGHT_PROUD = 0.03;

// Emissive intensity for both kinds of light — high enough to read as self-lit day or night, the
// same job EMISSIVE does for the fare diamond (geometry/diamond.js), just without a resting/peak
// pair since these have nothing to peak from: they are either present or not.
export const LIGHT_EMISSIVE = 1.4;

/**
 * One light pod, centred on its own origin.
 *
 * **Centred, and a pod's offset travels on its transform rather than in its vertices. That split is
 * the whole of this shape and it is not a style choice.** On/off here is a *scale* (see the note
 * above), and a scale is about the origin of whatever carries it — so a pod holding its own offset
 * in its vertices does not dim as the level falls, it **moves**: down the body toward the car's
 * own centre, and down toward the road, arriving at both when the lamp reaches zero.
 *
 * It shipped that way and it was the bloom that made it visible rather than the mesh. At play zoom
 * a pod is a handful of pixels and its slide reads as nothing much; the spill around it is a soft
 * blob an order of magnitude wider, and *that* was plainly detaching from the tail and crawling up
 * the flank. Only the brake lamp shows it, because only the brake level is eased
 * (`BRAKE_LIGHT_FALL` in sim/traffic.js, ~0.75s to dark) — a turn signal steps between 0 and 1 and
 * is never caught in between. Measured travel from lit to dark, on the geometry below: **1.59
 * units forward and 0.87 down on a car (1.88 / 1.03 on the taxi, which wears TAXI_SCALE), 2.69 and
 * 0.87 on a truck** — where a truck is 5.6 long, so the lamp finished up level with the middle of
 * the cargo box, which is exactly where it was reported.
 *
 * So the pair is two pods and not one merged geometry: the anchor is a *pivot*, and a pivot has to
 * be per pod. One merged pair can only ever be scaled about a point both pods share, and the two
 * kinds disagree about which point that is — a brake pair shares its x and y and differs across the
 * car, a turn-signal pair shares its y and z and differs along it. Two transforms sidestep the
 * question. sim/traffic.js indexes two instances per vehicle (the stride its steered wheels already
 * use); geometry/taxi.js hangs two ordinary Meshes.
 */
export function lightPodGeometry() {
  return new THREE.BoxGeometry(LIGHT_D, LIGHT_H, LIGHT_W);
}

/**
 * Where one pod sits, in car-local space. `sx` picks the front (+1) or rear (-1) bumper; `sz` picks
 * a side — `+1` is the car's own right, `-1` its left, in the same local +Z-is-right frame the wheel
 * anchors use (see `wheelAnchors` — a car built at yaw 0 drives down +X, and rightOf/leftOf on that
 * heading resolve to world +Z/-Z, which at yaw 0 *is* local Z).
 *
 * The pod is `LIGHT_D`/`LIGHT_H`/`LIGHT_W` and always has been — the sizes were parameters back
 * when this returned geometry, and every caller passed the same three constants. What genuinely
 * varies per vehicle is `len`/`width`, i.e. the bumper this pod is pinned to.
 */
export function lightPodAnchor(sx, sz, len, width) {
  return new THREE.Vector3(
    sx * (len / 2 + LIGHT_PROUD - LIGHT_D / 2),
    LIGHT_Y,
    sz * (width / 2 + LIGHT_PROUD - LIGHT_W / 2),
  );
}

/**
 * How many pods one light is made of. Both kinds are a pair, and a pair is the unit that switches
 * together — which is also the instance stride sim/traffic.js indexes its light meshes by, the way
 * `FRONT.length` is the stride for the steered wheels.
 */
export const LIGHT_PODS = 2;

/** Both rear corners — the two brake lights only ever switch together. */
export function brakeLightAnchors(len, width) {
  return [
    lightPodAnchor(-1, -1, len, width),
    lightPodAnchor(-1, 1, len, width),
  ];
}

/** The front and rear pod on one side — a side's pair blinks together. */
export function turnSignalAnchors(len, width, side) {
  return [
    lightPodAnchor(1, side, len, width),
    lightPodAnchor(-1, side, len, width),
  ];
}

/** Fresh material per mesh, matching `propMaterial()`'s (util/geo.js) own one-material-per-mesh habit. */
export function brakeLightMaterial() {
  return new THREE.MeshLambertMaterial({
    color: color('lightRed'),
    emissive: color('lightRed'),
    emissiveIntensity: LIGHT_EMISSIVE,
    flatShading: true,
  });
}

export function turnSignalMaterial() {
  return new THREE.MeshLambertMaterial({
    color: color('turnSignal'),
    emissive: color('turnSignal'),
    emissiveIntensity: LIGHT_EMISSIVE,
    flatShading: true,
  });
}

// --- The siren bar ------------------------------------------------------------
//
// A police light bar, as a *pair of pods on the roof* built out of the same machinery the brake
// and turn-signal pods are: one fixed emissive material per colour, and on/off as a scale about
// each pod's own origin. It exists for the [bank robbery](../../docs/gameplay.md#the-bank-robbery)
// — the cop cars that event puts into ambient traffic are ordinary cars off `carGeometry()`, and
// the only thing that makes one read as a police car at play zoom is the livery underneath and
// this alternating on the roof.
//
// It is **not** the cruiser's bar. `sim/police.js` builds its own, as two ordinary Meshes on a
// group with a real PointLight behind each, because there is exactly one cruiser and it can afford
// them. There can be half a dozen cop cars in ambient traffic and a point light each is not free,
// so these are instanced and their spill is the bloom's (`emissiveMeshes` in sim/traffic.js) rather
// than a light's. What the two *do* share is the rate below, so a city with both in it strobes on
// one clock.

/**
 * Fore-aft, vertical and across.
 *
 * A shade larger than the cruiser's own 0.55/0.26/0.5, which is the opposite of what a cop car in
 * ambient traffic looks like it should get. The cruiser is one car the player is *hunting for* and
 * it arrives with a screen-edge wash announcing it (game/sirenglow.js); these are four cars in the
 * middle of ordinary traffic with nothing announcing them, so the bar is the entire cue and it has
 * to survive being one vehicle among a dozen. At 7.7px per unit the pair spans 9.9px across the
 * roof — two 4.5 x 4.0px lamps 5.9px apart — which is about a third of the car's drawn width.
 */
const SIREN_D = 0.58;
const SIREN_H = 0.30;
const SIREN_W = 0.52;

/**
 * How far each pod sits off the car's centreline.
 *
 * A car's cabin is `CAR_W * 0.86` = 1.462 across, so its half-width is 0.731 — and a pod centred
 * 0.38 out reaches 0.64, which keeps both of them on the roof they are bolted to rather than
 * overhanging the gutter. Wide enough apart to read as two lamps rather than one blob: 0.76
 * between the centres against pods 0.52 across.
 */
const SIREN_SPREAD = 0.38;

/** Bar changes a second: six, matching the cruiser's corridor rate. */
const SIREN_HZ = 6;
/** ...and eleven once it has locked on, which is the only cue a chase gives. */
const SIREN_HUNT_HZ = 11;

/**
 * Which half of the strobe a bar is in — true for red, false for blue.
 *
 * Three consumers and one clock: the cruiser's own bar (`sim/police.js`), the off-screen wash that
 * stands in for it (`game/sirenglow.js`), and the instanced bars on the robbery's cop cars
 * (`sim/traffic.js`). It lives here rather than with the cruiser because it stopped being the
 * cruiser's the moment a second kind of police car existed — and a second clock keeping its own
 * time would have the two blinking out of step on the same street.
 */
export function sirenOn(flash, hunting = false) {
  return Math.floor(flash * (hunting ? SIREN_HUNT_HZ : SIREN_HZ)) % 2 === 0;
}

/**
 * One siren pod, centred on its own origin — the same contract `lightPodGeometry()` keeps, and for
 * the same reason: on/off here is a scale, and a scale is about the origin of whatever carries it.
 * A pod holding its roof offset in its vertices would slide down into the cabin as it dimmed.
 */
export function sirenPodGeometry() {
  return new THREE.BoxGeometry(SIREN_D, SIREN_H, SIREN_W);
}

/**
 * Where one pod sits, in car-local space. `sz` picks a side, `-1` the car's own left.
 *
 * `roofY` is the top of the cabin the bar stands on, which the caller knows and this module does
 * not — a cop car is an ordinary ambient car today, and nothing here should assume it stays one.
 * `roofX` is the cabin's own centre along the car, so the bar sits on the roof rather than hanging
 * off its back edge.
 */
export function sirenPodAnchor(sz, roofX, roofY) {
  return new THREE.Vector3(roofX, roofY + SIREN_H / 2, sz * SIREN_SPREAD);
}

/**
 * The bar's two pods — the same pair for both colours, so the **whole bar** goes red, then blue,
 * rather than one lamp lighting at each end.
 *
 * A real bar does the second thing and this one deliberately does not, for a reason that is
 * arithmetic rather than taste: a pod is 4px across at play zoom, so a bar split by colour
 * alternates two specks a colour apart and reads as a flicker. Flashing both pods together is one
 * mark 9.9px wide changing colour six times a second, which is what actually announces a police
 * car from across a five-block city.
 *
 * It also keeps `LIGHT_PODS` honest as the instance stride, which is the half that would have
 * bitten: a one-pod anchor list leaves the second slot of every car's stride untouched, and an
 * `InstancedMesh` initialises its matrices to the **identity** — so every ambient car in the city
 * would have parked a siren pod at the world origin.
 */
export function sirenBarAnchors(roofX, roofY) {
  return [sirenPodAnchor(-1, roofX, roofY), sirenPodAnchor(1, roofX, roofY)];
}

/**
 * The bar's housing: the dark box the two pods are bolted into, and the part of the bar that is
 * still there when it is switched off.
 *
 * **Without it a stood-down cop car is an ordinary car.** The bar is two lamps and nothing else,
 * and a lamp's off is a zero scale — so the frame a robbery ended, every cop car lost the only
 * thing on it that was not a car body, and `policeBody` (#2E5FA8) is a few steps off the
 * ordinary blue in `carBody` (#4E7FC0). At play zoom the fleet driving off read as the police
 * turning back into traffic. The housing is how a car with its lights off still says police.
 *
 * Inset from the pods on every side they share — 0.02 along the car and across, 0.04 lower — so a
 * lit pod wholly encloses its end of the housing and the two never draw a face on the same plane.
 * The one face they do share is the bottom, on the roof, and that faces down and is culled. What
 * shows while the bar is lit is the strip between the pods, which is what a real bar looks like.
 */
export function sirenHousingGeometry() {
  const span = 2 * (SIREN_SPREAD + SIREN_W / 2) - 0.04;
  return new THREE.BoxGeometry(SIREN_D - 0.04, SIREN_H - 0.04, span);
}

/** Where the housing sits in car-local space: on the roof, between the two pod anchors. */
export function sirenHousingAnchor(roofX, roofY) {
  return new THREE.Vector3(roofX, roofY + (SIREN_H - 0.04) / 2, 0);
}

/** The red half of the bar. Same `lightRed` the brake pods and the cruiser's own bar wear. */
export function sirenRedMaterial() {
  return new THREE.MeshLambertMaterial({
    color: color('lightRed'),
    emissive: color('lightRed'),
    emissiveIntensity: LIGHT_EMISSIVE,
    flatShading: true,
  });
}

/** ...and the blue half. `sirenBlue` is deliberately brighter and bluer than `policeBody`. */
export function sirenBlueMaterial() {
  return new THREE.MeshLambertMaterial({
    color: color('sirenBlue'),
    emissive: color('sirenBlue'),
    emissiveIntensity: LIGHT_EMISSIVE,
    flatShading: true,
  });
}
