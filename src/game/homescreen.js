/**
 * The "add it to your Home Screen" nudge — iOS only, and only in a browser tab.
 *
 * The game is already a home-screen app in everything but installation: `index.html` ships the
 * apple-touch icons, the web-app title and `apple-mobile-web-app-capable`, so launching it from the
 * Home Screen drops Safari's chrome and gives the fixed 3/4 camera the whole screen. In a tab it
 * loses the top bar and the bottom toolbar to browser furniture, and — the part that actually hurts
 * — the toolbar slides in and out as the page is touched, which resizes the viewport mid-run and
 * moves the camera's framing under the player. So the prompt is worth showing, once the player is
 * in a position to act on it.
 *
 * **iOS is the only platform that needs this.** Everywhere else the browser offers installation
 * itself: Chrome and Edge fire `beforeinstallprompt` and put their own affordance in the address
 * bar, and a page-drawn nudge would be a second, worse copy of it. iOS Safari fires nothing and
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
 * `?hometip` in the URL forces the card up regardless — this whole path is invisible on a desktop
 * otherwise, so laying out the card would mean a phone round trip per pixel.
 */

// A beat after load, not on it: the card lands on a city that has already painted, so it reads as a
// note about the game rather than as something standing between the player and it.
const SHOW_AT = 1400;

// Long enough to read twice, short enough that a player who is already driving isn't stuck with it.
// Tapping it dismisses it sooner, which is what most people will do.
const AUTO_HIDE = 11000;

// It is a suggestion, and a suggestion that returns forever is a nag. Three loads is enough for a
// player who ignored the first one to notice the third; an explicit dismiss ends it immediately.
const MAX_SHOWINGS = 3;
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

/**
 * iOS's share glyph, drawn rather than typed. The system icon is not a character in any font we can
 * rely on and the emoji nearest it is a different shape, so a wrong-looking square-and-arrow next to
 * the word "Share" would send the player hunting for a control that isn't there. Sized in `em` so it
 * tracks the line it sits on.
 */
function shareGlyph() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<path d="M12 2.6 8.4 6.2M12 2.6l3.6 3.6M12 2.6v11.2" />'
                + '<path d="M7.4 9.6H5.4v11.8h13.2V9.6h-2" />';
  return svg;
}

/**
 * Build and show the card. Returns `null` when it doesn't apply — not iOS, already installed, or
 * already shown its three times — so the caller can treat "nothing to do" as the normal case.
 *
 * `root` is the `#home-tip` element in the markup, empty until this fills it, the same arrangement
 * `showRunEnd` uses for `#run-end`.
 */
export function showHomeScreenTip(root, { force = false } = {}) {
  if (!root) return null;
  if (!force) {
    if (!isIOS() || isInstalled()) return null;
    const seen = readShowings();
    if (seen >= MAX_SHOWINGS) return null;
    writeShowings(seen + 1);
  }

  const card = document.createElement('div');
  card.className = 'home-tip-card';

  const title = document.createElement('strong');
  title.className = 'home-tip-title';
  title.textContent = 'Best experienced when adding to Home';

  // The instruction, as three named things in the order they are tapped. Naming the share sheet's
  // own wording — "Add to Home Screen" — matters more than brevity: it is what the player has to
  // find in a list of twenty rows.
  const steps = document.createElement('span');
  steps.className = 'home-tip-steps';
  steps.append('Tap ', shareGlyph(), ' Share, then ');
  const action = document.createElement('b');
  action.textContent = 'Add to Home Screen';
  steps.append(action);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'home-tip-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '✕';

  card.append(title, steps, close);
  root.append(card);
  root.hidden = false;

  let gone = false;
  let hideTimer = 0;

  /** Take it off screen. `forGood` is the explicit dismiss — it stops the card returning at all. */
  const hide = (forGood) => {
    if (gone) return;
    gone = true;
    clearTimeout(hideTimer);
    if (forGood) writeShowings(MAX_SHOWINGS);
    const done = () => { root.hidden = true; root.innerHTML = ''; };
    if (stillPlease()) { done(); return; }
    const out = card.animate([
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(-10px) scale(0.96)' },
    ], { duration: 220, easing: 'ease-in', fill: 'forwards' });
    out.onfinish = done;
  };

  // Anywhere on the card dismisses it, not just the ✕. There is nothing to interact with here and
  // the target is a small pill on a phone, so demanding a hit on an 18px glyph would leave players
  // batting at it — and a stray tap that *misses* the card still reaches the game underneath,
  // because the card is the only thing here with pointer events.
  card.addEventListener('click', () => hide(true));

  if (!stillPlease()) {
    card.animate([
      { opacity: 0, transform: 'translateY(-14px) scale(0.94)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' },
    ], { duration: 460, easing: RISE, fill: 'backwards' });
  }

  // Times out on its own, and *not* for good: a player who never looked at it hasn't declined it.
  hideTimer = setTimeout(() => hide(false), AUTO_HIDE);

  return { hide: () => hide(false) };
}

/**
 * The whole feature, on the caller's behalf: wait a beat, then show the card if it applies. Returns
 * a handle to dismiss it early, or `null` when it was never going to show — which is every desktop
 * load, so the caller can fire this unconditionally.
 */
export function createHomeScreenTip(root, { force = false, delay = SHOW_AT } = {}) {
  if (!root) return null;
  if (!force && (!isIOS() || isInstalled() || readShowings() >= MAX_SHOWINGS)) return null;
  let tip = null;
  let cancelled = false;
  const timer = setTimeout(() => {
    if (!cancelled) tip = showHomeScreenTip(root, { force });
  }, delay);
  return {
    hide: () => { cancelled = true; clearTimeout(timer); tip?.hide(); },
  };
}
