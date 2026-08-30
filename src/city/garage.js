import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry, unlitMaterial } from '../util/geo.js';
import { color, jitterColor } from '../palette.js';
import { KERB_H } from './ground.js';
import {
  DIR, GRID_I, GRID_J, HALF_ROAD, LANE, isSegmentClosed, junctionReach, lineX, lineZ,
} from './grid.js';

// The taxi's garage: a single-storey depot with a roller door on the street, and the one building
// in the city the tower generator doesn't draw. It exists for the opening vignette
// (game/opening.js) — the camera comes down onto the door, the door goes up, and the player's car
// drives out of it — so everything here is arranged around one shot from one fixed camera.
//
// **PROTOTYPE.** Three things are hard-coded that a finished version would probably decide per
// city, and each is called out where it lands: the door always faces **+X**, the depot always
// takes a **whole block**, and the exit is always a **right turn** into the near lane.
//
// Why +X and not a side chosen per seed: the camera looks down the +X+Z diagonal and never
// rotates, so only two of a building's four faces are ever visible at all. Of those two, +X is the
// one whose sightline to the camera leaves the block over the *road* rather than over the
// neighbouring block — see `occlusionClear` below, which is the whole of the site filter and the
// only part of this file that is subtle.

// --- The building, in block-local terms -------------------------------------
// All of these are measured off the block's own bounds, so the depot is the same building wherever
// it lands.

// Forecourt: kerb back to the building's street face. The generated city gives a lot 0.85 units of
// pavement, which is not a driveway — a car pulling out of a door that close to the kerb is over
// the lip before it has straightened up. Three units is enough apron to read as a forecourt and to
// give the drive-out a beat on the pavement before the drop.
const APRON = 3.0;
const SIDE_INSET = 0.9;          // setback off the block's other three edges
const HEIGHT = 5.0;              // parapet line
const DOOR_W = 5.4;
const DOOR_H = 3.4;
// How far the bay is sunk into the mass. Sized off the car that has to fit in it: the *drawn*
// taxi is 4.01 units long (CAR_LEN through TAXI_SCALE — see the note on `parkedX` in
// game/opening.js), and it parks with its nose clear of the shut door, so the bay needs that plus
// the recess plus somewhere to put the back bumper.
const BAY_D = 5.2;
const RECESS = 0.3;              // the curtain plane, behind the street face

// The door's centre, measured from the block's **−Z** edge rather than from its middle. This is
// the placement `occlusionClear` depends on: the sightline from the door to the camera runs +X+Z,
// so a door near the −Z end of the block has 7.8 units of z to spend before it crosses the block's
// far edge — and 7.8 units of x buys it, which is inside the 8-unit road. Centre the door and the
// line leaves over the *next block along* instead, where a tower can stand in front of it.
const DOOR_OFF = 4.5;

// Slat pitch on the curtain. Nine over the opening puts a shadow line every 0.36 units, which at
// play zoom is under three pixels and reads as texture — but the vignette watches this door at
// zoom 15, where it is nine distinct slats winding away.
const SLATS = 9;
const RAIL_H = 0.16;             // the bottom rail: the leading edge the eye tracks

// The block platform's walking surface — `createGround` lays the pavement one centimetre over the
// kerb box. A car standing on it rides this much higher than one on the road.
export const PAVEMENT_Y = KERB_H + 0.01;

/**
 * Can the camera actually see this block's +X face?
 *
 * The view never rotates, so this is one ray, computed rather than eyeballed. From a point on the
 * door the sightline runs (+1, +0.92, +1) per unit of x — see VIEW_DIR — and the question is
 * whether anything the city is about to build stands in it.
 *
 * Worked through once, from the bottom of the opening — the worst case, being the lowest — with
 * `DOOR_OFF` 4.5 and the door face 3 units back from the kerb:
 *
 *   - **The block straight across the road** (bi+1, bj) never occludes. The line leaves this
 *     block's z band after 7.5 units of x, which is still inside the 8-unit road, so it is already
 *     past that block in z before it reaches its façade.
 *   - **The diagonal block** (bi+1, bj+1) is the one that can. The line reaches its façade 16.35
 *     units of z out, by which point it is 15.4 units up — inside `buildTower`'s 16-unit ceiling.
 *     So the filter is on that block's *height*, and height comes from centrality: a ceiling of
 *     `5 + centrality * 11` clears the line whenever centrality is under 0.945, and 0.75 below
 *     leaves room for the top of the door as well as the bottom.
 *   - **Two blocks out** is safe on its own: the line is 20.7 units up by the far edge of
 *     (bi+1, bj+1), past `SKYLINE_CEILING`.
 *
 * A block on the eastern edge has no diagonal neighbour at all, which is why those pass for free.
 */
function occlusionClear(blocks, bi, bj) {
  if (bi + 1 > GRID_I - 1 || bj + 1 > GRID_J - 1) return true;  // nothing built out there
  const diagonal = blocks.find((b) => b.bi === bi + 1 && b.bj === bj + 1);
  if (!diagonal) return true;
  if (diagonal.type === 'park') return true;
  return diagonal.centrality < 0.75;
}

/**
 * Which block the depot takes, or null if this city has nowhere to put one.
 *
 * Null is a real answer and callers have to handle it: the vignette is a flourish, and a seed that
 * cannot host it should still open a playable run. `main.js` falls straight back to the old
 * opening.
 *
 * Called at the **end** of `createLayout`, after every other draw, so adding it cannot reshuffle a
 * single park, arterial or building — the generators downstream each run their own offset stream
 * and nothing in layout.js reads `rng` after this.
 */
export function chooseGarageBlock(rng, blocks) {
  const candidates = blocks.filter((b) => b.type === 'built'
    // A district block is half of a merged park; a lone pocket park is already excluded by `type`.
    && (b.districtId === null || b.districtId === undefined)
    // The road the door faces has to exist. A park district closes the road between its two
    // blocks, and a depot whose forecourt opens onto grass has nowhere to drive to.
    && !isSegmentClosed(b.bi + 1, b.bj, DIR.PZ)
    && occlusionClear(blocks, b.bi, b.bj));
  if (!candidates.length) return null;

  // Prefer somewhere off the outer ring: a depot in a corner puts the player's first fare — biased
  // to spawn near the taxi, see fares.js — out on the edge of the map with the whole city behind
  // it. Falls back to the full list rather than to nothing.
  const inner = candidates.filter((b) => b.bi > 0 && b.bj > 0 && b.bj < GRID_J - 1);
  return rng.pick(inner.length ? inner : candidates);
}

/**
 * Every number the vignette needs about a depot, derived from its block. Separate from the mesh so
 * `game/opening.js` can plan the drive-out without holding onto geometry.
 */
export function garageSite(block) {
  const { x0, z0, x1, z1 } = block.bounds;
  const frontX = x1 - APRON;
  const doorZ = z0 + DOOR_OFF;
  const curtainX = frontX - RECESS;
  // The kerb lip is the block's own +X bound: `blockBounds` stops where the road starts.
  const kerbX = x1;
  const laneX = lineX(block.bi + 1) - LANE;

  return {
    bi: block.bi,
    bj: block.bj,
    frontX,
    curtainX,
    doorZ,
    doorW: DOOR_W,
    doorH: DOOR_H,
    kerbX,
    laneX,
    // The back wall of the bay. Exported because the drive-out is planned against the door plane
    // and the probe checks the void is actually a void.
    bayX: frontX - BAY_D,
    exitZ: doorZ,
    // The fillet onto the lane, and it is not a free choice: the arc has to be tangent to the lane
    // it lands in *and* to the driveway it leaves, so its radius is exactly the gap between the
    // kerb and the near lane's centre. Which comes out at 2 — the same radius every right turn in
    // this city already uses (see `turnControl` in grid.js), so the manoeuvre reads as one of them.
    turnR: HALF_ROAD - LANE,
    // Where it hands back to the traffic model: the near lane on the road the door faces, running
    // +Z, approaching the junction at the far end of this block. Right-hand traffic puts that lane
    // nearest the kerb the taxi is pulling off, so the exit is a right turn.
    merge: {
      d: DIR.PZ,
      i: block.bi + 1,
      j: block.bj + 1,
      // `placeCar` counts back from the junction. The arc lands at `doorZ + turnR`; the lane's far
      // end stops one **crossing** road's reach short of the junction centre.
      //
      // `junctionReach` and not a hard-coded `HALF_ROAD`, for the reason `city/burgerjoint.js`
      // spells out at its own merge: that crossing road can be an arterial, and an arterial is a
      // third wider. This read `HALF_ROAD` until a depot happened to land on a block whose exit
      // junction is crossed by a main street, and then the vignette handed the taxi to the traffic
      // model 1.33 units from where the arc had just put it — a car twitching sideways on the one
      // frame the whole opening is built around.
      back: (lineZ(block.bj + 1) - junctionReach(DIR.PZ, block.bi + 1, block.bj + 1))
        - (doorZ + (HALF_ROAD - LANE)),
    },
    // The camera's subject: the middle of the opening, in three dimensions.
    focus: { x: curtainX, y: KERB_H + DOOR_H / 2, z: doorZ },
  };
}

function box(dx, dy, dz, x, base, z, col) {
  const geo = new THREE.BoxGeometry(dx, dy, dz);
  geo.translate(x, base + dy / 2, z);
  return bakeColor(geo, col);
}

/** A box between two corners, which is how every piece below is actually specified. */
function span(x0, x1, y0, y1, z0, z1, col) {
  return box(x1 - x0, y1 - y0, z1 - z0, (x0 + x1) / 2, y0, (z0 + z1) / 2, col);
}

/**
 * The depot: two merged meshes and a light.
 *
 * Two rather than one because the curtain moves and the shell does not. Both are stamped with the
 * same entrance anchor (see `stampEntry`), so the city's opening wave lifts the door with its own
 * building rather than leaving it hanging in the air.
 */
export function createGarage(block, rng) {
  const site = garageSite(block);
  const { x0, z0, z1 } = block.bounds;
  const { frontX, curtainX, doorZ, kerbX } = site;

  const bx0 = x0 + SIDE_INSET;
  const bz0 = z0 + SIDE_INSET;
  const bz1 = z1 - SIDE_INSET;
  const dz0 = doorZ - DOOR_W / 2;
  const dz1 = doorZ + DOOR_W / 2;
  const bayX = site.bayX;               // the back wall of the bay
  const base = KERB_H;
  const head = base + DOOR_H;           // the lintel: where the curtain winds away
  const top = base + HEIGHT;

  const wall = jitterColor(color('garageWall'), rng, { l: 0.03 });
  const trim = color('garageTrim');
  const bay = color('garageBay');

  const parts = [
    // The mass, hollowed for the bay: a back slab, a wing either side of the opening, and a header
    // over it. Built as four solids rather than as one box with a hole because the faces lining
    // the void are then each some solid's *outward* face, and so front-facing from inside it —
    // a hole cut in a single box shows nothing but the sky behind the building.
    span(bx0, bayX, base, top, bz0, bz1, wall),
    span(bayX, frontX, base, top, bz0, dz0, wall),
    span(bayX, frontX, base, top, dz1, bz1, wall),
    span(bayX, frontX, head, top, dz0, dz1, wall),

    // Parapet cap. A one-storey box with a lid reads as a building; without it, as a crate.
    span(bx0 - 0.18, frontX + 0.18, top, top + 0.34, bz0 - 0.18, bz1 + 0.18, trim),

    // The bay lining. Sits a hair inside every surface it covers, so it wins the depth test
    // against the wall behind it rather than arguing with it — and every panel stops short of
    // `curtainX`, because a lining that reached the street face would cross the closed door and
    // show as a dark sliver up each edge of it.
    span(bayX + 0.02, curtainX - 0.12, PAVEMENT_Y - 0.01, PAVEMENT_Y + 0.01,
      dz0 + 0.03, dz1 - 0.03, bay),
    span(bayX + 0.02, bayX + 0.1, base, head - 0.05, dz0 + 0.03, dz1 - 0.03, bay),
    span(bayX + 0.02, curtainX - 0.12, base, head - 0.05, dz0 + 0.03, dz0 + 0.11, bay),
    span(bayX + 0.02, curtainX - 0.12, base, head - 0.05, dz1 - 0.11, dz1 - 0.03, bay),
    span(bayX + 0.02, curtainX - 0.12, head - 0.11, head - 0.05, dz0 + 0.03, dz1 - 0.03, bay),

    // Door frame: a post either side. There is no separate lintel — the drum below is the head of
    // the opening, and a second bar in the same place is two coincident faces to z-fight.
    span(frontX, frontX + 0.14, base, head, dz0 - 0.22, dz0, trim),
    span(frontX, frontX + 0.14, base, head, dz1, dz1 + 0.22, trim),

    // The drum the curtain winds onto. Decoration — the slats are clamped away at the lintel, so
    // nothing needs hiding — but it is the one part that says *roller* rather than *shutter*.
    span(curtainX - 0.25, frontX + 0.15, head - 0.08, head + 0.62, dz0 - 0.25, dz1 + 0.25, trim),

    // The fascia band. See `garageSign` in palette.js for why this one is allowed to be yellow.
    span(frontX, frontX + 0.1, head + 0.78, head + 1.23, dz0 - 0.3, dz1 + 0.3, color('garageSign')),

    // The forecourt: asphalt laid over the pavement from under the door out to the kerb, which is
    // what says "cars come out of here" on a block that is otherwise bare paving. It runs back to
    // where the bay floor stops, so the threshold is continuous.
    span(curtainX - 0.12, kerbX, PAVEMENT_Y - 0.01, PAVEMENT_Y + 0.01, dz0 - 0.5, dz1 + 0.5,
      jitterColor(color('asphalt'), rng, { l: 0.02 })),

    // The other elevation. `+Z` is the second of the two faces this camera can ever see, and on a
    // one-storey box it is 8 × 5 units of nothing — which at the vignette's zoom is a quarter of
    // the frame. An office door and two windows are what a depot has besides the big hole, and
    // they are also the only thing on the building giving its height a human scale.
    span(bx0 + 1.0, bx0 + 1.9, base, base + 2.1, bz1, bz1 + 0.06, color('door')),
    span(bx0 + 0.82, bx0 + 2.08, base, base + 2.28, bz1, bz1 + 0.03, trim),
    span(bx0 + 3.0, bx0 + 4.6, base + 1.6, base + 2.9, bz1, bz1 + 0.05, color('shopfront')),
    span(bx0 + 5.2, bx0 + 6.8, base + 1.6, base + 2.9, bz1, bz1 + 0.05, color('shopfront')),

    // Rooftop plant, on top of the coping rather than under it. Same argument as the elevation
    // above: a flat lid reads as an unfinished box, and the city's own towers all carry some.
    box(1.6, 0.55, 1.2, bx0 + 2.2, top + 0.34, bz0 + 3.0, color('rooftop')),
    box(1.0, 0.42, 1.0, bx0 + 5.6, top + 0.34, bz1 - 2.2, color('rooftopIron')),

    dropKerb(kerbX, doorZ, rng),
  ];

  // The entrance wave scales every vertex about its object's ground anchor. One anchor for the
  // whole depot — shell and curtain alike — so the building comes up as one object.
  const anchorX = (bx0 + frontX) / 2;
  const anchorZ = (bz0 + bz1) / 2;
  const rand = hash01(anchorX, anchorZ);
  const stampAll = (geo) => stampEntry(geo, anchorX, anchorZ, rand);

  parts.forEach(stampAll);
  const shell = new THREE.Mesh(mergeGeometries(parts, false), propMaterial());
  parts.forEach((p) => p.dispose());
  shell.castShadow = true;
  shell.receiveShadow = true;
  shell.name = 'garage';

  // --- The curtain ----------------------------------------------------------
  const slatH = (DOOR_H - RAIL_H) / SLATS;
  const slats = [box(0.16, RAIL_H - 0.02, DOOR_W - 0.06, curtainX, base, doorZ,
    color('garageDoorRail'))];
  for (let k = 0; k < SLATS; k++) {
    slats.push(box(0.1, slatH - 0.045, DOOR_W - 0.1, curtainX,
      base + RAIL_H + k * slatH + 0.02, doorZ, color('garageDoor')));
  }
  slats.forEach(stampAll);
  const curtainGeo = mergeGeometries(slats, false);
  slats.forEach((s) => s.dispose());
  const curtain = new THREE.Mesh(curtainGeo, propMaterial());
  curtain.castShadow = true;
  curtain.name = 'garage-door';
  // The rest positions, kept so `setDoor` is a function of the open fraction rather than an
  // accumulating offset — a state machine that can be scrubbed, replayed and settled.
  const restY = Float32Array.from(curtainGeo.attributes.position.array);

  // --- The bay's strip light ------------------------------------------------
  // Unlit, because it is a light. Deliberately outside the entrance animation: the door is shut
  // while the city builds itself, so there is nothing for the wave to hide.
  const lightGeo = box(0.16, 0.08, DOOR_W - 1.6, curtainX - 1.3, head - 0.18, doorZ,
    color('garageLight'));
  const light = new THREE.Mesh(lightGeo, unlitMaterial({ vertexColors: true }));
  light.name = 'garage-light';

  const group = new THREE.Group();
  group.add(shell, curtain, light);

  /**
   * Wind the curtain up. `open` is 0 (shut) to 1 (gone).
   *
   * The whole door is one mesh and one draw call, and the winding is a clamp: every vertex rises
   * by the same travel and stops dead at the lintel, so a slat reaching the top collapses to zero
   * height there and disappears. That *is* what winding onto a drum looks like at this scale, and
   * it costs a rewrite of 360 floats rather than a mesh per slat, a shader patch, or a second
   * depth material for each of the two depth passes.
   *
   * Normals are not recomputed and do not need to be: every material in this project is
   * `flatShading`, which takes its normal from a screen-space derivative and never reads the
   * attribute (see docs/rendering.md).
   */
  function setDoor(open) {
    const travel = THREE.MathUtils.clamp(open, 0, 1) * DOOR_H;
    const position = curtainGeo.attributes.position;
    const array = position.array;
    for (let i = 1; i < array.length; i += 3) array[i] = Math.min(restY[i] + travel, head);
    position.needsUpdate = true;
    // The curtain only ever shrinks upward inside its shut bounds, so the sphere computed at
    // construction stays valid and there is nothing to refresh.
  }

  return { site, group, shell, curtain, light, meshes: [shell, curtain], setDoor,
    entrySite: { x: anchorX, z: anchorZ, r: Math.max(frontX - bx0, bz1 - bz0) / 2, rand } };
}

/**
 * The dropped kerb the taxi comes off.
 *
 * A rotated `BoxGeometry` rather than a hand-wound wedge, on purpose: this project has shipped a
 * ramp inside out once already (see CLAUDE.md), and a box that three wound itself cannot be wound
 * backwards by rotating it. The bulk of the box sinks under the road slab, which is opaque, so
 * only the sloped top and the two sides show.
 */
function dropKerb(kerbX, doorZ, rng) {
  // The slope, by its two endpoints: from a hair over the pavement 1.5 units back from the lip, to
  // a hair under the road just past it.
  const ax = kerbX - 1.5;
  const ay = PAVEMENT_Y + 0.02;
  const bx = kerbX + 0.1;
  const by = -0.02;
  const theta = Math.atan2(ay - by, bx - ax);
  const thickness = 0.5;

  const geo = new THREE.BoxGeometry(Math.hypot(bx - ax, ay - by), thickness, DOOR_W + 1.2);
  // Negative, so the box's own +x descends: (1, 0) rotates to (cos θ, −sin θ).
  geo.rotateZ(-theta);
  // Where the top face's centre has landed as a result, so the slope can be placed by its
  // endpoints rather than by trial and error.
  const cx = (thickness / 2) * Math.sin(theta);
  const cy = (thickness / 2) * Math.cos(theta);
  geo.translate((ax + bx) / 2 - cx, (ay + by) / 2 - cy, doorZ);
  return bakeColor(geo, jitterColor(color('kerb'), rng, { l: 0.02 }));
}
