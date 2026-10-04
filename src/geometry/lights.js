import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { color } from '../palette.js';
import { bakeColor, unlitMaterial } from '../util/geo.js';
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
// below) is what tells them apart, not geometry. A pod is a round lamp: a short disc facing out of
// the bumper, `LIGHT_H` across in both directions (see roundLamp()).
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
  return roundLamp(LIGHT_H / 2, LIGHT_D);
}

/**
 * Sides on a lamp's disc. They were boxes once; ten reads as a circle
 * on the 9-unit close-up and as a dot at play zoom, where a pod is four pixels across. It is not
 * free: 64 vertices against a box's 24, on up to ~8 pods a car — a few thousand vertices across a
 * full street, which is noise next to one building.
 */
const LAMP_SEGMENTS = 10;

/**
 * A round lamp, centred on its own origin with its face along ±X — a closed `CylinderGeometry`
 * laid on its side. Centred for the pivot reason above; the back cap is inside the body and costs
 * nothing worth saving, and it is what the taxi's loose lamps show swinging on their wires.
 * Three winds a cylinder outward, so no hand-made triangles here to assert.
 */
function roundLamp(radius, depth) {
  const geo = new THREE.CylinderGeometry(radius, radius, depth, LAMP_SEGMENTS, 1, false);
  geo.rotateZ(Math.PI / 2);
  return geo;
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

/**
 * How wide the *front* indicator is across the car. Narrower than a full pod so the headlight beside
 * it has room: at the full `LIGHT_W` the lit amber covered 0.34..0.88 of a car's 0.88 half-width and
 * stood twice the headlight's height right next to it, so the headlight on the blinking side read
 * as switched off. The rear indicator stays full width — it shares its corner (and its anchor) with
 * the brake pod, and a narrower one would vanish inside it whenever the brakes are on.
 */
const FRONT_SIGNAL_W = 0.3;

/** The front and rear pod on one side — a side's pair blinks together. */
export function turnSignalAnchors(len, width, side) {
  const front = lightPodAnchor(1, side, len, width);
  front.z = side * (width / 2 + LIGHT_PROUD - FRONT_SIGNAL_W / 2);
  return [
    front,
    lightPodAnchor(-1, side, len, width),
  ];
}

/**
 * Each indicator pod's shape, as a scale on the shared pod geometry, in the same order as
 * `turnSignalAnchors`. Multiplied into the on/off level rather than baked into a second geometry
 * because the fleet draws a side's front and rear pod from one InstancedMesh.
 *
 * The front one shrinks in height as well as width, so it stays a circle — `FRONT_SIGNAL_W`
 * across — rather than squashing the round pod into an upright oval.
 */
export function turnSignalShapes() {
  const front = FRONT_SIGNAL_W / LIGHT_W;
  return [
    new THREE.Vector3(1, front, front),
    new THREE.Vector3(1, 1, 1),
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

/**
 * Headlights — in the rain (`?rain`, `?storm`, or under a squall), driven by `setRunningLights` in
 * sim/traffic.js. Two pods set *inboard* of the front indicators, which own the front corners.
 * Centred `HEADLIGHT_INSET` in from the car's own flank: on a car that is 0.28..0.54 off the
 * centreline, a 0.04 gap short of the indicator (`FRONT_SIGNAL_W`) and 0.56 from its partner.
 *
 * They used to sit 0.62 in, which put the pair 0.26 apart in the middle of the bumper — one lamp,
 * at this zoom, throwing two pools so nearly on top of each other they read as one beam.
 */
const HEADLIGHT_W = 0.26;
const HEADLIGHT_INSET = 0.44;

/** Round, `HEADLIGHT_W` across. The cone (coneGeometry) starts on its centre, so it still leaves the lamp. */
export function headlightGeometry() {
  return roundLamp(HEADLIGHT_W / 2, LIGHT_D);
}

export function headlightAnchors(len, width) {
  return [-1, 1].map((sz) => new THREE.Vector3(
    len / 2 + LIGHT_PROUD - LIGHT_D / 2,
    LIGHT_Y + 0.05,
    sz * (width / 2 - HEADLIGHT_INSET),
  ));
}

export function headlightMaterial() {
  return unlitMaterial({ color: color('headlight') });
}

/**
 * The beam itself, as a cone of light out of the lamp: open-ended, starting at the pod's own size
 * and opening to `CONE_R` over `CONE_LEN`. Built along +X from its own origin, so it hangs off a headlight
 * anchor the way a pod does and switches on and off as a scale about the lamp.
 *
 * It rides the body, pitch and all, and that is deliberate rather than the bug the pools had: a
 * real headlight dips with the nose, and where this one meets the road it is cut by the road's own
 * depth, which reads as light hitting tarmac. What looked wrong on the pool was a flat slab of
 * *ground* lifting into the air.
 */
const CONE_LEN = 4.6;
const CONE_R = 0.85;
const CONE_TIP_R = 0.1;
/** Aimed down a little, so the cone's axis reaches the road near its far end. */
const CONE_TILT = Math.atan2(0.45, CONE_LEN);
/**
 * And swung out toward its own side of the car. The toe is what keeps a pair reading as two:
 * aimed straight ahead, two beams 0.82 apart overlap over most of their width.
 */
const CONE_TOE = Math.atan2(0.4, CONE_LEN);

export function coneGeometry() {
  const geo = new THREE.CylinderGeometry(CONE_TIP_R, CONE_R, CONE_LEN, 18, 6, true);
  // Cylinder: along Y, top (the tip) at +LEN/2. Tip to the origin, then lay it along X with the
  // mouth at +X — a quarter turn about Z takes -Y to +X.
  geo.translate(0, -CONE_LEN / 2, 0);
  geo.rotateZ(Math.PI / 2);
  // Tip at 0, mouth at +LEN: the 0..1 along the beam, for the fade, before any instance transform.
  const pos = geo.attributes.position;
  const along = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) along[i] = pos.getX(i) / CONE_LEN;
  geo.setAttribute('along', new THREE.BufferAttribute(along, 1));
  return geo;
}

/**
 * The cone's turn about its lamp, for a headlight at car-local `z`: tilted down by `CONE_TILT`, then
 * toed out by `CONE_TOE`. Negative yaw swings local +X toward +Z (the car's right), so the toe's
 * sign is the opposite of `z`'s.
 */
export function coneQuat(z) {
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -CONE_TILT);
  const toe = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.sign(z) * CONE_TOE);
  return toe.multiply(tilt);
}

/**
 * Additive, both sides, never depth-written. Brightest where the camera looks *through* the most of
 * it — the faces turned toward the view — and soft at the silhouette, which is what makes a hollow
 * cone read as a volume of lit rain rather than a lampshade. Fades out along its length.
 */
export function coneMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color('headlightBeam') }, uStrength: { value: 0.45 } },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      #include <common>
      attribute float along;
      varying float vAlong;
      varying vec3 vNormalView;
      void main() {
        vAlong = along;
        vec4 mvPosition = vec4(position, 1.0);
        vec3 n = normal;
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          n = mat3(instanceMatrix) * n;
        #endif
        vNormalView = normalize(normalMatrix * n);
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uStrength;
      varying float vAlong;
      varying vec3 vNormalView;
      void main() {
        // Orthographic: the view direction is view-space +Z everywhere.
        float facing = abs(normalize(vNormalView).z);
        float a = pow(1.0 - vAlong, 1.6) * smoothstep(0.0, 0.1, vAlong) * facing;
        gl_FragColor = vec4(uColor * a * uStrength, 1.0);
      }
    `,
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
// The cruiser (`sim/police.js`) wears the same bar — same pods, same housing, same materials — but
// builds it as ordinary Meshes on its own group, with a real PointLight behind each colour, because
// there is exactly one cruiser and it can afford them. There can be half a dozen cop cars in
// ambient traffic and a point light each is not free, so theirs are instanced and their spill is
// the bloom's (`emissiveMeshes` in sim/traffic.js) rather than a light's. The cruiser used to carry
// a smaller bar of its own, split red one side and blue the other, over a white roof; with the
// robbery's fleet on the road that was two police liveries in one city, so it is one now.

/**
 * Fore-aft, vertical and across.
 *
 * Sized for a car in the middle of ordinary traffic with nothing announcing it, so the bar is the
 * entire cue and it has to survive being one vehicle among a dozen. At 7.7px per unit the pair
 * spans 9.9px across the roof — two 4.5 x 4.0px lamps 5.9px apart — which is about a third of the
 * car's drawn width. (The cruiser's old bespoke bar was 0.55/0.26/0.5.)
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
 * The patrol's bar: a slow red-to-blue swing, one full cycle a second. Asked for as "gently strobe
 * its lights red and blue" — the steady bar before it announced a cop on the board but did not look
 * alive, and the hunting strobe (11 changes a second, `sirenOn`) is kept for a chase so the change
 * is the thing the player reads.
 */
export const PATROL_SWING_HZ = 1;

/**
 * Where the patrol swing is: 1 all red, 0 all blue, a sine in between. One clock for the bar, its two
 * lamps and the off-screen wash (game/sirenglow.js), the way `sirenOn` above is one clock for the strobe.
 */
export function patrolSwing(flash) {
  return 0.5 + 0.5 * Math.sin(2 * Math.PI * PATROL_SWING_HZ * flash);
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
 * Where each colour's one lamp sits: red over the car's left lens, blue over its right, so the
 * strobe alternates *sides* — red lamp lit with the blue lens dark, then the other way round.
 *
 * It used to flash the **whole bar** one colour at a time, both pods red and then both blue, on the
 * argument that a bar split by colour alternates two 4px specks and reads as a flicker. That held
 * while an unlit pod was a zero scale and the off side was simply *gone*. Once the painted lenses
 * arrived (`sirenBaseGeometry`) the off side is a deep red or deep blue lens rather than nothing, so
 * alternating sides is a change of brightness between two coloured lamps and not a speck blinking
 * out — and the whole-bar version, seen on a phone, read as **two red lights** on half its frames,
 * with nothing on the roof saying blue at all.
 *
 * One anchor per colour, which leaves the second slot of `LIGHT_PODS` unused on both meshes. An
 * `InstancedMesh` starts every matrix at the **identity**, so an unwritten slot is a pod parked at
 * the world origin — sim/traffic.js zeroes both meshes at construction for exactly that reason.
 */
export function sirenRedAnchor(roofX, roofY) {
  return sirenPodAnchor(-1, roofX, roofY);
}

export function sirenBlueAnchor(roofX, roofY) {
  return sirenPodAnchor(1, roofX, roofY);
}

/**
 * The bar as it stands with the siren **off**: a dark housing and two painted lenses, red on the
 * car's left and blue on its right — the part of the bar that is on the roof for as long as the car
 * is police, lit or not.
 *
 * **Without it a stood-down cop car is an ordinary car.** A lamp's off is a zero scale, so the
 * frame a robbery ended every cop lost the only thing on it that was not a car body and read as
 * the police turning back into traffic. It was a bare dark box for a while; the lenses are there
 * so a parked cop's roof still says red-and-blue rather than "something on the roof".
 *
 * Nested inside the lit pods on every side but the bottom, so a lit pod wholly encloses its lens
 * and the two never draw a face on the same plane: each lens is 0.02 in from its pod along the car,
 * across it and at the top. The housing is nested again inside the lenses (another 0.02, and
 * short of each lens's outer end), and passes *through* their inner faces rather than meeting them.
 * The one face everything shares is the bottom, on the roof, and that faces down and is culled.
 * While the bar is lit what shows is the two lamps and the dark strip between them.
 *
 * Built roof-local — origin on the roof at the bar's centre — with the offsets in the vertices,
 * which is safe for exactly one reason: this is only ever switched whole, scale 0 or 1, and never
 * dimmed, so there is no in-between frame for anything to slide toward the pivot on.
 */
export function sirenBaseGeometry() {
  const lensD = SIREN_D - 0.04;
  const lensH = SIREN_H - 0.02;
  const lensW = SIREN_W - 0.04;
  const housingH = SIREN_H - 0.06;
  const housing = new THREE.BoxGeometry(SIREN_D - 0.06, housingH,
    2 * (SIREN_SPREAD + SIREN_W / 2) - 0.08);
  housing.translate(0, housingH / 2, 0);
  const lens = (sz, name) => {
    const box = new THREE.BoxGeometry(lensD, lensH, lensW);
    box.translate(0, lensH / 2, sz * SIREN_SPREAD);
    return bakeColor(box, color(name));
  };
  const parts = [
    bakeColor(housing, color('sirenHousing')),
    lens(-1, 'sirenRedOff'),
    lens(1, 'sirenBlueOff'),
  ];
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/** Where the base sits in car-local space: on the roof, centred between the two pod anchors. */
export function sirenBaseAnchor(roofX, roofY) {
  return new THREE.Vector3(roofX, roofY, 0);
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
