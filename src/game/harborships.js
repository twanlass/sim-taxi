import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { propMaterial, vehiclePaintOn } from '../util/geo.js';
import { makeRng } from '../util/rng.js';
import { WATER_Y } from '../city/river.js';
import { coastEast } from '../city/grid.js';
import { EDGE_FADE } from '../city/ground.js';
import { ship as shipParts, SHIP_L } from '../city/harbor.js';
import { markOccluder } from './ssao.js';
import { sinkShadowCaster } from './scene.js';

// Ships coming in and out of the harbor (city/harbor.js builds the port; this moves the ships).
//
// Tyler, 2026-10-13: "ships coming in and out of port". One container ship at a time, on a cycle:
// in from the open sea down the middle of the basin bow first, eased sideways onto the berth under
// the cranes, a spell alongside, off the berth again, astern out past the pier ends, turned round
// in open water and away out to sea — then the berth stands empty for a while and the next one
// comes in. Two hulls take turns, each its own load of boxes, so the next ship is visibly a
// different one.
//
// Why astern and not a turn in the basin: the ship is 19 long and turning it about its middle
// sweeps a circle 19 across, which in the basin reaches the river's mouth, where the barges and
// the sailboat come out (game/boats.js). Past the pier ends there is nothing to hit.

// Speeds in world units per second. The traffic cruises at 8.5; a ship this size coming into port
// is barely moving, and that slowness is most of what makes it read as big.
const SAIL = 4.2;
const ASTERN = 2.2;
// Seconds for each of the slow manoeuvres.
const SIDESTEP = 7;
const TURN = 14;
// How long a ship stays alongside, and how long the berth stands empty after one leaves. Run seed.
const ALONGSIDE = [35, 60];
const EMPTY = [12, 30];
// The lane the ship comes in and goes out on, off the berth toward the middle of the basin.
const LANE_OFF = 7;
// How far past the pier ends the ship turns round, and where it starts and ends, out past the
// sea's fade so it arrives and leaves out of nothing.
const TURN_PAST = SHIP_L / 2 + 6;
const SEA_FAR = 52;
// A ship at its moorings still moves: a slow heave and a little roll.
const HEAVE = 0.06;
const ROLL = 0.012;

/**
 * A stand-in geometry carrying only a `boundingBox`: one ship's hull and upper works together,
 * which is all `propMaterial({ gloss })` reads off it. Off its own rng, so building it draws
 * nothing from the run's stream; the boxes on deck vary per ship and the box round them does not.
 */
function shipBounds() {
  const { hull, upper } = shipParts(makeRng(1));
  const box = new THREE.Box3();
  for (const part of [...hull, ...upper]) {
    part.computeBoundingBox();
    box.union(part.boundingBox);
    part.dispose();
  }
  return { boundingBox: box };
}

const ease = (t) => { const k = Math.min(1, Math.max(0, t)); return k * k * (3 - 2 * k); };

/**
 * `berth` is what `createHarbor` returns: where the ship ties up (`x`, `z`), which way is out from
 * the quay (`out`, ±1 in z) and where the open sea starts (`seaX`). Null without a harbor.
 */
export function createHarborShips(scene, rng, berth) {
  if (!berth) return null;
  // Hashed alpha rather than blending: the ship stays in the opaque pass, writes depth and needs no
  // sorting against the cranes, and still dissolves into the sky out past the sea's own fade the way
  // the water under it does, instead of popping into existence over nothing.
  //
  // The cars' paint, with the deck and the boxes tagged matte (`ship` in city/harbor.js). One
  // material for both hulls and everything on them, so its curve is centred on one ship's whole
  // bounds — a ship from the hull to the funnel cap — which `shipBounds` measures off a throwaway
  // build. `?vehiclepaint=classic` is the plain prop material it was before.
  // At the cargo box's 0.55 of the paint's reflection: at full strength the hull's whole bow went
  // to a band of pale sky.
  const material = vehiclePaintOn()
    ? propMaterial({ gloss: { geometry: shipBounds(), amount: 0.55 } })
    : propMaterial();
  material.alphaHash = true;
  const fadeFrom = coastEast() - 2;
  const fadeTo = coastEast() + EDGE_FADE * 0.7;
  const merge = (parts) => {
    const geo = mergeGeometries(parts, false);
    parts.forEach((p) => p.dispose());
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  // Everything on deck is its own mesh, riding on the hull, so its shadow can be sunk
  // (game/scene.js). The deck is 0.08 thick and the bridge's roof 0.18, against a shadow-map texel
  // that slides by more than either across its own width: both shadowed themselves in blotches,
  // and the heave and roll below slid the blotches about every frame — which read as z-fighting
  // over the whole superstructure. The hull is not sunk, so its shadow on the water still starts
  // at the waterline; it is solid and a long way deep, and has nothing to self-shadow.
  const hulls = [0, 1].map(() => {
    const { hull, upper } = shipParts(rng);
    const mesh = merge(hull);
    mesh.name = 'harbor-ship';
    mesh.visible = false;
    const works = sinkShadowCaster(merge(upper));
    works.name = 'harbor-ship-upper';
    mesh.add(works);
    scene.add(markOccluder(mesh));
    return mesh;
  });

  const laneZ = berth.z + berth.out * LANE_OFF;
  const turnX = berth.seaX + TURN_PAST;
  const farX = berth.seaX + SEA_FAR;

  // The legs of one visit, in order, each `{ name, time, at(t) }` where `at` gives the pose at
  // `t` in [0, 1] of the leg as `{ x, z, yaw }` — yaw π points the bow west, into port.
  const legs = [
    { name: 'in', time: (farX - berth.x) / SAIL * 1.25,
      // Eased out only: it arrives at speed and slows onto its mark.
      at: (t) => ({ x: farX + (berth.x - farX) * (1 - (1 - t) * (1 - t)), z: laneZ, yaw: Math.PI }) },
    { name: 'dock', time: SIDESTEP,
      at: (t) => ({ x: berth.x, z: laneZ + (berth.z - laneZ) * ease(t), yaw: Math.PI }) },
    { name: 'alongside', time: 0,
      at: () => ({ x: berth.x, z: berth.z, yaw: Math.PI }) },
    { name: 'undock', time: SIDESTEP,
      at: (t) => ({ x: berth.x, z: berth.z + (laneZ - berth.z) * ease(t), yaw: Math.PI }) },
    { name: 'astern', time: (turnX - berth.x) / ASTERN,
      at: (t) => ({ x: berth.x + (turnX - berth.x) * ease(t), z: laneZ, yaw: Math.PI }) },
    { name: 'turn', time: TURN,
      // About its own middle, out in open water: bow west round to bow east.
      at: (t) => ({ x: turnX, z: laneZ, yaw: Math.PI * (1 - ease(t)) }) },
    { name: 'out', time: (farX - turnX) / SAIL * 1.25,
      at: (t) => ({ x: turnX + (farX - turnX) * t * t, z: laneZ, yaw: 0 }) },
  ];

  const state = {
    hull: 0,
    leg: -1,        // -1: the berth is empty
    t: 0,
    wait: rng.range(2, 8),
    visits: 0,
    time: 0,
    x: farX, z: laneZ, yaw: Math.PI,
  };

  function begin() {
    state.leg = 0;
    state.t = 0;
    state.visits += 1;
    legs[2].time = rng.range(ALONGSIDE[0], ALONGSIDE[1]);
  }

  function pose() {
    const mesh = hulls[state.hull];
    for (const h of hulls) h.visible = h === mesh && state.leg >= 0;
    if (state.leg < 0) return;
    const leg = legs[state.leg];
    const p = leg.at(leg.time > 0 ? state.t / leg.time : 0);
    state.x = p.x;
    state.z = p.z;
    state.yaw = p.yaw;
    mesh.position.set(p.x, WATER_Y + HEAVE * Math.sin(state.time * 0.9), p.z);
    material.opacity = 1 - ease((p.x - fadeFrom) / (fadeTo - fadeFrom));
    // The hull is built bow +x; a yaw of π turns it to face west. Roll about its own length.
    mesh.rotation.set(ROLL * Math.sin(state.time * 0.7 + 1.3), p.yaw, 0, 'YXZ');
  }

  function update(dt) {
    state.time += dt;
    if (state.leg < 0) {
      state.wait -= dt;
      if (state.wait <= 0) begin();
    } else {
      state.t += dt;
      while (state.leg >= 0 && state.t >= legs[state.leg].time) {
        state.t -= legs[state.leg].time;
        state.leg += 1;
        if (state.leg >= legs.length) {
          state.leg = -1;
          state.wait = rng.range(EMPTY[0], EMPTY[1]);
          state.hull = 1 - state.hull;
        }
      }
    }
    pose();
  }

  /** Shot mode: a ship alongside under the cranes, the way the harbor's stills always had one. */
  function settle() {
    state.leg = 2;
    state.t = 1;
    pose();
  }

  pose();
  return { hulls, state, legs, update, settle, laneZ, turnX, farX };
}
