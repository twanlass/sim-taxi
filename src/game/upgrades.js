/**
 * The depot's upgrades — what a visit to the garage can buy besides a repair.
 *
 * **A prototype**, and shaped so its numbers are the thing to argue about rather than its wiring:
 * three lines, three levels each, a price per level, and one function per line that says what the
 * taxi gets at the level it is on. Nothing here touches the taxi, the tank or the DOM — main.js
 * reads `maxHp()`, `engine()` and `tankSeconds()` and hands them to the sim, the same way
 * game/boost.js is a clock nothing owns.
 *
 * **They last the run.** A retry reloads the page, which is also what resets every one of these.
 *
 * **Cash is the score**, so every purchase is a straight loss on the table unless the upgrade pays
 * it back in fares — which is the bet the menu is offering, and why the prices sit in the range of
 * one to five fares rather than being token. See `REPAIR_PRICE` in game/fares.js for the scale.
 */
import { BOOST_DURATION } from './boost.js';
import { TAXI_HP } from '../sim/collisions.js';

// Each line's per-level effect, kept beside its prices so a tuning pass reads one table.
//
// - **Bumpers**: +25 HP a level, so the top level is a 175-HP car — a little under twice the hits.
// - **Engine**: +8% on Loco Mode's speed and punch a level. Kept small on purpose: the following
//   rule's lookahead (`LOOKAHEAD` in sim/traffic.js) is derived against the shipped overdrive top,
//   and every percent past it is road the taxi can cover before it can see what it is about to
//   rear-end. +24% at the top is a guess that has not been swept.
// - **Tank**: +25% of a tank a level, 15s → 26.25s. Rewards are a *fraction of the tank*
//   (`topUp` in game/boost.js), so a bigger tank also pours more per fare — the upgrade is "more
//   boost", both held and earned.
export const UPGRADES = Object.freeze([
  {
    id: 'bumpers', name: 'Big bumpers', blurb: 'More HP — take more hits before a wreck.',
    prices: [40, 80, 140], perLevel: 25, unit: 'HP',
  },
  {
    id: 'engine', name: 'Bigger engine', blurb: 'Loco Mode goes faster and hits harder.',
    prices: [50, 100, 160], perLevel: 0.08, unit: '%',
  },
  {
    id: 'tank', name: 'Bigger tank', blurb: 'More Loco Mode in the tank, and per fare.',
    prices: [40, 80, 140], perLevel: 0.25, unit: '%',
  },
]);

const byId = new Map(UPGRADES.map((u) => [u.id, u]));

export function createUpgrades() {
  const levels = Object.fromEntries(UPGRADES.map((u) => [u.id, 0]));

  const level = (id) => levels[id] ?? 0;
  const maxLevel = (id) => byId.get(id)?.prices.length ?? 0;
  /** What the next level costs, or null at the top (or for a line that does not exist). */
  const price = (id) => {
    const u = byId.get(id);
    return u && level(id) < u.prices.length ? u.prices[level(id)] : null;
  };

  return {
    level,
    maxLevel,
    price,
    /** Is there anything at all `money` would buy? Gates the depot tap on an undamaged car. */
    affordable: (money) => UPGRADES.some((u) => (price(u.id) ?? Infinity) <= money),
    /**
     * Take one level of `id` if `money` covers it. Returns the price paid, or 0 when refused —
     * the caller owns the till (see `charge` in game/fares.js), this only owns the levels.
     */
    buy(id, money) {
      const cost = price(id);
      if (cost == null || cost > money) return 0;
      levels[id] += 1;
      return cost;
    },
    maxHp: () => TAXI_HP + level('bumpers') * byId.get('bumpers').perLevel,
    /** Multiplier on the taxi's Loco Mode speed and acceleration — 1 when stock. */
    engine: () => 1 + level('engine') * byId.get('engine').perLevel,
    tankSeconds: () => BOOST_DURATION * (1 + level('tank') * byId.get('tank').perLevel),
  };
}
