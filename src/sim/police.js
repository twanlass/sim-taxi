import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { propMaterial, BODY_EULER_ORDER, FINISH, countInEveryPass } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { SILL_Y } from '../geometry/wheels.js';
import {
  sirenOn, patrolSwing, sirenPodGeometry, sirenRedAnchor, sirenBlueAnchor, sirenBaseGeometry, sirenBaseAnchor,
  sirenRedMaterial, sirenBlueMaterial,
} from '../geometry/lights.js';
import {
  wheelAnchors, wheelGeometry, CHASSIS_LIFT,
  carGeometry, policeCabGeometry, CAR_LEN, CAR_W, CABIN_X, CABIN_TOP, SPEED,
} from './traffic.js';

// The patrol cruiser's *look*: its body, its light bar and the two real lamps on it.
//
// Where it drives is not this module's business any more. The cruiser used to be a scripted car on
// a rail that crossed town with its siren going and every light on its road held green for it — and
// then, when the taxi boosted near it, broke off and ran the taxi down. Reported as the thing that
// read wrong about it: a cop car blitzing through town with its lights on from the moment it
// appears is not a patrol, and a cop that is always in pursuit mode has nothing to *change* when it
// spots you.
//
// So the cruiser is an ordinary car in traffic now, for the whole of its patrol — the same kind of
// car a bank robbery brings (see "Cop cars in ambient traffic" in docs/traffic.md). It queues, stops
// at reds and can be rammed, and its bar swings gently red and blue until the taxi boosts near it,
// when it strobes hard. The swing is the telegraph — see `setBar`.
// game/patrol.js owns the car: when it comes onto the map, where it goes, when it gives chase and
// how the chase ends. What this module does is **wear** that car: the traffic model poses it
// through `car.skin`, and this draws the cruiser's own mesh there instead of the instance. It is the
// *same car* the robbery's fleet drives — the ambient body in the police two-tone under the white
// `policeCabGeometry()`, with the same siren bar (geometry/lights.js) — so the city has one police
// livery.
//
// What the instance cannot do is the reason this is a real mesh at all: the lamps. A lit bar washes
// red and blue across the road and the fronts of buildings as it passes, and a pod on an instanced
// car cannot. See `lightBar`.

// Boosting inside this radius of the patrol car is what sets it after you — reckless driving in
// front of a cop. One block in world units (PITCH = 20 in src/city/grid.js): the taxi and the
// cruiser have to be sharing a junction, so it reads as being caught in the act rather than spotted
// from a street over. It used to end the run on the spot; it starts a chase now (game/patrol.js).
export const SPOT_RANGE = 20;

/**
 * How long the cruiser takes to fade in as it comes onto the map and out as it leaves it, in seconds.
 * It enters and leaves at the edge of the island (game/patrol.js), and a car that appears there at
 * full strength reads as popping into existence; a dissolve over about a car length of driving reads
 * as it coming in from off the map.
 */
export const FADE_TIME = 0.8;

/**
 * The drive off the island (`release`): what it pulls away at, in u/s², and the speed it settles
 * at — the ambient cruise, so nothing about the car changes as it leaves the traffic model. It is
 * often released from a standstill (the ring is give-way, so it waits at its line first), and at
 * 4 u/s² it covers the ~16 units from the line to the slab's edge in under three seconds.
 */
const LOOSE_ACCEL = 4;
const LOOSE_SPEED = SPEED;

/**
 * The patrol lamps' peak, against the hunting strobe's 130: about half, so the wash says a cop is
 * about without the road going the colour of a chase.
 */
const PATROL_LAMP = 70;

/**
 * An ambient car, painted. `carGeometry()` bakes its body white and its glass dark so the fleet's
 * `instanceColor` can tint it; this is that same multiply done once into the vertex colours, so the
 * cruiser and a cop car in the fleet come out the same colour on every part, glass and tyres
 * included — all but the metal, which the fleet's shader keeps the tint off (util/geo.js), so the
 * bumpers and hubcaps are skipped here to match. The cab shell the fleet draws as a second instanced mesh is merged in here — it is never
 * switched separately from the body on a car there is only one of.
 */
function policeGeometry() {
  const car = carGeometry();
  const tint = color('policeBody');
  const colors = car.attributes.color;
  const finish = car.attributes.aFinish;
  for (let i = 0; i < colors.count; i++) {
    if (finish.getX(i) === FINISH.METAL) continue;
    colors.setXYZ(i, colors.getX(i) * tint.r, colors.getY(i) * tint.g, colors.getZ(i) * tint.b);
  }
  const cab = policeCabGeometry();
  const merged = mergeGeometries([car, cab], false);
  car.dispose();
  cab.dispose();
  return merged;
}

/** The steered front pair, added to `group` and handed back so the skin can turn them. */
function steeredWheels(group) {
  // Tinted on the material because `wheelGeometry()` is shared and baked neutral — the fleet tints
  // its front wheels with the same instance colour as the body, so the cruiser does too.
  const geometry = wheelGeometry();
  const material = propMaterial({ gloss: { geometry } });
  material.color.set(PALETTE.policeBody);
  return wheelAnchors(CAR_LEN, CAR_W)
    .filter((anchor) => anchor.front)
    .map((anchor) => {
      const wheel = new THREE.Mesh(geometry, material);
      wheel.position.set(anchor.x, anchor.y, anchor.z);
      wheel.castShadow = true;
      wheel.receiveShadow = true;
      group.add(wheel);
      return wheel;
    });
}

function lightBar(shell, carrier) {
  // One lamp per colour, red over the left lens and blue over the right — the same bar the
  // robbery's cop cars wear (see `sirenRedAnchor`). Switched by `visible`, never by a scale.
  const make = (material, at) => {
    const mesh = new THREE.Mesh(sirenPodGeometry(), material);
    mesh.position.copy(at);
    shell.add(mesh);
    return mesh;
  };

  // ...and the bar as it stands unlit — the housing and its red and blue lenses — which the lit pods
  // enclose. Always shown while the cruiser is, so a cruiser driving off with its bar dark still
  // reads as police.
  const housing = new THREE.Mesh(sirenBaseGeometry(), propMaterial());
  housing.position.copy(sirenBaseAnchor(CABIN_X, CABIN_TOP));
  housing.receiveShadow = true;
  shell.add(housing);

  // Actual lights, not just glowing boxes. The bar alone is a couple of pixels; what sells a
  // siren is the colour washing across the tarmac and the fronts of nearby buildings as it goes
  // past. No shadows — these are cheap fill, and shadow-casting point lights are not.
  //
  // Hung on `carrier` rather than on the shell, and that is a **performance** decision, not a
  // cosmetic one — see the shell's own comment in `createPolice`. Three counts the lights in the
  // scene by walking the *visible* graph, so a lamp under a hidden parent is not merely dark, it
  // is absent: `numPointLights` drops to zero and every lit program in the city is rebuilt.
  const lamp = (hex, z) => {
    const light = new THREE.PointLight(new THREE.Color(hex), 0, 34, 1.7);
    light.position.set(CABIN_X, 2.1 + CHASSIS_LIFT, z);
    // ...and on every layer, for the same reason one level up: see countInEveryPass.
    carrier.add(countInEveryPass(light));
    return light;
  };

  return {
    red: make(sirenRedMaterial(), sirenRedAnchor(CABIN_X, CABIN_TOP)),
    blue: make(sirenBlueMaterial(), sirenBlueAnchor(CABIN_X, CABIN_TOP)),
    housing,
    redLamp: lamp(PALETTE.lightRed, -0.42),
    blueLamp: lamp(PALETTE.sirenBlue, 0.42),
  };
}

export function createPolice(scene) {
  const group = new THREE.Group();
  /**
   * Everything the cruiser *draws*, one level in from the group that carries it.
   *
   * The car is off the map for much of a run and used to be hidden by `group.visible = false`,
   * which is the obvious way to do it and cost a stall every time the cop turned up. Three
   * collects the scene's lights with `traverseVisible`, so hiding the group took the two siren
   * lamps out of the count with it: `numPointLights` went 0 → 2 on the spawn frame, and the light
   * count is part of a material's program cache key, so **every lit material in the city relinked
   * its shader** — 22 programs on the frame the cruiser appeared and the rest on the frame it
   * left. Measured on a run at `tools/links.mjs`: 35 program links after boot, all of them the
   * static city's own materials, gone once the lamps stopped disappearing.
   *
   * So the group stays visible for the whole run and only this shell is switched. The lamps sit on
   * the group, outside it, dark at `intensity = 0` while the bar is off — a light that is counted
   * and contributes nothing, which is exactly the trade that keeps the program set still.
   */
  const shell = new THREE.Group();
  group.add(shell);
  const bodyGeometry = policeGeometry();
  const body = new THREE.Mesh(bodyGeometry, propMaterial({ gloss: { geometry: bodyGeometry, floor: SILL_Y } }));
  body.receiveShadow = true;
  shell.add(body);
  const lights = lightBar(shell, group);
  const wheels = steeredWheels(shell);
  /**
   * Everything that has to fade, dissolved rather than blended: `alphaHash` discards a noise-ordered
   * share of fragments below the opacity, so the car stays in the opaque pass — it keeps its place
   * in the AO prepass (`markOccluder` refuses a transparent material) and needs no sorting — and at
   * opacity 1 it discards nothing. Set once, here, because it is a define: toggling it per fade would
   * relink the program the frame the cruiser arrives.
   */
  const faders = [body.material, lights.housing.material, lights.red.material, lights.blue.material,
    wheels[0].material];
  for (const material of faders) material.alphaHash = true;
  shell.visible = false;
  // 'YXZ', not the default — see the note by the ambient euler in sim/traffic.js. The pose arrives
  // as a quaternion from the traffic model, but anything reading `rotation` back gets it in the
  // order that means something for a car.
  group.rotation.order = BODY_EULER_ORDER;
  scene.add(group);

  const state = {
    /** On the map: wearing a traffic car. */
    active: false,
    /** The traffic car it is wearing, or null. */
    cop: null,
    /**
     * The bar is up at all: swinging on patrol, strobing in a chase, off while the car drives away.
     * `game/sirenglow.js` reads this too, so the off-screen wash warns about a patrol on the board
     * and says which it is doing the same way the bar does.
     */
    lit: false,
    /** Strobing — the patrol has spotted the taxi and is after it. Read by sirenglow.js. */
    chasing: false,
    /** 'off' | 'patrol' | 'strobe' — see `setBar`. */
    bar: 'off',
    flash: 0,
    /** 0..1, how much of the car is drawn — see FADE_TIME. Also scales the lamps and the wash. */
    fade: 1,
    /** Which way the fade is heading: +1 in, -1 out. */
    fading: 0,
    /**
     * Driving off the island on its own, out of the traffic model — see `release`. null, or
     * `{ dx, dz, v, edge }`; `done` once it has dissolved, for game/patrol.js to retire it.
     */
    loose: null,
  };

  const skin = (pos, quat, car) => {
    group.position.copy(pos);
    group.quaternion.copy(quat);
    wheels.forEach((wheel) => { wheel.rotation.y = car.wheelAngle; });
  };

  /**
   * Draw the cruiser wherever the traffic model puts this car, in place of its instance.
   *
   * `fade: false` is a car that is already on screen — a robbery's cop handed over to chase the
   * taxi away from the drop-off (game/patrol.js, `pursueNearest`). It is the same livery on the
   * same body, so the swap is invisible as long as nothing dissolves in.
   */
  function wear(car, { fade = true } = {}) {
    state.loose = null;
    state.cop = car;
    state.active = true;
    car.skin = skin;
    group.position.set(car.x, group.position.y, car.z);
    shell.visible = true;
    if (fade) fadeIn();
    else { state.fade = 1; state.fading = 0; }
  }

  /** Dissolve in from nothing — the frame `wear` is called on, the car is still invisible. */
  function fadeIn() { state.fade = 0; state.fading = 1; }
  /** ...and out. `state.fade` reaches 0 FADE_TIME later. */
  function fadeOut() { state.fading = -1; }

  /**
   * Let go of the traffic car and drive the cruiser off the map by itself: straight on along
   * grid direction `d` from where it was last posed, dissolving once it crosses `edge` — the
   * coordinate along that axis where the asphalt slab gives way to its fade skirt.
   *
   * The road network ends at the ring road, so there is no lane off the island for the traffic
   * model to carry it down. The fade used to start at the exit junction instead, which is on the
   * ring and so on screen whenever the camera is near that side of town: reported as the patrol
   * car "fading out mid city". The caller takes the car out of the fleet; this keeps the mesh,
   * the bar and the lamps going until it is past the edge and gone (`state.loose.done`).
   */
  function release(d, edge) {
    const v = state.cop ? Math.max(0, state.cop.v) : LOOSE_SPEED;
    if (state.cop) state.cop.skin = null;
    state.cop = null;
    state.fading = 0;
    wheels.forEach((wheel) => { wheel.rotation.y = 0; });
    const dx = d === 0 ? 1 : d === 2 ? -1 : 0;
    const dz = d === 1 ? 1 : d === 3 ? -1 : 0;
    state.loose = { dx, dz, v, edge, done: false };
  }

  /**
   * What the bar is doing. **Patrol**: a slow, soft swing from red to blue (`patrolSwing`), which is
   * the telegraph — a playtest of the first dark-bar patrol found the cop hard to spot until it had
   * already spotted you, and a steady bar after it announced the car without looking alive. So the
   * patrol announces itself, gently, without looking like it is after anybody. **Strobe** once it
   * is: hard red/blue alternation at the hunting rate, which is the change the player has to read.
   * **Off** while it drives away after losing you — the stand-down reads as the lights going out.
   */
  function setBar(mode) {
    state.bar = mode;
  }

  /** Stop drawing it: the car has left the road, or been wrecked. */
  function shed() {
    if (state.cop) state.cop.skin = null;
    state.cop = null;
    state.bar = 'off';
    state.active = false;
    state.lit = false;
    state.chasing = false;
    state.fade = 1;
    state.fading = 0;
    state.loose = null;
    shell.visible = false;
    lights.redLamp.intensity = 0;
    lights.blueLamp.intensity = 0;
  }

  function update(dt) {
    state.flash += dt;
    const cop = state.cop;
    // Off the road, or a wreck. A wreck's shell is the traffic model's to draw — its effects take
    // it from the instance — so the cruiser's own mesh goes with it rather than standing over the
    // fire.
    if (cop && (!cop.police || cop.crashed)) shed();

    const loose = state.loose;
    if (loose && !loose.done) {
      loose.v = Math.min(LOOSE_SPEED, loose.v + LOOSE_ACCEL * dt);
      group.position.x += loose.dx * loose.v * dt;
      group.position.z += loose.dz * loose.v * dt;
      const along = loose.dx ? group.position.x * loose.dx : group.position.z * loose.dz;
      if (!state.fading && state.fade > 0 && along >= loose.edge) fadeOut();
    }

    if (state.fading) {
      state.fade = Math.max(0, Math.min(1, state.fade + state.fading * dt / FADE_TIME));
      if (state.fade === 1 || state.fade === 0) state.fading = 0;
      if (loose && state.fade === 0) loose.done = true;
    }
    for (const material of faders) material.opacity = state.fade;

    state.lit = Boolean(state.cop || state.loose) && state.bar !== 'off';
    state.chasing = state.lit && state.bar === 'strobe';
    // The pods' bloom does not fade with them (game/bloom.js draws its own material), so a bar on a
    // car still dissolving in stays dark until the car is mostly there.
    if (!state.lit || state.fade < 0.5) {
      lights.red.visible = false;
      lights.blue.visible = false;
      lights.redLamp.intensity = 0;
      lights.blueLamp.intensity = 0;
      return;
    }
    // Patrol: the slow swing. The lamps follow it smoothly and at a patrol's strength — the road
    // washed softly one colour and then the other, never both at once (red and blue from one point
    // read as purple, which reads as a lighting bug; see coplights.js). The pods can only be on or
    // off, so they change sides where the swing crosses the middle.
    if (!state.chasing) {
      const red = patrolSwing(state.flash);
      lights.red.visible = red >= 0.5;
      lights.blue.visible = red < 0.5;
      lights.redLamp.intensity = PATROL_LAMP * red * red * state.fade;
      lights.blueLamp.intensity = PATROL_LAMP * (1 - red) * (1 - red) * state.fade;
      return;
    }
    // Alternating sides, as the fleet's bar does — the dark side still shows its painted lens. The
    // point lights never go fully dark: a hard on/off wash reads as flicker rather than a siren, so
    // the off colour keeps a low glow. The hunting rate: this car is coming for you.
    const on = sirenOn(state.flash, true);
    lights.red.visible = on;
    lights.blue.visible = !on;
    lights.redLamp.intensity = on ? 130 : 14;
    lights.blueLamp.intensity = on ? 14 : 130;
  }

  return {
    state,
    update,
    wear,
    shed,
    setBar,
    fadeOut,
    release,
    group,
    /** Both halves of the light bar, for `main.js` to put in the bloom. See game/bloom.js. */
    emissiveMeshes: [lights.red, lights.blue],
  };
}
