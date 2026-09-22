import * as THREE from 'three';
import { bakeColor } from '../util/geo.js';
import { color } from '../palette.js';
import { KERB_H } from './ground.js';

// The city's one bank: a low, wide stone building with a colonnade under a pediment and a
// patinated dome behind it. It is the third building the tower generator does not draw, and the
// first of the three that is **a lot rather than a whole block** — a bank has no forecourt to pull
// out of and no drive-through lane, so there is nothing for it to need a block for. It is placed
// and built from `city/buildings.js` alongside the courtyard, which is the other one-per-city
// massing, and for the same reason: "exactly one" cannot be decided lot by lot.
//
// **What it is for is the event, and the event is a silhouette.** A robbery
// ([gameplay.md](../../docs/gameplay.md#the-bank-robbery)) starts when the empty taxi drives past
// this building, so a player who has had one happen to them has to be able to find the thing that
// caused it — from across a five-block city, at play zoom, on a phone. That is a tighter brief than
// "a distinctive building" and it is the whole of why this is shaped the way it is:
//
//   - **Low and wide**, against neighbours that run 5 to 16 units tall. The roofline is a flat 6.95
//     and the dome tops out at 9.59 on average over 40 seeds (9.39 to 9.73), so the bank is a gap
//     in the skyline before it is anything else. The frontage measures 10.19 on the same sweep,
//     which is very nearly a whole block: the minimums below are met by an undivided block and by
//     essentially nothing else, so a bank is a whole block of the city rather than a corner of one.
//     38 of those 40 cities had somewhere to put it. That roofline is also the one number here
//     that was *derived* rather than chosen — see the note on the heights below.
//   - **A colonnade**, which is the one vertical rhythm in a city of plain boxes. It is why
//     `bankColumn` is a paler stone than `bankStone`: at play zoom a column is about three pixels
//     and what reads is the column against the wall, not the shadow between them.
//   - **A pediment**, the one triangle at street level. Pitched roofs exist in this city
//     (`pitchedRoof` in city/buildings.js) but they sit on top of low-rise and never at the front.
//   - **A dome**, the one curved mass in the city, and in the one colour nothing else wears.
//
// **The front is not a choice.** The camera looks down the +X+Z diagonal and never rotates, so of a
// building's four faces only +X and +Z are ever visible — the same fact the burger joint's whole
// orientation falls out of (city/burgerjoint.js) and the courtyard's step-down at the front. A
// portico facing anywhere else is a portico the player never sees, and the trigger would then be a
// rule firing off a building with nothing on the side it fires from. So `chooseBankLot` only offers
// lots with a +X or +Z street side, and `bankSite` faces whichever of the two the lot has.

/** Smallest buildable rectangle a bank fits on: across the frontage, and back from it. */
const MIN_WIDTH = 7.0;
const MIN_DEPTH = 5.5;

// --- Heights, each measured off the one below it -----------------------------
//
// **The roofline is not a free number, and it is the one thing on this building that was measured
// rather than drawn.** A bank takes a whole block, so its back wall is a single flat 10-unit
// occluder standing directly up-screen of a kerb corner — and that corner is one a rider or a
// courier pad can be placed on. The sightline off a mark climbs 0.92 per unit travelled in x and z
// alike (game/sightline.js), and the geometry is fixed: a kerb corner stands `HALF_ROAD + 0.5`
// out from its own junction, the block starts `HALF_ROAD` the other side of it, and the buildable
// rectangle is `BANK_INSET` inside that — so the back wall is **9.35 units** away on an ordinary
// street, and the sightline is 7.64 units up by the time it reaches the *nearest* part of the mark
// and 10.86 by the furthest.
//
// Anything between those two cuts the mark in half, which is the one outcome the whole
// visible-corner filter cannot express: `cornerSeen` scores six samples and the corner comes out at
// three of six, on the wrong side of a threshold calibrated against towers that hide a mark
// outright or not at all. Measured over 840 corners in 20 cities against real rays: a roofline at
// 7.75 put **three** corners on the board with under 60% of their mark visible, and the score-4
// bucket's worst case at 0.56. At 6.95 both are zero and the worst corner kept is 0.64, which is
// where every other city in the sweep already sat.
//
// So the mass is sized to duck **under** 7.64 with margin rather than to clear 10.86: a taller bank
// would hide the corner honestly and cost the board a junction, and a low wide bank is what the
// silhouette wanted anyway. Everything at the front is then sized down to stay under it — a
// pediment poking above the roof behind it is a gable, not a portico.
/** The plinth the whole building stands on. */
const PLINTH_H = 0.55;
/** Column shaft, from the top of the plinth to the underside of the entablature. */
const COL_H = 4.0;
/** The beam the columns carry, and the pediment standing on it. */
const ENTAB_H = 0.5;
const PED_RISE = 0.85;
/** The main mass behind the portico, from the top of the plinth. See the note above. */
const MASS_H = 5.8;
const CORNICE_H = 0.25;
/** The drum the dome sits on, and the dome's own rise as a fraction of its radius. */
const DRUM_H = 0.6;

// --- Plan ---------------------------------------------------------------------
/** How far the portico reaches back from the front of the buildable rectangle. */
const PORTICO_DEPTH = 1.9;
/** ...and how far the steps reach forward of the columns, out of that. */
const STEP_RUN = 0.75;
const STEP_COURSES = 3;
/** A column's footprint, square. */
const COL_SIDE = 0.46;
/** How far the outermost column centres sit in from the ends of the frontage. */
const COL_MARGIN = 0.7;
/** Column count, by frontage — four is a portico, seven is a bank that took the whole street. */
const COL_MIN = 4;
const COL_MAX = 6;
/** The doorway in the wall behind the colonnade: a fraction of the frontage, and its height. */
const DOOR_FRACTION = 0.26;
const DOOR_H = 3.2;

/**
 * Where the plinth's top face sits. Exported for the same reason `APRON_Y` is in
 * city/burgerjoint.js: the module that lays a surface owns the height of anything standing on it,
 * and the trap it is avoiding is the one that file records — `createGround` lays a block's pavement
 * at `KERB_H + 0.01`, so a flat surface put down at `KERB_H` is *coplanar* with it and the whole lot
 * flickers as the camera moves.
 *
 * The plinth is a box rather than a flat quad, so only its top face is at risk and the pavement is
 * a whole `PLINTH_H` below it. The number is exported anyway because the steps are measured off it.
 */
export const PLINTH_TOP = KERB_H + PLINTH_H;

function box(w, h, d, x, base, z, col) {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, base + h / 2, z);
  return bakeColor(geo, col);
}

/**
 * Which of a lot's four sides sit on the block's edge, matching `streetSidesOf` in buildings.js.
 *
 * Only the two the camera can see are ever asked about, so this answers one axis at a time instead
 * of returning a list.
 */
const facesStreet = (lot, bounds, axis) => (axis === 'x'
  ? Math.abs(lot.x1 - bounds.x1) < 0.05
  : Math.abs(lot.z1 - bounds.z1) < 0.05);

/**
 * Everything about where a bank stands, derived from its lot alone so the geometry and the event
 * can never disagree about which way the doors face.
 *
 * `axis` is which way the front looks: `'x'` for a portico facing +X, `'z'` for one facing +Z.
 * `door` is the point on the pavement at the bottom of the steps — where the robber comes out of
 * (`game/robbery.js`) and what the trigger measures its range from. `centre` is the mass's own
 * centre, which is what a camera or a marker would aim at.
 *
 * Returns null for a lot that cannot carry one, so the caller's filter and the builder's
 * preconditions are the same function rather than two lists of numbers that have to be kept in
 * step.
 *
 * **The buildable rectangle is handed in rather than worked out here**, which is the one piece of
 * plumbing in this file. `buildableOf` and its `INSET` live in city/buildings.js and belong there —
 * the setback off a lot line is a fact about every building in the city, not about this one — and
 * importing it would close a cycle, since buildings.js is what calls this module. Restating the
 * constant is the other option and it is worse: two copies of a number that must agree, with
 * nothing to notice when one of them moves. See geometry/lights.js for the same shape of problem
 * solved by a third module, which is overkill for one function.
 */
export function bankSite(b, lot, bounds) {
  const w = b.x1 - b.x0;
  const d = b.z1 - b.z0;
  if (w < 2 || d < 2) return null;

  // Which way it faces. A lot on the block's +X edge gets a +X portico; one on the +Z edge gets a
  // +Z one. A lot on both takes the *longer* frontage, so the colonnade gets the columns it wants.
  const onX = facesStreet(lot, bounds, 'x');
  const onZ = facesStreet(lot, bounds, 'z');
  if (!onX && !onZ) return null;
  const axis = onX && onZ ? (d >= w ? 'x' : 'z') : (onX ? 'x' : 'z');

  // In the frontage frame: `width` runs along the façade, `depth` back from it.
  const width = axis === 'x' ? d : w;
  const depth = axis === 'x' ? w : d;
  if (width < MIN_WIDTH || depth < MIN_DEPTH) return null;

  // The front plane, and the centre of the frontage along it.
  const frontX = axis === 'x' ? b.x1 : (b.x0 + b.x1) / 2;
  const frontZ = axis === 'z' ? b.z1 : (b.z0 + b.z1) / 2;

  // The door point: at the foot of the steps, half a unit out past the buildable edge, which puts
  // it on the pavement rather than inside the building's own setback.
  const out = 0.5;
  return {
    axis,
    width,
    depth,
    b,
    front: { x: frontX, z: frontZ },
    door: {
      x: frontX + (axis === 'x' ? out : 0),
      z: frontZ + (axis === 'z' ? out : 0),
    },
    centre: { x: (b.x0 + b.x1) / 2, z: (b.z0 + b.z1) / 2 },
  };
}

/**
 * Pick the lot the bank takes, out of every lot in the city.
 *
 * Drawn **after** the courtyard and with its lot excluded, for the reason every one-per-city draw
 * in this codebase is drawn last: adding it must not be able to reshuffle anything already decided.
 * The two rarely compete anyway — a courtyard needs 8.2 units both ways and a bank needs 7.0 across
 * its frontage and 5.5 back, which is a lower bar on both axes.
 *
 * `null` is a real answer, and the whole robbery layer switches off behind it (see main.js). A city
 * whose blocks all happened to split into narrow lots gets no bank rather than a cramped one.
 */
export function chooseBankLot(rng, lots, buildableOf, exclude = null) {
  const options = lots.filter((entry) => entry !== exclude
    && entry.block.type === 'built'
    && bankSite(buildableOf(entry.lot), entry.lot, entry.block.bounds) !== null);
  return options.length ? rng.pick(options) : null;
}

/**
 * Build the bank into `parts`, and hand back its site.
 *
 * Everything is placed in the frontage frame and then mapped out to world x/z through `at`, so the
 * building is the same building whichever of the two visible sides it ends up facing — there is no
 * mirrored second copy of the layout to keep in step. `u` runs along the façade from its centre and
 * `v` runs *back* from the front plane, so every v below is a positive depth into the lot.
 */
export function buildBank(b, lot, bounds, parts) {
  const site = bankSite(b, lot, bounds);
  if (!site) return null;

  const { axis, width, depth, front } = site;
  // The centre of the frontage, along it. On a +X-facing bank the façade runs in z.
  const frontU = axis === 'x' ? (b.z0 + b.z1) / 2 : (b.x0 + b.x1) / 2;
  const at = (u, v) => (axis === 'x'
    ? { x: front.x - v, z: frontU + u }
    : { x: frontU + u, z: front.z - v });
  /** A box sized in the frontage frame: `su` across the façade, `sv` back from it. */
  const slab = (su, h, sv, u, base, v, col) => {
    const p = at(u, v);
    const [sx, sz] = axis === 'x' ? [sv, su] : [su, sv];
    parts.push(box(sx, h, sz, p.x, base, p.z, col));
  };

  const stone = color('bankStone');
  const columnStone = color('bankColumn');
  const stepStone = color('bankStep');

  // --- The plinth, and the steps up it ---------------------------------------
  //
  // The plinth stops at the back of the steps rather than running under them, which is the part
  // that is a decision. Laid across the whole footprint with the courses stacked *inside* it, the
  // top course's upper face would land on exactly the plinth's own — two front-facing surfaces on
  // one plane, which is the tie this project has already been bitten by once (the bridge abutment
  // against the channel wall: identical in float32, clean in every headless still, and a hard-edged
  // patchwork on a phone). Butted edge to edge instead they are a **seam**, which is the case the
  // coplanar rule explicitly does not cover — the two surfaces share a line and cover none of the
  // same ground.
  const plinthDepth = depth - STEP_RUN;
  slab(width, PLINTH_H, plinthDepth, 0, KERB_H, STEP_RUN + plinthDepth / 2, stepStone);

  // Wider than the colonnade by about a column either side, so the building is approached rather
  // than climbed, and never wider than the plinth it climbs to.
  const stepWidth = Math.min(width, width - COL_MARGIN * 2 + COL_SIDE * 2 + 1.2);
  const tread = STEP_RUN / STEP_COURSES;
  for (let k = 0; k < STEP_COURSES; k++) {
    // Course 0 is the front one and the lowest; the last is a full `PLINTH_H` and meets the
    // plinth's own face. Each course is a solid box from the pavement rather than a tread on a
    // riser — from 33° above, nothing can see under one.
    const h = (PLINTH_H / STEP_COURSES) * (k + 1);
    slab(stepWidth, h, tread, 0, KERB_H, STEP_RUN - tread * (k + 0.5), stepStone);
  }

  // --- The mass behind the portico -------------------------------------------
  const massDepth = depth - PORTICO_DEPTH;
  slab(width, MASS_H, massDepth, 0, PLINTH_TOP, PORTICO_DEPTH + massDepth / 2, stone);
  // A cornice, which is the cheapest thing on any building here and does the most work — see
  // `roofKit` in city/buildings.js, where the same 0.18 of ledge is what turns the top of a box
  // into the top of a building.
  slab(width + 0.36, CORNICE_H, massDepth + 0.36, 0, PLINTH_TOP + MASS_H,
    PORTICO_DEPTH + massDepth / 2, columnStone);

  // The doorway. Mostly buried in the mass with 0.03 of it standing **proud** of the front face —
  // the same trick and the same order of magnitude as `EPS` in city/buildings.js, which every
  // façade opening in the city is pushed out by. Flush is not the safe option it looks like: a dark
  // quad sitting exactly on the wall plane is two front-facing surfaces on one plane, and which one
  // wins is the rasteriser's rounding.
  const doorW = width * DOOR_FRACTION;
  slab(doorW, DOOR_H, 0.12, 0, PLINTH_TOP, PORTICO_DEPTH + 0.03, color('bankDoor'));

  // --- The colonnade ----------------------------------------------------------
  const columns = Math.max(COL_MIN, Math.min(COL_MAX,
    Math.round((width - COL_MARGIN * 2) / 1.7) + 1));
  const span = width - COL_MARGIN * 2;
  const colV = STEP_RUN + (PORTICO_DEPTH - STEP_RUN) / 2;
  for (let k = 0; k < columns; k++) {
    const u = -span / 2 + (span * k) / (columns - 1);
    slab(COL_SIDE, COL_H, COL_SIDE, u, PLINTH_TOP, colV, columnStone);
  }

  // The entablature the columns carry, running the full frontage and tying back into the mass so
  // the portico reads as part of the building rather than as a screen standing in front of it.
  const entabDepth = PORTICO_DEPTH - STEP_RUN + 0.3;
  const entabV = STEP_RUN + entabDepth / 2 - 0.15;
  slab(width, ENTAB_H, entabDepth, 0, PLINTH_TOP + COL_H, entabV, columnStone);

  // --- The pediment -----------------------------------------------------------
  //
  // A triangular prism, built exactly the way `pitchedRoof`'s gable is (city/buildings.js) —
  // `CylinderGeometry(1, 1, 1, 3)` rotated so the lone vertex points +Y and the flat edge lands
  // underneath. Building it out of the three-sided cylinder rather than hand-winding two triangles
  // and a soffit is the point: this project has a standing trap about hand-written triangles, and
  // the whole of the reason the roadworks ramp shipped inside out. A cylinder's winding is three's.
  const pedBase = PLINTH_TOP + COL_H + ENTAB_H;
  const ped = new THREE.CylinderGeometry(1, 1, 1, 3);
  ped.rotateX(-Math.PI / 2);
  // Circumradius 1 puts the base edge at √3 across and the apex 1.5 above it, so the scale divides
  // by both to land the prism exactly `width` across and `PED_RISE` tall.
  ped.scale(width / Math.sqrt(3), PED_RISE / 1.5, entabDepth);
  // Built with the triangle spanning x and the ridge running z, which is the +Z-facing bank. A
  // +X-facing one is the same prism turned a quarter: the triangle has to span the *façade*, and a
  // pediment whose gable end points along the building instead of out of it is a pitched roof.
  if (axis === 'x') ped.rotateY(Math.PI / 2);
  const pedAt = at(0, entabV);
  ped.translate(pedAt.x, pedBase + PED_RISE / 3, pedAt.z);
  parts.push(bakeColor(ped, columnStone));

  // --- The dome ---------------------------------------------------------------
  //
  // On the mass's own centre, on a drum. A hemisphere at 10 × 4 segments is 70 triangles — six
  // boxes' worth, where a punched-window tower on a lot this size emits several times that — and it
  // is the only curved mass in the city, which is what the whole event's findability rests on.
  //
  // `SphereGeometry`'s `phiLength`/`thetaLength` cut it open at the bottom, so nothing is drawn
  // under it. Left open on purpose: the camera is 33° above horizontal and the drum is 0.6 tall, so
  // there is no angle from which the inside of the shell can be reached.
  const domeCentre = at(0, PORTICO_DEPTH + massDepth / 2);
  const domeR = Math.min(width, massDepth) * 0.26;
  const drumTop = PLINTH_TOP + MASS_H + CORNICE_H + DRUM_H;
  parts.push(box(domeR * 2.2, DRUM_H, domeR * 2.2,
    domeCentre.x, PLINTH_TOP + MASS_H + CORNICE_H, domeCentre.z, columnStone));
  const dome = new THREE.SphereGeometry(domeR, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  dome.translate(domeCentre.x, drumTop, domeCentre.z);
  parts.push(bakeColor(dome, color('bankDome')));
  // A finial, so the dome has a top rather than trailing off into a facet seam.
  parts.push(box(0.22, 0.5, 0.22, domeCentre.x, drumTop + domeR - 0.05, domeCentre.z, columnStone));

  return {
    ...site,
    /** The roofline and the top of the dome, for anything that has to reason about the skyline. */
    roofY: PLINTH_TOP + MASS_H + CORNICE_H,
    domeY: drumTop + domeR,
    /**
     * The pediment's apex. Published because it is the one height here that is a sum of four other
     * constants, and so the one that drifts when any of them moves — a pediment poking above the
     * roof behind it is a gable, not a portico, and `tools/probe.mjs` holds the difference.
     */
    pedimentY: pedBase + PED_RISE,
    columns,
  };
}
