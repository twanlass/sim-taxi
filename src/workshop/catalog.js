// What the model workshop can put on the bench — /workshop/, see docs/workshop.md.
//
// **Every entry builds the shipped model through the shipped code.** Nothing here is a copy of a
// mesh: an entry calls the same builder the game calls, so an edit to that builder is an edit to
// the game, and the workshop is only ever showing you what the city will draw. Where the game
// assembles a vehicle out of several instanced meshes (the ambient fleet, `sim/traffic.js`), the
// entry puts the same geometries back together as plain meshes, the way `wreckShell` does when a
// car is copied out of the fleet.
//
// An entry is `{ id, label, kind, source, build(rng) }`. `source` is the file and function to
// edit, and is what the chat panel hands the agent so it starts in the right place. `build`
// returns `{ object, update?(dt, t) }`; the object is recentred on the bench by the viewer, so a
// landmark built in world coordinates on its block comes out at the origin like a car does.
//
// Adding an entry is the whole job of putting a new model in the workshop. The headless check
// (tools/workshop.mjs) builds every one of them, so a builder that throws fails `npm run check`.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, propMaterial } from '../util/geo.js';
import { PALETTE } from '../palette.js';
import { blockBounds } from '../city/grid.js';
import { KERB_H } from '../city/ground.js';
import { createTaxiMesh } from '../geometry/taxi.js';
import { wheelAnchors, wheelGeometry, SILL_Y } from '../geometry/wheels.js';
import {
  carGeometry, truckCabGeometry, truckBoxGeometry, CAR_LEN, CAR_W, TRUCK_LEN, TRUCK_W,
} from '../sim/traffic.js';
import {
  convertibleGeometry, convertibleInteriorGeometry, westfaliaGeometry,
} from '../geometry/classics.js';
import { createPolice } from '../sim/police.js';
import { createFireTruckMesh } from '../geometry/firetruck.js';
import { createHelicopterMesh } from '../geometry/helicopter.js';
import { createPlaneMesh } from '../geometry/plane.js';
import { createBargeMesh, createTugMesh } from '../geometry/boat.js';
import { createPerson } from '../geometry/person.js';
import { createParcel } from '../geometry/parcel.js';
import { createFoodOrder } from '../geometry/food.js';
import { createGarage } from '../city/garage.js';
import { createBurgerJoint } from '../city/burgerjoint.js';
import { buildBank } from '../city/bank.js';
import { INSET } from '../city/buildings.js';

const shadowed = (mesh) => {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};

/** A geometry on the plain prop material, which is what most of the city wears. */
const plain = (geometry, options) => shadowed(new THREE.Mesh(geometry, propMaterial(options)));

/** The fleet's glossy paint: what `createTraffic` puts on every ambient body. */
const glossy = (geometry) => shadowed(new THREE.Mesh(
  geometry, propMaterial({ gloss: { geometry, floor: SILL_Y } }),
));

/**
 * The steered front pair. The fleet draws them as their own instanced mesh (they turn and the body
 * does not) and tints them with the body's instance colour, so they share the body's material here.
 */
function frontWheels(group, len, width, material) {
  for (const anchor of wheelAnchors(len, width).filter((a) => a.front)) {
    const wheel = shadowed(new THREE.Mesh(wheelGeometry(), material));
    wheel.position.set(anchor.x, anchor.y, anchor.z);
    group.add(wheel);
  }
}

/**
 * An ambient car the way the fleet paints one: baked white, multiplied by a `carBody` colour.
 * `instanceColor` and `material.color` multiply the vertex colours the same way, which is what
 * lets `wreckShell` copy a car out of the fleet onto a material and keep its paint.
 */
function fleetCar(geometry, paint, len = CAR_LEN, width = CAR_W) {
  const group = new THREE.Group();
  const body = glossy(geometry);
  if (paint) body.material.color.set(paint);
  group.add(body);
  frontWheels(group, len, width, body.material);
  return group;
}

/** A block in the middle of the city, shaped like the ones `createLayout` hands the landmarks. */
function benchBlock(bi = 2, bj = 2) {
  return { bi, bj, type: 'built', districtId: null, bounds: blockBounds(bi, bj) };
}

/**
 * The block's own kerb and pavement under a landmark, so it sits at the height it does in the city
 * (everything on a block stands on `KERB_H`) instead of floating a kerb's height over the bench.
 */
function plinth(block) {
  const { x0, z0, x1, z1, cx, cz } = block.bounds;
  const slab = new THREE.Mesh(
    bakeColor(new THREE.BoxGeometry(x1 - x0, KERB_H, z1 - z0), PALETTE.kerb),
    propMaterial(),
  );
  slab.position.set(cx, KERB_H / 2, cz);
  slab.receiveShadow = true;
  return slab;
}

function landmark(block, built) {
  const group = new THREE.Group();
  group.add(plinth(block), built);
  return group;
}

export const CATALOG = [
  // --- Vehicles ---------------------------------------------------------------------------------
  {
    id: 'taxi', label: 'Taxi', kind: 'Vehicles',
    source: 'src/geometry/taxi.js · createTaxiMesh',
    build: () => ({ object: createTaxiMesh().group }),
  },
  {
    id: 'car', label: 'Ambient car', kind: 'Vehicles',
    source: 'src/sim/traffic.js · carGeometry (paint: PALETTE.carBody)',
    build: (rng) => ({ object: fleetCar(carGeometry(), rng.pick(PALETTE.carBody)) }),
  },
  {
    id: 'truck', label: 'Box truck', kind: 'Vehicles',
    source: 'src/sim/traffic.js · truckCabGeometry + truckBoxGeometry',
    build: (rng) => {
      const group = fleetCar(truckCabGeometry(), rng.pick(PALETTE.carBody), TRUCK_LEN, TRUCK_W);
      group.add(plain(truckBoxGeometry()));
      return { object: group };
    },
  },
  {
    id: 'police', label: 'Police cruiser', kind: 'Vehicles',
    source: 'src/sim/police.js · createPolice (body: carGeometry + policeCabGeometry)',
    build: () => {
      const cruiser = createPolice(new THREE.Group(), { lamps: false });
      // The shell is hidden until the cruiser is wearing a traffic car; on the bench it always is.
      cruiser.group.children.forEach((child) => { child.visible = true; });
      return { object: cruiser.group };
    },
  },
  {
    id: 'convertible', label: 'Convertible', kind: 'Vehicles',
    source: 'src/geometry/classics.js · convertibleGeometry',
    build: (rng) => {
      const group = fleetCar(convertibleGeometry(CAR_LEN, CAR_W), rng.pick(PALETTE.carBody));
      group.add(plain(convertibleInteriorGeometry(CAR_LEN, CAR_W)));
      return { object: group };
    },
  },
  {
    id: 'westfalia', label: 'VW camper', kind: 'Vehicles',
    source: 'src/geometry/classics.js · westfaliaGeometry',
    // Its paint is baked — the one ambient body that is not tinted (`tintOf` in sim/traffic.js).
    build: () => ({ object: fleetCar(westfaliaGeometry(CAR_LEN, CAR_W), null) }),
  },
  {
    id: 'firetruck', label: 'Fire engine', kind: 'Vehicles',
    source: 'src/geometry/firetruck.js · createFireTruckMesh',
    build: () => ({ object: createFireTruckMesh().group }),
  },
  {
    id: 'heli', label: 'Helicopter', kind: 'Vehicles',
    source: 'src/geometry/helicopter.js · createHelicopterMesh',
    build: () => spinning(createHelicopterMesh()),
  },
  {
    id: 'policeheli', label: 'Police helicopter', kind: 'Vehicles',
    source: 'src/geometry/helicopter.js · createHelicopterMesh({ livery: "police" })',
    build: () => spinning(createHelicopterMesh({ livery: 'police' })),
  },
  {
    id: 'plane', label: 'Plane', kind: 'Vehicles',
    source: 'src/geometry/plane.js · createPlaneMesh',
    build: () => ({ object: createPlaneMesh().group }),
  },
  {
    id: 'tug', label: 'Tugboat', kind: 'Vehicles',
    source: 'src/geometry/boat.js · createTugMesh',
    build: (rng) => ({ object: plain(createTugMesh(rng)) }),
  },
  {
    id: 'barge', label: 'Trash barge', kind: 'Vehicles',
    source: 'src/geometry/boat.js · createBargeMesh',
    build: (rng) => ({ object: plain(createBargeMesh(rng)) }),
  },

  // --- Landmarks --------------------------------------------------------------------------------
  {
    id: 'depot', label: 'Taxi depot', kind: 'Landmarks',
    source: 'src/city/garage.js · createGarage',
    build: (rng) => {
      const block = benchBlock();
      const garage = createGarage(block, rng);
      return { object: landmark(block, garage.group), update: (dt) => garage.update?.(dt) };
    },
  },
  {
    id: 'burger', label: 'Burger joint', kind: 'Landmarks',
    source: 'src/city/burgerjoint.js · createBurgerJoint',
    build: (rng) => {
      const block = benchBlock();
      const joint = createBurgerJoint(block, rng);
      return { object: landmark(block, joint.group), update: (dt) => joint.update?.(dt) };
    },
  },
  {
    id: 'bank', label: 'Bank', kind: 'Landmarks',
    source: 'src/city/bank.js · buildBank',
    build: () => {
      // The bank takes a whole block as one lot (city/buildings.js), set back by the same `INSET`
      // every building on a lot is.
      const block = benchBlock();
      const lot = { ...block.bounds };
      const b = {
        x0: lot.x0 + INSET, z0: lot.z0 + INSET, x1: lot.x1 - INSET, z1: lot.z1 - INSET,
      };
      Object.assign(b, { w: b.x1 - b.x0, d: b.z1 - b.z0, cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2 });
      const parts = [];
      buildBank(b, lot, block.bounds, parts);
      const mesh = plain(mergeGeometries(parts, false));
      parts.forEach((p) => p.dispose());
      return { object: landmark(block, mesh) };
    },
  },

  // --- People and props -------------------------------------------------------------------------
  {
    id: 'rider', label: 'Rider', kind: 'People & props',
    source: 'src/geometry/person.js · createPerson',
    build: () => ({ object: createPerson().group }),
  },
  {
    id: 'parcel', label: 'Parcel', kind: 'People & props',
    source: 'src/geometry/parcel.js · createParcel',
    build: () => ({ object: asObject(createParcel()) }),
  },
  {
    id: 'food', label: 'Food order', kind: 'People & props',
    source: 'src/geometry/food.js · createFoodOrder',
    build: () => ({ object: asObject(createFoodOrder()) }),
  },
];

/** Rotors turning, so a helicopter on the bench looks like one in the sky. */
function spinning(heli) {
  return {
    object: heli.group,
    update: (dt) => {
      if (heli.mainHub) heli.mainHub.rotation.y += dt * 18;
      if (heli.tailHub) heli.tailHub.rotation.x += dt * 24;
    },
  };
}

/** Builders hand back either an Object3D or a record carrying one as `group`. */
function asObject(built) {
  return built?.isObject3D ? built : built.group;
}

export const byId = (id) => CATALOG.find((entry) => entry.id === id) ?? CATALOG[0];
