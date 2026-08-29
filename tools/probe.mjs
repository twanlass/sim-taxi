/**
 * Headless simulation probe. Runs the city generators and the traffic model in Node with no
 * browser and no GL context, and asserts on invariants.
 *
 * This exists because the previous prototype proved the expensive part of the loop is *seeing*
 * results. Anything checkable as a number should be checked here in milliseconds, so screenshots
 * are spent only on questions that genuinely need eyes.
 */

import fs from 'node:fs';
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createLayout } from '../src/city/layout.js';
import {
  createGround, KERB_H, SLAB_X, SLAB_Z, SLAB_RADIUS, EDGE_FADE, PARK_EDGE, MEDIAN_EDGE,
} from '../src/city/ground.js';
import {
  createBuildings, facadeQuads, pitchedRoof, wallCeiling, SKYLINE_CEILING,
} from '../src/city/buildings.js';
import {
  createProps, parkPlots, planParkFurniture, planMedianBeds, MEDIAN_BED_ROOM,
  BENCH_LEN, STATUE_PLAZA,
} from '../src/city/props.js';
import { planPond, pondParts, pondRadiusAt, POND_WATER_Y, POND_SET } from '../src/city/pond.js';
import { createDucks } from '../src/game/ducks.js';
import { createGarage, garageSite } from '../src/city/garage.js';
import {
  createBurgerJoint, burgerSite, burgerGeometry, BURGER_R, SIGN_SPIN, VIEW_RISE, ROOF_Y,
} from '../src/city/burgerjoint.js';
import { createDriveThru } from '../src/game/drivethru.js';
import { createBurgerRun } from '../src/game/burgerrun.js';
import { createOpening, exitPath } from '../src/game/opening.js';
import { createTraffic, lightPhase, displayPhase, setPriorityJunction, getPriorityCorridor, isUnsignalised, ringAxisAt, placeCar, approachRoom, setClosedLanes, isLaneClosed, ROAD_Y, HOP_LEN, STOP_SETBACK, SIGNAL_LEAD, SIGNAL_LINGER, wheelAnchors, WHEEL_R, STEER_MAX, SPEED, CAR_LEN, CAR_W, landingBounce, BOUNCE_DUR, TRUCK_W, SPAWN_CLEARANCE,
  LOCO_DEFAULTS, locoTuning, setLocoTuning, resetLocoTuning, locoRamp, boostCruise, overdriveTop, MPH_PER_UNIT, locoWeave, locoWeaveFade } from '../src/sim/traffic.js';
import { loadLocoTuning, saveLocoTuning, clearLocoTuning } from '../src/game/locostash.js';
import { createRoadwork, BARRIER_S, CONE_ROW } from '../src/game/roadwork.js';
import { createDust } from '../src/game/dust.js';
import { barricadeParts, spoilParts, RAMP_RUN, RAMP_H, WORKS_Y, TRENCH_Y, SPLINTER_REST_Y } from '../src/geometry/roadworks.js';
import { findRoute as planRoute, setRoadworkLanes, setBlockedLanes, laneCost } from '../src/game/route.js';
import { createCollisions } from '../src/sim/collisions.js';
import { createPolice, POLICE_BUST_RANGE, BUST_ARM_INSET, sirenOn, CHASE_SPEED } from '../src/sim/police.js';
import {
  edgeGlow, sirenWash, GLOW_NEAR, GLOW_FAR, GLOW_FLOOR, SIREN_DIM,
} from '../src/game/sirenglow.js';
import {
  createFareSystem, cornerFor, cornerSeen, intersectionCentre, blockDistance, priceFor, MAX_FARES,
  ARRIVE_RADIUS, onSameBlock, CURSE_LIFT,
} from '../src/game/fares.js';
import { createCurseBubble, TAIL_DROP } from '../src/geometry/cursebubble.js';
import {
  createParcelSystem, MAX_PARCELS, PARCEL_MIN_DELIVERED, PARCEL_PAY_FACTOR, PARCEL_GAP_MIN,
  PARCEL_GAP_MAX, PARCEL_AFTER_DELIVERY, FLIGHT_MIN_ALPHA,
  PARCEL_PAD_LIFT, LIFT_TIME, TAP_MAX_DETOUR,
} from '../src/game/parcels.js';
import {
  createTargetRing, ringGrowScale, ringShrinkScale, RING_R, RING_Y,
} from '../src/geometry/targetring.js';
import { createParcelPad, PAD_R } from '../src/geometry/parcelpad.js';
import { TAXI_DECK_Y, TAXI_TAILPIPE_BACK, TAXI_TAILPIPE_HEIGHT } from '../src/geometry/taxi.js';
import { createLocoFlame } from '../src/game/locoflame.js';
import { createParcel, PARCEL_CENTRE_Y } from '../src/geometry/parcel.js';
import * as difficulty from '../src/game/difficulty.js';
import { createDestinationPin, createPassengerPin } from '../src/geometry/marker.js';
import { createPicker } from '../src/game/pick.js';
import { setCityOccluders, sightlineClear } from '../src/game/sightline.js';
import {
  createDiamond,
  bounceOffset, KICK_SCALE, KICK_HOP, RIM_SCALE, RIM_OFFSET, EMISSIVE, HIGHLIGHT_EMISSIVE,
  DIAMOND_HALF_H,
} from '../src/geometry/diamond.js';
import { CRYSTAL_TOP } from '../src/game/faremarker.js';
import { createPerson, HIGHLIGHT_EMISSIVE as RIDER_HIGHLIGHT } from '../src/geometry/person.js';
import { POP_SCALE_DIAMOND, POP_SCALE_RIDER, POP_TIME } from '../src/game/selectpop.js';
import { createTaxiMesh } from '../src/geometry/taxi.js';
import { isCarOffScreen } from '../src/game/taxifinder.js';
import { createPlaneMesh, PLANE_SPAN, PLANE_UNDERSIDE } from '../src/geometry/plane.js';
import { createFlyover, trailRoll, heading, PROP_SPIN } from '../src/game/flyover.js';
import {
  createClouds, cloudTint, screenOf, silhouetteTop, silhouetteBottom,
  KEEP_OUT, INNER_KEEP_OUT, INNER_REACH_X, INNER_REACH_Z,
  CITY_REACH_X, CITY_REACH_Z, BUILT_REACH_X, BUILT_REACH_Z, CITY_TOP, ROUND as CLOUD_ROUND,
} from '../src/game/clouds.js';
import { createHelicopterMesh, HELI_SKID_DROP, MAIN_R } from '../src/geometry/helicopter.js';
import { createChopper, CRUISE_ALT as CHOPPER_ALT, ROTOR_FLIGHT } from '../src/game/chopper.js';
import {
  birdBodyGeometry, birdWingGeometry, BIRD_LEN, BIRD_SPAN, BIRD_STAND_Y, WING_ROOT,
} from '../src/geometry/bird.js';
import {
  createBirds, bodyQuaternion, parkAreas, SETTLE_MIN, STARTLE_RANGE, SHADOW_CEILING,
} from '../src/game/birds.js';
import {
  propMaterial, unlitMaterial, setAmbientOcclusion, setCrayon, setCartoon,
  AO_UNIFORMS, CRAYON_UNIFORMS, CARTOON_UNIFORMS, BODY_EULER_ORDER,
} from '../src/util/geo.js';
import {
  AO_LAYER, markOccluder, unmarkOccluder, occluderList, RING_BROAD, RING_TIGHT, MAX_DEPTH_DIFF,
  EDGE_LOW, EDGE_HIGH,
} from '../src/game/ssao.js';
import { bakePaper, PAPER_SIZE, CRAYON_DEFAULTS } from '../src/game/crayon.js';
import {
  outlineRoot, instancedOutline, createCartoon, clampRim, outlineGeometry,
  toonOutlineMaterial, HERO_RIM, TAXI_RIM,
} from '../src/game/cartoon.js';

import { createCityEntry } from '../src/game/cityentry.js';
import {
  GHOST_MASK_ORDER, GHOST_RIM_ORDER, CAR_GHOST_MASK_ORDER, CAR_GHOST_RIM_ORDER, GHOST_REF,
  inflatedGeometry,
} from '../src/geometry/ghostoutline.js';
import {
  createCarGhosts, GHOST_RADIUS, MAX_GHOSTS, GHOST_OPACITY, FADE_BAND,
} from '../src/game/carghosts.js';
import {
  createCityCamera, attachDragPan, frameLead,
  VIEW_DIR, RIGHT, UP, DISTANCE, PLAY_ZOOM, DEPTH_PER_SCREEN_UNIT,
  LOCO_PUNCH, LOCO_PUNCH_HOLD, BILLBOARD, SCREEN_PER_WORLD_Y, VIEW_UP,
} from '../src/game/camera.js';
import {
  createScene, HAZE_TOP, hazeRange, hazeColor, hazeTuning, HAZE_SKY_H, HAZE_SATURATION,
} from '../src/game/scene.js';
import { createDaylight } from '../src/game/daylight.js';
import { URGENCY_SEGMENTS, urgencyLevel, urgencyColor, fareColor } from '../src/game/urgency.js';
import { planOrigin } from '../src/game/route.js';
import { HALF_SPAN_X, HALF_SPAN_Z, ROAD_W, LANE, PITCH, lineX, lineZ, GRID_I, GRID_J, isXAxis, leftOf, rightOf, opposite, dirSign, legalExits, riverBanks, riverRow } from '../src/city/grid.js';
import {
  waterEdges, bridgeSpan, bridgeLines, riverCrossing, archAt,
  WATER_Y, FLAT_SOFFIT, ARCH_SOFFIT, BARGE_AIR,
} from '../src/city/river.js';
import { createBridge } from '../src/geometry/bridge.js';
import { createBargeMesh, createTugMesh } from '../src/geometry/boat.js';
import { createDrawbridge } from '../src/game/drawbridge.js';
import { createBoats } from '../src/game/boats.js';
import {
  halfRoadX, halfRoadZ, laneOffX, laneOffZ, laneOffsetFor, medianRuns, MEDIAN_W,
} from '../src/city/grid.js';
import { cityNetwork } from '../src/city/roadnet.js';
import { routePath, nearestOnPath, HEAD_GAP } from '../src/game/routeline.js';
import {
  findRoute, findRouteVia, findRouteOnto, MAX_VIA_DETOUR, allIntersections,
} from '../src/game/route.js';
import { GRAB_RADIUS } from '../src/game/pathdrag.js';
import { nearestJunction, nextIntersection } from '../src/city/grid.js';
import { DIR, laneOffsetCoord } from '../src/city/grid.js';
import { PALETTE, BUILDING_COLORS } from '../src/palette.js';
import { createVanish } from '../src/game/vanish.js';
import { createBlast } from '../src/game/blast.js';
import {
  createBoost, BOOST_DURATION, BOOST_START_FRACTION, BOOST_FARE_REWARD, BOOST_PARCEL_REWARD,
  BOOST_COOLDOWN,
} from '../src/game/boost.js';
import { createBoostMeter } from '../src/game/boostmeter.js';

const seed = Number(process.argv[2] ?? 71624);
const CARS_DEFAULT = 7;    // low-density baseline for the fare-loop checks — keeps timing thresholds stable regardless of runtime default
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const time = (label, fn) => {
  const t0 = process.hrtime.bigint();
  const out = fn();
  console.log(`  ${label}: ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)}ms`);
  return out;
};

// Read a rider's diamond back the way a player does — off the material it is painted in, not by
// trusting the argument we passed in. Its colour is the whole of what that marker says now.
const diamondHex = (marker) => marker.mesh.material.color.getHexString();
// A disc, rim and fill and sweep — one mark at three weights, so they must never disagree with
// each other or with the crystal that owns them. One reader for each end of a trip: the rider's
// disc hangs off the travelling marker, the drop-off's off the slot's pin.
const riderRingHexes = (marker) => marker.ring.children.map((m) => m.material.color.getHexString());
const ringHexes = (slot) => slot.destination.ring.group.children
  .map((m) => m.material.color.getHexString());

// Slot 0's bounce phase offset — fares.js staggers the slots so two riders don't pulse in lockstep,
// and slot 0 draws the zero offset. Named here so the kick assertions can subtract the bounce out.
const PHASE_0 = 0;

const scene = new THREE.Scene();

const layout = time('layout', () => createLayout(makeRng(seed)));
const ground = time('ground', () => createGround(makeRng(seed + 11), layout));
const buildings = time('buildings', () => createBuildings(makeRng(seed + 22), layout));
const propsBuild = time('props', () => createProps(makeRng(seed + 33), layout));
const props = propsBuild.mesh;
const traffic = time('traffic init', () => createTraffic(makeRng(seed + 44), scene, 24));

const tris = (mesh) => mesh.geometry.attributes.position.count / 3;
console.log(`  triangles: ground ${tris(ground)}, buildings ${tris(buildings.mesh)}, props ${tris(props)}`);

// --- The asphalt's feathered edge -----------------------------------------
// The fade skirt is a second mesh because alpha cannot ride in the merged ground's 3-component
// colour attribute, and being a second mesh is exactly what makes it worth asserting: its inner
// ring has to land on the slab's own outline to the last bit, or a ring of sky leaks between the
// two meshes at the corner arcs, where Three's tessellation is the only thing that decides where
// the boundary actually is.
{
  const fade = ground.children.find((c) => c.name === 'asphalt-fade');
  // Signed distance to the rounded-square outline: 0 on the edge, positive outside.
  const insetX = SLAB_X / 2 - SLAB_RADIUS;
  const insetZ = SLAB_Z / 2 - SLAB_RADIUS;
  const edgeDist = (x, z) => Math.hypot(
    Math.max(Math.abs(x) - insetX, 0), Math.max(Math.abs(z) - insetZ, 0),
  ) - SLAB_RADIUS;

  const pos = fade?.geometry.attributes.position;
  const col = fade?.geometry.attributes.color;
  let seam = 0;      // how far the alpha-1 ring strays from the slab boundary
  let inside = 0;    // any part of the skirt reaching back over the road
  let reach = 0;     // how far the alpha-0 ring gets out
  for (let i = 0; pos && i < pos.count; i++) {
    const d = edgeDist(pos.getX(i), pos.getZ(i));
    inside = Math.min(inside, d);
    if (col.getW(i) === 1) seam = Math.max(seam, Math.abs(d));
    if (col.getW(i) === 0) reach = Math.max(reach, d);
  }

  check('the asphalt edge carries a fade skirt', !!fade && col?.itemSize === 4,
    fade ? `${pos.count / 3} triangles, alpha in the colour attribute` : 'missing');
  // Tolerance is float32 storage, not slop in the construction: both meshes keep their positions
  // in a Float32Array, and 62 units quantises to about 4e-6 there. Anything the geometry itself
  // got wrong lands orders of magnitude above this — and 1e-4 units is 1/1000th of a pixel.
  const FLOAT32 = 1e-4;
  check('the fade starts exactly on the slab edge', seam < FLOAT32,
    `max seam ${seam.toExponential(1)} units`);
  check('the fade reaches full transparency', Math.abs(reach - EDGE_FADE) < FLOAT32,
    `${reach.toFixed(1)} units out`);
  // Translucent asphalt over a road would show sky through the tarmac the ring road drives on.
  check('the fade never reaches back over the city', inside > -FLOAT32,
    `${inside.toExponential(1)} units inside`);
}

check('layout covers every block', layout.length === GRID_I * GRID_J, `${layout.length} blocks`);
check('some blocks are parks', layout.some((b) => b.type === 'park'),
  `${layout.filter((b) => b.type === 'park').length} parks`);

/**
 * Whether the corner pin at intersection (i, j) would stand on grass.
 *
 * Deliberately *not* `fares.onParkBlock`: this takes the world point `cornerFor` actually returns
 * and tests it against the park blocks' own bounds, so it checks where a pad ends up rather than
 * restating the index arithmetic that put it there. `cornerFor` flips its corner inward at the two
 * origin-edge lines, which is exactly the case a re-derived (i − 1, j − 1) gets wrong.
 */
const onGrass = (city, i, j) => {
  const { x, z } = cornerFor(i, j);
  return city.some((b) => b.type === 'park'
    && x >= b.bounds.x0 && x <= b.bounds.x1 && z >= b.bounds.z0 && z <= b.bounds.z1);
};

// A courier job may never stand on a park (game/parcels.js), and that is a *hard* filter — an
// unlucky city offers no box rather than a box on the grass. So the supply it draws from has to be
// checked, because the failure mode is silence: a city green enough to exhaust the non-park corners
// simply never spawns a package, with nothing logged. Swept over seeds rather than asserted on this
// one, since it is the generator's tail that would bite.
//
// Measured floor over 200 seeds is written into the message rather than into the threshold: the
// board needs two corners three blocks apart and the check wants to fail long before that.
{
  let leanest = Infinity;
  let leanestSeed = 0;
  for (let s = 0; s < 200; s++) {
    const city = createLayout(makeRng(s));
    let free = 0;
    for (let i = 0; i <= GRID_I; i++) {
      for (let j = 0; j <= GRID_J; j++) if (!onGrass(city, i, j)) free += 1;
    }
    if (free < leanest) { leanest = free; leanestSeed = s; }
  }
  // `createLayout` installs the network it bakes — put the probe's own city back. See the note at
  // the buildings sweep below, and the one at the foot of city/layout.js.
  createLayout(makeRng(seed));
  check('every city has corners for a courier job to stand on', leanest >= 16,
    `leanest ${leanest}/${(GRID_I + 1) * (GRID_J + 1)} on seed ${leanestSeed}`);
}

// --- The walk round a park --------------------------------------------------
//
// A park presents the same pavement to the street that a built block does, and the green starts
// `PARK_EDGE` inside the block's own bounds. Two things worth asserting rather than looking at.
//
// The **inset** is the one two other systems read: `city/props.js` plants trunks clear of the walk
// and `game/birds.js` keeps the flock off it, both deriving their margin from `PARK_EDGE`. A walk
// widened here without them noticing is a tree growing out of the paving.
//
// The **winding** is the standing trap: the walk is a `ShapeGeometry` with the lawn cut out of it
// as a hole, and a hole is triangulated by earcut rather than laid out in rows like a plain
// rounded rectangle. `computeVertexNormals` would launder a reversed triangle into whatever its
// neighbours say, so the normal is computed from the winding — the roadworks ramp and the courier
// pad both shipped this way round.
{
  const surfaceY = KERB_H + 0.01;
  const pos = ground.geometry.attributes.position;
  const col = ground.geometry.attributes.color;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();

  let facingDown = 0;
  let surfaceTris = 0;
  for (let t = 0; t < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    if (Math.abs(a.y - surfaceY) > 1e-4 || Math.abs(b.y - surfaceY) > 1e-4
      || Math.abs(c.y - surfaceY) > 1e-4) continue;
    n.crossVectors(b.clone().sub(a), c.clone().sub(a));
    // Earcut leaves a handful of zero-area triangles at the corners of a holed shape. They draw
    // nothing and have no normal to have got wrong; what must not appear is one facing the dirt.
    if (n.lengthSq() < 1e-12) continue;
    surfaceTris += 1;
    if (n.normalize().y < 0.999) facingDown += 1;
  }
  check('every block surface faces the sky', facingDown === 0 && surfaceTris > 0,
    `${facingDown} of ${surfaceTris} wound the wrong way`);

  // Where the green actually starts, measured off the mesh: the extent of the park-coloured
  // vertices on a park block against the block's own bounds.
  const areas = [
    ...(layout.districts ?? []).map((d) => d.bounds),
    ...layout.filter((bl) => bl.type === 'park' && (bl.districtId ?? null) === null)
      .map((bl) => bl.bounds),
  ];
  let worstGrass = 0;      // how far the grass inset strays from PARK_EDGE
  let thinnestWalk = Infinity;
  for (const area of areas) {
    let grass = Infinity;
    let paved = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      if (Math.abs(pos.getY(i) - surfaceY) > 1e-4) continue;
      if (x < area.x0 || x > area.x1 || z < area.z0 || z > area.z1) continue;
      const inset = Math.min(x - area.x0, area.x1 - x, z - area.z0, area.z1 - z);
      // Grass is the only green in the palette's block surfaces; paving is a neutral grey.
      if (col.getY(i) > col.getX(i) && col.getY(i) > col.getZ(i)) grass = Math.min(grass, inset);
      else paved = Math.min(paved, inset);
    }
    worstGrass = Math.max(worstGrass, Math.abs(grass - PARK_EDGE));
    thinnestWalk = Math.min(thinnestWalk, grass - paved);
  }
  check('a park is ringed by pavement, not grass to the kerb line', areas.length > 0
    && worstGrass < 1e-4 && thinnestWalk > 0.5,
    `${areas.length} parks · grass inset off by ${worstGrass.toExponential(1)} · walk ${thinnestWalk.toFixed(2)} wide`);
}

// --- Park furniture ---------------------------------------------------------
//
// Benches stand on the lawn a step off the walk, and there is exactly one statue in a city. Both
// are placement rules
// rather than shapes, so they are swept over seeds rather than looked at on this one: a bench half
// on the grass and a city with three statues in it are each perfectly plausible on the seed you
// happen to be looking at and wrong on the next one.
{
  let offTheGrass = 0;           // benches with any corner over the paving
  let adrift = 0;                // ...or wandered away from the walk into the middle of the lawn
  let facingOut = 0;             // benches with their back to the park
  let overlapping = 0;           // benches sharing a stretch of walk
  let statues = 0;
  let statuesOnGrass = 0;        // ...standing where a plaza fits inside the lawn
  let cities = 0;

  const SEEDS = 40;
  for (let s = 0; s < SEEDS; s++) {
    const cityLayout = createLayout(makeRng(seed + s * 37));
    const plots = parkPlots(cityLayout);
    const plan = planParkFurniture(makeRng(seed + s * 37 + 33), plots);
    if (!plots.length) continue;
    cities += 1;
    if (plan.statue) statues += 1;

    for (const bench of plan.benches) {
      const { x0, x1, z0, z1 } = bench.area.bounds;
      // The bench's own footprint, turned by its yaw: half a length along the seat, and the back
      // slat to the front edge across it.
      const cos = Math.cos(bench.yaw);
      const sin = Math.sin(bench.yaw);
      let nearest = Infinity;
      for (const ex of [-BENCH_LEN / 2, BENCH_LEN / 2]) {
        for (const ez of [-0.34, 0.31]) {
          const x = bench.x + ex * cos + ez * sin;
          const z = bench.z - ex * sin + ez * cos;
          nearest = Math.min(nearest, x - x0, x1 - x, z - z0, z1 - z);
        }
      }
      // A bench stands on the lawn just inside the walk: every corner past `PARK_EDGE`, and none
      // of them more than a bench's own depth beyond it. The far bound is the half that would
      // otherwise go unnoticed — a bench adrift in the middle of a park still passes "on grass".
      if (nearest < PARK_EDGE) offTheGrass += 1;
      if (nearest > PARK_EDGE + 1.0) adrift += 1;

      // A bench looks into the park. The seat faces local +Z, which yaw turns into the world.
      const look = { x: sin, z: cos };
      const inward = { x: (x0 + x1) / 2 - bench.x, z: (z0 + z1) / 2 - bench.z };
      if (look.x * inward.x + look.z * inward.z <= 0) facingOut += 1;
    }

    for (let a = 0; a < plan.benches.length; a++) {
      for (let b = a + 1; b < plan.benches.length; b++) {
        const gap = Math.hypot(plan.benches[a].x - plan.benches[b].x,
          plan.benches[a].z - plan.benches[b].z);
        if (gap < BENCH_LEN) overlapping += 1;
      }
    }

    if (plan.statue) {
      // The plaza has to land on lawn, not hanging over the walk: the tightest park is a pocket
      // one, 12 across, which leaves 9.7 of grass for a 3.6-unit square.
      const plot = plots.find((p) => Math.abs((p.bounds.x0 + p.bounds.x1) / 2 - plan.statue.x) < 1e-6
        && Math.abs((p.bounds.z0 + p.bounds.z1) / 2 - plan.statue.z) < 1e-6);
      const room = plot ? Math.min(plot.bounds.x1 - plot.bounds.x0, plot.bounds.z1 - plot.bounds.z0) : 0;
      if (room / 2 - PARK_EDGE < STATUE_PLAZA / 2) statuesOnGrass += 1;
    }
  }

  // Same trap as the building sweep further down: `createLayout` installs the network it bakes,
  // so a sweep leaves the probe's own city replaced by the last one it built.
  createLayout(makeRng(seed));

// --- Flower beds on the medians ----------------------------------------------
//
// The island is a stadium — a 2.4-wide capsule down the centre of an arterial — and what has to
// hold is that no bed hangs over its kerb into the carriageway. That is invisible once the props
// are merged into one mesh, which is why `planMedianBeds` is a separate function to begin with.
//
// Swept over seeds rather than looked at on one: the lateral draw is bounded by the bed's own
// radius, so it is exactly the widest bed on the narrowest island that would be the one to escape,
// and that pairing does not come up on every city.
{
  // Measured off the ground mesh's own inset, and cross-checked against the number the planner
  // bounds itself by — a bed kept inside a margin props.js invented would prove nothing.
  const grassEdge = MEDIAN_W / 2 - MEDIAN_EDGE;
  let escaped = 0;
  let tightest = Infinity;
  let beds = 0;
  let bare = 0;

  for (let city = 0; city < 12; city++) {
    createLayout(makeRng(seed + city * 53));
    const runs = medianRuns();
    for (const bed of planMedianBeds(makeRng(seed + city * 53 + 5), runs)) {
      beds += 1;
      // Distance to the island's own centre segment — the capsule's spine, which runs between the
      // two cap centres. A stadium is precisely "everywhere within R of that segment", so one
      // measurement covers the straight sides and both rounded ends.
      const run = runs.find((r) => bed.x >= r.x0 - 1 && bed.x <= r.x1 + 1
        && bed.z >= r.z0 - 1 && bed.z <= r.z1 + 1);
      if (!run) { escaped += 1; continue; }
      const along = run.axis === 'x' ? bed.x : bed.z;
      const across = run.axis === 'x' ? bed.z : bed.x;
      const spine = run.axis === 'x' ? (run.z0 + run.z1) / 2 : (run.x0 + run.x1) / 2;
      const capped = Math.min(run.to - MEDIAN_W / 2, Math.max(run.from + MEDIAN_W / 2, along));
      const room = grassEdge - (Math.hypot(along - capped, across - spine) + bed.footprint);
      tightest = Math.min(tightest, room);
      if (room < 0) escaped += 1;
    }
    if (runs.length && !planMedianBeds(makeRng(seed + city * 53 + 5), runs).length) bare += 1;
  }
  createLayout(makeRng(seed));   // `createLayout` installs its network — put the probe's city back

  check('the planner bounds itself by the grass the ground mesh actually lays',
    Math.abs(MEDIAN_BED_ROOM - grassEdge) < 1e-9,
    `props ${MEDIAN_BED_ROOM.toFixed(4)} vs ground ${grassEdge.toFixed(4)}`);
  check('every flower bed stands on its median, clear of the kerb',
    escaped === 0 && beds > 0,
    `${escaped} of ${beds} over the edge, tightest ${tightest.toFixed(3)} to spare`);
  check('and no median is left bare', bare === 0, `${bare} islands with nothing on them`);
}

// The blooms are the one place this game paints a saturated colour on something the player must
// *not* act on, so they get the clearance argument the roadworks orange gets. The urgency ramp,
// the taxi and the VIP purple can all be on the board at once; a dab of pink on a median must not
// read as any of them at 8 pixels.
{
  const hueOf = (hex) => {
    const hsl = { h: 0, s: 0, l: 0 };
    new THREE.Color(hex).getHSL(hsl);
    return hsl;
  };
  const spoken = [...PALETTE.urgency, PALETTE.taxiBody, PALETTE.vip, PALETTE.parcel,
    PALETTE.routeLine].map(hueOf);

  let nearest = 360;
  let loudest = 0;
  for (const hex of PALETTE.bloom) {
    const bloom = hueOf(hex);
    loudest = Math.max(loudest, bloom.s);
    for (const other of spoken) {
      const raw = Math.abs(bloom.h - other.h) * 360;
      nearest = Math.min(nearest, raw > 180 ? 360 - raw : raw);
    }
  }
  check('a flower bed cannot be mistaken for anything the player acts on',
    nearest > 20 && loudest < 0.75,
    `nearest game hue ${nearest.toFixed(0)}°, loudest bloom ${loudest.toFixed(2)} saturated`);
}

  check('every park bench stands on the grass, just off the walk',
    offTheGrass === 0 && adrift === 0, `${offTheGrass} on the paving, ${adrift} adrift on the lawn`);
  check('and looks into the park rather than out of it', facingOut === 0, `${facingOut} facing out`);
  check('no two benches share a stretch of walk', overlapping === 0, `${overlapping} pairs closer than a bench`);
  check('exactly one statue in a city', statues === cities, `${statues} across ${cities} cities`);
  check('and it has lawn enough for its plaza', statuesOnGrass === 0,
    `${statuesOnGrass} plazas hanging over the walk`);

  // The clearing is the other half of that: the trees are planted after the statue is placed and
  // have to keep out of its square. Read off the merged props mesh rather than off the plan —
  // every part carries its own object's ground anchor for the entrance animation (`stampEntry`),
  // so "what stands here" is a question the mesh itself can answer.
  const ownPlan = planParkFurniture(makeRng(seed + 33), parkPlots(layout));
  const entry = props.geometry.attributes.aEntry;
  // An anchor comes back out of a Float32Array, so "is this the statue's own geometry" is a
  // comparison against a rounded copy of the number that went in. It matched by luck at the
  // statue — 40 and 10 survive float32 exactly — and not at all at a bench on a 0.55 offset,
  // where every part of the bench then counted as something planted inside itself.
  const isAt = (ax, az, p) => Math.abs(ax - p.x) < 1e-4 && Math.abs(az - p.z) < 1e-4;
  let inTheClearing = 0;
  if (ownPlan.statue) {
    const clear = STATUE_PLAZA / 2 + 0.7;
    for (let i = 0; i < entry.count; i++) {
      const ax = entry.getX(i);
      const az = entry.getY(i);          // the anchor's z rides in the attribute's y
      if (Math.abs(ax - ownPlan.statue.x) > clear || Math.abs(az - ownPlan.statue.z) > clear) continue;
      if (!isAt(ax, az, ownPlan.statue)) inTheClearing += 1;
    }
  }
  check('nothing is planted in the statue\'s clearing', !!ownPlan.statue && inTheClearing === 0,
    ownPlan.statue ? `${inTheClearing} vertices of something else inside it` : 'no statue');

  // Benches share the lawn with the trees now rather than standing on the paving beside it, so the
  // planting has to miss them too. Same read, in each bench's own frame: an anchor inside a bench's
  // footprint that isn't that bench's own is a trunk coming up through the seat.
  let throughASeat = 0;
  for (const bench of ownPlan.benches) {
    const cos = Math.cos(bench.yaw);
    const sin = Math.sin(bench.yaw);
    for (let i = 0; i < entry.count; i++) {
      const ax = entry.getX(i);
      const az = entry.getY(i);
      if (isAt(ax, az, bench)) continue;
      const dx = ax - bench.x;
      const dz = az - bench.z;
      if (Math.abs(dx * cos - dz * sin) < BENCH_LEN / 2 && Math.abs(dx * sin + dz * cos) < 0.34) {
        throughASeat += 1;
      }
    }
  }
  check('and nothing stands in a bench', throughASeat === 0,
    `${throughASeat} vertices anchored inside one across ${ownPlan.benches.length} benches`);
}

// --- The duck pond -----------------------------------------------------------
//
// Exactly one a city, never in the statue's park, and every bit of it on the lawn. All three are
// placement rules and none of them is visible once the water is merged into the props mesh, which
// is why `planPond` is a function of its own — the same split `planParkFurniture` and
// `planMedianBeds` are held to, and swept over seeds for the same reason: the pond that escapes is
// the widest one on the narrowest park, and that pairing does not come up on the city you happen to
// be looking at.
{
  let cities = 0;
  let ponds = 0;
  let onTheStatuesLawn = 0;
  let overTheWalk = 0;             // any part of the circle past where the grass starts
  let inABench = 0;
  let tightest = Infinity;         // least lawn to spare between a pond's edge and the paving
  let smallest = Infinity;

  const SEEDS = 40;
  for (let s = 0; s < SEEDS; s++) {
    const cityLayout = createLayout(makeRng(seed + s * 37));
    const plots = parkPlots(cityLayout);
    if (!plots.length) continue;
    cities += 1;

    // Planned off one stream in the order `createProps` draws them, because that is the only way
    // to reproduce the pond a seed actually builds: the furniture draws first and the pond takes
    // what is left of the sequence.
    const rng = makeRng(seed + s * 37 + 33);
    const plan = planParkFurniture(rng, plots);
    const pond = planPond(rng, plots, plan.statue);
    if (!pond) continue;
    ponds += 1;
    smallest = Math.min(smallest, pond.r);

    if (plan.statue && pond.plot === plan.statue.plot) onTheStatuesLawn += 1;

    // The whole circle inside the grass: the outline never exceeds `r`, so the nearest block edge
    // less the radius is where the water gets closest to the walk round the park.
    const { x0, x1, z0, z1 } = pond.plot.bounds;
    const room = Math.min(pond.x - x0, x1 - pond.x, pond.z - z0, z1 - pond.z) - pond.r;
    tightest = Math.min(tightest, room - PARK_EDGE);
    if (room < PARK_EDGE) overTheWalk += 1;

    // And clear of the furniture standing on the same lawn. Measured in each bench's own frame
    // rather than against a radius round its centre: a bench is 1.9 by 0.645 and a circle big
    // enough to cover its ends reaches a unit out across the lawn behind it, which fails every
    // bench on the side of the park the pond is nearest without either of them touching.
    for (const bench of plan.benches) {
      const cos = Math.cos(bench.yaw);
      const sin = Math.sin(bench.yaw);
      const dx = pond.x - bench.x;
      const dz = pond.z - bench.z;
      // Distance from the pond's centre to the bench's rectangle: the overshoot past each of its
      // own half-extents, taken together.
      const along = Math.max(0, Math.abs(dx * cos - dz * sin) - BENCH_LEN / 2);
      const across = Math.max(0, Math.abs(dx * sin + dz * cos) - 0.34);
      if (Math.hypot(along, across) < pond.r) inABench += 1;
    }
  }
  createLayout(makeRng(seed));     // `createLayout` installs its network — put the probe's city back

  check('every city that can hold a pond gets exactly one', ponds === cities,
    `${ponds} across ${cities} cities, smallest ${smallest.toFixed(2)} in radius`);
  check('and it is never in the statue\'s park', onTheStatuesLawn === 0,
    `${onTheStatuesLawn} sharing a lawn with the statue`);
  check('the water lies entirely on the grass', overTheWalk === 0,
    `${overTheWalk} over the walk, tightest ${tightest.toFixed(2)} to spare`);
  check('and no bench stands in it', inABench === 0, `${inABench} benches in the water`);
}

// The pond's own geometry: two flat surfaces that have to face **up**. The water is a hand-wound
// fan — wound the other way round it is a pond lit from underneath, and `computeVertexNormals`
// would launder that into looking deliberate, which is exactly how the roadworks ramp shipped
// inside out (see CLAUDE.md). So the normal is computed from the winding rather than read off the
// normal attribute, and for every triangle rather than the first: `ShapeGeometry` is indexed, so
// walking `attributes.position` in order tests triangles that do not exist.
{
  const pondRng = makeRng(seed + 33);
  const pondPlan = planPond(pondRng, parkPlots(layout), planParkFurniture(makeRng(seed + 33), parkPlots(layout)).statue);
  let faces = 0;
  let downward = 0;
  let offLevel = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();

  if (pondPlan) {
    for (const part of pondParts(pondPlan, makeRng(seed + 7))) {
      const pos = part.attributes.position;
      const index = part.index;
      const at = (k) => (index ? index.getX(k) : k);
      const count = index ? index.count : pos.count;
      for (let i = 0; i < count; i += 3) {
        a.fromBufferAttribute(pos, at(i));
        b.fromBufferAttribute(pos, at(i + 1));
        c.fromBufferAttribute(pos, at(i + 2));
        const level = Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.y - c.y) < 1e-9;
        // `sub` writes into the vector it is called on, so the winding is taken last — reading the
        // corners back after this line reads whatever the cross product left behind.
        n.copy(b).sub(a).cross(c.sub(a));
        if (n.lengthSq() < 1e-12) continue;          // a degenerate sliver has no side to be on
        faces += 1;
        if (n.normalize().y < 0.999) downward += 1;
        if (!level) offLevel += 1;
      }
    }
  }
  check('every face of the pond points at the sky', !!pondPlan && faces > 0 && downward === 0,
    `${faces - downward}/${faces} facing up`);
  check('and the water lies level', offLevel === 0, `${offLevel} sloping triangles`);
}

// Nothing planted in the water, read off the merged mesh rather than off the plan — every part
// carries its own object's ground anchor for the entrance animation (`stampEntry`), so "what stands
// here" is a question the props mesh itself can answer. Same read as the statue's clearing above.
{
  const furniture = planParkFurniture(makeRng(seed + 33), parkPlots(layout));
  const rng = makeRng(seed + 33);
  planParkFurniture(rng, parkPlots(layout));
  const pond = planPond(rng, parkPlots(layout), furniture.statue);
  const entry = props.geometry.attributes.aEntry;
  // The furniture is not planting: a bench half a unit off the water is exactly where the pond's
  // setback puts one, and it carries an anchor like everything else in this mesh. What is being
  // counted here is *trees*, so everything the plan already accounts for is struck out first — the
  // pond's own two pieces, the benches, and the statue.
  const known = [...furniture.benches, furniture.statue, pond].filter(Boolean);
  const isAt = (ax, az, p) => Math.abs(ax - p.x) < 1e-4 && Math.abs(az - p.z) < 1e-4;
  let inTheWater = 0;
  if (pond) {
    for (let i = 0; i < entry.count; i++) {
      const ax = entry.getX(i);
      const az = entry.getY(i);          // the anchor's z rides in the attribute's y
      // A crown reaches ~1.8 past its trunk and a tree leaning over water is a tree growing out of
      // it, so the margin is the one `createProps` plants by rather than the bare radius.
      if (Math.hypot(ax - pond.x, az - pond.z) > pond.r + 1.8) continue;
      if (known.some((p) => isAt(ax, az, p))) continue;
      inTheWater += 1;
    }
  }
  check('nothing is planted in the pond', !!pond && inTheWater === 0,
    pond ? `${inTheWater} vertices of something else inside it` : 'no pond');
}

// --- The ducks on it ---------------------------------------------------------
//
// Five minutes of paddling. What has to hold is that a duck never leaves the water: the body is
// held a bird's length inside the radius the water is *guaranteed* to cover, which is what hides
// its legs under an opaque surface and keeps its tail off the bank. A duck aground is the one way
// this effect can look broken, and it would look broken for the whole run.
{
  const duckScene = new THREE.Scene();
  const furniture = planParkFurniture(makeRng(seed + 33), parkPlots(layout));
  const rng = makeRng(seed + 33);
  planParkFurniture(rng, parkPlots(layout));
  const pond = planPond(rng, parkPlots(layout), furniture.statue);
  const flotilla = createDucks(duckScene, makeRng(seed + 299), pond);

  let aground = 0;
  let stacked = 0;                 // two of them parked in the same place
  let sunk = 0;                    // ...or riding at a height the water would not hold them at
  let worst = 0;                   // the furthest any of them got from the middle
  let dabbles = 0;
  let travelled = 0;
  const was = flotilla.ducks.map((d) => ({ x: d.x, z: d.z }));

  for (let step = 0; step < 300 * 60; step++) {
    flotilla.update(1 / 60);
    for (let i = 0; i < flotilla.ducks.length; i++) {
      const duck = flotilla.ducks[i];
      const out = Math.hypot(duck.x - pond.x, duck.z - pond.z);
      worst = Math.max(worst, out);
      if (out > pond.water) aground += 1;
      if (Math.abs(duck.y - POND_WATER_Y) > 0.12) sunk += 1;
      if (duck.pitch < -0.5) dabbles += 1;
      travelled += Math.hypot(duck.x - was[i].x, duck.z - was[i].z);
      was[i] = { x: duck.x, z: duck.z };
      // Only while both are sitting: a pair crossing paths is a pond with ducks on it, and a pair
      // that has *settled* on the same spot reads as one bird.
      for (let j = i + 1; j < flotilla.ducks.length; j++) {
        const other = flotilla.ducks[j];
        if (duck.dwell <= 0 || other.dwell <= 0) continue;
        if (Math.hypot(duck.x - other.x, duck.z - other.z) < 0.55) stacked += 1;
      }
    }
  }

  check('the pond carries ducks', !!pond && flotilla.ducks.length >= 2,
    pond ? `${flotilla.ducks.length} on ${(2 * pond.r).toFixed(1)} units of water` : 'no pond');
  check('and none of them ever paddles onto the bank', aground === 0,
    `furthest out ${worst.toFixed(2)} of ${pond ? pond.water.toFixed(2) : '?'} of open water`);
  check('they sit in the surface rather than under it or over it', sunk === 0, `${sunk} frames adrift in y`);
  check('they get about, and they dabble', travelled > 20 && dabbles > 0,
    `${travelled.toFixed(0)} units paddled in 5 min, ${(dabbles / 60).toFixed(0)}s spent nose-down`);
  check('and no two of them settle in the same spot', stacked === 0, `${stacked} frames parked together`);
}

// The flock walks on the same lawns, and a pigeon crossing the pond would cross it in a straight
// line at walking pace — the one arrangement the keep-out exists to prevent. Ten minutes of it,
// with the flock pinned to the pond's own park so the test is actually asked.
{
  const walkScene = new THREE.Scene();
  const furniture = planParkFurniture(makeRng(seed + 33), parkPlots(layout));
  const rng = makeRng(seed + 33);
  planParkFurniture(rng, parkPlots(layout));
  const pond = planPond(rng, parkPlots(layout), furniture.statue);
  const keep = pond ? { x: pond.x, z: pond.z, r: pond.r + 0.7 } : null;
  const flock = createBirds(walkScene, makeRng(seed + 199), layout, { keepOut: keep ? [keep] : [] });
  // The pond's own park, by the bounds `parkAreas` hands out — settled there rather than left to
  // wander, since a flock that spends the run two parks away proves nothing.
  const home = parkAreas(layout).find((a) => pond
    && pond.x > a.x0 && pond.x < a.x1 && pond.z > a.z0 && pond.z < a.z1);
  if (home) flock.settle(home);

  let wet = 0;
  let onIt = 0;
  for (let step = 0; step < 600 * 60; step++) {
    flock.update(1 / 60);
    if (flock.state.mode !== 'ground' || flock.state.area !== home) continue;
    onIt += 1;
    for (const bird of flock.birds) {
      if (Math.hypot(bird.x - pond.x, bird.z - pond.z) < pond.r) wet += 1;
    }
  }
  check('a walking bird stops at the water rather than crossing it',
    !!home && onIt > 0 && wet === 0,
    home ? `${wet} birds in the pond over ${(onIt / 60).toFixed(0)}s on its lawn` : 'no flock on the pond\'s park');
}

// The water is a 45-pixel patch of saturated colour sitting in a park, which is the same thing a
// flower bed is and gets the same clearance argument: the urgency ramp, the taxi, the courier cyan
// and the VIP purple can all be on the board at once, and none of them may be confusable with a
// pond. Asserted here beside the blooms rather than trusted to the note in palette.js.
{
  const hueOf = (hex) => {
    const hsl = { h: 0, s: 0, l: 0 };
    new THREE.Color(hex).getHSL(hsl);
    return hsl;
  };
  const spoken = [...PALETTE.urgency, PALETTE.taxiBody, PALETTE.vip, PALETTE.parcel,
    PALETTE.routeLine].map(hueOf);
  // Luma in the space the eye reads, which is where the pond has to separate from the lawn it is
  // cut into — the trap `birdBody` documents, and worse here because this is an area rather than a
  // speck. Rec. 709 on the 8-bit channels, the same measure those palette notes are written in.
  const luma = (hex) => {
    const c = new THREE.Color(); c.setStyle(hex, THREE.SRGBColorSpace);
    const ch = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16));
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };

  let nearest = 360;
  let loudest = 0;
  for (const hex of [PALETTE.pondWater, PALETTE.pondShallow]) {
    const water = hueOf(hex);
    loudest = Math.max(loudest, water.s);
    for (const other of spoken) {
      const raw = Math.abs(water.h - other.h) * 360;
      nearest = Math.min(nearest, raw > 180 ? 360 - raw : raw);
    }
  }
  const contrast = luma(PALETTE.park) - luma(PALETTE.pondWater);
  check('a pond cannot be mistaken for anything the player acts on',
    nearest > 20 && loudest < 0.75,
    `nearest game hue ${nearest.toFixed(0)}°, loudest ${loudest.toFixed(2)} saturated`);
  check('and it reads as a hole in the lawn rather than a patch of it', contrast > 25,
    `${contrast.toFixed(0)} luma under the grass`);
}

// --- Façades ----------------------------------------------------------------
//
// Windows, shopfronts and doors are hand-wound quads rather than PlaneGeometry — a mid-rise
// carries forty of them and merging that many separate geometries costs more than the rest of the
// city put together. Hand-wound means the sign of the normal has to be *computed from the
// winding* rather than looked at: `computeVertexNormals` launders a reversed triangle into
// whatever its neighbours say, which is how the roadworks ramp shipped inside out and got
// reported as z-fighting. The expected normals are written out here rather than imported, so this
// is a second opinion on the table in buildings.js instead of a restatement of it.
{
  const OUT = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]];
  const CX = 5;
  const CZ = -7;
  const HW = 2;
  const HD = 3;
  let wound = 0;
  let sunk = 0;

  for (let side = 0; side < 4; side++) {
    const want = new THREE.Vector3(...OUT[side]);
    const geo = facadeQuads(
      [{ u: 0.4, y: 3, w: 1, h: 1.4 }, { u: -0.4, y: 6, w: 1, h: 1.4 }],
      side, CX, CZ, HW, HD, new THREE.Color(0x333333),
    );

    const normal = geo.attributes.normal;
    for (let i = 0; i < normal.count; i++) {
      const n = new THREE.Vector3(normal.getX(i), normal.getY(i), normal.getZ(i));
      if (n.dot(want) < 0.999) wound += 1;
    }

    // And every corner of it stands *outside* the wall. A quad wound correctly but placed on the
    // inward side would be a window seen from the room behind it, which back-face culling erases.
    const wall = side % 2 === 0 ? HW : HD;
    const position = geo.attributes.position;
    for (let i = 0; i < position.count; i++) {
      const offset = new THREE.Vector3(position.getX(i) - CX, 0, position.getZ(i) - CZ).dot(want);
      if (offset <= wall) sunk += 1;
    }
  }

  check('a façade faces out of the wall it is punched into', wound === 0,
    `${wound} vertices wound inward`);
  check('and every opening stands proud of it', sunk === 0,
    `${sunk} vertices at or behind the wall plane`);
}

// --- Faux window reflections ------------------------------------------------
//
// Glass is a vertex-colour gradient from `window` toward `windowSky` and nothing else — no envelope
// map, no second material, no texture. Two things about that are worth holding down.
{
  const base = new THREE.Color(PALETTE.window);
  const sky = new THREE.Color(PALETTE.windowSky);
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  // One: the gradient has to survive the bake. `bakeColors` is the only path in the project that
  // writes a colour per vertex rather than per geometry, and if it were ever flattened the windows
  // would still look perfectly fine — just flat — which is exactly the sort of regression that
  // ships. Asserted at the endpoints, where the answer is exact rather than a judgement.
  const geo = facadeQuads([{ u: 0, y: 4, w: 1, h: 1.4, g: [0, 0, 1, 1] }],
    0, 0, 0, 2, 2, base, 0.03, sky);
  const col = geo.attributes.color;
  // Vertex order within a quad is [BL, BR, TR, BL, TR, TL]: 0 is a bottom corner, 2 a top one.
  const bottom = new THREE.Color(col.getX(0), col.getY(0), col.getZ(0));
  const top = new THREE.Color(col.getX(2), col.getY(2), col.getZ(2));
  check('a pane carries a gradient rather than one flat colour',
    bottom.getHexString() === base.getHexString() && top.getHexString() === sky.getHexString(),
    `bottom #${bottom.getHexString()} → top #${top.getHexString()}`);

  // Two: a *punched* window never outshines the wall it is cut into. `windowSky` is more luminous
  // than brick (0.25 against 0.18) and than slate, so at full strength a pane on either would come
  // out brighter than the masonry around it — dark holes in a light wall becoming light patches on
  // a dark one, which loses the scale cue palette.js keeps `window` dark for in the first place.
  // Curtain walls are exempt by design and are not checked here: the glass is the wall there.
  let inverted = 0;
  const ceilings = [];
  for (const family of BUILDING_COLORS) {
    const body = new THREE.Color(PALETTE[family]);
    const t = wallCeiling(body, base, sky);
    ceilings.push(`${family} ${t.toFixed(2)}`);
    const brightest = base.clone().lerp(sky, t);
    if (lum(brightest) > lum(body)) inverted += 1;
  }
  check('a punched window never outshines its own wall', inverted === 0,
    ceilings.join(', '));
}

// --- Roofs, and the flight path over them -----------------------------------
//
// Roof furniture is the only thing in the city that can reach the aeroplane: the tallest possible
// tower is 16.4 to its parapet and the plane's belly is at 24.9 on the low side of its jitter.
// A water tower or a mast is built *conditional on fitting under* SKYLINE_CEILING rather than
// clamped to it, and this is what says the condition covers every city rather than the one seed
// the flyover check below happens to fly over.
{
  let tallest = 0;
  let tallestSeed = 0;
  let courtyards = 0;
  let manyYards = 0;
  let unplanted = 0;
  let helipads = 0;
  let pitches = 0;
  let flatOnly = 0;
  let miscounted = 0;
  let lowPads = 0;
  let cramped = 0;
  let cluttered = 0;
  let padsOffMesh = 0;
  let lowestPad = Infinity;
  const padHeights = [];
  // How much bare trunk each courtyard tree shows, and how many crowns are inside a wing.
  const courtTrunk = [];
  const courtBest = [];      // the most trunk any one tree in a city's yard shows
  let courtBuried = 0;
  // What counts as a low pad, and how many of them a sweep is allowed. A building is never shorter
  // than 5 units (`buildTower`), so a deck near six is the two-storey shop the check below exists
  // to keep the machine off. See the note over that check for why this is a rate and not a zero.
  const PAD_FLOOR = 6;
  const LOW_PAD_BUDGET = 2;
  const SEEDS = 24;
  const PAINT = new THREE.Color(PALETTE.laneMark);

  for (let s = 0; s < SEEDS; s++) {
    const cityLayout = createLayout(makeRng(seed + s * 101));
    const built = createBuildings(makeRng(seed + s * 101 + 22), cityLayout);
    built.mesh.geometry.computeBoundingBox();
    const top = built.mesh.geometry.boundingBox.max.y;
    if (top > tallest) { tallest = top; tallestSeed = s; }
    courtyards += built.courtyards;
    if (built.courtyards > 1) manyYards += 1;

    pitches += built.pitched;
    helipads += built.helipads;
    if (built.pitched === 0) flatOnly += 1;

    // The helipad's H is the only thing in the buildings mesh painted in the street's own paint,
    // so the counter above can be checked against the mesh rather than merely believed.
    const col = built.mesh.geometry.attributes.color;
    let painted = false;
    for (let i = 0; i < col.count; i += 3) {
      if (Math.abs(col.getX(i) - PAINT.r) < 1e-4 && Math.abs(col.getY(i) - PAINT.g) < 1e-4
        && Math.abs(col.getZ(i) - PAINT.b) < 1e-4) { painted = true; break; }
    }
    if (painted !== (built.helipads > 0)) miscounted += 1;

    // The pad the helicopter is sent to, checked against the mesh it is supposed to be part of
    // rather than against the numbers that produced it.
    if (built.pad) {
      const { x, z, y, r } = built.pad;
      if (y < PAD_FLOOR) lowPads += 1;
      padHeights.push(y);
      lowestPad = Math.min(lowestPad, y);
      // Wide enough for the machine's skids (2.5 by 1.24) with paint showing round them. The rotor
      // is *allowed* to overhang — a real pad on a tower of this size does exactly that — but the
      // thing has to be able to stand on it.
      if (r * 2 < 2.6) cramped += 1;

      // Nothing left standing on the circle. This is the check the whole splice in
      // `createBuildings` exists to pass: the chosen deck grew a plant room and an AC unit like
      // every other deck, and those come back out when it is picked. A vertex inside the circle and
      // more than a hand's width above the paint means one of them survived.
      const pos = built.mesh.geometry.attributes.position;
      let over = 0;
      let onPad = 0;
      for (let i = 0; i < pos.count; i++) {
        const vy = pos.getY(i);
        if (Math.hypot(pos.getX(i) - x, pos.getZ(i) - z) > r) continue;
        if (Math.abs(vy - y) < 0.12) onPad += 1;
        else if (vy > y + 0.3 && vy < y + 6) over += 1;
      }
      if (over > 0) cluttered += 1;
      // And the pad is where it says it is: the paint has to actually be in the mesh at that
      // height. A `pad` handed back for a circle that was never built would sail past every other
      // check here and strand a helicopter in mid-air.
      if (onPad === 0) padsOffMesh += 1;
    }

    // What the yard actually shows the player. A courtyard's trees are the only reason to hollow a
    // block out at all, and both ways of losing them are invisible in the code:
    //
    //   - **A crown inside a wing.** The trunk stands off the yard edge by its own crown's reach,
    //     so no part of the canopy is in a wall. It used to be planted 0.7 off it whatever it was
    //     carrying, and 71 of 91 trees over these seeds had a wing through the crown — which
    //     reads, correctly, as a shrub growing out of a roof. Checked from the placement, which is
    //     exact: this one is an invariant rather than a rate.
    //   - **No trunk showing.** Cast rather than derived. The arithmetic — a wing of height h
    //     hides everything within h / tan(33°) of its inner face, and a crown hides the top of its
    //     own trunk — is what `buildCourtyard` is built on and it is an *upper bound*: it knows
    //     nothing about the tree in front of this one. Over these seeds it reads 1.61 against a
    //     measured 0.90, and calls all 15 of the hidden trees visible. 2,275 rays is 0.7s of the
    //     probe's 26, so it pays for the real answer.
    if (built.court) {
      const { yard, trees } = built.court;
      const ray = new THREE.Raycaster();
      ray.far = 300;
      courtBest.push(0);
      for (const t of trees) {
        const N = 24;
        let seen = 0;
        for (let i = 0; i <= N; i++) {
          // Stood off along the ray, so the trunk's own skin isn't what the ray hits.
          const from = new THREE.Vector3(t.x, KERB_H + (t.trunkH * i) / N, t.z)
            .addScaledVector(VIEW_DIR, 0.3);
          ray.set(from, VIEW_DIR);
          if (ray.intersectObject(built.mesh, false).length === 0) seen += 1;
        }
        const run = (seen / (N + 1)) * t.trunkH;
        courtTrunk.push(run);
        courtBest[courtBest.length - 1] = Math.max(courtBest[courtBest.length - 1], run);
        for (const gap of [yard.x1 - t.x, yard.z1 - t.z, t.x - yard.x0, t.z - yard.z0]) {
          if (gap < t.crownReach - 1e-9) courtBuried += 1;
        }
      }
    }

    // A courtyard is a hollow block with trees in it, and the trees are the whole point — they
    // are the only green in the buildings mesh, so counting foliage-hued vertices is enough to
    // say the yard was actually planted rather than left as a hole.
    if (built.courtyards > 0) {
      const col = built.mesh.geometry.attributes.color;
      const hsl = { h: 0, s: 0, l: 0 };
      let green = 0;
      for (let i = 0; i < col.count; i += 3) {
        new THREE.Color(col.getX(i), col.getY(i), col.getZ(i)).getHSL(hsl);
        if (hsl.h > 0.2 && hsl.h < 0.45 && hsl.s > 0.15) green += 1;
      }
      if (green === 0) unplanted += 1;
    }
  }

  // `createLayout` is not a pure function: it closes segments and installs the road network it
  // just baked as *the* city network (see the note at the foot of city/layout.js). Sweeping seeds
  // therefore leaves the probe's own city replaced by whichever one came last, and every traffic
  // and routing check below silently starts measuring a different town — which is exactly what
  // happened, to the tune of eight failures with nothing to do with buildings. Rebuild the
  // probe's own layout to put its network back.
  createLayout(makeRng(seed));

  check('nothing on a roof reaches the flight path', tallest < SKYLINE_CEILING,
    `tallest ${tallest.toFixed(2)} on seed +${tallestSeed * 101}, ceiling ${SKYLINE_CEILING}`);
  // Exactly one a city, and the ceiling is the half that matters: rolled per lot it came out at
  // two or three with a tail to five, and a massing repeated five times over a 5×5 grid is not a
  // landmark, it is just what a block looks like. A city whose blocks all happened to split gets
  // none rather than a cramped one, so the floor is a rate rather than a per-seed guarantee.
  check('a city gets one courtyard block, never a district of them', manyYards === 0,
    `${courtyards} across ${SEEDS} seeds, ${manyYards} with more than one`);
  check('and nearly every city gets its one', courtyards > SEEDS * 0.85,
    `${courtyards}/${SEEDS} seeds`);
  check('and plants every one of them', unplanted === 0,
    `${unplanted} cities with a courtyard and no trees in it`);
  // Both halves of "a tree standing in a hole in a building" rather than "a green lump on a roof".
  // The bar is a *rate* because the near corner of a yard is genuinely behind its own wing and a
  // tree that lands there is meant to be hidden — what must not come back is that being the normal
  // case. With the crown at 0.55 of the height in a 6.0-unit yard it is 15 trees in 91; with it at
  // 0.42 in a 5.0-unit one it was 69 of them.
  const bareTrunk = courtTrunk.filter((t) => t < 0.05).length;
  const trunkSeen = courtTrunk.reduce((a, t) => a + t, 0) / courtTrunk.length;
  const bareYards = courtBest.filter((t) => t < 0.3).length;
  check('a courtyard tree shows its trunk',
    bareTrunk < courtTrunk.length * 0.25 && trunkSeen > 0.6,
    `${trunkSeen.toFixed(2)} of a unit on average (${(trunkSeen * SCREEN_PER_WORLD_Y * 7.7).toFixed(1)}px`
    + ` at play zoom), ${bareTrunk}/${courtTrunk.length} showing none`);
  // The per-city half of it, and the one a player would ever put into words. A yard is 3–5 trees
  // and the rate above lets a few of them hide, so this is what says no city draws the whole
  // massing with nothing but crowns showing: it was 11 cities in 24.
  check('and no city hides every one of them', bareYards === 0,
    `${bareYards}/${courtBest.length} cities with no trunk in the yard, best in yard averages `
    + `${(courtBest.reduce((a, t) => a + t, 0) / courtBest.length).toFixed(2)}`);
  check('and never grows a crown into a wing', courtBuried === 0,
    `${courtBuried} crowns inside a wall across ${courtTrunk.length} trees`);
  // A few a city, on the low masonry stock — which is most of the map, so a city with none at all
  // means the eligibility test has quietly stopped matching anything.
  check('the city builds pitched roofs', flatOnly === 0,
    `${(pitches / SEEDS).toFixed(1)} per city, ${flatOnly} cities with none`);
  // Exactly one, every city, no exceptions — the helicopter in game/chopper.js has nowhere to go
  // otherwise, and a vignette that only happens on some seeds is not a vignette. It was a coin flip
  // per eligible roof until that landed, which left 62% of cities with no pad at all.
  check('every city gets exactly one helipad', helipads === SEEDS,
    `${helipads} over ${SEEDS} seeds`);
  check('and the roof stats describe the mesh that was built', miscounted === 0,
    `${miscounted} cities whose helipad count disagrees with their paint`);
  check('the pad is where the buildings say it is', padsOffMesh === 0,
    `${padsOffMesh} cities whose pad has no paint under it`);
  // The two things the machine needs of the roof it lands on: room to stand, and a clear circle.
  check('and it is big enough to stand a helicopter on', cramped === 0,
    `${cramped} cities with a pad under 2.6 across`);
  check('and nothing is left standing on it', cluttered === 0,
    `${cluttered} cities whose pad still has roof furniture on it`);
  // It is meant to be *up there*. A pad on a two-storey shop is what picking the roomiest deck
  // instead of the tallest one does, and it reads as a car park with an H on it.
  //
  // Stated as a **median plus a budget on the tail** rather than as "no city under 6", which is
  // what it was: that form was always a coin flip, because one city in twenty-odd genuinely has no
  // flat deck above six units and which seed that is moves under any change to the block
  // footprints.
  //
  // It has now moved twice, and both times for a reason that had nothing to do with helicopters:
  //
  //   - **the arterials being widened.** Every block facing one lost 1.33 of depth, so the decks
  //     left after a tower's setbacks are narrower, fewer of them clear `PAD_MIN_SIDE`, and
  //     `choosePad` drops into its fallback more often. Over four base seeds × 24 cities the
  //     lowest pad in a sweep went 6.4 → 5.8, 7.3 → 6.8, 7.3 → 6.9, 7.3 → 6.9.
  //   - **the burger joint** (city/burgerjoint.js) taking a second whole block out of the tower
  //     generator's hands, which leaves `choosePad` 24 blocks of candidates instead of 25.
  //     Measured over 20 base seeds × 24 cities: the lowest pad anywhere went 5.44 → 5.14 and the
  //     worst sweep median 8.41 → 8.15.
  //
  // The intermediate form was a hard floor at 5.5, and it survived the second of those by 0.06 on
  // this file's own seed and nowhere else — which is the coin flip again, one decimal place down.
  // So the tail is a budget: **at most two cities in twenty-four** under `PAD_FLOOR`, against a
  // measured 1.5% over 480 cities and a worst single sweep of 1 in 24. The median is the property
  // the check was really after, and it is 8.1–9.2 on every base seed tried.
  const sorted = padHeights.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  check('and it is on a building worth landing on', lowPads <= LOW_PAD_BUDGET && median >= 8,
    `lowest pad ${lowestPad.toFixed(1)} units, ${lowPads}/${padHeights.length} under `
    + `${PAD_FLOOR} (budget ${LOW_PAD_BUDGET}), median ${median.toFixed(1)}`);
}

// --- Pitched roofs ----------------------------------------------------------
//
// A roof is nothing but sloped faces, which is exactly the shape the roadworks ramp shipped inside
// out — its slope normals came out at y = −0.98 and the only face the camera ever saw was the
// underside. So the sign is computed from the winding here rather than looked at.
//
// It has to be done on the shape itself and not on the merged city, and the reason is worth
// keeping: courtyard trees ride in the buildings mesh, and half of every canopy points downward.
// A whole-mesh sweep reported 8,847 downward faces on a city whose roofs were all correct.
{
  let underhung = 0;
  let sloped = 0;
  const shapes = new Set();

  // Enough draws to hit both branches, at footprints from square to long and thin.
  for (let n = 0; n < 40; n++) {
    const parts = [];
    const rng = makeRng(seed + n * 7919);
    pitchedRoof(parts, 3, -4, 2 + (n % 5) * 2, 3 + (n % 3) * 3, 6.2,
      new THREE.Color(PALETTE.tan), rng);
    // The eaves box is pushed first; the roof shape itself is last.
    const geo = parts[parts.length - 1];
    shapes.add(geo.attributes.position.count / 3);

    const normal = geo.attributes.normal;
    for (let i = 0; i < normal.count; i += 3) {
      const ny = normal.getY(i);
      if (ny > 0.02) sloped += 1;
      // The gable's own underside is a genuine downward face at exactly −1, hidden under the
      // building it sits on. Anything strictly between that and level is a slope on its back.
      if (ny < -0.02 && ny > -0.995) underhung += 1;
    }
    parts.forEach((g) => g.dispose());
  }

  check('a pitched roof slopes', sloped > 0, `${sloped} upward faces over 40 roofs`);
  check('and is never laid on its back', underhung === 0,
    `${underhung} faces sloping downward`);
  // 4 triangles is the hip (open-ended), 12 the gable. Both shapes have to come out of the run —
  // a branch that never fires is a shape nobody has ever seen.
  check('both a hip and a gable get built', shapes.size === 2,
    `triangle counts seen: ${[...shapes].sort((a, b) => a - b).join(', ')}`);
}
check('all cars spawned', traffic.cars.length === 24, `${traffic.cars.length}`);

// --- Run the simulation.
//
// Stepped here rather than through `traffic.warmup` so the frame-by-frame counters can be
// accumulated. `stats.moving` and `stats.waiting` are reset at the top of every `update()`, so
// reading them after a 120-second warmup samples **one frame** — and "is anybody ever stopped at a
// light" is not a question one arbitrary frame can answer. It was asked that way, and it was a
// latent flake the whole time: across five seeds somebody is stopped on 87–92% of frames, so the
// single-frame form was a coin with a 1-in-10 tails, and it finally landed tails when an unrelated
// change shifted the run by a frame.
let stoppedFrames = 0;
let simFrames = 0;
time('sim 120s', () => {
  for (let f = 0; f < 120 * 60; f++) {
    traffic.update(1 / 60);
    simFrames += 1;
    if (traffic.stats.waiting > 0) stoppedFrames += 1;
  }
});

const { stats } = traffic;
check('no car entered an intersection on red', stats.violations === 0, `${stats.violations} violations`);
check('traffic is flowing', stats.moving > traffic.cars.length * 0.35,
  `${stats.moving} moving / ${stats.waiting} waiting`);
// Measured 87–92% across five city seeds. The bar is well under that because what would mean
// something is signals having stopped *nobody* — a queue that never forms — not a few points of
// seed-to-seed drift in how busy the junctions happen to be.
check('signals actually stop people', stoppedFrames > simFrames * 0.5,
  `someone stopped on ${((stoppedFrames / simFrames) * 100).toFixed(0)}% of frames`);

// --- Positional invariants.
const positions = traffic.cars.map((c) => ({ x: c.x, z: c.z, state: c.state }));
// The outermost road centrelines sit exactly at ±HALF_SPAN_X / ±HALF_SPAN_Z, so a car in the far
// lane is legitimately LANE units beyond that. The original bound here was simply too tight.
const limitX = HALF_SPAN_X + LANE + 1;
const limitZ = HALF_SPAN_Z + LANE + 1;
const inBounds = positions.every((p) => Math.abs(p.x) <= limitX && Math.abs(p.z) <= limitZ);
check('every car is inside the city', inBounds);

// Distance from a coordinate to the nearest road centreline, and the index of that centreline.
//
// **Four functions, not two.** An `x` is measured against the roads running along Z (indexed by
// `i`) and a `z` against those running along X (indexed by `j`), and the two axes carry neither
// the same count nor the same origin now that the city has a river row on one of them. One
// function taking a bare coordinate cannot tell which it was handed, and the answer it guesses is
// wrong by half a block on the axis it guessed against.
const distToLineX = (x) => {
  let best = Infinity;
  for (let i = 0; i <= GRID_I; i++) best = Math.min(best, Math.abs(x - lineX(i)));
  return best;
};
const distToLineZ = (z) => {
  let best = Infinity;
  for (let j = 0; j <= GRID_J; j++) best = Math.min(best, Math.abs(z - lineZ(j)));
  return best;
};

/**
 * Index of the nearest road centreline. Half the positional checks below now have to ask how wide
 * the road under a point is, and an arterial's width is keyed by its line index — so a bare
 * distance is no longer enough to say whether a car is where it should be.
 */
const lineIndexX = (x) => Math.min(GRID_I, Math.max(0, Math.round((x + HALF_SPAN_X) / PITCH)));
const lineIndexZ = (z) => Math.min(GRID_J, Math.max(0, Math.round((z + HALF_SPAN_Z) / PITCH)));

// A driving car must sit on a lane centre: offset from a centreline on one axis by however far
// that road's lanes sit out — LANE on an ordinary street, further on a divided arterial — and
// somewhere along a road on the other.
const offLane = positions.filter((p) => {
  if (p.state !== 'drive') return false;
  const dx = distToLineX(p.x);
  const dz = distToLineZ(p.z);
  const onXLane = Math.abs(dz - laneOffX(lineIndexZ(p.z))) < 0.05;
  const onZLane = Math.abs(dx - laneOffZ(lineIndexX(p.x))) < 0.05;
  return !(onXLane || onZLane);
});
check('driving cars sit on lane centres', offLane.length === 0, `${offLane.length} off-lane`);

const turning = positions.filter((p) => p.state === 'turn');
// Twice the junction box, on each axis independently — a generous bound whose job is to catch a
// car flung out of the city, not to measure the arc. Per-road since the arterials were widened:
// the box a car turns inside is the *crossing* road's half-width, which is 5.33 on a main street.
const turnBound = (p) => 2 * Math.max(halfRoadZ(lineIndexX(p.x)), halfRoadX(lineIndexZ(p.z)));
const strayed = turning.filter((p) => Math.max(distToLineX(p.x), distToLineZ(p.z)) > turnBound(p));
check('turning cars are inside intersections', strayed.length === 0,
  `${strayed.length} of ${turning.length} turning outside, worst `
  + `${Math.max(0, ...turning.map((p) => Math.max(distToLineX(p.x), distToLineZ(p.z)))).toFixed(2)}`);

check('no rear-end overlaps', stats.minGap > 3.2, `min gap ${stats.minGap.toFixed(2)}`);

// --- Pairwise proximity, the check that actually catches visual overlap.
let worst = Infinity;
let worstPair = null;
for (let a = 0; a < positions.length; a++) {
  for (let b = a + 1; b < positions.length; b++) {
    const d = Math.hypot(positions[a].x - positions[b].x, positions[a].z - positions[b].z);
    if (d < worst) { worst = d; worstPair = [positions[a], positions[b]]; }
  }
}
check('no two cars occupy the same space', worst > 1.6,
  `closest pair ${worst.toFixed(2)} (${worstPair?.[0].state}/${worstPair?.[1].state})`);

// --- Front-wheel steering ---------------------------------------------------
// Render-only state, so every other assertion in this file would stay green if it broke
// completely. Three things have to hold: the wheels reach a real lock through a corner, they come
// back to straight once the car is on the straight, and they never go past full lock.
{
  const wScene = new THREE.Scene();
  const wTraffic = createTraffic(makeRng(seed + 44), wScene, 24);
  const sinceJunction = new Map();
  let maxLock = 0;
  let cornerLock = 0;
  let cockedOnStraight = 0;
  // The taxi's fronts are meshes on the group rather than instances, so they are wired up
  // separately and can be dropped separately. Read the angle back off the rig itself.
  let taxiLock = 0;
  let rigLock = 0;

  for (let step = 0; step < 60 * 60; step++) {
    wTraffic.update(1 / 60);
    taxiLock = Math.max(taxiLock, Math.abs(wTraffic.taxi.wheelAngle));
    for (const part of wTraffic.taxiGroup.children) {
      rigLock = Math.max(rigLock, Math.abs(part.rotation.y));
    }
    for (const car of wTraffic.cars) {
      if (car.crashed) continue;
      const lock = Math.abs(car.wheelAngle);
      maxLock = Math.max(maxLock, lock);

      if (car.state === 'turn') {
        sinceJunction.set(car, 0);
        // Straight on through a junction is still 'turn'; only a real corner should show lock.
        if (car.dOut !== car.d) cornerLock = Math.max(cornerLock, lock);
        continue;
      }

      const run = (sinceJunction.get(car) ?? 0) + car.v / 60;
      sinceJunction.set(car, run);
      // Six units clear of the junction, anything left is a wheel stuck over rather than one
      // still unwinding — measured, a car is under 0.2° by then.
      if (run > 6 && lock > 0.05) cockedOnStraight += 1;
    }
  }

  const asDeg = (r) => `${((r * 180) / Math.PI).toFixed(0)}°`;
  check('the front wheels reach a real lock through a corner', cornerLock > 0.3,
    `${asDeg(cornerLock)} at the tightest`);
  check('the front wheels straighten up on the straight', cockedOnStraight === 0,
    `${cockedOnStraight} frames still cocked`);
  check('the front wheels never pass full lock', maxLock <= STEER_MAX + 1e-6,
    `${asDeg(maxLock)} peak`);
  check('the taxi\'s own front wheels are steered too',
    taxiLock > 0.2 && Math.abs(rigLock - taxiLock) < 1e-9,
    `rig ${asDeg(rigLock)} vs model ${asDeg(taxiLock)}`);

  // The ambient wheels are instances composed through the car's own matrix, which nothing else
  // here exercises — a multiply the wrong way round leaves them at the world origin, or orbiting
  // the city at the car's distance from it. Checked on straight-driving cars only, so the corner
  // lean isn't in the way.
  const front = wheelAnchors().filter((anchor) => anchor.front);
  const reach = Math.hypot(front[0].x, front[0].z);
  const wheelMatrix = new THREE.Matrix4();
  const wheelPos = new THREE.Vector3();
  let adrift = 0;
  let checked = 0;
  for (const car of wTraffic.cars) {
    if (car.isTaxi || car.state !== 'drive' || car.crashed) continue;
    for (let w = 0; w < front.length; w++) {
      wTraffic.wheelMesh.getMatrixAt(car.instanceIndex * front.length + w, wheelMatrix);
      wheelPos.setFromMatrixPosition(wheelMatrix);
      checked += 1;
      const out = Math.hypot(wheelPos.x - car.x, wheelPos.z - car.z);
      if (Math.abs(out - reach) > 0.25) adrift += 1;
      else if (wheelPos.y < WHEEL_R - 0.25 || wheelPos.y > WHEEL_R + 0.45) adrift += 1;
    }
  }
  check('every front wheel is bolted to its car', adrift === 0 && checked > 0,
    `${adrift} adrift of ${checked}`);
}

// --- Police priority corridor ----------------------------------------------
// The override lives inside lightPhase, so the assertion is about signals, not about the car:
// while a corridor is live every junction on that road must show green along it and red across
// it, and no vehicle may enter on red as the corridor flips on and off.
{
  const pScene = new THREE.Scene();
  const pTraffic = createTraffic(makeRng(seed + 44), pScene, 24);
  const police = createPolice(makeRng(seed + 66), pScene);

  let activations = 0;
  let wasActive = false;
  let corridorChecks = 0;
  let corridorBad = 0;
  let crossBad = 0;

  for (let step = 0; step < 240 * 60; step++) {
    police.update(1 / 60);
    pTraffic.update(1 / 60);

    const c = getPriorityCorridor();
    if (c && !wasActive) activations += 1;
    wasActive = Boolean(c);

    if (c && step % 30 === 0) {
      const t = pTraffic.stats.time;
      // `k` walks the junctions the corridor passes, which are indexed on the *other* axis from
      // the one the line is named by: an x-running corridor sits on a j line and passes i
      // junctions.
      for (let k = 0; k <= (c.axis === 'x' ? GRID_I : GRID_J); k++) {
        const i = c.axis === 'x' ? k : c.line;
        const j = c.axis === 'x' ? c.line : k;
        const phase = lightPhase(i, j, t);
        corridorChecks += 1;
        if (phase.axis !== c.axis || phase.yellow) corridorBad += 1;

        // A junction one road over must be unaffected.
        const offLine = (c.line + 1) % ((c.axis === 'x' ? GRID_J : GRID_I) + 1);
        const offI = c.axis === 'x' ? i : offLine;
        const offJ = c.axis === 'x' ? offLine : j;
        if (lightPhase(offI, offJ, t).axis === c.axis && lightPhase(offI, offJ, t) === phase) crossBad += 1;
      }
    }
  }

  check('the police car runs corridors repeatedly', activations >= 3, `${activations} runs in 240s`);
  check('every junction on the corridor shows green along it', corridorBad === 0,
    `${corridorChecks} junction-checks`);
  check('no vehicle ran a red while corridors flipped', pTraffic.stats.violations === 0);
  check('traffic still flows with corridors active',
    pTraffic.stats.distance / pTraffic.stats.time / pTraffic.cars.length > 1,
    `${(pTraffic.stats.distance / pTraffic.stats.time / pTraffic.cars.length).toFixed(2)} units/s per car`);
}

// --- The fare's travelling clock --------------------------------------------
// The clock belongs to the fare, not to a place: one diamond waits over the rider's head and flies
// to the taxi the moment they get in. None of that is checkable from a still image, and every
// failure is silent — a marker left standing on an empty kerb, one that teleports to the car
// instead of travelling, one that stops following once it lands.
{
  const fScene = new THREE.Scene();
  const fTraffic = createTraffic(makeRng(seed + 44), fScene, 24);
  const fares = createFareSystem(makeRng(seed + 55), fScene);
  fTraffic.warmup(5);

  let marker = null;
  let overTheRider = false;
  let discUnderRider = false;
  let discMovedToDropoff = false;
  const bandFollows = [];
  let launchedFromKerb = false;
  let transferred = false;
  let landedOnTaxi = false;
  let leftTheKerb = false;
  let hiddenAfter = false;
  let kerbAtSpawn = null;
  let elapsed = 0;

  // Where the marker actually is, in the plane — its group carries the world position and the
  // crystal inside it only bounces.
  const at = () => marker.group.position;
  const distanceTo = (p) => Math.hypot(at().x - p.x, at().z - p.z);

  while (elapsed < 220 && !fares.state.gameOver) {
    fTraffic.update(1 / 60);
    const events = fares.update(1 / 60, fTraffic.taxi);
    elapsed += 1 / 60;

    const route = (fare) => {
      const r = findRoute(planOrigin(fTraffic.taxi), fare.target);
      if (r) { fTraffic.taxi.route = r; fTraffic.taxi.routeConsumed = false; fares.markDirected(fare); }
      // What the route band is painted from (main.js reads exactly these two): the fare the taxi
      // has been sent at, and the colour that fare is speaking in. A band on the wrong fare's
      // clock is a wrong answer drawn across half the city, and it is the widest object on screen.
      if (r) {
        bandFollows.push(fares.directed() === fare
          && fares.colorOf(fare).getHexString() === diamondHex(fare.slot.marker));
      }
    };

    let done = false;
    for (const { type, fare } of events) {
      if (type === 'spawned' && !marker) {
        // Follow the first fare all the way through; a later one appearing mid-ride is a
        // different assertion, made further down.
        marker = fare.slot.marker;
        kerbAtSpawn = cornerFor(fare.target.i, fare.target.j);
        // It stands over the rider from the frame they appear — this is the only thing marking
        // someone on the kerb, so a hidden one is an invisible fare.
        overTheRider = marker.group.visible && distanceTo(kerbAtSpawn) < 0.01;
        // The disc lands on the same corner, under their feet — it is the crystal's colour said
        // again on the ground, where the driving is aimed. And nothing is on the far corner yet.
        discUnderRider = marker.ring.visible
          && Math.hypot(marker.ring.position.x - kerbAtSpawn.x,
            marker.ring.position.z - kerbAtSpawn.z) < 0.01
          && new Set([...riderRingHexes(marker), diamondHex(marker)]).size === 1
          && !fare.slot.destination.group.visible;
        route(fare);
      }
      if (type === 'pickup' && fare.slot.marker === marker) {
        transferred = marker.isTransferring();
        // Launched from the corner the rider was standing on, not replanted on the car: the
        // hand-off has to read as the same object moving.
        launchedFromKerb = marker.group.visible && distanceTo(kerbAtSpawn) < 0.01;
        // ...and the disc makes the same hand-off on the ground that the crystal is making in the
        // air: the kerb corner's pulls back into its own centre as the drop-off's grows out of its
        // one, on the same frame and in one colour. A fare owns exactly one disc at a time, and two
        // at full size at once would read as two fares.
        //
        // Asserted on the *animations* rather than on `visible`, which is what this check used to
        // read: the kerb disc now takes RING_SHRINK_TIME to go, so it is still visible on this frame
        // and only its scale says it is leaving. `isLeaving()` is that state, and the pair of them —
        // one leaving, one arriving — is the hand-off.
        discMovedToDropoff = marker.ringLeaving()
          && fare.slot.destination.group.visible
          && new Set([...ringHexes(fare.slot), diamondHex(marker)]).size === 1;
        route(fare);
      }
      // The run may end on the clock rather than a delivery; the marker must clear either way.
      if ((type === 'delivered' || type === 'failed') && fare.slot.marker === marker) {
        hiddenAfter = !marker.group.visible;
        done = true;
      }
    }
    if (done) break;

    const carried = fares.carrying();
    if (transferred && carried?.slot.marker === marker) {
      // Mid-flight it is neither on the kerb nor on the car — that is what makes it a flight.
      if (marker.isTransferring() && distanceTo(kerbAtSpawn) > 1 && distanceTo(fTraffic.taxi) > 1) {
        leftTheKerb = true;
      }
      if (!marker.isTransferring() && !landedOnTaxi) {
        landedOnTaxi = distanceTo(fTraffic.taxi) < 0.05;
      }
    }
  }

  check('the clock stands over the rider from the frame they appear', overTheRider);
  check('and marks the ground under their feet in the same colour', discUnderRider);
  check('the disc hands off to the drop-off when they board', discMovedToDropoff);
  check('the route band takes its colour from the fare the taxi was sent at',
    bandFollows.length > 0 && bandFollows.every(Boolean),
    `${bandFollows.filter((b) => !b).length}/${bandFollows.length} dispatches disagreed`);
  check('it launches from the corner the rider was standing on', launchedFromKerb);
  check('it flies rather than teleports', transferred && leftTheKerb);
  check('it then rides with the taxi', landedOnTaxi);
  check('it clears on delivery', hiddenAfter);

  // The clock has to keep draining after the hand-off — the deadline covers spawn to drop-off, so a
  // marker that froze the moment it landed on the car would be lying for the whole second leg.
  // Drive it by hand on the taxi and read the crystal back.
  {
    const rider = fares.slots[1].marker;
    rider.showAt(URGENCY_SEGMENTS, 0, 0);
    rider.beginTransfer();
    const taxi = { x: 40, z: -20 };
    const hues = [];
    const fills = [];
    let t = 0;
    for (const fraction of [1, 0.7, 0.45, 0.2, 0.02]) {
      for (let f = 0; f < 60; f++) {
        t += 1 / 60;
        rider.setUrgency(urgencyLevel(fraction));
        rider.setFill(fraction);
        rider.update(t, taxi, fraction * 60);
      }
      hues.push(rider.mesh.material.color.getHexString());
      fills.push(rider.getFill());
    }
    check('it keeps draining once it is on the taxi',
      hues.join(' -> ') === [1, 0.7, 0.45, 0.2, 0.02]
        .map((f) => urgencyColor(urgencyLevel(f)).getHexString()).join(' -> '),
      hues.join(' -> '));

    // The liquid in the vessel is the fine hand: it has to keep moving *between* two colour steps,
    // which is the whole point of it. 0.7 and 0.45 are both level 2 — a fill that only followed the
    // colour would report the same crystal for both.
    check('the crystal drains continuously between colour steps',
      fills.every((f, i) => i === 0 || f < fills[i - 1])
        && urgencyLevel(0.2) === urgencyLevel(0.02) && fills[3] > fills[4],
      fills.map((f) => f.toFixed(2)).join(' -> '));
    check('and it is riding the taxi, not the kerb it left',
      Math.hypot(rider.group.position.x - taxi.x, rider.group.position.z - taxi.z) < 0.05);

    // The panic pulse: below five seconds the marker beats, so the end of a clock is an event and
    // not just a shade of red. It came across from the ring, which only ever pulsed on the taxi.
    let beats = 0;
    let calm = 0;
    for (let f = 0; f < 120; f++) {
      t += 1 / 60;
      rider.update(t, taxi, 3);
      if (rider.mesh.scale.x > 1.02) beats += 1;
      rider.update(t, taxi, 30);
      if (Math.abs(rider.mesh.scale.x - 1) < 1e-6) calm += 1;
    }
    check('the last five seconds pulse', beats > 40 && calm === 120,
      `${beats}/120 frames beating, ${calm}/120 calm above the threshold`);
    rider.hide();
  }
}

// --- The drop-off ring drains with the rider in the car -----------------------
// The disc at the far end of a trip is painted in the clock of whoever is aboard, and that is only
// worth anything if it walks the scale as the clock does. The played run above asserts the ring and
// the crystal never disagree, but a delivery is usually over well before the clock reaches red — so
// drive one fare's seconds down by hand mid-ride and read all three of the disc's layers back.
{
  const dScene = new THREE.Scene();
  const dTraffic = createTraffic(makeRng(seed + 44), dScene, 24);
  const dFares = createFareSystem(makeRng(seed + 55), dScene);
  dTraffic.warmup(5);

  const FRACTIONS = [1, 0.7, 0.45, 0.2, 0.02];
  const hues = [];
  let riding = null;
  let elapsed = 0;

  while (elapsed < 220 && !dFares.state.gameOver && hues.length < FRACTIONS.length) {
    dTraffic.update(1 / 60);
    // Held at the fraction under test, so the clock cannot run out while we read it — and the
    // rider is never routed at their drop-off, so the fare cannot resolve out from under us
    // either (arrival requires direction; see fares.js).
    if (riding) riding.timeLeft = riding.limit * FRACTIONS[hues.length];
    const events = dFares.update(1 / 60, dTraffic.taxi);
    elapsed += 1 / 60;

    // The pickup frame itself is not a sample: the override above only starts applying on the
    // frame after, so that one still carries whatever the real clock happened to read.
    let boarded = false;
    for (const { type, fare } of events) {
      if (type === 'spawned' && !riding) {
        const r = findRoute(planOrigin(dTraffic.taxi), fare.target);
        if (r) {
          dTraffic.taxi.route = r;
          dTraffic.taxi.routeConsumed = false;
          dFares.markDirected(fare);
        }
      }
      if (type === 'pickup' && !riding) {
        riding = fare;
        boarded = true;
      }
    }

    if (riding?.stage === 'riding' && !boarded) {
      const layers = new Set(ringHexes(riding.slot));
      hues.push(layers.size === 1 ? [...layers][0] : [...layers].join('/'));
    }
  }

  check('the drop-off ring walks the urgency scale as the ride runs down',
    hues.join(' -> ') === FRACTIONS.map((f) => urgencyColor(urgencyLevel(f)).getHexString()).join(' -> '),
    hues.join(' -> '));

  // The VIP exception, at the seam every one of those surfaces now reads from. A VIP's crystal,
  // its drop-off ring, its band and its off-screen arrow are one fixed purple at every level —
  // "this one is a VIP" must never be confusable with how much time it has left.
  const vipHues = new Set([0, 1, 2, 3, 4].map((l) => fareColor(l, true).getHexString()));
  check('a VIP speaks one purple at every level of the scale',
    vipHues.size === 1 && vipHues.has(new THREE.Color(PALETTE.vip).getHexString()),
    [...vipHues].join(', '));
}

// --- The difficulty curve is winnable everywhere on it ------------------------
// A deadline shorter than the driving it pays for is unwinnable by construction, and it would look
// exactly like the game being hard. Slack below 1.0 is therefore not a tuning choice, it is a bug,
// and it is the kind that only shows up several fares into a run on someone else's machine.
{
  let minSlack = Infinity;
  let capJumps = 0;
  let prevCap = difficulty.maxFares(0);
  for (let delivered = 0; delivered <= 40; delivered++) {
    minSlack = Math.min(minSlack, difficulty.slack(delivered));
    const cap = difficulty.maxFares(delivered);
    // The board grows one rider at a time. Two arriving on the same delivery is a burst the
    // spawn stagger cannot smooth out, because the cap is what gates it in the first place.
    if (cap - prevCap > 1) capJumps += 1;
    prevCap = cap;
  }
  check('slack never drops below 1.0 anywhere on the curve', minSlack >= 1,
    `min slack ${minSlack.toFixed(2)}`);
  check('the board cap grows one rider at a time', capJumps === 0);
  check('the curve reaches its ceiling', difficulty.maxFares(40) === MAX_FARES
    && difficulty.difficulty(40) === 1);
  // A fare that spawns already past its floor is one the clamp is doing all the work for. The
  // floor exists for the next-door hop; if it is catching a median trip, the budget is broken.
  const medianWork = 16.4;   // measured mean trip, tools/eta.mjs
  check('the clock floor does not swallow a median trip',
    difficulty.fareLimit(medianWork, 40) > difficulty.getTuning().clockFloor,
    `${difficulty.fareLimit(medianWork, 40).toFixed(1)}s at full difficulty`);
}

// --- Multiple fares, staggered ----------------------------------------------
// The board fills to MAX_FARES with extras arriving one at a time, so more than one clock can
// drain on the kerb and the player has to pick which to grab first. Every rule about when they
// appear is a timing rule — invisible in a still image and easy to break by accident. So: play a
// perfect run and assert the shape of the board at every frame of it.
{
  const mScene = new THREE.Scene();
  const mTraffic = createTraffic(makeRng(seed + 44), mScene, CARS_DEFAULT);
  const fares = createFareSystem(makeRng(seed + 55), mScene);
  mTraffic.warmup(5);

  let mostAtOnce = 0;
  let mostWaiting = 0;
  let extrasBeforeDelivery = false;
  let overCurveCap = 0;
  let spawnedWhileBusy = 0;
  let spawnedIdle = 0;
  let elapsed = 0;
  let prevSpawnAt = -Infinity;
  let minSpawnGap = Infinity;

  // Serve the carried rider first, then the most urgent one on the kerb — the only order one
  // taxi can work in, and the same policy the soak uses.
  const aim = () => {
    const job = fares.carrying() ?? fares.waiting();
    if (!job || job.directed) return;
    const r = findRoute(planOrigin(mTraffic.taxi), job.target);
    if (r) { mTraffic.taxi.route = r; mTraffic.taxi.routeConsumed = false; fares.markDirected(job); }
  };

  while (elapsed < 400 && !fares.state.gameOver && fares.state.delivered < 6) {
    mTraffic.update(1 / 60);
    for (const { type } of fares.update(1 / 60, mTraffic.taxi)) {
      if (type !== 'spawned') continue;
      if (fares.state.fares.length > 1) {
        // The board is only allowed to be this big at this point in the run. Asserted against the
        // curve rather than a constant, because the cap is now a function of deliveries — a ramp
        // that quietly handed out the fourth rider on delivery one would still satisfy any fixed
        // ceiling.
        if (fares.state.fares.length > difficulty.maxFares(fares.state.delivered)) {
          overCurveCap += 1;
        }
        if (fares.state.delivered < 1) extrasBeforeDelivery = true;
        spawnedWhileBusy += 1;
        // The stagger is what turns this into a prioritisation puzzle — every extra rider must
        // arrive at least difficulty.spawnGap() after the previous one, not in the same burst.
        minSpawnGap = Math.min(minSpawnGap, elapsed - prevSpawnAt);
      } else {
        spawnedIdle += 1;
      }
      prevSpawnAt = elapsed;
    }

    aim();
    elapsed += 1 / 60;

    mostAtOnce = Math.max(mostAtOnce, fares.state.fares.length);
    mostWaiting = Math.max(mostWaiting, fares.state.fares.filter((f) => f.stage === 'waiting').length);
  }

  check('the board can fill past two fares', mostAtOnce >= 2,
    `peak ${mostAtOnce}, ${fares.state.delivered} delivered`);
  check('never more than MAX_FARES', mostAtOnce <= MAX_FARES);
  check('the board never runs ahead of the difficulty curve', overCurveCap === 0,
    `${overCurveCap} frames over the cap`);
  check('the extra fares only arrive after the tutorial delivery',
    !extrasBeforeDelivery && spawnedWhileBusy > 0,
    `${spawnedWhileBusy} extras, ${spawnedIdle} on an empty board`);
  // Two waiting riders is the whole point of the change — a single-choice board would leave
  // "prioritise which one to grab" as words in the docs and nothing in the game.
  check('more than one rider can wait on the kerb at once', mostWaiting >= 2,
    `peak ${mostWaiting}`);
  // The stagger is the fairness guarantee: extras land at least difficulty.spawnGap() apart, so
  // their clocks drain out of phase instead of ending on the same tick. 6.5 is the floor of that
  // curve (7s at full difficulty) with a frame's grace — tightening spawnGapEnd below it is a
  // deliberate act that has to come here and say so.
  check('extra fares arrive staggered', minSpawnGap >= 6.5,
    `min gap ${Number.isFinite(minSpawnGap) ? minSpawnGap.toFixed(2) : '-'}s`);

  // The one-seat rule, from the outside: a kerbside rider cannot be directed at while carrying.
  const carried = fares.carrying();
  const kerb = fares.waiting();
  if (carried && kerb) {
    check('a waiting rider cannot be taken while carrying', fares.markDirected(kerb) === false);
  } else {
    check('a waiting rider cannot be taken while carrying', true, 'board not doubled up at exit');
  }
}

// --- Every generator gets its own stream ---------------------------------------------------------
//
// "Every generator draws from its own stream so that changing one system doesn't reshuffle the
// others" is a rule `src/main.js` states about itself and nothing enforced. It failed the first time
// two branches picked the same offset independently — the courier and the helicopter both landed on
// `runSeed + 233`, and the merge resolved cleanly because there was no textual conflict.
//
// `makeRng` is seeded, so two equal offsets are not two independent streams: they are the *same*
// sequence handed to two systems, which correlates them forever with no crash, no failing check and
// nothing to see. Read as text because that is where the mistake lives — the numbers are literals at
// their call sites, and there is no runtime object that knows the whole set.
{
  const src = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const offsets = [...src.matchAll(/makeRng\((runSeed|seed) \+ (\d+)\)/g)]
    .map((m) => `${m[1]}+${m[2]}`);
  const dupes = offsets.filter((o, n) => offsets.indexOf(o) !== n);
  check('no two generators share a seed offset', dupes.length === 0,
    dupes.length ? `shared: ${[...new Set(dupes)].join(', ')}` : `${offsets.length} distinct streams`);
  // The birds pass their offsets through a loop variable, so the literal scan above cannot see them.
  // Named here so the check is honest about its own blind spot rather than implying full coverage.
  check('and the scan actually found the call sites', offsets.length >= 12,
    `${offsets.length} literal offsets (the two flocks pass theirs via a loop)`);
}

// --- The package courier ------------------------------------------------------------------------
//
// A second cargo slot, reached by *steering* rather than by tapping (game/parcels.js). Everything
// worth asserting here is invisible in a still frame: whether a package can be tapped at all,
// whether it lands somewhere the current route already goes, whether it takes the seat, and whether
// it carries a clock it must not have.
{
  // The pad's winding, first — no simulation needed. Hand-written triangles get their winding
  // *asserted*, not eyeballed: the roadworks ramp shipped wound clockwise throughout, so the only
  // face the camera ever saw was its underside, and it read as z-fighting for weeks. A pad wound the
  // wrong way is a flat cyan square lying invisible on the road.
  const pad = createParcelPad(PALETTE.parcel);
  const [rim, fill, sweep] = pad.group.children;
  let badWinding = 0;
  let triangles = 0;
  // All three layers, the beam band included — it is a hand-wound strip round a rounded-square path,
  // which is the layer most likely to come out inside-out, and a beam wound away from the camera is
  // indistinguishable from a beam that was never added.
  for (const mesh of [rim, fill, sweep]) {
    const p = mesh.geometry.attributes.position;
    // `ShapeGeometry` is **indexed**, so positions 0/1/2 are not a triangle — the index buffer is
    // what says which vertices make one, and reading the attribute in order tests a triangle that
    // does not exist. (That mistake is what this check first reported as a face-down pad.)
    const index = mesh.geometry.index;
    const at = (n) => (index ? index.getX(n) : n);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    for (let t = 0; t < (index ? index.count : p.count); t += 3) {
      a.fromBufferAttribute(p, at(t));
      b.fromBufferAttribute(p, at(t + 1));
      c.fromBufferAttribute(p, at(t + 2));
      // Computed from the winding, not read off the normal attribute — a stated normal (and
      // `computeVertexNormals`) launders a reversed triangle into whatever it is told.
      if (b.sub(a).cross(c.sub(a)).y <= 0) badWinding += 1;
      triangles += 1;
    }
  }
  check('every triangle of the courier pad faces up', badWinding === 0 && triangles > 8,
    `${badWinding}/${triangles} wound face-down`);
  check('the courier pad is a rounded square, not a disc',
    // Its corners reach further from the centre than its edge midpoints do — true of a square and
    // false of every circle. This is the shape half of "shape says what a thing is": if the pad ever
    // silently becomes a disc, a package and a fare destination stop being distinguishable at zoom.
    Math.hypot(PAD_R, PAD_R) > PAD_R * 1.2, `half-width ${PAD_R}`);
  // Both layers, one hue, and it is the courier cyan rather than anything off the urgency scale — a
  // package has no clock, so a green-to-red hue here would be reporting a countdown that cannot
  // exist. Read back the way the fare disc's three layers are.
  check('the courier pad wears the courier cyan on all three layers',
    [rim, fill, sweep].every(
      (m) => m.material.color.getHexString() === new THREE.Color(PALETTE.parcel).getHexString(),
    ));
  // The beam is the pad's "this mark belongs to the game" cue, and it is the fare disc's beam rather
  // than a second implementation — same shader, so the same cache key, and an `aAngle` attribute is
  // what that shader reads. A band without one draws a uniform glow: the pad simply looks brighter,
  // with nothing travelling, which is the failure the eye is worst at naming.
  check('the courier pad carries the disc beam, not a copy of it',
    Boolean(sweep.geometry.attributes.aAngle)
    && sweep.material.customProgramCacheKey() === 'ring-sweep'
    && sweep.material.blending === THREE.AdditiveBlending);
  // Arc length round the perimeter, not angle from the centre. On a rounded square those disagree
  // badly — the centre angle races through the corners and crawls along the flats — so a beam keyed to
  // the wrong one visibly changes speed four times a lap. Checked as the spacing between consecutive
  // vertices being near-uniform, which is what arc-length parameterisation means.
  check('the pad beam travels at a steady speed round the square', (() => {
    const a = sweep.geometry.attributes.aAngle;
    const p = sweep.geometry.attributes.position;
    let minStep = Infinity;
    let maxStep = 0;
    // Each segment contributes six vertices, the first three of which span t0 -> t1 -> t1.
    for (let v = 0; v + 1 < a.count; v += 6) {
      const step = a.getX(v + 1) - a.getX(v);
      if (step <= 0) continue;
      const dx = p.getX(v + 1) - p.getX(v);
      const dz = p.getZ(v + 1) - p.getZ(v);
      const perUnit = step / (Math.hypot(dx, dz) || 1);
      minStep = Math.min(minStep, perUnit);
      maxStep = Math.max(maxStep, perUnit);
    }
    return maxStep / minStep < 1.35;
  })(), 'radians per world unit is near-constant round the path');
  check('the courier pad is depth-tested and does not write depth',
    rim.material.depthTest && !rim.material.depthWrite
    && fill.material.depthTest && !fill.material.depthWrite);

  // **A package is tapped now, and what the tap asks for is a detour.** Half the interaction model is
  // unchanged — nothing in the game dispatches the taxi *at* a box — and half of it is inverted: the
  // live end of an errand carries a hit box, and a tap on it re-plans the current route through that
  // junction (`divertToParcel` in main.js).
  //
  // So the assertion is no longer "nothing here is pickable". It is that exactly the corner standing
  // on the board is, that it is tagged with the kind main.js switches on, and that the copies which
  // can never be tapped — the box in flight, the one riding the taxi's deck — still are not. A stray
  // `pickable` on one of those would not throw; it would quietly answer a tap aimed at the road behind
  // it, which is the trap geometry/person.js warns about.
  const pScene = new THREE.Scene();
  const pTraffic = createTraffic(makeRng(seed + 44), pScene, CARS_DEFAULT);
  // `reserved` is the cross-system half of the corner rule, wired exactly as main.js wires it. The
  // forward reference to `parcels` is safe because the closure is only ever called from `update`.
  const fares = createFareSystem(makeRng(seed + 55), pScene, {
    reserved: () => parcels.occupiedSpots(),
  });
  const parcels = createParcelSystem(makeRng(seed + 255), pScene);
  pTraffic.warmup(5);

  const tagsUnder = (root) => {
    const kinds = [];
    root.traverse((node) => { if (node.userData?.pickable) kinds.push(node.userData.pickable); });
    return kinds;
  };
  const pinTags = [];
  let flightTagged = 0;
  for (const slot of parcels.slots) {
    pinTags.push(tagsUnder(slot.pickup.group).join('+'), tagsUnder(slot.dropoff.group).join('+'));
    flightTagged += tagsUnder(slot.flight).length;
  }
  check('each courier marker carries exactly one tap target, tagged by which end it is',
    pinTags.length === MAX_PARCELS * 2
    && pinTags.every((t, n) => t === (n % 2 === 0 ? 'parcel' : 'parcel-dropoff')),
    pinTags.join(' | '));
  // The flight copy shares its geometry factory with the kerb box and is a *sibling* of both markers
  // in the scene, so it is the one most likely to pick a tag up by accident — and it spends its whole
  // life crossing the road between two corners that are themselves tappable.
  check('the box in flight is not tappable', flightTagged === 0, `${flightTagged} tagged`);
  check('a loose parcel mesh can still be tagged when something wants it to be',
    createParcel({ pickable: 'parcel' }).mesh.userData.pickable === 'parcel');

  // The rest of the tap: `parcelFor` maps a hit back to the errand that owns it, `pickables()` offers
  // only the end that is actually standing on the board, and `acknowledge` answers on the corner.
  //
  // The acknowledgement is the half a screenshot cannot check and a player would notice first. Its
  // whole job is to distinguish a tap that landed from one that was refused, and the two differ only
  // in the **sign** of one scale — so both directions are asserted, and so is the return to exactly
  // rest, because a corner left a few percent large for the rest of the run is the failure mode of
  // every envelope in this game.
  const kScene = new THREE.Scene();
  const kTraffic = createTraffic(makeRng(seed + 46), kScene, CARS_DEFAULT);
  const kFares = createFareSystem(makeRng(seed + 57), kScene, {
    reserved: () => kParcels.occupiedSpots(),
  });
  const kParcels = createParcelSystem(makeRng(seed + 257), kScene);
  kTraffic.warmup(2);
  const kTick = () => kParcels.update(1 / 60, kTraffic.taxi, {
    fareSpots: kFares.occupiedSpots(), delivered: 9,
  });
  kParcels.state.nextSpawnAt = -Infinity;
  kTick();
  const box = kParcels.state.parcels[0];
  if (box) {
    const live = () => (box.stage === 'waiting' ? box.slot.pickup : box.slot.dropoff);
    // What the picker would actually hand back: the tap target itself, not the marker root.
    // `parcelFor` has to walk up from it, which is the only reason it is a walk rather than a
    // lookup — and the walk is why this searches the whole subtree rather than the root's children:
    // the target hangs off the kerb-corner group now (geometry/marker.js).
    let hit = null;
    live().group.traverse((o) => { if (o.userData?.pickable) hit ??= o; });
    check('a tap on the hit box resolves to the package that owns it',
      kParcels.parcelFor(hit) === box);
    check('a tap on something else resolves to nothing',
      kParcels.parcelFor(kTraffic.taxiGroup) === null);
    check('only the end on the board is offered to the picker',
      kParcels.pickables().length === 1 && kParcels.pickables()[0] === live().group);

    // Scale is written in `update`'s per-slot pass, so each reading needs a tick to produce it.
    const scaleAt = (seconds) => {
      for (let n = 0; n < Math.round(seconds * 60); n++) kTick();
      return live().postGroup.scale.x;
    };
    kParcels.acknowledge(box, true);
    kTick();                                       // stamps the envelope's zero
    const swell = scaleAt(POP_TIME * 0.25);        // the peak, see game/selectpop.js
    const restedAfterSwell = scaleAt(POP_TIME);
    kParcels.acknowledge(box, false);
    kTick();
    const flinch = scaleAt(POP_TIME * 0.25);
    const restedAfterFlinch = scaleAt(POP_TIME);
    check('an accepted tap swells the corner it landed on', swell > 1.05, swell.toFixed(3));
    check('a refused tap flinches it inward instead', flinch < 0.97, flinch.toFixed(3));
    check('and both land back on exactly rest',
      restedAfterSwell === 1 && restedAfterFlinch === 1,
      `${restedAfterSwell} / ${restedAfterFlinch}`);
  } else {
    check('a package spawned to tap', false);
  }

  // Now play a run: serve fares the way the soak's perfect player does, and take the cheap courier
  // detours on the way.
  //
  // **This is the gesture, driven for real.** Dragging the band sideways re-plans the route to the
  // *same* fare through the junction under the finger (`findRouteVia`, game/pathdrag.js), so that is
  // what happens here — no package is ever routed *at*, because nothing in the game can do that.
  //
  // `DETOUR_BUDGET` is the player's greed, in extra legs, and **the trade-off it buys is measured**.
  // Across three cities (seeds 71624, 4242, 90210), 420s of a perfect fare player who also couriers,
  // re-measured at MAX_PARCELS = 1:
  //
  //   budget  survived            fares   fare cash    offered  delivered  courier cash
  //   1 leg   420s x3             12-16   $252-319     1-2      0-1        $0-26
  //   2 legs  297s, 403s, 420s    8-12    $135-261     3        2-3        $40-54
  //   3 legs  indistinguishable from 2 legs — past two, the cap almost never binds
  //   (at 2 slots, 1 leg: 420s x3, 12-14 fares, $233-296, 1-3 delivered for $14-57)
  //
  // So a one-leg detour is free money and a two-leg one costs you the run in the worst city: the
  // courier cash never comes close to replacing the fare income it burns ($54 at best against $100+
  // forgone). That is the layer behaving as intended — a real temptation with a real price — and it
  // is why this loop runs at 1 rather than at MAX_VIA_DETOUR's 6. A greedy player is *supposed* to
  // die here.
  //
  // The single slot is visible in the "offered" column and is why the spawn-count floor below is 1.
  // A declined box holds the board for the rest of the run, so at a one-leg budget two of the three
  // cities saw exactly one box and never collected it. See docs/gameplay.md for what that costs.
  const DETOUR_BUDGET = 1;
  let viaTaken = 0;
  let viaRefused = 0;
  // Extra legs a *tapped* diversion would cost at each re-plan, and how many of those the drag's cap
  // would have thrown away. See the sampling block in `aimFare` and `TAP_MAX_DETOUR` in parcels.js.
  const tapExtra = [];
  let tapRefusedByDragCap = 0;
  let tapUnroutable = 0;
  // **Re-plan only when the plan actually changes.** A drag re-plans every frame the finger is down
  // and that is safe for the second or two a gesture lasts, but holding it for a whole run is not:
  // `routeConsumed` cleared on every tick means the turn the car has already committed to never
  // retires from the route, and the taxi sits re-deciding the same junction forever. (It does —
  // measured here as a run that earned $34 in seven minutes and delivered nothing.) So key the plan
  // on its two endpoints and leave it alone in between, which is also what a player does.
  let plannedFor = null;
  const aimFare = () => {
    const job = fares.carrying() ?? fares.waiting();
    if (!job) return;
    // The courier errand still outstanding: the pad of the box aboard, or a box on a corner if the
    // cargo slot is free. Once one is reached its stage flips, its `target` moves, and the key below
    // changes — which is how the waypoint retires rather than answering with a lap back to it.
    const errand = parcels.carrying() ?? parcels.state.parcels.find((p) => p.stage === 'waiting');
    const key = `${job.target.i},${job.target.j}`
      + (errand ? `|${errand.target.i},${errand.target.j}` : '');
    if (key === plannedFor && job.directed) return;

    const from = planOrigin(pTraffic.taxi);

    // **What a tap would cost, sampled beside the drag it replaces.** `divertToParcel` in main.js
    // plans this exact route when the player taps the box with a rider aboard, and the question
    // `TAP_MAX_DETOUR` answers is how much extra route that is. Sampled per re-plan rather than per
    // frame because the answer is a function of (origin, box, destination) and nothing else.
    //
    // This is here rather than in a sweep of its own because it has to be measured against the plans
    // a *player* is actually driving. A sweep over random (origin, box, target) triples answers a
    // different question — the distribution over the map, not over the game.
    if (errand && fares.carrying()) {
      const direct = findRoute(from, job.target);
      const uncapped = findRouteVia(from, errand.target, job.target, { maxDetour: TAP_MAX_DETOUR });
      if (!uncapped || !direct) tapUnroutable += 1;
      else {
        tapExtra.push(uncapped.length - direct.length);
        // The same plan under the *drag's* cap. Every one of these is a tap that would have been
        // refused with no route change and a flinch the player cannot see — which is exactly what
        // was reported from a real run, and what uncapping fixed.
        if (!findRouteVia(from, errand.target, job.target)) tapRefusedByDragCap += 1;
      }
    }

    const bent = errand
      ? findRouteVia(from, errand.target, job.target, { maxDetour: DETOUR_BUDGET })
      : null;
    if (errand) {
      if (bent) viaTaken += 1;
      else viaRefused += 1;
    }
    const route = bent ?? findRoute(from, job.target);
    if (!route) return;
    pTraffic.taxi.route = route;
    pTraffic.taxi.routeConsumed = false;
    fares.markDirected(job);
    plannedFor = key;
  };
  // The junctions the taxi's plan already takes it through — the same walk parcels.js does, kept
  // here independently so the check is not simply agreeing with the code it is testing.
  const onRoute = () => {
    const out = [{ i: pTraffic.taxi.i, j: pTraffic.taxi.j }];
    let { i, j } = pTraffic.taxi;
    for (const d of pTraffic.taxi.route ?? []) {
      const next = nextIntersection(d, i, j);
      if (!next) break;
      ({ i, j } = next);
      out.push({ i, j });
    }
    return out;
  };

  let spawns = 0;
  let spawnedTooEarly = 0;
  let overCap = 0;
  let liveOverCap = 0;
  let deliveries = 0;
  let tooShort = 0;
  let sameBlock = 0;
  let clashedWithFare = 0;
  let unroutable = 0;
  let mispriced = 0;
  let carriedClock = 0;
  let landedOnRoute = 0;
  let bothCarried = 0;
  let dropPadShownEarly = 0;
  let onPark = 0;
  let prevSpawnAt = -Infinity;
  let minGap = Infinity;
  let maxGap = 0;
  let deliveryHeld = 0;
  let elapsed = 0;
  let sharedCorner = 0;

  while (elapsed < 420 && !fares.state.gameOver && parcels.state.delivered < 3) {
    pTraffic.update(1 / 60);
    fares.update(1 / 60, pTraffic.taxi);
    aimFare();

    // Snapshot the route *before* parcels tick, so a spawn is judged against the plan the player was
    // actually driving on the frame it appeared.
    const route = onRoute();
    for (const { type, parcel } of parcels.update(1 / 60, pTraffic.taxi, {
      fareSpots: fares.occupiedSpots(),
      delivered: fares.state.delivered,
      over: fares.state.gameOver,
    })) {
      if (type === 'delivered') {
        deliveries += 1;
        // The hold is `max(drawn gap, now + PARCEL_AFTER_DELIVERY)`, so it only *moves* the timestamp
        // when the draw was nearer than the hold. Counting the times it bit is what makes this a check
        // on the rule rather than on which draws happened to come up.
        if (parcels.state.nextSpawnAt >= elapsed + PARCEL_AFTER_DELIVERY - 0.1) deliveryHeld += 1;
      }
      if (type !== 'spawned') continue;
      spawns += 1;
      if (fares.state.delivered < PARCEL_MIN_DELIVERED) spawnedTooEarly += 1;
      if (parcels.state.parcels.length > MAX_PARCELS) overCap += 1;
      if (blockDistance(parcel.pickup, parcel.dropoff) < 3) tooShort += 1;
      if (onSameBlock(parcel.pickup, parcel.dropoff)) sameBlock += 1;
      // Neither end on grass. A park block has no address to deliver to, and a district has built
      // over the road that used to reach one of its corners — so a pad there is a job pointing at a
      // street the router knows is gone.
      for (const end of [parcel.pickup, parcel.dropoff]) {
        if (onGrass(layout, end.i, end.j)) onPark += 1;
      }
      // A box may never share a corner with a live fare: two jobs in one place is two jobs the
      // player cannot tell apart at play zoom.
      for (const spot of fares.occupiedSpots()) {
        if ((spot.i === parcel.pickup.i && spot.j === parcel.pickup.j)
          || (spot.i === parcel.dropoff.i && spot.j === parcel.dropoff.j)) clashedWithFare += 1;
      }
      if (!findRoute({ ...parcel.pickup, d: pTraffic.taxi.d }, parcel.dropoff)) unroutable += 1;
      // Priced exactly as a rider going the same distance is, times the shift it appeared in.
      const want = Math.round(priceFor(parcel.pickup, parcel.dropoff)
        * difficulty.payoutMultiplier(parcels.state.delivered) * PARCEL_PAY_FACTOR);
      if (parcel.value !== want) mispriced += 1;
      // **No clock.** Not "a long one" — none at all, so there is nothing for a hue to step through
      // and nothing that can expire and end a run. Asserted on the shape of the object, because that
      // is where a clock would have to appear first.
      if ('timeLeft' in parcel || 'limit' in parcel) carriedClock += 1;
      // The mechanic: a package lands somewhere the current plan does *not* go, so collecting it
      // costs a deliberate bend of the route band. Only meaningful while the taxi actually has a
      // route to be off.
      if (route.length > 1
        && route.some((r) => r.i === parcel.pickup.i && r.j === parcel.pickup.j)) landedOnRoute += 1;
      // The far pad stays dark until the box is aboard — four cyan squares on a full board have
      // nothing to say which belongs to which.
      if (parcel.slot.dropoff.group.visible) dropPadShownEarly += 1;
      if (Number.isFinite(prevSpawnAt)) {
        minGap = Math.min(minGap, elapsed - prevSpawnAt);
        maxGap = Math.max(maxGap, elapsed - prevSpawnAt);
      }
      prevSpawnAt = elapsed;
    }

    // One cargo slot, from the outside.
    if (parcels.state.parcels.filter((p) => p.stage === 'carried').length > 1) bothCarried += 1;
    // And one *board* slot, every frame rather than only on the frames a package spawns. The spawn-
    // time count below cannot see a cap that leaks between events — which is the only way this could
    // now break, since `spawn` is the one thing that adds to `state.parcels`.
    if (parcels.state.parcels.length > MAX_PARCELS) liveOverCap += 1;

    // **The corner invariant, every frame and in both directions.** Checked here rather than only at a
    // package's spawn, which is where it used to be and which made it look enforced while only half of
    // it was: a package sits on its corner indefinitely, so a *later fare* could land on top of one.
    // Nothing about that is visible — two markers share one 20-unit hit box and the tap resolves to
    // whichever the raycast reached first.
    for (const spot of parcels.occupiedSpots()) {
      for (const other of fares.occupiedSpots()) {
        if ((spot.i === other.i && spot.j === other.j) || onSameBlock(spot, other)) sharedCorner += 1;
      }
    }
    elapsed += 1 / 60;
  }

  // **The park rule needs more spawns than a run produces.** One board slot means a run of this
  // length sees a handful of packages, and only about a sixth of the map is green — so the count
  // above would sit at zero for a city whose filter had been deleted, which is a check that passes by
  // not looking. A fresh board per seed on the *same* city gives the draw enough goes at the grass to
  // be an assertion: the taxi is left parked where the run left it, so the only thing varying is which
  // pair of corners the draw came up with.
  let sampled = 0;
  let sampledOnPark = 0;
  const BOARDS = 80;
  for (let s = 0; s < BOARDS; s++) {
    const boardScene = new THREE.Scene();
    const board = createParcelSystem(makeRng(seed + 900 + s * 7), boardScene);
    // `delivered` past the tutorial gate and `nextSpawnAt` still at −Infinity, so the first frame
    // spawns rather than waiting out a drawn gap.
    for (const { type, parcel } of board.update(1 / 60, pTraffic.taxi, { delivered: 99 })) {
      if (type !== 'spawned') continue;
      sampled += 1;
      for (const end of [parcel.pickup, parcel.dropoff]) {
        if (onGrass(layout, end.i, end.j)) sampledOnPark += 1;
      }
    }
  }

  // One spawn, not two. **The floor moved down with the cap, deliberately.** At two slots the board
  // refilled on its own and a run of this length always saw several; at one, a box that goes
  // uncollected holds the board until somebody drives through it, so every spawn after the first is a
  // fact about how the player drove rather than about the spawn policy — and this run's player takes
  // only the detours that cost a single leg, which in an unlucky city is none of them. Asserting more
  // than one here would be asserting the city's geometry, the same trap the missing gap *ceiling*
  // below is written around.
  check('packages appear on the board', spawns >= 1, `${spawns} spawned`);
  check('no package before the tutorial delivery', spawnedTooEarly === 0,
    `${spawnedTooEarly} early`);
  check('never more than MAX_PARCELS', overCap === 0 && liveOverCap === 0,
    `${overCap} over at spawn, ${liveOverCap} frames over`);
  check('a package trip is worth taking', tooShort === 0 && sameBlock === 0,
    `${tooShort} too short, ${sameBlock} on one block`);
  check('a package never spawns on a fare\'s corner', clashedWithFare === 0,
    `${clashedWithFare} clashes at spawn`);
  check('neither end of a package stands on a park', onPark === 0 && sampledOnPark === 0,
    `${onPark}/${spawns * 2} in the run, ${sampledOnPark}/${sampled * 2} over ${BOARDS} fresh boards`);
  // The other direction, and the one that was actually broken: a fare must not spawn on a package's
  // corner either. Frames, not events — the two boards move independently, so the only honest way to
  // state it is that no frame of the run ever has both on one slab.
  check('and no fare ever lands on a package\'s', sharedCorner === 0,
    `${sharedCorner} frames sharing a corner over ${elapsed.toFixed(0)}s`);
  check('both ends of a package are drivable', unroutable === 0, `${unroutable} unroutable`);
  check('a package is priced like a rider going the same distance', mispriced === 0,
    `${mispriced}/${spawns} mispriced`);
  check('a package carries no clock', carriedClock === 0, `${carriedClock} with one`);
  check('a package lands off the route the taxi is already driving', landedOnRoute === 0,
    `${landedOnRoute}/${spawns} on the plan`);
  check('the far pad stays dark until the box is aboard', dropPadShownEarly === 0,
    `${dropPadShownEarly} lit early`);
  check('the taxi never carries two packages', bothCarried === 0, `${bothCarried} frames with two`);
  // Spaced, and spaced *unpredictably* — the gap is drawn per package, so a box is something you come
  // across rather than something arriving on the beat.
  //
  // The **floor** is a property of the draw and is asserted as one. There is deliberately no ceiling:
  // an observed spawn-to-spawn gap is not the drawn gap, because a spawn also needs a free slot, so a
  // full board stretches the interval by however long it takes the player to clear one. A ceiling here
  // would be asserting something about the player's driving. (Measured 39.9s to 80.0s over four spawns
  // against a 18-45s draw, which is exactly that effect.)
  //
  // What *is* checked instead is that the gaps **vary** — a draw that silently became a constant would
  // sail through a floor check, and the whole point of the change is that the arrival is unpredictable.
  check('packages arrive spaced by a drawn gap', spawns < 2 || minGap >= PARCEL_GAP_MIN - 0.1,
    `min ${Number.isFinite(minGap) ? minGap.toFixed(1) : '-'}s against a ${PARCEL_GAP_MIN}s floor`);
  check('and no two gaps are the same length', spawns < 3 || maxGap - minGap > 1,
    `${minGap.toFixed(1)}s to ${maxGap.toFixed(1)}s over ${spawns} spawns`);
  // Cashing one in must not immediately put another on the board. Asserted on the state the delivery
  // writes, since the observed interval cannot separate this hold from the drawn gap around it.
  //
  // Stated as "every delivery this run made" rather than "at least one", because *whether this run
  // delivers at all* is a property of the city — the same reason the policy check below measures the
  // cost curve instead of asserting the loop works. The deterministic proof of the hold is in the
  // controlled block, where a delivery is arranged rather than hoped for.
  check('a delivery holds the next package off', deliveryHeld === deliveries,
    `${deliveryHeld}/${deliveries} deliveries pushed the next spawn out`);
  // The run has to have actually completed a courier job end to end for any of the above to mean
  // much: spawn, bend the band through the pad, collect, bend it through the far pad, get paid.
  // **This block measures the cost curve; it does not assert that the loop works.** That distinction is
  // load-bearing and was learned the hard way: at a one-leg budget whether *any* package is reachable is
  // a property of the city, and moving the courier's seed offset by one merge turned a run that
  // delivered two into a run offered twenty-five detours that could afford none. A check going red
  // because the streets happened to line up differently is a check nobody can act on.
  //
  // So what is asserted here is that the policy actually ran; the end-to-end path is proved in the
  // controlled block below, where the geometry is not left to luck.
  check('the courier policy was exercised', viaTaken + viaRefused > 0,
    `${viaTaken}/${viaTaken + viaRefused} offers within ${DETOUR_BUDGET} leg, `
    + `${parcels.state.delivered} delivered for $${parcels.state.earned}`);

  // **The tap's own cap, measured on the plans above.** Two claims, and they are different claims.
  const sorted = [...tapExtra].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  // One: a tap is answered. `TAP_MAX_DETOUR` is uncapped, so the only refusal left is a leg the
  // router cannot solve — which a shipped city never has, `main.js` rerolling any seed that does.
  // This is the check that would have caught the bug: at the drag's cap it goes red on 41% of taps.
  check('a tapped courier diversion is always routable',
    tapUnroutable === 0 && sorted.length > 0,
    `${sorted.length} sampled, ${tapUnroutable} unroutable, median +${median} legs`);
  // Two: the special case is still earning its keep. If the drag's cap ever stopped refusing these,
  // `TAP_MAX_DETOUR` would be a constant with nothing to say and should be deleted rather than left
  // as a second number to keep in step.
  check("the drag's cap would still refuse a real share of taps", tapRefusedByDragCap > 0,
    `${tapRefusedByDragCap}/${sorted.length} refused at MAX_VIA_DETOUR = ${MAX_VIA_DETOUR}`
    + ` — p90 +${sorted[Math.floor(sorted.length * 0.9)] ?? 0} legs`);
}

// --- A package rides alongside a passenger, and the run ending clears it -------------------------
//
// The point of the whole layer: the seat and the cargo slot are independent. And whichever way the
// run ends — a clock, a collision, a bust — no cyan pad may be left glowing on the blackout.
{
  const cScene = new THREE.Scene();
  const cTraffic = createTraffic(makeRng(seed + 44), cScene, 1);
  const fares = createFareSystem(makeRng(seed + 55), cScene, {
    reserved: () => parcels.occupiedSpots(),
  });
  const parcels = createParcelSystem(makeRng(seed + 255), cScene);
  cTraffic.warmup(2);

  // Get a rider aboard the ordinary way.
  fares.update(1 / 60, cTraffic.taxi);
  let guard = 0;
  while (!fares.carrying() && guard++ < 60 * 200 && !fares.state.gameOver) {
    cTraffic.update(1 / 60);
    fares.update(1 / 60, cTraffic.taxi);
    const job = fares.waiting();
    if (job && !job.directed) {
      const r = findRoute(planOrigin(cTraffic.taxi), job.target);
      if (r) { cTraffic.taxi.route = r; cTraffic.taxi.routeConsumed = false; fares.markDirected(job); }
    }
  }
  const rider = fares.carrying();

  // Force a package onto the board next to the taxi and drive into it. `delivered` is faked past
  // PARCEL_MIN_DELIVERED so the spawn gate opens — this is testing the cargo slot, not the gate.
  parcels.state.nextSpawnAt = -Infinity;
  parcels.update(1 / 60, cTraffic.taxi, { fareSpots: fares.occupiedSpots(), delivered: 9 });
  const parcel = parcels.state.parcels[0];

  if (rider && parcel) {
    const clockBefore = rider.timeLeft;
    const targetBefore = rider.target;
    // The player's bend of the route band, as a route through the package's junction.
    const detour = findRoute(planOrigin(cTraffic.taxi), parcel.pickup);
    if (detour) { cTraffic.taxi.route = detour; cTraffic.taxi.routeConsumed = false; }
    let g2 = 0;
    while (!parcels.carrying() && g2++ < 60 * 240 && !fares.state.gameOver) {
      cTraffic.update(1 / 60);
      fares.update(1 / 60, cTraffic.taxi);
      parcels.update(1 / 60, cTraffic.taxi, {
        fareSpots: fares.occupiedSpots(), delivered: 9, over: fares.state.gameOver,
      });
    }
    check('a package is collected while a passenger is aboard',
      Boolean(parcels.carrying()) && fares.carrying() === rider,
      parcels.carrying() ? 'both aboard' : 'never collected');
    // The seat and the cargo slot do not touch each other. The rider's deadline in particular is
    // *not* reset, paused or extended by the detour — the seconds the bend costs are the whole price
    // of the bonus, and a clock that quietly restarted would make the layer free.
    check('collecting a package does not touch the rider or their clock',
      fares.carrying() === rider && rider.target === targetBefore
      && rider.timeLeft < clockBefore && rider.stage === 'riding',
      `clock ${clockBefore.toFixed(1)}s → ${rider.timeLeft.toFixed(1)}s`);
  } else {
    check('a package is collected while a passenger is aboard', false,
      `rider ${Boolean(rider)}, parcel ${Boolean(parcel)}`);
    check('collecting a package does not touch the rider or their clock', false, 'no setup');
  }

  // --- The box lifts out of the world, and the pad grows rather than popping ----------------------
  //
  // A collected box rises off its pad, swells, slides away toward the corner of the screen the HUD chip
  // lives in, and fades out; near the end of that it emits `'loaded'` carrying the point it had reached,
  // which is what the chip comes in from (game/cargochip.js). The chip's half is a Web Animation and
  // belongs to `tools/smoke.mjs`. What belongs *here* is the lift: it starts exactly where the kerb box
  // stood, it goes the right way, and it hands over once, near the end, still moving.
  if (parcel) {
    const kerb = cornerFor(parcel.pickup.i, parcel.pickup.j);
    const lift = parcel.slot.flight;
    // The lift is already running — it was launched on the frame the box was collected. Its first
    // position is the seam: the flying copy has to stand exactly where the kerb copy did, or the box
    // jumps on the frame it changes objects.
    check('a collected box lifts off from the corner it was standing on',
      lift.visible
      && Math.hypot(lift.position.x - kerb.x, lift.position.z - kerb.z) < 0.01
      && Math.abs(lift.position.y - PARCEL_PAD_LIFT) < 0.01,
      `(${lift.position.x.toFixed(2)}, ${lift.position.y.toFixed(2)}, `
      + `${lift.position.z.toFixed(2)}) against kerb (${kerb.x.toFixed(2)}, `
      + `${PARCEL_PAD_LIFT.toFixed(2)}, ${kerb.z.toFixed(2)})`);

    // Step the lift and watch it climb, swell, fade, and set off up-screen and to the left — which is
    // world −X for this camera (see TOWARD_HUD in game/parcels.js). Nothing may cross the road to the
    // taxi, and nothing may be left on the kerb.
    let rose = 0;
    let swelled = 0;
    let faded = 0;
    let towardHud = 0;
    let kerbBoxShown = 0;
    let loadedEvents = 0;
    let handedAt = null;      // the fraction of the lift that had run when it handed over
    let handedAlpha = null;   // ...and how visible the box still was
    let padGrowing = 0;
    let padSettled = false;
    let stillFlying = 0;
    const padScale = () => parcel.slot.dropoff.ring.group.scale.x;
    const boxMaterial = parcel.slot.flightBox.mesh.material;
    const liftStartedAt = parcels.state.elapsed;
    for (let step = 0; step < 90; step++) {
      cTraffic.update(1 / 60);
      fares.update(1 / 60, cTraffic.taxi);
      for (const event of parcels.update(1 / 60, cTraffic.taxi, {
        fareSpots: fares.occupiedSpots(), delivered: 9, over: false,
      })) {
        if (event.type !== 'loaded') continue;
        loadedEvents += 1;
        handedAt = (parcels.state.elapsed - liftStartedAt) / LIFT_TIME;
        handedAlpha = boxMaterial.opacity;
        // The point handed over is the box's *middle*, which is what the chip's picture is centred
        // on — a hand-off aimed at its base points the chip's slide half a box low.
        if (event.at) {
          const middle = lift.position.y + PARCEL_CENTRE_Y * lift.scale.y;
          if (Math.abs(event.at.y - middle) > 0.02) handedAlpha = null;
        }
      }
      if (parcel.slot.pickup.group.visible) kerbBoxShown += 1;
      if (parcel.slot.flight.visible) {
        stillFlying += 1;
        if (lift.position.y > PARCEL_PAD_LIFT + 0.5) rose += 1;
        if (lift.scale.x > 1.02) swelled += 1;
        if (boxMaterial.transparent && boxMaterial.opacity < 0.9) faded += 1;
        // Up-screen and to the left is world −X for this view, so the box's x must only ever fall.
        if (lift.position.x < kerb.x - 0.5) towardHud += 1;
      }
      if (parcel.slot.dropoff.ring.group.visible) {
        if (padScale() < 0.95) padGrowing += 1;
        if (padScale() === 1) padSettled = true;
      }
    }
    check('and rises, swells and fades on the way out', rose > 8 && swelled > 8 && faded > 8,
      `${rose} frames climbing, ${swelled} swelling, ${faded} fading`);
    check('and sets off toward the corner the chip sits in', towardHud > 6,
      `${towardHud} frames past the kerb toward the HUD`);
    check('and the kerb it left is empty from that frame on',
      kerbBoxShown === 0, `${kerbBoxShown} frames still showing the kerb box`);
    // Exactly one hand-off per pickup: a second is a second chip arrival over the first.
    check('the hand-off to the HUD is its own event, once',
      loadedEvents === 1 && handedAt !== null, `${loadedEvents} loaded`);
    // **And it fires while the box is still going.** At the end of the lift there is nothing left to
    // cross-fade with and the chip reads as a separate pop — which is the version this replaced. The
    // band is around `LIFT_HANDOFF`, and the alpha is the half that actually matters: still visible,
    // clearly on the way out.
    check('and it fires late in the lift, with the box still on screen and fading',
      handedAt !== null && handedAt > 0.6 && handedAt < 0.95
      && handedAlpha !== null && handedAlpha > 0.1 && handedAlpha < 0.6,
      handedAt === null ? 'never handed over'
        : `at ${(handedAt * 100).toFixed(0)}% of the lift, alpha ${handedAlpha?.toFixed(2)}`);
    // ...and the box does eventually go. A lift left running is a box parked in the sky.
    check('and the box is gone by the end of it', stillFlying < 60,
      `${stillFlying} frames airborne of 90`);
    // And the pad it is going to grew out of the road rather than appearing at full size. Asserted on
    // frames of it *part-grown* — "it is visible" would pass against the pop this replaced.
    check('the courier pad grows rather than popping in', padGrowing > 4 && padSettled,
      `${padGrowing} frames part-grown, settled ${padSettled}`);
  } else {
    for (const label of ['a collected box lifts off from the corner it was standing on',
      'and rises, swells and fades on the way out',
      'and sets off toward the corner the chip sits in',
      'and the kerb it left is empty from that frame on',
      'the hand-off to the HUD is its own event, once',
      'and it fires late in the lift, with the box still on screen and fading',
      'and the box is gone by the end of it',
      'the courier pad grows rather than popping in']) check(label, false, 'no setup');
  }

  // The grow/shrink envelopes themselves, shared by the fare disc and the courier pad so the two
  // never become different kinds of event. Endpoints and the overshoot, which is the part a typo
  // turns into a disc that starts full-size or one that never reaches it.
  check('a disc grows from nothing to exactly full size',
    ringGrowScale(0) === 0 && ringGrowScale(1) === 1 && ringGrowScale(2) === 1);
  check('and overshoots on the way, a little', (() => {
    let peak = 0;
    for (let t = 0; t <= 1.0001; t += 0.01) peak = Math.max(peak, ringGrowScale(t));
    return peak > 1.01 && peak < 1.12;
  })(), 'crosses 1 and settles back');
  check('a disc shrinks to nothing and stays there',
    ringShrinkScale(0) === 1 && ringShrinkScale(1) === 0 && ringShrinkScale(3) === 0);

  // The accept flourish. `main.js` drives it off the select pop's envelope, so what is checkable here
  // is the half that lives in the mesh: every opaque part of the car takes the lift *together*. A car
  // whose body lit while its wheels stayed dark reads as the paint changing rather than as the car
  // reacting, and that is exactly what a part left out of this list produces.
  {
    const taxiMesh = createTaxiMesh();
    // The ghost outline's mask and rim are their own materials on purpose and are not part of the
    // flourish. Everything else with an emissive is a candidate.
    const emissives = () => {
      const out = [];
      taxiMesh.group.traverse((node) => {
        if (node.isMesh && node.material?.emissive && !/^ghost/.test(node.name)) {
          out.push(node.material.emissive.getHex());
        }
      });
      return out;
    };
    const dark = emissives();
    taxiMesh.setHighlight(1);
    const lit = emissives();
    taxiMesh.setHighlight(0);
    const back = emissives();

    // Compared frame to frame rather than against zero: **the brake light and both turn signals sit
    // at a non-zero emissive already** — that baked glow is how they light at all (geometry/lights.js)
    // — so "every emissive is 0 at rest" is simply false here, and a check written that way is testing
    // the probe's assumption rather than the car. What matters is which parts *move*.
    const moved = dark.map((h, n) => h !== lit[n]);
    const movedTo = lit.filter((_, n) => moved[n]);
    check('the accept flourish lights every body part of the taxi at once',
      // Shell, roof sign and both steered wheels: four, all to the same value, and all the way back
      // afterwards. A part left out of setHighlight's list is a car whose body lights while a wheel
      // stays dark, which reads as the paint changing rather than the car reacting. (It was five while
      // a parcel rode the rear deck — the load is a chip in the HUD now, and there is nothing on the
      // car to light.)
      moved.filter(Boolean).length === 4
      && new Set(movedTo).size === 1
      && back.every((h, n) => h === dark[n]),
      `${moved.filter(Boolean).length} parts moved to ${new Set(movedTo).size} value(s), all restored ${back.every((h, n) => h === dark[n])}`);
    check('and leaves the brake light and indicators alone',
      // They are not body panels; they are lamps with their own state, and lifting them would read as
      // the taxi braking at the moment it accepted a package.
      dark.filter((h) => h !== 0).length === 3
      && dark.filter((h) => h !== 0).every((h, n) => h === lit.filter((_, i) => dark[i] !== 0)[n]),
      `${dark.filter((h) => h !== 0).length} lamps, unchanged`);
  }

  // --- And deliver it, deterministically -----------------------------------------------------------
  //
  // The end-to-end path lives here rather than in the greedy run above, because here the geometry is
  // chosen rather than drawn: route at the pad, drive, and the payout either lands or it does not.
  if (parcel && parcels.carrying()) {
    // Hold the fare clocks for this leg. The taxi is being driven at the courier pad and nowhere near
    // the rider's drop-off, so without this the rider times out mid-test and the run ends — which is
    // *correct game behaviour* and useless as a test of the courier path. `setPaused` is the same seam
    // the opening tutorial uses to stop charging the player for a lesson.
    fares.setPaused(true);
    const moneyBefore = fares.state.money;
    const earnedBefore = parcels.state.earned;
    const toPad = findRoute(planOrigin(cTraffic.taxi), parcel.dropoff);
    if (toPad) { cTraffic.taxi.route = toPad; cTraffic.taxi.routeConsumed = false; }
    let delivered = 0;
    let outboundAirborne = 0;
    let heldFor = 0;
    let g3 = 0;
    while (delivered === 0 && g3++ < 60 * 240 && !fares.state.gameOver) {
      cTraffic.update(1 / 60);
      fares.update(1 / 60, cTraffic.taxi);
      for (const { type, parcel: p } of parcels.update(1 / 60, cTraffic.taxi, {
        fareSpots: fares.occupiedSpots(), delivered: 9, over: fares.state.gameOver,
      })) {
        if (type === 'delivered') {
          delivered += 1;
          if (p) fares.credit(p.value);
          // How far past *now* the next spawn was pushed, read on the frame the delivery wrote it.
          // The greedy run above counts the same rule over whatever deliveries the city allowed it;
          // this is the one that always runs.
          heldFor = parcels.state.nextSpawnAt - parcels.state.elapsed;
        }
      }
    }
    // Counted *after* the loop, not inside it: the `delivered` event fires on the frame the outbound
    // flight is **launched**, so a loop that breaks on delivery has ticked exactly one frame of it. The
    // first version of this check read "1 frame airborne" and was measuring its own exit condition.
    //
    // The faintest the box gets is tracked *while it flies*, never read at the landing: `updateFlights`
    // calls `rest()` on the same frame it arrives, which puts the opacity back to 1 — so a read taken
    // after `update` returns reports the resting state and would pass against a box that was invisible
    // the whole way. (An earlier version of this did exactly that, printing "opacity 1.00 on contact".)
    const boxMaterial = parcel.slot.flightBox.mesh.material;
    let sawGrow = 0;
    let sawFade = 0;
    let minAlpha = 1;
    for (let step = 0; step < 60; step++) {
      cTraffic.update(1 / 60);
      fares.update(1 / 60, cTraffic.taxi);
      parcels.update(1 / 60, cTraffic.taxi, {
        fareSpots: fares.occupiedSpots(), delivered: 9, over: fares.state.gameOver,
      });
      if (!parcel.slot.flight.visible) continue;
      // Above the pavement and below the deck it left: the reverse flight, arcing down into the pad.
      if (parcel.slot.flight.position.y > PARCEL_PAD_LIFT + 0.2) outboundAirborne += 1;
      if (parcel.slot.flight.scale.x < 0.9) sawGrow += 1;
      if (boxMaterial.transparent && boxMaterial.opacity < 0.9) sawFade += 1;
      minAlpha = Math.min(minAlpha, boxMaterial.opacity);
    }
    check('a package is delivered and paid for', delivered === 1
      && parcels.state.earned === earnedBefore + parcel.value
      && fares.state.money === moneyBefore + parcel.value,
      `$${parcel.value} — courier total $${parcels.state.earned}, run total $${fares.state.money}`);
    check('and the box flies back out to the pad', outboundAirborne > 4,
      `${outboundAirborne} frames airborne on the way out`);
    check('and grows and fades in as it comes out of the car', sawGrow > 4 && sawFade > 4,
      `${sawGrow} frames part-size, ${sawFade} fading`);
    // Never invisible on the way: a box that starts from nothing gives the player no frame to read the
    // load *leaving* off, which is the whole job of the outbound flight. Asserted as a floor across the
    // flight rather than at either end, for the reason noted above.
    check('and never leaves the car out of sight',
      minAlpha >= FLIGHT_MIN_ALPHA - 0.02 && minAlpha < 0.9,
      `faintest ${minAlpha.toFixed(2)} against a ${FLIGHT_MIN_ALPHA} floor`);
    // `sawFade` proves the material was genuinely transparent while it faded — the silent failure is
    // `opacity` moving on a material that never recompiled, which is a bug this project shipped once on
    // the rider figure. This is the *other* half of it: a box left transparent after landing z-sorts
    // wrong for the rest of the run, and the slot is reused.
    check('and is opaque again once it has landed',
      boxMaterial.transparent === false && boxMaterial.depthWrite === true
      && boxMaterial.opacity === 1,
      `transparent ${boxMaterial.transparent}, depthWrite ${boxMaterial.depthWrite}, `
      + `opacity ${boxMaterial.opacity.toFixed(2)}`);
    // Cashing one in must not immediately put the next on the board. This matters more at one slot
    // than it did at two: the delivery is now the moment the board goes *empty*, so without the hold
    // the very next frame is free to refill it and the find becomes a vending machine.
    check('and cashing it in holds the next package off',
      heldFor >= PARCEL_AFTER_DELIVERY - 0.1, `next spawn ${heldFor.toFixed(1)}s out`);
    fares.setPaused(false);
  } else {
    for (const label of ['a package is delivered and paid for',
      'and the box flies back out to the pad',
      'and grows and fades in as it comes out of the car',
      'and never leaves the car out of sight',
      'and is opaque again once it has landed',
      'and cashing it in holds the next package off']) check(label, false, 'no setup');
  }

  // The outbound flight leaves **from the rear deck**, not from the road under the car. Launched at
  // pavement height it starts under the car's own sills, which reads as the box being posted out
  // through the tarmac rather than lifted off the taxi.
  check('a delivery leaves at deck height, not at the wheels',
    Math.abs(TAXI_DECK_Y - PARCEL_PAD_LIFT) > 1
    && TAXI_DECK_Y > PARCEL_PAD_LIFT,
    `deck ${TAXI_DECK_Y.toFixed(2)} vs pavement ${PARCEL_PAD_LIFT.toFixed(2)}`);

  // The run ends. One seam inside parcels.js handles all three ways it can, so this drives the one
  // that does not go through the fare loop at all.
  fares.crash('probe', 'Wrecked!');
  parcels.update(1 / 60, cTraffic.taxi, { fareSpots: [], delivered: 9, over: true });
  let stillVisible = 0;
  for (const slot of parcels.slots) {
    if (slot.pickup.group.visible) stillVisible += 1;
    if (slot.dropoff.group.visible) stillVisible += 1;
  }
  check('the run ending clears every package off the board',
    parcels.state.parcels.length === 0 && stillVisible === 0,
    `${parcels.state.parcels.length} live, ${stillVisible} visible`);
}

// --- Tapping a second waiting rider before the first is picked up -----------------------------
// Regression for a real bug: with two riders on the kerb, tapping one then the other before either
// is collected left both `directed` — the first tap's flag never cleared when the second re-routed
// the taxi. If the new route happened to pass within ARRIVE_RADIUS of the abandoned rider's corner
// too, `update()` resolved a pickup for it as well: two riders "riding" off one seat. An erratic
// player here is whoever taps every un-directed waiter, every frame, the instant carrying() is
// false — the worst case for exactly this.
{
  const xScene = new THREE.Scene();
  const xTraffic = createTraffic(makeRng(seed + 44), xScene, CARS_DEFAULT);
  const fares = createFareSystem(makeRng(seed + 55), xScene);
  xTraffic.warmup(5);

  let elapsed = 0;
  let maxRiding = 0;
  let maxDirected = 0;
  let sawTwoWaiting = false;

  while (elapsed < 400 && !fares.state.gameOver && fares.state.delivered < 6) {
    xTraffic.update(1 / 60);
    for (const { type, fare } of fares.update(1 / 60, xTraffic.taxi)) {
      if (type !== 'pickup') continue;
      // The drop-off dispatches itself, same as dispatchToDropoff in main.js.
      const r = findRoute(planOrigin(xTraffic.taxi), fare.target);
      if (r) { xTraffic.taxi.route = r; xTraffic.taxi.routeConsumed = false; fares.markDirected(fare); }
    }

    maxRiding = Math.max(maxRiding, fares.state.fares.filter((f) => f.stage === 'riding').length);
    maxDirected = Math.max(maxDirected, fares.state.fares.filter((f) => f.directed).length);

    if (!fares.carrying()) {
      const waiters = fares.state.fares.filter((f) => f.stage === 'waiting');
      if (waiters.length >= 2) sawTwoWaiting = true;
      const target = waiters.find((f) => !f.directed);
      if (target) {
        const r = findRoute(planOrigin(xTraffic.taxi), target.target);
        if (r) { xTraffic.taxi.route = r; xTraffic.taxi.routeConsumed = false; fares.markDirected(target); }
      }
    }

    elapsed += 1 / 60;
  }

  check('the board doubles up enough to exercise the switch', sawTwoWaiting);
  check('at most one fare is ever directed at once', maxDirected <= 1, `peak ${maxDirected}`);
  check('switching targets before pickup never seats two riders', maxRiding <= 1, `peak ${maxRiding}`);
}

// --- The trip is public from the moment the rider is --------------------------
// The diamond over the rider's head is the only thing marking someone on the kerb, and the trip it
// belongs to stays hidden until pickup. Every failure mode is silent: a diamond that never appears,
// a drop-off leaking onto the map early, or one that quietly moves between being drawn at spawn
// and being shown at pickup.
{
  const tScene = new THREE.Scene();
  const tTraffic = createTraffic(makeRng(seed + 44), tScene, CARS_DEFAULT);
  const fares = createFareSystem(makeRng(seed + 55), tScene);
  tTraffic.warmup(5);

  let shownOnSpawn = 0;
  let missingPin = 0;
  let wrongCount = 0;
  let wrongPrice = 0;
  let unwinnableClock = 0;
  const budgetSlack = [];
  let movedAtPickup = 0;
  let leakedPin = 0;
  let pinHiddenAtPickup = 0;
  const rimWeights = new Set();
  let wrongOpening = 0;
  let drainedOpening = 0;
  let fillOutOfStep = 0;
  const discOutOfStep = [];
  let ridingFrames = 0;
  let pickups = 0;
  let stillMarked = 0;   // markers that vanished at pickup instead of flying to the taxi
  let sharedJunction = 0;
  let elapsed = 0;

  // Same perfect-player policy as the multi-fare block above, so the board actually doubles up.
  const aim = () => {
    const job = fares.carrying() ?? fares.waiting();
    if (!job || job.directed) return;
    const r = findRoute(planOrigin(tTraffic.taxi), job.target);
    if (r) { tTraffic.taxi.route = r; tTraffic.taxi.routeConsumed = false; fares.markDirected(job); }
  };

  while (elapsed < 400 && !fares.state.gameOver && fares.state.delivered < 6) {
    tTraffic.update(1 / 60);
    for (const { type, fare } of fares.update(1 / 60, tTraffic.taxi)) {
      if (type === 'spawned') {
        shownOnSpawn += 1;
        if (!fare.slot.marker.group.visible) missingPin += 1;
        if (fare.slot.destination.group.visible) leakedPin += 1;
        // A rider appears with their whole clock, so their diamond opens on the top urgency level
        // — except a VIP, whose diamond opens (and stays) on its own fixed purple instead.
        const wantOpening = fare.vip
          ? new THREE.Color(PALETTE.vip).getHexString()
          : urgencyColor(URGENCY_SEGMENTS).getHexString();
        if (diamondHex(fare.slot.marker) !== wantOpening) wrongOpening += 1;
        // And with a full vessel: the crystal is a glass of time, and it is poured at spawn. A
        // VIP's stays full forever rather than draining — see the fillOutOfStep loop below.
        if (fare.slot.marker.getFill() < 0.99) drainedOpening += 1;
        if (fare.blocks !== blockDistance(fare.pickup, fare.dropoff)) wrongCount += 1;
        // Distance price times the shift's multiplier, both settled at spawn — so this reads the
        // multiplier as of *this* frame, which is the one the fare was stamped with. A VIP stacks
        // its own streak multiplier on top (see fares.js); `fare.vipMultiplier` is 1 for everyone
        // else, so the formula is unchanged for an ordinary fare.
        const due = Math.round(priceFor(fare.pickup, fare.dropoff)
          * difficulty.payoutMultiplier(fares.state.delivered)
          * fare.vipMultiplier);
        if (fare.value !== due) wrongPrice += 1;
        // The clock is budgeted from the driving, so it has to cover it with the run's slack in
        // hand. Below 1.0 the rider cannot be delivered even by a perfect drive.
        if (fare.limit < fare.work) unwinnableClock += 1;
        budgetSlack.push(fare.limit / Math.max(1e-6, fare.work));
      }
      if (type === 'pickup') {
        pickups += 1;
        // The pin is promoted, not replanted — a drop-off that jumped at pickup would make the
        // preview a lie and every judgement made from it worthless.
        if (fare.target.i !== fare.dropoff.i || fare.target.j !== fare.dropoff.j) movedAtPickup += 1;
        // It does not clear at pickup any more — it flies to the taxi and keeps draining there.
        if (!fare.slot.marker.group.visible) stillMarked += 1;
        if (!fare.slot.destination.group.visible) pinHiddenAtPickup += 1;
      }
    }

    for (const f of fares.state.fares) {
      // The liquid level *is* the seconds, on both legs — a crystal that drifts from the clock it
      // draws is worse than one that never drained, because it reads as precision and isn't. A
      // VIP's crystal is the one exception: it never drains at all, by design (faremarker.js).
      const want = f.vip ? 1 : Math.max(0, Math.min(1, f.timeLeft / f.limit));
      if (Math.abs(f.slot.marker.getFill() - want) > 1e-6) fillOutOfStep += 1;
      // The ring at the far end of a trip under way wears the clock riding in the car — all three
      // of its layers, on every frame of the ride. A disc a level behind the crystal above the
      // roof would have the board saying two things about one deadline, which is the whole reason
      // the colour was moved onto it.
      if (f.stage === 'riding') {
        ridingFrames += 1;
        const hexes = new Set([...ringHexes(f.slot), diamondHex(f.slot.marker)]);
        if (hexes.size !== 1) discOutOfStep.push([...hexes].join('/'));
      }
      // One outline weight, whatever the fare is doing — waiting, directed at, or riding. It was
      // two for a while (a heavier rim inked the rider the taxi had been sent at), and the change
      // of weight at the hand-off read as the marker becoming a different object mid-trip.
      rimWeights.add(f.slot.marker.rim.scale.toArray().map((n) => n.toFixed(4)).join('/'));
    }

    aim();
    elapsed += 1 / 60;

    const live = fares.state.fares;
    // No two fares may claim the same junction at either end, even while the far ends are hidden:
    // a rider spawning on another fare's drop-off ends up sharing a kerb corner once it appears.
    // A riding fare's `target` *is* its drop-off, so it contributes one junction, not two.
    const ends = live.flatMap((f) => (f.stage === 'waiting'
      ? [`${f.target.i},${f.target.j}`, `${f.dropoff.i},${f.dropoff.j}`]
      : [`${f.target.i},${f.target.j}`]));
    if (new Set(ends).size !== ends.length) sharedJunction += 1;
  }

  check('a waiting rider shows their diamond', shownOnSpawn > 0 && missingPin === 0,
    `${shownOnSpawn} spawns, ${missingPin} missing`);
  check('the block count matches the trip', wrongCount === 0, `${wrongCount} mismatched`);
  check('a fresh rider\'s diamond opens on full urgency', wrongOpening === 0,
    `${wrongOpening} opened wrong`);
  check('and opens with a full vessel', drainedOpening === 0, `${drainedOpening} opened drained`);
  // Catches the wiring, not the model: `setUrgency` alone leaves a crystal that steps in quarters
  // and never moves between them, which is exactly the marker this replaced.
  check('the fill tracks the seconds on every live fare', fillOutOfStep === 0,
    `${fillOutOfStep} frames out of step`);
  // Same argument one step out: the ring the taxi is driving at is the same clock as the crystal
  // over its roof, so the two may never be seen at different levels.
  check('the drop-off ring wears the clock riding in the car',
    ridingFrames > 0 && discOutOfStep.length === 0,
    `${ridingFrames} frames aboard, ${discOutOfStep.length} out of step`
    + (discOutOfStep.length ? ` (e.g. ${discOutOfStep[0]})` : ''));
  check('the price agrees with the advertised distance', wrongPrice === 0, `${wrongPrice} mispriced`);
  // The clock now comes from the trip rather than a constant, so "is it enough?" is a live
  // question every spawn rather than something settled once in a comment.
  check('every fare spawns with a clock that covers its own driving',
    unwinnableClock === 0 && budgetSlack.length > 0,
    `${budgetSlack.length} fares, tightest ${Math.min(...budgetSlack).toFixed(2)}x work`);
  check('the drop-off stays hidden while the rider waits', leakedPin === 0, `${leakedPin} leaked`);
  check('the drop-off appears at pickup', pickups > 0 && pinHiddenAtPickup === 0,
    `${pickups} pickups, ${pinHiddenAtPickup} still hidden`);
  check('the drop-off lands where it was drawn at spawn', movedAtPickup === 0,
    `${movedAtPickup} moved`);
  check('the diamond stays up through the pickup', stillMarked === 0, `${stillMarked} vanished`);
  // Which rider the car is on its way to is the route band's job. The diamond's outline says
  // nothing about it and never changes weight — on the kerb, once directed at, or over the taxi.
  check('the diamond wears one outline weight for its whole life',
    rimWeights.size === 1
    && rimWeights.has(RIM_SCALE.toArray().map((n) => n.toFixed(4)).join('/')),
    [...rimWeights].join(', '));
  // --- The drop-off is a ring and nothing else.
  //
  // Read off the built marker rather than assumed. The head that used to float over it is gone, so
  // the assertion is as much about what is *not* there: anything standing on the corner would be a
  // second silhouette competing with the rider's diamond, which is the whole reason it went.
  {
    const pin = createDestinationPin();
    const opening = urgencyColor(URGENCY_SEGMENTS).getHexString();
    const painted = pin.ring.group.children.map((m) => m.material.color.getHexString()).join('/');
    // One mark at three weights, so rim, fill and sweep are always the same hex — and it is a hex
    // off the urgency scale now rather than a teal outside it. Which *level* a live drop-off is
    // standing at is asserted against a played run below.
    check('the drop-off ring opens on a full clock, rim and fill and sweep',
      painted === `${opening}/${opening}/${opening}`, painted);
    // The ring group and nothing else *visible* on the corner. The tap target shares the group —
    // it has to, that placement is what puts it over the mark (geometry/marker.js) — so it is named
    // rather than counted out.
    const onCorner = pin.postGroup.children.filter((c) => c !== pin.ring.group);
    check('the drop-off stands nothing on its corner',
      pin.standing === null && onCorner.length === 1 && onCorner[0].userData.pickable === 'destination',
      `${pin.postGroup.children.length} on the corner`);
  }
  check('no two fares claim the same junction', sharedJunction === 0, `${sharedJunction} frames`);

  // --- Which marker a tap lands on ---------------------------------------------------------------
  //
  // Reported from a phone: two riders a junction apart, a tap dead on the yellow one dispatched the
  // taxi at the green one below it. Both faults were in the tap target — see the block at the top of
  // geometry/marker.js — and neither is visible in a screenshot, because the target is invisible and
  // the wrong answer looks exactly like a mis-aimed thumb.
  //
  // So it is driven through the real picker, on a real phone-shaped frame, at the pixels a thumb
  // actually goes to. `createPicker` binds a DOM listener, which is the whole of what it needs from
  // a browser, so a stand-in element with one handler on it is the real code path.
  {
    const W = 390;
    const H = 844;
    const pScene = new THREE.Scene();
    const pCam = createCityCamera(W / H, { zoom: PLAY_ZOOM, target: [0, 0] });
    // The renderer would do this every frame; nothing here draws, and a camera whose world matrix
    // has never been composed raycasts straight down -Z from the origin. That mistake passes every
    // check it is asked, since one ray answers the same for every marker on it.
    pCam.camera.updateMatrixWorld(true);

    // A rider on each of nine junctions — a 3x3 patch, so every marker has a neighbour along each
    // road and one straight down the screen diagonal. Placed exactly as `place()` in game/fares.js
    // does it: root on the junction, corner group out on the kerb.
    const pins = new Map();
    for (let i = 1; i <= 3; i++) {
      for (let j = 1; j <= 3; j++) {
        const pin = createPassengerPin(createPerson);
        const centre = intersectionCentre(i, j);
        const corner = cornerFor(i, j);
        pin.group.position.set(centre.x, 0.12, centre.z);
        pin.postGroup.position.set(corner.x - centre.x, KERB_H, corner.z - centre.z);
        pin.group.userData.junction = `${i},${j}`;
        pin.group.visible = true;
        pScene.add(pin.group);
        pins.set(`${i},${j}`, pin);
      }
    }
    pScene.updateMatrixWorld(true);

    let picked = null;
    let handler = null;
    const canvas = {
      addEventListener: (type, fn) => { if (type === 'click') handler = fn; },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    };
    createPicker(pCam.camera, canvas, () => [...pins.values()].map((p) => p.group), (kind, hit) => {
      picked = null;
      for (let node = hit?.object; node; node = node.parent) {
        if (node.userData?.junction) { picked = node.userData.junction; break; }
      }
    });
    // Where a world point lands on this frame, in CSS pixels — the inverse of the picker's own NDC.
    const v = new THREE.Vector3();
    const screenOf = (x, y, z) => {
      v.set(x, y, z).project(pCam.camera);
      return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
    };
    const tapAt = (px, py) => { picked = null; handler({ clientX: px, clientY: py }); return picked; };
    const tapOn = (x, y, z) => { const p = screenOf(x, y, z); return tapAt(p.x, p.y); };

    // 1. The thing the player aims at. Three points on every rider, each one a place a thumb
    //    plausibly lands: the middle of their disc, their own head, and the crystal over it — which
    //    has always answered for the fare under it and has to keep doing so.
    const missed = [];
    for (const [id, pin] of pins) {
      const c = cornerFor(...id.split(',').map(Number));
      const aims = [
        ['disc', c.x, KERB_H + RING_Y, c.z],
        ['head', c.x, KERB_H + 2.9, c.z],
        ['crystal', c.x, KERB_H + CRYSTAL_TOP - DIAMOND_HALF_H, c.z],
      ];
      for (const [what, ...at] of aims) {
        const got = tapOn(...at);
        if (got !== id) missed.push(`${id} ${what} -> ${got}`);
      }
      // And the disc's own near edge, which is the part of the mark closest to the thumb coming up
      // the screen. Before the fix this was the marker below's, on every rider on the board.
      const edge = screenOf(c.x, KERB_H + RING_Y, c.z);
      const got = tapAt(edge.x, edge.y + RING_R * 0.545 * (H / (2 * PLAY_ZOOM)));
      if (got !== id) missed.push(`${id} disc edge -> ${got}`);
    }
    check('a tap on a rider selects that rider, not the one down-screen of them',
      missed.length === 0, missed.slice(0, 4).join(', ') || '9 riders, 4 aims each');

    // 2. No marker may claim a pixel that belongs to another one. Swept rather than argued: the
    //    separations that make it true — 14.1 screen units sideways to the next junction along a
    //    road, 15.4 straight down to the one on the diagonal — are the sort of arithmetic that
    //    stays written down while a constant moves under it.
    const raycaster = new THREE.Raycaster();
    const roots = [...pins.values()].map((p) => p.group);
    const mid = screenOf(...(() => { const c = cornerFor(2, 2); return [c.x, KERB_H, c.z]; })());
    let contested = 0;
    let owned = 0;
    for (let py = mid.y - 160; py <= mid.y + 160; py += 4) {
      for (let px = mid.x - 160; px <= mid.x + 160; px += 4) {
        raycaster.setFromCamera(
          new THREE.Vector2((px / W) * 2 - 1, -(py / H) * 2 + 1), pCam.camera,
        );
        const claims = new Set();
        for (const h of raycaster.intersectObjects(roots, true)) {
          for (let node = h.object; node; node = node.parent) {
            if (node.userData?.junction) { claims.add(node.userData.junction); break; }
          }
        }
        if (claims.size > 1) contested += 1;
        if (claims.size === 1) owned += 1;
      }
    }
    check('and no two markers on the board can claim the same pixel',
      contested === 0 && owned > 2000, `${contested} contested, ${owned} owned`);

    // 3. The size of the thing, in the units it was designed in. A target that is correct and 20px
    //    across is a different bug wearing the same face, and the only place the answer exists is
    //    on the built mesh.
    const perUnit = H / (2 * PLAY_ZOOM);
    const target = pins.get('2,2').postGroup.children.find((c) => c.userData?.pickable);
    const { width, height } = target.geometry.parameters;
    check('a rider\'s tap target is comfortably past a fingertip',
      width * perUnit >= 44 && height * perUnit >= 44,
      `${(width * perUnit).toFixed(0)} x ${(height * perUnit).toFixed(0)} px`);
    // Flat against the screen, so what it covers is what you see. A target with any depth to it is
    // the original bug: its far end projects up the frame and over the marker behind it.
    const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(target.quaternion);
    check('and it lies in the screen plane, over the kerb corner rather than the junction',
      facing.dot(VIEW_DIR) > 0.9999 && Math.abs(target.position.dot(RIGHT)) < 1e-9
      && Math.abs(target.position.dot(VIEW_DIR)) < 1e-9,
      `facing ${facing.dot(VIEW_DIR).toFixed(4)}`);
  }

  // --- The rider's diamond changes colour as the clock drains.
  //
  // The colour is the whole of what that marker says and none of it is visible in a still image:
  // it has to walk green → yellow → orange → red as the clock runs down, one step per quarter, and
  // never back up the scale. Drive a fare's clock by hand and read the crystal back.
  {
    const diamond = fares.slots[0].marker;
    const seen = [];
    const wrongColour = [];
    for (let step = 0; step <= 20; step++) {
      const fraction = 1 - step / 20;
      const level = urgencyLevel(fraction);
      diamond.showAt(level, 0, 0);
      const want = urgencyColor(level).getHexString();
      const got = diamondHex(diamond);
      if (got !== want) wrongColour.push(`${level}: ${got} != ${want}`);
      // Crystal and disc are one statement. A disc lagging a level behind would have the board
      // saying two different things about the same rider.
      for (const disc of riderRingHexes(diamond)) {
        if (disc !== want) wrongColour.push(`${level} disc: ${disc} != ${want}`);
      }
      if (got !== seen.at(-1)) seen.push(got);
    }
    check('each urgency level paints the diamond its own colour', wrongColour.length === 0,
      wrongColour.join('; '));
    // Four levels above zero and one at it, but 1 and 0 share red, so a full drain shows exactly
    // four distinct colours in scale order and never repeats one it has already left.
    const scale = [...new Set(PALETTE.urgency.map((h) => new THREE.Color(h).getHexString()))]
      .reverse();
    check('the diamond walks the urgency scale from green to red',
      seen.join(' -> ') === scale.join(' -> '), seen.join(' -> '));

    // The rim must stay black at the one weight it has: it was yellow once, and yellow is a colour
    // this very crystal wears for a quarter of every clock, so a yellow rim on a yellow diamond is
    // no rim at all. That it never *changes* weight is asserted across a played run above.
    const hull = diamond.rim;
    check('the diamond wears a black rim at RIM_SCALE',
      hull.material.color.getHexString() === '000000'
      && hull.scale.distanceTo(RIM_SCALE) < 1e-9,
      `${hull.material.color.getHexString()}@${hull.scale.toArray().map((n) => n.toFixed(3))}`);

    // And that weight is a *distance*, which a single scale factor no longer buys: the plumbob is
    // three times longer below its equator than it is wide, so one multiplier would hang a black
    // needle off the bottom point and shave the flanks. Measured corner by corner — every vertex of
    // the hull against the vertex of the body it came from, which is where the rim is widest and so
    // where a wrong number shows.
    //
    // Never *under* the weight, and never more than a tenth over. It is not exact at the equator
    // and cannot be: those four corners take the horizontal offset in full and then ride up a
    // little on the vertical scale as well, which lands them at 0.232 against 0.220. That is 0.09px
    // at play zoom. The tips, where a scale factor does real damage, are exact.
    {
      const body = diamond.mesh.geometry.attributes.position;
      const corner = new THREE.Vector3();
      let thinnest = Infinity;
      let thickest = 0;
      for (let i = 0; i < body.count; i++) {
        corner.fromBufferAttribute(body, i);
        const offset = corner.length() === 0 ? RIM_OFFSET
          : corner.distanceTo(corner.clone().multiply(hull.scale));
        thinnest = Math.min(thinnest, offset);
        thickest = Math.max(thickest, offset);
      }
      check('and it stands its own weight off every corner of the crystal',
        thinnest >= RIM_OFFSET - 1e-6 && thickest <= RIM_OFFSET * 1.1,
        `${thinnest.toFixed(3)} to ${thickest.toFixed(3)} against ${RIM_OFFSET}`);
    }

    // --- The plumbob's winding.
    //
    // Hand-written triangles need their winding asserted, not eyeballed (see CLAUDE.md — the
    // roadworks ramp shipped inside out and read as z-fighting). It bites twice on this shape: the
    // crystal is `flatShading`, which takes its normal from a screen-space derivative and so from
    // the rendered winding, and the outline hull draws the same geometry back-faces-only, so a
    // flipped triangle is both a facet lit from behind and a hole in the rim.
    //
    // Computed **from the winding**, not read back off the normal attribute:
    // `computeVertexNormals` averages a reversed triangle into whatever its neighbours say, which
    // is exactly the laundering this is here to catch. A convex shape around the origin gives the
    // test: every face normal must point away from the centre of its own triangle.
    {
      const pos = diamond.mesh.geometry.attributes.position;
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      const edge = new THREE.Vector3();
      const n = new THREE.Vector3();
      const centre = new THREE.Vector3();
      let inward = 0;
      let faces = 0;
      for (let i = 0; i < pos.count; i += 3) {
        a.fromBufferAttribute(pos, i);
        b.fromBufferAttribute(pos, i + 1);
        c.fromBufferAttribute(pos, i + 2);
        n.copy(b).sub(a).cross(edge.copy(c).sub(a)).normalize();
        centre.copy(a).add(b).add(c).divideScalar(3);
        faces += 1;
        // The origin is inside the crystal, so an outward normal has a positive dot with any point
        // on its own face. A reversed triangle fails this by exactly the sign.
        if (n.dot(centre) <= 0) inward += 1;
      }
      check('every facet of the crystal faces outwards',
        faces === 8 && inward === 0, `${faces} faces, ${inward} wound inside out`);
    }

    // --- The level change kicks.
    //
    // A hue that snaps between four steps is easy to miss on a 29px shape at the edge of the eye,
    // so a change swells and hops the crystal. None of that is visible in a still: drive the clock
    // by hand and watch the scale over the frames after a step.
    diamond.showAt(URGENCY_SEGMENTS, 0, 0);
    let t = 0;
    diamond.update(t);
    const restScale = diamond.mesh.scale.x;
    diamond.setUrgency(URGENCY_SEGMENTS - 1);
    let peakScale = 0;
    let peakLift = 0;
    let framesKicking = 0;
    for (let f = 0; f < 60; f++) {
      t += 1 / 60;
      diamond.update(t);
      if (diamond.isKicking()) framesKicking += 1;
      peakScale = Math.max(peakScale, diamond.mesh.scale.x);
      // Against the bounce this frame would have shown on its own, so the lift is the kick's.
      peakLift = Math.max(peakLift, diamond.mesh.position.y - bounceOffset(t + PHASE_0));
    }
    check('a level change swells the diamond and settles it back',
      peakScale > restScale * 1.05 && peakScale <= restScale * (1 + KICK_SCALE) + 1e-6
      && Math.abs(diamond.mesh.scale.x - restScale) < 1e-6,
      `peak ${peakScale.toFixed(3)}, back to ${diamond.mesh.scale.x.toFixed(3)}`);
    check('it hops on the same beat', peakLift > 0.2 && peakLift <= KICK_HOP + 1e-6,
      `${peakLift.toFixed(2)} units`);
    // Long enough to be seen, short enough that it is over well before the next level lands.
    check('the kick is a beat, not a state',
      framesKicking > 10 && framesKicking < 40 && !diamond.isKicking(),
      `${framesKicking} frames`);

    // A marker that pops the moment it appears is announcing a change that hasn't happened.
    diamond.showAt(URGENCY_SEGMENTS, 0, 0);
    diamond.update(t);
    check('a fresh rider\'s diamond does not kick on spawn',
      !diamond.isKicking() && Math.abs(diamond.mesh.scale.x - restScale) < 1e-6);
    // Once the kick is spent the diamond is back on the plain bounce and nothing else.
    check('the diamond settles back onto its bounce',
      Math.abs(diamond.mesh.position.y - bounceOffset(t + PHASE_0)) < 1e-6,
      `${diamond.mesh.position.y.toFixed(3)}`);
  }

  // A waiting fare offers exactly one target: its rider. Offering the hidden drop-off too would
  // put an invisible 20-unit hit box on a junction the player cannot see anything at.
  const kerb = fares.waiting();
  if (kerb) {
    const hittable = fares.pickables();
    check('a waiting fare offers only its rider as a target',
      hittable.includes(kerb.slot.passenger.group)
      && !hittable.includes(kerb.slot.destination.group));
    check('a tap on the rider resolves to their fare',
      fares.fareFor(kerb.slot.passenger.group) === kerb);
  } else {
    check('a waiting fare offers only its rider as a target', true, 'no waiter at exit');
    check('a tap on the rider resolves to their fare', true, 'no waiter at exit');
  }
}

// --- The select pop --------------------------------------------------------------------------
// A tap on a rider is answered on the corner it landed on: the figure and the crystal over their
// head swell together and settle back (game/selectpop.js). It is the only feedback under the
// finger — what the tap *means* is the route band, and that starts a junction away and runs off
// across the city — so a pop that silently stopped firing would leave a landed tap looking exactly
// like a missed one. None of it shows in a still, so drive the frames and read the scales.
{
  const kScene = new THREE.Scene();
  const kTraffic = createTraffic(makeRng(seed + 44), kScene, CARS_DEFAULT);
  const fares = createFareSystem(makeRng(seed + 55), kScene);
  kTraffic.warmup(5);
  // Held still, so the taxi cannot wander into the rider mid-pop and turn the fare into a ride
  // halfway through the measurement.
  kTraffic.taxi.parked = true;
  fares.update(1 / 60, kTraffic.taxi);

  const fare = fares.waiting();
  const figure = fare?.slot.passenger.postGroup;
  const crystal = fare?.slot.marker;
  // ...and then moved out of range outright, rather than trusted to be. `parked` only stops the
  // car driving itself, and the board is biased to spawn near the taxi (`spawnBias`): a taxi
  // standing mid-block can be left inside ARRIVE_RADIUS of the corner the rider lands on, which
  // collects them on the very next update. That takes the figure's half of the pop with it — the
  // swell only runs while the fare is `waiting` — and reads as the pop having stopped firing.
  // Nothing calls `kTraffic.update` past this point, so the position sticks.
  if (fare) {
    const kAway = intersectionCentre(fare.target.i, fare.target.j);
    kTraffic.taxi.x = kAway.x + HALF_SPAN_X;
    kTraffic.taxi.z = kAway.z + HALF_SPAN_Z;
  }
  if (!fare) {
    check('a fresh rider is not already popping', false, 'no rider on the kerb');
  } else {
    // Nothing has been tapped yet. A rider that swelled on spawn would be acknowledging a gesture
    // nobody made — the same rule the diamond's kick follows.
    fares.update(1 / 60, kTraffic.taxi);
    // Whichever mesh the rider's own colour lives on — the merged torso is first, and it is the
    // one a flash has to reach. Read off the material the way a player reads it off the screen.
    const skin = fare.slot.passenger.standing.group.children[0].material;
    check('a fresh rider is not already popping',
      !crystal.isPopping() && Math.abs(figure.scale.x - 1) < 1e-9
      && Math.abs(crystal.mesh.scale.x - 1) < 1e-9,
      `figure ${figure.scale.x.toFixed(3)}, crystal ${crystal.mesh.scale.x.toFixed(3)}`);
    check('and is not already lit',
      skin.emissive.getHex() === 0x000000
      && Math.abs(crystal.mesh.material.emissiveIntensity - EMISSIVE) < 1e-9,
      `rider ${skin.emissive.getHexString()}, crystal ${crystal.mesh.material.emissiveIntensity}`);

    fares.markDirected(fare);
    let peakFigure = 0;
    let peakCrystal = 0;
    let peakFigureFrame = -1;
    let peakCrystalFrame = -1;
    let dipFigure = Infinity;
    let framesPopping = 0;
    let peakRiderLit = 0;
    let peakCrystalLit = 0;
    let dimmedRider = 0;      // frames the flash pushed the figure *below* its resting black
    let dimmedCrystal = 0;    // and the crystal below its resting emissive
    for (let f = 0; f < 60; f++) {
      fares.update(1 / 60, kTraffic.taxi);
      if (crystal.isPopping()) framesPopping += 1;
      if (figure.scale.x > peakFigure) { peakFigure = figure.scale.x; peakFigureFrame = f; }
      if (crystal.mesh.scale.x > peakCrystal) { peakCrystal = crystal.mesh.scale.x; peakCrystalFrame = f; }
      dipFigure = Math.min(dipFigure, figure.scale.x);
      const lit = crystal.mesh.material.emissiveIntensity;
      peakRiderLit = Math.max(peakRiderLit, skin.emissive.r);
      peakCrystalLit = Math.max(peakCrystalLit, lit);
      if (skin.emissive.r < -1e-9) dimmedRider += 1;
      if (lit < EMISSIVE - 1e-9) dimmedCrystal += 1;
    }

    // Big enough to be seen under a fingertip, and never past the amplitude the constants promise
    // — this is the one cue a player gets that the tap landed, and it is measured in pixels
    // (~26px → ~31px on the figure, ~29px → ~35px on the crystal) rather than in taste.
    check('a tap swells the rider and their crystal',
      peakFigure > 1.05 && peakFigure <= 1 + POP_SCALE_RIDER + 1e-6
      && peakCrystal > 1.05 && peakCrystal <= 1 + POP_SCALE_DIAMOND + 1e-6,
      `figure ${peakFigure.toFixed(3)}, crystal ${peakCrystal.toFixed(3)}`);
    // One gesture, not two objects that happened to be tapped at once: both halves take their zero
    // from the same frame's `state.elapsed` and ride the same envelope, so they peak together.
    check('the two halves pop on the same curve',
      peakFigureFrame === peakCrystalFrame && peakFigureFrame >= 0,
      `figure at frame ${peakFigureFrame}, crystal at ${peakCrystalFrame}`);
    // The undershoot on the way back is what gives the eye an ending to see — without it the last
    // third is a barely-moving object slowly stopping, which reads as lag rather than as a pop.
    check('it settles back through rest before it lands',
      dipFigure < 1 - 1e-3 && dipFigure > 1 - POP_SCALE_RIDER * 0.2,
      `dips to ${dipFigure.toFixed(4)}`);
    // A beat, not a state: over well inside half a second, and finishing at exactly rest rather
    // than parking the rider a few percent large for the rest of their life on the kerb.
    check('the pop is a beat that lands back at rest',
      framesPopping > 18 && framesPopping < 32 && !crystal.isPopping()
      && Math.abs(figure.scale.x - 1) < 1e-9 && Math.abs(crystal.mesh.scale.x - 1) < 1e-9,
      `${framesPopping} frames, figure ${figure.scale.x.toFixed(4)}`);

    // --- The highlight.
    //
    // The second channel the same envelope drives: both objects light up and fade back. A swell on
    // its own is a shape changing size, which the crystal already does three other ways (bounce,
    // kick, panic pulse) — getting brighter is the one thing nothing else on that corner does.
    check('the tap lights the rider and the crystal',
      peakRiderLit > RIDER_HIGHLIGHT * 0.8 && peakRiderLit <= RIDER_HIGHLIGHT + 1e-9
      && peakCrystalLit > EMISSIVE * 2 && peakCrystalLit <= HIGHLIGHT_EMISSIVE + 1e-9,
      `rider ${peakRiderLit.toFixed(3)}, crystal ${peakCrystalLit.toFixed(3)}`);
    // The scale undershoots and that is the best part of it; the *light* must not, or the marker
    // reads as having been switched off rather than as having finished. Hence the clamp in
    // `popHighlight` — this is the assertion that says why it is there.
    check('the light never dips below rest on the way back',
      dimmedRider === 0 && dimmedCrystal === 0,
      `${dimmedRider} rider frames, ${dimmedCrystal} crystal frames under rest`);
    check('and it lands back exactly where it started',
      skin.emissive.getHex() === 0x000000
      && Math.abs(crystal.mesh.material.emissiveIntensity - EMISSIVE) < 1e-9,
      `rider ${skin.emissive.getHexString()}, crystal ${crystal.mesh.material.emissiveIntensity}`);

    // Re-tapping a rider the taxi is already on its way to has to pop again. It is an
    // acknowledgement of a gesture, not a state to reconcile — a second tap that did nothing reads
    // as the tap having been swallowed.
    fares.markDirected(fare);
    fares.update(1 / 60, kTraffic.taxi);
    fares.update(1 / 60, kTraffic.taxi);
    check('tapping the same rider again pops again',
      crystal.isPopping() && figure.scale.x > 1 + 1e-6,
      `figure ${figure.scale.x.toFixed(3)}`);
  }
}

// --- The indicator runs either side of the turn -----------------------------------------------
// The lamp used to be pinned to `state === 'turn'`, which is the arc plus its STOP_SETBACK run-up:
// it lit 0.4s before the junction and went out on the frame the car landed, so it read as a car
// flashing *because* it was cornering. It now comes off the car's intent SIGNAL_LEAD units back and
// runs SIGNAL_LINGER past the landing, which makes two separate things checkable — how much warning
// the lamp gives, and whether the warning was true. The second is the one with teeth: a turn chosen
// at the hold line cannot be indicated before it, so buying the warning meant deciding earlier, and
// a decision that can still be overruled at the line (a closure, a siren, a flee, a refused left,
// the free right at a red) is a lamp that can end up pointing the wrong way.
{
  const gScene = new THREE.Scene();
  // A full board rather than CARS_DEFAULT: the queues are half of what is being measured — a car
  // held at a red indicates for as long as it waits — and 24 cars over two minutes is ~560 turns,
  // which is a population rather than a handful.
  const gTraffic = createTraffic(makeRng(seed + 44), gScene, 24);
  gTraffic.warmup(5);
  const gDt = 1 / 60;
  let entered = 0;         // real turns begun — a straight-through is not one (see `dOut !== d`)
  let ownLamp = 0;         // ...under the lamp for the hand actually taken
  let wrongLamp = 0;       // ...under the lamp for the other one
  const gLeads = [];       // how long that lamp had been up when the arc began
  const gTails = [];       // and how long it ran on after the car landed
  const gTurning = new Map();
  const gTail = new Map();
  for (let f = 0; f < 60 * 120; f++) {
    const gBefore = new Map(gTraffic.cars.map((c) => [c, {
      state: c.state, hand: c.signalHand, t: c.signalT,
    }]));
    gTraffic.update(gDt);
    for (const car of gTraffic.cars) {
      const was = gBefore.get(car);
      if (!was) continue;
      const tail = gTail.get(car);
      if (tail) {
        if (car.signalHand === tail.hand) tail.frames += 1;
        else { gTails.push(tail.frames * gDt); gTail.delete(car); }
      }
      if (car.state === 'turn' && car.turn && car.turn.hand !== 'straight') {
        gTurning.set(car, car.turn.hand);
      }
      if (was.state !== 'turn' && car.state === 'turn' && car.turn
        && car.turn.hand !== 'straight') {
        entered += 1;
        if (was.hand === car.turn.hand) { ownLamp += 1; gLeads.push(was.t); }
        else if (was.hand !== null) wrongLamp += 1;
      }
      if (was.state === 'turn' && car.state === 'drive' && gTurning.has(car)) {
        gTail.set(car, { hand: gTurning.get(car), frames: 0 });
        gTurning.delete(car);
      }
    }
  }
  const gMedian = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];

  // Two minutes of a 24-car city is ~560 turns, so these are population numbers rather than
  // anecdotes. The ones without a lamp are the free right at a red taken by a car whose dice had
  // rolled straight — it turns unindicated, which is what every car did before this change.
  check('a car turns under its own lamp or none, never the other one',
    entered > 300 && wrongLamp === 0 && ownLamp / entered > 0.8,
    `${entered} turns — ${ownLamp} under their own lamp, ${entered - ownLamp - wrongLamp} under `
    + `none, ${wrongLamp} under the wrong one`);

  // SIGNAL_LEAD / SPEED = 0.82s at cruise, and the median lands on it because most cars meet their
  // junction at cruise. The long tail is a queue: a car held at a red indicates for as long as it
  // waits, which is what a queue of blinkers is supposed to look like.
  check('and it has been indicating for most of a second first',
    gMedian(gLeads) > (SIGNAL_LEAD / SPEED) * 0.9,
    `median ${gMedian(gLeads).toFixed(2)}s of lamp before the arc, longest `
    + `${Math.max(...gLeads).toFixed(2)}s`);

  // Measured to the frame the lamp changes rather than to the frame it goes dark, so a landing
  // straight into the next junction's indication ends this tail rather than extending it. The
  // median is a couple of frames under SIGNAL_LINGER because the frame that spends the last of it
  // is the frame the hand clears.
  check('and it keeps indicating after it lands',
    gTails.length > 300 && Math.abs(gMedian(gTails) - SIGNAL_LINGER) < 0.1,
    `${gTails.length} landings, median ${gMedian(gTails).toFixed(2)}s of lamp after the arc `
    + `against SIGNAL_LINGER ${SIGNAL_LINGER}`);
}

// --- Ring road and signal health -------------------------------------------
// The ring has no signals, so joining traffic yields into gaps instead of waiting for a phase.
// The failure mode that matters is a car queueing at the perimeter forever with no way in, which
// no screenshot would reveal — so the assertion is on the longest time any car stands still.
{
  const rScene = new THREE.Scene();
  const rTraffic = createTraffic(makeRng(seed + 44), rScene, 24);
  let longestWait = 0;
  const stopped = new Map(rTraffic.cars.map((c) => [c, 0]));
  let prev = rTraffic.cars.map((c) => ({ x: c.x, z: c.z }));

  for (let step = 0; step < 300 * 60; step++) {
    rTraffic.update(1 / 60);
    rTraffic.cars.forEach((c, k) => {
      const moved = Math.hypot(c.x - prev[k].x, c.z - prev[k].z);
      stopped.set(c, moved < 0.005 ? stopped.get(c) + 1 / 60 : 0);
      longestWait = Math.max(longestWait, stopped.get(c));
      prev[k] = { x: c.x, z: c.z };
    });
  }

  check('nobody is stranded at an unsignalised junction', longestWait < 45,
    `longest wait ${longestWait.toFixed(1)}s`);

  // Asked of the network, which is what the sim now obeys. `isUnsignalised` in grid.js still
  // answers the same on this seed, but it answers from `(i, j)` alone — it cannot see that a
  // closure has left an interior junction with nothing to arbitrate, so asserting against it would
  // be testing a function no car consults.
  const net = cityNetwork();
  const signalled = (i, j) => net.nodeByGrid(i, j).signal !== null;
  const ringCorners = [[0, 0], [0, GRID_J], [GRID_I, 0], [GRID_I, GRID_J]];
  // The whole ring is light-free, corners included. A corner has two arms meeting at a right
  // angle, so both movements through it are bends that sweep opposite sides and never cross —
  // `buildConflicts` returns nothing for either, and `bakeSignals` drops the signal on that
  // basis. Asserted alongside `uncontrolled`, because dropping the light is only half of it: a
  // corner left with a priority street would have one arm yielding into a 24-unit gap for traffic
  // that is turning away from it, which is a stop at a bend for no reason.
  check('ring corners carry no signal', ringCorners.every(([i, j]) => !signalled(i, j)));
  check('and nobody yields at one either',
    ringCorners.every(([i, j]) => net.nodeByGrid(i, j).uncontrolled
      && net.nodeByGrid(i, j).inbound.every((lane) => net.laneSignal(lane, 0).open)));
  check('the rest of the ring has none',
    !signalled(1, 0) && !signalled(0, 1) && signalled(1, 1));
  // An interior junction is untouched — the corners are dropped for having no conflicts, not for
  // sitting on the ring, and a normal four-way is full of them.
  check('an interior junction still arbitrates', !net.nodeByGrid(2, 2).uncontrolled);

  const perCar = rTraffic.stats.distance / rTraffic.stats.time / rTraffic.cars.length;
  check('traffic moves better than the old fixed-phase grid', perCar > 4.14,
    `${perCar.toFixed(2)} vs 4.14 units/s per car`);

  // Loco Mode should fly through ring junctions too, not just interior signalised ones. The
  // priority-junction override used to skip ring junctions on the grounds that they had no phase
  // to override; the ring/cross branches now consult `priorityCovers` and route through the
  // signal model, so `lightPhase` at the taxi's target junction reads green on its axis whether
  // it's a signalised interior or a yield-controlled ring approach.
  const boostScene = new THREE.Scene();
  const boostTraffic = createTraffic(makeRng(seed + 77), boostScene, 1);
  const bTaxi = boostTraffic.taxi;
  bTaxi.boost = true;
  bTaxi.d = 3; bTaxi.i = 2; bTaxi.j = 0;   // heading NZ toward a non-corner ring junction
  boostTraffic.update(1 / 60);
  const ringPhase = lightPhase(bTaxi.i, bTaxi.j, boostTraffic.stats.time);
  check('boost forces the ring junction green on the taxi axis',
    ringPhase.axis === 'z' && !ringPhase.yellow, `axis=${ringPhase.axis} yellow=${ringPhase.yellow}`);

  // ...but the lamps must not follow the hold. Loco Mode is meant to *look* like running every
  // red — the yielding happens underneath, in `canProceed`. Heads that flipped green as the taxi
  // arrived made the city read as politely opening up instead.
  const shown = displayPhase(bTaxi.i, bTaxi.j, boostTraffic.stats.time);
  setPriorityJunction(null);
  const honest = lightPhase(bTaxi.i, bTaxi.j, boostTraffic.stats.time);
  check('the signal heads ignore the boost hold',
    shown.axis === honest.axis && shown.yellow === honest.yellow && shown.axis !== ringPhase.axis,
    `shown ${shown.axis}/${shown.yellow}, honest ${honest.axis}/${honest.yellow}`);

  // Loco Mode weaves *inside its lane*. It used to slide a full LANE out onto the road centreline
  // to overtake, which put it 2 units from same-direction and oncoming traffic alike — inside the
  // 2.31-unit collision envelope, so every car it passed was a crash (one every 9.7s of boosting,
  // against one every 25.1s now). Two failures to guard against, and this checks both: the weave
  // growing back out of the lane, and the weave quietly going flat.
  const wScene = new THREE.Scene();
  const wTraffic = createTraffic(makeRng(seed + 91), wScene, CARS_DEFAULT);
  const wTaxi = wTraffic.taxi;
  wTraffic.warmup(10);
  wTaxi.boost = true;
  let widest = 0;
  let straightFrames = 0;
  for (let f = 0; f < 60 * 20; f++) {
    wTraffic.update(1 / 60);
    if (wTaxi.state !== 'drive') continue;
    straightFrames += 1;
    // Distance from the lane centre, measured off the rendered position — the offset is applied
    // at render, so reading `car.x/car.z` is reading what the player sees. On the travel axis the
    // coordinate runs along the road and says nothing; only the cross-axis one is the lane.
    // Against the offset of the lane it is *on*, not the global LANE: on a divided arterial the
    // lane centre sits 3.33 out, and measuring against 2 would report the widening as a weave.
    const crossDist = isXAxis(wTaxi.d) ? distToLineZ(wTaxi.z) : distToLineX(wTaxi.x);
    widest = Math.max(widest,
      Math.abs(crossDist - laneOffsetFor(wTaxi.d, wTaxi.i, wTaxi.j)));
  }
  // 0.52 is the two waves' peak sum; the margin covers a frame landing mid-corner-exit. The frame
  // floor is the sample size: at boost speed a junction arrives about every 1.1s, so barely half
  // of these 20s are spent in the 'drive' state at all.
  check('the boosting taxi holds its lane', widest < 0.6 && straightFrames > 400,
    `widest ${widest.toFixed(2)} units off the lane centre over ${straightFrames} frames`);
  check('the boosting taxi actually weaves', widest > 0.25, `widest ${widest.toFixed(2)}`);
  setPriorityJunction(null);

  // --- Loco Mode is supposed to be go-go-go, and for a long time it wasn't.
  //
  // Attributing every frame the boosting taxi spent below full speed put signals at 0.0% — the
  // priority hold was already doing its job — and ordinary traffic at everything else: queued
  // behind a leader, or stopped dead at a green line because the exit lane was full. Hence
  // `scatter` in traffic.js. These two checks pin the parts of it that can go quietly wrong: the
  // flee not firing, and oncoming traffic re-acquiring its veto over a left turn.
  //
  // Both are two-car scenarios placed by hand, so nothing else can be the reason either car moves
  // or doesn't. The aggregate version — mean speed over a long routed drive through heavy traffic
  // — was written and then thrown away: changing the turn weights reroutes the whole city's rng
  // stream, so a before/after pair is two different worlds rather than a comparison, and the
  // seed-to-seed spread (73%-96% of the cap across eight cities) swamped a two-point effect.
  //
  // Not a fixed junction either: park districts close whole segments, so on some cities the left
  // out of the middle intersection doesn't exist and the taxi's route desyncs into a random turn.
  // Take the first signalised junction where both the left and the facing approach are legal.
  let jI = -1;
  let jJ = -1;
  let dIn = -1;
  outer: for (let i = 1; i < GRID_I && dIn < 0; i++) {
    for (let j = 1; j < GRID_J && dIn < 0; j++) {
      if (ringAxisAt(i, j)) continue;
      for (const d of [0, 1, 2, 3]) {
        if (!legalExits(d, i, j).includes(leftOf(d))) continue;
        if (!legalExits(opposite(d), i, j).length) continue;
        // The scatter scenario below stages a car 30 units back, so the approach has to be that
        // long. A junction one block in from the edge is not — and the old infinite lane hid it
        // by letting the car sit off the map and drive in.
        if (approachRoom(d, i, j) < 30) continue;
        jI = i; jJ = j; dIn = d;
        break;
      }
    }
  }
  // `back` is measured from the junction boundary, and may be more than one block — placeCar
  // walks back along the straight-through chain, which is what the old infinite lane allowed.
  const place = (car, d, back) => {
    placeCar(car, d, jI, jJ, back);
    car.route = []; car.parked = false;
  };

  // 1. A leader with the boosting taxi on its bumper gets going. The taxi starts 30 units out and
  // the leader 12, well inside SCATTER_RANGE, on an otherwise empty road.
  //
  // The leader used to be staged 18 units out. That is not a place a car can be: a lane is 12 long
  // and the junction beyond it 8, so 18 is inside the junction box. The old infinite `laneKey` row
  // had no such notion — it also, on this junction, placed the *taxi* 14 units off the western edge
  // of the map and let it drive in — so the distance went unquestioned. 12 is the near end of the
  // lane, which is as much clear road as a car on this city can actually have.
  const sScene = new THREE.Scene();
  const sTraffic = createTraffic(makeRng(seed + 103), sScene, 2);
  const [sTaxi, leader] = sTraffic.cars;
  place(sTaxi, dIn, 30);
  place(leader, dIn, 12);
  sTaxi.boost = true;
  let fleeSpeed = 0;
  let fleePeak = 0;      // peak of the scatter envelope, not its value at the end — the leader
                         // turns off the taxi's road partway through and it decays from there
  let taxiFloor = Infinity;
  for (let f = 0; f < 60 * 2; f++) {
    sTraffic.update(1 / 60);
    sTaxi.boost = true;
    fleePeak = Math.max(fleePeak, leader.scatter);
    if (leader.state === 'drive') fleeSpeed = Math.max(fleeSpeed, leader.speedFactor);
    // Skip the first few frames: the taxi is still spinning up from cruise.
    if (f > 20 && sTaxi.state === 'drive') taxiFloor = Math.min(taxiFloor, sTaxi.speedFactor);
  }
  // speedFactor is v/SPEED, so anything over 1 is a car exceeding the ambient cruise, and 2.2 is
  // full boost. Measured against its own control — the identical scenario with the taxi not
  // boosting — the leader peaks at exactly 1.00x cruise with a scatter envelope of 0.00, against
  // 1.43x and a full 1.00 envelope with the taxi on its bumper. So the discrimination is total,
  // even though the absolute figure is down from the 2.00x the 18-unit staging used to report:
  // that number needed 18 units of clear road ahead of the leader before it had to brake for its
  // junction, and no lane in this city is that long. The taxi's floor is where it eases up behind
  // the leader as the leader turns off.
  //
  // That floor was asserted at `> 1.25` while the taxi had no following term inside a junction: it
  // entered one tailgating and left it at the overdrive top, because nothing in that branch was
  // measuring the car in front (see the mid-turn block in traffic.js, and docs/lab.md for what that
  // cost). Now that it matches the leader instead of accelerating past it, the floor *is* the
  // leader's own speed while it crosses — and an ambient car's target in a junction is exactly
  // cruise. So 1.0 is the structural floor, and what this asserts is that the taxi never drops to
  // ambient speed behind a car it is chasing. Measured across five city seeds: 1.09, 1.65, 1.65,
  // 1.74, 1.89 — the tight one is the default seed, where the leader spends the sampled window
  // mid-junction at cruise.
  check('traffic gets out of the boosting taxi\'s way',
    dIn >= 0 && fleePeak > 0.9 && fleeSpeed > 1.35 && taxiFloor > 1.0,
    `leader peaked at ${fleeSpeed.toFixed(2)}x cruise, taxi never fell below ${taxiFloor.toFixed(2)}x`);

  // 1b. The same staging with a truck as the leader. Trucks never scatter — too big to skitter,
  // see the scatter block in traffic.js — and `car.scatter` only ever rises via the `mark` that
  // now skips them, so the envelope must hold at exactly 0 and the truck must never exceed its
  // own cruise (TRUCK_SPEED = 0.65 × SPEED; speedFactor is v/SPEED). Flipping isTruck after
  // createTraffic is safe here: the truck meshes are sized for every ambient slot, and this
  // scenario only ever reads the sim.
  const tScene = new THREE.Scene();
  const tTraffic = createTraffic(makeRng(seed + 103), tScene, 2);
  const [tTaxi, truck] = tTraffic.cars;
  truck.isTruck = true;
  place(tTaxi, dIn, 30);
  place(truck, dIn, 12);
  tTaxi.boost = true;
  let truckFlee = 0;
  let truckTop = 0;
  for (let f = 0; f < 60 * 2; f++) {
    tTraffic.update(1 / 60);
    tTaxi.boost = true;
    truckFlee = Math.max(truckFlee, truck.scatter);
    // Skip the first half second: every car spawns already rolling at SPEED (v = SPEED at spawn,
    // trucks included), so the staged truck opens above its own cruise and spends ~0.3s braking
    // down to it. That shed is staging, not scatter.
    if (f > 30 && truck.state === 'drive') truckTop = Math.max(truckTop, truck.speedFactor);
  }
  check('a truck ignores the boosting taxi behind it',
    truckFlee === 0 && truckTop > 0 && truckTop < 0.7,
    `scatter envelope peaked at ${truckFlee.toFixed(2)}, speed at ${truckTop.toFixed(2)}x cruise`);

  // 2. A boosting taxi turning left used to stop dead under a green: the oncoming lane shares its
  // axis, so it kept its green, and the left-turn yield then refused to let the taxi go — waiting
  // on a car that was itself waiting. The priority hold now denies that one direction (`block` in
  // traffic.js) and the taxi only looks for something already inside the junction.
  const dScene = new THREE.Scene();
  const dTraffic = createTraffic(makeRng(seed + 117), dScene, 2);
  const [dTaxi, oncoming] = dTraffic.cars;
  place(dTaxi, dIn, 24);
  place(oncoming, opposite(dIn), 18);
  dTaxi.route = [leftOf(dIn)];
  dTaxi.routeConsumed = false;
  dTaxi.boost = true;

  let turned = false;
  let oncomingEntered = false;
  for (let f = 0; f < 60 * 6 && !turned; f++) {
    dTraffic.update(1 / 60);
    dTaxi.boost = true;
    if (dTaxi.state === 'turn' && dTaxi.dOut === leftOf(dIn)) turned = true;
    if (oncoming.state === 'turn') oncomingEntered = true;
  }
  check('Loco Mode takes its left turn instead of yielding',
    dIn >= 0 && turned && !oncomingEntered,
    `turned=${turned}, oncoming entered the junction=${oncomingEntered}`);

  // 3. A junction the taxi genuinely cannot enter — the lane it would land in is full.
  //
  // Two cars and an immovable blocker parked on the landing point, so nothing else can be the
  // reason the taxi does or doesn't stop. The same scenario is run twice, because boosting and not
  // boosting are supposed to give opposite answers.
  //
  // **Boosting: it does not stop.** Loco Mode's premise is that nothing halts the taxi, and the
  // consequence is the wreck — collisions.js is armed for exactly as long as `taxi.boost` is true,
  // so a junction with something in it costs the run rather than costing a wait. The taxi used to
  // be held at the line by the ambient don't-block-the-box rule instead, which is a politeness a
  // car being driven like this has no business observing.
  //
  // **Not boosting: it brakes into the hold.** The exit-lane and left-yield tests used to be asked
  // only on arrival, and the only way to obey one there is to pin `s` to the hold line — which
  // stops the car without touching `car.v`. That left a car sat at the line with its wheels
  // turning, no nose dip, and the weave (paced off `v · dt`) still sliding it sideways.
  // A *left* rather than a straight-through, which the junction search above already guarantees is
  // legal here. It has to be a turn: on a straight-through the blocker sits in the approach lane's
  // own straight-on chain, so `ahead()` hands it over as an ordinary leader and the car brakes for
  // it whatever the entry tests do. Round a corner nothing sees it until the exit test, which is
  // exactly the case that used to freeze.
  const roads = cityNetwork();
  const exitDir = leftOf(dIn);
  const inLane = roads.laneByGrid(dIn, jI, jJ);
  const exitTurn = inLane.exits.map((id) => roads.turnById.get(id))
    .find((turn) => roads.dirOfLane(roads.laneById.get(turn.outLane)) === exitDir);
  const exitLane = exitTurn && roads.laneById.get(exitTurn.outLane);
  const exitNode = exitLane && roads.nodeById.get(exitLane.to);

  /**
   * Drive the staged approach into the full exit lane and report what the taxi did.
   * `frozenFast` is the fastest it ever claimed to be going on a frame it did not actually move.
   */
  const runBlockedJunction = (boosting) => {
    const scene = new THREE.Scene();
    const traffic = createTraffic(makeRng(seed + 131), scene, 2);
    const [car, blocker] = traffic.cars;
    // 30 units back is one junction further out than (jI, jJ) — `placeCar` walks back along the
    // straight-through chain — so the route has to carry straight on through that one first.
    place(car, dIn, 30);
    car.route = [dIn, exitDir];
    car.routeConsumed = false;
    car.boost = boosting;
    // `back` of the whole lane length puts the blocker at s = 0, which *is* the point the taxi
    // lands on. Parked with an empty route holds it there — `allowed = 0` in traffic.js.
    placeCar(blocker, exitDir, exitNode.gi, exitNode.gj, exitLane.length);
    blocker.route = [];
    blocker.parked = true;

    const collisions = createCollisions(traffic.cars, car);
    let wrecked = false;
    collisions.onImpact(() => { wrecked = true; });

    let frozenFast = 0;
    let slid = 0;
    let rest = Infinity;
    let entered = false;
    let prevS = car.s;
    let prevLateral = car.lateral;
    for (let f = 0; f < 60 * 5 && !wrecked; f++) {
      traffic.update(1 / 60);
      car.boost = boosting;
      collisions.update();
      if (car.state === 'turn' && car.i === jI && car.j === jJ) entered = true;
      if (car.state === 'drive') {
        if (Math.abs(car.s - prevS) < 1e-9) {
          frozenFast = Math.max(frozenFast, car.v);
          slid = Math.max(slid, Math.abs(car.lateral - prevLateral));
          rest = Math.min(rest, car.v);
        }
        prevS = car.s;
      }
      prevLateral = car.lateral;
    }
    return { frozenFast, slid, rest, entered, wrecked };
  };

  const loco = runBlockedJunction(true);
  check('Loco Mode drives into a junction it cannot enter and wrecks, rather than waiting',
    dIn >= 0 && Boolean(exitLane) && loco.entered && loco.wrecked && loco.rest === Infinity,
    `entered=${loco.entered} wrecked=${loco.wrecked}, `
    + `${loco.rest === Infinity ? 'never stopped' : 'held at the line'}`);

  // Ambient traffic still yields — and still has to *brake* for it rather than arrive and freeze.
  //
  // The car that shows this is one **fleeing the boosting taxi**. Scatter lifts a car's ceiling to
  // 2.0x cruise (17 u/s) and the taxi's priority hold hands it the green, so it reaches the line
  // fast and with nothing else slowing it — and a lane is 12 units with the hold line 3.4 back, so
  // it has 8.6 units of warning against the 13.1 it needs to stop from there. Before the exit-lane
  // test was asked on approach that was a car pinned to the line still reading 17 u/s.
  //
  // Routed rather than rolled, so the exit it takes is the blocked one every time.
  const fScene = new THREE.Scene();
  const fTraffic = createTraffic(makeRng(seed + 149), fScene, 3);
  const [fTaxi, flee, fBlocker] = fTraffic.cars;
  place(fTaxi, dIn, 30);
  fTaxi.boost = true;
  place(flee, dIn, 12);
  flee.route = [exitDir];
  flee.routeConsumed = false;
  placeCar(fBlocker, exitDir, exitNode.gi, exitNode.gj, exitLane.length);
  fBlocker.route = [];
  fBlocker.parked = true;

  let fleeFrozen = 0;
  let fleeSlid = 0;
  let fleeRest = Infinity;
  let fleeTop = 0;
  let fPrevS = flee.s;
  let fPrevLateral = flee.lateral;
  for (let f = 0; f < 60 * 4; f++) {
    fTraffic.update(1 / 60);
    fTaxi.boost = true;
    if (flee.state === 'drive') {
      fleeTop = Math.max(fleeTop, flee.v);
      if (Math.abs(flee.s - fPrevS) < 1e-9) {
        fleeFrozen = Math.max(fleeFrozen, flee.v);
        fleeSlid = Math.max(fleeSlid, Math.abs(flee.lateral - fPrevLateral));
        fleeRest = Math.min(fleeRest, flee.v);
      }
      fPrevS = flee.s;
    }
    fPrevLateral = flee.lateral;
  }
  // `fleeRest` reaching 0 is what proves the hold actually happened — without one there are no
  // stationary frames and the other two numbers keep their initial values. `fleeTop` proves the
  // car was genuinely travelling before it got there, so a pass can't come from a car that
  // crawled up to the line.
  check('a car held at the line brakes into it rather than freezing at speed',
    dIn >= 0 && Boolean(exitLane) && fleeTop > 10 && fleeRest < 0.01 && fleeFrozen < 0.5
      && fleeSlid < 0.002,
    `peaked at ${fleeTop.toFixed(1)} u/s, stationary at up to ${fleeFrozen.toFixed(2)} u/s, `
    + `weave slid ${fleeSlid.toFixed(4)}/frame`);

  // 4. Overtaking. A boosting taxi with a slower car in front, on a route that carries straight
  // on, pulls a full lane into the *oncoming* side, goes past, and comes back.
  //
  // The invariant that matters most is the one the abandoned version of this failed: the taxi must
  // never sit on the road centreline. At LANE (2) off its own lane it is 2 from the car it is
  // passing and 2 from anything coming the other way, both inside collisions.js's 2.31-unit
  // envelope — which is what made the old overtake "a lottery over which car you died on". The
  // whole lane is the safe place to be; the centreline is somewhere to pass *through*. Asserted
  // here as clearance from the car being overtaken, which is the direct form of it.
  let pI = -1; let pJ = -1; let pD = -1;
  outerPass: for (let i = 1; i < GRID_I; i++) {
    for (let j = 1; j < GRID_J; j++) {
      if (ringAxisAt(i, j)) continue;
      for (const d of [0, 1, 2, 3]) {
        // Straight on out of this junction, and straight on out of the next, so the pass has road.
        if (!legalExits(d, i, j).includes(d)) continue;
        if (approachRoom(d, i, j) < 30) continue;
        pI = i; pJ = j; pD = d;
        break outerPass;
      }
    }
  }

  /** Drive a two-car overtake and report what the taxi managed. `held` is the button. */
  const runOvertake = (held, route, opts = {}) => {
    const scene = new THREE.Scene();
    const traffic = createTraffic(makeRng(seed + 167), scene, opts.oncoming ? 3 : 2);
    const [car, lead, onc] = traffic.cars;
    placeCar(car, pD, pI, pJ, 26); car.parked = false;
    placeCar(lead, pD, pI, pJ, 14); lead.parked = false;
    car.route = route; car.routeConsumed = false;
    // Straight by default so it stays in front rather than rolling a random turn-off.
    lead.route = opts.leadRoute ?? [pD, pD, pD]; lead.routeConsumed = false;
    if (opts.oncoming) {
      // The other half of this road, coming the other way, and *far enough up it to still be
      // there*. The two close on each other at 18.7 + 8.5 = 27 u/s, so a car staged level with
      // the junction ahead has gone by before the taxi has even closed on its leader — the first
      // attempt at this staged one 5.7 units ahead, watched it pass, and then reported a clear
      // road, correctly.
      //
      // Which means this staging is calibrated to *when the decision is taken*, and has to move
      // whenever that moment does. It went from one lane back to **two blocks** back when a leader
      // crossing a junction in a straight line became passable (see `passable` in traffic.js): the
      // taxi now pulls out several tenths of a second earlier, and at the old staging the oncoming
      // car had already swept 0.7 units *past* it by then — so the gate correctly reported a clear
      // road and the check was passing on an empty scenario rather than on the rule. Measured at
      // the new staging, the oncoming car is 34 units out and closing as the taxi reaches
      // PASS_TRIGGER, which is inside PASS_SIGHT and is the trap this is meant to lay.
      const back = roads.nodeById.get(car.lane.from);
      const facing = roads.laneByGrid(opposite(pD), back.gi, back.gj);
      placeCar(onc, opposite(pD), back.gi, back.gj, facing.length + PITCH * 2);
      onc.route = []; onc.parked = false;
    }
    let peak = 0;
    let closest = Infinity;
    let got = false;
    let leadTurned = false;
    let outWhileLeadTurning = 0;   // how far out the taxi got while the lead was mid-junction
    for (let f = 0; f < 60 * 6; f++) {
      car.boost = held;
      car.boostEasing = false;
      traffic.update(1 / 60);
      peak = Math.max(peak, car.pass);
      if (lead.state === 'turn' && !lead.crashed) {
        leadTurned = true;
        outWhileLeadTurning = Math.max(outWhileLeadTurning, car.pass);
      }
      if (!lead.crashed) {
        closest = Math.min(closest, Math.hypot(car.x - lead.x, car.z - lead.z));
        const sgn = dirSign(car.d);
        const rel = isXAxis(car.d) ? (lead.x - car.x) * sgn : (lead.z - car.z) * sgn;
        if (rel < -CAR_LEN) got = true;
      }
    }
    return { peak, closest, got, leadTurned, outWhileLeadTurning };
  };

  const over = runOvertake(true, [pD, pD, pD]);
  check('Loco Mode overtakes a slower car by taking the oncoming lane',
    pD >= 0 && over.peak > 0.95 && over.got,
    `reached ${(over.peak * 2 * LANE).toFixed(2)} of ${2 * LANE} units across, got by=${over.got}`);

  // 2.31 is the collision envelope in sim/collisions.js — CAR_W * 0.68, doubled. Clearing it by a
  // margin is the difference between a manoeuvre and a coin flip.
  check('an overtaking taxi never comes within the collision envelope of the car it passes',
    pD >= 0 && over.closest > 2.31,
    `closest approach ${over.closest.toFixed(2)} units, envelope 2.31`);

  // The route gate. A pass always spans a junction — 30-odd units of manoeuvre against a 12-unit
  // lane — so one that starts before a turn strands the taxi on the wrong side of the road going
  // into a corner. Turning at the very next junction must not offer one at all.
  const turnOff = runOvertake(true, [leftOf(pD), pD, pD]);
  check('no overtake is offered when the route turns at the next junction',
    pD >= 0 && turnOff.peak < 0.02, `reached ${(turnOff.peak * 2 * LANE).toFixed(2)} units across`);

  // And the control: the pass is the button. Not holding it is not a pass.
  const coasting = runOvertake(false, [pD, pD, pD]);
  check('an overtake needs the button held',
    pD >= 0 && coasting.peak < 0.02, `reached ${(coasting.peak * 2 * LANE).toFixed(2)} units across`);

  // The two gates that decide *when* it is allowed, both added after watching it wreck rather
  // than pass. A pass wants ~27 units of road against a 12-unit lane, so the taxi is always still
  // alongside when the leader reaches its junction — which is exactly when the left-turn dice are
  // rolled. Passing a car that is already crossing one means driving into its arc.
  //
  // Asserted as "the taxi never got out of its lane while that car was in the junction" rather
  // than as an absence of contact: a no-contact check passes whether the rule works or the
  // scenario simply never set it up, and this one has to prove the trap was laid. `leadTurned` is
  // that proof.
  const turningLead = runOvertake(true, [pD, pD, pD], { leadRoute: [leftOf(pD), pD, pD] });
  check('no overtake of a car that is already turning across the lane being borrowed',
    pD >= 0 && turningLead.leadTurned && turningLead.outWhileLeadTurning < 0.02,
    `lead turned=${turningLead.leadTurned}, taxi got `
    + `${(turningLead.outWhileLeadTurning * 2 * LANE).toFixed(2)} units across while it did`);

  // And the borrowed lane has to be empty to start with. Without this the taxi pulled out with
  // oncoming traffic 3 units away — inside the envelope, and nothing the player could have read.
  // A car that arrives *during* the pass still costs the run; that one is visible and is the risk.
  const intoTraffic = runOvertake(true, [pD, pD, pD], { oncoming: true });
  check('no overtake into oncoming traffic that is already in sight',
    pD >= 0 && intoTraffic.peak < 0.02,
    `reached ${(intoTraffic.peak * 2 * LANE).toFixed(2)} units across`);

  setPriorityJunction(null);
}

// --- Loco Mode momentum cooldown --------------------------------------------
// Letting go used to drop every boost-only rule in the same frame — collision detection, the
// police bust range, running reds — so tapping off a beat before impact was a free escape. The
// cooldown keeps those rules live for BOOST_COOLDOWN seconds after release while the taxi's own
// speed cap drops immediately, so it's still committed to the risk while visibly coasting down.
{
  // Plain release: active -> cooldown (still engaged) -> ready, fuel untouched while it's frozen.
  // Opened full rather than at the run's starting third so half a second of holding is a rounding
  // error against the tank, and the cooldown is the only thing under test.
  const boost = createBoost(15, 1, BOOST_COOLDOWN);
  boost.press();
  for (let f = 0; f < 30; f++) boost.update(1 / 60); // hold for half a second
  boost.release();
  check('release enters cooldown rather than going straight to ready',
    boost.isCoolingDown() && !boost.isActive() && !boost.isReady(), `mode=${boost.state.mode}`);
  check('cooldown still reads as engaged, for the collision/bust/red-light gates',
    boost.isEngaged());

  const fuelAtRelease = boost.state.fuel;
  boost.update(BOOST_COOLDOWN * 0.5);
  check('fuel stays frozen mid-cooldown', boost.state.fuel === fuelAtRelease,
    `${boost.state.fuel.toFixed(3)} vs ${fuelAtRelease.toFixed(3)} at release`);

  boost.update(BOOST_COOLDOWN * 0.5 + 0.01);
  check('cooldown hands off to ready once the window closes',
    boost.isReady() && !boost.isEngaged(), `mode=${boost.state.mode}`);
}
{
  // Re-pressing mid-cooldown catches the car before the window closes: back to active outright,
  // same as the button reads a fresh Loco Mode press (wheelie/flame/kick in main.js key off this).
  const boost = createBoost(15, 1, BOOST_COOLDOWN);
  boost.press();
  boost.update(1 / 60);
  boost.release();
  boost.update(BOOST_COOLDOWN * 0.5);
  const resumed = boost.press();
  check('re-press mid-cooldown snaps straight back to active',
    resumed && boost.isActive(), `resumed=${resumed} mode=${boost.state.mode}`);
}
{
  // Draining the tank to empty while still held gets the same cooldown tail as an on-purpose
  // release — it doesn't skip straight to the dead-button state just because the player never
  // let go.
  const boost = createBoost(0.1, 1, BOOST_COOLDOWN);
  boost.press();
  boost.update(0.2); // more than the whole tank in one step
  check('running dry enters cooldown instead of going dead immediately',
    boost.isCoolingDown(), `mode=${boost.state.mode}`);
  boost.update(BOOST_COOLDOWN + 0.01);
  check('cooldown from a dry tank lands on empty', boost.isEmpty(), `mode=${boost.state.mode}`);
}
{
  // The taxi's own physics: `boost` (the hazard flag) stays true through the cooldown tail, but
  // `boostEasing` tells traffic.js the hold itself is over, so the speed cap drops at once and the
  // car coasts down under ordinary braking — same braking constant as any other stop, which is
  // also what drives the visible nose-dip (the pitch spring reads deceleration off car.v).
  const eScene = new THREE.Scene();
  const eTraffic = createTraffic(makeRng(seed + 129), eScene, 1);
  const eTaxi = eTraffic.taxi;
  eTaxi.boost = true;
  for (let f = 0; f < 60; f++) eTraffic.update(1 / 60); // spin up to full boost speed
  const peakFactor = eTaxi.speedFactor; // v/SPEED — 2.2 is full boost, 1.0 is cruise
  eTaxi.boostEasing = true; // the button just came up — cooldown starts, hold ends
  for (let f = 0; f < Math.round(BOOST_COOLDOWN * 60); f++) eTraffic.update(1 / 60);
  check('boost speed peaks well above cruise before release', peakFactor > 1.8,
    `peak ${peakFactor.toFixed(2)}x cruise`);
  check('easing off drops the speed cap and the car actually coasts back toward cruise',
    eTaxi.speedFactor < peakFactor * 0.7 && eTaxi.speedFactor < 1.3,
    `${peakFactor.toFixed(2)}x -> ${eTaxi.speedFactor.toFixed(2)}x cruise over ${BOOST_COOLDOWN}s`);
  setPriorityJunction(null);
}

// --- The brake pedal --------------------------------------------------------
// `taxi.braking`, held from the HUD's brake button. It outranks every other speed rule the taxi
// has — the boost ceiling included — for exactly as long as it is held, and gives the car straight
// back to the auto gas the moment it is let go. There is nothing to earn and nothing to spend, so
// what is worth asserting is all here: that it stops the car, that it stops it *hard*, that it
// beats the button next to it, and that letting go is a clean hand-back.
{
  // A junction with a straight exit and a long approach, so the staged taxi has road in front of
  // it: the stop itself is about a unit from cruise, and the pull-away needs ~5 more to be back at
  // cruise, against the ~16 units of clear lane this staging leaves before the signal bites.
  let bI = -1; let bJ = -1; let bD = -1;
  outerBrake: for (let i = 1; i < GRID_I; i++) {
    for (let j = 1; j < GRID_J; j++) {
      if (ringAxisAt(i, j)) continue;
      for (const d of [0, 1, 2, 3]) {
        if (!legalExits(d, i, j).includes(d)) continue;
        if (approachRoom(d, i, j) < 30) continue;
        // ...and a crossing road to be held back, since half of what is staged here is that cross
        // traffic never gets released through a taxi standing in the box. A junction with the
        // crossing arm missing staged the first half fine and quietly skipped the second: the
        // check answered `crossLane` null with `closest = Infinity` and failed on nothing. Rare
        // with only park closures able to remove an arm, routine once the river could.
        if (!cityNetwork().laneByGrid(leftOf(d), i, j)) continue;
        bI = i; bJ = j; bD = d;
        break outerBrake;
      }
    }
  }

  /** One taxi, alone on the road, 18 units back from the junction and already at cruise. */
  const stage = () => {
    const bScene = new THREE.Scene();
    const bTraffic = createTraffic(makeRng(seed + 173), bScene, 1);
    const car = bTraffic.taxi;
    placeCar(car, bD, bI, bJ, 18);
    car.parked = false;
    car.route = [bD, bD, bD];
    car.routeConsumed = false;
    car.v = SPEED;
    return { bTraffic, car };
  };

  {
    const { bTraffic, car } = stage();
    for (let f = 0; f < 30; f++) bTraffic.update(1 / 60);
    const cruising = car.v;

    car.braking = true;
    // The rate, measured over the first frame of the hold rather than inferred from the stopping
    // distance — a signal or a leader can lower the *target* the car is chasing, but nothing else
    // in the sim sheds speed faster than `brake()`, so the rate is the part that can only come
    // from the pedal.
    const before = car.v;
    bTraffic.update(1 / 60);
    const rate = (before - car.v) * 60;
    check('the brake sheds speed at twice the rate lifting off does',
      Math.abs(rate - 2 * LOCO_DEFAULTS.brake) < 0.5,
      `${rate.toFixed(1)} u/s^2 vs brake ${LOCO_DEFAULTS.brake}`);

    const from = car.travelled;
    let frames = 1;
    while (car.v > 0 && frames < 600) { bTraffic.update(1 / 60); frames += 1; }
    const stopped = car.travelled - from;
    check('and hauls the taxi to a dead stop from cruise inside a car length',
      car.v === 0 && stopped < CAR_LEN && stopped > 0.2,
      `${stopped.toFixed(2)} units in ${(frames / 60).toFixed(2)}s from ${cruising.toFixed(1)} u/s`);

    // Held. The auto gas is the game's resting state, so "stopped" has to survive it.
    const held = car.travelled;
    for (let f = 0; f < 120; f++) bTraffic.update(1 / 60);
    check('and holds it there for as long as the pedal is down',
      car.v === 0 && car.travelled - held < 1e-9,
      `moved ${(car.travelled - held).toFixed(4)} units over 2s`);

    // Let go: back to driving itself, with nothing to re-arm and nobody to tell. Measured over
    // half a second of pull-away rather than by waiting for cruise — a staged lane is 12 units
    // long and the taxi is braking for the next signal well before it gets there, so "did it reach
    // cruise" is a question about that junction's light and not about the pedal. What the release
    // owes is that the ordinary throttle takes over at the ordinary ACCEL (6 u/s^2), which is
    // exactly what this measures.
    car.braking = false;
    const away = car.travelled;
    for (let f = 0; f < 30; f++) bTraffic.update(1 / 60);
    check('and letting go hands the taxi straight back to the auto gas',
      car.v > 2.5 && car.travelled > away,
      `${car.v.toFixed(1)} u/s and ${(car.travelled - away).toFixed(2)} units half a second after the release`);
  }

  {
    // The pedal beats the button. Both held at once is a real gesture — two thumbs, or a keyboard
    // — and main.js drops the boost on a brake press rather than leaving them to fight, but the
    // sim must not depend on that: whoever ends up holding both gets a stopped car.
    const { bTraffic, car } = stage();
    for (let f = 0; f < 60; f++) { car.boost = true; bTraffic.update(1 / 60); }
    const boosting = car.v;
    car.braking = true;
    for (let f = 0; f < 120; f++) { car.boost = true; bTraffic.update(1 / 60); }
    check('the brake outranks Loco Mode rather than fighting it for the throttle',
      car.v === 0, `${boosting.toFixed(1)} u/s at full boost -> ${car.v.toFixed(2)} u/s`);
    setPriorityJunction(null);
  }

  {
    // Mid-junction. A pedal that only worked on a lane would ignore the player for the ~0.9s a
    // crossing takes, which is the moment the brake is most likely to be wanted. Stopping in the
    // box is a hazard rather than a hold — see the `heldAt` set in traffic.js, which is what keeps
    // cross traffic from being released through a taxi standing in the middle of it.
    const bScene = new THREE.Scene();
    const bTraffic = createTraffic(makeRng(seed + 173), bScene, 2);
    const [car, cross] = bTraffic.cars;
    placeCar(car, bD, bI, bJ, 18);
    car.parked = false;
    car.route = [bD, bD, bD];
    car.routeConsumed = false;
    car.v = SPEED;

    let entered = 0;
    for (let f = 0; f < 60 * 12 && car.state !== 'turn'; f++) { bTraffic.update(1 / 60); entered = f; }
    const inTheBox = car.state === 'turn';
    // Part way across, not on the lip of the exit lane.
    for (let f = 0; f < 60 && car.turnT < 0.35; f++) bTraffic.update(1 / 60);
    car.braking = true;
    const turnAt = car.turnT;
    for (let f = 0; f < 180; f++) bTraffic.update(1 / 60);
    check('the brake works inside a junction, not just on a lane',
      inTheBox && car.v === 0 && car.state === 'turn' && car.turnT < 1,
      `entered after ${entered} frames, stopped at turnT ${car.turnT.toFixed(2)} (braked at ${turnAt.toFixed(2)})`);

    // And now the reason that is allowed to be a hazard rather than a crash: cross traffic must be
    // held out of a junction with a car standing in it, exactly as it is for an ambient car
    // stranded mid-turn. Run long enough to cover a whole signal cycle, so the crossing car gets a
    // real green to drive through the taxi on if the `heldAt` entry is missing — without it this
    // check would pass on a red.
    const roads = cityNetwork();
    const crossD = leftOf(car.d);
    const crossLane = roads.laneByGrid(crossD, bI, bJ);
    let closest = Infinity;
    let released = 0;      // frames the crossing car spent inside the box the taxi is stopped in
    if (crossLane) {
      placeCar(cross, crossD, bI, bJ, Math.min(10, crossLane.length));
      cross.parked = false;
      cross.route = [crossD, crossD];
      cross.routeConsumed = false;
      for (let f = 0; f < 60 * 30; f++) {
        bTraffic.update(1 / 60);
        if (cross.crashed || car.crashed) continue;
        closest = Math.min(closest, Math.hypot(cross.x - car.x, cross.z - car.z));
        if (cross.state === 'turn' && cross.i === bI && cross.j === bJ) released += 1;
      }
    }
    check('and cross traffic is held out of a junction the taxi is standing in',
      !!crossLane && released === 0 && closest > CAR_LEN,
      `${released} frames in the box, closest approach ${closest.toFixed(2)} units over 30s of cycles`);
  }
}

// --- Routing ---------------------------------------------------------------
// Every (approach state, destination) pair must be solvable. A single unreachable pair would
// strand the taxi with no way for the player to recover.
const ints = allIntersections();
let unroutable = 0;
let longest = 0;
for (const from of ints) {
  for (const to of ints) {
    for (let d = 0; d < 4; d++) {
      const route = findRoute({ i: from.i, j: from.j, d }, to);
      if (route === null) unroutable += 1;
      else longest = Math.max(longest, route.length);
    }
  }
}
check('every intersection is routable from every approach', unroutable === 0,
  `${ints.length * ints.length * 4} pairs, longest ${longest} turns`);

// --- The drawn route band --------------------------------------------------
// The band is paint on the lane the taxi will drive, so it has to (a) stay on the tarmac,
// (b) sit in the *right-hand* lane on every straight, and (c) never re-shape ahead of the car.
// (c) is the one that matters and the one the centreline version failed: its corner fillet was
// clamped against the distance to the car, so the drawn corner visibly moved as the taxi closed
// on it. Nothing in the path may depend on where the car is except where the band starts.
{
  const rScene = new THREE.Scene();
  const rTraffic2 = createTraffic(makeRng(seed + 91), rScene, 1);   // taxi alone: nothing to block it
  const rTaxi = rTraffic2.taxi;

  // Somewhere far enough away to cross the map and take several turns.
  const dest = { i: rTaxi.i > GRID_I / 2 ? 0 : GRID_I, j: rTaxi.j > GRID_J / 2 ? 0 : GRID_J };
  rTaxi.route = findRoute(planOrigin(rTaxi), dest);
  rTaxi.routeConsumed = false;

  const HALF_ROAD = ROAD_W / 2;
  const BAND_HALF = ((ROAD_W / 2) * 0.85) / 2;
  /** Coordinate of the road centreline nearest a point, one function per axis. */
  const lineNearX = (x) => lineX(Math.round((x + HALF_SPAN_X) / PITCH));
  const lineNearZ = (z) => lineZ(Math.round((z + HALF_SPAN_Z) / PITCH));

  // Distance from a point to a polyline, so "the new path lies on the old one" is one number.
  const distToPath = (p, path) => {
    let best = Infinity;
    for (let k = 0; k < path.length - 1; k++) {
      const a = path[k];
      const b = path[k + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len2 = dx * dx + dz * dz;
      const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
      best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz)));
    }
    return best;
  };

  const planned = routePath(rTaxi, rTaxi.route);
  let offRoad = 0;
  let wrongLane = 0;
  let straights = 0;
  let drift = 0;
  let frames = 0;

  for (let step = 0; step < 120 * 60; step++) {
    rTraffic2.update(1 / 60);
    const path = routePath(rTaxi, rTaxi.route);
    if (path.length < 2) break;
    frames += 1;

    for (const p of path) {
      const dx = Math.abs(p.x - lineNearX(p.x));
      const dz = Math.abs(p.z - lineNearZ(p.z));
      // Inside a junction box the tarmac runs both ways, so being near a centreline on either
      // axis is enough. Out on a straight the band's own half-width has to fit as well: a lane
      // centre is 2 units off its own kerb whatever the road's width, and the band is 1.7 wide,
      // which leaves 0.3 of asphalt showing at the kerb on a side street and on an arterial alike.
      const hz = halfRoadZ(lineIndexX(p.x));   // the road running along Z, nearest in x
      const hx = halfRoadX(lineIndexZ(p.z));   // the road running along X, nearest in z
      const inJunction = dx <= hz && dz <= hx;
      // Whichever centreline is nearer is the road the point is on, and it is that road's width
      // the band has to fit inside.
      const half = dx <= dz ? hz : hx;
      if (!inJunction && Math.min(dx, dz) + BAND_HALF > half) offRoad += 1;
      drift = Math.max(drift, distToPath(p, planned));
    }

    // Right-hand lane on the straights: take mid-block segments (both ends clear of a junction
    // box) and check the cross-axis offset is exactly one LANE, on the side travel dictates.
    for (let k = 0; k < path.length - 1; k++) {
      const a = path[k];
      const b = path[k + 1];
      const dirX = Math.abs(b.x - a.x) > Math.abs(b.z - a.z);
      const cross = dirX ? a.z : a.x;
      const alongMid = dirX ? (a.x + b.x) / 2 : (a.z + b.z) / 2;
      // The junction box along the travel axis is the *crossing* road's half-width, and the lane
      // offset across it is this road's — two different numbers now that a main street is wider.
      // `alongMid` runs along the segment and `cross` across it, so a segment running along X has
      // an x for the first and a z for the second — and the two want opposite axis helpers.
      const box = dirX ? halfRoadZ(lineIndexX(alongMid)) : halfRoadX(lineIndexZ(alongMid));
      const alongLine = dirX ? lineNearX(alongMid) : lineNearZ(alongMid);
      if (Math.abs(alongMid - alongLine) < box) continue;                  // inside a junction box
      if (Math.hypot(b.x - a.x, b.z - a.z) < 1) continue;
      const crossLine = dirX ? lineNearZ(cross) : lineNearX(cross);
      const sign = dirX ? Math.sign(b.x - a.x) : Math.sign(b.z - a.z);
      const off = dirX ? laneOffX(lineIndexZ(cross)) : laneOffZ(lineIndexX(cross));
      const want = dirX ? sign * off : -sign * off;
      straights += 1;
      if (Math.abs((cross - crossLine) - want) > 1e-6) wrongLane += 1;
    }

    if (!rTaxi.route.length && Math.hypot(rTaxi.x - lineX(dest.i), rTaxi.z - lineZ(dest.j)) < 8) break;
  }

  check('the route band stays on the road', offRoad === 0, `${offRoad} points off tarmac`);
  check('the route band sits in the right-hand lane', wrongLane === 0 && straights > 20,
    `${straights - wrongLane}/${straights} straight segments in lane`);
  // The band may only get shorter from behind: every point of every later path must still lie on
  // the path drawn when the route was planned.
  check('the route band never re-shapes ahead of the taxi', drift < 0.05 && frames > 300,
    `max drift ${drift.toFixed(4)} units over ${frames} frames`);
}

// --- Dragging the band to re-route -----------------------------------------
// The player takes hold of the route band and pulls it sideways; the junction under their finger
// becomes a waypoint and the route is re-planned through it, live, while the taxi keeps driving.
// Four things have to hold, and none of them is visible in a screenshot: the finger has to land on
// the band and nowhere else, the re-plan has to actually go through the waypoint, a silly drag has
// to be refused rather than answered with a lap of the city, and — the one that matters — the taxi
// has to still *arrive*.
{
  const dScene = new THREE.Scene();
  const dTraffic = createTraffic(makeRng(seed + 131), dScene, 1);   // taxi alone: nothing to block it
  const dTaxi = dTraffic.taxi;
  dTraffic.warmup(4);

  const dest = { i: dTaxi.i > GRID_I / 2 ? 0 : GRID_I, j: dTaxi.j > GRID_J / 2 ? 0 : GRID_J };
  const origin = planOrigin(dTaxi);
  const direct = findRoute(origin, dest);
  dTaxi.route = [...direct];
  dTaxi.routeConsumed = false;

  /** Junctions a route visits, in order, starting with the one the car is heading at. */
  const junctionsAlong = (from, route) => {
    const out = [{ i: from.i, j: from.j }];
    let at = { i: from.i, j: from.j };
    for (const d of route) {
      at = nextIntersection(d, at.i, at.j);
      if (!at) break;
      out.push({ i: at.i, j: at.j });
    }
    return out;
  };
  const passesThrough = (route, via) =>
    junctionsAlong(origin, route).some((p) => p.i === via.i && p.j === via.j);

  // --- The hit test.
  // Points sampled *on* the drawn band must read as on it, and the arc length must agree with the
  // one the shader fades against — the grab bloom is centred on this number, so a hit test that
  // located the finger correctly and mismeasured `along` would light up the wrong stretch of road.
  const band = routePath(dTaxi, dTaxi.route);
  let offBand = 0;
  let alongWrong = 0;
  let walked = 0;
  for (let k = 1; k < band.length; k++) {
    walked += Math.hypot(band[k].x - band[k - 1].x, band[k].z - band[k - 1].z);
    const near = nearestOnPath(band, band[k].x, band[k].z);
    if (!near || near.dist > 1e-6) offBand += 1;
    if (!near || Math.abs(near.along - walked) > 1e-6) alongWrong += 1;
  }
  check('a finger on the band reads as on the band', offBand === 0 && band.length > 20,
    `${band.length} points, ${offBand} missed`);
  check('and the band says how far along it was touched', alongWrong === 0,
    `${alongWrong} arc lengths disagreed with the walk`);

  // What separates a grab from a pan is one number, so that number is checked against an
  // independent one: the path densely resampled and brute-forced. A hit test that measured to the
  // nearest *vertex* instead of to the nearest point of a segment would pass every check above and
  // still refuse the middle of a 20-unit straight, which is most of the band.
  //
  // Both directions matter. Reading long turns a pan into a re-route; reading short leaves the one
  // gesture the feature is made of not firing where the paint plainly is.
  const dense = [];
  for (let k = 0; k < band.length - 1; k++) {
    const a = band[k];
    const b = band[k + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.1));
    for (let s = 0; s < steps; s++) {
      dense.push({ x: a.x + (b.x - a.x) * (s / steps), z: a.z + (b.z - a.z) * (s / steps) });
    }
  }
  const bruteForce = (x, z) => {
    let best = Infinity;
    for (const q of dense) best = Math.min(best, Math.hypot(q.x - x, q.z - z));
    return best;
  };

  let mismeasured = 0;
  let disagreed = 0;
  let probed = 0;
  let rejected = 0;
  for (let x = -HALF_SPAN_X; x <= HALF_SPAN_X; x += PITCH / 4) {
    for (let z = -HALF_SPAN_Z; z <= HALF_SPAN_Z; z += PITCH / 4) {
      const near = nearestOnPath(band, x, z);
      const ref = bruteForce(x, z);
      probed += 1;
      // 0.05 of tolerance covers the resampling step, not the measurement.
      if (Math.abs(near.dist - ref) > 0.05) mismeasured += 1;
      if ((near.dist <= GRAB_RADIUS) !== (ref <= GRAB_RADIUS - 0.05)
        && Math.abs(ref - GRAB_RADIUS) > 0.05) disagreed += 1;
      if (near.dist > GRAB_RADIUS) rejected += 1;
    }
  }
  check('the hit test measures distance to the paint, not to its corners',
    mismeasured === 0 && disagreed === 0 && probed > 400,
    `${probed} points, ${mismeasured} mismeasured`);
  // And it stays a target rather than becoming the map: most of the city is not the band.
  check('most of the city is not a grab', rejected > probed * 0.6,
    `${rejected}/${probed} points rejected at ${GRAB_RADIUS} units`);

  // --- The re-plan.
  // Every junction on the map, tried as a waypoint. Whatever comes back must go through it and
  // must still end at the destination; whatever is refused must be refused for a reason.
  let missedVia = 0;
  let wrongEnd = 0;
  let overCap = 0;
  let taken = 0;
  let refused = 0;
  for (const via of allIntersections()) {
    const route = findRouteVia(origin, via, dest);
    if (route === null) { refused += 1; continue; }
    taken += 1;
    if (!passesThrough(route, via)) missedVia += 1;
    const ends = junctionsAlong(origin, route).at(-1);
    if (ends.i !== dest.i || ends.j !== dest.j) wrongEnd += 1;
    if (route.length > direct.length + MAX_VIA_DETOUR) overCap += 1;
  }
  check('a dragged waypoint is actually driven through', missedVia === 0 && taken > 10,
    `${taken} of ${allIntersections().length} waypoints accepted, ${refused} refused`);
  check('and the destination is not moved by dragging', wrongEnd === 0);
  check('no accepted detour exceeds the cap', overCap === 0,
    `cap ${MAX_VIA_DETOUR} legs over the direct ${direct.length}`);
  // The cap has to refuse exactly what it claims to, which is not the same as "refuses waypoints
  // that aren't on the drawn route". A Manhattan grid is full of equal-length alternatives: on
  // this seed 16 of the 26 junctions the band does *not* pass through cost zero extra legs to go
  // via, because they sit on a route the same length that the router's straight-then-right-then-
  // left tie-break simply didn't pick. So the cap is checked against real detour cost.
  const NO_CAP = 999;
  let capWrong = 0;
  let genuineDetours = 0;
  let worstExtra = 0;
  for (const p of allIntersections()) {
    const full = findRouteVia(origin, p, dest, { maxDetour: NO_CAP });
    if (full === null) continue;
    const extra = full.length - direct.length;
    if (extra > 0) genuineDetours += 1;
    worstExtra = Math.max(worstExtra, extra);
    for (const cap of [0, 2, MAX_VIA_DETOUR]) {
      if ((findRouteVia(origin, p, dest, { maxDetour: cap }) !== null) !== (extra <= cap)) {
        capWrong += 1;
      }
    }
  }
  check('the detour cap refuses exactly what it says it does',
    capWrong === 0 && genuineDetours > 3,
    `${genuineDetours} waypoints cost extra, worst ${worstExtra} legs over a direct ${direct.length}`);

  // And it bites where it is meant to. On a long trip nothing on a 5×5 map can reach the cap; the
  // case it exists for is the *short* one, where a finger that lands behind the taxi asks for a
  // lap of the city to reach a destination two blocks away.
  const near2 = allIntersections()
    .map((p) => ({ p, route: findRoute(origin, p) }))
    .find((c) => c.route && c.route.length === 2);
  const bitten = near2
    ? allIntersections().filter((p) => findRouteVia(origin, p, near2.p) === null)
    : [];
  check('a detour past the cap is refused rather than driven',
    near2 !== undefined && bitten.length > 0,
    near2 ? `${bitten.length} waypoints refused for a 2-leg trip` : 'no short trip on this seed');

  // Dragging back onto the route the taxi was already taking gives that route back — this is what
  // makes the gesture undoable with the same finger that made it, with no revert to implement.
  const onPath = junctionsAlong(origin, direct)[Math.floor(direct.length / 2)];
  const rejoined = findRouteVia(origin, onPath, dest);
  check('dragging back onto the plan restores the plan',
    rejoined !== null && rejoined.join() === direct.join(),
    `${rejoined?.length} legs against ${direct.length}`);

  // The waypoint the finger names is the junction nearest it, so a finger anywhere inside a
  // junction's cell has to name that junction and no other.
  let snapWrong = 0;
  for (const p of allIntersections()) {
    for (const [dx, dz] of [[0, 0], [9, 0], [-9, 0], [0, 9], [0, -9], [6, 6]]) {
      const snapped = nearestJunction(lineX(p.i) + dx, lineZ(p.j) + dz);
      const want = { i: Math.min(GRID_I, Math.max(0, p.i)), j: Math.min(GRID_J, Math.max(0, p.j)) };
      // Off the edge of the map the snap clamps, which is the point: a drag past the ring road
      // pins to the ring rather than stopping answering.
      const clamped = lineX(p.i) + dx < -HALF_SPAN_X || lineX(p.i) + dx > HALF_SPAN_X
        || lineZ(p.j) + dz < -HALF_SPAN_Z || lineZ(p.j) + dz > HALF_SPAN_Z;
      if (!clamped && (snapped.i !== want.i || snapped.j !== want.j)) snapWrong += 1;
    }
  }
  check('a finger names the junction it is standing in', snapWrong === 0,
    `${snapWrong} mis-snapped`);

  // --- And it still arrives.
  // The assertion no screenshot can make, and the one the whole feature lives or dies on. This is
  // a *held* drag rather than a single re-plan: `pathdrag.js` re-stitches the waypoint onto a
  // fresh `planOrigin` every frame, because the taxi keeps driving while the finger is down, and
  // that is the part with teeth. Planning from the intersection a car mid-turn has already
  // committed to silently drops the first step; forgetting to clear `routeConsumed` makes the
  // commit eat the first step of the *new* plan. Either one is a route desync, not a crash, so the
  // only symptom would be a fare quietly timing out.
  //
  // Prefer a waypoint that genuinely lengthens the trip — a Manhattan grid has plenty that cost
  // nothing, and one of those would drive an identical route and assert nothing.
  const mid = junctionsAlong(origin, direct)[Math.max(1, Math.floor(direct.length / 2))];
  const candidates = [];
  for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const cand = { i: mid.i + di, j: mid.j + dj };
    if (cand.i < 0 || cand.i > GRID_I || cand.j < 0 || cand.j > GRID_J) continue;
    if (passesThrough(direct, cand)) continue;          // already on the plan; not a detour
    const route = findRouteVia(planOrigin(dTaxi), cand, dest);
    if (route) candidates.push({ via: cand, extra: route.length - direct.length });
  }
  candidates.sort((a, b) => b.extra - a.extra);
  const via = candidates[0]?.via ?? null;

  if (!via) {
    check('a dragged route still arrives', false, 'no sideways waypoint available on this seed');
  } else {
    // Mirrors main.js's `routeTo({ via })`, `routeConsumed` reset included.
    const dragTo = (waypoint) => {
      const route = findRouteVia(planOrigin(dTaxi), waypoint, dest);
      if (!route) return false;
      dTaxi.route = route;
      dTaxi.routeConsumed = false;
      dTaxi.parked = false;
      return true;
    };

    const plannedLegs = findRouteVia(planOrigin(dTaxi), via, dest).length;
    const viaCentre = { x: lineX(via.i), z: lineZ(via.j) };
    const destCentre = { x: lineX(dest.i), z: lineZ(dest.j) };

    // Three seconds of finger down, re-planning on every one of the 180 frames.
    let held = via;
    let replans = 0;
    let refusals = 0;
    let midTurnReplans = 0;
    for (let step = 0; step < 180 && held; step++) {
      if (dTaxi.state === 'turn') midTurnReplans += 1;
      if (dragTo(held)) replans += 1; else refusals += 1;
      dTraffic.update(1 / 60);
      // Retired the moment the taxi is heading at it, exactly as pathdrag.js does — otherwise the
      // next re-plan asks for a lap back to a junction already behind the car.
      const from = planOrigin(dTaxi);
      if (from.i === held.i && from.j === held.j) held = null;
    }

    let elapsed = 3;
    let nearestVia = Infinity;
    let arrived = false;
    while (elapsed < 180) {
      dTraffic.update(1 / 60);
      elapsed += 1 / 60;
      nearestVia = Math.min(nearestVia,
        Math.hypot(dTaxi.x - viaCentre.x, dTaxi.z - viaCentre.z));
      if (Math.hypot(dTaxi.x - destCentre.x, dTaxi.z - destCentre.z) < ARRIVE_RADIUS) {
        arrived = true;
        break;
      }
    }
    check('a route re-planned on every frame of a drag still arrives', arrived,
      `waypoint (${via.i},${via.j}), ${plannedLegs} legs against a direct ${direct.length}, ${elapsed.toFixed(1)}s`);
    check('and the taxi really drove the detour', nearestVia < ARRIVE_RADIUS,
      `${replans} re-plans (${midTurnReplans} mid-turn, ${refusals} refused), closest approach ${nearestVia.toFixed(1)}`);
    check('dragging desyncs nothing and runs no reds',
      dTraffic.stats.routeDesync === 0 && dTraffic.stats.violations === 0,
      `${dTraffic.stats.routeDesync} desyncs, ${dTraffic.stats.violations} violations`);
  }
}

// Park districts build over a road. The closure has to be real in the traffic model, not just
// hidden in the ground mesh, and it must not strand any part of the city.
check('park districts closed a road each', (layout.districts ?? []).length > 0,
  `${(layout.districts ?? []).length} districts`);

const drivingThroughPark = traffic.cars.filter((car) => (layout.districts ?? []).some((d) =>
  car.x > d.bounds.x0 && car.x < d.bounds.x1 && car.z > d.bounds.z0 && car.z < d.bounds.z1));
check('no vehicle is driving through a park district', drivingThroughPark.length === 0,
  `${drivingThroughPark.length} inside park bounds`);

check('the taxi is an ordinary car in the traffic array',
  traffic.cars.includes(traffic.taxi) && traffic.taxi.isTaxi,
  'so signals and following distance apply to it');

// --- Parked taxi with a same-intersection destination ---------------------
// The taxi picks up a rider, then the player taps a destination that happens to be the
// intersection the taxi is already heading toward. findRoute returns [] ("already at target"),
// which used to leave the parked check with an empty route — allowed = 0 forever, no arrival,
// no way out even with Loco Mode. Mirrors main.js:routeTo, which now clears `parked` too.
{
  const sScene = new THREE.Scene();
  const sTraffic = createTraffic(makeRng(seed + 44), sScene, CARS_DEFAULT);
  const sFares = createFareSystem(makeRng(seed + 55), sScene);
  const sTaxi = sTraffic.taxi;
  sTraffic.warmup(5);

  const routeTo = (target) => {
    const r = findRoute(planOrigin(sTaxi), target);
    if (!r) return false;
    sTaxi.route = r; sTaxi.routeConsumed = false; sTaxi.parked = false;
    return true;
  };

  let pickedUp = false;
  let tapped = false;
  let elapsed = 0;
  while (elapsed < 120 && !sFares.state.gameOver && sFares.state.delivered === 0) {
    sTraffic.update(1 / 60);
    for (const { type } of sFares.update(1 / 60, sTaxi)) {
      if (type === 'pickup') { sTaxi.route = []; sTaxi.parked = true; pickedUp = true; }
    }
    elapsed += 1 / 60;

    const waiting = sFares.waiting();
    if (waiting && !waiting.directed && !pickedUp) {
      if (routeTo(waiting.target)) sFares.markDirected(waiting);
    }
    if (pickedUp && !tapped) {
      const c = sFares.carrying();
      if (c) {
        c.target = { i: sTaxi.i, j: sTaxi.j };   // destination = taxi's current target junction
        if (routeTo(c.target)) sFares.markDirected(c);
        tapped = true;
      }
    }
  }

  check('a parked taxi still delivers when the destination is its own next junction',
    sFares.state.delivered === 1,
    `${sFares.state.delivered} delivered after ${elapsed.toFixed(1)}s`);
}

// --- The drop-off dispatches itself ----------------------------------------
// The player taps riders on the kerb and nothing else — no drop-off is ever tapped in this
// run — and a delivery still has to land. Mirrors main.js:dispatchToDropoff, which routes at the
// drop-off on the pickup frame instead of parking the taxi for a confirming tap.
//
// The pickup frame is the awkward one and the reason this is asserted rather than assumed: the
// taxi is *inside* the junction when the rider boards (measured: `state === 'turn'` at every
// pickup across four run seeds, still doing the full 8.5 u/s), so the route has to be planned from
// a turn the car has already committed to. planOrigin handles that, and a route planned from the
// wrong origin drops its first turn silently — the taxi would wander off and the fare would time
// out with nothing in the log to say why.
{
  const aScene = new THREE.Scene();
  const aTraffic = createTraffic(makeRng(seed + 44), aScene, CARS_DEFAULT);
  const aFares = createFareSystem(makeRng(seed + 55), aScene);
  const aTaxi = aTraffic.taxi;
  aTraffic.warmup(5);

  // Mirrors main.js:routeTo.
  const routeTo = (target) => {
    const r = findRoute(planOrigin(aTaxi), target);
    if (!r) return false;
    aTaxi.route = r; aTaxi.routeConsumed = false; aTaxi.parked = false;
    return true;
  };

  let pickups = 0;
  let dispatched = 0;
  let parkedWhileCarrying = 0;
  let elapsed = 0;

  while (elapsed < 200 && !aFares.state.gameOver && aFares.state.delivered === 0) {
    aTraffic.update(1 / 60);
    for (const { type, fare } of aFares.update(1 / 60, aTaxi)) {
      if (type !== 'pickup') continue;
      pickups += 1;
      aTaxi.route = [];
      if (routeTo(fare.target)) { aFares.markDirected(fare); dispatched += 1; }
      else aTaxi.parked = true;
    }

    // A pickup is a pause in a drive now, not a full stop: with a rider aboard the taxi is never
    // held at the kerb waiting to be told where to go. Sampled every frame, not just the pickup
    // one — `parked` is what Loco Mode used to be dead against.
    if (aFares.carrying() && aTaxi.parked) parkedWhileCarrying += 1;

    // The only tap the "player" makes in this run is on a rider standing on the kerb.
    const waiting = aFares.waiting();
    if (waiting && !waiting.directed && !aFares.carrying()) {
      if (routeTo(waiting.target)) aFares.markDirected(waiting);
    }
    elapsed += 1 / 60;
  }

  check('a rider is delivered without the drop-off ever being tapped',
    aFares.state.delivered === 1 && dispatched === pickups && pickups > 0,
    `${aFares.state.delivered} delivered after ${elapsed.toFixed(1)}s`);
  check('a carried rider never leaves the taxi parked', parkedWhileCarrying === 0,
    `${parkedWhileCarrying} frames held at the kerb`);
}

// --- Running out of time ends the run on its own beat ----------------------
// The third ending has nothing happening to the taxi to look at, so the rider is the event: they
// get out where they are, swear about it and go, on the same `beginBail` a missed VIP gets, while
// main.js points the closing camera at `state.failSpot` and holds the retry screen for it. Every
// half of that fails silently. A null `failSpot` drops the shot back onto the taxi; a rider left
// standing where the bail should have started is a frozen pin and no event at all; and the bail
// itself runs *after* `gameOver` is set, which is the one place in this module where an early
// return would freeze it on its first frame with nothing else changing.
{
  const tScene = new THREE.Scene();
  const tTraffic = createTraffic(makeRng(seed + 44), tScene, CARS_DEFAULT);
  const tFares = createFareSystem(makeRng(seed + 55), tScene);
  const tTaxi = tTraffic.taxi;
  tTraffic.warmup(5);

  // Mirrors main.js:routeTo.
  const routeTo = (target) => {
    const r = findRoute(planOrigin(tTaxi), target);
    if (!r) return false;
    tTaxi.route = r; tTaxi.routeConsumed = false; tTaxi.parked = false;
    return true;
  };

  // Drive the opening fare all the way to a pickup first, so the clock that expires belongs to a
  // rider *aboard* — the case the beat exists for, where the rider throws the door open in the
  // middle of the road rather than walking off a kerb they never left.
  let riding = null;
  let elapsed = 0;
  while (elapsed < 200 && !tFares.state.gameOver && !riding) {
    tTraffic.update(1 / 60);
    for (const { type, fare } of tFares.update(1 / 60, tTaxi)) {
      if (type === 'pickup') { tTaxi.route = []; riding = fare; }
    }
    elapsed += 1 / 60;
    const waiting = tFares.waiting();
    if (waiting && !waiting.directed && routeTo(waiting.target)) tFares.markDirected(waiting);
  }

  check('a rider is aboard before the timeout is staged', Boolean(riding),
    `${elapsed.toFixed(1)}s without a pickup`);

  // The opening fare is never a VIP, but pin it: a VIP's clock running out is the one timeout that
  // doesn't end the run, and this block would then be asserting nothing.
  riding.vip = false;
  riding.timeLeft = 1 / 120;                   // one more tick takes it under zero
  const gotOutAt = { x: tTaxi.x, z: tTaxi.z };
  const failed = tFares.update(1 / 60, tTaxi).find((e) => e.type === 'failed');

  check('a missed drop-off ends the run', Boolean(failed) && tFares.state.gameOver,
    `gameOver ${tFares.state.gameOver}`);

  const spot = tFares.state.failSpot;
  check('the closing camera is aimed at the rider getting out of the cab',
    Boolean(spot) && Math.hypot(spot.x - gotOutAt.x, spot.z - gotOutAt.z) < 1e-6,
    spot ? `${spot.x.toFixed(1)},${spot.z.toFixed(1)} vs taxi ${gotOutAt.x.toFixed(1)},${gotOutAt.z.toFixed(1)}`
      : 'no failSpot');
  check('the rider is out of the taxi and swearing about it',
    riding.slot.passenger.group.visible && riding.slot.curse.isShowing());
  // The clock over the roof is what ran out, so it goes; the ring at the far end stays. Between them
  // that is the whole of what the shot has to say — this is where they got out, and that is where
  // they were owed.
  check('their crystal goes with the run', !riding.slot.marker.group.visible);
  check('the missed drop-off ring is left standing for the shot',
    riding.slot.destination.group.visible);
  check('the expired fare still stops ticking', !tFares.state.fares.includes(riding));

  // ...and the bail animates on past `gameOver`. The whole point of the beat is that it moves while
  // the camera comes in, and `update`'s early return is exactly the shape that would leave it on
  // frame one — visible, in place, with every check above still green.
  //
  // **Measured as travel between two frames, not as distance from the cab.** The run is aimed at
  // the nearest kerb corner and stops there (`BAIL_RUN` is a ceiling, not a length), so how far the
  // rider gets is a fact about where the taxi happened to stop — a cab that dies two units from the
  // corner gives a two-unit dash, and an absolute threshold then fails on the staging rather than
  // on the animation. What is being asserted is that it is still *running*, so what is measured is
  // that it moved.
  tFares.update(1 / 60, tTaxi);
  const bailFrom = riding.slot.passenger.standing.group.position.clone();
  for (let k = 0; k < 44; k++) tFares.update(1 / 60, tTaxi);
  const ran = riding.slot.passenger.standing.group.position;
  const travelled = Math.hypot(ran.x - bailFrom.x, ran.z - bailFrom.z);
  check('the bail keeps running after the run has ended', travelled > 0.5,
    `${travelled.toFixed(2)} units travelled over 44 frames past gameOver,`
    + ` ${Math.hypot(ran.x, ran.z).toFixed(1)} from the cab`);
  check('and the outburst is over them, not where they jumped',
    Math.hypot(riding.slot.curse.group.position.x - ran.x,
      riding.slot.curse.group.position.z - ran.z) < 1e-6);

  // It also has to be *over* before the retry screen is (TIMEOUT_BANNER_DELAY in main.js, sized off
  // BAIL_SECONDS through the slow-mo ramp). Ticking out the rest of the 2.2s here is what makes that
  // arithmetic checkable at all: if the bail ever grows, this goes red rather than the banner
  // quietly sliding over a rider still running.
  for (let k = 0; k < 90; k++) tFares.update(1 / 60, tTaxi);
  check('and finished inside its own 2.2 seconds',
    !riding.slot.passenger.group.visible && !riding.slot.curse.isShowing());
}

{
  // And a rider who gives up on the kerb aims the same shot at their own corner, without a second
  // code path: `target` is whichever end of the trip was still owed.
  const kScene = new THREE.Scene();
  const kTraffic = createTraffic(makeRng(seed + 44), kScene, CARS_DEFAULT);
  const kFares = createFareSystem(makeRng(seed + 55), kScene);
  kTraffic.warmup(3);
  kFares.update(1 / 60, kTraffic.taxi);        // an empty board always refills — this is that fare
  const kerbFare = kFares.state.fares[0];
  kerbFare.vip = false;
  const corner = cornerFor(kerbFare.target.i, kerbFare.target.j);
  kerbFare.timeLeft = 1 / 120;
  kFares.update(1 / 60, kTraffic.taxi);

  const spot = kFares.state.failSpot;
  check('a rider who gives up waiting puts the shot on their own kerb corner',
    kFares.state.gameOver && Boolean(spot)
      && Math.hypot(spot.x - corner.x, spot.z - corner.z) < 1e-6,
    spot ? `${spot.x.toFixed(1)},${spot.z.toFixed(1)}` : 'no failSpot');
  check('the rider who gave up storms off that corner rather than standing on it',
    kerbFare.slot.passenger.group.visible && kerbFare.slot.curse.isShowing());
  // Along the pavement, which for this branch is one axis or the other — never the diagonal into
  // the block, the mistake `beginBail` documents. Asserted here as well as on the VIP path because
  // the two reach it by different calls now.
  for (let k = 0; k < 45; k++) kFares.update(1 / 60, kTraffic.taxi);
  const walked = kerbFare.slot.passenger.standing.group.position;
  check('and does it down one of the two pavements, in shot',
    Math.hypot(walked.x, walked.z) > 1
    && (Math.abs(walked.x) < 1e-6 || Math.abs(walked.z) < 1e-6),
    `${walked.x.toFixed(1)},${walked.z.toFixed(1)}`);
}

// --- A VIP walking out ------------------------------------------------------
//
// The third thing a clock hitting zero can do, and the only one that leaves the run running: a VIP
// gets out and goes (see `beginBail` in game/fares.js). The failure modes are all quiet ones — a
// rider left standing in the middle of the road forever, a bubble that outlives them, a slot that
// never comes back to the spawner, or the whole thing skipped so the fare simply blinks out — so
// every stage of it is asserted rather than the event alone.
{
  const bScene = new THREE.Scene();
  const bTraffic = createTraffic(makeRng(seed + 44), bScene, CARS_DEFAULT);
  const bFares = createFareSystem(makeRng(seed + 55), bScene);
  const bTaxi = bTraffic.taxi;
  bTraffic.warmup(3);

  const routeTo = (target) => {
    const r = findRoute(planOrigin(bTaxi), target);
    if (!r) return false;
    bTaxi.route = r; bTaxi.routeConsumed = false; bTaxi.parked = false;
    return true;
  };

  // Same staging as the timeout above: drive a real rider to a real pickup, then make them the VIP.
  // A fare assembled by hand would not have a slot, a marker or an animation state to check.
  let riding = null;
  let elapsed = 0;
  while (elapsed < 200 && !bFares.state.gameOver && !riding) {
    bTraffic.update(1 / 60);
    for (const { type, fare } of bFares.update(1 / 60, bTaxi)) {
      if (type === 'pickup') { bTaxi.route = []; riding = fare; }
    }
    elapsed += 1 / 60;
    const next = bFares.waiting();
    if (next && !next.directed && routeTo(next.target)) bFares.markDirected(next);
  }
  check('a rider is aboard before the bail is staged', Boolean(riding));

  riding.vip = true;
  bFares.state.vipStreak = 4;
  const { slot } = riding;
  const from = { x: bTaxi.x, z: bTaxi.z };
  riding.timeLeft = 1 / 120;
  const missed = bFares.update(1 / 60, bTaxi).find((e) => e.type === 'vip-missed');

  check('a VIP\'s clock running out does not end the run',
    Boolean(missed) && !bFares.state.gameOver);
  check('and takes the streak with it', bFares.state.vipStreak === 0,
    `streak ${bFares.state.vipStreak}`);
  check('the missed VIP leaves the board at once', !bFares.state.fares.includes(riding));
  // The clock is the one thing that goes immediately: it is what ran out.
  check('their crystal goes with the fare', !slot.marker.group.visible);
  check('but the rider is still on screen, swearing',
    slot.passenger.group.visible && slot.curse.isShowing());

  // A third of the way through: out of the cab and running. Two separate claims — the figure has
  // left the car, and the bubble is still over their head rather than parked where they jumped.
  for (let k = 0; k < 45; k++) bFares.update(1 / 60, bTaxi);
  const at = slot.passenger.standing.group.position;
  const ran = Math.hypot(at.x, at.z);
  const bubble = slot.curse.group.position;
  check('the missed VIP runs off away from the taxi', ran > 1,
    `${ran.toFixed(1)} units from where they got out`);
  check('and their outburst travels with them',
    Math.hypot(bubble.x - at.x, bubble.z - at.z) < 1e-6 && bubble.y > 4,
    `bubble ${bubble.x.toFixed(1)},${bubble.z.toFixed(1)} vs rider ${at.x.toFixed(1)},${at.z.toFixed(1)}`);
  // The pin root holds the world spot they jumped out at, so the figure's own local offset is the
  // whole of how far they have run — and it has to be heading for a pavement, not into the block
  // the taxi is already in.
  const kerb = cornerFor(bTaxi.i, bTaxi.j);
  check('they head for the nearest kerb rather than any old direction',
    (at.x * (kerb.x - from.x) + at.z * (kerb.z - from.z)) > 0,
    `ran ${at.x.toFixed(1)},${at.z.toFixed(1)}`);

  // ...and it ends. A slot pinned by an animation that never retires is a fare the board can never
  // spawn again, which is invisible until the board quietly runs one rider short for a whole run.
  for (let k = 0; k < 180; k++) bFares.update(1 / 60, bTaxi);
  check('the bail finishes and hands the slot back',
    !slot.passenger.group.visible && !slot.curse.isShowing()
    && !bFares.pickables().some((p) => p === slot.passenger.group));

  // The kerbside half of the same event, which runs the other placement branch: nobody ever
  // collected them, so they walk off their own corner rather than out of a car.
  const cScene = new THREE.Scene();
  const cTraffic = createTraffic(makeRng(seed + 44), cScene, CARS_DEFAULT);
  const cFares = createFareSystem(makeRng(seed + 55), cScene);
  cTraffic.warmup(3);
  cFares.update(1 / 60, cTraffic.taxi);
  const giving = cFares.state.fares[0];
  giving.vip = true;
  giving.timeLeft = 1 / 120;
  const kerbMiss = cFares.update(1 / 60, cTraffic.taxi).find((e) => e.type === 'vip-missed');
  for (let k = 0; k < 45; k++) cFares.update(1 / 60, cTraffic.taxi);

  const stood = giving.slot.passenger.standing.group.position;
  const centre = intersectionCentre(giving.pickup.i, giving.pickup.j);
  const corner = cornerFor(giving.pickup.i, giving.pickup.j);
  const outward = { x: corner.x - centre.x, z: corner.z - centre.z };
  check('a VIP nobody collected walks off the kerb too',
    Boolean(kerbMiss) && !cFares.state.gameOver
    && giving.slot.passenger.group.visible && giving.slot.curse.isShowing());
  // Along one axis and away from the crossing road — never the diagonal between them. A corner pin
  // stands half a unit inside its block and buildings begin 0.85 in, so a diagonal storm-off ends
  // inside a shopfront: the rider is simply gone, behind a wall, for the whole animation. Both
  // halves are asserted because either one alone passes on the bug — the diagonal moves outward
  // too, and a run along an axis toward the junction stays on one axis.
  const along = Math.abs(stood.x) > Math.abs(stood.z) ? 'x' : 'z';
  check('and walks along their own pavement rather than into the block',
    Math.abs(along === 'x' ? stood.z : stood.x) < 1e-6
    && (stood.x * outward.x + stood.z * outward.z) > 0,
    `${stood.x.toFixed(2)},${stood.z.toFixed(2)} from a kerb at ${outward.x.toFixed(1)},${outward.z.toFixed(1)}`);
}

// --- The outburst bubble ----------------------------------------------------
//
// Hand-written triangles, in a plane, aimed at the camera by a constant — three things that fail
// silently. A reversed winding is invisible in the geometry and renders as a hole; a billboard a
// few degrees off is invisible in a screenshot and obvious in a dot product.
{
  const bubble = createCurseBubble();
  // Every mesh, not just the first: the rim, the paper and the ink are three separate hand-wound
  // buffers and only one of them is a fan. `ShapeGeometry`'s indexed layout is what made the
  // courier pad's version of this check pass against a shape that was fine — these are all
  // non-indexed, so position order *is* triangle order, and that is asserted rather than assumed.
  let indexed = 0;
  let backwards = 0;
  let triangles = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (const mesh of bubble.group.children) {
    if (mesh.geometry.index) { indexed += 1; continue; }
    const pos = mesh.geometry.attributes.position;
    for (let t = 0; t < pos.count; t += 3) {
      a.fromBufferAttribute(pos, t);
      b.fromBufferAttribute(pos, t + 1);
      c.fromBufferAttribute(pos, t + 2);
      normal.crossVectors(b.sub(a), c.sub(a));
      triangles += 1;
      if (normal.z <= 0) backwards += 1;
    }
  }
  check('every face of the outburst bubble points at the viewer',
    indexed === 0 && backwards === 0 && triangles > 40,
    `${triangles} triangles, ${backwards} wound away, ${indexed} indexed`);

  // The bubble is authored in the screen plane, so the constant that turns it has to map local +Z
  // onto the view direction and local +X onto screen right — the same two vectors the camera is
  // actually built from.
  const facing = new THREE.Vector3(0, 0, 1).applyQuaternion(BILLBOARD);
  const across = new THREE.Vector3(1, 0, 0).applyQuaternion(BILLBOARD);
  check('and the whole bubble faces the camera it was drawn for',
    facing.dot(VIEW_DIR) > 0.9999 && across.dot(RIGHT) > 0.9999,
    `view ${facing.dot(VIEW_DIR).toFixed(4)}, right ${across.dot(RIGHT).toFixed(4)}`);
  // Which is what lets `CURSE_LIFT` be a plain world-Y offset: straight up in the world is straight
  // up on the screen under this camera, so the tail stays pointed at the rider's head.
  const up = new THREE.Vector3(0, 1, 0);
  check('a world-Y lift moves it straight up the screen',
    Math.abs(up.dot(RIGHT)) < 1e-9 && Math.abs(up.dot(new THREE.Vector3(0, 1, 0)
      .applyQuaternion(BILLBOARD)) - SCREEN_PER_WORLD_Y) < 1e-6,
    `screen per world Y ${SCREEN_PER_WORLD_Y.toFixed(3)}`);

  // Where it floats. The lift is in world units, the bubble is drawn in screen ones, and the tail
  // has to clear the head of a figure measured in the first — three modules and two spaces for one
  // relationship, which is precisely why it is asserted rather than eyeballed. The first lift was
  // chosen in world units without the conversion and hung the tail's point level with the rider's
  // chest. The head is read off the built figure rather than from a copied constant.
  const figure = createPerson();
  figure.rest();
  const head = new THREE.Box3().setFromObject(figure.group).max.y;
  const tip = CURSE_LIFT * SCREEN_PER_WORLD_Y - TAIL_DROP;
  check('the outburst\'s tail points at the rider\'s head rather than through it',
    tip > head * SCREEN_PER_WORLD_Y && tip < head * SCREEN_PER_WORLD_Y + 1.5,
    `tail tip ${tip.toFixed(2)} against a head at ${(head * SCREEN_PER_WORLD_Y).toFixed(2)}`);

  // It opens from nothing and it has to be gone by the end, or a slot's next rider inherits a
  // shout. Both ends are read off the object rather than off the constants that shape it.
  bubble.show();
  bubble.update(0);
  const opening = bubble.group.scale.x;
  bubble.update(0.5);
  const held = bubble.group.scale.x;
  const ink = bubble.group.children[bubble.group.children.length - 1];
  const inkOpen = ink.material.opacity;
  bubble.update(1);
  check('the outburst swells in and fades out',
    opening < 0.05 && held > 0.9 && inkOpen > 0.99 && ink.material.opacity < 0.01,
    `scale ${opening.toFixed(2)} → ${held.toFixed(2)}, ink ${inkOpen.toFixed(2)} → ${ink.material.opacity.toFixed(2)}`);
}

// --- Taxi-vs-car collisions ------------------------------------------------
// The whole feature only fires while boosting, and its silent failure modes are: no impact ever
// detected, an impact that doesn't wreck the taxi, or a wrecked car left driving around because
// something forgot to take it out of the sim. Drive the taxi head-on into an unsuspecting car and
// assert the whole crash chain, both cars included.
{
  const cScene = new THREE.Scene();
  const cTraffic = createTraffic(makeRng(seed + 44), cScene, CARS_DEFAULT);
  const cFares = createFareSystem(makeRng(seed + 55), cScene);
  const cTaxi = cTraffic.taxi;
  const collisions = createCollisions(cTraffic.cars, cTaxi);
  const cVanish = createVanish();
  let hits = 0;
  let impact = null;
  const shells = [];
  collisions.onImpact((event) => {
    hits += 1;
    impact = event;
    // Mirror the main.js wiring: both cars hand over their bodywork to the shrink-and-fade, and
    // the run ends.
    for (const car of [event.taxi, event.other]) {
      const shell = cTraffic.wreckShell(car);
      shells.push(shell);
      // Mirroring main.js again: each shell collapses while still *moving*, along the taxi's
      // heading and at its share of the speed the impact came in at. The fractions here are only
      // representative — what is being checked below is the wiring, not main.js's tuning.
      cVanish.take(shell, {
        driftX: Math.cos(event.taxi.yaw) * event.speed * 0.6,
        driftZ: -Math.sin(event.taxi.yaw) * event.speed * 0.6,
        spin: 1.2,
      });
    }
    cFares.crash();
  });

  cTraffic.warmup(3);

  // Park the taxi on top of an ambient car and start boosting.
  const target = cTraffic.cars.find((c) => !c.isTaxi && c.state === 'drive');
  cTaxi.x = target.x;
  cTaxi.z = target.z;
  cTaxi.boost = true;

  for (let step = 0; step < 90; step++) {
    collisions.update();
    cTraffic.update(1 / 60);
    if (hits > 0) break;
  }

  check('boosting into another car fires an impact', hits >= 1, `${hits} impacts`);
  check('the taxi is wrecked by the impact', cTaxi.crashed);
  check('game over fires with the wreck reason', cFares.state.gameOver
    && /paycheck/i.test(cFares.state.failReason ?? ''), cFares.state.failReason);

  // The impact carries the speed it happened at. `collisions.update` zeroes both cars a line
  // before it emits, so a listener that went looking for `taxi.v` itself would read 0 and every
  // piece of the wreck's momentum would quietly come out stationary — which is exactly what the
  // whole crash looked like before this existed.
  //
  // The pair is the check, not the number: a speed still on the event *and* a zero on the car it
  // came off. The staged impact here fires on the first frame of the boost, so 8-odd u/s rather
  // than the 22 a real one arrives at — which is fine, since what is being asserted is the
  // ordering of two lines rather than a magnitude.
  check('the impact reports the speed it happened at, after zeroing the car',
    impact.speed > 1 && impact.taxi.v === 0,
    `${impact?.speed?.toFixed(1)} u/s on the event, ${impact?.taxi?.v} on the taxi`);

  const victim = impact?.other;
  check('the car it hit is wrecked too', Boolean(victim?.crashed));

  // A wrecked car must be gone from the road, not merely marked: same place a second later, and
  // its instance collapsed to nothing so the InstancedMesh isn't still drawing it.
  const restX = victim.x;
  const restZ = victim.z;
  for (let step = 0; step < 60; step++) cTraffic.update(1 / 60);
  check('the wrecked car stops driving', victim.x === restX && victim.z === restZ,
    `${victim.x.toFixed(2)},${victim.z.toFixed(2)} vs ${restX.toFixed(2)},${restZ.toFixed(2)}`);

  // Body *and* both steered front wheels — the wheels are their own instanced mesh, so a wreck
  // that only collapsed the body would leave two wheels parked on the road.
  const instanceScale = new THREE.Vector3();
  const instanceMatrix = new THREE.Matrix4();
  const scaleOf = (instMesh, index) => {
    instMesh.getMatrixAt(index, instanceMatrix);
    instanceMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), instanceScale);
    return instanceScale.x;
  };
  const wheelsPerCar = cTraffic.wheelMesh.count / (cTraffic.cars.length - 1);
  const wheelScales = [];
  for (let w = 0; w < wheelsPerCar; w++) {
    wheelScales.push(scaleOf(cTraffic.wheelMesh, victim.instanceIndex * wheelsPerCar + w));
  }
  check('its instances are collapsed out of the traffic meshes',
    scaleOf(cTraffic.mesh, victim.instanceIndex) === 0 && wheelScales.every((s) => s === 0),
    `body + ${wheelScales.length} wheels`);

  // Two shells handed over — the taxi group and a standalone copy of the ambient car — and both
  // shrink and fade rather than cutting out on the impact frame.
  check('both wrecks hand over a shell to fade', shells.length === 2 && shells[0] !== shells[1]);
  // One material across the copy's body and wheels; read it off the body mesh.
  const shellMaterial = shells[1].children[0].material;
  const baseScale = shells[1].scale.x;
  const shellFrom = shells[1].position.clone();
  const shellPose = shells[1].quaternion.clone();
  cVanish.update(0.17);
  check('a wreck shell shrinks and fades under the explosion',
    shells[1].scale.x < baseScale && shells[1].scale.x > 0
    && shellMaterial.opacity < 1 && shellMaterial.opacity > 0,
    `scale ${shells[1].scale.x.toFixed(2)}, opacity ${shellMaterial.opacity.toFixed(2)}`);

  // And it is still travelling while it does. The shells are the most visible half of the crash's
  // momentum — a fireball is an abstraction and can be forgiven for standing still, a recognisable
  // car cannot — so a shell that collapsed on the spot read as the taxi stopping and *then*
  // exploding however much was moving around it. Downfield along the heading, and slewed off its
  // own line as it goes.
  const heading = { x: Math.cos(impact.taxi.yaw), z: -Math.sin(impact.taxi.yaw) };
  const moved = shells[1].position.clone().sub(shellFrom);
  check('a wreck shell keeps travelling as it collapses',
    moved.length() > 0.4
    && moved.x * heading.x + moved.z * heading.z > moved.length() - 1e-6
    && shells[1].quaternion.angleTo(shellPose) > 0.05,
    `${moved.length().toFixed(2)} units on, `
    + `${(shells[1].quaternion.angleTo(shellPose) * 180 / Math.PI).toFixed(1)}° of slew`);
  cVanish.update(0.4);
  check('a wreck shell ends hidden at zero size',
    !shells[1].visible && shells[1].scale.x === 0 && cVanish.pending() === 0);

  check('a wrecked taxi does not fire further impacts', hits === 1, `${hits} impacts`);

  // A non-boosting taxi must never trigger a collision — normal lane logic keeps them apart.
  const qScene = new THREE.Scene();
  const qTraffic = createTraffic(makeRng(seed + 44), qScene, CARS_DEFAULT);
  const qCollisions = createCollisions(qTraffic.cars, qTraffic.taxi);
  let quietHits = 0;
  qCollisions.onImpact(() => { quietHits += 1; });
  for (let step = 0; step < 60 * 30; step++) {
    qCollisions.update();
    qTraffic.update(1 / 60);
  }
  check('no collisions fire while the taxi is not boosting', quietHits === 0,
    `${quietHits} impacts over 30s`);
}

// --- Box trucks --------------------------------------------------------------
// A purely opt-in ambient variant — every scenario in this file runs with truckChance at its
// default of 0, so nothing above ever draws one. This is the one place it gets turned on, forcing
// every ambient car to be a truck and driving the same crash path as the block above, aimed at the
// truck meshes instead of the car ones — the failure mode worth catching is a wrecked truck
// collapsing the wrong InstancedMesh slot (its own car-mesh index, which happens to belong to some
// other truck) instead of its own.
{
  const uScene = new THREE.Scene();
  const uTraffic = createTraffic(makeRng(seed + 44), uScene, CARS_DEFAULT, CARS_DEFAULT, 1);
  check('truckChance=1 puts every ambient car in the truck meshes',
    uTraffic.mesh.count === 0 && uTraffic.truckMesh.count === CARS_DEFAULT - 1
    && uTraffic.truckBoxMesh.count === CARS_DEFAULT - 1,
    `car mesh ${uTraffic.mesh.count}, truck mesh ${uTraffic.truckMesh.count}, box mesh ${uTraffic.truckBoxMesh.count}`);

  // The invisible truck. Three computes an InstancedMesh's bounding sphere once, off the instance
  // matrices as they stood on the first frame the renderer culled it, and never refreshes it — so
  // a mesh whose instances drive across the city is culled against where they *were*. See the note
  // by `neverCull` in sim/traffic.js; game/carghosts.js has the same assertion for the same reason.
  //
  // Staged at the worst case that shipped: one truck, whose sphere is then a 3.1-unit bubble around
  // its warmup position, watched through a portrait phone's frustum (where the camera follows the
  // taxi rather than framing the whole city). Before the fix, a truck plainly on screen went
  // unsubmitted in 27% of these samples — and since the cab and the box are separate meshes with
  // separate spheres, some of those frames dropped only the box and left a cab driving down the
  // street with nothing on its back.
  {
    const kScene = new THREE.Scene();
    const kTraffic = createTraffic(makeRng(seed + 44), kScene, 2, 2, 1);
    check('every moving vehicle mesh is out of frustum culling',
      [kTraffic.mesh, kTraffic.wheelMesh,
        kTraffic.truckMesh, kTraffic.truckWheelMesh, kTraffic.truckBoxMesh]
        .every((m) => m.frustumCulled === false));

    const kAspect = 390 / 844;
    const kCam = createCityCamera(kAspect, { zoom: 46 });
    const kFrustum = new THREE.Frustum();
    const kMat = new THREE.Matrix4();
    const kPoint = new THREE.Vector3();
    // WebGLRenderer.projectObject's own test, verbatim — `frustumCulled` first, and the sphere
    // only if it is still on. WebGLShadowMap applies the same rule to the sun's frustum, which
    // covers the whole city, so a stale sphere drops the truck from the play camera while its
    // shadow keeps sliding along the road underneath it.
    const submitted = (m) => {
      kScene.updateMatrixWorld(true);
      kCam.camera.updateMatrixWorld(true);
      kMat.multiplyMatrices(kCam.camera.projectionMatrix, kCam.camera.matrixWorldInverse);
      kFrustum.setFromProjectionMatrix(kMat);
      return !m.frustumCulled || kFrustum.intersectsObject(m);
    };

    kTraffic.warmup(10);                 // main.js warms up before its first frame; so does this
    submitted(kTraffic.truckMesh);       // ...and that first frame is what would latch the sphere
    // Now put the truck on the taxi's own lane, which is both halves of the staging: it is nowhere
    // near the position the sphere was just latched at, and the camera follows the taxi, so the
    // frames the two share are guaranteed rather than hoped for. The 2%-to-33% band the note below
    // records has a **zero** in it — a draw where the pair never meet at all leaves this with no
    // samples to assert on, and the precondition fails while the invariant underneath is perfectly
    // healthy. Left to luck it took a reshuffle of the turn dice to find one; it is one line to
    // stop it being luck.
    if (kTraffic.trucks[0]) {
      placeCar(kTraffic.trucks[0], kTraffic.taxi.d, kTraffic.taxi.i, kTraffic.taxi.j,
        Math.max(0, kTraffic.taxi.s - CAR_LEN * 2));
    }
    let kInShot = 0;
    let kDropped = 0;
    // Every frame, not every fifteenth. One truck wandering a 5×5 city shares the phone-sized
    // frame with the taxi for anywhere between 2% and 33% of a minute depending on the seed, so at
    // a 15-frame stride the *precondition* — enough samples to be worth asserting on — is the part
    // that fails, and it fails on a lean draw while the invariant underneath it is perfectly
    // healthy. Measured over 8 seeds: the stride left 5 to 78 usable samples and three of those
    // seeds fell under the 20 this needs; sampling every frame gives 73 to 1183, and tests the
    // culling on fifteen times as many frames for a couple of seconds of probe time.
    for (let step = 0; step < 60 * 60; step++) {
      kTraffic.update(1 / 60);
      kCam.followXZ(kTraffic.taxi.x, kTraffic.taxi.z, 1 / 60, 3.2, kAspect);
      const onScreen = kTraffic.trucks.some((t) => {
        kPoint.set(t.x, 1.5, t.z).project(kCam.camera);
        return Math.abs(kPoint.x) < 0.95 && Math.abs(kPoint.y) < 0.95;
      });
      if (!onScreen) continue;
      kInShot += 1;
      if (!submitted(kTraffic.truckMesh) || !submitted(kTraffic.truckWheelMesh)
        || !submitted(kTraffic.truckBoxMesh)) kDropped += 1;
    }
    check('a truck on screen is still drawn once it has left where it spawned',
      kInShot > 20 && kDropped === 0,
      `${kInShot} sampled frames with a truck in shot, ${kDropped} of them culled away`);
  }

  // truckMesh's instance colour — which tints its chassis (the cab itself is baked dark
  // regardless, see truckCabGeometry) — is painted from PALETTE.carBody, same as an ordinary car.
  // Only the cargo box breaks from that, and it does so by never getting an instance colour at
  // all, not by reading a different palette.
  const uChassisColor = new THREE.Color();
  uTraffic.truckMesh.getColorAt(0, uChassisColor);
  const uCab = uTraffic.trucks[0];
  check("a truck's chassis is painted from the car palette",
    uChassisColor.getHexString()
    === new THREE.Color(PALETTE.carBody[uCab.colorIndex]).getHexString(),
    `#${uChassisColor.getHexString()} vs carBody[${uCab.colorIndex}] #${new THREE.Color(PALETTE.carBody[uCab.colorIndex]).getHexString()}`);
  check("a truck's cargo box is never instance-tinted", uTraffic.truckBoxMesh.instanceColor === null);

  // Driving feel: a truck cruises a little slower than a car (TRUCK_SPEED) and rocks less on every
  // start and stop (TRUCK_PITCH_SCALE / TRUCK_PITCH_DAMPING_MULT). Measured over a stretch of
  // ordinary driving against a same-seed, same-count control scene of ordinary cars, so the
  // comparison isn't luck of which junction either population happened to be at.
  const vTraffic = createTraffic(makeRng(seed + 44), new THREE.Scene(), CARS_DEFAULT);
  const sampleDriving = (traf, seconds) => {
    let vSum = 0; let vN = 0;
    let pitchSum = 0; let pitchN = 0;
    for (let step = 0; step < seconds * 60; step++) {
      traf.update(1 / 60);
      for (const car of traf.cars) {
        if (car.isTaxi || car.crashed) continue;
        if (car.state === 'drive') { vSum += car.v; vN += 1; }
        pitchSum += Math.abs(car.pitch); pitchN += 1;
      }
    }
    return { avgV: vN ? vSum / vN : 0, avgPitch: pitchN ? pitchSum / pitchN : 0 };
  };
  const truckSample = sampleDriving(uTraffic, 12);
  const carSample = sampleDriving(vTraffic, 12);
  check('trucks cruise slower than cars', truckSample.avgV < carSample.avgV * 0.95,
    `truck avg v ${truckSample.avgV.toFixed(2)} vs car avg v ${carSample.avgV.toFixed(2)}`);
  check('trucks rock less than cars on every start and stop',
    truckSample.avgPitch < carSample.avgPitch * 0.85,
    `truck avg |pitch| ${truckSample.avgPitch.toFixed(4)} vs car avg |pitch| ${carSample.avgPitch.toFixed(4)}`);

  // Following distance: a car has to leave more clear road behind a truck than behind another
  // car, since a leader's actual length has to be part of the gap — see followGap in traffic.js.
  // Staged directly on a straight, roomy lane: a parked leader (parked + no route holds any
  // ambient car forever, same trick the taxi's own kerb wait uses) and a follower that closes in
  // behind it and brakes to a stop, read once both have settled.
  // The lane itself — not just the chained approach room — has to be long enough for both `back`
  // values below to land inside it: placeCar walks back across a junction into the previous lane
  // in the chain once `back` exceeds this one's own length, which would leave leader and follower
  // on two unrelated lanes instead of nose-to-tail on one.
  let gI = -1; let gJ = -1; let gD = -1;
  const gNet = cityNetwork();
  outerGap: for (let i = 1; i < GRID_I; i++) {
    for (let j = 1; j < GRID_J; j++) {
      for (const d of [0, 1, 2, 3]) {
        const lane = gNet.laneByGrid(d, i, j);
        if (!lane || lane.degenerate || lane.length < 11.5) continue;
        gI = i; gJ = j; gD = d;
        break outerGap;
      }
    }
  }
  const settledGap = (leaderIsTruck) => {
    const gTraffic = createTraffic(makeRng(seed + 44), new THREE.Scene(), 3);
    const [, leader, follower] = gTraffic.cars;
    leader.isTruck = leaderIsTruck;
    placeCar(leader, gD, gI, gJ, 4);
    leader.parked = true;
    placeCar(follower, gD, gI, gJ, 11);
    for (let step = 0; step < 300; step++) gTraffic.update(1 / 60);
    return Math.hypot(leader.x - follower.x, leader.z - follower.z);
  };
  // CAR_LEN/2 + CAR_LEN/2 + BUMPER_GAP (1.9) = MIN_GAP = 5.3; with a truck leader,
  // CAR_LEN/2 + TRUCK_LEN/2 + BUMPER_GAP = 1.7 + 2.8 + 1.9 = 6.4.
  const carGap = settledGap(false);
  const truckGap = settledGap(true);
  check('a car settles further back behind a truck than behind a car',
    truckGap > carGap + 0.9, `behind a car ${carGap.toFixed(2)}, behind a truck ${truckGap.toFixed(2)}`);
  check('the settled gaps match followGap exactly, not the old flat MIN_GAP for both',
    Math.abs(carGap - 5.3) < 0.1 && Math.abs(truckGap - 6.4) < 0.1,
    `behind a car ${carGap.toFixed(2)} (want ~5.3), behind a truck ${truckGap.toFixed(2)} (want ~6.4)`);

  const uCollisions = createCollisions(uTraffic.cars, uTraffic.taxi);
  const uVanish = createVanish();
  let uHits = 0;
  let uImpact = null;
  const uShells = [];
  uCollisions.onImpact((event) => {
    uHits += 1;
    uImpact = event;
    for (const car of [event.taxi, event.other]) {
      const shell = uTraffic.wreckShell(car);
      uShells.push(shell);
      uVanish.take(shell);
    }
  });

  uTraffic.warmup(3);
  const uTarget = uTraffic.cars.find((c) => !c.isTaxi && c.state === 'drive');
  uTraffic.taxi.x = uTarget.x;
  uTraffic.taxi.z = uTarget.z;
  uTraffic.taxi.boost = true;
  for (let step = 0; step < 90; step++) {
    uCollisions.update();
    uTraffic.update(1 / 60);
    if (uHits > 0) break;
  }

  check('boosting into a truck fires an impact', uHits >= 1, `${uHits} impacts`);
  const uVictim = uImpact?.other;
  check('the truck it hit is wrecked', Boolean(uVictim?.crashed) && uVictim.isTruck === true);

  const uScale = new THREE.Vector3();
  const uMatrix = new THREE.Matrix4();
  const scaleOfTruck = (instMesh, index) => {
    instMesh.getMatrixAt(index, uMatrix);
    uMatrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), uScale);
    return uScale.x;
  };
  const truckWheelScales = [];
  for (let w = 0; w < uTraffic.truckWheelsPerCar; w++) {
    truckWheelScales.push(scaleOfTruck(
      uTraffic.truckWheelMesh, uVictim.instanceIndex * uTraffic.truckWheelsPerCar + w,
    ));
  }
  check('a wrecked truck collapses out of the truck meshes, not the car ones',
    scaleOfTruck(uTraffic.truckMesh, uVictim.instanceIndex) === 0
    && scaleOfTruck(uTraffic.truckBoxMesh, uVictim.instanceIndex) === 0
    && truckWheelScales.every((s) => s === 0),
    `cab + box + ${truckWheelScales.length} wheels`);

  // The shell itself carries two materials for a truck — cab+wheels in its car-palette colour, the
  // box in the fixed PALETTE.truckBox — and game/vanish.js has to find and fade both.
  const uShell = uShells[1];
  check('a wrecked truck hands over both a cab and a box mesh',
    uShell.children.length === 2 + truckWheelScales.length);

  // Right turns: a truck should visibly take longer than a car on the identical turn — see
  // TRUCK_RIGHT_TURN_SPEED in traffic.js. Staged with a forced route, the same "one routing
  // branch" any car can use and not just the taxi (docs/traffic.md), so the turn direction isn't
  // left to the weighted dice.
  let rI = -1; let rJ = -1; let rD = -1;
  outerRight: for (let i = 1; i < GRID_I; i++) {
    for (let j = 1; j < GRID_J; j++) {
      for (const d of [0, 1, 2, 3]) {
        if (!legalExits(d, i, j).includes(rightOf(d))) continue;
        const lane = gNet.laneByGrid(d, i, j);
        if (!lane || lane.degenerate || lane.length < 8) continue;
        rI = i; rJ = j; rD = d;
        break outerRight;
      }
    }
  }
  const rightTurnSeconds = (isTruck) => {
    const rTraffic = createTraffic(makeRng(seed + 44), new THREE.Scene(), 2);
    const [, car] = rTraffic.cars;
    car.isTruck = isTruck;
    placeCar(car, rD, rI, rJ, 7);
    car.route = [rightOf(rD)];
    let seconds = 0;
    let seenTurn = false;
    for (let step = 0; step < 60 * 30; step++) {
      rTraffic.update(1 / 60);
      if (car.state === 'turn') { seconds += 1 / 60; seenTurn = true; } else if (seenTurn) break;
    }
    return seconds;
  };
  const carRightSeconds = rightTurnSeconds(false);
  const truckRightSeconds = rightTurnSeconds(true);
  check('a truck takes measurably longer than a car on the same right turn',
    truckRightSeconds > carRightSeconds * 1.3,
    `car ${carRightSeconds.toFixed(2)}s, truck ${truckRightSeconds.toFixed(2)}s`);
}

// --- The crash blast -------------------------------------------------------
// game/blast.js is what a wreck detonates. Its silent failure modes are all "it looked fine on the
// impact frame": a pool that wraps and truncates the second car's burst, a slot left drawing after
// its life ran out, or both cars' shards coming out the same colour — which is the one thing the
// two separate debris pools it replaced were carrying.
{
  const eScene = new THREE.Scene();
  const blast = createBlast(eScene, makeRng(seed + 88));

  const liveScales = (mesh) => {
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const out = [];
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      if (scale.x > 0) out.push(scale.x);
    }
    return out;
  };

  check('a blast starts with nothing drawn', blast.active() === 0);

  // Both cars of a wreck, a couple of units apart and in their own paint.
  blast.fire(0, 0, PALETTE.taxiBody);
  blast.fire(3, 1.5, PALETTE.carBody[1]);
  const fired = blast.active();
  blast.update(1 / 60);

  check('both cars fit the pools without wrapping',
    fired === 2 * (12 + 7 + 2 + 1), `${fired} instances`);
  check('a blast puts a ring, a fireball and shards on the road',
    liveScales(blast.ringMesh).length === 2
    && liveScales(blast.puffMesh).length === 24
    && liveScales(blast.shardMesh).length === 14,
    `${liveScales(blast.ringMesh).length} rings, ${liveScales(blast.puffMesh).length} puffs, `
    + `${liveScales(blast.shardMesh).length} shards`);

  // Each car's shards wear that car's paint — a shared pool would have repainted the first car's
  // wreckage when the second one detonated.
  const shardColors = new Set();
  const instanceColor = new THREE.Color();
  for (let i = 0; i < blast.shardMesh.count; i++) {
    blast.shardMesh.getColorAt(i, instanceColor);
    shardColors.add(instanceColor.getHexString());
  }
  const taxiHex = new THREE.Color(PALETTE.taxiBody).getHexString();
  const otherHex = new THREE.Color(PALETTE.carBody[1]).getHexString();
  check('each car\'s shards keep their own paint',
    shardColors.has(taxiHex) && shardColors.has(otherHex),
    [...shardColors].join(' '));

  // The fireball peaks and then collapses — a blast that only faded left a full-size ghost of
  // itself hanging over the road for the whole retry screen.
  let peak = 0;
  for (let step = 0; step < 40; step++) {
    blast.update(1 / 60);
    peak = Math.max(peak, Math.max(0, ...liveScales(blast.puffMesh)));
  }
  const later = Math.max(0, ...liveScales(blast.puffMesh));
  check('the fireball blooms and then collapses', peak > 1 && later < peak,
    `peak ${peak.toFixed(2)}, ${later.toFixed(2)} at 0.67s`);

  // And it ends. Every slot back to zero scale, not merely faded — an instance left at size is
  // still a draw, and this pool is never cleared by anything else.
  for (let step = 0; step < 60 * 3; step++) blast.update(1 / 60);
  check('a blast retires completely',
    blast.active() === 0
    && liveScales(blast.ringMesh).length === 0
    && liveScales(blast.puffMesh).length === 0
    && liveScales(blast.shardMesh).length === 0,
    `${blast.active()} still alive`);

  // Shards arc, but nothing may end up under the road: there is no bounce to catch them any more,
  // only a floor.
  const bScene = new THREE.Scene();
  const floorBlast = createBlast(bScene, makeRng(seed + 89));
  floorBlast.fire(0, 0, PALETTE.taxiBody);
  let lowest = Infinity;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  for (let step = 0; step < 90; step++) {
    floorBlast.update(1 / 60);
    for (let i = 0; i < floorBlast.shardMesh.count; i++) {
      floorBlast.shardMesh.getMatrixAt(i, matrix);
      position.setFromMatrixPosition(matrix);
      const scale = new THREE.Vector3();
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      if (scale.x > 0) lowest = Math.min(lowest, position.y);
    }
  }
  check('no shard falls through the road', lowest >= 0.2 - 1e-6, `lowest y ${lowest.toFixed(3)}`);

  // Momentum. A crash at 22 u/s that blooms out of a stationary origin reads as a car stopping and
  // *then* exploding — and the crash slow-mo stretches exactly those frames out to five times their
  // length, so it is the one thing the beat cannot hide. Each of the three drifts along the
  // heading, by its own fraction of the taxi's speed (util/carry.js), and the ordering between them
  // is the claim: shards keep the most, then the fireball, then the ring — which is what keeps the
  // ring under the fire and the fire behind the wreckage rather than the other way about.
  //
  // Measured against the *same seed* detonated at rest, so what is being read is the drift and not
  // the roll of the fan, and along the heading, so a burst that merely got wider does not pass.
  const BLAST_HEADING = 0.6;
  const forward = { x: Math.cos(BLAST_HEADING), z: -Math.sin(BLAST_HEADING) };
  const reachOf = (speed) => {
    const scene = new THREE.Scene();
    const b = createBlast(scene, makeRng(seed + 91));
    b.fire(0, 0, PALETTE.taxiBody, BLAST_HEADING, speed);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const out = { ring: 0, puff: 0, shard: 0, side: 0 };
    for (let step = 0; step < 60 * 3; step++) {
      b.update(1 / 60);
      for (const [key, mesh] of [['ring', b.ringMesh], ['puff', b.puffMesh], ['shard', b.shardMesh]]) {
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, m);
          m.decompose(p, new THREE.Quaternion(), sc);
          if (sc.x <= 0) continue;
          out[key] = Math.max(out[key], p.x * forward.x + p.z * forward.z);
          // Across the heading. The carry must not show up here at all: a drift that leaked
          // sideways would be a sign vs a rotation error, which is invisible in the reach.
          out.side = Math.max(out.side, Math.abs(p.x * -forward.z + p.z * forward.x));
        }
      }
    }
    return out;
  };
  const still = reachOf(0);
  const moving = reachOf(22.1);
  const drift = {
    ring: moving.ring - still.ring,
    puff: moving.puff - still.puff,
    shard: moving.shard - still.shard,
  };
  check('the blast carries downfield, hardest on the heaviest debris',
    drift.ring > 1.5 && drift.puff > drift.ring && drift.shard > drift.puff && drift.shard < 12,
    `ring +${drift.ring.toFixed(2)}, fireball +${drift.puff.toFixed(2)}, shards +${drift.shard.toFixed(2)}`);
  check('none of the carry leaks across the heading',
    Math.abs(moving.side - still.side) < 1e-6,
    `${still.side.toFixed(2)} at rest vs ${moving.side.toFixed(2)} moving`);
  // And a blast fired without a speed is exactly the old one: the lab and the shot tool both rely
  // on a wreck detonating where it happened.
  check('a blast with no momentum detonates on the spot', still.ring === 0,
    `ring reached ${still.ring.toFixed(3)}`);
}

// --- The Loco Mode tailpipe flame -------------------------------------------
// game/locoflame.js is the plume that burns for the whole hold. Everything about it fails silently:
// hand-wound triangles that render as a hole, a cutout aimed along the wrong axis (which looks like
// a flame at exactly one heading and like a fin at the other three), a plume long enough to reach
// through the road, and an envelope that leaves the thing burning after the button came up.
{
  const fScene = new THREE.Scene();
  const flame = createLocoFlame(fScene);
  const still = { x: 0, z: 0, yaw: 0, crashed: false };
  const hold = (car, seconds, on) => {
    for (let step = 0; step < Math.round(seconds * 60); step++) flame.update(1 / 60, car, on);
  };

  check('nothing burns until Loco Mode is held', (() => {
    hold(still, 1, false);
    return flame.group.visible === false;
  })());

  // The winding, first, and every triangle of every silhouette rather than the first one — a
  // reversed strip quad is invisible in the geometry and draws as a notch out of the flame. The
  // buffers are non-indexed, which is asserted rather than assumed: reading `position` in order
  // tests triangles that do not exist the moment something makes them indexed (see the courier
  // pad's version of this check in CLAUDE.md).
  let triangles = 0;
  let backwards = 0;
  let indexed = 0;
  let offPlane = 0;
  {
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (const frame of flame.frames) {
      const geometry = frame.children[0].geometry;
      if (geometry.index) { indexed += 1; continue; }
      const pos = geometry.attributes.position;
      for (let t = 0; t < pos.count; t += 3) {
        a.fromBufferAttribute(pos, t);
        b.fromBufferAttribute(pos, t + 1);
        c.fromBufferAttribute(pos, t + 2);
        if (a.z !== 0 || b.z !== 0 || c.z !== 0) offPlane += 1;
        normal.crossVectors(b.sub(a), c.sub(a));
        triangles += 1;
        if (normal.z <= 0) backwards += 1;
      }
    }
  }
  check('every tongue is a flat sheet wound one way',
    indexed === 0 && backwards === 0 && offPlane === 0 && triangles === flame.frames.length * 19,
    `${triangles} triangles, ${backwards} wound away, ${offPlane} off the plane, ${indexed} indexed`);

  // The cutout is drawn from both sides *because* the camera sees the back of it on half the
  // compass — the plane's normal is (−sin yaw, 0, −cos yaw), so its dot with the view direction
  // flips sign between east and west. A single-sided flame would simply not be there for two of
  // the four headings, which is not something a check on one heading can catch.
  const backLit = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2].filter((yaw) => {
    const facing = new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(0, yaw + Math.PI, 0));
    return facing.dot(VIEW_DIR) < 0;
  });
  check('the plume is double-sided, because the camera sees its back on half the headings',
    backLit.length === 2 && flame.materials.every((m) => m.side === THREE.DoubleSide),
    `${backLit.length} of 4 headings show the back face`);

  // Where it burns, and which way. Local +X is the plume's length and it has to lie along the
  // car's *backward* direction — the same (−cos yaw, sin yaw) every other effect off this bumper is
  // written in. Getting this wrong at one heading is a flame out of the bonnet at another.
  let worstAim = 1;
  let worstAnchor = 0;
  let lowest = Infinity;
  for (const yaw of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2, 0.7]) {
    const car = { x: 12, z: -7, yaw, crashed: false };
    // Two seconds of hold, so the flipbook has been round its whole cycle and the pulse has been
    // through both of its beats — the reach is a moving number and one frame of it proves nothing.
    for (let step = 0; step < 120; step++) {
      flame.update(1 / 60, car, true);
      flame.group.updateMatrixWorld(true);

      const along = new THREE.Vector3(1, 0, 0)
        .applyQuaternion(flame.group.getWorldQuaternion(new THREE.Quaternion()));
      worstAim = Math.min(worstAim, along.dot(new THREE.Vector3(-Math.cos(yaw), 0, Math.sin(yaw))));
      worstAnchor = Math.max(worstAnchor, flame.group.position.distanceTo(new THREE.Vector3(
        car.x - Math.cos(yaw) * TAXI_TAILPIPE_BACK,
        TAXI_TAILPIPE_HEIGHT,
        car.z + Math.sin(yaw) * TAXI_TAILPIPE_BACK,
      )));

      // Every vertex actually being drawn, through its own world matrix.
      const point = new THREE.Vector3();
      for (const mesh of flame.frames[flame.state.frame].children) {
        const pos = mesh.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          lowest = Math.min(lowest, point.fromBufferAttribute(pos, i)
            .applyMatrix4(mesh.matrixWorld).y);
        }
      }
    }
  }
  check('the plume comes out of the tailpipe, pointing back down the car\'s own axis',
    worstAim > 0.9999 && worstAnchor < 1e-9,
    `aim ${worstAim.toFixed(4)}, anchor off by ${worstAnchor.toExponential(1)}`);
  // The whole reason this is a cutout standing on the car's axis rather than a screen-plane
  // billboard: a billboard turned to the projected backward direction points down-screen at two of
  // the four headings and sinks ~0.87 units through a road only 0.74 below the pipe. This shape
  // can only ever reach down by its own half-width, and that margin is the number worth keeping.
  check('and never reaches through the road it is driving on', lowest > 0.05,
    `lowest ${lowest.toFixed(3)} above the tarmac (HALF_W is what buys this)`);

  // The flicker is a flipbook, so what it must actually do is *change frames* — a cycle that
  // stalled would leave one hand-shaped pose burning steadily, which is the look this replaced.
  const seen = new Set();
  const lengths = new Set();
  for (let step = 0; step < 60; step++) {
    flame.update(1 / 60, still, true);
    seen.add(flame.state.frame);
    lengths.add(flame.group.scale.x.toFixed(3));
  }
  check('the flame flickers rather than burning as one pose',
    seen.size === flame.frames.length && lengths.size > 40,
    `${seen.size} silhouettes, ${lengths.size} distinct lengths in a second`);

  // The envelope. Up almost at once — this answers a button press — and out inside the boost's own
  // one-second cooldown, rather than hanging on the bumper of a car that has stopped boosting.
  const litAt = (() => {
    const scene = new THREE.Scene();
    const fresh = createLocoFlame(scene);
    for (let step = 0; step < 60; step++) {
      fresh.update(1 / 60, still, true);
      if (fresh.group.visible && fresh.state.heat > 0.9) return (step + 1) / 60;
    }
    return Infinity;
  })();
  hold(still, 1, true);
  let outAt = Infinity;
  for (let step = 0; step < 120; step++) {
    flame.update(1 / 60, still, false);
    if (!flame.group.visible) { outAt = (step + 1) / 60; break; }
  }
  check('it lights on the press and is out before the boost cooldown is',
    litAt <= 0.1 && outAt < BOOST_COOLDOWN,
    `lit in ${litAt.toFixed(2)}s, out ${outAt.toFixed(2)}s after release`);

  // A wreck takes it with it. The taxi keeps whatever the player was holding at the moment of
  // impact — `boost.isActive()` is still true through the crash — so this is the flame's own bail,
  // the same one `traffic.taxi.boost` gets in main.js.
  hold(still, 1, true);
  hold({ ...still, crashed: true }, 1, true);
  check('a wrecked taxi stops burning', flame.group.visible === false && flame.state.heat === 0);
}

// --- The tyres that get away -------------------------------------------------
// Two per car bounce out of the wreck and roll off down the street. Everything about them is a
// closed-form curve of `age`, like the cones and unlike an integrated velocity, so the failure
// modes are arithmetic rather than drift — a hop walk that never terminates, a tyre sunk through
// the road, or a spin picked to look right rather than taken from the distance it covered, which
// is what separates a rolling wheel from a disc being spun and slid.
{
  const tScene = new THREE.Scene();
  const wreck = createBlast(tScene, makeRng(seed + 95));
  const HEADING = 0.6;
  // At boost speed, because that is the only way a wreck happens: the taxi's momentum is folded
  // into the tyres' launch (TYRE_CARRY) rather than carried beside it as a drift, and a tyre
  // thrown at rest would test a flight the game never produces.
  const IMPACT = 22.1;
  wreck.fire(0, 0, PALETTE.taxiBody, HEADING, IMPACT);
  wreck.fire(3, 1.5, PALETTE.carBody[1], HEADING, IMPACT);

  check('a wreck throws two tyres per car', wreck.tyreMesh.count >= 4);

  // Walk one tyre's whole flight through the same function the render pass uses. A check written
  // from a second copy of the formula would agree with a bug in the first.
  const at = new THREE.Vector3();
  const track = [];
  for (let step = 0; step <= 150; step++) {
    const age = step / 60;
    const travel = wreck.tyreAt(0, age, at);
    track.push({ age, travel, x: at.x, y: at.y, z: at.z });
  }

  // It bounces: several distinct arcs, each lower than the last, all of them above the road.
  const apexes = [];
  for (let i = 1; i < track.length - 1; i++) {
    if (track[i].y > track[i - 1].y && track[i].y >= track[i + 1].y) apexes.push(track[i].y);
  }
  const floor = Math.min(...track.map((p) => p.y));
  check('a thrown tyre bounces, in decreasing hops, and never through the road',
    apexes.length >= 2 && apexes[0] > apexes[1] && apexes[1] > floor + 0.05
    && floor >= WHEEL_R * Math.cos(0.14) - 1e-6,
    `hops ${apexes.map((a) => a.toFixed(2)).join(' → ')}, floor ${floor.toFixed(3)}`);

  // And then it is rolling: the hop walk is bounded, so the last stretch of the life sits flat on
  // the contact height rather than still subdividing parabolas.
  const settled = track.filter((p) => p.age > 1.6).every((p) => Math.abs(p.y - floor) < 1e-6);
  check('the hop walk terminates into a roll', settled);

  // Rolling without slipping — the spin the render pass writes is the distance over the radius,
  // and it is still turning when the tyre fades rather than having stopped and waited.
  const matrix = new THREE.Matrix4();
  wreck.update(1 / 60);
  wreck.tyreMesh.getMatrixAt(0, matrix);
  const spun = new THREE.Euler().setFromRotationMatrix(matrix, 'YXZ');
  const turns = track[track.length - 1].travel / WHEEL_R;
  check('the tyre rolls rather than sliding',
    Math.abs(spun.z - track[1].travel / WHEEL_R) < 1e-4 && turns > Math.PI * 2,
    `${(turns / (Math.PI * 2)).toFixed(1)} turns over ${track[track.length - 1].travel.toFixed(1)} units`);

  // It leaves the wreck, along the heading it was given rather than back up the road the taxi came
  // down, and it stays inside the framing the camera pulls into (WRECK_ZOOM 26 is a half-height of
  // 26 units, and a tyre off the top of that is a tyre nobody saw).
  //
  // The ceiling is what sizes TYRE_CARRY, so it is asserted rather than assumed: over 400 seeds the
  // furthest tyre at 2.5s is 18.9 units out with the impact carry against 12.4 without it. 22 is
  // that measurement plus a little room for the roll's own spread, and still four units inside the
  // frame.
  const end = track[track.length - 1];
  const away = (end.x * Math.cos(-HEADING) + end.z * Math.sin(-HEADING)) / Math.hypot(end.x, end.z);
  check('the tyre rolls away downfield and stays in frame',
    Math.hypot(end.x, end.z) > 4 && Math.hypot(end.x, end.z) < 22 && away > 0.3,
    `${Math.hypot(end.x, end.z).toFixed(1)} units out, ${away.toFixed(2)} of it downfield`);

  // The carry is spent on the tyre's own bearing rather than added beside it, which is what keeps
  // the roll slip-free above — so it can only show up as a *longer* flight along the same line, and
  // most of it goes to the tyre thrown most nearly downfield. Same seed, same fan, no impact.
  const restScene = new THREE.Scene();
  const atRest = createBlast(restScene, makeRng(seed + 95));
  atRest.fire(0, 0, PALETTE.taxiBody, HEADING);
  //
  // Measured from the tyre's *own* launch point rather than from the wreck's centre: `fire` jitters
  // each origin by up to 0.6, so a bearing taken from (0, 0) is a few degrees off the line the
  // tyre actually rolled and this check would fail against perfectly good arithmetic.
  const restAt = new THREE.Vector3();
  const origin = new THREE.Vector3();
  atRest.tyreAt(0, 0, origin);
  atRest.tyreAt(0, 2.5, restAt);
  const rolled = (p) => Math.hypot(p.x - origin.x, p.z - origin.z);
  const restBearing = Math.atan2(restAt.z - origin.z, restAt.x - origin.x);
  wreck.tyreAt(0, 2.5, at);
  check('the impact throws the tyres further down the same line',
    rolled(at) > rolled(restAt) + 1.5
    && Math.abs(Math.atan2(at.z - origin.z, at.x - origin.x) - restBearing) < 1e-6,
    `${rolled(restAt).toFixed(1)} → ${rolled(at).toFixed(1)} units `
    + `on bearing ${restBearing.toFixed(3)}`);

  // It fades rather than vanishing, and then it goes: an instance left at size is still a draw.
  const liveTyres = () => {
    const scale = new THREE.Vector3();
    let live = 0;
    for (let i = 0; i < wreck.tyreMesh.count; i++) {
      wreck.tyreMesh.getMatrixAt(i, matrix);
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      if (scale.x > 0) live += 1;
    }
    return live;
  };
  // Sampled every frame rather than probed at one time: a tyre's life is rolled per instance, so
  // any fixed instant is either inside or past it depending on the seed. The claim is about the
  // shape — full opacity, then a fade long enough to be a fade, then nothing.
  const alpha = wreck.tyreMesh.geometry.attributes.aAlpha.array;
  const opaque = alpha[0];
  let fadingFrames = 0;
  for (let step = 0; step < 60 * 4; step++) {
    wreck.update(1 / 60);
    if (alpha[0] > 0.03 && alpha[0] < 0.97) fadingFrames += 1;
  }
  check('the tyres fade out and the pool clears',
    opaque === 1 && fadingFrames > 20 && liveTyres() === 0 && wreck.active() === 0,
    `${fadingFrames} frames of fade, ${liveTyres()} left`);
}

// --- The wreck's smoke collar ----------------------------------------------
// `dust.wreckSmoke` rings the fireball with the same lit puffs a barricade throws. Its failure
// modes are all things a screenshot of the impact frame would forgive: a collar that fills in the
// middle (grey over the one part of the blast that is supposed to be fire), a tint left behind in
// the ring buffer for the boost trail to inherit, or smoke that dies with the flame it is meant to
// outlast.
{
  const sScene = new THREE.Scene();
  const smoke = createDust(sScene, null, makeRng(seed + 91));

  // Live puffs as (radius from the collar's centre, scale), read off the InstancedMesh — the
  // module writes positions in update(), not at spawn.
  const livePuffs = (d = smoke) => {
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    const position = new THREE.Vector3();
    const out = [];
    for (let i = 0; i < d.mesh.count; i++) {
      d.mesh.getMatrixAt(i, matrix);
      matrix.decompose(position, new THREE.Quaternion(), scale);
      if (scale.x > 0) out.push({ r: Math.hypot(position.x, position.z), y: position.y, s: scale.x });
    }
    return out;
  };

  smoke.wreckSmoke(0, 0);
  smoke.update(1 / 60);
  const opening = livePuffs();
  const radii = opening.map((p) => p.r).sort((a, b) => a - b);
  const outer = radii[radii.length - 1];
  const middle = radii[Math.floor(radii.length / 2)];
  const overTheCore = radii.filter((r) => r < 1.5).length;

  // blast.js throws its fireball PUFF_REACH 2.8 and draws it at PUFF_SIZE 3.2 on a 0.5-radius
  // icosahedron. The core — the pale-gold heart, the first puff of each fire() — barely travels,
  // so what the collar must not cover is the middle. Stated as a shape rather than as a hard floor
  // on the nearest puff: the start radius is rolled per puff so the collar is not a torus (a torus
  // reads as a smoke *ring* once the fire inside it goes out), so the claim is that the bulk of it
  // sits outside the core, not that no single puff ever strays in.
  check('the wreck collar opens around the fire rather than over it',
    opening.length === 24 && middle > 2.2 && outer < 6 && overTheCore <= 3,
    `${opening.length} puffs, median r ${middle.toFixed(2)}, out to ${outer.toFixed(2)}, `
    + `${overTheCore} over the core`);

  // And it is thrown outward from there — a collar that only grew in place would read as a lid.
  // On the medians rather than the extremes: one puff rolled to the far end of its start radius
  // makes `max` a statement about that puff rather than about the collar.
  for (let step = 0; step < 30; step++) smoke.update(1 / 60);
  const spread = livePuffs().map((p) => p.r).sort((a, b) => a - b);
  const spreadMiddle = spread[Math.floor(spread.length / 2)];
  check('the collar is pushed outward and billows up',
    spreadMiddle > middle * 1.4
    && Math.max(...livePuffs().map((p) => p.y)) > 1
    && Math.max(...livePuffs().map((p) => p.s)) > Math.max(...opening.map((p) => p.s)),
    `median r ${middle.toFixed(2)} → ${spreadMiddle.toFixed(2)}, out to `
    + `${spread[spread.length - 1].toFixed(2)}`);

  // It travels with the rest of the wreck. This one is a check about the *other* effects: the
  // fireball, the shards and both shells were taught to keep the taxi's momentum and this was the
  // last thing that had not been, so the crash slid downfield out of a grey ring left standing on
  // the impact point — which reads worse than nothing having moved, because a stationary thing in
  // frame is what the moving ones get measured against. Its own centre, so a collar that merely
  // opened wider does not pass.
  const cScene = new THREE.Scene();
  const carried = createDust(cScene, null, makeRng(seed + 91));
  const CARRY_HEADING = 0.6;
  carried.wreckSmoke(0, 0, CARRY_HEADING, 22.1);
  for (let step = 0; step < 40; step++) {
    carried.update(1 / 60);
    smoke.update(1 / 60);
  }
  // `livePuffs` above reports an unsigned radius, which cannot tell a collar that moved from one
  // that grew. This is the same walk projected onto the heading, and averaged: the throw is a
  // symmetric fan, so its mean sits on the collar's own centre and the drift is all that is left.
  const meanAlong = (d) => {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    let sum = 0;
    let n = 0;
    for (let i = 0; i < d.mesh.count; i++) {
      d.mesh.getMatrixAt(i, matrix);
      matrix.decompose(position, new THREE.Quaternion(), scale);
      if (scale.x <= 0) continue;
      sum += position.x * Math.cos(CARRY_HEADING) + position.z * -Math.sin(CARRY_HEADING);
      n += 1;
    }
    return n ? sum / n : 0;
  };
  const drifted = meanAlong(carried);
  check('the wreck collar travels with the wreck',
    drifted > 2 && drifted < 5 && Math.abs(meanAlong(smoke)) < 0.5,
    `${drifted.toFixed(2)} units downfield, ${meanAlong(smoke).toFixed(2)} at rest`);

  // It outlives the fire, and by enough to still be *visible* — a puff is at 4% opacity by the end
  // of its own life, so "one frame longer than the fireball" would be a check that passes on
  // nothing anyone can see. Measured against a real blast rather than a number copied out of
  // blast.js: the fireball is what has to be gone, not the shards, which fly on past it.
  const fire = createBlast(new THREE.Scene(), makeRng(seed + 92));
  const collar = createDust(new THREE.Scene(), null, makeRng(seed + 93));
  fire.fire(0, 0, PALETTE.taxiBody);
  collar.wreckSmoke(0, 0);
  const fireballUp = () => {
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    let live = 0;
    for (let i = 0; i < fire.puffMesh.count; i++) {
      fire.puffMesh.getMatrixAt(i, matrix);
      matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
      if (scale.x > 0) live += 1;
    }
    return live;
  };
  let flameOut = 0;
  let smokeLeft = 0;
  for (let step = 0; step < 60 * 5; step++) {
    fire.update(1 / 60);
    collar.update(1 / 60);
    if (!flameOut && fireballUp() === 0) {
      flameOut = step;
      smokeLeft = livePuffs(collar).filter((p) => p.s > 1).length;
    }
  }
  // And it goes, like everything else in this pool: an instance left at size is still a draw.
  check('the smoke outlasts the fire and then clears',
    flameOut > 0 && smokeLeft >= 12 && livePuffs(collar).length === 0,
    `flame out at ${(flameOut / 60).toFixed(2)}s with ${smokeLeft} puffs still up`);

  // The tint must not survive the slot. The pool is a ring buffer shared with the boost trail, so
  // a grey left on a slot comes back as one grey puff in a white plume half a lap later.
  const recycler = createDust(new THREE.Scene(), null, makeRng(seed + 94));
  recycler.wreckSmoke(0, 0);
  const greyed = new THREE.Color();
  recycler.mesh.getColorAt(0, greyed);
  // A full lap of the ring, measured off the pool rather than typed: MAX_PUFFS is private to
  // dust.js and has moved twice (90 → 140 → 200, the last of those when the boost trail became a
  // plume per rear wheel). A hard-coded lap length stops reaching slot 0 the moment it grows.
  for (let n = 0; n < recycler.mesh.count; n++) recycler.add(0, 0, 0);
  const reused = new THREE.Color();
  recycler.mesh.getColorAt(0, reused);
  check('a recycled collar slot goes back to white for the boost trail',
    greyed.getHexString() === new THREE.Color(PALETTE.wreckSmoke).getHexString()
    && reused.getHexString() === 'ffffff',
    `collar ${greyed.getHexString()}, after ${reused.getHexString()}`);
}

// --- Busted by the police --------------------------------------------------
// Boosting near an active police car ends the run with a distinct "Busted!" title. Mirrors the
// wiring in src/main.js: proximity < POLICE_BUST_RANGE while boosting → fares.crash('...',
// 'Busted!'). No wreck plume, so the check is about the state transition, not particle effects.
{
  const bScene = new THREE.Scene();
  const bTraffic = createTraffic(makeRng(seed + 44), bScene, CARS_DEFAULT);
  const bFares = createFareSystem(makeRng(seed + 55), bScene);
  const bPolice = createPolice(makeRng(seed + 66), bScene);
  const bTaxi = bTraffic.taxi;

  // Fast-forward to a live police run — the corridor logic drives when the car appears. Armed
  // rather than merely active: the bust does not exist until the cruiser is a block in from the
  // edge, so a test staged on `active` would sit next to a cop that cannot bust anyone.
  bPolice.state.cooldown = 0;
  for (let step = 0; step < 60 * 60 && !bPolice.state.armed; step++) {
    bPolice.update(1 / 60);
    bTraffic.update(1 / 60);
  }
  check('police run arms for the bust test', bPolice.state.armed);

  // Put the taxi within bust range of the cop, boost engaged.
  bTaxi.x = bPolice.group.position.x + 5;
  bTaxi.z = bPolice.group.position.z + 5;
  bTaxi.boost = true;

  const dx = bTaxi.x - bPolice.group.position.x;
  const dz = bTaxi.z - bPolice.group.position.z;
  const near = dx * dx + dz * dz < POLICE_BUST_RANGE * POLICE_BUST_RANGE;
  if (near && bTaxi.boost && bPolice.state.armed && !bFares.state.gameOver && !bTaxi.crashed) {
    bTaxi.crashed = true;
    bFares.crash("The fuzz caught you slippin'.", 'Busted!');
  }

  check('boosting near the police ends the run', bFares.state.gameOver);
  check('bust banner title is "Busted!"', bFares.state.failTitle === 'Busted!',
    bFares.state.failTitle);
  check('bust reason mentions the fuzz', /fuzz/i.test(bFares.state.failReason ?? ''),
    bFares.state.failReason);

  // Well outside bust range: same setup, no trigger.
  const fScene = new THREE.Scene();
  const fTraffic = createTraffic(makeRng(seed + 44), fScene, CARS_DEFAULT);
  const fFares = createFareSystem(makeRng(seed + 55), fScene);
  const fPolice = createPolice(makeRng(seed + 66), fScene);
  fPolice.state.cooldown = 0;
  for (let step = 0; step < 60 * 60 && !fPolice.state.armed; step++) {
    fPolice.update(1 / 60);
    fTraffic.update(1 / 60);
  }
  const fTaxi = fTraffic.taxi;
  fTaxi.x = fPolice.group.position.x + POLICE_BUST_RANGE + 20;
  fTaxi.z = fPolice.group.position.z;
  fTaxi.boost = true;
  const fdx = fTaxi.x - fPolice.group.position.x;
  const fdz = fTaxi.z - fPolice.group.position.z;
  const farClear = fdx * fdx + fdz * fdz > POLICE_BUST_RANGE * POLICE_BUST_RANGE;
  check('boosting far from the police leaves the run running', farClear && !fFares.state.gameOver);
}

// --- The bust is never lethal before it is readable -------------------------
// A cruiser arriving on the map used to be able to end a run before it had drawn a pixel: the bust
// radius is a block (20) and FADE_BAND is 18, so on the ring road the check fired at exactly zero
// opacity, lamps included. BUST_ARM_INSET gates the whole thing on the cruiser being a block in.
//
// The light bar runs ahead of that gate rather than with it, which is the grace period: the siren
// is up from the spawn frame and the bust arms a block in, so three invariants rather than two.
// Whatever can bust you is fully drawn and lit; nothing is lit between runs; and every run
// telegraphs itself for a beat first. The last one is the tuning, so it is measured in seconds and
// not merely asserted to be non-zero.
{
  const aScene = new THREE.Scene();
  const aPolice = createPolice(makeRng(seed + 66), aScene);
  const lamps = aPolice.group.children.filter((child) => child.isPointLight);

  let armedFrames = 0;
  let armedWhileFading = 0;      // lethal while still transparent — the bug
  let armedWithLampsDark = 0;    // lethal with no cue at all
  let litWhileIdle = 0;          // the opposite lie: a bar burning with no cruiser on the map
  let darkWhileVisible = 0;      // a drawn cruiser running dark — the announcement missed
  let ringExposed = 0;           // armed while the cruiser is still in the outer band
  let runs = 0;
  let wasActive = false;
  // Seconds of *visible* light bar before the bust arms, taken per run and kept at its worst.
  // FADE_BAND (18) out to the arming line (the rail's half-span − BUST_ARM_INSET) is 38 units at SPEED = 19,
  // so this should land near 2s.
  let telegraph = 0;
  let telegraphTaken = false;
  let worstTelegraph = Infinity;

  for (let step = 0; step < 600 * 60; step++) {
    aPolice.update(1 / 60);
    const p = aPolice.state;
    if (p.active && !wasActive) { runs += 1; telegraph = 0; telegraphTaken = false; }
    wasActive = p.active;

    const lit = lamps.some((lamp) => lamp.intensity > 0);
    if (!p.lit) {
      if (lit) litWhileIdle += 1;
      continue;
    }
    // Lit and drawing: the bar has to actually be burning. The frames before that are the car
    // still out past FADE_BAND, where the lamps are scaled to nothing along with the bodywork.
    if (p.fade > 0 && !lit) darkWhileVisible += 1;
    if (!p.armed) {
      if (p.fade > 0) telegraph += 1 / 60;
      continue;
    }
    if (!telegraphTaken) { worstTelegraph = Math.min(worstTelegraph, telegraph); telegraphTaken = true; }
    armedFrames += 1;
    if (p.fade < 1) armedWhileFading += 1;
    if (!lit) armedWithLampsDark += 1;
    if (Math.abs(p.s) > (p.axis === 'x' ? HALF_SPAN_X : HALF_SPAN_Z) - BUST_ARM_INSET) ringExposed += 1;
  }

  check('the police car runs corridors for the arming test', runs >= 5, `${runs} runs`);
  check('the bust is never armed while the cruiser is still fading in',
    armedWhileFading === 0, `${armedWhileFading} of ${armedFrames} armed frames`);
  check('an armed cruiser always has its light bar running',
    armedWithLampsDark === 0, `${armedWithLampsDark} of ${armedFrames} armed frames`);
  check('a cruiser that is drawing at all has its light bar running', darkWhileVisible === 0,
    `${darkWhileVisible} frames`);
  check('the light bar is dark between runs', litWhileIdle === 0, `${litWhileIdle} frames`);
  check('every run telegraphs itself before the bust arms', worstTelegraph >= 1.5,
    `${worstTelegraph.toFixed(2)}s of visible siren on the tightest run`);
  check('the bust never arms out in the outer band', ringExposed === 0, `${ringExposed} frames`);
}

// --- The off-screen police warning -----------------------------------------
// A cruiser one screen edge away is already inside POLICE_BUST_RANGE of anywhere on that edge, and
// until this existed the only cue it was out there was ambient traffic pulling over to a car the
// player could not see. game/sirenglow.js washes red and blue in over the edge it is coming from.
//
// The whole feature is a bearing and a strength, so it is checked as numbers here rather than
// looked at: the strength is what says "it is off-frame and how close", the bearing is what says
// "that way", and the strobe has to stay in step with the bar it stands in for.
{
  // The pure half first, against a phone-shaped frame. Nothing here needs a cruiser — these are the
  // properties the geometry has to have for any of them.
  const W = 390;
  const H = 844;
  const onEdge = (g) => Math.abs(g.x) < 1e-6 || Math.abs(g.x - W) < 1e-6
    || Math.abs(g.y) < 1e-6 || Math.abs(g.y - H) < 1e-6;

  check('a cruiser in the middle of the frame gets no wash',
    edgeGlow(W / 2, H / 2, W, H, 30) === null);
  check('and one merely near the edge still gets none',
    edgeGlow(W * 0.92, H / 2, W, H, 30) === null, 'q = 0.84, under FADE_ON');

  // Eight bearings, one per compass point plus the corners, all well outside the frame.
  const bearings = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  let offEdge = 0;
  let wrongWay = 0;
  let notFull = 0;
  for (const [ux, uz] of bearings) {
    const g = edgeGlow(W / 2 + ux * W, H / 2 + uz * H, W, H, 10);
    if (!g) { notFull += 1; continue; }
    if (!onEdge(g)) offEdge += 1;
    // Same side of the frame centre on both axes as the cruiser itself — the one thing the player
    // reads off it.
    if (Math.sign(g.x - W / 2) !== Math.sign(ux) || Math.sign(g.y - H / 2) !== Math.sign(uz)) {
      wrongWay += 1;
    }
    if (g.strength < 0.999) notFull += 1;
  }
  check('the wash sits on the frame edge, whichever way the cruiser is', offEdge === 0,
    `${offEdge} of ${bearings.length} off the edge`);
  check('and on the edge the cruiser is actually behind', wrongWay === 0, `${wrongWay} wrong`);
  check('a close cruiser well off-frame burns at full strength', notFull === 0, `${notFull} short`);

  // Distance is the second read: same bearing, further away, dimmer — down to a floor, because a
  // siren on the far side of the city is still worth knowing about.
  const near = edgeGlow(W * 2, H / 2, W, H, GLOW_NEAR);
  const mid = edgeGlow(W * 2, H / 2, W, H, (GLOW_NEAR + GLOW_FAR) / 2);
  const far = edgeGlow(W * 2, H / 2, W, H, GLOW_FAR * 2);
  check('the wash dims with distance', near.strength > mid.strength && mid.strength > far.strength,
    `${near.strength.toFixed(2)} → ${mid.strength.toFixed(2)} → ${far.strength.toFixed(2)}`);
  check('and never all the way out while the cruiser is armed',
    Math.abs(far.strength - GLOW_FLOOR) < 1e-9, `floor ${far.strength.toFixed(2)}`);

  // Now against a live corridor run, through the play camera. Two lies to rule out, and they are
  // the same pair the light bar is checked for above: a wash over a cruiser between runs (a
  // warning about a car that is not on the map) and no wash over a lit one that is off-frame (the
  // silence this exists to end). Gated on `lit` rather than `armed` because that is what the bar
  // does — the wash covers the grace period before the bust arms, same as the siren it stands in
  // for.
  const gScene = new THREE.Scene();
  const gPolice = createPolice(makeRng(seed + 66), gScene);
  const gCam = createCityCamera(W / H, { zoom: 46 });
  gCam.update(W / H);
  const taxiAt = { x: lineX(2), z: lineZ(2) };             // parked mid-map, so the camera is still
  const projected = new THREE.Vector3();

  let washedUnlit = 0;
  let silentOffFrame = 0;
  let washedOnFrame = 0;
  let offFrameFrames = 0;
  let litFrames = 0;
  for (let step = 0; step < 600 * 60; step++) {
    gPolice.update(1 / 60);
    const car = gPolice.group.position;
    projected.copy(car).project(gCam.camera);
    const sx = (projected.x * 0.5 + 0.5) * W;
    const sy = (-projected.y * 0.5 + 0.5) * H;
    // The composed rule, arming gate and all — the same call main.js makes every frame.
    const glow = sirenWash(
      gPolice.state, sx, sy, W, H, Math.hypot(taxiAt.x - car.x, taxiAt.z - car.z),
    );

    if (!gPolice.state.lit) {
      if (glow) washedUnlit += 1;
      continue;
    }
    litFrames += 1;
    // Comfortably inside the frame — the cruiser is there to be seen, so the wash has to be gone.
    const inside = sx > W * 0.1 && sx < W * 0.9 && sy > H * 0.1 && sy < H * 0.9;
    if (inside && glow) washedOnFrame += 1;
    // Comfortably outside it, by more than the fade band's own reach.
    const outside = sx < -W * 0.5 || sx > W * 1.5 || sy < -H * 0.5 || sy > H * 1.5;
    if (outside) {
      offFrameFrames += 1;
      if (!glow) silentOffFrame += 1;
    }
  }

  check('the police wash runs over a live corridor', litFrames > 0 && offFrameFrames > 0,
    `${litFrames} lit frames, ${offFrameFrames} of them off-frame`);
  check('nothing with a dark light bar lights the frame edge', washedUnlit === 0,
    `${washedUnlit} frames`);
  check('a lit cruiser off the frame always lights it', silentOffFrame === 0,
    `${silentOffFrame} of ${offFrameFrames} off-frame lit frames`);
  check('and the wash is gone once the cruiser is plainly on screen', washedOnFrame === 0,
    `${washedOnFrame} frames`);

  // The strobe is the cruiser's own, not a second clock — `sirenOn` is what both read. Over a
  // second each colour has to take the top several times, and neither may ever go fully dark:
  // a hard on/off alternation reads as flicker rather than as a siren.
  let redPeaks = 0;
  let bluePeaks = 0;
  let dark = 0;
  let huntDiffers = 0;
  // Parked far off the frame at close range, so the strength is a flat 1 and the only thing moving
  // is the strobe.
  const strobing = (flash, hunting) => sirenWash(
    { lit: true, flash, chasing: hunting, arrived: false }, W * 2, H / 2, W, H, GLOW_NEAR,
  );
  for (let f = 0; f < 120; f++) {
    const flash = f / 120;
    const wash = strobing(flash, false);
    if (wash.red > wash.blue) redPeaks += 1;
    if (wash.blue > wash.red) bluePeaks += 1;
    if (wash.red <= 0 || wash.blue <= 0) dark += 1;
    const hunt = strobing(flash, true);
    if ((hunt.red > hunt.blue) !== (wash.red > wash.blue)) huntDiffers += 1;
  }
  const held = strobing(0.5, false);
  check('the off half of the strobe holds the light bar\'s own low glow',
    Math.abs(Math.min(held.red, held.blue) - SIREN_DIM) < 1e-9
    && Math.abs(Math.max(held.red, held.blue) - 1) < 1e-9,
    `${SIREN_DIM.toFixed(3)} of the lit side`);
  check('the wash alternates red and blue', redPeaks > 20 && bluePeaks > 20,
    `${redPeaks} red / ${bluePeaks} blue frames of 120`);
  check('and neither half ever goes fully dark', dark === 0, `${dark} frames`);
  check('the strobe speeds up once the cruiser has locked on', huntDiffers > 0,
    `${huntDiffers} of 120 frames differ from the corridor rate`);
}

// --- The bust chase --------------------------------------------------------
// On the bust the cruiser breaks off its corridor run and hunts the (now frozen) taxi down. What
// has to hold: it gets there, it gets there inside the cinematic's time budget, and it stays on
// the road grid while doing it — the greedy router turns at junctions, so a bug there sends it
// across a block rather than merely somewhere unhelpful.
{
  // Distance from a point to the nearest road centreline, on whichever axis is closer. A car in
  // its lane sits LANE (2) off; a car cutting a corner is inside the junction box (HALF_ROAD = 4
  // either way). Anything much past 4 means it left the asphalt.
  const offRoad = (x, z) => {
    let dx = Infinity;
    let dz = Infinity;
    for (let i = 0; i <= GRID_I; i++) dx = Math.min(dx, Math.abs(x - lineX(i)));
    for (let j = 0; j <= GRID_J; j++) dz = Math.min(dz, Math.abs(z - lineZ(j)));
    return Math.min(dx, dz);
  };

  // Four quarries around the cruiser, spread over the envelope the bust can actually produce:
  // POLICE_BUST_RANGE is 20, one block, so nothing here is further out than that plus the width of
  // the taxi's own road. Offsets are relative to the cruiser's heading — `along` down its road,
  // `across` in whole blocks sideways — and always land on a lane of a real road.
  const cases = [
    { name: 'ahead on the same road', along: 18, across: 0 },
    { name: 'behind it (U-turn)', along: -18, across: 0 },
    { name: 'one road over', along: 0, across: 1 },
    { name: 'one road over and behind', along: -12, across: 1 },
  ];

  let slowest = 0;
  let worstGap = 0;
  let worstOffRoad = 0;
  let worstStep = 0;
  let worstYawRate = 0;
  let failed = null;
  let uturns = 0;
  let peakRoll = 0;
  let noseUp = 0;
  let noseDown = 0;
  let sunk = 0;
  let peakKick = 0;
  // Front wheels. The corridor run is a straight rail, so anything but a flat zero there means
  // the difference is picking up noise; the chase corners, weaves and U-turns, so it has to reach
  // a real lock. `rigLock` reads the angle back off the meshes rather than off the model.
  let corridorLock = 0;
  let chaseLock = 0;
  let rigLock = 0;
  // Only the steered wheels yaw; the light-bar boxes and the body sit at 0.
  const wheelLock = (p) => Math.max(...p.group.children.map((c) => Math.abs(c.rotation.y)));

  for (const kase of cases) {
    const cScene = new THREE.Scene();
    const cPolice = createPolice(makeRng(seed + 66), cScene);
    cPolice.state.cooldown = 0;
    // Run it up to mid-city so there is room on every side for the quarry.
    for (let step = 0; step < 60 * 90; step++) {
      cPolice.update(1 / 60);
      if (cPolice.state.active) corridorLock = Math.max(corridorLock, Math.abs(cPolice.state.wheelAngle));
      if (cPolice.state.active && Math.abs(cPolice.state.s) < PITCH) break;
    }
    if (!cPolice.state.active) { failed = `${kase.name}: no run to chase from`; break; }

    // Place the quarry relative to the cruiser's own heading. Sideways steps go toward the middle
    // of the map so the target road exists whichever line the run happened to pick.
    // `state.line` names a j while the rail runs along X and an i while it runs along Z, so
    // "toward the middle" is measured against that axis's own count.
    const lineTop = cPolice.state.axis === 'x' ? GRID_J : GRID_I;
    const inward = cPolice.state.line <= lineTop / 2 ? 1 : -1;
    const alongCoord = cPolice.state.s + cPolice.state.dir * kase.along;
    const crossLine = cPolice.state.line + kase.across * inward;
    const crossCoord = (cPolice.state.axis === 'x' ? lineZ(crossLine) : lineX(crossLine)) + LANE;
    const quarry = cPolice.state.axis === 'x'
      ? { x: alongCoord, z: crossCoord }
      : { x: crossCoord, z: alongCoord };

    const before = cPolice.state.dir;
    cPolice.chase(quarry);
    if (!cPolice.state.chasing) { failed = `${kase.name}: chase() did not engage`; break; }
    if (cPolice.state.dir !== before) uturns += 1;
    // Read before the first update: the kick has to be a step in speed on the frame it decides,
    // not something the accel ramp gets to a few frames later.
    peakKick = Math.max(peakKick, cPolice.state.v);

    let t = 0;
    let prev = { x: cPolice.group.position.x, z: cPolice.group.position.z, y: cPolice.group.rotation.y };
    while (!cPolice.state.arrived && t < 10) {
      cPolice.update(1 / 60);
      t += 1 / 60;
      const now = cPolice.group.position;
      worstOffRoad = Math.max(worstOffRoad, offRoad(now.x, now.z));
      // The rail underneath this car turns corners square and flips a whole road width on the
      // U-turn. Only the smoothing keeps that off the screen, so both the step and the yaw rate
      // are watched frame by frame — a snap that reaches the mesh is a visible teleport.
      worstStep = Math.max(worstStep, Math.hypot(now.x - prev.x, now.z - prev.z));
      // Shortest-arc difference: the U-turn sweep ends on uturnYaw0 + π, which can be a whole
      // turn away from the atan2 the next frame produces for the same heading. Identical on
      // screen, so the metric has to see it that way too.
      const raw = cPolice.group.rotation.y - prev.y;
      const dYaw = Math.abs(Math.atan2(Math.sin(raw), Math.cos(raw)));
      worstYawRate = Math.max(worstYawRate, dYaw);
      chaseLock = Math.max(chaseLock, Math.abs(cPolice.state.wheelAngle));
      rigLock = Math.max(rigLock, wheelLock(cPolice));
      prev = { x: now.x, z: now.z, y: cPolice.group.rotation.y };

      // Body: it should lean, rock both ways, and never drop an edge through the tarmac.
      peakRoll = Math.max(peakRoll, Math.abs(cPolice.group.rotation.x));
      noseUp = Math.max(noseUp, cPolice.group.rotation.z);
      noseDown = Math.min(noseDown, cPolice.group.rotation.z);
      if (now.y < ROAD_Y - 1e-6) sunk += 1;
    }
    if (!cPolice.state.arrived) { failed = `${kase.name}: never arrived`; break; }

    slowest = Math.max(slowest, t);
    worstGap = Math.max(worstGap, Math.hypot(
      cPolice.group.position.x - quarry.x, cPolice.group.position.z - quarry.z,
    ));

    if (getPriorityCorridor()) { failed = `${kase.name}: corridor still held after arrival`; break; }
  }

  check('the cruiser runs down the taxi from every side', failed === null, failed ?? '4 approaches');
  // The banner waits for the arrest, but only so long: BUST_BANNER_MAX at BUST_SLOW_MO_MIN works
  // out at ~4.2s of sim time (see main.js). A typical approach is ~2.2s; the worst measured is
  // seed 8888's, where a park closes the only direct road and the legal route runs 68 units.
  check('the chase lands before the banner stops waiting', slowest < 4.1,
    `slowest ${slowest.toFixed(2)}s`);
  check('it pulls up next to the taxi, not on top of it', worstGap > 2 && worstGap < 9,
    `widest final gap ${worstGap.toFixed(2)}`);
  check('the chase never leaves the road grid', worstOffRoad < 4.4,
    `furthest off a centreline ${worstOffRoad.toFixed(2)}`);
  check('a quarry behind the cruiser makes it swing round', uturns >= 1, `${uturns} U-turns`);
  // Both numbers are the caps in police.js showing through: the drawn step is bounded at
  // CHASE_SPEED * 1.2 per frame, and easing the nose at YAW_EASE spreads the rail's instant 90°
  // corner over ~0.35s — 13.3°/frame at the sharpest, measured across eight seeds. Unbounded, the
  // corner snap put them at 0.83 units and 79° in a single frame.
  //
  // Derived from CHASE_SPEED rather than written out, because that constant is pinned to the taxi's
  // overdrive ceiling and has now moved twice with it — a hardcoded 0.55 here just goes red for the
  // wrong reason the next time the ceiling does.
  const stepCap = (CHASE_SPEED * 1.2) / 60 + 0.03;
  check('the chase never teleports', worstStep < stepCap,
    `biggest step ${worstStep.toFixed(3)} units of ${stepCap.toFixed(2)}`);
  check('the nose never snaps round', worstYawRate < 0.28,
    `fastest yaw ${(worstYawRate * 180 / Math.PI).toFixed(1)}°/frame`);


  // The body language, which is what makes the chase read as aggressive rather than as a fast
  // machine tracking a line. Bounds are the caps in police.js: ROLL_LIMIT, and PITCH_LIMIT plus
  // the kickoff wheelie riding on top of it.
  check('the cruiser leans through what it throws the car at', peakRoll > 0.08 && peakRoll <= 0.34,
    `peak lean ${(peakRoll * 180 / Math.PI).toFixed(1)}°`);
  check('it squats and dives, both', noseUp > 0.02 && noseDown < -0.02,
    `pitch ${(noseDown * 180 / Math.PI).toFixed(1)}°..+${(noseUp * 180 / Math.PI).toFixed(1)}°`);
  check('no tilt puts a corner through the tarmac', sunk === 0, `${sunk} frames below road level`);
  // CHASE_KICK against the corridor cruise of 19: the lock-on is a step in speed, not a ramp.
  check('it plants the throttle on lock-on', peakKick > 24,
    `${peakKick.toFixed(1)} units/s on the deciding frame, up from 19`);

  // The cruiser runs the same steerToward() as every car in traffic.js, so what is checked here is
  // that it is wired to a heading that actually moves — a corridor run alone would pass any
  // implementation, including one that never turned the wheels at all.
  check('the cruiser holds its wheels straight down a corridor', corridorLock < 1e-6,
    `${(corridorLock * 180 / Math.PI).toFixed(1)}° peak on the rail`);
  check('the cruiser steers into the chase', chaseLock > 0.3 && Math.abs(rigLock - chaseLock) < 1e-9,
    `rig ${(rigLock * 180 / Math.PI).toFixed(0)}° vs model ${(chaseLock * 180 / Math.PI).toFixed(0)}°`);
}

// --- Traffic in the siren's own lane ----------------------------------------
//
// The cruiser has no collision response and never will — it is a scripted car on a rail, and
// giving it a queue would mean giving it the whole following-distance model. What it has instead
// is a two-sided manoeuvre: ambient traffic in its lane pulls over onto the kerb (PULLOVER_* in
// traffic.js) and the cruiser moves toward the centreline to get past (DODGE_* in police.js).
// Neither half is any use alone — 1.5 units of pull-over against two 1.7-wide bodies still
// overlaps — so what is asserted here is the *outcome*: bodies that do not occupy the same tarmac.
//
// Measured against the same run with both halves removed, over 199 corridor runs on 24 seeds:
// frames with the cruiser inside an ambient body fell from 1747 to 495, and the ones on open road
// — a cruiser ploughing down an arterial through a queue, which is what this is for — from 762 to
// 7. What is left is almost entirely cars mid-turn inside a junction box, the same category the
// collision model already leaves standing as a hazard the player can read.
{
  const DT = 1 / 60;
  // Where a building façade starts: the block begins at the kerb line and towers are inset 0.85
  // into their lot. A car shoved past this is a car parked in a lobby. The kerb line is per-road
  // since the arterials were widened, so this is measured as a *margin* to the wall beside the
  // car rather than as one distance from the centreline compared against one constant.
  const LOT_INSET = 0.85;

  const medians = medianRuns();
  /** Is a body of half-width `pad` centred at (x, z) over any planted median? */
  const overMedian = (x, z, pad) => medians.some((m) => x > m.x0 - pad && x < m.x1 + pad
    && z > m.z0 - pad && z < m.z1 + pad);

  let armedFrames = 0;
  let insideBody = 0;
  let insideDriving = 0;
  let furthestOut = 0;
  let wallGap = Infinity;
  // Nothing drives on a planted median. The one sanctioned exception is a boosting taxi mid-pass,
  // which crosses it by design (see PASS_LATERAL in sim/traffic.js) — everything else meeting one
  // is a bug in a lane offset or in the police dodge, and both are numbers that get tuned.
  let onMedian = 0;
  let pulledOver = 0;
  let peakDodge = 0;
  let peakWheel = 0;

  for (const s of [seed, seed + 1, seed + 2]) {
    const pScene = new THREE.Scene();
    const pTraffic = createTraffic(makeRng(s + 44), pScene, 30);
    const pPolice = createPolice(makeRng(s + 66), pScene, pTraffic.cars);
    pPolice.state.cooldown = 0;

    let t = 0;
    for (let step = 0; step < 60 * 100; step++) {
      t += DT;
      pPolice.update(DT);
      pTraffic.update(DT, t);
      if (!pPolice.state.armed) continue;
      armedFrames += 1;
      peakDodge = Math.max(peakDodge, pPolice.state.dodge);
      peakWheel = Math.max(peakWheel, Math.abs(pPolice.state.wheelAngle));

      const p = pPolice.group.position;
      const axis = pPolice.state.axis;
      if (overMedian(p.x, p.z, CAR_W / 2)) onMedian += 1;
      // The taxi is the exception, and only while it is actually out of its lane.
      const pt = pTraffic.taxi;
      if (pt && !pt.crashed && pt.passOffset < 0.01 && overMedian(pt.x, pt.z, CAR_W / 2)) {
        onMedian += 1;
      }
      for (const car of pTraffic.cars) {
        if (car.crashed || car.isTaxi) continue;
        if (car.pullover > 0.5) pulledOver += 1;
        // Both bodies sit square to the road on a corridor run, so overlap is two axis-aligned
        // boxes: touching along the road *and* across it at the same time.
        const halfW = (car.isTruck ? TRUCK_W : CAR_W) / 2 + CAR_W / 2;
        const alongGap = Math.abs(axis === 'x' ? car.x - p.x : car.z - p.z) - CAR_LEN;
        const acrossGap = Math.abs(axis === 'x' ? car.z - p.z : car.x - p.x) - halfW;
        if (alongGap < 0 && acrossGap < 0) {
          insideBody += 1;
          if (car.state === 'drive') insideDriving += 1;
        }
        // How far the pull-over throws a body off the road it is on. Only meaningful for a car
        // running a lane — mid-junction there is no one centreline to measure against.
        // Flank included for a car running a lane, where the body is square to the road; a car
        // mid-turn is tested on its centre alone, since a wheel over a kerb inside a junction box
        // is not what this is looking for.
        const pad = car.state === 'drive' ? CAR_W / 2 : 0;
        if (overMedian(car.x, car.z, pad)) onMedian += 1;

        if (car.state !== 'drive') continue;
        const line = (isXAxis(car.d) ? car.j : car.i);
        const half = isXAxis(car.d) ? halfRoadX(line) : halfRoadZ(line);
        const off = isXAxis(car.d)
          ? Math.abs(car.z - lineZ(line))
          : Math.abs(car.x - lineX(line));
        const edge = off + CAR_W / 2;
        furthestOut = Math.max(furthestOut, edge);
        wallGap = Math.min(wallGap, half + LOT_INSET - edge);
      }
    }
  }

  check('traffic gets out of the siren\'s way', pulledOver > 50,
    `${pulledOver} car-frames pulled over across ${armedFrames} armed frames`);
  check('the cruiser moves over to get past', peakDodge > 1 && peakWheel > 0.02,
    `${peakDodge.toFixed(2)} units off the lane centre, wheels to ${(peakWheel * 180 / Math.PI).toFixed(1)}°`);
  // The one that matters: on open road the cruiser no longer drives through anybody. Bounded
  // rather than pinned at zero because a car can still be part-way through releasing its
  // pull-over as the cruiser arrives. Same sample with both halves removed: 54.
  check('it stops driving through the cars in its lane', insideDriving <= 20,
    `${insideDriving} frames inside a driving body`);
  // Everything, junction boxes included. 62 frames (3.28%) on this sample before the manoeuvre.
  //
  // Widened from 2% to 4%, and it is worth saying why rather than letting it look like drift. The
  // car-following rule changed (see "a moving leader is not a wall" in docs/traffic.md): cars used
  // to hang back at a *stopping* distance from cars that were driving away from them, and now sit
  // at the follow gap the docs always claimed. Traffic is genuinely denser as a result, so the
  // cruiser meets more bodies — and the ones it meets are in junction boxes, where its dodge is a
  // lane manoeuvre with no centreline to move off. Measured across five city seeds: 1.06, 1.42,
  // 0.00, 0.49, 1.59% before that change and 2.38, 1.10, 1.25, 3.25, 1.06% after.
  //
  // The property this pair exists to protect is the check *above*, which is unaffected: `0 frames
  // inside a driving body` on every one of those five seeds, against a bar of 20 and a pre-fix
  // sample of 54. This one is the loose companion — "mostly", in its own name — so it is the one
  // that gives, and it still fails on the 3.28% the manoeuvre was built to fix.
  check('and mostly stops driving through anyone at all', insideBody < armedFrames * 0.04,
    `${insideBody} frames (${(100 * insideBody / armedFrames).toFixed(2)}% of armed)`);
  // The pull-over and the panic shove take the larger of the two rather than adding, precisely so
  // this holds — summed they reach 5.17 and put a wing through a wall.
  // Vacuously true on a city with no arterials, so the run count is asserted beside it.
  check('nothing but a passing taxi drives on a median',
    onMedian === 0 && medians.length > 0,
    `${onMedian} body-frames over one of ${medians.length} islands`);
  check('nobody gets shoved into a building', wallGap > 0,
    `closest body edge came within ${wallGap.toFixed(2)} of a façade, furthest `
    + `${furthestOut.toFixed(2)} from a centreline`);
}

// --- The cruiser and a dug-up street ----------------------------------------
//
// A roadworks closure is soft — two lane ids in a set, nothing removed from the network — so
// nothing stops a car that does not check it, and the police car was exactly that car. It checks
// twice now: once when it draws a corridor line, and again at every junction of a chase.
{
  setClosedLanes([]);
  const dScene = new THREE.Scene();
  const dTraffic = createTraffic(makeRng(seed + 310), dScene, 12);
  for (let step = 0; step < 300; step++) dTraffic.update(1 / 60);
  const dWork = createRoadwork(makeRng(seed + 311), dScene, null);
  const staged = dWork.place(dTraffic.taxi, dTraffic.cars, []);

  const net = cityNetwork();
  const dug = dWork.closedLaneIds.map((id) => net.laneById.get(id));
  const ends = [net.nodeById.get(dug[0].from), net.nodeById.get(dug[0].to)];
  // The line the zone sits on, in the grid terms the cruiser draws its corridor in.
  const dugAxis = ends[0].gj === ends[1].gj ? 'x' : 'z';
  const dugLine = dugAxis === 'x' ? ends[0].gj : ends[0].gi;

  let draws = 0;
  let onTheZone = 0;
  const dPolice = createPolice(makeRng(seed + 66), dScene, dTraffic.cars);
  let wasActive = false;
  for (let step = 0; step < 60 * 600 && draws < 40; step++) {
    dPolice.state.cooldown = Math.min(dPolice.state.cooldown, 0.5);
    dPolice.update(1 / 60);
    if (dPolice.state.active && !wasActive) {
      draws += 1;
      if (dPolice.state.axis === dugAxis && dPolice.state.line === dugLine) onTheZone += 1;
    }
    wasActive = dPolice.state.active;
  }

  check('a zone stands somewhere for the cruiser to avoid', staged && dug.length === 2,
    staged ? `${dugAxis} line ${dugLine}` : 'no candidate');
  // 6 of 40 before the check went in — one road in twelve, drawn uniformly, is about right.
  check('a corridor never runs down a dug-up street', onTheZone === 0,
    `${draws} draws, ${onTheZone} down the closed line`);

  // And the chase, which picks its road a junction at a time and so has to ask again each time.
  // The quarry is planted on the far side of the zone from the cruiser, which is the case that
  // used to send it straight through the barricades: the greedy Manhattan score points at the
  // closed segment because that is the shortest way there.
  let throughTheZone = 0;
  let chases = 0;
  for (let k = 0; k < 4; k++) {
    const cScene = new THREE.Scene();
    const cPolice = createPolice(makeRng(seed + 66 + k), cScene, []);
    cPolice.state.cooldown = 0;
    for (let step = 0; step < 60 * 120; step++) {
      cPolice.update(1 / 60);
      if (cPolice.state.active && Math.abs(cPolice.state.s) < PITCH) break;
    }
    if (!cPolice.state.active) continue;
    chases += 1;
    // Just past the far end of the closed segment, measured from whichever end the cruiser is
    // further from — so the direct line to the quarry runs the length of the zone.
    const from = cPolice.group.position;
    const far = Math.hypot(ends[0].x - from.x, ends[0].z - from.z)
      > Math.hypot(ends[1].x - from.x, ends[1].z - from.z) ? ends[0] : ends[1];
    cPolice.chase({ x: far.x, z: far.z });
    for (let step = 0; step < 60 * 12 && !cPolice.state.arrived; step++) {
      cPolice.update(1 / 60);
      const p = cPolice.group.position;
      // Inside the closed segment: on its road, and past the junction box at either end. The
      // boxes are excluded because reaching the quarry means entering the one it is standing in,
      // and because the chase cuts its corners on about a lane radius (CHASE_SMOOTH), which puts
      // the drawn car a couple of units into the far side of a junction it is turning through.
      const onRoad = dugAxis === 'x'
        ? Math.abs(p.z - ends[0].z) < ROAD_W / 2
        : Math.abs(p.x - ends[0].x) < ROAD_W / 2;
      const between = dugAxis === 'x'
        ? p.x > Math.min(ends[0].x, ends[1].x) + ROAD_W / 2 && p.x < Math.max(ends[0].x, ends[1].x) - ROAD_W / 2
        : p.z > Math.min(ends[0].z, ends[1].z) + ROAD_W / 2 && p.z < Math.max(ends[0].z, ends[1].z) - ROAD_W / 2;
      if (onRoad && between) throughTheZone += 1;
    }
  }
  // 90 frames straight through the hole before turnAt learned to ask — 1.5 seconds of cruiser
  // inside a closed street, which is what this looked like.
  check('a chase routes around the barricades', chases > 0 && throughTheZone === 0,
    `${chases} chases, ${throughTheZone} frames inside the closure`);
  setClosedLanes([]);
}

// --- The pan gesture, and the opening follow-cam it hands off from ----------
// A run opens with the camera trailing the taxi and stops the moment the player swipes, so the
// whole handover hangs on `attachDragPan` deciding a press *became* a drag — the same 8px boundary
// that decides tap-versus-pan. Both halves are silent when wrong: a slop that fires too eagerly
// takes the camera off the taxi on the finger travel of an ordinary tap, and one that never fires
// leaves the follow towing the map back off wherever the player just swiped to.
//
// This runs on a stub element rather than a DOM, which is enough: attachDragPan only ever calls
// addEventListener, setPointerCapture and clientHeight on it.
{
  const listeners = new Map();
  const el = {
    clientHeight: 800,
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  };
  const fire = (type, x, y) => {
    for (const fn of listeners.get(type) ?? []) fn({ isPrimary: true, pointerId: 1, clientX: x, clientY: y });
  };

  const cam = createCityCamera(1.5, { zoom: 52 });
  let released = 0;
  const dragPan = attachDragPan(cam, el, () => 1.5, () => true, () => { released += 1; });

  // A tap with a few pixels of finger travel: still a tap. Nothing moves, and the follow-cam keeps
  // the taxi — this is the case that made a fixed camera necessary in the first place.
  const before = cam.state.target.clone();
  fire('pointerdown', 400, 300);
  fire('pointermove', 402, 301);
  fire('pointermove', 403, 302);
  fire('pointerup', 403, 302);
  check('a tap leaves the camera alone', released === 0 && !dragPan.didPan()
    && cam.state.target.equals(before), `${released} releases`);

  // A real swipe: the map moves and the player owns the framing from here.
  fire('pointerdown', 400, 300);
  fire('pointermove', 430, 340);
  fire('pointermove', 470, 380);
  fire('pointerup', 470, 380);
  check('a swipe hands the camera to the player', released === 1 && dragPan.didPan()
    && !cam.state.target.equals(before), `${released} releases`);
  // Once per gesture, not once per move event — the callback is what a run's opening follow-cam is
  // switched off by, and a second one arriving mid-drag would be a bug hidden by idempotence.
  fire('pointerdown', 400, 300);
  fire('pointermove', 460, 360);
  fire('pointermove', 480, 380);
  fire('pointerup', 480, 380);
  check('each swipe reports once', released === 2, `${released} releases over 2 swipes`);

  // --- The rider pan ---------------------------------------------------------
  // A tap on a rider-finder chip pans the camera to that rider instead of cutting to them. All of
  // this is invisible in a screenshot — a pan and a snap render identically once they've landed —
  // and the failure mode is a curve that technically arrives while reading as a teleport, so the
  // shape of the move is what gets asserted, not just the destination.
  const STEP = 1 / 60;

  // Eased *in*, which is the whole reason this isn't the follow-cams' exponential smoothing: that
  // leaves at full speed on frame one. Over a 40-unit pan the first frame must be a small
  // fraction of the linear step, and the move must still finish on time.
  cam.cancelGlide();
  cam.state.target.set(0, 0, 0);
  cam.glideTo(40, 0);
  const firstFrame = (cam.updateGlide(STEP, 1.5), cam.state.target.x);
  const linearStep = 40 * (STEP / 0.32);   // 40 units is under the floor, so it runs at min time
  check('the rider pan eases in rather than leaving at full speed',
    firstFrame > 0 && firstFrame < linearStep * 0.1,
    `${firstFrame.toFixed(4)} units on frame 1 vs ${linearStep.toFixed(3)} linear`);

  // It arrives exactly and retires itself. Retiring on the clock rather than on the distance left
  // is what keeps the flat tail of the smootherstep — cutting it early throws away the gentlest
  // part of the move, and "close enough" is invisible in the browser.
  let frames = 1;
  while (cam.updateGlide(STEP, 1.5)) frames += 1;
  check('the rider pan lands on its target and retires itself',
    !cam.isGliding() && Math.abs(cam.state.target.x - 40) < 1e-9 && Math.abs(cam.state.target.z) < 1e-9,
    `${frames} frames, landed at x=${cam.state.target.x.toFixed(6)}`);
  check('a short pan runs at the floor, not shorter', frames >= 19 && frames <= 21,
    `${frames} frames = ${(frames * STEP).toFixed(3)}s against a 0.32s floor`);

  // Duration scales with distance between the clamps, and stops scaling at the ceiling. Without
  // the ceiling a cross-town pan is the player watching the camera with a fare's clock draining;
  // without the floor a hop to the next block is a snap again.
  const durationOf = (from, to) => {
    cam.cancelGlide();
    cam.state.target.set(from[0], 0, from[1]);
    cam.glideTo(to[0], to[1]);
    let n = 0;
    while (cam.updateGlide(STEP, 1.5)) n += 1;
    return n * STEP;   // over by up to a frame, since the last step is clamped to the duration
  };
  // 75 units at 150 u/s = 0.5s, clear of both clamps. Laid out across the middle of the map
  // rather than out from the origin, since glideTo clamps its destination to the map's half-span.
  const mid = durationOf([-40, 0], [35, 0]);
  // Corner to corner: 141 units, well past the 112 the 0.75s ceiling buys — and the longest pan
  // the map can ask for, since glideTo clamps its destination to the map's half-span.
  const far = durationOf([-HALF_SPAN_X, -HALF_SPAN_Z], [HALF_SPAN_X, HALF_SPAN_Z]);
  check('pan duration scales with distance', mid >= 0.5 && mid <= 0.5 + 2 * STEP,
    `${mid.toFixed(3)}s for 75 units`);
  check('pan duration is capped', far >= 0.75 && far <= 0.75 + 2 * STEP,
    `${far.toFixed(3)}s across the city diagonal, against a 0.75s ceiling`);

  // The target is clamped like every other camera move, so a pan can't push the map off screen.
  cam.cancelGlide();
  cam.state.target.set(0, 0, 0);
  cam.glideTo(HALF_SPAN_X * 3, 0);
  while (cam.updateGlide(STEP, 1.5)) { /* run it out */ }
  check('a rider pan clamps to the map like a drag does',
    Math.abs(cam.state.target.x - HALF_SPAN_X) < 1e-9, `landed at x=${cam.state.target.x.toFixed(2)}`);

  // A finger on the map wins immediately. A tween still writing the target every frame would drag
  // the city back out from under the drag that interrupted it.
  cam.cancelGlide();
  cam.state.target.set(0, 0, 0);
  cam.glideTo(40, 0);
  cam.updateGlide(STEP, 1.5);
  fire('pointerdown', 400, 300);
  fire('pointermove', 440, 350);
  fire('pointerup', 440, 350);
  const afterDrag = cam.state.target.clone();
  const stillPanning = cam.updateGlide(STEP, 1.5);
  check('a drag kills a pan in flight',
    !stillPanning && !cam.isGliding() && cam.state.target.equals(afterDrag),
    stillPanning ? 'the pan kept writing the target' : 'ok');

  // Same for the follow-cams: a boost chase or a wreck focus starting mid-pan takes the camera
  // over, rather than the two easing the target to different places on alternate frames.
  cam.cancelGlide();
  cam.glideTo(-40, 40);
  cam.updateGlide(STEP, 1.5);
  cam.followXZ(0, 0, STEP, 3.2, 1.5);
  check('a follow outranks a pan in flight', !cam.isGliding(), 'the pan survived a followXZ');
  cam.glideTo(-40, 40);
  cam.updateGlide(STEP, 1.5);
  cam.focusOn(0, 0, 30, STEP, 1.5);
  check('a wreck focus outranks a pan in flight', !cam.isGliding(), 'the pan survived a focusOn');

  // Re-basing on a redirect: a second chip tapped mid-flight has to pick up from where the camera
  // actually is, or the pan jumps back to the first tap's start point before setting off again.
  cam.cancelGlide();
  cam.state.target.set(0, 0, 0);
  cam.glideTo(60, 0);
  for (let i = 0; i < 10; i++) cam.updateGlide(STEP, 1.5);
  const midFlight = cam.state.target.x;
  cam.glideTo(0, 60);
  const beforeRedirect = cam.state.target.x;
  cam.updateGlide(STEP, 1.5);
  check('a redirect mid-pan continues from where the camera is',
    midFlight > 0.1 && beforeRedirect === midFlight
    && Math.abs(cam.state.target.x - midFlight) < midFlight * 0.02,
    `redirected from x=${midFlight.toFixed(3)}`);

  // --- The peek, and the ride home ------------------------------------------
  // A chip tap doesn't just pan to the rider, it comes back: out, a beat on the kerb, then home to
  // a taxi that has been driving the whole time. Every one of the three legs is invisible in a
  // still — the failure mode is a camera that arrives and never returns, which looks exactly like
  // the pan working — so the sequence is walked frame by frame here.
  //
  // The taxi is a stand-in that drives a straight line at a plausible speed (the shipped SPEED is
  // 8.5 u/s), because what is being asserted is that the return leg *tracks* rather than that it
  // arrives at any particular corner.
  const peekTo = { x: 40, z: 0 };
  const car = { x: -20, z: -20 };
  const driveCar = (dt) => { car.x += 8.5 * dt; };

  let arrived = 0;
  cam.cancelGlide();
  cam.state.target.set(car.x, 0, car.z);
  cam.peekAt(peekTo.x, peekTo.z, () => car, () => { arrived += 1; });

  // Leg 1: out to the rider. Runs until the target stops moving. The taxi is driven *before* the
  // camera on every frame, the order main.js steps them in — so what the return leg reads is the
  // position the car has this frame, not last frame's.
  let outFrames = 0;
  let last = cam.state.target.clone();
  do {
    last = cam.state.target.clone();
    driveCar(STEP);
    cam.updateGlide(STEP, 1.5);
    outFrames += 1;
  } while (!cam.state.target.equals(last) && outFrames < 600);
  check('a peek pans out to the rider first',
    Math.abs(cam.state.target.x - peekTo.x) < 1e-9 && Math.abs(cam.state.target.z - peekTo.z) < 1e-9
    && arrived === 0,
    `landed at x=${cam.state.target.x.toFixed(3)} after ${outFrames} frames`);

  // Leg 2: the beat. The camera has to sit dead still on the rider — long enough to read the kerb,
  // and not so long that the player is watching a corner while their fare's clock drains.
  const heldAt = cam.state.target.clone();
  let holdFrames = 0;
  while (cam.state.target.equals(heldAt) && holdFrames < 600) {
    driveCar(STEP);
    cam.updateGlide(STEP, 1.5);
    holdFrames += 1;
  }
  // Good to a frame or so either side: the legs are being detected by the target moving, so the
  // first stationary frame fell to the loop above and the last one is the frame that armed the
  // ride home. The band below is wide enough not to care.
  const held = holdFrames * STEP;
  check('a peek holds the rider in frame for about a second', held > 0.5 && held < 1.5,
    `held ${held.toFixed(2)}s`);
  check('the peek is still driving the camera through the hold', cam.isGliding() && arrived === 0,
    arrived ? 'it reported arriving before it came back' : 'the glide retired during the hold');

  // Leg 3: home, onto a car that has not stopped moving.
  let backFrames = 0;
  while (cam.isGliding() && backFrames < 600) {
    driveCar(STEP);
    cam.updateGlide(STEP, 1.5);
    backFrames += 1;
  }
  // Exactly on it, not near it: the last frame's ease is 1, so the target it landed on is the one
  // the tracker read this frame. A leg that aimed once when it set off would be out by the ~5 units
  // the car covered while it travelled.
  const miss = Math.hypot(cam.state.target.x - car.x, cam.state.target.z - car.z);
  check('a peek rides home onto the moving taxi', miss < 1e-9 && arrived === 1,
    `${miss.toFixed(6)} units off after ${backFrames} frames, ${arrived} arrivals`);

  // ...and having arrived, it is over. A peek that kept writing the target would fight the follow
  // it just handed the framing to.
  cam.updateGlide(STEP, 1.5);
  check('a peek retires once it is home', !cam.isGliding() && arrived === 1, `${arrived} arrivals`);

  // The arrival callback is main.js's evidence that the camera is back on the car — it clears
  // `cameraTakenOver` on it. Anything that outranks a pan has to drop the peek *without* firing it,
  // or a swipe away mid-peek hands the framing back to the follow-cam and tows the map off it.
  const droppedBy = (steal) => {
    arrived = 0;
    cam.cancelGlide();
    cam.state.target.set(car.x, 0, car.z);
    cam.peekAt(peekTo.x, peekTo.z, () => car, () => { arrived += 1; });
    cam.updateGlide(STEP, 1.5);
    steal();
    for (let i = 0; i < 400; i++) cam.updateGlide(STEP, 1.5);
    return !cam.isGliding() && arrived === 0;
  };
  check('a drag mid-peek cancels the ride home', droppedBy(() => {
    fire('pointerdown', 400, 300);
    fire('pointermove', 440, 350);
    fire('pointerup', 440, 350);
  }), 'the peek survived a drag, or reported arriving anyway');
  check('a boost chase mid-peek cancels the ride home',
    droppedBy(() => cam.followXZ(0, 0, STEP, 3.2, 1.5)),
    'the peek survived a followXZ, or reported arriving anyway');
  check('a wreck focus mid-peek cancels the ride home',
    droppedBy(() => cam.focusOn(0, 0, 30, STEP, 1.5)),
    'the peek survived a focusOn, or reported arriving anyway');

  // A peek fired while the camera is already standing on the rider still holds the beat and still
  // comes home — the pan out is what's redundant there, not the trip back. (glideTo's own epsilon
  // case retires immediately, which is why this needs asserting separately.)
  arrived = 0;
  cam.cancelGlide();
  cam.state.target.set(peekTo.x, 0, peekTo.z);
  cam.peekAt(peekTo.x, peekTo.z, () => car, () => { arrived += 1; });
  let zeroLength = 0;
  while (cam.isGliding() && zeroLength < 600) { cam.updateGlide(STEP, 1.5); zeroLength += 1; }
  check('a peek from on top of the rider still comes home',
    arrived === 1 && Math.hypot(cam.state.target.x - car.x, cam.state.target.z - car.z) < 1e-9,
    `${arrived} arrivals after ${zeroLength} frames`);

  // --- The ride back to the taxi --------------------------------------------
  // The taxi-finder chip's whole camera move: a peek's homeward leg on its own, with no trip out.
  // It shares `armChase` with the peek, so what is worth asserting separately is that it is a
  // *ride* and not a cut — the one thing a player would notice going wrong, and the one thing a
  // still frame cannot show — and that it still lands on a car that never stopped driving.
  arrived = 0;
  car.x = -20;
  car.z = -20;
  cam.cancelGlide();
  cam.state.target.set(40, 0, 40);
  cam.chaseTo(() => car, () => { arrived += 1; });
  const chaseStart = cam.state.target.clone();
  driveCar(STEP);
  cam.updateGlide(STEP, 1.5);
  const chaseFirst = chaseStart.distanceTo(cam.state.target);
  // Same ease-in as every other pan here: the first frame is a small fraction of the linear step,
  // rather than the camera leaving at full speed and reading as most of a snap.
  const chaseLinear = chaseStart.distanceTo(new THREE.Vector3(car.x, 0, car.z)) * (STEP / 0.75);
  check('the ride back to the taxi eases in rather than cutting',
    chaseFirst > 0 && chaseFirst < chaseLinear * 0.1 && arrived === 0,
    `${chaseFirst.toFixed(4)} units on frame 1 vs ${chaseLinear.toFixed(3)} linear`);

  let chaseFrames = 1;
  while (cam.isGliding() && chaseFrames < 600) {
    driveCar(STEP);
    cam.updateGlide(STEP, 1.5);
    chaseFrames += 1;
  }
  // Exactly on the car, not near it: the aim is re-read every frame, so the ~5 units it covers
  // during the move are already paid for when the camera stops. That is what lets main.js hand the
  // framing straight to the follow-cam on arrival with no gap to close.
  const chaseMiss = Math.hypot(cam.state.target.x - car.x, cam.state.target.z - car.z);
  check('the ride back lands on the moving taxi and reports it',
    chaseMiss < 1e-9 && arrived === 1 && !cam.isGliding(),
    `${chaseMiss.toFixed(6)} units off after ${chaseFrames} frames, ${arrived} arrivals`);

  // And it is dropped like any other pan. The chip's own arrival is what clears `cameraTakenOver`,
  // so a swipe away mid-ride firing it anyway would hand the framing back to a follow-cam the
  // player has just taken it from.
  arrived = 0;
  cam.cancelGlide();
  cam.state.target.set(40, 0, 40);
  cam.chaseTo(() => car, () => { arrived += 1; });
  cam.updateGlide(STEP, 1.5);
  fire('pointerdown', 400, 300);
  fire('pointermove', 440, 350);
  fire('pointerup', 440, 350);
  for (let i = 0; i < 400; i++) cam.updateGlide(STEP, 1.5);
  check('a drag mid-ride cancels the trip back to the taxi',
    !cam.isGliding() && arrived === 0,
    'the ride survived a drag, or reported arriving anyway');
}

// --- Is the taxi off screen? ------------------------------------------------
// The test the taxi-finder chip is armed off (game/taxifinder.js). Its whole job is a boundary, and
// both ways of getting a boundary wrong are invisible in the browser until they are annoying: too
// eager and the chip offers to find a car the player can see, too shy and it never comes up at all.
// The hysteresis is the part that cannot be eyeballed — the symptom is a chip that blinks while the
// taxi tracks the frame edge, which is exactly the situation it exists for.
{
  const W = 390;
  const H = 844;
  const R = 22;                    // the car's on-screen radius at play zoom, near enough
  const SLACK = 14;                // taxifinder.js's EDGE_SLACK, restated so a change there fails here
  const at = (x, y, wasOff = false) => isCarOffScreen(x, y, R, W, H, wasOff);

  check('a taxi in the middle of the frame is not off screen', !at(W / 2, H / 2));
  // Every edge, since a sign slip on one axis leaves the other three working.
  check('a taxi well past each edge is off screen',
    at(-200, H / 2) && at(W + 200, H / 2) && at(W / 2, -200) && at(W / 2, H + 200));
  // Half a car showing is still a car you can see. This is the case that separates "completely off
  // screen" from "mostly off screen", and it is the one the feature was asked for in those words.
  check('a taxi half off the edge is not off screen', !at(-R / 2, H / 2) && !at(W + R / 2, H / 2));
  // Just clear of the frame, but inside the slack: not yet, or the chip appears on the frame the
  // last pixel leaves and takes itself down again on the next.
  check('a taxi just clear of the edge waits out the slack', !at(-R - SLACK / 2, H / 2));
  check('a taxi clear of the edge by the slack is off screen', !!at(-R - SLACK - 1, H / 2));

  // The band itself: once it is up, the chip stays up until a pixel of car is genuinely back in
  // frame — which is the asymmetry that stops the boundary flickering.
  const inBand = -R - SLACK / 2;
  check('the edge test is hysteretic', !at(inBand, H / 2, false) && at(inBand, H / 2, true),
    `${SLACK}px band outside the frame`);
  check('a pixel of car back in frame takes the chip down again',
    !at(-R + 1, H / 2, true), 'still reported off screen with the car overlapping the edge');

  // The corners, where both axes are outside at once — a car can be diagonally clear of the frame
  // without being past either edge by much.
  check('a taxi off a corner is off screen', !!at(-R - SLACK - 1, -R - SLACK - 1));
}

// --- The follow lead: framing the road ahead --------------------------------
// Both follows aim past the taxi so the direction it is driving gets the frame, and the whole claim
// is a *screen* one — the car sits LEAD_FRACTION of a half-frame into the quadrant behind it,
// whichever way it is pointed. Nothing about that is checkable by eye: a lead that quietly collapses
// to a third of itself going one way still looks like a chase camera, and the two failures this is
// really guarding — forgetting the view's 33° foreshortening, and forgetting the follow's own trail
// — are both invisible on a desktop, which is where they'd be looked at.
//
// So the framing is measured by projecting the taxi through a real frustum, at a real portrait
// aspect, after driving it far enough for both eases to settle.
{
  const LEAD_FRACTION = 0.425;    // camera.js's, restated so a change there fails here
  const ASPECT = 390 / 844;       // an iPhone in portrait — the viewport the follows run on
  const ZOOM = 52;
  const BOOST_TOP = boostCruise();  // what `gain` is measured against
  const STEP = 1 / 60;

  // The taxi is pinned at the origin and the world is slid under it. followXZ clamps its target to
  // the map's half-span, which is the city edge and correctly eats the lead when you drive at it — but that
  // is 50 units, and a boosting taxi crosses it in under three seconds, so a straight-line run would
  // measure the clamp rather than the framing.
  const settle = (yaw, speed, smoothing, seconds = 8) => {
    const cam = createCityCamera(ASPECT, { zoom: ZOOM });
    // A sim yaw, as everywhere else: forward is (cos yaw, −sin yaw).
    const dir = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    for (let i = 0; i < Math.round(seconds / STEP); i += 1) {
      cam.state.target.x -= dir.x * speed * STEP;
      cam.state.target.z -= dir.z * speed * STEP;
      cam.followXZ(0, 0, STEP, smoothing, ASPECT,
        { ...dir, gain: Math.min(speed / BOOST_TOP, 1), speed });
    }
    cam.camera.updateMatrixWorld(true);
    // Normalised device coordinates: ±1 is the frame edge on each axis, so this is exactly the
    // "fraction of a half-frame" the constant is stated in — aspect and foreshortening included.
    const p = new THREE.Vector3(0, 0, 0).project(cam.camera);
    return { x: p.x, y: p.y, r: Math.hypot(p.x, p.y), cam };
  };

  // A camera parked on the origin, purely to read screen bearings off. One world unit up a heading,
  // projected through this, *is* that heading's direction on screen — so the "behind" test below is
  // taken from the frustum rather than from a copy of camera.js's basis vectors.
  const plain = createCityCamera(ASPECT, { zoom: ZOOM }).camera;
  plain.updateMatrixWorld(true);
  const screenBearing = (yaw) => {
    const p = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).project(plain);
    const len = Math.hypot(p.x, p.y);
    return { x: p.x / len, y: p.y / len };
  };

  // Eight headings around the compass. The tolerance is 3% of the offset rather than float slop:
  // the trail term is the *continuous* steady state (v / rate) and the follow is stepped discretely,
  // which leaves about 0.15 units of lag unpaid at 60fps.
  let worstOff = 0;
  let worstAhead = 0;
  for (let k = 0; k < 8; k += 1) {
    const yaw = (k * Math.PI) / 4;
    const { x, y, r } = settle(yaw, BOOST_TOP, 3.2);
    worstOff = Math.max(worstOff, Math.abs(r - LEAD_FRACTION));
    // ...and the car has to be *behind* itself, not merely off-centre. A dot of −1 against its own
    // screen bearing is the car sitting exactly opposite the way it is pointed.
    const b = screenBearing(yaw);
    worstAhead = Math.max(worstAhead, (x * b.x + y * b.y) / r + 1);
  }
  check('the follow seats the taxi a fixed fraction of the frame behind itself',
    worstOff < LEAD_FRACTION * 0.03,
    `worst heading is off by ${(worstOff * 100).toFixed(2)}% of a half-frame`);
  check('the lead always opens the frame the way the taxi is pointed',
    worstAhead < 2e-3, `worst heading is ${(Math.acos(1 - worstAhead) * 180 / Math.PI).toFixed(2)}° off`);

  // The point of doing this in screen space. A single world-space lead — the passing lab's, which is
  // all a due-east road can tell you — is worth wildly different amounts of frame per heading here,
  // because the diagonal view foreshortens up-screen travel to 0.55 and a portrait frame is twice as
  // tall as it is wide. Those compound, so the *world* distance has to vary ~4x to hold the framing
  // still. This is the assertion that fails if someone "simplifies" this to one number.
  // Straight off frameLead rather than off the settled controller, whose offset also carries the
  // trail — a constant that is equal in every direction and would dilute the ratio being measured.
  const reach = (yaw) => {
    const l = frameLead(Math.cos(yaw), -Math.sin(yaw), 1, ZOOM * ASPECT, ZOOM);
    return Math.hypot(l.x, l.z);
  };
  const spread = reach((3 * Math.PI) / 4) / reach(Math.PI / 4);
  check('the world lead stretches to hold the screen framing', spread > 3.5 && spread < 4.5,
    `up-screen lead is ${spread.toFixed(2)}x the across-screen one `
    + `(${reach((3 * Math.PI) / 4).toFixed(1)} units against ${reach(Math.PI / 4).toFixed(1)})`);

  // Speed drives it, so a taxi held at a red sits dead centre — there is no "ahead" to look down
  // and the player is reading the junction they are stopped in. Exactly zero, not nearly: the lead
  // eases to a target of zero, and a floor left in by a stray max() would park the framing off the
  // car for the whole wait.
  check('a stopped taxi is framed dead centre', settle(Math.PI / 2, 0, 1.5).r < 1e-9,
    `${settle(Math.PI / 2, 0, 1.5).r.toFixed(6)} of a half-frame off`);

  // Both follows have to land in the same place, which is what the trail term buys: they run at 1.5
  // and 3.2, and an uncompensated exponential settles v/rate behind its aim — so the same speed
  // framed the car differently either side of the Loco Mode press, moving the picture on the one
  // frame the player is certainly watching.
  const opening = settle((3 * Math.PI) / 4, BOOST_TOP, 1.5);
  const chasing = settle((3 * Math.PI) / 4, BOOST_TOP, 3.2);
  check('the framing does not move when Loco Mode takes the camera over',
    Math.abs(opening.r - chasing.r) < 0.02,
    `opening follow ${opening.r.toFixed(3)}, boost chase ${chasing.r.toFixed(3)}`);

  // A corner swings the entire offset across the frame. It is eased separately and more slowly than
  // the follow (LEAD_RATE), and the thing that would go wrong without that — an overshoot that
  // throws the car at the edge of frame mid-turn, when the player is reading a new street — has no
  // tell in a still.
  {
    const cam = createCityCamera(ASPECT, { zoom: ZOOM });
    let yaw = (3 * Math.PI) / 4;
    let peak = 0;
    for (let i = 0; i < 60 * 6; i += 1) {
      const t = i * STEP;
      if (t > 2 && t < 2.45) yaw += (Math.PI / 2) * (STEP / 0.45);   // a junction taken at speed
      const dir = { x: Math.cos(yaw), z: -Math.sin(yaw) };
      cam.state.target.x -= dir.x * BOOST_TOP * STEP;
      cam.state.target.z -= dir.z * BOOST_TOP * STEP;
      cam.followXZ(0, 0, STEP, 3.2, ASPECT, { ...dir, gain: 1, speed: BOOST_TOP });
      if (t > 1.5) {
        cam.camera.updateMatrixWorld(true);
        const p = new THREE.Vector3(0, 0, 0).project(cam.camera);
        peak = Math.max(peak, Math.abs(p.x), Math.abs(p.y));
      }
    }
    check('a corner never throws the taxi at the edge of frame',
      peak < LEAD_FRACTION * 1.15, `worst ${(peak * 100).toFixed(1)}% of a half-frame from centre`);
  }

  // Saying nothing is how a caller asks for the car dead centre — the tutorial does, because its
  // first bubble is pointing at the car and an offset frame reads as pointing beside it. It has to
  // *retire* a standing lead rather than merely stop adding to it: the tutorial runs after a run has
  // been under way, so there is always one to retire.
  {
    const cam = createCityCamera(ASPECT, { zoom: ZOOM });
    const dir = { x: Math.cos(Math.PI / 2), z: -Math.sin(Math.PI / 2) };
    for (let i = 0; i < 240; i += 1) {
      cam.followXZ(0, 0, STEP, 3.2, ASPECT, { ...dir, gain: 1, speed: BOOST_TOP });
    }
    const withLead = Math.hypot(cam.leadOffset().x, cam.leadOffset().z);
    for (let i = 0; i < 240; i += 1) cam.followXZ(0, 0, STEP, 3.2, ASPECT);
    const without = Math.hypot(cam.leadOffset().x, cam.leadOffset().z);
    check('a follow with no aim gives the lead back', withLead > 1 && without < 0.01,
      `${withLead.toFixed(1)} units of lead, ${without.toFixed(3)} after`);
  }
}

// --- Loco Mode's push-in ----------------------------------------------------
// The frame tightens by LOCO_PUNCH while the pill is *held*. Two halves, and the awkward one is the
// half that has to do nothing: releasing mid-spend is a designed input, so the pill gets tapped
// constantly, and a push-in keyed on the press popped the frame on every jab. Nothing about either
// half shows up in a still — a push-in that fires on taps looks exactly like one that doesn't, one
// frame at a time — so the gesture is driven here instead, at 60fps against a real frustum.
//
// main.js owns the rule that turns the button into the boolean; it is restated in `punchWanted`
// below rather than imported, so a change to either side has to be made in both.
{
  const ASPECT = 390 / 844;         // the portrait phone the push-in runs on
  const ZOOM = 52;
  const STEP = 1 / 60;
  const HEADING = (3 * Math.PI) / 4;

  // main.js's latch: earning the push-in takes a hold every time, and once earned it survives the
  // momentum tail so feathering the pill doesn't breathe the frame in and out.
  const rig = () => {
    const cam = createCityCamera(ASPECT, { zoom: ZOOM });
    const boost = createBoost(BOOST_DURATION, 1, BOOST_COOLDOWN);
    let punched = false;
    return {
      cam,
      boost,
      // One frame of everything: the clock, the rule, the ease. Returns the drawn half-height.
      step(dt = STEP) {
        boost.update(dt);
        punched = (boost.isActive() && boost.heldSeconds() >= LOCO_PUNCH_HOLD)
          || (punched && boost.isEngaged());
        cam.punchZoom(punched, dt, ASPECT);
        return cam.viewZoom();
      },
    };
  };

  // A jab. 0.18s is a brisk tap — well past a frame, well short of a hold — and it must leave the
  // frustum untouched, not merely nearly untouched: this is the case that reads as the camera
  // twitching every time the player feathers the throttle.
  {
    const r = rig();
    r.boost.press();
    let worst = 0;
    for (let i = 0; i < Math.round(0.18 / STEP); i += 1) worst = Math.max(worst, ZOOM - r.step());
    r.boost.release();
    for (let i = 0; i < 120; i += 1) worst = Math.max(worst, ZOOM - r.step());
    check('a tap on Loco Mode never moves the frame', worst === 0,
      `worst ${worst.toFixed(4)} units of push-in over a 0.18s tap`);
  }

  // A hold. The frame has to actually arrive at the constant — an ease that stalls part-way is the
  // other silent failure, and it looks like a smaller push-in rather than like a bug.
  {
    const r = rig();
    r.boost.press();
    let biggestStep = 0;
    let prev = ZOOM;
    for (let i = 0; i < Math.round(3 / STEP); i += 1) {
      const now = r.step();
      biggestStep = Math.max(biggestStep, (prev - now) / ZOOM);
      prev = now;
    }
    check('a hold pushes the frame in to LOCO_PUNCH',
      Math.abs(r.cam.state.punch - LOCO_PUNCH) < 1e-3,
      `punch ${r.cam.state.punch.toFixed(4)} against ${LOCO_PUNCH}`);
    // The hold gate exists so the frame never *pops*, and the ease is what keeps it from popping
    // once the gate opens. Stated as a **fraction of the move**, not as a percentage of the frame:
    // the depth and the rate are feel constants that have already been retuned twice (0.93/2.2 was
    // a push-in that arrived in full and could not be seen), and an absolute bound fails on the fix
    // rather than on the bug. What has to stay true through any retune is that the ease spans
    // frames — at a fifth of the move per frame it takes five to travel, which the eye reads as a
    // move; a cut is one frame covering the lot.
    const travel = 1 - LOCO_PUNCH;
    check('the push-in never lands in one frame', biggestStep < travel * 0.2,
      `steepest frame covers ${(100 * biggestStep / travel).toFixed(1)}% of the move `
      + `(${(biggestStep * 100).toFixed(2)}% of the frame)`);

    // ...and letting go gives it all back, exactly, rather than leaving the city a fraction of a
    // percent large for the rest of the run.
    r.boost.release();
    for (let i = 0; i < Math.round(6 / STEP); i += 1) r.step();
    check('releasing opens the frame back up', r.cam.state.punch === 1 && r.cam.viewZoom() === ZOOM,
      `punch ${r.cam.state.punch}, zoom ${r.cam.viewZoom()}`);
  }

  // Feathering: let go and grab it again inside the momentum window. The taxi is still at full tilt
  // through that second (BOOST_COOLDOWN), so the frame has no business travelling anywhere. Held
  // long enough for the ease to settle first, so "still" can be asserted exactly rather than
  // against a push-in that is legitimately still arriving.
  {
    const r = rig();
    r.boost.press();
    for (let i = 0; i < Math.round(4 / STEP); i += 1) r.step();
    const held = r.cam.viewZoom();
    r.boost.release();
    for (let i = 0; i < Math.round(BOOST_COOLDOWN * 0.5 / STEP); i += 1) r.step();
    r.boost.press();
    let drift = 0;
    for (let i = 0; i < Math.round(1 / STEP); i += 1) drift = Math.max(drift, Math.abs(r.step() - held));
    check('feathering the pill holds the frame still', drift === 0,
      `${drift.toFixed(4)} units of drift across a re-press`);
  }

  // The push-in is a change to the frame, not to the framing. `LEAD_FRACTION` is stated as a
  // fraction of a *half-frame*, so the taxi has to sit in exactly the same place in the picture
  // pushed in as it does at rest — the city gets bigger around it and nothing slides. Measured by
  // projecting the taxi through the real frustum, as the lead checks above do.
  {
    const seat = (punch) => {
      const cam = createCityCamera(ASPECT, { zoom: ZOOM });
      const dir = { x: Math.cos(HEADING), z: -Math.sin(HEADING) };
      const speed = boostCruise();
      for (let i = 0; i < 8 * 60; i += 1) {
        cam.state.punch = punch;
        cam.state.target.x -= dir.x * speed * STEP;
        cam.state.target.z -= dir.z * speed * STEP;
        cam.followXZ(0, 0, STEP, 3.2, ASPECT, { ...dir, gain: 1, speed });
      }
      cam.camera.updateMatrixWorld(true);
      const p = new THREE.Vector3(0, 0, 0).project(cam.camera);
      // How far down the heading the frame edge is, in world units — what the push-in actually
      // spends, since the mode exists to cover ground.
      const inside = (d) => {
        const q = new THREE.Vector3(dir.x * d, 0, dir.z * d).project(cam.camera);
        return Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1;
      };
      let lo = 0;
      let hi = 400;
      for (let i = 0; i < 60; i += 1) {
        const mid = (lo + hi) / 2;
        if (inside(mid)) lo = mid; else hi = mid;
      }
      return { r: Math.hypot(p.x, p.y), ahead: lo };
    };
    const rest = seat(1);
    const pushed = seat(LOCO_PUNCH);
    check('the push-in moves the frame, not the taxi in it',
      Math.abs(rest.r - pushed.r) < 1e-3,
      `${(rest.r * 100).toFixed(1)}% of a half-frame at rest, ${(pushed.r * 100).toFixed(1)}% pushed in`);
    // What it costs, written down: the road ahead shrinks by exactly the push-in, and has to stay
    // clear of GHOST_RADIUS — the distance at which a car hidden behind a building lights its
    // outline. A push-in deep enough to bring the frame edge inside that would be showing the
    // player a warning about something off screen, which is the one way this could cost a run.
    check('the road ahead only loses the push-in, and keeps the traffic warning inside the frame',
      Math.abs(pushed.ahead / rest.ahead - LOCO_PUNCH) < 1e-3 && pushed.ahead > GHOST_RADIUS,
      `${rest.ahead.toFixed(0)} -> ${pushed.ahead.toFixed(0)} units of road ahead, `
      + `warning at ${GHOST_RADIUS}`);
  }
}

// --- Loco Mode's overdrive band ---------------------------------------------
// The mode's ceiling is 22.95 u/s, but holding the button does not buy it: BOOST_ACCEL runs out at
// 18.7 and the last 4.25 u/s arrive at 2.2 u/s², which is 40 units of unbroken straight road. The
// top end is a straightaway you drove rather than a button you held, and both halves of that are
// asserted here — that the band is reachable at all, and that there is no shortcut into it.
// Neither failure has a tell on screen: a taper that got lost, or a straightaway that stopped
// ending at corners, still looks exactly like an ordinary boost.
{
  const oScene = new THREE.Scene();
  const oTraffic = createTraffic(makeRng(seed + 44), oScene, CARS_DEFAULT);
  const oTaxi = oTraffic.taxi;
  oTraffic.warmup(5);
  oTaxi.boost = true;

  const BOOST_TOP = boostCruise();      // what holding the button is worth on its own
  const OVERDRIVE_TOP = overdriveTop(); // the ceiling, at the far end of a straightaway

  let top = 0;
  let straight = 0;               // distance driven since the last real turn
  let runToNearTop = Infinity;    // shortest straightaway that ever got within 1 u/s of the top
  let runToBoostTop = Infinity;   // ...and the shortest that reached the button's own ceiling
  let inBand = 0, bandRun = 0;    // road spent climbing the band, and the longest such climb

  for (let step = 0; step < 60 * 300; step++) {
    oTraffic.update(1 / 60);
    // Going straight on through a junction runs through the turn state as well, and is still part
    // of the straightaway — only a real turn ends one. See the `car.state === 'turn'` trap.
    if (oTaxi.state === 'turn' && oTaxi.turn?.hand !== 'straight') { straight = 0; continue; }
    straight += oTaxi.v * (1 / 60);
    top = Math.max(top, oTaxi.v);
    if (oTaxi.v > OVERDRIVE_TOP - 1) runToNearTop = Math.min(runToNearTop, straight);
    if (oTaxi.v > BOOST_TOP) runToBoostTop = Math.min(runToBoostTop, straight);
    // Road covered while inside the band itself — the climb the taper charges for, independent of
    // where the last corner was. Reset whenever the car drops back under the cap.
    if (oTaxi.v > BOOST_TOP && oTaxi.v < OVERDRIVE_TOP - 1) inBand += oTaxi.v * (1 / 60);
    else if (oTaxi.v <= BOOST_TOP) inBand = 0;
    else bandRun = Math.max(bandRun, inBand);
  }

  check('Loco Mode reaches its overdrive ceiling', top > OVERDRIVE_TOP - 0.01,
    `${top.toFixed(2)} of ${OVERDRIVE_TOP.toFixed(2)} units/s`);
  check('and never goes past it', top <= OVERDRIVE_TOP + 1e-6, `${top.toFixed(3)} units/s`);
  // **This used to be measured from the last corner, and can no longer be.** The old tuning shed
  // the whole band inside any turn — 4.25 u/s at BRAKE 11 is 0.39s against a right arc's ~0.35s —
  // so "distance since the last real turn" and "distance spent climbing the band" were the same
  // number. At the shipped ceiling of 34 with the turn clamp at 22.1, shedding takes 0.68s: a left
  // (~0.70s) still costs the band and a right (~0.35s) does not, so the taxi can now leave a right
  // turn already at the top and the old check reads a straightaway of nearly zero.
  //
  // What survives, and is the thing that check was actually defending, is that the band has to be
  // *climbed*: measure the road covered between the boost cap and the top instead. 71 units is what
  // the physics says — (34² − 22.1²) / (2 · 4.7). Anything much under it means the taper is gone
  // and the top end has become free.
  check('the top end still has to be climbed', bandRun > 55,
    `${bandRun.toFixed(1)} units between the cap and the top`);
  // The other half of the deal: the mode itself still lands instantly. Its own ceiling is back
  // within a couple of units of a corner exit, which is where the go-go-go feel lives.
  check('boost speed itself is still instant', runToBoostTop < 5,
    `${runToBoostTop.toFixed(1)} units of straight road`);
}

// --- The Loco Mode ramp, as live tuning -------------------------------------
//
// The six numbers above are a tuning object now, so the ⚙️ panel can move them while the game is
// running (see the Loco section in game/debugpanel.js). Two things have to hold and neither shows
// on screen.
//
// The first is that the shipped tuning is *still the shipped tuning* — every number quoted in
// docs/traffic.md, and the entire block of checks above, is stated against these six, so a typo in
// the defaults would move the game and leave the documentation describing a build that no longer
// exists.
//
// The second is the one a tuning panel actually dies of: a use site that captured its constant
// into a local at module load, leaving a slider that moves, reports, redraws its preview and
// changes nothing at all until the page is reloaded. That cannot be caught by reading the tuning
// back — it reads back fine — so it is caught by driving the sim past the shipped ceiling.
{
  check('the Loco defaults are the shipped constants',
    LOCO_DEFAULTS.kick === 1.25 && LOCO_DEFAULTS.speed === 2.6 && LOCO_DEFAULTS.accel === 24
    && LOCO_DEFAULTS.overdriveSpeed === 4.0 && LOCO_DEFAULTS.overdriveAccel === 4.7
    && LOCO_DEFAULTS.brake === 17.5,
    JSON.stringify(LOCO_DEFAULTS));
  check('and the derived ceilings match the docs',
    Math.abs(boostCruise() - 22.1) < 1e-9 && Math.abs(overdriveTop() - 34) < 1e-9,
    `${boostCruise().toFixed(2)} / ${overdriveTop().toFixed(2)} u/s`);
  // The *scale*, not the ceiling. MPH_PER_UNIT is a fixed conversion between the sim's unit and a
  // real one, so it is asserted at the speed it was anchored on — 22.95 u/s is 67mph whatever the
  // ceiling is doing. Written as `overdriveTop() * MPH_PER_UNIT === 67` first, which passed for
  // exactly as long as the ceiling stayed at 22.95 and then hid the readout rescaling under it.
  check('the mph scale is anchored, not derived from the ceiling',
    Math.round(22.95 * MPH_PER_UNIT) === 67 && Math.round(overdriveTop() * MPH_PER_UNIT) === 99,
    `22.95 → 67mph, top ${overdriveTop()} → ${Math.round(overdriveTop() * MPH_PER_UNIT)}mph`);
  // The cruiser has to out-run the quarry on its best day or the bust can never land, and nothing
  // on screen says so — the siren just follows you forever. See CHASE_SPEED in sim/police.js.
  check('the police cruiser still out-runs the overdrive top',
    CHASE_SPEED > overdriveTop(),
    `${CHASE_SPEED} against ${overdriveTop()} u/s, ${(CHASE_SPEED - overdriveTop()).toFixed(1)} to close with`);

  // The panel's preview is drawn from locoRamp(), so if it disagrees with the physics the picture
  // on screen is of a mode the game does not have. Checked against the closed form rather than
  // against a recorded number: the punch covers (22.1² − 10.625²) / (2·24) = 7.82 units from the
  // kick, and the band (34² − 22.1²) / (2·4.7) = 71.0 more.
  const ramp = locoRamp();
  const reached = (v) => ramp.find((p) => p.v >= v - 1e-3)?.s ?? Infinity;
  const toCap = reached(boostCruise());
  const toTop = reached(overdriveTop());
  check('the ramp preview agrees with the punch', Math.abs(toCap - 7.82) < 0.7,
    `${toCap.toFixed(2)} units to ${boostCruise().toFixed(1)} u/s`);
  check('and with the 71 units the band costs', Math.abs(toTop - toCap - 71.0) < 2,
    `${(toTop - toCap).toFixed(1)} units of band`);
  check('the ramp lets go and lands back at cruise',
    ramp.some((p) => p.release) && Math.abs(ramp[ramp.length - 1].v - SPEED) < 1e-6,
    `ends at ${ramp[ramp.length - 1].v.toFixed(2)} u/s`);

  // An overdrive ceiling under the boost cap is a mode with no band at all — boostAccel never
  // reaches its taper — so it is clamped up rather than taken at face value.
  setLocoTuning({ overdriveSpeed: 1.0 });
  check('an overdrive ceiling below the boost cap is clamped up',
    locoTuning().overdriveSpeed === locoTuning().speed,
    `${locoTuning().overdriveSpeed} vs cap ${locoTuning().speed}`);
  const beforeJunk = JSON.stringify(locoTuning());
  setLocoTuning({ accel: NaN, brake: -4, speed: 'fast' });
  check('and junk is ignored rather than fed to the sim',
    JSON.stringify(locoTuning()) === beforeJunk, locoTuning().accel + ' u/s²');
  resetLocoTuning();
  check('reset puts every knob back',
    JSON.stringify(locoTuning()) === JSON.stringify({ ...LOCO_DEFAULTS }), JSON.stringify(locoTuning()));

  // The end-to-end one. Same scenario as the overdrive block above, with the ceiling raised: if
  // any use site is reading a captured copy, the taxi tops out at the shipped 22.95 and this is
  // the only check in the suite that notices.
  const drive = () => {
    const s2 = new THREE.Scene();
    const t2 = createTraffic(makeRng(seed + 44), s2, CARS_DEFAULT);
    t2.warmup(5);
    t2.taxi.boost = true;
    let peak = 0;
    for (let i = 0; i < 60 * 300; i++) { t2.update(1 / 60); peak = Math.max(peak, t2.taxi.v); }
    return peak;
  };
  setLocoTuning({ overdriveSpeed: 5.5, overdriveAccel: 14 });
  const raised = drive();
  check('raising the ceiling in the tuning raises the sim', raised > overdriveTop() - 0.5,
    `${raised.toFixed(2)} of ${overdriveTop().toFixed(2)} u/s`);
  check('and it is the tuning doing it, not the old constant', raised > 34 + 1,
    `${raised.toFixed(2)} u/s against a shipped ceiling of 34`);

  // --- and the weave, which is the other half of the mode ---------------------
  //
  // The wander inside the lane. Same discipline as the speeds above and the same failure to guard
  // against — but with a second reader: `sim/police.js` drives the taxi's Loco Mode, and it used
  // to import the fade as a *constant* and divide by it. That is the captured-copy bug in its
  // purest form, so the fade is asserted through the cruiser rather than through the taxi.
  check('the weave defaults are the shipped constants',
    LOCO_DEFAULTS.sway === 0.40 && LOCO_DEFAULTS.swayWave === 18
    && LOCO_DEFAULTS.chop === 0.12 && LOCO_DEFAULTS.chopWave === 9.5
    && LOCO_DEFAULTS.fade === 7,
    `${LOCO_DEFAULTS.sway} + ${LOCO_DEFAULTS.chop} over ${LOCO_DEFAULTS.swayWave}/${LOCO_DEFAULTS.chopWave}`);

  // The room budget the tuning block in traffic.js is written against: lane centre to kerb, less
  // half a body. Asserted rather than restated, because "half the room" is the claim that makes
  // the shipped pair safe and it is the first thing a re-tune would quietly break.
  const weaveRoom = LANE - CAR_W / 2;
  check('and the shipped pair peaks at about half the lane it has',
    LOCO_DEFAULTS.sway + LOCO_DEFAULTS.chop < weaveRoom * 0.55,
    `${(LOCO_DEFAULTS.sway + LOCO_DEFAULTS.chop).toFixed(2)} of ${weaveRoom.toFixed(2)} units`);

  // The periods must not divide, or the two waves lock into a metronome and the whole point of
  // having two of them goes. 18 / 9.5 is 1.895.
  check('the two wavelengths do not divide',
    Math.abs((LOCO_DEFAULTS.swayWave / LOCO_DEFAULTS.chopWave) % 1) > 0.15,
    `${(LOCO_DEFAULTS.swayWave / LOCO_DEFAULTS.chopWave).toFixed(3)}`);

  // The shape itself, at the shipped tuning: peaks inside the room, and a slope that is a real
  // steering angle rather than a jerk.
  {
    let peak = 0, slopePeak = 0;
    for (let u = 0; u < 200; u += 0.05) {
      const w = locoWeave(u);
      peak = Math.max(peak, Math.abs(w.lateral));
      slopePeak = Math.max(slopePeak, Math.abs(w.slope));
    }
    check('the weave stays inside the lane it was sized for', peak < weaveRoom,
      `${peak.toFixed(3)} of ${weaveRoom.toFixed(2)} units`);
    // Against `STEER_MAX` (0.6 rad, ~34°, about where a real front wheel stops) rather than a
    // number picked to fit: the claim is that the weave asks for a steering angle the car can
    // actually give, and half the lock is comfortably inside that. Measured 0.217 rad, 12.3°.
    check('and its steering angle is one the front wheels can give',
      slopePeak < STEER_MAX / 2,
      `${(Math.atan(slopePeak) * 180 / Math.PI).toFixed(1)}° of a ${(Math.atan(STEER_MAX) * 180 / Math.PI).toFixed(0)}° lock`);
  }

  // Live, not captured: turning the sway up has to change what `locoWeave` returns, and it is the
  // same function the cruiser calls.
  setLocoTuning({ sway: 1.0, chop: 0.02 });
  {
    let peak = 0;
    for (let u = 0; u < 200; u += 0.05) peak = Math.max(peak, Math.abs(locoWeave(u).lateral));
    check('raising the sway raises the weave', peak > 0.95 && peak < 1.05,
      `${peak.toFixed(3)} units`);
  }
  setLocoTuning({ swayWave: 40 });
  {
    // A longer wavelength means a gentler slope for the same amplitude — the readable consequence,
    // and the one a wavelength that quietly stayed at 18 would not produce.
    let slopePeak = 0;
    for (let u = 0; u < 200; u += 0.05) slopePeak = Math.max(slopePeak, Math.abs(locoWeave(u).slope));
    check('and stretching the wavelength flattens the steering',
      slopePeak < 2 * Math.PI / 40 * 1.05 + 0.02,
      `${slopePeak.toFixed(4)} rad/unit`);
  }
  resetLocoTuning();

  // **Zero is a setting, not a refusal.** The amplitude sliders reach 0 because switching the
  // wander off is how you look at the mode without it — but `setLocoTuning` treated every
  // non-positive number as "no opinion", so dragging either to zero was silently ignored and the
  // taxi went on weaving. The two knobs where zero means something are the two amplitudes; a
  // wavelength of zero divides by zero inside `locoWeave`, and a `fade` of zero puts a NaN in the
  // envelope, so those still refuse it.
  setLocoTuning({ sway: 0, chop: 0 });
  {
    let peak = 0;
    for (let u = 0; u < 200; u += 0.05) peak = Math.max(peak, Math.abs(locoWeave(u).lateral));
    check('the weave can be switched off', locoTuning().sway === 0 && peak === 0,
      `sway ${locoTuning().sway}, peak ${peak}`);
  }
  resetLocoTuning();
  setLocoTuning({ swayWave: 0, chopWave: 0, fade: 0, speed: 0, brake: 0 });
  check('but a zero divisor is still refused',
    locoTuning().swayWave === 18 && locoTuning().chopWave === 9.5 && locoTuning().fade === 7
    && locoTuning().speed === 2.6 && locoTuning().brake === 17.5,
    `${locoTuning().swayWave}/${locoTuning().chopWave}, fade ${locoTuning().fade}`);
  setLocoTuning({ sway: -1 });
  check('and so is a negative amplitude', locoTuning().sway === LOCO_DEFAULTS.sway,
    `${locoTuning().sway}`);
  resetLocoTuning();

  // The stash has to agree, or the wander comes back on the next reload and nothing says why.
  {
    const map = new Map();
    const store = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
    saveLocoTuning({ ...LOCO_DEFAULTS, sway: 0, chop: 0 }, store);
    const back = loadLocoTuning(store);
    check('a switched-off weave survives the stash', back.sway === 0 && back.chop === 0,
      `sway ${back.sway}, chop ${back.chop}`);
  }

  // The fade, through the police car — the one reader that held its own copy.
  {
    const before = locoWeaveFade();
    setLocoTuning({ fade: 21 });
    check('the weave fade is live rather than a captured constant',
      locoWeaveFade() === 21 && before === 7, `${before} -> ${locoWeaveFade()}`);
    resetLocoTuning();
    check('and it comes back', locoWeaveFade() === 7, `${locoWeaveFade()}`);
  }

  // Everything after this point in the file drives the shipped game. Leaving the tuning moved
  // would quietly re-tune every later check in a way that is very hard to trace back to here.
  resetLocoTuning();
  check('and the tuning is back to shipped for the rest of the suite',
    overdriveTop() === SPEED * 4.0 && locoWeave(4.5).lateral > 0,
    `${overdriveTop().toFixed(2)} u/s`);
}

// --- The Loco tuning stash --------------------------------------------------
//
// A wreck ends the run and Retry is a page reload, so a tuning that doesn't persist is one you
// re-drag every couple of crashes. `game/locostash.js` keeps it in `localStorage`, and the store
// is injectable precisely so the cases a browser never reaches can be driven here: a store that
// throws on the property access, one that throws on the write, and a payload that has been outside
// the program since it was written.
//
// The gate that actually matters — restore only under `?debug` — lives in main.js and is asserted
// by `tools/smoke.mjs`, since it is a fact about how the page boots rather than about the module.
{
  const fake = (over = {}) => {
    const map = new Map();
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
      ...over,
    };
  };

  const store = fake();
  const tuning = { kick: 2.5, speed: 4, accel: 90, overdriveSpeed: 6, overdriveAccel: 30, brake: 40 };
  check('a tuning round-trips through the stash',
    saveLocoTuning(tuning, store)
    && JSON.stringify(loadLocoTuning(store)) === JSON.stringify(tuning),
    JSON.stringify(loadLocoTuning(store)));

  // The panel writes whole tunings, but the console can write one knob, and an old version of the
  // game could have written keys this one has never heard of.
  const partial = fake();
  saveLocoTuning({ speed: 3, nonsense: 7, brake: 'fast', kick: -1, accel: Infinity }, partial);
  check('the stash keeps only knobs that exist, with usable numbers',
    JSON.stringify(loadLocoTuning(partial)) === JSON.stringify({ speed: 3 }),
    JSON.stringify(loadLocoTuning(partial)));

  check('a tuning with nothing usable in it is not written at all',
    saveLocoTuning({ speed: NaN }, fake()) === false, 'refused');

  const corrupt = fake();
  corrupt.setItem('simtaxi.loco.v1', '{"speed":');
  check('a half-written payload reads as no stash', loadLocoTuning(corrupt) === null, 'null');

  const notObject = fake();
  notObject.setItem('simtaxi.loco.v1', '42');
  check('and so does a payload that is not an object', loadLocoTuning(notObject) === null, 'null');

  // Safari's private mode throws on the *write* while reporting a perfectly good object; blocked
  // third-party storage throws on the read. Neither may take the game down — the panel says
  // "not saved" and carries on.
  const deadRead = fake({ getItem: () => { throw new Error('SecurityError'); } });
  check('a store that throws on read degrades to no stash',
    loadLocoTuning(deadRead) === null, 'null');
  const deadWrite = fake({ setItem: () => { throw new Error('QuotaExceededError'); } });
  check('a store that throws on write reports the failure rather than throwing',
    saveLocoTuning(tuning, deadWrite) === false, 'false');
  check('and a store that throws on clear does the same',
    clearLocoTuning(fake({ removeItem: () => { throw new Error('nope'); } })) === false, 'false');

  clearLocoTuning(store);
  check('clearing the stash forgets it', loadLocoTuning(store) === null, 'null');
  check('a missing store is simply no stash', loadLocoTuning(null) === null, 'null');
}

// --- The Loco Mode meter ----------------------------------------------------
//
// The meter is now an earned resource: it opens at a third, drains only while held, and the sole
// way fuel gets in is a drop-off. A regression here is invisible in a screenshot — a stray refill
// path just makes the game quietly easier — so assert the whole arc as numbers.
{
  const b = createBoost();
  check('the meter opens at a third of a tank',
    Math.abs(b.fraction() - BOOST_START_FRACTION) < 1e-9, `${b.fraction().toFixed(3)}`);

  // Idle for a full tank's worth of seconds with the button untouched. Nothing may move.
  const idleStart = b.fraction();
  for (let i = 0; i < 60 * BOOST_DURATION; i++) b.update(1 / 60);
  check('an idle meter does not regenerate', b.fraction() === idleStart,
    `${idleStart.toFixed(3)} -> ${b.fraction().toFixed(3)}`);

  // Drain it dry: a third of a tank is 5s of boost, plus the BOOST_COOLDOWN momentum tail that
  // running dry earns the same as an on-purpose release, so 7s of holding lands on 'empty' with
  // room to spare.
  b.press();
  for (let i = 0; i < 60 * 7; i++) b.update(1 / 60);
  check('holding drains the tank to empty', b.fraction() === 0 && b.isEmpty(), `mode ${b.state.mode}`);

  // Still held, still empty, and — the point of the change — it stays that way. The old fast
  // recharge would have refilled it inside 15s and re-engaged under the finger.
  for (let i = 0; i < 60 * BOOST_DURATION; i++) b.update(1 / 60);
  check('an empty meter never recharges itself', b.fraction() === 0 && !b.isActive(),
    `mode ${b.state.mode} after ${BOOST_DURATION}s held on empty`);

  // A drop-off is the only way back. It pours in over ~0.7s, and because the button was never
  // released the boost re-engages rather than waiting for a fresh press.
  b.topUp(BOOST_FARE_REWARD);
  b.update(1 / 60);
  check('a drop-off revives an empty meter under a held button', b.isActive() && b.fraction() > 0,
    `mode ${b.state.mode}, ${b.fraction().toFixed(3)}`);

  // Three drop-offs fill it from empty. Release first so the pour isn't racing the drain.
  const c = createBoost(BOOST_DURATION, 0);
  check('a meter can start empty', c.fraction() === 0);
  for (let i = 0; i < 3; i++) c.topUp(BOOST_FARE_REWARD);
  for (let i = 0; i < 60 * 3; i++) c.update(1 / 60);
  check('three drop-offs fill the tank', Math.abs(c.fraction() - 1) < 1e-9, `${c.fraction().toFixed(3)}`);

  // And a fourth cannot overflow it.
  c.topUp(BOOST_FARE_REWARD);
  for (let i = 0; i < 60; i++) c.update(1 / 60);
  check('top-ups clamp at a full tank', c.fraction() === 1, `${c.fraction().toFixed(3)}`);

  // A package pays into the same tank at half the rate — the courier layer's only claim on the
  // meter. Two of them are worth exactly one fare, which is the whole statement of the ratio.
  const d = createBoost(BOOST_DURATION, 0);
  d.topUp(BOOST_PARCEL_REWARD);
  d.topUp(BOOST_PARCEL_REWARD);
  for (let i = 0; i < 60 * 2; i++) d.update(1 / 60);
  check('two packages pour what one drop-off does',
    Math.abs(d.fraction() - BOOST_FARE_REWARD) < 1e-9,
    `${d.fraction().toFixed(3)} vs ${BOOST_FARE_REWARD.toFixed(3)}`);
  check('a package pays less than a fare does', BOOST_PARCEL_REWARD < BOOST_FARE_REWARD);

  // And it revives a dead tank the same way a drop-off does — a sixth is small, but it is never
  // *nothing*: 2.5s of boost is a straightaway's worth, and the pill has to come back off `.is-empty`
  // for it or the reward is invisible.
  // Drained rather than started at zero: only a tank that has actually run dry reaches 'empty', and
  // 'empty' is the mode the revival has to come back out of.
  const e = createBoost();
  e.press();
  for (let i = 0; i < 60 * 7; i++) e.update(1 / 60);
  e.topUp(BOOST_PARCEL_REWARD);
  e.update(1 / 60);
  check('a package revives an empty meter under a held button', e.isActive() && e.fraction() > 0,
    `mode ${e.state.mode}, ${e.fraction().toFixed(3)}`);
}

// --- ...and its pour animation at a package's smaller slice ------------------
//
// The pour is what makes a reward *visible*, and a sixth of a tank is the smallest slice anything
// pays. The worry is that it lands too fast to read as filling: at POUR_RATE (half a tank a second)
// a sixth takes ~0.33s, against the ~0.7s a fare's third takes. Assert it stays a pour — long enough
// to see, and still overshooting so the pill's spring fires the same way.
{
  const b = createBoost(BOOST_DURATION, 0);
  const m = createBoostMeter();
  const dt = 1 / 60;
  b.topUp(BOOST_PARCEL_REWARD);

  let peak = -1, t = 0, pourT = null;
  for (let i = 0; i < 60 * 2; i++) {
    b.update(dt);
    const pouring = b.state.pending > 0;
    m.update(dt, b.fraction(), pouring);
    t += dt;
    if (!pouring && pourT === null) pourT = t;
    peak = Math.max(peak, m.state.pct);
  }

  check('a package pours long enough to read as filling', pourT > 0.25 && pourT < 0.5,
    `${pourT.toFixed(2)}s`);
  check('and the bar still overshoots it', peak > BOOST_PARCEL_REWARD + 0.02,
    `peaked at ${(peak * 100).toFixed(1)}% of a ${(BOOST_PARCEL_REWARD * 100).toFixed(1)}% pour`);
  check('the bar settles on the fuel a package left', Math.abs(m.state.pct - b.fraction()) < 1e-9,
    `${(m.state.pct * 100).toFixed(1)}% vs ${(b.fraction() * 100).toFixed(1)}% fuel`);
}

// --- The Punch It pill's fill animation -------------------------------------
//
// The pour is the reward for a drop-off, and all three of its layers are timing — an overshoot
// that never overshoots, or a glow that latches on and never fades, is exactly the kind of thing a
// screenshot can't see. boostmeter.js is pure for this reason: drive it with a real pour and read
// the numbers the CSS variables would have got.
{
  const b = createBoost();
  const m = createBoostMeter();
  const dt = 1 / 60;
  const before = b.fraction();
  b.topUp(BOOST_FARE_REWARD);

  let peak = -1, peakT = 0, t = 0, litFrames = 0, pulseMin = 1, pulseMax = 0;
  let markT = null;         // when the fuel itself finished arriving
  const trace = [];
  for (let i = 0; i < 60 * 3; i++) {
    b.update(dt);
    const pouring = b.state.pending > 0;
    m.update(dt, b.fraction(), pouring);
    t += dt;
    if (!pouring && markT === null) markT = t;
    if (m.state.pct > peak) { peak = m.state.pct; peakT = t; }
    if (m.state.fill > 0) litFrames++;
    if (markT === null && t > 0.2) {          // sample the throb mid-pour, past the attack ramp
      pulseMin = Math.min(pulseMin, m.state.pulse);
      pulseMax = Math.max(pulseMax, m.state.pulse);
    }
    trace.push({ t, pct: m.state.pct, fill: m.state.fill });
  }

  const mark = before + BOOST_FARE_REWARD;
  check('the bar overshoots the fuel it was given', peak > mark + 0.04 && peak < mark + 0.1,
    `${(before * 100).toFixed(0)}% -> ${(mark * 100).toFixed(0)}%, peaked at ${(peak * 100).toFixed(1)}%`);
  check('the overshoot lands just after the fuel does', peakT > markT && peakT < markT + 0.2,
    `fuel done ${markT.toFixed(2)}s, peak ${peakT.toFixed(2)}s`);

  // The bar has to come back to the fuel it actually holds — an overshoot that stuck would be the
  // meter lying about how much boost is in the tank.
  const settled = trace[trace.length - 1];
  check('the bar returns to the real level', Math.abs(settled.pct - b.fraction()) < 1e-9,
    `${(settled.pct * 100).toFixed(1)}% vs ${(b.fraction() * 100).toFixed(1)}% fuel`);

  // ...and it *rings* on the way there rather than easing straight down onto it. Every extremum
  // after the peak, measured against the level the bar ends on: alternating signs, each smaller
  // than the last. An eased fall — the version this replaced — produces none of them, so the
  // count alone is the check that the spring is still a spring.
  const after = trace.filter((s) => s.t > peakT).map((s) => s.pct - settled.pct);
  const swings = [];
  for (let i = 1; i < after.length - 1; i++) {
    if ((after[i] - after[i - 1]) * (after[i + 1] - after[i]) < 0) swings.push(after[i]);
  }
  const alternates = swings.every((v, i) => i === 0 || (v * swings[i - 1] < 0 && Math.abs(v) < Math.abs(swings[i - 1])));
  check('the settle rings instead of easing flat onto the mark',
    swings.length >= 3 && swings[0] < -0.01 && alternates,
    swings.map((v) => `${(v * 100).toFixed(1)}%`).join(' '));

  // The bar climbs the whole way — no stall or step backwards before the peak.
  const climbs = trace.filter((s) => s.t <= peakT).every((s, i, a) => i === 0 || s.pct >= a[i - 1].pct - 1e-9);
  check('the fill never steps backwards on the way up', climbs);

  check('the glow pulses while fuel is arriving', pulseMax - pulseMin > 0.5 && pulseMax <= 1,
    `${pulseMin.toFixed(2)}..${pulseMax.toFixed(2)}`);

  // The glow and the leading edge fade out — and specifically, they outlast the pour (so they're
  // still up while the bar bounces) but are gone well before the next fare could land.
  check('the glow fades out after the bounce', settled.fill === 0 && litFrames * dt > markT,
    `lit for ${(litFrames * dt).toFixed(2)}s, pour took ${markT.toFixed(2)}s`);

  // Nothing may move when no fuel is arriving: a drain has to read 1:1 with the fuel it costs.
  const d = createBoost();
  const dm = createBoostMeter();
  d.press();
  let drainMismatch = 0;
  for (let i = 0; i < 60 * 4; i++) {
    d.update(dt);
    dm.update(dt, d.fraction(), d.state.pending > 0);
    if (Math.abs(dm.state.pct - d.fraction()) > 1e-9 || dm.state.fill !== 0) drainMismatch++;
  }
  check('a drain draws exactly the fuel it has left', drainMismatch === 0, `${drainMismatch} frames off`);
}

// --- Ghost outline ----------------------------------------------------------
//
// The taxi's occluded-only outline (geometry/ghostoutline.js) is a two-pass stencil trick whose
// failure modes are all silent and visual — a wrong depthFunc draws the outline over the visible
// car, a missing mask fills the silhouette instead of tracing it. The material flags ARE the
// behaviour, so assert them here where a regression costs milliseconds, not a screenshot.
{
  const { group } = createTaxiMesh();
  const masks = [];
  const rims = [];
  group.traverse((node) => {
    if (node.name === 'ghostMask') masks.push(node);
    if (node.name === 'ghostRim') rims.push(node);
  });

  // Seven parts: shell, roof sign, both steered wheels, and the three light pods (brake, left turn
  // signal, right turn signal). Every opaque part of the car must be in the mask — a part left out
  // counts as an occluder of the rim behind it, and the wheels being skipped once painted a yellow
  // streak along the rocker panel of a fully visible car. The light pods are opaque parts too even
  // though they are usually scaled to nothing — see geometry/taxi.js's setLights().
  //
  // It was eight while a courier parcel rode the rear deck. The load is a chip in the HUD now
  // (game/cargochip.js) and the car carries nothing, which is one fewer silhouette to mask rather
  // than one that stopped mattering.
  check('taxi wears a ghost outline on every opaque part', masks.length === 7 && rims.length === 7,
    `${masks.length} masks, ${rims.length} rims`);

  const rimsHidden = rims.every((r) => r.material.depthFunc === THREE.GreaterDepth
    && r.material.depthWrite === false && r.material.side === THREE.BackSide);
  check('ghost rim draws only where the taxi is hidden', rimsHidden,
    'depthFunc GreaterDepth, no depth write, back faces');

  // The mask stamps the car's footprint into the stencil; the rim tests against it. Break either
  // half of the pairing and the outline turns into a filled ghost.
  const masksStamp = masks.every((m) => m.material.colorWrite === false
    && m.material.depthTest === false && m.material.stencilWrite
    && m.material.stencilZPass === THREE.ReplaceStencilOp);
  const rimsHollow = rims.every((r) => r.material.stencilWrite
    && r.material.stencilFunc === THREE.NotEqualStencilFunc
    && r.material.stencilRef === masks[0]?.material.stencilRef);
  const ordered = masks.every((m) => m.renderOrder === GHOST_MASK_ORDER)
    && rims.every((r) => r.renderOrder === GHOST_RIM_ORDER) && GHOST_MASK_ORDER < GHOST_RIM_ORDER;
  check('ghost outline is hollow — mask stamps before rim tests', masksStamp && rimsHollow && ordered,
    'stencil stamp/test paired, mask ordered first');

  // The rim hull must actually stand off the shell, or the trace has no thickness to show.
  const shellBox = new THREE.Box3().setFromBufferAttribute(masks[0].geometry.attributes.position);
  const rimBox = new THREE.Box3().setFromBufferAttribute(rims[0].geometry.attributes.position);
  const standoff = rimBox.max.x - shellBox.max.x;
  check('ghost rim stands off the shell', standoff > 0.2 && standoff < 0.5,
    `${standoff.toFixed(2)} units`);

  // The stencil trick needs the renderer's stencil buffer, which three has defaulted OFF since
  // r163. Nothing headless can construct a WebGLRenderer, so read the flag out of main.js —
  // without it the stencil test silently passes everywhere and the outline fills in.
  const mainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  check('renderer keeps its stencil buffer', /stencil:\s*true/.test(mainSource),
    'main.js constructs WebGLRenderer with stencil: true');
}

// --- Screen-space ambient occlusion -------------------------------------------
//
// game/ssao.js plus the patch it hangs on propMaterial(). Every failure mode here is silent: a
// no-op replace leaves the shader unpatched, a missing cache key hands the patched material
// somebody else's compiled program, and a mesh left out of the depth prepass wears the occlusion
// of whatever is standing behind it. None of that logs anything and none of it is obvious in a
// screenshot — it just looks like AO that "isn't doing much".
{
  setAmbientOcclusion(true);
  const aoMaterial = propMaterial();

  // Run the patch against a stub carrying the two chunk names three's Lambert shader actually
  // has. A `.replace()` on a chunk that moved would silently do nothing — the trap CLAUDE.md
  // names outright — and the result is AO that compiles fine and darkens nothing.
  const shader = {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {}',
    fragmentShader: '#include <common>\nvoid main() {\n\t#include <aomap_fragment>\n}',
  };
  aoMaterial.onBeforeCompile(shader, null);

  check('the AO patch reaches the Lambert fragment shader',
    shader.fragmentShader.includes('uniform sampler2D tAmbientOcclusion')
    && shader.fragmentShader.includes('uniform vec2 uAOTexel')
    && /aomap_fragment>[\s\S]*indirectDiffuse \*=/.test(shader.fragmentShader),
    'sampler declared and multiplied in after <aomap_fragment>');

  // Indirect only. Folding AO into the direct term greys off the one lit face per building that
  // golden hour is built around, and the sun's own shadow map already says that part.
  check('AO darkens the indirect term and leaves the sun alone',
    !shader.fragmentShader.includes('reflectedLight.directDiffuse *=')
    && shader.fragmentShader.includes('reflectedLight.indirectDiffuse *='),
    'reflectedLight.directDiffuse untouched');

  // One shared uniform bag, not per-material copies: ssao.js writes the texture once a frame, and
  // if Object.assign handed each shader its own object that write would reach nothing.
  check('every AO material reads the one shared uniform bag',
    shader.uniforms.tAmbientOcclusion === AO_UNIFORMS.tAmbientOcclusion
    && shader.uniforms.uAOTexel === AO_UNIFORMS.uAOTexel,
    'same uniform objects, not clones');

  // The cache key. Without it three keys the program off the material's *parameters*, computed
  // before onBeforeCompile runs, so this patched flat-shaded Lambert collides with every
  // unpatched one in the city and gets handed whichever compiled first.
  const aoKey = typeof aoMaterial.customProgramCacheKey === 'function'
    ? aoMaterial.customProgramCacheKey() : null;
  setAmbientOcclusion(false);
  const plainMaterial = propMaterial();
  const plainKey = typeof plainMaterial.customProgramCacheKey === 'function'
    ? plainMaterial.customProgramCacheKey() : null;
  check('the AO-patched material cannot collide with an unpatched one',
    Boolean(aoKey) && aoKey !== plainKey && plainMaterial.onBeforeCompile !== aoMaterial.onBeforeCompile,
    `patched key "${aoKey}", unpatched "${plainKey}"`);

  // The occluder filter, which is the failure that would actually be visible: the ghost outline's
  // inflated rim hull stamped into the depth prepass draws AO around a silhouette 0.3 units bigger
  // than the car, and the prepass swaps a mesh's material out wholesale, which strips exactly the
  // flags that would otherwise keep it out. The taxi carries masks, rims and an invisible hit box,
  // so it exercises the whole rule.
  const aoTaxi = createTaxiMesh();
  markOccluder(aoTaxi.group);
  const casting = [];
  const excluded = [];
  aoTaxi.group.traverse((o) => {
    if (o.isMesh) (o.layers.isEnabled(AO_LAYER) ? casting : excluded).push(o);
  });
  const solid = (m) => m.transparent !== true && m.visible !== false && m.colorWrite !== false;
  check('only solid, colour-writing meshes cast AO',
    casting.length > 0 && excluded.length > 0
    && casting.every((o) => solid(o.material)) && excluded.every((o) => !solid(o.material)),
    `${casting.length} casting, ${excluded.length} excluded (rims, masks, hit box)`);

  // The other half of the same rule: anything lit by propMaterial() has to cast as well as
  // receive, or it samples the occlusion of whatever is standing behind it.
  const receivingOnly = excluded.filter((o) => o.material.vertexColors && solid(o.material));
  check('no propMaterial mesh receives AO without casting it', receivingOnly.length === 0,
    'every lit prop mesh on the taxi is in the prepass');

  // The layer decides who renders in the prepass; the draw list decides what they render *as*. A
  // mesh in one and not the other is silent either way — off the list it stamps depth through its
  // own lit material, off the layer it is swapped onto a depth material and never drawn.
  const enrolled = occluderList();
  check('the AO draw list holds exactly the meshes on the AO layer',
    casting.length > 0 && casting.every((o) => enrolled.has(o))
    && excluded.every((o) => !enrolled.has(o)),
    `${casting.length} enrolled, ${excluded.length} left out`);

  // The list holds a hard reference and swaps a material onto every entry each frame, so anything
  // that disposes an occluder — roadwork's slab is the one that does — has to hand it back.
  unmarkOccluder(aoTaxi.group);
  check('unmarkOccluder clears both the layer and the draw list',
    casting.every((o) => !enrolled.has(o) && !o.layers.isEnabled(AO_LAYER)),
    `${casting.length} released`);

  // The entrance's depth materials (game/cityentry.js). The city's shape lives in its vertex
  // shader, so any depth pass that renders it unpatched draws the *finished* building. For the sun
  // that lands the whole skyline's shadows on frame one; for the AO prepass — whose result is
  // sampled in screen space, not per surface — it traces a contact crease around edges and corners
  // that have not risen out of the ground yet, painted onto the bare road standing there instead.
  const entryMeshes = [0, 1].map(() => new THREE.Mesh(
    new THREE.BufferGeometry(), new THREE.MeshLambertMaterial()));
  createCityEntry({ meshes: entryMeshes });
  const entryDepth = entryMeshes.flatMap((m) => [m.customDepthMaterial, m.userData.aoDepthMaterial]);

  check('both depth passes get a patched material for the entrance',
    entryDepth.length === 4 && entryDepth.every((m) => m?.isMeshDepthMaterial
      && m.depthPacking === THREE.RGBADepthPacking),
    'customDepthMaterial for the sun, userData.aoDepthMaterial for the AO prepass');

  // Same stub trick as the Lambert patch above: a `.replace()` on a chunk that moved does nothing,
  // compiles fine, and animates nothing.
  const entryShaders = entryDepth.map((material) => {
    const stub = {
      uniforms: {},
      vertexShader: '#include <common>\nvoid main() {\n\t#include <begin_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n}',
    };
    material.onBeforeCompile(stub, null);
    return stub;
  });
  check('every entrance depth pass runs the grow and discards what has not risen',
    entryShaders.every((s) => s.vertexShader.includes('attribute vec3 aEntry')
      && s.vertexShader.includes('uEntryTime')
      && s.fragmentShader.includes('discard')),
    'a scale-0 building is a flat sheet at kerb height, not nothing');

  // Two instances, not one shared. Three's shadow map assigns `side` on whatever depth material it
  // is handed, flipping FrontSide to BackSide through its `shadowSide` table
  // (WebGLShadowMap.getDepthMaterial) — every frame, and before the next frame's AO pass reads it.
  // Sharing the instance would leave the prepass stamping the depth of each building's *far* wall,
  // which is AO that is wrong everywhere rather than wrong for two seconds.
  check('the shadow map and the AO prepass hold separate depth materials',
    entryMeshes.every((m) => m.customDepthMaterial !== m.userData.aoDepthMaterial),
    'the shadow pass mutates the material it is given');
  for (const m of entryMeshes) m.customDepthMaterial.side = THREE.BackSide; // what the shadow pass does
  check('a shadow pass flipping `side` cannot reach the AO prepass material',
    entryMeshes.every((m) => m.userData.aoDepthMaterial.side === THREE.FrontSide),
    'the AO prepass still draws front faces');

  // And the mechanism that makes a per-mesh depth material reachable at all. `overrideMaterial` is
  // all-or-nothing: set it and every one of those choices is silently outranked.
  const aoSource = fs.readFileSync(new URL('../src/game/ssao.js', import.meta.url), 'utf8');
  check('the prepass picks a depth material per mesh rather than overriding the scene',
    /userData\.aoDepthMaterial \|\| depthMaterial/.test(aoSource)
    && /scene\.overrideMaterial = null/.test(aoSource)
    && !/scene\.overrideMaterial = depthMaterial/.test(aoSource),
    'occluders swapped individually, any override cleared for the pass');

  // The rejection window, recomputed from the camera and the car rather than trusted. Both bounds
  // fall out of VIEW_DIR's elevation, so re-angling the camera fails here rather than in a
  // screenshot nobody takes.
  const elevation = Math.asin(VIEW_DIR.y);
  const groundSwing = 1 / Math.tan(elevation);         // depth a tap crosses on flat road, per unit of radius
  const aoTraffic = createTraffic(makeRng(seed + 44), new THREE.Scene(), 8);
  const carBox = new THREE.Box3().setFromBufferAttribute(aoTraffic.mesh.geometry.attributes.position);
  const roofJump = (carBox.max.y - carBox.min.y) / Math.sin(elevation);
  check('the AO rejection window clears flat road and still rejects a car roofline',
    MAX_DEPTH_DIFF > groundSwing && RING_BROAD * MAX_DEPTH_DIFF < roofJump,
    `${groundSwing.toFixed(2)} < ${(RING_BROAD * MAX_DEPTH_DIFF).toFixed(2)} < ${roofJump.toFixed(2)}`);

  check('the tight ring sits inside the broad one',
    RING_TIGHT > 0 && RING_TIGHT < RING_BROAD && RING_TIGHT * MAX_DEPTH_DIFF < roofJump,
    `${RING_TIGHT} inside ${RING_BROAD}`);

  // Every render path has to run the pass. A frozen shot that skipped it would composite against
  // whatever the previous frame happened to leave in the AO texture.
  const aoMainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const outsideRenderFrame = aoMainSource.replace(/function renderFrame\(\)[\s\S]*?\n}/, '');
  check('every render goes through the AO pass',
    !/renderer\.render\(scene, camera\)/.test(outsideRenderFrame),
    'main.js renders only via renderFrame()');
}

// --- Crayon Mode ---------------------------------------------------------------
//
// game/crayon.js, the patch it adds to propMaterial(), and the edge channel it takes off the AO
// pass. Everything here fails silently in the same way the AO block above does — a replace that
// no longer matches, a cache key that collides, a page that reseeds under a screenshot — with the
// extra hazard that this pass paints over the entire picture, so "it looks a bit different" is
// not evidence either way.
{
  // The page. Baked on the CPU with no GL call in it, which is the whole reason `bakePaper` is a
  // function: a screenshot pair taken across a change to the city has to differ by the city, and
  // that is an assertion node can make.
  const paperA = bakePaper(64);
  const paperB = bakePaper(64);
  check('the paper bakes the same page every time',
    paperA.length === 64 * 64 * 4 && paperA.every((v, i) => v === paperB[i]),
    `${paperA.length} bytes, identical across two bakes`);

  // Every channel has to *have* a signal in it. A field that came out flat — a period that
  // divided wrong, an fbm normalised to nothing — is a texture that multiplies by a constant, and
  // a constant tooth is no tooth at all.
  const channels = [0, 1, 2, 3].map((c) => {
    const values = [];
    for (let i = c; i < paperA.length; i += 4) values.push(paperA[i]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const spread = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    return { mean, spread, min: Math.min(...values), max: Math.max(...values) };
  });
  check('every paper channel carries a signal, centred and unclipped',
    channels.every((c) => c.spread > 8 && c.mean > 70 && c.mean < 185
      && c.max - c.min > 100),
    channels.map((c) => `${c.mean.toFixed(0)}±${c.spread.toFixed(0)}`).join(' · '));

  // The seam. The tile is sampled in screen space with RepeatWrapping, so a field that does not
  // close on itself puts a hard edge every PAPER_SIZE pixels — a grid over the whole city, which
  // is the one thing a paper texture must not have. Measured as the step across the wrap against
  // the step between ordinary neighbours: the two should be the same size.
  const size = 64;
  const stepAcross = (channel) => {
    let wrap = 0;
    let inner = 0;
    for (let y = 0; y < size; y++) {
      wrap += Math.abs(paperA[(y * size + size - 1) * 4 + channel] - paperA[y * size * 4 + channel]);
      inner += Math.abs(paperA[(y * size + 1) * 4 + channel] - paperA[y * size * 4 + channel]);
    }
    return { wrap: wrap / size, inner: inner / size };
  };
  // Channels 0-2 wrap; 3 is the long fibre and is deliberately left open in y, so it is measured
  // across x only, where it does close.
  const seams = [0, 1, 2].map(stepAcross);
  check('the paper tiles without a seam',
    seams.every((s) => s.wrap <= s.inner * 1.6 + 2),
    seams.map((s) => `${s.wrap.toFixed(1)} vs ${s.inner.toFixed(1)}`).join(' · '));

  // The patch, run against a stub carrying the chunk names three's Lambert fragment shader
  // actually has — same trick as the AO block, and the same failure if a chunk moves.
  const stub = () => ({
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {}',
    fragmentShader: '#include <common>\nvoid main() {\n\t#include <aomap_fragment>\n'
      + '\t#include <opaque_fragment>\n\t#include <colorspace_fragment>\n\t#include <fog_fragment>\n}',
  });

  setAmbientOcclusion(false);
  setCrayon(true);
  const crayonMaterial = propMaterial();
  const crayonShader = stub();
  crayonMaterial.onBeforeCompile(crayonShader, null);

  check('the crayon patch reaches the Lambert fragment shader',
    crayonShader.fragmentShader.includes('uniform sampler2D tCrayonPaper')
    && /texture2D\(\s*tCrayonPaper/.test(crayonShader.fragmentShader)
    && /uCrayonGrain \*/.test(crayonShader.fragmentShader),
    'sampler declared and the tooth pressed in');

  // **The seam is the whole design.** By <fog_fragment> three has run the tonemap and the colour
  // space, so gl_FragColor is in display space — which is where a paint-like multiply belongs and
  // where "mid-tone" means what an eye means by it — and the haze has *not*, so a stroke at the
  // back of the city fades into the air exactly as the façade under it does. Hooked one chunk
  // later, at <dithering_fragment>, the same ink would draw at full strength over a hazed skyline.
  const crayonAt = crayonShader.fragmentShader.indexOf('uCrayonGrain *');
  check('the crayon body lands after the colour space and before the haze',
    crayonAt > crayonShader.fragmentShader.indexOf('#include <colorspace_fragment>')
    && crayonAt < crayonShader.fragmentShader.indexOf('#include <fog_fragment>'),
    'strokes are laid in display space and then hazed with everything else');

  // Value only, never chroma. Hue is content in this game — a fare's ring is its clock, yellow is
  // the player's car, cyan is a parcel — and the palette checks above assert measured hue
  // separations between them. Quantising rgb channel by channel, or touching saturation, would
  // walk straight through every one of those guarantees.
  // Scanned with the comments stripped, or the prose describing the pass fails the check on the
  // pass. Everything the shader *does* to colour has to be a scalar on `.rgb`.
  const crayonCode = crayonShader.fragmentShader.replace(/\/\/[^\n]*/g, '');
  check('the crayon patch moves value and never hue',
    /gl_FragColor\.rgb \*=/.test(crayonCode) && !/hsv|hsl|saturat/i.test(crayonCode),
    'rgb scaled by a scalar, so every channel ratio survives');

  // One shared uniform bag, not per-material copies — same contract as AO's, and the same failure
  // if Object.assign ever handed each shader its own object: the boil would advance for nobody.
  check('every crayon material reads the one shared uniform bag',
    crayonShader.uniforms.tCrayonPaper === CRAYON_UNIFORMS.tCrayonPaper
    && crayonShader.uniforms.uCrayonBoil === CRAYON_UNIFORMS.uCrayonBoil,
    'same uniform objects, not clones');

  // With AO off the pass still runs for the line, but its strength is pinned to zero and the
  // occlusion multiply is never compiled in — the fetch is absent rather than multiplied by one.
  check('crayon alone does not drag the AO multiply in with it',
    !crayonShader.fragmentShader.includes('reflectedLight.indirectDiffuse *='),
    '?crayon&ao=off compiles no occlusion term');

  // All four combinations have to key differently. This city is nothing but flat-shaded Lambert,
  // so two materials sharing a key are handed whichever program compiled first — the trap that
  // once drew the diamond's fill with a building's shader, and one that a second independent flag
  // makes twice as easy to fall into.
  const keyFor = (ao, crayon) => {
    setAmbientOcclusion(ao);
    setCrayon(crayon);
    const material = propMaterial();
    return typeof material.customProgramCacheKey === 'function'
      ? material.customProgramCacheKey() : null;
  };
  const keys = [keyFor(false, false), keyFor(true, false), keyFor(false, true), keyFor(true, true)];
  check('all four AO/crayon builds key to different programs',
    new Set(keys.map((k) => String(k))).size === 4,
    keys.map((k) => k ?? 'none').join(' · '));

  // And the patched pair still carries the AO term where it always was.
  const bothShader = stub();
  setAmbientOcclusion(true);
  setCrayon(true);
  propMaterial().onBeforeCompile(bothShader, null);
  check('AO and crayon compose rather than replacing one another',
    bothShader.fragmentShader.includes('reflectedLight.indirectDiffuse *=')
    && /texture2D\(\s*tCrayonPaper/.test(bothShader.fragmentShader),
    'both bodies present in one program');
  setCrayon(false);
  setAmbientOcclusion(false);

  // The edge channel. `g` is free — every fetch it needs was already made for the occlusion — but
  // it shares a shader with the term every contact shadow in the game is made of, so the thing
  // worth asserting is that the occlusion expression did not move.
  const ssaoSource = fs.readFileSync(new URL('../src/game/ssao.js', import.meta.url), 'utf8');
  // The tap budget, counted out of the shader rather than asserted as a number in a comment. The
  // line is not free — reusing the occlusion's own rings was free and drew a fifteen-pixel fringe
  // instead of a line — but it is bounded: one extra opposed pair in each axis, and no more.
  const callsTo = (name) => (ssaoSource.match(new RegExp(`${name}\\(z0,`, 'g')) || []).length;
  const tapsIn = (name) => {
    const body = ssaoSource.slice(ssaoSource.indexOf(`float ${name}(`));
    return (body.slice(0, body.indexOf('\n}')).match(/viewDepth\(/g) || []).length;
  };
  const taps = 1 + callsTo('pair') * tapsIn('pair') + callsTo('edgeAt') * tapsIn('edgeAt');
  check('the line costs one extra pair per axis and nothing more',
    callsTo('pair') === 4 && tapsIn('pair') === 2
    && callsTo('edgeAt') === 2 && tapsIn('edgeAt') === 2 && taps === 13,
    `${taps} fetches a pixel on a half-res pass: one centre, eight for occlusion, four for ink`);
  check('the occlusion term still writes red and the line writes green',
    /1\.0 - uStrength \* either\(tight, broad\),\s*\n\s*smoothstep\(EDGE_LOW, EDGE_HIGH, edge\)/
      .test(ssaoSource),
    'util/geo.js reads .r for occlusion and .g for ink');

  // The estimator, mirrored. `abs(a + b)` rather than `max(abs(a), abs(b))` is the whole reason
  // this can run with no normal buffer: under this camera flat ground recedes by cot(elevation)
  // per unit of radius, so either tap on its own is large *everywhere* and would ink the open
  // road solid. The sum is what cancels on any plane however steeply it recedes.
  const elev = Math.asin(VIEW_DIR.y);
  const swing = 1 / Math.tan(elev);
  const edgeOf = (a, b, radius) => Math.abs(a + b) * 0.5 / radius;
  const flatRoad = edgeOf(swing * RING_BROAD, -swing * RING_BROAD, RING_BROAD);
  const oneSided = Math.max(Math.abs(swing * RING_BROAD), Math.abs(-swing * RING_BROAD)) / RING_BROAD;
  check('flat ground cancels its own edge and a one-sided test would not',
    flatRoad < 1e-9 && oneSided > EDGE_LOW,
    `laplacian ${flatRoad.toFixed(6)}, one-sided ${oneSided.toFixed(2)} — over the ${EDGE_LOW} floor`);

  // Both bounds, recomputed from the camera and from the features either side of them rather than
  // trusted — the same discipline the rejection window above is checked with, and for the same
  // reason: re-angle the camera and this fails here rather than in a screenshot nobody took.
  const stepOf = (h) => edgeOf(0, h / Math.sin(elev), RING_BROAD);
  const paint = stepOf(0.05);                 // a stop bar: paint on the road, and not a contact
  const kerb = stepOf(KERB_H);                // where the pavement meets the tarmac
  // A 90-degree convex arris — a building's own vertical corner, and the commonest strong edge in
  // the city. Both neighbours recede from it, one across the ground and one up the wall.
  const arris = edgeOf(swing * RING_BROAD, RING_BROAD / Math.sin(elev), RING_BROAD);
  check('the ink ramp runs from over the road paint to under a building corner',
    EDGE_LOW > paint && kerb > EDGE_LOW && kerb < EDGE_HIGH && arris > EDGE_HIGH,
    `paint ${paint.toFixed(2)} < ramp ${EDGE_LOW}–${EDGE_HIGH} < arris ${arris.toFixed(2)}`
      + ` · kerb ${kerb.toFixed(2)} inside it`);

  // The boil. Ten steps a second is the difference between a hand redrawing the frame and
  // television static; it is a *rate*, so what matters is that it is well under the frame rate and
  // well over nothing.
  check('the boil runs slower than the frame and faster than a decal',
    CRAYON_DEFAULTS.boilHz > 4 && CRAYON_DEFAULTS.boilHz < 20,
    `${CRAYON_DEFAULTS.boilHz} steps a second against 60 frames`);

  // The page sits under every read-out. The transparent queue sorts by renderOrder and the ladder
  // is skid marks 2, dust 3, the route band 4, the drag handle 5, flames 6, the fare rings 7-9 —
  // so a page drawn above any of those is a tint over a clock, and a fare's hue is the time it has
  // left.
  const crayonSource = fs.readFileSync(new URL('../src/game/crayon.js', import.meta.url), 'utf8');
  const order = Number(crayonSource.match(/const PAPER_ORDER = (\d+)/)?.[1]);
  check('the paper draws under every game read-out',
    Number.isFinite(order) && order < 2,
    `renderOrder ${order}, below skid marks at 2`);

  // Screen-space, and sized in CSS pixels rather than device ones. `gl_FragCoord` is in device
  // pixels, so a tooth stated in texels halves on a DPR-2 phone and stops reading at all — the
  // same "size effects against the camera" rule one layer further out than usual.
  check('the tooth and the wobble are sized in CSS pixels',
    /uCrayonPaperScale\.value\.set\(\s*1 \/ \(PAPER_SIZE \* ratio\)/.test(crayonSource)
    && /uCrayonPixelRatio\.value = ratio/.test(crayonSource)
    && PAPER_SIZE >= 128,
    `a ${PAPER_SIZE}px tile, divided by the pixel ratio`);

  // Shot mode ticks the loop once and freezes, so anything driven off a clock is stuck on its
  // first frame — which for the boil is exactly right, and only because the step is set at
  // construction rather than on the first update. An entrance that opens at zero is the trap this
  // is the other side of.
  check('a frozen shot renders a settled page',
    /setStep\(0\);/.test(crayonSource) && /prepare\(\)/.test(crayonSource),
    'the boil starts on a real step and prepare() runs from renderFrame()');

  // Every render path has to size the page, for the same reason every one has to run the AO pass:
  // shot mode and __taxi.redraw() both reach a render without ever reaching the frame loop.
  const crayonMainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  check('every render goes through the crayon prepare',
    /function renderFrame\(\)[\s\S]*?crayon\.prepare\(\)[\s\S]*?renderer\.render/
      .test(crayonMainSource),
    'main.js sizes the page inside renderFrame()');
}

// --- Cartoon Mode --------------------------------------------------------------
//
// game/cartoon.js, the cel bands and ink it adds to propMaterial(), and the hero hulls. Two of the
// checks here are the two bugs this actually shipped with and had to be caught by looking:
// outlining every *part* of a vehicle, and drawing a scale-inflated hull without masking it out of
// its own silhouette.
{
  const stub = () => ({
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {}',
    fragmentShader: '#include <common>\nvoid main() {\n\t#include <aomap_fragment>\n'
      + '\t#include <lights_fragment_end>\n\t#include <opaque_fragment>\n'
      + '\t#include <colorspace_fragment>\n\t#include <fog_fragment>\n}',
  });

  setAmbientOcclusion(false);
  setCrayon(false);
  setCartoon(true);
  const toonShader = stub();
  propMaterial().onBeforeCompile(toonShader, null);

  check('the cartoon patch reaches the Lambert fragment shader',
    toonShader.fragmentShader.includes('uniform float uToonCel')
    && /uToonSteps/.test(toonShader.fragmentShader)
    && /texture2D\(tAmbientOcclusion[\s\S]*?\)\.g/.test(toonShader.fragmentShader),
    'cel bands and the edge lookup both spliced in');

  // The cel bands go where the direct term is *finished* — after lights_fragment_end, which is the
  // first point the shadow map has been multiplied in. Earlier and the terminator bands the raw
  // N-dot-L with a soft shadow laid over it, which is the one combination that reads as neither.
  // The *body*, not the uniform declaration — both names appear up by `<common>` first, and an
  // indexOf that found the declaration would pass this check against a patch spliced anywhere.
  const celAt = toonShader.fragmentShader.indexOf('reflectedLight.directDiffuse *= mix(');
  const inkAt = toonShader.fragmentShader.indexOf('smoothstep(uToonBite');
  check('the bands land on the finished direct term and the ink lands before the haze',
    celAt > toonShader.fragmentShader.indexOf('#include <lights_fragment_end>')
    && celAt < toonShader.fragmentShader.indexOf('#include <opaque_fragment>')
    && inkAt > toonShader.fragmentShader.indexOf('#include <colorspace_fragment>')
    && inkAt < toonShader.fragmentShader.indexOf('#include <fog_fragment>'),
    'shadow included in the banding, ink hazed with the wall it traces');

  // Value only, never hue — the same guarantee the crayon carries, and it matters more here: the
  // bands are a big move, and a cartoon that shifted chroma would walk straight through the hue
  // separations palette.js encodes and probe.mjs asserts above.
  const toonCode = toonShader.fragmentShader.replace(/\/\/[^\n]*/g, '');
  check('the cel bands move value and never hue',
    /reflectedLight\.directDiffuse \*= mix\(/.test(toonCode)
    && !/hsv|hsl|saturat/i.test(toonCode),
    'the direct term is scaled by a scalar, so every channel ratio survives');

  check('every cartoon material reads the one shared uniform bag',
    toonShader.uniforms.uToonCel === CARTOON_UNIFORMS.uToonCel
    && toonShader.uniforms.uToonInkColor === CARTOON_UNIFORMS.uToonInkColor,
    'same uniform objects, not clones');

  // Eight combinations now, and every one has to key to its own program. This city is nothing but
  // flat-shaded Lambert, so two builds sharing a key are handed whichever compiled first — and a
  // third independent flag makes that three times easier to fall into than when it was just AO.
  const keys = [];
  for (const ao of [false, true]) {
    for (const cray of [false, true]) {
      for (const toon of [false, true]) {
        setAmbientOcclusion(ao);
        setCrayon(cray);
        setCartoon(toon);
        const material = propMaterial();
        keys.push(typeof material.customProgramCacheKey === 'function'
          ? material.customProgramCacheKey() : 'none');
      }
    }
  }
  check('all eight AO/crayon/cartoon builds key to different programs',
    new Set(keys.map(String)).size === 8, keys.map(String).join(' · '));
  setAmbientOcclusion(false);
  setCrayon(false);
  setCartoon(false);

  // --- The hero hulls.
  //
  // **One hull per vehicle, on its body.** Outlining every part is the obvious thing and it is what
  // this shipped with: a rim stated in world units is a fraction of a body and a multiple of a trim
  // strip, and the taxi carries two 3.46 x 0.54 bars down its flanks whose hulls inflate the thin
  // axes by two thirds. Eight hulls on one taxi rendered as a black brick with yellow showing
  // through the cracks between them.
  const toonTaxi = createTaxiMesh();
  const made = outlineRoot(toonTaxi.group, { rim: TAXI_RIM });
  const outlineMeshes = [];
  toonTaxi.group.traverse((o) => {
    if (o.name === 'toonOutline' || o.name === 'toonOutlineMask') outlineMeshes.push(o);
  });
  const shell = made[0]?.hull?.parent ?? null;
  const lit = [];
  toonTaxi.group.traverse((o) => {
    if (o.isMesh && o.material?.isMeshLambertMaterial && !o.name.startsWith('toon')) lit.push(o);
  });
  const bulkOf = (mesh) => {
    mesh.geometry.computeBoundingBox();
    const size = mesh.geometry.boundingBox.getSize(new THREE.Vector3());
    return size.x * size.y * size.z;
  };
  check('a vehicle gets exactly one outline, on its biggest part',
    made.length === 1 && outlineMeshes.length === 2 && lit.length > 1
    && shell && lit.every((m) => bulkOf(m) <= bulkOf(shell)),
    `${lit.length} lit parts on the taxi, one outlined at ${bulkOf(shell).toFixed(1)} cubic units`);

  // The rim is a scale-inflated copy of a **non-convex** body, so it is not an offset surface: the
  // hull's cabin ends up standing over the real boot, nearer the camera, and an ordinary depth test
  // paints it black. The stencil mask is what makes this an outline rather than a repaint, and both
  // halves of the test are silent when wrong.
  const rimMaterial = made[0].hull.material;
  check('the rim is masked out of its own silhouette',
    rimMaterial.stencilWrite === true
    && rimMaterial.stencilFunc === THREE.NotEqualStencilFunc
    && rimMaterial.stencilRef === GHOST_REF
    && made[0].mask.material.colorWrite === false,
    'pass 1 stamps the body footprint, pass 2 draws only outside it');

  // ...and it is an *ordinary* depth test, unlike the ghost outline's. The ghost draws only where
  // something is in front of it, because it is a see-through-walls signal; this is ink on a visible
  // car and has to be hidden by the tower the car drives behind.
  check('the ink is occluded by the city, unlike the ghost rim it borrows from',
    rimMaterial.depthFunc !== THREE.GreaterDepth && rimMaterial.side === THREE.BackSide,
    'normal depth test, back faces only');

  // The tiers sit below the ghost outline's four. The stencil buffer is never cleared mid-frame, so
  // this ordering is the contract that keeps the two systems from eating each other.
  check('the outline resolves before the ghost outline stamps anything',
    made[0].mask.renderOrder < made[0].hull.renderOrder
    && made[0].hull.renderOrder < GHOST_MASK_ORDER,
    `${made[0].mask.renderOrder}/${made[0].hull.renderOrder} below ${GHOST_MASK_ORDER}`);

  // A hull is a bigger copy of a mesh that already casts a shadow. Inheriting it fattens every
  // shadow in the city by the outline's width and stamps a second one from the mask.
  check('no outline casts a shadow',
    outlineMeshes.every((m) => m.castShadow === false),
    `${outlineMeshes.length} outline meshes, none casting`);

  // **Order matters against markOccluder**, and getting it wrong is invisible in a still: a hull in
  // the depth prepass stamps a silhouette a rim bigger than the car, so the city's own screen-space
  // line would trace the outline instead of the vehicle.
  const occluderTaxi = createTaxiMesh();
  markOccluder(occluderTaxi.group);
  const beforeOutline = occluderList().size;
  outlineRoot(occluderTaxi.group, { rim: TAXI_RIM });
  check('outlining after markOccluder keeps hulls out of the depth prepass',
    occluderList().size === beforeOutline,
    `${beforeOutline} occluders, unchanged by the outline`);
  unmarkOccluder(occluderTaxi.group);

  // --- The fleet.
  //
  // The whole efficiency claim is that the pools share traffic's *own* matrices rather than copying
  // them. A copy would mean walking every car every frame to duplicate a matrix that already
  // exists, and one that fell a frame behind shows as ink sliding off the cars.
  const toonTraffic = createTraffic(makeRng(seed + 44), new THREE.Scene(), 8);
  const pooled = instancedOutline(toonTraffic.mesh);
  check('the fleet outline shares traffic own instance matrices',
    pooled.mask.instanceMatrix === toonTraffic.mesh.instanceMatrix
    && pooled.hull.instanceMatrix === toonTraffic.mesh.instanceMatrix
    && pooled.mask.geometry === toonTraffic.mesh.geometry,
    'no copies: two draw calls and no per-frame matrix work');

  // Both pools, and the source, must agree about culling. Three caches an InstancedMesh's bounding
  // sphere from the matrices as they stood on the first frame it culled — so a rim that survived a
  // frame its mask was culled on would draw as a *filled* silhouette rather than an outline.
  check('mask and rim can never be culled apart',
    pooled.mask.frustumCulled === false && pooled.hull.frustumCulled === false
    && toonTraffic.mesh.frustumCulled === false,
    'culling off on the source and on both pools');

  // `count` is not a property three watches, and traffic moves it at runtime — a truck spawning, or
  // the panel car slider. Left behind, the hull draws the fleet high-water mark: collapsed matrices
  // at the world origin, which is a knot of ink under the middle of the city.
  const toonMode = createCartoon({ enabled: true });
  const [fleetMask, fleetHull] = toonMode.fleet(toonTraffic.mesh);
  const bornAt = fleetHull.count;
  toonTraffic.mesh.count = 3;
  toonMode.update();
  check('the fleet outline follows its source count',
    bornAt === toonTraffic.ambient.length && fleetHull.count === 3 && fleetMask.count === 3,
    `born at ${bornAt}, both pools follow the source to 3`);

  // And the rim clamp, which is what stops one number describing a body from doubling a small part
  // it also lands on.
  check('an outline can never be more than a third of the part it wraps',
    clampRim(toonTaxi.sign.geometry, TAXI_RIM) < TAXI_RIM
    && clampRim(toonTraffic.mesh.geometry, HERO_RIM) === HERO_RIM,
    `sign clamped to ${clampRim(toonTaxi.sign.geometry, TAXI_RIM).toFixed(3)}, a car body left at ${HERO_RIM}`);

  // The two rims are the look, and the ratio between them is what says which car is the player's.
  check('the taxi is inked more heavily than the traffic it drives through',
    TAXI_RIM > HERO_RIM && TAXI_RIM / HERO_RIM < 2,
    `${TAXI_RIM} against ${HERO_RIM}, and 1.18x again through TAXI_SCALE`);

  // --- The live rim.
  //
  // The inflation moved out of the geometry and into the vertex shader so the ⚙️ panel can scrub
  // it. That is a maths change disguised as a plumbing change, so the claim worth pinning is that
  // it reproduces what it replaced: `position + aInflate * r`, floor-clamped, has to equal
  // `inflatedGeometry(geometry, r)` for *any* r, not just the one it shipped with.
  const rimSource = createTaxiMesh();
  let rimBody = null;
  rimSource.group.traverse((o) => {
    if (o.isMesh && o.material?.isMeshLambertMaterial
      && (!rimBody || bulkOf(o) > bulkOf(rimBody))) rimBody = o;
  });
  const shaderGeo = outlineGeometry(rimBody.geometry);
  const inflate = shaderGeo.attributes.aInflate;
  const worst = [0.05, TAXI_RIM, 0.6].map((r) => {
    const baked = inflatedGeometry(rimBody.geometry, r).attributes.position;
    const base = shaderGeo.attributes.position;
    let error = 0;
    for (let v = 0; v < base.count; v += 1) {
      const x = base.getX(v) + inflate.getX(v) * r;
      const y = Math.max(base.getY(v) + inflate.getY(v) * r, shaderGeo.userData.floorY);
      const z = base.getZ(v) + inflate.getZ(v) * r;
      error = Math.max(error,
        Math.abs(x - baked.getX(v)), Math.abs(y - baked.getY(v)), Math.abs(z - baked.getZ(v)));
    }
    return error;
  });
  check('the shader rim reproduces the baked inflation at every width',
    worst.every((e) => e < 1e-5),
    `worst vertex error ${Math.max(...worst).toExponential(1)} across 0.05, ${TAXI_RIM} and 0.6`);

  // Offset by *position*, never by normal. Every mesh here is non-indexed and flat-shaded, so a
  // shared corner is several vertices carrying several normals — offsetting along those tears the
  // hull open at every hard edge, which is the trap `jitterVertices` records one layer down.
  const cornerKeys = new Map();
  const basePos = shaderGeo.attributes.position;
  let split = 0;
  for (let v = 0; v < basePos.count; v += 1) {
    const key = `${basePos.getX(v).toFixed(4)},${basePos.getY(v).toFixed(4)},${basePos.getZ(v).toFixed(4)}`;
    const dir = `${inflate.getX(v).toFixed(5)},${inflate.getY(v).toFixed(5)},${inflate.getZ(v).toFixed(5)}`;
    if (cornerKeys.has(key) && cornerKeys.get(key) !== dir) split += 1;
    cornerKeys.set(key, dir);
  }
  check('a shared corner offsets one way, so the hull cannot tear',
    split === 0 && cornerKeys.size < basePos.count,
    `${basePos.count - cornerKeys.size} duplicated corners, ${split} disagreeing`);

  // The vertex patch itself, against a stub carrying the chunk names three's shader actually has —
  // and the cache key, which matters more here than almost anywhere: this is a plain
  // MeshBasicMaterial in a project full of them, so without a key of its own an outline hull is
  // handed whichever unpatched basic compiled first and draws at rim zero, invisible, silently.
  const rimMat = toonOutlineMaterial({ rim: 0.3, floorY: 0.1 });
  const rimShader = {
    uniforms: {},
    vertexShader: '#include <common>\nvoid main() {\n\t#include <begin_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main() {}',
  };
  rimMat.onBeforeCompile(rimShader, null);
  const plainUnlit = unlitMaterial({});
  check('the outline vertex patch lands and cannot collide with a plain basic material',
    rimShader.vertexShader.includes('attribute vec3 aInflate')
    && /transformed \+= aInflate \* uToonRim/.test(rimShader.vertexShader)
    && /transformed\.y = max\(/.test(rimShader.vertexShader)
    && rimMat.customProgramCacheKey() !== (plainUnlit.customProgramCacheKey?.() ?? null),
    `keyed "${rimMat.customProgramCacheKey()}"`);

  // The taxi and the traffic are scrubbed apart. A single rim would collapse the one distinction
  // the mode exists to make — a hero reads as a hero because its ink is heavier than everything
  // else's — so the panel drives two groups and `set` must not cross them.
  const groups = createCartoon({ enabled: true });
  const taxiPair = groups.outline(createTaxiMesh().group, { group: 'taxi' })[0];
  const heroPair = groups.outline(createTaxiMesh().group, { group: 'hero' })[0];
  groups.set('taxiRim', 0.5);
  const taxiRimUniform = () => taxiPair.hull.material.userData.toon.uToonRim.value;
  const heroRimUniform = () => heroPair.hull.material.userData.toon.uToonRim.value;
  check('the taxi rim and the traffic rim move independently',
    taxiRimUniform() > heroRimUniform() && heroRimUniform() === HERO_RIM,
    `taxi ${taxiRimUniform()} against traffic ${heroRimUniform()}`);

  // ...and a rim is clamped against the part it is written onto, not once at construction. A
  // slider hands one number to a group whose members are different sizes, and MAX_RIM_FRACTION is
  // a statement about a part: dragged past what the smallest of them can carry, that one stops and
  // the rest keep going.
  groups.set('taxiRim', 99);
  check('a rim can never grow past the part it wraps',
    taxiRimUniform() === taxiPair.hull.geometry.userData.maxRim
    && taxiRimUniform() < 99,
    `capped at ${taxiRimUniform().toFixed(3)} for a body that size`);

  // One ink, two places it is drawn, two colour spaces. Handed over unconverted the screen-space
  // line comes out far darker than the hulls drawn from the identical value — which is the tell,
  // and the reason this is asserted rather than eyeballed.
  groups.set('inkColor', '#804020');
  const hullInk = taxiPair.hull.material.color;
  const lineInk = CARTOON_UNIFORMS.uToonInkColor.value;
  check('the hulls and the city line always draw the same ink',
    Math.abs(hullInk.r - new THREE.Color('#804020').r) < 1e-6
    && lineInk.r > hullInk.r
    && Math.abs(lineInk.r - new THREE.Color('#804020').clone().convertLinearToSRGB().r) < 1e-6,
    'material colour linear, line uniform re-encoded to sRGB');

  groups.set('inkOpacity', 0.4);
  check('ink opacity reaches every hull',
    taxiPair.hull.material.opacity === 0.4 && heroPair.hull.material.opacity === 0.4,
    'both groups follow one slider');
}

// --- Atmospheric perspective --------------------------------------------------
//
// The haze over the back of the frame (game/scene.js). Every number here is re-derived from a real
// frustum rather than read back off the fog object, because the whole feature is one claim about
// where the ramp sits relative to the picture: place the band wrong and the failure is either a
// flat wash over the entire city — the thing the old "an ortho camera can't have fog" note was
// afraid of — or nothing visible at all. Both look like "fog didn't work" in a screenshot.
{
  const smoothstep = (a, b, x) => {
    const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  // Haze on a world point, read exactly as the shader reads it: view-space depth through a real
  // camera matrix, then three's own linear-fog curve.
  const hazeAt = (controller, fog, x, y, z) => {
    controller.camera.updateMatrixWorld();
    const depth = -new THREE.Vector3(x, y, z)
      .applyMatrix4(controller.camera.matrixWorldInverse).z;
    return smoothstep(fog.near, fog.far, depth);
  };

  const world = createScene({ shadowMapSize: 0 });
  const cam = createCityCamera(0.5, { zoom: PLAY_ZOOM });
  cam.update(0.5);

  // The claim DEPTH_PER_SCREEN_UNIT rests on: screen-right is perpendicular to the view direction,
  // so moving across the frame changes nothing about how far away a thing is. Without it the haze
  // would lean with the diagonal instead of banding.
  check('screen-right carries no depth, so the haze is a vertical gradient',
    Math.abs(RIGHT.dot(VIEW_DIR)) < 1e-12,
    `RIGHT·VIEW_DIR = ${RIGHT.dot(VIEW_DIR).toExponential(1)}`);

  // A ground point at the top or bottom edge of the frame, at any pan. `zoom` is the frame's
  // half-height in world units of *screen*, and a ground step is foreshortened by VIEW_DIR.y.
  const frameEdge = (controller, sign) => {
    const reach = (sign * controller.state.zoom) / VIEW_DIR.y;
    return {
      x: controller.state.target.x + UP.x * reach,
      z: controller.state.target.z + UP.z * reach,
    };
  };

  const bottom = frameEdge(cam, -1);
  const top = frameEdge(cam, +1);
  check('the near edge of the play frame is perfectly clear',
    hazeAt(cam, world.fog, bottom.x, 0, bottom.z) < 1e-6,
    `depth ${(DISTANCE - PLAY_ZOOM * DEPTH_PER_SCREEN_UNIT).toFixed(1)} sits on the near plane`);
  check('the far edge of the play frame carries exactly HAZE_TOP',
    Math.abs(hazeAt(cam, world.fog, top.x, 0, top.z) - HAZE_TOP) < 1e-4,
    `${hazeAt(cam, world.fog, top.x, 0, top.z).toFixed(4)} against ${HAZE_TOP}`);

  // Pan-invariance, which is the whole reason the band is anchored on the frame rather than on the
  // map. The camera and its target move together, so the depth of the bottom edge of the screen is
  // a constant — a player who has panned to the corner still gets a clear foreground, and the haze
  // can never creep forward onto the taxi.
  cam.state.target.set(HALF_SPAN_X, 0, -HALF_SPAN_Z);
  cam.update(0.5);
  const pannedBottom = frameEdge(cam, -1);
  const pannedTop = frameEdge(cam, +1);
  check('panning to the map edge moves neither end of the ramp',
    hazeAt(cam, world.fog, pannedBottom.x, 0, pannedBottom.z) < 1e-6
    && Math.abs(hazeAt(cam, world.fog, pannedTop.x, 0, pannedTop.z) - HAZE_TOP) < 1e-4,
    'the frame carries its own depth band');

  // And nothing in the city ever wears more than the number that was tuned. The far corner of the
  // map sits at depth 465 against the frame's 480, which is the coincidence that lets one constant
  // be stated about the picture and be true of the whole board.
  const home = createCityCamera(0.5, { zoom: PLAY_ZOOM });
  home.update(0.5);
  let worst = 0;
  for (const x of [-HALF_SPAN_X, HALF_SPAN_X]) {
    for (const z of [-HALF_SPAN_Z, HALF_SPAN_Z]) worst = Math.max(worst, hazeAt(home, world.fog, x, 0, z));
  }
  // Both bounds stated *relative to HAZE_TOP*, which is the point: the corner has to sit inside the
  // band the constant is declared about, and it has to be a real fraction of it rather than a
  // rounding error. An absolute floor here went red the first time the strength was retuned, which
  // is a check reporting its own staleness rather than a fact about the city.
  check('no corner of the city is hazier than the frame edge it was tuned against',
    worst > HAZE_TOP * 0.6 && worst <= HAZE_TOP,
    `worst corner ${worst.toFixed(3)}, ${(worst / HAZE_TOP).toFixed(2)} of the frame edge's ${HAZE_TOP}`);

  // The wreck close-up (zoom 26) and the far end of the wheel. A frame that spans less depth gets
  // less haze across it, which is what a shorter column of air should do — and the ramp must not
  // run away at the other end either.
  const closeUp = createCityCamera(0.5, { zoom: 26 });
  closeUp.update(0.5);
  const closeTop = frameEdge(closeUp, +1);
  const closeBottom = frameEdge(closeUp, -1);
  const closeSpread = hazeAt(closeUp, world.fog, closeTop.x, 0, closeTop.z)
    - hazeAt(closeUp, world.fog, closeBottom.x, 0, closeBottom.z);
  check('a close-up spans less haze than the play frame',
    closeSpread > 0.05 && closeSpread < HAZE_TOP,
    `${closeSpread.toFixed(3)} across the wreck zoom`);

  // The band's own arithmetic, at the two zooms the game actually uses it at. `far` is a ramp
  // length rather than a distance anything is drawn at, and a sign slip there reads as no fog.
  const band = hazeRange();
  check('the fog band is placed around the camera standoff, not from the eye',
    band.near > DISTANCE * 0.75 && band.near < DISTANCE && band.far > band.near,
    `${band.near.toFixed(0)} → ${band.far.toFixed(0)} on a ${DISTANCE}-unit standoff`);
  check('asking for no haze pushes the ramp past anything drawn',
    hazeRange(0).far > 1e5, `${hazeRange(0).far.toExponential(1)}`);

  // --- The colour.
  //
  // Two failure modes, and the haze shipped with the second one. It has to **follow the sky**, or
  // the whole effect inverts after dark — a pale blue wash over a midnight city lights the back of
  // the board brighter than the front. And it has to **carry chroma**, or it is a value wash: the
  // horizon this originally used is a near-white, and a near-white can only take colour away, which
  // is what made the far city read as black-and-white rather than as distant. Both are checked
  // across the keyframes rather than at the parked hour, since dusk is where they pull apart.
  {
    const dayWorld = createScene({ shadowMapSize: 0 });
    const daylight = createDaylight(dayWorld);
    // Channel spread in the *displayed* colour, which is where "reads as grey" is decided.
    const spread = (c) => {
      const ch = c.getHexString().match(/../g).map((h) => parseInt(h, 16));
      return Math.max(...ch) - Math.min(...ch);
    };
    const hsl = { h: 0, s: 0, l: 0 };
    let worstHueDrift = 0;
    let leastChroma = 255;
    let worstChromaRatio = Infinity;
    let darkest = 1;
    let duskWarm = true;
    for (const hour of [0, 5, 6.5, 9, 13, 16.4, 18.6, 20, 23]) {
      daylight.apply(hour);
      const fog = dayWorld.fog.color;
      const sky = hazeColor(
        dayWorld.sky.uniforms.topColor.value, dayWorld.sky.uniforms.bottomColor.value,
      );
      // Hue against the sky sample the colour is built from: saturation moves, hue must not, or an
      // orange dusk would come out blue.
      fog.getHSL(hsl);
      const fogHue = hsl.h;
      sky.getHSL(hsl);
      const wrap = Math.abs(fogHue - hsl.h);
      worstHueDrift = Math.max(worstHueDrift, Math.min(wrap, 1 - wrap));
      leastChroma = Math.min(leastChroma, spread(fog));
      // The ratio is only asked of the hours whose horizon is *itself* near-neutral, which is
      // where the grey came from. A dawn horizon is already 112 points of orange and sampling the
      // dome above it necessarily spends some of that — nothing is wrong there, and demanding a
      // gain at every hour is what made a first version of this check red.
      const horizonChroma = spread(dayWorld.sky.uniforms.bottomColor.value);
      if (horizonChroma < 40) {
        worstChromaRatio = Math.min(worstChromaRatio, spread(fog) / Math.max(1, horizonChroma));
      }
      darkest = Math.min(darkest, (fog.getHSL(hsl), hsl.l));
      if (hour === 18.6) duskWarm = fog.r > fog.b;
    }
    check('the haze is built from the sky, hue for hue, at every hour of the day',
      worstHueDrift < 1e-9, `worst hue drift ${worstHueDrift.toExponential(1)}`);
    check('and carries real chroma rather than washing the far city grey',
      leastChroma > 30 && worstChromaRatio > 1.25,
      `least spread ${leastChroma} of 255; `
      + `${worstChromaRatio.toFixed(2)}x the horizon wherever the horizon is itself near-neutral`);
    // **The dusk trade-off, pinned rather than asserted away.** At 18:36 the dome runs orange at the
    // bottom to deep blue at the top, so how much sunset survives in the haze is entirely a
    // question of how far up `skyH` samples. At the zenith the haze is blue while the horizon
    // behind it is still orange — an inversion of what air does at dusk — and that was accepted
    // for a while, because the shipped look is 16:24 with the cycle off where a high sample is the
    // whole point.
    //
    // The shipped 0.73 has walked most of the way back from that without giving up the parked
    // hour's blue, and it lands almost exactly on the tipping point: **warm by 6 parts in 255**,
    // which is neutral in the hand rather than a restored sunset. Measured across the slider at
    // 18:36 — 1.00 #004788 (cool by 62), 0.73 #8a4d84 (warm by 6), 0.60 #a74162 (68),
    // 0.50 #bb3635 (117), 0.35 #d05600 (161).
    //
    // So this pins three things: the inversion is real at the top of the range, the shipped value
    // is on the knife edge, and the escape hatch to a genuine sunset is still one slider away. Move
    // `HAZE_SKY_H` more than a hair and it goes red — correctly, because the note above it would
    // then be describing a game that no longer exists.
    daylight.apply(18.6);
    const duskSky = [
      dayWorld.sky.uniforms.topColor.value, dayWorld.sky.uniforms.bottomColor.value,
    ];
    const duskAt = (skyH) => {
      hazeTuning.skyH = skyH;
      const sampled = hazeColor(...duskSky);
      hazeTuning.skyH = HAZE_SKY_H;
      return sampled;
    };
    const duskZenith = duskAt(1);
    const duskShipped = dayWorld.fog.color.clone();
    const duskLower = duskAt(0.35);
    const margin = (c) => Math.round((c.r - c.b) * 255);
    check('the sky sample sets how much sunset survives, and the shipped one sits on the knife edge',
      duskZenith.b > duskZenith.r
        && duskWarm && Math.abs(margin(duskShipped)) < 20
        && margin(duskLower) > 100,
      `zenith #${duskZenith.getHexString()} cool by ${-margin(duskZenith)}, `
      + `shipped #${duskShipped.getHexString()} warm by ${margin(duskShipped)}, `
      + `0.35 #${duskLower.getHexString()} warm by ${margin(duskLower)}`);
    check('a night haze is dark rather than a pale wash over a dark city',
      darkest < 0.12, `darkest lightness ${darkest.toFixed(3)}`);
    // The two colour knobs have to stay *live* state, not constants folded back into hazeColor():
    // the ⚙️ panel writes this object and nothing else, so a refactor that inlines the numbers
    // again would leave three sliders that move and do nothing.
    {
      // Back to the parked hour: the loop above left the sky at 23:00, and the skyTop identity
      // below is stated about the palette's own colours.
      daylight.apply(16.4);
      const sky = { top: dayWorld.sky.uniforms.topColor.value, bottom: dayWorld.sky.uniforms.bottomColor.value };
      const before = hazeColor(sky.top, sky.bottom).getHexString();
      hazeTuning.skyH = 1;
      hazeTuning.saturation = 1;
      const tweaked = hazeColor(sky.top, sky.bottom).getHexString();
      hazeTuning.skyH = HAZE_SKY_H;
      hazeTuning.saturation = HAZE_SATURATION;
      const restored = hazeColor(sky.top, sky.bottom).getHexString();
      check('the haze colour reads its tuning live, so the panel sliders reach it',
        tweaked !== before && restored === before,
        `${before} → ${tweaked} → ${restored}`);
      // At the top of the dome with no lift, the answer is the sky's top colour exactly — which is
      // the arithmetic stated in one line, and how the panel's own readback was confirmed.
      check('and degenerates to the sky itself at skyH 1, saturation 1',
        `#${tweaked.toUpperCase()}` === PALETTE.skyTop, `${tweaked} against ${PALETTE.skyTop}`);
    }

    check('the parked palette entry is the haze it stands in for',
      `#${createScene({ shadowMapSize: 0 }).fog.color.getHexString().toUpperCase()}` === PALETTE.fog,
      `${PALETTE.fog}, against a horizon of ${PALETTE.skyBottom}`);
  }

  // --- Unlit means unfogged.
  //
  // The rule `unlitMaterial()` (util/geo.js) carries: a marker's whole content is its hue, and a
  // hue mixed toward the sky by distance is a clock reporting the wrong time. Checked on the real
  // materials rather than on the helper, since what matters is that the markers went through it.
  check('the sky dome takes no fog',
    world.sky.fog === false, 'a fogged backdrop would flatten its own gradient');
  check('a fare disc takes no haze',
    createTargetRing(PALETTE.urgency[4]).group.children.every((m) => m.material.fog === false),
    'rim, fill and sweep');
  const crystal = createDiamond(PALETTE.urgency[4]);
  check("a fare's crystal takes no haze either, lit though it is",
    crystal.mesh.material.fog === false && crystal.rim.material.fog === false,
    'the hue is the clock');
  check('a courier pad takes no haze',
    createParcelPad(PALETTE.parcel).group.children.every((m) => m.material.fog === false));
  check('the city itself does take it',
    propMaterial().fog === true, 'everything lit is in the air');

  // The half of the rule a runtime check cannot reach: whatever gets added next. Every unlit
  // material in the game has to come through the one helper, and the only exemption is an
  // invisible raycast box — which draws nothing there is anything to fog.
  const strays = [];
  for (const file of fs.readdirSync(new URL('../src', import.meta.url), { recursive: true })) {
    if (!String(file).endsWith('.js') || String(file) === 'util/geo.js') continue;
    const text = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    // The constructor and the ~120 characters after it, so `visible: false` is in reach.
    for (const m of text.matchAll(/new THREE\.MeshBasicMaterial\(([\s\S]{0,120})/g)) {
      if (!/visible:\s*false/.test(m[1])) strays.push(String(file));
    }
  }
  check('every unlit material goes through unlitMaterial()',
    strays.length === 0, strays.length ? `bare in ${strays.join(', ')}` : 'no bare MeshBasicMaterial');
}

// --- Nearby-traffic ghost outlines --------------------------------------------
//
// The instanced variant (game/carghosts.js). Same reasoning as the block above — the material
// flags ARE the behaviour and every failure mode is silent — plus two things the taxi's outline
// never had to worry about: which cars get picked, and whether the pool's matrices agree with the
// cars they are supposed to be tracing. A one-frame lag or a transposed wheel index looks like a
// broken outline in a screenshot and like nothing at all anywhere else.
{
  const gScene = new THREE.Scene();
  // Full density, not CARS_DEFAULT's low-density baseline: the whole thing under test is *which*
  // cars get picked out of a crowd, and at 7 cars on a 100-unit map the radius is usually empty.
  const gTraffic = createTraffic(makeRng(seed + 44), gScene, 24);
  const ghosts = createCarGhosts(gScene, gTraffic);
  gTraffic.warmup(30);

  const { bodyMask, wheelMask, bodyRim } = ghosts;
  const perCar = gTraffic.wheelsPerCar;

  check('car ghost pool is sized to the cap',
    bodyMask.instanceMatrix.count === MAX_GHOSTS && bodyRim.instanceMatrix.count === MAX_GHOSTS
    && wheelMask.instanceMatrix.count === MAX_GHOSTS * perCar,
    `${MAX_GHOSTS} bodies, ${MAX_GHOSTS * perCar} wheels`);

  // Three computes an InstancedMesh's bounding sphere once and caches it. Every slot starts
  // collapsed at the origin, so culling against that sphere drops the pool the moment the origin
  // leaves frame — and mask and rim culling *differently* is a filled ghost, not a missing one.
  const pool = [bodyMask, wheelMask, bodyRim];
  check('car ghosts never frustum-cull',
    pool.every((m) => m.frustumCulled === false && !m.castShadow),
    'culling off, no shadows borrowed from the traffic meshes');

  // The load-bearing ordering. The taxi's rim has to resolve before a single traffic mask exists in
  // the stencil buffer, or a car sliding past at a couple of units bites a chunk out of the
  // player's own outline on exactly the frame they need it.
  check('taxi ghost resolves before any traffic mask stamps',
    GHOST_MASK_ORDER < GHOST_RIM_ORDER && GHOST_RIM_ORDER < CAR_GHOST_MASK_ORDER
    && CAR_GHOST_MASK_ORDER < CAR_GHOST_RIM_ORDER
    && bodyMask.renderOrder === CAR_GHOST_MASK_ORDER && wheelMask.renderOrder === CAR_GHOST_MASK_ORDER
    && bodyRim.renderOrder === CAR_GHOST_RIM_ORDER,
    `${GHOST_MASK_ORDER} < ${GHOST_RIM_ORDER} < ${CAR_GHOST_MASK_ORDER} < ${CAR_GHOST_RIM_ORDER}`);

  // Same stencil pairing as the taxi's, and the SAME ref — one ref across every ghost is what stops
  // one traced car's rim painting over another's visible bodywork. Assert it rather than leave it
  // to be "fixed" into per-car refs, which cannot be done without one draw call per ghost.
  const taxiMask = [];
  createTaxiMesh().group.traverse((n) => { if (n.name === 'ghostMask') taxiMask.push(n); });
  const flagsOk = bodyRim.material.depthFunc === THREE.GreaterDepth
    && bodyRim.material.depthWrite === false && bodyRim.material.side === THREE.BackSide
    && bodyRim.material.stencilFunc === THREE.NotEqualStencilFunc
    && [bodyMask, wheelMask].every((m) => m.material.colorWrite === false
      && m.material.depthTest === false && m.material.stencilZPass === THREE.ReplaceStencilOp)
    && [bodyMask, wheelMask, bodyRim].every((m) => m.material.stencilWrite
      && m.material.stencilRef === taxiMask[0].material.stencilRef);
  check('car ghosts share the taxi ghost stencil recipe', flagsOk,
    `ref ${bodyRim.material.stencilRef}, mask stamps / rim tests NotEqual`);

  // The masks must trace the exact silhouette, so they share traffic's own geometries — which also
  // means nothing here may add an attribute to them. Only the rim's private inflated clone carries
  // the per-instance alpha.
  check('car ghost masks share the traffic geometry untouched',
    bodyMask.geometry === gTraffic.mesh.geometry && wheelMask.geometry === gTraffic.wheelMesh.geometry
    && !bodyMask.geometry.attributes.aAlpha && !wheelMask.geometry.attributes.aAlpha
    && bodyRim.geometry !== gTraffic.mesh.geometry && Boolean(bodyRim.geometry.attributes.aAlpha),
    'masks shared, rim cloned and inflated');

  const bodyBox = new THREE.Box3().setFromBufferAttribute(bodyMask.geometry.attributes.position);
  const ghostBox = new THREE.Box3().setFromBufferAttribute(bodyRim.geometry.attributes.position);
  const standoff = ghostBox.max.x - bodyBox.max.x;
  check('car ghost rim stands off the body', standoff > 0.2 && standoff < 0.5,
    `${standoff.toFixed(2)} units`);

  // --- Drive it. Let the envelope reach full strength on its own, before a single frame of update()
  // has run.
  const runFrames = (n) => {
    for (let f = 0; f < n; f++) { gTraffic.update(1 / 60); ghosts.update(1 / 60); }
  };

  check('car ghosts are gone entirely before the first frame',
    ghosts.state.strength === 0 && bodyMask.count === 0 && wheelMask.count === 0
    && bodyRim.count === 0,
    'counts at zero — a mask writes no colour, so fading it is not the same as retiring it');

  // Not gated on the boost — the whole point is to warn the player about a hidden car *before* they
  // decide to press the button, so `taxi.boost` stays false through this entire block.
  check('the taxi starts un-boosted', gTraffic.taxi.boost === false, 'nothing armed the button yet');
  runFrames(40);

  check('car ghosts fade up without the boost', ghosts.state.strength === 1 && ghosts.state.active > 0,
    `${ghosts.state.active} cars ghosted, boost still off`);

  // The radius is a *warning time* written down as a distance, and the figure that matters is the
  // fully-lit one: a ghost inside FADE_BAND of the edge is nearly transparent, which is not a
  // warning. Asserted against boost speed rather than left as a bare 42, because the bare number
  // is what quietly went stale last time — at 30 a car hidden behind a tower lit up 1.3s out at
  // Loco cruise and 1.05s in overdrive, which is after the player has committed to the junction.
  // The failure was reported as "cars behind buildings sometimes have no outline"; they had none
  // because they were 30-odd units away and the horizon stopped there.
  const litSeconds = (GHOST_RADIUS - FADE_BAND) / boostCruise();
  check('the ghost horizon is a reaction window, not a braking distance', litSeconds >= 1.8,
    `${litSeconds.toFixed(2)}s at full opacity, ${(GHOST_RADIUS / boostCruise()).toFixed(2)}s to the edge`);

  // The cap must stay a rail. Eviction drops the *farthest* vehicle, and farthest is not safest —
  // the car two junctions out is exactly what the widened radius is there to show — so the moment
  // the cap starts binding it is silently undoing the horizon above. At radius 42 with the old cap
  // of 8 a genuinely hidden vehicle was dropped on 5.5% of frames; this is what would catch the
  // radius growing again without it.
  let peakInRange = 0;
  for (let f = 0; f < 900; f++) {
    runFrames(1);
    let n = 0;
    for (const car of [...gTraffic.ambient, ...gTraffic.trucks]) {
      if (car.crashed) continue;
      if (Math.hypot(car.x - gTraffic.taxi.x, car.z - gTraffic.taxi.z) <= GHOST_RADIUS) n++;
    }
    if (n > peakInRange) peakInRange = n;
  }
  check('the cap never becomes the filter', peakInRange <= MAX_GHOSTS,
    `peak ${peakInRange} vehicles in range over 15s of boosting, cap ${MAX_GHOSTS}`);

  // The horizon has a ceiling, and it is the spawn clearance. A mid-run arrival appears at least
  // SPAWN_CLEARANCE from the taxi; if the ghost radius ever reached that, a car would materialise
  // already wearing an outline — a ghost blinking into existence beside the taxi, with no vehicle
  // having driven into view — which is indistinguishable from the outline bug this whole module
  // exists to prevent. Measured on the current pair: no spawn lands inside the radius, the nearest
  // 52.6 units out, and the margin is 8 units (0.43s at boostCruise()). Raising one means raising
  // the other first.
  check('a car can never spawn inside the ghost horizon', GHOST_RADIUS < SPAWN_CLEARANCE,
    `radius ${GHOST_RADIUS} under a spawn clearance of ${SPAWN_CLEARANCE},`
    + ` ${((SPAWN_CLEARANCE - GHOST_RADIUS) / boostCruise()).toFixed(2)}s of margin`);

  // Nearest-first, radius-limited, capped — recomputed by brute force and compared. This is what
  // catches a selection that quietly degrades into "whichever cars the loop reached first".
  const nearest = gTraffic.ambient
    .filter((c) => !c.crashed)
    .map((car) => ({ car, dist: Math.hypot(car.x - gTraffic.taxi.x, car.z - gTraffic.taxi.z) }))
    .filter((e) => e.dist <= GHOST_RADIUS)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, MAX_GHOSTS);
  check('car ghosts pick the nearest traffic, in range and capped',
    ghosts.state.active === nearest.length && ghosts.state.active <= MAX_GHOSTS
    && bodyMask.count === ghosts.state.active && wheelMask.count === ghosts.state.active * perCar,
    `${ghosts.state.active} of ${gTraffic.ambient.length} within ${GHOST_RADIUS}`);

  // Every slot's transform must be the traced car's own, wheels included. Recomposing instead of
  // reading back would drift the bob, the lean, the pitch rock and the wheelie apart from the car;
  // a transposed wheel index (slot*perCar+w against instanceIndex*perCar+w) is invisible until a
  // wheel outline turns up bolted to the wrong car.
  const a = new THREE.Matrix4();
  const b = new THREE.Matrix4();
  let drift = 0;
  for (let slot = 0; slot < ghosts.state.active; slot++) {
    const { car } = nearest[slot];
    gTraffic.mesh.getMatrixAt(car.instanceIndex, a);
    bodyMask.getMatrixAt(slot, b);
    if (!a.equals(b)) drift++;
    bodyRim.getMatrixAt(slot, b);
    if (!a.equals(b)) drift++;
    for (let w = 0; w < perCar; w++) {
      gTraffic.wheelMesh.getMatrixAt(car.instanceIndex * perCar + w, a);
      wheelMask.getMatrixAt(slot * perCar + w, b);
      if (!a.equals(b)) drift++;
    }
  }
  check('every car ghost sits exactly on the car it traces', drift === 0,
    `${drift} matrices adrift across ${ghosts.state.active} cars`);

  // Alpha: the boost envelope times each car's own distance fade, so the farthest ghost — the one
  // the cap would evict next — is already the faintest.
  const live = Array.from(ghosts.alphas.slice(0, ghosts.state.active));
  check('car ghost alpha falls off with distance',
    live.every((v, k) => v > 0 && v <= GHOST_OPACITY + 1e-6 && (k === 0 || v <= live[k - 1] + 1e-6))
    && GHOST_OPACITY < taxiMask[0].parent.children.find((n) => n.name === 'ghostRim').material.opacity,
    `peak ${Math.max(...live).toFixed(2)} under the taxi's 0.85, monotone outward`);

  // A wrecked car leaves the road for good; its ghost must go with it rather than hang over the
  // fireball. wreckShell collapses the instance, so a stale slot would trace a zero-scale car.
  const wrecked = nearest[0]?.car;
  if (wrecked) {
    gTraffic.wreckShell(wrecked);
    runFrames(1);
    gTraffic.mesh.getMatrixAt(wrecked.instanceIndex, a);
    let tracesWreck = false;
    for (let slot = 0; slot < ghosts.state.active; slot++) {
      bodyRim.getMatrixAt(slot, b);
      if (a.equals(b)) tracesWreck = true;
    }
    check('a wrecked car drops its ghost', !tracesWreck && ghosts.state.active > 0,
      `${ghosts.state.active} still ghosted, the wreck not among them`);
  }

  // Pressing the boost changes nothing — the set was already up. Only a crash retires it.
  gTraffic.taxi.boost = true;
  runFrames(5);
  check('boosting does not change an already-active ghost set',
    ghosts.state.strength === 1 && ghosts.state.active > 0,
    `${ghosts.state.active} cars ghosted, boost now on`);

  gTraffic.taxi.crashed = true;
  runFrames(40);
  check('car ghosts retire when the taxi crashes',
    ghosts.state.strength === 0 && ghosts.state.active === 0 && bodyMask.count === 0
    && wheelMask.count === 0 && bodyRim.count === 0,
    'strength 0, all three counts 0');
  gTraffic.taxi.crashed = false;   // the wreck above was the other car; keep the taxi driving
  gTraffic.taxi.boost = false;
}

// --- Box-truck ghost outlines -------------------------------------------------
//
// Trucks went without an outline for a while, because they live in their own instance space and the
// pool read `car.instanceIndex` straight into the *car* meshes — including a truck would have
// traced whichever car held the same index. Now there is a pool per vehicle class, which is three
// new ways to be wrong that a car can't be: a mask that misses the cargo box (a part left out of
// the mask is an occluder of the rim behind it), a rim built as two overlapping hulls (which blends
// twice and paints a lit band down the flank instead of an outline), and a cross-wired index
// between two pools that are both filling slots from one nearest-N list.
{
  const kScene = new THREE.Scene();
  // Half the vehicles as trucks, not TRUCK_CHANCE's 1/12: what is under test is the truck path, and
  // at 1/12 a seed that happens to hold no truck inside GHOST_RADIUS asserts nothing while passing.
  const kTraffic = createTraffic(makeRng(seed + 44), kScene, 24, 24, 0.5);
  const kGhosts = createCarGhosts(kScene, kTraffic);
  kTraffic.warmup(30);

  const {
    truckCabMask, truckBoxMask, truckWheelMask, truckRim,
    bodyMask: carMask, wheelMask: carWheelMask, bodyRim: carRim,
  } = kGhosts;
  const perTruck = kTraffic.truckWheelsPerCar;

  check('truck ghost pool is sized to the cap',
    truckCabMask.instanceMatrix.count === MAX_GHOSTS
    && truckBoxMask.instanceMatrix.count === MAX_GHOSTS
    && truckRim.instanceMatrix.count === MAX_GHOSTS
    && truckWheelMask.instanceMatrix.count === MAX_GHOSTS * perTruck,
    `full ${MAX_GHOSTS} slots per class — the cap is shared, the pools are not`);

  const kPool = [truckCabMask, truckBoxMask, truckWheelMask, truckRim];
  check('truck ghosts never frustum-cull',
    kPool.every((m) => m.frustumCulled === false && !m.castShadow),
    'culling off, no shadows borrowed from the truck meshes');

  check('truck ghosts stamp and resolve in the traffic tiers',
    [truckCabMask, truckBoxMask, truckWheelMask].every((m) => m.renderOrder === CAR_GHOST_MASK_ORDER)
    && truckRim.renderOrder === CAR_GHOST_RIM_ORDER,
    `masks ${CAR_GHOST_MASK_ORDER}, rim ${CAR_GHOST_RIM_ORDER} — same tiers as the cars`);

  // Every opaque part of the truck, the cargo box included. A box missing from the mask is an
  // occluder like any other: the cab's own rim would resolve straight across it.
  check('truck ghost masks share all three truck geometries untouched',
    truckCabMask.geometry === kTraffic.truckMesh.geometry
    && truckBoxMask.geometry === kTraffic.truckBoxMesh.geometry
    && truckWheelMask.geometry === kTraffic.truckWheelMesh.geometry
    && kPool.slice(0, 3).every((m) => !m.geometry.attributes.aAlpha)
    && truckRim.geometry !== kTraffic.truckMesh.geometry
    && Boolean(truckRim.geometry.attributes.aAlpha),
    'cab, box and wheels masked; rim merged, inflated and carrying the alpha');

  // ONE hull for the vehicle, not one per mesh. The rim blends, so two hulls overlapping across the
  // chassis line draw the same fragment twice — 0.86 against the intended 0.62, measured as a band
  // down the flank from y 1.65 to 2.95. Count the rims rather than trust the comment.
  const kRims = [];
  kScene.traverse((n) => { if (n.isMesh && n.name === 'truckGhostRim') kRims.push(n); });
  check('a truck wears exactly one rim hull', kRims.length === 1 && kRims[0] === truckRim,
    'cab and box merged before inflation, so nothing blends twice');

  // ...and that one hull has to cover both. A cab-only hull leaves the tallest thing on the road —
  // the box roof, a metre above the cab — with no outline at all, which is the whole vehicle as far
  // as a player glancing at a junction is concerned.
  const cabBox = new THREE.Box3().setFromBufferAttribute(truckCabMask.geometry.attributes.position);
  const cargoBox = new THREE.Box3().setFromBufferAttribute(truckBoxMask.geometry.attributes.position);
  const hull = new THREE.Box3().setFromBufferAttribute(truckRim.geometry.attributes.position);
  const standoffs = [
    hull.max.y - cargoBox.max.y,   // box roof
    hull.max.x - cabBox.max.x,     // cab nose
    cargoBox.min.x - hull.min.x,   // tail
    hull.max.z - Math.max(cabBox.max.z, cargoBox.max.z),
  ];
  check('the truck rim stands off cab and cargo box alike',
    standoffs.every((s) => s > 0.2 && s < 0.6) && hull.max.y > cabBox.max.y + 0.5,
    `${standoffs.map((s) => s.toFixed(2)).join(' / ')} — roof, nose, tail, flank`);

  // --- Drive it.
  const kFrames = (n) => {
    for (let f = 0; f < n; f++) { kTraffic.update(1 / 60); kGhosts.update(1 / 60); }
  };

  // Staged, not drawn. The radius holds ~6.5 vehicles on average, but *which* ones is the seed's
  // business: on the default seed this scenario opens with a single vehicle inside 30 units and no
  // truck at all, so a drawn version of this block would pass while asserting nothing. Put the taxi
  // and two trucks on approaches to one junction instead, and the rest of the traffic wherever the
  // draw left it — the expectation below is brute-forced from final positions either way.
  let kI = -1;
  let kJ = -1;
  for (let i = 1; i < GRID_I && kI < 0; i++) {
    for (let j = 1; j < GRID_J && kI < 0; j++) {
      if (ringAxisAt(i, j)) continue;
      // All four approaches, with room to stage on: the trucks come in from the other three.
      if ([0, 1, 2, 3].every((d) => approachRoom(d, i, j) >= 8)) { kI = i; kJ = j; }
    }
  }
  const kPlace = (car, d, back) => {
    const ok = placeCar(car, d, kI, kJ, back);
    car.route = []; car.parked = false;
    return ok;
  };
  const kDir = 0;
  const staged = kPlace(kTraffic.taxi, kDir, 4)
    && kPlace(kTraffic.trucks[0], opposite(kDir), 2)
    && kPlace(kTraffic.trucks[1], leftOf(kDir), 2)
    && kPlace(kTraffic.ambient[0], rightOf(kDir), 2);
  check('the truck ghost scenario stages', staged && kI > 0,
    `taxi and two trucks onto junction (${kI}, ${kJ})`);

  // Boost stays off through the whole staged scenario — the ghosts must trace it anyway.
  kFrames(40);

  // Nearest-first across BOTH arrays against one shared cap, recomputed by brute force. A per-class
  // cap would show up here as more ghosts than MAX_GHOSTS; a per-class radius, as a truck the taxi
  // is nearer to than a car it did ghost.
  const kNearest = [
    ...kTraffic.ambient.map((car) => ({ car, truck: false })),
    ...kTraffic.trucks.map((car) => ({ car, truck: true })),
  ]
    .filter((e) => !e.car.crashed)
    .map((e) => ({ ...e, dist: Math.hypot(e.car.x - kTraffic.taxi.x, e.car.z - kTraffic.taxi.z) }))
    .filter((e) => e.dist <= GHOST_RADIUS)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, MAX_GHOSTS);
  const kTrucks = kNearest.filter((e) => e.truck);
  const kCars = kNearest.filter((e) => !e.truck);

  check('trucks are ghosted alongside cars, under one shared cap',
    kGhosts.state.trucks === kTrucks.length && kGhosts.state.cars === kCars.length
    && kGhosts.state.active === kNearest.length && kGhosts.state.active <= MAX_GHOSTS
    && kTrucks.length > 0,
    `${kGhosts.state.cars} cars + ${kGhosts.state.trucks} trucks of `
    + `${kTraffic.ambient.length}+${kTraffic.trucks.length} within ${GHOST_RADIUS}`);

  check('every truck ghost mesh is drawn to its own slot count',
    truckCabMask.count === kTrucks.length && truckBoxMask.count === kTrucks.length
    && truckRim.count === kTrucks.length
    && truckWheelMask.count === kTrucks.length * perTruck
    && carMask.count === kCars.length && carRim.count === kCars.length,
    `${kTrucks.length} trucks, ${kTrucks.length * perTruck} truck wheels`);

  // The cross-wiring test. Two pools now fill slots out of one nearest-N list, so a truck's slot in
  // its own pool is NOT its position in that list — get that wrong and a ghost lands on the vehicle
  // one place along, which looks like a broken outline and like nothing at all headlessly.
  const kA = new THREE.Matrix4();
  const kB = new THREE.Matrix4();
  let kDrift = 0;
  let truckSlot = 0;
  let carSlot = 0;
  for (const { car, truck } of kNearest) {
    const slot = truck ? truckSlot++ : carSlot++;
    const body = truck ? kTraffic.truckMesh : kTraffic.mesh;
    const wheels = truck ? kTraffic.truckWheelMesh : kTraffic.wheelMesh;
    const per = truck ? perTruck : kTraffic.wheelsPerCar;
    body.getMatrixAt(car.instanceIndex, kA);
    (truck ? truckCabMask : carMask).getMatrixAt(slot, kB);
    if (!kA.equals(kB)) kDrift++;
    (truck ? truckRim : carRim).getMatrixAt(slot, kB);
    if (!kA.equals(kB)) kDrift++;
    if (truck) {
      // The cargo box rides the cab's transform exactly — read back from its own mesh all the same.
      kTraffic.truckBoxMesh.getMatrixAt(car.instanceIndex, kA);
      truckBoxMask.getMatrixAt(slot, kB);
      if (!kA.equals(kB)) kDrift++;
    }
    for (let w = 0; w < per; w++) {
      wheels.getMatrixAt(car.instanceIndex * per + w, kA);
      (truck ? truckWheelMask : carWheelMask).getMatrixAt(slot * per + w, kB);
      if (!kA.equals(kB)) kDrift++;
    }
  }
  check('every ghost sits on its own vehicle across both pools', kDrift === 0,
    `${kDrift} matrices adrift across ${kNearest.length} vehicles`);

  // Each pool's alphas are written in nearest-first order within that pool, so both stay monotone
  // even though the two are interleaved in the shared list.
  const kTruckAlphas = Array.from(kGhosts.truckAlphas.slice(0, kGhosts.state.trucks));
  check('truck ghost alpha falls off with distance',
    kTruckAlphas.every((v, k) => v > 0 && v <= GHOST_OPACITY + 1e-6
      && (k === 0 || v <= kTruckAlphas[k - 1] + 1e-6)),
    `peak ${Math.max(...kTruckAlphas).toFixed(2)} under the taxi's 0.85, monotone outward`);

  // A wrecked truck leaves the road for good — wreckShell collapses all three of its instances, so
  // a stale slot would trace a zero-scale truck.
  const kWreck = kTrucks[0]?.car;
  if (kWreck) {
    kTraffic.wreckShell(kWreck);
    kFrames(1);
    kTraffic.truckMesh.getMatrixAt(kWreck.instanceIndex, kA);
    let tracesWreck = false;
    for (let slot = 0; slot < kGhosts.state.trucks; slot++) {
      truckRim.getMatrixAt(slot, kB);
      if (kA.equals(kB)) tracesWreck = true;
    }
    check('a wrecked truck drops its ghost', !tracesWreck,
      `${kGhosts.state.trucks} still ghosted, the wreck not among them`);
  }

  kTraffic.taxi.crashed = true;
  kFrames(40);
  check('truck ghosts retire with the rest when the taxi crashes',
    kGhosts.state.strength === 0 && kGhosts.state.trucks === 0 && kGhosts.state.active === 0
    && kPool.every((m) => m.count === 0),
    'strength 0, every truck count 0');
  kTraffic.taxi.crashed = false;
}

// --- Ghost paints -------------------------------------------------------------
// "Yellow is reserved for the taxi" is a rule palette.js records having already been broken once —
// an amber ambient car was genuinely mistakable for the player's. The ghost rims are the same trap
// one level up: two carBody entries are hue ~41° at low saturation, and they only read as off-white
// because of that saturation. Make the clearance mechanical rather than a comment.
{
  // getHSL defaults to the *working* colour space, which is Linear-sRGB — every lightness below is
  // an sRGB number, and read linearly they all come out far darker than they look. Ask for sRGB
  // explicitly or this block measures a different colour than the eye sees.
  const SRGB = THREE.SRGBColorSpace;
  const ghostHsl = { h: 0, s: 0, l: 0 };
  const bodyHsl = { h: 0, s: 0, l: 0 };
  const taxiHsl = new THREE.Color(PALETTE.taxiGhost).getHSL({ h: 0, s: 0, l: 0 }, SRGB);

  let unlit = 0;
  let clashes = 0;
  for (let k = 0; k < PALETTE.carBody.length; k++) {
    new THREE.Color(PALETTE.carBodyGhost[k]).getHSL(ghostHsl, SRGB);
    new THREE.Color(PALETTE.carBody[k]).getHSL(bodyHsl, SRGB);

    // Every ghost has to read from the shadowed side of a tower, which is the only place it is ever
    // seen. The dark slate is the one this is really about: L 0.32 raw.
    if (ghostHsl.l < 0.55) unlit++;
    // Saturation must not have been pushed up — that is what would drag the two near-neutral creams
    // into taxiGhost's own hue family, where a 2px outline is indistinguishable from the player's.
    if (ghostHsl.s > bodyHsl.s + 0.02) clashes++;
    const dh = Math.abs(ghostHsl.h - taxiHsl.h) * 360;
    if (Math.min(dh, 360 - dh) < 25 && ghostHsl.s > 0.35) clashes++;
  }

  check('every car has a ghost paint', PALETTE.carBodyGhost.length === PALETTE.carBody.length,
    `${PALETTE.carBodyGhost.length} of ${PALETTE.carBody.length}`);
  check('ghost paints read from under a tower', unlit === 0, `${unlit} too dark`);
  check('no ghost paint strays into the taxi\'s yellow', clashes === 0,
    `${clashes} within 25° of taxiGhost, or saturated past its own body colour`);
}

let planeOrder;   // read out of the block below, checked in 'Which axis a body rolls about'
let chopperOrder; // likewise

// --- The ambient flyover --------------------------------------------------------
// A plane crossing the sky is the one thing in the game with no failure state to notice: if it
// clips a tower, pops into frame at the edge of a wide monitor, or flies parallel to the streets,
// nothing breaks and nobody is told. All three are numbers, so they belong here.
{
  const model = createPlaneMesh();
  const box = new THREE.Box3().setFromObject(model.group);
  check('the plane model measures what geometry/plane.js says it does',
    Math.abs(-box.min.y - PLANE_UNDERSIDE) < 1e-6
    && Math.abs((box.max.z - box.min.z) - PLANE_SPAN) < 1e-6,
    `underside ${(-box.min.y).toFixed(2)}, span ${(box.max.z - box.min.z).toFixed(2)}`);

  // Both streamers face the camera as squarely as a ribbon fixed to the fuselage axis can. The
  // ceiling is the length of VIEW_DIR with its component along that axis removed — hit it exactly
  // and the roll is right; a sign error lands on its negative and the ribbons turn edge-on.
  // Read the normal off the built quads rather than recomputing it from the roll angle: rolling
  // the ribbon to point its *width* at the camera instead of its face is a one-character
  // difference that leaves every formula self-consistent and the streamers invisible.
  const triangleNormal = (array, yaw) => {
    const v = (i) => new THREE.Vector3(array[i * 3], array[i * 3 + 1], array[i * 3 + 2]);
    const a = v(0);
    return new THREE.Vector3().crossVectors(v(1).sub(a), v(2).sub(a)).normalize()
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  };
  let facingError = 0;
  for (let k = 0; k < 32; k++) {
    const yaw = (k / 32) * Math.PI * 2;
    model.setTrailRoll(trailRoll(yaw));
    const normal = triangleNormal(model.trails.geometry.attributes.position.array, yaw);
    // The ceiling: VIEW_DIR with its component along the fuselage axis taken out, which is all a
    // ribbon fixed to that axis can ever turn to face.
    const f = heading(yaw);
    const along = VIEW_DIR.x * f.x + VIEW_DIR.z * f.z;
    const best = Math.hypot(VIEW_DIR.x - along * f.x, VIEW_DIR.y, VIEW_DIR.z - along * f.z);
    facingError = Math.max(facingError, Math.abs(best - Math.abs(normal.dot(VIEW_DIR))));
  }
  model.setTrailRoll(0);
  check('wingtip streamers turn to face the camera', facingError < 1e-6,
    `off the best a ribbon on the fuselage axis can do by ${facingError.toExponential(1)}`);

  const planeScene = new THREE.Scene();
  const flyover = createFlyover(planeScene, makeRng(seed + 155));

  // Ten minutes of sim, which is several flights and a lot more waiting.
  let minY = Infinity;
  let hiddenOverCity = 0;        // frames faded down while over the map, where it has to be solid
  let airborne = 0;
  let frames = 0;
  let straight = 0;              // launches within 12° of a street
  let lastFlight = 0;
  let wasActive = false;
  const ends = [];               // where each run starts and where it stops being drawn
  for (let step = 0; step < 600 * 60; step++) {
    flyover.update(1 / 60);
    frames++;
    if (flyover.state.flights !== lastFlight) {
      lastFlight = flyover.state.flights;
      // Distance from the nearest world axis, i.e. from the nearest street direction.
      const off = Math.abs(((flyover.state.yaw % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2));
      if (Math.min(off, Math.PI / 2 - off) < THREE.MathUtils.degToRad(12)) straight++;
      ends.push(flyover.group.position.clone());
    }
    if (wasActive && !flyover.state.active) ends.push(flyover.group.position.clone());
    wasActive = flyover.state.active;
    if (!flyover.state.active) continue;
    airborne++;
    minY = Math.min(minY, flyover.group.position.y);
    const p = flyover.group.position;
    if (Math.abs(p.x) < HALF_SPAN_X && Math.abs(p.z) < HALF_SPAN_Z && flyover.state.fade < 1) hiddenOverCity++;
  }

  check('the flyover comes round every so often, not constantly',
    flyover.state.flights >= 4 && airborne / frames < 0.2,
    `${flyover.state.flights} flights in 10 min, airborne ${(100 * airborne / frames).toFixed(0)}% of it`);

  // The tallest thing it has to miss, measured off the city that was actually built rather than
  // off the constant the generator caps at.
  buildings.mesh.geometry.computeBoundingBox();
  const skyline = buildings.mesh.geometry.boundingBox.max.y;
  check('the plane clears the skyline',
    minY - PLANE_UNDERSIDE > skyline + 4,
    `underside ${(minY - PLANE_UNDERSIDE).toFixed(1)} vs tallest tower ${skyline.toFixed(1)}`);

  // Both ends of a run have to be off the edge of the frame, so the aeroplane is only ever seen
  // arriving rather than appearing. Projected through real cameras at the extremes the game
  // allows — portrait phone to ultrawide desktop, panned into each corner of the map — rather
  // than compared against a hand-derived reach.
  const framings = [];
  for (const aspect of [0.46, 1, 1.78, 2.4]) {
    for (const target of [[0, 0], [HALF_SPAN_X, HALF_SPAN_Z], [-HALF_SPAN_X, HALF_SPAN_Z],
      [HALF_SPAN_X, -HALF_SPAN_Z], [-HALF_SPAN_X, -HALF_SPAN_Z]]) {
      framings.push(createCityCamera(aspect, { zoom: 52, target }).camera);
    }
  }
  let onScreenEnds = 0;
  for (const p of ends) {
    for (const cam of framings) {
      const ndc = p.clone().project(cam);
      if (Math.abs(ndc.x) < 1 && Math.abs(ndc.y) < 1) onScreenEnds++;
    }
  }
  check('the plane flies in from off-frame and out the other side', onScreenEnds === 0,
    `${ends.length} run ends against ${framings.length} framings, ${onScreenEnds} of them in shot`);

  check('it is fully painted while over the city', hiddenOverCity === 0,
    `${hiddenOverCity} frames faded while inside the map`);
  check('it never flies parallel to the streets', straight === 0,
    `${straight} of ${flyover.state.flights} headings within 12° of an axis`);

  // Two blades, so the prop repeats every half turn: past 90° a frame it reads as running
  // backwards, and at exactly 180° it stands still.
  check('the propeller does not strobe', PROP_SPIN / 60 < Math.PI / 2,
    `${THREE.MathUtils.radToDeg(PROP_SPIN / 60).toFixed(1)}° per frame at 60fps`);
  planeOrder = flyover.group.rotation.order;
}

// --- Weather -------------------------------------------------------------------
// The clouds (game/clouds.js) are placed by where they land **on screen**, so every claim about
// them is a claim about a projection and none of it can be seen from the world coordinates. Three
// things have to hold and all three failed at least once while this was being built: a cloud never
// overlaps the city, a cloud stays in the frustum from every framing the game allows, and there is
// weather in shot often enough to be worth having at all.
{
  // The city's silhouette as a convex polygon, built the same way `clouds.js` builds its chains but
  // kept whole, so a cloud can be tested against the *outline* rather than against the two halves.
  // Twice: the island as the player sees it, and the inner city a block inside the ring road, which
  // is the one the weather may never reach however far in the band is dragged.
  const hullOf = (points) => {
    const pts = points.map((k) => [k.sx, k.sy]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const half = (src) => {
      const out = [];
      for (const p of src) {
        while (out.length > 1) {
          const [ax, ay] = out[out.length - 2];
          const [bx, by] = out[out.length - 1];
          if ((bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax) <= 0) out.pop(); else break;
        }
        out.push(p);
      }
      return out;
    };
    const lower = half(pts);
    const upper = half([...pts].reverse());
    return lower.slice(0, -1).concat(upper.slice(0, -1));
  };

  const hull = hullOf(KEEP_OUT);
  const innerHull = hullOf(INNER_KEEP_OUT);

  /** Signed distance from a point to a hull: positive outside, negative within it. */
  const distanceTo = (poly, x, y) => {
    let worst = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      const ex = bx - ax;
      const ey = by - ay;
      worst = Math.max(worst, ((x - ax) * ey - (y - ay) * ex) / Math.hypot(ex, ey));
    }
    return worst;
  };

  const clearanceOf = (x, y) => distanceTo(hull, x, y);

  // The two chains have to agree with the hull they were cut from. Rounding a corner *outward* is
  // free — it only ever buys more sky between the cloud and the city — but rounding one **inward**
  // eats the clearance, and `ROUND * 0.25` is the deepest the polynomial smooth-min can cut. That
  // is the number `clouds.js` hands back when it places a cloud, so this is the assertion that the
  // number it hands back is the right one. Sampled across the hull's own span, since beyond that
  // the chains deliberately stop tracing the outline and carry on past the map's side.
  let bite = 0;
  const span = Math.max(...KEEP_OUT.map((k) => k.sx));
  for (let sx = -span; sx <= span; sx += 0.5) {
    bite = Math.max(bite, -clearanceOf(sx, silhouetteTop(sx)), -clearanceOf(sx, silhouetteBottom(sx)));
  }
  check('the smoothed silhouette never cuts deeper into the city than it pays back',
    bite <= CLOUD_ROUND * 0.25 + 1e-9,
    `deepest bite ${bite.toFixed(2)} against the ${(CLOUD_ROUND * 0.25).toFixed(2)} handed back`);

  const framings = [];
  for (const aspect of [0.46, 1, 1.78, 2.4]) {
    for (const target of [[0, 0], [HALF_SPAN_X, HALF_SPAN_Z], [-HALF_SPAN_X, HALF_SPAN_Z],
      [HALF_SPAN_X, -HALF_SPAN_Z], [-HALF_SPAN_X, -HALF_SPAN_Z]]) {
      framings.push(createCityCamera(aspect, { zoom: 52, target }).camera);
    }
  }

  let worstClearance = Infinity;
  let innerClearance = Infinity;
  let broadside = Infinity;
  let darkest = 1;
  let faintest = 1;
  let strongest = 0;
  let solid = 0;
  let seen = 0;
  let alphaless = 0;
  let chunked = 0;
  let outOfOrder = 0;
  let shadows = 0;
  let behindCamera = 0;
  const corner = new THREE.Vector3();
  const YAXIS = new THREE.Vector3(0, 1, 0);
  const LOBE_VERTS = 240;      // a detail-1 icosahedron: 80 faces, non-indexed

  for (let s = 0; s < 4; s++) {
    const skyScene = new THREE.Scene();
    const clouds = createClouds(skyScene, makeRng(seed + s * 977 + 277));

    for (const cloud of clouds.clouds) {
      // The long axis lies down the wind, and the wind runs across the frame — so a cloud is a
      // good deal wider than it is tall *on screen*. This is the check that catches the sign of
      // the yaw: the other quarter turn aims the model straight into the screen, where it
      // projects to almost nothing across the frame and reads as a lumpy potato on end.
      broadside = Math.min(broadside, (2 * cloud.reach) / (cloud.drop + cloud.rise));
      if (cloud.mesh.castShadow) shadows += 1;

      // Colour is rgb **and** the rim fade, so the darkest-channel walk has to step over the alpha
      // — which reaches 0 by design, and read as a black cloud the first time this ran.
      const colours = cloud.mesh.geometry.attributes.color;
      if (colours.itemSize !== 4) alphaless += 1;
      for (let v = 0; v < colours.count; v++) {
        darkest = Math.min(darkest, colours.getX(v), colours.getY(v), colours.getZ(v));
        const a = colours.getW(v);
        faintest = Math.min(faintest, a);
        strongest = Math.max(strongest, a);
        if (a > 0.999) solid += 1;
        seen += 1;
      }

      // Back to front, so the translucent lobes blend in depth order rather than painting over
      // each other — see the sort in geometry/cloud.js. Every lobe is a detail-1 icosahedron, so
      // the merged geometry is exactly 240 vertices per lobe and the chunks *are* the lobes.
      const pos = cloud.mesh.geometry.attributes.position;
      if (pos.count % LOBE_VERTS) chunked += 1;
      let previous = -Infinity;
      for (let lobe = 0; lobe + LOBE_VERTS <= pos.count; lobe += LOBE_VERTS) {
        let depth = 0;
        for (let v = lobe; v < lobe + LOBE_VERTS; v++) {
          corner.set(pos.getX(v), pos.getY(v), pos.getZ(v))
            .applyAxisAngle(YAXIS, cloud.mesh.rotation.y);
          depth += corner.dot(VIEW_DIR);
        }
        depth /= LOBE_VERTS;
        // Against a tolerance, because what is sorted is each lobe's **centre** and what is
        // measured here is the mean of its vertices — and `jitterVertices` moves those about, so
        // the two disagree by a few hundredths of a unit. Measured worst case on the shipped
        // jitter: 0.05. Anything that is actually a sorting bug is a whole lobe out of place.
        if (depth < previous - 0.25) outOfOrder += 1;
        previous = Math.max(previous, depth);
      }
    }

    // Eight minutes of drift each, which is a couple of laps of the run — a cloud crosses the
    // 400-unit sweep in a little over three.
    for (let step = 0; step < 60 * 480; step++) {
      clouds.update(1 / 60);
      if (step % 13) continue;
      for (let i = 0; i < clouds.state.count; i++) {
        const cloud = clouds.clouds[i];
        if (!cloud.mesh.visible) continue;
        const p = cloud.mesh.position;
        const at = screenOf(p.x, p.y, p.z);
        for (const dx of [-cloud.reach, cloud.reach]) {
          for (const dy of [-cloud.drop, cloud.rise]) {
            worstClearance = Math.min(worstClearance, clearanceOf(at.sx + dx, at.sy + dy));
            innerClearance = Math.min(innerClearance, distanceTo(innerHull, at.sx + dx, at.sy + dy));
          }
        }
        if (step % 601) continue;
        // And in front of the camera from anywhere the player can drive to. Depth is measured from
        // the camera's *target*, so a cloud that sits comfortably in frame with the camera at the
        // middle of the map can be behind it once the target has moved 59 units down the view axis.
        for (const cam of framings) {
          if (corner.copy(p).project(cam).z >= 1) behindCamera += 1;
        }
      }
    }
  }

  // The weather hangs **over the coast**: a cloud's box comes in past the island's edge on purpose
  // (`OVERLAP`, which the ⚙️ panel can drag), and the box is a long way outside the drawn shape —
  // the fade has dissolved the lower rim before its bounding box ends — so this is a veil over the
  // outermost asphalt rather than a lid on it. What is asserted is that it stays a veil.
  check('the weather comes in over the coast, and no further', worstClearance > -20,
    `deepest ${(-worstClearance).toFixed(1)} units in past the island's edge`);
  // And the half of it that is not a preference: whatever the band is set to, nothing in the sky
  // may reach the city inside the ring road. This is the check that stops "a little closer in" from
  // becoming weather over the play area one tweak at a time.
  check('and never over the map itself', innerClearance > 0,
    `closest approach ${innerClearance.toFixed(1)} units outside the inner city`
    + ` (±${INNER_REACH_X} by ±${INNER_REACH_Z})`);
  check('every cloud is drawn broadside to the wind', broadside > 1.3,
    `narrowest is ${broadside.toFixed(2)}x wider than tall on screen`);
  check('clouds stay in front of the camera from every framing', behindCamera === 0,
    `${framings.length} framings, ${behindCamera} clipped`);
  check('nothing in the sky casts a shadow', shadows === 0,
    shadows ? `${shadows} clouds throwing a patch over the city` : 'the band would land on the map');
  // The light is baked (geometry/cloud.js), and the floor under it is what keeps the unlit side of
  // a cloud reading as cloud rather than as rock.
  check('a cloud is bright even on its own shaded side', darkest > 0.12,
    `darkest baked channel ${darkest.toFixed(3)}`);
  // And the fade, which is the whole of why a low-poly cloud does not read as one: it has to reach
  // nothing at the silhouette *and* reach solid at the point of each lobe aimed at the camera. Only
  // a few percent of a lobe's vertices are in that solid cap — the body of a cloud is opaque
  // because its lobes stack, not because any one of them is — so what is asserted is the range.
  check('the fade reaches both ends', alphaless === 0 && faintest < 0.02 && strongest > 0.999,
    `alpha ${faintest.toFixed(3)} at the silhouette to ${strongest.toFixed(3)} at the core, ${(100 * solid / seen).toFixed(1)}% of vertices fully opaque`);
  check('a cloud\'s lobes are built back to front', chunked === 0 && outOfOrder === 0,
    `${outOfOrder} lobes out of depth order, ${chunked} clouds not a whole number of lobes`);

  // And the point of all of it: is there any weather in the picture? Measured on the framing that
  // has the least sky in it by a distance — a portrait phone at play zoom, where the island fills
  // the frame and what is left is the wedge past its edge.
  {
    const skyScene = new THREE.Scene();
    const clouds = createClouds(skyScene, makeRng(seed + 277));
    const halfW = 52 * 0.46;
    let seen = 0;
    let samples = 0;
    for (let step = 0; step < 60 * 420; step++) {
      clouds.update(1 / 60);
      if (step % 60) continue;
      const t = step / 60;
      const view = screenOf(40 * Math.sin(t * 0.11), 0, 40 * Math.sin(t * 0.07 + 1));
      let inFrame = 0;
      for (let i = 0; i < clouds.state.count; i++) {
        const cloud = clouds.clouds[i];
        if (!cloud.mesh.visible) continue;
        const p = cloud.mesh.position;
        const at = screenOf(p.x, p.y, p.z);
        if (Math.abs(at.sx - view.sx) < halfW + cloud.reach
          && Math.abs(at.sy - view.sy) < 52 + cloud.rise) inFrame += 1;
      }
      samples += 1;
      if (inFrame) seen += 1;
    }
    check('there is weather in shot on a phone', seen / samples > 0.5,
      `a cloud is in frame ${(100 * seen / samples).toFixed(0)}% of the time at 0.46 aspect`);
  }

  // The keep-out is two boxes, and the tall one stops at the ring road — the difference is 17
  // units of sky the clouds get to use. Asserted rather than trusted because it is the one number
  // in here that comes from somewhere else in the project.
  check('the keep-out stops where the city does',
    BUILT_REACH_X < CITY_REACH_X && BUILT_REACH_Z < CITY_REACH_Z && CITY_TOP > 16,
    `built to ${BUILT_REACH_X}x${BUILT_REACH_Z} and ${CITY_TOP} tall,`
    + ` ground out to ${CITY_REACH_X}x${CITY_REACH_Z}`);

  // The clouds are the only unlit thing in the sky, so the tint is the *whole* of what the day
  // cycle does to them (game/daylight.js). A tint that stopped tracking would leave white clouds
  // hanging over a midnight city, which nothing else in the suite would notice.
  const hsl = { h: 0, s: 0, l: 0 };
  const lightness = (top, bottom) => {
    cloudTint(new THREE.Color(top), new THREE.Color(bottom)).getHSL(hsl);
    return hsl.l;
  };
  const noon = lightness('#6FA9D4', '#CDE3EE');
  const midnight = lightness('#0A1320', '#16202E');
  check('the clouds go out with the light', midnight < noon * 0.4 && midnight > 0.02,
    `lightness ${noon.toFixed(2)} at noon, ${midnight.toFixed(2)} at midnight`);
}

// --- The rooftop helicopter ------------------------------------------------------
// The aeroplane's problem, with a second one on top of it: this thing has to *land* somewhere real.
// Everything about that is a number nobody would be told about if it went wrong — a machine that
// hovers a foot over its own pad, sits on it back-to-front, flies home through the tower next door,
// or comes down onto a roof with an air-conditioning unit already standing on it.
{
  /** Signed shortest way round, so a heading comparison never trips over the wrap at ±π. */
  const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  // Inside this of the pad, the tallest thing under the machine is the roof it is landing on —
  // which it is *supposed* to be over. Outside it, anything under the rotor is a building it is
  // about to fly through.
  const OWN_ROOF = 5;

  const model = createHelicopterMesh();
  const box = new THREE.Box3().setFromObject(model.group);
  check('the helicopter model measures what geometry/helicopter.js says it does',
    Math.abs(-box.min.y - HELI_SKID_DROP) < 1e-6,
    `underside ${(-box.min.y).toFixed(3)} against ${HELI_SKID_DROP}`);

  // The rotor turns 26.7° a frame at 60fps. Two blades is 180° of symmetry, so past 90° it reads as
  // running backwards and at exactly 180° it stands still — the propeller's constraint, and this
  // one has to hold at the *flight* rate, the fastest the machine ever spins it.
  const perFrame = ROTOR_FLIGHT / 60;
  check('the main rotor does not strobe', perFrame < Math.PI / 2,
    `${THREE.MathUtils.radToDeg(perFrame).toFixed(1)}° per frame at 60fps`);

  // Its transit altitude has to fit in the gap between the tallest thing on a roof and the lowest
  // the aeroplane's belly ever gets. Both ends read from the modules that own them.
  const rotorTop = box.max.y;
  check('it transits above the skyline and below the aeroplane',
    CHOPPER_ALT > SKYLINE_CEILING + 1 && CHOPPER_ALT + rotorTop < 26 - PLANE_UNDERSIDE,
    `cruise ${CHOPPER_ALT}, skyline ${SKYLINE_CEILING}, plane belly ${(26 - PLANE_UNDERSIDE).toFixed(1)}`);

  // A height field of the city the probe built, at two units a cell, so the flown path can be
  // checked against what is actually standing under it rather than against the ceiling constant.
  const CELL = 2;
  const cells = new Map();
  const cityPos = buildings.mesh.geometry.attributes.position;
  for (let i = 0; i < cityPos.count; i++) {
    const key = `${Math.floor(cityPos.getX(i) / CELL)},${Math.floor(cityPos.getZ(i) / CELL)}`;
    const y = cityPos.getY(i);
    if (!(cells.get(key) >= y)) cells.set(key, y);
  }
  const tallestNear = (x, z, radius) => {
    let top = 0;
    const span = Math.ceil(radius / CELL);
    const gx = Math.floor(x / CELL);
    const gz = Math.floor(z / CELL);
    for (let i = -span; i <= span; i++) {
      for (let j = -span; j <= span; j++) {
        const h = cells.get(`${gx + i},${gz + j}`);
        if (h !== undefined && h > top) top = h;
      }
    }
    return top;
  };

  const pad = buildings.pad;
  const heliScene = new THREE.Scene();
  let washes = 0;
  let bursts = 0;
  let washOffPad = 0;              // dust kicked up somewhere other than the deck
  const chopper = createChopper(heliScene, makeRng(seed + 233), pad, {
    onWash: (x, z, y, yaw, power, count) => {
      if (count > 1) bursts += 1; else washes += 1;
      if (Math.abs(y - pad.y) > 1e-6 || Math.hypot(x - pad.x, z - pad.z) > pad.r * 1.3) washOffPad += 1;
    },
  });

  // Ten minutes, which is a handful of visits and a lot more waiting.
  let frames = 0;
  let flying = 0;
  let belowPad = 0;                // frames under the paint it is supposed to land on
  let clearance = Infinity;        // worst gap between its belly and whatever it is over
  let maxRoll = 0;
  let bankedOverCity = 0;          // frames of real bank while inside the map and fully painted
  let hoverLean = 0;               // the worst lean it ever wore with no speed on it
  let restless = 0;                // airborne frames whose pose differs from the flight state
  let twitchyOnDeck = 0;           // parked frames where it doesn't
  let hiddenOverPad = 0;           // frames faded while sitting on the deck
  let parkOffset = 0;              // how far the skids ended up from the middle of the H
  let backwards = 0;               // landings facing across the deck rather than along it
  let departError = 0;             // how far off "the way it came" the departure heading was
  let landings = 0;
  let beaconOn = 0;
  let beaconOff = 0;
  const alongX = pad.cw >= pad.cd;

  for (let step = 0; step < 600 * 60; step++) {
    chopper.update(1 / 60);
    frames++;
    const st = chopper.state;
    if (st.mode === 'away') continue;
    flying++;
    if (chopper.heli.beacon.visible) beaconOn++; else beaconOff++;

    const dist = Math.hypot(st.x - pad.x, st.z - pad.z);
    if (st.y < pad.y) belowPad++;
    if (Math.abs(st.roll) > maxRoll) maxRoll = Math.abs(st.roll);
    // A bank is what turns a *moving* helicopter; a stationary one turns on its pedals. Leaning
    // over a hover is the single thing that would give the model away, so the roll is scaled by
    // speed — and that is worth an assertion, because the departure turns hardest in the second
    // it spends going nowhere.
    if (st.speed < 1) hoverLean = Math.max(hoverLean, Math.abs(st.roll));

    // The attitude wobble rides on top of the flight at pose time: the machine is never rigid in
    // the air and dead still on its skids. Read off the group the game actually draws, since the
    // whole point of it is that it is *not* in the state the flight model computes.
    const posed = chopper.group.rotation;
    const jitter = Math.abs(posed.x - st.roll) + Math.abs(posed.y - st.yaw)
      + Math.abs(posed.z - st.pitch);
    if (st.mode === 'idle') { if (jitter > 1e-9) twitchyOnDeck++; }
    else if (st.y - pad.y > 4 && jitter > 0.02) restless++;
    if (Math.abs(st.roll) > 0.1 && st.fade > 0.99
      && Math.abs(st.x) < HALF_SPAN_X && Math.abs(st.z) < HALF_SPAN_Z) bankedOverCity++;

    // Clearance, skipping the pad's own tower — the roof directly under it is the point of the
    // exercise. Measured to the *rotor* radius, since that is the widest part of the machine.
    if (dist > OWN_ROOF) {
      clearance = Math.min(clearance, (st.y - HELI_SKID_DROP) - tallestNear(st.x, st.z, MAIN_R));
    }

    if (st.mode === 'idle') {
      if (st.fade < 1) hiddenOverPad++;
      if (landings !== st.landings) {
        landings = st.landings;
        // The skids, not the origin: the model's own centre is a unit and a half forward of them.
        const f = { x: Math.cos(st.yaw), z: -Math.sin(st.yaw) };
        parkOffset = Math.max(parkOffset, Math.hypot(
          st.x + f.x * 0.575 - pad.x, st.z + f.z * 0.575 - pad.z,
        ));
        // Sitting along the roof rather than across it — the tail boom overhangs either way, and
        // the deck's long axis is the direction with room for it.
        const off = Math.abs(wrapPi(st.yaw - (alongX ? 0 : Math.PI / 2)));
        if (Math.min(off, Math.PI - off) > 0.5) backwards++;
      }
    }
    if (st.mode === 'out') {
      departError = Math.max(departError, Math.abs(Math.abs(wrapPi(st.inbound - st.departYaw)) - Math.PI));
    }
  }

  check('the helicopter visits every so often, not constantly',
    chopper.state.visits >= 3 && flying / frames < 0.35,
    `${chopper.state.visits} visits in 10 min, up ${(100 * flying / frames).toFixed(0)}% of it`);
  check('and lands on every one of them', chopper.state.landings === chopper.state.visits,
    `${chopper.state.landings} landings against ${chopper.state.visits} visits`);
  check('it puts its skids on the H, not its nose', parkOffset < 0.2,
    `worst ${parkOffset.toFixed(2)} units off centre`);
  check('and sits along the deck rather than across it', backwards === 0,
    `${backwards} of ${chopper.state.landings} landings across a ${pad.cw.toFixed(1)}×${pad.cd.toFixed(1)} roof`);
  check('and leaves the way it came', departError < 0.4,
    `departure ${departError.toFixed(2)} rad off the reverse of the approach`);
  check('it never drops through the roof it lands on', belowPad === 0,
    `${belowPad} frames below the pad`);

  // The one that the level transit and the vertical descent exist for. A glide slope onto the pad
  // flew through a neighbouring tower on eleven cities in twenty-four, and nothing about that
  // failure is loud: it is a helicopter passing behind a building it is actually inside.
  check('and never flies through anything on the way in or out', clearance > 0,
    `worst clearance ${clearance.toFixed(2)} units over the city`);

  check('it banks where the bank can be seen', bankedOverCity > 60 && maxRoll > 0.35,
    `${bankedOverCity} frames of lean over the map, peak ${maxRoll.toFixed(2)} rad`);
  check('and never leans on a hover', hoverLean < 0.05,
    `worst ${hoverLean.toFixed(3)} rad with nothing on the clock`);
  check('it is never rigid in the air, and never twitches on the deck',
    restless > 600 && twitchyOnDeck === 0,
    `${restless} unsteady frames aloft, ${twitchyOnDeck} on the skids`);
  check('it is fully painted while it is on the deck', hiddenOverPad === 0,
    `${hiddenOverPad} frames faded while parked`);
  check('the beacon blinks rather than sitting on or off',
    beaconOn > 0 && beaconOff > beaconOn,
    `lit ${(100 * beaconOn / (beaconOn + beaconOff)).toFixed(0)}% of the time it is up`);
  // Dust comes off the deck it is landing on, at the height of the paint. A wash spawned at the
  // road's default height would go up eleven storeys below the machine making it, on a street.
  check('the rotor wash comes off the pad, not off the road',
    washes > 20 && bursts >= 2 * chopper.state.landings && washOffPad === 0,
    `${washes} puffs and ${bursts} bursts over ${chopper.state.landings} landings, ${washOffPad} off the deck`);

  chopperOrder = chopper.group.rotation.order;
}

// --- The park flock -------------------------------------------------------------
// Birds in a park have the flyover's problem twice over: nothing about them can fail loudly. A
// bird that sinks into the grass, walks off the lawn onto the road, beats one wing up while the
// other goes down, or winks out instead of fading is a thing somebody has to *notice* in a moving
// picture — so all of it is asserted here, where it is arithmetic.
{
  const bodyGeometry = birdBodyGeometry();
  bodyGeometry.computeBoundingBox();
  const bounds = bodyGeometry.boundingBox;
  check('the bird model measures what geometry/bird.js says it does',
    Math.abs((bounds.max.x - bounds.min.x) - BIRD_LEN) < 1e-6
    && Math.abs(-bounds.min.y - BIRD_STAND_Y) < 1e-6,
    `${(bounds.max.x - bounds.min.x).toFixed(2)} long, standing ${(-bounds.min.y).toFixed(2)} clear of its origin`);

  // The wings are two geometries rather than one mirrored by a negative scale — a mirror flips
  // every triangle's winding, and `flatShading` then lights the whole wing as if the sun were
  // behind it. Measured off both, so a copy-paste that left one side pointing the wrong way shows
  // up as a span rather than as a shape nobody looked at closely.
  const wingBounds = (side) => {
    const geometry = birdWingGeometry(side);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox.clone();
    geometry.dispose();
    return box;
  };
  const rightWing = wingBounds(1);
  const leftWing = wingBounds(-1);
  const span = (rightWing.max.z + WING_ROOT.z) - (leftWing.min.z - WING_ROOT.z);
  check('the wings span what geometry/bird.js says they do', Math.abs(span - BIRD_SPAN) < 1e-6,
    `${span.toFixed(2)} tip to tip`);

  // Ten minutes of a flock's life, which is several visits and a lot more standing about.
  const birdScene = new THREE.Scene();
  const flock = createBirds(birdScene, makeRng(seed + 199), layout);
  const [flockBody, flockLeft, flockRight] = flock.meshes;

  let onGround = 0;
  let frames = 0;
  let lowest = Infinity;              // the lowest point of the lowest bird, ever
  let offTheGrass = 0;                // walking birds outside the park they live in
  let dimOnTheGrass = 0;              // frames on the deck at less than full paint
  let fadeStep = 0;                   // the biggest one-frame change in opacity
  let wingFaults = 0;                 // frames where the two wings disagreed about which way is up
  let shadowAloft = 0;                // frames casting shadows with a bird well off the ground
  let lastFade = flock.state.fade;

  const matrix = new THREE.Matrix4();
  const tip = new THREE.Vector3();
  const shoulder = new THREE.Vector3();
  // Rise of a wingtip above its own shoulder, read off the instance matrix the flock actually
  // wrote — not recomputed from the flap angle, which is the half of it that could be wrong.
  const tipRise = (mesh, index, tipZ) => {
    mesh.getMatrixAt(index, matrix);
    tip.set(0, 0, tipZ).applyMatrix4(matrix);
    shoulder.set(0, 0, 0).applyMatrix4(matrix);
    return tip.y - shoulder.y;
  };

  for (let step = 0; step < 600 * 60; step++) {
    flock.update(1 / 60);
    frames++;

    if (flock.group.visible) {
      fadeStep = Math.max(fadeStep, Math.abs(flock.state.fade - lastFade));
      lastFade = flock.state.fade;
    } else {
      lastFade = flock.state.fade;
    }

    const area = flock.state.area;
    let highest = -Infinity;
    for (const bird of flock.birds) {
      lowest = Math.min(lowest, bird.y - BIRD_STAND_Y);
      highest = Math.max(highest, bird.y);
      if (flock.state.mode === 'ground'
        && (bird.x < area.x0 || bird.x > area.x1 || bird.z < area.z0 || bird.z > area.z1)) {
        offTheGrass++;
      }
    }
    if (flockBody.castShadow && highest > SHADOW_CEILING) shadowAloft++;

    if (flock.state.mode === 'ground') {
      onGround++;
      if (flock.state.fade !== 1) dimOnTheGrass++;
    } else if (flock.state.mode === 'up' || flock.state.mode === 'in') {
      for (let i = 0; i < flock.birds.length; i++) {
        // Only on a strong upstroke: at a shallow angle the body's own bank is the same order as
        // the beat, and this is a test of the beat's sign rather than of the bank's.
        if (flock.birds[i].flap < 0.6) continue;
        if (tipRise(flockLeft, i, leftWing.min.z) <= 0) wingFaults++;
        if (tipRise(flockRight, i, rightWing.max.z) <= 0) wingFaults++;
      }
    }
  }

  check('the flock comes and goes, and spends most of its life on the grass',
    flock.state.flights >= 3 && flock.state.landings >= 3 && onGround / frames > 0.45,
    `${flock.state.flights} departures in 10 min, ${(100 * onGround / frames).toFixed(0)}% of it on the deck`);
  check('no bird ever sinks into the grass', lowest >= KERB_H - 1e-9,
    `lowest sole ${lowest.toFixed(3)} against a park surface at ${KERB_H.toFixed(2)}`);
  check('a walking bird stays inside its park', offTheGrass === 0,
    `${offTheGrass} bird-frames out over the kerb`);
  check('the flock is fully painted while it is on the ground', dimOnTheGrass === 0,
    `${dimOnTheGrass} frames walking about half-there`);
  // The fade is the whole of how a departure ends, so a jump in it is a pop — which is the one
  // failure here that a player would actually see.
  check('it fades rather than winking out', fadeStep < 0.05,
    `biggest one-frame opacity change ${fadeStep.toFixed(4)}`);
  check('both wings beat the same way up', wingFaults === 0,
    `${wingFaults} wingtips below their own shoulder on an upstroke`);
  // The shadow pass ignores a material's opacity, so a faded-out flock that kept casting would
  // drag hard shadows across the city with nothing visible above them.
  check('it stops casting shadows once it is off the ground', shadowAloft === 0,
    `${shadowAloft} frames casting from altitude`);
  // A moving InstancedMesh latches its bounding sphere on the first frame it is culled and never
  // recomputes it — the trap the ambient trucks were lost to.
  check('the flock is never frustum-culled', flock.meshes.every((m) => m.frustumCulled === false),
    `${flock.meshes.length} meshes for the whole flock`);
  check('the city has parks for it to live in', parkAreas(layout).length > 0,
    `${parkAreas(layout).length} green areas`);

  // The taxi coming past is what puts them up. Driven as a car that *shadows* the flock at a fixed
  // gap, which is not a thing that happens in a run — but a car parked somewhere plausible next to
  // the park is a test of where the birds happened to land, and this is a test of the range.
  //
  // The window it has to fire in is the whole point of the pair. `SETTLE_MIN` is what stops a park
  // one block off two streets from putting its birds in the air for the whole run; a range that
  // reached a street over would do the same thing by the other route.
  const startleAfter = (park) => {
    const startleScene = new THREE.Scene();
    const startled = createBirds(startleScene, makeRng(seed + 199), layout);
    // Short of GROUND_STAY's floor, so a flock that leaves on its own timer never reaches the end
    // of this loop and Infinity means "the taxi did not do it".
    for (let step = 0; step < 24 * 60; step++) {
      startled.update(1 / 60, park(startled.birds));
      if (startled.state.mode !== 'ground') return (step + 1) / 60;
    }
    return Infinity;
  };
  // Three units off one bird, so the nearest bird is inside the range whatever the flock does.
  const nearOne = (flying) => ({ x: flying[0].x + 3, z: flying[0].z });
  // And past the whole flock rather than past one of them: a point twelve units from the bird you
  // measured is not twelve units from the other nine, which is what a first attempt at this
  // measured and why it read as a range that reaches a street over when it doesn't.
  const clearOfAll = (flying) => ({
    x: Math.max(...flying.map((bird) => bird.x)) + STARTLE_RANGE + 4,
    z: flying[0].z,
  });
  const startledAt = startleAfter(nearOne);
  check('the taxi coming past puts the flock up, and not before it has settled',
    startledAt > SETTLE_MIN - 0.05 && startledAt < SETTLE_MIN + 0.2,
    `up ${startledAt.toFixed(2)}s in, against a ${SETTLE_MIN}s settle`);
  check('a taxi a street over leaves them alone', startleAfter(clearOfAll) === Infinity,
    `${STARTLE_RANGE + 4} units clear of every bird for 24s`);

  // Which axis a bird banks about. Read off `bodyQuaternion` — the function the flock poses every
  // bird with — rather than off a string, so a call site that went back to the default order fails
  // here. See the section below for what the default order actually does.
  const birdLean = (yaw) => new THREE.Vector3(0, 0, 1)
    .applyQuaternion(bodyQuaternion(0.2, yaw, 0.06, new THREE.Quaternion())).y;
  const birdLeans = [0, Math.PI / 2, Math.PI, -Math.PI / 2].map(birdLean);
  check('a bird banks about its own long axis at every heading',
    Math.abs(birdLeans[0]) > 0.1 && birdLeans.every((y) => Math.abs(y - birdLeans[0]) < 1e-9),
    `lean ${birdLeans.map((y) => y.toFixed(2)).join(', ')} east/north/west/south`);

  // --- Two flocks, two parks ------------------------------------------------------
  // `main.js` runs a pair, wired to keep off each other's lawn. Built here exactly the way it
  // builds them — the loop-and-push, the `avoid` closure and both seed offsets — because the part
  // that can break is the wiring, not the flock: a callback that read the wrong flock's state, or
  // one evaluated once at construction instead of at every pick, still produces two flocks that
  // fly perfectly well and spend the run standing in the same park.
  const pairScene = new THREE.Scene();
  const pair = [];
  for (const offset of [199, 211]) {
    pair.push(createBirds(pairScene, makeRng(seed + offset), layout, {
      avoid: (state) => pair.filter((f) => f.state !== state).map((f) => f.state.area),
    }));
  }

  // Every seed the layout generator produces has at least two areas big enough for a flock, so the
  // pair should never be forced to share. Asserted over the whole sweep of city seeds rather than
  // this one, since "how many parks does a city get" is the thing that would quietly make the
  // second flock pointless — and it is the layout generator's to change, not this file's.
  let leanestCity = Infinity;
  for (let s = 0; s < 200; s++) leanestCity = Math.min(leanestCity, parkAreas(createLayout(makeRng(s))).length);
  check('every city has a park for each flock', leanestCity >= 2,
    `${leanestCity} green areas in the barest of 200 city seeds`);

  // Put the probe's own city back — same trap as the building sweep above, and it had already
  // sprung here. This sweep left seed 199's town installed, so every block below it was measuring
  // a city it never chose: the roadworks vignette closed whichever street *that* city offered and
  // then asked whether discounting it reroutes anything, which on seed 199 it does not. The check
  // passed only because the street it happened to land on was one where it did.
  createLayout(makeRng(seed));

  let shared = 0;                     // frames with both flocks claiming the same green
  let bothOnTheDeck = 0;              // frames neither is flying, i.e. when it would be seen
  for (let step = 0; step < 600 * 60; step++) {
    for (const flock of pair) flock.update(1 / 60);
    if (pair.every((f) => f.state.mode === 'ground')) {
      bothOnTheDeck++;
      if (pair[0].state.area === pair[1].state.area) shared++;
    }
  }
  check('the two flocks keep to separate parks', shared === 0,
    `${shared} of ${bothOnTheDeck} frames with both on the grass had them sharing one`);
  // They are on separate seed offsets so that a run has one flock on the grass while the other is
  // out — a pair that moved together would be one flock drawn twice.
  check('the two flocks lead separate lives',
    pair[0].state.flights !== pair[1].state.flights || pair[0].state.area !== pair[1].state.area,
    `${pair[0].state.flights} and ${pair[1].state.flights} departures in the same 10 min`);
}

// --- Which axis a body rolls about ---------------------------------------------
// Everything in the game that leans writes `rotation.set(roll, yaw, pitch)`, and the Euler order
// that lands on decides what the first of those three actually means. Three composes the default
// 'XYZ' as Rx·Ry·Rz, which puts the roll *outside* the yaw and turns it about the world X axis:
// a car driving east leans correctly, one driving north or south renders the same number as pitch
// and shows no lean at all, and one driving west leans the opposite way. 'YXZ' is Ry·Rx·Rz — yaw
// first, so the roll turns about the body's own long axis and reads the same at every heading.
//
// This shipped for a long time and was invisible because everything that leans is *also* usually
// turning, so the missing lean looked like a car that simply wasn't leaning much. It surfaced when
// the overtake got a bank of its own: the passing lab's road runs due east, where the two orders
// agree exactly, so the lane change leaned beautifully at /lab/ and did nothing in the game.
{
  // The lean the eye actually reads: how far the body's right-hand side (+Z in model space) has
  // been lifted or dropped out of the ground plane, at each of the four headings a street runs.
  const leanByHeading = (order) => [0, Math.PI / 2, Math.PI, -Math.PI / 2].map((yaw) => new THREE.Vector3(0, 0, 1)
    .applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.2, yaw, 0.06, order))).y);
  const sameEverywhere = (order) => {
    const [east, ...rest] = leanByHeading(order);
    return Math.abs(east) > 0.1 && rest.every((y) => Math.abs(y - east) < 1e-9);
  };

  // The order is read off the objects the game actually draws, not asserted as a string, so the
  // check fails the moment a call site goes back to the default — which is what happened.
  const bodyScene = new THREE.Scene();
  const bodyTraffic = createTraffic(makeRng(seed + 302), bodyScene, 4);
  const bodyPolice = createPolice(makeRng(seed + 303), bodyScene, bodyTraffic.cars);
  for (let step = 0; step < 60 * 90; step++) {
    bodyTraffic.update(1 / 60);
    bodyPolice.update(1 / 60);
  }

  // Proof the metric can tell the two apart, so a bug in it can't quietly pass everything.
  check('the default rotation order really would lose the lean', !sameEverywhere('XYZ'),
    `world-X roll reads ${leanByHeading('XYZ').map((y) => y.toFixed(2)).join(', ')} east/north/west/south`);
  check('the taxi leans the same on every street', sameEverywhere(bodyTraffic.taxiGroup.rotation.order),
    `order ${bodyTraffic.taxiGroup.rotation.order}`);
  check('so do the ambient cars', sameEverywhere(BODY_EULER_ORDER),
    `order ${BODY_EULER_ORDER}`);
  check('and the police cruiser', sameEverywhere(bodyPolice.group.rotation.order),
    `order ${bodyPolice.group.rotation.order}`);
  check('and the aeroplane banks about its fuselage', sameEverywhere(planeOrder),
    `order ${planeOrder}`);
  check('and so does the helicopter', sameEverywhere(chopperOrder),
    `order ${chopperOrder}`);
}

// --- The barricade's geometry, before any of it is placed ----------------------
// The ramp shipped wound inside out: its slope normals came out at y = -0.98 and its underside's
// at +1.00, so the only face the camera ever saw was the bottom — a flat quad lying exactly on the
// road, which read as a patch of z-fighting near the junction. `flatShading` takes its normal from
// a screen-space derivative, so the wrong-facing quad still lit like a surface rather than going
// black, and it survived a screenshot review. Hence a test on the numbers.
{
  const { ramp } = barricadeParts({ width: ROAD_W - 0.4, centreX: -LANE });
  const pos = ramp[0].getAttribute('position');
  // Face normals straight off the winding, which is the thing under test — `computeVertexNormals`
  // would launder a reversed triangle into whatever its neighbours said.
  const faces = [];
  for (let f = 0; f < pos.count / 3; f++) {
    const p = [0, 1, 2].map((k) => new THREE.Vector3().fromBufferAttribute(pos, f * 3 + k));
    faces.push(new THREE.Vector3()
      .subVectors(p[1], p[0]).cross(new THREE.Vector3().subVectors(p[2], p[0])).normalize());
  }
  // Written in this order by `rampWedge`: slope, vertical back, underside, the two sides.
  const slope = faces.slice(0, 2);
  const underside = faces.slice(4, 6);

  check('the ramp\'s slope faces the sky and its underside faces the road',
    slope.every((n) => n.y > 0.9) && underside.every((n) => n.y < -0.99),
    `slope y ${slope.map((n) => n.y.toFixed(2)).join('/')}, `
    + `underside y ${underside.map((n) => n.y.toFixed(2)).join('/')}`);

  // The slope's pitch, from the same normals. Shallow enough and it is a plate, not a ramp — the
  // first pair was 0.66 over 3.2, which is 12°.
  const pitch = Math.acos(slope[0].y) * 180 / Math.PI;
  check('and it is pitched steeply enough to read as a ramp',
    pitch > 15 && pitch < 25, `${pitch.toFixed(1)}° from ${RAMP_H} over ${RAMP_RUN}`);

  // Nothing coplanar with the road slab (0), the lane paint (0.02) or the route band (0.03). A
  // flat face at any of those three z-fights whatever is already drawn there.
  let lowest = Infinity;
  for (let v = 0; v < pos.count; v++) lowest = Math.min(lowest, pos.getY(v));
  check('the ramp sits clear of the road paint and the route band',
    Math.abs(lowest - WORKS_Y) < 1e-6 && WORKS_Y > 0.03,
    `lowest vertex ${lowest.toFixed(3)} against band 0.03`);

  const hole = spoilParts(0, 0, makeRng(seed + 909))[1].getAttribute('position');
  let holeY = -Infinity;
  for (let v = 0; v < hole.count; v++) holeY = Math.max(holeY, hole.getY(v));
  check('and the trench is above the lane paint but under the route band',
    Math.abs(holeY - TRENCH_Y) < 1e-6 && holeY > 0.02 && holeY < 0.03,
    `${holeY.toFixed(3)} in (0.02, 0.03)`);

  // The chain the landing depends on: the ramp runs RAMP_RUN back from BARRIER_S, so its toe is at
  // the difference and that has to stay on the tarmac. At 1.7 against a 3.2 ramp it was -1.5,
  // which put the toe in the middle of a live intersection.
  check('the ramp\'s toe is inside the lane, not in the junction behind it',
    BARRIER_S - RAMP_RUN > 0,
    `toe at ${(BARRIER_S - RAMP_RUN).toFixed(2)} (barrier ${BARRIER_S} - run ${RAMP_RUN})`);
}

// --- A street closed for roadworks ---------------------------------------------
// The vignette has two halves that can fail silently. The closure is a *soft* one — two lane ids
// that zero a turn's weight rather than a road removed from the graph — so a mistake there does
// not throw, it just puts ambient cars back inside the barricades or, worse, strands one at a
// hold line it can never leave. And the taxi's ramp is drawn from `car.travelled`, so a mistake
// there is a stunt that gets longer the faster you are going and lands inside a junction.
{
  setClosedLanes([]);
  const rwScene = new THREE.Scene();
  const rwTraffic = createTraffic(makeRng(seed + 210), rwScene, 24);
  const rwCars = rwTraffic.cars;
  const rwTaxi = rwTraffic.taxi;
  for (let step = 0; step < 300; step++) rwTraffic.update(1 / 60);

  const roadwork = createRoadwork(makeRng(seed + 211), rwScene, null);
  const placed = roadwork.place(rwTaxi, rwCars, []);
  const net = cityNetwork();
  const closedIds = new Set(roadwork.closedLaneIds);
  const closed = roadwork.closedLaneIds.map((id) => net.laneById.get(id));

  check('a construction zone finds a street to close', placed && closed.length === 2,
    placed ? closed.map((l) => l.id).join(' + ') : 'no candidate');

  check('it closes a side street, never an arterial or the ring',
    closed.every((l) => l.edge.klass === 'side'), closed[0]?.edge.klass);

  // The invariant that actually matters. A car whose every onward lane is closed can never leave
  // the junction — U-turns are illegal — so it holds at the line with its whole lane behind it.
  let stranded = 0;
  for (const end of [closed[0].edge.a, closed[0].edge.b]) {
    for (const lane of net.nodeById.get(end).inbound) {
      if (lane.degenerate) continue;
      if (!lane.onward.some((out) => !closedIds.has(out.id))) stranded += 1;
    }
  }
  check('no approach to either end is left with nowhere to go', stranded === 0,
    `${stranded} stranded approaches`);

  // Cones and the hole go on the *tarmac between* the junctions. An edge runs node centre to node
  // centre, so laying them out along it puts the first and last few across two live intersections.
  const lane = closed[0];
  const a = lane.path.at(0);
  const b = lane.path.at(lane.length);
  const ux = (b.x - a.x) / lane.length;
  const uz = (b.z - a.z) / lane.length;
  let worstLateral = 0;
  let outsideSpan = 0;
  const laterals = [];
  for (const cone of roadwork.cones) {
    const along = (cone.x - a.x) * ux + (cone.z - a.z) * uz;
    // Lateral offset from the road centreline, which sits LANE to the left of this lane.
    const lateral = (cone.x - a.x) * uz - (cone.z - a.z) * ux + LANE;
    worstLateral = Math.max(worstLateral, Math.abs(lateral));
    laterals.push(lateral);
    if (along < 0 || along > lane.length) outsideSpan += 1;
  }
  check('every cone is on the tarmac, clear of both junction boxes',
    outsideSpan === 0 && worstLateral < ROAD_W / 2,
    `${outsideSpan} past an end, worst offset ${worstLateral.toFixed(2)} of ${ROAD_W / 2}`);

  // Two rows rather than a scatter. This was a sine zigzag that wandered across the centreline,
  // which read as cones dropped at random — the order has to be legible before the jitter on top of
  // it reads as a crew having placed them rather than as noise.
  const rowError = Math.max(...laterals.map((v) => Math.abs(Math.abs(v) - CONE_ROW)));
  const perSide = laterals.filter((v) => v > 0).length;
  check('the cones stand in two rows, one either side of the works',
    rowError < 0.2 && perSide === roadwork.cones.length / 2,
    `${perSide}/${roadwork.cones.length - perSide} split, worst row error ${rowError.toFixed(3)}`);

  // The near row has to be in the taxi's way and the far row out of it, or driving through is
  // either a clean corridor or a wall. The taxi tracks a lane centre at LANE and is CAR_W wide.
  check('one row is in the taxi\'s path and the other survives it',
    CONE_ROW < LANE + CAR_W / 2 && CONE_ROW > LANE - 1,
    `row at ${CONE_ROW}, taxi flank reaches ${(LANE + CAR_W / 2).toFixed(2)}`);

  // Ambient traffic routes around it. Sampled every frame rather than at the end, because a car
  // that turns in and out again between two samples is exactly the bug this is looking for.
  let intrusions = 0;
  let held = 0;
  for (let step = 0; step < 150 * 60; step++) {
    rwTraffic.update(1 / 60);
    roadwork.update(1 / 60, rwTaxi, rwCars, []);
    for (const car of rwCars) {
      if (car === rwTaxi) continue;
      if (closedIds.has(car.lane?.id)) intrusions += 1;
      if (car.v < 0.01) held += 1;
    }
  }
  check('no ambient car enters the closure over 150s', intrusions === 0,
    `${intrusions} car-frames inside the barricades`);
  check('closing a street does not wedge the traffic model',
    rwTraffic.stats.routeDesync === 0 && rwTraffic.stats.violations === 0,
    `desync ${rwTraffic.stats.routeDesync}, red-light violations ${rwTraffic.stats.violations}, `
    + `${(held / (150 * 60 * rwCars.length) * 100).toFixed(0)}% of car-frames stationary`);

  check('the zone finishes rising out of the road and everything is at rest',
    roadwork.state.phase === 'live' && roadwork.active() === 0);

  // --- The ramp -------------------------------------------------------------
  // Driven at two very different speeds, because the arc is paced by distance and the whole point
  // of that is that the two agree. A time-paced hop covers 4.25 units at cruise and 11.5 in
  // overdrive, which is most of a 12-unit lane — the taxi would still be in the air at the line
  // where it picks its next turn.
  const flights = [];
  for (const boosting of [false, true]) {
    setClosedLanes([]);
    const runScene = new THREE.Scene();
    const runTraffic = createTraffic(makeRng(seed + 212), runScene, 6);
    const runwork = createRoadwork(makeRng(seed + 211), runScene, null);
    for (let step = 0; step < 300; step++) runTraffic.update(1 / 60);
    if (!runwork.place(runTraffic.taxi, runTraffic.cars, [])) continue;
    // Let the zone finish rising before staging the run at it. A player reaches one long after it
    // has settled, and a barricade half out of the road is a different test.
    while (runwork.state.phase !== 'live') runwork.update(1 / 60, runTraffic.taxi, runTraffic.cars, []);

    const taxi = runTraffic.taxi;
    const target = net.laneById.get(runwork.closedLaneIds[0]);
    const [ti, tj] = target.to.split(',').map(Number);
    // placeCar takes the junction the car is *heading for*, so this lands the taxi on the closed
    // lane itself, a unit short of the barricade at its mouth.
    placeCar(taxi, cityNetwork().dirOfLane(target), ti, tj, target.length - 1);
    taxi.boost = boosting;
    taxi.v = boosting ? 22 : SPEED;

    let smashes = 0;
    let lands = 0;
    let peakY = 0;
    let launchAt = null;
    let air = null;
    let airborneAtLine = false;
    // The wreckage, sampled every frame rather than read at the end: a cone that goes up and comes
    // back down is indistinguishable from one that never left the road once it has landed, and
    // "flipped into the air" is the whole claim being made.
    let peakCone = 0;
    let peakChip = 0;
    // Frames spent in the landing bounce. The curve itself is asserted separately, off
    // `landingBounce` — see below for why it cannot usefully be measured off the rendered taxi.
    let bounceFrames = 0;
    runwork.onSmash(() => { smashes += 1; });
    runwork.onLand(() => { lands += 1; });

    for (let step = 0; step < 60 * 6; step++) {
      const before = taxi.hopFrom;
      runTraffic.update(1 / 60);
      runwork.update(1 / 60, taxi, runTraffic.cars, []);
      if (before == null && taxi.hopFrom != null) launchAt = taxi.hopFrom;
      if (taxi.hopFrom != null) {
        peakY = Math.max(peakY, runTraffic.taxiGroup.position.y - ROAD_Y);
        // The line where the next turn is chosen. Still airborne there and the stunt has outrun
        // its own street.
        if (taxi.lane && taxi.s >= taxi.lane.length - STOP_SETBACK) airborneAtLine = true;
      }
      if (before != null && taxi.hopFrom == null && air === null) {
        air = taxi.travelled - launchAt;
      }
      if (taxi.hopFrom == null && taxi.bounceT != null) bounceFrames += 1;
      for (const cone of runwork.cones) if (cone.knocked) peakCone = Math.max(peakCone, cone.y);
      for (const chip of runwork.chips) if (chip.live) peakChip = Math.max(peakChip, chip.y);
    }
    flights.push({
      boosting, smashes, lands, peakY, air, airborneAtLine, taxi, runwork,
      peakCone, peakChip, bounceFrames,
    });
  }

  const cruise = flights.find((f) => !f.boosting);
  const fast = flights.find((f) => f.boosting);

  check('the taxi rams the barricade and is launched off it',
    flights.length === 2 && flights.every((f) => f.smashes >= 1 && f.lands === 1),
    flights.map((f) => `${f.boosting ? 'boost' : 'cruise'} ${f.smashes} smash / ${f.lands} land`).join(', '));

  check('it actually leaves the road and comes back down',
    flights.every((f) => f.peakY > 1.2 && Math.abs(f.taxi.hopFrom ?? 0) === 0),
    flights.map((f) => `peak ${f.peakY.toFixed(2)}`).join(', '));

  // One frame of slack: the flag clears on the first frame past the arc's end, so the measured
  // distance overshoots by whatever that frame covered.
  check('the hop is the same length at cruise and in overdrive',
    cruise && fast
    && cruise.air >= HOP_LEN && cruise.air < HOP_LEN + SPEED / 60 + 1e-6
    && fast.air >= HOP_LEN && fast.air < HOP_LEN + 23 / 60 + 1e-6,
    `${cruise?.air?.toFixed(3)} vs ${fast?.air?.toFixed(3)} against HOP_LEN ${HOP_LEN}`);

  check('and it is back on the tarmac before the line where it picks its next turn',
    flights.every((f) => !f.airborneAtLine));

  // The same fact as a number rather than an outcome, because it is a chain of three constants that
  // have to keep closing: the taxi launches at BARRIER_S and lands HOP_LEN later, against a hold
  // line STOP_SETBACK back from the end of a lane. Moving BARRIER_S out to clear the junction ate
  // most of the old slack (2.1 + 6.0 = 8.1 against 8.6), which is why HOP_LEN came down to 5.5.
  // Asserting only the outcome lets any one of the three drift until a fast run happens to fail.
  const holdS = closed[0].length - STOP_SETBACK;
  const margin = holdS - (BARRIER_S + HOP_LEN);
  check('the launch-to-landing chain leaves real slack before the hold line',
    margin > 0.75,
    `lands at ${(BARRIER_S + HOP_LEN).toFixed(2)}, line at ${holdS.toFixed(2)}, `
    + `margin ${margin.toFixed(2)}`);

  check('going through knocks the cones over, and they come to rest',
    flights.every((f) => f.runwork.cones.filter((c) => c.knocked).length >= 4
      && f.runwork.active() === 0),
    flights.map((f) => `${f.runwork.cones.filter((c) => c.knocked).length} knocked`).join(', '));

  // --- The wreckage ---------------------------------------------------------
  // "More chaotic" is a look, but the two things carrying it are numbers: cones that genuinely
  // leave the road rather than sliding along it, and wood off the trestle at all. Both are bounded
  // above as well as below — a cone thrown eleven units up (which SMASH_POWER without CONE_VY_MAX
  // would do at the overdrive top) leaves the frame on a close shot, and debris that outlives the
  // zone is a prop nobody cleared away.
  check('a smash flips cones into the air rather than sliding them along the road',
    flights.every((f) => f.peakCone > 1.2 && f.peakCone < 4),
    flights.map((f) => `${f.boosting ? 'boost' : 'cruise'} peak ${f.peakCone.toFixed(2)}`).join(', '));

  check('and blows splinters off the barricade, which land flat on the road',
    flights.every((f) => {
      const thrown = f.runwork.chips.filter((c) => c.live);
      return thrown.length >= 12
        && thrown.every((c) => c.age >= c.dur && Math.abs(c.y - SPLINTER_REST_Y) < 1e-6);
    }),
    flights.map((f) => `${f.runwork.chips.filter((c) => c.live).length} chips, `
      + `up to ${f.peakChip.toFixed(2)}`).join(', '));

  // The landing bounce, in two halves.
  //
  // First that the taxi enters it *on touchdown and at both speeds*: it is paced by a clock while
  // the arc above it is paced by distance, so the two are wired together at exactly one point — the
  // frame the arc ends — and a bounce that never started would be invisible in every other number
  // here. Same frame count at cruise and in overdrive is the point of the clock.
  const bounceFrames = Math.round(BOUNCE_DUR * 60);
  check('touchdown hands off to a landing bounce, the same length at either speed',
    flights.every((f) => Math.abs(f.bounceFrames - bounceFrames) <= 1
      && f.taxi.bounceT == null),
    flights.map((f) => `${f.boosting ? 'boost' : 'cruise'} ${f.bounceFrames}`).join(', ')
    + ` against ${bounceFrames} frames`);

  // ...and then the curve itself, off `landingBounce` rather than off the rendered taxi. The
  // rendered height also carries the speed bob and the pitch lift, and in overdrive those are three
  // times the size of the bounce — measured there, a bounce of zero passes and a bounce of double
  // fails. Two decaying rebounds, the second clearly smaller, back to nothing by the end, and the
  // whole thing well under the jump it follows: a landing that out-hops the hop reads as a ramp.
  {
    const samples = Array.from({ length: 61 }, (_, n) => landingBounce((n / 60) * BOUNCE_DUR));
    const peakAt = (from, to) => Math.max(...samples.slice(from, to));
    const first = peakAt(0, 31);
    const second = peakAt(31, 61);
    const jump = Math.min(...flights.map((f) => f.peakY));
    check('the bounce is two decaying rebounds that end on the road',
      first > 0.3 && first < jump * 0.35
      && second > 0.05 && second < first * 0.6
      && landingBounce(-0.1) === 0 && landingBounce(BOUNCE_DUR) === 0
      && samples[0] === 0,
      `rebounds ${first.toFixed(2)} then ${second.toFixed(2)}, against a ${jump.toFixed(2)} jump`);
  }

  // --- The dust off a barricade ---------------------------------------------
  // The smash used to emit two ordinary trail puffs, which is exactly what a boosting taxi lays
  // down in two frames — the one impact in the run looked like exhaust. Measured against a single
  // trail puff so the assertion is "bigger than the thing it was confused with", not a magic
  // number: pull the per-instance scale straight off the InstancedMesh.
  {
    const puffScene = new THREE.Scene();
    const trail = createDust(puffScene, null, makeRng(seed + 501));
    const boom = createDust(puffScene, null, makeRng(seed + 501));

    const scales = (d) => {
      const m = new THREE.Matrix4();
      const v = new THREE.Vector3();
      const out = [];
      for (let n = 0; n < d.mesh.count; n++) {
        d.mesh.getMatrixAt(n, m);
        m.decompose(new THREE.Vector3(), new THREE.Quaternion(), v);
        if (v.x > 0) out.push(v.x);
      }
      return out;
    };

    trail.add(0, 0, 0);
    trail.update(1 / 60);
    boom.burst(0, 0, 0);
    boom.update(1 / 60);

    const one = scales(trail);
    const many = scales(boom);
    check('a barricade throws a burst of dust, not a boost puff',
      many.length >= 10 && many.length > one.length * 5
      && Math.max(...many) > Math.max(...one) * 1.5,
      `${many.length} puffs at up to ${Math.max(...many).toFixed(2)} `
      + `against ${one.length} at ${Math.max(...one).toFixed(2)}`);
  }

  // --- Packing up once the taxi has been through ----------------------------
  // The zone clears itself away afterwards, and the half of that which is not cosmetic is giving
  // the street *back*. Two lane sets were pushed out when it was built — one that keeps ambient
  // traffic out, one that tempts the taxi in — and a teardown that forgets either leaves the city
  // with an invisible closure it drives around for the rest of the run.
  {
    setClosedLanes([]);
    setRoadworkLanes([]);
    const outScene = new THREE.Scene();
    const outTraffic = createTraffic(makeRng(seed + 212), outScene, 6);
    const outWork = createRoadwork(makeRng(seed + 211), outScene, null);
    for (let step = 0; step < 300; step++) outTraffic.update(1 / 60);

    let cleared = 0;
    outWork.onCleared(() => { cleared += 1; });

    if (outWork.place(outTraffic.taxi, outTraffic.cars, [])) {
      while (outWork.state.phase !== 'live') {
        outWork.update(1 / 60, outTraffic.taxi, outTraffic.cars, []);
      }

      const taxi = outTraffic.taxi;
      const target = net.laneById.get(outWork.closedLaneIds[0]);
      const [ti, tj] = target.to.split(',').map(Number);
      placeCar(taxi, cityNetwork().dirOfLane(target), ti, tj, target.length - 1);
      taxi.v = SPEED;

      // Long enough to drive the block, get clear, dwell and fade — but the assertions are on what
      // happened, not on the clock, so a slower teardown fails rather than passing by luck.
      let allFleeingAt = null;
      let ranAt = null;      // every worker has finished the sprint and is standing at the kerb
      let goneAt = null;     // ...and has faded out afterwards
      let sinkAt = null;     // ...and only then does the site itself start going
      for (let step = 0; step < 60 * 25 && outWork.state.phase !== 'gone'; step++) {
        outTraffic.update(1 / 60);
        outWork.update(1 / 60, taxi, outTraffic.cars, []);
        if (allFleeingAt === null && outWork.state.smashed) allFleeingAt = outWork.workersFleeing();
        if (ranAt === null && outWork.workersClear() === 2) ranAt = step;
        if (goneAt === null && outWork.workersGone() === 2) goneAt = step;
        if (sinkAt === null && outWork.state.phase === 'leaving') sinkAt = step;
      }

      check('every worker runs when a barricade goes, not just the nearest',
        allFleeingAt === 2, `${allFleeingAt} of 2 fleeing on the frame of the smash`);

      // The order of the beats, not their durations. It used to come out wrong at speed and only at
      // speed: the zone's fade is triggered by the taxi being clear of the street, and in overdrive
      // that happens half a second after the smash — while the crew is still mid-sprint — so they
      // dissolved on their way to the kerb instead of reaching it. Asserted as an ordering because
      // that is the thing that has to hold; the constants behind it are free to move.
      check('the crew runs clear and fades before the site starts packing up',
        ranAt !== null && goneAt !== null && sinkAt !== null
        && goneAt > ranAt && sinkAt >= goneAt,
        `ran clear at frame ${ranAt}, gone at ${goneAt}, site starts sinking at ${sinkAt}`);

      check('the zone clears itself away once the taxi is through',
        outWork.state.phase === 'gone' && cleared === 1 && outWork.group.parent === null,
        `phase ${outWork.state.phase}, ${cleared} cleared, `
        + `${outWork.group.parent === null ? 'detached' : 'still in the scene'}`);

      // The one that would otherwise be invisible.
      const stillClosed = outWork.closedLaneIds.filter((id) => isLaneClosed(id));
      const stillCheap = outWork.closedLaneIds
        .filter((id) => laneCost(net.laneById.get(id)) < 1);
      check('and gives the street back to both the traffic and the router',
        stillClosed.length === 0 && stillCheap.length === 0,
        `${stillClosed.length} still closed, ${stillCheap.length} still discounted`);
    }
    setClosedLanes([]);
    setRoadworkLanes([]);
  }

  // --- Steering the player into it ------------------------------------------
  // The player cannot drive. They tap a rider and the taxi routes itself, so unless the router is
  // told to like the closed street the whole vignette is scenery the game never visits — measured
  // at 33% of runs before this, 96% after (tools/roadwork-pull.mjs). Two mechanisms do it, and both
  // fail silently: a discount that never reaches `laneCost` changes nothing, and a drop-off hint
  // that is quietly dropped changes nothing either.
  {
    const ends = [closed[0].edge.a, closed[0].edge.b].map((id) => net.nodeById.get(id));
    const junctions = [...net.nodeById.values()].map((n) => ({ i: n.gi, j: n.gj }));

    // **Swept over every origin, not planned from one.** This used to plan from the closed lane's
    // own near end, travelling along it — which is a state the router has already committed to the
    // discounted street from, so making it cheaper can change nothing about where it goes next. On
    // a city where that happened to be true of every destination the check reported "0 of 42
    // rerouted" and failed on placement luck rather than on anything about `laneCost`; measured
    // across the road network, five side streets in thirty-four are like that.
    //
    // What the check is actually about is whether the discount reaches the cost function at all, so
    // it asks the whole board: every junction to every junction, on all four approaches.
    const pairs = [];
    for (const from of junctions) {
      for (let d = 0; d < 4; d++) pairs.push({ i: from.i, j: from.j, d });
    }
    const planAll = () => pairs.flatMap((o) => junctions.map((t) => planRoute(o, t)));

    setRoadworkLanes([]);
    const plain = planAll();
    setRoadworkLanes(roadwork.closedLaneIds);
    const cheap = planAll();

    const same = (p, q) => (p === null || q === null
      ? p === q : p.length === q.length && p.every((d, k) => d === q[k]));
    const changed = plain.filter((p, k) => !same(p, cheap[k])).length;
    check('pricing the closed street low actually reaches the router',
      changed > 0, `${changed} of ${plain.length} routes rerouted`);

    // ...and does not turn into a detour finder. The weights in route.js are tie-breakers by
    // design — 0.45 is worth about half a block, so nothing should gain more than one leg.
    const worst = Math.max(...plain.map((p, k) => (p && cheap[k] ? cheap[k].length - p.length : 0)));
    check('and does not drag routes across town to use it',
      worst <= 1, `worst route grew by ${worst} legs`);

    // A fare's drop-off can be aimed at the zone. The hint is one-shot and silently declined when
    // neither end is free, so the failure mode is "nothing happened" — worth pinning both ways.
    const aimScene = new THREE.Scene();
    const aimFares = createFareSystem(makeRng(seed + 313), aimScene);
    const aimTaxi = { i: 0, j: 0, x: 0, z: 0, lane: null, s: 0, v: 0 };
    aimFares.aimNextDropoff(ends.map((n) => ({ i: n.gi, j: n.gj })));
    let aimed = null;
    for (let step = 0; step < 120 && !aimed; step++) {
      for (const { type, fare } of aimFares.update(1 / 60, aimTaxi)) {
        if (type === 'spawned') aimed = fare;
      }
    }
    check('a fare can have its drop-off aimed at the closed street',
      aimed !== null && ends.some((n) => n.gi === aimed.dropoff.i && n.gj === aimed.dropoff.j),
      aimed ? `dropoff ${aimed.dropoff.i},${aimed.dropoff.j} of `
        + `${ends.map((n) => `${n.gi},${n.gj}`).join(' / ')}` : 'no fare spawned');

    // Aimed at junctions that do not exist: the hint has to be declined rather than honoured or
    // thrown, and the ordinary unbiased draw has to still produce a legal drop-off.
    const badFares = createFareSystem(makeRng(seed + 314), new THREE.Scene());
    badFares.aimNextDropoff([{ i: -5, j: -5 }]);
    let fallback = null;
    for (let step = 0; step < 120 && !fallback; step++) {
      for (const { type, fare } of badFares.update(1 / 60, aimTaxi)) {
        if (type === 'spawned') fallback = fare;
      }
    }
    check('and an unusable hint falls back to an ordinary drop-off',
      fallback !== null && fallback.dropoff.i >= 0 && fallback.dropoff.j >= 0
      && blockDistance(fallback.pickup, fallback.dropoff) > 0,
      fallback ? `dropoff ${fallback.dropoff.i},${fallback.dropoff.j}` : 'no fare spawned');

    setRoadworkLanes([]);
  }

  // --- Placement rules ------------------------------------------------------
  // A rider standing on a kerb corner inside a construction site is not broken — the taxi drives
  // through a closure — but it reads as one, so the spawner is told to keep clear.
  {
    // A band of junctions rather than a parity set: every edge joins an even corner to an odd
    // one, so `(i + j) % 2` excludes the whole city and the check passes by placing nothing.
    const busy = [];
    for (let i = 0; i <= GRID_I; i++) busy.push({ i, j: 2 }, { i, j: 3 });
    let touched = 0;
    let tries = 0;
    for (let n = 0; n < 8; n++) {
      setClosedLanes([]);
      const s = new THREE.Scene();
      const t = createTraffic(makeRng(seed + 300 + n), s, 12);
      for (let step = 0; step < 200; step++) t.update(1 / 60);
      const rw = createRoadwork(makeRng(seed + 400 + n), s, null);
      if (!rw.place(t.taxi, t.cars, busy)) continue;
      tries += 1;
      const e = cityNetwork().laneById.get(rw.closedLaneIds[0]).edge;
      for (const end of [e.a, e.b]) {
        const node = cityNetwork().nodeById.get(end);
        if (busy.some((b) => b.i === node.gi && b.j === node.gj)) touched += 1;
      }
    }
    check('a zone never closes a street a rider is waiting in', tries > 0 && touched === 0,
      `${tries} placements, ${touched} on an occupied corner`);
  }

  // Same seed, same street. The zone is part of the *situation*, so `?run=` has to reproduce it.
  {
    const build = () => {
      setClosedLanes([]);
      const s = new THREE.Scene();
      const t = createTraffic(makeRng(seed + 210), s, 24);
      for (let step = 0; step < 300; step++) t.update(1 / 60);
      const rw = createRoadwork(makeRng(seed + 211), s, null);
      rw.place(t.taxi, t.cars, []);
      return rw.closedLaneIds.join('+');
    };
    const first = build();
    check('the same run seed closes the same street', first === build(), first);
  }

  // Orange is the whole read, and the warm end of the wheel is spoken for twice: the taxi owns
  // yellow, and the urgency scale owns the ambers under it. Same clearance argument the ghost
  // paints get, for the same reason — at play zoom hue is most of what a small shape is.
  {
    const hueOf = (hex) => {
      const hsl = { h: 0, s: 0, l: 0 };
      new THREE.Color(hex).getHSL(hsl);
      return hsl.h * 360;
    };
    const taxiHue = hueOf(PALETTE.taxiBody);
    const gap = (hex) => Math.abs(hueOf(hex) - taxiHue);
    check('roadworks orange is clearly not the taxi',
      gap(PALETTE.cone) > 20 && gap(PALETTE.barrier) > 20 && gap(PALETTE.hiVis) > 20,
      `cone ${gap(PALETTE.cone).toFixed(0)}°, barrier ${gap(PALETTE.barrier).toFixed(0)}°, `
      + `vest ${gap(PALETTE.hiVis).toFixed(0)}° from the taxi's ${taxiHue.toFixed(0)}°`);
  }

  // Leave the sim as it was found: `closedLanes` is module state in traffic.js, and anything below
  // this point would inherit a city with a street shut in it.
  setClosedLanes([]);
}

// --- The taxi's garage, and the vignette that comes out of it --------------------------------
//
// Three separate claims, and the third is the one that could not be made any other way than here.
//
//   1. The depot really does take its block out of the tower generator's hands.
//   2. The exit path and the traffic model agree, to the bit, about where the taxi lands.
//   3. **The camera can see the door.** `chooseGarageBlock` filters on a sightline argument worked
//      out on paper (see `occlusionClear`); this fires a real ray through the real merged city and
//      finds out. Getting it wrong is a run that opens on a two-second close-up of a wall.
{
  const site = garageSite(layout.garageBlock);
  const bounds = layout.garageBlock.bounds;

  check('the city puts a depot somewhere', Boolean(layout.garageBlock),
    layout.garageBlock ? `block (${site.bi}, ${site.bj})` : 'none');
  check('and the tower generator leaves that block alone', (() => {
    const p = buildings.mesh.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (p.getX(i) > bounds.x0 && p.getX(i) < bounds.x1
        && p.getZ(i) > bounds.z0 && p.getZ(i) < bounds.z1) return false;
    }
    return true;
  })());

  const garage = createGarage(layout.garageBlock, makeRng(seed + 99));
  const head = KERB_H + site.doorH;

  // The bay is a hole, not a dark patch painted on a wall. Tested as a box strictly inside the
  // opening, clear of every lining panel: a solid mass would have vertices in it.
  check('the bay is genuinely hollow', (() => {
    const p = garage.shell.geometry.attributes.position;
    const inside = (x, y, z) => x > site.bayX + 0.2 && x < site.curtainX - 0.2
      && y > KERB_H + 0.2 && y < head - 0.2
      && z > site.doorZ - site.doorW / 2 + 0.2 && z < site.doorZ + site.doorW / 2 - 0.2;
    for (let i = 0; i < p.count; i++) {
      if (inside(p.getX(i), p.getY(i), p.getZ(i))) return false;
    }
    return true;
  })());

  // The curtain winds *away*, rather than sliding up out of the opening and standing above the
  // building. Every vertex has to end up on the lintel plane and none above it.
  const curtainY = () => {
    const p = garage.curtain.geometry.attributes.position;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < p.count; i++) { lo = Math.min(lo, p.getY(i)); hi = Math.max(hi, p.getY(i)); }
    return { lo, hi };
  };
  garage.setDoor(0);
  const shut = curtainY();
  check('shut, the curtain fills the opening',
    Math.abs(shut.lo - KERB_H) < 0.03 && Math.abs(shut.hi - head) < 0.06,
    `${shut.lo.toFixed(3)} → ${shut.hi.toFixed(3)} against ${KERB_H} → ${head.toFixed(2)}`);
  garage.setDoor(1);
  const open = curtainY();
  check('open, the whole curtain has collapsed onto the lintel and none of it is above it',
    Math.abs(open.hi - head) < 1e-9 && open.hi - open.lo < 1e-9,
    `${open.lo.toFixed(4)} → ${open.hi.toFixed(4)}`);
  // Scrubbable rather than accumulating: the same fraction has to give the same door however it
  // was reached, or a replay lands somewhere else than the first run did.
  garage.setDoor(0.4);
  const half = curtainY();
  garage.setDoor(1);
  garage.setDoor(0.4);
  const halfAgain = curtainY();
  check('and the door is a function of its open fraction, not an accumulating offset',
    Math.abs(half.lo - halfAgain.lo) < 1e-12 && Math.abs(half.hi - halfAgain.hi) < 1e-12);

  // --- The exit path.
  const path = exitPath(site);

  // Where the taxi parks, against the two things it has to fit between. The nose one is the check
  // that would have caught the bug this constant exists for: the drawn taxi is TAXI_SCALE longer
  // than `CAR_LEN`, and parking it by the sim's half-length put a yellow rectangle through the
  // middle of a shut shutter.
  const parked = path.at(0);
  check('the parked taxi is behind the shut door',
    parked.x + TAXI_TAILPIPE_BACK < site.curtainX - 0.08,
    `nose ${(site.curtainX - (parked.x + TAXI_TAILPIPE_BACK)).toFixed(2)} behind the curtain`);
  check('...and clear of the back of the bay',
    parked.x - TAXI_TAILPIPE_BACK > site.bayX + 0.2,
    `tail ${(parked.x - TAXI_TAILPIPE_BACK - site.bayX).toFixed(2)} off the wall`);
  const endTangent = path.tangentAt(path.total);
  const joinBefore = path.tangentAt(path.run.length - 1e-6);
  const joinAfter = path.tangentAt(path.run.length + 1e-6);
  check('the fillet meets the driveway with no kink',
    Math.hypot(joinBefore.x - joinAfter.x, joinBefore.z - joinAfter.z) < 1e-3,
    `${joinBefore.x.toFixed(4)},${joinBefore.z.toFixed(4)} → ${joinAfter.x.toFixed(4)},${joinAfter.z.toFixed(4)}`);
  check('and lands pointing straight down the lane',
    Math.abs(endTangent.x) < 1e-9 && Math.abs(endTangent.z - 1) < 1e-9);

  // The one that matters: two completely different pieces of arithmetic — the fillet's own
  // geometry, and `placeCar` counting back from a junction along a baked lane — have to agree
  // about where the taxi is. A few millimetres here is a car twitching sideways on the handover.
  const end = path.at(path.total);
  const stand = traffic.cars.find((c) => !c.isTaxi);
  const was = { lane: stand.lane, s: stand.s, state: stand.state, turn: stand.turn };
  placeCar(stand, site.merge.d, site.merge.i, site.merge.j, site.merge.back);
  const landed = stand.lane.path.at(stand.s);
  check('the arc lands exactly where the traffic model picks the taxi up',
    Math.hypot(landed.x - end.x, landed.z - end.z) < 1e-9,
    `arc ${end.x.toFixed(3)},${end.z.toFixed(3)} vs lane ${landed.x.toFixed(3)},${landed.z.toFixed(3)}`);
  check('...with a whole car-length of lane left before the junction',
    stand.lane.length - stand.s > CAR_LEN,
    `${(stand.lane.length - stand.s).toFixed(2)} units`);
  Object.assign(stand, was);

  // --- Staging, and the state the depot is left in.
  //
  // `settle()` is the `?vignette=off` path, and it has to land in exactly the world the played-out
  // sequence does — that is the whole reason the skip goes through the same handover rather than
  // around it. Both halves are checkable with no browser: a camera controller is a frustum and two
  // vectors, and `stageCar`/`releaseCar` are pure state.
  {
    const controller = createCityCamera(1.6, { zoom: PLAY_ZOOM });
    const opening = createOpening({
      site,
      setDoor: garage.setDoor,
      taxi: traffic.taxi,
      taxiGroup: traffic.taxiGroup,
      cars: traffic.cars,
      controller,
      aspect: () => 1.6,
      playZoom: PLAY_ZOOM,
      restFraming: () => ({ x: 0, z: 0 }),
    });
    const shutOnOpen = curtainY();
    check('building the vignette parks the taxi in the bay with the door shut',
      traffic.taxi.staged && Math.abs(traffic.taxi.x - parked.x) < 1e-9
      && Math.abs(shutOnOpen.hi - head) < 0.06);
    opening.settle();
    const shutAgain = curtainY();
    check('...and settling it puts the car back on the merge lane',
      !traffic.taxi.staged && traffic.taxi.kerbLift === 0
      && Math.hypot(traffic.taxi.lane.path.at(traffic.taxi.s).x - end.x,
        traffic.taxi.lane.path.at(traffic.taxi.s).z - end.z) < 1e-9);
    // Shut, not open: the resting state of a depot in a live run is a car gone and a door down.
    check('...with the door shut behind it',
      Math.abs(shutAgain.hi - head) < 0.06 && shutAgain.hi - shutAgain.lo > site.doorH - 0.1,
      `${shutAgain.lo.toFixed(2)} → ${shutAgain.hi.toFixed(2)}`);
  }

  // --- The player's skip: a tap during the sequence, from behind the cut to black in game/wipe.js.
  //
  // Same handover as `settle` — that is what the two sharing a path is for — plus the one thing
  // `settle` has no reason to do. `?vignette=off` lands the module before the shot has gone
  // anywhere; a tap lands it with the camera fifteen units off a garage door, and a skip that left
  // it there would end on the close-up it was asked to escape. The snap is only invisible because
  // it happens under the black, and neither half of that can be seen from here — what *is*
  // checkable is that the framing ends up exactly where the run plays from.
  {
    const controller = createCityCamera(1.6, { zoom: PLAY_ZOOM });
    const rest = { x: 0, z: 0 };
    const opening = createOpening({
      site,
      setDoor: garage.setDoor,
      taxi: traffic.taxi,
      taxiGroup: traffic.taxiGroup,
      cars: traffic.cars,
      controller,
      aspect: () => 1.6,
      playZoom: PLAY_ZOOM,
      restFraming: () => rest,
    });
    // Two seconds in, which is the door winding up: the sequence is well past `wait`, the shot is
    // down on the door, and this is the state a tap actually interrupts.
    for (let i = 0; i < 120; i++) { opening.update(1 / 60); opening.frameCamera(1 / 60); }
    const onDoor = { zoom: controller.state.zoom, x: controller.state.target.x };
    check('the vignette has the camera down on the door two seconds in',
      opening.holdsCamera() && onDoor.zoom < PLAY_ZOOM * 0.5,
      `phase ${opening.phase()}, zoom ${onDoor.zoom.toFixed(1)}`);

    opening.skip();
    check('...and a tap skips it onto the merge lane, exactly as settling does',
      !opening.running() && !traffic.taxi.staged && traffic.taxi.kerbLift === 0
      && Math.hypot(traffic.taxi.lane.path.at(traffic.taxi.s).x - end.x,
        traffic.taxi.lane.path.at(traffic.taxi.s).z - end.z) < 1e-9);
    // Snapped, not left easing: the frame after the skip is the framing the run plays at, so
    // nothing downstream has a second of zoom to spend getting out of the depot.
    check('...with the camera put where the run plays from',
      Math.abs(controller.state.zoom - PLAY_ZOOM) < 1e-9
      && Math.hypot(controller.state.target.x - rest.x, controller.state.target.z - rest.z) < 1e-9
      && Math.abs(onDoor.x - rest.x) > 1,
      `zoom ${onDoor.zoom.toFixed(1)} → ${controller.state.zoom.toFixed(1)}, `
      + `target x ${onDoor.x.toFixed(1)} → ${controller.state.target.x.toFixed(1)}`);
    check('...and the camera handed back with it',
      !opening.holdsCamera());
  }

  // --- Can the camera see the door?
  //
  // Nine points across the opening, each fired along VIEW_DIR through the real merged city — the
  // buildings and the props, not the depot itself, whose own +Z jamb is *meant* to hide the back
  // half of the bay. Swept over seeds, because the answer is a property of whatever got built next
  // door rather than of the depot.
  const sightline = (city, cityProps, s) => {
    const caster = new THREE.Raycaster();
    caster.far = 600;
    for (let u = -0.4; u <= 0.41; u += 0.4) {
      for (let v = 0.1; v <= 0.91; v += 0.4) {
        const from = new THREE.Vector3(
          s.curtainX, KERB_H + v * s.doorH, s.doorZ + u * s.doorW,
        ).addScaledVector(VIEW_DIR, 0.5);
        caster.set(from, VIEW_DIR);
        if (caster.intersectObjects([city, cityProps], false).length) return false;
      }
    }
    return true;
  };
  check('nothing stands between the camera and this door',
    sightline(buildings.mesh, props, site));

  let sited = 0;
  let clear = 0;
  const SEEDS = 10;
  for (let n = 0; n < SEEDS; n++) {
    const s = seed + n * 977;
    const sweepLayout = createLayout(makeRng(s));
    if (!sweepLayout.garageBlock) continue;
    sited += 1;
    const sweepCity = createBuildings(makeRng(s + 22), sweepLayout);
    const sweepProps = createProps(makeRng(s + 33), sweepLayout).mesh;
    if (sightline(sweepCity.mesh, sweepProps, garageSite(sweepLayout.garageBlock))) clear += 1;
  }
  check(`every seed hosts a depot`, sited === SEEDS, `${sited}/${SEEDS}`);
  check('and the door is unobstructed on every one of them', clear === sited, `${clear}/${sited}`);

  // `createLayout` installs the network it bakes as *the* city network (see CLAUDE.md), so the
  // sweep above has replaced the city everything below this point measures against. Put it back.
  createLayout(makeRng(seed));
}

// --- The burger joint, and the drive-through that runs through it -----------------------------
//
// Four claims, and the last two could not be made any other way than here.
//
//   1. The city puts a joint somewhere, and the tower generator leaves its block alone.
//   2. The lane's two ends and the traffic model agree, to the bit, about where a car comes off
//      the road and where it goes back on.
//   3. **A car actually goes through it.** The lot is a hand-driven path spliced into a lane model
//      that knows nothing about it, so the only way to find out whether cars go in, sit at both
//      windows and come back out on the right lane facing the right way is to run it.
//   4. **The camera can see the lane.** `chooseBurgerBlock` filters on a sightline predicted from
//      block centralities before a single tower exists (`laneSeen`); this fires real rays through
//      the real merged city and finds out. Getting it wrong is a drive-through behind a tower.
{
  const block = layout.burgerBlock;
  check('the city puts a burger joint somewhere', Boolean(block),
    block ? `block (${block.bi}, ${block.bj})` : 'none');

  const site = burgerSite(block);
  const bounds = block.bounds;

  check('and the tower generator leaves that block alone', (() => {
    const p = buildings.mesh.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (p.getX(i) > bounds.x0 && p.getX(i) < bounds.x1
        && p.getZ(i) > bounds.z0 && p.getZ(i) < bounds.z1) return false;
    }
    return true;
  })());
  check('...and it is not the depot’s block either', layout.garageBlock !== block,
    `depot (${layout.garageBlock?.bi}, ${layout.garageBlock?.bj})`);

  // --- The two ends of the lane.
  //
  // The same claim the garage's fillet makes, and worth making twice here because this path has
  // two handovers rather than one: a car is taken *off* a lane at the mouth and put back *on* one
  // at the exit, and either being a few millimetres out is a car twitching sideways in front of
  // the player.
  const mouth = site.path.at(0);
  const mouthTangent = site.path.tangentAt(0);
  const mouthLane = laneOffsetCoord(DIR.NX, block.bi, block.bj + 1);
  check('the mouth sits on the kerbside lane it takes cars off',
    Math.abs(mouth.z - mouthLane) < 1e-9
    && Math.abs(mouthTangent.x + 1) < 1e-9 && Math.abs(mouthTangent.z) < 1e-9,
    `z ${mouth.z.toFixed(4)} vs lane ${mouthLane.toFixed(4)}`);

  const end = site.path.at(site.path.total);
  const endTangent = site.path.tangentAt(site.path.total);
  check('and the exit lands pointing straight down the lane it joins',
    Math.abs(endTangent.x) < 1e-9 && Math.abs(endTangent.z - 1) < 1e-9);

  {
    const stand = traffic.cars.find((c) => !c.isTaxi);
    const was = { lane: stand.lane, s: stand.s, state: stand.state, turn: stand.turn };
    placeCar(stand, site.merge.d, site.merge.i, site.merge.j, site.merge.back);
    const landed = stand.lane.path.at(stand.s);
    check('the exit arc lands exactly where the traffic model picks a car up',
      Math.hypot(landed.x - end.x, landed.z - end.z) < 1e-9,
      `arc ${end.x.toFixed(3)},${end.z.toFixed(3)} vs lane ${landed.x.toFixed(3)},${landed.z.toFixed(3)}`);
    // The whole reason the lane goes out through the +X kerb rather than the nearer −Z one: a car
    // put back on the road inside its own stop line runs the light it never saw. See `EXIT_LIFT`.
    check('...far enough back that it can still stop for the light it is driving at',
      stand.lane.length - stand.s > STOP_SETBACK + CAR_LEN,
      `${(stand.lane.length - stand.s).toFixed(2)} units, hold line at ${STOP_SETBACK}`);
    Object.assign(stand, was);
  }

  // Five curves joined end to end, so there are four joins to kink at. Checked as curvature rather
  // than by inspecting the seams: sampled tightly, the heading may never turn faster than the one
  // radius every piece of this path is built from.
  {
    const STEP = 0.01;
    let worst = 0;
    for (let d = 0; d + STEP <= site.path.total; d += STEP) {
      const a = site.path.tangentAt(d);
      const b = site.path.tangentAt(d + STEP);
      const turn = Math.abs(Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z));
      worst = Math.max(worst, turn / STEP);
    }
    check('the lane is one continuous curve with no kink at any of its four joins',
      worst <= 1 / site.turnR + 1e-6, `tightest radius ${(1 / worst).toFixed(3)} of ${site.turnR}`);
  }

  // Between the two kerbs the lane has to be on the block, and where it runs straight — the part a
  // car spends its visit on, and the part the asphalt was laid for — a whole car has to fit
  // between the building and the kerb.
  {
    let off = 0;
    let narrow = 0;
    for (let d = site.enterS; d <= site.exitS; d += 0.1) {
      const p = site.path.at(d);
      if (p.x < bounds.x0 - 1e-6 || p.x > bounds.x1 + 1e-6
        || p.z < bounds.z0 - 1e-6 || p.z > bounds.z1 + 1e-6) off += 1;
      if (Math.abs(p.x - site.laneX) > 1e-6) continue;
      if (p.x - CAR_W / 2 < site.apron.x0 || p.x + CAR_W / 2 > site.apron.x1) narrow += 1;
    }
    check('every part of the lane inside the lot is on the block', off === 0,
      `${off} samples adrift`);
    check('...and a whole car fits on the asphalt down the straight of it', narrow === 0,
      `${narrow} samples too narrow`);
  }

  // Both windows have to be on the straight, in the order a car meets them: one served on an arc
  // is a car parked diagonally across its own lane, at a window on a wall that runs straight.
  check('both windows are on the straight of the lane, in the order cars meet them',
    site.enterS + CAR_LEN / 2 < site.orderS && site.orderS < site.pickupS
    && site.pickupS < site.exitS - CAR_LEN / 2,
    `enter ${site.enterS.toFixed(1)} < order ${site.orderS.toFixed(1)} `
    + `< pickup ${site.pickupS.toFixed(1)} < exit ${site.exitS.toFixed(1)}`);

  // --- The building.
  const joint = createBurgerJoint(block, makeRng(seed + 111));
  {
    joint.shell.geometry.computeBoundingBox();
    const bb = joint.shell.geometry.boundingBox;
    // The apron runs right up to both kerbs by design, so the block's own bounds are the test. The
    // tolerance is the two dropped kerbs and nothing else: each has to finish a hair *under* the
    // road slab or it reads as a lip rather than a ramp, so 0.1 of each is over the line.
    const LIP = 0.12;
    check('the joint stays on its own block',
      bb.min.x >= bounds.x0 - 1e-6 && bb.max.x <= bounds.x1 + LIP
      && bb.min.z >= bounds.z0 - 1e-6 && bb.max.z <= bounds.z1 + LIP,
      `x ${bb.min.x.toFixed(2)}..${bb.max.x.toFixed(2)} in ${bounds.x0.toFixed(2)}..${bounds.x1.toFixed(2)}, `
      + `z ${bb.min.z.toFixed(2)}..${bb.max.z.toFixed(2)} in ${bounds.z0.toFixed(2)}..${bounds.z1.toFixed(2)}`);

    // --- Nothing on this block is coplanar with anything else on it.
    //
    // Three flat surfaces stack on the lot — the block's own pavement, the joint's asphalt apron,
    // and the paint on the apron — and two of them at the *same* height is not "just touching",
    // it is two polygons the depth buffer cannot separate. It ships as the ground shimmering when
    // the camera moves, which is what the first cut of this apron did: its top face landed on
    // `KERB_H + 0.01`, which is exactly where `createGround` lays the pavement.
    //
    // So: every up-facing triangle either mesh puts on this block, gathered by height and checked
    // pairwise. A single slab contributes one height however many triangles it has, which is why
    // this is a set rather than a count.
    const flatTops = (mesh, within) => {
      const heights = new Set();
      const geo = mesh.geometry;
      const pos = geo.attributes.position;
      const index = geo.index;
      const n = index ? index.count : pos.count;
      const at = (k) => (index ? index.getX(k) : k);
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const c = new THREE.Vector3();
      const ab = new THREE.Vector3();
      const ac = new THREE.Vector3();
      const nrm = new THREE.Vector3();
      for (let t = 0; t + 2 < n; t += 3) {
        a.fromBufferAttribute(pos, at(t));
        b.fromBufferAttribute(pos, at(t + 1));
        c.fromBufferAttribute(pos, at(t + 2));
        // Up-facing only. A wall's vertical faces cannot fight a floor, and a *down*-facing one is
        // culled before it can fight anything (see the awning over the door, which sits exactly on
        // the door's top and is fine for that reason).
        nrm.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
        if (nrm.lengthSq() < 1e-12 || nrm.y / nrm.length() < 0.999) continue;
        if (Math.abs(a.y - b.y) > 1e-6 || Math.abs(a.y - c.y) > 1e-6) continue;
        const cx2 = (a.x + b.x + c.x) / 3;
        const cz2 = (a.z + b.z + c.z) / 3;
        if (cx2 < within.x0 || cx2 > within.x1 || cz2 < within.z0 || cz2 > within.z1) continue;
        if (a.y > KERB_H + 0.3) continue;      // ground level only — roofs cannot fight pavement
        heights.add(a.y.toFixed(4));
      }
      return [...heights].map(Number).sort((u, v) => u - v);
    };

    const groundTops = flatTops(ground, bounds);
    const jointTops = flatTops(joint.shell, bounds);
    let closest = Infinity;
    let pair = '';
    for (const g of groundTops) {
      for (const j of jointTops) {
        if (Math.abs(g - j) < closest) { closest = Math.abs(g - j); pair = `${g.toFixed(3)}/${j.toFixed(3)}`; }
      }
    }
    check('no surface the joint lays on the ground is coplanar with the pavement under it',
      groundTops.length > 0 && jointTops.length > 0 && closest > 0.005,
      `${groundTops.length} ground levels, ${jointTops.length} lot levels, nearest pair ${pair} `
      + `(${closest.toFixed(4)} apart)`);

    // Nothing the building is made of may stand in the lane at car height. The canopy deliberately
    // reaches over it — that is what a drive-through canopy is — so the test runs from above the
    // road paint to a car's roofline, which is where a car actually is. It caught a canopy post at
    // 0.9 off the lane centre against a car's half-width of 0.85.
    const CAR_TOP = KERB_H + 2.2;
    const p = joint.shell.geometry.attributes.position;
    let fouled = 0;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y < KERB_H + 0.1 || y > CAR_TOP) continue;
      const z = p.getZ(i);
      if (z < site.turnZ || z > site.kerbZ) continue;     // only alongside the straight run
      if (Math.abs(p.getX(i) - site.laneX) < CAR_W / 2 + 0.15) fouled += 1;
    }
    check('and nothing it is made of stands in the lane at car height', fouled === 0,
      `${fouled} vertices inside the car's envelope`);

    // The sign turns about a vertical axis through the pole, which is only true if its geometry is
    // built centred on its own origin. Off-centre it orbits the pole instead of turning on it, and
    // no rotation speed makes that look right.
    const burger = burgerGeometry();
    burger.computeBoundingBox();
    const cx = (burger.boundingBox.min.x + burger.boundingBox.max.x) / 2;
    const cz = (burger.boundingBox.min.z + burger.boundingBox.max.z) / 2;
    const cy = (burger.boundingBox.min.y + burger.boundingBox.max.y) / 2;
    check('the burger is centred on the axis it turns about',
      Math.abs(cx) < 1e-6 && Math.abs(cz) < 1e-6 && Math.abs(cy) < 1e-6
      && burger.boundingBox.max.x > BURGER_R * 1.2,
      `centre ${cx.toFixed(5)},${cy.toFixed(5)},${cz.toFixed(5)}, `
      + `${(burger.boundingBox.max.x - burger.boundingBox.min.x).toFixed(2)} across`);

    // Where the sign really is, transformed by the pivot that carries the lean — every vertex,
    // rather than a bounding box. A `Box3` over a rotated object is the AABB *of* an AABB, which
    // over-states the drop by 0.4 here and would turn this into a test of the slack in the box.
    const lowestSign = (() => {
      joint.signPivot.updateMatrixWorld(true);
      const p = joint.sign.geometry.attributes.position;
      const v = new THREE.Vector3();
      let lo = Infinity;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(joint.sign.matrixWorld);
        lo = Math.min(lo, v.y);
      }
      return lo;
    })();
    // Measured off the parapet the pole comes out of and not off the shell's bounding box — the
    // pole is part of that box and reaches the burger's own centre, so a bbox test could only ever
    // say "the sign is not above its own pole".
    check('...and it stands clear of the roof it is over, leaning and all',
      lowestSign - ROOF_Y > 1.0,
      `${(lowestSign - ROOF_Y).toFixed(2)} units over the parapet`);

    // The lean is *away* from the camera, which is the counter-intuitive half of it and the whole
    // reason it helps: leaning toward the viewer would show more of the bun. See `SIGN_TILT`.
    const signUp = new THREE.Vector3(0, 1, 0).applyQuaternion(joint.signPivot.quaternion);
    check('...and it leans away from the camera, not toward it',
      signUp.x * VIEW_DIR.x + signUp.z * VIEW_DIR.z < -0.1 && signUp.y > 0.8,
      `up (${signUp.x.toFixed(2)}, ${signUp.y.toFixed(2)}, ${signUp.z.toFixed(2)})`);
    // ...about the *pivot's* axis rather than the world's: the mesh turns inside the leaning
    // parent, which is what holds one three-quarter attitude all the way round instead of sweeping
    // the burger round a cone.
    check('...and it turns, inside the lean rather than under it', (() => {
      const before = joint.sign.rotation.y;
      const pivotBefore = joint.signPivot.quaternion.clone();
      joint.update(1, SIGN_SPIN);
      return Math.abs(joint.sign.rotation.y - before - SIGN_SPIN) < 1e-9
        && joint.signPivot.quaternion.angleTo(pivotBefore) < 1e-12;
    })(), `${(Math.PI * 2 / SIGN_SPIN).toFixed(0)}s per revolution`);
  }

  // --- A car actually goes through it.
  //
  // On a traffic model of its own, because the lot takes cars *out* of one: anything sharing this
  // file's instance would inherit a city with three cars parked in a car park.
  {
    const lotScene = new THREE.Scene();
    // A real density rather than the low `CARS_DEFAULT` the fare checks use: how often a car
    // passes the mouth at all is one of the inputs this is measuring.
    //
    // Stated as cars **per junction** rather than as the flat 24 it used to be. That 24 was
    // measured on a 6x6 city, and the map has since grown a row for the river — 42 junctions of
    // road with 24 cars on it is a sixth emptier than the number was tuned at, which showed up
    // here as a drive-through that was not busy enough rather than as anything to do with the lot.
    const lotCars = Math.round((24 / 36) * (GRID_I + 1) * (GRID_J + 1));
    const lotTraffic = createTraffic(makeRng(seed + 44), lotScene, lotCars);
    lotTraffic.warmup(10);
    const lot = createDriveThru({ site, cars: lotTraffic.cars, rng: makeRng(seed + 311) });

    let peak = 0;
    let tooClose = 0;
    let strayed = 0;
    let tookTaxi = 0;
    let notStaged = 0;
    let handovers = 0;
    let badLanding = 0;
    const visitors = new Set();
    let inLot = new Set();

    for (let step = 0; step < 60 * 240; step++) {       // four minutes of sim
      lot.update(1 / 60);

      const queue = lot.state.queue;
      peak = Math.max(peak, queue.length);
      const now = new Set();
      for (let n = 0; n < queue.length; n++) {
        const entry = queue[n];
        now.add(entry.car);
        visitors.add(entry.car);
        if (entry.car.isTaxi) tookTaxi += 1;
        // A car in the lot is out of the traffic model. If that stopped being true the lane model
        // would be steering it too, from a lane position it left several seconds ago.
        if (!entry.car.staged) notStaged += 1;
        if (n > 0 && queue[n - 1].s - entry.s < CAR_LEN) tooClose += 1;
        if (entry.s < -0.5 || entry.s > site.path.total + 1e-6) strayed += 1;
      }
      // Anything in the lot last frame and not in it now has just been handed back — and this is
      // the only frame it can be checked on, because `traffic.update` has not composed its
      // transform yet. What a released car *is* right now is a lane and a distance along it.
      for (const car of inLot) {
        if (now.has(car)) continue;
        handovers += 1;
        const at = car.lane?.path.at(car.s);
        if (car.staged || car.state !== 'drive' || !at
          || Math.hypot(at.x - site.merge.point.x, at.z - site.merge.point.z) > 1e-9) {
          badLanding += 1;
        }
      }
      inLot = now;

      lotTraffic.update(1 / 60);
    }

    const served = lot.state.served();
    check('cars pull into the drive-through and are served', served >= 4 && visitors.size >= 3,
      `${visitors.size} different cars, ${served} served in four minutes`);
    check('...never more than the lane holds, and never nose to tail inside it',
      peak <= 3 && tooClose === 0 && strayed === 0,
      `peak ${peak}, ${tooClose} overlaps, ${strayed} off-path`);
    check('...and the player’s own taxi is never swept in with them', tookTaxi === 0);
    check('...and a car in the lot is out of the traffic model the whole time it is in there',
      notStaged === 0, `${notStaged} frames with a lot car still on a lane`);
    // The handover, checked against the cars that actually took it rather than against a staged
    // one. Every release has to land on the merge lane exactly, and everything that went in has to
    // have come out again bar whatever is still in there when the clock stops.
    check('...and every one of them comes back out, onto the merge lane, to the bit',
      handovers >= served - lot.state.queue.length && badLanding === 0,
      `${handovers} handovers against ${served} served, ${lot.state.queue.length} still inside, `
      + `${badLanding} bad`);

    // The shot path: a lot filled by hand, because a review framing gets one tick of the world.
    const shotScene = new THREE.Scene();
    const shotTraffic = createTraffic(makeRng(seed + 44), shotScene, CARS_DEFAULT);
    const shotLot = createDriveThru({ site, cars: shotTraffic.cars, rng: makeRng(seed + 311) });
    shotLot.settle();
    const filled = shotLot.state.queue;
    check('settling the lot fills it for a screenshot',
      filled.length === 3 && filled.every((e) => e.car.staged
        && Math.abs(e.car.x - site.path.at(e.s).x) < 1e-9),
      `${filled.length} cars, front one at the window`);
  }

  // --- Every way in is a way in *down the mouth's own lane*.
  //
  // `findRouteOnto` is the router the tap uses, and the property it exists for is one a junction
  // router cannot state: the last leg of the route is the lane the driveway opens off. Swept over
  // every junction in the city and all four headings, walked step by step rather than trusted —
  // "the last direction is −X" is necessary and not sufficient, since a route that ends −X into the
  // *wrong* junction reads identically. Which is exactly how the `findRouteVia` version failed.
  {
    const { d: mouthD, i: mouthI, j: mouthJ } = site.approach;
    const walk = (from, route) => {
      let at = { i: from.i, j: from.j };
      for (const step of route) {
        at = {
          i: at.i + (step === DIR.PX ? 1 : step === DIR.NX ? -1 : 0),
          j: at.j + (step === DIR.PZ ? 1 : step === DIR.NZ ? -1 : 0),
        };
      }
      return at;
    };

    let asked = 0;
    let missing = 0;
    let wrongEnd = 0;
    let wrongSide = 0;
    let empty = 0;
    let longest = 0;
    for (const start of allIntersections()) {
      for (const d of [DIR.PX, DIR.PZ, DIR.NX, DIR.NZ]) {
        const from = { i: start.i, j: start.j, d };
        const route = findRouteOnto(from, { i: mouthI, j: mouthJ }, mouthD);
        asked += 1;
        if (route === null) { missing += 1; continue; }
        if (!route.length) { empty += 1; continue; }
        const end = walk(from, route);
        if (end.i !== mouthI || end.j !== mouthJ) wrongEnd += 1;
        if (route[route.length - 1] !== mouthD) wrongSide += 1;
        longest = Math.max(longest, route.length);
      }
    }
    check('every route to the drive-through ends on the lane its driveway opens off',
      missing === 0 && wrongEnd === 0 && wrongSide === 0 && empty === 0,
      `${asked} starts swept, ${missing} unroutable, ${wrongEnd} at the wrong junction, `
      + `${wrongSide} from the wrong side, longest ${longest} legs`);

    // ...including from the lane itself, which is the case with an answer nobody would guess: a taxi
    // that has just gone past the driveway is *on* the lane it needs, and the shortest way back onto
    // it is a lap of the block. An empty route would be the router agreeing it is already there.
    const lap = findRouteOnto({ i: mouthI, j: mouthJ, d: mouthD }, { i: mouthI, j: mouthJ }, mouthD);
    check('...and a taxi that has just driven past it is sent round the block for another pass',
      lap !== null && lap.length > 0 && lap[lap.length - 1] === mouthD,
      lap ? `${lap.length} legs` : 'unroutable');
  }

  // --- ...and the player's taxi goes through it when it is *sent*.
  //
  // The secret (game/burgerrun.js): a tap on the joint routes the taxi in for a splash of boost. It
  // is the same lot loop the cars above run, so what is new — and what nothing but a run can answer —
  // is the half either side of it:
  //
  //   1. **the route reaches the mouth.** A drive-through has one way in: the kerbside −X lane of the
  //      road along the block's +Z edge. The plan is `findRouteVia` through the junction that lane
  //      leaves, and if that ever stops landing the taxi *on* that lane the trip silently becomes a
  //      drive past a building.
  //   2. **the lot is held.** From the tap until the taxi is back on the road no ambient car may be
  //      taken, or a player can arrive at a full lot they watched fill up.
  //   3. **the job comes back.** The detour interrupts whatever the taxi was doing, and the taxi has
  //      to be driving it again on the way out — with the reward paid exactly once on the way.
  //
  // Five trips, taken from wherever the previous one left the car, so the plan is asked the awkward
  // questions on its own: from the far side of the city, from the joint's own street, and — after the
  // first visit — from the exit lane one junction from the mouth it just came out of.
  {
    const runScene = new THREE.Scene();
    const runTraffic = createTraffic(makeRng(seed + 44), runScene, 12);
    runTraffic.warmup(10);
    const runLot = createDriveThru({ site, cars: runTraffic.cars, rng: makeRng(seed + 311) });
    const taxi = runTraffic.taxi;

    // main.js's own `routeTo`, less the parts that only matter to a drawn game.
    const routeTo = (target, { via = null, maxDetour, onto = null } = {}) => {
      const route = onto !== null
        ? findRouteOnto(planOrigin(taxi), target, onto)
        : via
          ? findRouteVia(planOrigin(taxi), via, target, { maxDetour })
          : findRoute(planOrigin(taxi), target);
      if (!route) return false;
      taxi.route = route;
      taxi.routeConsumed = false;
      taxi.pendingTarget = target;
      taxi.parked = false;
      return true;
    };

    let paid = 0;
    let finished = 0;
    let restored = 0;
    const run = createBurgerRun({
      site,
      lot: runLot,
      taxi,
      routeTo,
      onServed: () => { paid += 1; },
      // What main.js does with a handed-back job, minus the board it checks it against.
      onFinish: (handBack) => {
        finished += 1;
        if (handBack && routeTo(handBack)) restored += 1;
      },
    });

    const S = 1 / 60;
    const step = (seconds) => {
      for (let n = 0; n < Math.round(seconds / S); n++) {
        runLot.update(S);
        run.update(S);
        runTraffic.update(S);
      }
    };

    // Somewhere to be when the tap lands. Four corners of the map and the joint's own doorstep, so
    // the last trip is planned from a car that is already on the lane it has to come back down.
    const jobs = [
      { i: 0, j: 0 }, { i: GRID_I, j: GRID_J }, { i: 0, j: GRID_J },
      { i: site.approach.i, j: site.approach.j }, { i: GRID_I, j: 0 },
    ];

    let refused = 0;
    let trips = 0;
    let neverEntered = 0;
    let intruders = 0;
    let badLanding = 0;
    let stillStaged = 0;
    let notHandedBack = 0;
    let overpaid = 0;
    let slowest = 0;

    for (const job of jobs) {
      routeTo(job);
      step(2);                        // driving it for a beat, so the tap interrupts something
      const before = paid;
      if (!run.send()) { refused += 1; continue; }
      trips += 1;

      let clock = 0;
      let entered = false;
      let landed = null;
      let inLot = new Set(runLot.state.queue.map((e) => e.car));
      while (run.active() && clock < 150) {
        runLot.update(S);
        run.update(S);

        const now = new Set(runLot.state.queue.map((e) => e.car));
        for (const car of now) {
          if (inLot.has(car)) continue;
          if (car === taxi) entered = true;
          else intruders += 1;         // the lot was supposed to be held
        }
        // The one frame a released car can be checked on: `traffic.update` has not composed its
        // transform yet, so what it *is* right now is a lane and a distance along it.
        if (inLot.has(taxi) && !now.has(taxi)) landed = taxi.lane?.path.at(taxi.s) ?? null;
        inLot = now;

        runTraffic.update(S);
        clock += S;
      }
      slowest = Math.max(slowest, clock);

      if (!entered) neverEntered += 1;
      if (!landed || Math.hypot(landed.x - site.merge.point.x, landed.z - site.merge.point.z) > 1e-9) {
        badLanding += 1;
      }
      if (taxi.staged) stillStaged += 1;
      if (taxi.pendingTarget !== job) notHandedBack += 1;
      if (paid !== before + 1) overpaid += 1;
    }

    check('a tap on the joint takes the taxi through the drive-through',
      refused === 0 && trips === jobs.length && neverEntered === 0,
      `${trips - neverEntered}/${jobs.length} trips reached the lane, ${refused} refused, `
      + `slowest ${slowest.toFixed(1)}s`);
    check('...and the lot is held for it: nobody else pulls in while it is on its way',
      intruders === 0, `${intruders} cars took a place that was being held`);
    check('...it comes back out onto the merge lane, to the bit, back in the traffic model',
      badLanding === 0 && stillStaged === 0 && finished === trips,
      `${badLanding} bad landings, ${stillStaged} left staged, ${finished} trips ended`);
    check('...the burger is paid for exactly once per visit',
      overpaid === 0 && paid === trips, `${paid} rewards over ${trips} visits`);
    check('...and the job the detour interrupted is put back under the car on the way out',
      notHandedBack === 0 && restored === trips,
      `${restored}/${trips} routes restored`);

    // And the lot goes back to being a drive-through. A reservation that leaked would show up here
    // and nowhere else: the queue would simply never take another car for the rest of the run.
    const servedBefore = runLot.state.served();
    step(300);
    check('...and ambient cars pull in again once the taxi has gone',
      runLot.state.served() > servedBefore,
      `${runLot.state.served() - servedBefore} served in the five minutes after`);
  }

  // --- Can the camera see the lane?
  //
  // Nine points along it at a car's roofline, each fired along VIEW_DIR through the real merged
  // city — the buildings and the props, not the joint itself, whose own canopy is *meant* to be
  // over the pickup window. Swept over seeds, because the answer is a property of whatever got
  // built next door rather than of the joint.
  const laneClear = (city, cityProps, s) => {
    const caster = new THREE.Raycaster();
    caster.far = 600;
    for (let n = 0; n < 9; n++) {
      const p = s.path.at(s.enterS + (s.exitS - s.enterS) * (n / 8));
      const from = new THREE.Vector3(p.x, KERB_H + 1.5, p.z).addScaledVector(VIEW_DIR, 0.5);
      caster.set(from, VIEW_DIR);
      if (caster.intersectObjects([city, cityProps], false).length) return false;
    }
    return true;
  };
  check('nothing stands between the camera and this drive-through',
    laneClear(buildings.mesh, props, site));

  let sited = 0;
  let clear = 0;
  const BURGER_SEEDS = 10;
  for (let n = 0; n < BURGER_SEEDS; n++) {
    const s = seed + n * 977;
    const sweepLayout = createLayout(makeRng(s));
    if (!sweepLayout.burgerBlock) continue;
    sited += 1;
    const sweepCity = createBuildings(makeRng(s + 22), sweepLayout);
    const sweepProps = createProps(makeRng(s + 33), sweepLayout).mesh;
    if (laneClear(sweepCity.mesh, sweepProps, burgerSite(sweepLayout.burgerBlock))) clear += 1;
  }
  check('every seed hosts a burger joint', sited === BURGER_SEEDS, `${sited}/${BURGER_SEEDS}`);
  check('and its lane is unobstructed on every one of them', clear === sited, `${clear}/${sited}`);

  // The site filter works its sightlines out from `VIEW_DIR` without importing it — `city/` may not
  // reach into `game/`. This is the join between the two: move the camera's elevation and the
  // filter has to move with it, rather than going on predicting for a camera that no longer exists.
  check('the site filter is using this camera’s own elevation',
    Math.abs(VIEW_DIR.y / VIEW_DIR.x - VIEW_RISE) < 1e-9,
    `${(VIEW_DIR.y / VIEW_DIR.x).toFixed(4)} vs ${VIEW_RISE}`);

  // `createLayout` installs the network it bakes as *the* city network (see CLAUDE.md), so the
  // sweep above has replaced the city everything below this point measures against. Put it back.
  createLayout(makeRng(seed));
}

// --- Which kerb corners the camera can see ------------------------------------
//
// The bug: a courier pad behind a building is a delivery with no visible destination. The fix is a
// filter on the board rather than a new marker (game/sightline.js), and it stands on a height field
// rather than a raycast because 324 real rays through the merged city cost half a second. So the
// thing to check here is that the cheap answer and the honest one agree — and they are asked to
// agree in the direction that matters, which is one-sided: a height field built from triangle
// bounding boxes rounds occluders *up*, so it may call a visible corner hidden (costing the board a
// junction) but must never call a hidden one visible (which is the bug).
//
// Swept over seeds, because which corners are hidden is a property of what got built, not of the
// filter.
{
  const seenSamples = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1]];
  const caster = new THREE.Raycaster();
  caster.far = 900;
  // A real ray from a point on the mark, offset along the sightline the way the garage check does it.
  const rayClear = (targets, x, y, z) => {
    caster.set(new THREE.Vector3(x, y, z).addScaledVector(VIEW_DIR, 0.5), VIEW_DIR);
    return !caster.intersectObjects(targets, false).length;
  };
  // How much of the whole mark a real ray finds, on a 5 x 5 over the pad — the ground truth the
  // filter is scored against. Rays through the merged city are the expensive thing in this file
  // (1.6ms each, and there is no acceleration structure to fix that), so this is spent only where
  // it can change an answer: a corner whose six cheap samples ALL came back clear has six proven
  // sightlines spread across its mark and cannot be one of the hidden ones. Everything else — every
  // rejection, and every corner that scored anything less than a clean sweep — is measured.
  const trueVisible = (targets, x, z) => {
    let seen = 0;
    for (let u = 0; u < 5; u++) {
      for (let v = 0; v < 5; v++) {
        const dx = (u / 4 * 2 - 1) * PAD_R;
        const dz = (v / 4 * 2 - 1) * PAD_R;
        if (rayClear(targets, x + dx, KERB_H + RING_Y, z + dz)) seen += 1;
      }
    }
    return seen / 25;
  };

  let corners = 0;
  let rejected = 0;
  let disagreements = 0;
  let badKept = 0;
  let goodDropped = 0;
  let worstKept = 1;
  let originRejected = 0;
  let mostRejectedInOneCity = 0;
  const SEEDS = 4;
  for (let n = 0; n < SEEDS; n++) {
    const s = seed + n * 977;
    const sweepLayout = createLayout(makeRng(s));
    const sweepCity = createBuildings(makeRng(s + 22), sweepLayout).mesh;
    const sweepProps = createProps(makeRng(s + 33), sweepLayout).mesh;
    const targets = [sweepCity, sweepProps];
    setCityOccluders(sweepCity, sweepProps);
    let rejectedHere = 0;
    for (let i = 0; i <= GRID_I; i++) {
      for (let j = 0; j <= GRID_J; j++) {
        corners += 1;
        const c = cornerFor(i, j);
        const seen = cornerSeen(i, j);
        // The one-sided property, sample by sample rather than corner by corner: wherever the
        // height field says a point is in the clear, a real ray has to reach the camera from it.
        let clean = 0;
        for (const [u, v] of seenSamples) {
          const x = c.x + u * (RING_R / 2);
          const z = c.z + v * (RING_R / 2);
          if (!sightlineClear(x, KERB_H + RING_Y, z)) continue;
          clean += 1;
          if (!rayClear(targets, x, KERB_H + RING_Y, z)) disagreements += 1;
        }
        if (seen && clean === seenSamples.length) continue;    // proven visible, see `trueVisible`
        const vis = trueVisible(targets, c.x, c.z);
        if (!seen) {
          rejected += 1;
          rejectedHere += 1;
          if (i === 0 && j === 0) originRejected += 1;
          if (vis > 0.85) goodDropped += 1;
        } else {
          worstKept = Math.min(worstKept, vis);
          if (vis < 0.6) badKept += 1;
        }
      }
    }
    mostRejectedInOneCity = Math.max(mostRejectedInOneCity, rejectedHere);
  }

  check('the height field never calls a hidden point visible',
    disagreements === 0, `${disagreements} of ${corners * seenSamples.length} samples`);
  check('no corner the camera cannot see is left on the board',
    badKept === 0, `${badKept} kept with under 60% of the mark visible`);
  check('...and the worst corner it does keep still shows most of its mark',
    worstKept > 0.6, `${(worstKept * 100).toFixed(0)}% visible`);
  // The other direction, which the cell size buys and nothing else does: a height field coarse
  // enough to over-state a wall starts throwing away corners that were perfectly visible. At a
  // 1-unit cell this failed on this very sweep.
  check('no corner the camera CAN see is thrown away',
    goodDropped === 0, `${goodDropped} dropped with over 85% visible`);
  // The failure this was written for: `cornerFor` flips both axes at the origin junction, which is
  // the one corner of block (0, 0) with that block's own building between it and the camera. It is
  // hidden in nearly every city, and it was on the board in all of them.
  check('the origin corner — hidden in nearly every city — is off the board',
    originRejected >= SEEDS - 1, `${originRejected}/${SEEDS} cities`);
  // A filter that eats the board is worse than the bug. Two junctions a city on average, and the
  // worst city in the sweep is the number that would show up as "nowhere to put a fare".
  check('and the filter costs the board a couple of junctions, not a district',
    rejected / SEEDS < 4 && mostRejectedInOneCity <= 6,
    `${(rejected / SEEDS).toFixed(1)} of 36 per city, worst ${mostRejectedInOneCity}`);

  // With the field installed, both boards have to actually honour it — the fare loop through
  // `free()` and the courier through its own hard filter.
  const vScene = new THREE.Scene();
  const vTraffic = createTraffic(makeRng(seed + 44), vScene, CARS_DEFAULT);
  const vFares = createFareSystem(makeRng(seed + 55), vScene, {
    reserved: () => vParcels.occupiedSpots(),
  });
  const vParcels = createParcelSystem(makeRng(seed + 255), vScene);
  vTraffic.warmup(5);
  let placements = 0;
  let hidden = 0;
  for (let n = 0; n < 3000; n++) {
    vTraffic.update(1 / 60);
    vFares.update(1 / 60, vTraffic.taxi, { delivered: 12 });
    vParcels.state.nextSpawnAt = Math.min(vParcels.state.nextSpawnAt, vParcels.state.t ?? 0);
    vParcels.update(1 / 60, vTraffic.taxi, { fareSpots: vFares.occupiedSpots(), delivered: 12 });
    for (const spot of [...vFares.occupiedSpots(), ...vParcels.occupiedSpots()]) {
      placements += 1;
      if (!cornerSeen(spot.i, spot.j)) hidden += 1;
    }
  }
  check('neither board ever stakes a marker on a corner the camera cannot see',
    hidden === 0 && placements > 100, `${hidden} hidden of ${placements} placements`);

  // `createLayout` installs the network it bakes as *the* city network (see CLAUDE.md), and
  // `setCityOccluders` is the same shape of module state one layer up. Put both back.
  createLayout(makeRng(seed));
  setCityOccluders(buildings.mesh, props);
}

// --- Taxi roof sign -----------------------------------------------------------
// The sign no longer carries the fare's own colour — it just says occupied or not. Assert the
// on/off states directly rather than trusting the toggle by eye.
{
  const { sign, setOccupied } = createTaxiMesh();
  const hex = (c) => new THREE.Color(c).getHexString();
  check('taxi sign starts dark, empty', sign.material.color.getHexString() === hex(PALETTE.taxiTrim));
  setOccupied(true);
  check('taxi sign lights up once a rider boards',
    sign.material.color.getHexString() === hex(PALETTE.taxiSign));
  setOccupied(false);
  check('taxi sign goes dark again once the rider is dropped off',
    sign.material.color.getHexString() === hex(PALETTE.taxiTrim));
}

// --- The river, its bridges and the span that lifts ------------------------
//
// Four things, and each is the sort that fails silently: geometry the camera never shows you,
// a clearance chain spread over three files, a closure that has to still leave the city routable,
// and a leaf that must never come down on anything.
{
  const rScene = new THREE.Scene();
  const rBanks = riverBanks();
  const rWater = waterEdges();

  check('the city has a river, and it splits it roughly in half',
    rBanks !== null && riverRow() !== null
    && riverRow() >= 1 && riverRow() <= GRID_J - 2,
    `row ${riverRow()} of ${GRID_J}, channel ${(rWater.z1 - rWater.z0).toFixed(1)} units of water`);

  // --- The clearance chain.
  //
  // Four numbers across three files decide whether the drawbridge has a reason to exist: two
  // soffits in city/river.js, two air draughts built into geometry/boat.js. Asserted as the chain
  // rather than as its outcome, so moving any one of them fails here rather than shipping a tug
  // that sails under the bridge it opens.
  const flatGap = -WATER_Y + FLAT_SOFFIT;
  const archGap = -WATER_Y + ARCH_SOFFIT;
  const bargeGeo = createBargeMesh(makeRng(seed + 811));
  const tugGeo = createTugMesh(makeRng(seed + 812));
  bargeGeo.computeBoundingBox();
  tugGeo.computeBoundingBox();
  const bargeAir = bargeGeo.boundingBox.max.y;
  const tugAir = tugGeo.boundingBox.max.y;

  check('a barge clears every span in the city',
    bargeAir <= BARGE_AIR + 1e-6 && bargeAir < flatGap,
    `${bargeAir.toFixed(2)} against the flat span's ${flatGap.toFixed(2)}`);
  check('and a tug clears the arched ones but not the flat one',
    tugAir < archGap && tugAir > flatGap,
    `${tugAir.toFixed(2)} against ${flatGap.toFixed(2)} flat and ${archGap.toFixed(2)} arched`);
  check('the arch is what buys the tug that clearance',
    archGap - flatGap > 0.9, `${(archGap - flatGap).toFixed(2)} units of hump`);

  // --- The deck profile.
  //
  // Zero slope at both abutments is the whole reason the hump is a `sin^2` — a curve arriving at
  // the road with slope left in it kinks where the two meet, and no rise tunes that out.
  const rSpan = bridgeSpan(bridgeLines().find((i) => riverCrossing(i) === 'fixed'));
  const rLen = rSpan.z1 - rSpan.z0;
  check('the arch meets the road flat at both ends',
    Math.abs(archAt(0, rLen).slope) < 1e-9 && Math.abs(archAt(1, rLen).slope) < 1e-9
    && Math.abs(archAt(0, rLen).y) < 1e-9 && Math.abs(archAt(1, rLen).y) < 1e-9,
    `crest ${archAt(0.5, rLen).y.toFixed(2)} at ${(Math.atan(Math.max(
      ...Array.from({ length: 41 }, (_, k) => Math.abs(archAt(k / 40, rLen).slope)),
    )) * 180 / Math.PI).toFixed(1)} degrees of peak grade`);

  // Every deck triangle wound the way it claims. A lofted arch is exactly the shape the roadworks
  // ramp shipped inside out, and `computeVertexNormals` launders a reversed one into looking
  // deliberate — so the normal is computed from the winding rather than read off the attribute.
  {
    let degenerate = 0;
    let upward = 0;
    const a = new THREE.Vector3(); const b = new THREE.Vector3();
    const c = new THREE.Vector3(); const n = new THREE.Vector3();
    for (const i of bridgeLines()) {
      const geo = createBridge(bridgeSpan(i), makeRng(seed + 820 + i));
      const p = geo.attributes.position;
      for (let k = 0; k < p.count; k += 3) {
        a.fromBufferAttribute(p, k); b.fromBufferAttribute(p, k + 1); c.fromBufferAttribute(p, k + 2);
        n.copy(b).sub(a).cross(c.clone().sub(a));
        if (n.length() < 1e-9) { degenerate += 1; continue; }
        if (n.normalize().y > 0.5) upward += 1;
      }
    }
    check('no bridge triangle is degenerate', degenerate === 0, `${degenerate} of them`);
    // The running surface, both footways, the rail caps and the dashes all face up; if the lofting
    // ever flips, this is what goes with it.
    check('the deck faces the sky', upward > 100, `${upward} up-facing triangles`);
  }

  // --- The paint does not sink into the hump.
  //
  // `markRoad` lays its dashes flat at y = 0.02 and an arched deck is 1.1 above that at the crest,
  // which is why the span paints its own. If the ground ever starts painting a bridged gap again
  // the marks vanish into the deck with nothing logged.
  {
    const rGround = createGround(makeRng(seed + 11), layout);
    let overWater = 0;
    const scan = (geo) => {
      const p = geo.attributes.position;
      for (let k = 0; k < p.count; k += 3) {
        let cz = 0;
        for (let v = 0; v < 3; v++) cz += p.getZ(k + v);
        cz /= 3;
        if (cz > rBanks.z0 + 1e-3 && cz < rBanks.z1 - 1e-3) overWater += 1;
      }
    };
    scan(rGround.geometry);
    for (const child of rGround.children) if (child.geometry && child.name !== 'river-mouth-fade') scan(child.geometry);
    check('the ground lays nothing over the channel', overWater === 0,
      `${overWater} triangles between the banks`);
  }

  // --- The lift, and the two things it must never do.
  {
    const bridge = createDrawbridge(rScene, makeRng(seed + 830), {});
    check('one span lifts', bridge !== null && bridge.laneIds.length === 2,
      bridge ? `line ${bridge.line}` : 'none');

    // **The city is still routable with the leaf up.** `isCityConnected` runs at layout time with
    // every bridge down, so it says nothing about the state this module spends a fifth of the run
    // in — and a lift that stranded a corner of the map would strand a fare with it.
    setBlockedLanes(bridge.laneIds);
    const ints = allIntersections();
    let stranded = 0;
    for (const from of ints) {
      for (let d = 0; d < 4; d++) {
        for (const to of ints) if (findRoute({ i: from.i, j: from.j, d }, to) === null) stranded += 1;
      }
    }
    setBlockedLanes([]);
    check('every fare is still reachable with the leaf up', stranded === 0,
      `${stranded} unroutable of ${ints.length * 4 * ints.length}`);

    // ...and no route threads the raised span, which is the other half of the same claim: a large
    // weight would still be paid on a city where the bridge is the short way across.
    setBlockedLanes(bridge.laneIds);
    const net2 = cityNetwork();
    let threaded = 0;
    for (const from of ints) {
      for (let d = 0; d < 4; d++) {
        const path = findRoute({ i: from.i, j: from.j, d }, { i: bridge.span.line, j: bridge.span.row });
        if (!path) continue;
        let at = { i: from.i, j: from.j, d };
        for (const step of path) {
          const lane = net2.laneOutByGrid(step, at.i, at.j);
          if (lane && bridge.laneIds.includes(lane.id)) threaded += 1;
          const next = lane ? net2.nodeById.get(lane.to) : null;
          at = next ? { i: next.gi, j: next.gj, d: step } : at;
        }
      }
    }
    setBlockedLanes([]);
    check('and no route threads a raised leaf', threaded === 0, `${threaded} legs over it`);

    // **The leaf waits for the deck, with no timeout.** A car standing on the span holds the whole
    // cycle in `clearing` — including the taxi, including one the player is sitting on with the
    // brake held. This is the check that stops "it hardly ever happens" from becoming a car in the
    // river.
    bridge.request();
    const stuck = [{ lane: { id: bridge.laneIds[0] }, turn: null }];
    for (let f = 0; f < 60 * 40; f++) bridge.update(1 / 60, stuck);
    check('the leaf never moves while a car is on the deck',
      bridge.state.lift === 0 && bridge.state.phase === 'clearing',
      `${bridge.state.phase} after 40s, lift ${bridge.state.lift.toFixed(2)}`);
    for (let f = 0; f < 60 * 6; f++) bridge.update(1 / 60, []);
    check('and goes up once it clears', bridge.state.lift > 0.99, bridge.state.phase);

    // The boats, over a full run. The tug must never be inside the span with the leaf anywhere but
    // fully up — which is the boat's own doing (`HOLD_OFF`), not the bridge's.
    const boats = createBoats(rScene, makeRng(seed + 840), bridge);
    let lowest = 1;
    let shutFrames = 0;
    for (let f = 0; f < 60 * 300; f++) {
      boats.update(1 / 60);
      bridge.update(1 / 60, []);
      if (bridge.closed) shutFrames += 1;
      for (const boat of boats.boats) {
        if (boat.kind !== 'tug') continue;
        if (Math.abs(boat.x - bridge.span.cx) < 5) lowest = Math.min(lowest, bridge.state.lift);
      }
    }
    check('a tug is never inside the span unless the leaf is fully up', lowest > 0.99,
      `lowest lift with a tug in the span: ${lowest.toFixed(3)}`);
    // Long enough to be an event, short enough not to be the map. Two or three lifts in a
    // three-minute session, and the span open for four fifths of the run.
    check('the span spends most of the run open', shutFrames / (60 * 300) < 0.3,
      `shut ${((100 * shutFrames) / (60 * 300)).toFixed(0)}% of five minutes,`
      + ` ${boats.state.tugs} tugs and ${boats.state.barges} barges`);
    bridge.dispose();
  }
}

// Average speed per car over the whole run — a stable throughput number, unlike a snapshot of
// how many cars happen to be moving at the instant the sim stops.
const throughput = stats.distance / stats.time / traffic.cars.length;
console.log(`\nthroughput: ${throughput.toFixed(2)} avg units/s per car`);

const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
