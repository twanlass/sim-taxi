/**
 * The depot's upgrade menu — the card that comes up behind the shut garage door on a visit.
 *
 * Built from script into `#upgrade-menu` (index.html carries the empty element and the styles),
 * the way the run-end card is. It owns no prices and no levels: everything it shows is read from
 * game/upgrades.js on every paint, and a press is handed to `onBuy`, which owns the till.
 *
 * **It holds the visit, not the game.** The fare clocks are already held for the whole visit
 * (`holdFareClocks` in main.js) and the taxi is staged in the bay, so nothing the player can lose
 * is running while it is up; the opening's `repair` phase simply does not end until it is closed
 * (`hold` on `enter` in game/opening.js). Traffic keeps driving outside, which is what you would
 * expect of a garage.
 *
 * Buttons act on `click`, not `pointerdown`: the card covers the canvas, so a release cannot land
 * on the city and dispatch the taxi, and a click is what a keyboard activation fires too.
 */
import { UPGRADES } from './upgrades.js';

/**
 * @param root      `#upgrade-menu`, or null (shot mode, the lab) — then this returns null
 * @param upgrades  game/upgrades.js
 * @param money     () => cash the player can spend right now
 * @param owed      () => the repair bill still to come off the till on the way out, or 0
 * @param onBuy     (id) => void — take the money and apply the level; the menu repaints after
 */
export function createUpgradeMenu({ root, upgrades, money, owed = () => 0, onBuy }) {
  if (!root) return null;
  let open = false;
  let onClose = null;

  function paint() {
    const cash = money();
    const rows = UPGRADES.map((u) => {
      const level = upgrades.level(u.id);
      const max = upgrades.maxLevel(u.id);
      const price = upgrades.price(u.id);
      const pips = Array.from({ length: max }, (_, k) =>
        `<span class="upgrade-pip${k < level ? ' is-on' : ''}"></span>`).join('');
      const label = price == null ? 'Maxed' : `$${price}`;
      const disabled = price == null || price > cash ? ' disabled' : '';
      return `<div class="upgrade-row">
        <div class="upgrade-text">
          <div class="upgrade-name">${u.name}</div>
          <div class="upgrade-blurb">${u.blurb}</div>
          <div class="upgrade-pips">${pips}</div>
        </div>
        <button class="upgrade-buy" type="button" data-id="${u.id}"${disabled}>${label}</button>
      </div>`;
    }).join('');
    root.innerHTML = `<div class="upgrade-card">
      <div class="upgrade-title">Taxi Depot</div>
      <div class="upgrade-cash">Cash: $${Math.floor(cash)}${owed() > 0 ? ` <span class="upgrade-owed">after $${owed()} repairs</span>` : ''}</div>
      ${rows}
      <button class="upgrade-done" type="button">Back to work</button>
    </div>`;
  }

  root.addEventListener('click', (event) => {
    const buy = event.target.closest?.('.upgrade-buy');
    if (buy && !buy.disabled) {
      onBuy(buy.dataset.id);
      paint();
      return;
    }
    if (event.target.closest?.('.upgrade-done')) close();
  });

  function close() {
    if (!open) return;
    open = false;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    const done = onClose;
    onClose = null;
    done?.();
  }

  return {
    /** Put the card up. `then` fires once when it is closed, by the player or by `close()`. */
    show(then = null) {
      onClose = then;
      open = true;
      paint();
      root.hidden = false;
      root.setAttribute('aria-hidden', 'false');
    },
    close,
    isOpen: () => open,
  };
}
