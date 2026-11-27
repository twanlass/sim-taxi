/**
 * Does a drift kick carried onto an arched bridge fly Big Air when the route turns at the far bank?
 * Puts a kicked, boosting taxi at the foot of every arched deck on six cities, once per exit, and
 * counts launches. Straight exits are the control. See `bigAirDetour` in sim/traffic.js.
 *
 *   node tools/bigair-turn.mjs [classic]
 *
 * Measured 2026-11-27: classic launches 0 of 48 turning routes; the detour 42 of 48 (the six misses
 * are far banks with no straight exit, a T into a block). Straight 21 of 21 either way.
 */
import * as THREE from 'three';
import { makeRng } from '../src/util/rng.js';
import { createTraffic, placeCar, launchKick, setBigAirStyle } from '../src/sim/traffic.js';
import { createLayout } from '../src/city/layout.js';
import { cityNetwork } from '../src/city/roadnet.js';
import { isArchedDeck } from '../src/game/route.js';

const STEP = 1 / 60;
setBigAirStyle(process.argv[2]);
let ctl = 0, ctlBig = 0, big = 0, total = 0, detours = 0, wrong = 0;
for (let s = 0; s < 6; s++) {
  createLayout(makeRng(10000 + s * 1237));
  const net = cityNetwork();
  const traffic = createTraffic(makeRng(s + 44), new THREE.Scene(), 1);
  const taxi = traffic.taxi;
  for (const deck of net.lanes.filter(isArchedDeck)) {
    const far = net.nodeById.get(deck.to);
    const d = net.dirOfLane(deck);
    for (const id of deck.exits) {
      const tn = net.turnById.get(id);
      const straight = tn.hand === 'straight';
      const out = net.laneById.get(tn.outLane);
      if (!placeCar(taxi, d, far.gi, far.gj, deck.length - 0.5)) continue;
      taxi.lane = deck; taxi.s = 0.5;
      taxi.route = [net.dirOfLane(out)];
      taxi.routeConsumed = false;
      taxi.archHopLane = null; taxi.hopFrom = null; taxi.detoured = false;
      launchKick(taxi);
      taxi.boost = true;
      total += 1;
      let sawBig = false, det = false;
      for (let t = 0; t < 2.5; t += STEP) {
        traffic.update(STEP);
        if (taxi.hopFrom != null && taxi.hopBig) sawBig = true;
        if (taxi.detoured) det = true;
        if (taxi.lane && taxi.lane !== deck && taxi.state === 'drive') break;
      }
      if (straight) { ctl += 1; if (sawBig) ctlBig += 1; total -= 1; continue; }
      if (sawBig) big += 1;
      else console.log('  miss: seed', s, deck.id, tn.hand, 'straight exit:', deck.exits.map((x) => net.turnById.get(x).hand).join(','), 'v', taxi.v.toFixed(1), 'hop', taxi.hopKind ?? '', taxi.archHopLane === deck.id);
      if (det) detours += 1;
      if (sawBig && taxi.lane && net.dirOfLane(taxi.lane) !== d) wrong += 1;
    }
  }
}
console.log(`straight control: ${ctlBig}/${ctl}; turning routes off a kicked deck: ${total}, Big Air ${big}, detoured ${detours}, big-but-turned ${wrong}`);
