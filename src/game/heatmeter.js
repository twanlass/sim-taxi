// The police heat meter, top left (#heat in index.html): the stealth game's detection bar for the
// patrol cruiser (game/patrol.js).
//
//   patrol      a patrol is in town and has not noticed you — dim, empty
//   suspicious  you boosted near it and the heat is climbing; full is a chase (NOTICE_RANGE)
//   pursuit     it is after you and can see you; the bar is how far you are from shaking it
//   evading     it is after you and the bar is draining — out of its sight, or far enough ahead
//   lost        you shook it — held for LOST_HOLD, then the meter goes
//
// Read-only: it reads the patrol's state every frame and owns no rules of its own, so what the bar
// says and what the patrol does cannot disagree.

/** How long "Lost 'em" stays up after a chase ends in your favour, in seconds. */
const LOST_HOLD = 2;

/** Over this much heat a suspicious cop's dome throbs: the last moment to lift off. */
const HOT = 0.6;

const LABELS = {
  patrol: 'Patrol',
  suspicious: 'Suspicious',
  pursuit: 'Pursuit',
  evading: 'Evading',
  lost: "Lost 'em",
};

/**
 * @param el  the #heat element, or null (headless) — then this only tracks the mode
 */
export function createHeatMeter(el) {
  const label = el?.querySelector('.heat-label');
  let mode = 'none';
  let level = -1;
  let lostFor = 0;
  let wasChasing = false;

  function show(next, heat) {
    if (next !== mode) {
      mode = next;
      if (el) el.dataset.mode = next;
      if (label && LABELS[next]) label.textContent = LABELS[next];
    }
    // Quantised so a still bar writes nothing.
    const q = Math.round(heat * 200) / 200;
    if (q !== level) {
      level = q;
      el?.style.setProperty('--heat', String(q));
    }
    el?.classList.toggle('is-hot', next === 'suspicious' && heat >= HOT);
  }

  /**
   * @param patrol  game/patrol.js's patrol — reads `state` only
   */
  function update(dt, patrol) {
    const { phase, heat, evading } = patrol.state;
    const chasing = phase === 'chase' || phase === 'arrest';
    // A chase that ended any way but the arrest is the taxi getting away (lost, or the depot).
    if (wasChasing && !chasing && phase !== 'off') lostFor = LOST_HOLD;
    wasChasing = chasing;
    if (chasing) lostFor = 0;
    if (lostFor > 0) {
      lostFor -= dt;
      show('lost', 0);
      return;
    }
    if (chasing) show(evading ? 'evading' : 'pursuit', heat);
    else if (phase === 'patrol') show(heat > 0 ? 'suspicious' : 'patrol', heat);
    else show('none', 0);
  }

  return {
    update,
    get mode() { return mode; },
  };
}
