/**
 * The day's name, big and centred, before anything else of the run (Tyler, 2026-10-31: "before the
 * story starts we should show the day in big white letters / black outline center center"). White
 * with the pop text's dark stroke (`.earning` in index.html), so it reads as the game's own type
 * over any part of the city. It punches in, holds, and fades; a tap or Enter/Space cuts the hold
 * short. `#day-card` in index.html carries the look.
 *
 * Calls `done` once, as the fade starts, so whatever follows — the backstory, or nothing — begins
 * under the card's exit rather than after a blank beat.
 */
const IN_MS = 380;
const HOLD_MS = 1500;
const OUT_MS = 420;

export function showDayCard(parent, name, done) {
  const card = document.createElement('div');
  card.id = 'day-card';
  card.setAttribute('role', 'status');
  const word = document.createElement('span');
  word.className = 'day-card-word';
  word.textContent = name;
  card.append(word);
  parent.append(card);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    window.removeEventListener('keydown', onKey, true);
    card.classList.add('is-out');
    setTimeout(() => card.remove(), OUT_MS);
    done?.();
  };
  const onKey = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  card.addEventListener('pointerdown', (event) => { event.stopPropagation(); close(); });
  window.addEventListener('keydown', onKey, true);
  const timer = setTimeout(close, IN_MS + HOLD_MS);
  return { close };
}
