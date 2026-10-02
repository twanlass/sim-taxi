/**
 * The garage's paint (docs/garage.md): the skin codec, the rest-pose stamping every painted part
 * relies on, and the shader patch. In `npm run check` as `garage`.
 *
 *   node tools/garage.mjs
 *
 * The one claim worth the most here is the door's: paint put on the flank of a *shut* car is on the
 * door when it swings open. That is the whole reason paint is looked up by rest position, and a
 * stamping slip would break it without a single visible error — the door would simply open bare.
 */
import * as THREE from 'three';
import {
  createSkin, blankSkin, encodeVolume, decodeVolume, paintSphere, PAINT_FIXED, PAINT_NONE,
} from '../src/util/paint.js';
import { createTaxiMesh } from '../src/geometry/taxi.js';
import { getSkin } from '../src/geometry/skins.js';
import { propMaterial } from '../src/util/geo.js';
import SHIPPED from '../assets/skins/taxi.json' with { type: 'json' };

let passed = 0;
let total = 0;
const check = (name, ok, detail = '') => {
  total++;
  if (ok) passed++;
  else console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

// --- Codec ---------------------------------------------------------------------------------------

{
  const bytes = new Uint8Array(20 * 12 * 9 * 4);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let v = 0; v < bytes.length / 4; v++) {
    if (rand() < 0.15) for (let c = 0; c < 4; c++) bytes[v * 4 + c] = Math.floor(rand() * 256);
  }
  const back = decodeVolume(encodeVolume(bytes), new Uint8Array(bytes.length));
  check('codec round-trips a sparse volume', back.every((v, i) => v === bytes[i]));
  let threw = false;
  try { decodeVolume(encodeVolume(bytes), new Uint8Array(bytes.length + 4)); } catch { threw = true; }
  check('codec refuses a volume of the wrong size', threw);
}

// --- The shipped skin ----------------------------------------------------------------------------

const shipped = createSkin('shipped', SHIPPED);
check('shipped taxi skin decodes', shipped.bytes.length === SHIPPED.dims.reduce((p, n) => p * n, 4));

// --- Brush ---------------------------------------------------------------------------------------

{
  const skin = createSkin('scratch', blankSkin([-1, -1, -1], [1, 1, 1], 0.125));
  // A corner of a cell is as far as a point can be from that cell's centre.
  const corner = new THREE.Vector3(0.0001, 0.0001, 0.0001);
  check('a zero-radius dab paints its own cell', paintSphere(skin, corner, 0, [1, 2, 3], PAINT_FIXED) === 1);
  const n = paintSphere(skin, new THREE.Vector3(), 0.3, [9, 9, 9], PAINT_FIXED);
  check('a dab paints a ball', n > 20 && skin.painted() === n, `${n} painted`);
  paintSphere(skin, new THREE.Vector3(), 0.3, null, PAINT_NONE);
  check('erase clears the ball', skin.painted() === 0);
  check('a dab off the volume is ignored',
    paintSphere(skin, new THREE.Vector3(5, 5, 5), 0.3, [1, 1, 1], PAINT_FIXED) === 0);
}

// --- The taxi ------------------------------------------------------------------------------------

const taxi = createTaxiMesh();
const skin = getSkin('taxi');
const painted = [];
taxi.group.traverse((node) => {
  if (node.isMesh && node.geometry.attributes.paintPos
    && node.material.customProgramCacheKey().includes('-paint')) painted.push(node);
});
// Shell, two steered wheels, two door skins, boot lid, bonnet.
check('seven taxi parts read paint', painted.length === 7, `${painted.length}`);

// Every painted part's `paintPos` is where its vertices sit relative to the car with every hinge
// shut. Measured off the live transforms rather than off the constants taxi.js stamped with: each
// part's chain up to the group, with the zero scale that hides a shut door read as 1 (that is
// hiding, not geometry) and every rotation required to be identity at construction.
{
  let worst = 0;
  let rotated = 0;
  const v = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (const mesh of painted) {
    const rest = new THREE.Matrix4();
    for (let node = mesh; node && node !== taxi.group; node = node.parent) {
      if (Math.abs(node.quaternion.w) < 1 - 1e-9) rotated++;
      rest.premultiply(new THREE.Matrix4().makeTranslation(node.position));
    }
    const { position, paintPos } = mesh.geometry.attributes;
    for (let i = 0; i < position.count; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(rest);
      p.fromBufferAttribute(paintPos, i);
      worst = Math.max(worst, v.distanceTo(p));
    }
  }
  check('painted parts are built shut (no rotation at rest)', rotated === 0, `${rotated} rotated`);
  check('paintPos is each part at rest', worst < 1e-5, `off by ${worst.toExponential(2)}`);
}

// Everything paintable sits inside the volume, open or shut.
{
  const bounds = new THREE.Box3(skin.min.clone(), skin.min.clone().add(skin.uniforms.uPaintSize.value));
  let outside = 0;
  const p = new THREE.Vector3();
  for (const mesh of painted) {
    const attr = mesh.geometry.attributes.paintPos;
    for (let i = 0; i < attr.count; i++) if (!bounds.containsPoint(p.fromBufferAttribute(attr, i))) outside++;
  }
  check('the taxi fits its skin volume', outside === 0, `${outside} vertices outside`);
}

// The door. Paint the +z flank where the shut door lies, open the door, and every outward face of
// the door's skin reads the paint — while actually standing somewhere else.
//
// The skin only, below the belt line. The door's *glass* stands 0.23 off the cabin's side window
// (CAR_W * 0.43 against DOOR_Z), further than any brush reaches across, so paint on the window
// does not carry onto it — it is painted with the door open, like the inside of a real one.
{
  const saved = skin.bytes.slice();
  const flank = new THREE.Vector3(-0.6, 1.05, 0.85);
  paintSphere(skin, flank, 0.6, [200, 30, 40], PAINT_FIXED);
  taxi.setDoor(1, 1.15);
  taxi.group.updateMatrixWorld(true);
  const door = taxi.doors.find((panel) => panel.parent.position.z > 0);
  const { position, paintPos, normal } = door.geometry.attributes;
  const centroid = new THREE.Vector3();
  const live = new THREE.Vector3();
  const n = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let outward = 0;
  let hit = 0;
  let moved = Infinity;
  for (let t = 0; t < position.count; t += 3) {
    n.fromBufferAttribute(normal, t);
    if (n.z < 0.99) continue;           // the outer face only
    outward++;
    centroid.set(0, 0, 0);
    live.set(0, 0, 0);
    for (let k = 0; k < 3; k++) {
      centroid.add(tmp.fromBufferAttribute(paintPos, t + k));
      live.add(tmp.fromBufferAttribute(position, t + k));
    }
    centroid.divideScalar(3);
    if (centroid.y > 1.4) { outward--; continue; }   // the glass
    door.localToWorld(live.divideScalar(3));
    taxi.group.worldToLocal(live);
    moved = Math.min(moved, live.distanceTo(centroid));
    const sample = skin.sample(skin.surfacePoint(centroid, n));
    if (sample && sample[3] === PAINT_FIXED && sample[0] === 200) hit++;
  }
  check('an open door reads the paint of the shut flank', outward > 0 && hit === outward,
    `${hit}/${outward} outer triangles painted`);
  check('...from somewhere it is not standing', moved > 0.2, `nearest ${moved.toFixed(2)}`);
  taxi.setDoor(0, 0);
  skin.bytes.set(saved);
}

// --- The shader ----------------------------------------------------------------------------------

{
  const compile = (material) => {
    const shader = {
      uniforms: {},
      vertexShader: THREE.ShaderLib.lambert.vertexShader,
      fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
    };
    material.onBeforeCompile(shader);
    return shader;
  };
  const bare = propMaterial();
  const inked = propMaterial({ paint: skin });
  let shader = null;
  let error = '';
  try { shader = compile(inked); } catch (e) { error = e.message; }
  check('the paint patch finds every anchor in the lambert shader', shader !== null, error);
  check('a painted material samples the volume', Boolean(shader?.fragmentShader.includes('texture( tPaint')
    && shader.vertexShader.includes('vPaintPos = paintPos') && shader.uniforms.tPaint === skin.uniforms.tPaint));
  const plain = compile(bare);
  check('an unpainted material is untouched', !plain.fragmentShader.includes('tPaint')
    && !plain.vertexShader.includes('paintPos'));
  check('painted and unpainted materials key apart',
    bare.customProgramCacheKey() !== inked.customProgramCacheKey());
  check('no backtick inside the shader', !/`/.test(shader?.fragmentShader ?? '`'));
}

console.log(`${passed}/${total} checks passed`);
process.exit(passed === total ? 0 : 1);
