import * as THREE from 'three';
import { createParcelPin, createParcelDropPin } from '../geometry/marker.js';
import { createParcel, PARCEL_DECK_SCALE } from '../geometry/parcel.js';
import { KERB_H } from '../city/ground.js';
import { PARCEL_COLOR } from './urgency.js';
import { allIntersections, findRoute } from './route.js';
import { nextIntersection } from '../city/grid.js';
import {
  ARRIVE_RADIUS, blockDistance, cornerFor, intersectionCentre, onSameBlock, priceFor,
} from './fares.js';
import * as difficulty from './difficulty.js';

// The package courier: a second cargo slot on a taxi that has one seat.
//
// A brown parcel sits on a kerb corner on a cyan rounded-square pad. Drive near it and the taxi
// picks it up — while carrying a passenger, if it is carrying one — and the pad it is going to
// lights up somewhere else on the map. Drive near *that* and the package pays out in cash.
//
// ## Nothing here is tapped. You steer into it.
//
// **This is the whole feature.** A package cannot be selected: it has no hit box, it is not in the
// picker's target list, and there is no way to dispatch the taxi at one. The only way to collect or
// deliver a package is to make the taxi's route **pass through its junction** — which, since the
// route is planned to whatever fare the player is actually working, means **dragging the route band
// sideways** until it bends through the pad (see game/pathdrag.js).
//
// That is why the layer is worth having. Until now the band was the one thing on screen the player
// could reshape and had no reason to reshape unless traffic went solid ahead of them: `pathdrag`
// answered "which way", and the answer almost never mattered. A package puts something *on* a road
// the route does not currently take, so the question becomes worth asking on an empty street. The
// route-drag mechanic gets a reason to exist, and it costs the player exactly the seconds the detour
// costs — spent out of the clock of whichever rider is in the back seat.
//
// It also means there is no `directed` flag here and no arbitration with the fare system. `fares.js`
// needs that rule because a taxi cruising on random turns would otherwise wander into a pin and
// collect a fare nobody asked for — measured at 11 of 40 seeds. A package has none of that exposure:
// it has no clock to lose, missing one costs nothing, and collecting one by luck is a small gift
// rather than a stolen decision. **A package that happens to sit on the route you were already
// driving is free money, and that is intended.** Spawn placement below is what keeps that from being
// the common case.
//
// ## A package has no clock, and so has no diamond
//
// The board's vocabulary is: shape says what a thing is, hue says whose clock is paying for it. A
// plumbob **means** a countdown. A package having no deadline is precisely why it must not have one
// — and it keeps this layer from adding a second thing to read to a board that can already carry
// four fares. The cyan says "courier job" and nothing else, which for a package is the only honest
// thing a colour can say.
//
// So nothing in this module can end a run. A parcel sits on its corner until somebody drives through
// it. It is pure upside by construction, the same way a VIP is, which is what lets it stay optional
// without ever being a trap.
//
// ## Why this is its own module
//
// `fares.js` is built end to end around one seat, a run-ending budgeted clock, the difficulty board
// size, urgency levels, VIP streaks and exit animations. A package needs none of it. What *is*
// shared is shared rather than copied: the marker factory, `priceFor`, `blockDistance`, `cornerFor`,
// `onSameBlock` and `ARRIVE_RADIUS` all come from the fare system rather than being re-derived here.

/**
 * How many packages can be on the board at once.
 *
 * Two, so there is sometimes a choice of which detour to take and sometimes only one on offer — and
 * never so many that the cyan starts competing with the fare board for the eye. The taxi carries one
 * at a time regardless, which is what keeps a pickup wired to exactly one drop-off.
 */
export const MAX_PARCELS = 2;

/**
 * Deliveries before the first package appears.
 *
 * Mirrors `VIP_MIN_DELIVERED` in `fares.js`, for a sharper version of the same reason. The second
 * tutorial beat *is* "tap that rider" — a box on a corner during it is a second thing competing for
 * the one gesture being taught, and worse here than for a VIP, because the box teaches the opposite
 * lesson: it is the one thing on the board that tapping does nothing to.
 */
export const PARCEL_MIN_DELIVERED = 1;

/**
 * Seconds between package spawns.
 *
 * Longer than any fare's `spawnGap`, and deliberately off the difficulty curve: the courier layer is
 * bonus income, not pressure, so it must not thicken as the ramp does. Staggered rather than spawned
 * together for the reason the fare board staggers — two arriving at once is a moment followed by a
 * lull, where two arriving apart is a standing offer.
 */
export const PARCEL_SPAWN_GAP = 12;

/**
 * Multiplier on a package's distance price. **This is the knob.**
 *
 * A package pays what a rider going the same distance pays (`priceFor`, times the shift multiplier),
 * so at 1 the courier layer is a real second income rather than a rounding error. Named rather than
 * inlined because it is the one number to turn if the soak shows bonus cash flattening the economy —
 * and if it moves, write the measured survival curve down beside it.
 */
export const PARCEL_PAY_FACTOR = 1;

/**
 * Fewest blocks between a package's two ends.
 *
 * A package whose ends are adjacent is worth almost nothing and reads as an error — the player
 * crosses both pads in one junction without a decision anywhere in it. Three blocks is the shortest
 * hop that is visibly a *delivery*, and `priceFor` puts it at a payout worth a detour.
 */
const MIN_TRIP_BLOCKS = 3;

/**
 * How long the box takes to cross between the kerb and the taxi, either way.
 *
 * A shade under the fare crystal's 0.65s (game/faremarker.js). That one is tuned against the rider's
 * 0.9s run-and-jump so the clock lands a beat before its owner does; a box has nothing to wait for,
 * and the two flights should not look like the same object anyway.
 */
const FLIGHT_TIME = 0.55;

/** Lift over the middle of the flight, so the box arcs across rather than sliding along the road. */
const FLIGHT_ARC = 1.4;

/**
 * Height the flying box's base rides at — the pavement, matching where the kerb box stands.
 *
 * `place` below puts a marker's group at 0.12 and its postGroup at KERB_H, so a box standing on a pad
 * has its base there. The flight has to leave and land at that same height or the hand-off reads as
 * the box hopping onto a different plane.
 */
export const PARCEL_PAD_LIFT = KERB_H + 0.12;

/**
 * What the box shrinks to as it goes into the taxi, rather than to nothing.
 *
 * Exactly the size of the parcel that appears on the rear deck, imported rather than restated, so the
 * flight ends *on* the object it becomes instead of near it — and so resizing the box cannot leave the
 * two disagreeing.
 */
const FLIGHT_MIN_SCALE = PARCEL_DECK_SCALE;

const NO_EVENTS = Object.freeze([]);

/**
 * The meshes one package needs, built once per slot and reused. A parcel is cheap bookkeeping; a
 * box, two pads and a flight copy are not something to rebuild every twenty seconds.
 */
function createSlot(scene, index) {
  // `pickable: null` throughout — a package is never raycast, so tagging one would be a trap for
  // whoever next picks against the scene rather than against an explicit target list.
  const pickup = createParcelPin(() => createParcel({ pickable: null }));
  const dropoff = createParcelDropPin();

  // The box that crosses between the kerb and the taxi. A **second** parcel rather than the kerb one
  // reparented: that one lives inside the marker's `postGroup`, two transforms deep on a corner it
  // must not leave, and this has to own its world position for the whole flight — the same split
  // game/faremarker.js makes for the crystal, and for the same reason.
  //
  // Two nested groups, also the crystal's arrangement: the outer one carries the flight (position,
  // and the scale that takes the box down into the taxi) and the inner box goes on spinning and
  // bobbing in local space, so the two concerns never fight over one transform.
  const flightBox = createParcel({ pickable: null });
  const flight = new THREE.Group();
  flight.add(flightBox.group);
  flight.visible = false;
  scene.add(flight);

  pickup.group.visible = false;
  dropoff.group.visible = false;
  scene.add(pickup.group);
  scene.add(dropoff.group);

  return { index, pickup, dropoff, flight, flightBox };
}

export function createParcelSystem(rng, scene) {
  const state = {
    /** Live packages: on a corner (`waiting`) or aboard the taxi (`carried`). */
    parcels: [],
    elapsed: 0,
    delivered: 0,
    /** Cash paid out by this layer alone, so the soak can separate it from fare income. */
    earned: 0,
    lastSpawnAt: -Infinity,
    over: false,
  };

  const slots = Array.from({ length: MAX_PARCELS }, (_, index) => createSlot(scene, index));

  // Boxes in the air. Kept out of `state.parcels` for the reason `fares.js` keeps its exit animations
  // out of `state.fares`: the puzzle is over the moment a package resolves and the animation is only
  // skin, so a flight must not gate the next spawn. Each entry pins the slot it borrows until it
  // lands, so a new package cannot land on a slot whose last box is still crossing the road.
  //
  //   kind 'in'  — kerb → taxi, shrinking and fading out as it goes
  //   kind 'out' — taxi → pad, growing and fading in, then the pad pulls back into its own centre
  const flights = [];

  // Slot indices whose inbound box landed this frame, drained by `update` into `'loaded'` events.
  // Collected rather than emitted directly because `updateFlights` runs inside a frame that is
  // already building an event list, and the taxi's own reaction — the deck parcel appearing, the
  // flourish — belongs to the moment the box *arrives*, not to the moment the player earned it.
  const landed = [];

  /** The package aboard the taxi, if any. One at a time. */
  const carrying = () => state.parcels.find((p) => p.stage === 'carried') ?? null;

  /** Every intersection a live package has spoken for, either end. */
  const occupiedSpots = () => state.parcels.flatMap((p) => [p.pickup, p.dropoff]);

  // Same placement `fares.js` uses: the group sits at the junction centre and the postGroup is
  // pushed out to the pavement corner, so the pad and whatever stands on it share one corner.
  const place = (pin, i, j) => {
    const centre = intersectionCentre(i, j);
    const corner = cornerFor(i, j);
    pin.group.position.set(centre.x, 0.12, centre.z);
    pin.postGroup.position.set(corner.x - centre.x, KERB_H, corner.z - centre.z);
    pin.group.visible = true;
  };

  const distanceTo = (spot, taxiCar) => {
    const centre = intersectionCentre(spot.i, spot.j);
    return Math.hypot(taxiCar.x - centre.x, taxiCar.z - centre.z);
  };

  /**
   * Every junction the taxi's current plan already takes it through.
   *
   * Packages are placed *off* this list, which is what makes the drag the mechanic rather than a
   * garnish: a box sitting on a road the taxi was going to drive anyway is collected for free and
   * asks the player nothing. It is only a spawn-time bias — the next fare re-plans the whole route,
   * and a package can perfectly well end up on the new one. That is the "free money" case the module
   * comment allows for, and it is the exception rather than the rule this way round.
   */
  function routeJunctions(taxiCar) {
    const out = [{ i: taxiCar.i, j: taxiCar.j }];
    let { i, j } = taxiCar;
    for (const d of taxiCar.route ?? []) {
      const next = nextIntersection(d, i, j);
      if (!next) break;
      ({ i, j } = next);
      out.push({ i, j });
    }
    return out;
  }

  /**
   * Pick an intersection a package may use.
   *
   * `taken` is every spot already spoken for — by a live fare as well as by the other package — so a
   * box never lands on a corner a rider is waving from or inside a disc that is already there. Two
   * markers on one corner is two jobs in one place, and at play zoom the player cannot tell there
   * are two.
   *
   * `avoid` is the taxi's current route (above). It is a *preference*, not a filter: if excluding it
   * leaves nothing, the draw falls back to the unrestricted set rather than failing to spawn. A city
   * with an unlucky route is still a city that should offer a package.
   */
  function pickIntersection(taxiCar, taken, { avoid = [], minBlocksFrom = null } = {}) {
    const legal = allIntersections().filter((spot) => {
      // Not on top of the car: a box materialising where the taxi already is asks nothing.
      if (spot.i === taxiCar.i && spot.j === taxiCar.j) return false;
      if (taken.some((other) => spot.i === other.i && spot.j === other.j)) return false;
      // `onSameBlock`, not `(i, j)` equality: near the map's origin edge two intersections a whole
      // block apart still park their corner pins on the same slab — see fares.js.
      if (taken.some((other) => onSameBlock(spot, other))) return false;
      if (minBlocksFrom && blockDistance(spot, minBlocksFrom) < MIN_TRIP_BLOCKS) return false;
      return true;
    });
    if (!legal.length) return null;
    const offRoute = legal.filter(
      (spot) => !avoid.some((other) => spot.i === other.i && spot.j === other.j),
    );
    return rng.pick(offRoute.length ? offRoute : legal);
  }

  /**
   * Put a package on the board. Returns it, or null if there was no free slot, no legal pair of
   * corners, or no drivable route between them.
   *
   * `fareSpots` is `fares.occupiedSpots()` — passed in rather than imported, so this module holds no
   * reference to the fare system.
   */
  function spawn(taxiCar, fareSpots) {
    const slot = slots.find((s) => !state.parcels.some((p) => p.slot === s)
      && !flights.some((f) => f.slot === s));
    if (!slot) return null;

    const taken = [...fareSpots, ...occupiedSpots()];
    const avoid = routeJunctions(taxiCar);
    const pickup = pickIntersection(taxiCar, taken, { avoid });
    if (!pickup) return null;
    const dropoff = pickIntersection(taxiCar, [...taken, pickup], {
      avoid, minBlocksFrom: pickup,
    });
    if (!dropoff) return null;

    // A package the taxi cannot drive between is a detour that can never be completed. `main.js`
    // already rerolls any city seed where the router fails a fare pair, so this never fires in a
    // shipped city — but it is checked rather than assumed, because the failure is invisible: the
    // pad simply sits there for the rest of the run.
    if (!findRoute({ i: pickup.i, j: pickup.j, d: taxiCar.d }, dropoff)) return null;

    const parcel = {
      slot,
      stage: 'waiting',
      pickup,
      dropoff,
      // What resolving this package next needs the taxi to reach. Moves to the drop-off when the box
      // is collected, the same hand-off a fare's `target` makes at pickup.
      target: pickup,
      blocks: blockDistance(pickup, dropoff),
      // Priced at spawn for the reason every price here is: it is a fact about the trip, settled the
      // moment both ends are known. A rider's rate for a rider's distance, times the shift the
      // package appeared in — so a courier job found during Rush Hour is worth Rush Hour money
      // whenever it happens to get delivered.
      value: 0,
    };
    parcel.value = Math.round(
      priceFor(pickup, dropoff) * difficulty.payoutMultiplier(state.delivered) * PARCEL_PAY_FACTOR,
    );
    state.parcels.push(parcel);

    place(slot.pickup, pickup.i, pickup.j);
    slot.pickup.standing?.rest?.();
    // Grows out of its own centre rather than appearing at full size — see targetring.js.
    slot.pickup.ring?.appear();
    // The pad at the far end stays hidden until the box is aboard. Both ends lit from spawn would put
    // four cyan squares on a full board with nothing to say which belongs to which — the same clutter
    // a preview pin on the far kerb was taken back off the fare board for.
    slot.dropoff.ring?.hideNow();
    slot.dropoff.group.visible = false;

    return parcel;
  }

  /** Take a package off the board and hide its meshes at once, with no animation. */
  function clear(parcel) {
    parcel.slot.pickup.ring?.hideNow();
    parcel.slot.dropoff.ring?.hideNow();
    parcel.slot.pickup.group.visible = false;
    parcel.slot.dropoff.group.visible = false;
    const at = state.parcels.indexOf(parcel);
    if (at !== -1) state.parcels.splice(at, 1);
  }

  /**
   * Launch the box between the kerb and the taxi.
   *
   * `from` and `to` are world XZ. A null `to` means "wherever the taxi is on the frame this is being
   * drawn", read per frame — the car does not stop for this, so an 'in' flight has to catch a moving
   * target the way the fare crystal's does.
   */
  function launch(slot, kind, from, to) {
    slot.flightBox.rest();
    slot.flight.visible = true;
    slot.flight.position.set(from.x, PARCEL_PAD_LIFT, from.z);
    slot.flight.scale.setScalar(kind === 'in' ? 1 : FLIGHT_MIN_SCALE);
    flights.push({ slot, kind, from: { ...from }, to: to ? { ...to } : null, at: null });
  }

  /**
   * Collected. The box leaves the corner for the taxi and the pad it is going to grows out of the
   * road — the ground-level version of the hand-off a fare's crystal makes in the air.
   *
   * The kerb box is hidden and a flight copy takes over from the same spot, so what the player sees is
   * one box leaving rather than one disappearing and another appearing.
   */
  function beginCarry(parcel) {
    parcel.stage = 'carried';
    parcel.target = parcel.dropoff;
    parcel.slot.pickup.standing?.rest?.();
    parcel.slot.pickup.group.visible = false;
    parcel.slot.pickup.ring?.hideNow();
    // Null destination: `updateFlights` re-reads the taxi every frame, because the car does not stop
    // for this and the box has to catch it.
    launch(parcel.slot, 'in', cornerFor(parcel.pickup.i, parcel.pickup.j), null);
    place(parcel.slot.dropoff, parcel.dropoff.i, parcel.dropoff.j);
    parcel.slot.dropoff.ring?.appear();
  }

  /**
   * Delivered. The box comes back out of the taxi, grows into the pad, and the pad then pulls back
   * into its own centre under it.
   *
   * The origin is the taxi's position on *this* frame and stays fixed for the rest of the flight: the
   * box was set down here, and the car drives on without it.
   */
  function beginDrop(parcel, taxiCar) {
    const pad = cornerFor(parcel.dropoff.i, parcel.dropoff.j);
    launch(parcel.slot, 'out', { x: taxiCar.x, z: taxiCar.z }, pad);
    const at = state.parcels.indexOf(parcel);
    if (at !== -1) state.parcels.splice(at, 1);
  }

  /** Advance every box in the air, landing and tidying the ones that have arrived. */
  function updateFlights(elapsed, taxiCar) {
    for (let n = flights.length - 1; n >= 0; n--) {
      const f = flights[n];
      // Stamped on the first frame it is drawn rather than at the call site, the deferral
      // faremarker.js makes: every animation here is a function of sim time, so a frozen shot renders
      // the same frame whatever order the calls came in.
      if (f.at === null) f.at = elapsed;

      const t = Math.min(1, (elapsed - f.at) / FLIGHT_TIME);
      const eased = 1 - (1 - t) ** 3;
      const to = f.to ?? { x: taxiCar.x, z: taxiCar.z };
      f.slot.flight.position.set(
        f.from.x + (to.x - f.from.x) * eased,
        PARCEL_PAD_LIFT + Math.sin(eased * Math.PI) * FLIGHT_ARC,
        f.from.z + (to.z - f.from.z) * eased,
      );
      // Scale and alpha run *with* the travel rather than on their own curve, so the box reads as
      // going into the car rather than as fading while it happens to move.
      const shrink = f.kind === 'in' ? 1 - eased : eased;
      f.slot.flight.scale.setScalar(FLIGHT_MIN_SCALE + (1 - FLIGHT_MIN_SCALE) * shrink);
      f.slot.flightBox.setOpacity(Math.max(0, Math.min(1, shrink)));
      f.slot.flightBox.idle(elapsed);

      if (t < 1) continue;

      f.slot.flight.visible = false;
      f.slot.flightBox.rest();
      flights.splice(n, 1);
      if (f.kind === 'in') {
        landed.push(f.slot.index);
      } else {
        // The pad has nothing left to mark. It pulls back into its own centre rather than blinking
        // out, and `update` keeps ticking it below until it has.
        f.slot.dropoff.ring?.vanish();
      }
    }
  }

  /**
   * Advances the board and resolves arrivals. Returns the events that happened this frame —
   * `{type, parcel}`, type one of `'spawned' | 'pickup' | 'loaded' | 'delivered'` — rather than firing
   * callbacks, so this module holds no reference to the taxi mesh, the HUD or the fare system.
   * `main.js` translates them.
   *
   * `pickup` and `loaded` are deliberately two events a flight apart. `pickup` is the moment the
   * player earned the box; `loaded` is the moment it actually reaches the car, which is when the taxi
   * gets to react to it. Splitting them is what lets the box visibly travel instead of teleporting
   * into a deck that was already carrying it. `delivered` pays out at once — the money is earned on
   * arrival, and making the player wait out an animation for it would read as lag.
   *
   * `fareSpots` is `fares.occupiedSpots()`, `delivered` is `fares.state.delivered`, `over` is
   * `fares.state.gameOver`. Passed in per frame rather than wired up, which is what keeps the
   * dependency one-way.
   */
  function update(dt, taxiCar, { fareSpots = [], delivered = 0, over = false } = {}) {
    // Hide everything on the transition into game-over and stay quiet after it. One seam, inside the
    // module, rather than a call at each of the three places a run can end (a fare's clock, a
    // collision, a police bust) — a cyan pad left glowing on the blackout is the failure mode, and
    // `fares.crash` is reached from more places than are easy to keep in step.
    if (over) {
      if (!state.over) {
        state.over = true;
        for (const parcel of [...state.parcels]) clear(parcel);
        // A box frozen mid-air over the blackout is the same failure as a pad left glowing under it.
        for (const f of flights) { f.slot.flight.visible = false; f.slot.flightBox.rest(); }
        flights.length = 0;
        landed.length = 0;
        for (const slot of slots) {
          slot.pickup.ring?.hideNow();
          slot.dropoff.ring?.hideNow();
          slot.pickup.group.visible = false;
          slot.dropoff.group.visible = false;
        }
      }
      return NO_EVENTS;
    }

    let events = null;
    const emit = (type, parcel) => { (events ??= []).push({ type, parcel }); };

    // Snapshot before spawning: resolving an arrival splices out from under the loop, and a package
    // spawned *this* frame must not also be ticked in it.
    const live = [...state.parcels];

    if (delivered >= PARCEL_MIN_DELIVERED
      && state.parcels.length < MAX_PARCELS
      && state.elapsed - state.lastSpawnAt >= PARCEL_SPAWN_GAP) {
      const spawned = spawn(taxiCar, fareSpots);
      if (spawned) {
        state.lastSpawnAt = state.elapsed;
        emit('spawned', spawned);
      }
    }

    state.elapsed += dt;

    for (const parcel of live) {
      // Spin and bob the waiting box. Off sim time, never an accumulated dt, so a frozen shot
      // renders the same frame every time.
      if (parcel.stage === 'waiting') parcel.slot.pickup.standing?.idle?.(state.elapsed);

      if (distanceTo(parcel.target, taxiCar) >= ARRIVE_RADIUS) continue;

      if (parcel.stage === 'waiting') {
        // One cargo slot. A second box the taxi drives past while already loaded is simply left
        // where it is — there is nowhere to put it, and silently swapping the load would throw away
        // a delivery the player had already driven a detour for. A box still in the air counts as
        // loaded: it has been collected, it just has not arrived.
        if (carrying() || flights.some((f) => f.kind === 'in')) continue;
        beginCarry(parcel);
        emit('pickup', parcel);
      } else {
        state.delivered += 1;
        state.earned += parcel.value;
        beginDrop(parcel, taxiCar);
        emit('delivered', parcel);
      }
    }

    // Boxes in the air, and then every pad's own arrival/exit animation. The pads are ticked across
    // *all* slots rather than only for live packages: an outbound flight outlives the package that
    // paid for it, and the pad it is landing on still has an exit to play.
    updateFlights(state.elapsed, taxiCar);
    // No payload: all `main.js` needs to know is that a box reached the car. Which one it was stopped
    // mattering the moment it was collected.
    for (let n = 0; n < landed.length; n++) emit('loaded', null);
    landed.length = 0;

    for (const slot of slots) {
      for (const pin of [slot.pickup, slot.dropoff]) {
        if (!pin.group.visible) continue;
        pin.ring?.update(state.elapsed);
        // The ring owns its own visibility through the exit animation; once it has finished, the
        // marker group around it is an empty transform still being traversed every frame.
        if (pin.ring && !pin.ring.group.visible && !pin.ring.isLeaving()) pin.group.visible = false;
      }
    }

    return events ?? NO_EVENTS;
  }

  return {
    state,
    update,
    carrying,
    occupiedSpots,
    /** Land every pad's arrival animation at once — shot mode. See `fares.settleMarkers`. */
    settleMarkers: () => {
      for (const slot of slots) {
        slot.pickup.ring?.settle();
        slot.dropoff.ring?.settle();
      }
    },
    /**
     * The one colour a courier job speaks in, wherever it is speaking. A constant, unlike a fare's:
     * there is no clock for it to report.
     */
    colorOf: () => PARCEL_COLOR,
    slots,
  };
}
