import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { wheelGeometries, wheelGeometry, wheelAnchors, CHASSIS_LIFT } from './wheels.js';
import {
  lightPodGeometry, brakeLightAnchors, turnSignalAnchors, brakeLightMaterial, turnSignalMaterial,
} from './lights.js';
import { addGhostOutline } from './ghostoutline.js';

// The player's taxi. Built as its own Group rather than an instance in the traffic InstancedMesh
// because it needs to be raycast against for picking, and because it wears things the ambient cars
// do not: a roof sign in the fare's colour, and a ghost outline for when it ducks behind a tower.
//
// Its parts carried an explicit renderOrder for a while, so the car would draw over the fare's timer
// ring — which lay flat on the road around it and drew with the depth test off. That ring is gone
// (the fare's clock floats above the roof now), and with it the whole ordering dance.

const CAR_LEN = 3.4;
const CAR_W = 1.7;
const TAXI_SCALE = 1.18;

// World-space distance from the taxi origin back to the bumper — used by the tailpipe flame burst
// (main.js). Kept here rather than in flames.js so both offsets follow if the mesh ever resizes.
export const TAXI_TAILPIPE_BACK = (CAR_LEN / 2) * TAXI_SCALE;
export const TAXI_TAILPIPE_HEIGHT = 0.42 + CHASSIS_LIFT;

/**
 * World height of the rear deck — the top of the body, scaled.
 *
 * Exported because `game/parcels.js` launches the outbound box *from* it: a delivery is the load
 * leaving the car, and a flight that started at the taxi's XZ at pavement height starts under the
 * car's own sills, which reads as the box being posted out through the road rather than lifted off
 * the deck. Nothing rides here any more — see `setHighlight` below for where the load went — but the
 * height is still the point on the car a package is handled at.
 */
export const TAXI_DECK_Y = (1.18 + CHASSIS_LIFT) * TAXI_SCALE;

/**
 * Where the rear tyres meet the road, in world units off the taxi's own origin: the axle sits
 * `TAXI_REAR_AXLE_BACK` behind it and each tread `TAXI_REAR_TRACK` out to its own side.
 *
 * Exported because the boost trail comes off the wheels now — one plume per rear tyre rather than
 * one off the centreline (see `kickDust` in main.js and in the lab). Read straight off the anchors
 * the wheels are *built* at and put through the group's scale, so resizing a wheel or rescaling the
 * car takes the dust with it. The hand-typed 1.2 / 1.04 the rubber stamps at are the reason to
 * derive these: the track number stopped matching the car the day WHEEL_W doubled, and nothing said so.
 */
const REAR_ANCHOR = wheelAnchors(CAR_LEN, CAR_W).find((anchor) => !anchor.front);
export const TAXI_REAR_AXLE_BACK = -REAR_ANCHOR.x * TAXI_SCALE;
export const TAXI_REAR_TRACK = Math.abs(REAR_ANCHOR.z) * TAXI_SCALE;

/**
 * The same pair for the front tyres, and they exist for the brake.
 *
 * Everything else that marks the road comes off the driven wheels — the launch chirp, the rubber
 * through a boosted corner, the overtake's two lane changes — so the rear anchors were all anything
 * needed. Standing on the brake locks all four, and a skid that leaves two streaks reads as the car
 * still being under power; four is what says the wheels have stopped turning.
 */
const FRONT_ANCHOR = wheelAnchors(CAR_LEN, CAR_W).find((anchor) => anchor.front);
export const TAXI_FRONT_AXLE_FWD = FRONT_ANCHOR.x * TAXI_SCALE;
export const TAXI_FRONT_TRACK = Math.abs(FRONT_ANCHOR.z) * TAXI_SCALE;

export function createTaxiMesh() {
  const group = new THREE.Group();
  group.name = 'taxi';

  const parts = [];

  // Proportions match the ambient cars so the taxi reads as the same class of vehicle.
  const body = new THREE.BoxGeometry(CAR_LEN, 0.8, CAR_W);
  body.translate(0, 0.78 + CHASSIS_LIFT, 0);
  parts.push(bakeColor(body, color('taxiBody')));

  const cabin = new THREE.BoxGeometry(CAR_LEN * 0.5, 0.6, CAR_W * 0.86);
  cabin.translate(-0.2, 1.45 + CHASSIS_LIFT, 0);
  parts.push(bakeColor(cabin, color('carGlass')));



  // Chequer stripe along each flank — the one piece of livery that says "taxi" from the side, the
  // way the roof sign says it from above.
  //
  // Six cells rather than a real two-row chequerboard, and that is a zoom decision, not a stylistic
  // one. The band is 0.22 tall, which through TAXI_SCALE is ~2px at play zoom (1 unit ≈ 7.7px), so
  // splitting it into two rows would ask for a 1px row and get mush. One row of alternating cells
  // reads as chequer at this size; a chequerboard reads as a grey smear.
  //
  // Six is also what the app icon paints (tools/make-icon.mjs), so the car on the home screen and
  // the car on the road wear the same livery. At CAR_LEN * 0.82 that puts a cell at ~0.55 world
  // units ≈ 4px — the finest pitch that survives. Twelve cells (square ones, matching the band's
  // own height) measure ~2px each and alias into a flicker as the car turns.
  const STRIPE_CELLS = 6;
  const stripeLen = CAR_LEN * 0.82;
  const cellLen = stripeLen / STRIPE_CELLS;
  for (const side of [-1, 1]) {
    for (let i = 0; i < STRIPE_CELLS; i++) {
      const cell = new THREE.BoxGeometry(cellLen, 0.22, 0.06);
      cell.translate(
        -stripeLen / 2 + (i + 0.5) * cellLen,
        0.82 + CHASSIS_LIFT,
        side * (CAR_W / 2 + 0.02),
      );
      // Both colours painted, rather than letting the light cells fall through to the body: the
      // body is `taxiBody` yellow, and a yellow-and-black band is a hazard stripe, not a taxi. The
      // white is `taxiSign`, the off-white the roof sign already lights up in — the car's existing
      // white, so the livery stays a two-colour car rather than gaining a third.
      parts.push(bakeColor(cell, color(i % 2 === 0 ? 'taxiTrim' : 'taxiSign')));
    }
  }

  // Rear wheels only — the fronts steer, so they hang off the group as their own meshes below.
  parts.push(...wheelGeometries(CAR_LEN, CAR_W));

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const shell = new THREE.Mesh(merged, propMaterial());
  shell.castShadow = true;
  // ...and receives, like every ambient car — see the note over the traffic meshes in
  // sim/traffic.js for what that costs and why it is not behind a flag.
  shell.receiveShadow = true;
  // Marks this subtree as the taxi for the picker, which raycasts recursively.
  shell.userData.pickable = 'taxi';
  group.add(shell);

  // Traced outline shown only where the car is hidden behind other geometry, so the player can
  // always see where their taxi is. Every opaque part of the car wears one — shell, roof sign
  // and both steered wheels below. Not for their silhouettes alone: any taxi part left out of the
  // stencil mask counts as an *occluder* of the rim behind it, and the wheels being skipped at
  // first painted a yellow streak along the rocker panel of a fully visible car.
  addGhostOutline(shell);

  // Steered front wheels. One shared material, one mesh each, pivoting about their own hubs — the
  // group's transform carries them along, so nothing here has to know where the taxi is.
  const wheelMaterial = propMaterial();
  const steered = wheelAnchors(CAR_LEN, CAR_W)
    .filter((anchor) => anchor.front)
    .map((anchor) => {
      const wheel = new THREE.Mesh(wheelGeometry(), wheelMaterial);
      wheel.position.set(anchor.x, anchor.y, anchor.z);
      wheel.castShadow = true;
      wheel.receiveShadow = true;
      wheel.userData.pickable = 'taxi';
      // Small rim to match the part — and being in the mask is what stops the wheel occluding
      // the shell's rim (see the note above addGhostOutline(shell)). Children of the wheel, so
      // the ghost steers with it.
      addGhostOutline(wheel, { rim: 0.12 });
      group.add(wheel);
      return wheel;
    });

  // There is no selection indicator under the car any more. It was a yellow pool marking the
  // taxi as selected — but the taxi is permanently selected and there is only one of it, so the
  // pool was labelling something that was never in question, and it sat directly under the route
  // band in the same yellow, which read as the band leaking out around the car.

  // A generous invisible hit volume. The taxi is only a few units long on a fixed camera that
  // shows the whole city, so picking the visible mesh alone is a frustratingly small target.
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(5.5, 4, 5.5),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  hit.position.y = 1.4 + CHASSIS_LIFT;
  hit.userData.pickable = 'taxi';
  group.add(hit);

  // Roof sign — reads as "taxi" at this zoom, and lights up while a rider is aboard. It used to
  // carry the fare's own colour, back when colour paired a rider with their drop-off pin; now
  // that pairing is gone (the drop-off pin is fixed to Loco Mode's yellow, see marker.js), so the
  // sign only has one thing left to say and says it with on/off rather than hue.
  //
  // Centred on its own origin and hung at its spot, rather than translated into place in its
  // vertices, so it tilts about itself when the car is damaged (`damage.setSignTilt`) — a rotation,
  // like a scale, is about the mesh's origin, and one baked into the vertices would swing the sign
  // about the middle of the car. See the light pods below for the same trap with scale.
  const signGeo = new THREE.BoxGeometry(0.75, 0.34, 0.4);
  const sign = new THREE.Mesh(
    signGeo,
    // Starts dark — the taxi is empty until a fare boards.
    new THREE.MeshLambertMaterial({ color: new THREE.Color(PALETTE.taxiTrim), flatShading: true }),
  );
  sign.position.set(-0.1, 1.92 + CHASSIS_LIFT, 0);
  sign.castShadow = true;
  sign.receiveShadow = true;
  sign.userData.pickable = 'taxi';
  group.add(sign);
  // A smaller rim than the shell's: the default 0.3 on a 0.34-unit-tall sign would double it.
  addGhostOutline(sign, { rim: 0.15 });

  // **No parcel on the rear deck.** There was one — a `PARCEL_DECK_SCALE` box behind the cabin, shown
  // while a package was aboard — and it was the honest answer to "does the car have one" at a size
  // nobody could read it at: about **four pixels** at play zoom, on the object the player is steering
  // rather than looking at. The courier load is stated in the HUD instead (game/cargochip.js), which
  // is where the collected box now flies, and it is stated there at 42px.
  //
  // Two things followed from taking it off, and both are the point rather than a side effect. The car
  // says exactly one thing about what it is carrying — the roof sign, for a rider — so "am I couriering"
  // is asked of the corner rather than of a lump on the roofline that could be either. And the pickup
  // stopped being a hand-off *into a mesh*: the box no longer has to arrive somewhere on this car, so it
  // can travel from the kerb to the readout in one unbroken move.

  // Brake lights and turn signals — same geometry and materials sim/traffic.js builds its
  // InstancedMeshes from (see geometry/lights.js), just as ordinary Meshes here since the taxi is
  // one car, not a fleet. "On"/"off" is the mesh's own scale, same as an ambient car's instance —
  // see the note in traffic.js by BRAKE_LIGHT_RISE for why scale rather than a colour or opacity
  // write. Scaled to 0 rather than left out of the group entirely so setLights() below never has
  // to add or remove children.
  //
  // **One Mesh per pod, not per pair**, because that scale is about the mesh's own origin: a pair
  // merged into one geometry carries each pod's offset in its vertices, and scaling it down slides
  // both pods forward along the car and down toward the road instead of dimming them where they
  // are. Hanging each pod at its own anchor makes the anchor the pivot. See lightPodGeometry() for
  // the measurements, and note the taxi's are the *largest* in the game — TAXI_SCALE is on the
  // group above these.
  const podPair = (anchors, material) => anchors.map((anchor) => {
    // A material each rather than one shared across the pair, matching the one-material-per-mesh
    // habit the rest of this file and `propMaterial()` keep — and `markEmissive` (game/bloom.js)
    // derives a bloom material per *mesh* off the live one, so a shared live material would have
    // two meshes deriving from it.
    const pod = new THREE.Mesh(lightPodGeometry(), material());
    pod.position.copy(anchor);
    return pod;
  });
  const brakeLights = podPair(brakeLightAnchors(CAR_LEN, CAR_W), brakeLightMaterial);
  const turnLeftLight = podPair(turnSignalAnchors(CAR_LEN, CAR_W, -1), turnSignalMaterial);
  const turnRightLight = podPair(turnSignalAnchors(CAR_LEN, CAR_W, 1), turnSignalMaterial);
  const lightPods = [...brakeLights, ...turnLeftLight, ...turnRightLight];
  for (const light of lightPods) {
    light.scale.setScalar(0);
    light.userData.pickable = 'taxi';
    group.add(light);
    // Smaller than the sign's: these pods are thinner still, and the mask/rim inherit whatever
    // scale setLights() puts on the light itself, so a dark pod traces no rim at all.
    addGhostOutline(light, { rim: 0.08 });
  }

  const damage = buildDamage(group, shell, sign);

  // Slightly oversized against ambient traffic. The player has to find this car at a glance in a
  // street full of identically shaped vehicles.
  group.scale.setScalar(TAXI_SCALE);
  group.rotation.order = 'YXZ';   // so roll applies about the car's own long axis

  /** Lights the roof sign while a rider is aboard; dark (the trim's own colour) while empty. */
  let occupied = false;
  let signOut = false;
  const paintSign = () => {
    sign.material.color.set(occupied && !signOut ? PALETTE.taxiSign : PALETTE.taxiTrim);
  };
  const setOccupied = (next) => { occupied = next; paintSign(); };
  // A damaged sign sputters: the damage layer (game/taxidamage.js) drops it out for a few frames
  // at a time. Kept beside `occupied` rather than written as a colour by the caller, so a fare
  // boarding mid-flicker cannot leave the sign lit when it should be out or the other way round.
  damage.setSignOut = (out) => { if (out !== signOut) { signOut = out; paintSign(); } };

  /**
   * Light the whole car, 0..1 — the flourish that says a courier box has been accepted
   * (game/parcels.js). Driven from `main.js` off the select pop's own envelope, so an accepted package
   * reads as the same *kind* of acknowledgement a tapped rider gets.
   *
   * A white emissive lift rather than a tint, for the reason every other highlight here is one: hue on
   * this car means the taxi, and a flash may not repaint it. Every opaque part takes the lift together
   * — shell, both steered wheels and the roof sign — because a car whose body lit while its wheels
   * stayed dark reads as the paint changing rather than as the car reacting. (It was five parts while
   * a box rode the deck. The box is in the HUD now; the flourish is unchanged in what it means.)
   *
   * 0.32 rather than the rider figure's measured 0.3: the taxi's yellow is already the brightest thing
   * on the road, so it has less headroom before the chequer stripe washes into the body, and the lift
   * has to be visible against a car that is *moving* at the moment it fires.
   *
   * The stripe's white cells clip at this lift, and that is fine rather than merely tolerated: the roof
   * sign is the same `taxiSign` off-white and has taken the same lift since the flourish existed. What
   * still reads through the flash is the *dark* cells, which have the whole of the lift to climb — so
   * the chequer stays legible as chequer while the car is lit, which is the thing the headroom argument
   * above is actually protecting.
   */
  const HIGHLIGHT = 0.32;
  const litParts = [shell, sign, ...steered];
  const setHighlight = (amount) => {
    const lift = HIGHLIGHT * amount;
    for (const part of litParts) part.material.emissive.setScalar(lift);
  };

  /** Front-wheel lock, in radians. Both wheels take the same angle — at this zoom the Ackermann
   * difference between inner and outer is well under a pixel. */
  const setSteer = (angle) => {
    for (const wheel of steered) wheel.rotation.y = angle;
  };

  /**
   * Brake and turn-signal brightness, 0..1 each — straight off the same car object's own
   * brakeLevel/turnLeftLevel/turnRightLevel sim/traffic.js already computes every frame for every
   * car, taxi included, since the taxi is just another entry in the `cars` array physics runs over.
   */
  const setLights = (brakeLevel, turnLeftLevel, turnRightLevel) => {
    for (const pod of brakeLights) pod.scale.setScalar(brakeLevel);
    for (const pod of turnLeftLight) pod.scale.setScalar(turnLeftLevel);
    for (const pod of turnRightLight) pod.scale.setScalar(turnRightLevel);
  };

  return {
    group,
    sign,
    damage,
    /**
     * The six light pods — two per lamp, see the note by their construction — so `main.js` can
     * put them in the bloom (`markEmissive` in
     * game/bloom.js). Handed back rather than marked here for the reason the AO occluders are:
     * this module is built by tools too, and the draw list is module state.
     */
    lights: lightPods,
    setOccupied,
    setHighlight,
    setSteer,
    setLights,
  };
}

// --- Damage ------------------------------------------------------------------------------------
//
// What the car wears after it has been in a scrape — driven in tiers off its hit points by
// game/taxidamage.js. Everything here is sized for the camera rather than for realism: the taxi is
// about 30px long at play zoom (1 unit ≈ 7.7px through TAXI_SCALE), so scuffs and a cracked screen
// would not read at all. What does is a change of *silhouette* — a crushed corner, a sign knocked
// crooked, a boot lid up, a bumper hanging off — and those are the four pieces.
//
// Built at boot and hidden with a zero scale rather than added when needed, for the reason the light
// pods are: `markOccluder`, the cartoon outline and the ghost-outline traversal all walk this group
// once, and a part that turns up later is missed by all three. A zero scale draws nothing and needs
// no second code path. (No lights in here, so hiding by scale has none of the light-count trap.)

// Where the boot lid hinges: the rear edge of the cabin, which sits at −0.2 ± CAR_LEN/4.
const BOOT_HINGE_X = -0.2 - CAR_LEN * 0.25;
const BODY_TOP = 1.18 + CHASSIS_LIFT;
const BOOT_LEN = CAR_LEN / 2 + BOOT_HINGE_X - 0.02;
// The bumper hangs from the rear corner on the side that took the damage and drags on the road.
const BUMPER_LEN = CAR_W * 0.9;
const BUMPER_T = 0.14;
const BUMPER_Y = 0.46 + CHASSIS_LIFT;
// A dent crushes the top of one corner inward and down. Only vertices above WHEEL_TOP move: the rear
// wheels are merged into the shell, and a wheel caught in a corner's radius would be crushed with it.
// The body's own bottom edge stays put, so the crushed face slants — which is the silhouette.
//
// Sized off a look at it rather than off a number: the first cut (0.28 in, 0.13 down, three levels)
// could not be seen from a camera zoomed seven times closer than play, let alone at play zoom, where
// 0.28 of a unit is two pixels. Two levels of a deeper crush is a corner that visibly folds.
const DENT_R = 1.1;
const DENT_IN = 0.5;            // per level, toward the middle of the car along its length
const DENT_DOWN = 0.22;         // per level
const DENT_SIDE = 0.14;         // per level, toward the centreline
const DENT_DARKEN = 0.3;        // per level, toward the trim colour — crumpled metal is in shadow
const DENT_MAX = 2;
const WHEEL_TOP = 0.68 + CHASSIS_LIFT;

function buildDamage(group, shell, sign) {
  const geometry = shell.geometry;
  const position = geometry.attributes.position;
  const colour = geometry.attributes.color;
  const pristinePos = position.array.slice();
  const pristineCol = colour ? colour.array.slice() : null;
  const trim = color('taxiTrim');
  // Dent level per corner, keyed `${sx},${sz}` with each sign ±1 — sx + is the nose, sz + the right.
  const dents = new Map();

  function applyDents() {
    const pos = position.array;
    pos.set(pristinePos);
    if (pristineCol) colour.array.set(pristineCol);
    for (const [key, level] of dents) {
      if (level <= 0) continue;
      const [sx, sz] = key.split(',').map(Number);
      const cx = sx * CAR_LEN / 2;
      const cz = sz * CAR_W / 2;
      for (let v = 0; v < position.count; v++) {
        const y = pristinePos[v * 3 + 1];
        if (y < WHEEL_TOP) continue;
        const x = pristinePos[v * 3];
        const z = pristinePos[v * 3 + 2];
        // By position, not by index: the merged shell repeats shared corners, and a displacement
        // keyed on anything but where the vertex is would tear it open (CLAUDE.md).
        const w = Math.max(0, 1 - Math.hypot(x - cx, z - cz) / DENT_R);
        if (w <= 0) continue;
        const k = w * level;
        pos[v * 3] -= sx * DENT_IN * k;
        pos[v * 3 + 1] -= DENT_DOWN * k;
        pos[v * 3 + 2] -= sz * DENT_SIDE * k;
        if (pristineCol) {
          const t = Math.min(0.6, DENT_DARKEN * k);
          colour.array[v * 3] += (trim.r - colour.array[v * 3]) * t;
          colour.array[v * 3 + 1] += (trim.g - colour.array[v * 3 + 1]) * t;
          colour.array[v * 3 + 2] += (trim.b - colour.array[v * 3 + 2]) * t;
        }
      }
    }
    position.needsUpdate = true;
    if (pristineCol) colour.needsUpdate = true;
    geometry.computeBoundingSphere();
  }

  // The boot lid, on a hinge at the back of the cabin, over a dark opening that only shows when the
  // lid is up. The lid's underside sits exactly on the body's top face, and that is fine: it faces
  // down and is culled before it can fight anything (see the coplanar notes in CLAUDE.md).
  const bootHinge = new THREE.Group();
  bootHinge.position.set(BOOT_HINGE_X, BODY_TOP, 0);
  const lidGeo = new THREE.BoxGeometry(BOOT_LEN, 0.06, CAR_W * 0.94);
  lidGeo.translate(-BOOT_LEN / 2, 0.03, 0);
  const lid = new THREE.Mesh(bakeColor(lidGeo, color('taxiBody')), propMaterial());
  lid.castShadow = true;
  lid.receiveShadow = true;
  lid.userData.pickable = 'taxi';
  bootHinge.add(lid);
  const holeGeo = new THREE.BoxGeometry(BOOT_LEN * 0.9, 0.02, CAR_W * 0.82);
  holeGeo.translate(BOOT_HINGE_X - BOOT_LEN / 2, BODY_TOP + 0.01, 0);
  const hole = new THREE.Mesh(bakeColor(holeGeo, color('taxiTrim')), propMaterial());
  hole.userData.pickable = 'taxi';
  bootHinge.scale.setScalar(0);
  hole.scale.setScalar(0);
  group.add(bootHinge, hole);

  // The bumper: a dark bar hinged at one rear corner, its free end down on the tarmac. The geometry
  // runs from the hinge along −z; the other side is the same bar turned half round about the hinge,
  // which keeps the winding (a mirror by negative scale would not).
  const bumperHinge = new THREE.Group();
  bumperHinge.rotation.order = 'YXZ';
  const barGeo = new THREE.BoxGeometry(BUMPER_T, BUMPER_T, BUMPER_LEN);
  barGeo.translate(0, 0, -BUMPER_LEN / 2);
  const bar = new THREE.Mesh(bakeColor(barGeo, color('taxiTrim')), propMaterial());
  bar.castShadow = true;
  bar.userData.pickable = 'taxi';
  bumperHinge.add(bar);
  bumperHinge.scale.setScalar(0);
  group.add(bumperHinge);
  // Angle that puts the free end's underside on the road: the hinge is BUMPER_Y up.
  const droopToRoad = Math.asin(Math.min(1, (BUMPER_Y - BUMPER_T / 2) / BUMPER_LEN));
  const tipLocal = new THREE.Vector3(0, -BUMPER_T / 2, -BUMPER_LEN);

  return {
    /** Crush one corner a level further. `sx` + is the nose, `sz` + the car's right. */
    dent(sx, sz) {
      const key = `${Math.sign(sx) || 1},${Math.sign(sz) || 1}`;
      dents.set(key, Math.min(DENT_MAX, (dents.get(key) ?? 0) + 1));
      applyDents();
    },
    /** Roll and yaw on the roof sign, radians. */
    setSignTilt(roll, yaw) {
      sign.rotation.set(roll, yaw, 0);
    },
    /** The boot lid's opening angle in radians, or null to put it away altogether. */
    setBoot(angle) {
      const shown = angle != null;
      bootHinge.scale.setScalar(shown ? 1 : 0);
      hole.scale.setScalar(shown ? 1 : 0);
      if (shown) bootHinge.rotation.z = -angle;
    },
    /**
     * Hang the bumper off the rear corner on `side` (+1 right, −1 left), `lift` radians short of
     * resting on the road — or pass side 0 to put it away.
     */
    setBumper(side, lift = 0) {
      bumperHinge.scale.setScalar(side ? 1 : 0);
      if (!side) return;
      bumperHinge.position.set(-CAR_LEN / 2 - BUMPER_T / 2, BUMPER_Y, side * (CAR_W / 2 - 0.05));
      bumperHinge.rotation.set(-(droopToRoad - lift), side > 0 ? 0 : Math.PI, 0);
    },
    /** World position of the bumper's dragging end, for the sparks. Needs a current matrixWorld. */
    bumperTip(target) {
      return bar.localToWorld(target.copy(tipLocal));
    },
    /** Put everything back — a new run, or a repair. */
    reset() {
      dents.clear();
      applyDents();
      sign.rotation.set(0, 0, 0);
      bootHinge.scale.setScalar(0);
      hole.scale.setScalar(0);
      bumperHinge.scale.setScalar(0);
      this.setSignOut?.(false);
    },
  };
}
