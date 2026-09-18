import * as THREE from 'three';
import { color, jitterColor } from '../palette.js';
import {
  box, EPS, facadeQuads, punchedWindows, shade, SIDE_OUT, SIDE_TAN, skyWeight,
  streakPeak, wallCeiling, WIN_W,
} from './facade.js';
import { KERB_H } from './ground.js';

// A terrace of brick row houses — the New York brownstone, and the one residential thing in a city
// otherwise made of offices and shops.
//
// Three to five narrow houses share party walls across a whole block frontage: a raised basement
// at pavement level, a **stoop** climbing to a front door one storey up, two or three storeys over
// that, and one heavy cornice running the length of the run. It is the third massing the tower
// generator doesn't draw — the depot and the courtyard block are the others — and the only one
// whose point is a thing standing *in front of* the façade rather than the façade itself.
//
// Which is what fixes most of the numbers below. At play zoom one world unit is 7.7px, so a stoop
// is three pixels of step against fifty of wall: it does not read as a staircase and was never
// going to. What it reads as is a mass jutting out into the light with its own shadow under it,
// and everything here is sized for that — the cheek walls beside the flight do more work than the
// steps, and the run is laid at 33° rather than at the 50° five risers would otherwise want,
// because a shallow diagonal is legible from a camera 33° above and a steep one is a wall.

// --- What a house is -------------------------------------------------------

// A storey of a **house**, which is not the storey of a block of flats. `FLOOR_H` next door is
// 2.6, and the difference is not decoration: the terrace's total height turned out to be the one
// number in this file the rest of the game can feel. See `STOREYS`.
const ROW_FLOOR_H = 2.3;
// The raised basement — the "garden level" — and so also how far the stoop has to climb. A
// brownstone's front door is a full storey off the pavement and that is the whole silhouette;
// below about a unit and a quarter the flight is three steps and the house reads as a building
// with a ramp outside it.
const GARDEN_H = 1.5;
// Storeys over the garden level: one or two, so a house is two or three floors and stands 4.14 or
// 6.44 units to the top of its cornice.
//
// **This is the number that has to be measured rather than chosen.** A terrace fills a whole block
// frontage with one continuous wall, and the blocks it is allowed on are the outer ones, where the
// tower generator's own ceiling is `5 + centrality * 11` — 5 to 6 units on a typical candidate. A
// terrace taller than that is not merely out of scale with its neighbours: it starts shading the
// kerb corners the fare board paints its marks on, and the marks are gameplay.
//
// Measured as the worst kept corner across four cities on each of six top-level seeds, where the
// bar `tools/probe.mjs` holds is 60% of the pad visible and an unchanged city runs 64–80%:
//
//   - at 2.6-unit storeys over a 1.6 basement (6.8 and 9.4 to the parapet) it was **44–68%**, red
//     on half the seeds, and the blocker was the terrace itself on every one of them;
//   - dropping the *stoops* entirely changed nothing — 44–48%, which is what said the massing was
//     the problem and not the thing standing in front of it;
//   - at 2.3-unit storeys over a 1.5 basement it is **64–76%**, and no terrace is the worst
//     blocker in any of the six.
//
// So a row house got the storey height a row house actually has, which is shorter than a block of
// flats'. Note what that does *not* claim: a three-floor terrace is 6.44 and the shortest tower in
// the game is 5, so a terrace is still the tallest thing on some of the blocks it lands on. What
// changed is that it stopped being tall enough to take a corner mark with it.
const STOREYS = [1, 2];
// What a terrace needs behind its front garden before it stops being a row of sheds.
const MIN_HOUSE_DEPTH = 4.5;

// The frontage one house takes. A brownstone is famously narrow — far deeper than it is wide — and
// narrow is also what makes a run of them read as *houses*: the party walls are the rhythm.
//
// The count comes out of the frontage rather than the other way round, because the openings have a
// floor. A house wants a door and a window side by side on the parlour floor, and an opening under
// about 0.8 units stops separating from the pier beside it (see the façade rhythm note in
// facade.js). Two openings and three piers is 2.3 units at the absolute limit, so the target sits
// clear of it: a 10.3-unit block frontage — which is what every eligible lot is, see
// `rowHomeFits` — divides into four houses of 2.57 with openings at 0.91.
const UNIT_TARGET = 2.6;
const UNIT_MIN = 3;
const UNIT_MAX = 5;
// Houses butt up on their party walls rather than interpenetrating, and the first cut had it the
// other way round — 0.04 of lap, on the reasoning that two boxes sharing a plane hand that plane
// to whichever one the rasteriser rounds in front ("an exact tie does not shimmer", CLAUDE.md).
//
// That reasoning does not apply here, and the lap it bought created the artefact it was insuring
// against. A party wall is two box faces at the same plane pointing in *opposite* directions, so
// backface culling draws exactly one of them and it is buried inside the neighbour anyway — the
// courtyard's four wings have met edge to edge on the same argument since they were written. The
// lap, meanwhile, overlapped each pair of **roof decks** by 0.04, and two decks are two horizontal
// faces at the same height pointing the same way, which is the real tie: a hairline down the roof
// of every terrace, at the one angle this camera looks from.

// The cornice. Deeper and heavier than the towers' 0.18 ledge because on a house this is the whole
// of the roofline: there is no plant room, no water tower and no setback above it. `CORNICE_BACK`
// is how far it reaches back onto the roof, which is what makes it a band rather than a lid — see
// where it is built.
const CORNICE_H = 0.34;
const CORNICE_OUT = 0.26;
const CORNICE_BACK = 0.45;
// The flat roof inside it. Thin enough that the cornice stands 0.16 proud of it, which is the
// reveal that says parapet.
const ROOF_H = 0.18;
// The party wall, carried through the front elevation as a shallow pier. 0.14 across is one pixel
// at play zoom and it is not there to be seen as a pilaster — it is there to break the front into
// bays, which a one-pixel vertical does and four levels of colour jitter does not.
const PIER_W = 0.14;
const PIER_OUT = 0.07;

/**
 * The tallest a terrace can stand, cornice included — 6.44.
 *
 * Exported so `tools/probe.mjs` can hold the `STOREYS` note to a number instead of to a sentence.
 * A chimney goes above it; the roofline does not.
 */
export const ROW_MAX_H = GARDEN_H + Math.max(...STOREYS) * ROW_FLOOR_H + CORNICE_H;

// --- The stoop -------------------------------------------------------------
//
// Five risers and a landing. The **tread** is the number that was tuned and the rise is whatever
// falls out of it: five steps up `GARDEN_H` is 0.30 a step either way, and what changes with the
// tread is the angle the flight cuts across the front garden. At the 0.34 an indoor stair would
// use that is 41° — which under a camera sitting at 33° reads as another piece of wall — and at
// 0.46 it is 33°, which reads as a stair. The cost is 1.84 units of front garden, out of a lot
// that has 10.3 of depth to give.
const STOOP_RISERS = 5;
const STOOP_TREAD = 0.46;
const STOOP_LANDING = 0.45;              // the top platform, against the door
const STOOP_REACH = STOOP_LANDING + (STOOP_RISERS - 1) * STOOP_TREAD;   // 2.29
// How wide the flight is, and the stone cheek wall either side of it. The cheeks are not trim. A
// step is 2.3 pixels of rise at play zoom, so a bare flight seen from above is a set of horizontal
// lines lying on the ground and reads as paving; two walls climbing beside it read as a stair from
// the first frame, and they are what carries the whole feature.
const STOOP_W = 1.15;
const CHEEK_W = 0.17;
const CHEEK_H = 0.52;                    // how far a cheek stands above the tread beside it
const CHEEK_LAP = 0.02;                  // how far it buries itself in the flight — see `stoop`
// How much bare areaway is left between the bottom step and the lot line, and it is **sized by the
// fare board rather than by taste**. It was 0.4 — enough that the stoop stays off the pavement,
// which is the line `tools/probe.mjs` measures a car's clearance to a wall from — and that put a
// stoop straight through the mark the board paints on the kerb corner.
//
// The arithmetic, all of it from modules this one has no business importing, so it is asserted in
// the probe instead of derived here ("a stoop stands clear of the kerb marks"). `cornerFor` puts a
// pin **0.5 inside** its block past the kerb; a fare's timer ring is `RING_R` = 3.5 across, so the
// samples `cornerSeen` tests reach `RING_R / 2` = 1.75 further in; and a lot line is `INSET` = 0.85
// off the block edge. So a mark reaches 1.4 past the lot line and anything standing in that strip
// is standing on it.
//
// Two things go wrong when something does, and only one of them is the obvious one. The mark is
// half behind a stoop, which is a courier pad you cannot see — that is the filter in
// `game/sightline.js` doing its job, and it would simply drop the corner. The other is that the
// filter **stops working**: it marches a height field that skips the first cell under the mark, on
// the stated grounds that a real occluder has units of mass ahead of it rather than one cell's
// worth. A stoop is 2.3 units deep and 1.6 tall, so it does not — the sightline clears the last
// step before the march starts looking — and the field then calls a buried mark visible, which is
// the one error that module exists to make impossible. Measured over 4 cities: 2 samples in 1008,
// and a corner kept on the board with 56% of its pad behind a staircase.
//
// 1.5 rather than 1.4 because the ring is not the only mark on a corner: the courier pad is 3.2
// across and the probe scores a corner over the whole of it.
const MARK_CLEAR = 1.5;
// What the house gives up at the front for the stoop to stand in.
const AREAWAY = STOOP_REACH + MARK_CLEAR;       // 3.79

// --- The openings ----------------------------------------------------------
//
// A house front is two bays: the door bay and the window bay. `OPENING_U` is where their centres
// sit as a fraction of the frontage either side of the middle and `OPENING_W` how wide they are —
// together they leave three equal piers, which is what a two-bay elevation actually is.
const OPENING_U = 0.225;
const OPENING_W = 0.354;
// The parlour floor's window is floor-to-ceiling and the storeys above it step down. A real
// brownstone shrinks its windows as it climbs, and it is the cheapest storey-telling there is.
const PARLOUR_WIN_H = 1.6;
const UPPER_WIN_H = [1.3, 1.15];
const DOOR_H = 1.75;
const GARDEN_WIN_H = 0.85;

// Where the residential stock stops. Height in this city is driven by a block's centrality, so a
// 7-to-10-unit terrace dropped in the middle of the map punches a residential hole through the one
// gradient the massing has. 0.45 costs almost nothing on top of the room test: the lots roomy
// enough to carry a terrace at all are overwhelmingly outer ones already (median centrality 0.06
// over 24 cities), so this trims 24 candidates out of 128 rather than being what decides where
// they go.
const MAX_CENTRALITY = 0.45;

/**
 * How often a lot that *could* carry a terrace actually does.
 *
 * A per-lot roll, unlike the courtyard block and the helipad next door — both of those are
 * "exactly one a city" and so have to be decided outside the loop. A terrace is not a landmark, it
 * is a *neighbourhood*, and the thing a rate has to avoid here is the opposite failure: at 1.0
 * every eligible block in the city is a terrace and the city stops having offices in it.
 *
 * Measured over 48 cities: 0.5 gives 1.25 rows and 4.9 houses a city, 0.7 gives 1.98 and 7.6, and
 * 0.85 gives 2.38 and 9.1. At 0.7 that is two blocks of the city, which is a neighbourhood you
 * drive through rather than a thing you notice once.
 *
 * **One city in six gets none, and that is allowed to stand**, which is the opposite call from the
 * helipad's — the difference is that nothing depends on a terrace existing. The pad was a coin
 * flip until a helicopter started landing on one, and a city without a pad then had no opening
 * vignette. Nothing flies to, spawns on or routes through a row house, so a seed whose eligible
 * blocks all came up towers is still a whole city.
 */
export const ROW_RATE = 0.7;

/**
 * Which way a terrace on this lot could face — `[0]`, `[1]`, `[0, 1]`, or empty for "it can't".
 *
 * A **list** rather than the first side that fits, and that is not tidiness. Both tests below pass
 * on an undivided block, which is the only kind of lot that ever qualifies, so a function that
 * returned the first hit would return 0 every single time: measured over nine cities before this
 * was a list, **every terrace in every one of them faced +X**. A city whose houses all face the
 * same way is a city with one street of them repeated, and the fix has to be a draw — which means
 * the choice cannot live here, because this is asked once to decide eligibility and again inside
 * `buildRowHomes`, and a draw taken twice is two different answers.
 *
 * **The camera is the filter, and it throws away half the map.** The view is a fixed diagonal down
 * +X+Z and never rotates (docs/rendering.md), so of a building's four elevations only the +X and
 * +Z ones are ever seen. Every other building in this city survives that — a tower is a mass and a
 * mass reads from any side — but a row house is nothing but its front. Built facing −X, the
 * stoops, the doors, the tall parlour windows and the entire reason the massing exists sit round
 * the back, and what the player gets is a long brick box. So a lot with no camera-facing street
 * frontage doesn't get a terrace; it gets towers, like it always did.
 *
 * The rest is room: the frontage has to hold `UNIT_MIN` houses and the depth has to hold the
 * areaway *plus* a house behind it. In practice both only ever pass on an **undivided block** —
 * measured over 24 cities, every lot that qualifies is 9.0 to 10.3 across, because `splitLot`
 * halves anything bigger. A terrace takes the whole block, which is what a terrace is.
 */
export function rowHomeFits(b, streetSides, centrality) {
  if (centrality > MAX_CENTRALITY) return [];
  const fits = [];
  for (const side of [0, 1]) {
    if (!streetSides.includes(side)) continue;
    // Side 0 faces +X, so its frontage runs along Z and its depth along X; side 1 is the other way.
    const face = side === 0 ? b.d : b.w;
    const depth = side === 0 ? b.w : b.d;
    if (face < UNIT_TARGET * UNIT_MIN) continue;
    if (depth < AREAWAY + MIN_HOUSE_DEPTH) continue;
    fits.push(side);
  }
  return fits;
}

/**
 * One house's front elevation, in face-local `u`. Returns where the door ended up.
 *
 * `hand` is +1 or −1 and says which bay the door is in. Doors are handed in **pairs** — houses 0
 * and 1 face each other, 2 and 3 face each other — so the stoops come together two at a time with
 * a gap between pairs, which is what a brownstone block looks like from the end of the street.
 * Handed the same way down the whole run they sit at an even pitch and the terrace reads as one
 * building with four doors in it.
 */
function frontOpenings(parts, unit, hand, side, body, peak) {
  const { uw, h, floors, cx, cz, w, d } = unit;
  const hw = w / 2;
  const hd = d / 2;
  const openW = Math.min(WIN_W, uw * OPENING_W);
  const doorU = hand * uw * OPENING_U;
  const winU = -doorU;
  const parlour = KERB_H + GARDEN_H;

  const glass = color('window');
  const sky = color('windowSky');
  const ceiling = wallCeiling(body, glass, sky);
  const rects = [];
  // A pane's gradient is sampled at its own head and sill and left flat across its width — the
  // same rule the punched grid follows, and for the same reason: the streak is a between-panes
  // effect, and taking it inside one quad shows that quad's diagonal.
  const pane = (u, y, pw, ph) => {
    const un = u / (side === 0 ? d : w) + 0.5;
    const yb = skyWeight(un, (y - ph / 2 - KERB_H) / h, side, peak, ceiling);
    const yt = skyWeight(un, (y + ph / 2 - KERB_H) / h, side, peak, ceiling);
    rects.push({ u, y, w: pw, h: ph, g: [yb, yb, yt, yt] });
  };

  // The garden level: one window, in the bay the stoop isn't standing in. The door down here is
  // the area door under the stair, and there is nothing to be gained from drawing a door the
  // stoop is covering.
  pane(winU, KERB_H + 0.62 + GARDEN_WIN_H / 2, openW * 0.85, GARDEN_WIN_H);
  // The parlour floor: the tall window beside the front door.
  pane(winU, parlour + 0.4 + PARLOUR_WIN_H / 2, openW, PARLOUR_WIN_H);
  // And the storeys above it, both bays, shrinking as they climb.
  for (let f = 1; f < floors; f++) {
    const winH = UPPER_WIN_H[Math.min(f, UPPER_WIN_H.length) - 1];
    const y = parlour + f * ROW_FLOOR_H + 0.55 + winH / 2;
    pane(winU, y, openW, winH);
    pane(doorU, y, openW, winH);
  }
  parts.push(facadeQuads(rects, side, cx, cz, hw, hd, glass, EPS, sky));

  // The door, its surround, and the stone lintel over it. Two stood-off layers, for the same
  // reason the towers' entrance has them: `door` and the glass beside it sit within a few points
  // of each other in value, and without a light frame the entrance is a dark patch on a dark wall
  // that nobody can find.
  parts.push(facadeQuads(
    [{ u: doorU, y: parlour + (DOOR_H + 0.2) / 2, w: openW + 0.26, h: DOOR_H + 0.2 }],
    side, cx, cz, hw, hd, color('awning'), EPS * 2,
  ));
  parts.push(facadeQuads(
    [{ u: doorU, y: parlour + DOOR_H / 2, w: openW, h: DOOR_H }],
    side, cx, cz, hw, hd, color('door'), EPS * 3,
  ));

  // The lintel is a box rather than a quad because it has to have a *soffit*: the shadow under a
  // projecting course is what says the wall has depth, and a quad flush against it says nothing.
  const [nx, nz] = SIDE_OUT[side];
  const [tx, tz] = SIDE_TAN[side];
  const reach = (side % 2 === 0 ? hw : hd) + 0.1;
  const along = openW + 0.44;
  parts.push(box(
    side % 2 === 0 ? 0.2 : along, 0.16, side % 2 === 0 ? along : 0.2,
    cx + nx * reach + tx * doorU, parlour + DOOR_H + 0.2, cz + nz * reach + tz * doorU,
    shade(body, 0.88),
  ));
  return doorU;
}

/**
 * The stair up to the front door, standing out in front of the house.
 *
 * A step is a **slab of its own tread's depth**, standing from the pavement up to its own nosing —
 * not a box run all the way back to the wall. Nesting them that way is the obvious build and it is
 * the coplanar tie from CLAUDE.md wearing a staircase: two nested boxes at the same width share
 * both their side planes over the whole depth of the smaller one, both facing the same way, and an
 * exact tie is handed to whichever the rasteriser rounds in front — which is a hard-edged
 * patchwork down the side of every stoop on a phone and nothing at all in a headless still.
 *
 * Disjoint slabs have no tie to resolve. Each one's side face occupies its own strip of depth and
 * meets its neighbour's edge to edge, which is a seam rather than a fight; the face where two
 * slabs meet is coincident and *oppositely* wound, so the back one is culled and the riser in
 * front of it is the only thing that draws.
 *
 * `faceX`/`faceZ` are the point on the front wall the flight climbs to — the door's own centre.
 */
function stoop(parts, side, faceX, faceZ, doorU, body, rng) {
  const [nx, nz] = SIDE_OUT[side];
  const [tx, tz] = SIDE_TAN[side];
  const acrossX = side % 2 === 0;         // a +X front puts the flight's width along Z
  // The footprint the whole flight occupies, cheeks included, handed back so the probe can measure
  // where a stoop actually stands rather than re-deriving it from the constants under test.
  const halfAcross = STOOP_W / 2 + CHEEK_W - CHEEK_LAP;
  const footprint = new THREE.Box2(
    new THREE.Vector2(
      Math.min(faceX, faceX + nx * STOOP_REACH) - (acrossX ? 0 : halfAcross) + tx * doorU,
      Math.min(faceZ, faceZ + nz * STOOP_REACH) - (acrossX ? halfAcross : 0) + tz * doorU,
    ),
    new THREE.Vector2(
      Math.max(faceX, faceX + nx * STOOP_REACH) + (acrossX ? 0 : halfAcross) + tx * doorU,
      Math.max(faceZ, faceZ + nz * STOOP_REACH) + (acrossX ? halfAcross : 0) + tz * doorU,
    ),
  );
  const rise = GARDEN_H / STOOP_RISERS;
  // Stone, and the same stone as the house: a brownstone stoop is the building's own facing
  // carried down to the pavement. A stop lighter than the cheeks beside it, so the flight doesn't
  // merge into one dark mass at play zoom.
  const stone = jitterColor(shade(body, 0.92), rng, { l: 0.02 });
  const cheekCol = shade(body, 0.8);

  for (let n = 0; n < STOOP_RISERS; n++) {
    const top = (n + 1) * rise;
    // This step's nosing and its back edge, both as distances off the wall. The top step is the
    // landing: it runs back to the wall itself and is `STOOP_LANDING` deep rather than a tread.
    const nose = STOOP_LANDING + (STOOP_RISERS - 1 - n) * STOOP_TREAD;
    const back = n === STOOP_RISERS - 1 ? 0 : nose - STOOP_TREAD;
    const run = nose - back;
    const mid = (nose + back) / 2;
    // The slab stands on the pavement, so its underside sits at `KERB_H` — 0.01 *below* the block
    // platform's own top and therefore buried inside it. A down-facing surface never draws, which
    // is the one kind of coplanar surface this city allows (see the pavement note in CLAUDE.md).
    parts.push(box(
      acrossX ? run : STOOP_W, top, acrossX ? STOOP_W : run,
      faceX + nx * mid + tx * doorU, KERB_H, faceZ + nz * mid + tz * doorU,
      stone,
    ));
    // The cheeks, one either side, standing `CHEEK_H` over the tread they flank. Lapped 0.02 into
    // the flight rather than set exactly against it: the two planes would otherwise coincide with
    // the step's own side face, and "these two face opposite ways so one is always culled" is a
    // claim CLAUDE.md is explicit about not writing down. A sixth of a pixel buys not having to.
    for (const s of [-1, 1]) {
      const cu = doorU + s * (STOOP_W + CHEEK_W - CHEEK_LAP) / 2;
      parts.push(box(
        acrossX ? run : CHEEK_W, top + CHEEK_H, acrossX ? CHEEK_W : run,
        faceX + nx * mid + tx * cu, KERB_H, faceZ + nz * mid + tz * cu,
        cheekCol,
      ));
    }
  }
  return footprint;
}

/**
 * A terrace across one lot's camera-facing frontage.
 *
 * `b` is the lot's buildable rectangle, already inset off the lot lines. Returns what the probe
 * measures the row by — where its front wall is, how far the stoops reach off it, and one entry
 * per house — or `null` if this lot was never eligible.
 */
export function buildRowHomes(b, streetSides, centrality, rng, parts) {
  const fits = rowHomeFits(b, streetSides, centrality);
  if (!fits.length) return null;
  // The one draw the orientation gets. See `rowHomeFits` for why it is taken here.
  const side = fits.length > 1 ? rng.pick(fits) : fits[0];

  const alongX = side === 1;               // a +Z front runs the row of houses along X
  const face = alongX ? b.w : b.d;
  const depth = alongX ? b.d : b.w;

  const houses = Math.max(UNIT_MIN, Math.min(UNIT_MAX, Math.round(face / UNIT_TARGET)));
  const uw = face / houses;
  const houseDepth = depth - AREAWAY;
  const floors = rng.pick(STOREYS);
  const bodyH = GARDEN_H + floors * ROW_FLOOR_H;

  // The row's own envelope. `brownstone` stays out of `BUILDING_COLORS` for the same reason the
  // depot's does: a terrace is not one of the shapes the tower generator draws, and letting the
  // family turn up in the roll there would put a curtain wall on a row house.
  const family = color('brownstone');

  // Both camera-facing sides are the +ve end of their own axis, so the front wall is always the
  // lot's high coordinate less the areaway, and the houses run back from it toward the low one.
  const frontCoord = (alongX ? b.z1 : b.x1) - AREAWAY;
  const backCoord = alongX ? b.z0 : b.x0;
  const midCoord = (frontCoord + backCoord) / 2;

  // Sampled once for the whole terrace rather than per house, so the streak sweeps across the run
  // the way it sweeps across a setback tower's tiers.
  const peak = streakPeak(b.cx, b.cz);
  const units = [];

  for (let i = 0; i < houses; i++) {
    const alongLo = (alongX ? b.x0 : b.z0) + i * uw;
    const alongMid = alongLo + uw / 2;
    const cx = alongX ? alongMid : midCoord;
    const cz = alongX ? midCoord : alongMid;
    const w = alongX ? uw : houseDepth;
    const d = alongX ? houseDepth : uw;

    // Jittered per house, and this is the whole of what varies between them — the heights are
    // shared, because a terrace is built in one go and a run of independently-sized houses reads
    // as four buildings that happen to be touching rather than as one row.
    const body = jitterColor(family, rng, { h: 0.014, l: 0.05 });
    const unit = { uw, h: bodyH, floors, cx, cz, w, d };
    units.push(unit);

    parts.push(box(w, bodyH, d, cx, KERB_H, cz, body));
    const doorU = frontOpenings(parts, unit, i % 2 === 0 ? 1 : -1, side, body, peak);
    unit.doorU = doorU;

    // The back, and on the two end houses the side elevation. Everything in between is a party
    // wall: glazing one would be two window grids fighting over the same depth inside a solid,
    // which is what the courtyard's wings did at all four corners before they declared their
    // faces. The rear windows come off the same floor lines the front does — `GARDEN_H` is the
    // first-floor height everywhere on this building.
    const endLo = i === 0 ? houseDepth : 0;
    const endHi = i === houses - 1 ? houseDepth : 0;
    const faces = alongX
      ? [endHi, 0, endLo, uw]              // +X end, the front, −X end, the back
      : [0, endHi, uw, endLo];             // the front, +Z end, the back, −Z end
    punchedWindows(parts, cx, KERB_H, cz, w, d, bodyH, GARDEN_H, color('window'), peak, body,
      faces, ROW_FLOOR_H);

    // The roof, and then the cornice standing round the edge of it.
    //
    // **The cornice has to be a band, not a lid.** The first build ran it the full depth of the
    // house — one box, the whole roof, cut from the body colour darkened — and the terrace came out
    // of the first screenshot as a plain brown box with windows in it. From 33° above, the roof is
    // most of a low building's silhouette: a run of houses roofed in their own brickwork has no
    // line where the wall stops, and the cornice, the one piece of this whose entire job is to draw
    // that line, was the thing painting it out. So the deck is `roof` — the grey every other flat
    // roof in the city wears — and the cornice is a 0.45 band around the edges that are seen, with
    // the deck sitting 0.16 below its top.
    const deckY = KERB_H + bodyH;
    parts.push(box(w, ROOF_H, d, cx, deckY, cz, color('roof')));

    // The front band runs the length of the terrace as one line, turning the corner only at the two
    // ends of the run. Neighbours meet edge to edge rather than overlapping: two bands at the same
    // height crossing each other is the coplanar tie the party walls are lapped to avoid, one
    // storey up and in the one place the eye is actually looking.
    const capLo = i === 0 ? CORNICE_OUT : 0;
    const capHi = i === houses - 1 ? CORNICE_OUT : 0;
    const bandDepth = CORNICE_BACK + CORNICE_OUT;
    const bandOff = (CORNICE_OUT - CORNICE_BACK) / 2;      // toward the street, off the front wall
    const corniceCol = shade(body, 0.72);
    parts.push(box(
      alongX ? uw + capLo + capHi : bandDepth,
      CORNICE_H,
      alongX ? bandDepth : uw + capLo + capHi,
      alongX ? cx + (capHi - capLo) / 2 : frontCoord + bandOff, deckY,
      alongX ? frontCoord + bandOff : cz + (capHi - capLo) / 2,
      corniceCol,
    ));

    // And the return along an end of the run, on the two houses that have one. It stops at the
    // front band's inner face rather than meeting it in the corner — overlapping there would put
    // two identical top faces on the same plane, which is the tie above by another route.
    if (i === 0 || i === houses - 1) {
      const outward = i === 0 ? -1 : 1;
      const edge = alongLo + (i === 0 ? 0 : uw);
      const endLen = houseDepth - CORNICE_BACK;
      const endMid = (backCoord + frontCoord - CORNICE_BACK) / 2;
      parts.push(box(
        alongX ? bandDepth : endLen,
        CORNICE_H,
        alongX ? endLen : bandDepth,
        alongX ? edge + outward * (CORNICE_OUT - CORNICE_BACK) / 2 : endMid, deckY,
        alongX ? endMid : edge + outward * (CORNICE_OUT - CORNICE_BACK) / 2,
        corniceCol,
      ));
    }

    // A chimney on the party wall, back from the roofline where a real flue comes up. One per
    // house, standing on the line two houses share, so the run reads as a terrace from above as
    // well as from the street — and the last house's comes back inside its own wall rather than
    // hanging off the end of the row.
    const stackAlong = alongLo + (i === houses - 1 ? uw - 0.35 : uw);
    const stackAcross = backCoord + houseDepth * 0.28;
    const stackH = rng.range(0.7, 1.05);
    const sx = alongX ? stackAlong : stackAcross;
    const sz = alongX ? stackAcross : stackAlong;
    parts.push(box(0.46, stackH, 0.46, sx, deckY + ROOF_H, sz, shade(body, 0.8)));
    parts.push(box(0.54, 0.1, 0.54, sx, deckY + ROOF_H + stackH, sz, color('rooftopIron')));

    // The party wall, carried through the front as a shallow pier. One at each joint and one at
    // each end of the run, so a terrace is four houses rather than one wall with four doors —
    // which is what the first screenshot showed, the colour jitter between neighbours being three
    // or four levels of brick and invisible at any distance. A vertical is not: the piers give the
    // run the grain that says *houses*, and they cost one box each.
    for (const end of (i === houses - 1 ? [0, 1] : [0])) {
      const pierAt = alongLo + end * uw;
      const px = alongX ? pierAt : frontCoord + PIER_OUT / 2;
      const pz = alongX ? frontCoord + PIER_OUT / 2 : pierAt;
      parts.push(box(
        alongX ? PIER_W : PIER_OUT, bodyH, alongX ? PIER_OUT : PIER_W,
        px, KERB_H, pz, shade(body, 0.87),
      ));
    }

    // And the stair, built last so it stands against a wall that already exists.
    unit.stoop = stoop(parts, side, alongX ? cx : frontCoord, alongX ? frontCoord : cz, doorU,
      body, rng);
  }

  return {
    side, alongX, houses, uw, floors, frontCoord, units,
    reach: STOOP_REACH, areaway: AREAWAY, height: bodyH + CORNICE_H, parlour: KERB_H + GARDEN_H,
  };
}
