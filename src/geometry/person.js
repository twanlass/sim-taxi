import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';

// A blocky figure: a rider hailing a cab and running to it, and — same rig, different colours —
// a road worker standing in a closed street until the taxi comes at them.
//
// Scale is a deliberate lie: a person next to a 3.4-unit car should be about 1.3 units tall,
// which is two pixels at play zoom. This is a bit over 3, so the figure reads as a person.
//
// Torso + head + hair are one merged mesh sharing a single material; the four limbs are separate
// so the running animation can pivot each one at its hip or shoulder. The right arm's raised
// hail-a-cab pose was the original reason for that separation — running just made it apply to the
// other three limbs too.

const SKIN = '#E8B78C';
const HAIR = '#4A3A2E';
const LEGS = '#3C3A45';
// How far a tapped rider's figure is lit at the peak of a select pop (game/selectpop.js). A white
// emissive lift on top of the vertex colours the meshes already carry, so every part of them —
// jacket, skin, trousers — brightens together and the figure reads as *lit* rather than as
// repainted. Their own colours are how one rider is told from another on a busy board, and a tap
// must not disturb that.
//
// Measured against the figure rather than guessed: the rider is *already* pale — a light shirt over
// dark trousers — so it takes very little to send them over. At 0.45 the peak clipped them to a
// featureless white blob with the raised arm swallowed into the torso, which reads as a sprite
// failing to load. At 0.3 the shirt and trousers stay separable through the flash and the figure
// still visibly lights up, which is the whole ask.
export const HIGHLIGHT_EMISSIVE = 0.3;

// --- The robber's kit ---------------------------------------------------------
//
// A bank robbery (game/robbery.js) puts a rider in the taxi who has to read as *not an ordinary
// fare* from the moment they come down the steps. The marker over their head cannot do it — a
// robber's crystal is on the ordinary urgency scale on purpose, because the clock is the whole
// drama — so it falls to the figure.
//
// It is **additive and switchable**, not a second person. The slots in game/fares.js are pooled:
// one figure per slot, built once and handed to every fare that occupies it, so a robber cannot be
// a differently-coloured `createPerson`. Nor can the base figure be recoloured for one — its torso,
// head and hair are merged into a single mesh with the colours baked into the vertices, so tinting
// the jacket tints the face with it. Three extra boxes that start hidden sidestep both.
//
// What the three are, and why each earns its place at a figure that is ~24px tall at play zoom:
//
//   - **The mask**, which is what was asked for and does most of the work. A band right across the
//     head at eye level rather than a patch on one face: the figure yaws — it scans the street
//     while it waits and turns as it runs — so a mask on the front alone is a mask the camera sees
//     for part of a turn and loses for the rest.
//   - **A cap** over the hair, because a dark band on a head with ordinary hair over it reads at
//     this size as a shadow. Two dark courses stacked read as a disguise.
//   - **A jacket**, a box a hair larger than the torso and pulled over it. This one was added
//     after looking at the first build: a mask and a cap on a figure still wearing the board's pale
//     shirt reads as *a man in a hat*, because at 24px the torso is the largest thing on the
//     figure and it was still saying "ordinary fare" louder than the head was saying anything. It
//     has to be a box over the top rather than a repaint, because the torso, the head and the hair
//     are merged into one mesh with their colours in the vertices — tinting the jacket tints the
//     face with it.
//   - **The sleeves**, which are the one part that *is* a repaint: an arm is its own mesh in one
//     flat colour, so `material.color` multiplies it dark with nothing else on that mesh to spoil.
//     `highlight()` writes `emissive` and `setOpacity()` writes `opacity`, so neither collides.
//     The legs need nothing — they are already the board's dark trouser colour.
//   - **A sack**, hung off the left hand, which is the only part that says *why*. It swings with
//     the arm for free: it is parented to the limb, and a limb pivots at its shoulder.
const MASK = '#1A1A1E';
const CAP = '#23232A';
const JACKET = '#2B2E38';
/** What an arm's own colour is multiplied by. Dark enough to match the jacket over any `body`. */
const SLEEVE_TINT = 0.28;
const SACK = '#DDD6C0';
/** Eye level on a 0.62 head centred at 2.75. */
const MASK_Y = 2.82;
const MASK_H = 0.17;
/** Proud of the 0.62 head on both axes, so the band is never coplanar with the face it sits on. */
const MASK_W = 0.68;

const SHOULDER_Y = 2.25;
const HIP_Y = 1.15;
const LEG_LEN = 1.15;
const ARM_LEN = 1.0;

// The hair slab, hoisted out of `box()` below only so the top of the head can be exported.
const HAIR_Y = 3.14;
const HAIR_H = 0.2;

/**
 * Where a bare-headed figure tops out — anything that has to leave headroom over one measures from
 * here rather than guessing. A hard hat adds another 0.39 on top of it, and nothing needs to clear
 * that: the only figures wearing one are the road crew, who never carry a marker.
 */
export const PERSON_TOP_Y = HAIR_Y + HAIR_H / 2;

// --- Shooting around (game/hoopers.js) -----------------------------------------
//
// The two poses a player on the basketball court is in, written as pure functions of their phase so
// the ball can be put *in the hands that are holding it*: game/hoopers.js asks `handAt` where a
// hand is for the same angles the rig is wearing, rather than keeping a second copy of the arm's
// geometry that would drift from this one.

/** Where the right shoulder is; the left is its mirror in x. */
const SHOULDER_X = 0.72;

/**
 * Where a hand ends up, in the figure's own frame (+Z forward), for an arm at `rx` about X and `rz`
 * about Z. `side` is +1 for the right arm and −1 for the left, whose Z angle is mirrored with it.
 * Three's default 'XYZ' order applies Z to the arm first, then X — which is the order this unrolls.
 */
export function handAt(rx, rz, side, out = { x: 0, y: 0, z: 0 }) {
  const sz = Math.sin(rz * side);
  const cz = Math.cos(rz * side);
  out.x = side * SHOULDER_X + ARM_LEN * sz;
  out.y = SHOULDER_Y - ARM_LEN * cz * Math.cos(rx);
  out.z = -ARM_LEN * cz * Math.sin(rx);
  return out;
}

/**
 * The dribble, at `bounce` 0..1 through one bounce (0 and 1 are the ball at the top, in the hand).
 * The right hand pushes down as the ball leaves it and comes back up to meet it — the arm and the
 * ball are one cycle, so they cannot drift apart.
 */
export function dribblePose(bounce) {
  return { rx: -0.55 - 0.3 * Math.cos(bounce * Math.PI * 2), rz: 0.15 };
}

/** Where the ball is in the figure's frame on a dribble: off the right hand, in front of the feet. */
export function dribbleBall(bounce, radius, out = { x: 0, y: 0, z: 0 }) {
  const top = 1.32;
  out.x = 0.86;
  out.y = radius + (top - radius) * Math.abs(Math.cos(bounce * Math.PI));
  out.z = 0.72;
  return out;
}

/** The phases of a jump shot, as fractions of it: the gather, the jump, and the release at its top. */
export const SHOT_GATHER = 0.35;
export const SHOT_JUMP_END = 0.65;
export const SHOT_RELEASE = 0.5;
const SHOT_HOP = 0.55;

/**
 * The jump shot, at `k` 0..1 across the whole action: both arms come up from the dribble to a set
 * point over the forehead while the figure dips, then it jumps and the arms extend, and the ball
 * leaves at the top (`SHOT_RELEASE`). The arms hold their follow-through after landing and drop.
 * `lift` is the body's height off the ground.
 */
export function shotPose(k) {
  const ease = (t) => t * t * (3 - 2 * t);
  let rx;
  let lift;
  if (k < SHOT_GATHER) {
    const t = ease(k / SHOT_GATHER);
    rx = -0.6 - 1.7 * t;
    lift = -0.15 * t;
  } else if (k < SHOT_JUMP_END) {
    const t = (k - SHOT_GATHER) / (SHOT_JUMP_END - SHOT_GATHER);
    rx = -2.3 - 0.6 * ease(Math.min(1, t * 1.6));
    lift = Math.sin(t * Math.PI) * SHOT_HOP;
  } else {
    const t = (k - SHOT_JUMP_END) / (1 - SHOT_JUMP_END);
    rx = -2.9 + 2.4 * ease(Math.max(0, (t - 0.35) / 0.65));
    lift = 0;
  }
  // Hands drawn in toward each other so the ball sits between them rather than in the air between
  // two arms held shoulder-width apart.
  return { rx, rz: -0.42, lift };
}

/**
 * @param body  torso and arm colour
 * @param legs  trouser colour
 * @param hair  the slab on top of the head
 * @param hat   if given, a hard hat in this colour on top of the hair — brim and crown
 * @param pickable  the `userData.pickable` kind, or null for a figure that is scenery. The picker
 *                  works off an explicit target list (`fares.pickables()`), so a road worker is
 *                  unreachable either way — but a figure tagged as a passenger it can never be is
 *                  a trap laid for whoever next raycasts the scene rather than a list.
 */
export function createPerson({
  body = PALETTE.passenger, legs = LEGS, hair = HAIR, hat = null, pickable = 'passenger',
} = {}) {
  const group = new THREE.Group();

  // Torso + head + hair: merged, since none of them articulate.
  const bodyParts = [];
  const box = (w, h, d, x, y, z, col) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(x, y, z);
    bodyParts.push(bakeColor(geo, new THREE.Color(col)));
  };
  box(1.0, 1.3, 0.6, 0, 1.8, 0, body);          // torso
  box(0.62, 0.62, 0.62, 0, 2.75, 0, SKIN);      // head
  box(0.68, HAIR_H, 0.68, 0, HAIR_Y, 0, hair);  // hair
  if (hat) {
    // Brim first, then crown. Both wider than the head so the hat reads as *worn* rather than as
    // a second head — at play zoom the silhouette is the only thing carrying it.
    box(0.86, 0.09, 0.86, 0, 3.29, 0, hat);
    box(0.56, 0.3, 0.56, 0, 3.48, 0, hat);
  }

  const merged = mergeGeometries(bodyParts, false);
  bodyParts.forEach((p) => p.dispose());
  const torso = new THREE.Mesh(merged, propMaterial());
  torso.castShadow = true;
  if (pickable) torso.userData.pickable = pickable;
  group.add(torso);

  // Each limb hangs *below* its own origin, so the mesh pivots at the top (hip or shoulder) when
  // rotated. Same trick the old right arm used for its hail-a-cab swing; the other three now share
  // it so a running cycle can move them.
  const limb = (w, h, d, hexCol, x, y) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(0, -h / 2, 0);
    const mesh = new THREE.Mesh(bakeColor(geo, new THREE.Color(hexCol)), propMaterial());
    mesh.castShadow = true;
    if (pickable) mesh.userData.pickable = pickable;
    mesh.position.set(x, y, 0);
    group.add(mesh);
    return mesh;
  };

  const legL = limb(0.34, LEG_LEN, 0.34, legs, -0.26, HIP_Y);
  const legR = limb(0.34, LEG_LEN, 0.34, legs, 0.26, HIP_Y);
  const armL = limb(0.26, ARM_LEN, 0.26, body, -0.72, SHOULDER_Y);
  const armR = limb(0.26, ARM_LEN, 0.26, body, 0.72, SHOULDER_Y);

  // --- The robber's kit, built hidden --------------------------------------
  //
  // Built for every figure rather than only the ones that will wear it, and that is the cheaper
  // answer rather than the lazy one: three boxes is 36 triangles against a figure that is already
  // several hundred, and building them on demand would mean allocating geometry on the frame a
  // robbery fires. `visible = false` costs nothing — three skips a hidden mesh before it reaches
  // the render list.
  //
  // The mask and the cap hang off `group` rather than off the torso mesh, since neither the head
  // nor the hair articulates and `group` is what the animations yaw and lean. The sack hangs off
  // the left arm, whose origin is its own shoulder — so `-ARM_LEN` is the hand.
  const kit = (w, h, d, x, y, z, col, parent) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(x, y, z);
    const mesh = new THREE.Mesh(bakeColor(geo, new THREE.Color(col)), propMaterial());
    mesh.castShadow = true;
    // Deliberately *not* tagged `pickable`. The mask is the widest thing on the head and a raycast
    // that found it instead of the torso would report a hit on a mesh no fare owns.
    mesh.visible = false;
    parent.add(mesh);
    return mesh;
  };
  const mask = kit(MASK_W, MASK_H, MASK_W, 0, MASK_Y, 0, MASK, group);
  const cap = kit(0.72, 0.26, 0.72, 0, HAIR_Y + 0.05, 0, CAP, group);
  // Over the torso, which is 1.0 x 1.3 x 0.6 at y 1.8. Proud on all three axes so no face of it is
  // ever coplanar with the one underneath — two surfaces on one plane is the tie this project has
  // been bitten by before, and a jacket that z-fought with the shirt it covers would flicker on
  // exactly the figure the player is being asked to look at.
  const jacket = kit(1.07, 1.37, 0.67, 0, 1.8, 0, JACKET, group);
  // A swag sack: a fat cube at the end of the arm with a pinched neck above it, so the silhouette
  // is a bag being carried rather than a brick being held. Pale, because it is the one part of the
  // kit that is *not* dark — against a black mask, a black cap and a black jacket, a dark bag is
  // invisible and the figure has nothing saying what it just did.
  const sackBag = kit(0.52, 0.50, 0.46, 0, -ARM_LEN - 0.22, 0.08, SACK, armL);
  const sackNeck = kit(0.20, 0.18, 0.20, 0, -ARM_LEN + 0.04, 0.08, SACK, armL);
  const robberKit = [mask, cap, jacket, sackBag, sackNeck];

  /**
   * One frame of the run cycle, returning the body bob that goes with it.
   *
   * The three animations that run — boarding, exiting, and a worker getting out of the taxi's way
   * — differ only in where they run *to*, so the cadence itself lives here. It was copied
   * verbatim between board() and exit() before there was a third caller to keep in step.
   */
  function runCycle(cadence) {
    const legSwing = Math.sin(cadence) * 0.95;
    const armSwing = Math.sin(cadence) * 0.7;

    // Legs and arms cycle in opposition; opposite arm to opposite leg.
    legL.rotation.set(legSwing, 0, 0);
    legR.rotation.set(-legSwing, 0, 0);
    armL.rotation.set(-armSwing, 0, 0);
    armR.rotation.set(armSwing, 0, 0);

    // Slight forward lean, so the run has weight.
    group.rotation.x = -0.22;
    return Math.abs(Math.sin(cadence)) * 0.18;
  }

  // Every mesh on the figure carries its own material (torso + four limbs), so the exit fade can
  // dim all of them together. Collected up front rather than walked from `group.children` on every
  // frame — the set is fixed for the lifetime of the person.
  const meshes = [torso, legL, legR, armL, armR, ...robberKit];

  /**
   * Set the whole figure's opacity. `1` returns the meshes to opaque (no blend cost).
   *
   * `material.transparent` and `depthWrite` are shader-define switches — flipping them at
   * runtime does nothing until `needsUpdate` triggers a program recompile. The old version
   * changed `opacity` but the material stayed opaque, so the rider never faded and popped off
   * when `visible` finally flipped. Track the last-set flag to only invalidate on transitions.
   */
  function setOpacity(a) {
    for (const mesh of meshes) {
      const opaque = a >= 1;
      const wasTransparent = mesh.material.transparent;
      if (opaque === wasTransparent) {
        mesh.material.transparent = !opaque;
        mesh.material.depthWrite = opaque;
        mesh.material.needsUpdate = true;
      }
      mesh.material.opacity = a;
    }
  }

  /**
   * Light the whole figure, 0..1 — the colour half of the select pop.
   *
   * A shared white emissive rather than a tint per mesh: five materials writing five different
   * colours is five things to keep in step, and the flash is over in a third of a second. `0` puts
   * the emissive back to black, which is what every figure that is not being tapped sits at.
   */
  function highlight(amount) {
    const lift = HIGHLIGHT_EMISSIVE * amount;
    for (const mesh of meshes) mesh.material.emissive.setScalar(lift);
  }

  /** Zero every articulated joint and undo any pose the boarding pass left behind. */
  function rest() {
    legL.rotation.set(0, 0, 0);
    legR.rotation.set(0, 0, 0);
    armL.rotation.set(0, 0, 0);
    armR.rotation.set(0, 0, 0);
    group.position.set(0, 0, 0);
    group.rotation.set(0, 0, 0);
    group.scale.setScalar(1);
    group.visible = true;
    setOpacity(1);
    // Slot reuse: a rider tapped in the last third of a second of their life would otherwise hand
    // the next figure on this rig a flash nobody asked for.
    highlight(0);
  }

  /**
   * Wear the mask, the cap and the sack — or take them off again.
   *
   * Deliberately **not** reset by `rest()`, unlike every other piece of pooled state on this rig.
   * `rest()` runs mid-fare (a robber is rested on the frame they appear, and again when they get
   * out at the far end) and a kit that came off there would take the mask off the figure halfway
   * through its own event. What owns it is the spawn: `game/fares.js` sets it true in
   * `spawnRobber` and false for every ordinary rider in `spawnFare`, which is the one place a slot
   * changes hands.
   */
  function setRobber(on) {
    for (const mesh of robberKit) mesh.visible = on;
    // The sleeves. A tint rather than a fifth box: an arm is one mesh in one flat colour, so
    // multiplying it is exact and costs nothing, and it keeps the jacket's own colour reading as
    // the *same* garment whatever `body` this figure was built with.
    const sleeve = on ? SLEEVE_TINT : 1;
    armL.material.color.setScalar(sleeve);
    armR.material.color.setScalar(sleeve);
  }

  /**
   * Hailing: right arm up and swinging, feet planted.
   *
   * Replaces an earlier hop-in-place. Bouncing read as impatience or idling; a raised, waving arm
   * says specifically "I want that taxi", which is the one thing the figure exists to communicate.
   */
  function wave(t) {
    // Left arm and legs stay at rest; the whole point of the wave is that only the raised right
    // arm moves. Reset them so boarding → waiting on a slot reuse doesn't leave a running pose.
    legL.rotation.set(0, 0, 0);
    legR.rotation.set(0, 0, 0);
    armL.rotation.set(0, 0, 0);
    group.position.set(0, 0, 0);
    group.rotation.x = 0;
    group.scale.setScalar(1);

    armR.rotation.set(0, 0, 2.15 + Math.sin(t * 7) * 0.3);
    group.rotation.y = Math.sin(t * 0.9) * 0.25;   // slight turn, as if scanning for a cab
  }

  /**
   * Boarding: run from the kerb to the taxi's open door and hop in through it.
   *
   * `t` is 0..1 across the whole animation. `dx`/`dz` are the horizontal offset from the rider's
   * starting world position to where the run ends — just outside the door (`taxiDoorPoint` in
   * geometry/taxi.js) — and `inX`/`inZ` to where the hop lands, just inside it. The character's
   * local +Z is treated as forward — leg swing on `rotation.x` moves them along that axis, so the
   * group is yawed to point +Z at where they are headed and the limbs cycle in body-local space.
   *
   * It used to run at the middle of the car and leap over the roof (a 1.6 arc with a 15% overshoot),
   * which stopped making sense the day the cab grew a door: the figure has to go in where the door
   * is open, and through a door is a low hop, not a vault.
   */
  function board(t, dx, dz, inX, inZ) {
    const RUN_END = 0.7;
    const running = t < RUN_END;

    if (running) {
      // Face the door. atan2(dx, dz) so (dx=0, dz=+1) → yaw 0, i.e. local +Z aligns with it.
      group.rotation.y = Math.atan2(dx, dz);
      const stride = t / RUN_END;
      // Fast cadence — this is a sprint from a standing wave, not a stroll.
      const bob = runCycle(t * 22);
      group.position.set(dx * stride, bob, dz * stride);
    } else {
      const jump = (t - RUN_END) / (1 - RUN_END);
      // Turned square to the opening for the hop, whatever angle the run came in at.
      group.rotation.y = Math.atan2(inX - dx, inZ - dz);
      // A low hop over the sill: the door's bottom edge is ~0.6 up through TAXI_SCALE.
      const arcY = Math.sin(jump * Math.PI) * 0.5 + jump * 0.5;

      // Tuck: knees pulled up, arms swung back for a hop-in.
      legL.rotation.set(-1.35, 0, 0);
      legR.rotation.set(-1.35, 0, 0);
      armL.rotation.set(0.6, 0, 0);
      armR.rotation.set(0.6, 0, 0);
      group.rotation.x = -0.4;
      group.position.set(dx + (inX - dx) * jump, arcY, dz + (inZ - dz) * jump);

      // Shrink toward vanish as they duck into the cabin — a scale-down + hop reads as "in".
      group.scale.setScalar(1 - jump * 0.7);
    }
  }

  /**
   * Exiting: hop out of the taxi, run to the kerb, then fade out.
   *
   * The mirror of `board`. `t` is 0..1 across the whole animation. `dx`/`dz` are the horizontal
   * offset from the rider's local origin (parked at the kerb corner) to the taxi they climb out of,
   * so at `t = 0` the figure is on top of the car and at the run's end they are back at the origin.
   */
  function exit(t, dx, dz) {
    const HOP_END = 0.25;      // brief arc out of the cabin onto the road
    const RUN_END = 0.75;      // sprint from the taxi to the kerb
    // Face away from the taxi — the person walks toward the kerb origin, so local +Z is (-dx,-dz).
    group.rotation.y = Math.atan2(-dx, -dz);

    if (t < HOP_END) {
      // The over-the-roof hop `board` used to make, played backwards: `jump` runs 1→0, so the slide
      // goes 1.15→1.0, the arc comes from 0.9 back down through the sine to 0, the tuck relaxes and
      // the scale goes 0.3→1.0. Boarding goes in through the door now; getting out still comes off
      // the roof, as there is no door swing on the way out.
      const jump = 1 - t / HOP_END;
      const slide = 1 + 0.15 * jump;
      const arcY = Math.sin(jump * Math.PI) * 1.6 + jump * 0.9;
      legL.rotation.set(-1.35 * jump, 0, 0);
      legR.rotation.set(-1.35 * jump, 0, 0);
      armL.rotation.set(0.6 * jump, 0, 0);
      armR.rotation.set(0.6 * jump, 0, 0);
      group.rotation.x = -0.4 * jump;
      group.position.set(dx * slide, arcY, dz * slide);
      group.scale.setScalar(1 - jump * 0.7);
      setOpacity(1);
    } else if (t < RUN_END) {
      // Straight sprint from the car back to the kerb, cycling arms and legs in opposition — same
      // shape as board(), just running the position from (dx, dz) → (0, 0) instead of the reverse.
      const stride = 1 - (t - HOP_END) / (RUN_END - HOP_END);
      const bob = runCycle(t * 22);
      group.position.set(dx * stride, bob, dz * stride);
      group.scale.setScalar(1);
      setOpacity(1);
    } else {
      // On the kerb, settling out of the run and fading. Opacity does the vanish, not scale — a
      // shrink here would read as sinking into the pavement, but a fade reads as "on their way".
      const fade = (t - RUN_END) / (1 - RUN_END);
      legL.rotation.set(0, 0, 0);
      legR.rotation.set(0, 0, 0);
      armL.rotation.set(0, 0, 0);
      armR.rotation.set(0, 0, 0);
      group.rotation.x = 0;
      group.position.set(0, 0, 0);
      group.scale.setScalar(1);
      setOpacity(Math.max(0, 1 - fade));
    }
  }

  /**
   * Bailing: out of the cab (or off the kerb), and gone.
   *
   * A VIP whose clock runs out does not get delivered and does not end the run — they leave, which
   * is the only way the player finds out it happened (see `beginBail` in game/fares.js). `t` is
   * 0..1 across the whole animation; `dx`/`dz` are where they run *to*, relative to wherever they
   * were standing when the clock hit zero.
   *
   * The hop is `exit`'s, played from the same tuck so a rider leaving a moving taxi looks like a
   * rider leaving a taxi however they came to be doing it. Everything after it is different on
   * purpose: no settling at the kerb and no turning back, a quicker cadence than a delivered
   * rider's, and the run carries on *through* the fade — a delivered fare arrives somewhere, and
   * this one is only leaving.
   */
  function bail(t, dx, dz) {
    const HOP_END = 0.22;
    const FADE_FROM = 0.72;
    group.rotation.y = Math.atan2(dx, dz);

    if (t < HOP_END) {
      // `exit`'s hop verbatim, minus the slide: they land on the spot rather than short of it,
      // because the spot is the middle of the road and there is nothing to land beside.
      const jump = 1 - t / HOP_END;
      legL.rotation.set(-1.35 * jump, 0, 0);
      legR.rotation.set(-1.35 * jump, 0, 0);
      armL.rotation.set(0.6 * jump, 0, 0);
      armR.rotation.set(0.6 * jump, 0, 0);
      group.rotation.x = -0.4 * jump;
      group.position.set(0, Math.sin(jump * Math.PI) * 1.6 + jump * 0.9, 0);
      group.scale.setScalar(1 - jump * 0.7);
      setOpacity(1);
      return;
    }

    // One straight sprint from there to the end, fading over the last stretch of it rather than
    // stopping to fade. The stride runs a little past 1 so the last visible frame is still moving.
    const stride = (t - HOP_END) / (1 - HOP_END) * 1.12;
    // 26 against the boarding sprint's 22: this is the one run in the game that is a storm-off.
    const bob = runCycle(t * 26);
    group.position.set(dx * stride, bob, dz * stride);
    group.scale.setScalar(1);
    setOpacity(t < FADE_FROM ? 1 : Math.max(0, 1 - (t - FADE_FROM) / (1 - FADE_FROM)));
  }

  /**
   * Standing about on a job: a slow weight shift and one arm working.
   *
   * Deliberately low-frequency. A crew that read as *busy* would compete with the traffic for the
   * player's attention, and this is scenery — the thing that has to carry is the orange, not the
   * animation. `phase` offsets one worker from the next so a pair doesn't sway in lockstep, the
   * same reason every ambient car carries its own bob phase.
   */
  function idle(t, phase = 0) {
    const s = t * 0.8 + phase;
    legL.rotation.set(0, 0, 0);
    legR.rotation.set(0, 0, 0);
    // The working arm swings around a raised rest position rather than through vertical, so it
    // reads as holding something. Straight through vertical is the hail wave, which means
    // "I want that taxi" — the one thing a worker must not be saying.
    armR.rotation.set(-0.5 + Math.sin(s * 2.1) * 0.3, 0, 0.22);
    armL.rotation.set(0, 0, -0.1);
    group.rotation.x = 0;
    group.rotation.y = Math.sin(s * 0.55) * 0.35;
    group.position.set(0, Math.sin(s * 1.3) * 0.03, 0);
    group.scale.setScalar(1);
  }

  /**
   * Getting out of the way: sprint from where they were standing to (dx, dz), then stand there
   * looking back at the road they just left.
   *
   * `t` runs 0..1 and does not loop — a worker who has moved has moved. The turn to look back is
   * why the standing pose is here rather than being `rest()`: `rest()` puts the figure back at
   * its origin, which is the spot they just ran off.
   */
  function flee(t, dx, dz) {
    const RUN_END = 0.8;
    if (t < RUN_END) {
      group.rotation.y = Math.atan2(dx, dz);
      const stride = t / RUN_END;
      // A shade faster than a rider's cadence. They are not catching a cab, they are being missed.
      const bob = runCycle(t * 25);
      group.position.set(dx * stride, bob, dz * stride);
    } else {
      const settle = Math.min(1, (t - RUN_END) / (1 - RUN_END));
      legL.rotation.set(0, 0, 0);
      legR.rotation.set(0, 0, 0);
      armL.rotation.set(0, 0, -0.35);
      armR.rotation.set(0, 0, 0.35);   // hands out, the universal "what was that"
      group.rotation.x = -0.22 * (1 - settle);
      group.rotation.y = Math.atan2(dx, dz) + Math.PI * settle;
      group.position.set(dx, 0, dz);
    }
    group.scale.setScalar(1);
  }

  /**
   * Hands up: the robber on the kerb at the drop-off, with the police circling (game/arrest.js).
   *
   * `dx`/`dz` is what to face — the middle of the junction the cars are going round — and `t` is
   * seconds, for a nervous shuffle: the body turns a little after whichever way the noise is
   * coming from and the raised arms tremble. Both arms go straight up past the head; the sack
   * stays in the left hand, because a bag held up over a mask is the whole joke of the pose.
   */
  function surrender(t, dx, dz) {
    legL.rotation.set(0, 0, 0);
    legR.rotation.set(0, 0, 0);
    armR.rotation.set(0, 0, 2.75 + Math.sin(t * 13) * 0.06);
    armL.rotation.set(0, 0, -2.75 - Math.sin(t * 11 + 1) * 0.06);
    group.rotation.x = 0;
    group.rotation.y = Math.atan2(dx, dz) + Math.sin(t * 1.7) * 0.45;
    group.position.set(0, Math.abs(Math.sin(t * 5)) * 0.04, 0);
    group.scale.setScalar(1);
    setOpacity(1);
  }

  /**
   * The dribble, standing or on the move. `bounce` is the ball's phase (see `dribblePose`) and
   * `cadence` the jog's, or null for dribbling on the spot. The legs jog at half the run's swing:
   * this is a player working the ball round the key, not a rider sprinting for a cab.
   */
  function dribble(bounce, cadence = null) {
    const arm = dribblePose(bounce);
    armR.rotation.set(arm.rx, 0, arm.rz);
    if (cadence === null) {
      legL.rotation.set(0, 0, 0);
      legR.rotation.set(0, 0, 0);
      armL.rotation.set(-0.3, 0, -0.18);
      group.rotation.x = -0.08;
      group.position.set(0, 0, 0);
    } else {
      const swing = Math.sin(cadence);
      legL.rotation.set(swing * 0.6, 0, 0);
      legR.rotation.set(-swing * 0.6, 0, 0);
      armL.rotation.set(-0.3 - swing * 0.4, 0, -0.18);
      group.rotation.x = -0.14;
      group.position.set(0, Math.abs(swing) * 0.09, 0);
    }
    group.rotation.y = 0;
    group.scale.setScalar(1);
  }

  /** The jump shot at `k` 0..1 — see `shotPose`. */
  function shoot(k) {
    const pose = shotPose(k);
    armR.rotation.set(pose.rx, 0, pose.rz);
    armL.rotation.set(pose.rx, 0, -pose.rz);
    // Toes pointed through the air, feet planted either side of it.
    const air = k > SHOT_GATHER && k < SHOT_JUMP_END ? 0.25 : 0;
    legL.rotation.set(air, 0, 0);
    legR.rotation.set(air, 0, 0);
    group.rotation.x = 0;
    group.rotation.y = 0;
    group.position.set(0, pose.lift, 0);
    group.scale.setScalar(1);
  }

  /** Off after a loose ball: the run cycle, a shade slower than a rider's sprint. */
  function chase(cadence) {
    group.position.set(0, runCycle(cadence), 0);
    group.rotation.y = 0;
    group.scale.setScalar(1);
  }

  /** Standing, watching the shot: arms down, a little weight on the toes. */
  function watch(t) {
    legL.rotation.set(0, 0, 0);
    legR.rotation.set(0, 0, 0);
    armL.rotation.set(-0.15, 0, -0.12);
    armR.rotation.set(-0.15, 0, 0.12);
    group.rotation.x = 0;
    group.rotation.y = 0;
    group.position.set(0, Math.abs(Math.sin(t * 6)) * 0.03, 0);
    group.scale.setScalar(1);
  }

  rest();
  wave(0);
  return {
    group, wave, board, exit, bail, rest, idle, flee, surrender, highlight, setRobber,
    dribble, shoot, chase, watch,
  };
}
