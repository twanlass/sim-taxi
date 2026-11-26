/**
 * Headless checks for the snowstorm (game/snow.js).
 *
 * The tracks are a map painted on the CPU, so the claims that matter can be asked of it directly:
 * a car driven down a street leaves two treads where its wheels are and nothing between them, a car
 * that teleports or flies leaves nothing, and snowfall fills a track back in over `REFILL`. Then
 * the shader side, as emitted source (nothing headless renders): every lit prop takes the cover,
 * and the water and the vehicles do not. Then the season's dates.
 *
 *   node tools/snow.mjs
 */
import * as THREE from 'three';

globalThis.window ??= { location: { search: '' } };

const { createSnow, REFILL, TRACK_EXTENT, TRACK_RES } = await import('../src/game/snow.js');
const { setSnow, propMaterial, SNOW_UNIFORMS } = await import('../src/util/geo.js');
const { inSnowSeason } = await import('../src/util/shot.js');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// --- The tracks ---------------------------------------------------------------------------------

const snow = createSnow({ pin: 1 });
check('the ground reads this storm\'s track map', SNOW_UNIFORMS.tSnowTracks.value === snow.texture
  && SNOW_UNIFORMS.uSnow.value.z === TRACK_EXTENT && SNOW_UNIFORMS.uSnow.value.y === 1);

// A car driving east (yaw 0) down z = 10, a step a frame.
const car = { x: -20, z: 10, yaw: 0, isTruck: false };
for (; car.x <= 20; car.x += 0.4) snow.stamp([car]);
const tread = Math.min(snow.trackAt(0, 10.7), snow.trackAt(0, 9.3), snow.trackAt(7.3, 10.7));
check('a driven street has a tread under each wheel', tread > 0.9, `min ${tread.toFixed(2)}`);
check('and none between the wheels', snow.trackAt(0, 10) < 0.05, `${snow.trackAt(0, 10).toFixed(2)}`);
check('and none a metre outside them', snow.trackAt(0, 11.8) < 0.05 && snow.trackAt(0, 8.2) < 0.05);
check('the tread is no wider than a tyre', snow.trackAt(0, 11.15) < 0.5, `${snow.trackAt(0, 11.15).toFixed(2)} at 0.45 out`);
check('nothing ahead of where it stopped', snow.trackAt(25, 10.7) < 0.05);

// One driving north (yaw π/2 -> forward (0, -1)), for the other axis.
const north = { x: -30, z: 20, yaw: Math.PI / 2, isTruck: false };
for (; north.z >= -20; north.z -= 0.4) snow.stamp([north]);
check('a car driving north treads either side of x', snow.trackAt(-29.3, 0) > 0.9 && snow.trackAt(-30.7, 0) > 0.9
  && snow.trackAt(-30, 0) < 0.05);

// A respawn: a jump of 40 units in one frame draws no line across the city.
const jumper = { x: -40, z: -30, yaw: 0, isTruck: false };
snow.stamp([jumper]);
jumper.x = 0;
snow.stamp([jumper]);
check('a car that teleports leaves no line', snow.trackAt(-20, -29.3) < 0.05);

// Airborne and crashed cars leave nothing.
const flyer = { x: 30, z: -40, yaw: 0, isTruck: false };
const crashed = { x: 30, z: -45, yaw: 0, isTruck: false, crashed: true };
for (let k = 0; k < 20; k++, flyer.x += 0.4, crashed.x += 0.4) snow.stamp([flyer, crashed], { airborne: (c) => (c === flyer ? 1 : 0) });
check('an airborne car leaves nothing', snow.trackAt(34, -39.3) < 0.05);
check('a crashed car leaves nothing', snow.trackAt(34, -44.3) < 0.05);

// --- Snowfall fills them in ---------------------------------------------------------------------

const before = snow.trackAt(0, 10.7);
for (let t = 0; t < REFILL / 2; t += 1 / 30) snow.update(1 / 30);
const half = snow.trackAt(0, 10.7);
for (let t = 0; t < REFILL / 2 + 1; t += 1 / 30) snow.update(1 / 30);
check('half filled in after half of REFILL', Math.abs(half - before / 2) < 0.08, `${before.toFixed(2)} -> ${half.toFixed(2)}`);
check('filled in after REFILL', snow.trackAt(0, 10.7) === 0);
check('the map is uploaded as it changes', snow.texture.version > 1, `version ${snow.texture.version}`);
check('the map covers the island', TRACK_EXTENT / TRACK_RES < 0.3, `${(TRACK_EXTENT / TRACK_RES).toFixed(3)} units a texel`);

// --- The cover, as emitted source ----------------------------------------------------------------

const compile = (material) => {
  const shader = {
    vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader,
    uniforms: {},
  };
  material.onBeforeCompile(shader);
  return { shader, key: material.customProgramCacheKey() };
};
setSnow(true);
const roof = compile(propMaterial());
check('a lit prop takes the cover', roof.shader.fragmentShader.includes('diffuseColor.rgb = snowCover')
  && roof.shader.vertexShader.includes('vSnowWorld = (modelMatrix') && roof.key.endsWith('-snow')
  && roof.shader.uniforms.uSnow === SNOW_UNIFORMS.uSnow, roof.key);
const waterMat = propMaterial({ ao: false });
waterMat.userData.snow = false;
const water = compile(waterMat);
check('water does not', !water.shader.fragmentShader.includes('snowCover') && !water.key.includes('snow'), water.key);
setSnow(false);
const dry = compile(propMaterial());
check('nothing is compiled in without snow', !dry.shader.fragmentShader.includes('snowCover') && !dry.key.includes('snow'));

// --- The holidays -------------------------------------------------------------------------------

const { treeParts, firTiers, HOLIDAY_TREE_H } = await import('../src/city/props.js');
const { createHolidayLights } = await import('../src/game/holidaylights.js');
const { makeRng } = await import('../src/util/rng.js');
const firCrowns = [];
const fir = treeParts(5, 5, makeRng(3), { fir: true, height: HOLIDAY_TREE_H, crowns: firCrowns });
const tiers = firTiers(5, 5, HOLIDAY_TREE_H);
check('the fir is a treeParts tree with a leaf-card lobe per tier', fir.length === 1 + tiers.tiers.length
  && firCrowns.length === tiers.tiers.length);
check('the fir stands its full height', Math.abs(tiers.top - HOLIDAY_TREE_H - 0.15) < 1.5, `top ${tiers.top.toFixed(2)}`);
const decks = Array.from({ length: 40 }, (_, k) => ({ cx: k * 13.1 - 200, cz: (k % 7) * 9.3, cw: 6, cd: 5, deck: 7 }));
const lights = createHolidayLights({ decks, tree: { x: 5, z: 5, ...tiers } });
const bare = createHolidayLights({ decks: [], tree: { x: 5, z: 5, ...tiers } }).count;
const strung = lights.count - bare;
// A 6 x 5 roof is 46 bulbs round; drops and shopfront rings add to the roofs that have them.
check('most roofs are strung', strung > 0.6 * 40 * 46 && strung < 40 * 46 * 3, `${strung} building bulbs`);
const lit = createHolidayLights({ crowns: Array.from({ length: 200 }, (_, k) => ({ x: k * 7, y: 4, z: 0, r: 1.2, tx: k * 7, tz: 0 })) });
check('about half the trees carry lights', lit.count > 0.25 * 200 * 10 && lit.count < 0.7 * 200 * 10, `${lit.count} crown bulbs`);
check('a star on top of the fir', lights.star && lights.star.position.y > tiers.top, `${lights.star?.position.y.toFixed(2)}`);
check('the lights are two draws', lights.meshes.length === 2);

// --- The rink -----------------------------------------------------------------------------------

const { rinkBoardParts, rinkSurface, roundRectDist } = await import('../src/city/pond.js');
const { createRink, lanePoint, laneLength } = await import('../src/game/rink.js');
const rinkPond = { shape: 'rink', x: 10, z: -5, hx: 8, hz: 3.5, rc: 1.8, bank: 0.4, r: 8 };
const rink = createRink(new THREE.Scene(), makeRng(5), rinkPond);
const ice = rinkSurface(rinkPond);
let offIce = 0;
let worstIn = -Infinity;
let touching = 0;
for (let k = 0; k < 30 * 60; k++) {
  rink.update(1 / 30);
  for (const sk of rink.skaters) {
    const d = roundRectDist(sk.holder.position.x - rinkPond.x, sk.holder.position.z - rinkPond.z, ice.hx, ice.hz, ice.rc);
    worstIn = Math.max(worstIn, d);
    if (d > -0.4) offIce += 1;
  }
  const at = rink.skaters.map((sk) => sk.holder.position);
  for (let a = 0; a < at.length; a++) for (let b = a + 1; b < at.length; b++) if (at[a].distanceTo(at[b]) < 0.8) touching += 1;
}
check('skaters on the frozen pond', rink.skaters.length >= 4, `${rink.skaters.length}`);
check('and they never skate through each other', touching === 0, `${touching} frames of two skaters within 0.8`);
check('and none of them ever reaches the boards', offIce === 0, `closest ${(-worstIn).toFixed(2)} in from the boards`);
const lane = { hx: 5, hz: 2, r: 1 };
let jump = 0;
let prev = lanePoint(lane, 0);
const L = laneLength(lane);
for (let s = 0.01; s <= L + 0.01; s += 0.01) {
  const p = lanePoint(lane, s);
  jump = Math.max(jump, Math.hypot(p.x - prev.x, p.z - prev.z));
  prev = p;
}
check('a lane runs round without a jump', jump < 0.0101, `largest step ${jump.toFixed(4)} for 0.01 of arclength`);
// The boards are wound by ExtrudeGeometry; their top faces must face up all the same.
const [wall] = rinkBoardParts(rinkPond, makeRng(2));
const pos = wall.attributes.position;
let up = 0;
let down = 0;
wall.computeBoundingBox();
const top = wall.boundingBox.max.y;
const A = new THREE.Vector3(); const B = new THREE.Vector3(); const C = new THREE.Vector3();
for (let i = 0; i < pos.count; i += 3) {
  A.fromBufferAttribute(pos, i); B.fromBufferAttribute(pos, i + 1); C.fromBufferAttribute(pos, i + 2);
  const n = B.clone().sub(A).cross(C.clone().sub(A)).normalize();
  if (Math.abs(A.y - B.y) < 1e-6 && Math.abs(A.y - C.y) < 1e-6 && Math.abs(A.y - top) < 1e-6) (n.y > 0.99 ? up++ : down++);
}
check('the boards\' top faces point at the sky', up > 0 && down === 0, `${up} up, ${down} down`);

// --- The season ---------------------------------------------------------------------------------

const on = ['2026-12-01', '2026-12-25', '2027-01-01', '2027-01-06'];
const off = ['2026-11-30', '2027-01-07', '2027-07-04'];
check('snows 1 December to 6 January', on.every((d) => inSnowSeason(new Date(`${d}T12:00`)))
  && off.every((d) => !inSnowSeason(new Date(`${d}T12:00`))));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
