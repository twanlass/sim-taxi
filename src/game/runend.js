/**
 * The run-end overlay — a title, a reason, and then a sequence of screens on a full-screen
 * blackout: the run's four stats counted out, an initials prompt if the run made the high-score
 * table, the table itself, and finally the play-again button.
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
 * ## One body, three screens
 *
 * The stats, the initials prompt and the high-score table are the same slot in the card, swapped
 * one for the next — not a list that grows. Stacking them was the first shape and it does not fit:
 * a title, a reason, four stat rows, a prompt and five table rows is well past what a landscape
 * phone shows at once, and this card's whole layout (see the `max-width` and the `vh` clamps in
 * `index.html`) exists to keep "Play again" above the fold. Swapping also makes each beat a screen
 * of its own, which is what the sequence is for: read your run, sign it, see where it placed.
 *
 * The slot never shrinks below the stats' own height, so the handover is a cross-fade rather than
 * a card that collapses and re-centres under the title between every beat.
 *
 * ## The one phase that waits
 *
 * Every beat but the prompt is on a timer, and a pointerdown anywhere fast-forwards it — counting
 * four rows out is worth ~3.5s of curtain call the first few times and a wall the twentieth. The
 * prompt is different: it is waiting on the *player*, so nothing skips it and no timer runs past
 * it. That is why the skip is a single mutable handler (`skip`) that each phase installs and the
 * prompt sets to null, rather than one listener that finishes every animation on the screen. An
 * earlier shape had the skip land the whole timeline at once, which blew straight through the
 * initials field and threw away the name the player was mid-way through typing.
 *
 * The DOM is rebuilt on every call. This runs once per run, so nothing here is pooled or reused.
 */
import { NAME_LENGTH, normaliseName, scoreOf } from './highscores.js';

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

/** Held beat after the last number lands, before the body swaps out from under it. */
const HOLD_MS = 420;
const SWAP_OUT_MS = 240;      // the outgoing screen leaving
const SWAP_IN_MS = 420;       // and the next one arriving in its place

/**
 * The table's rows cascade rather than counting out one at a time. The stats are four facts about
 * *this* run and each is worth a beat of its own; the table is one object, and five rows played at
 * a stat's pace would be another three seconds on a screen the player has already finished reading.
 */
const SCORE_ROW_STRIDE = 65;
const SCORE_ROW_MS = 360;

const RISE = 'cubic-bezier(0.22, 1, 0.36, 1)';   // the same ease the earnings pop and money bump use

/** Everything at rest, no motion. Used under `prefers-reduced-motion`. */
const stillPlease = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** 1st through 5th — the table is five rows, so this never needs the general rule. */
const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th'];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Cap the reason's width at the title's own rendered width, so a two-line reason reads as sitting
 * *under* the title rather than spilling past it. `text-wrap: balance` (see the CSS) does the rest:
 * given that cap, it picks a break point that leaves both lines close to the same length instead of
 * a short orphan hanging off a nearly-full first line.
 */
function matchReasonWidth(heading, sub) {
  if (!sub.textContent) return;
  const width = heading.getBoundingClientRect().width;
  if (width > 0) sub.style.maxWidth = `${width}px`;
}

/**
 * Rise-and-settle: up from below, slightly small, into place. The shared entrance for the title,
 * the reason, each swapped-in screen and the play-again button, so they read as one family of moves.
 */
function riseIn(node, delay, { from = 14, scale = 0.94, duration = 520 } = {}) {
  return node.animate([
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
function scaleDownIn(node, delay) {
  return node.animate([
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
function countUp(node, value, format, delay) {
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
    node.textContent = format(Math.round(value * eased));
    if (t < 1) { requestAnimationFrame(step); return; }
    live = false;
    node.textContent = format(value);
    node.animate([
      { transform: 'scale(1)' }, { transform: 'scale(1.14)', offset: 0.4 }, { transform: 'scale(1)' },
    ], { duration: LAND_MS, easing: RISE });
  };
  node.textContent = format(0);
  requestAnimationFrame(step);
  return () => { live = false; node.textContent = format(value); };
}

/**
 * The stats ledger: one row per stat, label pinned left and value right.
 *
 * Returns the block plus a `play` that runs the count-out and resolves when the last number has
 * landed, and a `land` that drops every row onto its final value immediately.
 */
function buildStats(stats) {
  const column = el('div', 'run-end-stats');

  const cells = stats.map((stat) => {
    const cell = el('div', 'stat');
    const label = el('span', 'stat-label', stat.label);
    // Placeholder text before the roll starts, so the row is already at its final size when it
    // fades in — a value column that widened as digits arrived would drag the right-hand edge of
    // the whole block with it, and rows that grew would shove the button down the screen.
    const value = el('span', 'stat-value', stat.format(0));
    cell.append(label, value);
    column.append(cell);
    return { label, value, stat };
  });

  // Hidden until its beat starts, and cleared inside `play` below.
  //
  // What hides a row otherwise is `fill: 'backwards'` on its own entrance, which only applies from
  // the moment `animate()` is called — and this screen is built at once but played `STATS_AT` later,
  // on a timer. In between, the block sat on the card at full opacity showing its labels and its
  // `format(0)` placeholders, then snapped to hidden as the animations were created and faded back
  // in: the stats appeared, vanished and arrived again. The old single-pass version never had the
  // gap, because it created every animation up front with `delay: at`.
  column.style.opacity = '0';

  return {
    node: column,
    /** Total time from the first label to the last number's pop. */
    duration: Math.max(0, cells.length - 1) * STAT_STRIDE + ROW_MS,
    play(anims, landings) {
      // Same task as the entrances below, so the row is never painted between the two.
      column.style.opacity = '';
      cells.forEach(({ label, value, stat }, index) => {
        const at = index * STAT_STRIDE;
        anims.push(scaleDownIn(label, at));
        // The value shares its label's entrance — it is the same cell arriving — and starts counting
        // partway through it, so the number is already moving as the word settles. The row is over
        // COUNT_LEAD + COUNT_MS + LAND_MS later, which is exactly what the next row waits for.
        anims.push(value.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: LABEL_MS, delay: at + 60, easing: 'ease-out', fill: 'backwards',
        }));
        landings.push(countUp(value, stat.value, stat.format, at + COUNT_LEAD));
      });
    },
  };
}

/**
 * How much shorter the visual viewport has to be than the layout viewport before we treat the
 * difference as a software keyboard. A URL bar collapsing is worth a few dozen pixels; a keyboard
 * is worth a third of the screen. 80px is comfortably between the two.
 */
const KEYBOARD_MIN = 80;

/**
 * Keep the overlay inside the *visual* viewport for as long as the initials field has focus, and
 * keep the prompt itself scrolled into what that leaves.
 *
 * iOS does not shrink the layout viewport when the keyboard opens — it slides the visual viewport
 * up over an unchanged one — so `#run-end`'s `position: fixed; inset: 0` still measures the whole
 * screen and centres the card on a point behind the keys. Asking for the field to be scrolled into
 * view (what this used to do, on a 300ms timer) cannot help: the centre of the scroll container
 * *is* the covered half. So clamp the container to `visualViewport` instead and let the card's
 * existing `margin: auto` do the centring against the band that is visible.
 *
 * Android resizes the layout viewport itself, so there the two viewports agree and the clamp stays
 * off — applying it anyway would subtract the keyboard's height a second time. The scroll runs
 * either way, since a card taller than the remaining band still has to be pointed at the prompt.
 *
 * Returns the release: it drops the clamp and unhooks the listeners. Removing a focused element
 * does not reliably fire `blur`, so the commit path calls this too rather than trusting the event.
 */
function followKeyboard(root, entry) {
  const vv = window.visualViewport;
  if (!vv) return () => {};

  let frame = 0;
  const apply = () => {
    if (window.innerHeight - vv.height - vv.offsetTop > KEYBOARD_MIN) {
      root.style.setProperty('--kb-top', `${vv.offsetTop}px`);
      root.style.setProperty('--kb-height', `${vv.height}px`);
      root.classList.add('is-keyboard');
    } else {
      root.classList.remove('is-keyboard');
    }
    // The clamp only takes effect on the next layout, so the scroll that depends on it waits a
    // frame — measured against the old box it would scroll to a position that no longer exists.
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      // `nearest`, not `center`. The prompt is short enough to fit the band the keyboard leaves,
      // and `nearest` is a no-op once it does; `center` on a block that *doesn't* fit pushes its
      // top edge — the "New high score!" line, the reason the screen exists — off the top.
      entry.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    });
  };

  // The keyboard animates in, and iOS reports the viewport repeatedly on the way; `scroll` is the
  // one that fires when iOS shifts the visual viewport without changing its height.
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();

  return () => {
    cancelAnimationFrame(frame);
    vv.removeEventListener('resize', apply);
    vv.removeEventListener('scroll', apply);
    root.classList.remove('is-keyboard');
    root.style.removeProperty('--kb-top');
    root.style.removeProperty('--kb-height');
  };
}

/**
 * The initials prompt: three character cells with a real `<input>` laid transparently over them.
 *
 * **One input, not three.** Three fields means three focus targets, a tab order, and hand-written
 * backspace-moves-back behaviour — all of which the browser already does for free on a single
 * `maxlength="3"` field. The arcade look comes from the cells behind it, which are painted from
 * the value on every keystroke.
 *
 * **The cells are spans, not a styled input.** Letter-spacing a field into three slots depends on
 * the glyph advance of a font this game does not control (`ui-rounded` is SF Pro Rounded on iOS and
 * something else everywhere it is developed — see the fit-to-width saga in `homescreen.js`), so the
 * underscores drift out from under the letters on any face but the one it was eyeballed against.
 * Painting three fixed boxes and putting the text in them cannot drift.
 *
 * `text-transform: uppercase` is *not* what makes the name uppercase — that only changes what is
 * painted, and the value would still save as typed. `normaliseName` on every input event is.
 */
function buildEntry(root, rank, prefill, commit) {
  const wrap = el('div', 'score-entry');
  const lead = el('p', 'score-entry-lead',
    rank === 1 ? 'New high score!' : `${ORDINALS[rank - 1] ?? `${rank}th`} best run`);
  const hint = el('p', 'score-entry-hint', 'Enter your initials');

  const slots = el('div', 'score-slots');
  const cells = Array.from({ length: NAME_LENGTH }, () => el('span', 'score-cell'));
  slots.append(...cells);

  const input = el('input', 'score-input');
  input.type = 'text';
  input.maxLength = NAME_LENGTH;
  input.value = normaliseName(prefill);
  input.setAttribute('autocapitalize', 'characters');
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('aria-label', 'Your initials');
  slots.append(input);

  const ok = el('button', 'score-ok', 'OK');
  ok.type = 'button';

  wrap.append(lead, hint, slots, ok);

  /** Repaint the cells from the field, and mark the one the caret is sitting in. */
  const paint = () => {
    const text = input.value;
    cells.forEach((cell, index) => {
      cell.textContent = text[index] ?? '';
      cell.classList.toggle('is-filled', index < text.length);
      cell.classList.toggle('is-active',
        document.activeElement === input && index === Math.min(text.length, NAME_LENGTH - 1));
    });
  };

  input.addEventListener('input', () => {
    // Rewriting the value moves the caret to the end, which is where it already is for every
    // keystroke that survives the filter — and exactly where it should go for one that doesn't.
    input.value = normaliseName(input.value);
    paint();
  });
  /** The keyboard clamp's release while the field has focus, `null` when it doesn't. */
  let release = null;
  const unfollow = () => { release?.(); release = null; };

  input.addEventListener('focus', () => {
    paint();
    unfollow();
    release = followKeyboard(root, wrap);
  });
  input.addEventListener('blur', () => { paint(); unfollow(); });

  // The screen is leaving, so the overlay goes back to the full viewport before the board arrives
  // on it — the keyboard is on its way down and nothing after this point wants the clamp.
  const done = () => { unfollow(); commit(input.value); };
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    done();
  });
  ok.addEventListener('click', done);

  paint();

  return {
    node: wrap,
    focus() {
      input.focus({ preventScroll: true });
      // Puts the caret at the end of a pre-filled name rather than selecting it, so the first
      // keystroke of someone changing their initials doesn't wipe all three.
      input.setSelectionRange?.(input.value.length, input.value.length);
      paint();
    },
  };
}

/**
 * The table. Three columns — rank, name, score — laid out on the same `display: contents` grid the
 * stats use, which is what puts every column on one straight edge down the block.
 *
 * **One number per row.** A fares column sat between the name and the cash and it had to go: the
 * table ranks by a single score, and a second figure beside it invited the player to work out how
 * the two combined into the order they were looking at. They don't combine — the score is the cash
 * — so the row now shows exactly what it is sorted by and nothing else.
 *
 * The player's own row is picked out by id rather than by rank, because a run that ties an existing
 * score sits *below* it (see `compare` in `highscores.js`) and matching on the number would light
 * up the wrong row.
 */
function buildBoard(entries, youId) {
  const wrap = el('div', 'score-board');
  wrap.append(el('p', 'score-board-title', 'Leaderboard'));

  const list = el('ol', 'score-list');
  const rows = entries.map((entry, index) => {
    const row = el('li', 'score-row');
    if (youId && entry.id === youId) row.classList.add('is-you');
    row.append(
      el('span', 'score-rank', `${index + 1}.`),
      el('span', 'score-name', entry.name),
      el('span', 'score-cash', `$${scoreOf(entry)}`),
    );
    list.append(row);
    return row;
  });
  wrap.append(list);

  return {
    node: wrap,
    duration: Math.max(0, rows.length - 1) * SCORE_ROW_STRIDE + SCORE_ROW_MS,
    play(anims) {
      rows.forEach((row, index) => {
        anims.push(row.animate([
          { opacity: 0, transform: 'translateY(10px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ], {
          duration: SCORE_ROW_MS, delay: index * SCORE_ROW_STRIDE, easing: RISE, fill: 'backwards',
        }));
      });
    },
  };
}

/**
 * Build and reveal the overlay.
 *
 * `stats` is a list of `{ label, value, format }` — `format` turns the counter's integer into what
 * the player sees (the `$` prefix on Cash, the shift name on Shift), so the count-up itself never
 * has to know which stat it is rolling.
 *
 * `scores` is optional, and `null` means "no table on this screen" — a run played with the
 * difficulty pinned, or a browser with no storage to keep one in. When present it is
 * `{ entries, rank, id, name, onName }`: the table to show, this run's 1-based placing (or `null`
 * if it missed), the id of its row, the initials to pre-fill, and a commit that returns the table
 * as it stands afterwards. Only a run with a `rank` is asked to sign itself.
 */
export function showRunEnd(root, { title, reason, stats, scores = null, onRetry }) {
  root.innerHTML = '';
  root.hidden = false;

  const still = stillPlease();

  const card = el('div', 'run-end-card');
  const heading = el('strong', 'run-end-title', title);
  const sub = el('span', 'run-end-reason', reason ?? '');
  const body = el('div', 'run-end-body');

  const retry = el('button', 'retry', 'Play again');
  retry.type = 'button';
  retry.addEventListener('click', onRetry);

  const statsScreen = buildStats(stats);
  body.append(statsScreen.node);
  card.append(heading, sub, body, retry);
  root.append(card);
  matchReasonWidth(heading, sub);

  // The slot never shrinks below what the stats needed. Each screen holds a different amount of
  // content, and a card centred by `margin: auto` re-centres on every height change — so without
  // this the title would hop up and down the screen between beats. Only under motion: the reduced
  // path stacks its screens rather than swapping them, where a floor would just add dead space.
  if (!still) {
    const floor = body.getBoundingClientRect().height;
    if (floor > 0) body.style.minHeight = `${floor}px`;
  }

  // Nothing to click at until the button's entrance: it is transparent until then, and a disabled
  // button doesn't swallow the pointer, so a tap aimed at the invisible pill reaches the skip
  // instead of silently reloading the page.
  retry.disabled = true;
  retry.style.opacity = '0';

  /**
   * The current beat's fast-forward, or `null` when there is nothing to skip. Each phase installs
   * its own and clears it on the way out; the prompt leaves it null, which is what stops a stray
   * tap from blowing through a field the player is still typing in.
   */
  let skip = null;
  let timer = 0;
  root.addEventListener('pointerdown', () => skip?.());

  /**
   * Run one beat: `play` starts it, `ms` is how long it lasts, and `next` is what follows. Returns
   * a finish that is idempotent, so the timer and a tap racing each other cannot double-advance.
   */
  function beat(play, ms, next) {
    const anims = [];
    const landings = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      skip = null;
      clearTimeout(timer);
      for (const anim of anims) anim.finish();
      for (const land of landings) land();
      next();
    };
    play(anims, landings);
    if (still) { finish(); return; }
    skip = finish;
    timer = setTimeout(finish, ms);
  }

  /**
   * Cross-fade the body from whatever is in it to `next`, then carry on.
   *
   * Deliberately not skippable: it is a quarter of a second, and a tap that lands mid-handover has
   * nothing meaningful to jump to — the screen it would skip to has not been built yet.
   *
   * **Under reduced motion the screens stack instead of swapping.** The whole sequence resolves in
   * a single frame there, so a swap would replace the stats with the prompt before the stats had
   * been on screen for one — a player who opted out of animation would never see their own run
   * summary. Reduced motion means no movement, not less content, so everything is simply present at
   * once and the card scrolls if it has to. The prompt still gives way to the board, since a
   * filled-in form sitting above the table it produced is clutter rather than content.
   */
  function swapBody(next, then) {
    if (still) {
      const last = body.lastElementChild;
      if (last && last !== statsScreen.node) last.remove();
      body.append(next);
      then();
      return;
    }
    skip = null;
    const current = body.firstElementChild;
    const arrive = () => {
      body.replaceChildren(next);
      riseIn(next, 0, { from: 12, scale: 0.96, duration: SWAP_IN_MS });
      then();
    };
    if (!current) { arrive(); return; }
    const out = current.animate([
      { opacity: 1, transform: 'translateY(0)' },
      { opacity: 0, transform: 'translateY(-10px)' },
    ], { duration: SWAP_OUT_MS, easing: 'ease-in', fill: 'forwards' });
    out.onfinish = arrive;
  }

  // --- The sequence ---------------------------------------------------------

  function playRetry() {
    retry.style.opacity = '';
    retry.disabled = false;
    if (still) return;
    riseIn(retry, 0, { from: 10, scale: 0.9, duration: 420 });
  }

  function playBoard(entries) {
    const board = buildBoard(entries, scores?.id ?? null);
    swapBody(board.node, () => {
      beat((anims) => board.play(anims), board.duration + RETRY_GAP, playRetry);
    });
  }

  /**
   * The one beat with no timer on it. `skip` stays null for as long as the prompt is up, so a tap
   * anywhere on the blackout does nothing rather than committing a half-typed name — the player
   * leaves via Enter or the OK button, and both go through here.
   */
  function playEntry() {
    let committed = false;
    const entry = buildEntry(root, scores.rank, scores.name ?? '', (name) => {
      if (committed) return;
      committed = true;
      const updated = scores.onName?.(name);
      playBoard(Array.isArray(updated) ? updated : scores.entries);
    });
    swapBody(entry.node, () => {
      // Focus opens the software keyboard on desktop and Android. iOS only opens it inside a user
      // gesture, so there it stays shut until the player taps — which is what the cells are for:
      // the input is laid over them at full size, so a tap anywhere on the slots is a tap on the
      // field. The OK button is the way out for anyone who would rather not type at all.
      if (!still) entry.focus();
    });
  }

  function afterStats() {
    if (!scores) { playRetry(); return; }
    if (scores.rank) { playEntry(); return; }
    playBoard(scores.entries);
  }

  // Under reduced motion `beat` finishes synchronously, so the whole sequence collapses to its
  // final state in one frame — including, if the run placed, a prompt sitting there waiting to be
  // answered. That is the right end state: the animation is what is being opted out of, not the
  // chance to sign a high score.
  if (!still) {
    root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: REVEAL_MS, easing: 'ease-out' });
    riseIn(heading, TITLE_AT, { from: 18, scale: 0.92 });
    riseIn(sub, REASON_AT);
  }

  const startStats = () => beat(
    (anims, landings) => statsScreen.play(anims, landings),
    statsScreen.duration + HOLD_MS,
    afterStats,
  );

  // Under reduced motion the whole sequence resolves in this one call — every `beat` finishes the
  // instant it starts and each screen lands on its final frame — so there is nothing to wait for.
  if (still) startStats();
  else setTimeout(startStats, STATS_AT);
}
