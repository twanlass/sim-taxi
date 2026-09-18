import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bakeColor, hash01, propMaterial, stampEntry } from '../util/geo.js';
import { BUILDING_COLORS, color, jitterColor } from '../palette.js';
import {
  bayLayout, box, EPS, FACING, facadeQuads, GROUND_H, punchedWindows, ribbonWindows, shade,
  SIDE_OUT, SIDE_TAN, streakPeak,
} from './facade.js';
import { KERB_H } from './ground.js';
import { treeParts, treeShape } from './props.js';
import { buildRowHomes, rowHomeFits, ROW_RATE } from './rowhome.js';

/**
 * Nothing on a roof may reach past this.
 *
 * The ambient aeroplane cruises at 26 units at the bottom of its jitter and `tools/probe.mjs`
 * asserts four units of clearance under its belly, which puts the hard ceiling at 20.9. Roof
 * furniture is the only thing here that can reach it — the tallest possible tower is 16.4 to its
 * parapet — so the water tower and the mast are *conditional on fitting under this*, and fall
 * back to something shorter rather than being clamped into a stump. The probe asserts the
 * clearance across seeds; this is what makes the assertion hold by construction.
 */
export const SKYLINE_CEILING = 20.5;

// Curtain wall on the two cool envelopes, punched openings on the masonry. A rule rather than a
// roll: a glass tower with holes cut in it and a brick walk-up glazed floor to ceiling are both
// wrong, and tying the façade to the envelope colour means the city never builds either.
const CURTAIN_WALL = new Set(['glass', 'slate']);

/**
 * The street-level storey: a glazed shopfront on every face that meets a street, and one door.
 *
 * Only the street sides get it, which is the whole reason the block bounds are threaded down here.
 * A lot's interior sides face the back of the next lot along and a shopfront there would be a
 * window into somebody's party wall — and the difference between a building that has a front and
 * one that is glazed on all four sides is most of what makes a row of them read as a street.
 */
function groundFloor(parts, cx, cz, w, d, streetSides, rng) {
  const base = KERB_H;
  const glassH = Math.min(1.2, GROUND_H - 0.8);
  const glassY = base + 0.5 + glassH / 2;

  const sky = color('windowSky');
  for (const side of streetSides) {
    const faceW = side % 2 === 0 ? d : w;
    if (faceW < 1.6) continue;
    // The one place a plain top-to-bottom gradient is right: a shopfront is a single pane a metre
    // and a half tall, and what it catches is the sky over the street opposite — brightest along
    // its head, gone by the sill. No streak, because there is nothing here for one to cross.
    const lit = FACING[side];
    parts.push(facadeQuads(
      [{ u: 0, y: glassY, w: faceW * 0.74, h: glassH, g: [0, 0, 0.5 * lit, 0.5 * lit] }],
      side, cx, cz, w / 2, d / 2, color('shopfront'), EPS, sky,
    ));
  }

  // One entrance, on one street side. A door per face would read as four doors on a building the
  // size of a bus, which at this scale is what most of them are.
  const side = rng.pick(streetSides);
  const faceW = side % 2 === 0 ? d : w;
  if (faceW < 1.6) return;

  const { bays, pitch } = bayLayout(faceW);
  // Off-centre on a wide façade, which is what a real entrance is: dead centre reads as a
  // symmetry the rest of the building doesn't have.
  const bay = bays > 1 ? rng.int(0, bays - 1) : 0;
  const u = (bay + 0.5 - bays / 2) * pitch;
  const doorW = Math.min(1.15, pitch * 0.7);
  const doorH = GROUND_H - 0.45;

  // Stood off in two layers, so neither the door nor its surround is coplanar with the glazing
  // beside it. The surround is not decoration: `door` and `shopfront` sit within four points of
  // each other in value, and without a light frame around it the entrance is a dark patch on a
  // dark band that nobody can find. It is what makes a door read at all.
  parts.push(facadeQuads(
    [{ u, y: base + (doorH + 0.18) / 2, w: doorW + 0.3, h: doorH + 0.18 }],
    side, cx, cz, w / 2, d / 2, color('awning'), EPS * 2,
  ));
  parts.push(facadeQuads(
    [{ u, y: base + doorH / 2, w: doorW, h: doorH }],
    side, cx, cz, w / 2, d / 2, color('door'), EPS * 3,
  ));

  if (!rng.chance(0.55)) return;

  // The canopy over it. Reaches 0.47 out, which is well inside the 0.85 the tower is already
  // inset into its lot — a façade that grew past that line would be a building with its awning
  // over the pavement, and `tools/probe.mjs` measures cars against exactly that line.
  const [nx, nz] = SIDE_OUT[side];
  const [tx, tz] = SIDE_TAN[side];
  const reach = (side % 2 === 0 ? w / 2 : d / 2) + 0.22;
  const along = doorW + 0.5;
  parts.push(box(
    side % 2 === 0 ? 0.5 : along, 0.16, side % 2 === 0 ? along : 0.5,
    cx + nx * reach + tx * u, base + doorH + 0.12, cz + nz * reach + tz * u,
    color('awning'),
  ));
}

// The landing circle, and how it is sized against the deck under it. The fraction and the ceiling
// both went up when the helicopter arrived: the pad used to be scenery and is now somewhere a
// 5.4-unit machine has to sit down (see geometry/helicopter.js), and at the old `* 0.36` clamped to
// 2 the circle disappeared underneath it. The floor is what keeps a pad on a narrow deck from
// reading as a dinner plate; `choosePad` prefers roomy decks precisely so the clamp rarely bites.
const PAD_FRACTION = 0.4;
const PAD_MIN_R = 1.3;
const PAD_MAX_R = 2.4;
// How far the paint stands above the deck — the pad slab plus the H on top of it. What the
// helicopter's skids rest on, so it is exported rather than re-derived at the far end.
export const PAD_SURFACE = 0.1;

/**
 * A landing circle with an H on it. Returns the radius it settled on, which is what
 * `game/chopper.js` sizes its rotor wash against.
 *
 * Painted rather than lit: the deck is `roof` and the mark is `laneMark`, which is the same paint
 * the streets are striped with. That is not thrift, it is the point — an H is road marking that
 * happens to be eleven storeys up, and borrowing a colour the eye already files as "paint on a
 * surface" is what keeps a pale circle at play zoom from reading as something the player is meant
 * to tap. Every other pale disc in this game is a marker under a rider.
 */
function helipad(parts, cx, cz, radius, deck) {
  const r = THREE.MathUtils.clamp(radius, PAD_MIN_R, PAD_MAX_R);
  const pad = new THREE.CylinderGeometry(r, r, 0.1, 12);
  pad.translate(cx, deck + 0.05, cz);
  parts.push(bakeColor(pad, color('roof')));

  // The H, as three bars. Drawn as flat boxes standing 0.04 off the deck rather than as quads,
  // because from 33° above a quad lying on a surface and the surface itself are one plane and the
  // depth buffer picks between them per pixel.
  const bar = r * 0.16;
  const leg = r * 0.9;
  for (const dx of [-r * 0.3, r * 0.3]) {
    parts.push(box(bar, 0.04, leg, cx + dx, deck + 0.1, cz, color('laneMark')));
  }
  parts.push(box(r * 0.6, 0.04, bar, cx, deck + 0.1, cz, color('laneMark')));
  return r;
}

// What a deck has to be for the landing circle to look like it belongs there.
//
// The side is a hard requirement and the height only a preference, which is the other way round
// from how it reads. A city is not guaranteed to own a tower with a *wide* roof: the tallest masses
// are the ones that have set back twice, so the widest deck over 8.5 units is typically 3 to 5
// across, and demanding 4.2 of it left two thirds of all cities with no candidate at all. 2.9 is
// the smallest circle this draws (2.6) plus a strip of roof either side of it, and it gets the pad
// onto a genuine tower on seven cities in eight; the rest land at 6 to 8 units, which is a low-rise
// with a pad on it rather than a shop with one.
const PAD_MIN_DECK = 8.5;
const PAD_MIN_SIDE = 2.9;

/**
 * Which roof in the city gets the pad — decided once every deck is known, rather than rolled for
 * as each roof is built.
 *
 * It *was* a coin flip per eligible roof, and that produced a helipad on 23 cities out of 60 and
 * none at all on the other 37. Fine while the pad was scenery. Not fine now that a helicopter flies
 * in and lands on one (see game/chopper.js), because a city with no pad is a city with no vignette
 * — so the roll is gone and every city gets exactly one. What the seed decides is *which* roof, and
 * that is the same shape as the courtyard: "exactly one a city" is not a decision a per-lot roll can
 * make, and both are therefore taken outside the loop that builds them.
 *
 * Every deck wide enough to hold the circle is a candidate; the tall ones are preferred, and among
 * whichever pool that leaves, the roomier half wins. A landmark on the fourth-tallest tower is
 * still a landmark, and it beats one on the tallest if the tallest has set back to a chimney.
 */
function choosePad(decks, rng) {
  const fits = decks.filter((d) => Math.min(d.cw, d.cd) > PAD_MIN_SIDE);
  if (!fits.length) return null;

  const tall = fits.filter((d) => d.deck > PAD_MIN_DECK);
  // No tower in this city has a roof both high and wide enough: take the highest one that fits and
  // accept a tight circle on it. Picking the *roomiest* here instead is what the first version did,
  // and on a fifth of all cities that put the landing pad on a two-storey shop — the widest decks
  // in a city are the ones that never set back, which is to say the low ones.
  if (!tall.length) {
    return fits.reduce((best, d) => (d.deck > best.deck ? d : best));
  }

  // The roomier half of the tall ones, and then one of those at *random* — a city whose pad is
  // always on its single widest roof stops having a landmark and starts having a rule, and the
  // whole point of choosing late is that the seed gets to decide.
  const roomy = tall.slice()
    .sort((a, b) => Math.min(b.cw, b.cd) - Math.min(a.cw, a.cd))
    .slice(0, Math.max(1, Math.ceil(tall.length / 2)));
  return rng.pick(roomy);
}

/**
 * A pitched roof, instead of a flat deck and its clutter.
 *
 * Two shapes, and both come out of Three's own generators rather than being hand-built: a hip is
 * `ConeGeometry` with four radial segments and a gable is `CylinderGeometry` with three, rotated
 * onto its side. That is worth saying out loud — a roof is nothing but sloped faces, which is
 * exactly the shape the roadworks ramp shipped inside out (see CLAUDE.md), and a generated
 * geometry cannot be wound backwards. Rotation and positive non-uniform scale both preserve
 * handedness, so neither step can undo it either.
 *
 * Only the low masonry buildings get one. A pitch on a ten-storey tower is a folly, and on a
 * curtain wall it is a contradiction — but on the two- and three-storey stuff that makes up most
 * of the map, it is the difference between a suburb and a row of shoeboxes.
 *
 * Exported so `tools/probe.mjs` can check the winding on the shape itself. It cannot be checked on
 * the merged city: courtyard trees ship in the same mesh and half of every canopy points downward,
 * which is exactly the false negative a whole-mesh sweep gives you.
 */
export function pitchedRoof(parts, cx, cz, cw, cd, y, body, rng) {
  // The eaves the roof sits on, overhanging the walls by 0.2 all round.
  parts.push(box(cw + 0.4, 0.16, cd + 0.4, cx, y, cz, shade(body, 0.86)));
  const base = y + 0.16;
  const w = cw + 0.4;
  const d = cd + 0.4;
  const rise = THREE.MathUtils.clamp(Math.min(w, d) * 0.42, 1, 2.4);

  // Slate or clay tile. The tile is `brick` darkened, which keeps its hue and saturation exactly
  // and only drops the value — and that is what makes it safe warm colour in a game where warm
  // colour is spoken for. It lands at 11.4° in the working space, five degrees off the roadworks
  // cone, but at saturation 0.57 against 0.96 and lightness 0.16 against 0.44 it is a third of the
  // cone's brightness; more to the point, `brick` itself is already a wall colour standing on
  // streets all over this city, so the eye has read this hue as masonry since before there were
  // roofs. A tile roof is the same clay as the wall under it, fired darker. See the note on `cone`
  // in palette.js for the argument this one is a corollary of.
  //
  // Mixed rather than picked per building family: a brick building with a slate roof and a tan one
  // with a tile roof are both ordinary, and tying the two together made a street of low-rise read
  // as two kinds of building rather than as a dozen different ones.
  const col = rng.chance(0.45)
    ? jitterColor(shade(color('brick'), 0.72), rng, { h: 0.012, l: 0.05 })
    : jitterColor(color('roof'), rng, { h: 0.02, l: 0.07 });

  if (rng.chance(0.45)) {
    // Hip: a four-sided pyramid. Its base square has a circumradius of 1, so a side is √2 — hence
    // the rotation onto the axes and the /√2 in the scale.
    // Open-ended: the base cap is four triangles of floor sitting on the eaves box, and nothing
    // ever sees under a roof from 33° above it.
    const geo = new THREE.ConeGeometry(1, 1, 4, 1, true);
    geo.rotateY(Math.PI / 4);
    geo.scale(w / Math.SQRT2, rise, d / Math.SQRT2);
    geo.translate(cx, base + rise / 2, cz);
    parts.push(bakeColor(geo, col));
    return;
  }

  // Gable: a triangular prism laid on its side, ridge along the *longer* axis — a ridge running
  // the short way across a long building reads as a tent pitched sideways.
  const alongX = w > d;
  const span = alongX ? d : w;         // across the slope
  const len = alongX ? w : d;          // along the ridge
  const geo = new THREE.CylinderGeometry(1, 1, 1, 3);
  // Axis Y → -Z, and the triangle's lone vertex (at +Z) → +Y, so the flat edge lands underneath.
  geo.rotateX(-Math.PI / 2);
  // Circumradius 1 puts the base edge at √3 across and the apex 1.5 above it.
  geo.scale(span / Math.sqrt(3), rise / 1.5, len);
  if (alongX) geo.rotateY(Math.PI / 2);
  geo.translate(cx, base + rise / 3, cz);
  parts.push(bakeColor(geo, col));
}

/**
 * A cornice, and then whatever the roof can carry.
 *
 * The cornice is the cheapest of the lot and does the most work: twelve triangles of ledge
 * standing 0.18 proud of the walls turns the top of a box into the top of a *building*, and it
 * reads at play zoom where none of the rest of this does.
 */
function roofKit(parts, cx, cz, cw, cd, y, style, body, rng, stats) {
  const capH = 0.3;
  if (style === 'punched') {
    parts.push(box(cw + 0.36, capH, cd + 0.36, cx, y, cz, shade(body)));
  } else {
    // A curtain wall has no cornice to have — the glass runs to a flush parapet, which is the
    // whole visual difference between the two at a distance.
    parts.push(box(cw, capH, cd, cx, y, cz, color('rooftop')));
  }
  const deck = y + capH;

  // Every flat deck in the city, with the slice of `parts` its furniture is about to occupy. One of
  // them becomes the helipad once they are all known — see `choosePad` — and the slice is why the
  // range is recorded: a landing circle claims the whole roof, because a plant room standing in the
  // middle of one is the single thing a deck like that cannot have. So the winner's furniture comes
  // back off. Building it and dropping it costs one roof's worth of boxes a city, and it buys the
  // pad decision the thing it actually needs, which is to be taken *after* every deck exists.
  const site = { cx, cz, cw, cd, deck, from: parts.length, to: parts.length };
  stats.decks.push(site);
  roofFurniture(parts, cx, cz, cw, cd, deck, rng);
  site.to = parts.length;
}

/** The plant room, the AC, and the one-in-eight water tower or mast. */
function roofFurniture(parts, cx, cz, cw, cd, deck, rng) {
  const area = cw * cd;

  // Plant room / stair bulkhead. Every roof used to get one, which made a skyline of identical
  // boxes wearing identical smaller boxes.
  if (rng.chance(0.55) && area > 6) {
    parts.push(box(cw * rng.range(0.26, 0.46), rng.range(0.7, 1.6), cd * rng.range(0.26, 0.46),
      cx + rng.jitter(cw * 0.2), deck, cz + rng.jitter(cd * 0.2), color('rooftop')));
  }

  // Air conditioning. Sized up a touch from the first pass, where at 0.5–0.85 wide they were four
  // pixels at play zoom and went unnoticed entirely; they are the thing that makes a roof look
  // occupied, so they have to be legible from the framing the game is actually played at.
  const units = area > 14 ? rng.int(0, 2) : rng.int(0, 1);
  for (let n = 0; n < units; n++) {
    const uw = rng.range(0.6, 1);
    const ud = rng.range(0.5, 0.85);
    const uh = rng.range(0.35, 0.6);
    const ux = cx + rng.jitter(Math.max(0, cw / 2 - uw));
    const uz = cz + rng.jitter(Math.max(0, cd / 2 - ud));
    parts.push(box(uw, uh, ud, ux, deck, uz, color('rooftop')));
    // The fan grille on top, as a plate rather than a disc: a cylinder here is 24 triangles for
    // something four pixels across.
    parts.push(box(uw * 0.62, 0.06, ud * 0.62, ux, deck + uh, uz, color('rooftopIron')));
  }

  // The water tower. Mid-rise only: a tank on legs is a walk-up's answer to water pressure and
  // looks wrong on the tallest thing in the city, which has a plant room for it instead. The
  // ceiling test is belt and braces on top of that — see SKYLINE_CEILING.
  const TANK_R = 0.62;
  const LEG_H = 1.1;
  const TANK_H = 1.7;
  const CAP_H = 0.5;
  const TOWER_H = LEG_H + TANK_H + CAP_H;
  const MID_RISE = 13;
  // One in eight. It was three in ten to start with and the city grew a forest of them: at play
  // zoom a water tower is a 5px spike above the roofline, and on every roof that is a texture
  // rather than a landmark. Rare enough to notice one is the whole point of it.
  if (area > 12 && deck < MID_RISE && deck + TOWER_H < SKYLINE_CEILING && rng.chance(0.125)) {
    const tx = cx + rng.jitter(Math.max(0, cw / 2 - TANK_R - 0.5));
    const tz = cz + rng.jitter(Math.max(0, cd / 2 - TANK_R - 0.5));

    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      parts.push(box(0.13, LEG_H, 0.13, tx + lx * TANK_R * 0.62, deck, tz + lz * TANK_R * 0.62,
        color('rooftopIron')));
    }
    const tank = new THREE.CylinderGeometry(TANK_R, TANK_R * 0.94, TANK_H, 8);
    tank.translate(tx, deck + LEG_H + TANK_H / 2, tz);
    parts.push(bakeColor(tank, jitterColor(color('watertank'), rng, { l: 0.04 })));
    // The hoop that holds the staves together. Two triangles' worth of ring is what stops the tank
    // reading as a plain drum.
    const hoop = new THREE.CylinderGeometry(TANK_R * 1.04, TANK_R * 1.02, 0.14, 8);
    hoop.translate(tx, deck + LEG_H + TANK_H * 0.32, tz);
    parts.push(bakeColor(hoop, color('rooftopIron')));
    const cap = new THREE.ConeGeometry(TANK_R * 1.1, CAP_H, 8);
    cap.translate(tx, deck + LEG_H + TANK_H + CAP_H / 2, tz);
    parts.push(bakeColor(cap, color('roof')));
    return;
  }

  // Or a mast, on the tall ones. The old threshold was `height > 22` against a ceiling of 16, so
  // no building in the shipped city ever grew one.
  const MAST_H = rng.range(2.2, 4.5);
  if (deck > 9 && deck + MAST_H < SKYLINE_CEILING && rng.chance(0.4)) {
    const mast = new THREE.CylinderGeometry(0.1, 0.15, MAST_H, 5);
    mast.translate(cx, deck + MAST_H / 2, cz);
    parts.push(bakeColor(mast, color('pole')));
  }
}

const MIN_LOT = 4.2;

/** Recursive lot subdivision, so blocks read as several parcels rather than one monolith. */
function splitLot(x0, z0, x1, z1, depth, rng) {
  const w = x1 - x0;
  const d = z1 - z0;

  const canSplit = depth > 0 && Math.max(w, d) > MIN_LOT * 2;
  if (!canSplit || rng.chance(0.26)) return [{ x0, z0, x1, z1 }];

  const ratio = rng.range(0.4, 0.6);
  if (w >= d) {
    const xm = x0 + w * ratio;
    return [
      ...splitLot(x0, z0, xm, z1, depth - 1, rng),
      ...splitLot(xm, z0, x1, z1, depth - 1, rng),
    ];
  }
  const zm = z0 + d * ratio;
  return [
    ...splitLot(x0, z0, x1, zm, depth - 1, rng),
    ...splitLot(x0, zm, x1, z1, depth - 1, rng),
  ];
}

/** Which of a lot's four sides sit on the block's edge, and so face a street. */
function streetSidesOf(lot, bounds) {
  const on = (a, b) => Math.abs(a - b) < 0.05;
  const sides = [];
  if (on(lot.x1, bounds.x1)) sides.push(0);
  if (on(lot.z1, bounds.z1)) sides.push(1);
  if (on(lot.x0, bounds.x0)) sides.push(2);
  if (on(lot.z0, bounds.z0)) sides.push(3);
  return sides;
}

/** The buildable rectangle inside a lot: the lot minus the setback off every line. */
const INSET = 0.85;
function buildableOf(lot) {
  const x0 = lot.x0 + INSET;
  const z0 = lot.z0 + INSET;
  const x1 = lot.x1 - INSET;
  const z1 = lot.z1 - INSET;
  return {
    x0, z0, x1, z1, w: x1 - x0, d: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2,
  };
}

function buildTower(lot, block, rng, parts, stats) {
  const { w, d, cx, cz } = buildableOf(lot);
  if (w < 2 || d < 2) return;

  const streetSides = streetSidesOf(lot, block.bounds);

  // Height is driven by how central the block is — this is what produces a downtown silhouette
  // instead of an evenly tall grid.
  // Capped far lower than the city sim's 43. Downtown towers there were tall enough to hide the
  // taxi behind them, and the player has to be able to see the car they're directing at all times.
  const ceiling = 5 + block.centrality * 11;
  const height = Math.max(5, rng.range(0.42, 1) * ceiling);

  const family = rng.pick(BUILDING_COLORS);
  const style = CURTAIN_WALL.has(family) ? 'curtain' : 'punched';
  const body = jitterColor(color(family), rng, { l: 0.05 });
  const windowColor = color('window');
  // Sampled once per building rather than per tier, so a setback tower's reflection runs on up
  // through the steps instead of restarting at each one.
  const peak = streakPeak(cx, cz);

  let y = KERB_H;
  let cw = w;
  let cd = d;
  let remaining = height;
  let tier = 0;

  // Stack up to three setback tiers, each smaller than the one below.
  while (remaining > 4 && tier < 3) {
    const tierH = tier === 0
      ? Math.min(remaining, remaining * rng.range(0.55, 0.8))
      : remaining;

    parts.push(box(cw, tierH, cd, cx, y, cz, tier === 0 ? body : jitterColor(body, rng, { l: 0.04 })));

    // The ground storey only exists on the tier that meets the pavement; everything above it
    // starts its floor lines straight off the setback.
    const firstFloorH = tier === 0 ? GROUND_H : 0.4;
    if (style === 'punched') {
      punchedWindows(parts, cx, y, cz, cw, cd, tierH, firstFloorH, windowColor, peak, body);
    } else {
      ribbonWindows(parts, cx, y, cz, cw, cd, tierH, firstFloorH, windowColor, peak);
    }
    if (tier === 0 && streetSides.length) groundFloor(parts, cx, cz, cw, cd, streetSides, rng);

    y += tierH;
    remaining -= tierH;
    tier += 1;

    if (remaining <= 4) break;
    // A ledge where the tower steps in, so a setback reads as a setback rather than as two boxes
    // that happen to be stacked.
    parts.push(box(cw + 0.2, 0.22, cd + 0.2, cx, y, cz, shade(body, 0.86)));
    y += 0.22;
    const shrink = rng.range(0.62, 0.82);
    cw *= shrink;
    cd *= shrink;
  }

  // Low, masonry, and never set back — anything else keeps its flat deck. `tier === 1` is the
  // "never set back" test: the loop increments it once per tier built.
  const lowRise = tier === 1 && style === 'punched' && height <= 8 && Math.min(cw, cd) > 2;
  if (lowRise && rng.chance(0.45)) {
    stats.pitched += 1;
    pitchedRoof(parts, cx, cz, cw, cd, y, body, rng);
  } else {
    roofKit(parts, cx, cz, cw, cd, y, style, body, rng, stats);
  }
}

// --- Courtyard blocks -------------------------------------------------------
//
// A hollow perimeter block: four wings around a planted courtyard. It is the one massing in the
// city that isn't a solid, and it only works because of a measurement.
//
// The camera looks down VIEW_DIR (1, 0.92, 1), which is 33.0° above horizontal. A wing of height
// h hides everything within h / tan(33°) = 1.54h of its inner face, so an enclosed courtyard with
// 5-unit wings and 6 units of opening shows the player nothing at all — the trees inside would be
// invisible and the whole thing would read as a slightly lumpy box.
//
// Four things fix it, and none of them is a cheat — they are all ordinary things for a building or
// a tree to do:
//
//   - The wings facing the camera (+X and +Z, which are also the two the sun lights) are built
//     from a **lower** height range than the pair behind them. A perimeter block that steps down
//     toward its front is normal architecture, and it is what opens the courtyard to the one
//     direction anybody ever looks from. The camera never rotates — see docs/rendering.md — so
//     "the front" is a fixed pair of sides.
//   - The wings are thin, which is what buys the yard the width to be seen into at all.
//   - The trees are grown from the tall end of the park's range, sized against the *front* pair.
//     The tall pair sit past the yard rather than between it and the camera, so they are not what
//     a crown has to clear.
//   - The trees carry their crowns **high**, and stand far enough off the wings that no part of a
//     crown is inside one. Those two are what put a *trunk* in view, and a trunk is what says the
//     thing is a tree in a yard rather than a shrub on a roof — see `TREE_TRUNK` below and the
//     planting in `buildCourtyard`.
const COURT_MIN = 8.2;        // smallest buildable rectangle worth hollowing out
// Thin wings and low ones at the front, and both numbers come straight off the 1.54h above. At
// 2.3–3.1 thick with 3.2–4.6 at the front the yard was 4.9 across — 6.9 on the diagonal against
// 4.9–7.1 of occlusion — and the lawn never showed at all: the trees read as sitting on the roof
// of a lumpy box rather than as standing in a hole in it.
//
// At 2.0–2.7 thick it averaged 4.96 across over 24 seeds — 5.7 is the widest a block ever gives,
// and this comment quoted that as though it were the usual — and what it showed was the crowns and
// nothing else: **69 of 91 trees showed no bare trunk at all**, and 11 of the 24 cities had not one
// tree with a trunk in view. At 1.6–2.1, with the front pair capped at 3.1 rather than 3.6, the
// yard is 5.98 across: 8.5 on the view diagonal against 4.0–4.8 of occlusion.
const WING_MIN = 1.6;
const WING_MAX = 2.1;
const FRONT_H = [2.6, 3.1];   // the floor is the ground storey: GROUND_H plus its cornice
const TREE_H = [4.4, 6];
// A courtyard tree is pruned up, and this fraction is the lever the whole thing turns on. What a
// wing hides is measured from the *crown's underside*, and the parks' broadleaf carries that at
// 0.37 of its height — below the 2.6–3.1 the wing in front of it stands — so the wider yard on its
// own only got the average bare trunk to 0.41 of a unit, 23 of 91 trees still showing none. At 0.55
// it is 0.90 and 15 of 91: six pixels of trunk at play zoom, which is the difference between a tree
// standing in a hole and a shrub sitting on a roof. Held by `tools/probe.mjs`.
const TREE_TRUNK = 0.55;

function buildCourtyard(lot, block, rng, parts) {
  const { x0, z0, x1, z1, w, d, cx, cz } = buildableOf(lot);
  const streetSides = streetSidesOf(lot, block.bounds);

  const family = rng.pick(BUILDING_COLORS);
  const style = CURTAIN_WALL.has(family) ? 'curtain' : 'punched';
  const body = jitterColor(color(family), rng, { l: 0.05 });
  const windowColor = color('window');
  const peak = streakPeak(cx, cz);

  const t = rng.range(WING_MIN, WING_MAX);

  // The lawn first, so the wings draw over its edges rather than leaving a green seam.
  const yard = { x0: x0 + t, z0: z0 + t, x1: x1 - t, z1: z1 - t };
  parts.push(box(yard.x1 - yard.x0, 0.06, yard.z1 - yard.z0,
    (yard.x0 + yard.x1) / 2, KERB_H, (yard.z0 + yard.z1) / 2,
    jitterColor(color('park'), rng, { l: 0.03 })));

  // Wing rectangles, indexed by the side each one faces: 0 = +X, 1 = +Z, 2 = -X, 3 = -Z. The pair
  // running along Z are full length and the pair along X fill what is left between them, so the
  // four meet edge to edge and no two of them overlap — a ring, not four crossed slabs.
  //
  // `faces` is how much of each side is glazable. The two ends of a short wing are buried in the
  // long wing beside it, and a long wing's inner face only shows across the gap between them.
  const mid = Math.max(0, w - 2 * t);
  const inner = Math.max(0, d - 2 * t);
  const wings = [
    { side: 0, x0: x1 - t, x1, z0, z1, faces: [d, t, inner, t] },
    { side: 2, x0, x1: x0 + t, z0, z1, faces: [inner, t, d, t] },
    { side: 1, x0: x0 + t, x1: x1 - t, z0: z1 - t, z1, faces: [0, mid, 0, mid] },
    { side: 3, x0: x0 + t, x1: x1 - t, z0, z1: z0 + t, faces: [0, mid, 0, mid] },
  ];

  let tallest = 0;
  const front = [0, 0];       // the two camera-facing wings, indexed by side: what a tree has to clear
  for (const wing of wings) {
    // Front pair low, back pair full height. See the note above.
    const facing = wing.side === 0 || wing.side === 1;
    const h = facing
      ? rng.range(FRONT_H[0], FRONT_H[1])
      : rng.range(5.2, 5.2 + block.centrality * 5);
    if (facing) front[wing.side] = h;
    tallest = Math.max(tallest, h);

    const ww = wing.x1 - wing.x0;
    const wd = wing.z1 - wing.z0;
    const wx = (wing.x0 + wing.x1) / 2;
    const wz = (wing.z0 + wing.z1) / 2;
    if (ww < 0.5 || wd < 0.5) continue;

    parts.push(box(ww, h, wd, wx, KERB_H, wz, jitterColor(body, rng, { l: 0.03 })));
    // One ground storey across the whole perimeter, low wings included — they are the same
    // building. Starting a short wing's windows lower would put a row of them straight through
    // the shopfront band that `groundFloor` paints on the same face.
    const firstFloorH = GROUND_H;
    if (style === 'punched') {
      punchedWindows(parts, wx, KERB_H, wz, ww, wd, h, firstFloorH, windowColor, peak, body,
        wing.faces);
    } else {
      ribbonWindows(parts, wx, KERB_H, wz, ww, wd, h, firstFloorH, windowColor, peak, wing.faces);
    }
    // A cornice per wing, so the stepped heights read as four buildings in a terrace.
    parts.push(box(ww + 0.3, 0.26, wd + 0.3, wx, KERB_H + h, wz, shade(body)));
  }

  // Street-level glazing and an entrance, on the perimeter as usual. The courtyard is behind it.
  if (streetSides.length) groundFloor(parts, cx, cz, w, d, streetSides, rng);

  // The planting. A trunk stands off the yard's edge by its own crown's **reach**, so no part of a
  // canopy is ever inside a wall. The front pair a crown may hang *over* — that is what a tree does
  // to a low wall — but the back pair are 5.2 units and up and would simply swallow it, and a crown
  // with a building through it is what the whole massing gets judged on: it reads as a shrub
  // sprouting out of a roof. Planted at a flat 0.7 off the edge whatever it was carrying, that was
  // 71 of 91 trees across 24 seeds, 48 of them buried more than half a unit deep.
  //
  // A yard too narrow to give a tree that room grows a smaller tree rather than planting one into a
  // wall, and the floor is knowable rather than hoped for: a block needs `COURT_MIN` to be hollowed
  // at all, so the yard is never under 8.2 − 2 × 2.1 = 4.0 across, `room` never under 1.6 and the
  // cap never under 4.8 — above the top of `TREE_H`, so this only ever trims a tall tree in a tight
  // yard and can't produce a bonsai.
  const trees = rng.int(3, 5);
  const yw = yard.x1 - yard.x0;
  const yd = yard.z1 - yard.z0;
  const reachPerHeight = treeShape(1, TREE_TRUNK).crownReach;   // off the generator, not restated
  const room = Math.min(yw, yd) / 2 - 0.4;
  const planted = [];
  for (let n = 0; n < trees; n++) {
    // Sized against the *front* wings, which are the only ones that occlude anything — the tall
    // pair behind sit past the courtyard, not between it and the camera. Grown from the tall
    // end of the park's range so a crown always clears a 3.1-unit wing; taken from the back
    // wings' height instead, a downtown courtyard produced one ten-unit tree that filled the
    // whole yard like a cauliflower.
    //
    // The height is drawn here rather than inside `treeParts` — the same draw in the same place in
    // the stream, so the tree is the one this seed would have grown anyway — because the yard has
    // to know how wide the crown is *before* it can decide where the trunk goes.
    const height = Math.min(rng.range(TREE_H[0], TREE_H[1]), room / reachPerHeight);
    const shape = treeShape(height, TREE_TRUNK);

    // Down the yard's **long** axis, one tree to a band, rather than three to five independent
    // draws over the same rectangle. What is left of the yard once the margin above is taken off
    // is 1.5 by 2.8 in the shot city, and four crowns 3.5 across drawn anywhere in that are one
    // crown with four trunks under it — which is exactly what the first build of this rendered.
    // A band each is what makes it read as a row of trees rather than as one shrub.
    const alongX = yw > yd;
    const [loA, hiA] = alongX ? [yard.x0, yard.x1] : [yard.z0, yard.z1];
    const [loB, hiB] = alongX ? [yard.z0, yard.z1] : [yard.x0, yard.x1];
    const lo = loA + shape.crownReach;
    const band = (hiA - shape.crownReach - lo) / trees;
    const along = rng.range(lo + band * n, lo + band * (n + 1));
    const across = rng.range(loB + shape.crownReach, hiB - shape.crownReach);
    const tx = alongX ? along : across;
    const tz = alongX ? across : along;
    planted.push({ x: tx, z: tz, ...shape });
    parts.push(...treeParts(tx, tz, rng, { height, trunk: TREE_TRUNK }));
  }

  // One AC unit or two on the tallest wing, reached through the same kit as everything else —
  // minus the water tower, which wants a roof this doesn't have.
  if (yw > 2 && yd > 2 && rng.chance(0.5)) {
    const wing = wings[rng.chance(0.5) ? 2 : 3];
    parts.push(box(rng.range(0.5, 0.8), 0.4, rng.range(0.45, 0.7),
      rng.range(wing.x0 + 0.6, wing.x1 - 0.6), KERB_H + tallest + 0.26,
      rng.range(wing.z0 + 0.6, wing.z1 - 0.6), color('rooftop')));
  }

  // Handed back so the yard can be measured rather than eyeballed: how much of each trunk clears
  // the wing in front of it is the whole reason the numbers above are the numbers they are, and
  // `tools/probe.mjs` holds it across seeds. See "the yard shows its trunks" there.
  return { yard, wing: t, front, trees: planted };
}

export function createBuildings(rng, blocks) {
  const parts = [];
  // Counted rather than inferred. These are all rates the look depends on — one courtyard, a
  // scattering of pitched roofs, a helipad now and then — and a rate that drifts is invisible in
  // any single city. Returning them is what lets `tools/probe.mjs` hold them across seeds.
  // `decks` is not a statistic — it is every flat roof in the city, gathered as they are built so
  // that the one landing circle can be placed once they all exist. It rides here rather than in a
  // parameter of its own because it is threaded through exactly the same three call sites the
  // counters are, and two out-parameters where one would do is two things to keep in step.
  const stats = { pitched: 0, helipads: 0, decks: [] };
  const rows = [];

  // Every parcel in the city, decided before any of them is built. Two passes rather than one
  // because of the courtyard: **exactly one city block gets hollowed out**, and "exactly one"
  // cannot be decided lot by lot. Rolled per lot instead it came out at two or three a city with
  // the tail running to five, and a distinctive massing repeated five times across a 5×5 grid
  // stops being distinctive — it just becomes the shape a block is.
  const lots = [];
  for (const block of blocks) {
    if (block.type !== 'built') continue;
    const { x0, z0, x1, z1 } = block.bounds;
    for (const lot of splitLot(x0, z0, x1, z1, 2, rng)) lots.push({ lot, block });
  }

  // Only an *undivided* block is wide enough to hollow out and still leave wings with rooms in
  // them, so the candidate list is short to begin with — five or so on a typical seed. A city
  // whose blocks all happened to split gets no courtyard rather than a cramped one.
  const roomy = lots.filter(({ lot }) => {
    const b = buildableOf(lot);
    return b.w > COURT_MIN && b.d > COURT_MIN;
  });
  const yard = roomy.length ? rng.pick(roomy) : null;

  // Every part a lot builds is stamped with that lot's ground anchor, which is what lets the
  // entrance animation (game/cityentry.js) grow whole buildings out of the one merged mesh. The
  // jitter is a hash of the anchor rather than a draw from `rng`, so the stamping is provably
  // geometry-neutral: the city a seed builds is the same city with or without it. `entrySites`
  // is the same anchors handed back as a list, for the dust each building kicks up as it lands.
  const entrySites = [];
  let court = null;
  for (const entry of lots) {
    const from = parts.length;
    if (entry === yard) {
      court = buildCourtyard(entry.lot, entry.block, rng, parts);
    } else {
      // A terrace of row houses, where the lot has the frontage for one and the camera can see it
      // — see `rowHomeFits`. A per-lot roll rather than a pick taken outside the loop, because
      // unlike the courtyard and the helipad a terrace is a *neighbourhood* rather than a
      // landmark: "exactly one a city" is the wrong shape for it, and the failure the rate has to
      // avoid is the opposite one, every outer block in the city a row of houses.
      //
      // Eligibility is settled first and the roll only taken on a lot that passes, so the draw is
      // spent where it decides something. Which lots those are is pure geometry — frontage, depth
      // and which way the block faces — and so is the same for a given city seed either way.
      const bl = buildableOf(entry.lot);
      const sides = streetSidesOf(entry.lot, entry.block.bounds);
      const row = rowHomeFits(bl, sides, entry.block.centrality).length && rng.chance(ROW_RATE)
        ? buildRowHomes(bl, sides, entry.block.centrality, rng, parts)
        : null;
      if (row) rows.push(row);
      else buildTower(entry.lot, entry.block, rng, parts, stats);
    }
    if (parts.length === from) continue;      // a lot too narrow to build stamps nothing
    const b = buildableOf(entry.lot);
    const rand = hash01(b.cx, b.cz);
    for (let i = from; i < parts.length; i++) stampEntry(parts[i], b.cx, b.cz, rand);
    entrySites.push({ x: b.cx, z: b.cz, r: Math.max(b.w, b.d) / 2, rand });
  }
  const courtyards = yard ? 1 : 0;

  // The landing circle, on the deck the whole city was built to choose from. Its furniture is
  // spliced back out first — see the note in `roofKit`. Nothing else has touched `parts` since
  // that range was recorded except appends past the end of it, so the indices still hold.
  const site = choosePad(stats.decks, rng);
  let pad = null;
  if (site) {
    for (let i = site.from; i < site.to; i++) parts[i].dispose();
    parts.splice(site.from, site.to - site.from);

    const padFrom = parts.length;
    const r = helipad(parts, site.cx, site.cz, Math.min(site.cw, site.cd) * PAD_FRACTION, site.deck);

    // One unit shoved into a corner, so the deck still reads as occupied — but only if the corner
    // it is going into is genuinely clear of the circle. The old placement was `cw / 2 - uw` from
    // the centre, which on the narrow decks the pad usually ends up on put the box *inside* the
    // paint: a third of all cities landed a helicopter on top of an air conditioner.
    const uw = rng.range(0.6, 0.9);
    const ux = site.cw / 2 - uw / 2;
    const uz = site.cd / 2 - uw * 0.4;
    if (Math.hypot(ux, uz) > r + uw * 0.75) {
      parts.push(box(uw, 0.45, uw * 0.8, site.cx + ux, site.deck, site.cz + uz, color('rooftop')));
    }

    // Where a helicopter puts its skids down: the top of the paint, not the top of the structure.
    // The deck's own dimensions ride along because the machine is longer than most of these roofs
    // are wide — `game/chopper.js` lines its approach up with the long axis so it sits along the
    // building rather than across it.
    pad = { x: site.cx, z: site.cz, y: site.deck + PAD_SURFACE, r, cw: site.cw, cd: site.cd };
    stats.helipads += 1;

    // The pad replaces furniture on a roof whose walls are already stamped, and `site.cx/cz` *is*
    // the anchor that tower was stamped with — setback tiers never move off their lot centre — so
    // hashing the same point makes the landing circle rise with its own building.
    for (let i = padFrom; i < parts.length; i++) {
      stampEntry(parts[i], site.cx, site.cz, hash01(site.cx, site.cz));
    }
  }

  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());

  const mesh = new THREE.Mesh(merged, propMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'buildings';
  return {
    mesh, count: parts.length, courtyards, court, pad, entrySites, rows,
    pitched: stats.pitched, helipads: stats.helipads,
  };
}
