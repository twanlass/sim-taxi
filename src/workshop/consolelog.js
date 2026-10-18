// The workshop page's console, forwarded to the dev server — /workshop/, not part of the game.
// See docs/workshop.md.
//
// The agent cannot open devtools, so an error that only the browser sees (a mount that throws, a
// shader that fails to link) used to reach it as a screenshot someone pasted. This hooks
// `console.error`, `console.warn`, uncaught errors and unhandled rejections and posts them to
// `/__workshop/console`, which keeps the last few in `.workshop/console.log` for the agent to Read,
// the way it Reads `view.png`. Errors also go to `onError`, which chat.js uses to offer the agent
// the fix without being asked.
//
// Imports nothing from the game, for the reason chat.js does not. Installing twice is a no-op: an
// edit to this file re-runs it, and a second wrapper on `console.error` would post everything twice.

const FLAG = '__workshopConsoleCapture';

/** One line a person (or the agent) can read: Errors with their stack, everything else as text. */
function describe(value) {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/**
 * Two reports of the same failure are one failure: the signature is the first line with the
 * numbers (line, column, counts) taken out, so a retry at another position does not read as new.
 */
export const signature = (message) => message.split('\n')[0].replace(/\d+/g, '#').slice(0, 160);

export function installConsoleCapture(onError) {
  if (window[FLAG]) { window[FLAG].onError = onError; return; }
  const state = { onError, queue: [], timer: 0 };
  window[FLAG] = state;

  const flush = () => {
    state.timer = 0;
    const entries = state.queue.splice(0);
    if (!entries.length) return;
    // Never through `console`: a failure to report would report itself, forever.
    fetch('/__workshop/console', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
      keepalive: true,
    }).catch(() => {});
  };

  const report = (level, message) => {
    const entry = { level, message: message.slice(0, 2000), t: Date.now() };
    state.queue.push(entry);
    // Batched: one failing frame can log hundreds of times a second.
    if (!state.timer) state.timer = setTimeout(flush, 250);
    if (level === 'error') state.onError?.(entry);
  };

  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      report(level, args.map(describe).join(' '));
    };
  }
  addEventListener('error', (event) => {
    report('error', describe(event.error ?? event.message));
  });
  addEventListener('unhandledrejection', (event) => {
    report('error', `Unhandled rejection: ${describe(event.reason)}`);
  });
}
