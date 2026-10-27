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
// returns `{ object, update?(dt, t), glow? }`; the object is recentred on the bench by the viewer,
// so a landmark built in world coordinates on its block comes out at the origin like a car does.
// `glow` is `[mesh, kind]` pairs for the bloom, the same meshes at the same kinds main.js marks.
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
import { createTaxiHeadlights, switchedLights } from '../game/citylights.js';
import { wheelAnchors, wheelGeometry, SILL_Y } from '../geometry/wheels.js';
import {
  carGeometry, truckCabGeometry, truckBoxGeometry, CAR_LEN, CAR_W, TRUCK_LEN, TRUCK_W,
} from '../sim/traffic.js';
import {
  convertibleGeometry, convertibleInteriorGeometry, westfaliaGeometry,
} from '../geometry/classics.js';
import { createPolice } from '../sim/police.js';
import { createFireTruckMesh } from '../geometry/firetruck.js';
import { createGarbageTruckMesh } from '../geometry/garbage.js';
import { createRivalMesh } from '../game/race.js';
import { createHelicopterMesh } from '../geometry/helicopter.js';
import { createPlaneMesh } from '../geometry/plane.js';
import { PROP_SPIN } from '../game/flyover.js';
import { createBargeMesh, createTugMesh } from '../geometry/boat.js';
import { createTrainMesh } from '../game/ltrain.js';
import { createPerson } from '../geometry/person.js';
import { createParcel } from '../geometry/parcel.js';
import { createFoodOrder } from '../geometry/food.js';
import { buildBank, bankDomeMesh } from '../city/bank.js';
import { INSET, buildLotTower } from '../city/buildings.js';
import { chooseVetSite, createVetClinic } from '../city/vetclinic.js';
import { makeRng } from '../util/rng.js';

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

/**
 * The landmarks, found rather than listed: any module in src/city that exports
 * `LANDMARK = { id, label, create }`, where `create(block, rng)` returns `{ group, update? }` the
 * way the depot, the burger joint, the graveyard and the roadside businesses all do. A new
 * landmark lands in the bench's model list by exporting one, with nothing to add here. The list
 * was hand-kept before, and the graveyard, car wash and gas station all shipped without a row.
 *
 * Under Vite that is `import.meta.glob`, which only exists as a compile-time rewrite; the headless
 * check (tools/workshop.mjs) imports this file under plain Node, which has no `import.meta.env`
 * and reads the directory instead. The specifier is a variable so Vite does not try to bundle
 * `node:fs` for the browser.
 */
async function cityModules() {
  if (import.meta.env) return import.meta.glob('../city/*.js', { eager: true });
  const fsName = 'node:fs';
  const { readdirSync } = await import(/* @vite-ignore */ fsName);
  const dir = new URL('../city/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  return Object.fromEntries(await Promise.all(
    files.map(async (f) => [`../city/${f}`, await import(new URL(f, dir).href)]),
  ));
}

const LANDMARKS = Object.entries(await cityModules())
  .filter(([, mod]) => mod.LANDMARK)
  .map(([path, mod]) => ({ ...mod.LANDMARK, file: path.split('/').pop() }))
  .sort((a, b) => a.label.localeCompare(b.label));

export const CATALOG = [
  // --- Vehicles ---------------------------------------------------------------------------------
  {
    id: 'taxi', label: 'Taxi', kind: 'Vehicles',
    source: 'src/geometry/taxi.js · createTaxiMesh',
    // Its lamp pods bloom as the fleet hands them to main.js (`emissiveMeshes`, sim/traffic.js).
    build: () => {
      const taxi = createTaxiMesh();
      // The headlights main.js hangs on the taxi under weather, and the tail lights' running floor
      // (`TAIL_FLOOR` in sim/traffic.js), both thrown by the bench's Weather picker.
      const headlights = createTaxiHeadlights();
      taxi.group.add(headlights.group);
      return {
        object: taxi.group,
        glow: [...taxi.lights.map((pod) => [pod, 'pod']), [headlights.pods, 'pod']],
        lamps: (level) => { headlights.setLevel(level); taxi.setLights(level * 0.6, 0, 0); },
      };
    },
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
      return { object: cruiser.group, glow: cruiser.emissiveMeshes.map((mesh) => [mesh, 'siren']) };
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
    // The game keeps the engine's shell hidden until it responds to a fire, so show it on the bench.
    build: () => {
      const engine = createFireTruckMesh();
      engine.shell.visible = true;
      return { object: engine.group };
    },
  },
  {
    id: 'garbage', label: 'Garbage truck', kind: 'Vehicles',
    source: 'src/geometry/garbage.js · createGarbageTruckMesh',
    // Hidden between collections in the game, like the fire engine's shell.
    build: () => {
      const truck = createGarbageTruckMesh();
      truck.shell.visible = true;
      return { object: truck.group };
    },
  },
  {
    id: 'racer', label: 'Street racer', kind: 'Vehicles',
    source: 'src/game/race.js · createRivalMesh (body: rivalBodyGeometry)',
    build: () => {
      const rival = createRivalMesh();
      rival.shell.visible = true;
      return { object: rival.group };
    },
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
    // Turning at the flyover's own rate, so the bench shows what the sky does (and any strobing).
    build: () => {
      const plane = createPlaneMesh();
      return { object: plane.group, update: (dt) => { plane.blade.rotation.x += dt * PROP_SPIN; } };
    },
  },
  {
    id: 'ltrain', label: 'L train', kind: 'Vehicles',
    source: 'src/game/ltrain.js · buildCar (bench: createTrainMesh)',
    build: () => ({ object: createTrainMesh() }),
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
  // Every whole-block landmark module found under src/city (`LANDMARKS`, below), then the bank,
  // which is not a module of its own but a lot `createBuildings` merges into the skyline.
  ...LANDMARKS.map(({ id, label, create, glow, file }) => ({
    id, label, kind: 'Landmarks',
    source: `src/city/${file} · ${create.name}`,
    build: (rng) => {
      const block = benchBlock();
      const built = create(block, rng);
      // Panes a landmark leaves for main.js to switch with the city's lights (the depot's office).
      const panes = built.litWindows ? switchedLights(built.litWindows, 'litWindows') : null;
      if (panes) built.group.add(panes);
      return {
        object: landmark(block, built.group),
        update: (dt) => built.update?.(dt),
        glow: glow?.(built) ?? [],
      };
    },
  })),
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
      const built = buildBank(b, lot, block.bounds, parts);
      const mesh = plain(mergeGeometries(parts, false), { smooth: true });
      parts.forEach((p) => p.dispose());
      // The dome is its own glossy mesh in the city too, so the bench draws it the same way.
      const group = new THREE.Group();
      group.add(mesh, bankDomeMesh(built.domeGeometry));
      return { object: landmark(block, group) };
    },
  },

  {
    // An ordinary corner shop, built by the city's own tower generator on the +X+Z quarter of the
    // bench block, with the clinic's sign on it — the head is what this entry is for.
    id: 'vet', label: 'Vet clinic', kind: 'Landmarks',
    source: 'src/city/vetclinic.js · dogHeadGeometry',
    build: () => {
      const block = { ...benchBlock(), centrality: 0 };
      const { x0, z0, x1, z1, cx, cz } = block.bounds;
      const lot = { x0: cx - 1, z0: cz - 1, x1, z1 };
      // The first shop the generator gives a flat roof (pitched ones have no deck to stand on).
      for (let n = 0; n < 40; n++) {
        const { tower, meshes } = buildLotTower(lot, block, makeRng(500 + n), { height: 5.5, families: ['brick'] });
        const site = tower && chooseVetSite([tower], null);
        if (!site) { meshes.forEach((m) => m.geometry.dispose()); continue; }
        const vet = createVetClinic(site);
        const group = new THREE.Group();
        group.add(...meshes, vet.group);
        return { object: landmark(block, group), update: (dt) => vet.update(dt), glow: [[vet.glow, 'window']] };
      }
      throw new Error('vet bench: no flat-roofed shop in 40 tries');
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

/** Rotors turning about the axes the flight code turns them about, so the bench matches the sky. */
function spinning(heli) {
  return {
    object: heli.group,
    update: (dt) => {
      if (heli.mainHub) heli.mainHub.rotation.y += dt * 18;
      // About z, the lateral axis, as game/chopper.js turns it: the bar sweeps the fin's plane.
      // This once spun it about x, which swung the blade out across the boom on the bench only.
      if (heli.tailHub) heli.tailHub.rotation.z += dt * 24;
    },
  };
}

/** Builders hand back either an Object3D or a record carrying one as `group`. */
function asObject(built) {
  return built?.isObject3D ? built : built.group;
}

export const byId = (id) => CATALOG.find((entry) => entry.id === id) ?? CATALOG[0];
