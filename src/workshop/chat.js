// The model workshop's chat panel — /workshop/. See docs/workshop.md.
//
// A text box that talks to Claude Code running headless in the repo, through the dev server
// (tools/workshop-agent.mjs). Every message goes with the model on the bench, its source file, the
// view, and a screenshot of exactly what is on screen, so "make that bigger" has a "that".
//
// **Imports nothing from the game.** The viewer re-runs on every edit (viewer.js); this module
// must not, or the agent's own edit would wipe the conversation it is in the middle of. And the
// conversation survives a *full* reload too — an edit to the page, or to something Vite cannot
// hot-swap — because it lives in sessionStorage, and the run it was streaming lives on the server:
// a reloaded page reattaches and replays what it missed.

const STORE = 'workshop-chat';
const log = document.getElementById('log');
const input = document.getElementById('input');
const form = document.getElementById('compose');
const sendButton = document.getElementById('send');
const stopButton = document.getElementById('stop');
const newButton = document.getElementById('new-chat');

/** { sessionId, messages: [{ role, text } | { role: 'tool', name, detail }], runId, seen } */
let chat = restore();
let live = null;          // the agent message currently being written into, while streaming

function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE));
    if (saved && Array.isArray(saved.messages)) return saved;
  } catch { /* a private window, or nothing saved yet */ }
  return { sessionId: null, messages: [], runId: null, seen: 0 };
}

function save() {
  try { sessionStorage.setItem(STORE, JSON.stringify(chat)); } catch { /* best effort */ }
}

// --- Drawing ----------------------------------------------------------------

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const inline = (s) => escape(s)
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');

/** A path relative to the repo, which is all anyone wants to read in a tool line. */
const short = (path) => path.replace(/^.*?\/(src|tools|docs|assets|workshop)\//, '$1/');

function element(message, latestUndo) {
  const el = document.createElement('div');
  if (message.role === 'undo') {
    // Only the latest turn's edits can be undone: an older turn's snapshot predates everything
    // after it, so putting its files back would quietly take the later turns with them.
    el.className = 'undo';
    const names = message.files.map((f) => f.split('/').pop()).join(', ');
    if (message.state === 'done') {
      el.textContent = `Undone: ${names}`;
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'act';
      button.textContent = `Undo (${names})`;
      button.disabled = message !== latestUndo || Boolean(chat.runId);
      button.addEventListener('click', () => undo(message));
      el.append(button);
    }
    return el;
  }
  if (message.role === 'tool') {
    el.className = 'tool';
    el.innerHTML = `<b>${escape(message.name)}</b> ${escape(short(message.detail ?? ''))}`;
  } else {
    el.className = `msg ${message.role}`;
    el.innerHTML = inline(message.text ?? '');
  }
  return el;
}

function render() {
  log.replaceChildren();
  if (!chat.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = 'Ask for a change to the model on the bench. Claude edits the game\'s own '
      + 'source and the model reloads here as soon as the file is saved, so whatever you end up '
      + 'with is already in the game.<br><br>Try: <i>make the roof sign twice as tall</i>, '
      + '<i>paint the cab a deeper yellow</i>, <i>round off the bonnet</i>.';
    log.append(empty);
  }
  const latestUndo = chat.messages.findLast((m) => m.role === 'undo');
  for (const message of chat.messages) {
    const el = element(message, latestUndo);
    if (message === live) el.classList.add('working');
    log.append(el);
  }
  log.scrollTop = log.scrollHeight;
  const busy = Boolean(chat.runId);
  sendButton.disabled = busy;
  stopButton.hidden = !busy;
}

// --- Talking to the dev server ---------------------------------------------

function apply(event) {
  if (event.type === 'session') {
    chat.sessionId = event.id;
  } else if (event.type === 'break') {
    live = null;
  } else if (event.type === 'text') {
    if (!live) {
      live = { role: 'agent', text: '' };
      chat.messages.push(live);
    }
    live.text += event.text;
  } else if (event.type === 'tool') {
    live = null;
    chat.messages.push({ role: 'tool', name: event.name, detail: event.detail });
  } else if (event.type === 'done') {
    live = null;
    if (!event.ok && event.error) chat.messages.push({ role: 'error', text: event.error });
    if (event.undoable) chat.messages.push({ role: 'undo', runId: chat.runId, files: event.edited, state: 'ready' });
    chat.runId = null;
  }
}

/** Read a run's events from `chat.seen` on, until it ends. Safe to call again after a reload. */
async function attach(runId) {
  try {
    const res = await fetch(`/__workshop/runs/${runId}?from=${chat.seen}`);
    if (!res.ok) throw new Error(res.status === 404 ? 'lost' : `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        apply(JSON.parse(line));
        chat.seen++;
      }
      save();
      render();
    }
  } catch (error) {
    // The dev server restarted (and took the run with it), or this is not the dev server at all.
    chat.runId = null;
    chat.messages.push({
      role: 'error',
      text: error.message === 'lost'
        ? 'Lost track of that reply (the dev server restarted). Any edits it made are still on disk.'
        : 'Couldn\'t reach the agent. The chat only works under `npm run dev`.',
    });
  }
  live = null;
  save();
  render();
}

async function undo(message) {
  try {
    const res = await fetch(`/__workshop/runs/${message.runId}/undo`, { method: 'POST' });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    message.state = 'done';
    if (reply.kept?.length) {
      chat.messages.push({ role: 'error', text: `Left alone (no copy from before): ${reply.kept.join(', ')}` });
    }
    // The agent remembers making the change, so tell it, or the next turn builds on an edit that
    // is no longer there. Folded into the next message rather than spending a turn on it.
    chat.pendingNote = `(I undid your last edit to ${message.files.join(', ')}; those files are back to how they were before it.)`;
  } catch (error) {
    chat.messages.push({ role: 'error', text: `Couldn't undo: ${error.message}` });
  }
  save();
  render();
}

async function send(text) {
  const bench = window.__workshop;
  chat.messages.push({ role: 'user', text });
  live = null;
  render();

  // The screenshot is the one part that can fail (a bench whose model threw has nothing to draw),
  // and a message without a picture is still worth sending.
  let image = null;
  try { image = bench?.capture?.() ?? null; } catch { /* send it blind */ }
  const body = {
    message: chat.pendingNote ? `${chat.pendingNote}\n\n${text}` : text,
    sessionId: chat.sessionId,
    model: bench?.model?.() ?? null,
    view: bench?.view?.() ?? 'orbit',
    image,
  };

  try {
    const res = await fetch('/__workshop/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    chat.runId = reply.runId;
    chat.seen = 0;
    chat.pendingNote = null;
    save();
    render();
    await attach(reply.runId);
  } catch (error) {
    chat.messages.push({
      role: 'error',
      text: error instanceof TypeError || /JSON/.test(error.message)
        ? 'Couldn\'t reach the agent. The chat only works under `npm run dev`.'
        : error.message,
    });
    save();
    render();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || chat.runId) return;
  input.value = '';
  send(text);
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});
stopButton.addEventListener('click', () => {
  if (chat.runId) fetch(`/__workshop/runs/${chat.runId}/stop`, { method: 'POST' }).catch(() => {});
});
newButton.addEventListener('click', () => {
  if (chat.runId) return;
  chat = { sessionId: null, messages: [], runId: null, seen: 0 };
  save();
  render();
  input.focus();
});

render();
if (chat.runId) {
  // Back from a reload mid-reply: carry on writing into the bubble that was being written.
  const last = chat.messages.at(-1);
  if (last?.role === 'agent') live = last;
  attach(chat.runId);
}
