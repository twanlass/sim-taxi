/**
 * The depot's upgrades (game/upgrades.js) and the resizable boost tank they drive.
 *
 * Pure logic, so it costs nothing: the catalogue's levels and prices, the till rule, and the two
 * things a tank upgrade must not do — hand out a free fill, or lose fuel already poured.
 *
 *   node tools/upgrades.mjs
 */
import { createUpgrades, UPGRADES } from '../src/game/upgrades.js';
import { createBoost, BOOST_DURATION, BOOST_FARE_REWARD } from '../src/game/boost.js';
import { TAXI_HP } from '../src/sim/collisions.js';

const results = [];
const failures = [];
function check(name, ok, detail = '') {
  results.push(ok);
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

// --- Stock -------------------------------------------------------------------
{
  const u = createUpgrades();
  check('stock HP is TAXI_HP', u.maxHp() === TAXI_HP);
  check('stock engine is 1', u.engine() === 1);
  check('stock tank is BOOST_DURATION', u.tankSeconds() === BOOST_DURATION);
  check('nothing affordable on $0', !u.affordable(0));
  const cheapest = Math.min(...UPGRADES.map((x) => x.prices[0]));
  check('the cheapest first level is affordable on its price', u.affordable(cheapest));
  check('and not a dollar under it', !u.affordable(cheapest - 1));
}

// --- Buying ------------------------------------------------------------------
{
  const u = createUpgrades();
  const first = u.price('bumpers');
  check('refused short of the price', u.buy('bumpers', first - 1) === 0 && u.level('bumpers') === 0);
  check('bought on the price, returns it', u.buy('bumpers', first) === first && u.level('bumpers') === 1);
  check('bumpers raise max HP', u.maxHp() > TAXI_HP);
  for (let k = 0; k < 10; k++) u.buy('bumpers', 1e9);
  check('levels stop at the top', u.level('bumpers') === u.maxLevel('bumpers'));
  check('a maxed line has no price', u.price('bumpers') === null);
  check('and cannot be bought', u.buy('bumpers', 1e9) === 0);
  check('an unknown line cannot be bought', u.buy('nitro', 1e9) === 0);
  u.buy('engine', 1e9);
  check('engine raises the multiplier', u.engine() > 1);
  u.buy('tank', 1e9);
  check('tank raises the seconds', u.tankSeconds() > BOOST_DURATION);
  check('prices climb within a line', UPGRADES.every((x) =>
    x.prices.every((p, k) => k === 0 || p > x.prices[k - 1])));
}

// --- The tank ----------------------------------------------------------------
{
  const b = createBoost();
  const before = b.state.fuel;
  b.setDuration(BOOST_DURATION * 1.5);
  check('a bigger tank keeps the fuel in it, not a free fill', b.state.fuel === before);
  check('so the dial reads lower', near(b.fraction(), before / (BOOST_DURATION * 1.5)));
  b.topUp(BOOST_FARE_REWARD);
  for (let k = 0; k < 600; k++) b.update(1 / 60);
  check('a fare pours a third of the *new* tank',
    near(b.state.fuel, before + BOOST_DURATION * 1.5 * BOOST_FARE_REWARD));
  b.topUp(1);
  for (let k = 0; k < 600; k++) b.update(1 / 60);
  check('and a full pour fills the new tank, not the old one', near(b.state.fuel, BOOST_DURATION * 1.5));
  b.setDuration(1);
  check('cannot shrink under the fuel in it', b.duration() >= b.state.fuel);
  b.setDuration(NaN);
  check('ignores nonsense', Number.isFinite(b.duration()));
}

const passed = results.filter(Boolean).length;
for (const line of failures.slice(0, 12)) console.log(`  FAIL ${line}`);
console.log(`${passed}/${results.length} checks passed`);
process.exit(failures.length ? 1 : 0);
