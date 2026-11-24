/**
 * The scripted session — `?bot`, for profiling on the phone without anyone playing.
 *
 * `?soak` (game/soak.js) drives the taxi from fare to fare and nothing else, which measures the
 * quietest minute of the game. The frames that drop on a phone are the busy ones: Loco Mode's flame
 * and bloom, a drift's smoke and rubber, a Big Air hop, the bank job's cut and four cop cars, a
 * patrol chase, a wreck and its replay. This plays **all of them, in a fixed order, on a fixed
 * clock**, and marks each one in the `?perf` capture (`perfMark('bot:<scene>')`), so
 * `tools/ios-perf.mjs` can split fps and hitches by scene and two builds can be compared scene by
 * scene. `tools/ios-perfloop.mjs` is the Mac half that builds, installs, runs and pulls it.
 *
 * **Deterministic input, not deterministic frames.** Pin `?seed=` and `?run=` (the loop does) and
 * the bot makes the same decisions on the same clock. A slow frame still takes a bigger sim step, so
 * the taxi is not in exactly the same place on two devices; scene averages compare, single frames
 * do not. Hence a script of *intentions* (go over a bridge on Loco, take the bank rider) rather than
 * a recording of taps, which would drift off the road the first time a frame ran long.
 *
 * **The bot does not lose.** A dead run would end the capture in whatever scene it died in, so until
 * the `crash` scene the taxi's HP is topped up, the fare clocks and the shift clock are held
 * (`fares.setPaused`), and a chasing cop is kept in its grace window so it cannot pin the taxi.
 * Then the last scene wrecks it on purpose, for the blast, the replay and the run-end card.
 *
 * `?bot` plays every scene; `?bot=loco,drift` only those (plus `warm` first and `crash` last).
 * Nothing runs without the flag.
 */

import { cityNetwork } from '../city/roadnet.js';
import { GRID_I, GRID_J } from '../city/grid.js';
import { isArchedDeck } from './route.js';
import { STOP_SETBACK, DRIFT_MIN_V } from '../sim/traffic.js';
import { TAXI_HP } from '../sim/collisions.js';
import { perfMark } from './perf.js';

/** Seconds per scene. Fixed, so two runs of the same build spend the same time in each. */
export const BOT_SCENES = [
  // The city's entrance, the first rider. Not judged: it is the load settling.
  { name: 'warm', seconds: 8 },
  // The fare loop as a player plays it, no pedals.
  { name: 'fares', seconds: 40 },
  // Loco Mode held the whole time: flame, wheelie, the push-in, bloom on the exhaust.
  { name: 'loco', seconds: 25 },
  // Loco, a brake tap before each corner, Loco again: the slide, smoke and rubber.
  { name: 'drift', seconds: 30 },
  // Straight on over the arched bridges on Loco: the hop and its landing.
  { name: 'bigair', seconds: 35 },
  // The bank rider, the bank job's cut, the getaway with four cop cars. Long, because the cut alone
  // is ~10 s and the getaway is a cross-town drive.
  { name: 'robbery', seconds: 75 },
  // A patrol cruiser spots the taxi on Loco and gives chase.
  { name: 'cops', seconds: 35 },
  // A wreck: the blast, the replay, the run-end card.
  { name: 'crash', seconds: 14 },
];

/**
 * Scenes a list can ask for that the full session does not play, so the profiling loop's timing
 * stays what it was. `bigroll`: a drift onto an arched bridge carried straight over its crest — true
 * Big Air, barrel roll and all — which the `bigair` scene only stumbles on (tools/trailer.mjs).
 */
export const BOT_EXTRA_SCENES = [{ name: 'bigroll', seconds: 45 }];

/** `?bot` → the scenes to play, or null without it. */
export function readBotScenes(search) {
  const params = new URLSearchParams(search);
  if (!params.has('bot')) return null;
  const only = (params.get('bot') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!only.length || only.includes('all') || only.includes('on')) return BOT_SCENES;
  const extra = BOT_EXTRA_SCENES.filter((s) => only.includes(s.name));
  const picked = BOT_SCENES.filter((s) => s.name === 'warm' || only.includes(s.name));
  return [...picked, ...extra, BOT_SCENES.at(-1)];
}

/**
 * @param hooks.ready       () => boolean — the run has started and the taxi is on the road
 * @param hooks.drive       () => void — dispatch to the next fare when idle (the bench's autopilot)
 * @param hooks.routeTo     main.js's routeTo
 * @param hooks.holdLoco / hooks.releaseLoco / hooks.holdBrake / hooks.releaseBrake — the pedals
 * @param hooks.dispatchToRider
 * @param hooks.wreck       () => boolean — wreck the taxi into the nearest car
 * @param hooks.save        (reason) => void — save the `?perf` capture now
 */
export function createPerfBot({
  traffic, fares, boost, robbery, patrols, pause = null, robberLine = null, ready, drive, routeTo, holdLoco, releaseLoco, holdBrake,
  releaseBrake, dispatchToRider, wreck, save, fixedStep = 0, search = typeof window !== 'undefined' ? window.location.search : '',
}) {
  const scenes = readBotScenes(search);
  if (!scenes) return null;

  const taxi = traffic.taxi;
  let index = -1;
  let sceneT = 0;
  let total = 0;
  let lastT = 0;
  let done = false;
  let started = false;
  // A destination of the bot's own (a bridge, a cop), as opposed to a fare's.
  let errand = null;
  let hops = 0;
  let lineOpen = 0;
  let tappedLane = null;
  let brakeUntil = -1;
  let robberySeen = false;
  let robberyEnded = 0;
  let wrecked = false;
  const log = [];
  // What each scene actually managed — a drift that never kicked or a bridge never hopped is a
  // scene that measured something else, and the report says so rather than quietly averaging it.
  const stats = {};
  const was = { drift: false, hop: false, big: false, rob: false, chase: false, boost: false };
  function count(key, on) {
    if (on && !was[key]) {
      const row = (stats[scene()] ??= {});
      row[key] = (row[key] ?? 0) + 1;
    }
    was[key] = on;
  }

  const scene = () => scenes[index]?.name ?? null;

  function enter(k) {
    // Whatever the last scene was holding, it lets go of.
    releaseLoco();
    releaseBrake();
    brakeUntil = -1;
    errand = null;
    index = k;
    sceneT = 0;
    const name = scene();
    if (!name) {
      done = true;
      perfMark(`bot:done ${JSON.stringify(stats)}`);
      save('bot-done');
      return;
    }
    perfMark(`bot:${name}`);
    log.push([Math.round(total * 10) / 10, name]);
    if (name === 'cops') {
      // A getaway still running holds every patrol off (`blocked` in main.js); end it as a wreck
      // would, at once, so this scene measures the patrol and not the tail of the robbery.
      if (robbery?.state.active) robbery.abandon();
      for (const p of patrols) if (p.state.phase === 'off') p.state.cooldown = 0;
    }
    // A patrol that spotted the taxi on Loco in an earlier scene would hold the robbery off for as
    // long as its chase ran (`busy` in game/robbery.js): call it off as the depot would.
    if (name === 'robbery') for (const p of patrols) p.hideout();
    if (name === 'crash') {
      fares.setPaused(false);
      wrecked = wreck();
    }
  }

  /** Keep the run alive until the crash scene: HP, clocks, and no arrest. */
  function immortal() {
    if (scene() === 'crash' || done) return;
    taxi.hp = TAXI_HP;
    fares.setPaused(true);
    for (const p of patrols) {
      if (p.state.phase === 'chase') p.state.grace = Math.max(p.state.grace, 0.5);
    }
  }

  function topUpFuel() {
    if (boost.state.fuel < 2) boost.state.fuel = 3;
  }

  function locoOn() {
    topUpFuel();
    if (!boost.isActive()) holdLoco();
  }

  /** Is the bot's own errand over — arrived, timed out, or taken over by a fare event? */
  function errandOver() {
    if (!errand) return true;
    const d = Math.hypot(taxi.x - errand.x, taxi.z - errand.z);
    if (d < 6 || sceneT - errand.at > 25 || taxi.pendingTarget !== errand.target) {
      if (taxi.pendingTarget === errand.target) taxi.pendingTarget = null;
      errand = null;
      return true;
    }
    return false;
  }

  /** The autopilot, unless the bot is on an errand of its own. */
  function autopilot() {
    if (!errandOver()) return;
    drive();
  }

  function goTo(target, opts) {
    const net = cityNetwork();
    const node = net.nodes.find((n) => n.gi === target.i && n.gj === target.j);
    if (!node || !routeTo(target, opts)) return false;
    errand = { x: node.x, z: node.z, at: sceneT, target };
    return true;
  }

  /** Pick an arched deck, the nearer end first, and drive straight over it and one block on. */
  function bridgeErrand() {
    const net = cityNetwork();
    const decks = net.lanes.filter((l) => isArchedDeck(l));
    if (!decks.length) return false;
    // Rotate through them so the hop is not always on the same bridge, but in a fixed order.
    const lane = decks[hops % decks.length];
    hops += 1;
    let a = net.nodeById.get(lane.from);
    let b = net.nodeById.get(lane.to);
    // Over it away from the taxi, so the approach is a straight run at it rather than a lap.
    if (Math.hypot(taxi.x - b.x, taxi.z - b.z) < Math.hypot(taxi.x - a.x, taxi.z - a.z)) [a, b] = [b, a];
    const di = Math.sign(b.gi - a.gi);
    const dj = Math.sign(b.gj - a.gj);
    const end = {
      i: Math.max(0, Math.min(GRID_I, b.gi + di)),
      j: Math.max(0, Math.min(GRID_J, b.gj + dj)),
    };
    return goTo(end, { along: { a: { i: a.gi, j: a.gj }, b: { i: b.gi, j: b.gj } } });
  }

  /**
   * Big Air, staged: an arched deck entered by a *turn* at its near bank, so the drift on that corner
   * is still being carried when the taxi reaches the crest, with the route going straight on past the
   * far bank (`launchHop(car, big)` in sim/traffic.js). Routed via the junction beside the near bank
   * on the bank road, then on to one block past the far one; driftPedals does the corner.
   */
  function bigRollErrand() {
    const net = cityNetwork();
    const decks = net.lanes.filter((l) => isArchedDeck(l));
    if (!decks.length) return false;
    for (let tries = 0; tries < decks.length * 2; tries++) {
      const k = hops++;
      const lane = decks[k % decks.length];
      const a = net.nodeById.get(lane.from);
      const b = net.nodeById.get(lane.to);
      const side = (Math.floor(k / decks.length) % 2) ? 1 : -1;
      const si = a.gi + side;
      if (si < 0 || si > GRID_I) continue;
      const end = { i: b.gi, j: Math.max(0, Math.min(GRID_J, b.gj + Math.sign(b.gj - a.gj))) };
      if (goTo(end, { via: { i: si, j: a.gj }, maxDetour: 99 })) return true;
    }
    return false;
  }

  /** Loco on; a brake tap just before a corner the route turns at, then Loco again (the kick). */
  function driftPedals() {
    if (brakeUntil >= 0) {
      if (sceneT >= brakeUntil) { releaseBrake(); brakeUntil = -1; locoOn(); }
      return;
    }
    locoOn();
    if (taxi.drift || taxi.state !== 'drive' || !taxi.route?.length || !taxi.lane) return;
    // One tap per corner, and only at Loco speed: a tap that did not arm a drift is an ordinary
    // brake, and tapping again every frame after it held the taxi at a crawl for a whole scene.
    if (tappedLane === taxi.lane.id || taxi.v < DRIFT_MIN_V) return;
    const toLine = taxi.lane.length - STOP_SETBACK - taxi.s;
    if (taxi.route[0] !== taxi.d && toLine > 0 && toLine < Math.max(6, taxi.v * 0.5)) {
      tappedLane = taxi.lane.id;
      holdBrake();
      brakeUntil = sceneT + 0.13;
    }
  }

  function robberyStep() {
    if (!robbery) { autopilot(); return; }
    if (robbery.state.active) robberySeen = true;
    if (robberySeen && !robbery.state.active && !robberyEnded) robberyEnded = sceneT;
    if (!robberySeen) {
      const bank = fares.state.fares.find((f) => f.bank && f.stage === 'waiting');
      if (bank && !bank.directed && !fares.carrying()) { dispatchToRider(bank); return; }
      // No bank rider on the board in time: stage the getaway directly once the seat is empty.
      if (sceneT > 15 && !fares.carrying() && robbery.force()) return;
    }
    if (bank() && !robberySeen) return;
    autopilot();
    // The getaway on Loco, as a player plays it: four cop cars and the flame together is the frame
    // this scene is here to measure.
    if (robberySeen && robbery.state.active && fares.carrying()) locoOn();
  }
  const bank = () => fares.state.fares.some((f) => f.bank && f.directed);

  function copsStep() {
    const chasing = patrols.some((p) => p.state.phase === 'chase');
    const cop = patrols.map((p) => p.state.cop).find((c) => c && !c.crashed);
    if (!chasing && cop && !errand) {
      // Head for the junction nearest the cruiser, on Loco: it spots a taxi on the pill in range.
      let best = null;
      let bestD = Infinity;
      for (const n of cityNetwork().nodes) {
        if (n.gi == null) continue;
        const d = Math.hypot(n.x - cop.x, n.z - cop.z);
        if (d < bestD) { best = n; bestD = d; }
      }
      if (best) goTo({ i: best.gi, j: best.gj });
    }
    if (chasing && errand) { if (taxi.pendingTarget === errand.target) taxi.pendingTarget = null; errand = null; }
    autopilot();
    if (cop) locoOn();
  }

  return {
    /** True while the bot keeps the run from ending. */
    immortal: () => started && !done && scene() !== 'crash',
    /** Demo mode's bank rule, in the robbery scene: the next spawn the bank is allowed is theirs. */
    wantsBank: () => scene() === 'robbery' && !robberySeen,
    /** The scene playing now, and `log`: `[seconds, name]` as each began (also `bot:` notes in the capture). */
    scene,
    log,
    stats,
    /** The bot's own destination and how many bridge runs it has set, for debugging a scene. */
    errand: () => errand && { ...errand, hops },
    /** Call once per frame, before `tick`. */
    update(t) {
      // Under `?fixedstep` the scene clocks run on game time too, so a scene is the same frames everywhere.
      const dt = fixedStep && lastT ? fixedStep : lastT ? Math.min((t - lastT) / 1000, 0.1) : 0;
      lastT = t;
      if (done) return;
      if (!started) {
        if (!ready()) return;
        started = true;
        enter(0);
      }
      // The shell pauses the run whenever the app stops being frontmost (a notification banner pulled
      // down, Control Centre). Nobody is there to resume it, so the bot does.
      if (pause?.state.paused) pause.setPaused(false);
      // The robber's line stops the world until a tap (game/robberline.js). Read for a couple of
      // seconds, as a player would, then answered the way the keyboard answers it.
      if (robberLine?.isOpen()) {
        lineOpen += dt;
        if (lineOpen > 2.5) {
          lineOpen = 1;
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter' }));
        }
      } else lineOpen = 0;
      sceneT += dt;
      total += dt;
      immortal();
      count('drift', Boolean(taxi.drift?.kicked));
      // Any hop (an arch crest on Loco, a barricade), and the big one — the drift launch, which is
      // Big Air when it carries over a bridge (`launchHop` in sim/traffic.js).
      count('hop', taxi.hopFrom != null);
      count('big', taxi.hopFrom != null && taxi.hopBig === true);
      count('rob', Boolean(robbery?.state.active));
      count('chase', patrols.some((p) => p.state.phase === 'chase'));
      count('boost', boost.isActive());
      const name = scene();
      if (name === 'fares' || name === 'warm') autopilot();
      else if (name === 'loco') { autopilot(); locoOn(); }
      else if (name === 'drift') { autopilot(); driftPedals(); }
      else if (name === 'bigair') {
        if (errandOver() && !bridgeErrand()) autopilot();
        if (errand) locoOn();
      } else if (name === 'bigroll') {
        if (errandOver() && !bigRollErrand()) autopilot();
        if (errand) driftPedals(); else locoOn();
      } else if (name === 'robbery') robberyStep();
      else if (name === 'cops') copsStep();
      else if (name === 'crash' && !wrecked && sceneT > 0.5) wrecked = wreck();
      const limit = scenes[index].seconds;
      // The robbery ends early once the getaway is over and a few seconds have passed, so a short
      // getaway does not leave twenty seconds of plain fares labelled as a robbery.
      const early = name === 'robbery' && robberyEnded && sceneT - robberyEnded > 4 && sceneT > 30;
      if (sceneT >= limit || early) enter(index + 1);
    },
  };
}
