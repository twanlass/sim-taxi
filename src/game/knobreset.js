// The ↺ beside each control in the ⚙️ panel: one click puts that knob back where it stood before
// you first touched it, for flicking between "this" and "what it was" while tuning by ear or eye.
//
// The baseline is taken on the first *touch*, not when the control is built, and that is not a
// nicety. Several controls are built at a placeholder and painted afterwards — every audio slider
// is made at 0 and only then set from the live mix — and the daylight ones move on their own while
// the cycle runs, so "the value at construction" would be 0 for one family and a stale hour for the
// other. The value under the finger at the first pointerdown or key is what the player was looking
// at when they decided to change it.
//
// Restoring goes through the control's own `input` and `change` events rather than a setter of its
// own, so each control's existing handler does whatever that knob already does — retune the mix,
// take manual control of the sun, save the Loco stash — and nothing here needs to know which.

export function attachKnobReset(input) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'dbg-reset';
  button.textContent = '↺';
  button.title = 'Back to the value before you changed it';
  button.setAttribute('aria-label', 'Reset');

  let baseline = null;
  const take = () => { if (baseline === null) baseline = input.value; };
  // `input` is the fallback for a change that came with no pointer or key first (a colour picker's
  // native dialog, say); by then the value has already moved, so it only catches the *next* edit.
  input.addEventListener('pointerdown', take);
  input.addEventListener('keydown', take);
  input.addEventListener('focus', take);

  // Some panels repaint their controls without firing `input` (Reset to shipped mix, the daylight
  // cycle), so the button's state is rechecked whenever the pointer comes near it, too.
  const sync = () => { button.classList.toggle('is-on', baseline !== null && input.value !== baseline); };
  input.addEventListener('input', sync);
  input.addEventListener('change', sync);

  button.addEventListener('click', (event) => {
    // The control lives in a <label>, which would otherwise forward the click to the input.
    event.preventDefault();
    if (baseline === null || input.value === baseline) return;
    input.value = baseline;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
  });

  return { button, sync };
}
