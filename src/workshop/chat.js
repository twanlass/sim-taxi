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
const attachmentsEl = document.getElementById('attachments');

/**
 * { sessionId, messages: [{ role, text } | { role: 'tool', name, detail }], runId, seen, queue }
 *
 * `queue` is what was sent while a reply was still going: [{ id, text, pin, bench }], sent one at a
 * time as each run finishes (`drain`). The server takes one run at a time (409 otherwise), so this
 * is the whole of queueing — no parallel runs, just not having to wait to type the next thing.
 *
 * Everything a message says about the bench is taken when it is *queued*, not when it is sent:
 * `bench` is the model and view, and the screenshot is kept beside it (`queuedImages`). By the time
 * a queued message goes the bench has usually moved on, and the first version read all three at
 * send time — so a note about the helicopter went out naming the L train, with a picture of it.
 */
let chat = restore();
let live = null;          // the agent message currently being written into, while streaming

// Each queued message's screenshot (under its id) and pasted images (under `<id>:att`). Not in sessionStorage, where a megabyte of base64 apiece fills
// it in a few messages, but in IndexedDB, so it survives the full reloads the page takes while a
// queue waits (an edit to the page, or Vite reloading every tab for the game's sake). A first
// version held them in memory only, and a reload silently swapped in a fresh picture of whatever
// was on the bench by then. The Map is the fast path; IndexedDB is what outlives the page.
const queuedImages = new Map();
const IMAGE_DB = 'workshop-chat-images';
let imageDb = null;
function images(mode, use) {
  imageDb ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(IMAGE_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('images');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  return imageDb.then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('images', mode);
    const request = use(tx.objectStore('images'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
  }));
}
function keepImage(id, image) {
  queuedImages.set(id, image);
  images('readwrite', (store) => store.put(image, id)).catch(() => { /* memory still has it */ });
}
async function takeImage(id) {
  let image = queuedImages.get(id) ?? null;
  if (!image) {
    try { image = (await images('readonly', (store) => store.get(id))) ?? null; } catch { /* none kept */ }
  }
  dropImage(id);
  return image;
}
function dropImage(id) {
  queuedImages.delete(id);
  images('readwrite', (store) => store.delete(id)).catch(() => {});
}

// --- Pasted and dropped images ------------------------------------------------
//
// Reference pictures, sketches, a screenshot of the game: pasted or dropped onto the compose box,
// shown as thumbnails above it, and sent with the next message, where the endpoint writes each to
// `.workshop/` for the agent to Read beside the bench's own screenshot. Re-encoded through a canvas
// on the way in, capped at ATTACH_MAX px on the long side: a retina screenshot is 6 MB of PNG for
// detail the agent's image input scales away anyway, and one format means the endpoint only has to
// know one. Like the screenshot, they live in memory and IndexedDB, never in sessionStorage.

const ATTACH_MAX = 1600;
const ATTACH_LIMIT = 6;
let attached = [];        // data URLs waiting for the next message

async function toPng(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, ATTACH_MAX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/png');
}

async function addImages(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/') || attached.length >= ATTACH_LIMIT) continue;
    try { attached.push(await toPng(file)); } catch { /* not an image the browser can decode */ }
  }
  drawAttachments();
}

function drawAttachments() {
  attachmentsEl.hidden = !attached.length;
  attachmentsEl.replaceChildren(...attached.map((src, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    const img = document.createElement('img');
    img.src = src;
    img.alt = `Attached image ${i + 1}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.title = 'Remove';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      attached = attached.filter((_, k) => k !== i);
      drawAttachments();
    });
    thumb.append(img, remove);
    return thumb;
  }));
}

input.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;          // plain text pastes as text
  event.preventDefault();
  addImages(files);
});
form.addEventListener('dragover', (event) => {
  if (![...(event.dataTransfer?.items ?? [])].some((item) => item.kind === 'file')) return;
  event.preventDefault();
  form.classList.add('dropping');
});
form.addEventListener('dragleave', () => form.classList.remove('dropping'));
form.addEventListener('drop', (event) => {
  form.classList.remove('dropping');
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  addImages(files);
});

// A reload aborts the stream `attach` is reading, and its catch runs while the page is going away.
// Left to itself it would write "couldn't reach the agent" and `runId = null` into sessionStorage,
// so the reloaded page would not reattach and the next message would hit a run still going (409).
// The reload that does this is usually not ours: Vite broadcasts a full reload to every tab, so an
// edit the game's own tab cannot hot-swap reloads the workshop too, even though the bench could.
let leaving = false;
addEventListener('beforeunload', () => { leaving = true; });
addEventListener('pagehide', () => { leaving = true; });

function restore() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE));
    if (saved && Array.isArray(saved.messages)) return { queue: [], ...saved };
  } catch { /* a private window, or nothing saved yet */ }
  return { sessionId: null, messages: [], runId: null, seen: 0, queue: [] };
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

// Which tool groups are expanded, by the index of their first call, so a re-render on every
// streamed event doesn't snap one shut under the pointer.
const openGroups = new Set();

function toolGroup(tools, key, active) {
  const details = document.createElement('details');
  details.className = 'tools';
  if (active) details.classList.add('working');
  details.open = openGroups.has(key);
  details.addEventListener('toggle', () => {
    if (details.open) openGroups.add(key); else openGroups.delete(key);
  });
  const summary = document.createElement('summary');
  const count = document.createElement('span');
  count.className = 'count';
  count.textContent = tools.length > 1 ? `${tools.length} steps` : '1 step';
  summary.append(element(tools.at(-1)), count);
  details.append(summary);
  const list = document.createElement('div');
  list.className = 'tool-list';
  for (const tool of tools) list.append(element(tool));
  details.append(list);
  return details;
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
  const messages = chat.messages;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'tool') {
      // A run of tool calls is one row showing the latest, which ticks over as the agent works;
      // the whole list is a click away. A turn is often twenty reads and greps, and listed out
      // they bury the two sentences of reply that matter.
      let end = i;
      while (end + 1 < messages.length && messages[end + 1].role === 'tool') end++;
      log.append(toolGroup(messages.slice(i, end + 1), i, end === messages.length - 1 && Boolean(chat.runId)));
      i = end;
      continue;
    }
    const el = element(messages[i], latestUndo);
    if (messages[i] === live) el.classList.add('working');
    log.append(el);
  }
  for (const item of chat.queue) {
    const el = document.createElement('div');
    el.className = 'msg user queued';
    el.innerHTML = inline(bubbleText(item.text, item.pin, item.images ?? 0));
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.title = 'Remove from the queue';
    cancel.textContent = '×';
    cancel.addEventListener('click', () => unqueue(item));
    el.append(cancel);
    log.append(el);
  }
  log.scrollTop = log.scrollHeight;
  const busy = Boolean(chat.runId);
  sendButton.textContent = busy ? 'Queue' : 'Send';
  stopButton.hidden = !busy;
}

// The images themselves stay out of the log (sessionStorage again), so a bubble just counts them.
const bubbleText = (text, pin, images = 0) => `${pin ? `📍 ${pin.label}: ` : ''}${text}`
  + (images ? `${text ? ' ' : ''}🖼 ×${images}` : '');

// True from the moment a message starts going until the server has given it a run id (or refused
// it): without it, a message typed in that gap — or the queue draining into it — would be posted
// alongside and bounce off the server's one-run-at-a-time 409.
let starting = false;
const busy = () => Boolean(chat.runId) || starting;

/** The bench as it is right now: which model, which view. */
function benchNow() {
  const bench = window.__workshop;
  return { model: bench?.model?.() ?? null, view: bench?.view?.() ?? 'orbit' };
}

/** Hold a message until the run ahead of it is done, with the bench as it is now. */
function enqueue(text, pin = null, image = null, attachments = []) {
  const id = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (!image) {
    try { image = window.__workshop?.capture?.() ?? null; } catch { /* sent with a fresh one */ }
  }
  if (image) keepImage(id, image);
  if (attachments.length) keepImage(`${id}:att`, attachments);
  chat.queue.push({ id, text, pin, bench: benchNow(), images: attachments.length });
  save();
  render();
}

function unqueue(item) {
  chat.queue = chat.queue.filter((q) => q !== item);
  dropImage(item.id);
  dropImage(`${item.id}:att`);
  // Its pin was waiting on a reply that is now never coming.
  if (item.pin?.id) dispatchEvent(new CustomEvent('workshop:run-done', { detail: { pinId: item.pin.id } }));
  save();
  render();
}

/** Send the next queued message, if nothing is running. */
async function drain() {
  if (busy() || !chat.queue.length) return;
  starting = true;
  const item = chat.queue.shift();
  save();
  const image = await takeImage(item.id);
  // An image the page has lost is said out loud rather than dropped quietly: the text may point at it.
  const attachments = item.images ? (await takeImage(`${item.id}:att`)) ?? [] : [];
  starting = false;
  const lost = (item.images ?? 0) - attachments.length;
  const text = lost > 0 ? `${item.text}\n\n(${lost} image(s) they attached were lost before this was sent.)` : item.text;
  send(text, item.pin, image, item.bench, attachments);
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
    // The bench takes down the pin this run was answering (viewer.js). An event, not a call, for
    // the same reason `__workshopChat` is a global: the two modules never import each other.
    dispatchEvent(new CustomEvent('workshop:run-done', { detail: { pinId: chat.runPin ?? null } }));
    chat.runPin = null;
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Read a run's events from `chat.seen` on, until it ends. Safe to call again after a reload.
 *
 * A dropped stream is retried for a while before it is called lost, because the agent can restart
 * the dev server under its own run: asked to change the workshop's endpoint, it saves
 * tools/workshop-agent.mjs, which vite.config.js imports, and Vite restarts. The run survives that
 * (the table is on globalThis, see workshop-agent.mjs), so the stream comes back once the server
 * does, about a second later. Vite's own client then reloads the page, and the next page picks up
 * from `chat.seen` as it would after any reload.
 */
async function attach(runId) {
  for (let attempt = 0; ; attempt++) {
    const outcome = await read(runId);
    if (leaving) return;
    if (outcome === 'done') {
      drain();
      return;
    }
    if (outcome === 'lost' || attempt >= 15) {
      chat.runId = null;
      chat.messages.push({
        role: 'error',
        text: outcome === 'lost'
          ? 'Lost track of that reply (the dev server restarted). Any edits it made are still on disk.'
          : 'Couldn\'t reach the agent. The chat only works under `npm run dev`.',
      });
      live = null;
      save();
      render();
      return;
    }
    await sleep(1000);
    if (leaving) return;
  }
}

/** One attempt at the stream: 'done' when the run ends, 'lost' if the server has no such run. */
async function read(runId) {
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
    // Unloading, the server restarting, or this is not the dev server at all: the caller decides.
    if (error.message === 'lost') return 'lost';
  }
  if (leaving) return 'retry';    // the page is reloading; the next one picks the run back up
  live = null;
  save();
  render();
  // A stream can also end cleanly with the run still going, when the server goes away mid-run.
  // Only the run's own `done` event (which clears `runId`) means it is over.
  return chat.runId ? 'retry' : 'done';
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

/**
 * `pin` is a spot clicked on the bench (viewer.js): `label` names it in the bubble, and `context`
 * describes it for the agent. The context goes in the message rather than as a field of its own so
 * the endpoint needs nothing new, and so it stays in the conversation the agent resumes from.
 *
 * `image` and `at` (the model and view) come with a queued message, taken when it was queued; a
 * message sent straight away reads them off the bench now.
 */
async function send(text, pin = null, image = null, at = null, attachments = []) {
  const bench = window.__workshop;
  starting = true;
  chat.messages.push({ role: 'user', text: bubbleText(text, pin, attachments.length) });
  // The endpoint refuses an empty message, and an image on its own is a fair thing to send.
  const said = text || 'See the attached image.';
  const message = pin
    ? `${said}\n\n[They pinned this to a spot they clicked on the model, marked with a yellow ring in the screenshot:\n${pin.context}]`
    : said;
  live = null;
  render();

  // The screenshot is the one part that can fail (a bench whose model threw has nothing to draw),
  // and a message without a picture is still worth sending.
  if (!image) {
    try { image = bench?.capture?.() ?? null; } catch { /* send it blind */ }
  }
  const { model, view } = at ?? benchNow();
  const body = {
    message: chat.pendingNote ? `${chat.pendingNote}\n\n${message}` : message,
    sessionId: chat.sessionId,
    model,
    view,
    image,
    attachments,
  };

  try {
    const res = await fetch('/__workshop/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const reply = await res.json();
    starting = false;
    if (res.status === 409 && reply.runId === chat.lastRunId) {
      // Our own run, still going: we lost track of it somehow. Pick it back up instead of failing.
      chat.messages.pop();
      if (!pin) input.value = text;
      chat.runId = reply.runId;
      save();
      render();
      await attach(reply.runId);
      return;
    }
    if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
    chat.runId = reply.runId;
    chat.lastRunId = reply.runId;
    chat.runPin = pin?.id ?? null;
    chat.seen = 0;
    chat.pendingNote = null;
    save();
    render();
    await attach(reply.runId);
  } catch (error) {
    starting = false;
    if (pin?.id) dispatchEvent(new CustomEvent('workshop:run-done', { detail: { pinId: pin.id } }));
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
  if (!text && !attached.length) return;
  const images = attached;
  input.value = '';
  attached = [];
  drawAttachments();
  if (busy()) enqueue(text, null, null, images); else send(text, null, null, null, images);
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
  for (const item of chat.queue) unqueue(item);
  chat = { sessionId: null, messages: [], runId: null, seen: 0, queue: [] };
  openGroups.clear();
  save();
  render();
  input.focus();
});

// How the bench's pins post here. A global rather than an import, for the reason in the header:
// this module imports nothing the viewer does, and the viewer re-runs under it.
window.__workshopChat = {
  busy,
  send: (text, { image = null, ...pin } = {}) => {
    if (busy()) enqueue(text, pin, image); else send(text, pin, image);
  },
};

render();
if (!chat.runId && chat.lastRunId) {
  // Belt and braces for a page that lost its run anyway: if the server is still busy with the run
  // this conversation started, carry on reading it rather than refusing the next message.
  fetch('/__workshop/status').then((res) => res.json()).then(({ busy: running }) => {
    if (running && running === chat.lastRunId && !chat.runId) {
      chat.runId = running;
      render();
      attach(running);
    } else {
      drain();
    }
  }).catch(() => {});
} else if (!chat.runId) {
  // A queue that outlived a reload with nothing running in front of it.
  drain();
}
if (chat.runId) {
  // Back from a reload mid-reply: carry on writing into the bubble that was being written.
  const last = chat.messages.at(-1);
  if (last?.role === 'agent') live = last;
  attach(chat.runId);
}
