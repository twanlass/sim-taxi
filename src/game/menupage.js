/**
 * The pieces the title screen and the pause screen share: a sub-page with "‹ Back" over its
 * header, and the Settings rows that go on one.
 *
 * Both screens build their *own* Settings page from these rather than sharing one node, because
 * the two overlays sit at different depths (the title screen over the pause veil it holds back)
 * and are never up together — moving one page between them would only add a way for it to be in
 * the wrong one. The styles are shared the same way: index.html scopes them to
 * `:is(#title-screen, #pause-veil)`.
 */

import { isNative } from '../util/platform.js';

/** One element, with a class and optional text. */
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A sub-page: "‹ Back" over its header, then whatever `body` holds. */
export function menuPage(name, title, onBack) {
  const section = el('section', `title-view title-page title-${name}`);
  section.setAttribute('aria-label', title);
  const back = el('button', 'title-back');
  back.type = 'button';
  back.append(el('span', 'title-back-chevron', '‹'), el('span', null, 'Back'));
  back.addEventListener('click', onBack);
  const header = el('h2', 'title-header', title);
  const body = el('div', 'title-body');
  section.append(back, header, body);
  return { section, back, body };
}

/** An on/off row: the whole row is the switch, so the label is a target too. */
function toggleRow(label, read, write) {
  const row = el('button', 'title-row title-toggle');
  row.type = 'button';
  row.setAttribute('role', 'switch');
  const knob = el('span', 'title-switch');
  knob.append(el('span', 'title-switch-dot'));
  row.append(el('span', 'title-label', label), knob);
  const paint = () => row.setAttribute('aria-checked', String(read()));
  row.addEventListener('click', () => { write(!read()); paint(); });
  paint();
  return { row, paint };
}

/** A 0..1 slider row. The fill left of the thumb is a CSS variable, since range inputs have no
 *  standard "progress" part to style. */
function sliderRow(label, read, write) {
  const row = el('label', 'title-row title-slider');
  const input = el('input');
  input.type = 'range';
  input.min = '0';
  input.max = '100';
  input.step = '1';
  input.setAttribute('aria-label', label);
  const paint = () => {
    const v = Math.round(read() * 100);
    input.value = String(v);
    input.style.setProperty('--fill', `${v}%`);
  };
  input.addEventListener('input', () => {
    write(Number(input.value) / 100);
    input.style.setProperty('--fill', `${input.value}%`);
  });
  row.append(el('span', 'title-label', label), input);
  paint();
  return { row, paint };
}

/**
 * The Settings rows, appended to `body`. Returns `refresh()`, to be called each time the page comes
 * up: the sound switch is the one setting that can change from outside the page (M, or the other
 * screen's copy of it), so it is re-read rather than trusted.
 *
 * `tips: false` leaves the Tutorial tips row out. The pause screen does: the tips are read once, on
 * Play, so a switch mid-run would move and change nothing.
 *
 * @param {HTMLElement} body
 * @param {object} opts
 * @param {{ isOn: () => boolean, set: (on: boolean) => void }} opts.sound  The game's one mute.
 * @param {ReturnType<import('./settings.js').createSettings>} opts.settings
 * @param {boolean} [opts.tips]
 */
export function settingsRows(body, { sound, settings, tips = true }) {
  const soundRow = toggleRow('Sound', () => sound.isOn(), (on) => { sound.set(on); paintMuted(); });
  const musicRow = sliderRow('Music volume', () => settings.get().music, (v) => settings.set({ music: v }));
  const sfxRow = sliderRow('SFX volume', () => settings.get().effects,
    (v) => settings.set({ effects: v }));
  // The two sliders still move while the sound is off — a player setting levels before unmuting is
  // a reasonable thing to do — but they read as asleep, which says why moving them is silent.
  const paintMuted = () => {
    const off = !sound.isOn();
    musicRow.row.classList.toggle('is-asleep', off);
    sfxRow.row.classList.toggle('is-asleep', off);
  };
  paintMuted();
  body.append(soundRow.row, musicRow.row, sfxRow.row);
  if (tips) {
    const tipsRow = toggleRow('Tutorial tips', () => settings.get().tips, (on) => settings.set({ tips: on }));
    body.append(tipsRow.row);
  }
  // Haptics only exist inside the iOS app (util/haptics.js), so on the web the rows would be two
  // switches that do nothing. "Combo haptics" off plays the combos as the plain knocks they had
  // before their patterns — kept as a switch so the two can be compared on the phone, mid-run,
  // from the pause screen.
  const hapticRows = [];
  if (isNative()) {
    const hapticsRow = toggleRow('Haptics', () => settings.get().haptics, (on) => {
      settings.set({ haptics: on });
      paintHaptics();
    });
    const comboRow = toggleRow('Combo haptics', () => settings.get().comboHaptics,
      (on) => settings.set({ comboHaptics: on }));
    hapticRows.push(hapticsRow, comboRow);
    body.append(hapticsRow.row, comboRow.row);
  }
  const paintHaptics = () => hapticRows[1]?.row.classList.toggle('is-asleep', !settings.get().haptics);
  paintHaptics();
  return {
    refresh() {
      soundRow.paint();
      musicRow.paint();
      sfxRow.paint();
      paintMuted();
      for (const r of hapticRows) r.paint();
      paintHaptics();
    },
  };
}
