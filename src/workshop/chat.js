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

import { installConsoleCapture, signature } from './consolelog.js';
import { createComposer } from './composer.js';

const STORE = 'workshop-chat';
const log = document.getElementById('log');
const form = document.getElementById('compose');
const newButton = document.getElementById('new-chat');
// The pasted images' thumbnails, which go inside the composer above the text (`drawAttachments`).
const attachmentsEl = Object.assign(document.createElement('div'), { id: 'attachments', hidden: true });
// The gap between the thumbnails and the text: the same as a sent bubble's (`.bubble-thumbs`).
const ATTACH_GAP = 12;

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

// The text box, Speed picker, mic, Stop and Send: the same component as the pin note on the bench
// (composer.js). Made here rather than at the top because building it asks `canSend`, which reads
// `attached`. Its handlers are function declarations further down, hoisted.
const composer = createComposer({
  placeholder: 'Make the taxi\'s roof sign bigger…',
  inputId: 'input',
  stop: true,
  canSend: () => attached.length > 0,
  onSend: submit,
  onInput: keepDraft,
  onStop: () => {
    if (chat.runId) fetch(`/__workshop/runs/${chat.runId}/stop`, { method: 'POST' }).catch(() => {});
  },
  onError: (text) => {
    chat.messages.push({ role: 'error', text });
    save();
    render();
  },
});
form.append(composer.el);
composer.el.prepend(attachmentsEl);
const { input, sendButton, stopButton, speedSelect } = composer;

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

// What a sent bubble shows of an image: a small JPEG kept in the saved log (sessionStorage), where
// the full PNG would not fit.
const THUMB_PX = 160;
async function thumbOf(src) {
  try {
    const img = new Image();
    img.src = src;
    await img.decode();
    const scale = Math.min(1, THUMB_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch { return null; }
}

/** The pictures in a bubble, as a row of thumbnails, to go above its text. */
function thumbRow(thumbs, text) {
  const row = document.createElement('div');
  row.className = text?.trim() ? 'bubble-thumbs' : 'bubble-thumbs alone';
  for (const src of thumbs) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'Attached image';
    row.append(img);
  }
  return row;
}

function drawAttachments() {
  syncSend();
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
  // Make room for the row in the box's top padding: measured rather than assumed, since six of
  // them wrap to a second row in the chat's width. The thumbs are a fixed size, so the height is
  // known before the images decode.
  const room = attached.length ? attachmentsEl.offsetHeight + ATTACH_GAP : 0;
  composer.el.style.setProperty('--attach-h', `${room}px`);
  composer.autosize();
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

// When a reaction appears after its message is sent (the "…" shows from just after the message lands
// until then, about a second), and how long it takes to pop in (ms).
const REACTION_DELAY = 1200;
const REACTION_POP = 250;

// Which undo rows have their file list open, by run, for the same reason as `openGroups` below.
const openChanges = new Set();

function element(message, latestUndo) {
  if (message.role === 'bg') return backgroundElement(message);
  const el = document.createElement('div');
  if (message.role === 'undo') {
    // Only the latest turn's edits can be undone: an older turn's snapshot predates everything
    // after it, so putting its files back would quietly take the later turns with them.
    el.className = 'undo';
    if (message.state === 'done') {
      const done = document.createElement('span');
      done.className = 'undone';
      done.textContent = 'Undone';
      el.append(done);
    } else {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'act';
      button.textContent = 'Undo';
      button.disabled = message !== latestUndo || Boolean(chat.runId);
      button.addEventListener('click', () => undo(message));
      el.append(button);
    }
    // The files beside the button, folded away: a turn can touch half a dozen, and strung into the
    // button's label they ran on into one unreadable line. A toggle and a list as siblings rather
    // than a <details>, so the toggle sits on the button's line and the list wraps below both.
    const open = openChanges.has(message.runId);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'changes';
    toggle.textContent = `Changes ${open ? '▾' : '▸'}`;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.addEventListener('click', () => {
      if (openChanges.has(message.runId)) openChanges.delete(message.runId); else openChanges.add(message.runId);
      render();
    });
    const list = document.createElement('ul');
    list.hidden = !open;
    for (const file of message.files) {
      const item = document.createElement('li');
      item.textContent = short(file);
      list.append(item);
    }
    el.append(toggle, list);
    return el;
  }
  if (message.role === 'tool') {
    el.className = 'tool';
    el.innerHTML = `<b>${escape(message.name)}</b> ${escape(short(message.detail ?? ''))}`;
  } else {
    el.className = `msg ${message.role}`;
    el.innerHTML = inline(message.text ?? '');
    if (message.thumbs?.length) el.prepend(thumbRow(message.thumbs, message.text));
    if (message.reaction) {
      const badge = document.createElement('span');
      badge.className = 'reaction';
      badge.textContent = message.reaction;
      // Pops in half a second after the message is sent. The log is rebuilt on every streamed event,
      // which would restart a plain animation each time, so the delay is what is left of the 500ms
      // (negative once it is under way, which resumes the animation at the right frame instead of
      // replaying it). Past the end of it, no animation at all: the badge just sits there.
      const age = Date.now() - (message.sentAt ?? 0);
      if (age < REACTION_DELAY + REACTION_POP) {
        badge.style.animation = `reaction-pop ${REACTION_POP}ms cubic-bezier(0.2, 1.6, 0.4, 1) ${REACTION_DELAY - age}ms backwards`;
      }
      // Before it, a "…" that stands in for the agent thinking: it fades in just after the message
      // lands, bounces for about a second, and is gone when the reaction takes its place. One
      // animation across the whole wait (`typing-life`), resumed by the same negative delay.
      if (age < REACTION_DELAY) {
        const typing = document.createElement('span');
        typing.className = 'reaction typing';
        typing.style.animation = `typing-life ${REACTION_DELAY}ms linear ${-age}ms both`;
        typing.innerHTML = '<i></i><i></i><i></i>';
        el.append(typing);
      }
      el.append(badge);
    }
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

let emptyHost = null;
let renderedCount = 0;
function render() {
  // Read before the rebuild: emptying the log shrinks it and the browser clamps scrollTop to match,
  // which is what used to drag a reader back to the bottom on every streamed word. Follow the reply
  // only while already at the bottom (or when they have just sent something); scrolled up reading,
  // stay put and let them scroll down when they get there.
  const wasTop = log.scrollTop;
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  const justSent = chat.messages.length > renderedCount && chat.messages.at(-1)?.role === 'user';
  renderedCount = chat.messages.length;
  log.replaceChildren();
  if (!chat.messages.length) {
    // No copy: the taxi doing its Loco Mode weave on the spot. Loaded lazily, never imported, so
    // this module still imports nothing from the game (see the top of the file); emptytaxi.js is
    // its own hot-reload boundary. One host kept across renders so the canvas is not rebuilt.
    emptyHost ??= Object.assign(document.createElement('div'), { className: 'empty' });
    log.append(emptyHost);
    import('./emptytaxi.js').then((m) => m.mount(emptyHost)).catch((error) => console.error('new-chat taxi failed to draw:', error));
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
  // From the moment a message is sent until the first thing comes back (a tool call or a word of the
  // reply): a "Thinking" row, so the gap is never an empty log. That gap is real work, not lag the
  // page can remove: the screenshot, the snapshot for Undo, starting the CLI, and the model's first
  // token. `busy()` is already true while the request is in flight, so it shows at once.
  if (busy() && messages.at(-1)?.role === 'user') {
    const thinking = document.createElement('div');
    thinking.className = 'thinking';
    thinking.innerHTML = '<i class="pulse"></i>Thinking';
    log.append(thinking);
  }
  for (const item of chat.queue) {
    const el = document.createElement('div');
    el.className = 'msg user queued';
    el.innerHTML = inline(bubbleText(item.text, item.pin));
    if (item.thumbs?.length) el.prepend(thumbRow(item.thumbs, bubbleText(item.text, item.pin)));
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.title = 'Remove from the queue';
    cancel.textContent = '×';
    cancel.addEventListener('click', () => unqueue(item));
    el.append(cancel);
    log.append(el);
  }
  log.scrollTop = atBottom || justSent ? log.scrollHeight : wasTop;
  // Not `busy`: a local of that name shadows the module's `busy()` for the whole function, so the
  // Thinking check above hit it before it was declared and threw on every render, page load included.
  const running = Boolean(chat.runId);
  sendButton.textContent = running ? 'Queue' : 'Send';
  stopButton.hidden = !running;
}

// The full images stay out of the log (sessionStorage again); a bubble keeps small thumbnails.
// The part's name only when the builder gave it one: "📍 unnamed mesh:" says nothing, and the
// square crop beside the message already shows where it was pinned.
const GENERIC_LABELS = new Set(['unnamed mesh', 'group', 'on the bench beside it']);
const bubbleText = (text, pin) => `${pin && !GENERIC_LABELS.has(pin.label) ? `📍 ${pin.label}: ` : ''}${text}`;

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
function enqueue(text, pin = null, image = null, attachments = [], speed = null, thumbs = []) {
  const id = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (!image) {
    try { image = window.__workshop?.capture?.() ?? null; } catch { /* sent with a fresh one */ }
  }
  if (image) keepImage(id, image);
  if (attachments.length) keepImage(`${id}:att`, attachments);
  chat.queue.push({ id, text, pin, bench: benchNow(), images: attachments.length, thumbs, speed });
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
  send(text, item.pin, image, item.bench, attachments, item.speed, item.thumbs);
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
  } else if (event.type === 'model') {
    // Which model took the turn is not shown: the endpoint still reports it, but a line under every
    // quick reply was noise. The Speed picker says what was asked for.
  } else if (event.type === 'done') {
    live = null;
    if (!event.ok && event.error) chat.messages.push({ role: 'error', text: event.error });
    // The test and docs status first, then Undo under it, so Undo is the last thing on the reply.
    if (event.background) {
      const bg = { role: 'bg', runId: chat.runId, check: 'running', docs: 'running', failures: '', docsFiles: [] };
      chat.messages.push(bg);
      watchBackground(bg);
    }
    if (event.undoable) chat.messages.push({ role: 'undo', runId: chat.runId, files: event.edited, state: 'ready' });
    // An edit's console errors land a moment after the reply (hot-reload, then the first frame), so
    // the auto-fix below listens from here.
    if (event.edited?.length) chat.editedAt = Date.now();
    chat.runId = null;
    // The bench takes down the pin this run was answering (viewer.js). An event, not a call, for
    // the same reason `__workshopChat` is a global: the two modules never import each other.
    dispatchEvent(new CustomEvent('workshop:run-done', { detail: { pinId: chat.runPin ?? null } }));
    chat.runPin = null;
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// --- The browser console, handed to the agent ---------------------------------
//
// consolelog.js forwards every console error to `.workshop/console.log`, which the agent Reads when
// something is not showing. This is the other half: an error that appears within AUTOFIX_WINDOW of a
// reply that edited files is, nearly always, that edit's — so the agent is sent it as a message
// instead of waiting for someone to notice a blank panel and paste a screenshot.
//
// Bounded, because an agent fixing its own console is one bad fix from a loop: one attempt per
// error signature (kept in the conversation, so the reload the edit causes cannot re-fire it), and
// at most AUTOFIX_CHAIN in a row without a message from the person.
const AUTOFIX_WINDOW = 30_000;
const AUTOFIX_CHAIN = 2;

function autoFix(entry) {
  const sig = signature(entry.message);
  chat.autoFixed ??= [];
  if (!chat.editedAt || Date.now() - chat.editedAt > AUTOFIX_WINDOW) return;
  if (chat.autoFixed.includes(sig) || (chat.autoChain ?? 0) >= AUTOFIX_CHAIN) return;
  chat.autoFixed.push(sig);
  chat.autoChain = (chat.autoChain ?? 0) + 1;
  chat.editedAt = null;
  save();
  const text = `The browser console reported an error right after your last edit:\n\n${entry.message.slice(0, 1200)}\n\nFix what the edit broke. The full console is in .workshop/console.log.`;
  // Smart, for the reason Fix is: a failure is what Auto's fast guess is not for.
  if (busy()) enqueue(text, null, null, [], 'smart'); else send(text, null, null, null, [], 'smart');
}
installConsoleCapture(autoFix);

// --- What follows a reply: the checks and the docs pass ---------------------
//
// The agent no longer runs `npm run check` or touches docs/ inside its turn; the endpoint does both
// once the reply is done (`background` in tools/workshop-agent.mjs), and this polls for the result
// and draws it under the reply. Polled rather than streamed because it outlives the run's stream,
// and a reload in between must find it again: `watchBackground` is re-armed from the log on boot.

const settled = (state) => state !== 'running';
const watching = new Set();

async function watchBackground(bg) {
  if (watching.has(bg.runId)) return;
  watching.add(bg.runId);
  try {
    while (!leaving && !(settled(bg.check) && settled(bg.docs))) {
      await sleep(2000);
      let reply;
      try {
        const res = await fetch(`/__workshop/runs/${bg.runId}/background`);
        if (res.status === 404) { Object.assign(bg, { check: 'lost', docs: 'lost' }); break; }
        reply = await res.json();
      } catch { continue; }      // the dev server restarting: try again
      Object.assign(bg, {
        check: reply.check, docs: reply.docs, failures: reply.failures ?? '',
        docsFiles: reply.docsFiles ?? [], docsNote: reply.docsNote ?? '',
      });
      // The docs pass's files join the turn's, so its Changes list (and Undo) covers them.
      const undoRow = chat.messages.find((m) => m.role === 'undo' && m.runId === bg.runId);
      if (undoRow && reply.edited) undoRow.files = reply.edited;
      save();
      render();
    }
  } finally {
    watching.delete(bg.runId);
  }
  save();
  render();
}

function backgroundElement(bg) {
  const el = document.createElement('div');
  el.className = 'bg';
  const check = {
    running: 'Running tests', pass: '✓ Tests pass', fail: '✗ Tests failed',
    superseded: 'Tests: folded into the next edit\'s', cancelled: 'Tests cancelled', lost: 'Tests: lost track (dev server restarted)',
  }[bg.check];
  const docs = {
    running: 'Updating docs',
    done: bg.docsFiles?.length ? `✓ Docs updated (${bg.docsFiles.length})` : '✓ No doc changes needed',
    fail: '✗ Docs pass failed', cancelled: 'Docs pass cancelled', lost: '',
  }[bg.docs];
  // A pulsing dot in front of whatever is still running, in place of a spinner glyph.
  const part = (text, running) => {
    const span = document.createElement('span');
    if (running) {
      const dot = document.createElement('i');
      dot.className = 'pulse';
      span.append(dot);
    }
    span.append(text);
    return span;
  };
  const line = document.createElement('div');
  line.className = 'bg-line';
  const parts = [[check, bg.check === 'running'], [docs, bg.docs === 'running']].filter(([text]) => text);
  parts.forEach(([text, running]) => line.append(part(text, running)));
  el.append(line);
  if (bg.check === 'fail') {
    if (bg.failures) {
      const pre = document.createElement('pre');
      pre.textContent = bg.failures;
      el.append(pre);
    }
    const fix = document.createElement('button');
    fix.type = 'button';
    fix.className = 'act';
    fix.textContent = 'Fix';
    // Always on the default model: a failure is exactly what Auto's fast guess is not for.
    fix.addEventListener('click', () => {
      const text = `The background checks (npm run check) failed after your last edit:\n\n${bg.failures}\n\nFix what the edit broke, or update the probe if the change was deliberate.`;
      if (busy()) enqueue(text, null, null, [], 'smart'); else send(text, null, null, null, [], 'smart');
    });
    el.append(fix);
  }
  return el;
}

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
async function send(text, pin = null, image = null, at = null, attachments = [], speed = null, thumbs = []) {
  const bench = window.__workshop;
  starting = true;
  // Deterministic reaction, off what they typed (not the pin's label): a question gets 👀, anything
  // else 👍.
  chat.messages.push({ role: 'user', text: bubbleText(text, pin), thumbs, reaction: text.includes('?') ? '👀' : '👍', sentAt: Date.now() });
  // The endpoint refuses an empty message, and an image on its own is a fair thing to send.
  const said = text || 'See the attached image.';
  const message = pin
    ? `${said}\n\n[They pinned this to a spot they clicked on the model, marked with a white ring in the screenshot:\n${pin.context}]`
    : said;
  live = null;
  render();

  // The screenshot is the one part that can fail (a bench whose model threw has nothing to draw),
  // and a message without a picture is still worth sending.
  if (!image) {
    try { image = bench?.capture?.() ?? null; } catch { /* send it blind */ }
  }
  const { model, view } = at ?? benchNow();
  // The model this conversation is about, for the new-chat suggestion: the first message's.
  if (!chat.benchId && model?.id) chat.benchId = model.id;
  const body = {
    message: chat.pendingNote ? `${chat.pendingNote}\n\n${message}` : message,
    sessionId: chat.sessionId,
    model,
    view,
    image,
    attachments,
    // The Speed picker (Auto / Fast / Smart), unless this message came with its own: Fix does.
    speed: speed ?? speedSelect?.value ?? 'auto',
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
      if (!pin) { input.value = text; autosize(); }
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

// The half-written message survives a reload. An edit to the page, or to anything Vite cannot swap
// in place, reloads this tab, and a textarea does not outlive that on its own: whatever was being
// typed was gone. Kept in sessionStorage as it is typed and put back on load, cleared on send.
// Text only; pasted images are too big to keep here (see `queuedImages`).
const DRAFT = 'workshop-chat-draft';

/** Send (or Queue) is only live with something to send: some text, or a pasted image. */
function syncSend() {
  sendButton.disabled = !input.value.trim() && !attached.length;
}

const autosize = () => composer.autosize();

try { input.value = sessionStorage.getItem(DRAFT) ?? ''; } catch { /* a private window */ }
autosize();
// The composer's `onInput`: every keystroke, and every dictated word.
function keepDraft() {
  try { sessionStorage.setItem(DRAFT, input.value); } catch { /* best effort */ }
}
const clearDraft = () => {
  try { sessionStorage.removeItem(DRAFT); } catch { /* best effort */ }
  autosize();
};

// ...and so does the focus, with the caret where it was. A reload dropped it, so you could not keep
// typing while an edit was landing: noted as the page goes away (while it still knows what has
// focus) and given back on load.
const FOCUS = 'workshop-chat-focus';
const noteFocus = () => {
  try {
    if (document.activeElement === input) {
      sessionStorage.setItem(FOCUS, JSON.stringify([input.selectionStart, input.selectionEnd]));
    } else {
      sessionStorage.removeItem(FOCUS);
    }
  } catch { /* best effort */ }
};
addEventListener('beforeunload', noteFocus);
addEventListener('pagehide', noteFocus);
try {
  const saved = JSON.parse(sessionStorage.getItem(FOCUS));
  sessionStorage.removeItem(FOCUS);
  if (Array.isArray(saved)) {
    input.focus({ preventScroll: true });
    input.setSelectionRange(saved[0] ?? input.value.length, saved[1] ?? input.value.length);
  }
} catch { /* nothing noted */ }

// Voice mode is the composer's own (composer.js); a blocked microphone comes back through its
// `onError` and is said in the chat rather than lost.

// The composer's `onSend`, on Enter or Send, with something to send.
async function submit(text) {
  const images = attached;
  chat.autoChain = 0;           // a person is steering again: the auto-fix budget starts over
  input.value = '';
  clearDraft();
  attached = [];
  drawAttachments();
  const thumbs = (await Promise.all(images.map(thumbOf))).filter(Boolean);
  if (busy()) enqueue(text, null, null, images, null, thumbs); else send(text, null, null, null, images, null, thumbs);
}
// The form is only the drop target now (Send is the composer's own button), but Enter in a form can
// still submit it in some browsers: never let that navigate.
form.addEventListener('submit', (event) => event.preventDefault());
function newChat() {
  if (chat.runId) return;
  for (const item of chat.queue) unqueue(item);
  chat = { sessionId: null, messages: [], runId: null, seen: 0, queue: [] };
  openGroups.clear();
  save();
  render();
  refreshSuggest();
  input.focus();
}
newButton.addEventListener('click', newChat);

// --- Suggesting a fresh chat --------------------------------------------------
//
// Two signals, both cheap and local (no model call to judge a topic): the bench is showing a
// different model from the one this chat began on, or the chat has run long. Either way the old
// history is dead weight for what comes next — and the first is the common case, since the
// conversation is about a model and the bench is where you change which one. A chip above the
// composer rather than a prompt in the way: it offers, and × waives it for that reason (a model
// switch is dismissed per model, so going to a third one asks again).
const LONG_CHAT_TURNS = 14;
const suggestEl = document.getElementById('suggest');
const suggestNew = document.getElementById('suggest-new');
const suggestX = document.getElementById('suggest-x');

function suggestion() {
  const turns = chat.messages.filter((m) => m.role === 'user').length;
  if (!turns || busy() || chat.queue.length) return null;
  const now = benchNow().model;
  if (chat.benchId && now && now.id !== chat.benchId && chat.dismissed !== `model:${now.id}`) {
    return { key: `model:${now.id}`, text: `New chat for the ${now.label}?` };
  }
  if (turns >= LONG_CHAT_TURNS && chat.dismissed !== 'long') {
    return { key: 'long', text: `Long chat (${turns} messages): start fresh?` };
  }
  return null;
}

let suggestShown = null;
function refreshSuggest() {
  const s = suggestion();
  suggestShown = s;
  suggestEl.hidden = !s;
  if (s) suggestNew.textContent = s.text;
}
suggestNew.addEventListener('click', newChat);
suggestX.addEventListener('click', () => {
  if (suggestShown) chat.dismissed = suggestShown.key;
  save();
  refreshSuggest();
});
// The bench's model picker lives in another module that re-runs under this one, so poll rather than
// listen: once a second is nothing, and it also catches a run finishing or the queue emptying.
setInterval(refreshSuggest, 1000);

// How the bench's pins post here. A global rather than an import, for the reason in the header:
// this module imports nothing the viewer does, and the viewer re-runs under it.
window.__workshopChat = {
  busy,
  send: (text, { image = null, thumbs = [], speed = null, ...pin } = {}) => {
    // `thumbs` is the square around the pin, shown in the bubble beside the 📍; `speed` is the pin
    // note's own Speed picker.
    if (busy()) enqueue(text, pin, image, [], speed, thumbs); else send(text, pin, image, null, [], speed, thumbs);
  },
};

render();
// Checks and docs passes still going when the page reloaded.
for (const m of chat.messages) {
  if (m.role === 'bg' && !(settled(m.check) && settled(m.docs))) watchBackground(m);
}
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
