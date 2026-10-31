/**
 * The week (Tyler, 2026-10-31; design in project-files shifts/proposal.md). The game is a run of
 * days, each one a timed shift with an earnings target: survive to the buzzer with the target in
 * hand and the day is cleared, and the next one is up. A wreck, a bust or a buzzer short of the
 * target fails it, and a failed day is played again from the top **with its cash lost** — only a
 * cleared day banks what it earned (`bank`), for the store that will spend it later.
 *
 * Pure and DOM-free like difficulty.js: the table, and a save over whatever store it is handed.
 * main.js reads the day once at boot and writes it once at the end of the shift.
 *
 * The two knobs that make a day harder are its clock and its target (Tyler: "we fix the clock and
 * target earnings, we can tune both"); `floor` starts the difficulty ramp part way up, so a later
 * day opens where an earlier one was finishing. Events are the other half of a day, and only the
 * ones that are *events*: the bank robbery and the street race. The garbage truck, the drawbridge,
 * the fire and the patrols are the world, and run every day (Tyler, 2026-10-30).
 *
 * UNTUNED. The targets are a first guess off FARE_CYCLE (35s a delivery for a player who boosts when
 * behind, ~$25-30 a fare early on) and every clock is the shipped SHIFT_SECONDS, which keeps each day
 * ranked on the shift table. Sweep before trusting any row.
 */

/**
 * `bank`: 'off' — no bank rider at all; 'on' — the ordinary chance; 'force' — the bank rider is the
 * first spawn the bank is allowed and is always the robbery (what demo mode does).
 * `race`: whether a racer can turn up.
 */
export const DAYS = Object.freeze([
  { key: 'fri', name: 'Friday', seconds: 300, target: 150, floor: 0, bank: 'off', race: false },
  { key: 'sat', name: 'Saturday', seconds: 300, target: 250, floor: 0.15, bank: 'off', race: true },
  // The bank's closed on a Sunday.
  { key: 'sun', name: 'Sunday', seconds: 300, target: 300, floor: 0.3, bank: 'off', race: true },
  // The robbery, guaranteed; the robo-taxis roll out at Monday's buzzer (not built yet).
  { key: 'mon', name: 'Monday', seconds: 300, target: 400, floor: 0.4, bank: 'force', race: true },
]);

const STORE_KEY = 'simtaxi.days';

/** The day a key names, or null. For `?day=`. */
export const dayByKey = (key) => DAYS.findIndex((d) => d.key === key);

function read(store) {
  try {
    const raw = JSON.parse(store?.getItem(STORE_KEY) ?? 'null');
    const day = Number.isInteger(raw?.day) ? Math.min(Math.max(raw.day, 0), DAYS.length - 1) : 0;
    const bank = Number.isFinite(raw?.bank) ? Math.max(0, raw.bank) : 0;
    return { day, bank, weeks: Number.isInteger(raw?.weeks) ? raw.weeks : 0 };
  } catch {
    // A store that throws (file://, a private window) plays Friday every time; nothing is lost
    // that was ever saved.
    return { day: 0, bank: 0, weeks: 0 };
  }
}

function write(store, save) {
  try { store?.setItem(STORE_KEY, JSON.stringify(save)); } catch { /* see read() */ }
}

/** Where the week stands: the day to play (an index into DAYS) and the cash banked by cleared days. */
export const loadWeek = (store) => read(store);

/**
 * The shift is over and the target was made: bank the day's earnings and move on. The last day
 * clears the week and plays again (the robo-taxis' days are not built), so `weeks` counts how many
 * times that has happened. Answers the save as written.
 */
export function clearDay(store, dayIndex, earned) {
  const save = read(store);
  save.bank += Math.max(0, earned);
  if (dayIndex >= DAYS.length - 1) { save.weeks += 1; save.day = DAYS.length - 1; }
  else save.day = dayIndex + 1;
  write(store, save);
  return save;
}

/** Back to Friday with nothing banked. The ⚙️ panel's reset and the tools. */
export function resetWeek(store) {
  try { store?.removeItem(STORE_KEY); } catch { /* see read() */ }
}

/** Did a shift that ended with this much cash make the day? */
export const madeTarget = (money, target) => target === null || money >= target;
