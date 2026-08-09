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
 * **One row at a time.** The stats are counted out, not staggered: a row's label arrives, its
 * number rolls, the number lands and pops, and only after a held beat does the next label appear.
 * An earlier pass overlapped them on a 165ms stride, and with four rows all counting at once the
 * block read as one animation with numbers moving inside it — you watched the screen rather than
 * any single figure. `STAT_STRIDE` is now *derived* from a row's own beat plus `ROW_GAP`, so the
 * "finished before the next one starts" property is a fact about the constants rather than
 * something to keep re-checking by eye.
 *
 * Every beat is driven from the timeline constants below rather than from CSS keyframe delays, so
 * the whole cadence can be re-paced from one place and so the stat rows — however many there are —
 * fall out of a single stride. The play-again button is deliberately last: it appears once the
 * final number has finished counting, so the player isn't invited to leave mid-tally. Counting the
 * rows out one at a time roughly doubled the wait to get there, which is what the tap-to-skip at
 * the bottom of this module is for.
 *
 * The DOM is rebuilt on every call. This runs once per run, so nothing here is pooled or reused.
 */

// --- The timeline, in ms ----------------------------------------------------
// Tuned as a whole: the overlay is up for ~3.5s before the button appears. That is the cost of
// playing the rows one at a time — each of the four owns ~0.7s of it — so every individual beat is
// kept short; a row that takes its time *and* waits its turn drags the whole card.
const REVEAL_MS = 300;        // the blackout coming up behind everything else
const TITLE_AT = 110;
const REASON_AT = 250;
const STATS_AT = 430;
const LABEL_MS = 280;         // the scale-down fade-in on a stat's label
const COUNT_LEAD = 100;       // the count starts while its label is still settling, not after it
const COUNT_MS = 340;
const LAND_MS = 200;          // the scale pop the number ends on
const ROW_GAP = 90;           // held beat between one number landing and the next label arriving
const RETRY_GAP = 240;        // beat between the last number landing and the button appearing

/** A row from its label's first frame to its number's pop finishing: the unit the list counts in. */
const ROW_MS = COUNT_LEAD + COUNT_MS + LAND_MS;
const STAT_STRIDE = ROW_MS + ROW_GAP;   // start-to-start, so rows never overlap

const RISE = 'cubic-bezier(0.22, 1, 0.36, 1)';   // the same ease the earnings pop and money bump use

// The reason line — "The fuzz caught you slippin'.", "That's coming out of your paycheck." — is
// sized to this fraction of the viewport, not the card. The three lines run from 30 to 41
// characters, and a fixed font-size either wasted the width on the short one or wrapped the long
// one; scaling each to the same on-screen width instead makes every ending read with the same
// weight regardless of which copy it landed on.
const REASON_WIDTH_RATIO = 0.8;
// A safety valve on the maths, not a design target: keeps a future one-word reason legible and an
// unexpectedly long one off the edge of the screen, without capping the sizes the three shipped
// lines actually land on.
const REASON_MIN_PX = 10;
const REASON_MAX_PX = 72;

/** Everything at rest, no motion. Used under `prefers-reduced-motion`. */
const stillPlease = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/**
 * Scale the reason line's font-size so its one line spans `REASON_WIDTH_RATIO` of the viewport
 * width, whatever the copy. Measured against the CSS base size rather than a hardcoded one, so a
 * future tweak to that base doesn't need a matching change here — reset to it first so a second
 * call (there isn't one today, but nothing here assumes there won't be) can't compound a previous
 * scale onto itself. `white-space: nowrap` is what keeps this a fit rather than a wrap: without it
 * a long reason would break the line before it ever reached the target width.
 */
function fitReasonWidth(el) {
  if (!el.textContent) return;
  el.style.fontSize = '';
  const natural = el.getBoundingClientRect().width;
  if (natural <= 0) return;
  const basePx = Number.parseFloat(getComputedStyle(el).fontSize);
  const target = window.innerWidth * REASON_WIDTH_RATIO;
  const size = Math.min(REASON_MAX_PX, Math.max(REASON_MIN_PX, basePx * (target / natural)));
  el.style.fontSize = `${size}px`;
}

/**
 * Rise-and-settle: up from below, slightly small, into place. The shared entrance for the title,
 * the reason and the play-again button, so the three read as one family of moves.
 */
function riseIn(el, delay, { from = 14, scale = 0.94, duration = 520 } = {}) {
  return el.animate([
    { opacity: 0, transform: `translateY(${from}px) scale(${scale})` },
    { opacity: 1, transform: 'translateY(0) scale(1)' },
  ], { duration, delay, easing: RISE, fill: 'backwards' });
}

/**
 * A stat's label: oversized and transparent, shrinking into its final size as it fades up. Scaling
 * *down* into place (rather than up) is what makes the word feel like it is settling onto the screen
 * instead of being pushed at the player, and it leaves the number beside it as the only thing still
 * moving once the label has landed. Label and value are set in the same type and sit at opposite
 * edges of the row, so the list reads as a ledger rather than as captions over figures.
 */
function scaleDownIn(el, delay) {
  return el.animate([
    { opacity: 0, transform: 'scale(1.55)' },
    { opacity: 1, transform: 'scale(1)' },
  ], { duration: LABEL_MS, delay, easing: RISE, fill: 'backwards' });
}

/**
 * Roll a number from zero up to `value`, then bump it. Same shape as the HUD's money roll, but on
 * its own clock: this one is a reveal, not a reaction to an event, so it eases out hard and ends
 * on a scale pop that says "this is the number".
 *
 * Very small values still take the full COUNT_MS — a "3" that counts 0-1-2-3 over a third of a
 * second reads as deliberate, whereas scaling the duration to the value made Fares flick past while
 * Cash laboured through three digits, and the four stats stopped feeling like one list.
 *
 * Returns a function that lands the number where it stands: the skip below calls it on every row
 * at once, and a roll that hasn't started yet drops straight to its final value.
 */
function countUp(el, value, format, delay) {
  // Zero is the first *frame*, not the moment this was called. A WAAPI animation starts at the
  // next frame after `animate()`, so anchoring the roll to `performance.now()` here put it on a
  // different clock than the fade beside it — and the game-over frame is exactly where the page
  // hitches. Measured on a stalled boot: the numbers ran ~500ms ahead of their own labels, which
  // for a list played one row at a time meant a row counting before it had appeared.
  let t0 = null;
  let live = true;
  const step = (now) => {
    if (!live) return;
    if (t0 === null) t0 = now + delay;
    const t = Math.min(1, Math.max(0, (now - t0) / COUNT_MS));
    const eased = 1 - (1 - t) ** 3;
    el.textContent = format(Math.round(value * eased));
    if (t < 1) { requestAnimationFrame(step); return; }
    live = false;
    el.textContent = format(value);
    el.animate([
      { transform: 'scale(1)' }, { transform: 'scale(1.14)', offset: 0.4 }, { transform: 'scale(1)' },
    ], { duration: LAND_MS, easing: RISE });
  };
  el.textContent = format(0);
  requestAnimationFrame(step);
  return () => { live = false; el.textContent = format(value); };
}

/**
 * Build and reveal the overlay.
 *
 * `stats` is a list of `{ label, value, format }` — `format` turns the counter's integer into what
 * the player sees (the `$` prefix on Cash, the shift name on Shift), so the count-up itself never
 * has to know which stat it is rolling.
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
    // Placeholder text before the roll starts, so the row is already at its final size when it
    // fades in — a value column that widened as digits arrived would drag the right-hand edge of
    // the whole block with it, and rows that grew would shove the button down the screen.
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
  fitReasonWidth(sub);

  const lastStatAt = STATS_AT + Math.max(0, cells.length - 1) * STAT_STRIDE;
  const retryAt = lastStatAt + ROW_MS + RETRY_GAP;

  if (stillPlease()) {
    // No entrance and no roll: final values, immediately. The sequence is the whole point of this
    // module, so under reduced motion there is nothing left to do but print the scoreboard.
    for (const { value, stat } of cells) value.textContent = stat.format(stat.value);
    return;
  }

  // Nothing to click at until the button's entrance: it is transparent until then, and a disabled
  // button doesn't swallow the pointer, so a tap aimed at the invisible pill reaches the skip below
  // instead of silently reloading the page.
  retry.disabled = true;

  const anims = [
    root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REVEAL_MS, easing: 'ease-out' }),
    riseIn(heading, TITLE_AT, { from: 18, scale: 0.92 }),
    riseIn(sub, REASON_AT),
  ];
  const landings = [];

  cells.forEach(({ label, value, stat }, index) => {
    const at = STATS_AT + index * STAT_STRIDE;
    anims.push(scaleDownIn(label, at));
    // The value shares its label's entrance — it is the same cell arriving — and starts counting
    // partway through it, so the number is already moving as the word settles. The row is over
    // COUNT_LEAD + COUNT_MS + LAND_MS later, which is exactly what the next row waits for.
    anims.push(value.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: LABEL_MS, delay: at + 60, easing: 'ease-out', fill: 'backwards',
    }));
    landings.push(countUp(value, stat.value, stat.format, at + COUNT_LEAD));
  });

  anims.push(riseIn(retry, retryAt, { from: 10, scale: 0.9, duration: 420 }));

  // Tap anywhere to jump to the end of the tally. Counting four rows out one at a time is worth
  // ~3.5s of curtain call the first few times and a wall the twentieth; a player who wants to be
  // back in the taxi shouldn't have to sit through numbers they can already predict. Finishing the
  // animations rather than cancelling them leaves every element on its resting frame.
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    root.removeEventListener('pointerdown', finish);
    for (const anim of anims) anim.finish();
    for (const land of landings) land();
    retry.disabled = false;
  };
  root.addEventListener('pointerdown', finish);
  // Part-way into the button's 420ms entrance rather than at the end of it: on this ease it is
  // ~85% opaque by then, and a pill you can already see but can't press yet reads as a dead button.
  setTimeout(finish, retryAt + 200);
}
