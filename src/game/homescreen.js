/**
 * The "add it to your Home Screen" screen — iOS only, and only in a browser tab.
 *
 * The game is already a home-screen app in everything but installation: `index.html` ships the
 * apple-touch icons, the web-app title and `apple-mobile-web-app-capable`, so launching it from the
 * Home Screen drops the browser's chrome and gives the fixed 3/4 camera the whole screen. In a tab
 * it loses the top bar and the bottom toolbar to browser furniture, and — the part that actually
 * hurts — the toolbar slides in and out as the page is touched, which resizes the viewport mid-run
 * and moves the camera's framing under the player.
 *
 * **iOS is the only platform that needs this.** Everywhere else the browser offers installation
 * itself: Chrome and Edge fire `beforeinstallprompt` and put their own affordance in the address
 * bar, and a page-drawn screen would be a second, worse copy of it. iOS Safari fires nothing and
 * hides the action three taps deep in the share sheet, which is why it has to be described in
 * words rather than triggered.
 *
 * **Detection is two questions, not one:** is this iOS, and is the page already running as an
 * installed app. Both have a trap:
 *
 * - iPadOS 13+ sends a desktop user-agent string by default, so `/iPad/` misses every modern iPad.
 *   `MacIntel` + a touch screen is the standard tell — a real Mac reports `maxTouchPoints === 0`
 *   even with a trackpad, since a trackpad is a pointer and not a touch digitiser.
 * - `navigator.standalone` is the iOS-specific flag and the only signal older Safari sets; the
 *   `display-mode: standalone` media query is the standard one and covers Safari 16.4+ and every
 *   other engine. Either being true means the icon launched us, so there is nothing to suggest.
 *
 * Both are read at call time rather than at import, so the module boots in node for `npm run check`.
 *
 * **The steps are the browser's, not iOS's.** Every iOS browser is WebKit underneath, but they do
 * not share a route to the share sheet: Safari puts Share in the toolbar, Chrome and Edge bury it
 * behind their own ⋯ button, Firefox behind ≡. A list that named the wrong first tap would send the
 * player hunting for a control that isn't on their screen, which is worse than not asking at all —
 * so the list is built per browser and Safari's is one step shorter.
 *
 * **It holds the run.** Unlike the toast it replaced, this covers the screen and waits to be
 * tapped, so `state.holding` is true from the moment the module decides to show — main.js keeps the
 * fare system parked while it is set. Without that a rider would spawn behind the overlay with a
 * 60-second clock already draining, and a player who read the screen slowly would lose a run they
 * had not started. Holding from *creation* rather than from the reveal matters: the screen appears
 * a beat after load, and a fare spawned inside that beat would be exactly the bug.
 *
 * `?hometip` in the URL forces the screen up regardless — this whole path is invisible on a desktop
 * otherwise, so laying it out would mean a phone round trip per pixel.
 */

// A beat after load, not on it: the city paints, and the screen sinks it rather than replacing it.
// Shorter than the toast's delay was, because this one is a gate and the run is waiting on it.
const SHOW_AT = 800;

// It covers the screen and has to be dismissed by hand, so being shown *is* being acknowledged —
// there is no version of this where asking a second time is a service. (The counter rather than a
// boolean so the number is the only thing to change if that turns out to be wrong.)
const MAX_SHOWINGS = 1;
const STORE_KEY = 'simtaxi.homescreen.seen';

const RISE = 'cubic-bezier(0.22, 1, 0.36, 1)';   // the entrance every other overlay in the game uses

/** True on iPhone, iPod, and iPad including the desktop-UA ones. See the header for the trap. */
function isIOS() {
  const ua = navigator.userAgent ?? '';
  if (/iPhone|iPod|iPad/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1;
}

/** True when the page was launched from a Home Screen icon rather than opened in a tab. */
function isInstalled() {
  if (navigator.standalone === true) return true;
  return window.matchMedia?.('(display-mode: standalone)').matches ?? false;
}

// Safari in private browsing used to throw from `setItem` rather than no-op, and a storage
// exception here would take the whole boot down over a nudge. Failing to read means "never seen",
// failing to write means it shows again next load — both are the harmless direction.
function readShowings() {
  try {
    return Number.parseInt(window.localStorage.getItem(STORE_KEY) ?? '0', 10) || 0;
  } catch {
    return 0;
  }
}
function writeShowings(count) {
  try {
    window.localStorage.setItem(STORE_KEY, String(count));
  } catch { /* storage unavailable — the count just doesn't persist */ }
}

const stillPlease = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// --- The glyphs -------------------------------------------------------------
// Drawn rather than typed. None of these are characters in a font we can rely on, and the emoji
// nearest each is a different shape — a wrong-looking icon next to the word is exactly what sends
// someone hunting for a control that isn't there. Each is drawn as the button actually looks: the
// browsers' menu buttons wear a circle, Safari's toolbar Share does not.

const svgEl = (viewBox, markup) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = markup;
  return svg;
};

/** iOS's share glyph: a box with an arrow leaving the top of it. */
const shareGlyph = () => svgEl('0 0 24 24',
  '<path d="M12 2.6 8.4 6.2M12 2.6l3.6 3.6M12 2.6v11.2" />'
  + '<path d="M7.4 9.6H5.4v11.8h13.2V9.6h-2" />');

/** Chrome's and Edge's ⋯ button — three dots inside a ring. */
const ellipsisGlyph = () => svgEl('0 0 24 24',
  '<circle cx="12" cy="12" r="10" />'
  + '<circle class="dot" cx="7.1" cy="12" r="1.7" /><circle class="dot" cx="12" cy="12" r="1.7" />'
  + '<circle class="dot" cx="16.9" cy="12" r="1.7" />');

/** Firefox's ≡ button. */
const menuGlyph = () => svgEl('0 0 24 24',
  '<path d="M4 7.5h16M4 12h16M4 16.5h16" />');

/**
 * The taps that actually reach "Add to Home Screen" in the browser we are in.
 *
 * Safari's Share is in the toolbar, so its list is two steps. Chrome and Edge hide it behind ⋯ and
 * Firefox behind ≡, so those get a third step in front naming their own button. The final step is
 * the share sheet's own wording in every case — that is the row the player has to find in a list of
 * twenty, so it is quoted exactly rather than paraphrased.
 *
 * **Only the first step carries a glyph**, because only the first step is a hunt: it names a
 * control somewhere in the browser's chrome that the player has to spot. Everything after it is a
 * row in a sheet they are already looking at, labelled in words, and drawing an icon beside those
 * would be decorating rather than pointing.
 */
function stepsFor(ua = navigator.userAgent ?? '') {
  const share = { label: 'Share' };
  const install = { label: 'Add to Home Screen' };
  if (/CriOS|EdgiOS/.test(ua)) return [{ label: 'More', glyph: ellipsisGlyph }, share, install];
  if (/FxiOS/.test(ua)) return [{ label: 'Menu', glyph: menuGlyph }, share, install];
  return [{ ...share, glyph: shareGlyph }, install];
}

/**
 * Build and show the screen. Returns `null` when it doesn't apply — not iOS, already installed, or
 * already acknowledged — so the caller can treat "nothing to do" as the normal case.
 *
 * `root` is the `#home-tip` element in the markup, empty until this fills it, the same arrangement
 * `showRunEnd` uses for `#run-end`. `onHide` fires once, when the screen is done and the run may
 * start.
 */
export function showHomeScreenTip(root, { force = false, onHide } = {}) {
  if (!root) return null;
  if (!force) {
    if (!isIOS() || isInstalled()) return null;
    const seen = readShowings();
    if (seen >= MAX_SHOWINGS) return null;
  }
  writeShowings(MAX_SHOWINGS);

  const sheet = document.createElement('div');
  sheet.className = 'home-tip-sheet';

  const lead = document.createElement('p');
  lead.className = 'home-tip-lead';
  lead.textContent = 'For the best experience:';

  // A real <ol> so the numbers are the list's, not text baked into each line. It lays out as a
  // two-column grid with the items as `display: contents`, the same trick the run-end stats use —
  // that is what puts every number and every label on one straight edge apiece.
  const list = document.createElement('ol');
  list.className = 'home-tip-steps';
  stepsFor().forEach((step, index) => {
    const row = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'step-index';
    n.textContent = `${index + 1}.`;
    const name = document.createElement('span');
    name.className = 'step-name';
    name.textContent = step.label;
    if (step.glyph) name.append(step.glyph());
    row.append(n, name);
    list.append(row);
  });

  const hint = document.createElement('p');
  hint.className = 'home-tip-hint';
  hint.textContent = 'Tap anywhere to continue';

  sheet.append(lead, list, hint);
  root.append(sheet);
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Add Sim Taxi to your Home Screen');
  root.hidden = false;

  /**
   * Shrink the block until its longest line fits across the screen.
   *
   * The strings are fixed and the viewport is not: "3. Add to Home Screen" is eighteen characters
   * of heavy type that has to sit on one line — wrapping it under its own number breaks the second
   * straight edge the grid exists to hold — and it has to do that on a 320px phone as well as a
   * 430px one. Worse, the width it needs depends on a font we do not control: `ui-rounded` is SF
   * Pro Rounded on iOS but something else wherever this is being *developed*, and rounded faces run
   * wide. Any single `vw` coefficient is therefore a guess that is wrong on some device.
   *
   * So it is measured rather than guessed. The CSS clamp stays the *ideal* size and this only ever
   * scales down from it, against the widest line actually rendered — which is the lead or a step
   * row, whichever wins. Everything in the sheet is sized in `em` off one font-size, so one number
   * moves the whole block and the design's proportions survive the shrink.
   */
  const fitToWidth = () => {
    sheet.style.fontSize = '';                 // measure against the CSS ideal, not last fit
    const room = list.clientWidth;
    if (!room) return;                         // hidden or not laid out yet
    const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
    // `scrollWidth` rather than `clientWidth`: these are `nowrap`, so when a line is too long the
    // grid overflows and only the scroll width still reports what it actually wanted.
    const rows = [...list.children].map((row) => {
      const [index, name] = row.children;
      return index.scrollWidth + gap + name.scrollWidth;
    });
    const widest = Math.max(lead.scrollWidth, ...rows);
    if (widest <= room) return;
    const ideal = Number.parseFloat(getComputedStyle(sheet).fontSize);
    sheet.style.fontSize = `${(ideal * (room / widest)).toFixed(2)}px`;
  };

  fitToWidth();
  // Rotating the phone changes the axis the clamp is sized against and the room the line has, so
  // the fit has to be redone rather than carried over from portrait.
  window.addEventListener('resize', fitToWidth);

  let gone = false;
  const hide = () => {
    if (gone) return;
    gone = true;
    root.removeEventListener('pointerdown', hide);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', fitToWidth);
    // Stop taking taps the instant it is dismissed, so the fade-out doesn't swallow the first tap
    // aimed at the game underneath it.
    root.style.pointerEvents = 'none';
    const done = () => {
      root.hidden = true;
      root.innerHTML = '';
      root.style.pointerEvents = '';
      onHide?.();
    };
    if (stillPlease()) { done(); return; }
    root.animate([{ opacity: 1 }, { opacity: 0 }],
      { duration: 260, easing: 'ease-in', fill: 'forwards' }).onfinish = done;
  };

  const onKey = (event) => {
    // Desktop only in practice (`?hometip`), but a screen that can only be dismissed by touch is a
    // dead end for anyone driving the page from a keyboard.
    if (['Escape', 'Enter', ' ', 'Spacebar'].includes(event.key)) { event.preventDefault(); hide(); }
  };

  // Anywhere at all, as the screen says. `pointerdown` rather than `click` so it goes on the press:
  // the matching release then lands on the canvas with no `click` following it, because the two
  // ends of the gesture are on different elements — so the tap that dismisses this cannot also
  // dispatch the taxi.
  root.addEventListener('pointerdown', hide);
  window.addEventListener('keydown', onKey);

  if (!stillPlease()) {
    root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease-out' });
    // The sheet arrives after the black does, so the city sinks first and the words land on it.
    sheet.animate([
      { opacity: 0, transform: 'translateY(22px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 540, delay: 90, easing: RISE, fill: 'backwards' });
  }

  return { hide };
}

/**
 * The whole feature, on the caller's behalf: wait a beat, then show the screen if it applies.
 * Returns `null` when it was never going to show — which is every desktop load, so the caller can
 * fire this unconditionally — or a handle whose `state.holding` is true for as long as the run
 * should stay parked. See the header for why that starts before the screen is visible.
 */
export function createHomeScreenTip(root, { force = false, delay = SHOW_AT } = {}) {
  if (!root) return null;
  if (!force && (!isIOS() || isInstalled() || readShowings() >= MAX_SHOWINGS)) return null;

  const state = { holding: true };
  let tip = null;
  const release = () => { state.holding = false; };
  const timer = setTimeout(() => {
    if (state.holding) tip = showHomeScreenTip(root, { force, onHide: release });
    // Nothing to show after all (the checks run again at reveal time): let the run start rather
    // than parking the fare system for the rest of the session.
    if (!tip) release();
  }, delay);

  return {
    state,
    hide: () => { clearTimeout(timer); tip?.hide(); release(); },
  };
}
