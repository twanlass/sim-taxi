import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, unlitMaterial } from '../util/geo.js';
import { color } from '../palette.js';
import { stampGhostMask } from './ghostoutline.js';

// A light twin-skid helicopter — a Jet Ranger, in the same sense the aeroplane is a Cessna:
// everything about the silhouette that says "small helicopter" is here and nothing else is. It
// comes in over the rooftops, lands on a tower's helipad, sits with its rotor idling and leaves
// again. It is not part of the game: nothing collides with it, nothing can be tapped on it. See
// game/chopper.js for the visit itself.
//
// Nose points +X, the same convention every vehicle model in the project uses (`dirYaw` in
// city/grid.js turns a direction into the yaw that aims a +X model down it), so the flight code
// computes a heading exactly the way the traffic does.

// Scale, and it is set by the pad rather than by life. One unit is about 1.1m here (the taxi is 4
// units for a 4.5m car), so a real Jet Ranger would be a 9-unit rotor over a 12-unit machine —
// which is *wider than the roof it lands on*: a helipad is `min(cw, cd) * 0.4` on a deck that is
// rarely more than 12 units across, so the circle comes out between 2.6 and 4.8 wide. Drawn true to
// scale the thing would sit on a tower like a saucer on a teacup. At a 5.4-unit rotor it overhangs
// the circle by a little, which is what a helicopter on a pad actually looks like, and the whole
// machine still reads at the 40 pixels a tower gets at play zoom.
export const MAIN_R = 2.7;
const TAIL_R = 0.55;

const ROTOR_Y = 1.35;            // the main rotor plane, in model space
const TAIL_HUB = { x: -3.85, y: 0.85, z: 0.24 };

// The skids, and how far the model hangs below its own origin because of them. Measured off these
// two numbers rather than guessed — `tools/probe.mjs` asserts it against the built bounding box,
// and game/chopper.js parks the machine by adding it to the height of the pad's paint.
const SKID_Y = -1.0;
const SKID_H = 0.11;
export const HELI_SKID_DROP = -(SKID_Y - SKID_H / 2);

// The rotor discs. Much fainter than the plane's 0.11, and the reason is the angle: a propeller
// disc is edge-on to this camera and a main rotor is flat-on to it, so the same alpha covers eighty
// times the pixels — a 5.4-unit disc lying under a camera 33° up projects an ellipse the size of the
// roof, and at the propeller's strength it read as a grey lens laid over the block behind it.
const DISC_ALPHA = 0.05;
const TAIL_DISC_ALPHA = 0.1;

// The anti-collision beacon on the fin. Two meshes: a hard little lamp and a halo around it, which
// is what stops a 4-pixel dot from reading as a stuck vertex when it comes on.
const LAMP_R = 0.12;
const HALO_R = 0.3;
const HALO_ALPHA = 0.33;

// How much of each blade, from the tip inwards, is painted in `heliRotorTip`. A sixth is what a
// real machine wears and it holds up here: at play zoom the main rotor is a 40-pixel bar, so this
// is a 6-pixel mark at each end — enough to follow round, small enough that the blade still reads
// as one dark bar rather than a barber's pole. The tips are their own boxes butted onto the ends
// of the bar rather than laid over it: this material is transparent for the fade at both ends of a
// visit, and two coincident faces at one opacity blend to a third colour that is neither.
const TIP_FRAC = 1 / 6;

/** One axis-aligned box, coloured and placed. Most of the helicopter is one of these. */
function box(w, h, d, x, y, z, name) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  geometry.translate(x, y, z);
  return bakeColor(geometry, color(name));
}

/**
 * The paint, by livery. `civil` is the rooftop visitor's; `police` is the getaway's chopper
 * (game/policeheli.js), in the cruisers' own two colours turned round: their white cab as the
 * whole machine and their light-blue body as one broad stripe, so the thing overhead belongs to
 * the cars underneath it at a glance.
 */
const LIVERIES = {
  civil: { body: 'heliBody', bandHi: 'heliStripeOrange', bandLo: 'heliStripeGold' },
  police: { body: 'policeCab', stripe: 'policeBody' },
};

/**
 * The police stripe, as a height on the flank. The civil cheatline's 0.17 is a pinstripe, and it
 * only reads because it is two saturated colours against each other; one pastel blue on white has
 * no second colour to lean on, and at play zoom (≈7.7px a unit) 0.17 is a pixel and a bit. A first
 * pass at 0.3 still read as a pinstripe in a close-up, because the flank it is on is the shaded
 * side from this camera for most headings; 0.44 is a third of the cabin's height and reads as a
 * band. It sits under the side glazing (which starts at −0.04) so the two never share a face.
 */
const POLICE_STRIPE_H = 0.44;
const POLICE_STRIPE_Y = -0.29;

/**
 * The police machine's tail lamps, one at each tip of the horizontal stabiliser: red on its own
 * left (−Z — right is +Z, see the note at the top of the file), blue on its right, the way a
 * cruiser's bar is split. The stabiliser is 1.5 across, so its tips are at ±0.75; the lamps sit
 * just outboard of them so the boxes never cut into the octahedra.
 */
const TAIL_LAMP = { x: -3.25, y: 0.42, z: 0.82 };
const TAIL_LAMP_R = 0.16;
const TAIL_HALO_R = 0.42;

/**
 * Where the police machine's searchlight sits, in model space: under the nose, ahead of the front
 * skid struts, low enough that the beam leaves from below the body rather than through it. The
 * beam in game/policeheli.js starts here.
 */
export const SEARCHLIGHT = { x: 1.75, y: -0.78, z: 0 };

function airframe(livery = 'civil') {
  const paint = LIVERIES[livery] ?? LIVERIES.civil;
  const parts = [
    // Cabin, and the nose stepping down and in front of it. Two boxes is the whole fuselage: a
    // light helicopter is a glasshouse with an engine behind it, and the glass below does the
    // rest of the work.
    box(2.6, 1.3, 1.4, 0.5, 0, 0, paint.body),
    box(0.95, 0.9, 1.15, 2.15, -0.12, 0, paint.body),

    // Glazing, proud of the body it sits in — the same trick the taxi's chequer and the plane's
    // window band use. The windscreen is the front of the nose rather than a panel on top of it:
    // on this machine the pilot sits *in* the bubble, and putting the glass anywhere else turns
    // the silhouette into a van.
    box(0.55, 0.85, 1.2, 1.95, 0.06, 0, 'carGlass'),
    box(1.2, 0.52, 1.46, 0.75, 0.22, 0, 'carGlass'),


    // Engine deck behind the mast, and the mast itself. The hump is most of what separates a
    // helicopter from a car with a fan on it at this size.
    box(1.5, 0.5, 1.1, -0.3, 0.83, 0, paint.body),

    // Tail boom, fin and stabiliser.
    box(2.9, 0.4, 0.4, -2.45, 0.3, 0, paint.body),
    box(0.62, 1.15, 0.15, -3.72, 0.78, 0, paint.body),
    box(0.45, 0.1, 1.5, -3.25, 0.4, 0, paint.body),
  ];

  if (paint.stripe) {
    // One broad band down the cabin, carried on along the boom and capping the fin. The boom's
    // run starts where it leaves the cabin (x −0.8) and stops short of the fin, so it never
    // shares a face with either; inside the stabiliser it is buried, which is fine — nothing sees
    // a face inside a box.
    parts.push(
      box(2.5, POLICE_STRIPE_H, 1.44, 0.45, POLICE_STRIPE_Y, 0, paint.stripe),
      box(2.6, 0.2, 0.44, -2.1, 0.3, 0, paint.stripe),
      box(0.62, 0.16, 0.16, -3.72, 1.28, 0, paint.stripe),
    );
  } else {
    parts.push(
      // The cheatline. Same argument as the aeroplane's: a single-value fuselage at play zoom is
      // a smudge, and one band along the flank is what gives it a top and a bottom. Two bands
      // rather than the plane's one, occupying the same 0.17 the single band did: on a near-white
      // body the stripe is the only saturated thing on the machine, and a pair of them separated
      // by their own edge is what reads as *paint* at 40 pixels instead of as a stray line.
      box(2.5, 0.09, 1.44, 0.45, -0.30, 0, paint.bandHi),
      box(2.5, 0.08, 1.44, 0.45, -0.385, 0, paint.bandLo),
      // The fin's tip cap, carrying both bands in the same order, so the tail is painted like the
      // flank. Same 1.20–1.36 the single cap spanned.
      box(0.62, 0.09, 0.16, -3.72, 1.315, 0, paint.bandHi),
      box(0.62, 0.07, 0.16, -3.72, 1.235, 0, paint.bandLo),
    );
  }

  const mast = new THREE.CylinderGeometry(0.11, 0.13, 0.5, 6);
  mast.translate(0.1, ROTOR_Y - 0.28, 0);
  parts.push(bakeColor(mast, color('heliRotor')));

  // Skids. Two runners under the cabin on four struts, with the front of each runner kicked up —
  // that upturn is the one piece of shape on the underside that reads from a camera 33° above,
  // and without it the machine sits on two pencils.
  for (const side of [-1, 1]) {
    const z = side * 0.62;
    parts.push(box(2.5, SKID_H, 0.13, 0.35, SKID_Y, z, 'heliRotor'));
    for (const x of [1.15, -0.45]) {
      parts.push(box(0.13, 0.34, 0.12, x, -0.8, z, 'heliRotor'));
    }
    // Lifted a hair further than the rotation alone would need: turning a 0.5-long box through
    // 0.45 rad drops its leading corner 0.16, and at the runner's own height that corner — not the
    // runner — becomes the lowest point on the machine, which is the number `HELI_SKID_DROP`
    // promises and `tools/probe.mjs` measures off the built model.
    const toe = new THREE.BoxGeometry(0.5, SKID_H, 0.13);
    toe.rotateZ(0.45);
    toe.translate(1.82, SKID_Y + 0.18, z);
    parts.push(bakeColor(toe, color('heliRotor')));
  }

  // The searchlight: a dark housing slung under the nose. The lens is a separate unlit mesh (see
  // `createHelicopterMesh`), because a lamp lit by the sun is not a lamp.
  if (livery === 'police') {
    parts.push(box(0.42, 0.3, 0.42, SEARCHLIGHT.x, SEARCHLIGHT.y + 0.12, SEARCHLIGHT.z, 'heliRotor'));
    parts.push(box(0.12, 0.2, 0.12, SEARCHLIGHT.x, SEARCHLIGHT.y + 0.36, SEARCHLIGHT.z, 'heliRotor'));
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((part) => part.dispose());
  return merged;
}

/** A spinning bar and the faint disc it sweeps out — the recipe both rotors are built from. */
function rotor(radius, chord, thickness, hub, discAlpha, discSegments) {
  // The hub is merged into the blade rather than parented to it: it turns with the blade either
  // way, and one mesh is one draw call. It is painted in the rotor's own dark rather than the
  // body's — it used to be `heliBody`, which was a dark hub on a dark machine and is now a white
  // one on a white machine, and the mast it caps is `heliRotor` regardless.
  const tip = radius * TIP_FRAC;
  const parts = [
    box((radius - tip) * 2, thickness, chord, 0, 0, 0, 'heliRotor'),
    box(hub, hub * 0.7, hub, 0, 0, 0, 'heliRotor'),
    box(tip, thickness, chord, radius - tip / 2, 0, 0, 'heliRotorTip'),
    box(tip, thickness, chord, -(radius - tip / 2), 0, 0, 'heliRotorTip'),
  ];
  const geometry = mergeGeometries(parts, false);
  parts.forEach((part) => part.dispose());

  const blade = new THREE.Mesh(
    geometry,
    stampGhostMask(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent: true })),
  );
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, discSegments),
    unlitMaterial({
      color: '#FFFFFF',
      transparent: true,
      opacity: discAlpha,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  return { blade, disc };
}

/**
 * The model, as a group whose origin sits at the middle of the cabin — the flight code moves and
 * tilts this and nothing else. Landed, the group sits `HELI_SKID_DROP` above the pad's paint.
 *
 * Deliberately **not** `propMaterial()`, for the reason the aeroplane isn't either: that recipe
 * carries the screen-space AO lookup, and a mesh that receives occlusion without being in the
 * depth prepass wears the occlusion of whatever stands behind it (see the occluder rule in
 * docs/rendering.md). Behind this one is a tower and then the rest of the skyline. It cannot go
 * into the prepass either — it is transparent, for the fade at both ends of a visit. With AO off
 * the two materials are the same material anyway.
 */
export function createHelicopterMesh({ livery = 'civil' } = {}) {
  const group = new THREE.Group();
  group.name = livery === 'police' ? 'policeHelicopter' : 'helicopter';

  // Every part that writes depth stamps the ghost mask — see stampGhostMask. The rotor discs and
  // the halo write none, so the ghosts never saw them.
  const body = new THREE.Mesh(
    airframe(livery),
    stampGhostMask(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent: true })),
  );
  group.add(body);

  // The main rotor. One bar rather than a cross, exactly as the propeller is: two blades is 180°
  // of symmetry, so anything under 90° of travel a frame reads as forward rotation, and this
  // machine has to look convincing at *two* rates — spun up, and idling on the deck where the eye
  // can follow an individual blade round.
  const main = rotor(MAIN_R, 0.26, 0.06, 0.34, DISC_ALPHA, 24);
  const mainHub = new THREE.Group();
  mainHub.position.set(0.1, ROTOR_Y, 0);
  main.disc.rotation.x = -Math.PI / 2;    // CircleGeometry faces +Z; this disc lies flat
  main.disc.position.y = -0.03;
  mainHub.add(main.blade, main.disc);
  group.add(mainHub);

  // And the tail rotor, turning about the lateral axis on the right-hand side of the fin. Small
  // and fast, and the one part of the machine that says which way the torque is going.
  const tail = rotor(TAIL_R, 0.14, 0.05, 0.16, TAIL_DISC_ALPHA, 12);
  const tailHub = new THREE.Group();
  tailHub.position.set(TAIL_HUB.x, TAIL_HUB.y, TAIL_HUB.z);
  tail.blade.rotation.z = Math.PI / 2;    // the bar sweeps in the fin's plane, not along the boom
  tail.disc.position.z = 0.04;
  tailHub.add(tail.blade, tail.disc);
  group.add(tailHub);

  // The beacon on the fin tip. `MeshBasicMaterial`, so it is the one thing on the machine the sun
  // has no say over — a lamp lit by a light source is not a lamp. The halo is what makes it read
  // at the size it is actually seen at; on its own the lamp is a red pixel that could be anything.
  const lamp = new THREE.Mesh(
    new THREE.OctahedronGeometry(LAMP_R, 0),
    stampGhostMask(unlitMaterial({ color: color('heliBeacon'), transparent: true })),
  );
  const halo = new THREE.Mesh(
    new THREE.OctahedronGeometry(HALO_R, 0),
    unlitMaterial({
      color: color('heliBeacon'),
      transparent: true,
      opacity: HALO_ALPHA,
      depthWrite: false,
    }),
  );
  const beacon = new THREE.Group();
  beacon.position.set(-3.72, 1.5, 0);
  beacon.add(lamp, halo);
  beacon.visible = false;                 // it starts dark, and blinks on
  group.add(beacon);

  // The searchlight's lens, on the police machine only: unlit, so it reads as the source of the
  // beam rather than as a grey box. Scaled rather than hidden when the light is off — see
  // `setSearchlight`.
  let lens = null;
  if (livery === 'police') {
    lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.17, 0.17, 0.06, 10),
      stampGhostMask(unlitMaterial({ color: color('headlight'), transparent: true })),
    );
    lens.position.set(SEARCHLIGHT.x, SEARCHLIGHT.y - 0.04, SEARCHLIGHT.z);
    group.add(lens);
  }

  // The police tail lamps — see TAIL_LAMP. The same lamp-and-halo pair the fin beacon is, one
  // red and one blue, each its own group so the two can blink apart. `cores` is what
  // game/policeheli.js puts in the bloom: the hard lamp only, because the halo is already the
  // drawn half of the glow and a translucent shape three times the lamp's size in the emissive
  // pass is a wash rather than a light (spill is a total — see BLOOM_INTENSITY in game/bloom.js).
  // Switched by `visible` on the group, which is safe here for the reason it is not on the
  // cruiser: there is no `PointLight` under it, so nothing about the scene's light count moves.
  const tailLamps = [];
  if (livery === 'police') {
    for (const [side, name] of [[-1, 'heliBeacon'], [1, 'sirenBlue']]) {
      const core = new THREE.Mesh(
        new THREE.OctahedronGeometry(TAIL_LAMP_R, 0),
        stampGhostMask(unlitMaterial({ color: color(name), transparent: true })),
      );
      const glow = new THREE.Mesh(
        new THREE.OctahedronGeometry(TAIL_HALO_R, 0),
        unlitMaterial({ color: color(name), transparent: true, opacity: HALO_ALPHA, depthWrite: false }),
      );
      const holder = new THREE.Group();
      holder.position.set(TAIL_LAMP.x, TAIL_LAMP.y, side * TAIL_LAMP.z);
      holder.add(core, glow);
      holder.visible = false;
      group.add(holder);
      tailLamps.push({ holder, core, glow });
    }
  }

  const skin = [body.material, main.blade.material, tail.blade.material];
  let fade = 1;
  let blur = 1;
  let lit = false;
  const tailLit = [false, false];

  // Both discs are a product of the two states, so neither setter may write them alone — do it
  // that way and whichever of the pair is called second wins, which shows up as a rotor blur that
  // stops fading with the machine on exactly half the frames.
  function paintDiscs() {
    main.disc.material.opacity = DISC_ALPHA * blur * fade;
    tail.disc.material.opacity = TAIL_DISC_ALPHA * blur * fade;
    beacon.visible = lit && fade > 0.35;
    tailLamps.forEach((lampPair, i) => { lampPair.holder.visible = tailLit[i] && fade > 0.35; });
  }

  return {
    group,
    body,
    mainHub,
    tailHub,
    beacon,
    /** The police tail lamps' hard cores, red then blue, for the bloom. Empty on the civil machine. */
    tailCores: tailLamps.map((lampPair) => lampPair.core),
    /**
     * How hard the rotors are turning, 0 (stopped) to 1 (flight rpm). Only the discs read it: a
     * blur is a function of speed, and an idling rotor whose blades you can count still wearing a
     * full-strength disc is the single thing that makes a parked helicopter look like a decal.
     */
    setRotorBlur: (next) => { blur = next; paintDiscs(); },
    /** The beacon, on or off. Blinked from the flight so a frozen shot is reproducible. */
    setBeacon: (next) => { lit = next; paintDiscs(); },
    /** The police tail lamps, red and blue, each on or off. No-op on the civil machine. */
    setTailLights: (red, blue) => { tailLit[0] = red; tailLit[1] = blue; paintDiscs(); },
    /** One opacity for the whole machine — the fade in and out at the ends of a visit. */
    /** The searchlight's lens, 0 (dark) to 1 — police livery only. */
    setSearchlight: (level) => { if (lens) lens.scale.setScalar(Math.max(1e-3, level)); },
    setFade: (next) => {
      fade = next;
      for (const material of skin) material.opacity = fade;
      if (lens) lens.material.opacity = fade;
      lamp.material.opacity = fade;
      halo.material.opacity = HALO_ALPHA * fade;
      for (const { core, glow } of tailLamps) {
        core.material.opacity = fade;
        glow.material.opacity = HALO_ALPHA * fade;
      }
      paintDiscs();
    },
  };
}
