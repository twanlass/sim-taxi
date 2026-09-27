import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial, unlitMaterial, BODY_EULER_ORDER } from '../util/geo.js';
import { PALETTE, color } from '../palette.js';
import { sirenOn } from '../geometry/lights.js';
import { wheelAnchors, wheelGeometries, wheelGeometry, CHASSIS_LIFT } from './traffic.js';

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
// at reds and can be rammed, and it drives with its bar **dark** until the taxi boosts near it.
// game/patrol.js owns the car: when it comes onto the map, where it goes, when it gives chase and
// how the chase ends. What this module does is **wear** that car: the traffic model poses it
// through `car.skin`, and this draws the cruiser's own mesh there instead of an instanced
// hatchback in police paint. A cruiser has a stripe and a roof in `policeRoof`, which is what makes
// it the patrol rather than one more car in a robbery's fleet.
//
// The lamps are the other half, and they are why this is a real mesh at all rather than another
// instance: a lit bar washes red and blue across the road and the fronts of buildings as it passes,
// and a pod on an instanced car cannot. See `lightBar`.

// Boosting inside this radius of the patrol car is what sets it after you — reckless driving in
// front of a cop. One block in world units (PITCH = 20 in src/city/grid.js): the taxi and the
// cruiser have to be sharing a junction, so it reads as being caught in the act rather than spotted
// from a street over. It used to end the run on the spot; it starts a chase now (game/patrol.js).
export const SPOT_RANGE = 20;

// Body dimensions, used two ways: policeGeometry() builds to them, and the wheels come out of
// traffic.js against them — which keeps the steering geometry identical in kind to every other car
// on the road.
const CAR_LEN = 3.6;
const CAR_W = 1.8;

// Where the bar sits, in car-local space. The housing is the bar's dark body, so a cruiser with its
// lights off still reads as police: it is out on patrol for most of its life now, and for as long
// as it was two lamps and nothing else, a dark bar was no bar — the same hole the robbery's cops had
// (`sirenHousingMesh` in sim/traffic.js), where a stood-down cop read as the fleet turning back into
// traffic.
const BAR_X = -0.2;
const BAR_Y = 1.9 + CHASSIS_LIFT;
const BAR_H = 0.26;
const POD_Z = 0.42;
const POD_W = 0.5;

function policeGeometry() {
  const parts = [];

  const body = new THREE.BoxGeometry(CAR_LEN, 0.8, CAR_W);
  body.translate(0, 0.78 + CHASSIS_LIFT, 0);
  parts.push(bakeColor(body, color('policeBody')));

  const roof = new THREE.BoxGeometry(1.9, 0.62, 1.6);
  roof.translate(-0.2, 1.46 + CHASSIS_LIFT, 0);
  parts.push(bakeColor(roof, color('policeRoof')));

  const stripe = new THREE.BoxGeometry(3.62, 0.3, 1.82);
  stripe.translate(0, 0.62 + CHASSIS_LIFT, 0);
  parts.push(bakeColor(stripe, color('policeRoof')));

  // Inset from the pods on every side they share, so a lit pod encloses it rather than fighting it
  // — the same arrangement `sirenHousingGeometry` has on the robbery's cops.
  const housing = new THREE.BoxGeometry(0.51, BAR_H - 0.04, 2 * (POD_Z + POD_W / 2) - 0.04);
  housing.translate(BAR_X, BAR_Y, 0);
  parts.push(bakeColor(housing, color('sirenHousing')));

  // Rear pair only; the fronts steer, so they hang off the group as their own meshes.
  parts.push(...wheelGeometries(CAR_LEN, CAR_W));

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

/** The steered front pair, added to `group` and handed back so the skin can turn them. */
function steeredWheels(group) {
  const material = propMaterial();
  return wheelAnchors(CAR_LEN, CAR_W)
    .filter((anchor) => anchor.front)
    .map((anchor) => {
      const wheel = new THREE.Mesh(wheelGeometry(), material);
      wheel.position.set(anchor.x, anchor.y, anchor.z);
      wheel.castShadow = true;
      wheel.receiveShadow = true;
      group.add(wheel);
      return wheel;
    });
}

function lightBar(shell, carrier) {
  const make = (hex, z) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.55, BAR_H, POD_W),
      unlitMaterial({ color: new THREE.Color(hex) }),
    );
    mesh.position.set(BAR_X, BAR_Y, z);
    shell.add(mesh);
    return mesh;
  };

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
    light.position.set(BAR_X, BAR_Y + 0.2, z);
    carrier.add(light);
    return light;
  };

  return {
    red: make(PALETTE.lightRed, -POD_Z),
    blue: make(PALETTE.sirenBlue, POD_Z),
    redLamp: lamp(PALETTE.lightRed, -POD_Z),
    blueLamp: lamp(PALETTE.sirenBlue, POD_Z),
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
  const body = new THREE.Mesh(policeGeometry(), propMaterial());
  body.receiveShadow = true;
  shell.add(body);
  const lights = lightBar(shell, group);
  const wheels = steeredWheels(shell);
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
     * The bar is running — which is to say the patrol car has spotted the taxi and is after it.
     * It is dark for the whole of an ordinary patrol. `game/sirenglow.js` reads this too, so the
     * off-screen wash only ever warns about a cop that is actually coming for you.
     */
    lit: false,
    /** Running at the hunting rate — true for as long as the bar is lit. Read by sirenglow.js. */
    chasing: false,
    flash: 0,
  };

  const skin = (pos, quat, car) => {
    group.position.copy(pos);
    group.quaternion.copy(quat);
    wheels.forEach((wheel) => { wheel.rotation.y = car.wheelAngle; });
  };

  /** Draw the cruiser wherever the traffic model puts this car, in place of its instance. */
  function wear(car) {
    state.cop = car;
    state.active = true;
    car.skin = skin;
    group.position.set(car.x, group.position.y, car.z);
    shell.visible = true;
  }

  /** Stop drawing it: the car has left the road, or been wrecked. */
  function shed() {
    if (state.cop) state.cop.skin = null;
    state.cop = null;
    state.active = false;
    state.lit = false;
    state.chasing = false;
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

    state.lit = Boolean(state.cop?.siren);
    state.chasing = state.lit;
    if (!state.lit) {
      lights.red.visible = false;
      lights.blue.visible = false;
      lights.redLamp.intensity = 0;
      lights.blueLamp.intensity = 0;
      return;
    }
    // Never fully dark on either side — a hard on/off strobe reads as flicker rather than a
    // siren, so the off colour keeps a low glow. Always the hunting rate: the only time the bar is
    // up is when this car is coming for you.
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
    group,
    /** Both halves of the light bar, for `main.js` to put in the bloom. See game/bloom.js. */
    emissiveMeshes: [lights.red, lights.blue],
  };
}
