/**
 * The model workshop's chat panel, server side — see docs/workshop.md.
 *
 * A Vite plugin, dev server only (`apply: 'serve'`), that hands each chat message to the Claude
 * Code CLI running headless in the repo (`claude -p`). That is the whole trick, and the reason the
 * panel needs no API key and no server of its own: it borrows the login of whoever ran
 * `npm run dev`, and the agent edits the real source files, which Vite then hot-reloads into the
 * viewer. There is no "export the values back into the game" step because the values never left.
 *
 * Three endpoints under `/__workshop/`:
 *
 *   POST /chat              { message, sessionId?, model: { id, label, source }, view, image?,
 *                             attachments? }
 *                           → { runId }. `image` is a PNG data URL of the canvas, written to
 *                           `.workshop/view.png` for the agent to Read; `attachments` are PNG data
 *                           URLs they pasted in, written to `.workshop/attachment-<n>.png`.
 *   GET  /runs/:id?from=n   the run's events from index `n`, as NDJSON, held open until it ends.
 *   POST /runs/:id/stop     kill it.
 *   POST /runs/:id/undo     put every file the run edited back the way it was before the run.
 *   GET  /runs/:id/background  the checks and docs pass that follow a run (`background`).
 *
 * **A run outlives the request that started it.** An edit to something the viewer's whole import
 * graph hangs off (the palette, the scene) or to the page itself reloads the tab, and the tab is
 * where the stream was being read — if the child were tied to that socket, the agent would be
 * killed by its own edit. So the run buffers every event it emits, and a reloaded page reattaches
 * with `from=` and replays what it missed.
 *
 * Loopback only. This endpoint edits files and runs `npm run check`; `vite --host` would otherwise
 * hand that to the whole Wi-Fi network.
 */

import { spawn, execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * What the agent may do without asking. Headless, there is nobody to ask, so anything not on this
 * list is simply refused: edits (via `acceptEdits`), reads, searches, a syntax check, and looking at
 * its own diff. No git writes, no network, no servers.
 *
 * **Not the check suite, and not the docs.** Both used to be part of every turn, and between them
 * they were most of a turn's wait: `npm run check` is 45 s on a quiet machine and has taken nine
 * minutes on a busy one, and the docs pass is a second round of reading. Both now run *after* the
 * reply, in `background` below, while the person is already looking at the edit.
 */
const ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(node --check *)', 'Bash(git diff*)', 'Bash(git status*)',
].join(',');

/**
 * The faster model, for the Speed picker's Fast and for what Auto judges simple (`isSimple`), and
 * the one the background docs pass runs on. Overridable without an edit, since model names move.
 */
const FAST_MODEL = process.env.WORKSHOP_FAST_MODEL || 'sonnet';
const DOCS_MODEL = process.env.WORKSHOP_DOCS_MODEL || FAST_MODEL;

/**
 * Auto's guess at "a simple change": short, one thing, and nothing pasted in to study. Most bench
 * requests are this ("make the dome smooth", "darker yellow") and go to the fast model; anything
 * longer, listed, or with a reference picture goes to the default one. A wrong guess costs little
 * now that the checks run after every turn: a fast edit that breaks something comes back with a
 * Fix button, and Fix always goes to the default model.
 */
function isSimple(body) {
  const text = String(body.message ?? '').split('\n\n[They pinned this')[0];
  const attachments = Array.isArray(body.attachments) ? body.attachments.length : 0;
  return !attachments && text.length <= 200 && !/\n\s*[-*\d]/.test(text);
}

const EDITING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The system-prompt addendum for one turn: what is on the bench and where its code lives. */
export function workshopPrompt(model, { image = null, view = 'orbit', attachments = [] } = {}) {
  const lines = [
    'You are running inside the Rocket Rides model workshop (/workshop/ on the Vite dev server).',
    `The person chatting is looking at the "${model.label}" on the bench. It is built by ${model.source}.`,
    'Every model there is built by the game\'s own code, so make the change they ask for directly in that source.',
    'Vite hot-reloads your edit into their viewer within a second, and it is the shipped game code: there is no separate copy to sync back.',
    view === 'game'
      ? 'They are looking through the game camera: the fixed orthographic 3/4 view. Detail smaller than about a tenth of a unit will not read there.'
      : 'They are orbiting the model up close. In the game it is seen from a fixed orthographic 3/4 view at about 7.7 px per unit, so tiny details may not read in play.',
  ];
  if (image) {
    lines.push(`A screenshot of exactly what they see is at ${image}. Read it before any visual change, and refer to parts by what is visible in it.`);
  }
  if (attachments.length) {
    lines.push(`They also pasted ${attachments.length === 1 ? 'an image' : `${attachments.length} images`} of their own into the message (a reference, a sketch, or a screenshot from elsewhere), at ${attachments.join(', ')}. Read ${attachments.length === 1 ? 'it' : 'them'} before acting: the message is probably about ${attachments.length === 1 ? 'it' : 'them'}.`);
  }
  lines.push(
    'Follow CLAUDE.md: colours live in src/palette.js, geometry constants in src/city/grid.js, trees go through treeParts, water through the shared shader, and comments carry the why.',
    'Keep the change scoped to this model unless asked otherwise. Do not commit, push, install packages, or start servers.',
    'Do not run npm run check or any other test suite, and do not edit anything under docs/ unless they ask you to: as soon as you finish, the workshop runs the full checks and a docs pass in the background and shows the results under your reply. Spend this turn on the edit itself. If a probe in tools/ asserts something your change deliberately alters, update that probe, since the background checks will otherwise fail on it.',
    'If they ask for a change to the workshop itself (its panels, controls, layout, this chat) rather than to the model, that is fair game too: the page is workshop/index.html, the bench is src/workshop/viewer.js, this chat panel is src/workshop/chat.js, the catalog is src/workshop/catalog.js, and the endpoint running you is tools/workshop-agent.mjs; docs/workshop.md explains each. Edits to viewer.js hot-swap; edits to index.html or chat.js reload their page, which the chat survives.',
    'Saving tools/workshop-agent.mjs or vite.config.js restarts the dev server under you. This turn keeps running and the panel reconnects, but your change only applies from the next message, and a syntax error there takes the dev server down entirely: make that edit last, and run node --check on the file straight after.',
    'Finish with one short line, under about ten words, saying what changed (e.g. "Gap between the cargo box and cab halved."). No file paths, numbers, side effects or test results unless they ask, or unless something went wrong or needs their decision. No headings, no lists.',
  );
  return lines.join('\n');
}

/** Boil the CLI's stream-json down to the four things the panel draws. */
function translate(line, run, emit) {
  let event;
  try { event = JSON.parse(line); } catch { return; }

  if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
    emit({ type: 'session', id: event.session_id });
  } else if (event.type === 'stream_event') {
    const inner = event.event;
    if (inner?.type === 'message_start') {
      run.streamed = false;
      emit({ type: 'break' });
    } else if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
      run.streamed = true;
      emit({ type: 'text', text: inner.delta.text });
    }
  } else if (event.type === 'assistant' && !event.parent_tool_use_id) {
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text' && !run.streamed) {
        emit({ type: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        const input = block.input ?? {};
        if (EDITING_TOOLS.has(block.name) && input.file_path) run.touched.add(String(input.file_path));
        const detail = input.file_path ?? input.command ?? input.pattern ?? input.path ?? '';
        emit({ type: 'tool', name: block.name, detail: String(detail) });
      }
    }
  } else if (event.type === 'result') {
    run.result = { ok: !event.is_error, error: event.is_error ? String(event.result ?? 'failed') : null };
  }
}

const gitAsync = (root, args) => new Promise((done, fail) => {
  execFile('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, out) => {
    if (error) fail(error); else done(out);
  });
});

/**
 * The working tree as it stood before a run, for undo. `git stash create` writes the tree with
 * every uncommitted change in it as a dangling commit and touches nothing — not the index, not the
 * stash list, not a file — and prints nothing on a clean tree, where HEAD is the same answer. It
 * cannot hold an untracked file, so those are listed: a file the agent created is deleted on undo,
 * and one that was already lying around untracked is left alone, since there is no copy of it.
 */
/**
 * Asynchronous, and that is the point: this used to be `execFileSync` and ran at the top of `start`,
 * so the dev server sat on three git calls before it answered the chat request or started the CLI.
 * Now the CLI is spawned straight away (its startup is the long pole) and only its stdin, the
 * message, waits on this: the agent cannot edit anything before the snapshot is taken.
 */
async function snapshot(root) {
  try {
    const ref = (await gitAsync(root, ['stash', 'create'])).trim() || (await gitAsync(root, ['rev-parse', 'HEAD'])).trim();
    const untracked = new Set((await gitAsync(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean));
    return { ref, untracked };
  } catch {
    return null;    // not a git checkout: no undo, everything else still works
  }
}

/**
 * Put the files a run edited back. Edits made by hand to those same files *during* the run go
 * with them — the snapshot is from before the run, and that is the price of an undo this simple.
 */
function undo(root, run) {
  if (!run.before) throw new Error('No snapshot to undo to (not a git checkout?).');
  if (run.undone) return { restored: [], kept: [] };
  const restored = [];
  const kept = [];
  for (const file of run.touched) {
    const abs = resolve(root, file);
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) { kept.push(file); continue; }
    const path = rel.split('\\').join('/');
    let original = null;
    try {
      original = execFileSync('git', ['show', `${run.before.ref}:${path}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { /* not in the snapshot */ }
    if (original) writeFileSync(abs, original);
    else if (run.before.untracked.has(path)) { kept.push(path); continue; }
    else if (existsSync(abs)) unlinkSync(abs);
    restored.push(path);
  }
  run.undone = true;
  return { restored, kept };
}

/** A background process and everything it started (it was spawned detached, as a group leader). */
function killTree(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
}

/** The lines of `npm run check` worth showing: every FAIL, top-level and detail alike. */
function failures(output) {
  const lines = output.split('\n').filter((line) => /^\s*FAIL\b/.test(line)).map((line) => line.trim());
  return (lines.length ? lines : output.trim().split('\n').slice(-12)).slice(0, 20).join('\n');
}

/** The prompt for the background docs pass over one turn's edits. */
function docsPrompt(run, request, edited) {
  return [
    'You are the documentation pass of the Rocket Rides model workshop. Another agent has just made a change to the game in response to this request:',
    '',
    request,
    '',
    `It edited: ${edited.join(', ')}.`,
    `See exactly what changed with: git diff ${run.before.ref} -- ${edited.join(' ')}` + ' (a file it created is untracked and will not show there: Read it instead).',
    '',
    'Update the docs under docs/ so they describe the code as it now is, following CLAUDE.md ("Docs describe the game as it is now", "Comments carry the why"): find the doc that covers these files (docs/README.md is the index) and change only what the edit made untrue or left out. Keep the house style. A new URL parameter needs a row in docs/params.md.',
    'Edit nothing outside docs/. If no doc needs to change, which is common for a small visual tweak, change nothing. Do not run tests. Finish with one short line saying what you updated, or "No doc changes needed."',
  ].join('\n');
}

export function workshopAgent({ bin = process.env.CLAUDE_BIN || 'claude' } = {}) {
  // **On `globalThis`, not in this closure,** because the agent is allowed to edit this file — and
  // this file is a dependency of vite.config.js, so saving it restarts the dev server, which
  // re-evaluates the config and builds a fresh plugin. In the same Node process, though: the
  // child keeps running and keeps writing into the run object its old closure holds. With the
  // table here, the new plugin finds that run, the page reattaches to it after the restart, and
  // the turn that edited the server finishes in the panel it was asked from. Kept in a closure,
  // the table died with the old plugin, the page was told "no such run", and `busy` was free while
  // the old child was still editing — so the next message started a second agent beside it.
  const shared = (globalThis.__workshopAgent ??= { runs: new Map(), nextId: 1, busy: null });
  const runs = shared.runs;

  /**
   * After a turn that edited something: `npm run check` and a docs pass, side by side, while the
   * person is already looking at the edit. The panel polls `GET /runs/:id/background` for
   * `run.bg`. The docs pass is its own headless agent on DOCS_MODEL, allowed to edit docs/ and
   * nothing else; what it edits joins the turn's `touched`, so the turn's Undo takes the doc edits
   * back along with the code. If it did edit, the doc-link check is re-run after both are done,
   * because the suite may have read the docs halfway through being written.
   *
   * A newer turn supersedes a check still running (`start`), since it would be testing a tree the
   * next agent is busy changing; that turn's own check covers both. The docs pass is left to finish.
   */
  function background(root, run, request) {
    const rel = (file) => relative(root, resolve(root, file)).split('\\').join('/');
    const code = [...run.touched].map(rel).filter((f) => !f.startsWith('docs/') && !f.startsWith('.workshop/'));
    const bg = {
      check: 'running', docs: code.length && run.before ? 'running' : 'skipped',
      failures: '', docsNote: '', docsFiles: [], children: new Set(), checkChild: null,
    };
    run.bg = bg;
    const proc = (cmd, args, input = null, onChild = null) => new Promise((done) => {
      let out = '';
      let child;
      try {
        // Detached, so each is its own process group and `killTree` can take its children with it:
        // `npm run check` is npm, then node, then the node scripts that one spawns.
        child = spawn(cmd, args, { cwd: root, env: process.env, detached: true, stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      } catch (error) {
        done({ code: -1, signal: null, out: error.message });
        return;
      }
      bg.children.add(child);
      onChild?.(child);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { out += chunk; });
      child.on('error', (error) => { bg.children.delete(child); done({ code: -1, signal: null, out: `${out}\n${error.message}` }); });
      child.on('close', (exit, signal) => { bg.children.delete(child); done({ code: exit, signal, out }); });
      if (input != null) {
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      }
    });

    const checking = proc('npm', ['run', 'check'], null, (child) => { bg.checkChild = child; }).then(({ code: exit, out }) => {
      bg.checkChild = null;
      if (bg.check !== 'running') return;     // superseded or cancelled while it ran
      bg.check = exit === 0 ? 'pass' : 'fail';
      if (exit !== 0) bg.failures = failures(out);
    });
    const documenting = bg.docs === 'skipped' ? Promise.resolve() : proc(bin, [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'default',
      '--allowedTools', 'Read,Glob,Grep,Edit(docs/**),Write(docs/**),Bash(git diff*)',
      '--model', DOCS_MODEL,
    ], docsPrompt(run, request, code)).then(({ code: exit, out }) => {
      const scratch = { touched: new Set(), streamed: false };
      let note = '';
      for (const line of out.split('\n')) {
        if (line.trim()) translate(line.trim(), scratch, (event) => { if (event.type === 'text') note += event.text; });
      }
      // Kept even when it was cancelled part way: whatever it wrote is on disk, and Undo should know.
      for (const file of scratch.touched) run.touched.add(file);
      bg.docsFiles = [...scratch.touched].map(rel);
      if (bg.docs !== 'running') return;
      bg.docs = exit === 0 ? 'done' : 'fail';
      bg.docsNote = note.trim().split('\n').at(-1) ?? '';
    });
    Promise.all([checking, documenting]).then(async () => {
      if (bg.check !== 'pass' || !bg.docsFiles.length) return;
      bg.check = 'running';
      const { code: exit, out } = await proc('node', ['tools/docs.mjs']);
      if (bg.check !== 'running') return;
      bg.check = exit === 0 ? 'pass' : 'fail';
      if (exit !== 0) bg.failures = failures(out);
    });
  }

  /** Stop a run's background work: on Undo, which is about to take its edits back. */
  function cancelBackground(run) {
    const bg = run.bg;
    if (!bg) return;
    if (bg.check === 'running') bg.check = 'cancelled';
    if (bg.docs === 'running') bg.docs = 'cancelled';
    for (const child of bg.children) killTree(child);
  }

  function start(root, body) {
    // A check still running for an earlier turn is testing a tree this turn is about to change.
    for (const earlier of runs.values()) {
      if (earlier.bg?.check !== 'running') continue;
      earlier.bg.check = 'superseded';
      if (earlier.bg.checkChild) killTree(earlier.bg.checkChild);
    }
    const id = String(shared.nextId++);
    const run = { id, events: [], listeners: new Set(), done: false, child: null, streamed: false, result: null, touched: new Set(), before: null };
    runs.set(id, run);
    // Keep the last few runs to reattach to; older ones are history nobody will ask for.
    for (const old of runs.keys()) if (runs.size > 8 && old !== id) runs.delete(old);

    const emit = (event) => {
      run.events.push(event);
      for (const listener of run.listeners) listener();
    };
    const finish = (event) => {
      if (run.done) return;
      run.done = true;
      shared.busy = null;
      const edited = [...run.touched].map((file) => relative(root, resolve(root, file)));
      // Checks and docs only after a turn that finished and changed something.
      const after = Boolean(event.ok) && edited.length > 0;
      emit({ type: 'done', ...event, edited, undoable: Boolean(run.before) && edited.length > 0, background: after });
      if (after) background(root, run, String(body.message ?? ''));
    };

    const PNG = 'data:image/png;base64,';
    const dir = join(root, '.workshop');
    mkdirSync(dir, { recursive: true });
    let image = null;
    if (typeof body.image === 'string' && body.image.startsWith(PNG)) {
      image = join(dir, 'view.png');
      writeFileSync(image, Buffer.from(body.image.slice(PNG.length), 'base64'));
    }
    // Images they pasted into the message (chat.js re-encodes every one to PNG). The last turn's
    // are cleared first, so a turn without any can never be handed an old one by a stale name.
    for (const name of readdirSync(dir)) if (/^attachment-\d+\.png$/.test(name)) unlinkSync(join(dir, name));
    const attachments = (Array.isArray(body.attachments) ? body.attachments : [])
      .filter((a) => typeof a === 'string' && a.startsWith(PNG))
      .slice(0, 6)
      .map((a, i) => {
        const path = join(dir, `attachment-${i + 1}.png`);
        writeFileSync(path, Buffer.from(a.slice(PNG.length), 'base64'));
        return path;
      });

    // The message goes in on stdin, not as an argument: passed as `-p <message>`, a message that
    // opened with a bulleted list ("- make this window smaller") was parsed by the CLI as an
    // unknown option and the turn failed before it started. `-p` with no prompt reads stdin.
    const args = [
      '-p',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', ALLOWED_TOOLS,
      '--append-system-prompt', workshopPrompt(body.model ?? { label: 'model', source: 'src/' }, { image, view: body.view, attachments }),
    ];
    if (typeof body.sessionId === 'string' && /^[\w-]+$/.test(body.sessionId)) args.push('--resume', body.sessionId);
    // The Speed picker: Fast and Smart say which outright, Auto asks `isSimple`. Smart is the CLI's
    // own default model, so it passes nothing.
    const speed = body.speed === 'fast' || body.speed === 'smart' ? body.speed : 'auto';
    const fast = speed === 'fast' || (speed === 'auto' && isSimple(body));
    if (fast) args.push('--model', FAST_MODEL);
    emit({ type: 'model', fast, name: fast ? FAST_MODEL : 'default' });

    let child;
    try {
      child = spawn(bin, args, { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      // An EPIPE here would otherwise be an uncaught error on the dev server; a child that dies
      // before reading reports itself through its exit code below.
      child.stdin.on('error', () => {});
    } catch (error) {
      finish({ ok: false, error: error.message });
      return run;
    }
    run.child = child;
    shared.busy = run;
    // The message goes in once the undo snapshot is taken, not before: `claude -p` reads its prompt
    // from stdin and does nothing until it has it, so this is what holds the agent off the files
    // while the CLI's own startup (the slow part) runs alongside the three git calls.
    snapshot(root).then((before) => {
      run.before = before;
      try { child.stdin.end(String(body.message ?? '')); } catch { /* the child is already gone */ }
    });

    let buffer = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) translate(line, run, emit);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    child.on('error', (error) => finish({
      ok: false,
      error: error.code === 'ENOENT'
        ? `Couldn't find the Claude Code CLI (\`${bin}\`). Install it, or set CLAUDE_BIN, and restart npm run dev.`
        : error.message,
    }));
    child.on('close', (code, signal) => {
      if (signal) finish({ ok: false, error: 'Stopped.' });
      else if (run.result) finish(run.result);
      else finish({ ok: code === 0, error: code === 0 ? null : (stderr.trim() || `claude exited with ${code}`) });
    });
    return run;
  }

  function stream(run, from, res) {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    let sent = Math.max(0, from);
    const flush = () => {
      while (sent < run.events.length) res.write(`${JSON.stringify(run.events[sent++])}\n`);
      if (run.done) {
        run.listeners.delete(flush);
        res.end();
      }
    };
    run.listeners.add(flush);
    res.on('close', () => run.listeners.delete(flush));
    flush();
  }

  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };

  return {
    name: 'workshop-agent',
    apply: 'serve',
    // An edit to workshop/index.html has to reload the page, and out of the box it does nothing.
    // Vite only sends an .html file's `full-reload` when no module in the graph belongs to that
    // file, and the page's inline <style> is one: Vite serves it as an `html-proxy&inline-css`
    // module keyed to index.html. So the save "hot-updated" a CSS proxy the page never imports,
    // and the new markup and styles sat on disk until a manual refresh (the inset's minimize
    // button did exactly that). Handing back no modules sends Vite down its own reload path.
    hotUpdate({ file }) {
      if (this.environment.name === 'client' && file.endsWith('/workshop/index.html')) return [];
    },
    configureServer(server) {
      const root = server.config.root;
      server.middlewares.use('/__workshop', (req, res) => {
        if (!LOOPBACK.has(req.socket.remoteAddress)) return json(res, 403, { error: 'loopback only' });
        const url = new URL(req.url, 'http://localhost');
        const runMatch = url.pathname.match(/^\/runs\/(\d+)(\/stop|\/undo|\/background)?$/);

        if (req.method === 'POST' && url.pathname === '/chat') {
          if (shared.busy) return json(res, 409, { error: 'Still working on the last message.', runId: shared.busy.id });
          let raw = '';
          req.setEncoding('utf8');
          req.on('data', (chunk) => { raw += chunk; });
          req.on('end', () => {
            let body;
            try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
            if (!body.message?.trim()) return json(res, 400, { error: 'empty message' });
            json(res, 200, { runId: start(root, body).id });
          });
          return undefined;
        }
        if (runMatch) {
          const run = runs.get(runMatch[1]);
          if (!run) return json(res, 404, { error: 'no such run' });
          if (runMatch[2] === '/stop' && req.method === 'POST') {
            run.child?.kill('SIGTERM');
            return json(res, 200, { ok: true });
          }
          if (runMatch[2] === '/undo' && req.method === 'POST') {
            if (!run.done || shared.busy) return json(res, 409, { error: 'Wait for the reply to finish first.' });
            // Its checks would be testing edits about to be taken back, and its docs pass writing
            // about them; whatever the docs pass already wrote is in `touched` and goes back too.
            cancelBackground(run);
            try {
              return json(res, 200, undo(root, run));
            } catch (error) {
              return json(res, 500, { error: error.message });
            }
          }
          if (runMatch[2] === '/background') {
            const bg = run.bg;
            if (!bg) return json(res, 200, { check: 'none', docs: 'none' });
            return json(res, 200, {
              check: bg.check, docs: bg.docs, failures: bg.failures, docsNote: bg.docsNote,
              docsFiles: bg.docsFiles,
              edited: [...run.touched].map((file) => relative(root, resolve(root, file))),
            });
          }
          return stream(run, Number(url.searchParams.get('from')) || 0, res);
        }
        if (url.pathname === '/status') return json(res, 200, { busy: shared.busy?.id ?? null });
        return json(res, 404, { error: 'not found' });
      });
    },
  };
}
