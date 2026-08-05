/**
 * The run-end overlay — a title, a reason, four stats and a play-again button on a full-screen
 * blackout — revealed as a sequence rather than all at once.
 *
 * The old version wrote one line of `innerHTML` and the whole screen appeared in a single frame,
 * which read as "the game stopped" rather than as a scoreboard. Everything here is about giving
 * the run a curtain call: the title lands first, the reason follows it, then each stat's label
 * drops in and only *then* does its number roll up from zero. A number that rolls is a number
 * that gets read; a number that is simply printed gets skipped past on the way to the button.
 *
 * Every beat is driven from the timeline constants below rather than from CSS keyframe delays, so
 * the whole cadence can be re-paced from one place and so the stat rows — however many there are —
 * stagger off a single stride. The play-again button is deliberately last: it appears once the
 * final number has finished counting, so the player isn't invited to leave mid-tally.
 *
 * The DOM is rebuilt on every call. This runs once per run, so nothing here is pooled or reused.
 */

// --- The timeline, in ms ----------------------------------------------------
// Tuned as a whole: the overlay is up for ~2.1s before the button appears, which is long enough to
// read four stats and short enough that a player who already knows what they say isn't held hostage.
const REVEAL_MS = 300;        // the blackout coming up behind everything else
const TITLE_AT = 110;
const REASON_AT = 250;
const STATS_AT = 470;
const STAT_STRIDE = 165;      // gap between one stat starting and the next
const LABEL_MS = 420;         // the scale-down fade-in on a stat's label
const COUNT_LEAD = 200;       // the count starts while its label is still settling, not after it
const COUNT_MS = 620;
const RETRY_GAP = 240;        // beat between the last number landing and the button appearing

const RISE = 'cubic-bezier(0.22, 1, 0.36, 1)';   // the same ease the earnings pop and money bump use

/** Everything at rest, no motion. Used under `prefers-reduced-motion`. */
const stillPlease = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Rise-and-settle: up from below, slightly small, into place. The shared entrance for the title,
 * the reason and the play-again button, so the three read as one family of moves.
 */
function riseIn(el, delay, { from = 14, scale = 0.94, duration = 520 } = {}) {
  el.animate([
    { opacity: 0, transform: `translateY(${from}px) scale(${scale})` },
    { opacity: 1, transform: 'translateY(0) scale(1)' },
  ], { duration, delay, easing: RISE, fill: 'backwards' });
}

/**
 * A stat's label: oversized and transparent, shrinking into its final size as it fades up. Scaling
 * *down* into place (rather than up) is what makes the word feel like it is settling onto the screen
 * instead of being pushed at the player, and it leaves the number below it as the only thing still
 * moving once the label has landed. Label and value are set in the same type, so the pair reads as
 * one two-line phrase — "Fares / 9" — rather than as a caption over a figure.
 */
function scaleDownIn(el, delay) {
  el.animate([
    { opacity: 0, transform: 'scale(1.55)' },
    { opacity: 1, transform: 'scale(1)' },
  ], { duration: LABEL_MS, delay, easing: RISE, fill: 'backwards' });
}

/**
 * Roll a number from zero up to `value`, then bump it. Same shape as the HUD's money roll, but on
 * its own clock: this one is a reveal, not a reaction to an event, so it eases out hard and ends
 * on a scale pop that says "this is the number".
 *
 * Very small values still take the full COUNT_MS — a "3" that counts 0-1-2-3 over half a second
 * reads as deliberate, whereas scaling the duration to the value made Fares flick past while Cash
 * laboured through three digits, and the four stats stopped feeling like one list.
 */
function countUp(el, value, format, delay) {
  const t0 = performance.now() + delay;
  const step = (now) => {
    const t = Math.min(1, Math.max(0, (now - t0) / COUNT_MS));
    const eased = 1 - (1 - t) ** 3;
    el.textContent = format(Math.round(value * eased));
    if (t < 1) { requestAnimationFrame(step); return; }
    el.textContent = format(value);
    el.animate([
      { transform: 'scale(1)' }, { transform: 'scale(1.14)', offset: 0.4 }, { transform: 'scale(1)' },
    ], { duration: 280, easing: RISE });
  };
  el.textContent = format(0);
  requestAnimationFrame(step);
}

/**
 * Build and reveal the overlay.
 *
 * `stats` is a list of `{ label, value, format }` — `format` turns the counter's integer into what
 * the player sees (the `$` prefix, the `mph` suffix), so the count-up itself never has to know
 * which stat it is rolling.
 */
export function showRunEnd(root, { title, reason, stats, onRetry }) {
  root.innerHTML = '';
  root.hidden = false;

  const card = document.createElement('div');
  card.className = 'run-end-card';

  const heading = document.createElement('strong');
  heading.className = 'run-end-title';
  heading.textContent = title;

  const sub = document.createElement('span');
  sub.className = 'run-end-reason';
  sub.textContent = reason ?? '';

  const column = document.createElement('div');
  column.className = 'run-end-stats';

  const cells = stats.map((stat) => {
    const cell = document.createElement('div');
    cell.className = 'stat';
    const label = document.createElement('span');
    label.className = 'stat-label';
    label.textContent = stat.label;
    const value = document.createElement('span');
    value.className = 'stat-value';
    // Placeholder text before the roll starts, so the column is already at its final height when
    // it fades in — rows that grew as numbers arrived would shove the button down the screen.
    value.textContent = stat.format(0);
    cell.append(label, value);
    column.append(cell);
    return { label, value, stat };
  });

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'retry';
  retry.textContent = 'Play again';
  retry.addEventListener('click', onRetry);

  card.append(heading, sub, column, retry);
  root.append(card);

  const lastStatAt = STATS_AT + Math.max(0, cells.length - 1) * STAT_STRIDE;
  const retryAt = lastStatAt + COUNT_LEAD + COUNT_MS + RETRY_GAP;

  if (stillPlease()) {
    // No entrance and no roll: final values, immediately. The stagger is the whole point of this
    // module, so under reduced motion there is nothing left to do but print the scoreboard.
    for (const { value, stat } of cells) value.textContent = stat.format(stat.value);
    return;
  }

  root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REVEAL_MS, easing: 'ease-out' });
  riseIn(heading, TITLE_AT, { from: 18, scale: 0.92 });
  riseIn(sub, REASON_AT);

  cells.forEach(({ label, value, stat }, index) => {
    const at = STATS_AT + index * STAT_STRIDE;
    scaleDownIn(label, at);
    // The value shares its label's entrance — it is the same cell arriving — and starts counting
    // partway through it, so the number is already moving as the word settles.
    value.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: LABEL_MS, delay: at + 60, easing: 'ease-out', fill: 'backwards',
    });
    countUp(value, stat.value, stat.format, at + COUNT_LEAD);
  });

  riseIn(retry, retryAt, { from: 10, scale: 0.9, duration: 420 });
}
