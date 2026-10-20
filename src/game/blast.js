import * as THREE from 'three';
import { skipWhenEmpty } from '../util/emptypools.js';
import { color } from '../palette.js';
import { unlitMaterial } from '../util/geo.js';
import { markEmissive } from './bloom.js';
import { wheelGeometry, WHEEL_R } from '../geometry/wheels.js';
import { carrySpeed, carryTravel } from '../util/carry.js';

// The crash detonation, whole. One call — `fire(x, z, tint, yaw, speed)` — puts a shockwave ring, a
// fireball and a handful of shards on the road, and a crash makes exactly two of those calls, one
// per car.
//
// It replaces a stack of four: sparks.js, smoke.js, debris.js and the `blast()` half of flames.js,
// each fired twice at two points plus a third wave on a setTimeout. That was ~60 draw calls and
// four separate physics packets — gravity, drag, restitution, friction, angular damping — to say
// one thing. Simulating a crash properly is not what makes a crash read at a fixed 3/4 camera;
// **shape and timing** are, and both were buried under the sum of four tunings.
//
// So the vocabulary here is graphic rather than physical:
//
//   - **Unlit flat colour, not Lambert.** A faceted sphere needs a light to show its facets, and
//     the sun is behind the camera. These carry no shading at all and read as silhouettes — which
//     is also what keeps a night-time wreck as bright as a golden-hour one.
//   - **Colour is the animation.** Each puff walks one ramp over its own life, hot core → flame →
//     smoke, and the puffs are staggered, so at any instant the cluster holds all three stops at
//     once. That internal structure is what the flat fill would otherwise cost, and it retires the
//     separate grey smoke plume: the fireball *becomes* the smoke.
//   - **Position is a curve, not an integration.** Puffs and rings are `origin + direction × ease(t)`
//     evaluated from scratch every frame; only the shards carry a ballistic arc, and that one is
//     closed-form too. Nothing accumulates, so nothing has a drag constant to tune, and a slow-mo
//     frame is exactly the same shape as a full-speed one. The wreck's downfield momentum is a
//     second such curve added on top (see the CARRY block below and util/carry.js) rather than a
//     velocity any of this is integrated against.
//
// Three instanced meshes, ~40 live instances at the peak of a two-car wreck.

const PUFFS_PER_BLAST = 12;
const SHARDS_PER_BLAST = 7;
const TYRES_PER_BLAST = 2;

// Two blast sites per crash and a crash ends the run, so these only ever need to hold two of each.
// Doubled anyway — the pools are ring buffers, and a wrapped slot silently truncates a burst.
// The `burn` style's afterburn feeds this pool for the whole run-end hold (see BURN_* below), which
// is what sizes it: ~24 puffs of fireball plus ~12 flame and ~12 smoke live per burning wreck.
const MAX_PUFFS = 128;
const MAX_SHARDS = 28;
const MAX_RINGS = 4;
const MAX_TYRES = 8;
const MAX_GLOWS = 4;

// Fireball. REACH is how far a puff drifts from the origin over its whole life: a two-car wreck
// spans about 4 units, and at 3.4 the two clusters overlap into one blast rather than reading as
// two bangs that happen to be adjacent.
const PUFF_LIFE = 0.95;
const PUFF_REACH = 2.8;
const PUFF_RISE = 2.6;
const PUFF_SIZE = 3.2;

// Shards. Short-lived and gone in the air — no ground bounce, no friction, no settling. Wreckage
// coming to rest on the tarmac is a detail for a camera that stays; this one pulls into a close-up
// and then cuts to the retry screen, so the pieces only ever have to sell the moment of coming
// apart.
const SHARD_LIFE = 1.25;
const SHARD_GRAVITY = 22;
const SHARD_SIZE = 0.34;
const SHARD_FLOOR = 0.2;

// Tyres. Two per car, and the one piece of the wreck that is *recognisable* — everything else here
// is an abstraction (a ring, a sphere, a squashed tetrahedron), so the eye is told a car came apart
// without being shown a single part of one. A wheel is the part that survives a real wreck intact
// and the only one small enough to keep moving after it.
//
// They are the second effect in the game whose flight has a contact with the ground — the
// roadworks cones are the first — and the same rule applies: position is a curve of `age`, never an
// integrated velocity, so nothing accumulates and a slow-motion frame is the same shape as a
// full-speed one. The bounce is a *sequence* of parabolas rather than one: each hop launches at
// TYRE_BOUNCE of the last, so hop times fall away geometrically (0.64s, 0.32s, 0.16s at these
// numbers) and the tyre reads as landing, skipping, and settling into a roll.
//
// Horizontal travel is exponential drag in closed form, `(v / DRAG) · (1 − e^-DRAG·age)`, so the
// whole flight has a finite reach — v / DRAG, about 8–11 units, which at the wreck's zoom stays in
// frame. It is spent slowly enough that the tyre is still rolling when it fades, because a tyre
// that comes to a stop and *then* disappears is a thing being deleted.
const TYRE_LIFE = 2.4;
const TYRE_GRAVITY = 22;      // as the shards, which is exaggerated: a real 9.8 arc reads as float
const TYRE_BOUNCE = 0.5;      // restitution, per hop
const TYRE_DRAG = 0.7;        // 1/s on the roll
const TYRE_HOPS = 5;          // after this many the hop is under 4cm; it is rolling, not bouncing
const TYRE_FADE = 0.3;        // last fraction of life spent fading out

// Momentum. Every one of the four effects above is launched out of a *stationary* origin, and a
// crash is not stationary — see util/carry.js for the shape of the drift and why it is a closed
// form rather than an integration. What is per-effect is how much of the taxi's speed each one
// keeps, and the ordering is about weight rather than taste:
//
//   - **Shards keep the most.** They are bits of the car, and a piece of bodywork that separates
//     from a car at 22 u/s is still doing 22 u/s a moment later. Anything much under this and the
//     shower fanned out symmetrically around a point the taxi had already driven through.
//   - **The fireball keeps rather less.** Burning fuel is buoyant gas: it goes with the wreck, but
//     it is dragged back by air the bodywork punches through. At the shards' fraction the flame
//     front outran the wreckage it came out of, which reads as a fireball being *fired* downfield.
//   - **The ring keeps least of the three.** It is the ground mark of the bang, so what it wants is
//     to stay under the fireball rather than to travel: at 0.3 the two stay concentric for the
//     0.45s the ring is alive, which is what a shockwave under a moving wreck looks like from here.
//   - **The tyres are the odd one out** — theirs is folded into the roll instead, see `fire`.
//
// Measured at a boost-speed impact (22.1 u/s), over each effect's own life: the ring drifts 2.0
// units, the fireball 4.5, and the shards 7.8 on top of their own 6–12 of fan.
const RING_CARRY = 0.30;
const PUFF_CARRY = 0.42;
const SHARD_CARRY = 0.70;
// Under the other three because it is spent on a *bearing* that is already up to 66° off the
// heading, and because a tyre has TYRE_DRAG 0.7 rather than CARRY_DRAG 1.7 to spend it against —
// so 0.28 of the taxi's speed buys the same 2.5–5.8 units of extra ground the fractions above do.
const TYRE_CARRY = 0.28;

// Shockwave. The one mark that reads instantly at this camera angle: a flat ring on the road
// projects as an ellipse spreading out from under the wreck, so the blast has a size before the
// fireball has grown into one.
const RING_LIFE = 0.45;
const RING_START = 1.2;
const RING_END = 5.5;
const RING_Y = 0.06;      // above the road paint at 0.02 and the route band at 0.03

// The big-air landing's ring (`shock`, fired from main.js off `traffic.onTaxiLand` when the drift
// launch comes down). The wreck's ring and nothing else — no fireball, no shards — because the
// fire is what says *crash*, and a landing that read as one at a glance would teach the player the
// stunt had killed them. Smaller and quicker than the wreck's flat-style 7.7: 4.6 still clears the
// 4-unit taxi by a body length on each side, which is what makes it read as a ring rather than a
// halo, and it is gone before the slam's dust has finished settling. Tinted by the caller.
const LAND_RING_END = 4.6;
const LAND_RING_LIFE = 0.38;

// Three cuts of the fireball, for comparing on a phone (`?wreck=` or the ⚙️ panel's Game section).
// The complaint they answer is that the classic one *hides the crash*: twelve puffs per car, each
// up to 4.3 units across, centred on the bodywork and held at full size for most of a second, so
// the two cars the run just ended on are behind an orange cloud for the frames the slow-mo
// stretches out. Each knob is a multiplier on the constants above, so classic is the identity.
//
//   - **quick** is the same fireball, smaller and over in a bit over half the time: the cars are
//     covered for the first instant and back in view while the camera is still pushing in.
//   - **flat** is a shockwave of fire: the puffs are squashed to under half their height, start on
//     a ring HOLE units out rather than on the car, hug the road (LIFT, RISE) and roll *outward*,
//     so the fire is a burning skirt around the wreck and the bodywork sits in the clear middle of
//     it. No core puff — the core is the one that would sit on the cars. The ring is thrown wider
//     to lead the skirt out.
//
//   - **burn** is the default, and it is flat's shape lit like the rest of the city. Flat was
//     right about *where* the fire goes and wrong about what it is made of: twelve hexagons of one
//     flat orange each, a white disc under them, and nothing on the road or the cars to say
//     anything was burning. Once the cars took real paint and the street took a sun (#547, #539)
//     that read as stickers on a photograph — "flat and cartoony" (Tyler, 2026-10-20). So:
//       - **shaded puffs** (`shade`): each facet is lit by how squarely it faces the camera, hot
//         and pale in the middle of a puff and deep at its edge, and the silhouette facets fade
//         out on the *sine* of that angle (the clouds' rim, geometry/cloud.js). Still faceted —
//         the city is — but a volume rather than a cutout. Smoke is shaded the other way: sky on
//         top, firelight underneath.
//       - **light on the road** (`glow`): an additive pool of orange under the blast, a flash and
//         then the flicker of the burn. The one thing real fire does that no amount of puff can,
//         and at night it is most of the picture.
//       - **the wrecks keep burning** (`burn`, see `burn()`): small flame tongues on each shell and
//         a dark column of smoke rising off it for the whole run-end hold, so the crash has
//         weight after the bang instead of a fireball that pops and is gone.
//       - **no shockwave ring** (`ring: 0`): the white ellipse was the most cartoon thing on
//         screen, and the glow's flash does its job — gives the bang a size on its first frame.
//     The fireball is a little taller and less squashed than flat's, because the rim fade means a
//     puff no longer has to be thin to keep the cars visible through it.
//
// Read at `fire` and stored per instance, so switching style mid-wreck cannot reshape a blast that
// is already in the air.
export const WRECK_STYLES = {
  classic: { life: 1, size: 1, reach: 1, rise: 1, lift: 1, squash: 1, hole: 0, core: true, ring: 1, shade: 0, glow: 0, burn: false },
  quick: { life: 0.55, size: 0.8, reach: 0.9, rise: 0.6, lift: 1, squash: 1, hole: 0, core: true, ring: 1, shade: 0, glow: 0, burn: false },
  flat: { life: 0.8, size: 0.85, reach: 1.25, rise: 0.12, lift: 0.3, squash: 0.42, hole: 1.6, core: false, ring: 1.4, shade: 0, glow: 0, burn: false },
  burn: { life: 0.85, size: 0.95, reach: 1.15, rise: 0.4, lift: 0.5, squash: 0.65, hole: 1.4, core: false, ring: 0, shade: 1, glow: 1, burn: true },
};
// Tyler picked flat after comparing the first three on a phone (2026-10-05); burn replaced it as the
// default (2026-10-20) and `?wreck=flat` brings it back. All four stay switchable.
export const DEFAULT_WRECK_STYLE = 'burn';

// The light on the road. GLOW_FLASH is the bang's: big, near full strength for a frame and decayed
// over GLOW_FLASH_LIFE. GLOW_BURN is the wreck's own, smaller and flickering for as long as it burns.
// Both are diameters in world units; at 1u ≈ 7.7px a 12-unit pool is most of a phone's width at
// play zoom, which is what a car fire lights at night.
const GLOW_FLASH = 13;
const GLOW_FLASH_LIFE = 0.7;
const GLOW_BURN = 8;
const GLOW_Y = 0.05;      // under the ring's 0.06, over the paint and the route band

// The afterburn (`burn`). Long enough to cover the run-end hold (2.6s) and the replay's live beat,
// tapering so it is dying down rather than switched off when the card comes up.
const BURN_LIFE = 2.8;
const BURN_FLAME_EVERY = 0.05;  // seconds between flame tongues at full strength
const BURN_SMOKE_EVERY = 0.13;
const MAX_BURNS = 4;

/**
 * Per-instance alpha. `instanceColor` is RGB only and a 4-component colour attribute takes a
 * different code path in three, so opacity has to ride its own attribute and be multiplied in by
 * hand — same recipe as dust.js and flames.js, factored to one helper because this module wants it
 * three times.
 */
function withInstanceAlpha(geometry, material, capacity) {
  const alphas = new Float32Array(capacity);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor.a *= vAlpha;');
  };
  return alphas;
}

/**
 * `withInstanceAlpha` plus the `burn` style's shading, for the fireball alone. A second per-instance
 * attribute, `aFire` = (shade, heat, underglow): `shade` 0 leaves a puff the flat unlit colour every
 * older style is drawn in, 1 lights it; `heat` blends the lit puff between fire (hot pale centre,
 * deep edge) and smoke (sky on top); `underglow` is how much firelight a smoke puff catches from
 * below.
 *
 * The facet normal comes off a screen-space derivative of the view position, which is exactly what
 * `flatShading` does — MeshBasicMaterial carries no normal of its own to interpolate, and a facet
 * is what this city is made of anyway. Its own function rather than a branch in
 * `withInstanceAlpha`, because three keys a program off `onBeforeCompile.toString()`: the ring, the
 * shards and the tyres must not share a cache key with a shader that reads an attribute they lack.
 */
function withFireShading(geometry, material, capacity) {
  const alphas = new Float32Array(capacity);
  const fire = new Float32Array(capacity * 3);
  geometry.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(alphas, 1));
  geometry.setAttribute('aFire', new THREE.InstancedBufferAttribute(fire, 3));
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aAlpha;
attribute vec3 aFire;
varying float vAlpha;
varying vec3 vFire;
varying vec3 vFireView;`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvAlpha = aAlpha;\n\tvFire = aFire;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvFireView = -mvPosition.xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vAlpha;
varying vec3 vFire;
varying vec3 vFireView;`)
      .replace('#include <dithering_fragment>', /* glsl */ `#include <dithering_fragment>
	gl_FragColor.a *= vAlpha;
	if (vFire.x > 0.0) {
		vec3 facetN = normalize(cross(dFdx(vFireView), dFdy(vFireView)));
		float facing = clamp(facetN.z, 0.0, 1.0);
		float up = dot(facetN, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz));
		vec3 base = gl_FragColor.rgb;
		// Fire: the facets square to the eye are the hot heart of the puff, the ones turning away
		// are its deeper skin. The pale lift is gated on heat so a cooling puff stops glowing.
		vec3 flame = base * mix(0.55, 1.2, facing) + vec3(1.0, 0.86, 0.55) * pow(facing, 5.0) * 0.5 * vFire.y;
		// Smoke: lit by the sky from above, and by the fire under it from below.
		vec3 soot = base * (0.7 + 0.6 * max(up, 0.0)) + vec3(1.0, 0.4, 0.1) * max(-up, 0.0) * vFire.z;
		vec3 lit = mix(soot, flame, smoothstep(0.1, 0.55, vFire.y));
		gl_FragColor.rgb = mix(base, lit, vFire.x);
		// The rim, on the sine of the angle off the view axis rather than its cosine, so the fade
		// spends its ramp across the outer facets instead of in the last sliver of the silhouette.
		float rim = sqrt(max(0.0, 1.0 - facing * facing));
		gl_FragColor.a *= mix(1.0, 1.0 - smoothstep(0.5, 0.97, rim), vFire.x);
	}`);
  };
  return { alphas, fire };
}

/** An InstancedMesh parked at zero scale, so an untouched slot draws nothing. */
function makePool(scene, geometry, material, capacity, renderOrder) {
  const mesh = skipWhenEmpty(new THREE.InstancedMesh(geometry, material, capacity));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.renderOrder = renderOrder;
  mesh.frustumCulled = false;
  const dummy = new THREE.Object3D();
  dummy.scale.setScalar(0);
  dummy.updateMatrix();
  for (let slot = 0; slot < capacity; slot++) mesh.setMatrixAt(slot, dummy.matrix);
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  return mesh;
}

export function createBlast(scene, rng) {
  // --- Shockwave ring -------------------------------------------------------
  // Fourteen segments, not a smooth circle: at the wreck zoom the flat sides are visible and the
  // ring belongs to the same faceted city as everything else.
  const ringGeo = new THREE.RingGeometry(0.8, 1, 14);
  ringGeo.rotateX(-Math.PI / 2);
  // White, with the hue on `instanceColor`: the wreck's ring is `blastRing` and a landing's is
  // whichever drift colour the kick was burning.
  const ringMat = unlitMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // Flat and laid face up, so three's two-pass draw for transparent DoubleSide (back faces, then
    // front) spent a draw and a program re-resolve every frame on a half with nothing in it. See
    // the same flag in game/skidmarks.js.
    forceSinglePass: true,
  });
  const ringAlpha = withInstanceAlpha(ringGeo, ringMat, MAX_RINGS);
  // Render orders 4/5/6 — the band the four retired effects occupied, so the crash still sits
  // above the road decals (rubber 2, dust 3) and tops out level with the tailpipe flame.
  const ringMesh = makePool(scene, ringGeo, ringMat, MAX_RINGS, 4);
  // Seeded now rather than on the first `setColorAt`: that call is what creates `instanceColor`,
  // and `USE_INSTANCING_COLOR` is part of the program, so leaving it lazy would relink the ring's
  // shader on the frame of the first wreck or landing — a stall exactly when something happens.
  const ringColor = color('blastRing');
  for (let slot = 0; slot < MAX_RINGS; slot++) ringMesh.setColorAt(slot, ringColor);

  // --- Ground glow ----------------------------------------------------------
  // The `burn` style's light on the road: a square laid flat with a radial falloff, added onto
  // whatever is under it. Additive rather than a lit light for the trap in CLAUDE.md — a PointLight
  // that only exists during a wreck changes every lit material's light count, and the frame it
  // appeared on would relink the whole city's shaders at the exact moment of the crash. A real light
  // kept in the scene at zero instead is a cost every frame of every run for one second of one. The
  // headlight cones make the same trade.
  const glowGeo = new THREE.PlaneGeometry(1, 1);
  glowGeo.rotateX(-Math.PI / 2);
  const glowMat = unlitMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glowAlpha = new Float32Array(MAX_GLOWS);
  glowGeo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(glowAlpha, 1));
  glowMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vGlow;\nvarying vec2 vGlowUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvGlow = aAlpha;\n\tvGlowUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;\nvarying vec2 vGlowUv;')
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
	float glowR = min(1.0, length(vGlowUv - 0.5) * 2.0);
	float glowK = 1.0 - glowR;
	gl_FragColor.a *= glowK * glowK * vGlow;`);
  };
  // Under the ring and the fire, over the rubber.
  const glowMesh = makePool(scene, glowGeo, glowMat, MAX_GLOWS, 3);
  const glowColor = color('blastGlow');
  for (let slot = 0; slot < MAX_GLOWS; slot++) glowMesh.setColorAt(slot, glowColor);

  // --- Shards ---------------------------------------------------------------
  // One tetrahedron, squashed per instance into plates and chunks. Four geometries' worth of
  // variety out of one, which is what lets the whole shower be a single draw call.
  const shardGeo = new THREE.TetrahedronGeometry(1, 0);
  const shardMat = new THREE.MeshLambertMaterial({
    flatShading: true,
    transparent: true,
    depthWrite: false,
  });
  const shardAlpha = withInstanceAlpha(shardGeo, shardMat, MAX_SHARDS);
  const shardMesh = makePool(scene, shardGeo, shardMat, MAX_SHARDS, 5);
  shardMesh.castShadow = true;

  // --- Tyres ----------------------------------------------------------------
  // `wheelGeometry()` unchanged, not a torus of its own: the wheel that rolls away has to be the
  // wheel that was on the car, and geometry/wheels.js is where every vehicle in the game gets one.
  // It arrives with its tyre colour already baked into the vertex attribute, hence `vertexColors`
  // — and no `instanceColor`, because a tyre is black on every car in the city.
  const tyreGeo = wheelGeometry();
  const tyreMat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    flatShading: true,
    transparent: true,
    depthWrite: false,
  });
  const tyreAlpha = withInstanceAlpha(tyreGeo, tyreMat, MAX_TYRES);
  const tyreMesh = makePool(scene, tyreGeo, tyreMat, MAX_TYRES, 5);
  // The shadow is half of what sells the bounce: a hop is about a unit of altitude, which at this
  // camera is a couple of dozen pixels of gap opening between the tyre and its own shadow and
  // closing again. Without it the arc reads as a tyre sliding up-screen.
  tyreMesh.castShadow = true;

  // --- Fireball -------------------------------------------------------------
  // Above the shards, so the core of the blast covers the pieces still inside it.
  // Detail 1, 80 facets, rather than the 20 of the older styles: under shading each facet is a
  // step of brightness, and twenty steps across a puff read as a d20. Still visibly faceted.
  const puffGeo = new THREE.IcosahedronGeometry(0.5, 1);
  const puffMat = unlitMaterial({
    transparent: true,
    depthWrite: false,
  });
  const { alphas: puffAlpha, fire: puffFire } = withFireShading(puffGeo, puffMat, MAX_PUFFS);
  const puffMesh = makePool(scene, puffGeo, puffMat, MAX_PUFFS, 6);
  // The fireball glows — see game/bloom.js. Three things about this one would each have needed
  // handling and none of them does, which is worth knowing because it is the shape most effects in
  // here have:
  //
  //   - **Its hue is `instanceColor`,** not the material's colour: `puffMat` is left white and the
  //     RAMP below is written per puff. That needs nothing, because `USE_INSTANCING_COLOR` is
  //     derived from the *mesh* rather than the material, so the pass's own material picks the ramp
  //     up on the same InstancedMesh. The white it reads off `puffMat` is the identity it
  //     multiplies.
  //   - **Its alpha is a shader patch** (`withInstanceAlpha`), and MAX_PUFFS slots are dead at any
  //     moment outside a wreck. `markEmissive` inherits a source's `onBeforeCompile`, so the dead
  //     ones stay dead rather than blooming as a permanent ball of fire at the origin.
  //   - **It is pooled**, so this marks once and `aAlpha` does the rest.
  markEmissive(puffMesh, 'blast');

  // The one ramp every puff walks, keyed on its own fraction of life. Flat stops rather than a
  // formula for the same reason the daylight keyframes are: the interesting part is the shape of
  // the hold in the middle — flash, burn, die back, grey out — and a curve smooth enough to
  // express it would spend most of its range somewhere uninteresting.
  const RAMP = [
    { at: 0.00, c: color('blastCore') },
    { at: 0.12, c: color('blastGold') },
    { at: 0.42, c: color('blastFlame') },
    { at: 0.62, c: color('blastFlame') },   // the hold: this is what the blast is *seen* as
    { at: 0.82, c: color('blastEmber') },
    { at: 1.00, c: color('blastSmoke') },
  ];

  function rampColor(out, t) {
    for (let i = 1; i < RAMP.length; i++) {
      if (t > RAMP[i].at && i < RAMP.length - 1) continue;
      const span = RAMP[i].at - RAMP[i - 1].at;
      return out.lerpColors(RAMP[i - 1].c, RAMP[i].c, Math.min(1, (t - RAMP[i - 1].at) / span));
    }
    return out.copy(RAMP[RAMP.length - 1].c);
  }

  // Ring buffers of plain state. Everything below is read straight back into a closed-form
  // position, so a slot holds where it started and how it was thrown — never where it got to.
  const puff = {
    life: new Float32Array(MAX_PUFFS),
    life0: new Float32Array(MAX_PUFFS),
    ox: new Float32Array(MAX_PUFFS),
    oy: new Float32Array(MAX_PUFFS),
    oz: new Float32Array(MAX_PUFFS),
    dx: new Float32Array(MAX_PUFFS),
    dz: new Float32Array(MAX_PUFFS),
    cx: new Float32Array(MAX_PUFFS),
    cz: new Float32Array(MAX_PUFFS),
    reach: new Float32Array(MAX_PUFFS),
    hole: new Float32Array(MAX_PUFFS),
    squash: new Float32Array(MAX_PUFFS),
    rise: new Float32Array(MAX_PUFFS),
    size: new Float32Array(MAX_PUFFS),
    shade: new Float32Array(MAX_PUFFS),
    spin: new Float32Array(MAX_PUFFS),
    tilt: new Float32Array(MAX_PUFFS),
    lit: new Float32Array(MAX_PUFFS),       // aFire.x — 0 for the older styles' flat fill
    smoke: new Float32Array(MAX_PUFFS),     // 1 for the burn's smoke column: grows, then thins out
  };
  const shard = {
    life: new Float32Array(MAX_SHARDS),
    life0: new Float32Array(MAX_SHARDS),
    ox: new Float32Array(MAX_SHARDS),
    oy: new Float32Array(MAX_SHARDS),
    oz: new Float32Array(MAX_SHARDS),
    vx: new Float32Array(MAX_SHARDS),
    vy: new Float32Array(MAX_SHARDS),
    vz: new Float32Array(MAX_SHARDS),
    cx: new Float32Array(MAX_SHARDS),
    cz: new Float32Array(MAX_SHARDS),
    wx: new Float32Array(MAX_SHARDS),
    wy: new Float32Array(MAX_SHARDS),
    wz: new Float32Array(MAX_SHARDS),
    long: new Float32Array(MAX_SHARDS),
    flat: new Float32Array(MAX_SHARDS),
    size: new Float32Array(MAX_SHARDS),
  };
  const ring = {
    life: new Float32Array(MAX_RINGS),
    ox: new Float32Array(MAX_RINGS),
    oz: new Float32Array(MAX_RINGS),
    cx: new Float32Array(MAX_RINGS),
    cz: new Float32Array(MAX_RINGS),
    end: new Float32Array(MAX_RINGS),
    life0: new Float32Array(MAX_RINGS),
    y: new Float32Array(MAX_RINGS),
  };
  const tyre = {
    life: new Float32Array(MAX_TYRES),
    life0: new Float32Array(MAX_TYRES),
    ox: new Float32Array(MAX_TYRES),
    oz: new Float32Array(MAX_TYRES),
    dx: new Float32Array(MAX_TYRES),
    dz: new Float32Array(MAX_TYRES),
    bearing: new Float32Array(MAX_TYRES),
    roll: new Float32Array(MAX_TYRES),      // ground speed at launch, u/s
    hop: new Float32Array(MAX_TYRES),       // vertical speed at launch, u/s
    lean: new Float32Array(MAX_TYRES),
  };

  const glow = {
    life: new Float32Array(MAX_GLOWS),
    life0: new Float32Array(MAX_GLOWS),
    ox: new Float32Array(MAX_GLOWS),
    oz: new Float32Array(MAX_GLOWS),
    cx: new Float32Array(MAX_GLOWS),
    cz: new Float32Array(MAX_GLOWS),
    size: new Float32Array(MAX_GLOWS),
    seed: new Float32Array(MAX_GLOWS),
    follow: new Array(MAX_GLOWS).fill(null),
  };
  // The burning wrecks — see `burn`. Few enough to be a plain list.
  const burns = [];
  const smokeColor = color('burnSmoke');
  const smokeTop = color('burnSmokeTop');
  const where = new THREE.Vector3();

  let nextGlow = 0;
  let nextPuff = 0;
  let nextShard = 0;
  let nextRing = 0;
  let nextTyre = 0;
  let style = WRECK_STYLES[DEFAULT_WRECK_STYLE];

  const dummy = new THREE.Object3D();
  const tintColor = new THREE.Color();
  const scratch = new THREE.Color();

  /**
   * One detonation at (x, z). `tint` paints that car's shards in its own paint, so a two-car wreck
   * throws two colours of wreckage and what lands is visibly two cars — the one thing the old
   * per-car debris pools were carrying that a shared pool could not.
   *
   * `yaw` is a **sim heading**, not a bearing: `sim/traffic.js` builds it as `atan2(-tz, tx)`, so
   * forward is `(cos yaw, −sin yaw)` and the bearing this module fans its tyres about is `−yaw`.
   * Both cars are given the taxi's, because the momentum that throws anything downfield is the
   * taxi's — the car it hit is doing 8 u/s to the taxi's ~19 and may not even be pointing the same
   * way. Left out, the tyres fan evenly around the wreck and half of them roll back up the road
   * the taxi came down, which reads as an explosion rather than as a collision.
   *
   * `speed` is how fast the taxi was going when it hit, in u/s, and it is what the whole burst is
   * *carried* along that heading by — see the CARRY fractions above and util/carry.js. Left at 0
   * the blast detonates on the spot, which is what every caller did before and what the lab still
   * wants: there the useful thing about a wreck is where it happened.
   */
  function fire(x, z, tint = null, yaw = 0, speed = 0) {
    // The heading as a direction in this module's (x, z): `yaw` is a sim heading, so the bearing
    // is −yaw and forward is (cos, sin) of it. Rolled once and shared by all four effects, which
    // is the point — a wreck whose parts drifted along four slightly different vectors would come
    // apart rather than travel.
    const carry = carrySpeed(speed);
    const fx = Math.cos(-yaw) * carry;
    const fz = Math.sin(-yaw) * carry;

    if (style.ring > 0) addRing(x, 0, z, fx, fz, RING_END * style.ring, RING_LIFE, ringColor);
    if (style.glow > 0) addGlow(x, z, fx * PUFF_CARRY, fz * PUFF_CARRY, GLOW_FLASH, GLOW_FLASH_LIFE, null);

    for (let k = 0; k < PUFFS_PER_BLAST; k++) {
      const slot = nextPuff;
      nextPuff = (nextPuff + 1) % MAX_PUFFS;

      // An even fan with a little jitter, rather than a free random angle. Random angles clump,
      // and a cluster with a bald side reads as a mistake at exactly the moment the camera pushes
      // in on it.
      const angle = (k / PUFFS_PER_BLAST) * Math.PI * 2 + rng.jitter(0.35);
      // The first puff is the core: it barely travels, so the middle of the fireball stays filled
      // while the rest of the cluster opens out around it.
      const core = k === 0 && style.core;
      const spread = core ? 0.12 : rng.range(0.55, 1.15);

      // A wide spread on the life, which is what staggers the colour ramp: puffs that all reach
      // the flame stop together read as one flat orange silhouette with no depth in it.
      puff.life[slot] = PUFF_LIFE * style.life * rng.range(0.6, 1.4);
      puff.life0[slot] = puff.life[slot];
      puff.ox[slot] = x + rng.jitter(0.3);
      puff.oy[slot] = (0.7 + rng.range(0, 0.8)) * style.lift;
      puff.oz[slot] = z + rng.jitter(0.3);
      puff.dx[slot] = Math.cos(angle);
      puff.dz[slot] = Math.sin(angle);
      puff.cx[slot] = fx * PUFF_CARRY;
      puff.cz[slot] = fz * PUFF_CARRY;
      puff.reach[slot] = PUFF_REACH * style.reach * spread;
      puff.hole[slot] = style.hole;
      puff.squash[slot] = style.squash;
      puff.rise[slot] = PUFF_RISE * style.rise * rng.range(0.6, 1.3);
      puff.size[slot] = PUFF_SIZE * style.size * (core ? 1.35 : rng.range(0.7, 1.15));
      // A fixed bias along the colour ramp, correlated with how far the puff is thrown: the outer
      // ones run *ahead* of the ramp and the core runs behind it, so the fireball has a pale-gold
      // heart and deepens towards its edge.
      //
      // Life alone could not produce this. The puffs still alive at any instant are the long-lived
      // ones, and they all sit at the same stop — which is why a ramp keyed on life alone, however
      // many colours were in it, rendered as one flat orange.
      puff.shade[slot] = (spread - 0.8) * 0.3 + rng.jitter(0.05);
      puff.spin[slot] = rng.range(0, Math.PI * 2);
      puff.tilt[slot] = rng.range(-1.6, 1.6);
      puff.lit[slot] = style.shade;
      puff.smoke[slot] = 0;
      puffAlpha[slot] = 1;
    }

    for (let k = 0; k < SHARDS_PER_BLAST; k++) {
      const slot = nextShard;
      nextShard = (nextShard + 1) % MAX_SHARDS;

      const angle = (k / SHARDS_PER_BLAST) * Math.PI * 2 + rng.jitter(0.5);
      const out = rng.range(5, 10);

      shard.life[slot] = SHARD_LIFE * rng.range(0.8, 1.15);
      shard.life0[slot] = shard.life[slot];
      shard.ox[slot] = x + rng.jitter(0.3);
      shard.oy[slot] = 0.9 + rng.range(0, 0.5);
      shard.oz[slot] = z + rng.jitter(0.3);
      shard.vx[slot] = Math.cos(angle) * out;
      shard.vy[slot] = rng.range(5, 9.5);
      shard.vz[slot] = Math.sin(angle) * out;
      // The fan is a straight line at constant speed (no drag on a shard — see updateShards), so
      // the carry cannot simply be added to it: at 0.7 of 22 u/s a shard would still be gaining
      // ground when its life ran out, 19 units downfield and well off the top of the frame. It
      // rides its own drag curve instead, which is bounded.
      shard.cx[slot] = fx * SHARD_CARRY;
      shard.cz[slot] = fz * SHARD_CARRY;
      shard.wx[slot] = rng.range(-9, 9);
      shard.wy[slot] = rng.range(-9, 9);
      shard.wz[slot] = rng.range(-9, 9);
      shard.long[slot] = rng.range(0.7, 1.9);
      shard.flat[slot] = rng.range(0.35, 1);
      shard.size[slot] = SHARD_SIZE * rng.range(0.7, 1.3);
      shardAlpha[slot] = 1;
      shardMesh.setColorAt(slot, tint ? tintColor.set(tint) : tintColor.set('#FFFFFF'));
    }
    if (shardMesh.instanceColor) shardMesh.instanceColor.needsUpdate = true;

    for (let k = 0; k < TYRES_PER_BLAST; k++) {
      const slot = nextTyre;
      nextTyre = (nextTyre + 1) % MAX_TYRES;

      // One either side of the heading rather than two free angles, and never straight down it:
      // two tyres rolling the same way are one tyre drawn twice, and a tyre that leaves along the
      // car's own line spends the whole shot behind the fireball it came out of.
      const side = k % 2 ? 1 : -1;
      const offset = side * rng.range(0.35, 1.15);
      const bearing = -yaw + offset;

      tyre.life[slot] = TYRE_LIFE * rng.range(0.85, 1.1);
      tyre.life0[slot] = tyre.life[slot];
      tyre.ox[slot] = x + rng.jitter(0.6);
      tyre.oz[slot] = z + rng.jitter(0.6);
      tyre.dx[slot] = Math.cos(bearing);
      tyre.dz[slot] = Math.sin(bearing);
      tyre.bearing[slot] = bearing;
      // The one effect whose momentum is *not* a separate drift vector. A tyre's ground track is
      // already a closed-form drag along its own bearing, and its spin is read straight off that
      // distance — so a carry added beside it would be distance the wheel covered without turning,
      // which is the exact "disc being spun and slid" the roll was written to avoid. Projected onto
      // the bearing instead (`cos offset`, 0.94 down to 0.41 across the fan) it is just a harder
      // launch: the tyres thrown most nearly downfield get most of it, which is also what should
      // happen. Measured at a 22.1 u/s impact: 2.5–5.8 units of extra ground, and over 400 seeds
      // the furthest tyre is 18.9 units out at 2.5s against 12.4 before — still inside the 26-unit
      // half-height the camera pulls into, which is the constraint that sizes this.
      tyre.roll[slot] = rng.range(7.5, 10) + carry * TYRE_CARRY * Math.cos(offset);
      tyre.hop[slot] = rng.range(6, 8);
      // A couple of degrees off vertical, fixed for the flight. Bolt upright, four tyres rolling
      // out of a wreck read as machined; this is the wobble of one that is going to fall over
      // eventually, without the cost of actually landing it — nothing here is on screen long
      // enough to have to.
      tyre.lean[slot] = rng.jitter(0.14);
      tyreAlpha[slot] = 1;
    }
  }

  /**
   * A pool of light on the road. `follow` makes it a burn's — it rides that object and flickers for
   * its whole life — and null a bang's, which flashes and decays where it went off.
   */
  function addGlow(x, z, cx, cz, size, life, follow) {
    const slot = nextGlow;
    nextGlow = (nextGlow + 1) % MAX_GLOWS;
    glow.life[slot] = life;
    glow.life0[slot] = life;
    glow.ox[slot] = x;
    glow.oz[slot] = z;
    glow.cx[slot] = cx;
    glow.cz[slot] = cz;
    glow.size[slot] = size;
    glow.seed[slot] = rng.range(0, 100);
    glow.follow[slot] = follow;
  }

  /**
   * Keep a wreck burning: flame tongues licking off it and a column of dark smoke rising from it,
   * for BURN_LIFE seconds, and its own flickering pool of light on the road. `object` is the wreck
   * shell game/wreckage.js is sliding, and the fire is read off its world position every frame, so
   * the flames stay on the car rather than being left behind where it was hit. `scale` sizes the
   * whole fire — the car that was hit burns a little smaller than the taxi.
   *
   * A no-op unless the style asks for it, so callers need not know which style is current.
   */
  function burn(object, { scale = 1 } = {}) {
    if (!style.burn || !object) return;
    if (burns.length >= MAX_BURNS) burns.shift();
    burns.push({ object, scale, age: 0, flame: 0.22, smoke: 0.12 });
    object.getWorldPosition(where);
    addGlow(where.x, where.z, 0, 0, GLOW_BURN * scale, BURN_LIFE, object);
  }

  /** How hard a burn is going at `age`: full through the bang and the slide, then dying down. */
  function burnStrength(age) {
    if (age < 1.1) return 1;
    return Math.max(0, 1 - (age - 1.1) / (BURN_LIFE - 1.1)) ** 0.8;
  }

  function spawnFlame(x, z, scale, strength) {
    const slot = nextPuff;
    nextPuff = (nextPuff + 1) % MAX_PUFFS;
    const angle = rng.range(0, Math.PI * 2);
    puff.life[slot] = rng.range(0.4, 0.65);
    puff.life0[slot] = puff.life[slot];
    puff.ox[slot] = x + rng.jitter(0.75) * scale;
    puff.oy[slot] = 0.75 + rng.range(0, 0.5);
    puff.oz[slot] = z + rng.jitter(0.75) * scale;
    puff.dx[slot] = Math.cos(angle);
    puff.dz[slot] = Math.sin(angle);
    puff.cx[slot] = 0;
    puff.cz[slot] = 0;
    puff.reach[slot] = rng.range(0.15, 0.5);
    puff.hole[slot] = 0;
    // Stretched rather than squashed: a tongue of flame is taller than it is wide.
    puff.squash[slot] = 1.5;
    puff.rise[slot] = rng.range(1.0, 1.8) * scale;
    puff.size[slot] = rng.range(0.7, 1.15) * scale * (0.5 + 0.5 * strength);
    // Born at the hot end of the ramp and walked through it fast — a tongue is all flame.
    puff.shade[slot] = rng.range(-0.05, 0.1);
    puff.spin[slot] = rng.range(0, Math.PI * 2);
    puff.tilt[slot] = rng.range(-0.3, 0.3);
    puff.lit[slot] = 1;
    puff.smoke[slot] = 0;
    puffAlpha[slot] = 1;
  }

  function spawnSmoke(x, z, scale) {
    const slot = nextPuff;
    nextPuff = (nextPuff + 1) % MAX_PUFFS;
    const angle = rng.range(0, Math.PI * 2);
    puff.life[slot] = rng.range(1.6, 2.2);
    puff.life0[slot] = puff.life[slot];
    puff.ox[slot] = x + rng.jitter(0.5) * scale;
    puff.oy[slot] = 1.4 + rng.range(0, 0.4);
    puff.oz[slot] = z + rng.jitter(0.5) * scale;
    puff.dx[slot] = Math.cos(angle);
    puff.dz[slot] = Math.sin(angle);
    puff.cx[slot] = 0;
    puff.cz[slot] = 0;
    puff.reach[slot] = rng.range(0.4, 1.4);
    puff.hole[slot] = 0;
    puff.squash[slot] = 1;
    puff.rise[slot] = rng.range(5, 7.5) * scale;
    puff.size[slot] = rng.range(1.9, 2.7) * scale;
    puff.shade[slot] = 0;
    puff.spin[slot] = rng.range(0, Math.PI * 2);
    puff.tilt[slot] = rng.range(-1.6, 1.6);
    puff.lit[slot] = 1;
    puff.smoke[slot] = 1;
    puffAlpha[slot] = 0;
  }

  function updateBurns(dt) {
    for (let k = burns.length - 1; k >= 0; k--) {
      const b = burns[k];
      b.age += dt;
      if (b.age >= BURN_LIFE) { burns.splice(k, 1); continue; }
      const strength = burnStrength(b.age);
      b.object.getWorldPosition(where);
      // Intervals stretched as the fire dies rather than puffs shrunk to nothing: a dying fire is
      // fewer, smaller tongues, not the same number of invisible ones.
      // Each loop is bounded by the interval it adds, so a long frame spawns a few puffs at once
      // rather than spinning: at the 0.05s dt cap that is one tongue and at most one smoke.
      b.flame -= dt;
      while (b.flame <= 0) {
        b.flame += BURN_FLAME_EVERY / Math.max(0.2, strength);
        spawnFlame(where.x, where.z, b.scale, strength);
      }
      b.smoke -= dt;
      while (b.smoke <= 0) {
        b.smoke += BURN_SMOKE_EVERY / Math.max(0.35, strength);
        spawnSmoke(where.x, where.z, b.scale);
      }
    }
  }

  function updateGlows(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_GLOWS; slot++) {
      if (glow.life[slot] <= 0) continue;
      touched = true;
      glow.life[slot] -= dt;
      const age = glow.life0[slot] - Math.max(0, glow.life[slot]);
      const t = Math.min(1, age / glow.life0[slot]);
      const follow = glow.follow[slot];
      let level;
      if (follow) {
        follow.getWorldPosition(where);
        dummy.position.set(where.x, GLOW_Y, where.z);
        // Two incommensurate sines, so the flicker never visibly repeats over its three seconds.
        const seed = glow.seed[slot];
        const flicker = 0.78 + 0.22 * Math.sin(age * 19 + seed) * Math.sin(age * 7.3 + seed * 1.7);
        level = 0.55 * Math.min(1, age / 0.35) * burnStrength(age) * flicker;
      } else {
        const drift = carryTravel(age);
        dummy.position.set(glow.ox[slot] + glow.cx[slot] * drift, GLOW_Y, glow.oz[slot] + glow.cz[slot] * drift);
        level = Math.min(1, age / 0.03) * (1 - t) ** 1.6;
      }
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(glow.size[slot], 1, glow.size[slot]);
      dummy.updateMatrix();
      glowMesh.setMatrixAt(slot, dummy.matrix);
      glowAlpha[slot] = level;
      if (glow.life[slot] <= 0) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        glowMesh.setMatrixAt(slot, dummy.matrix);
        glowAlpha[slot] = 0;
        glow.follow[slot] = null;
      }
    }
    if (touched) {
      glowMesh.instanceMatrix.needsUpdate = true;
      glowGeo.attributes.aAlpha.needsUpdate = true;
    }
  }

  function addRing(x, y, z, fx, fz, end, life, tint) {
    ring.life[nextRing] = life;
    ring.life0[nextRing] = life;
    ring.ox[nextRing] = x;
    ring.y[nextRing] = y;
    ring.oz[nextRing] = z;
    ring.cx[nextRing] = fx * RING_CARRY;
    ring.cz[nextRing] = fz * RING_CARRY;
    ring.end[nextRing] = end;
    ringMesh.setColorAt(nextRing, tint);
    ringMesh.instanceColor.needsUpdate = true;
    nextRing = (nextRing + 1) % MAX_RINGS;
  }

  /**
   * The shockwave alone, for a landing rather than a wreck — see LAND_RING_END. `y` is the height
   * of the surface it came down on (the bridge deck's, if any), `tint` a colour, and `yaw`/`speed`
   * carry it downfield exactly as `fire` carries the wreck's.
   */
  function shock(x, z, { y = 0, tint = ringColor, yaw = 0, speed = 0 } = {}) {
    const carry = carrySpeed(speed);
    addRing(x, y, z, Math.cos(-yaw) * carry, Math.sin(-yaw) * carry,
      LAND_RING_END, LAND_RING_LIFE, tintColor.set(tint));
  }

  function updatePuffs(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_PUFFS; slot++) {
      if (puff.life[slot] <= 0) continue;
      touched = true;
      puff.life[slot] -= dt;
      const age = puff.life0[slot] - Math.max(0, puff.life[slot]);
      const t = Math.min(1, age / puff.life0[slot]);

      // Punches out and eases to a stop. This is the whole of the motion — the old fireball
      // integrated a velocity against an exponential drag to arrive at the same shape.
      //
      // Two terms, and they are different curves on purpose: the fan is keyed on `t`, this puff's
      // own fraction of its own life, and the carry on `age`, real seconds. A puff rolled a short
      // life would otherwise finish its downfield travel early and hang back while its longer-lived
      // neighbours went on past it — the fireball would shear rather than move.
      // `hole` is where on the fan the puff starts: 0 for a fireball, a ring round the cars for
      // the flat style.
      const ease = 1 - (1 - t) ** 2.2;
      const drift = carryTravel(age);
      const out = puff.hole[slot] + puff.reach[slot] * ease;
      dummy.position.set(
        puff.ox[slot] + puff.dx[slot] * out + puff.cx[slot] * drift,
        puff.oy[slot] + puff.rise[slot] * ease,
        puff.oz[slot] + puff.dz[slot] * out + puff.cz[slot] * drift,
      );

      // Pop, hold, collapse. A fireball that only faded left a full-size ghost hanging over the
      // road; collapsing it is what makes the blast look like it is being drawn back in.
      // The burn's smoke is the exception: it billows — grows the whole way — and thins out over
      // the back half instead of collapsing, because smoke that is drawn back in reads as fire.
      const smoke = puff.smoke[slot];
      const env = smoke
        ? 0.3 + 0.7 * Math.sqrt(t)
        : Math.min(1, t / 0.18) * Math.min(1, (1 - t) / 0.42) ** 0.8;
      // A squashed puff keeps its tilt off: rolled, a flattened icosahedron stands its long axis
      // back up and the skirt grows spikes.
      const squash = puff.squash[slot];
      dummy.rotation.set(squash < 1 ? 0 : puff.tilt[slot] * 0.3, puff.spin[slot] + puff.tilt[slot] * t, 0);
      const s = puff.size[slot] * env;
      dummy.scale.set(s, s * squash, s);
      dummy.updateMatrix();
      puffMesh.setMatrixAt(slot, dummy.matrix);

      // Where on the ramp this puff sits: its own life, offset by its shade bias. The bias is what
      // spreads the cluster *across* the ramp rather than marching it through in lockstep, and a
      // flat unlit fill has no other source of internal structure.
      const ramp = Math.min(1, Math.max(0, t + puff.shade[slot]));
      // Soot at the base, thinning to a mid grey as it rises and mixes with air.
      if (smoke) puffMesh.setColorAt(slot, scratch.lerpColors(smokeColor, smokeTop, Math.min(1, t * 1.4)));
      else puffMesh.setColorAt(slot, rampColor(scratch, ramp));
      // Heat follows the ramp: full through the flame stops, gone by the time it reaches smoke.
      // A smoke puff carries none, and catches firelight underneath for the first half of its life
      // — the half it spends low enough over the wreck to be lit by it.
      puffFire[slot * 3] = puff.lit[slot];
      puffFire[slot * 3 + 1] = smoke ? 0 : 1 - Math.min(1, Math.max(0, (ramp - 0.55) / 0.35));
      puffFire[slot * 3 + 2] = smoke ? 0.7 * Math.max(0, 1 - t * 1.8) : 0.5;

      // Full opacity almost the whole way, so the tail *darkens* rather than thinning out. Fading
      // a still-orange puff over its last quarter turned the end of the blast into translucent
      // pink hexagons hanging over the road; the ramp above has to be allowed to reach smoke
      // before anything is taken off the alpha.
      puffAlpha[slot] = smoke
        ? 0.75 * Math.min(1, t / 0.12) * Math.min(1, (1 - t) / 0.6)
        : Math.min(1, (1 - t) / 0.15);

      if (puff.life[slot] <= 0) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        puffMesh.setMatrixAt(slot, dummy.matrix);
        puffAlpha[slot] = 0;
      }
    }
    if (touched) {
      puffMesh.instanceMatrix.needsUpdate = true;
      if (puffMesh.instanceColor) puffMesh.instanceColor.needsUpdate = true;
      puffGeo.attributes.aAlpha.needsUpdate = true;
      puffGeo.attributes.aFire.needsUpdate = true;
    }
  }

  function updateShards(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_SHARDS; slot++) {
      if (shard.life[slot] <= 0) continue;
      touched = true;
      shard.life[slot] -= dt;
      const age = shard.life0[slot] - Math.max(0, shard.life[slot]);
      const t = Math.min(1, age / shard.life0[slot]);

      // Closed-form ballistics, floored at the tarmac rather than bounced off it. A shard that
      // reaches the floor stays there for the last of its life and shrinks out where it landed.
      // The carry rides on top, on its own drag curve — so a shard keeps gaining downfield after
      // its fan has flattened out, and one that has come to rest on the road slides the last of it
      // off rather than stopping dead.
      const drift = carryTravel(age);
      dummy.position.set(
        shard.ox[slot] + shard.vx[slot] * age + shard.cx[slot] * drift,
        Math.max(SHARD_FLOOR, shard.oy[slot] + shard.vy[slot] * age - 0.5 * SHARD_GRAVITY * age * age),
        shard.oz[slot] + shard.vz[slot] * age + shard.cz[slot] * drift,
      );
      dummy.rotation.set(shard.wx[slot] * age, shard.wy[slot] * age, shard.wz[slot] * age);

      const env = Math.min(1, (1 - t) / 0.25);
      const s = shard.size[slot] * env;
      dummy.scale.set(s * shard.long[slot], s * shard.flat[slot], s);
      dummy.updateMatrix();
      shardMesh.setMatrixAt(slot, dummy.matrix);
      shardAlpha[slot] = env;

      if (shard.life[slot] <= 0) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        shardMesh.setMatrixAt(slot, dummy.matrix);
        shardAlpha[slot] = 0;
      }
    }
    if (touched) {
      shardMesh.instanceMatrix.needsUpdate = true;
      shardGeo.attributes.aAlpha.needsUpdate = true;
    }
  }

  /**
   * Where a tyre's centre is, `age` seconds after it came off. Split out because the probe checks
   * the bounce and the roll against each other, and a check written from a second copy of the
   * formula would agree with a bug in the first.
   *
   * The height is a walk down the hops: each is a parabola of its own, launched at TYRE_BOUNCE of
   * the one before, and the walk is bounded — after TYRE_HOPS the tyre is rolling, and its centre
   * sits at the contact height for the rest of its life.
   */
  function tyreAt(slot, age, out) {
    // Ground track. Closed form of an exponential drag, so the reach is finite and known.
    const travel = (tyre.roll[slot] / TYRE_DRAG) * (1 - Math.exp(-TYRE_DRAG * age));

    let speed = tyre.hop[slot];
    let hopAge = age;
    let hopTime = (2 * speed) / TYRE_GRAVITY;
    let hops = 0;
    while (hopAge > hopTime && hops < TYRE_HOPS) {
      hopAge -= hopTime;
      speed *= TYRE_BOUNCE;
      hopTime = (2 * speed) / TYRE_GRAVITY;
      hops += 1;
    }
    // A leaning wheel stands on a point closer to its axle than an upright one does: this is 0.6cm
    // at the lean rolled above, which nobody will see, and it is here so the contact is *defined*
    // rather than assumed — the probe's "no tyre through the road" check reads this floor.
    const floor = WHEEL_R * Math.cos(tyre.lean[slot]);
    const rise = hops < TYRE_HOPS
      ? Math.max(0, speed * hopAge - 0.5 * TYRE_GRAVITY * hopAge * hopAge)
      : 0;

    out.set(
      tyre.ox[slot] + tyre.dx[slot] * travel,
      floor + rise,
      tyre.oz[slot] + tyre.dz[slot] * travel,
    );
    return travel;
  }

  function updateTyres(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_TYRES; slot++) {
      if (tyre.life[slot] <= 0) continue;
      touched = true;
      tyre.life[slot] -= dt;
      const age = tyre.life0[slot] - Math.max(0, tyre.life[slot]);
      const t = Math.min(1, age / tyre.life0[slot]);

      const travel = tyreAt(slot, age, dummy.position);

      // Rolling without slipping — the spin is the distance covered over the radius, not a rate
      // picked to look right. It is what makes the tyre read as *rolling* rather than as a disc
      // being spun and slid along, and it costs nothing: the distance is already in hand. It runs
      // through the airborne stretches too, which is correct — a wheel that leaves the car spinning
      // keeps spinning, and stopping it mid-hop would read as a stall.
      //
      // Euler order YXZ, so the matrix is RY·RX·RZ and the three rotations compose in the order the
      // wheel needs them: spin about its own axle (the geometry's +z), tip it off vertical, then
      // yaw the whole thing into the direction of travel. In the default XYZ order the lean would
      // be applied in world space and the tyre would lean sideways relative to its own roll.
      dummy.rotation.set(tyre.lean[slot], -tyre.bearing[slot], travel / WHEEL_R, 'YXZ');
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      tyreMesh.setMatrixAt(slot, dummy.matrix);

      // Fade only, no shrink. A tyre that shrinks is a tyre being taken away; one that thins out
      // while it is still moving is one that got away down the street.
      tyreAlpha[slot] = Math.min(1, (1 - t) / TYRE_FADE);

      if (tyre.life[slot] <= 0) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        tyreMesh.setMatrixAt(slot, dummy.matrix);
        tyreAlpha[slot] = 0;
      }
    }
    if (touched) {
      tyreMesh.instanceMatrix.needsUpdate = true;
      tyreGeo.attributes.aAlpha.needsUpdate = true;
    }
  }

  function updateRings(dt) {
    let touched = false;
    for (let slot = 0; slot < MAX_RINGS; slot++) {
      if (ring.life[slot] <= 0) continue;
      touched = true;
      ring.life[slot] -= dt;
      const age = ring.life0[slot] - Math.max(0, ring.life[slot]);
      const t = Math.min(1, age / ring.life0[slot]);

      // Snaps out and decelerates hard — the ring is the leading edge of the bang, so all of its
      // travel belongs at the front of its life.
      const spread = RING_START + (ring.end[slot] - RING_START) * (1 - (1 - t) ** 2.6);
      const drift = carryTravel(age);
      dummy.position.set(
        ring.ox[slot] + ring.cx[slot] * drift,
        ring.y[slot] + RING_Y,
        ring.oz[slot] + ring.cz[slot] * drift,
      );
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(spread, 1, spread);
      dummy.updateMatrix();
      ringMesh.setMatrixAt(slot, dummy.matrix);
      ringAlpha[slot] = (1 - t) ** 1.1;

      if (ring.life[slot] <= 0) {
        dummy.scale.setScalar(0);
        dummy.updateMatrix();
        ringMesh.setMatrixAt(slot, dummy.matrix);
        ringAlpha[slot] = 0;
      }
    }
    if (touched) {
      ringMesh.instanceMatrix.needsUpdate = true;
      ringGeo.attributes.aAlpha.needsUpdate = true;
    }
  }

  function update(dt) {
    updateBurns(dt);
    updateGlows(dt);
    updatePuffs(dt);
    updateShards(dt);
    updateTyres(dt);
    updateRings(dt);
  }

  /** For the headless checks — how many instances are still alive, so a wreck can be shown to end. */
  function active() {
    let live = 0;
    for (let slot = 0; slot < MAX_PUFFS; slot++) if (puff.life[slot] > 0) live += 1;
    for (let slot = 0; slot < MAX_SHARDS; slot++) if (shard.life[slot] > 0) live += 1;
    for (let slot = 0; slot < MAX_TYRES; slot++) if (tyre.life[slot] > 0) live += 1;
    for (let slot = 0; slot < MAX_RINGS; slot++) if (ring.life[slot] > 0) live += 1;
    for (let slot = 0; slot < MAX_GLOWS; slot++) if (glow.life[slot] > 0) live += 1;
    return live + burns.length;
  }

  /**
   * Whether the current style wants dust.js's pale smoke collar round the wreck. The older styles
   * do — their fire is unlit and gone in a second, and the collar is what is left. The burn does
   * not: its own smoke column and the wreck still alight carry the beat after the bang, and a pale
   * translucent skirt laid over that read as panes of tinted glass round the cars.
   */
  function wantsCollar() {
    return !style.burn;
  }

  /** Which of WRECK_STYLES the *next* `fire` uses. Unknown names fall back to the default. */
  function setStyle(name) {
    style = WRECK_STYLES[name] ?? WRECK_STYLES[DEFAULT_WRECK_STYLE];
  }

  return { fire, shock, burn, wantsCollar, update, active, tyreAt, setStyle, puffMesh, shardMesh, ringMesh, tyreMesh, glowMesh };
}
