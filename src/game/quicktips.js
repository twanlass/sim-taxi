// Tooltips for the debug tools that show in a blink rather than a second.
//
// The browser's own `title` tooltip waits about a second and nothing a page does can shorten it,
// which is far too slow for a panel you read while dragging sliders. So this takes the `title` over:
// on hover it moves the text to `data-tip` (so the native one never also appears) and shows it in
// one shared box after DELAY ms. Moving it on hover rather than once up front means a title set
// later — the music ▶ that becomes a ■ rewrites its own — is picked up the next time it is hovered.
//
// Debug only: attached to the ⚙️ panel and the map's sound pins, never to the game's own UI.

const DELAY = 120;
const GAP = 12;

let box = null;
function tipBox() {
  if (!box) {
    box = document.createElement('div');
    box.id = 'quick-tip';
    box.hidden = true;
    document.body.append(box);
  }
  return box;
}

/** Give everything under `root` with a `title` the fast tooltip. */
export function attachQuickTips(root) {
  let timer = 0;
  let current = null;
  let at = { x: 0, y: 0 };

  const hide = () => {
    clearTimeout(timer);
    current = null;
    if (box) box.hidden = true;
  };
  function place() {
    const b = tipBox();
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    // Below-right of the pointer, flipped to the other side where it would leave the window.
    let x = at.x + GAP;
    let y = at.y + GAP;
    if (x + w > window.innerWidth - 8) x = Math.max(8, at.x - GAP - w);
    if (y + h > window.innerHeight - 8) y = Math.max(8, at.y - GAP - h);
    b.style.transform = `translate(${x}px, ${y}px)`;
  }

  root.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return;
    const el = event.target.closest?.('[title], [data-tip]');
    if (!el || !root.contains(el)) { hide(); return; }
    if (el.hasAttribute('title')) {
      const text = el.getAttribute('title');
      el.removeAttribute('title');
      if (text) el.dataset.tip = text; else delete el.dataset.tip;
    }
    if (!el.dataset.tip) { hide(); return; }
    if (el === current) return;
    hide();
    current = el;
    at = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      if (current !== el) return;
      const b = tipBox();
      b.textContent = el.dataset.tip;
      b.hidden = false;
      place();
    }, DELAY);
  });
  root.addEventListener('pointermove', (event) => {
    at = { x: event.clientX, y: event.clientY };
    if (box && !box.hidden) place();
  });
  root.addEventListener('pointerleave', hide);
  root.addEventListener('pointerdown', hide);
  root.addEventListener('scroll', hide, true);
}
