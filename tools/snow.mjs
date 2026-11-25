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

// --- The season ---------------------------------------------------------------------------------

const on = ['2026-12-01', '2026-12-25', '2027-01-01', '2027-01-06'];
const off = ['2026-11-30', '2027-01-07', '2027-07-04'];
check('snows 1 December to 6 January', on.every((d) => inSnowSeason(new Date(`${d}T12:00`)))
  && off.every((d) => !inSnowSeason(new Date(`${d}T12:00`))));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
