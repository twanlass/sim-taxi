/**
 * Z-fighting, found in the triangles rather than looked for in a render.
 *
 * Every z-fight this project has shipped was an exact tie between two front-facing surfaces — the
 * channel wall under the embankment kerb (#686), the bridge abutment on the channel wall, the
 * drive-through's apron on the pavement — and an exact tie resolves the same way in every headless
 * frame and differently on a phone, which is why each one was reported from a phone and fixed one
 * at a time with its own probe. A tie is a fact about geometry, so this reads the geometry
 * (src/util/zfight.js):
 *
 *   - **the city**, built through the same builders and seeds main.js uses, on several cities,
 *     with the scan aimed down the game's own fixed view so a face nothing can see is not reported;
 *   - **every model on the workshop's bench** (src/workshop/catalog.js), which is every vehicle and
 *     landmark the game draws, built through the shipped builders — so an edit the workshop's chat
 *     makes is checked by the same `npm run check` as one made by hand. A vehicle is scanned at
 *     every heading, since it drives all four ways;
 *   - and the scanner itself, on shapes built here where the answer is known — the control.
 *
 *   node tools/zfight.mjs                 the whole check
 *   node tools/zfight.mjs --model taxi    one workshop model, every finding listed (what the
 *                                         workshop's agent runs after it edits a model)
 *   node tools/zfight.mjs --seed 23       one city, every finding listed
 *
 * **Adding to the city.** `buildCity` below is a copy of the order main.js builds the static city
 * in, because main.js boots a page and cannot be imported. A new static builder in main.js wants a
 * line here, or it is not checked. Vehicles, people and parcels are checked through their
 * workshop entries instead.
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { propMaterial } from '../src/util/geo.js';
import { VIEW_DIR } from '../src/game/camera.js';
import { sinkShadowCaster } from '../src/game/scene.js';
import { findZFighting, describeZFighting } from '../src/util/zfight.js';
import { createLayout } from '../src/city/layout.js';
import { createGround } from '../src/city/ground.js';
import { createManholes } from '../src/city/manholes.js';
import { createAsphaltPatches } from '../src/city/asphaltpatch.js';
import { createRiver, bridgeLines, bridgeSpan } from '../src/city/river.js';
import { createHarbor } from '../src/city/harbor.js';
import { createNorthPark } from '../src/city/northpark.js';
import { createSouthShore } from '../src/city/southshore.js';
import { createParkShore } from '../src/city/parkshore.js';
import { createWestEdge } from '../src/city/westedge.js';
import { createBridge } from '../src/geometry/bridge.js';
import { createBuildings } from '../src/city/buildings.js';
import { createProps } from '../src/city/props.js';
import { createGarage } from '../src/city/garage.js';
import { createBurgerJoint } from '../src/city/burgerjoint.js';
import { createGraveyard } from '../src/city/graveyard.js';
import { createCarWash } from '../src/city/carwash.js';
import { createGasStation } from '../src/city/gasstation.js';
import { roadsideKind } from '../src/city/roadside.js';
import { createLTrain } from '../src/game/ltrain.js';
import { createDrawbridge } from '../src/game/drawbridge.js';
import { CATALOG } from '../src/workshop/catalog.js';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
};

// Six cities: enough that a fixed landmark is met on several blocks and a random placement (two
// trees on one spot, two roofs at one height) gets a fair number of chances to happen. 30 were
// swept when this was written and found nothing these six do not.
const SEEDS = [1, 7, 11, 16, 23, 29];

/** The static city, in main.js's order and off main.js's seed offsets. */
function buildCity(seed) {
  const scene = new THREE.Scene();
  const layout = createLayout(makeRng(seed));
  const add = (name, object) => {
    if (!object) return;
    object.name ||= name;
    scene.add(object);
  };
  add('ground', createGround(makeRng(seed + 11), layout));
  add('manholes', createManholes(makeRng(seed + 193)));
  add('asphalt-patches', createAsphaltPatches(makeRng(seed + 197)));
  const river = createRiver(makeRng(seed + 44), layout);
  if (river) {
    add('river', river.group);
    const bridgeRng = makeRng(seed + 55);
    for (const line of bridgeLines()) {
      const span = bridgeSpan(line);
      if (span.kind !== 'fixed') continue;
      const mesh = new THREE.Mesh(createBridge(span, bridgeRng), propMaterial());
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      sinkShadowCaster(mesh);
      add(`bridge-${line}`, mesh);
    }
  }
  add('harbor', createHarbor(makeRng(seed + 47))?.mesh);
  const northPark = createNorthPark(makeRng(seed + 53));
  if (northPark) {
    add('north-park', northPark.mesh);
    add('north-park-water', northPark.water);
  }
  add('park-shore', createParkShore()?.mesh);
  add('south-shore', createSouthShore(makeRng(seed + 61))?.mesh);
  const city = createBuildings(makeRng(seed + 22), layout);
  add('buildings', city.mesh);
  add('frames', city.frames);
  add('bank-dome', city.domeMesh);
  city.glass.forEach((glass, i) => add(`glass-${i}`, glass));
  const westEdge = createWestEdge(makeRng(seed + 59));
  if (westEdge) {
    add('west-edge-ground', westEdge.ground);
    add('west-edge-towers', westEdge.towers);
    add('west-edge-frames', westEdge.frames);
    westEdge.glass.forEach((glass, i) => add(`west-edge-glass-${i}`, glass));
  }
  const props = createProps(makeRng(seed + 33), layout);
  add('props', props.mesh);
  add('pond', props.pondMesh);
  add('court', props.courtMesh);
  add('skatepark', props.skateMesh);
  if (layout.graveyardBlock) add('graveyard', createGraveyard(layout.graveyardBlock, makeRng(seed + 131)).group);
  if (layout.garageBlock) add('garage', createGarage(layout.garageBlock, makeRng(seed + 99), {}).group);
  if (layout.burgerBlock) add('burger', createBurgerJoint(layout.burgerBlock, makeRng(seed + 111)).group);
  if (layout.roadsideBlock) {
    const create = roadsideKind(seed) === 'gas' ? createGasStation : createCarWash;
    add('roadside', create(layout.roadsideBlock, makeRng(seed + 141)).group);
  }
  createLTrain(scene, makeRng(seed + 421), { intro: false });
  createDrawbridge(scene, makeRng(seed + 66));
  return scene;
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const listing = (lines) => (lines.length ? `\n        ${lines.join('\n        ')}` : '');

const box = (w, h, d, x, y, z, color = 0x808080, options = {}) => {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y + h / 2, z);
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, ...options }));
  mesh.name = options.name ?? `box@${x},${z}`;
  return mesh;
};

function selfTest() {
  // Two slabs whose fronts share a plane and a patch of ground: the bug, in miniature.
  const tie = new THREE.Group();
  tie.add(box(2, 1, 1, 0, 0, 0, 0xff0000), box(2, 1, 1, 1, 0, 0, 0x00ff00));
  const tied = findZFighting(tie, { view: VIEW_DIR });
  check('scanner: a shared face is found', tied.length === 1 && Math.abs(tied[0].area - 2) < 0.05,
    tied.length ? `${tied[0].area.toFixed(2)} u², want 2 (front and top)` : 'nothing found');

  // The same pair a centimetre apart — the house idiom for laying one surface on another.
  const apart = new THREE.Group();
  apart.add(box(2, 1, 1, 0, 0, 0, 0xff0000), box(2, 1.02, 1.02, 1, -0.01, 0, 0x00ff00));
  check('scanner: 0.01 proud is not a tie', findZFighting(apart, { view: VIEW_DIR }).length === 0);

  // Same colour: a tie nobody can see.
  const same = new THREE.Group();
  same.add(box(2, 1, 1, 0, 0, 0), box(2, 1, 1, 1, 0, 0));
  check('scanner: identical pixels are not reported', findZFighting(same, { view: VIEW_DIR }).length === 0);

  // A decal declared as one.
  const decal = new THREE.Group();
  decal.add(box(2, 1, 1, 0, 0, 0, 0xff0000), box(2, 1, 1, 1, 0, 0, 0x00ff00,
    { polygonOffset: true, polygonOffsetFactor: -1 }));
  check('scanner: a polygonOffset decal is let through', findZFighting(decal, { view: VIEW_DIR }).length === 0);

  // A tie on a face the camera never sees (its -Z side), and one buried inside a third box.
  const hidden = new THREE.Group();
  hidden.add(box(1, 1, 1, 0, 0, 0, 0xff0000), box(1, 1, 1, 0, 0, -1, 0x00ff00));
  check('scanner: back faces are not reported', findZFighting(hidden, { view: VIEW_DIR }).length === 0);
  const buried = new THREE.Group();
  buried.add(box(1, 0.5, 1, 0, 0, 0, 0xff0000), box(1, 0.5, 1, 0.5, 0, 0, 0x00ff00), box(3, 1, 3, 0, 0.5, 0, 0x0000ff));
  // The two tops tie at y = 0.5, under the big box's bottom face... which is the cover.
  const buriedFound = findZFighting(buried, { view: VIEW_DIR }).filter((f) => f.normal.y > 0.9);
  check('scanner: a tie inside a solid is not reported', buriedFound.length === 0,
    describeZFighting(buriedFound).join('; '));

}

function scanCity(seed, verbose) {
  const scene = buildCity(seed);
  const fights = findZFighting(scene, { view: VIEW_DIR });
  check(`city ${seed}: no coplanar surfaces fighting`, fights.length === 0,
    `${fights.length} found${listing(describeZFighting(fights, verbose ? 100 : 6))}`);
}

function scanModel(entry, verbose) {
  const { object } = entry.build(makeRng(7));
  // A landmark is built where it stands and never turns; anything else can face any way.
  const spin = entry.kind !== 'Landmarks';
  const fights = findZFighting(object, { view: VIEW_DIR, spin });
  check(`${entry.id}: no coplanar surfaces fighting`, fights.length === 0,
    `${fights.length} found${listing(describeZFighting(fights, verbose ? 100 : 4))}`);
}

const started = performance.now();
const model = arg('model');
const seed = arg('seed');
if (model) {
  const entry = CATALOG.find((e) => e.id === model);
  if (!entry) {
    console.error(`no workshop model "${model}" — one of: ${CATALOG.map((e) => e.id).join(', ')}`);
    process.exit(2);
  }
  scanModel(entry, true);
} else if (seed) {
  scanCity(Number(seed), true);
} else {
  selfTest();
  for (const s of SEEDS) scanCity(s, false);
  for (const entry of CATALOG) scanModel(entry, false);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed · ${((performance.now() - started) / 1000).toFixed(1)}s`);
process.exit(passed === results.length ? 0 : 1);
